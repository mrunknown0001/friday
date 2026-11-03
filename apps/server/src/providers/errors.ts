import OpenAI from 'openai';
import type { ProviderErrorKind } from './types.js';
import type { Redactor } from '../security/redact.js';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limit',
  'timeout',
  'network',
  'server',
  'upstream',
]);

/** Who an error is about, for messages that name the provider and its key. */
export interface ProviderSource {
  label: string;
  envVar: string;
  /** Passes requests on to other companies' models (NoTokenLimit, OpenRouter, 7API). */
  gateway: boolean;
}

export const NOTOKENLIMIT: ProviderSource = {
  label: 'NoTokenLimit',
  envVar: 'NTL_API_KEY',
  gateway: true,
};

/** No provider has a key at all. */
export const NO_PROVIDER: ProviderSource = {
  label: 'No model provider',
  envVar:
    'NTL_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY or SEVENAPI_API_KEY',
  gateway: false,
};

function userMessage(kind: ProviderErrorKind, p: ProviderSource): string {
  const n = p.label;
  switch (kind) {
    case 'not_configured':
      return p === NO_PROVIDER
        ? `No model provider is configured. Set ${p.envVar} (see Settings for the file) and restart Friday.`
        : `${n} is not configured. Set ${p.envVar} (see Settings for the file) and restart Friday.`;
    case 'auth':
      return `${n} rejected the API key. Check ${p.envVar}.`;
    case 'permission':
      return `Your ${n} account is not permitted to use this model or endpoint.`;
    case 'rate_limit':
      return `${n} is rate limiting requests. Wait a moment and retry.`;
    case 'quota':
      return `Your ${n} quota or credit is exhausted.`;
    case 'timeout':
      return `The request to ${n} timed out.`;
    case 'network':
      return `Could not reach ${n} (network error).`;
    case 'bad_request':
      return `${n} rejected the request as invalid.`;
    case 'model_not_found':
      return 'The selected model is not available to your account.';
    case 'unsupported':
      return 'The selected model does not support a feature this request needs.';
    case 'server':
      return `${n} returned a server error.`;
    case 'upstream':
      return p.gateway
        ? `${n} couldn't get an answer from the model's provider. This is on ${n}'s side: try again in a few minutes, or choose another model in Settings.`
        : `${n} is overloaded or couldn't answer right now. Try again in a few minutes, or choose another model in Settings.`;
    case 'malformed':
      return `${n} returned a response that could not be understood.`;
    case 'cancelled':
      return 'The request was cancelled.';
    case 'unknown':
      return `Unexpected error while calling ${n}.`;
  }
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  /** Number of attempts made before giving up (set by `withRetry`). */
  attempts = 1;

  constructor(
    kind: ProviderErrorKind,
    detail?: string | null,
    opts: {
      status?: number | null;
      retryAfterMs?: number | null;
      cause?: unknown;
      source?: ProviderSource;
    } = {},
  ) {
    const base = userMessage(kind, opts.source ?? NOTOKENLIMIT);
    super(detail ? `${base} (${detail})` : base, { cause: opts.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

export function parseRetryAfter(headers: Headers | undefined): number | null {
  if (!headers) return null;
  const ms = headers.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const value = headers.get('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function extractProviderDetail(err: InstanceType<typeof OpenAI.APIError>): {
  code: string;
  message: string;
} {
  const body = (err.error ?? {}) as Record<string, unknown>;
  const code = [body['code'], body['type'], body['status']]
    .filter((v) => typeof v === 'string')
    .join(' ');
  const message = typeof body['message'] === 'string' ? body['message'] : '';
  return { code, message };
}

export const QUOTA_HINT =
  /quota|credit|balance|insufficient|billing|payment|exhausted|plan limit|limit reached/i;
const MODEL_HINT = /model/i;
/** NoTokenLimit's wording when the model's own provider fails or is unreachable. */
const UPSTREAM_HINT =
  /upstream|bad gateway|gateway time-?out|service unavailable|overloaded|provider (failed|error|unavailable)/i;
/** Upstream outages last longer than a blip: wait at least this long before retrying. */
export const UPSTREAM_RETRY_MS = 2_000;
const UNSUPPORTED_HINT =
  /not support|unsupported|tool_choice|tools? (are|is) not|function calling/i;

type ErrorOpts = ConstructorParameters<typeof ProviderError>[2];

/**
 * Providers quote part of a rejected key ("sk-proj-***…abcd"); not even that is shown. Exported for
 * the Anthropic classifier.
 */
export function withoutKeyHints(text: string): string {
  return text.replace(/[\w-]*\*{3,}[\w-]*/g, '[REDACTED]');
}

/** Map any thrown value from the OpenAI SDK (or our own code) to a ProviderError. */
export function classifyError(
  err: unknown,
  redactor: Redactor,
  source: ProviderSource = NOTOKENLIMIT,
): ProviderError {
  if (err instanceof ProviderError) return err;
  const E = (kind: ProviderErrorKind, detail?: string | null, opts: ErrorOpts = {}) =>
    new ProviderError(kind, detail, { ...opts, source });

  if (err instanceof OpenAI.APIUserAbortError) return E('cancelled');
  if (err instanceof OpenAI.APIConnectionTimeoutError) return E('timeout', null, { cause: err });
  if (err instanceof OpenAI.APIConnectionError) {
    return E(
      'network',
      redactor.redact(err.cause instanceof Error ? err.cause.message : err.message),
      { cause: err },
    );
  }

  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    const { code, message } = extractProviderDetail(err);
    const text = `${code} ${message}`.trim();
    const detail = redactor
      .redact(withoutKeyHints(message || code || `HTTP ${status ?? '?'}`))
      .slice(0, 300);
    const retryAfterMs = parseRetryAfter(err.headers);
    const opts = { status, retryAfterMs, cause: err };
    const upstream = () =>
      E('upstream', detail, {
        ...opts,
        retryAfterMs: Math.max(retryAfterMs ?? 0, UPSTREAM_RETRY_MS),
      });

    switch (true) {
      case status === 401:
        return E('auth', detail, opts);
      case status === 402:
        return E('quota', detail, opts);
      case status === 403:
        return E(QUOTA_HINT.test(text) ? 'quota' : 'permission', detail, opts);
      case status === 404:
        return E(MODEL_HINT.test(text) ? 'model_not_found' : 'bad_request', detail, opts);
      case status === 408:
        return E('timeout', detail, opts);
      case status === 429:
        return E(QUOTA_HINT.test(text) ? 'quota' : 'rate_limit', detail, opts);
      case status === 400 || status === 422:
        // Gemini reports a wrong key as a 400.
        if (/api[ _]key not valid|API_KEY_INVALID|invalid api key|pass a valid api key/i.test(text))
          return E('auth', detail, opts);
        if (
          MODEL_HINT.test(text) &&
          /not (found|exist|available|allowed)|invalid model|unknown model/i.test(text)
        ) {
          return E('model_not_found', detail, opts);
        }
        return E(UNSUPPORTED_HINT.test(text) ? 'unsupported' : 'bad_request', detail, opts);
      // A bad gateway or gateway timeout: no good answer came back from the model's provider.
      case status === 502 || status === 504:
        return upstream();
      case status !== null && status >= 500:
        return UPSTREAM_HINT.test(text) ? upstream() : E('server', detail, opts);
      default:
        // Errors embedded in an SSE stream arrive without an HTTP status.
        if (QUOTA_HINT.test(text)) return E('quota', detail, opts);
        if (/rate.?limit|too many requests/i.test(text)) return E('rate_limit', detail, opts);
        if (UPSTREAM_HINT.test(text)) return upstream();
        return E('unknown', detail, opts);
    }
  }

  if (err instanceof Error && err.name === 'AbortError') return E('cancelled');
  if (err instanceof SyntaxError)
    return E('malformed', redactor.redact(err.message), { cause: err });

  const message = err instanceof Error ? err.message : String(err);
  return E('unknown', redactor.redact(message).slice(0, 300), { cause: err });
}
