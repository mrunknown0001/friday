import fs from 'node:fs';
import path from 'node:path';
import type { RunEvent } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProviderError } from '../src/providers/errors.js';
import { Redactor } from '../src/security/redact.js';
import { executeToolCall, ToolRegistry, DEFAULT_TOOLS } from '../src/tools/registry.js';
import { defineTool, type ToolContext, type ToolSpec } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import {
  call,
  cleanupProjects,
  makeProject,
  ScriptedProvider,
  testConfig,
  testServices,
} from './helpers.js';

afterEach(cleanupProjects);

const env = await detectToolEnvironment();

function ctx(root: string | null, over: Partial<ToolContext> = {}): ToolContext {
  return {
    project: root
      ? {
          id: 'p1',
          name: 'proj',
          rootPath: root,
          createdAt: '',
          lastOpenedAt: null,
          sandbox: null,
          worktree: null,
        }
      : null,
    sessionId: 's1',
    runId: 'r1',
    signal: new AbortController().signal,
    redactor: new Redactor(['sk-live-0123456789abcdefghij']),
    env,
    maxOutputChars: 20_000,
    setPlan: () => undefined,
    ...over,
  };
}

const registry = new ToolRegistry();
const run = (root: string | null, name: string, args: unknown, over: Partial<ToolContext> = {}) =>
  executeToolCall(registry, call(name, args), ctx(root, over), { timeoutMs: 5_000 });

describe('tool executor', () => {
  it('denies unknown tools and tools in disabled categories', async () => {
    expect(await run(null, 'rm_rf', {})).toMatchObject({ status: 'denied' });
    const deployer = defineTool({
      name: 'deploy',
      description: 'd',
      category: 'network',
      risk: 'critical',
      requiresProject: true,
      schema: z.object({}),
      describeCall: () => '',
      prepare: async () => {
        throw new Error('must never run');
      },
    });
    const reg = new ToolRegistry([...DEFAULT_TOOLS, deployer as unknown as ToolSpec<never>]);
    const res = await executeToolCall(reg, call('deploy', {}), ctx('/tmp'), { timeoutMs: 1000 });
    expect(res.status).toBe('denied');
    expect(res.content).toMatch(/not enabled/);
    // Denied tools are not even advertised to the model.
    expect(reg.definitions(true).map((d) => d.name)).not.toContain('deploy');
  });

  it('never runs protected tools directly, and refuses to register them with execute()', async () => {
    const root = makeProject({ 'a.txt': 'x' });
    const res = await run(root, 'write_file', { path: 'a.txt', content: 'y', reason: 'test it' });
    expect(res).toMatchObject({ status: 'denied', summary: 'Requires approval' });
    expect(fs.readFileSync(path.join(root, 'a.txt'), 'utf8')).toBe('x');
    const sneaky = defineTool({
      name: 'sneaky',
      description: 's',
      category: 'shell',
      risk: 'high',
      requiresProject: false,
      schema: z.object({}),
      describeCall: () => '',
      execute: async () => ({ content: 'ran', summary: 'ran' }),
    });
    expect(() => new ToolRegistry([sneaky as unknown as ToolSpec<never>])).toThrow(/prepare/);
  });

  it('rejects malformed and schema-invalid arguments without executing', async () => {
    const root = makeProject({ 'a.txt': 'x' });
    const bad = await executeToolCall(
      registry,
      { id: 'c', name: 'read_file', argumentsJson: '{"path":' },
      ctx(root),
      { timeoutMs: 1000 },
    );
    expect(bad).toMatchObject({ status: 'error', summary: 'Invalid JSON arguments' });
    const invalid = await run(root, 'read_file', { path: 42 });
    expect(invalid.status).toBe('error');
    expect(invalid.content).toMatch(/invalid arguments for read_file: path/);
  });

  it('requires a project for workspace tools', async () => {
    expect(await run(null, 'read_file', { path: 'a.txt' })).toMatchObject({
      status: 'denied',
      summary: 'No project',
    });
  });

  it('reads files with line numbers and ranges, redacting secrets', async () => {
    const root = makeProject({
      'src/app.ts':
        Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n') +
        '\nconst k = "sk-live-0123456789abcdefghij";\n',
    });
    const res = await run(root, 'read_file', { path: 'src/app.ts', start_line: 2, end_line: 3 });
    expect(res.status).toBe('completed');
    expect(res.content).toBe(
      'src/app.ts (lines 2-3 of 31)\n2 | line 2\n3 | line 3\n[more: continue with start_line=4]',
    );
    expect(res.label).toBe('read_file src/app.ts:2-3');
    const all = await run(root, 'read_file', { path: 'src/app.ts' });
    expect(all.content).not.toContain('sk-live-0123456789abcdefghij');
    expect(all.content).toContain('[REDACTED]');
  });

  it('refuses secrets, traversal, binary files, and reports clear errors', async () => {
    const root = makeProject({ '.env': 'A=1', 'img.png': Buffer.from([0x89, 0x50, 0, 1, 2]) });
    expect((await run(root, 'read_file', { path: '.env' })).content).toMatch(/credentials file/);
    expect((await run(root, 'read_file', { path: '../../etc/passwd' })).content).toMatch(
      /outside the project root/,
    );
    expect((await run(root, 'read_file', { path: 'img.png' })).content).toMatch(/binary file/);
    expect((await run(root, 'read_file', { path: 'nope.ts' })).content).toMatch(/does not exist/);
  });

  it('truncates oversized output', async () => {
    const root = makeProject({ 'big.txt': 'x'.repeat(300) + '\n' + 'y'.repeat(300) });
    const res = await run(root, 'read_file', { path: 'big.txt' }, { maxOutputChars: 400 });
    expect(res.truncated).toBe(true);
    expect(res.content.length).toBeLessThan(600);
  });

  it('times out slow tools and reports cancellation', async () => {
    const slow = defineTool({
      name: 'slow',
      description: 's',
      category: 'read_only',
      risk: 'none',
      requiresProject: false,
      schema: z.object({}),
      describeCall: () => '',
      execute: () => new Promise(() => undefined),
    });
    const reg = new ToolRegistry([slow as unknown as ToolSpec<never>]);
    const timedOut = await executeToolCall(reg, call('slow', {}), ctx(null), { timeoutMs: 50 });
    expect(timedOut).toMatchObject({ status: 'error', summary: 'Timed out' });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 20);
    const cancelled = await executeToolCall(
      reg,
      call('slow', {}),
      ctx(null, { signal: ctrl.signal }),
      { timeoutMs: 5000 },
    );
    expect(cancelled.status).toBe('skipped');
  });

  it('lists directories and searches code', async () => {
    const root = makeProject({
      'src/a.ts': 'export const findMe = 1;\n',
      'src/b.ts': '',
      'node_modules/x.js': 'findMe',
    });
    const list = await run(root, 'list_directory', { path: '.', depth: 2 });
    expect(list.content).toBe('./\nsrc/\n  a.ts (25 B)\n  b.ts (0 B)');
    const found = await run(root, 'search_code', { query: 'findMe' });
    expect(found.content).toContain('src/a.ts\n  1: export const findMe = 1;');
    expect(found.content).not.toContain('node_modules');
    const files = await run(root, 'find_files', { pattern: '**/*.ts' });
    expect(files.content.split('\n').map((l) => l.split(' ')[0])).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('does not reveal whether a credential file matched a search', async () => {
    const root = makeProject({ '.env': 'STRIPE_KEY=sk_test_abcdefghijklmnop', 'src/a.ts': 'x' });
    const hit = await run(root, 'search_code', { query: 'STRIPE_KEY=sk_test_a' });
    const miss = await run(root, 'search_code', { query: 'STRIPE_KEY=sk_test_z' });
    expect(hit.status).toBe('completed');
    // Identical answers, so a model cannot guess the secret one character at a time.
    expect(hit.content).toBe(miss.content.replace('sk_test_z', 'sk_test_a'));
    expect(hit.content).not.toContain('.env');
  });

  it('advertises clean JSON schemas and hides project tools without a project', () => {
    const withProject = registry.definitions(true);
    expect(withProject.map((d) => d.name).sort()).toEqual(
      [
        'delete_file',
        'edit_file',
        'edit_files',
        'git_branches',
        'git_commit',
        'git_create_branch',
        'git_push',
        'create_pull_request',
        'ci_runs',
        'ci_failure',
        'review_changes',
        'report_findings',
        'detect_tests',
        'run_tests',
        'find_references',
        'rename_symbol',
        'move_symbol',
        'list_saved_actions',
        'run_saved_action',
        'git_diff',
        'git_log',
        'git_show',
        'git_status',
        'file_info',
        'find_files',
        'inspect_docker',
        'inspect_environment',
        'monitor_status',
        'prepare_deployment_plan',
        'remote_command',
        'remote_diagnose',
        'search_logs',
        'validate_config',
        'inspect_project',
        'list_directory',
        'move_file',
        'read_file',
        'run_command',
        'search_code',
        'update_plan',
        'write_file',
        'remember',
        'search_memory',
        'suggest_next_steps',
        'request_task_permissions',
        'start_process',
        'list_processes',
        'read_process_output',
        'stop_process',
        'view_image',
        'code_map',
        'find_symbol',
        'screenshot',
        'inspect_page',
        'run_browser_flow',
        'database_schema',
        'query_database',
        'run_load_test',
        'create_document',
        'create_spreadsheet',
        'create_presentation',
        'compose_status',
        'compose_control',
        'dependency_report',
        'dependency_changelog',
        'upgrade_dependencies',
      ].sort(),
    );
    const read = withProject.find((d) => d.name === 'read_file')!;
    expect(read.parameters).toMatchObject({ type: 'object', required: ['path'] });
    expect(JSON.stringify(read.parameters)).not.toContain('$schema');
    expect(JSON.stringify(read.parameters)).not.toContain('9007199254740991');
    expect(
      registry
        .definitions(false)
        .map((d) => d.name)
        .sort(),
    ).toEqual(
      [
        'inspect_docker',
        'inspect_environment',
        'monitor_status',
        'prepare_deployment_plan',
        'remember',
        'remote_command',
        'remote_diagnose',
        'screenshot',
        'inspect_page',
        'run_browser_flow',
        'database_schema',
        'query_database',
        'run_load_test',
        'search_logs',
        'search_memory',
        'suggest_next_steps',
        'update_plan',
      ].sort(),
    );
  });
});

// ------------------------------------------------------------------ agent loop

function setup(
  provider: ScriptedProvider,
  files: Record<string, string> = { 'src/app.ts': 'export const answer = 42;\n' },
  agent = {},
) {
  const config = testConfig();
  config.agent = { ...config.agent, ...agent };
  const s = testServices({ provider, config, toolEnv: env });
  const root = makeProject(files);
  const project = s.projects.create('demo', root);
  const session = s.sessions.create(undefined, project.id);
  return { s, root, project, session };
}

function collect(s: ReturnType<typeof setup>['s'], runId: string) {
  const events: RunEvent[] = [];
  const sub = s.runManager.subscribe(runId, 0, (e) => events.push(e));
  events.push(...(sub?.replay ?? []));
  return events;
}

describe('agent loop', () => {
  it('runs tools, feeds results back, and finishes with an answer', async () => {
    const provider = new ScriptedProvider([
      {
        chunks: ['Let me look.'],
        toolCalls: [
          call('search_code', { query: 'answer' }, 'c1'),
          call('read_file', { path: 'src/app.ts' }, 'c2'),
        ],
      },
      { chunks: ['`answer` is 42 (src/app.ts:1).'] },
    ]);
    const { s, session } = setup(provider);
    const { run } = s.runManager.startMessage(session.id, 'What is answer?');
    const events = collect(s, run.id);
    await s.runManager.waitFor(run.id);

    expect(s.runs.get(run.id)?.status).toBe('completed');
    expect(provider.requests).toHaveLength(2);
    // Tools were offered, and the second request carried the tool results.
    expect(provider.requests[0]!.tools?.map((t) => t.name)).toContain('read_file');
    const second = provider.requests[1]!.messages;
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool']);
    const toolMsg = second[4]!;
    expect(toolMsg.role === 'tool' && toolMsg.toolCallId).toBe('c2');
    expect(toolMsg.role === 'tool' && toolMsg.content).toContain('1 | export const answer = 42;');

    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'tool_started')).toHaveLength(2);
    expect(
      events.filter((e) => e.type === 'tool_finished').map((e) => (e as { status: string }).status),
    ).toEqual(['completed', 'completed']);

    const stored = s.messages.listBySession(session.id);
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    expect(stored[1]!.toolCalls?.map((c) => c.name)).toEqual(['search_code', 'read_file']);
    expect(stored[3]!.tool).toMatchObject({
      callId: 'c2',
      name: 'read_file',
      status: 'completed',
      summary: 'src/app.ts:1-1 of 1 lines',
    });
    expect(s.runs.get(run.id)).toMatchObject({ status: 'completed' });
  });

  it('includes the project root and detected stack in the system prompt', async () => {
    const provider = new ScriptedProvider([{ chunks: ['ok'] }]);
    const { s, session, root } = setup(provider, {
      'package.json': '{"dependencies":{"react":"1"}}',
    });
    const { run } = s.runManager.startMessage(session.id, 'hi');
    await s.runManager.waitFor(run.id);
    const system = provider.requests[0]!.messages[0]!;
    expect(system.role === 'system' && system.content).toContain(`Root: ${root}`);
    expect(system.role === 'system' && system.content).toContain('React');
    expect(system.role === 'system' && system.content).toContain('Change with approval');
  });

  it('stops with a blocked status when the iteration limit is reached', async () => {
    const steps = Array.from({ length: 5 }, (_, i) => ({
      toolCalls: [call('file_info', { path: 'src/app.ts' }, `c${i}`)],
    }));
    const provider = new ScriptedProvider(
      steps.map((st, i) => ({
        ...st,
        toolCalls: [call('list_directory', { path: '.', depth: (i % 5) + 1 }, `c${i}`)],
      })),
    );
    const { s, session } = setup(provider, undefined, { maxIterations: 3 });
    const { run } = s.runManager.startMessage(session.id, 'explore forever');
    await s.runManager.waitFor(run.id);
    expect(s.runs.get(run.id)).toMatchObject({
      status: 'blocked',
      errorKind: 'limit_reached',
      retryable: true,
    });
    expect(provider.requests).toHaveLength(3);
  });

  it('enforces the tool-call limit and records unexecuted calls', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [1, 2, 3].map((d) => call('list_directory', { path: '.', depth: d }, `c${d}`)) },
    ]);
    const { s, session } = setup(provider, undefined, { maxToolCalls: 2 });
    const { run } = s.runManager.startMessage(session.id, 'go');
    await s.runManager.waitFor(run.id);
    expect(s.runs.get(run.id)).toMatchObject({ status: 'blocked', errorKind: 'limit_reached' });
    const tools = s.messages.listBySession(session.id).filter((m) => m.role === 'tool');
    expect(tools.map((t) => t.tool?.status)).toEqual(['completed', 'completed', 'skipped']);
  });

  it('skips repeated identical calls and blocks after failing turns in a row', async () => {
    const same = () => call('read_file', { path: 'missing.ts' });
    const provider = new ScriptedProvider([
      // One turn of blind calls counts as one failure...
      { toolCalls: [same(), same(), same()] },
      { toolCalls: [call('read_file', { path: 'gone.ts' })] },
      // ...and so does each later turn whose calls all fail.
      { toolCalls: [call('read_file', { path: 'nope.ts' })] },
      { chunks: ['unused'] },
    ]);
    const { s, session } = setup(provider, undefined, { maxConsecutiveToolFailures: 3 });
    const { run } = s.runManager.startMessage(session.id, 'read it');
    await s.runManager.waitFor(run.id);
    const tools = s.messages.listBySession(session.id).filter((m) => m.role === 'tool');
    expect(tools.map((t) => t.tool?.status)).toEqual([
      'error',
      'error',
      'skipped',
      'error',
      'error',
    ]);
    expect(tools[2]!.content).toMatch(/identical read_file call already made 2 times/);
    expect(s.runs.get(run.id)).toMatchObject({ status: 'blocked', errorKind: 'repeated_failures' });
    expect(s.runs.get(run.id)?.errorMessage).toMatch(/failed tool calls in 3 turns in a row/);
  });

  it('lets a model correct a turn of blind guesses', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          call('read_file', { path: 'a.ts' }, 'g1'),
          call('read_file', { path: 'b.ts' }, 'g2'),
          call('read_file', { path: 'c.ts' }, 'g3'),
          call('read_file', { path: 'd.ts' }, 'g4'),
        ],
      },
      { toolCalls: [call('read_file', { path: 'src/app.ts' }, 'ok')] },
      { chunks: ['Found it.'] },
    ]);
    const { s, session } = setup(provider, undefined, { maxConsecutiveToolFailures: 3 });
    const { run } = s.runManager.startMessage(session.id, 'read it');
    await s.runManager.waitFor(run.id);
    expect(s.runs.get(run.id)?.status).toBe('completed');
  });

  it('cancels between tool calls and records remaining calls as skipped', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          call('list_directory', { path: '.' }, 'a'),
          call('file_info', { path: 'src/app.ts' }, 'b'),
        ],
      },
    ]);
    const { s, session } = setup(provider);
    const { run } = s.runManager.startMessage(session.id, 'go');
    s.runManager.subscribe(run.id, 0, (e) => {
      if (e.type === 'tool_finished' && e.callId === 'a') s.runManager.cancel(run.id);
    });
    await s.runManager.waitFor(run.id);
    expect(s.runs.get(run.id)?.status).toBe('cancelled');
    const tools = s.messages.listBySession(session.id).filter((m) => m.role === 'tool');
    expect(tools.map((t) => [t.toolCallId, t.tool?.status])).toEqual([
      ['a', 'completed'],
      ['b', 'skipped'],
    ]);
  });

  it('publishes plans to the session', async () => {
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          call('update_plan', {
            steps: [
              { title: 'Find config', status: 'in_progress' },
              { title: 'Explain', status: 'pending' },
            ],
          }),
        ],
      },
      { chunks: ['done'] },
    ]);
    const { s, session } = setup(provider);
    const { run } = s.runManager.startMessage(session.id, 'plan it');
    const events = collect(s, run.id);
    await s.runManager.waitFor(run.id);
    expect(events.find((e) => e.type === 'plan_updated')).toMatchObject({
      plan: [{ title: 'Find config' }, { title: 'Explain' }],
    });
    expect(s.sessions.get(session.id)?.plan).toEqual([
      { title: 'Find config', status: 'in_progress' },
      { title: 'Explain', status: 'pending' },
    ]);
  });

  it('confines tools to the session project (no cross-project access)', async () => {
    const other = makeProject({ 'secret-plan.md': 'project B internals' });
    const provider = new ScriptedProvider([
      { toolCalls: [call('read_file', { path: `${other}/secret-plan.md` }, 'x')] },
      { chunks: ['cannot'] },
    ]);
    const { s, session } = setup(provider);
    s.projects.create('B', other);
    const { run } = s.runManager.startMessage(session.id, 'read the other project');
    await s.runManager.waitFor(run.id);
    const tool = s.messages.listBySession(session.id).find((m) => m.role === 'tool')!;
    expect(tool.tool?.status).toBe('error');
    expect(tool.content).toMatch(/outside the project root/);
    expect(tool.content).not.toContain('project B internals');
  });

  it('offers only update_plan without a project, and no tools if the model lacks tool support', async () => {
    const provider = new ScriptedProvider([{ chunks: ['a'] }, { chunks: ['b'] }]);
    const s = testServices({ provider, toolEnv: env });
    const plain = s.sessions.create();
    let { run } = s.runManager.startMessage(plain.id, 'hi');
    await s.runManager.waitFor(run.id);
    // Without a project only machine-level and plan tools are offered; no workspace file tools.
    const offered = provider.requests[0]!.tools?.map((t) => t.name) ?? [];
    expect(offered).toContain('update_plan');
    expect(offered).not.toContain('read_file');
    expect(offered).not.toContain('run_command');

    s.capabilities.saveProbe('test-model', {
      streaming: 'supported',
      toolCalling: 'unsupported',
      imageInput: 'unknown',
      notes: null,
    });
    ({ run } = s.runManager.startMessage(plain.id, 'again'));
    await s.runManager.waitFor(run.id);
    expect(provider.requests[1]!.tools).toBeUndefined();
  });

  it('repairs history when a run died between a tool call and its result', async () => {
    const provider = new ScriptedProvider([{ chunks: ['recovered'] }]);
    const { s, session } = setup(provider);
    // Simulate a crash: assistant asked for a tool, no result was stored.
    s.messages.insert({
      sessionId: session.id,
      role: 'user',
      content: 'first',
      status: 'complete',
    });
    s.messages.insert({
      sessionId: session.id,
      role: 'assistant',
      content: '',
      status: 'complete',
      toolCalls: [call('read_file', { path: 'x' }, 'lost')],
    });
    const { run } = s.runManager.startMessage(session.id, 'continue');
    await s.runManager.waitFor(run.id);
    const msgs = provider.requests[0]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(msgs[3]!.role === 'tool' && msgs[3]!.toolCallId).toBe('lost');
    expect(msgs[3]!.role === 'tool' && msgs[3]!.content).toMatch(/interrupted/);
  });

  it('retry after a provider failure continues with completed tool work in context', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [call('file_info', { path: 'src/app.ts' }, 'f1')] },
      { error: new ProviderError('rate_limit') },
      { chunks: ['final'] },
    ]);
    const { s, session } = setup(provider);
    const first = s.runManager.startMessage(session.id, 'info?');
    await s.runManager.waitFor(first.run.id);
    expect(s.runs.get(first.run.id)?.status).toBe('failed');
    const { run } = s.runManager.retry(session.id);
    await s.runManager.waitFor(run.id);
    expect(s.runs.get(run.id)?.status).toBe('completed');
    expect(provider.requests[2]!.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
  });
});
