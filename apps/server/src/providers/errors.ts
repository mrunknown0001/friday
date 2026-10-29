import OpenAI from 'openai';
import type { ProviderErrorKind } from './types.js';
import type { Redactor } from '../security/redact.js';

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limit',
  'timeout',
  'network',
  'server',
]);

const USER_MESSAGES: Record<ProviderErrorKind, string> = {
  not_configured: 'NoTokenLimit is not configured. Set NTL_API_KEY in .env and restart the server.',
  auth: 'NoTokenLimit rejected the API key. Check NTL_API_KEY.',
  permission: 'Your NoTokenLimit account is not permitted to use this model or endpoint.',
  rate_limit: 'NoTokenLimit is rate limiting requests. Wait a moment and retry.',
  quota: 'Your NoTokenLimit quota or credit is exhausted.',
  timeout: 'The request to NoTokenLimit timed out.',
  network: 'Could not reach NoTokenLimit (network error).',
  bad_request: 'NoTokenLimit rejected the request as invalid.',
  model_not_found: 'The selected model is not available to your account.',
  unsupported: 'The selected model does not support a feature this request needs.',
  server: 'NoTokenLimit returned a server error.',
  malformed: 'NoTokenLimit returned a response that could not be understood.',
  cancelled: 'The request was cancelled.',
  unknown: 'Unexpected error while calling NoTokenLimit.',
};

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
    opts: { status?: number | null; retryAfterMs?: number | null; cause?: unknown } = {},
  ) {
    const base = USER_MESSAGES[kind];
    super(detail ? `${base} (${detail})` : base, { cause: opts.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = RETRYABLE.has(kind);
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

function parseRetryAfter(headers: Headers | undefined): number | null {
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
  const code = [body['code'], body['type']].filter((v) => typeof v === 'string').join(' ');
  const message = typeof body['message'] === 'string' ? body['message'] : '';
  return { code, message };
}

const QUOTA_HINT =
  /quota|credit|balance|insufficient|billing|payment|exhausted|plan limit|limit reached/i;
const MODEL_HINT = /model/i;
const UNSUPPORTED_HINT =
  /not support|unsupported|tool_choice|tools? (are|is) not|function calling/i;

/** Map any thrown value from the OpenAI SDK (or our own code) to a ProviderError. */
export function classifyError(err: unknown, redactor: Redactor): ProviderError {
  if (err instanceof ProviderError) return err;

  if (err instanceof OpenAI.APIUserAbortError) return new ProviderError('cancelled');
  if (err instanceof OpenAI.APIConnectionTimeoutError)
    return new ProviderError('timeout', null, { cause: err });
  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderError(
      'network',
      redactor.redact(err.cause instanceof Error ? err.cause.message : err.message),
      {
        cause: err,
      },
    );
  }

  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === 'number' ? err.status : null;
    const { code, message } = extractProviderDetail(err);
    const text = `${code} ${message}`.trim();
    const detail = redactor.redact(message || code || `HTTP ${status ?? '?'}`).slice(0, 300);
    const retryAfterMs = parseRetryAfter(err.headers);
    const opts = { status, retryAfterMs, cause: err };

    switch (true) {
      case status === 401:
        return new ProviderError('auth', detail, opts);
      case status === 402:
        return new ProviderError('quota', detail, opts);
      case status === 403:
        return new ProviderError(QUOTA_HINT.test(text) ? 'quota' : 'permission', detail, opts);
      case status === 404:
        return new ProviderError(
          MODEL_HINT.test(text) ? 'model_not_found' : 'bad_request',
          detail,
          opts,
        );
      case status === 408:
        return new ProviderError('timeout', detail, opts);
      case status === 429:
        return new ProviderError(QUOTA_HINT.test(text) ? 'quota' : 'rate_limit', detail, opts);
      case status === 400 || status === 422:
        if (
          MODEL_HINT.test(text) &&
          /not (found|exist|available|allowed)|invalid model|unknown model/i.test(text)
        ) {
          return new ProviderError('model_not_found', detail, opts);
        }
        return new ProviderError(
          UNSUPPORTED_HINT.test(text) ? 'unsupported' : 'bad_request',
          detail,
          opts,
        );
      case status !== null && status >= 500:
        return new ProviderError('server', detail, opts);
      default:
        // Errors embedded in an SSE stream arrive without an HTTP status.
        if (QUOTA_HINT.test(text)) return new ProviderError('quota', detail, opts);
        if (/rate.?limit|too many requests/i.test(text))
          return new ProviderError('rate_limit', detail, opts);
        return new ProviderError('unknown', detail, opts);
    }
  }

  if (err instanceof Error && err.name === 'AbortError') return new ProviderError('cancelled');
  if (err instanceof SyntaxError)
    return new ProviderError('malformed', redactor.redact(err.message), { cause: err });

  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError('unknown', redactor.redact(message).slice(0, 300), { cause: err });
}
