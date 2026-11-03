import fs from 'node:fs';
import path from 'node:path';
import type { RunDto, SessionSummaryDto } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);

const H = { host: '127.0.0.1:4317', 'x-friday-client': '1', 'content-type': 'application/json' };

function setup(steps: ConstructorParameters<typeof ScriptedProvider>[0]) {
  const provider = new ScriptedProvider(steps);
  const s = testServices({ provider });
  const root = makeProject({ 'src/a.ts': 'export const a = 1;\n' });
  const project = s.projects.create('p', root);
  return { s, provider, root, project };
}

async function run(s: ReturnType<typeof setup>['s'], sessionId: string, text: string) {
  const { run } = s.runManager.startMessage(sessionId, text);
  await s.runManager.waitFor(run.id);
  return s.runs.get(run.id)!;
}

const names = (p: ScriptedProvider, i: number) => p.requests[i]!.tools!.map((t) => t.name);

describe('modes', () => {
  it('ask mode offers only reading tools and refuses the others if called anyway', async () => {
    const { s, provider, root, project } = setup([
      {
        toolCalls: [
          call('read_file', { path: 'src/a.ts' }, 'c1'),
          call('write_file', { path: 'src/a.ts', content: 'hacked' }, 'c2'),
        ],
      },
      { chunks: ['a is 1.'] },
    ]);
    const session = s.sessions.create(undefined, project.id, 'ask');
    const r = await run(s, session.id, 'what is a?');
    expect(r.status).toBe('completed');
    expect(r.mode).toBe('ask');

    const offered = names(provider, 0);
    expect(offered).toEqual(
      expect.arrayContaining(['read_file', 'search_code', 'update_plan', 'ask_user']),
    );
    for (const t of [
      'write_file',
      'edit_file',
      'run_command',
      'git_commit',
      'request_task_permissions',
      'suggest_mode',
    ])
      expect(offered).not.toContain(t);
    const prompt = String(provider.requests[0]!.messages[0]!.content);
    expect(prompt).toContain('## Mode: ask');
    // The mode section comes after the general workflow, which it overrides.
    expect(prompt.indexOf('## Mode: ask')).toBeGreaterThan(prompt.indexOf('## Capabilities'));

    const tools = s.messages.listBySession(session.id).filter((m) => m.role === 'tool');
    expect(tools[0]!.content).toContain('export const a = 1;');
    expect(tools[1]!.content).toMatch(
      /^Not executed: write_file is not available in ask mode, which only reads/,
    );
    expect(fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(s.approvalRepo.listBySession(session.id)).toEqual([]);
    // A change it wasn't allowed to make: one click switches to code mode and asks for it.
    expect(r.suggestions![0]).toEqual({
      label: 'Switch to Code mode',
      prompt: 'Go ahead and make that change.',
      action: 'switch_mode',
      mode: 'code',
      source: 'records',
    });
  });

  it('plan mode plans without changes and offers to build the plan in code mode', async () => {
    const { s, provider, project } = setup([
      {
        toolCalls: [
          call('update_plan', {
            steps: [
              { title: 'Add the cache module', status: 'pending' },
              { title: 'Use it in the API', status: 'pending' },
            ],
          }),
        ],
      },
      { chunks: ['Here is the plan. Accept it to have it built.'] },
    ]);
    const session = s.sessions.create(undefined, project.id, 'plan');
    const r = await run(s, session.id, 'add caching');
    expect(names(provider, 0)).not.toContain('write_file');
    expect(String(provider.requests[0]!.messages[0]!.content)).toContain('## Mode: plan');
    // "Accept and build" switches to code mode and asks for the work; no "Next: step" chip.
    expect(r.suggestions![0]).toEqual({
      label: 'Accept and build',
      prompt: 'I accept the plan. Carry it out step by step, keeping the plan up to date.',
      action: 'switch_mode',
      mode: 'code',
      source: 'records',
    });
    expect(r.suggestions!.some((x) => x.label.startsWith('Next:'))).toBe(false);
  });

  it('auto mode may suggest a mode, ending the turn; code and debug offer every tool', async () => {
    const { s, provider, project } = setup([
      {
        chunks: ['This looks like a bug to track down.'],
        toolCalls: [call('suggest_mode', { mode: 'debug', reason: 'a failing test to reproduce' })],
      },
      { chunks: ['ok'] },
      { chunks: ['ok'] },
    ]);
    const session = s.sessions.create(undefined, project.id);
    const r = await run(s, session.id, 'the checkout test fails');
    expect(r.mode).toBe('auto');
    expect(names(provider, 0)).toContain('suggest_mode');
    // suggest_mode is a final annotation: no extra model turn.
    expect(provider.requests).toHaveLength(1);
    expect(r.suggestions).toContainEqual({
      label: 'Switch to Debug mode',
      prompt: '',
      action: 'switch_mode',
      mode: 'debug',
      source: 'model',
    });

    s.sessions.setMode(session.id, 'debug');
    await run(s, session.id, 'go');
    expect(names(provider, 1)).toEqual(expect.arrayContaining(['write_file', 'run_command']));
    expect(names(provider, 1)).not.toContain('suggest_mode');
    expect(String(provider.requests[1]!.messages[0]!.content)).toContain('Reproduce it first');
    s.sessions.setMode(session.id, 'code');
    await run(s, session.id, 'go');
    expect(String(provider.requests[2]!.messages[0]!.content)).toContain('## Mode: code');
  });

  it('keeps the mode with the conversation, changed only by the user', async () => {
    const { s, project } = setup([]);
    const app = await buildApp(s);
    const created = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: H,
      payload: { projectId: project.id, mode: 'plan' },
    });
    const session = created.json<SessionSummaryDto>();
    expect(session.mode).toBe('plan');
    expect(
      (
        await app.inject({ method: 'POST', url: '/api/sessions', headers: H, payload: {} })
      ).json<SessionSummaryDto>().mode,
    ).toBe('auto');

    const patch = (payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/sessions/${session.id}`, headers: H, payload });
    const changed = await patch({ mode: 'debug' });
    expect(changed.json<SessionSummaryDto>()).toMatchObject({
      mode: 'debug',
      title: session.title,
    });
    expect((await patch({ mode: 'yolo' })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ title: 'Renamed' })).json<SessionSummaryDto>()).toMatchObject({
      title: 'Renamed',
      mode: 'debug',
    });
    expect(s.audit.list().find((e) => e.action === 'mode_changed')!.details).toEqual({
      from: 'plan',
      to: 'debug',
    });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/sessions/${session.id}`,
      headers: H,
    });
    expect(detail.json<{ mode: string; runs: RunDto[] }>().mode).toBe('debug');
  });
});
