import type { HttpMethod } from './types.js';

/** Attempts per request, the first included. */
export const MAX_ATTEMPTS = 3;

const BASE_DELAY_MS = 1_000;

/** Methods that are safe to send again after Printify may have processed them. */
const IDEMPOTENT: ReadonlySet<HttpMethod> = new Set(['GET', 'PUT', 'DELETE']);

// All three HTTP date formats in RFC 9110 start with the day name. Date.parse alone is too lenient:
// V8 reads "-5" and "1.5" as dates.
const HTTP_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/;

/** What one attempt produced: the response status, or `'network'` when there was no response. */
export type Outcome = { status: number } | 'network';

/**
 * Whether an attempt may be sent again. A 429 was not processed, so any method may retry. A 502,
 * a 503 or a network error may come after Printify processed the request, so a POST never does.
 */
export function shouldRetry(method: HttpMethod, outcome: Outcome): boolean {
  if (outcome === 'network') return IDEMPOTENT.has(method);
  if (outcome.status === 429) return true;
  if (outcome.status === 502 || outcome.status === 503) return IDEMPOTENT.has(method);
  return false;
}

/**
 * Milliseconds from a `Retry-After` value: digits only are seconds, and an HTTP date is the time
 * until it, or 0 once it has passed. `undefined` when the header is missing or invalid.
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  const value = header?.trim() ?? '';
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!HTTP_DATE.test(value)) return undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/**
 * The wait before retry `retry` (1 or 2): the `Retry-After` value if it is valid, otherwise
 * exponential backoff with jitter, 50–100% of 1 s × 2^(retry - 1).
 */
export function retryDelayMs(
  retry: number,
  retryAfter: string | null,
  random: () => number = Math.random,
): number {
  return (
    parseRetryAfter(retryAfter, Date.now()) ??
    BASE_DELAY_MS * 2 ** (retry - 1) * (0.5 + random() * 0.5)
  );
}
