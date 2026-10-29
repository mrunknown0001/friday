import { execFileSync } from 'node:child_process';
import type { RunEvent, RunReport } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSuggestions, type SuggestionInput } from '../src/reports/suggestions.js';
import { Redactor } from '../src/security/redact.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);
const env = await detectToolEnvironment();
const redactor = new Redactor(['sk-live-0123456789abcdefghij']);

const report = (over: Partial<RunReport> = {}): RunReport => ({
  status: 'verified',
  note: '',
  files: [
    {
      path: 'src/cart.js',
      change: 'modify',
      fromPath: null,
      reverted: false,
      modifiedSince: false,
    },
  ],
  commands: [
    {
      title: 'npm test',
      result: 'exit code 0 (0.2s)',
      exitCode: 0,
      verification: true,
      afterLastChange: true,
    },
  ],
  commits: [],
  ...over,
});
const input = (over: Partial<SuggestionInput> = {}): SuggestionInput => ({
  report: null,
  plan: null,
  pendingMemories: 0,
  testCommand: null,
  uncommitted: null,
  failureLocation: null,
  modelSteps: [],
  ...over,
});

describe('record-based suggestions', () => {
  it('suggests fixing a failing check, pointing at the first location', () => {
    const s = buildSuggestions(
      input({
        report: report({
          status: 'failed',
          commands: [
            {
              title: 'npm test',
              result: 'exit code 1 (0.3s)',
              exitCode: 1,
              verification: true,
              afterLastChange: true,
            },
          ],
        }),
        failureLocation: 'src/cart.js:5:12',
      }),
      redactor,
    );
    expect(s[0]).toEqual({
      label: 'Fix the failing check',
      prompt:
        '`npm test` failed after your last change (exit code 1 (0.3s)). Start from src/cart.js:5:12. Find the cause in the output, fix it, and run the check again.',
      action: 'prompt',
      source: 'records',
    });
  });

  it('suggests running the detected test command when changes are unverified', () => {
    const s = buildSuggestions(
      input({ report: report({ status: 'unverified', commands: [] }), testCommand: 'pnpm test' }),
      redactor,
    );
    expect(s[0]).toMatchObject({
      label: 'Run pnpm test',
      prompt: 'Run `pnpm test` now and report the actual result.',
    });
  });

  it('suggests re-checking drifted files, committing, the next plan step, and reviewing memories', () => {
    const s = buildSuggestions(
      input({
        report: report({
          files: [
            {
              path: 'src/cart.js',
              change: 'modify',
              fromPath: null,
              reverted: false,
              modifiedSince: true,
            },
          ],
        }),
        uncommitted: ['src/cart.js', 'notes.txt'],
        plan: [
          { title: 'Fix loop', status: 'completed' },
          { title: 'Add a regression test for empty carts', status: 'pending' },
        ],
        pendingMemories: 1,
      }),
      redactor,
    );
    expect(s.map((x) => [x.label, x.action])).toEqual([
      ['Re-check edited files', 'prompt'],
      ['Review & commit', 'prompt'],
      ['Next: Add a regression test for empty c…', 'prompt'],
      ['Review 1 proposed memory', 'open_memory'],
    ]);
  });

  it('suggests nothing for verified, committed work with no plan', () => {
    expect(
      buildSuggestions(
        input({ report: report({ commits: ['abc123 Fix'] }), uncommitted: [] }),
        redactor,
      ),
    ).toEqual([]);
  });
});

describe('model suggestions', () => {
  it('validates, redacts, deduplicates against record chips, and caps the total', () => {
    const s = buildSuggestions(
      input({
        report: report({ status: 'unverified', commands: [] }),
        testCommand: 'npm test',
        modelSteps: [
          { label: 'Run npm test', prompt: 'Run npm test and report the result.' },
          { label: 'Add an empty-cart test', prompt: 'Add a test for cartTotal([]) returning 0.' },
          { label: 'Rotate key', prompt: 'Rotate sk-live-0123456789abcdefghij in the dashboard.' },
          { label: 'x', prompt: 'too short label' },
        ],
      }),
      redactor,
    );
    expect(s.map((x) => [x.label, x.source])).toEqual([
      ['Run npm test', 'records'],
      ['Add an empty-cart test', 'model'],
      ['Rotate key', 'model'],
    ]);
    expect(s[2]!.prompt).not.toContain('sk-live');
  });

  it('drops model chips with the same intent as a record chip (regression from the live test)', () => {
    const s = buildSuggestions(
      input({
        report: report(),
        uncommitted: ['src/cart.js'],
        modelSteps: [
          {
            label: 'Commit the fix',
            prompt: 'Commit the cart.js off-by-one fix with an appropriate message.',
          },
          {
            label: 'Add edge-case tests',
            prompt: 'Add tests for an empty cart and a single item.',
          },
        ],
      }),
      redactor,
    );
    expect(s.map((x) => x.label)).toEqual(['Review & commit', 'Add edge-case tests']);
  });
});

describe('suggestions in the agent loop', () => {
  it('ends the run without another model call when suggest_next_steps accompanies the final answer', async () => {
    const provider = new ScriptedProvider([
      {
        chunks: ['The loop starts at 1; it should start at 0 (src/cart.js:5).'],
        toolCalls: [
          call(
            'suggest_next_steps',
            {
              steps: [
                {
                  label: 'Apply the fix',
                  prompt: 'Change the loop in src/cart.js to start at 0, then run the tests.',
                },
              ],
            },
            's',
          ),
        ],
      },
      { chunks: ['this second turn must never be requested'] },
    ]);
    const s = testServices({ provider, toolEnv: env });
    const session = s.sessions.create();
    const { run } = s.runManager.startMessage(session.id, 'why is the total wrong?');
    const events: RunEvent[] = [];
    s.runManager.subscribe(run.id, 0, (e) => events.push(e))?.replay.forEach((e) => events.push(e));
    await s.runManager.waitFor(run.id);
    expect(provider.requests).toHaveLength(1);
    const finished = events.find((e) => e.type === 'run_finished');
    expect(finished).toMatchObject({
      run: {
        status: 'completed',
        suggestions: [{ label: 'Apply the fix', source: 'model', action: 'prompt' }],
      },
    });
    expect(s.runs.get(run.id)?.suggestions).toHaveLength(1);
  });

  it('derives chips from what actually happened: unverified edit in a git repo', async () => {
    const root = makeProject({
      'package.json': '{"scripts":{"test":"node --test"}}',
      'src/cart.js': 'let i = 1;\n',
    });
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'],
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'],
    ]) {
      execFileSync('git', args, { cwd: root });
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          call(
            'edit_file',
            {
              path: 'src/cart.js',
              edits: [{ old_text: 'i = 1', new_text: 'i = 0' }],
              reason: 'fix the loop',
            },
            'e',
          ),
        ],
      },
      { chunks: ['Fixed and verified!'] },
    ]);
    const s = testServices({ provider, toolEnv: env });
    const project = s.projects.create('shop', root);
    const session = s.sessions.create(undefined, project.id);
    const { run } = s.runManager.startMessage(session.id, 'fix it');
    s.runManager.subscribe(run.id, 0, (e) => {
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
    });
    await s.runManager.waitFor(run.id);
    // The model claimed "verified", but nothing ran after the change: Friday says so.
    expect(s.runs.get(run.id)?.suggestions?.map((x) => x.label)).toEqual([
      'Run npm test',
      'Review & commit',
    ]);
  });

  it('adds no chips to failed or cancelled runs', async () => {
    const provider = new ScriptedProvider([{ chunks: ['a', 'b', 'c'], delayMs: 30 }]);
    const s = testServices({ provider, toolEnv: env });
    const session = s.sessions.create();
    const { run } = s.runManager.startMessage(session.id, 'go');
    s.runManager.cancel(run.id);
    await s.runManager.waitFor(run.id);
    expect(s.runs.get(run.id)).toMatchObject({ status: 'cancelled', suggestions: null });
  });
});
