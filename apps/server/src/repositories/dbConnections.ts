import { randomUUID } from 'node:crypto';
import type { DbConnectionDto, DbConnectionInput } from '@friday/shared';
import type { Db } from '../db/database.js';

interface DbConnectionRow {
  id: string;
  name: string;
  engine: DbConnectionDto['engine'];
  project_id: string | null;
  environment: DbConnectionDto['environment'];
  host: string | null;
  port: number | null;
  database: string | null;
  username: string | null;
  secret_var: string | null;
  secret_kind: DbConnectionDto['secretKind'];
  ssl: DbConnectionDto['ssl'];
  path: string | null;
  created_at: string;
  updated_at: string;
}

const toDto = (r: DbConnectionRow): DbConnectionDto => ({
  id: r.id,
  name: r.name,
  engine: r.engine,
  projectId: r.project_id,
  environment: r.environment,
  host: r.host,
  port: r.port,
  database: r.database,
  username: r.username,
  secretVar: r.secret_var,
  secretKind: r.secret_kind,
  ssl: r.ssl,
  path: r.path,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Database connections (no secrets: only the name of the variable that holds one). */
export class DbConnectionRepo {
  constructor(private readonly db: Db) {}

  create(input: DbConnectionInput): DbConnectionDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO db_connections (id, name, engine, project_id, environment, host, port, database, username, secret_var, secret_kind, ssl, path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ...this.values(input), now, now);
    return this.get(id)!;
  }

  update(id: string, input: DbConnectionInput): DbConnectionDto | null {
    this.db
      .prepare(
        `UPDATE db_connections SET name = ?, engine = ?, project_id = ?, environment = ?, host = ?, port = ?, database = ?, username = ?, secret_var = ?, secret_kind = ?, ssl = ?, path = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(...this.values(input), new Date().toISOString(), id);
    return this.get(id);
  }

  private values(i: DbConnectionInput) {
    return [
      i.name,
      i.engine,
      i.projectId,
      i.environment,
      i.host,
      i.port,
      i.database,
      i.username,
      i.secretVar,
      i.secretKind,
      i.ssl,
      i.path,
    ] as const;
  }

  get(id: string): DbConnectionDto | null {
    const row = this.db.prepare('SELECT * FROM db_connections WHERE id = ?').get(id) as unknown as
      DbConnectionRow | undefined;
    return row ? toDto(row) : null;
  }

  byName(name: string): DbConnectionDto | null {
    const row = this.db
      .prepare('SELECT * FROM db_connections WHERE name = ?')
      .get(name) as unknown as DbConnectionRow | undefined;
    return row ? toDto(row) : null;
  }

  list(): DbConnectionDto[] {
    return (
      this.db
        .prepare('SELECT * FROM db_connections ORDER BY name COLLATE NOCASE')
        .all() as unknown as DbConnectionRow[]
    ).map(toDto);
  }

  /** Connections a conversation may use: any-conversation ones, plus its project's own. */
  available(projectId: string | null): DbConnectionDto[] {
    return this.list().filter((c) => c.projectId === null || c.projectId === projectId);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM db_connections WHERE id = ?').run(id).changes > 0;
  }
}
