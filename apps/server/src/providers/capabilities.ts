import type { CapabilityState } from '@friday/shared';
import { ProviderError } from './errors.js';
import type { LLMProvider } from './types.js';

/**
 * Conservative context-window guesses used until the user configures a real value.
 * These are deliberately on the low side: under-estimating only costs history, while
 * over-estimating causes provider errors.
 */
const ASSUMED_WINDOWS: Array<[RegExp, number]> = [
  [/^(claude|premium-fable|uncensored-claude)/i, 180_000],
  [/^gemini/i, 900_000],
  [/^gpt/i, 120_000],
  [/^(deepseek|kimi|glm|qwen3|minimax|grok)/i, 120_000],
  [/^llama-4/i, 120_000],
];
const DEFAULT_WINDOW = 32_000;

export function assumedContextWindow(model: string): number {
  return ASSUMED_WINDOWS.find(([re]) => re.test(model))?.[1] ?? DEFAULT_WINDOW;
}

export interface ProbeResult {
  streaming: CapabilityState;
  toolCalling: CapabilityState;
  notes: string | null;
}

const NOT_SUPPORTED_KINDS = new Set(['unsupported', 'bad_request']);

/**
 * Verify streaming and tool calling with two tiny real requests. Errors that say nothing about
 * capability (auth, quota, network) are re-thrown so they are not mistaken for "unsupported".
 */
export async function probeCapabilities(
  provider: LLMProvider,
  model: string,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const notes: string[] = [];

  let streaming: CapabilityState;
  try {
    let sawFinish = false;
    for await (const ev of provider.streamChat({
      model,
      operation: 'probe_streaming',
      messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
      maxOutputTokens: 16,
      ...(signal ? { signal } : {}),
    })) {
      if (ev.type === 'finish') sawFinish = true;
    }
    streaming = sawFinish ? 'supported' : 'unknown';
  } catch (err) {
    if (err instanceof ProviderError && NOT_SUPPORTED_KINDS.has(err.kind)) {
      streaming = 'unsupported';
      notes.push(`streaming: ${err.message}`);
    } else {
      throw err;
    }
  }

  let toolCalling: CapabilityState;
  try {
    const result = await provider.complete({
      model,
      operation: 'probe_tools',
      messages: [
        {
          role: 'system',
          content: 'You are a test harness. Always respond by calling the provided tool.',
        },
        { role: 'user', content: 'Call report_status with status "ok".' },
      ],
      tools: [
        {
          name: 'report_status',
          description: 'Report a status value.',
          parameters: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['ok'] } },
            required: ['status'],
            additionalProperties: false,
          },
        },
      ],
      toolChoice: 'auto',
      maxOutputTokens: 64,
      ...(signal ? { signal } : {}),
    });
    const call = result.toolCalls.find((c) => c.name === 'report_status');
    if (!call) {
      toolCalling = 'unsupported';
      notes.push('tools: model answered in text instead of calling the tool');
    } else {
      try {
        const args = JSON.parse(call.argumentsJson) as { status?: unknown };
        toolCalling = args.status === 'ok' ? 'supported' : 'unknown';
        if (toolCalling !== 'supported') notes.push('tools: tool called with unexpected arguments');
      } catch {
        toolCalling = 'unknown';
        notes.push('tools: tool arguments were not valid JSON');
      }
    }
  } catch (err) {
    if (err instanceof ProviderError && NOT_SUPPORTED_KINDS.has(err.kind)) {
      toolCalling = 'unsupported';
      notes.push(`tools: ${err.message}`);
    } else {
      throw err;
    }
  }

  return { streaming, toolCalling, notes: notes.length ? notes.join('; ') : null };
}
