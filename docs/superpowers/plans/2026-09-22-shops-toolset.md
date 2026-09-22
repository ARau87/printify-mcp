# Shops Toolset Implementation Plan

> **On hold until #6 merges (decided 2026-09-22).** Do not execute this version. Once #6's test
> harness is on `main`, rebase `feat/7-shops` and revise the plan and spec. Move the tests onto
> `createTestServer` and `test/fixtures/shops.ts`. Drop `json`, `jsonFetch`, the fixture config
> overrides and the `test/server.test.ts` change. Give `createTestServer`'s services `shops`, and
> add the "Adding a tool" section to `CONTRIBUTING.md`. The `src/` code stays as planned.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shop-scoped tools get their shop id without a lookup call: from `shop_id`, else
`PRINTIFY_SHOP_ID`, else the account's only shop, else a `ToolError` that lists the shops. The
`shops` toolset adds `list_shops` and the `destructive`-gated `disconnect_shop`, and `ALL_TOOLS`
is composed from a record keyed by toolset.

**Architecture:** `src/printify/shops.ts` is the process's shop directory: it fetches and
validates `GET /v1/shops.json` and caches the list until `invalidate()`. `cli.ts` creates it once,
next to the one Printify client, and passes it to every tool as `ctx.shops`.
`src/tools/shop-id.ts` holds the shared `shop_id` input field and `resolveShopId`, which every
shop-scoped tool in #8–#19 calls first. `src/tools/shops.ts` defines the two tools, and
`src/tools/index.ts` derives `ALL_TOOLS` from `TOOLS_BY_TOOLSET` in `TOOLSETS` order.

**Tech Stack:** Node >= 22, TypeScript ~6.0.3, `@modelcontextprotocol/server` 2.0.0, zod 4.6.5,
Vitest 5, ESLint 10 with typescript-eslint 8 `strictTypeChecked`, Prettier 3.

**Spec:** `docs/superpowers/specs/2026-09-22-shops-toolset-design.md`. Read it before starting.
This plan implements it. The one deliberate difference: `Shop` is `z.output` of its zod schema,
so `title` and `sales_channel` are optional keys (`title?: string | undefined`) rather than
required keys that may be `undefined`.

## Global Constraints

- Branch: `feat/7-shops` (already exists, with the spec and this plan committed on it). Never
  commit to `main`. The branch has no upstream yet; Task 4 pushes it with `-u`.
- No new dependencies. `package.json` and `package-lock.json` do not change.
- `"type": "module"` and NodeNext: relative imports use the `.js` suffix, including in tests.
- Nothing in `src/` may use `console.*` (ESLint `no-console`).
- Per-process state lives in `ToolServices`, which `cli.ts` creates once. Never create the shop
  directory inside `createServer` (it can run twice per process) or in module scope.
- Every tool input is a `z.strictObject`. The catalog test (`toolProblems`) enforces the tool
  rules, e.g. `gate: 'destructive'` needs `destructiveHint: true`.
- Tool names, descriptions, `ToolError` messages and hints, and error messages are part of the
  interface. Tests assert them exactly, so copy them verbatim from this plan.
- Tests that must send no request pass a `jsonFetch` fake and assert
  `expect(fetch).not.toHaveBeenCalled()`. Never rely on the default `unexpectedFetch`: its failure
  surfaces as "could not reach Printify" (#6 fixes that).
- Lint is typescript-eslint `strictTypeChecked`. No non-null assertions (`!`). Numbers in template
  literals must be wrapped in `String(…)`. Reuse `rejection` and `apiError` from
  `test/printify/helpers.ts` for promises that must reject.
- Prettier: `singleQuote: true`, `printWidth: 100`. Every file must pass `prettier --check`. The
  code in this plan is already Prettier-formatted.
- Commit messages use this repo's style: a short imperative sentence with no conventional-commit
  prefix, a blank line, then exactly this trailer, whatever model writes the commit:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Everything below was prototyped on 2026-09-22 with Node 24.13.1, Vitest 5.0.1, TypeScript 6.0.3,
  `@modelcontextprotocol/server` 2.0.0 and zod 4.6.5, then replayed task by task in a fresh
  worktree: every task ends with lint, typecheck and Prettier clean. The expected outputs come from
  those runs. The suite has 354 tests in 20 files before Task 1.

## File Map

| File                          | Responsibility                                                       | Task |
| ----------------------------- | -------------------------------------------------------------------- | ---- |
| `src/printify/shops.ts`       | `Shop`, `ShopDirectory`, `createShopDirectory`: the shop cache       | 1    |
| `src/printify/errors.ts`      | `invalidResponseError` gains the problem `'an unexpected shop list'` | 1    |
| `test/printify/shops.test.ts` | Caching, refresh, invalidate, the stale-fetch race, validation       | 1    |
| `src/tools/define.ts`         | `ToolServices` gains `shops: ShopDirectory`                          | 2    |
| `src/cli.ts`                  | Creates the shop directory once per process                          | 2    |
| `test/tools/fixtures.ts`      | `json`, `jsonFetch`, services with `shops`, config overrides         | 2    |
| `test/server.test.ts`         | Uses `jsonFetch` instead of its local `fakeFetch`                    | 2    |
| `test/cli.test.ts`            | One shop directory however many servers the factory builds           | 2    |
| `src/tools/shop-id.ts`        | `shopIdInput`, `resolveShopId`                                       | 2    |
| `test/tools/shop-id.test.ts`  | The four resolution branches, no shops, cancellation                 | 2    |
| `src/tools/shops.ts`          | `list_shops`, `disconnect_shop`, `shopsTools`                        | 3    |
| `src/tools/index.ts`          | `TOOLS_BY_TOOLSET`; `ALL_TOOLS` derived from it                      | 3    |
| `test/tools/shops.test.ts`    | Both tools, gating through `ALL_TOOLS`, end to end over MCP          | 3    |
| `test/tools/catalog.test.ts`  | Every tool is filed under its own toolset                            | 3    |

---

### Task 1: Cache the account's shops once per process

**Files:**

- Create: `src/printify/shops.ts`
- Modify: `src/printify/errors.ts` (the `problem` parameter of `invalidResponseError`)
- Test: `test/printify/shops.test.ts`

**Interfaces:**

- Consumes: `PrintifyClient` (`request(method, path, { signal })`) from `src/printify/client.ts`,
  `invalidResponseError(route, status, problem)` from `src/printify/errors.ts`, and `apiPath`
  from `src/printify/path.ts`.
- Produces, in `src/printify/shops.ts`:
  - `type Shop = { id: number; title?: string | undefined; sales_channel?: string | undefined }`
    (declared as `z.output<typeof shopSchema>`)
  - `interface ShopDirectory { list(signal: AbortSignal): Promise<readonly Shop[]>; refresh(signal: AbortSignal): Promise<readonly Shop[]>; invalidate(): void }`
  - `createShopDirectory(client: PrintifyClient): ShopDirectory`

  Task 2 puts the directory into `ToolServices`; Tasks 2 and 3 call `list`, `refresh` and
  `invalidate`.

- [ ] **Step 1: Write the failing test**

Create `test/printify/shops.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { PrintifyClient } from '../../src/printify/client.js';
import { httpError } from '../../src/printify/errors.js';
import { createShopDirectory } from '../../src/printify/shops.js';
import { apiError, rejection } from './helpers.js';

// The documented GET /v1/shops.json example.
const SHOPS = [
  { id: 5432, title: 'My new store', sales_channel: 'My Sales Channel' },
  { id: 9876, title: 'My other new store', sales_channel: 'disconnected' },
];

const signal = new AbortController().signal;

/** A client whose nth request resolves to the nth answer, or rejects with it if it is an Error. */
function clientAnswering(...answers: unknown[]) {
  const request = vi.fn<PrintifyClient['request']>(() => {
    const answer = answers.shift();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  return { client: { request } satisfies PrintifyClient, request };
}

describe('createShopDirectory', () => {
  it('fetches the shops on the first list, with the caller signal', async () => {
    const { client, request } = clientAnswering(SHOPS);
    expect(await createShopDirectory(client).list(signal)).toEqual(SHOPS);
    expect(request).toHaveBeenCalledWith('GET', '/v1/shops.json', { signal });
  });

  it('answers a second list from the cache', async () => {
    const { client, request } = clientAnswering(SHOPS);
    const shops = createShopDirectory(client);
    await shops.list(signal);
    expect(await shops.list(signal)).toEqual(SHOPS);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fetches again on refresh and caches what it got', async () => {
    const { client, request } = clientAnswering(SHOPS, SHOPS.slice(0, 1));
    const shops = createShopDirectory(client);
    await shops.list(signal);
    expect(await shops.refresh(signal)).toEqual(SHOPS.slice(0, 1));
    expect(await shops.list(signal)).toEqual(SHOPS.slice(0, 1));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fetches again after invalidate', async () => {
    const { client, request } = clientAnswering(SHOPS, SHOPS.slice(1));
    const shops = createShopDirectory(client);
    await shops.list(signal);
    shops.invalidate();
    expect(await shops.list(signal)).toEqual(SHOPS.slice(1));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed fetch', async () => {
    const error = httpError({ method: 'GET', path: '/v1/shops.json' }, 500, undefined, null);
    const { client, request } = clientAnswering(error, SHOPS);
    const shops = createShopDirectory(client);
    expect(await rejection(shops.list(signal))).toBe(error);
    expect(await shops.list(signal)).toEqual(SHOPS);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('returns, but does not cache, a list that arrives after invalidate', async () => {
    let release: (body: unknown) => void = () => undefined;
    const request = vi
      .fn<PrintifyClient['request']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(SHOPS.slice(1));
    const shops = createShopDirectory({ request });
    const pending = shops.list(signal);
    shops.invalidate();
    release(SHOPS);
    expect(await pending).toEqual(SHOPS);
    expect(await shops.list(signal)).toEqual(SHOPS.slice(1));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an object', { data: SHOPS }],
    ['an empty body', undefined],
    ['a shop without an id', [{ title: 'My new store' }]],
    ['a shop whose id is a string', [{ id: '5432', title: 'My new store' }]],
  ])('rejects %s as an invalid response', async (_, body) => {
    const { client } = clientAnswering(body);
    const error = await apiError(createShopDirectory(client).list(signal));
    expect(error).toMatchObject({ kind: 'invalid_response', status: 200 });
    expect(error.message).toBe('GET /v1/shops.json returned HTTP 200 with an unexpected shop list');
  });

  it('keeps a shop with an odd title or sales channel, and drops unknown keys', async () => {
    const { client } = clientAnswering([
      { id: 5432, title: null, sales_channel: 7, created_at: '2026-09-22' },
    ]);
    expect(await createShopDirectory(client).list(signal)).toEqual([{ id: 5432 }]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/printify/shops.test.ts`

Expected: FAIL with `Error: Cannot find module '../../src/printify/shops.js'`.

- [ ] **Step 3: Allow the new problem in `invalidResponseError`**

In `src/printify/errors.ts`, replace the `problem` parameter of `invalidResponseError`:

<!-- prettier-ignore -->
```ts
  problem: 'a body that is not JSON' | 'an unexpected pagination envelope',
```

with (this is how Prettier wraps it):

<!-- prettier-ignore -->
```ts
  problem:
    'a body that is not JSON' | 'an unexpected pagination envelope' | 'an unexpected shop list',
```

- [ ] **Step 4: Write the shop directory**

Create `src/printify/shops.ts`:

```ts
import { z } from 'zod';
import type { PrintifyClient } from './client.js';
import { invalidResponseError } from './errors.js';
import { apiPath } from './path.js';

const SHOPS_PATH = apiPath`/v1/shops.json`;

// Lenient except for the id, so one odd shop cannot break shop resolution for all of them.
const shopSchema = z.object({
  id: z.number().int(),
  title: z.string().optional().catch(undefined),
  sales_channel: z.string().optional().catch(undefined),
});
const shopListSchema = z.array(shopSchema);

/** A shop as `GET /v1/shops.json` lists it. `sales_channel` is "disconnected" when none is. */
export type Shop = z.output<typeof shopSchema>;

export interface ShopDirectory {
  /** The account's shops: fetched on first use, then cached until `invalidate`. */
  list(signal: AbortSignal): Promise<readonly Shop[]>;
  /** Fetches the shops again and replaces the cache. */
  refresh(signal: AbortSignal): Promise<readonly Shop[]>;
  /** Drops the cache, e.g. after a shop is disconnected. */
  invalidate(): void;
}

/**
 * Creates the process's shop list cache. Only a successful fetch is cached. Concurrent misses
 * each send a request rather than share one, so one caller's abort cannot fail another's call.
 */
export function createShopDirectory(client: PrintifyClient): ShopDirectory {
  let cached: readonly Shop[] | undefined;
  // Bumped by invalidate, so a fetch that started before it cannot cache what it got.
  let generation = 0;

  async function fetchShops(signal: AbortSignal): Promise<readonly Shop[]> {
    const started = generation;
    const body = await client.request('GET', SHOPS_PATH, { signal });
    const parsed = shopListSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidResponseError(
        { method: 'GET', path: SHOPS_PATH },
        200,
        'an unexpected shop list',
      );
    }
    if (generation === started) cached = parsed.data;
    return parsed.data;
  }

  return {
    list: (signal) => (cached === undefined ? fetchShops(signal) : Promise.resolve(cached)),
    refresh: fetchShops,
    invalidate: () => {
      cached = undefined;
      generation += 1;
    },
  };
}
```

- [ ] **Step 5: Run the tests and every check**

```bash
npx vitest run test/printify/shops.test.ts
npm test
npm run typecheck
npm run lint
```

Expected: `Tests  11 passed (11)` for the file; the full suite shows `Test Files  21 passed (21)`
and `Tests  365 passed (365)`; typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/printify/shops.ts src/printify/errors.ts test/printify/shops.test.ts
git commit -F - <<'EOF'
Cache the account's shops once per process

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Resolve the shop id from the input, PRINTIFY_SHOP_ID or the only shop

**Files:**

- Modify: `src/tools/define.ts` (`ToolServices`), `src/cli.ts` (the services)
- Modify: `test/tools/fixtures.ts`, `test/server.test.ts`, `test/cli.test.ts`
- Create: `src/tools/shop-id.ts`
- Test: `test/tools/shop-id.test.ts`

**Interfaces:**

- Consumes, from Task 1: `ShopDirectory`, `Shop` and `createShopDirectory(client)` from
  `src/printify/shops.ts`. From `src/tools/define.ts`: `ToolContext`, `ToolError`.
- Produces:
  - `ToolServices` gains `shops: ShopDirectory`, so every `ToolContext` has `ctx.shops`.
  - In `src/tools/shop-id.ts`: `shopIdInput` (an object with one key, `shop_id`: an optional
    positive integer) and
    `resolveShopId(input: { shop_id?: number | undefined }, ctx: ToolContext): Promise<number>`.
  - In `test/tools/fixtures.ts`: `json(body: unknown, status = 200): Response`,
    `jsonFetch(body: unknown, status = 200)` (a `vi.fn` fetch answering every request with that
    JSON), `fixtureServices(fetch?, overrides?: Partial<Config>)`, and
    `fixtureContext({ fetch?, signal?, config?: Partial<Config> })`. Task 3 uses all of them.

- [ ] **Step 1: Write the failing CLI test**

In `test/cli.test.ts`, add the import after the `createPrintifyClient` import:

```ts
import { createShopDirectory } from '../src/printify/shops.js';
```

Replace the mock block at the top:

```ts
// ALL_TOOLS is empty until the first toolset lands. The tests below fill this stand-in.
const allTools = vi.hoisted((): Tool[] => []);
vi.mock('../src/tools/index.js', () => ({ ALL_TOOLS: allTools }));
// Spies on createPrintifyClient while keeping the real implementation.
vi.mock('../src/printify/client.js', { spy: true });
```

with:

```ts
// The tests below fill this stand-in for ALL_TOOLS with fixture tools.
const allTools = vi.hoisted((): Tool[] => []);
vi.mock('../src/tools/index.js', () => ({ ALL_TOOLS: allTools }));
// Spies on createPrintifyClient and createShopDirectory while keeping the real implementations.
vi.mock('../src/printify/client.js', { spy: true });
vi.mock('../src/printify/shops.js', { spy: true });
```

Replace the one-client test:

<!-- prettier-ignore -->
```ts
    it('creates one client however many servers the factory builds', () => {
      vi.mocked(createPrintifyClient).mockClear();
      const { io, served } = fakeIo();
      main([], env, io);
      const call = served[0];
      if (call === undefined) throw new Error('serve was not called');
      const [factory] = call;
      expect(factory()).not.toBe(factory());
      expect(createPrintifyClient).toHaveBeenCalledTimes(1);
    });
```

with:

<!-- prettier-ignore -->
```ts
    it('creates one client and one shop cache however many servers the factory builds', () => {
      vi.mocked(createPrintifyClient).mockClear();
      vi.mocked(createShopDirectory).mockClear();
      const { io, served } = fakeIo();
      main([], env, io);
      const call = served[0];
      if (call === undefined) throw new Error('serve was not called');
      const [factory] = call;
      expect(factory()).not.toBe(factory());
      expect(createPrintifyClient).toHaveBeenCalledTimes(1);
      expect(createShopDirectory).toHaveBeenCalledTimes(1);
    });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/cli.test.ts`

Expected: FAIL in `creates one client and one shop cache however many servers the factory builds`
with `AssertionError: expected "vi.fn()" to be called 1 times, but got 0 times` (the spy on
`createShopDirectory`).

- [ ] **Step 3: Give every tool call the shop directory**

In `src/tools/define.ts`, add the import after the `PrintifyClient` import:

```ts
import type { ShopDirectory } from '../printify/shops.js';
```

and give `ToolServices` its fourth member:

```ts
/** Created once per process and shared by every tool call. */
export interface ToolServices {
  client: PrintifyClient;
  config: Config;
  log: Logger;
  /** The account's shops, cached for the process. */
  shops: ShopDirectory;
}
```

In `src/cli.ts`, add the import after the `createPrintifyClient` import:

```ts
import { createShopDirectory } from './printify/shops.js';
```

and in `main`, replace:

<!-- prettier-ignore -->
```ts
  // Everything below happens once per process, however often serve calls the factory: one
  // client, and so one rate limiter, for every server instance.
```

<!-- prettier-ignore -->
```ts
  const services: ToolServices = { client, config, log };
```

with:

<!-- prettier-ignore -->
```ts
  // Everything below happens once per process, however often serve calls the factory: one
  // client (and so one rate limiter) and one shop cache for every server instance.
```

<!-- prettier-ignore -->
```ts
  const services: ToolServices = { client, config, log, shops: createShopDirectory(client) };
```

In `test/tools/fixtures.ts`, add two imports, so the top reads:

```ts
import { vi } from 'vitest';
import { z } from 'zod';
import { loadConfig, type Config } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { createPrintifyClient } from '../../src/printify/client.js';
import { createShopDirectory } from '../../src/printify/shops.js';
```

Then replace everything from `/** Services whose client uses …` to the end of the file (the old
`fixtureServices` and `fixtureContext`) with:

```ts
/** A JSON response, as Printify sends it. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fake `fetch` that answers every request with `body` as JSON. */
export function jsonFetch(body: unknown, status = 200) {
  return vi.fn<typeof globalThis.fetch>(() => Promise.resolve(json(body, status)));
}

/**
 * Services whose client uses `fetch`, whose shop directory uses that client, and whose log lines
 * land in `logged`. `overrides` change the fixture configuration, e.g. `{ shopId: 12 }`.
 */
export function fixtureServices(
  fetch: typeof globalThis.fetch = unexpectedFetch,
  overrides: Partial<Config> = {},
) {
  const logged: string[] = [];
  const config = fixtureConfig(overrides);
  const client = createPrintifyClient({ token: config.token, baseUrl: config.apiBaseUrl, fetch });
  const services: ToolServices = {
    client,
    config,
    log: createLogger((text) => {
      logged.push(text);
    }),
    shops: createShopDirectory(client),
  };
  return { services, logged };
}

/** A tool call's context: `fixtureServices` plus a signal that has not aborted, by default. */
export function fixtureContext(
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal; config?: Partial<Config> } = {},
) {
  const { services, logged } = fixtureServices(options.fetch, options.config);
  const ctx: ToolContext = { ...services, signal: options.signal ?? new AbortController().signal };
  return { ctx, logged };
}
```

`unexpectedFetch`, above it, stays as it is.

In `test/server.test.ts`, drop `vi` from the vitest import:

```ts
import { describe, expect, it } from 'vitest';
```

import `jsonFetch` with the other fixtures:

```ts
import {
  FIXTURE_TOOLS,
  READ_ONLY,
  deleteProduct,
  fixtureServices,
  jsonFetch,
} from './tools/fixtures.js';
```

delete the local `function fakeFetch(status: number, body: unknown) { … }`, and change its three
calls (note the argument order):

| Before                                                        | After                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| `fakeFetch(200, { id: PRODUCT_ID, title: 'Tee', sku: null })` | `jsonFetch({ id: PRODUCT_ID, title: 'Tee', sku: null })`      |
| `fakeFetch(404, { error: 'Not found', request_id: 'req-1' })` | `jsonFetch({ error: 'Not found', request_id: 'req-1' }, 404)` |
| `fakeFetch(200, {})`                                          | `jsonFetch({})`                                               |

- [ ] **Step 4: Run the tests to see them pass**

```bash
npx vitest run test/cli.test.ts test/server.test.ts
npm run typecheck
```

Expected: `Test Files  2 passed (2)` and `Tests  33 passed (33)`; typecheck exits 0.

- [ ] **Step 5: Write the failing resolver test**

Create `test/tools/shop-id.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/tools/define.js';
import { resolveShopId } from '../../src/tools/shop-id.js';
import { rejection } from '../printify/helpers.js';
import { fixtureContext, jsonFetch } from './fixtures.js';

// The documented GET /v1/shops.json example.
const SHOPS = [
  { id: 5432, title: 'My new store', sales_channel: 'My Sales Channel' },
  { id: 9876, title: 'My other new store', sales_channel: 'disconnected' },
];

const SEVERAL_SHOPS_HINT =
  'Ask the user which shop to use and pass its id as shop_id. To make one the default, set ' +
  'PRINTIFY_SHOP_ID in the "env" block of the printify-mcp entry in the MCP client config.';

/** Awaits a promise that must reject with a ToolError, and returns its message and hint. */
async function refusal(promise: Promise<unknown>) {
  const error = await rejection(promise);
  if (!(error instanceof ToolError)) throw new Error(`expected a ToolError, got ${String(error)}`);
  return { message: error.message, hint: error.hint };
}

describe('resolveShopId', () => {
  it('uses shop_id when it is given, over PRINTIFY_SHOP_ID, without a request', async () => {
    const fetch = jsonFetch(SHOPS);
    const { ctx } = fixtureContext({ fetch, config: { shopId: 9876 } });
    expect(await resolveShopId({ shop_id: 5432 }, ctx)).toBe(5432);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses PRINTIFY_SHOP_ID without a request', async () => {
    const fetch = jsonFetch(SHOPS);
    const { ctx } = fixtureContext({ fetch, config: { shopId: 9876 } });
    expect(await resolveShopId({}, ctx)).toBe(9876);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uses the only shop, and lists the shops only once', async () => {
    const fetch = jsonFetch(SHOPS.slice(0, 1));
    const { ctx } = fixtureContext({ fetch });
    expect(await resolveShopId({}, ctx)).toBe(5432);
    expect(await resolveShopId({ shop_id: undefined }, ctx)).toBe(5432);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      'https://api.printify.com/v1/shops.json',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('refuses when the account has no shops', async () => {
    const { ctx } = fixtureContext({ fetch: jsonFetch([]) });
    expect(await refusal(resolveShopId({}, ctx))).toEqual({
      message: 'This Printify account has no shops.',
      hint: 'Add a shop in Printify first, then try again.',
    });
  });

  it('refuses and lists the shops when there are several', async () => {
    const { ctx } = fixtureContext({ fetch: jsonFetch(SHOPS) });
    expect(await refusal(resolveShopId({}, ctx))).toEqual({
      message:
        'This Printify account has 2 shops, so shop_id is needed: 5432 "My new store" ' +
        '(My Sales Channel), 9876 "My other new store" (disconnected).',
      hint: SEVERAL_SHOPS_HINT,
    });
  });

  it('quotes each title and leaves out a missing title or sales channel', async () => {
    const fetch = jsonFetch([
      { id: 1, title: 'Say "hi"\nnow', sales_channel: 'etsy' },
      { id: 2, sales_channel: 'shopify' },
      { id: 3, title: 'API' },
    ]);
    const { ctx } = fixtureContext({ fetch });
    expect(await refusal(resolveShopId({}, ctx))).toEqual({
      message:
        'This Printify account has 3 shops, so shop_id is needed: 1 "Say \\"hi\\"\\nnow" (etsy), ' +
        '2 (shopify), 3 "API".',
      hint: SEVERAL_SHOPS_HINT,
    });
  });

  it('rejects with the abort reason once the call is cancelled', async () => {
    const controller = new AbortController();
    const reason = new Error('The user cancelled');
    controller.abort(reason);
    const fetch = jsonFetch(SHOPS);
    const { ctx } = fixtureContext({ fetch, signal: controller.signal });
    expect(await rejection(resolveShopId({}, ctx))).toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `npx vitest run test/tools/shop-id.test.ts`

Expected: FAIL with `Error: Cannot find module '../../src/tools/shop-id.js'`.

- [ ] **Step 7: Write the resolver**

Create `src/tools/shop-id.ts`:

```ts
import { z } from 'zod';
import type { Shop } from '../printify/shops.js';
import { ToolError, type ToolContext } from './define.js';

const NO_SHOPS = 'This Printify account has no shops.';
const NO_SHOPS_HINT = 'Add a shop in Printify first, then try again.';
const SEVERAL_SHOPS_HINT =
  'Ask the user which shop to use and pass its id as shop_id. To make one the default, set ' +
  'PRINTIFY_SHOP_ID in the "env" block of the printify-mcp entry in the MCP client config.';

/**
 * The `shop_id` field of every shop-scoped tool. Spread it into the tool's input:
 * `z.strictObject({ ...shopIdInput, product_id: … })`, then call `resolveShopId`.
 */
export const shopIdInput = {
  shop_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The shop to use. Leave it out to use the default: PRINTIFY_SHOP_ID, or the only shop in ' +
        'the account.',
    ),
};

/**
 * The shop a call is for: `shop_id` if given, else PRINTIFY_SHOP_ID, else the account's only
 * shop. Only the last costs a request, and only until the shop list is cached. Throws a
 * `ToolError` when the account has no shops or several.
 */
export async function resolveShopId(
  input: { shop_id?: number | undefined },
  ctx: ToolContext,
): Promise<number> {
  if (input.shop_id !== undefined) return input.shop_id;
  if (ctx.config.shopId !== undefined) return ctx.config.shopId;
  const shops = await ctx.shops.list(ctx.signal);
  const [first] = shops;
  if (first === undefined) throw new ToolError(NO_SHOPS, NO_SHOPS_HINT);
  if (shops.length === 1) return first.id;
  throw new ToolError(
    `This Printify account has ${String(shops.length)} shops, so shop_id is needed: ` +
      `${shops.map(describeShop).join(', ')}.`,
    SEVERAL_SHOPS_HINT,
  );
}

/** `5432 "My new store" (Etsy)`, leaving out a missing title or sales channel. */
function describeShop({ id, title, sales_channel }: Shop): string {
  const parts = [String(id)];
  // JSON-quoted, so a quote or line break in a title cannot garble the list.
  if (title !== undefined) parts.push(JSON.stringify(title));
  if (sales_channel !== undefined) parts.push(`(${sales_channel})`);
  return parts.join(' ');
}
```

- [ ] **Step 8: Run the tests and every check**

```bash
npx vitest run test/tools/shop-id.test.ts
npm test
npm run typecheck
npm run lint
```

Expected: `Tests  7 passed (7)` for the file; the full suite shows `Test Files  22 passed (22)`
and `Tests  372 passed (372)`; typecheck and lint exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/tools/define.ts src/cli.ts src/tools/shop-id.ts test/tools/fixtures.ts \
  test/tools/shop-id.test.ts test/server.test.ts test/cli.test.ts
git commit -F - <<'EOF'
Resolve the shop id from the input, PRINTIFY_SHOP_ID or the only shop

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Add the shops toolset and compose ALL_TOOLS by toolset

**Files:**

- Create: `src/tools/shops.ts`
- Modify: `src/tools/index.ts` (replaced), `test/tools/catalog.test.ts` (replaced)
- Test: `test/tools/shops.test.ts`

**Interfaces:**

- Consumes: `defineTool`, `Tool` from `src/tools/define.ts`; `apiPath` from
  `src/printify/path.ts`; `ctx.shops.refresh` and `ctx.shops.invalidate` from Task 1 via Task 2's
  `ToolServices`; `resolveShopId` (tests only) and the fixtures from Task 2.
- Produces:
  - In `src/tools/shops.ts`: `listShops`, `disconnectShop` and
    `shopsTools: readonly Tool[] = [listShops, disconnectShop]`.
  - In `src/tools/index.ts`:
    `TOOLS_BY_TOOLSET: Readonly<Record<Toolset, readonly Tool[]>>` and
    `ALL_TOOLS: readonly Tool[]`, derived from it in `TOOLSETS` order. Every later toolset issue
    replaces its own `[]` here.

- [ ] **Step 1: Write the failing tests**

Create `test/tools/shops.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createServer } from '../../src/server.js';
import type { Tool } from '../../src/tools/define.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { runTool } from '../../src/tools/run.js';
import { selectTools, serverInstructions, type SelectionConfig } from '../../src/tools/select.js';
import { resolveShopId } from '../../src/tools/shop-id.js';
import { disconnectShop, listShops } from '../../src/tools/shops.js';
import { TOOLSETS } from '../../src/toolsets.js';
import { connect } from '../support/json-rpc.js';
import { fixtureContext, fixtureServices, json, jsonFetch } from './fixtures.js';

const API = 'https://api.printify.com';

// The documented GET /v1/shops.json example.
const SHOPS = [
  { id: 5432, title: 'My new store', sales_channel: 'My Sales Channel' },
  { id: 9876, title: 'My other new store', sales_channel: 'disconnected' },
];

/** The names of the shops toolset's tools among `tools`. */
function shopsToolNames(tools: readonly Tool[]): string[] {
  return tools.filter((tool) => tool.toolset === 'shops').map((tool) => tool.name);
}

describe('list_shops', () => {
  it('lists the shops, with PRINTIFY_SHOP_ID as the default', async () => {
    const fetch = jsonFetch(SHOPS);
    const { ctx } = fixtureContext({ fetch, config: { shopId: 9876 } });
    expect(await runTool(listShops, {}, ctx)).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ shops: SHOPS, default_shop_id: 9876 }) }],
      structuredContent: { shops: SHOPS, default_shop_id: 9876 },
    });
    expect(fetch).toHaveBeenCalledWith(
      `${API}/v1/shops.json`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('makes the only shop the default', async () => {
    const { ctx } = fixtureContext({ fetch: jsonFetch(SHOPS.slice(0, 1)) });
    expect((await runTool(listShops, {}, ctx)).structuredContent).toStrictEqual({
      shops: SHOPS.slice(0, 1),
      default_shop_id: 5432,
    });
  });

  it('leaves out default_shop_id with several shops and no PRINTIFY_SHOP_ID', async () => {
    const { ctx } = fixtureContext({ fetch: jsonFetch(SHOPS) });
    expect((await runTool(listShops, {}, ctx)).structuredContent).toStrictEqual({ shops: SHOPS });
  });

  it('fetches on every call and refreshes the cache that resolveShopId uses', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(SHOPS))
      .mockResolvedValueOnce(json(SHOPS.slice(1)));
    const { ctx } = fixtureContext({ fetch });
    await runTool(listShops, {}, ctx);
    expect((await runTool(listShops, {}, ctx)).structuredContent).toStrictEqual({
      shops: SHOPS.slice(1),
      default_shop_id: 9876,
    });
    expect(await resolveShopId({}, ctx)).toBe(9876);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('disconnect_shop', () => {
  it('sends DELETE to the shop connection and reports the shop as disconnected', async () => {
    const fetch = jsonFetch({});
    const { ctx } = fixtureContext({ fetch });
    expect(await runTool(disconnectShop, { shop_id: 9876 }, ctx)).toEqual({
      content: [{ type: 'text', text: '{"shop_id":9876,"disconnected":true}' }],
      structuredContent: { shop_id: 9876, disconnected: true },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `${API}/v1/shops/9876/connection.json`,
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it.each([
    ['succeeds', 200, {}],
    ['fails', 404, { error: 'Not found', request_id: 'req-1' }],
  ])('drops the shop cache when the disconnect %s', async (outcome, status, body) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(json(SHOPS))
      .mockResolvedValueOnce(json(body, status))
      .mockResolvedValueOnce(json(SHOPS.slice(0, 1)));
    const { ctx } = fixtureContext({ fetch });
    await ctx.shops.list(ctx.signal);
    const result = await runTool(disconnectShop, { shop_id: 9876 }, ctx);
    expect(result.isError ?? false).toBe(outcome === 'fails');
    expect(await ctx.shops.list(ctx.signal)).toEqual(SHOPS.slice(0, 1));
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe('the shops toolset in ALL_TOOLS', () => {
  const flagsOff: SelectionConfig = {
    toolsets: new Set(TOOLSETS),
    enableOrders: false,
    enableDestructive: false,
  };

  it('skips disconnect_shop unless PRINTIFY_ENABLE_DESTRUCTIVE is on', () => {
    const { enabled, skipped } = selectTools(ALL_TOOLS, flagsOff);
    expect(shopsToolNames(enabled)).toEqual(['list_shops']);
    expect(skipped.map(({ tool, reason }) => [tool.name, reason])).toContainEqual([
      'disconnect_shop',
      'destructive',
    ]);
  });

  it('registers both tools with PRINTIFY_ENABLE_DESTRUCTIVE on', () => {
    const { enabled } = selectTools(ALL_TOOLS, { ...flagsOff, enableDestructive: true });
    expect(shopsToolNames(enabled)).toEqual(['list_shops', 'disconnect_shop']);
  });
});

describe('the shops toolset over MCP', () => {
  /** Serves ALL_TOOLS the way cli.ts does, with PRINTIFY_ENABLE_DESTRUCTIVE on. */
  function serve(fetch: typeof globalThis.fetch) {
    const { services } = fixtureServices(fetch, { enableDestructive: true });
    const { enabled, skipped } = selectTools(ALL_TOOLS, services.config);
    const instructions = serverInstructions(skipped);
    return connect(createServer({ tools: enabled, services, instructions }));
  }

  it('lists both tools with their annotations, and shop_id as required to disconnect', async () => {
    const mcp = await serve(jsonFetch(SHOPS));
    const tools = (await mcp.listTools()).filter((tool) =>
      ['list_shops', 'disconnect_shop'].includes(String(tool.name)),
    );
    expect(tools).toMatchObject([
      {
        name: 'list_shops',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'disconnect_shop',
        inputSchema: { required: ['shop_id'], additionalProperties: false },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ]);
    await mcp.close();
  });

  it('returns the shops as structured content', async () => {
    const mcp = await serve(jsonFetch(SHOPS));
    expect(await mcp.callTool('list_shops', {})).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ shops: SHOPS }) }],
      structuredContent: { shops: SHOPS },
    });
    await mcp.close();
  });

  it('refuses disconnect_shop without shop_id before sending anything', async () => {
    const fetch = jsonFetch({});
    const mcp = await serve(fetch);
    const result = await mcp.callTool('disconnect_shop', {});
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result.content)).toContain(
      'Input validation error: Invalid arguments for tool disconnect_shop',
    );
    expect(fetch).not.toHaveBeenCalled();
    await mcp.close();
  });
});
```

Replace `test/tools/catalog.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { toolProblems } from '../../src/tools/check.js';
import { ALL_TOOLS, TOOLS_BY_TOOLSET } from '../../src/tools/index.js';

describe('ALL_TOOLS', () => {
  it('follows every rule for tool definitions', () => {
    expect(toolProblems(ALL_TOOLS)).toEqual([]);
  });

  it('files every tool under its own toolset', () => {
    const misfiled = Object.entries(TOOLS_BY_TOOLSET).flatMap(([toolset, tools]) =>
      tools
        .filter((tool) => tool.toolset !== toolset)
        .map((tool) => `${tool.name} (toolset ${tool.toolset}) is filed under ${toolset}`),
    );
    expect(misfiled).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/tools/shops.test.ts test/tools/catalog.test.ts`

Expected: `test/tools/shops.test.ts` fails with
`Error: Cannot find module '../../src/tools/shops.js'`, and
`files every tool under its own toolset` fails with
`TypeError: Cannot convert undefined or null to object`, because `TOOLS_BY_TOOLSET` does not exist
yet.

- [ ] **Step 3: Write the tools**

Create `src/tools/shops.ts`:

```ts
import { z } from 'zod';
import { apiPath } from '../printify/path.js';
import { defineTool, type Tool } from './define.js';

export const listShops = defineTool({
  name: 'list_shops',
  toolset: 'shops',
  description:
    'Lists the shops in the Printify account with their id, title and sales channel ' +
    '("disconnected" when no sales channel is connected, e.g. an API shop). `default_shop_id` ' +
    'is the shop that shop-scoped tools use when `shop_id` is left out; it is missing when ' +
    'there is no default. Call this when the user asks about their shops or when a tool needs ' +
    'a `shop_id`.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  input: z.strictObject({}),
  handler: async (_input, ctx) => {
    // Always fetched, so the answer is current and the cache picks up newly connected shops.
    const shops = await ctx.shops.refresh(ctx.signal);
    const onlyShop = shops.length === 1 ? shops[0]?.id : undefined;
    return { shops, default_shop_id: ctx.config.shopId ?? onlyShop };
  },
});

export const disconnectShop = defineTool({
  name: 'disconnect_shop',
  toolset: 'shops',
  gate: 'destructive',
  description:
    'Disconnects a shop from Printify. This cannot be undone with this server; reconnecting ' +
    'happens in the Printify app. Needs an explicit `shop_id` and never uses the default shop. ' +
    "Before calling it, confirm the shop's id and title with the user, e.g. from `list_shops`.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  input: z.strictObject({
    shop_id: z
      .number()
      .int()
      .positive()
      .describe('The shop to disconnect. Required: this tool never uses the default shop.'),
  }),
  handler: async ({ shop_id }, ctx) => {
    try {
      await ctx.client.request('DELETE', apiPath`/v1/shops/${shop_id}/connection.json`, {
        signal: ctx.signal,
      });
    } finally {
      // Also after a failure: after a timeout, nobody knows whether the shop was disconnected.
      ctx.shops.invalidate();
    }
    return { shop_id, disconnected: true };
  },
});

export const shopsTools: readonly Tool[] = [listShops, disconnectShop];
```

- [ ] **Step 4: Compose `ALL_TOOLS` by toolset**

Replace `src/tools/index.ts` with:

```ts
import { TOOLSETS, type Toolset } from '../toolsets.js';
import type { Tool } from './define.js';
import { shopsTools } from './shops.js';

/**
 * Each toolset's tools, from `src/tools/<toolset>.ts`. A toolset's issue replaces its `[]` with
 * its own array, so toolsets never edit the same line.
 */
export const TOOLS_BY_TOOLSET: Readonly<Record<Toolset, readonly Tool[]>> = {
  shops: shopsTools,
  catalog: [],
  uploads: [],
  products: [],
  publishing: [],
  personalization: [],
  orders: [],
  support: [],
  webhooks: [],
  workflows: [],
};

/** Every tool the server can offer, in `TOOLSETS` order. */
export const ALL_TOOLS: readonly Tool[] = TOOLSETS.flatMap((toolset) => TOOLS_BY_TOOLSET[toolset]);
```

- [ ] **Step 5: Run the tests and every check**

```bash
npx vitest run test/tools/shops.test.ts test/tools/catalog.test.ts
npm test
npm run typecheck
npm run lint
```

Expected: `Tests  14 passed (14)` for the two files; the full suite shows
`Test Files  23 passed (23)` and `Tests  385 passed (385)`; typecheck and lint exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/tools/shops.ts src/tools/index.ts test/tools/shops.test.ts test/tools/catalog.test.ts
git commit -F - <<'EOF'
Add the shops toolset and compose ALL_TOOLS by toolset

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Clean verification, pull request and hand-off comments

**Files:** none.

- [ ] **Step 1: Verify from a clean install**

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: every command exits 0; `Test Files  23 passed (23)` and `Tests  385 passed (385)`;
`dist/printify/shops.js`, `dist/tools/shop-id.js` and `dist/tools/shops.js` exist.

- [ ] **Step 2: Smoke-run the built server over stdio**

```bash
(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; sleep 1) \
  | PRINTIFY_API_TOKEN=Tok-smoke-1 node dist/index.js
```

Expected: stderr shows
`printify-mcp: 0.0.0 on stdio (tools: 1 of 2; toolsets: all; orders: off; destructive: off; default shop: none; upload dirs: 0)`
and `printify-mcp: PRINTIFY_ENABLE_DESTRUCTIVE is off, skipped: disconnect_shop`. The
`initialize` result has instructions that name `disconnect_shop` and
`PRINTIFY_ENABLE_DESTRUCTIVE=true`, and `tools/list` returns only `list_shops`. No request reaches
Printify.

- [ ] **Step 3: Check the commit trailers**

Run: `git log --format='%h %s | %(trailers:only,unfold)' origin/main..HEAD`

Expected: every commit ends with
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and no other
`Co-Authored-By` line. Fix any other trailer before pushing.

- [ ] **Step 4: Push and open the pull request**

```bash
git push -u origin feat/7-shops
gh pr create --base main --title "Shops toolset and default shop resolution" --body-file - <<'EOF'
Closes #7

## Summary

- **Shop resolution:** `resolveShopId(input, ctx)` in `src/tools/shop-id.ts` uses `shop_id`, else
  `PRINTIFY_SHOP_ID`, else the account's only shop. With no shops or several, it refuses with a
  `ToolError` that lists them (id, JSON-quoted title, sales channel) and says how to set a
  default. Every shop-scoped tool in #8–#19 spreads `shopIdInput` into its input and calls it
  first.
- **Shop cache:** `createShopDirectory(client)` in `src/printify/shops.ts` fetches and validates
  `GET /v1/shops.json` and caches the list for the process. `cli.ts` creates it once, next to the
  client, and every tool gets it as `ctx.shops`. Failed fetches are not cached, and a fetch that
  overlaps `invalidate()` does not write a stale list back.
- **`list_shops`:** read-only; always fetches, refreshes the cache and returns
  `{ shops, default_shop_id }`, so the model knows which shop an omitted `shop_id` means.
- **`disconnect_shop`:** `DELETE /v1/shops/{shop_id}/connection.json` (the Postman collection's
  GET is wrong). Registered only with `PRINTIFY_ENABLE_DESTRUCTIVE=true`, takes a required
  `shop_id` (it never uses the default shop), and drops the shop cache whether or not the call
  succeeds.
- **`ALL_TOOLS`:** derived in `TOOLSETS` order from `TOOLS_BY_TOOLSET`, a record keyed by toolset.
  Each toolset issue replaces its own `[]`, so they never edit the same line; a catalog test
  checks that every tool is filed under its own toolset.

Tests use `runTool`, `test/tools/fixtures.ts` and `test/support/json-rpc.ts`, because #6's
harness has not landed; #6 moves the end-to-end ones to `createTestServer`.

Spec: `docs/superpowers/specs/2026-09-22-shops-toolset-design.md`
Plan: `docs/superpowers/plans/2026-09-22-shops-toolset.md`

## Test plan

- [x] `npm run lint`, `npm run typecheck`, `npm test` (385 tests), `npm run build`
- [x] All four resolution branches, plus no shops and cancellation
- [x] `disconnect_shop` is absent without `PRINTIFY_ENABLE_DESTRUCTIVE` and present with it
- [x] `disconnect_shop` sends DELETE and drops the cache after success and failure
- [x] Smoke run of the built server over stdio
- [ ] CI green on Node 22 and 24

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 5: Move the issue to In review and watch CI**

```bash
~/.claude/skills/updating-github-project-status/board.sh review
gh pr checks --watch
```

Expected: the board script prints a line moving #7 to In review; every check passes. If a check
fails, read its log with `gh run view --log-failed`, fix the cause, commit and push again.

- [ ] **Step 6: Hand-off comments on #6 and #8**

```bash
gh issue comment 6 --body-file - <<'EOF'
Notes from the #7 implementation (shops toolset):
- `ToolServices` now has `shops`, the process's shop directory: `createShopDirectory(client)` from `src/printify/shops.ts`. `createTestServer` must build it from the same fake-fetch client, as `fixtureServices` in `test/tools/fixtures.ts` does.
- `test/tools/fixtures.ts` gained `json(body, status?)`, `jsonFetch(body, status?)` (a `vi.fn` fetch that answers every request with that JSON) and config overrides: `fixtureServices(fetch, { shopId: 12 })` and `fixtureContext({ fetch, config })`. The route-based fake can replace `jsonFetch`.
- The "the shops toolset over MCP" tests in `test/tools/shops.test.ts` use `test/support/json-rpc.ts`. Move them to `createTestServer` with the rest.
- For the "adding a tool" section of `CONTRIBUTING.md`:
  - One file per toolset, `src/tools/<toolset>.ts`, exporting `<toolset>Tools`. Wire it in by replacing the toolset's `[]` in `TOOLS_BY_TOOLSET` in `src/tools/index.ts`. A catalog test checks that every tool is filed under its own toolset.
  - A shop-scoped tool spreads `shopIdInput` from `src/tools/shop-id.ts` into its `z.strictObject` and starts its handler with `const shopId = await resolveShopId(input, ctx)`. A destructive tool that acts on a whole shop, like `disconnect_shop`, takes a required `shop_id` instead.
  - Test gating and end-to-end behaviour through `selectTools(ALL_TOOLS, …)`, not the toolset's own array, so a tool that was never wired in fails its own tests.
EOF
gh issue comment 8 --body-file - <<'EOF'
Conventions from the #7 implementation (shops toolset). They apply to every toolset issue (#8–#19) and add to the #5 notes on #7:
- Put the toolset in one file, `src/tools/<toolset>.ts`, exporting `<toolset>Tools: readonly Tool[]`. Wire it in by replacing the toolset's `[]` in `TOOLS_BY_TOOLSET` in `src/tools/index.ts`; `ALL_TOOLS` is derived from that record in `TOOLSETS` order. (#9 adds to `src/tools/catalog.ts`.)
- Shop-scoped tools (#11–#16, #19): spread `shopIdInput` from `src/tools/shop-id.ts` into the input, `z.strictObject({ ...shopIdInput, … })`, and start the handler with `const shopId = await resolveShopId(input, ctx)`. It uses `shop_id`, else `PRINTIFY_SHOP_ID`, else the only shop, and throws a `ToolError` listing the shops otherwise. A destructive tool that acts on a whole shop takes a required `shop_id` instead.
- Test gating and end-to-end behaviour through `selectTools(ALL_TOOLS, …)`, not the toolset's own array, so a tool that was never wired in fails its own tests. `jsonFetch` and `json` in `test/tools/fixtures.ts` make fake responses; assert "no request" with `expect(fetch).not.toHaveBeenCalled()`.
EOF
```

---

## Summary

| Task | Commit                                                                | Tests after |
| ---- | --------------------------------------------------------------------- | ----------- |
| 1    | Cache the account's shops once per process                            | 365         |
| 2    | Resolve the shop id from the input, PRINTIFY_SHOP_ID or the only shop | 372         |
| 3    | Add the shops toolset and compose ALL_TOOLS by toolset                | 385         |
| 4    | (no commit) verification, PR, board, hand-off comments                | 385         |

The tasks run in order: Task 2 needs Task 1's directory, and Task 3 needs both.
