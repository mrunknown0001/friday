import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalDetails, RunEvent } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { occurrences, regions } from '../src/refactor/lexer.js';
import {
  parseGoImports,
  parseJsStatements,
  parsePhpNames,
  parsePyImports,
  parseTsconfigPaths,
  relativeSpec,
  resolveJs,
  resolvePy,
} from '../src/refactor/modules.js';
import { definitionRange } from '../src/refactor/move.js';
import { Redactor } from '../src/security/redact.js';
import { findReferencesTool, moveSymbol, renameSymbol } from '../src/tools/refactorTools.js';
import type { ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);
const env = await detectToolEnvironment();
const TSC = path.resolve(import.meta.dirname, '../../../node_modules/typescript/bin/tsc');

const SHOP: Record<string, string> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: 'es2022',
      module: 'esnext',
      moduleResolution: 'bundler',
      skipLibCheck: true,
    },
    include: ['src/**/*.ts'],
  }),
  'src/cart.ts': `import { round } from './util/math';
import type { Item } from './types';

const TAX = 0.2;

/** Sum of the items, with tax. */
export function cartTotal(items: Item[]): number {
  const sum = items.reduce((s, i) => s + i.price * i.qty, 0);
  return round(sum * (1 + TAX));
}

export function cartCount(items: Item[]) {
  return items.length;
}

export class Cart {
  items: Item[] = [];
  total() {
    return cartTotal(this.items);
  }
  addItem(i: Item) {
    this.items.push(i);
    return this.total();
  }
}
`,
  'src/util/math.ts': 'export const round = (n: number) => Math.round(n * 100) / 100;\n',
  'src/types.ts': 'export interface Item {\n  price: number;\n  qty: number;\n}\n',
  'src/index.ts': "export * from './cart';\n",
  'src/checkout.ts': `import { cartTotal, Cart } from './cart';

// cartTotal includes tax
export function checkout(c: Cart) {
  const label = 'cartTotal';
  return { label, total: cartTotal(c.items) + c.total() };
}
`,
  'src/api.ts':
    "import { cartTotal } from './index';\nexport const handler = () => cartTotal([]);\n",
  'src/legacy.js': 'function cartTotal(x) {\n  return 0;\n}\nmodule.exports = { cartTotal };\n',
  'src/report.ts': "import * as cart from './cart';\nexport const r = cart.cartTotal([]);\n",
  'README.md': '# shop\n\nUse cartTotal() to compute the total.\n',
};

function setup(files: Record<string, string>) {
  const root = makeProject(files);
  const s = testServices();
  const project = s.projects.create('shop', root);
  const changes: string[] = [];
  const c: ToolContext = {
    project,
    sessionId: 's',
    runId: 'r',
    callId: 'c1',
    signal: new AbortController().signal,
    redactor: new Redactor(),
    env,
    maxOutputChars: 40_000,
    setPlan: () => undefined,
    codeMap: s.codeMap,
    recordFileChange: (ch) => changes.push(`${ch.change} ${ch.path}`),
  };
  return { root, c, changes, read: (f: string) => fs.readFileSync(path.join(root, f), 'utf8') };
}

const tsc = (root: string) =>
  execFileSync(process.execPath, [TSC, '-p', root], { encoding: 'utf8', stdio: 'pipe' });

async function refs(c: ToolContext, symbol: string, file?: string) {
  const out = await findReferencesTool.execute!(
    findReferencesTool.schema.parse({ symbol, ...(file ? { path: file } : {}) }),
    c,
  );
  return out.content;
}

describe('lexer', () => {
  it('tells code from comments and strings, template code included', () => {
    const text = "a /* b */ 'c' `d ${e + 'f'} g` // h\nx";
    const r = regions(text, 'typescript');
    const at = (s: string) => r[text.indexOf(s)];
    expect([
      at('a'),
      at('b'),
      at('c'),
      at('d'),
      at('e'),
      at('f'),
      at('g'),
      at('h'),
      at('x'),
    ]).toEqual([0, 1, 2, 2, 0, 2, 2, 1, 0]);
    const py = 'x = """total\n# not a comment"""  # total\ntotal';
    expect(occurrences(py, 'total', 'python').map((o) => o.region)).toEqual([
      'string',
      'comment',
      'code',
    ]);
    expect(occurrences('$total = $this->total; self::total; \\App\\total', 'total', 'php')).toEqual(
      [
        expect.objectContaining({ accessor: '->', receiver: 'this' }),
        expect.objectContaining({ accessor: '::', receiver: 'self' }),
        expect.objectContaining({ accessor: '\\', receiver: 'App' }),
      ],
    );
    expect(occurrences('...total, a?.total, totals', 'total', 'typescript')).toEqual([
      expect.objectContaining({ accessor: null }),
      expect.objectContaining({ accessor: '?.', receiver: 'a' }),
    ]);
  });
});

describe('module statements', () => {
  it('reads JS/TS imports, re-exports and require, and resolves them', () => {
    const text = `import D, { a, b as c, type T } from './x.js';
import * as ns from "@/lib/y";
import type { U } from '../types';
export { a as aa } from './x';
export * from './z';
export { local };
const { q, r: rr } = require('./q');
const whole = require('./w');
// import { fake } from './fake';
const s = "import { str } from './str'";`;
    const st = parseJsStatements(text);
    expect(st.map((s) => [s.kind, s.spec, s.namespace, s.typeOnly])).toEqual([
      ['import', './x.js', null, false],
      ['import', '@/lib/y', 'ns', false],
      ['import', '../types', null, true],
      ['export-from', './x', null, false],
      ['export-all', './z', null, false],
      ['export-list', null, null, false],
      ['require', './q', null, false],
      ['require', './w', 'whole', false],
    ]);
    expect(st[0]!.specifiers).toEqual([
      { imported: 'default', local: 'D', type: false },
      { imported: 'a', local: 'a', type: false },
      { imported: 'b', local: 'c', type: false },
      { imported: 'T', local: 'T', type: true },
    ]);
    expect(st[6]!.specifiers.map((s) => [s.imported, s.local])).toEqual([
      ['q', 'q'],
      ['r', 'rr'],
    ]);

    const files = new Set(['src/x.ts', 'src/lib/y/index.tsx', 'src/types.ts', 'src/a/b.ts']);
    const aliases = parseTsconfigPaths(
      '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"], }, }, }',
      '.',
    );
    expect(resolveJs('src/a/b.ts', '../x.js', files, null)).toBe('src/x.ts');
    expect(resolveJs('src/a/b.ts', '@/lib/y', files, aliases)).toBe('src/lib/y/index.tsx');
    expect(resolveJs('src/a/b.ts', 'react', files, aliases)).toBeNull();
    expect(relativeSpec('src/a/b.ts', 'src/x.ts', './q.js')).toBe('../x.js');
    expect(relativeSpec('src/a/b.ts', 'src/a/c.ts', './q')).toBe('./c');
  });

  it('reads Python, Go and PHP imports', () => {
    const py = parsePyImports(
      'from shop.cart import (\n  cart_total,\n  Cart as C,\n)\nimport shop.orders as o, os\nfrom . import util\n# from x import y\n',
    );
    expect(py.map((p) => [p.module, p.names, p.local])).toEqual([
      [
        'shop.cart',
        [
          { imported: 'cart_total', local: 'cart_total' },
          { imported: 'Cart', local: 'C' },
        ],
        null,
      ],
      ['shop.orders', null, 'o'],
      ['os', null, 'os'],
      ['.', [{ imported: 'util', local: 'util' }], null],
    ]);
    const files = new Set(['src/shop/cart.py', 'src/shop/__init__.py', 'src/shop/util.py']);
    expect(resolvePy('app.py', 'shop.cart', files)).toBe('src/shop/cart.py');
    expect(resolvePy('src/shop/cart.py', '.util', files)).toBe('src/shop/util.py');
    expect(resolvePy('src/shop/cart.py', '.', files)).toBe('src/shop/__init__.py');

    expect([
      ...parseGoImports(
        'import (\n\t"fmt"\n\tc "example.com/shop/cart"\n)\nimport "example.com/x/y"\n',
      ),
    ]).toEqual([
      ['y', 'example.com/x/y'],
      ['fmt', 'fmt'],
      ['c', 'example.com/shop/cart'],
    ]);
    const php = parsePhpNames(
      '<?php\nnamespace App\\Http;\n\nuse App\\Models\\Cart;\nuse App\\Models\\Order as O, Foo\\Bar;\n',
    );
    expect(php.namespace).toBe('App\\Http');
    expect([...php.uses]).toEqual([
      ['Cart', 'App\\Models\\Cart'],
      ['O', 'App\\Models\\Order'],
      ['Bar', 'Foo\\Bar'],
    ]);
  });
});

describe('find_references in TypeScript', () => {
  it('follows imports and re-exports, and lists matches that may be something else', async () => {
    const { c } = setup(SHOP);
    await expect(refs(c, 'cartTotal')).rejects.toThrow(
      /defined in several places: src\/cart\.ts:7 \(cartTotal\), src\/legacy\.js:1/,
    );
    const out = await refs(c, 'cartTotal', 'src/cart.ts');
    expect(out).toContain('Same symbol (7 occurrences in 4 files');
    expect(out).toContain('- src/api.ts: 1, 2'); // through the index.ts re-export
    expect(out).toContain('- src/report.ts: 2'); // cart.cartTotal via a namespace import
    expect(out).toContain('README.md:3  in a file that is not source code');
    expect(out).toContain('src/checkout.ts:3  in a comment');
    expect(out).toContain("src/checkout.ts:5  in a string: const label = 'cartTotal';");
    expect(out).toContain("src/legacy.js:1  this file doesn't import it from src/cart.ts");

    const method = await refs(c, 'Cart.total');
    expect(method).toContain('- src/cart.ts: 18, 23');
    expect(method).toContain('- src/checkout.ts: 6'); // c.total(), in a file that uses Cart
    // The object key `total:` on the same line is a different thing.
    expect(method).toContain('src/checkout.ts:6  the same name defined or used outside the class');
  });
});

describe('rename_symbol', () => {
  it('renames across files as one approved change that still compiles, leaving uncertain matches', async () => {
    const { root, c, changes, read } = setup(SHOP);
    const proposal = await renameSymbol.prepare!(
      renameSymbol.schema.parse({
        symbol: 'cartTotal',
        path: 'src/cart.ts',
        new_name: 'computeTotal',
        also: ['src/checkout.ts:3'],
        reason: 'clearer name',
      }),
      c,
    );
    const d = proposal.details as Extract<ApprovalDetails, { kind: 'file_change' }>;
    expect(d.changes.map((ch) => ch.path)).toEqual([
      'src/api.ts',
      'src/cart.ts',
      'src/checkout.ts',
      'src/report.ts',
    ]);
    expect(d.refactor).toMatchObject({
      kind: 'rename',
      symbol: 'cartTotal',
      definition: 'src/cart.ts:7',
      target: 'computeTotal',
      changed: 8,
      included: [{ path: 'src/checkout.ts', line: 3, reason: 'in a comment' }],
    });
    expect(d.refactor!.notChanged.map((m) => `${m.path}:${m.line}`)).toEqual([
      'README.md:3',
      'src/checkout.ts:5',
      'src/legacy.js:1',
      'src/legacy.js:4',
    ]);
    const out = await proposal.apply(c);
    expect(out.content).toContain('Left unchanged (may be a different symbol):');
    expect(changes).toHaveLength(4);
    expect(read('src/checkout.ts')).toContain('// computeTotal includes tax');
    expect(read('src/checkout.ts')).toContain("const label = 'cartTotal';");
    expect(read('src/legacy.js')).toContain('function cartTotal(x)');
    expect(read('src/api.ts')).toBe(
      "import { computeTotal } from './index';\nexport const handler = () => computeTotal([]);\n",
    );
    tsc(root);
  }, 30_000);

  it('renames a method through this and its callers', async () => {
    const { root, c, read } = setup(SHOP);
    const proposal = await renameSymbol.prepare!(
      renameSymbol.schema.parse({ symbol: 'Cart.total', new_name: 'subtotal', reason: 'clearer' }),
      c,
    );
    await proposal.apply(c);
    expect(read('src/cart.ts')).toContain('  subtotal() {');
    expect(read('src/cart.ts')).toContain('return this.subtotal();');
    expect(read('src/checkout.ts')).toContain('total: cartTotal(c.items) + c.subtotal()');
    tsc(root);
  }, 30_000);

  it('refuses names that clash, are invalid, or matches that were not listed', async () => {
    const { c } = setup(SHOP);
    const prep = (args: Record<string, unknown>) =>
      renameSymbol.prepare!(
        renameSymbol.schema.parse({
          symbol: 'cartTotal',
          path: 'src/cart.ts',
          reason: 'xyz',
          ...args,
        }),
        c,
      );
    await expect(prep({ new_name: 'cartCount' })).rejects.toThrow(
      /"cartCount" already appears in code being changed \(src\/cart\.ts:12\)/,
    );
    await expect(prep({ new_name: 'class' })).rejects.toThrow(/reserved word/);
    await expect(prep({ new_name: '2fast' })).rejects.toThrow(/not a valid identifier/);
    await expect(prep({ new_name: 'x', also: ['src/api.ts:1'] })).rejects.toThrow(
      /"src\/api\.ts:1" is not one of the uncertain matches/,
    );
    await expect(
      renameSymbol.prepare!(
        renameSymbol.schema.parse({ symbol: 'nothingLikeThis', new_name: 'x', reason: 'xyz' }),
        c,
      ),
    ).rejects.toThrow(/No definition of "nothingLikeThis"/);
  });
});

describe('references in other languages', () => {
  it('Python: from-imports, package re-exports and module attributes', async () => {
    const { c, read } = setup({
      'shop/__init__.py': 'from .cart import cart_total\n',
      'shop/cart.py':
        'def cart_total(items):\n    return sum(items)\n\n\nclass Cart:\n    def total(self):\n        return cart_total(self.items)\n',
      'app.py': 'from shop import cart_total\nprint(cart_total([1]))\n',
      'report.py': 'import shop.cart as c\nprint(c.cart_total([]))\n',
      'other.py': 'def cart_total(x):\n    return 0\n',
      'notes.py': '# cart_total is in shop\nx = "cart_total"\n',
    });
    const out = await refs(c, 'cart_total', 'shop/cart.py');
    expect(out).toContain('- app.py: 1, 2');
    expect(out).toContain('- report.py: 2');
    expect(out).toContain('- shop/__init__.py: 1');
    expect(out).toContain('- shop/cart.py: 1, 7');
    expect(out).toContain("other.py:1  this file doesn't import it from shop/cart.py");
    expect(out).toContain('notes.py:1  in a comment');
    const p = await renameSymbol.prepare!(
      renameSymbol.schema.parse({
        symbol: 'cart_total',
        path: 'shop/cart.py',
        new_name: 'total_of',
        reason: 'xyz',
      }),
      c,
    );
    await p.apply(c);
    expect(read('app.py')).toBe('from shop import total_of\nprint(total_of([1]))\n');
    expect(read('other.py')).toContain('def cart_total(x)');
  });

  it('Go: the same package, and other packages through their import', async () => {
    const { c } = setup({
      'go.mod': 'module example.com/shop\n\ngo 1.22\n',
      'cart/cart.go': 'package cart\n\nfunc Total(xs []int) int {\n\treturn len(xs)\n}\n',
      'cart/use.go': 'package cart\n\nfunc twice(xs []int) int { return Total(xs) * 2 }\n',
      'api/api.go':
        'package api\n\nimport c "example.com/shop/cart"\n\nfunc H() int { return c.Total(nil) }\n',
      'orders/orders.go': 'package orders\n\nfunc Total() int { return 0 }\n\nvar x = Total()\n',
    });
    const out = await refs(c, 'Total', 'cart/cart.go');
    expect(out).toContain('- api/api.go: 5');
    expect(out).toContain('- cart/cart.go: 3');
    expect(out).toContain('- cart/use.go: 3');
    expect(out).toContain('orders/orders.go:5  another package (orders), not cart');
    await expect(
      renameSymbol.prepare!(
        renameSymbol.schema.parse({
          symbol: 'Total',
          path: 'cart/cart.go',
          new_name: 'sum',
          reason: 'xyz',
        }),
        c,
      ),
    ).rejects.toThrow(/capitalisation decides whether Total is exported/);
  });

  it('PHP: namespaces, use statements and qualified names', async () => {
    const { c } = setup({
      'app/Models/Cart.php': '<?php\nnamespace App\\Models;\n\nclass Cart\n{\n}\n',
      'app/Http/CartController.php':
        '<?php\nnamespace App\\Http;\n\nuse App\\Models\\Cart;\n\nclass CartController\n{\n    public function show() { return new Cart(); }\n}\n',
      'app/Models/Order.php':
        '<?php\nnamespace App\\Models;\n\nclass Order\n{\n    public function cart() { return Cart::class; }\n}\n',
      'routes/web.php': '<?php\nreturn [\\App\\Models\\Cart::class, \\Other\\Cart::class];\n',
      'legacy/Cart.php': '<?php\nnamespace Legacy;\n\nclass Cart {}\n$c = new Cart();\n',
    });
    const out = await refs(c, 'Cart', 'app/Models/Cart.php');
    expect(out).toContain('- app/Http/CartController.php: 4, 8');
    expect(out).toContain('- app/Models/Cart.php: 4');
    expect(out).toContain('- app/Models/Order.php: 6');
    expect(out).toContain('- routes/web.php: 2');
    expect(out).toContain(
      'routes/web.php:2  the qualified name Other\\Cart, not App\\Models\\Cart',
    );
    expect(out).toContain('legacy/Cart.php:4  in namespace Legacy');
  });
});

describe('move_symbol', () => {
  it('moves a function with its imports, re-points importers and keeps it compiling', async () => {
    const { root, c, read } = setup(SHOP);
    const proposal = await moveSymbol.prepare!(
      moveSymbol.schema.parse({
        symbol: 'cartTotal',
        path: 'src/cart.ts',
        to: 'src/pricing.ts',
        reason: 'xyz',
      }),
      c,
    );
    const d = proposal.details as Extract<ApprovalDetails, { kind: 'file_change' }>;
    expect(d.refactor).toMatchObject({
      kind: 'move',
      target: 'src/pricing.ts',
      changed: 2,
      notChanged: [
        {
          path: 'src/report.ts',
          reason: 'uses cartTotal through a namespace import of src/cart.ts',
        },
      ],
    });
    expect(d.refactor!.notes).toEqual([
      'TAX is now exported from src/cart.ts, because cartTotal uses it.',
      'src/cart.ts and src/pricing.ts now import each other (a circular import); check this works for your bundler/runtime.',
    ]);
    expect(proposal.category).toBe('file_create');
    await proposal.apply(c);
    expect(read('src/pricing.ts')).toBe(`import { round } from './util/math';
import type { Item } from './types';
import { TAX } from './cart';

/** Sum of the items, with tax. */
export function cartTotal(items: Item[]): number {
  const sum = items.reduce((s, i) => s + i.price * i.qty, 0);
  return round(sum * (1 + TAX));
}
`);
    expect(read('src/cart.ts')).toMatch(
      /^import type \{ Item \} from '\.\/types';\nimport \{ cartTotal \} from '\.\/pricing';\n\nexport const TAX = 0\.2;\n\nexport function cartCount/,
    );
    expect(read('src/checkout.ts')).toMatch(
      /^import \{ Cart \} from '\.\/cart';\nimport \{ cartTotal \} from '\.\/pricing';\n/,
    );
    expect(read('src/index.ts')).toBe(
      "export * from './cart';\nexport { cartTotal } from './pricing';\n",
    );
    // report.ts still reads cart.cartTotal through the namespace: the one listed for a manual fix.
    fs.writeFileSync(
      path.join(root, 'src/report.ts'),
      "import { cartTotal } from './pricing';\nexport const r = cartTotal([]);\n",
    );
    tsc(root);
  }, 30_000);

  it('moves into an existing file, merging imports, and refuses what it cannot move', async () => {
    const { root, c, read } = setup({
      ...SHOP,
      'src/pricing.ts':
        "import { round } from './util/math';\n\nexport const half = (n: number) => round(n / 2);\n",
      'src/report.ts': "import { cartCount } from './cart';\nexport const n = cartCount([]);\n",
    });
    const prep = (args: Record<string, unknown>) =>
      moveSymbol.prepare!(moveSymbol.schema.parse({ reason: 'xyz', ...args }), c);
    const p = await prep({ symbol: 'cartCount', to: 'src/pricing.ts' });
    await p.apply(c);
    expect(read('src/pricing.ts')).toBe(`import { round } from './util/math';
import type { Item } from './types';

export const half = (n: number) => round(n / 2);

export function cartCount(items: Item[]) {
  return items.length;
}
`);
    expect(read('src/report.ts')).toBe(
      "import { cartCount } from './pricing';\nexport const n = cartCount([]);\n",
    );
    expect(read('src/cart.ts')).not.toContain('cartCount');
    tsc(root);

    await expect(prep({ symbol: 'Cart.total', to: 'src/x.ts' })).rejects.toThrow(/Only top-level/);
    await expect(prep({ symbol: 'Cart', to: 'src/notes.md' })).rejects.toThrow(/not a TypeScript/);
    await expect(prep({ symbol: 'Cart', to: 'src/cart.ts' })).rejects.toThrow(
      /already in src\/cart\.ts/,
    );
  }, 30_000);

  it('finds the whole definition, semicolons or not', () => {
    const text = [
      'import x from "y"',
      '',
      '// helper',
      '/** Doc. */',
      '@decorator()',
      'export class A {',
      '  m() { return "}" }',
      '}',
      'export const f = (a: number) =>',
      '  a +',
      '  1',
      'export type T = {',
      '  a: string',
      '}',
      'const z = 1;',
    ].join('\n');
    const slice = (line: number) => {
      const r = definitionRange(text, line);
      return text.slice(r.start, r.end);
    };
    expect(slice(6)).toBe(
      '// helper\n/** Doc. */\n@decorator()\nexport class A {\n  m() { return "}" }\n}\n',
    );
    expect(slice(9)).toBe('export const f = (a: number) =>\n  a +\n  1\n');
    expect(slice(12)).toBe('export type T = {\n  a: string\n}\n');
  });
});

describe('refactoring in a conversation', () => {
  it('asks for approval with the refactor details, then records the file changes', async () => {
    const root = makeProject(SHOP);
    const provider = new ScriptedProvider();
    const s = testServices({ provider });
    const project = s.projects.create('shop', root);
    provider.streamSteps.push(
      { toolCalls: [call('find_references', { symbol: 'cartCount' }, 'f1')] },
      {
        toolCalls: [
          call(
            'rename_symbol',
            { symbol: 'cartCount', new_name: 'itemCount', reason: 'clearer' },
            'r1',
          ),
        ],
      },
      { chunks: ['Renamed.'] },
    );
    const session = s.sessions.create('Rename', project.id);
    const { run } = s.runManager.startMessage(session.id, 'rename cartCount to itemCount');
    const events: RunEvent[] = [];
    const onEvent = (e: RunEvent) => {
      events.push(e);
      if (e.type === 'approval_requested')
        setTimeout(
          () =>
            s.approvals.decide(e.approval.id, {
              decision: 'approve',
              actionHash: e.approval.actionHash,
              sessionId: session.id,
            }),
          5,
        );
    };
    const sub = s.runManager.subscribe(run.id, 0, onEvent);
    sub?.replay.forEach(onEvent);
    await s.runManager.waitFor(run.id);
    const asked = events.find((e) => e.type === 'approval_requested') as Extract<
      RunEvent,
      { type: 'approval_requested' }
    >;
    expect(asked.approval.title).toBe('Rename cartCount to itemCount');
    expect(asked.approval.details).toMatchObject({
      kind: 'file_change',
      refactor: { kind: 'rename', changed: 1 },
    });
    expect(fs.readFileSync(path.join(root, 'src/cart.ts'), 'utf8')).toContain(
      'export function itemCount(',
    );
    expect(s.runs.get(run.id)!.report?.files.map((f) => f.path)).toEqual(['src/cart.ts']);
  });
});
