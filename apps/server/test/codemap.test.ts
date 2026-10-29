import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractSymbols } from '../src/codemap/extract.js';
import { CodeMap } from '../src/codemap/index.js';
import { renderOutline } from '../src/codemap/outline.js';
import { openDatabase } from '../src/db/database.js';
import { Redactor } from '../src/security/redact.js';
import { executeToolCall, ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { call, cleanupProjects, makeProject, testServices } from './helpers.js';

afterEach(cleanupProjects);

/** "kind container.name@line" for compact assertions. */
const sig = (file: string, text: string) =>
  extractSymbols(file, text).map(
    (s) =>
      `${s.kind} ${s.container ? `${s.container}.` : ''}${s.name}@${s.line}${s.exported ? '' : '-'}`,
  );

describe('symbol extraction', () => {
  it('TypeScript: classes, members, multi-line signatures; nothing from inside bodies', () => {
    const ts = `import x from 'y';
export interface Options {
  name: string;
  run(): void;
}
export type Id = string;
export const LIMIT = 3;
const helper = (a: number) => a + 1;
export async function main(
  opts: Options,
): Promise<void> {
  const inner = () => 1;
  helper(inner());
}
/* class Commented {} */
export class Store<T> extends Base {
  private items: T[] = [];
  static create(): Store<number> {
    return new Store();
  }
  async load(
    id: Id,
  ): Promise<{
    ok: boolean;
  }> {
    if (id) {
      this.items.push(fetchIt(id));
    }
    return { ok: true };
  }
  async *stream(): AsyncGenerator<T> {
    yield* this.items;
  }
  private onEvent = async (e: Event) => {
    console.log(e);
  };
  #secret() {}
}
enum Color {
  Red,
}
describe('x', () => {
  const local = () => 1;
  function alsoLocal() {}
});
`;
    expect(sig('src/store.ts', ts)).toEqual([
      'interface Options@2',
      'type Id@6',
      'const LIMIT@7',
      'function helper@8-',
      'function main@9',
      'class Store@16',
      'method Store.create@18',
      'method Store.load@21',
      'method Store.stream@31',
      'method Store.onEvent@34-',
      'method Store.#secret@37-',
      'enum Color@39-',
    ]);
  });

  it('Python, PHP, Go, Rust, Ruby', () => {
    expect(
      sig(
        'app/models.py',
        `MAX_ITEMS = 10
class Cart(Base):
    def __init__(self):
        def nested():
            pass
    async def total(self) -> int:
        return 1
    def _private(self):
        pass

def checkout(cart):
    pass
`,
      ),
    ).toEqual([
      'const MAX_ITEMS@1',
      'class Cart@2',
      'method Cart.__init__@3',
      'method Cart.total@6',
      'method Cart._private@8-',
      'function checkout@11',
    ]);
    expect(
      sig(
        'src/Cart.php',
        `<?php
final class Cart
{
    public function add(Item $item): void
    {
    }
    private static function key(): string { return ''; }
}
function helper() {}
`,
      ),
    ).toEqual(['class Cart@2', 'method Cart.add@4', 'method Cart.key@7-', 'function helper@9']);
    expect(
      sig(
        'cart.go',
        `package cart
type Cart struct {
	items []Item
}
type Store interface {
	Get() Cart
}
func (c *Cart) Add(i Item) error {
	return nil
}
func newCart() *Cart {
	return &Cart{}
}
`,
      ),
    ).toEqual(['struct Cart@2', 'interface Store@5', 'method Cart.Add@8', 'function newCart@11-']);
    expect(
      sig(
        'src/cart.rs',
        `pub struct Cart {
    items: Vec<Item>,
}
impl Cart {
    pub fn add(&mut self) {
        fn local() {}
    }
    fn private(&self) {}
}
pub trait Store {
    fn get(&self) -> Cart;
}
pub fn checkout() {}
`,
      ),
    ).toEqual([
      'struct Cart@1',
      'method Cart.add@5',
      'method Cart.private@8-',
      'trait Store@10',
      'method Store.get@11-',
      'function checkout@13',
    ]);
    expect(
      sig(
        'lib/cart.rb',
        `module Shop
  class Cart
    def add(item)
      item
    end
    def self.build
    end
  end
end
`,
      ),
    ).toEqual(['class Shop@1', 'class Shop.Cart@2', 'method Cart.add@3', 'method Cart.build@6']);
  });

  it('Java, Kotlin, C#; skips minified and unsupported files', () => {
    expect(
      sig(
        'Cart.java',
        `public class Cart {
    private final List<Item> items = new ArrayList<>();
    public void add(Item item) {
        items.add(item);
    }
    private int count() {
        return items.size();
    }
}
`,
      ),
    ).toEqual(['class Cart@1', 'method Cart.add@3', 'method Cart.count@6-']);
    expect(
      sig(
        'Cart.kt',
        `data class Cart(val items: List<Item>) {
    fun total(): Int {
        return 0
    }
}
fun main() {}
`,
      ),
    ).toEqual(['class Cart@1', 'method Cart.total@2', 'function main@6']);
    expect(
      sig(
        'Cart.cs',
        `public class Cart
{
    public async Task<int> Total(int x)
    {
        return x;
    }
}
`,
      ),
    ).toEqual(['class Cart@1', 'method Cart.Total@3']);
    expect(extractSymbols('dist/app.min.js', 'function a(){}')).toEqual([]);
    expect(extractSymbols('README.md', '# class Nope')).toEqual([]);
    expect(extractSymbols('big.js', `function ${'x'.repeat(500)}() {}`)).toEqual([]);
  });
});

// ---------- index ----------

function setupMap(files: Record<string, string>) {
  const root = makeProject(files);
  const db = openDatabase(':memory:');
  db.prepare(
    "INSERT INTO projects (id, name, root_path, created_at) VALUES ('p1', 'shop', ?, 'now')",
  ).run(root);
  return { root, db, map: new CodeMap(db), project: { id: 'p1', rootPath: root } };
}

describe('code map index', () => {
  it('indexes source files only, and re-reads only what changed', async () => {
    const { root, map, project, db } = setupMap({
      'src/cart.ts': 'export class Cart {\n  add() {\n  }\n}\n',
      'src/util.py': 'def helper():\n    pass\n',
      'node_modules/pkg/index.js': 'export function dep() {}\n',
      'dist/bundle.js': 'export function built() {}\n',
      'generated/api.ts': 'export function gen() {}\n',
      '.gitignore': 'generated/\n',
      '.env.js': 'export const KEY = 1;\n',
      'README.md': '# shop',
    });
    const first = await map.refresh(project);
    expect(first).toMatchObject({ files: 2, symbols: 3, changed: 2, removed: 0 });
    expect(map.find('p1', 'dep')).toEqual([]);
    expect(map.find('p1', 'gen')).toEqual([]);
    expect(map.find('p1', 'KEY')).toEqual([]);

    // Within the freshness window nothing is walked again; invalidate() forces a check.
    fs.writeFileSync(
      path.join(root, 'src/cart.ts'),
      'export class Cart {\n  add() {\n  }\n  remove() {\n  }\n}\n',
    );
    fs.rmSync(path.join(root, 'src/util.py'));
    expect((await map.refresh(project)).symbols).toBe(3);
    map.invalidate('p1');
    const second = await map.refresh(project);
    expect(second).toMatchObject({ files: 1, symbols: 3, changed: 1, removed: 1 });
    expect(map.find('p1', 'Cart.remove')).toEqual([
      expect.objectContaining({ path: 'src/cart.ts', line: 4, container: 'Cart' }),
    ]);
    expect((await map.refresh(project, { force: true })).changed).toBe(0);

    // Removing the project removes its index.
    db.prepare('DELETE FROM projects WHERE id = ?').run('p1');
    expect(map.status('p1')).toEqual({ files: 0, symbols: 0 });
  });

  it('ranks exact names first and summarises big outlines to fit', async () => {
    const files: Record<string, string> = {
      'src/a/cart.ts':
        'export class CartItem {}\nexport function cart() {}\nfunction cartHelper() {}\n',
      'src/b/cart.ts': 'export class Cart {}\n',
    };
    for (let i = 0; i < 40; i++)
      files[`src/mod${i}/file.ts`] = Array.from(
        { length: 15 },
        (_, j) => `export function handler${i}_${j}(request: Request, response: Response) {}`,
      ).join('\n');
    const { map, project } = setupMap(files);
    await map.refresh(project);
    expect(map.find('p1', 'Cart').map((s) => s.name)).toEqual([
      'Cart',
      'cart',
      'CartItem',
      'cartHelper',
    ]);
    expect(map.find('p1', 'cart', 'class').map((s) => s.name)).toEqual(['Cart', 'CartItem']);

    const all = map.symbolsUnder('p1', '', false);
    expect(renderOutline(all, { members: false, budget: 100_000 }).level).toBe('signatures');
    expect(renderOutline(all, { members: false, budget: 20_000 }).level).toBe('names');
    const folders = renderOutline(all, { members: false, budget: 1_000 });
    expect(folders.level).toBe('folders');
    expect(folders.text.length).toBeLessThan(1_100);
    expect(folders.text).toContain('more folders: pass a narrower path');
  });
});

// ---------- tools ----------

const env = await detectToolEnvironment();

describe('code map tools', () => {
  function ctxFor(root: string): ToolContext {
    const s = testServices();
    const project = s.projects.create('shop', root);
    return {
      project,
      sessionId: 's1',
      runId: 'r1',
      signal: new AbortController().signal,
      redactor: new Redactor([]),
      env,
      maxOutputChars: 20_000,
      setPlan: () => undefined,
      codeMap: s.codeMap,
    };
  }
  const registry = new ToolRegistry();
  const run = (ctx: ToolContext, name: string, args: unknown) =>
    executeToolCall(registry, call(name, args), ctx, { timeoutMs: 10_000 });

  it('code_map outlines the project, a folder or a file', async () => {
    const root = makeProject({
      'src/cart.ts':
        'export class Cart {\n  add(item: Item) {\n  }\n  total(): number {\n    return 0;\n  }\n}\n',
      'src/api/routes.ts': 'export function registerRoutes(app: App) {}\n',
      'scripts/build.py': 'def main():\n    pass\n',
    });
    const ctx = ctxFor(root);
    const whole = await run(ctx, 'code_map', {});
    expect(whole.status).toBe('completed');
    expect(whole.content).toContain('Code map of the project: 3 files, 5 definitions');
    expect(whole.content).toContain('src/cart.ts\n  1: export class Cart  [+2 members]');
    expect(whole.content).not.toContain('add(item: Item)');

    const folder = await run(ctx, 'code_map', { path: 'src/api' });
    expect(folder.content).toContain('Code map of src/api/: 1 files, 1 definitions');
    expect(folder.content).not.toContain('cart.ts');

    const file = await run(ctx, 'code_map', { path: 'src/cart.ts' });
    expect(file.content).toContain('    2: add(item: Item)');
    expect(file.content).toContain('    4: total(): number');

    expect((await run(ctx, 'code_map', { path: '../outside' })).status).toBe('error');
  });

  it('find_symbol gives definitions and whole-word references', async () => {
    const root = makeProject({
      'src/cart.ts': 'export class Cart {\n  total() {\n    return 0;\n  }\n}\n',
      'src/checkout.ts':
        "import { Cart } from './cart';\nexport function checkout(cart: Cart) {\n  return cart.total();\n}\nconst subtotal = 1;\n",
    });
    const ctx = ctxFor(root);
    const res = await run(ctx, 'find_symbol', { name: 'Cart.total', references: true });
    expect(res.content).toContain('src/cart.ts:2  method Cart.total');
    expect(res.content).toContain('src/checkout.ts:3:');
    // Whole words only: "subtotal" is not a reference to "total".
    expect(res.content).not.toContain('src/checkout.ts:5');
    // The definition line itself is not listed as a reference.
    expect(res.content).not.toMatch(/src\/cart\.ts:2: total/);

    const missing = await run(ctx, 'find_symbol', { name: 'NoSuchThing' });
    expect(missing.content).toMatch(/No definition named like "NoSuchThing".*search_code/);
    expect((await run(ctx, 'find_symbol', { name: 'a b' })).status).toBe('error');
  });
});

describe('code map routes', () => {
  it('reports status and rebuilds on request', async () => {
    const { buildApp } = await import('../src/app.js');
    const root = makeProject({ 'src/a.ts': 'export function a() {}\nexport class B {}\n' });
    const s = testServices();
    const app = await buildApp(s, { logger: false });
    const project = s.projects.create('shop', root);
    const headers = { host: '127.0.0.1:8787', 'x-friday-client': '1' };
    const before = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/codemap`,
      headers,
    });
    expect(before.json()).toEqual({ files: 0, symbols: 0, lastRefresh: null });
    const rebuilt = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/codemap/rebuild`,
      headers,
    });
    expect(rebuilt.json()).toMatchObject({
      files: 1,
      symbols: 2,
      lastRefresh: { truncated: false },
    });
  });
});
