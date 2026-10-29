import type { z } from 'zod';
import type { Db } from '../db/database.js';

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  /** Returns the stored value if it still matches `schema`, otherwise null. */
  get<T>(key: string, schema: z.ZodType<T>): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = schema.safeParse(JSON.parse(row.value));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}
