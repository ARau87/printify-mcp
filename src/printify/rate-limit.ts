import { PrintifyApiError, type Route } from './errors.js';
import { formatSeconds } from './hints.js';
import { sleep } from './sleep.js';

export type Bucket = 'global' | 'catalog' | 'publish';

export interface BucketLimit {
  limit: number;
  windowMs: number;
}

/** Printify's limits, per account: https://developers.printify.com/#api-usage-guidelines */
export const RATE_LIMITS: Readonly<Record<Bucket, BucketLimit>> = {
  global: { limit: 600, windowMs: 60_000 },
  catalog: { limit: 100, windowMs: 60_000 },
  publish: { limit: 200, windowMs: 1_800_000 },
};

/** The longest a request waits for a slot before it fails fast. */
export const MAX_WAIT_MS = 10_000;

const CATALOG_PATH = /^\/v[12]\/catalog\//;
const PUBLISH_PATH = /^\/v1\/shops\/[^/]+\/products\/[^/]+\/publish\.json$/;

const NOUNS: Readonly<Record<Bucket, string>> = {
  global: 'requests',
  catalog: 'catalog requests',
  publish: 'publish requests',
};

/** The buckets a request takes a slot in, from its `ApiPath`. Always includes `global`. */
export function bucketsFor(path: string): readonly Bucket[] {
  if (CATALOG_PATH.test(path)) return ['global', 'catalog'];
  if (PUBLISH_PATH.test(path)) return ['global', 'publish'];
  return ['global'];
}

export interface RateLimiter {
  /**
   * Resolves when the request may be sent. Rejects with a `PrintifyApiError` when the wait would
   * exceed `MAX_WAIT_MS`, and with `signal.reason` when `signal` aborts first.
   */
  acquire(route: Route, signal: AbortSignal): Promise<void>;
}

/**
 * Creates a limiter with Printify's limits as rolling windows. Each bucket keeps the times of its
 * slots in ascending order, so no window of our own traffic ever holds more than the limit. It
 * starts no timers until a request has to wait.
 */
export function createRateLimiter(): RateLimiter {
  const slots: Record<Bucket, number[]> = { global: [], catalog: [], publish: [] };

  return {
    async acquire(route, signal) {
      signal.throwIfAborted();
      const now = performance.now();
      const buckets = bucketsFor(route.path);
      let time = now;
      let blocking: Bucket = 'global';
      for (const bucket of buckets) {
        const free = nextFree(slots[bucket], RATE_LIMITS[bucket], now);
        // `>=`: on a tie, name the catalog or publish bucket, which comes after global.
        if (free >= time) {
          time = free;
          blocking = bucket;
        }
      }
      const wait = time - now;
      if (wait > MAX_WAIT_MS) throw rateLimitError(route, blocking, wait);
      for (const bucket of buckets) slots[bucket].push(time);
      if (wait <= 0) return;
      try {
        await sleep(wait, signal);
      } catch (error) {
        // Give the slot back. Requests queued behind it keep theirs: later than needed, but safe.
        for (const bucket of buckets) remove(slots[bucket], time);
        throw error;
      }
    },
  };
}

/** Drops the slots that have left the window, then returns when the bucket's next slot is free. */
function nextFree(times: number[], { limit, windowMs }: BucketLimit, now: number): number {
  const firstLive = times.findIndex((time) => time > now - windowMs);
  times.splice(0, firstLive === -1 ? times.length : firstLive);
  const latest = times.at(-1) ?? now;
  // Undefined while the bucket holds fewer than `limit` slots.
  const oldest = times.at(-limit);
  return oldest === undefined ? latest : Math.max(latest, oldest + windowMs);
}

function remove(times: number[], time: number): void {
  const index = times.lastIndexOf(time);
  if (index !== -1) times.splice(index, 1);
}

function rateLimitError(route: Route, bucket: Bucket, waitMs: number): PrintifyApiError {
  const { limit, windowMs } = RATE_LIMITS[bucket];
  const minutes = windowMs / 60_000;
  const per = minutes === 1 ? 'minute' : `${String(minutes)} minutes`;
  const retryAfterSeconds = Math.ceil(waitMs / 1000);
  return new PrintifyApiError(
    `${route.method} ${route.path} was not sent: the limit of ${String(limit)} ${NOUNS[bucket]} ` +
      `per ${per} is used up. Retry in ${formatSeconds(retryAfterSeconds)}`,
    { kind: 'http', ...route, status: 429, retryAfterSeconds },
  );
}
