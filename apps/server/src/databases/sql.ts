import type { DbEngine } from '@friday/shared';

/**
 * Friday's own check that a statement only reads: exactly one statement, starting with a read
 * keyword, and no write keyword, locking clause, `INTO` or side-effect function anywhere outside
 * strings, comments and quoted names. The database's read-only transaction or session is the
 * second line of defence, and a read-only database user the third.
 */

export type StatementKind =
  'select' | 'with' | 'values' | 'table' | 'explain' | 'show' | 'describe' | 'pragma';

export type Classified =
  | {
      ok: true;
      kind: StatementKind;
      /** The statement without trailing semicolons and whitespace. */
      text: string;
    }
  | { ok: false; reason: string };

const START: Record<DbEngine, Record<string, StatementKind>> = {
  postgres: {
    SELECT: 'select',
    WITH: 'with',
    VALUES: 'values',
    TABLE: 'table',
    EXPLAIN: 'explain',
    SHOW: 'show',
  },
  mysql: {
    SELECT: 'select',
    WITH: 'with',
    VALUES: 'values',
    TABLE: 'table',
    EXPLAIN: 'explain',
    SHOW: 'show',
    DESCRIBE: 'describe',
    DESC: 'describe',
  },
  sqlite: {
    SELECT: 'select',
    WITH: 'with',
    VALUES: 'values',
    EXPLAIN: 'explain',
    PRAGMA: 'pragma',
  },
};

/** Keywords that only appear in statements that write, lock or change the session. */
const WRITES = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'TRUNCATE',
  'DROP',
  'ALTER',
  'CREATE',
  'GRANT',
  'REVOKE',
  'COPY',
  'CALL',
  'INTO',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'REINDEX',
  'HANDLER',
  'OUTFILE',
  'DUMPFILE',
];

/** Functions that act outside the query (other sessions, files, settings, locks, links). */
const SIDE_EFFECTS = [
  'PG_TERMINATE_BACKEND',
  'PG_CANCEL_BACKEND',
  'PG_RELOAD_CONF',
  'PG_ROTATE_LOGFILE',
  'PG_READ_FILE',
  'PG_READ_BINARY_FILE',
  'PG_LS_DIR',
  'PG_STAT_FILE',
  'LO_IMPORT',
  'LO_EXPORT',
  'LO_UNLINK',
  'LO_CREATE',
  'DBLINK',
  'DBLINK_EXEC',
  'DBLINK_CONNECT',
  'SET_CONFIG',
  'PG_ADVISORY_LOCK',
  'PG_ADVISORY_XACT_LOCK',
  'PG_TRY_ADVISORY_LOCK',
  'PG_NOTIFY',
  'NEXTVAL',
  'SETVAL',
  'LOAD_FILE',
  'GET_LOCK',
  'RELEASE_LOCK',
  'LOAD_EXTENSION',
  'READFILE',
  'WRITEFILE',
  'EDIT',
];

/**
 * The statement with string literals, quoted names and comments blanked out (same length, so
 * positions still line up), or an error for an unterminated one.
 */
export function blankLiterals(sql: string, engine: DbEngine): string | { error: string } {
  const out = sql.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '#' && engine === 'mysql') {
      const end = sql.indexOf('\n', i);
      const stop = end < 0 ? sql.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      // Postgres nests block comments.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*' && engine === 'postgres') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else j++;
      }
      if (depth > 0) return { error: 'an unterminated /* comment' };
      // MySQL runs /*! ... */ comments as code: refuse rather than guess.
      if (engine === 'mysql' && sql[i + 2] === '!') return { error: 'a /*! executable comment */' };
      blank(i, j);
      i = j;
    } else if (
      c === "'" ||
      (c === '"' && engine !== 'mysql') ||
      c === '`' ||
      (c === '"' && engine === 'mysql')
    ) {
      // Strings ('…'), quoted names ("…", `…`). Doubling the quote escapes it; backslash too in
      // MySQL strings and Postgres E'…' strings.
      const backslash =
        engine === 'mysql' || (engine === 'postgres' && /[eE]$/.test(sql.slice(0, i)) && c === "'");
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return { error: `an unterminated ${c} quote` };
        if (backslash && sql[j] === '\\') j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else if (c === '$' && engine === 'postgres') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag && !/[A-Za-z0-9_]$/.test(sql.slice(0, i))) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end < 0) return { error: 'an unterminated $-quoted string' };
        blank(i, end + tag[0].length);
        i = end + tag[0].length;
      } else i++;
    } else i++;
  }
  return out.join('');
}

const READS = 'read-only statements (SELECT, WITH … SELECT, VALUES, EXPLAIN, SHOW)';

export function classifySql(sql: string, engine: DbEngine): Classified {
  const code = blankLiterals(sql, engine);
  if (typeof code !== 'string') return { ok: false, reason: `The statement has ${code.error}.` };
  // One statement: a semicolon may only end it (comments may follow).
  const firstSemi = code.indexOf(';');
  if (firstSemi >= 0 && code.slice(firstSemi).replace(/[;\s]/g, '') !== '')
    return { ok: false, reason: 'Run one statement at a time (no ";" between statements).' };
  const end = firstSemi >= 0 ? firstSemi : sql.length;
  const text = sql.slice(0, end).trim();
  const words = (code.slice(0, end).match(/[A-Za-z_][A-Za-z0-9_$]*/g) ?? []).map((w) =>
    w.toUpperCase(),
  );
  if (!words.length) return { ok: false, reason: 'The statement is empty.' };
  const kind = START[engine][words[0]!];
  if (!kind)
    return {
      ok: false,
      reason: `query_database runs ${READS} only; "${words[0]}" statements are not allowed.`,
    };
  const write = words.find((w) => WRITES.includes(w));
  if (write)
    return { ok: false, reason: `query_database runs ${READS} only; this one contains ${write}.` };
  const flat = ` ${words.join(' ')} `;
  if (/ FOR (NO KEY )?(UPDATE|SHARE|KEY SHARE) | LOCK IN SHARE MODE /.test(flat))
    return { ok: false, reason: 'Locking reads (FOR UPDATE / FOR SHARE) are not allowed.' };
  if (/ REPLACE INTO /.test(flat))
    return { ok: false, reason: `query_database runs ${READS} only.` };
  const effect = words.find((w) => SIDE_EFFECTS.includes(w));
  if (effect)
    return {
      ok: false,
      reason: `${effect.toLowerCase()}() acts outside the query and is not allowed.`,
    };
  if (kind === 'pragma' && /=/.test(code.slice(0, end)))
    return { ok: false, reason: 'Only PRAGMA reads (no "=") are allowed.' };
  return { ok: true, kind, text };
}
