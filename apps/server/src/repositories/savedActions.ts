import { randomUUID } from 'node:crypto';
import type { SavedActionDto, SavedActionInput } from '@friday/shared';
import type { Db } from '../db/database.js';

interface Row {
  id: string;
  project_id: string;
  name: string;
  description: string;
  risk: SavedActionDto['risk'];
  steps: string;
  created_at: string;
  updated_at: string;
}

const toDto = (r: Row): SavedActionDto => ({
  id: r.id,
  projectId: r.project_id,
  name: r.name,
  description: r.description,
  risk: r.risk,
  steps: JSON.parse(r.steps) as SavedActionDto['steps'],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Saved actions (runbooks), defined by the user per project. */
export class SavedActionRepo {
  constructor(private readonly db: Db) {}

  create(projectId: string, a: SavedActionInput): SavedActionDto {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO saved_actions (id, project_id, name, description, risk, steps, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId, a.name, a.description, a.risk, JSON.stringify(a.steps), now, now);
    return this.get(id)!;
  }

  update(id: string, a: SavedActionInput): SavedActionDto | null {
    this.db
      .prepare(
        'UPDATE saved_actions SET name = ?, description = ?, risk = ?, steps = ?, updated_at = ? WHERE id = ?',
      )
      .run(a.name, a.description, a.risk, JSON.stringify(a.steps), new Date().toISOString(), id);
    return this.get(id);
  }

  get(id: string): SavedActionDto | null {
    const row = this.db.prepare('SELECT * FROM saved_actions WHERE id = ?').get(id) as unknown as
      Row | undefined;
    return row ? toDto(row) : null;
  }

  byName(projectId: string, name: string): SavedActionDto | null {
    const row = this.db
      .prepare('SELECT * FROM saved_actions WHERE project_id = ? AND name = ? COLLATE NOCASE')
      .get(projectId, name) as unknown as Row | undefined;
    return row ? toDto(row) : null;
  }

  listByProject(projectId: string): SavedActionDto[] {
    return (
      this.db
        .prepare('SELECT * FROM saved_actions WHERE project_id = ? ORDER BY name COLLATE NOCASE')
        .all(projectId) as unknown as Row[]
    ).map(toDto);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM saved_actions WHERE id = ?').run(id).changes > 0;
  }
}
