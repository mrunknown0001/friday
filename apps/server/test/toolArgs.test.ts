import { execFileSync } from 'node:child_process';
import type { ApprovalDto } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { runCommand } from '../src/tools/commandTool.js';
import { editFile, writeFile } from '../src/tools/fileTools.js';
import { gitCommit } from '../src/tools/gitTools.js';
import { parseToolArgs } from '../src/tools/registry.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);

describe('tool arguments sent as JSON strings', () => {
  it('decodes a list or object written as a string where the schema wants one', () => {
    const commit = parseToolArgs(gitCommit.schema, {
      message: 'Fix total',
      paths: '["src/cart.js", "src/util.js"]',
      reason: 'commit the fix',
    });
    expect(commit.success && commit.data.paths).toEqual(['src/cart.js', 'src/util.js']);

    // Nested: a list of objects as a string, with defaults applied afterwards.
    const edit = parseToolArgs(editFile.schema, {
      path: 'a.ts',
      edits: JSON.stringify([{ old_text: 'a', new_text: 'b' }]),
      reason: 'rename',
    });
    expect(edit.success && edit.data.edits).toEqual([
      { old_text: 'a', new_text: 'b', replace_all: false },
    ]);

    // Schemas with their own checks still apply them.
    const run = parseToolArgs(runCommand.schema, { argv: ' ["npm", "test"] ', reason: 'verify' });
    expect(run.success && run.data.argv).toEqual(['npm', 'test']);
    expect(
      parseToolArgs(runCommand.schema, {
        argv: '["npm"]',
        shell_command: 'npm test',
        reason: 'both',
      }).success,
    ).toBe(false);
  });

  it('loosens nothing else', () => {
    // A string field keeps a string that looks like JSON.
    const write = parseToolArgs(writeFile.schema, {
      path: 'a.json',
      content: '[1, 2]',
      reason: 'data',
    });
    expect(write.success && write.data.content).toBe('[1, 2]');
    // Not JSON, the wrong shape, or wrong contents: refused with the schema's message.
    for (const paths of ['src/cart.js', '{"a": 1}', '[1, 2]', '["a", ']) {
      const r = parseToolArgs(gitCommit.schema, { message: 'Fix', paths, reason: 'x x x' });
      expect(r.success, paths).toBe(false);
    }
    const bad = parseToolArgs(gitCommit.schema, {
      message: 'Fix',
      paths: 'src/cart.js',
      reason: 'abc',
    });
    expect(!bad.success && bad.error.issues[0]!.message).toMatch(/expected array, received string/);
  });

  it('lets the agent commit when the model sends the paths as a string', async () => {
    const root = makeProject({ 'src/cart.js': 'export const total = 1;\n' });
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', ...args], { cwd: root });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
    execFileSync('sh', ['-c', 'echo "export const total = 2;" > src/cart.js'], { cwd: root });

    const s = testServices({
      provider: new ScriptedProvider([
        {
          toolCalls: [
            call('git_commit', {
              message: 'Fix total',
              paths: '["src/cart.js"]',
              reason: 'save it',
            }),
          ],
        },
        { chunks: ['done'] },
      ]),
    });
    const project = s.projects.create('shop', root);
    const session = s.sessions.create(undefined, project.id);
    const { run } = s.runManager.startMessage(session.id, 'commit it');
    const approval = await new Promise<ApprovalDto>((resolve) =>
      s.runManager.subscribe(
        run.id,
        0,
        (e) => e.type === 'approval_requested' && resolve(e.approval),
      ),
    );
    expect(approval.details).toMatchObject({ kind: 'git', operation: 'commit' });
    s.approvals.decide(approval.id, {
      decision: 'approve',
      actionHash: approval.actionHash,
      sessionId: session.id,
    });
    await s.runManager.waitFor(run.id);
    expect(execFileSync('git', ['log', '--format=%s', '-1'], { cwd: root }).toString().trim()).toBe(
      'Fix total',
    );
  });
});
