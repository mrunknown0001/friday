import type { UsageSummaryDto } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import {
  fitHistory,
  STANDARD_OPTIMIZATION,
  type ContextInput,
  type HistoryItem,
} from '../src/chat/context.js';
import { estimateTokens } from '../src/providers/tokens.js';
import type { ChatMessage } from '../src/providers/types.js';
import { hintedGroups, TOOL_GROUPS } from '../src/tools/groups.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);

const H = { host: '127.0.0.1:4317', 'x-friday-client': '1', 'content-type': 'application/json' };

// ------------------------------------------------------------------ history

let nextId = 1;
const item = (message: ChatMessage, ok?: boolean): HistoryItem => ({
  id: nextId++,
  message,
  ...(ok === undefined ? {} : { ok }),
});
const user = (content: string) => item({ role: 'user', content });
/** One model turn: a tool call and its result. */
const turn = (name: string, args: unknown, content: string, ok = true): HistoryItem[] => {
  const c = call(name, args);
  return [
    item({ role: 'assistant', content: null, toolCalls: [c] }),
    item({ role: 'tool', toolCallId: c.id, content }, ok),
  ];
};
const reads = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    turn('read_file', { path: `f${i}.ts` }, `${i}`.repeat(5_000)),
  );

const fit = (history: HistoryItem[], extra: Partial<ContextInput> = {}) =>
  fitHistory({
    systemPrompt: 'You are Friday.',
    summary: null,
    history,
    contextWindow: 1_000_000,
    reserveOutputTokens: 8_000,
    optimization: STANDARD_OPTIMIZATION,
    ...extra,
  });
const toolText = (messages: ChatMessage[]) =>
  messages.filter((m) => m.role === 'tool').map((m) => m.content);

describe('token optimization: history', () => {
  it("settles the current run's older results a few turns at a time, keeping the prefix stable", () => {
    const history = (n: number) => [user('fix it'), ...reads(n).flat()];
    // Six model turns: every result is whole (keep 3, settle 4 at a time).
    const six = fit(history(6));
    expect(toolText(six.messages).every((t) => t.length === 5_000)).toBe(true);
    expect(six.stablePrefix).toBe(1);

    // Seven: the first four turns' results are clipped; the last three stay whole.
    const base = history(9);
    const seven = fit(base.slice(0, 15));
    const lengths = toolText(seven.messages).map((t) => t.length);
    expect(lengths.slice(0, 4).every((l) => l < 1_600)).toBe(true);
    expect(lengths.slice(4)).toEqual([5_000, 5_000, 5_000]);
    expect(seven.stablePrefix).toBe(1 + 1 + 4 * 2);

    // Eight and nine turns settle nothing new: the same leading messages, cached by the provider.
    const nine = fit(base);
    expect(nine.stablePrefix).toBe(seven.stablePrefix);
    expect(nine.messages.slice(0, seven.stablePrefix)).toEqual(
      seven.messages.slice(0, seven.stablePrefix),
    );
    expect(
      toolText(nine.messages)
        .slice(4)
        .every((t) => t.length === 5_000),
    ).toBe(true);

    // Without optimization the current run is never clipped.
    const off = fit(base, { optimization: null });
    expect(toolText(off.messages).every((t) => t.length === 5_000)).toBe(true);
  });

  it('drops file reads that a later read or a successful change made obsolete', () => {
    const history = [
      user('look at a'),
      ...turn('read_file', { path: 'src/a.ts' }, 'first copy of a'),
      ...turn('read_file', { path: 'src/b.ts', start_line: 1, end_line: 50 }, 'b 1-50'),
      ...turn('read_file', { path: 'src/a.ts' }, 'second copy of a'),
      ...turn('read_file', { path: 'src/b.ts', start_line: 100, end_line: 150 }, 'b 100-150'),
      ...turn('read_file', { path: 'src/c.ts' }, 'c before the rejected edit'),
      ...turn('edit_file', { path: 'src/c.ts', edits: [] }, 'The user rejected this action', false),
      ...turn('read_file', { path: 'src/d.ts' }, 'd before the edit'),
      ...turn('edit_file', { path: 'src/d.ts', edits: [] }, 'Edited src/d.ts'),
      user('thanks; now something else'),
    ];
    const texts = toolText(fit(history).messages);
    expect(texts[0]).toBe(
      '[earlier read of src/a.ts omitted: the file was read again later in this conversation; read it again if you need it]',
    );
    expect(texts.slice(1, 5)).toEqual([
      'b 1-50', // a different range is not a copy
      'second copy of a',
      'b 100-150',
      'c before the rejected edit', // the edit did not happen
    ]);
    expect(texts[6]).toBe(
      '[earlier read of src/d.ts omitted: the file was changed later in this conversation; read it again if you need it]',
    );
    // Off: every copy stays.
    expect(toolText(fit(history, { optimization: null }).messages)[0]).toBe('first copy of a');
  });

  it('caps the request below a large window, but never below what the current turn needs', () => {
    const history = Array.from({ length: 12 }, (_, i) => [
      user(`question ${i} ${'x'.repeat(40_000)}`),
      item({ role: 'assistant', content: `answer ${i}` }),
    ]).flat();
    const capped = fit([...history, user('and now?')], { toolTokens: 6_000 });
    expect(capped.dropped.length).toBeGreaterThan(0);
    expect(capped.estimatedTokens + 6_000).toBeLessThanOrEqual(
      STANDARD_OPTIMIZATION.maxContextTokens,
    );
    expect(fit([...history, user('and now?')], { optimization: null }).dropped).toEqual([]);

    // A current message bigger than the cap still goes, within the model's window.
    const big = fit([...history, user('y'.repeat(420_000))]);
    expect(big.messages.at(-1)!.content).toHaveLength(420_000);
    expect(big.estimatedTokens).toBeGreaterThan(STANDARD_OPTIMIZATION.maxContextTokens);
  });

  it('reports where the input goes', () => {
    const plan = fit(
      [user('hello'), ...turn('read_file', { path: 'a.ts' }, 'z'.repeat(700)), user('more')],
      { summary: 'Earlier: the user set up the project.', toolTokens: 1_234 },
    );
    expect(plan.breakdown.system).toBe(estimateTokens('You are Friday.'));
    expect(plan.breakdown.tools).toBe(1_234);
    expect(plan.breakdown.toolResults).toBeGreaterThan(200);
    expect(plan.breakdown.system + plan.breakdown.history + plan.breakdown.toolResults).toBe(
      plan.estimatedTokens,
    );
  });
});

// ------------------------------------------------------------------ tool groups

function setup(steps: ConstructorParameters<typeof ScriptedProvider>[0], withProject = true) {
  const provider = new ScriptedProvider(steps);
  const s = testServices({ provider });
  const project = withProject
    ? s.projects.create('p', makeProject({ 'src/a.ts': 'export const a = 1;\n' }))
    : null;
  return { s, provider, project };
}

async function run(s: ReturnType<typeof setup>['s'], sessionId: string, text: string) {
  const { run } = s.runManager.startMessage(sessionId, text);
  await s.runManager.waitFor(run.id);
  return s.runs.get(run.id)!;
}

const names = (p: ScriptedProvider, i: number) => p.requests[i]!.tools!.map((t) => t.name);
const prompt = (p: ScriptedProvider, i: number) => String(p.requests[i]!.messages[0]!.content);

describe('token optimization: tool groups', () => {
  it('offers the core tools, loads a group on request, and keeps it for the conversation', async () => {
    const { s, provider, project } = setup([
      { toolCalls: [call('load_tools', { groups: ['git', 'nope'] }, 'c1')] },
      { chunks: ['Done.'] },
      { chunks: ['Again.'] },
    ]);
    const session = s.sessions.create(undefined, project!.id);
    const r = await run(s, session.id, 'tidy up a.ts');
    expect(r.status).toBe('completed');

    const first = names(provider, 0);
    expect(first).toEqual(
      expect.arrayContaining(['read_file', 'edit_file', 'run_tests', 'load_tools']),
    );
    for (const t of ['git_commit', 'compose_control', 'query_database', 'run_load_test'])
      expect(first).not.toContain(t);
    expect(first.length).toBeLessThan(35);
    expect(prompt(provider, 0)).toContain('- More tools, in groups: call load_tools');
    expect(prompt(provider, 0)).toContain('\n  - git: branches, commits');
    expect(prompt(provider, 0)).not.toContain('- Git: inspect freely');

    const result = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
    expect(result.content).toContain(
      'Loaded git: git_branches, git_commit, git_create_branch, git_push, create_pull_request, ci_runs, ci_failure.',
    );
    expect(result.content).toMatch(/Unknown or unavailable: nope\. Available groups: .*git/);

    // The next model turn has the group's tools and instructions, and no longer lists it.
    expect(names(provider, 1)).toEqual(expect.arrayContaining(['git_commit', 'ci_failure']));
    expect(prompt(provider, 1)).toContain('- Git: inspect freely');
    expect(prompt(provider, 1)).not.toContain('\n  - git: ');
    expect(s.sessions.get(session.id)!.toolGroups).toEqual(['git']);

    // A later run in the same conversation starts with it.
    await run(s, session.id, 'and again');
    expect(names(provider, 2)).toContain('git_push');
  });

  it('loads groups the message hints at, and a group whose tool the model calls directly', async () => {
    const { s, provider, project } = setup([
      { chunks: ['Committed.'] },
      { toolCalls: [call('database_schema', {}, 'c1')] },
      { chunks: ['No databases.'] },
    ]);
    const session = s.sessions.create(undefined, project!.id);
    await run(s, session.id, 'commit the change to a.ts');
    expect(names(provider, 0)).toContain('git_commit');
    expect(s.sessions.get(session.id)!.toolGroups).toEqual(['git']);

    await run(s, session.id, 'what tables are there?');
    expect(names(provider, 1)).not.toContain('database_schema');
    expect(names(provider, 2)).toEqual(
      expect.arrayContaining(['database_schema', 'query_database']),
    );
    expect(s.sessions.get(session.id)!.toolGroups).toEqual(['git', 'database']);
  });

  it('respects the mode: a loaded group only brings its reading tools in ask mode', async () => {
    const { s, provider, project } = setup([
      { toolCalls: [call('load_tools', { groups: ['git'] }, 'c1')] },
      { chunks: ['ok'] },
    ]);
    const session = s.sessions.create(undefined, project!.id, 'ask');
    await run(s, session.id, 'explain a.ts');
    const tools = names(provider, 1);
    expect(tools).toEqual(expect.arrayContaining(['git_branches', 'ci_runs', 'ci_failure']));
    for (const t of ['git_commit', 'git_push', 'create_pull_request'])
      expect(tools).not.toContain(t);
    const result = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
    expect(result.content).toContain('Loaded git: git_branches, ci_runs, ci_failure.');
  });

  it('without a project, offers the machine and server tools from the start', async () => {
    const { s, provider } = setup([{ chunks: ['ok'] }], false);
    const session = s.sessions.create();
    await run(s, session.id, 'hi');
    expect(names(provider, 0)).toEqual(
      expect.arrayContaining([
        'inspect_environment',
        'remote_diagnose',
        'inspect_docker',
        'load_tools',
      ]),
    );
    expect(prompt(provider, 0)).toContain('No project is attached');
  });

  it('turned off, offers every tool as before', async () => {
    const { s, provider, project } = setup([{ chunks: ['ok'] }]);
    s.settings.set('usage.optimization', 'off');
    const session = s.sessions.create(undefined, project!.id);
    await run(s, session.id, 'tidy up a.ts');
    const tools = names(provider, 0);
    expect(tools).toEqual(
      expect.arrayContaining(['git_commit', 'compose_control', 'run_load_test']),
    );
    expect(tools).not.toContain('load_tools');
    expect(prompt(provider, 0)).not.toContain('More tools, in groups');
    expect(prompt(provider, 0)).toContain('- Git: inspect freely');
    // The baseline is the request itself.
    const b = provider.requests[0]!.breakdown!;
    expect(b.baseline).toBe(b.system + b.tools + b.history + b.toolResults);
  });

  it('sends the breakdown, the run and the stable prefix with each chat request', async () => {
    const { s, provider, project } = setup([{ chunks: ['ok'] }]);
    const session = s.sessions.create(undefined, project!.id);
    const r = await run(s, session.id, 'tidy up a.ts');
    const req = provider.requests[0]!;
    expect(req.runId).toBe(r.id);
    expect(req.stablePrefix).toBe(1);
    const b = req.breakdown!;
    expect(b.tools).toBe(estimateTokens(JSON.stringify(req.tools)));
    expect(b.system).toBe(estimateTokens(String(req.messages[0]!.content)));
    // All 70-odd tools and their instructions would have been about twice as much.
    expect(b.baseline).toBeGreaterThan(2 * (b.system + b.tools + b.history + b.toolResults));
  });

  it("every group's hints and tools are sound", () => {
    const all = TOOL_GROUPS.map((g) => g.id);
    expect(new Set(TOOL_GROUPS.flatMap((g) => g.tools)).size).toBe(
      TOOL_GROUPS.flatMap((g) => g.tools).length,
    );
    expect(hintedGroups('the CI build is failing on my branch', all)).toEqual(['git']);
    expect(hintedGroups('why is my docker compose stack down?', all)).toEqual(['docker']);
    expect(hintedGroups('add a button to the settings page', all)).toEqual(['browser']);
    expect(hintedGroups('rename getUser to fetchUser', all)).toEqual(['refactor']);
    expect(hintedGroups('fix the off-by-one in the parser', all)).toEqual([]);
    // Words that only look like DevOps: a git log, a dev server, environment variables.
    expect(hintedGroups('read the git log and the environment variables', all)).toEqual([]);
    expect(hintedGroups('check the nginx logs on staging', all)).toEqual(['devops']);
    expect(hintedGroups('use monitor_status', all)).toEqual(['devops']);
    expect(hintedGroups('post it to wmt', ['app:wmt', 'git'])).toEqual(['app:wmt']);
  });
});

// ------------------------------------------------------------------ usage view

describe('token optimization: usage view and switch', () => {
  it('shows where input went, cache hits and recent runs, and turns optimization off', async () => {
    const s = testServices({ provider: new ScriptedProvider([]) });
    const session = s.sessions.create();
    const record = (runId: string, input: number, cached: number) =>
      s.providerCalls.insert({
        model: 'anthropic:claude-sonnet-5-5',
        operation: 'chat',
        sessionId: session.id,
        status: 'ok',
        errorKind: null,
        durationMs: 900,
        attempts: 1,
        usage: {
          inputTokens: input,
          outputTokens: 50,
          cachedInputTokens: cached,
          cacheWriteTokens: 10,
        },
        tokensEstimated: false,
        runId,
        breakdown: {
          system: 2_000,
          tools: 5_000,
          history: 1_000,
          toolResults: 3_000,
          baseline: 30_000,
        },
      });
    record('run-1', 10_000, 0);
    record('run-1', 11_000, 9_000);
    record('run-2', 12_000, 8_000);
    // An older call without a breakdown counts in the totals but not in the breakdown.
    s.providerCalls.insert({
      model: 'claude-opus-5.5',
      operation: 'chat',
      sessionId: session.id,
      status: 'ok',
      errorKind: null,
      durationMs: 900,
      attempts: 1,
      usage: { inputTokens: 40_000, outputTokens: 10 },
      tokensEstimated: false,
    });

    const app = await buildApp(s);
    const get = async () =>
      (
        await app.inject({ method: 'GET', url: '/api/usage?days=7', headers: H })
      ).json() as UsageSummaryDto;
    const usage = await get();
    expect(usage.optimization).toBe('standard');
    expect(usage.totals.inputTokens).toBe(73_000);
    expect(usage.totals.cachedInputTokens).toBe(17_000);
    expect(usage.context).toEqual({
      requests: 3,
      system: 6_000,
      tools: 15_000,
      history: 3_000,
      toolResults: 9_000,
      baseline: 90_000,
      inputTokens: 33_000,
      cachedInputTokens: 17_000,
    });
    expect(usage.recentRuns.map((r) => [r.runId, r.requests, r.cachedInputTokens])).toEqual(
      expect.arrayContaining([
        ['run-1', 2, 9_000],
        ['run-2', 1, 8_000],
      ]),
    );
    expect(usage.recentRuns[0]!.title).toBe(session.title);

    const put = (payload: Record<string, string>) =>
      app.inject({ method: 'PUT', url: '/api/usage/optimization', headers: H, payload });
    expect((await put({ optimization: 'max' })).statusCode).toBe(400);
    expect((await put({ optimization: 'off' })).json()).toEqual({ optimization: 'off' });
    expect((await get()).optimization).toBe('off');
    expect(s.audit.list(5)[0]).toMatchObject({
      action: 'token_optimization_changed',
      details: { from: 'standard', to: 'off' },
    });
    await app.close();
  });
});
