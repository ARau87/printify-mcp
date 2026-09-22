# Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every toolset issue (#7–#19) one way to call a tool as an MCP client would and to assert on the HTTP requests that reached Printify.

**Architecture:** Two layers. `createFakeApi(routes)` is a fake `fetch` that answers from a `METHOD /path` route table and records every request; it knows nothing about MCP. `createTestServer(options)` builds the server the way `cli.ts` does over that fake API and connects a real MCP `Client` through an in-memory transport. Two assertion helpers normalise tool results. The existing `test/server.test.ts` moves onto the harness and the raw JSON-RPC stand-in is deleted.

**Tech Stack:** TypeScript ~6.0 (ESM, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`), vitest 5, zod 4, `@modelcontextprotocol/server` 2.0.0, `@modelcontextprotocol/client` 2.0.0 (added by this plan).

**Spec:** `docs/superpowers/specs/2026-09-22-test-harness-design.md`

## Global Constraints

- Branch: `feat/6-test-harness`, already created from `origin/main`. The spec is already committed on it.
- Node >= 22. Package is ESM (`"type": "module"`); every relative import ends in `.js`.
- End every commit message with exactly: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. This overrides any attribution your own harness would otherwise add.
- `npm run lint` runs `eslint . && prettier --check .` and must pass. Notable rules this plan already accounts for: `@typescript-eslint/unbound-method` (interface members are function-typed properties, never methods), `no-unnecessary-condition`, `prefer-promise-reject-errors` (reject with an `Error`), and `no-unnecessary-type-assertion`.
- `tsconfig.json` sets `strict` and `noUncheckedIndexedAccess`, so every indexed read is `T | undefined` and must be narrowed.
- Never put a real Printify token in a test. The harness token is the literal `Tok-harness-9K8j7H6g`.
- Tests live in `test/**/*.test.ts` (the vitest `include`). Support modules and fixtures are not test files and must not contain `describe`/`it`.
- Do not modify `test/printify/client.test.ts`, `src/**`, or `test/tools/{select,shape,check,reference,run}.test.ts`. If you believe one of them must change, stop and report why.
- After each task: `npm run lint`, `npx tsc --noEmit`, `npm test` must all pass before you commit.

---

### Task 1: Fixtures and the fake Printify API

**Files:**

- Create: `test/fixtures/shops.ts`
- Create: `test/fixtures/products.ts`
- Create: `test/fixtures/errors.ts`
- Create: `test/support/fake-api.ts`
- Test: `test/support/fake-api.test.ts`

**Interfaces:**

- Consumes: `HttpMethod` from `src/printify/types.js` (`'GET' | 'POST' | 'PUT' | 'DELETE'`).
- Produces, from `test/support/fake-api.js`: the types `RouteKey`, `FakeRequest`, `Responder`, `JsonBody`, `Route`, `Routes`, `FakeApi`; the functions `createFakeApi(routes?: Routes): FakeApi`, `json(body: unknown, status?: number, headers?: Record<string, string>): Response`, `text(body: string, status?: number): Response`, `empty(status?: number): Response`, `inTurn(...replies: readonly Route[]): Responder`, `fails(cause?: Error): Responder`, `never(): Responder`.
- Produces, from `test/fixtures/shops.js`: `SHOP`, `DISCONNECTED_SHOP`, `SHOPS`, `shop(overrides?)`.
- Produces, from `test/fixtures/products.js`: `PRODUCT`, `product(overrides?)`.
- Produces, from `test/fixtures/errors.js`: `apiErrorBody(overrides?)`, `notFoundBody(overrides?)`.

- [ ] **Step 1: Create the three fixture modules**

`test/fixtures/shops.ts`:

```ts
/** The documented `GET /v1/shops.json` example. */
export const SHOP = { id: 5432, title: 'My new store', sales_channel: 'My Sales Channel' };

/** An API-only shop, which #7's default-shop resolution has to tell apart from a connected one. */
export const DISCONNECTED_SHOP = {
  id: 9876,
  title: 'My other new store',
  sales_channel: 'disconnected',
};

export const SHOPS = [SHOP, DISCONNECTED_SHOP];

export function shop(overrides: Partial<typeof SHOP> = {}): typeof SHOP {
  return { ...SHOP, ...overrides };
}
```

`test/fixtures/products.ts`:

```ts
import { SHOP } from './shops.js';

const SHOP_ID = SHOP.id;

/**
 * A product as `GET /v1/shops/{shop_id}/products/{product_id}.json` returns one, trimmed to the
 * fields tools read. `external` is null on purpose: it proves the registry drops nulls.
 */
export const PRODUCT = {
  id: '5d39b159e7c48c000728c89f',
  title: 'Unisex Jersey Short Sleeve Tee',
  description: 'A soft cotton tee.',
  tags: ['T-shirt', 'Men'],
  blueprint_id: 6,
  print_provider_id: 99,
  shop_id: SHOP_ID,
  visible: true,
  is_locked: false,
  external: null,
  variants: [
    { id: 17887, sku: '19473', price: 1000, is_enabled: true, is_default: true, grams: 180 },
    { id: 17888, sku: '19474', price: 1000, is_enabled: false, is_default: false, grams: 180 },
  ],
  images: [
    {
      src: 'https://images.printify.com/mockup/1.png',
      variant_ids: [17887],
      position: 'front',
      is_default: true,
    },
  ],
  print_areas: [
    {
      variant_ids: [17887, 17888],
      placeholders: [
        {
          position: 'front',
          images: [{ id: '5cb87a8cd490a2ccb256cec4', x: 0.5, y: 0.5, scale: 1, angle: 0 }],
        },
      ],
    },
  ],
  created_at: '2019-07-25 13:40:41+00:00',
};

export function product(overrides: Partial<typeof PRODUCT> = {}): typeof PRODUCT {
  return { ...PRODUCT, ...overrides };
}
```

`test/fixtures/errors.ts`:

```ts
/**
 * Printify's documented error envelope: `{status, code, message, errors: {reason, code}}`. Note
 * the `status` key, which is why the harness never detects a response wrapper by shape.
 */
export function apiErrorBody(
  overrides: { code?: number; message?: string; reason?: string } = {},
): { status: string; code: number; message: string; errors: { reason: string; code: number } } {
  const {
    code = 8502,
    message = 'Order failed',
    reason = 'Shipping method is not supported',
  } = overrides;
  return { status: 'error', code, message, errors: { reason, code } };
}

/** The shorter envelope 401 and 404 return. `request_id` is what `error.request_id` reports. */
export function notFoundBody(overrides: { error?: string; request_id?: string } = {}): {
  error: string;
  request_id: string;
} {
  const { error = 'Not found', request_id = 'req-1' } = overrides;
  return { error, request_id };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/support/fake-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SHOPS } from '../fixtures/shops.js';
import { createFakeApi, empty, inTurn, json } from './fake-api.js';

const BASE = 'https://api.printify.com';

describe('createFakeApi: serving routes', () => {
  it('serves a bare value as a 200 JSON body', async () => {
    const api = createFakeApi({ 'GET /v1/shops.json': SHOPS });
    const response = await api.fetch(`${BASE}/v1/shops.json`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SHOPS);
  });

  it('serves a Response as it is, keeping its status', async () => {
    const api = createFakeApi({ 'GET /v1/x.json': json({ error: 'nope' }, 404) });
    const response = await api.fetch(`${BASE}/v1/x.json`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'nope' });
  });

  it('serves empty() as a 204 with no body', async () => {
    const api = createFakeApi({ 'DELETE /v1/x.json': empty() });
    const response = await api.fetch(`${BASE}/v1/x.json`, { method: 'DELETE' });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });

  it('answers the same route twice, because the Response is cloned', async () => {
    const api = createFakeApi({ 'GET /v1/shops.json': json(SHOPS) });
    expect(await (await api.fetch(`${BASE}/v1/shops.json`)).json()).toEqual(SHOPS);
    expect(await (await api.fetch(`${BASE}/v1/shops.json`)).json()).toEqual(SHOPS);
  });

  it('answers in turn and repeats the last reply', async () => {
    const api = createFakeApi({ 'GET /v1/x.json': inTurn(json({ n: 1 }), json({ n: 2 })) });
    const seen: unknown[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      seen.push(await (await api.fetch(`${BASE}/v1/x.json`)).json());
    }
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 2 }]);
  });

  it('passes the query to a responder without matching on it', async () => {
    const api = createFakeApi({ 'GET /v1/x.json': (request) => ({ page: request.query.page }) });
    const response = await api.fetch(`${BASE}/v1/x.json?page=3&limit=10`);
    expect(await response.json()).toEqual({ page: '3' });
    expect(api.requests[0]?.query).toEqual({ page: '3', limit: '10' });
  });

  it('records the method, path and parsed body of a request', async () => {
    const api = createFakeApi({ 'POST /v1/x.json': json({ ok: true }) });
    await api.fetch(`${BASE}/v1/x.json`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Tee' }),
    });
    expect(api.requests).toHaveLength(1);
    expect(api.requests[0]).toMatchObject({
      method: 'POST',
      path: '/v1/x.json',
      body: { title: 'Tee' },
    });
  });
});

describe('createFakeApi: route keys', () => {
  it.each([
    ['GET/v1/x.json', /Invalid route key/],
    ['PATCH /v1/x.json', /Invalid route key/],
    ['GET v1/x.json', /must start with/],
    ['GET /v1/x.json extra', /Invalid route key/],
  ])('rejects the malformed key %s', (key, message) => {
    expect(() => createFakeApi({ [key]: 1 } as never)).toThrow(message);
  });
});

describe('createFakeApi: unmatched requests', () => {
  it('answers 418 with a message naming the declared routes', async () => {
    const api = createFakeApi({ 'GET /v1/shops.json': SHOPS });
    const response = await api.fetch(`${BASE}/v1/nope.json`);
    expect(response.status).toBe(418);
    expect(await response.json()).toEqual({
      error:
        'printify-mcp test harness: no route for GET /v1/nope.json. ' +
        'Declared routes: GET /v1/shops.json',
    });
  });

  it('says "(none)" when no route was declared', async () => {
    const api = createFakeApi();
    const response = await api.fetch(`${BASE}/v1/nope.json`);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('Declared routes: (none)');
  });

  it('assertNoUnmatched throws and names every unmatched request', async () => {
    const api = createFakeApi();
    await api.fetch(`${BASE}/v1/a.json`);
    await api.fetch(`${BASE}/v1/b.json`, { method: 'POST' });
    expect(() => {
      api.assertNoUnmatched();
    }).toThrow(/2 request\(s\) that matched no route: GET \/v1\/a.json, POST \/v1\/b.json/);
  });

  it('assertNoUnmatched passes once takeUnmatched has cleared them', async () => {
    const api = createFakeApi();
    await api.fetch(`${BASE}/v1/a.json`);
    expect(api.takeUnmatched()).toHaveLength(1);
    expect(api.unmatched).toHaveLength(0);
    expect(() => {
      api.assertNoUnmatched();
    }).not.toThrow();
  });
});

describe('createFakeApi: expectRequest', () => {
  it('returns the one matching request and matches its body', async () => {
    const api = createFakeApi({ 'POST /v1/x.json': json({ ok: true }) });
    await api.fetch(`${BASE}/v1/x.json`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Tee', extra: 1 }),
    });
    expect(api.expectRequest('POST', '/v1/x.json', { title: 'Tee' }).path).toBe('/v1/x.json');
  });

  it('lists the recorded requests when nothing matched', async () => {
    const api = createFakeApi({ 'POST /v1/x.json': json({ ok: true }) });
    await api.fetch(`${BASE}/v1/x.json`, { method: 'POST' });
    expect(() => api.expectRequest('GET', '/v1/x.json')).toThrow(
      /expected exactly one "GET \/v1\/x.json", got 0\. Recorded: POST \/v1\/x.json/,
    );
  });

  it('fails when the same route was called twice', async () => {
    const api = createFakeApi({ 'GET /v1/x.json': json({ ok: true }) });
    await api.fetch(`${BASE}/v1/x.json`);
    await api.fetch(`${BASE}/v1/x.json`);
    expect(() => api.expectRequest('GET', '/v1/x.json')).toThrow(/got 2/);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/support/fake-api.test.ts`
Expected: FAIL — `Failed to resolve import "./fake-api.js"`.

- [ ] **Step 4: Implement the fake API**

Create `test/support/fake-api.ts`:

```ts
import { expect } from 'vitest';
import type { HttpMethod } from '../../src/printify/types.js';

const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'DELETE'];

/** A route key: the method, one space, and the exact pathname. */
export type RouteKey = `${HttpMethod} /${string}`;

export interface FakeRequest {
  method: string;
  /** The pathname only: no base URL and no query. */
  path: string;
  query: Record<string, string>;
  headers: Headers;
  /** The parsed JSON body, the raw text when it is not JSON, or `undefined` when there was none. */
  body: unknown;
  /** The signal the client passed to `fetch`, not the `Request` copy of it. */
  signal: AbortSignal;
}

/** Answers one request. Returning anything but a `Response` sends it as a 200 JSON body. */
export type Responder = (request: FakeRequest) => unknown;

/** Anything sent as a JSON body. `object`, so a fixture declared as an interface is assignable. */
export type JsonBody = object | string | number | boolean | null;

/**
 * What a route answers with, discriminated at runtime: a `Response` is used as is, a `Responder`
 * is called, and anything else is sent as a 200 JSON body. `Responder` is a member of the union
 * rather than the whole type being `unknown`, because only a union with a function member gives a
 * route written as `(request) => …` a typed parameter.
 */
export type Route = Response | Responder | JsonBody;

export type Routes = Readonly<Record<RouteKey, Route>>;

// Every member is a function-typed property rather than a method, because destructuring a method
// off the object trips @typescript-eslint/unbound-method.
export interface FakeApi {
  fetch: typeof globalThis.fetch;
  requests: readonly FakeRequest[];
  /** Requests that matched no route. */
  unmatched: readonly FakeRequest[];
  /** Asserts exactly one matching request and returns it. */
  expectRequest: (method: HttpMethod, path: string, body?: unknown) => FakeRequest;
  /**
   * Returns the unmatched requests and forgets them, so the teardown check passes. Only a test
   * that means to provoke a miss calls this.
   */
  takeUnmatched: () => readonly FakeRequest[];
  /** Throws, naming them, when any request matched no route. The teardown hook calls this. */
  assertNoUnmatched: () => void;
}

/** A JSON response. The default status is 200. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A plain-text response, for the paths that must cope with a body that is not JSON. */
export function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

/** An empty response, as a delete returns. */
export function empty(status = 204): Response {
  return new Response(null, { status });
}

/** Answers the nth request with the nth reply, and every later one with the last. */
export function inTurn(...replies: readonly Route[]): Responder {
  if (replies.length === 0) throw new TypeError('inTurn needs at least one reply');
  let count = 0;
  return (request) => {
    const reply = replies[Math.min(count, replies.length - 1)];
    count += 1;
    // Unreachable: the index is clamped and the list is not empty. Route excludes undefined.
    if (reply === undefined) throw new TypeError('inTurn ran out of replies');
    return resolveRoute(reply, request);
  };
}

/** Rejects, the way `fetch` does when the request never reached a server. */
export function fails(cause: Error = new TypeError('fetch failed')): Responder {
  return () => Promise.reject(cause);
}

/** Answers only once the request's signal aborts, like a server that never replies. */
export function never(): Responder {
  return ({ signal }) =>
    new Promise<Response>((_resolve, reject) => {
      const fail = () => {
        reject(signal.reason as Error);
      };
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail);
    });
}

/**
 * A fake `fetch` for `createPrintifyClient`, answering from `routes` and recording every request.
 * A request that matches no route is recorded in `unmatched` and answered with 418, which carries
 * no hint and is never retried, so the tool result names the missing route.
 */
export function createFakeApi(routes: Routes = {}): FakeApi {
  for (const key of Object.keys(routes)) checkRouteKey(key);
  const table: Readonly<Record<string, Route>> = routes;
  const requests: FakeRequest[] = [];
  const unmatched: FakeRequest[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const sent: FakeRequest = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body: parseBody(await request.text()),
      // Request copies the signal, so keep the one the client passed.
      signal: init?.signal ?? request.signal,
    };
    requests.push(sent);
    const key = `${sent.method} ${sent.path}`;
    const route = table[key];
    // Route excludes undefined, so a missing value means the route was never declared.
    if (route === undefined) {
      unmatched.push(sent);
      return json({ error: noRouteMessage(key, Object.keys(table)) }, 418);
    }
    return resolveRoute(route, sent);
  };

  return {
    fetch,
    requests,
    unmatched,
    expectRequest(method, path, body) {
      const matching = requests.filter((sent) => sent.method === method && sent.path === path);
      const only = matching[0];
      if (matching.length !== 1 || only === undefined) {
        throw new Error(
          `expected exactly one "${method} ${path}", got ${String(matching.length)}. ` +
            `Recorded: ${describeRequests(requests)}`,
        );
      }
      if (body !== undefined) expect(only.body).toMatchObject(body as object);
      return only;
    },
    takeUnmatched() {
      return unmatched.splice(0, unmatched.length);
    },
    assertNoUnmatched() {
      if (unmatched.length === 0) return;
      throw new Error(
        `the test sent ${String(unmatched.length)} request(s) that matched no route: ` +
          describeRequests(unmatched),
      );
    },
  };
}

/** Cloned, so a route may answer more than one request. */
async function resolveRoute(route: Route, request: FakeRequest): Promise<Response> {
  const value = typeof route === 'function' ? await (route as Responder)(request) : route;
  return value instanceof Response ? value.clone() : json(value);
}

function parseBody(body: string): unknown {
  if (body === '') return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function checkRouteKey(key: string): void {
  const parts = key.split(' ');
  const [method, path] = parts;
  if (parts.length !== 2 || method === undefined || !METHODS.includes(method)) {
    throw new TypeError(
      `Invalid route key "${key}": use "<METHOD> /path", e.g. "GET /v1/shops.json". ` +
        `Methods: ${METHODS.join(', ')}`,
    );
  }
  if (path === undefined || !path.startsWith('/')) {
    throw new TypeError(`Invalid route key "${key}": the path must start with "/"`);
  }
}

function noRouteMessage(key: string, declared: readonly string[]): string {
  return (
    `printify-mcp test harness: no route for ${key}. Declared routes: ` +
    (declared.length === 0 ? '(none)' : declared.join(', '))
  );
}

function describeRequests(requests: readonly FakeRequest[]): string {
  if (requests.length === 0) return '(none)';
  return requests.map((sent) => `${sent.method} ${sent.path}`).join(', ');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/support/fake-api.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Verify the whole project**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: all pass. The existing 354 tests are untouched.

- [ ] **Step 7: Commit**

```bash
git add test/fixtures test/support/fake-api.ts test/support/fake-api.test.ts
git commit -m "$(cat <<'EOF'
Add the fake Printify API and its fixtures

Routes are declared as "METHOD /path" and matched without the query. A
request that matches no route is answered with 418, which carries no hint
and is never retried, so the tool result names the missing route instead
of reporting that Printify could not be reached.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The assertion helpers

**Files:**

- Create: `test/support/expect.ts`
- Test: `test/support/expect.test.ts`

**Interfaces:**

- Consumes: `CallToolResult` from `@modelcontextprotocol/server`.
- Produces, from `test/support/expect.js`: `ToolErrorFields`, `expectToolData(result: CallToolResult): Record<string, unknown>`, `expectToolError(result: CallToolResult, expected?: Partial<ToolErrorFields>): ToolErrorFields`.

- [ ] **Step 1: Write the failing test**

Create `test/support/expect.test.ts`:

```ts
import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { expectToolData, expectToolError } from './expect.js';

function success(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function registryError(error: Record<string, unknown>): CallToolResult {
  const body = { error };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

const validationError: CallToolResult = {
  isError: true,
  content: [
    {
      type: 'text',
      text: 'Input validation error: Invalid arguments for tool get_product: Unrecognized key: "detial"',
    },
  ],
};

describe('expectToolData', () => {
  it('returns the data of a successful result', () => {
    expect(expectToolData(success({ shops: [{ id: 1 }] }))).toEqual({ shops: [{ id: 1 }] });
  });

  it('rejects an error result', () => {
    expect(() => expectToolData(registryError({ kind: 'http', message: 'no' }))).toThrow(
      /expected a successful tool result/,
    );
  });

  it('rejects a result without structuredContent', () => {
    expect(() => expectToolData({ content: [{ type: 'text', text: '{}' }] })).toThrow(
      /no structuredContent/,
    );
  });

  it('rejects a result whose text block and structuredContent disagree', () => {
    expect(() =>
      expectToolData({
        content: [{ type: 'text', text: '{"shops":[]}' }],
        structuredContent: { shops: [{ id: 1 }] },
      }),
    ).toThrow();
  });
});

describe('expectToolError', () => {
  it('returns the registry error fields', () => {
    const result = registryError({
      kind: 'http',
      request: 'GET /v1/shops.json',
      status: 404,
      message: 'Not found',
      hint: 'Check the id.',
    });
    expect(expectToolError(result)).toMatchObject({ kind: 'http', status: 404 });
  });

  it('matches the expected fields when they are given', () => {
    const result = registryError({ kind: 'tool', message: 'No default shop' });
    expect(expectToolError(result, { kind: 'tool' }).message).toBe('No default shop');
    expect(() => expectToolError(result, { kind: 'http' })).toThrow();
  });

  it('normalises an SDK validation error', () => {
    const fields = expectToolError(validationError);
    expect(fields.kind).toBe('validation');
    expect(fields.message).toContain('Unrecognized key');
  });

  it('rejects a successful result', () => {
    expect(() => expectToolError(success({ ok: true }))).toThrow(/expected an error tool result/);
  });

  it('rejects an error result in neither shape', () => {
    expect(() =>
      expectToolError({ isError: true, content: [{ type: 'text', text: 'something else' }] }),
    ).toThrow(/neither known shape/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/support/expect.test.ts`
Expected: FAIL — `Failed to resolve import "./expect.js"`.

- [ ] **Step 3: Implement the helpers**

Create `test/support/expect.ts`:

```ts
import type { CallToolResult } from '@modelcontextprotocol/server';
import { expect } from 'vitest';

/** The registry's error kinds, plus `validation` for the SDK's input validation error. */
export interface ToolErrorFields {
  kind: 'http' | 'timeout' | 'network' | 'invalid_response' | 'tool' | 'internal' | 'validation';
  request?: string;
  status?: number;
  code?: number;
  message: string;
  reason?: string;
  request_id?: string;
  retry_after_seconds?: number;
  hint?: string;
}

/**
 * Asserts a successful tool result, and that its JSON text block and `structuredContent` agree.
 * Returns the data.
 */
export function expectToolData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`expected a successful tool result, got ${JSON.stringify(result)}`);
  }
  const data: unknown = result.structuredContent;
  if (typeof data !== 'object' || data === null) {
    throw new Error(`the tool result has no structuredContent: ${JSON.stringify(result)}`);
  }
  expect(JSON.parse(textOf(result))).toEqual(data);
  return data as Record<string, unknown>;
}

/**
 * Asserts an error tool result and normalises both shapes: the registry's
 * `structuredContent.error`, and the SDK's text-only input validation error, which becomes
 * `kind: 'validation'`. With `expected`, the normalised fields are matched against it.
 */
export function expectToolError(
  result: CallToolResult,
  expected?: Partial<ToolErrorFields>,
): ToolErrorFields {
  if (result.isError !== true) {
    throw new Error(`expected an error tool result, got ${JSON.stringify(result)}`);
  }
  const fields = errorFields(result);
  if (expected !== undefined) expect(fields).toMatchObject(expected);
  return fields;
}

function errorFields(result: CallToolResult): ToolErrorFields {
  const structured: unknown = result.structuredContent;
  if (typeof structured === 'object' && structured !== null && 'error' in structured) {
    return structured.error as ToolErrorFields;
  }
  const message = textOf(result);
  if (message.startsWith('Input validation error:')) return { kind: 'validation', message };
  throw new Error(`the error result is in neither known shape: ${JSON.stringify(result)}`);
}

/** The first text content block. */
function textOf(result: CallToolResult): string {
  const block = result.content.find((item) => item.type === 'text');
  if (block === undefined) {
    throw new Error(`the tool result has no text block: ${JSON.stringify(result)}`);
  }
  return block.text;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/support/expect.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Verify the whole project**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add test/support/expect.ts test/support/expect.test.ts
git commit -m "$(cat <<'EOF'
Add the tool result assertion helpers

expectToolError accepts both shapes a failed call can take: the registry's
structuredContent.error, and the SDK's text-only input validation error.
expectToolData also checks that the JSON text block and structuredContent
agree, which the registry promises and nothing tested.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: The test server harness

**Files:**

- Modify: `package.json` (devDependencies)
- Create: `test/support/harness.ts`
- Test: `test/support/harness.test.ts`

**Interfaces:**

- Consumes: `createFakeApi`, `Routes`, `FakeApi`, `never`, `json` from Task 1; `expectToolData`, `expectToolError` from Task 2; `loadConfig`, `Config`, `Env` from `src/config.js`; `createLogger` from `src/log.js`; `createPrintifyClient` from `src/printify/client.js`; `createServer` from `src/server.js`; `Tool` from `src/tools/define.js`; `ALL_TOOLS` from `src/tools/index.js`; `selectTools`, `serverInstructions`, `Selection` from `src/tools/select.js`; the fixture tools from `test/tools/fixtures.js`.
- Produces, from `test/support/harness.js`: `TEST_TOKEN`, `TestServerOptions`, `CallOptions`, `TestServer`, `createTestServer(options?: TestServerOptions): Promise<TestServer>`.

- [ ] **Step 1: Add the client devDependency**

Run: `npm install --save-dev @modelcontextprotocol/client@^2.0.0`
Expected: `package.json` gains `"@modelcontextprotocol/client": "^2.0.0"` under `devDependencies`, and `package-lock.json` updates. It is a devDependency because the server never constructs a client.

- [ ] **Step 2: Write the failing test**

Create `test/support/harness.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiPath } from '../../src/printify/path.js';
import { defineTool } from '../../src/tools/define.js';
import { SHOPS } from '../fixtures/shops.js';
import { createOrder, READ_ONLY } from '../tools/fixtures.js';
import { expectToolData, expectToolError } from './expect.js';
import { never } from './fake-api.js';
import { createTestServer } from './harness.js';

const listShops = defineTool({
  name: 'list_shops',
  toolset: 'shops',
  description: 'Lists the shops.',
  annotations: READ_ONLY,
  input: z.strictObject({}),
  handler: async (_input, ctx) => ({
    shops: await ctx.client.request('GET', apiPath`/v1/shops.json`, { signal: ctx.signal }),
  }),
});

// createOrder comes from the shared fixtures: it is gated on orders, which is all these tests
// need from it. Only list_shops needs a handler that reaches the fake API.
const TOOLS = [listShops, createOrder];

describe('createTestServer', () => {
  it('lists the tools and calls one end to end', async () => {
    const { mcp, api, call } = await createTestServer({
      tools: TOOLS,
      env: { PRINTIFY_ENABLE_ORDERS: 'true' },
      routes: { 'GET /v1/shops.json': SHOPS },
    });
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['list_shops', 'create_order']);
    expect(expectToolData(await call('list_shops'))).toEqual({ shops: SHOPS });
    expect(api.expectRequest('GET', '/v1/shops.json').method).toBe('GET');
  });

  it('parses env with the real loadConfig, so a gate hides a tool', async () => {
    const { mcp, selection } = await createTestServer({ tools: TOOLS });
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(['list_shops']);
    expect(selection.skipped.map(({ tool }) => tool.name)).toEqual(['create_order']);
    expect(mcp.getInstructions()).toContain('create_order');
  });

  it('narrows the tools with PRINTIFY_TOOLSETS', async () => {
    const { mcp } = await createTestServer({
      tools: TOOLS,
      env: { PRINTIFY_TOOLSETS: 'orders', PRINTIFY_ENABLE_ORDERS: 'true' },
    });
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(['create_order']);
  });

  it('throws when the environment is invalid', async () => {
    await expect(createTestServer({ env: { PRINTIFY_SHOP_ID: 'abc' } })).rejects.toThrow(
      /PRINTIFY_SHOP_ID must be a numeric shop id/,
    );
  });

  it('applies a config override after loadConfig', async () => {
    const { selection } = await createTestServer({
      tools: TOOLS,
      config: { enableOrders: true },
    });
    expect(selection.enabled.map((tool) => tool.name)).toEqual(['list_shops', 'create_order']);
  });

  it('surfaces a missing route in the tool result, with no hint', async () => {
    const { call, api } = await createTestServer({ tools: TOOLS });
    const fields = expectToolError(await call('list_shops'), { kind: 'http', status: 418 });
    expect(fields.message).toContain('no route for GET /v1/shops.json');
    expect(fields.hint).toBeUndefined();
    expect(api.takeUnmatched()).toHaveLength(1);
  });

  it('reports an SDK validation error through expectToolError', async () => {
    const { call } = await createTestServer({
      tools: TOOLS,
      routes: { 'GET /v1/shops.json': SHOPS },
    });
    const fields = expectToolError(await call('list_shops', { nope: 1 }));
    expect(fields.kind).toBe('validation');
    expect(fields.message).toContain('Input validation error:');
  });

  it('aborts the handler signal when the client cancels', async () => {
    const { call, api } = await createTestServer({
      tools: TOOLS,
      routes: { 'GET /v1/shops.json': never() },
    });
    const controller = new AbortController();
    const pending = call('list_shops', {}, { signal: controller.signal });
    await vi.waitUntil(() => api.requests.length === 1);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(api.requests[0]?.signal.aborted).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/support/harness.test.ts`
Expected: FAIL — `Failed to resolve import "./harness.js"`.

- [ ] **Step 4: Implement the harness**

Create `test/support/harness.ts`:

```ts
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/server';
import { onTestFinished } from 'vitest';
import { loadConfig, type Config, type Env } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { createPrintifyClient } from '../../src/printify/client.js';
import { createServer } from '../../src/server.js';
import type { Tool } from '../../src/tools/define.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { selectTools, serverInstructions, type Selection } from '../../src/tools/select.js';
import { createFakeApi, type FakeApi, type Routes } from './fake-api.js';

/** The token every harness server runs with. Never a real one. */
export const TEST_TOKEN = 'Tok-harness-9K8j7H6g';

export interface TestServerOptions {
  /** Defaults to `ALL_TOOLS`. */
  tools?: readonly Tool[];
  routes?: Routes;
  /** Merged over `{ PRINTIFY_API_TOKEN }` and parsed by the real `loadConfig`. */
  env?: Env;
  /** Applied after `loadConfig`, for what is awkward to express in `env`. */
  config?: Partial<Config>;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

// Function-typed properties, not methods: destructuring a method trips unbound-method.
export interface TestServer {
  /** The real MCP client. */
  mcp: Client;
  api: FakeApi;
  /** Shorthand for `mcp.callTool({ name, arguments: args }, options)`. */
  call: (
    name: string,
    args?: Record<string, unknown>,
    options?: CallOptions,
  ) => Promise<CallToolResult>;
  /** The lines the server wrote to stderr. */
  logged: readonly string[];
  selection: Selection;
  close: () => Promise<void>;
}

/**
 * Builds the server the way `cli.ts` does, over a fake Printify API, and connects a real MCP
 * client to it. Closes both and asserts that no request went unmatched when the test finishes.
 */
export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const result = loadConfig({ PRINTIFY_API_TOKEN: TEST_TOKEN, ...options.env });
  if (!result.ok) {
    throw new Error(`the test's environment is invalid:\n  ${result.errors.join('\n  ')}`);
  }
  const config: Config = { ...result.config, ...options.config };
  const api = createFakeApi(options.routes);
  const logged: string[] = [];
  const log = createLogger((line) => {
    logged.push(line);
  });
  const client = createPrintifyClient({
    token: config.token,
    baseUrl: config.apiBaseUrl,
    fetch: api.fetch,
  });
  const selection = selectTools(options.tools ?? ALL_TOOLS, config);
  const server = createServer({
    tools: selection.enabled,
    services: { client, config, log },
    instructions: serverInstructions(selection.skipped),
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'printify-mcp-test', version: '0' });
  await server.connect(serverSide);
  await mcp.connect(clientSide);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await mcp.close();
    await server.close();
  };
  onTestFinished(async () => {
    await close();
    api.assertNoUnmatched();
  });

  return {
    mcp,
    api,
    logged,
    selection,
    close,
    call: (name, args = {}, callOptions) => mcp.callTool({ name, arguments: args }, callOptions),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/support/harness.test.ts`
Expected: PASS, all tests. The cancellation test takes about 50 ms; that is the real abort round trip, not a hang.

- [ ] **Step 6: Verify the whole project**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json test/support/harness.ts test/support/harness.test.ts
git commit -m "$(cat <<'EOF'
Add createTestServer with a real MCP client

The harness builds the server the way cli.ts does, so a test's env goes
through the real loadConfig and selectTools. A client cancellation is now
covered end to end: the test asserts that the handler's own fetch signal
aborted, which no unit test could show.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Move the existing tests onto the harness

**Files:**

- Modify: `test/tools/fixtures.ts` (the `fixtureServices` and `fixtureContext` internals only)
- Modify: `test/server.test.ts` (rewritten onto the harness)
- Delete: `test/support/json-rpc.ts`

**Interfaces:**

- Consumes: everything from Tasks 1–3.
- Produces: `fixtureServices(routes?: Routes)` now returns `{ services, logged, api }`; `fixtureContext(options?: { routes?: Routes; signal?: AbortSignal })` now returns `{ ctx, logged, api }`. `FIXTURE_TOOLS`, `fixtureTool`, `fixtureConfig`, `READ_ONLY`, `WRITE`, `DESTRUCTIVE`, `TOKEN` and the named fixture tools are unchanged.

- [ ] **Step 1: Rewrite the fixtures' fake fetch**

In `test/tools/fixtures.ts`, add the import and replace `unexpectedFetch`, `fixtureServices` and `fixtureContext`. Everything above them stays exactly as it is.

Add to the imports at the top:

```ts
import { createFakeApi, type Routes } from '../support/fake-api.js';
```

Delete this function entirely:

```ts
/** Fails any test that sends a request it did not expect. */
function unexpectedFetch(): Promise<Response> {
  throw new Error('the test did not expect a Printify request');
}
```

Replace `fixtureServices` and `fixtureContext` with:

```ts
/**
 * Services whose client answers from `routes` and whose log lines land in `logged`. A request
 * that matches no route is answered with 418 and named in the result, rather than looking like a
 * network failure; `api.assertNoUnmatched()` reports it when the tool swallowed the error.
 */
export function fixtureServices(routes: Routes = {}) {
  const api = createFakeApi(routes);
  const logged: string[] = [];
  const config = fixtureConfig();
  const services: ToolServices = {
    client: createPrintifyClient({
      token: config.token,
      baseUrl: config.apiBaseUrl,
      fetch: api.fetch,
    }),
    config,
    log: createLogger((text) => {
      logged.push(text);
    }),
  };
  return { services, logged, api };
}

/** A tool call's context: `fixtureServices` plus a signal that has not aborted, by default. */
export function fixtureContext(options: { routes?: Routes; signal?: AbortSignal } = {}) {
  const { services, logged, api } = fixtureServices(options.routes);
  const ctx: ToolContext = { ...services, signal: options.signal ?? new AbortController().signal };
  return { ctx, logged, api };
}
```

- [ ] **Step 2: Run the tests that use the fixtures**

Run: `npx vitest run test/tools/run.test.ts`
Expected: PASS. `run.test.ts` only ever calls `fixtureContext()` and `fixtureContext({ signal })`, so it needs no change. `test/server.test.ts` now fails to compile, because it passes a `fetch`; Step 3 rewrites it.

- [ ] **Step 3: Rewrite the server test onto the harness**

Replace the whole of `test/server.test.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiPath } from '../src/printify/path.js';
import { defineTool } from '../src/tools/define.js';
import { notFoundBody } from './fixtures/errors.js';
import { expectToolData, expectToolError } from './support/expect.js';
import { json } from './support/fake-api.js';
import { createTestServer } from './support/harness.js';
import { FIXTURE_TOOLS, READ_ONLY, deleteProduct } from './tools/fixtures.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

const PRODUCT_ID = '5f3a1b2c3d4e5f6a7b8c9d0e';

const getProduct = defineTool({
  name: 'get_product',
  toolset: 'products',
  description: 'Gets a product.',
  annotations: READ_ONLY,
  input: z.strictObject({ product_id: z.string().regex(/^[0-9a-f]{24}$/) }),
  handler: async ({ product_id }, ctx) => ({
    product: await ctx.client.request('GET', apiPath`/v1/shops/12/products/${product_id}.json`, {
      signal: ctx.signal,
    }),
  }),
});

const PRODUCT_ROUTE = `GET /v1/shops/12/products/${PRODUCT_ID}.json` as const;

describe('createServer', () => {
  it('answers initialize with the name and version from package.json', async () => {
    const { mcp } = await createTestServer({ tools: [] });
    expect(mcp.getServerVersion()).toEqual({
      name: packageJson.name,
      version: packageJson.version,
    });
    expect(mcp.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
    expect(mcp.getInstructions()).toBeUndefined();
  });

  it('sends instructions naming the tools that are turned off', async () => {
    const { mcp } = await createTestServer({ tools: FIXTURE_TOOLS });
    expect(mcp.getInstructions()).toContain('create_order');
  });

  it('answers tools/list with an empty list when there are no tools', async () => {
    const { mcp } = await createTestServer({ tools: [] });
    expect((await mcp.listTools()).tools).toEqual([]);
  });

  it('lists a tool with its hints, openWorldHint and a strict input schema', async () => {
    const { mcp } = await createTestServer({
      tools: [deleteProduct],
      env: { PRINTIFY_ENABLE_DESTRUCTIVE: 'true' },
    });
    expect((await mcp.listTools()).tools).toEqual([
      {
        name: 'delete_product',
        description: 'Deletes a product.',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ]);
  });

  describe.each([
    ['destructive', 'delete_product', 'PRINTIFY_ENABLE_DESTRUCTIVE'],
    ['orders', 'create_order', 'PRINTIFY_ENABLE_ORDERS'],
  ] as const)('a tool gated as %s', (_gate, name, variable) => {
    it('is absent from tools/list without its flag, and the instructions name it', async () => {
      const { mcp } = await createTestServer({ tools: FIXTURE_TOOLS });
      expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain(name);
      expect(mcp.getInstructions()).toContain(name);
    });

    it('is present in tools/list with its flag', async () => {
      const { mcp } = await createTestServer({
        tools: FIXTURE_TOOLS,
        env: { [variable]: 'true' },
      });
      expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain(name);
    });
  });

  it('returns a successful call as structured content and JSON text', async () => {
    const { call, api } = await createTestServer({
      tools: [getProduct],
      routes: { [PRODUCT_ROUTE]: { id: PRODUCT_ID, title: 'Tee', sku: null } },
    });
    const result = await call('get_product', { product_id: PRODUCT_ID });
    // The null is dropped, and expectToolData checks the text block against it.
    expect(expectToolData(result)).toEqual({ product: { id: PRODUCT_ID, title: 'Tee' } });
    api.expectRequest('GET', `/v1/shops/12/products/${PRODUCT_ID}.json`);
  });

  it('returns a Printify 404 as an isError result with the hint', async () => {
    const { call, api } = await createTestServer({
      tools: [getProduct],
      routes: { [PRODUCT_ROUTE]: json(notFoundBody(), 404) },
    });
    expectToolError(await call('get_product', { product_id: PRODUCT_ID }), {
      kind: 'http',
      request: `GET /v1/shops/12/products/${PRODUCT_ID}.json`,
      status: 404,
      message: 'Not found',
      request_id: 'req-1',
      hint: 'Not found. Check the id, and that it belongs to this shop.',
    });
    // A 404 is never retried, so exactly one request was sent.
    expect(api.requests).toHaveLength(1);
  });

  it('rejects an unknown argument before the handler runs', async () => {
    const { call, api } = await createTestServer({
      tools: [getProduct],
      routes: { [PRODUCT_ROUTE]: { id: PRODUCT_ID } },
    });
    const fields = expectToolError(
      await call('get_product', {
        product_id: PRODUCT_ID,
        detial: 'full',
      }),
    );
    expect(fields.kind).toBe('validation');
    expect(fields.message).toContain(
      'Input validation error: Invalid arguments for tool get_product: Unrecognized key: "detial"',
    );
    expect(api.requests).toEqual([]);
  });
});
```

- [ ] **Step 4: Delete the JSON-RPC stand-in**

Run: `git rm test/support/json-rpc.ts`
Expected: the file is gone. It had two sharp edges the real `Client` removes: resolved entries were never deleted from its `waiting` map, and it resolved on the first message with a matching id, which would mis-route a server-to-client request because both sides start their ids at 1.

- [ ] **Step 5: Verify nothing still imports it**

Run: `grep -rn "json-rpc" test/ src/ ; echo "exit=$?"`
Expected: no matches (`exit=1` from grep means nothing found, which is what you want).

- [ ] **Step 6: Verify the whole project**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: all pass, with more tests than the 354 the branch started with and none skipped.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
Move the server test onto the harness

test/tools/fixtures.ts builds its fake fetch from createFakeApi, so an
unplanned request now names the route that was missing instead of
reporting that Printify could not be reached. The raw JSON-RPC stand-in
is deleted rather than fixed: the real Client owns id allocation.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Document the harness in CONTRIBUTING.md

**Files:**

- Create: `CONTRIBUTING.md`

**Interfaces:**

- Consumes: everything from Tasks 1–4. The worked example must be code that actually runs; verify it against `test/support/harness.test.ts` rather than inventing new API.
- Produces: nothing importable. #7 will add an "Adding a tool" section beneath this one.

- [ ] **Step 1: Write the file**

Create `CONTRIBUTING.md`:

````markdown
# Contributing

Thanks for helping out. This guide covers getting set up and how the project is tested.

## Getting started

Node 22 or newer is required.

```bash
npm ci          # install exactly what package-lock.json pins
npm test        # run the test suite once
npm run lint    # eslint, then prettier --check
npm run typecheck
npm run build   # compile to dist/
```

`npm test` runs vitest once. Use `npx vitest` for watch mode, or
`npx vitest run test/path/to/one.test.ts` for a single file.

## How this project is tested

Everything is unit tested, and nothing in the suite talks to Printify.

- **Plain unit tests** for pure functions — config parsing, retry policy, response shaping. They
  import the function and call it. See `test/tools/shape.test.ts`.
- **The harness** for anything that goes through a tool or the wire. It runs the real server with
  a real MCP client and a fake Printify API. See below.
- **Live tests** against the real API are not implemented yet (`npm run test:live` exits with a
  message). They are tracked in issue #20 and will be read-only.

## The test harness

`createTestServer` builds the server the way `src/cli.ts` does — the real configuration parsing,
the real toolset and gate selection, the real registry — over a fake Printify API, and connects a
real MCP client to it. A test therefore exercises the same path a user's client would.

### A worked example

```ts
import { describe, expect, it } from 'vitest';
import { SHOPS } from '../fixtures/shops.js';
import { expectToolData } from '../support/expect.js';
import { createTestServer } from '../support/harness.js';
import { listShopsTool } from '../../src/tools/shops.js';

describe('list_shops', () => {
  it('returns the shops', async () => {
    const { call, api } = await createTestServer({
      tools: [listShopsTool],
      routes: { 'GET /v1/shops.json': SHOPS },
    });

    const result = await call('list_shops');

    expect(expectToolData(result)).toEqual({ shops: SHOPS });
    api.expectRequest('GET', '/v1/shops.json');
  });
});
```

There is no cleanup to write. The harness closes the client and the server when the test
finishes, and fails the test if any request matched no route.

### `createTestServer(options)`

| Option   | Meaning                                                                           |
| -------- | --------------------------------------------------------------------------------- |
| `tools`  | The tools to offer. Defaults to `ALL_TOOLS`.                                      |
| `routes` | The fake Printify API's route table.                                              |
| `env`    | Environment variables, merged over the token and parsed by the real `loadConfig`. |
| `config` | Overrides applied after `loadConfig`, for what `env` cannot express.              |

It returns:

| Property    | Meaning                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `mcp`       | The real MCP `Client`: `listTools()`, `getInstructions()`, `callTool()`. |
| `call`      | Shorthand: `call('list_shops', { page: 2 })`.                            |
| `api`       | The fake Printify API — the recorded requests and `expectRequest`.       |
| `logged`    | The lines the server wrote to stderr.                                    |
| `selection` | What `selectTools` enabled and skipped.                                  |

Use `env` rather than `config` where you can, because it goes through the real parser:

```ts
await createTestServer({ env: { PRINTIFY_TOOLSETS: 'shops', PRINTIFY_ENABLE_ORDERS: 'true' } });
```

### Declaring routes

A route key is the method, one space, and the exact pathname. The query string is **not** part of
matching — it is recorded, and responders can read it.

```ts
routes: {
  // A plain value is sent as a 200 JSON body.
  'GET /v1/shops.json': SHOPS,

  // json() sets a status.
  'GET /v1/shops/12/products/abc.json': json(notFoundBody(), 404),

  // A function is called with the request.
  'GET /v1/shops/12/products.json': (request) => productPage(request.query.page),

  // inTurn() answers a sequence, then repeats the last reply — for retries.
  'POST /v1/shops/12/orders.json': inTurn(json({}, 429), json(ORDER, 201)),

  // empty() is a 204, as a delete returns.
  'DELETE /v1/shops/12/products/abc.json': empty(),
}
```

Computed keys work, so ids can come from a constant:

```ts
routes: { [`GET /v1/shops/${SHOP.id}/products.json`]: PRODUCTS }
```

The other response helpers are `text(body, status)` for a body that is not JSON, `fails(error)`
for a network failure, and `never()` for a server that answers only when the request is cancelled.

**A request that matches no route** is answered with `418` and a body naming the missing route and
listing the ones you declared, so the tool result says exactly what was missing. The test also
fails at the end if any request went unmatched. When a test provokes a miss on purpose, consume it
with `api.takeUnmatched()`.

### Asserting

```ts
// Exactly one matching request; returns it, so you can assert further.
const request = api.expectRequest('POST', '/v1/shops/12/orders.json', { external_id: 'abc' });
expect(request.query).toEqual({ limit: '10' });

// A successful result. Also checks the JSON text block against structuredContent.
const data = expectToolData(result);

// An error result, in either shape a failure can take.
expectToolError(result, { kind: 'http', status: 404 });
expectToolError(result, { kind: 'validation' }); // the SDK's input validation error
```

`expectToolError` normalises both shapes: the registry's `structuredContent.error` (with `kind`,
`status`, `code`, `message`, `reason`, `request_id`, `hint`), and the SDK's text-only
`Input validation error: …`, which becomes `kind: 'validation'`.

## Fixtures

Printify response fixtures live in `test/fixtures/`, one module per resource, each built from the
documented response example. A module exports the example as a constant and a builder that takes
overrides:

```ts
export const SHOP = { id: 5432, title: 'My new store', sales_channel: 'My Sales Channel' };
export const SHOPS = [SHOP, DISCONNECTED_SHOP];

export function shop(overrides: Partial<typeof SHOP> = {}): typeof SHOP {
  return { ...SHOP, ...overrides };
}
```

Add a module when you add the toolset that needs it — `test/fixtures/orders.ts` with the orders
tools, and so on. Keep a fixture to the fields tools actually read, and take the shape from
Printify's documentation rather than from a guess.
````

- [ ] **Step 2: Check the example compiles against the real API**

Read `test/support/harness.test.ts` and confirm every name the document uses exists with that
signature: `createTestServer`, `call`, `api.expectRequest`, `api.takeUnmatched`, `expectToolData`,
`expectToolError`, `json`, `empty`, `inTurn`, `text`, `fails`, `never`. The `listShopsTool` import
in the worked example is deliberately a tool that does not exist yet (#7 adds it); everything else
must be real.

- [ ] **Step 3: Verify formatting and the whole project**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: all pass. Prettier checks Markdown, so `CONTRIBUTING.md` must already be formatted; run
`npm run format` if it complains.

- [ ] **Step 4: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "$(cat <<'EOF'
Document the test harness in CONTRIBUTING.md

Covers getting set up, when to use a unit test and when to use the
harness, the route table and its response helpers, the assertion helpers
and the fixture pattern. #7 adds the "Adding a tool" section.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Finishing the branch

- [ ] **Full verification**

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

All five must pass before any claim that the work is done.

- [ ] **Check the commit trailers**

```bash
git log --format='%h %s | %(trailers:only,unfold)' origin/main..HEAD
```

Every commit must end with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.

- [ ] **Open the pull request**

Push the branch and open a PR whose body ends with `Closes #6` and the line
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Move the issue to In review on
[project 8](https://github.com/users/ARau87/projects/8). Watch CI on Node 22 and 24.

- [ ] **Hand off to the toolset issues**

Comment on #7, saying it applies to #7–#19: the worked example from `CONTRIBUTING.md`, the rule
that route keys ignore the query, that an unmatched request surfaces as a 418 naming the route,
and that `expectToolError` takes both error shapes. One comment rather than thirteen.
