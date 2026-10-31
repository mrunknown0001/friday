import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import type { DbConnectionDto } from '@friday/shared';
import type { DbConnectionRepo } from '../repositories/dbConnections.js';
import type { ProjectRecord, ProjectRepo } from '../repositories/projects.js';
import { DbError, type DbTarget } from './clients.js';

/** A variable name a connection may point at. Friday's own settings are off limits. */
export const SECRET_VAR = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED = /^(NTL_|FRIDAY_)/;

export function secretVarProblem(name: string): string | null {
  if (!SECRET_VAR.test(name))
    return 'Use a variable name such as DB_PASSWORD (letters, digits, _).';
  if (RESERVED.test(name)) return `${name} is one of Friday's own settings, not a database secret.`;
  return null;
}

function readEnvFile(file: string): Record<string, string> | null {
  try {
    return parseEnv(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Database connections for conversations and Settings: which ones a conversation may use, and
 * turning one into something to connect with. Secrets are read from the named variable at that
 * moment (the project's .env, then Friday's config file, then Friday's environment) and never
 * stored, logged or returned to the model.
 */
export class DatabaseService {
  constructor(
    private readonly repo: DbConnectionRepo,
    private readonly projects: ProjectRepo,
    private readonly opts: { envFile: string; dataDir: string; env?: NodeJS.ProcessEnv },
  ) {}

  available(project: ProjectRecord | null): DbConnectionDto[] {
    return this.repo.available(project?.worktree?.parentId ?? project?.id ?? null);
  }

  /** A connection this conversation may use, by name. */
  byName(name: string, project: ProjectRecord | null): DbConnectionDto | null {
    return this.available(project).find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  private projectOf(conn: DbConnectionDto): ProjectRecord | null {
    return conn.projectId ? this.projects.get(conn.projectId) : null;
  }

  /** Where the secret is looked up, in order. */
  private sources(conn: DbConnectionDto) {
    const project = this.projectOf(conn);
    return [
      ...(project
        ? [{ label: "the project's .env", file: path.join(project.rootPath, '.env') }]
        : []),
      { label: `Friday's config file (${this.opts.envFile})`, file: this.opts.envFile },
      { label: "Friday's environment", file: null },
    ];
  }

  /** "DB_PASSWORD in the project's .env", for the approval card (null for SQLite). */
  credentialLabel(conn: DbConnectionDto): string | null {
    if (conn.engine === 'sqlite' || !conn.secretVar)
      return conn.engine === 'sqlite' ? null : 'no password';
    const found = this.lookup(conn);
    const name = `${conn.secretVar}${conn.secretKind === 'url' ? ' (connection URL)' : ''}`;
    return found ? `${name} in ${found.label}` : `${name} (not set yet)`;
  }

  private lookup(conn: DbConnectionDto): { value: string; label: string } | null {
    const name = conn.secretVar!;
    for (const s of this.sources(conn)) {
      const value = s.file ? readEnvFile(s.file)?.[name] : (this.opts.env ?? process.env)[name];
      if (value !== undefined && value !== '') return { value, label: s.label };
    }
    return null;
  }

  /** Everything needed to connect, resolved now. Throws DbError with what to fix. */
  target(conn: DbConnectionDto): DbTarget {
    if (conn.engine === 'sqlite') return { conn, secret: null, sqlitePath: this.sqlitePath(conn) };
    if (!conn.secretVar) {
      if (conn.secretKind === 'url')
        throw new DbError(`${conn.name} has no connection URL variable.`);
      return { conn, secret: null, sqlitePath: null };
    }
    const problem = secretVarProblem(conn.secretVar);
    if (problem) throw new DbError(problem);
    const found = this.lookup(conn);
    if (!found)
      throw new DbError(
        `${conn.secretVar} is not set. Add it to ${this.sources(conn)
          .filter((s) => s.file)
          .map((s) => s.label)
          .join(' or ')}; Friday reads it when connecting and never shows or stores it.`,
      );
    if (conn.secretKind === 'url') {
      let scheme: string;
      try {
        scheme = new URL(found.value).protocol;
      } catch {
        throw new DbError(`${conn.secretVar} does not hold a valid connection URL.`);
      }
      const ok = conn.engine === 'postgres' ? /^postgres(ql)?:$/ : /^mysql:$/;
      if (!ok.test(scheme))
        throw new DbError(
          `${conn.secretVar} holds a ${scheme.replace(':', '')} URL, not a ${conn.engine} one.`,
        );
    }
    return { conn, secret: found.value, sqlitePath: null };
  }

  /** The SQLite file: absolute, or inside the connection's project; never Friday's own data. */
  sqlitePath(conn: DbConnectionDto): string {
    const project = this.projectOf(conn);
    const raw = conn.path ?? '';
    if (!path.isAbsolute(raw) && !project)
      throw new DbError(
        'A SQLite path must be absolute unless the connection belongs to a project.',
      );
    const abs = path.resolve(project?.rootPath ?? '/', raw);
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      throw new DbError(`${abs} does not exist.`);
    }
    if (!fs.statSync(real).isFile()) throw new DbError(`${abs} is not a file.`);
    const data = (() => {
      try {
        return fs.realpathSync(this.opts.dataDir);
      } catch {
        return path.resolve(this.opts.dataDir);
      }
    })();
    if (real === data || real.startsWith(data + path.sep))
      throw new DbError("That is Friday's own data, not a project database.");
    return real;
  }
}
