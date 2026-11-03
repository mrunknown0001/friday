import type { CapabilityState, ModelCapabilities, ModelInfo } from '@friday/shared';
import { transaction, type Db } from '../db/database.js';
import { assumedContextWindow } from '../providers/capabilities.js';

interface CapRow {
  model: string;
  streaming: CapabilityState;
  tool_calling: CapabilityState;
  image_input: CapabilityState;
  context_window: number | null;
  notes: string | null;
  probed_at: string | null;
  listed_context_window: number | null;
  listed_image_input: CapabilityState | null;
}

export class CapabilityRepo {
  constructor(private readonly db: Db) {}

  /**
   * Stored capabilities, or conservative defaults (everything 'unknown') if never probed. The
   * context window is the user's, else the provider list's, else a guess; image support is what a
   * probe or a real request showed, else what the provider's list says.
   */
  get(model: string): ModelCapabilities {
    const row = this.db.prepare('SELECT * FROM model_capabilities WHERE model = ?').get(model) as
      CapRow | undefined;
    const image = row?.image_input ?? 'unknown';
    return {
      model,
      streaming: row?.streaming ?? 'unknown',
      toolCalling: row?.tool_calling ?? 'unknown',
      imageInput: image === 'unknown' ? (row?.listed_image_input ?? 'unknown') : image,
      contextWindow:
        row?.context_window ?? row?.listed_context_window ?? assumedContextWindow(model),
      contextWindowSource: row?.context_window
        ? 'configured'
        : row?.listed_context_window
          ? 'listed'
          : 'assumed',
      probedAt: row?.probed_at ?? null,
      notes: row?.notes ?? null,
    };
  }

  saveProbe(
    model: string,
    result: {
      streaming: CapabilityState;
      toolCalling: CapabilityState;
      imageInput: CapabilityState;
      notes: string | null;
    },
  ): void {
    this.db
      .prepare(
        `INSERT INTO model_capabilities (model, streaming, tool_calling, image_input, notes, probed_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET streaming = excluded.streaming, tool_calling = excluded.tool_calling,
           image_input = excluded.image_input, notes = excluded.notes, probed_at = excluded.probed_at`,
      )
      .run(
        model,
        result.streaming,
        result.toolCalling,
        result.imageInput,
        result.notes,
        new Date().toISOString(),
      );
  }

  /** Learned from a real request: the provider refused images for this model. */
  setImageInput(model: string, state: CapabilityState): void {
    this.db
      .prepare(
        `INSERT INTO model_capabilities (model, image_input) VALUES (?, ?)
         ON CONFLICT(model) DO UPDATE SET image_input = excluded.image_input`,
      )
      .run(model, state);
  }

  /** What the providers' model lists report (only models whose entry says something). */
  saveListed(models: ModelInfo[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO model_capabilities (model, listed_context_window, listed_image_input) VALUES (?, ?, ?)
       ON CONFLICT(model) DO UPDATE SET listed_context_window = excluded.listed_context_window,
         listed_image_input = excluded.listed_image_input`,
    );
    const listed = models.filter((m) => m.contextWindow || m.imageInput !== undefined);
    if (!listed.length) return;
    transaction(this.db, () => {
      for (const m of listed)
        upsert.run(
          m.id,
          m.contextWindow ?? null,
          m.imageInput === undefined ? null : m.imageInput ? 'supported' : 'unsupported',
        );
    });
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
