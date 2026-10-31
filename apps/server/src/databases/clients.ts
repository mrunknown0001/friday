import { Worker } from 'node:worker_threads';
import type { DbConnectionDto, DbConnectionTestResult } from '@friday/shared';
import mysql from 'mysql2';
import pg from 'pg';
import type { StatementKind } from './sql.js';

/**
 * Running statements read-only on Postgres, MySQL and SQLite. Every call opens its own
 * connection and closes it afterwards, so nothing a statement changes in the session outlives it.
 * - Postgres: `default_transaction_read_only` for the session, then BEGIN READ ONLY, statement and
 *   lock timeouts, and the extended protocol (exactly one statement). Row limits use a cursor.
 * - MySQL: SET SESSION TRANSACTION READ ONLY, START TRANSACTION READ ONLY, max_execution_time,
 *   no multiple statements, no LOCAL INFILE. Rows are streamed and the connection dropped at the
 *   limit.
 * - SQLite: the file opened read-only with query_only, in a worker thread that is terminated at
 *   the time limit.
 */

export class DbError extends Error {}

/** A connection ready to open: the stored settings plus the secret, resolved just now. */
export interface DbTarget {
  conn: DbConnectionDto;
  /** The password or connection URL (postgres/mysql), never shown or stored. */
  secret: string | null;
  /** The SQLite file, absolute. */
  sqlitePath: string | null;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** More rows than the limit. */
  more: boolean;
  durationMs: number;
}

export interface QueryOptions {
  maxRows: number;
  timeoutMs: number;
  /** For Friday's own fixed statements only (schema browsing). */
  params?: unknown[];
  /** Postgres: limit rows with a cursor (reads only). */
  kind?: StatementKind;
  signal?: AbortSignal;
}

const CONNECT_TIMEOUT_MS = 10_000;
const ROW_KINDS = new Set<StatementKind>(['select', 'with', 'values', 'table']);

/** Driver errors, without anything that could carry a secret. */
function clean(err: unknown, t: DbTarget): DbError {
  if (err instanceof DbError) return err;
  let msg = err instanceof Error ? err.message : String(err);
  if (t.secret) msg = msg.split(t.secret).join('[REDACTED]');
  const code = (err as { code?: string }).code;
  if (code === 'ECONNREFUSED')
    msg = `Nothing is accepting connections at ${where(t)} (connection refused).`;
  else if (code === 'ENOTFOUND') msg = `The host of ${t.conn.name} was not found.`;
  else if (code === 'ETIMEDOUT' || /timeout expired|connect ETIMEDOUT/i.test(msg))
    msg = `Connecting to ${where(t)} timed out.`;
  return new DbError(msg);
}

/** user@host:port/database (or the file), never the password. */
export function where(t: Pick<DbTarget, 'conn' | 'secret' | 'sqlitePath'>): string {
  const c = t.conn;
  if (c.engine === 'sqlite') return t.sqlitePath ?? c.path ?? '?';
  if (c.secretKind === 'url' && t.secret) {
    try {
      const u = new URL(t.secret);
      return `${decodeURIComponent(u.username)}@${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
    } catch {
      return `the URL in ${c.secretVar}`;
    }
  }
  return `${c.username ?? ''}@${c.host ?? ''}:${c.port ?? (c.engine === 'postgres' ? 5432 : 3306)}/${c.database ?? ''}`;
}

function sslFor(mode: DbConnectionDto['ssl']) {
  return mode === 'disable' ? undefined : { rejectUnauthorized: mode === 'verify' };
}

// ------------------------------------------------------------------ Postgres

async function withPg<T>(
  t: DbTarget,
  timeoutMs: number,
  fn: (q: (text: string, values?: unknown[]) => Promise<pg.QueryArrayResult>) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const c = t.conn;
  const ssl = sslFor(c.ssl);
  const base: pg.ClientConfig = {
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: 'Friday (read-only)',
    options: '-c default_transaction_read_only=on',
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs + 5_000,
    ...(ssl ? { ssl } : {}),
  };
  const client = new pg.Client(
    c.secretKind === 'url'
      ? { ...base, connectionString: t.secret ?? '' }
      : {
          ...base,
          host: c.host ?? 'localhost',
          port: c.port ?? 5432,
          database: c.database ?? undefined,
          user: c.username ?? undefined,
          ...(t.secret !== null ? { password: t.secret } : {}),
        },
  );
  client.on('error', () => undefined);
  const onAbort = () => void client.end().catch(() => undefined);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.round(timeoutMs)}`);
    await client.query('SET LOCAL lock_timeout = 5000');
    // queryMode 'extended' (exactly one statement) is in pg but not in its type definitions.
    return await fn((text, values) =>
      client.query({
        text,
        values: values ?? [],
        rowMode: 'array',
        queryMode: 'extended',
      } as pg.QueryArrayConfig),
    );
  } catch (err) {
    if (signal?.aborted) throw new DbError('Cancelled.');
    if ((err as { code?: string }).code === '57014')
      throw new DbError(
        `The statement took longer than ${Math.round(timeoutMs / 1000)}s and was cancelled.`,
      );
    throw clean(err, t);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function pgQuery(t: DbTarget, sql: string, o: QueryOptions): Promise<QueryResult> {
  const started = Date.now();
  return withPg(
    t,
    o.timeoutMs,
    async (q) => {
      let r: pg.QueryArrayResult;
      if (!o.params && o.kind && ROW_KINDS.has(o.kind)) {
        // A cursor fetches only as many rows as shown (the extended protocol keeps it to the one
        // statement; the line break ends a trailing comment).
        await q(`DECLARE friday_rows NO SCROLL CURSOR FOR ${sql}\n`);
        r = await q(`FETCH ${o.maxRows + 1} FROM friday_rows`);
      } else r = await q(sql, o.params);
      const rows = r.rows ?? [];
      return {
        columns: (r.fields ?? []).map((f) => f.name),
        rows: rows.slice(0, o.maxRows),
        more: rows.length > o.maxRows,
        durationMs: Date.now() - started,
      };
    },
    o.signal,
  );
}

// ------------------------------------------------------------------ MySQL

function mysqlConnection(t: DbTarget): mysql.Connection {
  const c = t.conn;
  const ssl = sslFor(c.ssl);
  const common = {
    connectTimeout: CONNECT_TIMEOUT_MS,
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    flags: ['-LOCAL_FILES'],
    ...(ssl ? { ssl } : {}),
  };
  return c.secretKind === 'url'
    ? mysql.createConnection({ ...common, uri: t.secret ?? '' })
    : mysql.createConnection({
        ...common,
        host: c.host ?? 'localhost',
        port: c.port ?? 3306,
        ...(c.database ? { database: c.database } : {}),
        ...(c.username ? { user: c.username } : {}),
        ...(t.secret !== null ? { password: t.secret } : {}),
      });
}

async function mysqlQuery(t: DbTarget, sql: string, o: QueryOptions): Promise<QueryResult> {
  const started = Date.now();
  const conn = mysqlConnection(t);
  conn.on('error', () => undefined);
  const run = (text: string) =>
    new Promise<void>((resolve, reject) =>
      conn.query(text, (err) => (err ? reject(err) : resolve())),
    );
  let timer: NodeJS.Timeout | undefined;
  const onAbort = () => conn.destroy();
  o.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await run('SET SESSION TRANSACTION READ ONLY');
    await run(`SET SESSION max_execution_time = ${Math.round(o.timeoutMs)}`);
    await run('START TRANSACTION READ ONLY');
    return await new Promise<QueryResult>((resolve, reject) => {
      const columns: string[] = [];
      const rows: unknown[][] = [];
      let more = false;
      let done = false;
      const finish = (err?: unknown) => {
        if (done) return;
        done = true;
        if (err) reject(err);
        else resolve({ columns, rows, more, durationMs: Date.now() - started });
      };
      timer = setTimeout(() => {
        conn.destroy();
        finish(
          new DbError(
            `The statement took longer than ${Math.round(o.timeoutMs / 1000)}s and was cancelled.`,
          ),
        );
      }, o.timeoutMs + 2_000);
      const query = conn.query({ sql, values: o.params ?? [], rowsAsArray: true });
      query.on('fields', (fields: Array<{ name: string }>) => {
        if (!columns.length) columns.push(...fields.map((f) => f.name));
      });
      query.on('result', (row: unknown) => {
        if (!Array.isArray(row)) return; // a status packet (SHOW and friends send rows)
        if (rows.length < o.maxRows) rows.push(row);
        else {
          more = true;
          conn.destroy();
          finish();
        }
      });
      query.on('error', (err: Error) => finish(err));
      query.on('end', () => finish());
    });
  } catch (err) {
    if (o.signal?.aborted) throw new DbError('Cancelled.');
    if ((err as { code?: string }).code === 'ER_QUERY_TIMEOUT')
      throw new DbError(
        `The statement took longer than ${Math.round(o.timeoutMs / 1000)}s and was cancelled.`,
      );
    throw clean(err, t);
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
    conn.destroy();
  }
}

// ------------------------------------------------------------------ SQLite

const SQLITE_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
try {
  const db = new DatabaseSync(workerData.path, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  const st = db.prepare(workerData.sql);
  if (typeof st.setReturnArrays === 'function') st.setReturnArrays(true);
  let columns = typeof st.columns === 'function' ? st.columns().map((c) => c.name) : null;
  const rows = [];
  let more = false;
  for (const r of st.iterate(...workerData.params)) {
    if (!columns && !Array.isArray(r)) columns = Object.keys(r);
    if (rows.length >= workerData.maxRows) { more = true; break; }
    rows.push(Array.isArray(r) ? r : Object.values(r));
  }
  db.close();
  parentPort.postMessage({ ok: true, columns: columns || [], rows, more });
} catch (e) {
  parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
}
`;

function sqliteQuery(t: DbTarget, sql: string, o: QueryOptions): Promise<QueryResult> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const worker = new Worker(SQLITE_WORKER, {
      eval: true,
      stderr: true,
      workerData: { path: t.sqlitePath, sql, params: o.params ?? [], maxRows: o.maxRows },
    });
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new DbError(
              `The statement took longer than ${Math.round(o.timeoutMs / 1000)}s and was cancelled.`,
            ),
          ),
        ),
      o.timeoutMs,
    );
    const onAbort = () => finish(() => reject(new DbError('Cancelled.')));
    o.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on(
      'message',
      (m: {
        ok: boolean;
        error?: string;
        columns?: string[];
        rows?: unknown[][];
        more?: boolean;
      }) =>
        finish(() =>
          m.ok
            ? resolve({
                columns: m.columns!,
                rows: m.rows!,
                more: !!m.more,
                durationMs: Date.now() - started,
              })
            : reject(new DbError(m.error ?? 'The statement failed.')),
        ),
    );
    worker.on('error', (err) => finish(() => reject(clean(err, t))));
    worker.on('exit', () =>
      finish(() => reject(new DbError('The query worker stopped unexpectedly.'))),
    );
  });
}

// ------------------------------------------------------------------ the API

export function runQuery(t: DbTarget, sql: string, o: QueryOptions): Promise<QueryResult> {
  switch (t.conn.engine) {
    case 'postgres':
      return pgQuery(t, sql, o);
    case 'mysql':
      return mysqlQuery(t, sql, o);
    case 'sqlite':
      return sqliteQuery(t, sql, o);
  }
}

/**
 * Check a statement without running it (no rows are read): its syntax and the names it uses.
 * Returns the planner's row estimate where the database gives one (Postgres).
 */
export async function explain(
  t: DbTarget,
  sql: string,
  kind: StatementKind,
  signal?: AbortSignal,
): Promise<{ estimatedRows: number | null }> {
  if (!ROW_KINDS.has(kind)) return { estimatedRows: null };
  const o = { maxRows: 5, timeoutMs: 10_000, ...(signal ? { signal } : {}) };
  switch (t.conn.engine) {
    case 'postgres': {
      const r = await runQuery(t, `EXPLAIN (FORMAT JSON) ${sql}\n`, o);
      const plan = (r.rows[0]?.[0] as Array<{ Plan?: { 'Plan Rows'?: number } }> | undefined)?.[0]
        ?.Plan;
      return { estimatedRows: typeof plan?.['Plan Rows'] === 'number' ? plan['Plan Rows'] : null };
    }
    case 'mysql':
      await runQuery(t, `EXPLAIN ${sql}`, o);
      return { estimatedRows: null };
    case 'sqlite':
      await runQuery(t, `EXPLAIN QUERY PLAN ${sql}`, o);
      return { estimatedRows: null };
  }
}

/** Connect, report the server and its version, and warn when the user could write. */
export async function testConnection(t: DbTarget): Promise<DbConnectionTestResult> {
  const o = { maxRows: 200, timeoutMs: 10_000 };
  try {
    const warnings: string[] = [];
    if (t.conn.engine === 'postgres') {
      const r = await runQuery(
        t,
        `SELECT version(), current_user, current_database(),
           COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false),
           (SELECT count(*) FROM information_schema.table_privileges
              WHERE grantee = current_user AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))`,
        { ...o, params: [] },
      );
      const [version, user, db, superuser, writable] = r.rows[0] as [
        string,
        string,
        string,
        boolean,
        string,
      ];
      if (superuser)
        warnings.push(
          `"${user}" is a superuser. Friday's session is read-only, but a read-only database user is safer.`,
        );
      else if (Number(writable) > 0)
        warnings.push(
          `"${user}" may write to ${writable} table(s). Friday's session is read-only, but a read-only database user is safer.`,
        );
      return {
        ok: true,
        message: `Connected to ${db} as ${user}: ${String(version).split(',')[0]}.`,
        warnings,
      };
    }
    if (t.conn.engine === 'mysql') {
      const v = await runQuery(t, 'SELECT VERSION(), CURRENT_USER(), DATABASE()', {
        ...o,
        params: [],
      });
      const [version, user, db] = v.rows[0] as [string, string, string | null];
      const grants = await runQuery(t, 'SHOW GRANTS', { ...o, params: [] });
      if (
        grants.rows.some((g) =>
          /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/.test(String(g[0])),
        )
      )
        warnings.push(
          `${user} has write privileges. Friday's session is read-only, but a read-only database user is safer.`,
        );
      return {
        ok: true,
        message: `Connected${db ? ` to ${db}` : ''} as ${user}: MySQL ${version}.`,
        warnings,
      };
    }
    const v = await runQuery(t, 'SELECT sqlite_version()', { ...o, params: [] });
    return {
      ok: true,
      message: `Opened ${t.sqlitePath} read-only: SQLite ${String(v.rows[0]?.[0])}.`,
      warnings,
    };
  } catch (err) {
    return { ok: false, message: clean(err, t).message, warnings: [] };
  }
}
