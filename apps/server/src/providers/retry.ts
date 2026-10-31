import { ProviderError } from './errors.js';

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  signal?: AbortSignal | undefined;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ProviderError('cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The wait before retry number `attempt` (1-based): jittered exponential backoff, at least the
 * error's retry-after, at most the cap. */
export function retryDelay(
  attempt: number,
  err: ProviderError,
  opts: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'random'> = {},
): number {
  const base = opts.baseDelayMs ?? 500;
  const cap = opts.maxDelayMs ?? 30_000;
  const random = opts.random ?? Math.random;
  const backoff = Math.min(cap, base * 2 ** (attempt - 1));
  const jittered = backoff / 2 + random() * (backoff / 2);
  return Math.min(cap, Math.max(jittered, err.retryAfterMs ?? 0));
}

/**
 * Run `fn` with bounded exponential backoff. Only errors marked retryable (rate limits, timeouts,
 * network and 5xx errors) are retried; auth, quota, and validation errors fail immediately.
 * The `attempt` argument starts at 1.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  classify: (err: unknown) => ProviderError,
  opts: RetryOptions,
): Promise<{ value: T; attempts: number }> {
  const sleep = opts.sleep ?? abortableSleep;

  for (let attempt = 1; ; attempt++) {
    if (opts.signal?.aborted) throw new ProviderError('cancelled');
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (raw) {
      const err = classify(raw);
      if (opts.signal?.aborted) throw new ProviderError('cancelled');
      if (!err.retryable || attempt > opts.maxRetries) {
        err.attempts = attempt;
        throw err;
      }
      await sleep(retryDelay(attempt, err, opts), opts.signal);
    }
  }
}
