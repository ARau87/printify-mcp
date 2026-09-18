import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Route } from '../../src/printify/errors.js';
import {
  MAX_WAIT_MS,
  bucketsFor,
  createRateLimiter,
  type RateLimiter,
} from '../../src/printify/rate-limit.js';
import { apiError } from './helpers.js';

const PRODUCTS: Route = { method: 'GET', path: '/v1/shops/12/products.json' };
const CATALOG: Route = { method: 'GET', path: '/v1/catalog/blueprints.json' };
const PUBLISH: Route = { method: 'POST', path: '/v1/shops/12/products/abc/publish.json' };

/** A signal that never aborts. */
const NEVER = new AbortController().signal;

/** Acquires `count` slots at once and resolves when every one has been granted. */
async function acquireMany(limiter: RateLimiter, route: Route, count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, () => limiter.acquire(route, NEVER)));
}

/** Starts an acquire and records when it settles. */
function track(promise: Promise<void>) {
  const state: { settled: boolean; error: unknown } = { settled: false, error: undefined };
  promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('bucketsFor', () => {
  it.each([
    ['/v1/catalog/blueprints.json', ['global', 'catalog']],
    ['/v2/catalog/blueprints/5/print_providers/9/variants.json', ['global', 'catalog']],
    ['/v1/shops/12/products/abc/publish.json', ['global', 'publish']],
    ['/v1/shops/12/products/abc/unpublish.json', ['global']],
    ['/v1/shops/12/products/abc/publishing_succeeded.json', ['global']],
    ['/v1/shops/12/products/abc.json', ['global']],
    ['/v1/shops.json', ['global']],
  ])('%s takes a slot in %j', (path, buckets) => {
    expect(bucketsFor(path)).toEqual(buckets);
  });
});

describe('createRateLimiter', () => {
  it('lets 600 requests through at once, then waits for the first to leave the window', async () => {
    const limiter = createRateLimiter();
    await acquireMany(limiter, PRODUCTS, 600);
    await vi.advanceTimersByTimeAsync(55_000);
    const next = track(limiter.acquire(PRODUCTS, NEVER));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(next.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(next).toEqual({ settled: true, error: undefined });
  });

  it('frees slots as they leave the window, with no refill burst', async () => {
    const limiter = createRateLimiter();
    await acquireMany(limiter, PRODUCTS, 300);
    await vi.advanceTimersByTimeAsync(30_000);
    await acquireMany(limiter, PRODUCTS, 300);
    await vi.advanceTimersByTimeAsync(30_000);
    // The 300 slots from 0 s have left the window; the 300 from 30 s have not.
    await acquireMany(limiter, PRODUCTS, 300);
    const error = await apiError(limiter.acquire(PRODUCTS, NEVER));
    expect(error.retryAfterSeconds).toBe(30);
  });

  it('serves waiting requests in arrival order, a plain request behind a catalog one', async () => {
    const limiter = createRateLimiter();
    await acquireMany(limiter, CATALOG, 100);
    await vi.advanceTimersByTimeAsync(55_000);
    const order: string[] = [];
    const catalog = limiter.acquire(CATALOG, NEVER).then(() => order.push('catalog'));
    const plain = limiter.acquire(PRODUCTS, NEVER).then(() => order.push('plain'));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([catalog, plain]);
    expect(order).toEqual(['catalog', 'plain']);
  });

  it('fails fast when the wait would exceed 10 seconds, and reserves nothing', async () => {
    const limiter = createRateLimiter();
    await acquireMany(limiter, CATALOG, 100);
    const error = await apiError(limiter.acquire(CATALOG, NEVER));
    expect(error).toMatchObject({
      kind: 'http',
      method: 'GET',
      path: '/v1/catalog/blueprints.json',
      status: 429,
      retryAfterSeconds: 60,
    });
    expect(error.message).toBe(
      'GET /v1/catalog/blueprints.json was not sent: the limit of 100 catalog requests per ' +
        'minute is used up. Retry in 60 seconds',
    );
    expect(error.hint).toBe(
      "Printify's rate limit is used up, so the request was not sent. Wait 60 seconds before " +
        'trying again.',
    );
    // Had the failed request reserved a global slot at 60 s, this one would have to wait for it.
    await expect(limiter.acquire(PRODUCTS, NEVER)).resolves.toBeUndefined();
  });

  it('queues a request whose wait is exactly 10 seconds', async () => {
    const limiter = createRateLimiter();
    await acquireMany(limiter, CATALOG, 100);
    await vi.advanceTimersByTimeAsync(50_000);
    const next = track(limiter.acquire(CATALOG, NEVER));
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS - 1);
    expect(next.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(next).toEqual({ settled: true, error: undefined });
  });

  it('fails fast in minutes when the publish limit is used up', async () => {
    const limiter = createRateLimiter();
    await acquireMany(limiter, PUBLISH, 200);
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    const error = await apiError(limiter.acquire(PUBLISH, NEVER));
    expect(error.retryAfterSeconds).toBe(840);
    expect(error.message).toBe(
      'POST /v1/shops/12/products/abc/publish.json was not sent: the limit of 200 publish ' +
        'requests per 30 minutes is used up. Retry in 14 minutes',
    );
  });

  it('names the global limit when that is the one used up', async () => {
    const limiter = createRateLimiter();
    await acquireMany(limiter, PRODUCTS, 600);
    await vi.advanceTimersByTimeAsync(48_000);
    const error = await apiError(limiter.acquire(CATALOG, NEVER));
    expect(error.message).toBe(
      'GET /v1/catalog/blueprints.json was not sent: the limit of 600 requests per minute is ' +
        'used up. Retry in 12 seconds',
    );
  });

  it('names the catalog limit on a tie with the global one', async () => {
    const limiter = createRateLimiter();
    await acquireMany(limiter, PRODUCTS, 500);
    await acquireMany(limiter, CATALOG, 100);
    const error = await apiError(limiter.acquire(CATALOG, NEVER));
    expect(error.message).toBe(
      'GET /v1/catalog/blueprints.json was not sent: the limit of 100 catalog requests per ' +
        'minute is used up. Retry in 60 seconds',
    );
  });

  it('rejects with the reason of a signal that has already aborted, and reserves nothing', async () => {
    const limiter = createRateLimiter();
    const reason = new Error('already cancelled');
    await expect(limiter.acquire(PRODUCTS, AbortSignal.abort(reason))).rejects.toBe(reason);
    // A reserved slot would make the 600th of these fail fast.
    await expect(acquireMany(limiter, PRODUCTS, 600)).resolves.toBeUndefined();
  });

  it('gives the slot back when the signal aborts during the wait', async () => {
    const limiter = createRateLimiter();
    await acquireMany(limiter, CATALOG, 100);
    await vi.advanceTimersByTimeAsync(55_000);
    const controller = new AbortController();
    const reason = new Error('tool call cancelled');
    const waiting = limiter.acquire(CATALOG, controller.signal);
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    // All 100 slots from 0 s have left. Had the aborted request kept its slot at 60 s, the 100th
    // of these would have to wait until 120 s and fail fast.
    await expect(acquireMany(limiter, CATALOG, 100)).resolves.toBeUndefined();
  });
});
