# Rate Limiting and Retries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Printify request waits for a free slot under Printify's rate limits (global 600/min,
catalog 100/min, publishing 200 per 30 min), fails fast with a clear "retry in N" error when the
wait would exceed 10 s, and retries 429s for any method and 502/503/network errors for GET, PUT and
DELETE, with at most 3 attempts.

**Architecture:** `rate-limit.ts` keeps one rolling window of slot times per bucket and hands out
slots in arrival order; `sleep.ts` is the abortable wait both the limiter and the retry loop use;
`retry.ts` holds pure functions that decide whether and how long to wait before retrying. The
`request()` method in `client.ts` gains an attempt loop, `send()`, that takes a limiter slot, calls
the injected `fetch`, reads the body and asks `retry.ts` whether to go again, all under the
request's existing timeout signal. `PrintifyApiError` gains `retryAfterSeconds`, which the 429 hint
uses.

**Tech Stack:** Node >= 22, TypeScript ~6.0.3, Vitest 5 (fake timers fake `setTimeout`, `Date` and
`performance.now()` by default), ESLint 10 with typescript-eslint 8 `strictTypeChecked`,
Prettier 3.

**Spec:** `docs/superpowers/specs/2026-09-18-rate-limit-retry-design.md`. Read it before starting.
This plan implements it exactly.

## Global Constraints

- Branch: `feat/4-rate-limit-retry` (already exists, with the spec and this plan committed on it).
  Never commit to `main`. The branch has no upstream yet; Task 5 pushes it with `-u`.
- No new dependencies. `package.json` and `package-lock.json` do not change.
- `"type": "module"` and NodeNext: relative imports use the `.js` suffix, including in tests.
- Nothing in `src/` may use `console.*` (ESLint `no-console`).
- `createPrintifyClient` must stay free of side effects: no timers or connections until a request.
  Creating a limiter starts no timers.
- The limiter is per client and per process. There is no module-level state.
- Error messages and hints are part of the interface. Tests assert them exactly, so copy them
  verbatim from this plan.
- `AbortSignal.timeout` does not follow Vitest's fake timers, so timeout tests use real 20 ms
  timeouts. Every other waiting test uses `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync`.
- Lint is typescript-eslint `strictTypeChecked` plus ESLint's `preserve-caught-error`. No non-null
  assertions (`!`). Numbers in template literals must be wrapped in `String(…)`. A test helper must
  not re-throw a new error from inside a `catch`; use the `rejection`/`apiError` pair shown below.
- Prettier: `singleQuote: true`, `printWidth: 100`. Every file must pass `prettier --check`. The
  code in this plan is already Prettier-formatted.
- Commit messages use this repo's style: a short imperative sentence with no conventional-commit
  prefix, a blank line, then exactly this trailer, whatever model writes the commit:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Everything below was prototyped on 2026-09-18 with Node 24.13.1, Vitest 5.0.1 and TypeScript
  6.0.3: 287 tests passing, lint, typecheck, Prettier and build clean. The expected outputs come
  from that run. The suite has 208 tests before Task 1.

## File Map

| File                               | Responsibility                                                   | Task |
| ---------------------------------- | ---------------------------------------------------------------- | ---- |
| `src/printify/hints.ts`            | `formatSeconds`; 429 hint with `retryAfterSeconds`               | 1    |
| `src/printify/errors.ts`           | `retryAfterSeconds` field on `PrintifyApiError`                  | 1    |
| `test/printify/hints.test.ts`      | New 429 row, `formatSeconds`                                     | 1    |
| `test/printify/errors.test.ts`     | The constructor stores `retryAfterSeconds`                       | 1    |
| `src/printify/sleep.ts`            | `sleep(ms, signal)`                                              | 2    |
| `src/printify/rate-limit.ts`       | `RATE_LIMITS`, `MAX_WAIT_MS`, `bucketsFor`, `createRateLimiter`  | 2    |
| `test/printify/sleep.test.ts`      | Delay, abort during the wait, already aborted                    | 2    |
| `test/printify/rate-limit.test.ts` | Buckets, rolling window, order, fail-fast, messages, abort       | 2    |
| `src/printify/retry.ts`            | `MAX_ATTEMPTS`, `shouldRetry`, `parseRetryAfter`, `retryDelayMs` | 3    |
| `test/printify/retry.test.ts`      | Retry table, `Retry-After` parsing, backoff ranges               | 3    |
| `src/printify/client.ts`           | One limiter per client; attempt loop `send()` in `request()`     | 4    |
| `test/printify/client.test.ts`     | Retries and limits end to end; two #3 tests moved to fake timers | 4    |

---

### Task 1: `retryAfterSeconds` and the hint for a rate-limit wait

**Files:**

- Modify: `src/printify/hints.ts`
- Modify: `src/printify/errors.ts`
- Test: `test/printify/hints.test.ts`, `test/printify/errors.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `formatSeconds(seconds: number): string` exported from `src/printify/hints.ts`. Task 2 uses it
    in the fail-fast message.
  - `PrintifyErrorFields.retryAfterSeconds?: number | undefined` and
    `PrintifyApiError.retryAfterSeconds: number | undefined` in `src/printify/errors.ts`. Task 2
    sets it on the fail-fast error.
  - `HintInput.retryAfterSeconds?: number | undefined`. Optional, so existing callers and tests
    that build a `HintInput` do not change.

- [ ] **Step 1: Write the failing tests**

In `test/printify/hints.test.ts`, change the import on line 2 to:

```ts
import { formatSeconds, hintFor, scopeFor, type HintInput } from '../../src/printify/hints.js';
```

Inside `describe('hintFor', …)`, directly after the `it.each(…)('explains HTTP %i', …)` block and
before `it('prefers the code hint over the status hint', …)`, add:

<!-- prettier-ignore -->
```ts
  it('gives the wait on a 429 that the rate limiter never sent', () => {
    expect(hintFor({ ...http(429), retryAfterSeconds: 60 })).toBe(
      "Printify's rate limit is used up, so the request was not sent. Wait 60 seconds before " +
        'trying again.',
    );
    expect(hintFor({ ...http(429), retryAfterSeconds: 840 })).toBe(
      "Printify's rate limit is used up, so the request was not sent. Wait 14 minutes before " +
        'trying again.',
    );
  });
```

At the end of `test/printify/hints.test.ts`, add:

```ts
describe('formatSeconds', () => {
  it.each([
    [11, '11 seconds'],
    [119, '119 seconds'],
    [120, '2 minutes'],
    [121, '3 minutes'],
    [1800, '30 minutes'],
  ])('formats %i as %s', (seconds, text) => {
    expect(formatSeconds(seconds)).toBe(text);
  });
});
```

At the end of `test/printify/errors.test.ts`, add (`PrintifyApiError` and `httpError` are already
imported):

```ts
describe('PrintifyApiError', () => {
  it('stores retryAfterSeconds and uses it for the hint', () => {
    const error = new PrintifyApiError('GET /v1/shops.json was not sent', {
      kind: 'http',
      method: 'GET',
      path: '/v1/shops.json',
      status: 429,
      retryAfterSeconds: 30,
    });
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.hint).toBe(
      "Printify's rate limit is used up, so the request was not sent. Wait 30 seconds before " +
        'trying again.',
    );
  });

  it('leaves retryAfterSeconds unset on a 429 from Printify', () => {
    const error = httpError({ method: 'GET', path: '/v1/shops.json' }, 429, undefined, null);
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.hint).toBe(
      "Printify's rate limit was reached. Wait a minute before trying again.",
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/printify/hints.test.ts test/printify/errors.test.ts`

Expected: `Tests  7 failed | 55 passed (62)`. The five `formatSeconds` cases fail with
`TypeError: formatSeconds is not a function`, the new hint test with
`expected 'Printify\'s rate limit was reached. W…' to be 'Printify\'s rate limit is used up, so…'`,
and `stores retryAfterSeconds …` with `expected undefined to be 30`. The "leaves retryAfterSeconds
unset" test already passes: it guards the existing behaviour.

- [ ] **Step 3: Implement**

In `src/printify/hints.ts`, replace the `HintInput` interface with:

```ts
/** What a hint depends on. `PrintifyApiError` has all of these fields. */
export interface HintInput {
  kind: PrintifyErrorKind;
  method: HttpMethod;
  path: string;
  status: number | undefined;
  code: number | undefined;
  /** Set only on the rate limiter's fail-fast error, which was never sent. */
  retryAfterSeconds?: number | undefined;
}
```

Directly above `/** The token scope the endpoint probably needs, …` (the `scopeFor` doc comment),
add:

```ts
/** A wait of more than 10 seconds, for messages: seconds under 2 minutes, else whole minutes. */
export function formatSeconds(seconds: number): string {
  return seconds < 120
    ? `${String(seconds)} seconds`
    : `${String(Math.ceil(seconds / 60))} minutes`;
}
```

Replace the whole `statusHint` function at the end of the file with:

```ts
function statusHint({ status, method, path, retryAfterSeconds }: HintInput): string | undefined {
  if (status === undefined) return undefined;
  if (status === 409) return DUPLICATE_ORDER;
  if (status === 401) return UNAUTHORIZED;
  if (status === 403) {
    const scope = scopeFor(method, path);
    if (scope === undefined) return FORBIDDEN;
    return (
      `Printify denied access. The token probably lacks the \`${scope}\` scope; the user can ` +
      "create a new token that includes it. Printify's message may name another reason."
    );
  }
  if (status === 404) return NOT_FOUND;
  if (status === 429) {
    if (retryAfterSeconds === undefined) return RATE_LIMITED;
    return (
      "Printify's rate limit is used up, so the request was not sent. " +
      `Wait ${formatSeconds(retryAfterSeconds)} before trying again.`
    );
  }
  if (status >= 500 && status <= 599) return SERVER_ERROR;
  return undefined;
}
```

In `src/printify/errors.ts`, replace the `PrintifyErrorFields` interface and the
`PrintifyApiError` class with:

```ts
export interface PrintifyErrorFields extends Route {
  kind: PrintifyErrorKind;
  status?: number | undefined;
  code?: number | undefined;
  printifyMessage?: string | undefined;
  reason?: string | undefined;
  requestId?: string | undefined;
  /** Set only by the rate limiter's fail-fast error: the request was not sent. */
  retryAfterSeconds?: number | undefined;
}

/** Every failure of a Printify request. `kind` says which. The hint is advice for the assistant. */
export class PrintifyApiError extends Error {
  override readonly name = 'PrintifyApiError';
  readonly kind: PrintifyErrorKind;
  readonly method: HttpMethod;
  readonly path: string;
  readonly status: number | undefined;
  readonly code: number | undefined;
  readonly printifyMessage: string | undefined;
  readonly reason: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly hint: string | undefined;

  constructor(message: string, fields: PrintifyErrorFields, options?: ErrorOptions) {
    super(message, options);
    this.kind = fields.kind;
    this.method = fields.method;
    this.path = fields.path;
    this.status = fields.status;
    this.code = fields.code;
    this.printifyMessage = fields.printifyMessage;
    this.reason = fields.reason;
    this.requestId = fields.requestId;
    this.retryAfterSeconds = fields.retryAfterSeconds;
    this.hint = hintFor(this);
  }
}
```

`retryAfterSeconds` must be assigned before `this.hint = hintFor(this)`, because the hint reads it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/printify/hints.test.ts test/printify/errors.test.ts`
Expected: `Tests  62 passed (62)`.

Run: `npm run typecheck && npm run lint && npm test`
Expected: no type or lint errors; `Tests  216 passed (216)`.

- [ ] **Step 5: Commit**

```bash
git add src/printify/hints.ts src/printify/errors.ts test/printify/hints.test.ts test/printify/errors.test.ts
git commit -F - <<'EOF'
Add retryAfterSeconds and a hint for rate-limit waits

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: `sleep` and the rolling-window rate limiter

**Files:**

- Create: `src/printify/sleep.ts`
- Create: `src/printify/rate-limit.ts`
- Test: `test/printify/sleep.test.ts`, `test/printify/rate-limit.test.ts`

**Interfaces:**

- Consumes (Task 1): `formatSeconds` from `./hints.js`; `PrintifyApiError` with
  `retryAfterSeconds`, and the `Route` type (`{ method: HttpMethod; path: string }`), from
  `./errors.js`.
- Produces:
  - `sleep(ms: number, signal: AbortSignal): Promise<void>` in `src/printify/sleep.ts`. Rejects
    with `signal.reason`.
  - In `src/printify/rate-limit.ts`: `type Bucket = 'global' | 'catalog' | 'publish'`,
    `RATE_LIMITS`, `MAX_WAIT_MS = 10_000`, `bucketsFor(path: string): readonly Bucket[]`,
    `interface RateLimiter { acquire(route: Route, signal: AbortSignal): Promise<void> }` and
    `createRateLimiter(): RateLimiter`. Task 4 uses `MAX_WAIT_MS`, `createRateLimiter` and
    `RateLimiter`.

- [ ] **Step 1: Write the failing tests**

Create `test/printify/sleep.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sleep } from '../../src/printify/sleep.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('resolves after the delay and not before', async () => {
  let done = false;
  void sleep(1000, new AbortController().signal).then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(done).toBe(true);
});

it('rejects with the reason when the signal aborts during the wait, and clears its timer', async () => {
  const controller = new AbortController();
  const reason = new Error('tool call cancelled');
  const pending = sleep(1000, controller.signal);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects at once for a signal that has already aborted', async () => {
  const reason = new Error('already cancelled');
  await expect(sleep(1000, AbortSignal.abort(reason))).rejects.toBe(reason);
  expect(vi.getTimerCount()).toBe(0);
});
```

Create `test/printify/rate-limit.test.ts`. Every test here uses fake timers, which also fake
`performance.now()`, so slot times are whole milliseconds from a fixed start:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrintifyApiError, type Route } from '../../src/printify/errors.js';
import {
  MAX_WAIT_MS,
  bucketsFor,
  createRateLimiter,
  type RateLimiter,
} from '../../src/printify/rate-limit.js';

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

/** Awaits a promise that must reject, and returns the reason. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function apiError(promise: Promise<unknown>): Promise<PrintifyApiError> {
  const error = await rejection(promise);
  if (error instanceof PrintifyApiError) return error;
  throw new Error(`expected a PrintifyApiError, got ${String(error)}`);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/printify/sleep.test.ts test/printify/rate-limit.test.ts`

Expected: `Test Files  2 failed (2)`, with
`Error: Cannot find module '../../src/printify/sleep.js'` and
`Error: Cannot find module '../../src/printify/rate-limit.js'`.

- [ ] **Step 3: Implement `sleep`**

Create `src/printify/sleep.ts`:

```ts
/**
 * Resolves after `ms` milliseconds. Rejects with `signal.reason` when `signal` aborts first, or at
 * once if it already has. Uses the global `setTimeout`, which Vitest's fake timers control.
 */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

Do not use `setTimeout` from `node:timers/promises`: it rejects with its own `AbortError` rather
than `signal.reason`, and the client relies on getting the caller's reason back unchanged.

- [ ] **Step 4: Implement the limiter**

Create `src/printify/rate-limit.ts`:

```ts
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
```

Why it works:

- Slot times never decrease within a bucket, because a new slot is at least the bucket's latest
  one. With ascending times, "the `limit`-th most recent slot is at least one window old" means no
  window of `windowMs` holds more than `limit` slots.
- `times.at(-limit)` is `times[length - limit]`, or `undefined` while there are fewer than `limit`
  slots.
- Pruning only drops slots that can no longer affect a new one; it keeps memory bounded.
- The fail-fast check happens before anything is pushed, so a failed request reserves nothing.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/printify/sleep.test.ts test/printify/rate-limit.test.ts`
Expected: `Tests  20 passed (20)`.

Run: `npm run typecheck && npm run lint && npm test`
Expected: no type or lint errors; `Tests  236 passed (236)`.

- [ ] **Step 6: Commit**

```bash
git add src/printify/sleep.ts src/printify/rate-limit.ts test/printify/sleep.test.ts test/printify/rate-limit.test.ts
git commit -F - <<'EOF'
Add the rolling-window rate limiter

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: The retry policy

**Files:**

- Create: `src/printify/retry.ts`
- Test: `test/printify/retry.test.ts`

**Interfaces:**

- Consumes: `HttpMethod` from `./types.js`.
- Produces, in `src/printify/retry.ts`: `MAX_ATTEMPTS = 3`,
  `type Outcome = { status: number } | 'network'`,
  `shouldRetry(method: HttpMethod, outcome: Outcome): boolean`,
  `parseRetryAfter(header: string | null, nowMs: number): number | undefined` and
  `retryDelayMs(retry: number, retryAfter: string | null, random?: () => number): number`. Task 4
  uses `MAX_ATTEMPTS`, `Outcome`, `shouldRetry` and `retryDelayMs`.

- [ ] **Step 1: Write the failing tests**

Create `test/printify/retry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  parseRetryAfter,
  retryDelayMs,
  shouldRetry,
} from '../../src/printify/retry.js';

describe('shouldRetry', () => {
  it.each([
    ['GET', 429, true],
    ['PUT', 429, true],
    ['DELETE', 429, true],
    ['POST', 429, true],
    ['GET', 502, true],
    ['PUT', 502, true],
    ['DELETE', 503, true],
    ['GET', 503, true],
    ['POST', 502, false],
    ['POST', 503, false],
    ['GET', 500, false],
    ['GET', 504, false],
    ['GET', 400, false],
    ['DELETE', 404, false],
    ['POST', 409, false],
    ['GET', 200, false],
    ['GET', 304, false],
  ] as const)('%s with HTTP %i: %s', (method, status, expected) => {
    expect(shouldRetry(method, { status })).toBe(expected);
  });

  it.each([
    ['GET', true],
    ['PUT', true],
    ['DELETE', true],
    ['POST', false],
  ] as const)('%s after a network error: %s', (method, expected) => {
    expect(shouldRetry(method, 'network')).toBe(expected);
  });

  it('allows three attempts in total', () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});

describe('parseRetryAfter', () => {
  const NOW = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');

  it.each([
    ['5', 5_000],
    [' 0 ', 0],
    ['120', 120_000],
  ])('reads %j as seconds', (header, expected) => {
    expect(parseRetryAfter(header, NOW)).toBe(expected);
  });

  it('reads an HTTP date as the time until it', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:30 GMT', NOW)).toBe(30_000);
  });

  it('reads an HTTP date in the past as 0', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:27:00 GMT', NOW)).toBe(0);
  });

  it.each([null, '', '-5', '1.5', 'soon', 'Sunday, maybe'])('ignores %j', (header) => {
    expect(parseRetryAfter(header, NOW)).toBeUndefined();
  });
});

describe('retryDelayMs', () => {
  it.each([
    [1, 0, 500],
    [1, 0.999, 999.5],
    [2, 0, 1_000],
    [2, 0.999, 1_999],
  ])('backs off retry %i with random() at %d', (retry, random, expected) => {
    expect(retryDelayMs(retry, null, () => random)).toBeCloseTo(expected);
  });

  it('prefers a valid Retry-After to backoff', () => {
    expect(retryDelayMs(1, '7', () => 0)).toBe(7_000);
  });

  it('falls back to backoff for an invalid Retry-After', () => {
    expect(retryDelayMs(2, 'soon', () => 0)).toBe(1_000);
  });
});
```

The `-5` and `1.5` cases matter: V8's `Date.parse` reads both as dates (`Date.parse('-5')` is
`988668000000`), so a plain `Date.parse` fallback would turn them into a 0 ms retry.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/printify/retry.test.ts`
Expected: `Test Files  1 failed (1)` with `Error: Cannot find module '../../src/printify/retry.js'`.

- [ ] **Step 3: Implement**

Create `src/printify/retry.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/printify/retry.test.ts`
Expected: `Tests  39 passed (39)`.

Run: `npm run typecheck && npm run lint && npm test`
Expected: no type or lint errors; `Tests  275 passed (275)`.

- [ ] **Step 5: Commit**

```bash
git add src/printify/retry.ts test/printify/retry.test.ts
git commit -F - <<'EOF'
Add the retry policy for Printify requests

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Retry and rate-limit every client request

**Files:**

- Modify: `src/printify/client.ts` (whole file shown below)
- Test: `test/printify/client.test.ts`

**Interfaces:**

- Consumes: `MAX_WAIT_MS`, `createRateLimiter`, `RateLimiter` from `./rate-limit.js` (Task 2);
  `sleep` from `./sleep.js` (Task 2); `MAX_ATTEMPTS`, `Outcome`, `retryDelayMs`, `shouldRetry`
  from `./retry.js` (Task 3).
- Produces: no new exports. `PrintifyClientOptions`, `RequestOptions`, `PrintifyClient` and
  `createPrintifyClient` keep their signatures; only the behaviour of `request()` changes.

- [ ] **Step 1: Write the failing tests**

All edits are in `test/printify/client.test.ts`.

**(a)** Replace the top-level `afterEach` block (after `neverAnswer`) with this helper and an
`afterEach` that also restores real timers:

```ts
/** Answers the nth request with the nth responder, and every later one with the last. */
function inTurn(...responders: Responder[]): Responder {
  let count = 0;
  return (request) => {
    const respond = responders[Math.min(count, responders.length - 1)];
    count += 1;
    if (respond === undefined) throw new Error('inTurn needs at least one responder');
    return respond(request);
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
```

**(b)** In `describe('createPrintifyClient: failures', …)`, replace the test
`'marks an HTML error page as a non-JSON response'` with the version below. A GET is now retried on
502, so it runs under fake timers and expects three attempts:

<!-- prettier-ignore -->
```ts
  it('marks an HTML error page as a non-JSON response', async () => {
    vi.useFakeTimers();
    const { printify, requests } = client(
      () => new Response('<html>Bad gateway</html>', { status: 502 }),
    );
    const pending = apiError(printify.request('GET', apiPath`/v1/shops.json`));
    // A GET is retried on 502: three attempts, with at most 1 s and then 2 s of backoff.
    await vi.advanceTimersByTimeAsync(3_000);
    const error = await pending;
    expect(error).toMatchObject({ kind: 'http', status: 502 });
    expect(error.message).toBe('GET /v1/shops.json failed with HTTP 502 (non-JSON response)');
    expect(requests).toHaveLength(3);
  });
```

**(c)** In the same `describe`, replace the test
`'re-throws a PrintifyApiError thrown by fetch unchanged'` with:

<!-- prettier-ignore -->
```ts
  it('re-throws a PrintifyApiError thrown by fetch unchanged', async () => {
    const rateLimited = new PrintifyApiError('GET /v1/shops.json was not sent: rate limit', {
      kind: 'http',
      method: 'GET',
      path: '/v1/shops.json',
      status: 429,
    });
    const { printify, fetch } = client(() => Promise.reject(rateLimited));
    await expect(printify.request('GET', apiPath`/v1/shops.json`)).rejects.toBe(rateLimited);
    // Not retried, although a GET is retried after other rejections.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
```

**(d)** In the same `describe`, replace the test
`'turns a rejected fetch into a network error that keeps the cause'` with:

<!-- prettier-ignore -->
```ts
  it('turns a rejected fetch into a network error that keeps the cause', async () => {
    const system = Object.assign(new Error('getaddrinfo ENOTFOUND api.printify.com'), {
      code: 'ENOTFOUND',
    });
    const cause = new TypeError('fetch failed', { cause: system });
    vi.useFakeTimers();
    const { printify, requests } = client(() => Promise.reject(cause));
    const pending = apiError(printify.request('GET', apiPath`/v1/shops.json`));
    // A GET is retried after a network error: three attempts, then the last error is reported.
    await vi.advanceTimersByTimeAsync(3_000);
    const error = await pending;
    expect(requests).toHaveLength(3);
    expect(error).toMatchObject({ kind: 'network', status: undefined });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('GET /v1/shops.json failed: could not reach Printify (ENOTFOUND)');
  });
```

**(e)** Directly before `describe('createPrintifyClient: redaction', …)`, add:

```ts
describe('createPrintifyClient: retries and rate limits', () => {
  const badGateway = () => new Response('<html>Bad gateway</html>', { status: 502 });

  it('retries a 429, even for a POST, and resolves with the next response', async () => {
    vi.useFakeTimers();
    const { printify, requests } = client(
      inTurn(
        () => json({}, 429),
        () => json({ id: 'o-1' }),
      ),
    );
    const pending = printify.request('POST', apiPath`/v1/shops/${12}/orders.json`, { body: {} });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ id: 'o-1' });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toBe('{}');
  });

  it('waits for Retry-After before retrying', async () => {
    vi.useFakeTimers();
    const { printify, requests } = client(
      inTurn(
        () => json({}, 429, { 'Retry-After': '5' }),
        () => json({ ok: true }),
      ),
    );
    const pending = printify.request('GET', apiPath`/v1/shops.json`);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(2);
  });

  it('does not retry when Retry-After asks for more than 10 seconds', async () => {
    const { printify, requests } = client(() =>
      json({ error: 'Too Many Requests' }, 429, { 'Retry-After': '120' }),
    );
    const error = await apiError(printify.request('GET', apiPath`/v1/shops.json`));
    expect(error).toMatchObject({ kind: 'http', status: 429, retryAfterSeconds: undefined });
    expect(error.hint).toBe(
      "Printify's rate limit was reached. Wait a minute before trying again.",
    );
    expect(requests).toHaveLength(1);
  });

  it('never retries a POST on 502', async () => {
    vi.useFakeTimers();
    const { printify, requests } = client(badGateway);
    const error = await apiError(
      printify.request('POST', apiPath`/v1/shops/${12}/orders.json`, { body: {} }),
    );
    expect(error.status).toBe(502);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toHaveLength(1);
  });

  it('retries a GET on 503 and resolves with the next response', async () => {
    vi.useFakeTimers();
    const { printify, requests } = client(
      inTurn(
        () => json({}, 503),
        () => json({ ok: true }),
      ),
    );
    const pending = printify.request('GET', apiPath`/v1/shops.json`);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(2);
  });

  it('never retries a 500 or other 4xx responses', async () => {
    vi.useFakeTimers();
    for (const status of [500, 400, 404]) {
      const { printify, requests } = client(() => json({ error: 'Nope' }, status));
      const error = await apiError(printify.request('GET', apiPath`/v1/shops.json`));
      expect(error.status).toBe(status);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(requests).toHaveLength(1);
    }
  });

  it('retries a GET after a network error, but not a POST', async () => {
    vi.useFakeTimers();
    const failed = () => Promise.reject(new TypeError('fetch failed'));
    const get = client(inTurn(failed, () => json({ ok: true })));
    const pending = get.printify.request('GET', apiPath`/v1/shops.json`);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(get.requests).toHaveLength(2);

    const post = client(failed);
    const error = await apiError(
      post.printify.request('POST', apiPath`/v1/shops/${12}/orders.json`, { body: {} }),
    );
    expect(error.kind).toBe('network');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(post.requests).toHaveLength(1);
  });

  it('retries a GET whose body fails midway', async () => {
    vi.useFakeTimers();
    const brokenBody = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError('terminated'));
          },
        }),
      );
    const { printify, requests } = client(inTurn(brokenBody, () => json({ ok: true })));
    const pending = printify.request('GET', apiPath`/v1/uploads.json`);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(2);
  });

  it('fails fast on the 101st catalog request without calling fetch', async () => {
    vi.useFakeTimers();
    const { printify, fetch } = client(() => json({}));
    const path = apiPath`/v1/catalog/blueprints.json`;
    await Promise.all(Array.from({ length: 100 }, () => printify.request('GET', path)));
    const error = await apiError(printify.request('GET', path));
    expect(error).toMatchObject({ kind: 'http', status: 429, retryAfterSeconds: 60 });
    expect(error.message).toBe(
      'GET /v1/catalog/blueprints.json was not sent: the limit of 100 catalog requests per ' +
        'minute is used up. Retry in 60 seconds',
    );
    expect(fetch).toHaveBeenCalledTimes(100);
  });

  it('gives each client its own limiter', async () => {
    vi.useFakeTimers();
    const path = apiPath`/v1/catalog/blueprints.json`;
    const first = client(() => json({}));
    await Promise.all(Array.from({ length: 100 }, () => first.printify.request('GET', path)));
    const second = client(() => json({}));
    await expect(second.printify.request('GET', path)).resolves.toEqual({});
  });

  it('stops at once when the caller aborts during the backoff', async () => {
    vi.useFakeTimers();
    const { printify, requests } = client(() => json({}, 429));
    const controller = new AbortController();
    const reason = new Error('tool call cancelled');
    const pending = rejection(
      printify.request('GET', apiPath`/v1/shops.json`, { signal: controller.signal }),
    );
    // The first attempt has failed; the backoff before the second lasts at least 500 ms.
    await vi.advanceTimersByTimeAsync(100);
    expect(requests).toHaveLength(1);
    controller.abort(reason);
    expect(await pending).toBe(reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requests).toHaveLength(1);
  });

  it('times out during the backoff', async () => {
    // Real timers: AbortSignal.timeout does not follow Vitest's fake timers.
    const { printify, requests } = client(() => json({}, 429, { 'Retry-After': '5' }), {
      timeoutMs: 20,
    });
    const error = await apiError(printify.request('GET', apiPath`/v1/shops.json`));
    expect(error).toMatchObject({ kind: 'timeout' });
    expect(error.message).toBe('GET /v1/shops.json timed out after 20 ms');
    expect(requests).toHaveLength(1);
  });
});
```

Wherever a test calls `vi.useFakeTimers()`, the `afterEach` from (a) restores real timers.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/printify/client.test.ts`

Expected: `Tests  10 failed | 26 passed (36)`. The failing tests are the two rewritten #3 tests (the
old client sends one request, not three) and eight new ones: `retries a 429 …`,
`waits for Retry-After …`, `retries a GET on 503 …`, `retries a GET after a network error …`,
`retries a GET whose body fails midway`, `fails fast on the 101st catalog request …`,
`stops at once when the caller aborts …` and `times out during the backoff`. The remaining new tests
(`does not retry when Retry-After asks for more than 10 seconds`, `never retries a POST on 502`,
`never retries a 500 or other 4xx responses`, `gives each client its own limiter`) and the rewritten
pass-through test already pass: they guard against retrying too much.

- [ ] **Step 3: Implement**

Replace the whole of `src/printify/client.ts` with:

```ts
import { PACKAGE_VERSION } from '../package-info.js';
import { redactValues } from '../redact.js';
import type { Secret } from '../secret.js';
import {
  PrintifyApiError,
  httpError,
  invalidResponseError,
  networkError,
  parseJson,
  timeoutError,
  type Route,
} from './errors.js';
import type { ApiPath } from './path.js';
import { MAX_WAIT_MS, createRateLimiter, type RateLimiter } from './rate-limit.js';
import { MAX_ATTEMPTS, retryDelayMs, shouldRetry, type Outcome } from './retry.js';
import { sleep } from './sleep.js';
import type { HttpMethod } from './types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface PrintifyClientOptions {
  token: Secret;
  /** `config.apiBaseUrl`: no trailing slash and no API version. */
  baseUrl: string;
  /** Defaults to the global `fetch`. Tests and #6 pass a fake, which sits below the retries. */
  fetch?: typeof globalThis.fetch;
  /** Default timeout for every request, in milliseconds. */
  timeoutMs?: number;
}

/** Query parameters. `undefined` values are left out. */
export type Query = Readonly<Record<string, string | number | boolean | undefined>>;

export interface RequestOptions {
  query?: Query;
  /** Sent as JSON. Not allowed with GET. */
  body?: unknown;
  /** The caller's cancellation signal, e.g. the MCP request's. */
  signal?: AbortSignal;
  /** Overrides the client's default timeout, e.g. for uploads by URL. */
  timeoutMs?: number;
}

export interface PrintifyClient {
  /**
   * Sends one request, waiting for a rate-limit slot before each attempt and retrying the failures
   * that are safe to retry. Resolves to the parsed JSON body, or `undefined` when the body is
   * empty. Rejects with a `PrintifyApiError`, or with the caller's abort reason when `signal`
   * aborts.
   */
  request(method: HttpMethod, path: ApiPath, options?: RequestOptions): Promise<unknown>;
}

/**
 * Creates a client with its own rate limiter. It starts no timers and opens no connections until
 * the first request. Throws a `TypeError` if the token contains characters that cannot be sent in
 * an HTTP header.
 */
export function createPrintifyClient(options: PrintifyClientOptions): PrintifyClient {
  // The only reveal() in the codebase: the header needs the token, and errors must scrub it.
  const token = options.token.reveal();
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': `printify-mcp/${PACKAGE_VERSION}`,
    'Content-Type': 'application/json;charset=utf-8',
  };
  try {
    new Headers(headers);
  } catch {
    throw new TypeError(
      'The Printify token contains characters that cannot be sent in an HTTP header',
    );
  }
  const limiter = createRateLimiter();

  return {
    async request(method, path, { query, body, signal, timeoutMs = defaultTimeoutMs } = {}) {
      // fetch would reject this with a TypeError that looks like a network error.
      if (method === 'GET' && body !== undefined) {
        throw new TypeError('A GET request cannot have a body');
      }
      // Serialised before the try: a body that cannot be JSON-encoded (e.g. a BigInt) must not
      // be reported as a network error.
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const route: Route = { method, path };
      const fetch = options.fetch ?? globalThis.fetch;
      const url = buildUrl(options.baseUrl, path, query);
      const timeout = AbortSignal.timeout(timeoutMs);
      // Covers every attempt, wait and backoff, so a call never takes longer than its timeout.
      const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

      let response: Response;
      let text: string;
      try {
        ({ response, text } = await send(limiter, route, combined, () =>
          fetch(url, { method, headers: { ...headers }, body: payload, signal: combined }),
        ));
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof PrintifyApiError) throw error;
        if (timeout.aborted) throw timeoutError(route, timeoutMs);
        throw networkError(route, error);
      }

      if (!response.ok) {
        const secrets = [token, ...addressValues(body)];
        throw httpError(
          route,
          response.status,
          parseJson(text),
          response.headers.get('x-pfy-correlation-id'),
          (value) => redactValues(value, secrets),
        );
      }
      if (text.trim() === '') return undefined;
      // Parsed whatever the Content-Type says: openapi.json labels some v2 JSON octet-stream.
      const json = parseJson(text);
      if (json === undefined) {
        throw invalidResponseError(route, response.status, 'a body that is not JSON');
      }
      return json.value;
    },
  };
}

interface Received {
  response: Response;
  text: string;
}

/**
 * Sends a request up to `MAX_ATTEMPTS` times, taking a rate-limit slot before each attempt.
 * Resolves to the last response with its body read, or rejects with the last error. An abort, and
 * a `PrintifyApiError` such as the limiter's fail-fast error, end it at once.
 */
async function send(
  limiter: RateLimiter,
  route: Route,
  signal: AbortSignal,
  sendOnce: () => Promise<Response>,
): Promise<Received> {
  for (let attempt = 1; ; attempt += 1) {
    await limiter.acquire(route, signal);
    let received: Received | undefined;
    let failure: unknown;
    try {
      const response = await sendOnce();
      // The signal covers the body too, so a stalled download still ends on time. Reading every
      // body in full also frees the connection of a response that is retried.
      received = { response, text: await response.text() };
    } catch (error) {
      if (signal.aborted || error instanceof PrintifyApiError) throw error;
      failure = error;
    }
    const outcome: Outcome =
      received === undefined ? 'network' : { status: received.response.status };
    if (attempt < MAX_ATTEMPTS && shouldRetry(route.method, outcome)) {
      const delay = retryDelayMs(attempt, received?.response.headers.get('retry-after') ?? null);
      if (delay <= MAX_WAIT_MS) {
        await sleep(delay, signal);
        continue;
      }
    }
    if (received === undefined) throw failure;
    return received;
  }
}

/** Concatenates rather than using `new URL(path, base)`, which would drop a proxy path prefix. */
function buildUrl(baseUrl: string, path: ApiPath, query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.append(key, String(value));
  }
  const search = params.toString();
  return search === '' ? `${baseUrl}${path}` : `${baseUrl}${path}?${search}`;
}

/** Every string under an `address_to` key in a request body, at any depth. */
function addressValues(value: unknown, inAddress = false): string[] {
  if (typeof value === 'string') return inAddress ? [value] : [];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    addressValues(item, inAddress || key === 'address_to'),
  );
}
```

Compared with the #3 version, only these parts change: the three new imports, the `fetch` doc
comment, the `request` and `createPrintifyClient` doc comments, `const limiter`, `url` and
`combined` in `request()`, the call to `send()` inside the `try`, and the new `Received` and
`send`. The `catch` block, the response handling, `buildUrl` and `addressValues` are unchanged.

How the failures map, so a reviewer can check the loop against the spec:

- The limiter's fail-fast error and a `PrintifyApiError` from `fetch` leave `send()` at once and
  are re-thrown unchanged by the existing `catch`.
- A timeout or caller abort (during a slot wait, a request, a body read or a backoff) leaves
  `send()` at once. The existing `catch` then re-throws the caller's reason, or builds the timeout
  error.
- Any other rejection from `fetch` or `response.text()` is a network outcome. When it is not
  retried, `send()` throws it and the existing `catch` turns it into a network error with that
  error as `cause`.
- A response that is not retried is returned with its body already read; the code after the `try`
  handles it exactly as before.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/printify/client.test.ts`
Expected: `Tests  36 passed (36)`.

Run: `npm run typecheck && npm run lint && npm test`
Expected: no type or lint errors; `Tests  287 passed (287)`, in well under a second of test time
(no test waits on a real backoff).

- [ ] **Step 5: Commit**

```bash
git add src/printify/client.ts test/printify/client.test.ts
git commit -F - <<'EOF'
Retry and rate-limit every Printify request

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Clean verification, pull request and follow-up comments

**Files:** none.

- [ ] **Step 1: Verify from a clean install**

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: every command exits 0; `Test Files  14 passed (14)` and `Tests  287 passed (287)`;
`dist/printify/rate-limit.js`, `dist/printify/retry.js` and `dist/printify/sleep.js` exist.

- [ ] **Step 2: Check the commit trailers**

Run: `git log --format='%h %s | %(trailers:only,unfold)' origin/main..HEAD`

Expected: every commit ends with
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and no other
`Co-Authored-By` line. Fix any other trailer before pushing.

- [ ] **Step 3: Push and open the pull request**

```bash
git push -u origin feat/4-rate-limit-retry
gh pr create --base main --title "Client-side rate limiting and retry policy" --body-file - <<'EOF'
Closes #4

## Summary

- **Rate limits:** every request takes a slot in rolling windows for Printify's limits: 600/min
  for everything, 100/min for `/v1/catalog/…` and `/v2/catalog/…`, and 200 per 30 minutes for
  `…/publish.json`. Rolling windows, not token buckets, so no window of our own traffic exceeds a
  limit (a full token bucket would allow about twice the limit in the first window).
- **Fail fast:** a request queues for up to 10 s. A longer wait sends nothing and throws a
  `PrintifyApiError` with status 429 and the new `retryAfterSeconds`, e.g. "POST …/publish.json was
  not sent: the limit of 200 publish requests per 30 minutes is used up. Retry in 14 minutes". The
  429 hint uses the same wait.
- **Retries:** at most 3 attempts. 429 is retried for every method; 502, 503 and network errors
  (including a body that fails midway) only for GET, PUT and DELETE. `Retry-After` is honoured
  (seconds or HTTP date); otherwise backoff is 0.5–1 s, then 1–2 s. A delay over 10 s is not
  retried. Timeouts, caller aborts and every other status are never retried.
- The policy runs inside `request()`, below nothing but the injected `fetch`, so it knows the
  `ApiPath` and the whole attempt. Limits are per client, and so per process.

Spec: `docs/superpowers/specs/2026-09-18-rate-limit-retry-design.md`
Plan: `docs/superpowers/plans/2026-09-18-rate-limit-retry.md`

## Test plan

- [x] `npm run lint`, `npm run typecheck`, `npm test` (287 tests), `npm run build`
- [x] Fake-timer tests cover the rolling-window refill, fail-fast (seconds and minutes), abort while
      waiting, `Retry-After`, and no retry for POST on 502
- [ ] CI green on Node 22 and 24

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 4: Move the issue to In review and watch CI**

```bash
~/.claude/skills/updating-github-project-status/board.sh review
gh pr checks --watch
```

Expected: the board script prints a line moving #4 to In review; every check passes. If a check
fails, read its log with `gh run view --log-failed`, fix the cause, commit and push again.

- [ ] **Step 5: Hand-off comments on #5 and #6**

```bash
gh issue comment 5 --body-file - <<'EOF'
Notes from the #4 implementation (rate limiting and retries):
- `PrintifyApiError` has a new field, `retryAfterSeconds`. Only the client's own rate limiter sets it, on a 429 that was **never sent** to Printify (e.g. the publishing limit of 200 per 30 minutes is used up). Show it in the `isError` result next to `status` and `hint`; the hint already names the wait ("Wait 14 minutes before trying again.").
- A 429 without `retryAfterSeconds` came from Printify after up to 3 attempts.
- Retries happen inside `client.request()`, so a tool call can take a few seconds longer, but never longer than its timeout (30 s by default). A caller abort still re-throws the caller's reason unchanged.
EOF
gh issue comment 6 --body-file - <<'EOF'
Notes from the #4 implementation (rate limiting and retries):
- The client now retries a 429 for every method, and 502, 503 and network errors (including a rejected fake `fetch`) for GET, PUT and DELETE, with real backoff of up to 3 s. Tests of those cases need `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync(3_000)`, or they slow down; 400, 404, 409 and 500 are never retried.
- Every client has its own rate limiter, so each `createTestServer` starts with empty buckets. Fake timers also fake `performance.now()`, which the limiter uses.
- `test/printify/client.test.ts` has an `inTurn(...responders)` helper that answers the nth request with the nth responder.
EOF
```

---

## Summary

| Task | Commit                                                 | Tests after |
| ---- | ------------------------------------------------------ | ----------- |
| 1    | Add retryAfterSeconds and a hint for rate-limit waits  | 216         |
| 2    | Add the rolling-window rate limiter                    | 236         |
| 3    | Add the retry policy for Printify requests             | 275         |
| 4    | Retry and rate-limit every Printify request            | 287         |
| 5    | (no commit) verification, PR, board, hand-off comments | 287         |

Tasks 1 and 3 are independent of each other. Task 2 needs Task 1, and Task 4 needs Tasks 2 and 3.
