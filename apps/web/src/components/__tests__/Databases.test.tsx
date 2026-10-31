import type { ApprovalDto, DbConnectionDto } from '@friday/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { ApprovalCard } from '../ApprovalCard';
import { DatabaseSettings } from '../DatabaseSettings';
import { toolLabel } from '../ToolActivity';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const approval: ApprovalDto = {
  id: 'ap',
  sessionId: 's',
  runId: 'r',
  projectId: 'p1',
  toolCallId: 'c',
  toolName: 'query_database',
  category: 'database',
  risk: 'high',
  title: 'Query shop-prod',
  summary: 'One read-only statement on shop-prod (postgres, production), at most 50 rows, 15 s.',
  reason: 'count refunds this week',
  details: {
    kind: 'database_query',
    connection: {
      name: 'shop-prod',
      engine: 'postgres',
      environment: 'production',
      target: 'reader@db.internal:5432/shop',
    },
    sql: "SELECT status, count(*) FROM orders WHERE created_at > now() - interval '7 days' GROUP BY 1",
    maxRows: 50,
    timeoutSeconds: 15,
    credential: "DB_PASSWORD in the project's .env",
    safeguards: [
      'Read-only transaction in a read-only session (Postgres refuses any write)',
      'Exactly one statement (Postgres refuses more)',
    ],
    estimatedRows: 1200,
    riskReasons: ['Production data. Type the connection name to approve.'],
  },
  actionHash: 'f'.repeat(64),
  status: 'pending',
  decisionNote: null,
  resultSummary: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  decidedAt: null,
  confirmationRequired: 'shop-prod',
  grantedBy: null,
};

describe('database queries', () => {
  it('shows the statement, where it runs, the credential source and the safeguards', () => {
    render(<ApprovalCard approval={approval} onDecide={vi.fn()} />);
    expect(screen.getByLabelText('SQL').textContent).toBe(
      approval.details.kind === 'database_query' ? approval.details.sql : '',
    );
    expect(screen.getByText('reader@db.internal:5432/shop')).toBeTruthy();
    expect(screen.getByText("DB_PASSWORD in the project's .env (value not shown)")).toBeTruthy();
    expect(screen.getByText(/the planner expects about 1,200 rows/)).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Safeguards' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    // Production: the name must be typed before Approve works.
    expect((screen.getByRole('button', { name: /^Approve/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // No "allow similar" for queries: every one asks.
    expect(screen.queryByText(/Also allow/)).toBeNull();
  });

  it('labels the database tools', () => {
    expect(
      toolLabel('database_schema', JSON.stringify({ connection: 'shop', table: 'orders' })),
    ).toBe('shop: orders');
    expect(
      toolLabel(
        'query_database',
        JSON.stringify({ connection: 'shop', sql: 'SELECT  *\n FROM orders' }),
      ),
    ).toBe('shop: SELECT * FROM orders');
  });
});

describe('database settings', () => {
  const existing: DbConnectionDto = {
    id: 'c1',
    name: 'shop-dev',
    engine: 'mysql',
    projectId: 'p1',
    environment: 'development',
    host: '127.0.0.1',
    port: 3306,
    database: 'shop',
    username: 'reader',
    secretVar: 'DB_PASSWORD',
    secretKind: 'password',
    ssl: 'disable',
    path: null,
    createdAt: '',
    updatedAt: '',
  };
  beforeEach(() => {
    vi.spyOn(api, 'databases').mockResolvedValue({ connections: [existing] });
    vi.spyOn(api, 'projects').mockResolvedValue({
      projects: [{ id: 'p1', name: 'shop' } as never],
    });
  });

  it('lists connections, tests one, and adds one by variable name only', async () => {
    const test = vi.spyOn(api, 'testDatabase').mockResolvedValue({
      ok: true,
      message: 'Connected as reader.',
      warnings: ['reader has write privileges.'],
    });
    const add = vi.spyOn(api, 'addDatabase').mockResolvedValue(existing);
    render(<DatabaseSettings />);
    await screen.findByText('shop-dev');
    expect(screen.getByText('reader@127.0.0.1:3306/shop')).toBeTruthy();
    expect(screen.getByText(/Project shop only · password from DB_PASSWORD/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect((await screen.findByRole('status')).textContent).toBe(
      'Connected as reader.reader has write privileges.',
    );
    expect(test).toHaveBeenCalledWith('c1');

    const form = screen.getByRole('form', { name: 'Add database connection' });
    // There is no field for a password itself.
    expect(within(form).queryByLabelText(/^Password$/)).toBeNull();
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'analytics' } });
    fireEvent.change(within(form).getByLabelText('Connect with'), { target: { value: 'url' } });
    expect(within(form).queryByLabelText('Host')).toBeNull();
    fireEvent.change(within(form).getByLabelText('URL variable name'), {
      target: { value: 'DATABASE_URL' },
    });
    fireEvent.change(within(form).getByLabelText('Environment'), { target: { value: 'staging' } });
    fireEvent.submit(form);
    await waitFor(() => expect(add).toHaveBeenCalled());
    expect(add.mock.calls[0]![0]).toEqual({
      name: 'analytics',
      engine: 'postgres',
      projectId: null,
      environment: 'staging',
      host: null,
      port: null,
      database: null,
      username: null,
      secretVar: 'DATABASE_URL',
      secretKind: 'url',
      ssl: 'disable',
      path: null,
    });
  });
});
