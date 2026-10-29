import type { CapabilityState, ModelCapabilities } from '@friday/shared';
import type { Db } from '../db/database.js';
import { assumedContextWindow } from '../providers/capabilities.js';

interface CapRow {
  model: string;
  streaming: CapabilityState;
  tool_calling: CapabilityState;
  context_window: number | null;
  notes: string | null;
  probed_at: string | null;
}

export class CapabilityRepo {
  constructor(private readonly db: Db) {}

  /** Stored capabilities, or conservative defaults (everything 'unknown') if never probed. */
  get(model: string): ModelCapabilities {
    const row = this.db.prepare('SELECT * FROM model_capabilities WHERE model = ?').get(model) as
      CapRow | undefined;
    return {
      model,
      streaming: row?.streaming ?? 'unknown',
      toolCalling: row?.tool_calling ?? 'unknown',
      contextWindow: row?.context_window ?? assumedContextWindow(model),
      contextWindowSource: row?.context_window ? 'configured' : 'assumed',
      probedAt: row?.probed_at ?? null,
      notes: row?.notes ?? null,
    };
  }

  saveProbe(
    model: string,
    result: { streaming: CapabilityState; toolCalling: CapabilityState; notes: string | null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO model_capabilities (model, streaming, tool_calling, notes, probed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET streaming = excluded.streaming, tool_calling = excluded.tool_calling,
           notes = excluded.notes, probed_at = excluded.probed_at`,
      )
      .run(model, result.streaming, result.toolCalling, result.notes, new Date().toISOString());
  }

  setContextWindow(model: string, tokens: number | null): void {
    this.db
      .prepare(
        `INSERT INTO model_capabilities (model, context_window) VALUES (?, ?)
         ON CONFLICT(model) DO UPDATE SET context_window = excluded.context_window`,
      )
      .run(model, tokens);
  }
}
