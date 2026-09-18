# Rate limiting and retries — design

- **Issue:** [#4 Client-side rate limiting and retry policy](https://github.com/ARau87/printify-mcp/issues/4)
- **Date:** 2026-09-18
- **Status:** approved

## Goal

Printify limits requests per account, and error responses may not exceed 5% of all requests. An
agent that loops over variants or products can reach these limits quickly and get the account
throttled. The HTTP client from #3 therefore limits its own request rate and retries the failures
that are safe to retry, so that no tool has to think about either.

## API facts this design relies on

Checked on 2026-09-18 against the "API usage guidelines" in the HTML docs at
https://developers.printify.com/.

- **Global:** 600 requests per minute. "Customers exceeding this limit will receive error responses
  with a 429 response code."
- **Catalog:** 100 requests per minute, "in addition to the global limit". Exceeding it gives
  "429 Too Many Requests".
- **Publishing:** "The product publishing endpoint has a limit of 200 requests per 30 minutes."
  Product creation that results from creating an order is not subject to this limit.
- **Scope:** all limits apply "per integration (per account), not per access token".
- **Errors:** "Requests resulting in an error response may not exceed 5% of your total requests."
- **Headers:** no `Retry-After` or `X-RateLimit-*` headers are documented. A probe on 2026-09-18 saw
  none on 401 and 404 responses.
- **Windows:** the docs do not say whether a limit counts in fixed or rolling windows.

## Decisions that differ from the issue and the #3 notes

1. **Rolling windows, not token buckets.** A token bucket that holds 600 tokens and refills at 10
   per second allows 600 requests at once and then 10 per second: up to about 1,200 in the first
   minute. A publish bucket would allow about 400 in the first 30 minutes. A rolling window caps
   every window of our own traffic at the limit. That also keeps us under a fixed-window count,
   whichever scheme Printify uses.
2. **The policy runs inside `request()` and does not wrap the injected `fetch`.** The #3 spec and
   the note on #4 suggested `withRetry(withRateLimit(fetch))`. A `fetch` wrapper sees only the full
   URL string, so to classify a request, and to name its `ApiPath` in the fail-fast error, it would
   have to strip the base URL (which can carry a proxy prefix) and the query. It also returns
   before the client reads the body, so a connection that drops mid-body could not be retried.
   Inside `request()`, the policy has the `ApiPath`, the method and the whole attempt. The
   injected `fetch`, and so the fake from #6, still sits below it.
3. **`PrintifyApiError` gains `retryAfterSeconds`.** The existing 429 hint says "Wait a minute
   before trying again". That is wrong when the publish bucket needs another 14 minutes.
4. **Limits are per process.** Printify counts per account, so two server processes (e.g. one in
   Claude Desktop and one in Claude Code) share a budget that neither can see whole. Each process
   limits only its own requests. Traffic from other processes is covered only by retrying 429
   responses.

## Files

```
src/printify/
  rate-limit.ts            # new: RATE_LIMITS, MAX_WAIT_MS, bucketsFor, createRateLimiter
  retry.ts                 # new: MAX_ATTEMPTS, shouldRetry, parseRetryAfter, retryDelayMs
  sleep.ts                 # new: sleep(ms, signal)
  client.ts                # attempt loop in request(), one limiter per client
  errors.ts                # retryAfterSeconds field
  hints.ts                 # 429 hint with retryAfterSeconds, formatSeconds
test/printify/
  rate-limit.test.ts       # new
  retry.test.ts            # new
  sleep.test.ts            # new
  client.test.ts           # new retry and limit cases, two #3 tests adjusted
  errors.test.ts           # retryAfterSeconds
  hints.test.ts            # new 429 row
```

No new dependencies and no barrel file. `fetchPage` calls `client.request`, so pages get the same
limits and retries without changes.

## Rate limiter

```ts
type Bucket = 'global' | 'catalog' | 'publish';

const RATE_LIMITS: Readonly<Record<Bucket, { limit: number; windowMs: number }>> = {
  global: { limit: 600, windowMs: 60_000 },
  catalog: { limit: 100, windowMs: 60_000 },
  publish: { limit: 200, windowMs: 1_800_000 },
};

/** The longest a request waits for a slot before it fails fast. */
const MAX_WAIT_MS = 10_000;

/** The buckets a request takes a slot in, from its `ApiPath`. Always includes `global`. */
function bucketsFor(path: string): readonly Bucket[];

interface RateLimiter {
  /**
   * Resolves when the request may be sent. Rejects with a `PrintifyApiError` when the wait would
   * exceed `MAX_WAIT_MS`, and with `signal.reason` when `signal` aborts first.
   */
  acquire(route: Route, signal: AbortSignal): Promise<void>;
}

/** A limiter with `RATE_LIMITS` and `MAX_WAIT_MS`. It starts no timers until a request waits. */
function createRateLimiter(): RateLimiter;
```

### Buckets

| Bucket    | Limit              | `ApiPath`                                                 |
| --------- | ------------------ | --------------------------------------------------------- |
| `global`  | 600 per 60 s       | every path                                                |
| `catalog` | 100 per 60 s       | `^/v[12]/catalog/`                                        |
| `publish` | 200 per 30 minutes | `^/v1/shops/[^/]+/products/[^/]+/publish\.json$`, exactly |

A request takes one slot in every bucket it matches: a catalog request takes a `global` and a
`catalog` slot. `unpublish.json`, `publishing_succeeded.json` and `publishing_failed.json` take
only a `global` slot. The method does not matter. Only POST exists for `publish.json`.

### Slots

Each bucket keeps a list of slot times in ascending order. A slot time is when a request was, or
will be, sent.

1. Times at or before `now - windowMs` are dropped. They can no longer affect a new slot.
2. A bucket's next free time is its latest slot time, or `now` if it has none. If it holds `limit`
   times or more, the next free time is also at least `times[length - limit] + windowMs`, which is
   when the oldest of the last `limit` slots leaves the window.
3. The request's slot time `t` is the latest of `now` and the next free time of each of its buckets.
4. If `t - now` exceeds `MAX_WAIT_MS`, the limiter reserves nothing and throws the fail-fast error.
5. Otherwise `t` is appended to each of the request's buckets, and `acquire` sleeps for `t - now`,
   or resolves at once when that is 0.

Slot times never decrease within a bucket, so rule 2 caps every window of `windowMs` at `limit`
slots. Requests leave in the order they arrive. A request that waits for the `catalog` bucket also
holds a future `global` slot, so a plain request that arrives after it waits behind it. That wait
is at most `MAX_WAIT_MS`, because no slot is ever reserved further ahead.

- **Every sent request counts**, whatever its outcome, because Printify counts it too. A slot is
  never given back after the request is sent.
- **Abort:** if `signal` has already aborted, `acquire` rejects with `signal.reason` and reserves
  nothing. If it aborts during the wait, the limiter removes the request's slot time from each of
  its buckets and rejects with `signal.reason`. Requests queued behind it keep their slot times.
  That is safe, just not as early as they could be.
- **Clock:** `performance.now()`. It is monotonic, so a change to the system clock cannot block
  requests or let a burst through. It is not injected: Vitest's fake timers fake it by default,
  together with the `setTimeout` that `sleep` uses, so tests move both with one call.
- **Timeout:** the client's signal combines the timeout and the caller's signal, so a wait counts
  toward the request's timeout. With the default of 30 s and at most 10 s of waiting, that only
  matters for a short per-request `timeoutMs`, which then ends as kind `timeout`.

### Fail-fast error

```ts
new PrintifyApiError(message, { kind: 'http', ...route, status: 429, retryAfterSeconds });
```

- `retryAfterSeconds` is `Math.ceil((t - now) / 1000)`, so it is at least 11.
- The message names the bucket whose next free time set `t`. On a tie, it names `catalog` or
  `publish` rather than `global`:

  ```
  POST /v1/shops/12/products/34/publish.json was not sent: the limit of 200 publish requests per 30 minutes is used up. Retry in 14 minutes
  GET /v2/catalog/blueprints/5/print_providers/9/variants.json was not sent: the limit of 100 catalog requests per minute is used up. Retry in 25 seconds
  GET /v1/shops/12/products.json was not sent: the limit of 600 requests per minute is used up. Retry in 12 seconds
  ```

- The duration comes from `formatSeconds` in `hints.ts`: under 120 seconds it is
  `<seconds> seconds`, otherwise `<Math.ceil(seconds / 60)> minutes`. Inputs are always at least
  11, so there is no singular form.
- `request` re-throws a `PrintifyApiError` unchanged, so #5 treats the fail-fast error like any other 429.

## Sleep

```ts
/** Resolves after `ms`. Rejects with `signal.reason` when `signal` aborts first. */
function sleep(ms: number, signal: AbortSignal): Promise<void>;
```

It uses the global `setTimeout`, which vitest's fake timers control, and not `node:timers/promises`,
which rejects with its own `AbortError`. It clears the timer and removes its abort listener in
either case. If `signal` has already aborted, it rejects at once. The limiter and the retry loop
both use it.

## Retries

```ts
/** Attempts per request, the first included. */
const MAX_ATTEMPTS = 3;

/** What one attempt produced. */
type Outcome = { status: number } | 'network';

function shouldRetry(method: HttpMethod, outcome: Outcome): boolean;

/** Milliseconds from a `Retry-After` value, or `undefined` when it is missing or invalid. */
function parseRetryAfter(header: string | null, nowMs: number): number | undefined;

/** The wait before retry `retry` (1 or 2): `Retry-After` if valid, else backoff. */
function retryDelayMs(retry: number, retryAfter: string | null, random?: () => number): number;
```

### What is retried

| Outcome of an attempt                                                             | GET, PUT, DELETE | POST  |
| --------------------------------------------------------------------------------- | ---------------- | ----- |
| HTTP 429                                                                          | retry            | retry |
| HTTP 502, 503                                                                     | retry            | never |
| `network`: `fetch` rejects, or reading the body fails                             | retry            | never |
| Any other status: 2xx, 3xx, other 4xx, 500, 504                                   | never            | never |
| Timeout or caller abort                                                           | never            | never |
| A `PrintifyApiError`, e.g. the limiter's fail-fast error or one thrown by `fetch` | never            | never |

- A 429 means Printify did not process the request, so retrying is safe for every method.
- A 502, a 503 or a network error may come after Printify has processed the request. A POST such as
  an order creation is therefore never retried after one.
- A 500 usually repeats, and a retry would only use up the error budget. A 504 would arrive after
  the client's own 30 s timeout has fired, so it is not retried either.
- Other 4xx responses are never retried: they would fail again and use up the error budget.
- **Known quirk:** a DELETE whose first attempt reached Printify but lost its response can get a 404
  on the retry, because the resource is already gone. The model then sees "Not found". This is
  accepted.

### Delay

- **`Retry-After`:** a value of digits only is that many seconds, 0 included. A value that starts
  with a day name (`Mon` to `Sun`, as all three HTTP date formats in RFC 9110 do) is read with
  `Date.parse`. A valid date gives the time until it, or 0 for a date in the past. Surrounding
  whitespace is ignored. Anything else, e.g. `-5`, `1.5` or `soon`, is invalid and falls back to
  backoff. The day-name check is needed because V8's `Date.parse` reads `-5` and `1.5` as dates.
  `retryDelayMs` passes `Date.now()`, the wall clock an HTTP date needs.
- **Backoff:** `1000 × 2^(retry - 1) × (0.5 + random() × 0.5)`, with `random` defaulting to
  `Math.random`. That is 0.5–1 s before the second attempt and 1–2 s before the third.
- **Too long:** if the delay exceeds `MAX_WAIT_MS` (e.g. `Retry-After: 120`), there is no retry.
  The last outcome is reported as it is.

## Client

`createPrintifyClient` creates one limiter with `createRateLimiter()`. That starts no timers, so
the client still has no side effects until the first request, and the probe instance of
`serveStdio` stays harmless. `PrintifyClientOptions` does not change.

`request()`:

1. The GET-body check, the JSON serialisation and the timeout signal are unchanged. The signal
   passed below is the timeout signal combined with the caller's signal, as today.
2. For attempt 1 to `MAX_ATTEMPTS`:
   1. `await limiter.acquire(route, signal)`.
   2. `fetch(url, init)`, then `response.text()`, exactly as today. `init.headers` is still a fresh
      copy for each attempt.
   3. If `fetch` or the body read rejects, and the signal has aborted or the rejection is a
      `PrintifyApiError`, it is re-thrown at once.
   4. The outcome is the status, or `'network'` for any other rejection. If this was the last
      attempt, `shouldRetry` says no, or `retryDelayMs` exceeds `MAX_WAIT_MS`, the loop ends.
   5. Otherwise `await sleep(delay, signal)`, and the next attempt starts.
3. A network outcome is re-thrown, and the existing `catch`, which wraps the whole loop, maps
   it. Its order is unchanged: caller abort, then `PrintifyApiError`, then timeout, then network.
   The last attempt's error becomes the network error's `cause`.
4. A response is handled exactly as today.

If `acquire` fails fast on a retry attempt, its error is thrown instead of the earlier outcome: it
says when to try again. Every attempt reads its body in full, so a discarded response never holds a connection open. The
signal covers every attempt, every wait for a slot and every backoff, so one call never takes longer
than its timeout.

## Errors and hints

- `PrintifyErrorFields` and `PrintifyApiError` gain `retryAfterSeconds: number | undefined`. Only the
  limiter's fail-fast error sets it. A server 429 leaves it `undefined`, because Printify sends no
  `Retry-After`.
- `HintInput` gains `retryAfterSeconds`. A new row goes before the existing 429 row:

  | Match                           | Hint                                                                                                       |
  | ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
  | HTTP 429 with retryAfterSeconds | Printify's rate limit is used up, so the request was not sent. Wait `<formatSeconds>` before trying again. |
  | HTTP 429                        | Printify's rate limit was reached. Wait a minute before trying again. (unchanged)                          |

- `hints.ts` exports `formatSeconds(seconds: number): string` for the hint and the fail-fast
  message. `rate-limit.ts` imports it from `hints.ts`, and `errors.ts` does not import
  `rate-limit.ts`, so there is no cycle.

## Tests

All tests run under `npm test`. None needs the network or a Printify account. Tests that wait use
`vi.useFakeTimers()`, which fakes `setTimeout`, `Date` and `performance.now()`, and they advance
with `vi.advanceTimersByTimeAsync`.

### `test/printify/rate-limit.test.ts`

- **Buckets:** v1 and v2 catalog paths give `global` and `catalog`; `publish.json` gives `global`
  and `publish`; `unpublish.json`, `publishing_succeeded.json` and a product path give only
  `global`.
- **Rolling window, refill:** 600 plain requests at 0 s resolve at once. At 55 s the 601st waits
  5 s and resolves at 60 s, when the first slots leave the window. With 300 requests at 0 s and
  300 at 30 s, 300 more resolve at once at 60 s, and the next one fails fast with
  `retryAfterSeconds: 30`: there is no refill burst.
- **Order:** waiting requests resolve in arrival order. A plain request that arrives after a waiting
  catalog request resolves no earlier than it.
- **Fail-fast:** after 100 catalog requests at 0 s, the 101st rejects with status 429,
  `retryAfterSeconds: 60`, the catalog message, and no slot reserved. At 50 s the 101st waits
  exactly 10 s and resolves. After 200 publish requests, the next one fails fast in minutes.
- **Abort:** an already aborted signal rejects with its reason and reserves nothing; an abort during
  the wait rejects with its reason and frees the slot.

### `test/printify/retry.test.ts`

- Every row of the retry table, method by method, including **no retry for POST on 502**.
- `parseRetryAfter`: `"5"`, `" 0 "`, an HTTP date in the future and in the past, and the invalid
  values `-5`, `1.5`, `soon`, `Sunday, maybe` and an empty string.
- `retryDelayMs`: backoff with `random` returning 0 and just under 1, for retry 1 and 2;
  `Retry-After` wins over backoff.

### `test/printify/sleep.test.ts`

Resolves after the delay and not before; rejects with the signal's reason on an abort during the
wait and at once for an already aborted signal; leaves no pending timer after an abort.

### `test/printify/client.test.ts`

- **429, then 200:** resolves after 2 requests.
- **`Retry-After`:** after a 429 with `Retry-After: 5`, the retry is not sent at 4.9 s and is sent
  at 5 s. With `Retry-After: 120`, there is no retry and the 429 error is thrown.
- **502:** a GET that gets 502 three times sends 3 requests and throws the 502 error; **a POST that
  gets 502 sends exactly 1 request**.
- **Network:** a GET whose `fetch` rejects is retried; a POST is not. A GET whose body read fails
  once is retried and resolves.
- **Fail-fast through the client:** the 101st catalog GET rejects with the fail-fast error and does
  not call `fetch`.
- **Abort and timeout during backoff:** a caller abort re-throws its reason and sends nothing more.
  A timeout gives kind `timeout`. The timeout test uses real timers and a 20 ms timeout, because
  `AbortSignal.timeout` does not follow fake timers.
- **Adjusted #3 tests:** the HTML 502 test and the rejected-`fetch` test use GET, so they now run
  with fake timers and expect 3 attempts. Their messages and fields are unchanged.

### `test/printify/hints.test.ts` and `test/printify/errors.test.ts`

The new 429 row with `retryAfterSeconds` in seconds and in minutes; the existing 429 row without it;
the constructor stores `retryAfterSeconds`.

## Acceptance criteria mapping

| Criterion (issue #4)                                                                                    | Covered by                                              |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Unit tests with fake timers cover bucket refill, fail-fast, `Retry-After`, and no retry for POST on 502 | `rate-limit.test.ts`, `retry.test.ts`, `client.test.ts` |

The issue's other requirements:

| Requirement                                                           | Covered by                                   |
| --------------------------------------------------------------------- | -------------------------------------------- |
| Global 600/min, catalog 100/min, publish 200/30 min                   | `RATE_LIMITS`, `bucketsFor`, rolling windows |
| Requests queue for a free slot; fail fast when the wait exceeds ~10 s | `acquire`, `MAX_WAIT_MS`, fail-fast error    |
| Exponential backoff with jitter, max 3 attempts, honour `Retry-After` | `retryDelayMs`, `MAX_ATTEMPTS`               |
| 429 retried for any method; 502/503/network only for GET, PUT, DELETE | `shouldRetry`                                |
| Other 4xx never retried                                               | `shouldRetry`                                |

## Out of scope

| Topic                                                  | Why                                     |
| ------------------------------------------------------ | --------------------------------------- |
| Coordinating limits between server processes           | Decided: per process only               |
| Pausing buckets after a server 429                     | Not planned; retries cover it           |
| Environment variables for limits, attempts or waits    | Not planned, like the timeout           |
| Retrying 500 or 504                                    | See "What is retried"                   |
| A per-request "safe to retry" opt-in for POST          | Not planned                             |
| `retryAfterSeconds` from a server `Retry-After` header | Printify sends none                     |
| Logging of waits and retries                           | Not planned, like request logging in #3 |

## Delivery

1. Branch `feat/4-rate-limit-retry` from `origin/main`. This spec is its first commit.
2. Implementation plan via the writing-plans skill, then test-first implementation.
3. Local verification before any claim of success: `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test` and `npm run build`.
4. PR with `Closes #4`, moved to In review on the project board. Watch its CI run on Node 22 and 24.
5. Comment on the issues that build on this:
   - #5: show `retryAfterSeconds` in the `isError` result when it is set. A 429 with it set was
     never sent to Printify.
   - #6: a route that answers 429, 502 or 503, or a GET whose `fetch` rejects, now makes the client
     retry with real delays of up to 3 s. Tests of those cases need `vi.useFakeTimers()`.
