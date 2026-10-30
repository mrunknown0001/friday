import path from 'node:path';
import type { RefactorInfo, RefactorMatch } from '@friday/shared';
import { z } from 'zod';
import { languageOf, type Language } from '../codemap/extract.js';
import type { CodeMap } from '../codemap/index.js';
import { occurrences, replaceAt } from '../refactor/lexer.js';
import { planMove } from '../refactor/move.js';
import { findReferences, type References, type UncertainRef } from '../refactor/references.js';
import { assertRootAvailable, WorkspaceError } from '../workspace/paths.js';
import { applyAll, planFromText, planWrite, type FilePlan } from './fileTools.js';
import { defineTool, type Proposal, type ToolContext } from './types.js';

/**
 * Safe refactoring. `find_references` shows where a symbol is used, split into occurrences
 * Friday ties to the definition and text matches that may be something else. `rename_symbol`
 * and `move_symbol` turn that into one multi-file change the user approves as a whole; the
 * uncertain matches are listed on the card and left alone unless the model names the ones it
 * checked.
 */

const MAX_SHOWN = 80;

async function setup(ctx: ToolContext): Promise<{ root: string; map: CodeMap }> {
  if (!ctx.project)
    throw new WorkspaceError('unsupported', 'This conversation is not attached to a project.');
  if (!ctx.codeMap) throw new WorkspaceError('unsupported', 'The code map is not available here.');
  await assertRootAvailable(ctx.project.rootPath);
  return { root: ctx.project.rootPath, map: ctx.codeMap };
}

const symbolArg = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[\w$#.:\\-]+$/, 'A symbol name, e.g. cartTotal or Cart.total.')
  .describe('The symbol: a name, or Class.member for a method or property.');

const pathArg = z
  .string()
  .max(1024)
  .optional()
  .describe('The file that defines it, when several definitions share the name.');

const display = (r: References) => `${r.def.container ? `${r.def.container}.` : ''}${r.def.name}`;

const where = (m: { path: string; line: number }) => `${m.path}:${m.line}`;

const toMatch = (u: UncertainRef): RefactorMatch => ({
  path: u.path,
  line: u.line,
  text: u.text,
  reason: u.reason,
});

/** Confident lines per file, compactly: "src/cart.ts: 3, 12, 40". */
function groupLines(refs: Array<{ path: string; line: number }>): string[] {
  const byFile = new Map<string, number[]>();
  for (const r of refs) byFile.set(r.path, [...(byFile.get(r.path) ?? []), r.line]);
  return [...byFile].map(([f, lines]) => `- ${f}: ${[...new Set(lines)].join(', ')}`);
}

export const findReferencesTool = defineTool({
  name: 'find_references',
  description:
    "Where a symbol is used, for a rename or a move: its definition, the occurrences Friday can tie to it (same file, imports and re-exports, `this`/self, the same Go package or PHP namespace), and, listed separately, text matches that may be a different symbol (comments, strings, files that don't import it, member calls on values whose type can't be checked), each with the reason. Read-only. Check the uncertain ones you care about before rename_symbol, and pass the ones that are really this symbol in its `also`.",
  category: 'read_only',
  risk: 'none',
  requiresProject: true,
  schema: z.object({ symbol: symbolArg, path: pathArg }),
  describeCall: (a) => a.symbol,
  async execute(args, ctx) {
    const { root, map } = await setup(ctx);
    const r = await findReferences({
      root,
      map,
      projectId: ctx.project!.id,
      symbol: args.symbol,
      path: args.path,
      ripgrep: ctx.env.ripgrep,
      signal: ctx.signal,
    });
    const files = new Set(r.confident.map((c) => c.path));
    const lines = [
      `Definition: ${where(r.def)}  ${r.def.kind} ${display(r)}${r.def.exported ? '' : ' (not exported)'}`,
      `    ${r.def.signature}`,
      '',
      `Same symbol (${r.confident.length} occurrence${r.confident.length === 1 ? '' : 's'} in ${files.size} file${files.size === 1 ? '' : 's'}; rename_symbol changes these):`,
      ...groupLines(r.confident),
    ];
    if (r.uncertain.length) {
      lines.push(
        '',
        `May be a different symbol (${r.uncertain.length}; not changed unless you pass "path:line" in \`also\`):`,
        ...r.uncertain.slice(0, MAX_SHOWN).map((u) => `- ${where(u)}  ${u.reason}: ${u.text}`),
        ...(r.uncertain.length > MAX_SHOWN ? [`… ${r.uncertain.length - MAX_SHOWN} more`] : []),
      );
    } else lines.push('', 'No other text matches.');
    return {
      content: lines.join('\n'),
      summary: `${r.confident.length} sure, ${r.uncertain.length} uncertain`,
    };
  },
});

const RESERVED = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package private protected public await async def lambda pass raise from global nonlocal and or not is None True False elif except func go chan defer fallthrough map range select struct type echo fn impl mod pub use self Self match loop mut ref where namespace trait abstract final'.split(
    ' ',
  ),
);

function checkName(newName: string, language: Language, old: string) {
  const ok =
    language === 'php' || language === 'typescript'
      ? /^[A-Za-z_$][\w$]*$/.test(newName)
      : /^[A-Za-z_]\w*$/.test(newName);
  if (!ok || (newName.startsWith('$') && language === 'php'))
    throw new WorkspaceError('unsupported', `"${newName}" is not a valid identifier.`);
  if (RESERVED.has(newName))
    throw new WorkspaceError('unsupported', `"${newName}" is a reserved word.`);
  if (newName === old) throw new WorkspaceError('unsupported', 'The new name is the same.');
  if (language === 'go' && /^[A-Z]/.test(old) !== /^[A-Z]/.test(newName))
    throw new WorkspaceError(
      'unsupported',
      `In Go, capitalisation decides whether ${old} is exported; "${newName}" would change that. Pick a name with the same first-letter case.`,
    );
}

export const renameSymbol = defineTool({
  name: 'rename_symbol',
  description:
    "Rename a function, class, type, constant or method everywhere it is used, as one multi-file change the user approves (each file's diff is shown). Friday changes only the occurrences it can tie to the definition (see find_references); text matches that may be a different symbol are listed on the approval card and left alone, unless you pass them in `also` after checking them. Refused if the new name already appears in a file being changed. Call find_references first.",
  category: 'file_modify',
  risk: 'medium',
  requiresProject: true,
  schema: z.object({
    symbol: symbolArg,
    path: pathArg,
    new_name: z.string().trim().min(1).max(200),
    also: z
      .array(z.string().regex(/^.+:\d+$/, '"path:line"'))
      .max(200)
      .default([])
      .describe(
        'Uncertain matches ("path:line" from find_references) that are really this symbol.',
      ),
    reason: z.string().min(3).max(500),
  }),
  describeCall: (a) => `${a.symbol} → ${a.new_name}`,
  async prepare(args, ctx): Promise<Proposal> {
    const { root, map } = await setup(ctx);
    const r = await findReferences({
      root,
      map,
      projectId: ctx.project!.id,
      symbol: args.symbol,
      path: args.path,
      ripgrep: ctx.env.ripgrep,
      signal: ctx.signal,
    });
    checkName(args.new_name, r.language, r.def.name);

    const included: UncertainRef[] = [];
    for (const a of args.also) {
      const at = a.lastIndexOf(':');
      const file = path.posix.normalize(a.slice(0, at).replace(/^\.\//, ''));
      const line = Number(a.slice(at + 1));
      const hits = r.uncertain.filter((u) => u.path === file && u.line === line);
      if (!hits.length)
        throw new WorkspaceError(
          'unsupported',
          `"${a}" is not one of the uncertain matches. ${r.uncertain.length ? `They are: ${r.uncertain.slice(0, 20).map(where).join(', ')}.` : 'There are none.'}`,
        );
      included.push(...hits);
    }
    const left = r.uncertain.filter((u) => !included.includes(u));

    const byFile = new Map<string, number[]>();
    for (const ref of [...r.confident, ...included])
      byFile.set(ref.path, [...(byFile.get(ref.path) ?? []), ref.offset]);

    // The new name must not already mean something in a file being changed.
    const clashes: string[] = [];
    for (const f of byFile.keys()) {
      const text = r.texts.get(f)!;
      for (const o of occurrences(text, args.new_name, languageOf(f)))
        if (o.region === 'code') clashes.push(`${f}:${o.line}`);
    }
    if (clashes.length)
      throw new WorkspaceError(
        'unsupported',
        `"${args.new_name}" already appears in code being changed (${clashes.slice(0, 10).join(', ')}${clashes.length > 10 ? ', …' : ''}), so the rename could clash with it. Pick another name.`,
      );

    const plans: FilePlan[] = [];
    for (const [f, offsets] of byFile) {
      const before = r.texts.get(f)!;
      plans.push(
        await planFromText(root, f, before, replaceAt(before, offsets, r.def.name, args.new_name)),
      );
    }
    const changed = r.confident.length + included.length;
    const refactor: RefactorInfo = {
      kind: 'rename',
      symbol: display(r),
      definition: where(r.def),
      target: args.new_name,
      changed,
      notChanged: left.slice(0, 200).map(toMatch),
      included: included.map(toMatch),
      notes: [],
    };
    const added = plans.reduce((n, p) => n + p.preview.added, 0);
    return {
      title: `Rename ${display(r)} to ${args.new_name}`,
      summary: `Changes ${changed} occurrence${changed === 1 ? '' : 's'} in ${plans.length} file${plans.length === 1 ? '' : 's'} as one step${left.length ? `; ${left.length} text match${left.length === 1 ? '' : 'es'} that may be something else stay as they are` : ''}.`,
      category: 'file_modify',
      risk: plans.length > 10 || added > 400 ? 'high' : 'medium',
      details: { kind: 'file_change', changes: plans.map((p) => p.preview), refactor },
      fingerprint: plans.map((p) => p.fingerprint).join('|'),
      async apply(execCtx) {
        await applyAll(plans, execCtx);
        return {
          content: [
            `Renamed ${display(r)} to ${args.new_name}: ${changed} occurrence${changed === 1 ? '' : 's'} in ${plans.map((p) => p.rel).join(', ')}.`,
            ...(left.length
              ? [
                  `Left unchanged (may be a different symbol):`,
                  ...left.slice(0, MAX_SHOWN).map((u) => `- ${where(u)}  ${u.reason}: ${u.text}`),
                ]
              : []),
            'Run the tests or type checker to confirm.',
          ].join('\n'),
          summary: `renamed in ${plans.length} file${plans.length === 1 ? '' : 's'} (${changed})`,
        };
      },
    };
  },
});

export const moveSymbol = defineTool({
  name: 'move_symbol',
  description:
    "Move a top-level function, class, type, interface, enum or constant (TypeScript/JavaScript) to another file, new or existing, as one multi-file change the user approves: the definition (with its doc comment) moves, the imports it needs come along, the old file imports it back if it still uses it, and every file that imports it from the old file is updated. Uses that can't be updated safely (namespace imports, require, dynamic import) are listed on the card. Call find_references first to see who uses it.",
  category: 'file_modify',
  risk: 'medium',
  requiresProject: true,
  schema: z.object({
    symbol: symbolArg,
    path: pathArg,
    to: z.string().min(1).max(1024).describe('Destination file, relative to the project root.'),
    reason: z.string().min(3).max(500),
  }),
  describeCall: (a) => `${a.symbol} → ${a.to}`,
  async prepare(args, ctx): Promise<Proposal> {
    const { root, map } = await setup(ctx);
    const refs = await findReferences({
      root,
      map,
      projectId: ctx.project!.id,
      symbol: args.symbol,
      path: args.path,
      ripgrep: ctx.env.ripgrep,
      signal: ctx.signal,
    });
    const move = await planMove(root, refs, args.to);
    const plans: FilePlan[] = [];
    for (const f of move.files)
      plans.push(
        f.before === null
          ? await planWrite(root, f.path, f.after)
          : await planFromText(root, f.path, f.before, f.after),
      );
    const refactor: RefactorInfo = {
      kind: 'move',
      symbol: display(refs),
      definition: where(refs.def),
      target: move.target,
      changed: move.importsUpdated,
      notChanged: move.notChanged,
      included: [],
      notes: move.notes,
    };
    return {
      title: `Move ${display(refs)} to ${move.target}`,
      summary: `Moves the definition from ${refs.def.path} to ${move.target}${move.importsUpdated ? ` and updates ${move.importsUpdated} import${move.importsUpdated === 1 ? '' : 's'}` : ''}, as one step.`,
      category: plans.some((p) => !p.before) ? 'file_create' : 'file_modify',
      risk: plans.length > 10 ? 'high' : 'medium',
      details: { kind: 'file_change', changes: plans.map((p) => p.preview), refactor },
      fingerprint: plans.map((p) => p.fingerprint).join('|'),
      async apply(execCtx) {
        await applyAll(plans, execCtx);
        return {
          content: [
            `Moved ${display(refs)} from ${refs.def.path} to ${move.target}; changed ${plans.map((p) => p.rel).join(', ')}.`,
            ...move.notes,
            ...(move.notChanged.length
              ? [
                  'Not updated (check these by hand):',
                  ...move.notChanged.map((u) => `- ${where(u)}  ${u.reason}: ${u.text}`),
                ]
              : []),
            'Run the tests or type checker to confirm.',
          ].join('\n'),
          summary: `moved to ${move.target} (${plans.length} file${plans.length === 1 ? '' : 's'})`,
        };
      },
    };
  },
});
