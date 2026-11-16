/**
 * Browser GETs that survive transient failures. A page load fires dozens of requests at once (scripts, route
 * prefetches, the API reads), and a per-client rate limit in front of the site can answer some of them with 429; a
 * restarting server answers 502–504; a dropped connection fails the fetch outright. Those are worth a few retries
 * with backoff. Anything else (404, a 500 from a bug) is returned at once, so the caller reports it as before.
 *
 * Pure apart from fetch and timers, both injectable: unit-tested in lib/__tests__/fetchRetry.test.ts.
 */

/** HTTP statuses that mean "try again shortly". */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 502, 503, 504]);

export interface RetryOptions {
  /** Retries after the first attempt. */
  retries?: number;
  /** Delay before the first retry; doubles on each retry. */
  baseDelayMs?: number;
  /** Upper bound for any single delay, including a server's Retry-After. */
  maxDelayMs?: number;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** 0..1, for jitter; tests pass a constant. */
  random?: () => number;
}

export const DEFAULT_RETRY: Required<Pick<RetryOptions, 'retries' | 'baseDelayMs' | 'maxDelayMs'>> = {
  retries: 4,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

/** Retry-After in ms (delta-seconds or an HTTP date), or null when absent or unparseable. */
export function retryAfterMs(header: string | null, nowMs: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** Delay before retry number `attempt` (0-based): exponential backoff with jitter, at least Retry-After, capped. */
export function retryDelayMs(attempt: number, retryAfter: number | null, opts: Required<Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs'>> & { random: () => number }): number {
  const backoff = opts.baseDelayMs * 2 ** attempt;
  const jittered = backoff / 2 + opts.random() * (backoff / 2);   // 50–100% of the backoff
  return Math.min(opts.maxDelayMs, Math.max(jittered, retryAfter ?? 0));
}

function isAbort(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError';
}

/**
 * fetch(), retried on network errors and RETRYABLE_STATUSES. Resolves with the last response (which may still be an
 * error status, for the caller to report); rejects with the last network error. An aborted request is never retried.
 */
export async function fetchWithRetry(input: string, init: RequestInit = {}, options: RetryOptions = {}): Promise<Response> {
  const retries = options.retries ?? DEFAULT_RETRY.retries;
  const fetchFn = options.fetchFn ?? ((i: RequestInfo | URL, n?: RequestInit) => fetch(i, n));
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const delayOpts = {
    baseDelayMs: options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
    maxDelayMs: options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    random: options.random ?? Math.random,
  };

  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await fetchFn(input, init);
    } catch (err) {
      if (isAbort(err) || init.signal?.aborted || attempt >= retries) throw err;
      await sleep(retryDelayMs(attempt, null, delayOpts));
      continue;
    }
    if (!RETRYABLE_STATUSES.has(response.status) || attempt >= retries || init.signal?.aborted) return response;
    const wait = retryDelayMs(attempt, retryAfterMs(response.headers.get('retry-after')), delayOpts);
    // Free the connection before waiting; the body of a 429/5xx isn't needed.
    response.body?.cancel().catch(() => {});
    await sleep(wait);
  }
}
