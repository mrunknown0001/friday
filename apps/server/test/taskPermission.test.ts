import fs from 'node:fs';
import path from 'node:path';
import type { ApprovalDto, AppNotice, RunEvent, TaskPermissionDto } from '@friday/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { covers, similarScope, type TaskPermission } from '../src/approvals/taskPermission.js';
import type { Proposal } from '../src/tools/types.js';
import { detectToolEnvironment } from '../src/workspace/environment.js';
import { call, cleanupProjects, makeProject, ScriptedProvider, testServices } from './helpers.js';

afterEach(cleanupProjects);
const env = await detectToolEnvironment();

const permission = (over: Partial<TaskPermission> = {}): TaskPermission => ({
  approvalId: 'grant-1',
  runId: 'run-1',
  files: ['src/cart.js', 'test/'],
  commands: [['npm', 'test']],
  sites: [],
  maxActions: 5,
  used: 0,
  expiresAt: Date.now() + 60_000,
  ended: null,
  ...over,
});

const fileProposal = (
  changes: Array<{ path: string; change: 'create' | 'modify' | 'delete' | 'move' }>,
  over: Partial<Proposal> = {},
): Proposal => ({
  title: 't',
  summary: 's',
  category: 'file_modify',
  risk: 'medium',
  details: {
    kind: 'file_change',
    changes: changes.map((c) => ({ ...c, diff: '', added: 1, removed: 1 })),
  },
  fingerprint: 'f',
  apply: async () => ({ content: '', summary: '' }),
  ...over,
});

const commandProposal = (
  argv: string[] | null,
  over: { shell?: boolean; cwd?: string; network?: boolean; risk?: Proposal['risk'] } = {},
): Proposal => ({
  title: 't',
  summary: 's',
  category: 'shell',
  risk: over.risk ?? 'medium',
  details: {
    kind: 'command',
    argv,
    shellCommand: argv ? null : 'npm test | tee out',
    shell: over.shell ?? argv === null,
    cwd: over.cwd ?? '.',
    host: 'local',
    timeoutSeconds: 60,
    env: [],
    network: over.network ?? false,
    riskReasons: [],
    sandbox: null,
  },
  fingerprint: 'f',
  apply: async () => ({ content: '', summary: '' }),
});

const flowProposal = (origin: string): Proposal => ({
  title: 't',
  summary: 's',
  category: 'browser',
  risk: 'medium',
  details: {
    kind: 'browser_flow',
    title: 'Sign in',
    startUrl: `${origin}/login`,
    origin,
    width: 1280,
    height: 800,
    steps: [{ action: 'click', description: 'Click button "Sign in"' }],
    engine: 'chrome',
    riskReasons: [],
  },
  fingerprint: 'f',
  apply: async () => ({ content: '', summary: '' }),
});

describe('what a task permission covers', () => {
  it('covers browser flows only on the listed sites', () => {
    const p = permission({ sites: ['http://localhost:5173'] });
    expect(covers(p, 'run_browser_flow', flowProposal('http://localhost:5173'))).toBe(true);
    expect(covers(p, 'run_browser_flow', flowProposal('http://localhost:3000'))).toBe(false);
    expect(covers(permission(), 'run_browser_flow', flowProposal('http://localhost:5173'))).toBe(
      false,
    );
    expect(similarScope('run_browser_flow', flowProposal('http://localhost:5173'))).toEqual({
      files: [],
      commands: [],
      sites: ['http://localhost:5173'],
    });
  });

  it('covers listed files and folders, only for creating or modifying them', () => {
    const p = permission();
    expect(covers(p, 'edit_file', fileProposal([{ path: 'src/cart.js', change: 'modify' }]))).toBe(
      true,
    );
    expect(
      covers(p, 'write_file', fileProposal([{ path: 'test/cart.test.js', change: 'create' }])),
    ).toBe(true);
    expect(
      covers(
        p,
        'edit_files',
        fileProposal([
          { path: 'src/cart.js', change: 'modify' },
          { path: 'src/other.js', change: 'modify' },
        ]),
      ),
    ).toBe(false);
    expect(covers(p, 'edit_file', fileProposal([{ path: 'src/cart.jsx', change: 'modify' }]))).toBe(
      false,
    );
    expect(covers(p, 'edit_file', fileProposal([{ path: 'testdata/x', change: 'modify' }]))).toBe(
      false,
    );
    expect(
      covers(p, 'delete_file', fileProposal([{ path: 'src/cart.js', change: 'delete' }])),
    ).toBe(false);
  });

  it('covers only the exact listed commands, without a shell, in the project root', () => {
    const p = permission();
    expect(covers(p, 'run_command', commandProposal(['npm', 'test']))).toBe(true);
    expect(covers(p, 'run_command', commandProposal(['npm', 'test', '--', '-u']))).toBe(false);
    expect(covers(p, 'run_command', commandProposal(['npm', 'test'], { cwd: 'sub' }))).toBe(false);
    expect(covers(p, 'run_command', commandProposal(['npm', 'test'], { network: true }))).toBe(
      false,
    );
    expect(covers(p, 'run_command', commandProposal(null))).toBe(false);
  });

  it('never covers risky, confirmed, other-tool, ended, expired or used-up cases', () => {
    const edit = fileProposal([{ path: 'src/cart.js', change: 'modify' }]);
    expect(covers(permission(), 'edit_file', { ...edit, risk: 'high' })).toBe(false);
    expect(covers(permission(), 'edit_file', { ...edit, confirmationRequired: 'prod' })).toBe(
      false,
    );
    expect(covers(permission(), 'git_commit', edit)).toBe(false);
    expect(covers(permission({ ended: 'revoked' }), 'edit_file', edit)).toBe(false);
    expect(covers(permission({ expiresAt: Date.now() - 1 }), 'edit_file', edit)).toBe(false);
    expect(covers(permission({ used: 5 }), 'edit_file', edit)).toBe(false);
    expect(covers(null, 'edit_file', edit)).toBe(false);
  });
});

describe('task permissions in the agent loop', () => {
  function setup(steps: ConstructorParameters<typeof ScriptedProvider>[0]) {
    const root = makeProject({
      'package.json': '{"type":"module","scripts":{"test":"node --test"}}',
      'src/cart.js': 'let i = 1;\n',
      'src/other.js': 'x\n',
    });
    const provider = new ScriptedProvider(steps);
    const s = testServices({ provider, toolEnv: env });
    const project = s.projects.create('shop', root);
    const session = s.sessions.create(undefined, project.id);
    return { s, root, session };
  }

  const grantCall = call(
    'request_task_permissions',
    {
      plan: ['Fix the loop', 'Run the tests'],
      files: ['src/cart.js'],
      commands: [['node', '--version']],
      reason: 'Fix and verify',
    },
    'g',
  );
  const editCart = (id: string, from: string, to: string) =>
    call(
      'edit_file',
      { path: 'src/cart.js', edits: [{ old_text: from, new_text: to }], reason: 'fix' },
      id,
    );

  it('asks once, then runs covered actions without asking; everything else still asks', async () => {
    const { s, root, session } = setup([
      { toolCalls: [grantCall] },
      { toolCalls: [editCart('e1', 'i = 1', 'i = 0')] },
      {
        toolCalls: [call('run_command', { argv: ['node', '--version'], reason: 'check' }, 'c1')],
      },
      {
        toolCalls: [
          call(
            'edit_file',
            { path: 'src/other.js', edits: [{ old_text: 'x', new_text: 'y' }], reason: 'also' },
            'e2',
          ),
        ],
      },
      { chunks: ['Done.'] },
    ]);
    const notices: AppNotice[] = [];
    s.runManager.onNotice((n) => notices.push(n));
    const { run } = s.runManager.startMessage(session.id, 'fix it');
    const asked: ApprovalDto[] = [];
    const permissions: TaskPermissionDto[] = [];
    s.runManager.subscribe(run.id, 0, (e: RunEvent) => {
      if (e.type === 'task_permission') permissions.push(e.permission);
      if (e.type === 'approval_requested' && e.approval.status === 'pending') {
        // Mirror the UI: the user decides only on what is actually waiting for them.
        setTimeout(() => {
          const current = s.approvalRepo.get(e.approval.id)!;
          if (current.status !== 'pending') return;
          asked.push(current);
          s.approvals.decide(current.id, {
            decision: current.toolName === 'request_task_permissions' ? 'approve' : 'reject',
            actionHash: current.actionHash,
            sessionId: session.id,
          });
        }, 5);
      }
    });
    await s.runManager.waitFor(run.id);

    // Two human decisions: the permission itself, and the edit outside it (rejected).
    expect(asked.map((a) => a.toolName)).toEqual(['request_task_permissions', 'edit_file']);
    expect(asked[0]!.details).toMatchObject({
      kind: 'task_permissions',
      files: ['src/cart.js'],
      commands: [['node', '--version']],
    });
    expect(fs.readFileSync(path.join(root, 'src/cart.js'), 'utf8')).toBe('let i = 0;\n');
    expect(fs.readFileSync(path.join(root, 'src/other.js'), 'utf8')).toBe('x\n');

    const all = s.approvalRepo.listByRun(run.id);
    const grant = all.find((a) => a.toolName === 'request_task_permissions')!;
    const auto = all.filter((a) => a.grantedBy === grant.id);
    expect(auto.map((a) => [a.toolName, a.status])).toEqual([
      ['edit_file', 'executed'],
      ['run_command', 'executed'],
    ]);
    // The automatic edit is recorded like any other, so it can be undone.
    expect(s.fileChanges.listByRun(run.id).map((c) => c.approvalId)).toContain(auto[0]!.id);
    expect(permissions.at(-1)).toMatchObject({ active: true, used: 2, approvalId: grant.id });
    // Only actions that waited for the user are announced app-wide.
    expect(notices.filter((n) => n.type === 'approval_requested').map((n) => n.approvalId)).toEqual(
      asked.map((a) => a.id),
    );
    expect(notices.at(-1)).toMatchObject({ type: 'run_finished', status: 'completed' });
  });

  it('lets the user allow similar actions while approving one (no request from the model)', async () => {
    const test = (id: string) =>
      call('run_command', { argv: ['node', '--version'], reason: 'test' }, id);
    const { s, root, session } = setup([
      { toolCalls: [editCart('e1', 'i = 1', 'i = 2')] },
      { toolCalls: [test('t1')] },
      { toolCalls: [editCart('e2', 'i = 2', 'i = 0')] },
      { toolCalls: [test('t2')] },
      { chunks: ['Done.'] },
    ]);
    const { run } = s.runManager.startMessage(session.id, 'fix it');
    const asked: string[] = [];
    let latest: TaskPermissionDto | null = null;
    s.runManager.subscribe(run.id, 0, (e) => {
      if (e.type === 'task_permission') latest = e.permission;
      if (e.type === 'approval_requested' && e.approval.status === 'pending') {
        setTimeout(() => {
          const a = s.approvalRepo.get(e.approval.id)!;
          if (a.status !== 'pending') return;
          asked.push(a.title);
          s.approvals.decide(a.id, {
            decision: 'approve',
            actionHash: a.actionHash,
            sessionId: session.id,
            allowSimilar: true,
          });
        }, 5);
      }
    });
    await s.runManager.waitFor(run.id);
    // The first edit and the first test asked; their repeats ran under the permission.
    expect(asked).toEqual(['Edit src/cart.js', 'Run: node --version']);
    expect(fs.readFileSync(path.join(root, 'src/cart.js'), 'utf8')).toBe('let i = 0;\n');
    expect(latest).toMatchObject({
      files: ['src/cart.js'],
      commands: [['node', '--version']],
      used: 2,
      active: true,
    });
    const auto = s.approvalRepo.listByRun(run.id).filter((a) => a.grantedBy);
    expect(auto.map((a) => a.status)).toEqual(['executed', 'executed']);
  });

  it('stops covering actions once revoked', async () => {
    const { s, root, session } = setup([
      { toolCalls: [grantCall] },
      { toolCalls: [editCart('e1', 'i = 1', 'i = 2')] },
      { toolCalls: [editCart('e2', 'i = 2', 'i = 3')] },
      { chunks: ['Done.'] },
    ]);
    const { run } = s.runManager.startMessage(session.id, 'go');
    let revoked = false;
    const asked: string[] = [];
    s.runManager.subscribe(run.id, 0, (e) => {
      if (e.type === 'approval_resolved' && e.approval.grantedBy && !revoked) {
        revoked = s.runManager.revokeTaskPermission(run.id);
      }
      if (e.type === 'approval_requested' && e.approval.status === 'pending') {
        setTimeout(() => {
          const a = s.approvalRepo.get(e.approval.id)!;
          if (a.status !== 'pending') return;
          asked.push(a.toolName);
          s.approvals.decide(a.id, {
            decision: a.toolName === 'request_task_permissions' ? 'approve' : 'reject',
            actionHash: a.actionHash,
            sessionId: session.id,
          });
        }, 5);
      }
    });
    await s.runManager.waitFor(run.id);
    expect(revoked).toBe(true);
    // The first edit ran under the permission; after revoking, the second one had to ask.
    expect(asked).toEqual(['request_task_permissions', 'edit_file']);
    expect(fs.readFileSync(path.join(root, 'src/cart.js'), 'utf8')).toBe('let i = 2;\n');
  });

  it('refuses to include credential files or risky and network commands', async () => {
    const { s, session } = setup([
      {
        toolCalls: [
          call(
            'request_task_permissions',
            { plan: ['Do it'], files: ['.env'], commands: [], reason: 'nope' },
            'a',
          ),
          call(
            'request_task_permissions',
            { plan: ['Do it'], files: ['src/'], commands: [['rm', '-rf', 'src']], reason: 'nope' },
            'b',
          ),
          call(
            'request_task_permissions',
            {
              plan: ['Do it'],
              files: ['src/'],
              commands: [['curl', 'https://x.test']],
              reason: 'no',
            },
            'c',
          ),
        ],
      },
      { chunks: ['ok'] },
    ]);
    const { run } = s.runManager.startMessage(session.id, 'go');
    await s.runManager.waitFor(run.id);
    const results = s.messages.listBySession(session.id).filter((m) => m.role === 'tool');
    expect(results).toHaveLength(3);
    for (const r of results) expect(r.content).toMatch(/^Error:/);
    expect(results[1]!.content).toMatch(/cannot be part of a task permission/);
    expect(s.approvalRepo.listByRun(run.id)).toEqual([]);
  });
});
