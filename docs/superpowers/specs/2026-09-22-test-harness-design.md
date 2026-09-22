# Test harness — in-memory MCP client and fake Printify API — design

- **Issue:** [#6 Test harness — in-memory MCP client and fake Printify API](https://github.com/ARau87/printify-mcp/issues/6)
- **Date:** 2026-09-22
- **Status:** approved

## Goal

Ten toolset issues (#7–#19) will each be built test-first, and each needs the same two things: a
way to call a tool exactly as an MCP client would, and a way to assert on the HTTP requests that
reached Printify. Without a shared harness every issue invents its own fake `fetch` — the
repository already has three variants of one. This issue builds the harness once, documents it so
the toolset issues can use it without rediscovering it, and moves the existing server test onto
it.

It also closes the three follow-ups the #5 review parked here: no end-to-end cancellation
coverage, the swallowed `unexpectedFetch` guard, and the two sharp edges in the raw JSON-RPC
stand-in.

## Facts this design relies on

Verified on 2026-09-22 with a throwaway vitest probe against `@modelcontextprotocol/client`
2.0.0, `@modelcontextprotocol/server` 2.0.0 and vitest 5.0.1. The probe was deleted; none of it is
committed.

- **Client surface.** `new Client({ name, version })` followed by `await client.connect(transport)`
  completes the handshake. `getInstructions()`, `getServerVersion()` and
  `getServerCapabilities()` return the server's initialize data. `listTools()` resolves to
  `{ tools }`. `callTool({ name, arguments }, options)` resolves to
  `{ content, structuredContent, isError? }`.
- **Cancellation works end to end.** `callTool(params, { signal })` rejects with
  `SdkError: AbortError: This operation was aborted` once the signal aborts, and the tool handler's
  `AbortSignal` — the one `client.request` hands to `fetch` — reports `aborted: true` with an
  `AbortError` reason. No part of that path needs mocking.
- **No client-side list caching by default.** Two `listTools()` calls put two `tools/list`
  requests on the wire.
- **A 418 reply is inert.** `hintFor` gives it no hint (only 401, 403, 404, 409, 429 and 5xx have
  one) and `shouldRetry` never retries it, so it arrives as `kind: 'http'`, `status: 418` with its
  message intact after exactly one `fetch`. Any 5xx would instead carry "Printify had a server
  error. Try again in a moment.", which would read as a Printify outage rather than a test bug.
- **A throw in `onTestFinished` fails the test** and reports the thrown message as the failure.
- **The two error result shapes** are as #5's notes describe: the registry's
  `structuredContent.error`, and the SDK's text-only
  `Input validation error: Invalid arguments for tool <name>: …` with no `structuredContent`.

## Decisions that differ from the issue

1. **Two modules, not one.** The issue describes a single `createTestServer`. The fake API is
   split out as `createFakeApi(routes)`, which knows nothing about MCP, because
   `test/tools/fixtures.ts` needs the same fake `fetch` for tests that build a `ToolContext`
   without a server. That gives one definition of "an unexpected request" and one recorder rather
   than two.
2. **Sequences and statuses are explicit, never inferred.** `'GET /v1/shops.json': shops` must not
   mean "answer these requests in turn": that endpoint returns a JSON array. A `{ status, body }`
   wrapper cannot be detected by shape either, because Printify's documented error envelope has a
   `status` key. So a bare value is always a 200 JSON body, `inTurn(...)` makes a sequence, and
   `json(body, status)` sets a status.
3. **Query strings take no part in route matching.** They are recorded and handed to responders.
   Pagination tests use `inTurn` or read `req.query.page` instead of declaring one route per page.
4. **An unmatched request is answered, not thrown.** Throwing inside `client.request`'s `try` is
   exactly what makes today's guard report "could not reach Printify" with the real message buried
   in `cause`. The fake API answers 418 with a body naming the missing route and listing the
   declared ones, and records it for the teardown assertion.
5. **Three fixture modules, not seven.** The issue lists shops, blueprint, variants, product,
   order, upload and webhook. Fixtures for tools nobody has written are guesses about which fields
   those tools trim and assert on. #6 writes what its own tests need and documents the pattern, so
   each toolset issue adds its own.
6. **The harness returns the real `Client`,** plus a `call(name, args, options?)` shorthand,
   because roughly fifty tool tests will type it. There is no wrapper to keep in sync with the SDK.
7. **`test/tools/fixtures.ts` stays where it is.** Moving it under `test/support/` would edit the
   imports of five unrelated test files for no behavioural gain. Only its internals change.
8. **`test/printify/client.test.ts` keeps its own `fakeFetch`.** It asserts on headers, signal
   identity, retry timing under fake timers and non-JSON bodies — everything a route map
   deliberately hides.

## Files

<!-- prettier-ignore -->
```
test/support/fake-api.ts      new      createFakeApi and the response helpers
test/support/harness.ts       new      createTestServer
test/support/expect.ts        new      expectToolData, expectToolError
test/support/harness.test.ts  new      the harness's own tests
test/support/json-rpc.ts      deleted  replaced by the real Client
test/fixtures/shops.ts        new      SHOP, SHOPS, shop(overrides)
test/fixtures/products.ts     new      PRODUCT, product(overrides)
test/fixtures/errors.ts       new      both documented error envelopes
test/tools/fixtures.ts        changed  internals rebuilt on the fake API
test/server.test.ts           changed  moved onto the harness
package.json                  changed  devDependency @modelcontextprotocol/client ^2.0.0
CONTRIBUTING.md               new      how to test this project
```

`@modelcontextprotocol/client` ^2.0.0 is the only new dependency, and it is a devDependency: the
server itself never constructs a client. No runtime dependency changes.

## The fake Printify API

`createFakeApi(routes)` returns a fake `fetch` to hand to `createPrintifyClient`, plus the
recorded requests and an assertion helper.

<!-- prettier-ignore -->
```ts
export type RouteKey = `${HttpMethod} /${string}`;

export interface FakeRequest {
  method: string;
  /** The pathname only: no base URL, no query. */
  path: string;
  query: Record<string, string>;
  headers: Headers;
  /** The parsed JSON body, or `undefined` when there was none. */
  body: unknown;
  /** The signal the client passed to `fetch`, not the `Request` copy. */
  signal: AbortSignal;
}

export type Responder = (request: FakeRequest) => Response | Promise<Response>;

/**
 * What a route answers with. Discriminated at runtime, not by the type: a `Response` is used as
 * is, a `Responder` is called, and anything else is sent as a 200 JSON body. Writing it as a
 * union would be a lie — `unknown` absorbs the other two members.
 */
export type Route = unknown;

export interface FakeApi {
  fetch: typeof globalThis.fetch;
  requests: readonly FakeRequest[];
  /** Requests that matched no route. */
  unmatched: readonly FakeRequest[];
  /** Asserts exactly one matching request and returns it. */
  expectRequest(method: HttpMethod, path: string, body?: unknown): FakeRequest;
  /** Throws, listing them, when any request went unmatched. Called by the teardown hook. */
  assertNoUnmatched(): void;
}

export function createFakeApi(routes?: Readonly<Record<RouteKey, Route>>): FakeApi;
```

### Matching

The key is a literal `METHOD /pathname`, compared against the request's method and
`new URL(url).pathname`. The query string never takes part. Route keys are validated on
construction: a key that is not `METHOD /path` throws at once, so a typo fails where it was
written rather than as a missing route later.

Matching is on the whole pathname, which equals the `ApiPath` only while the base URL has no path
of its own. A test that sets a proxy-prefixed `PRINTIFY_API_BASE_URL` must include that prefix in
its route keys.

### Response helpers

<!-- prettier-ignore -->
```ts
json(body: unknown, status = 200, headers?: Record<string, string>): Response
text(body: string, status = 200): Response
empty(status = 204): Response
inTurn(...replies: Route[]): Responder   // nth request gets the nth reply, then the last repeats
fails(cause?: unknown): Responder        // rejects, for the network-error and retry paths
never(): Responder                       // answers only once the request's signal aborts
```

`never()` is lifted from `test/printify/client.test.ts`, where it already exists as
`neverAnswer`; the cancellation and timeout tests need it. `inTurn` repeating its last reply
matches the existing helper's behaviour, so a retry test does not have to count attempts.

### Declaring routes

<!-- prettier-ignore -->
```ts
const api = createFakeApi({
  'GET /v1/shops.json': SHOPS,                              // 200, JSON array
  'GET /v1/catalog/blueprints/6.json': json(NOT_FOUND, 404),
  'GET /v1/shops/12/products.json': (req) => json(productPage(req.query.page)),
  'POST /v1/shops/12/orders.json': inTurn(json({}, 429), json(ORDER, 201)),
  'DELETE /v1/shops/12/products/abc.json': empty(),
});
```

### Unmatched requests

The request is recorded in `api.unmatched` and answered with 418 and the body

<!-- prettier-ignore -->
```json
{ "error": "printify-mcp test harness: no route for GET /v1/shops/13/products.json. Declared routes: GET /v1/shops.json, POST /v1/shops/12/orders.json" }
```

so the tool result itself carries the diagnosis: `kind: 'http'`, `status: 418`, that message, and
no hint. `createTestServer` additionally fails the test in teardown when `api.unmatched` is
non-empty, so a stray request cannot pass silently even when the tool under test swallowed the
error. This is what replaces today's `unexpectedFetch`, whose message is lost inside
`networkError.cause`.

### Recording

Every request is recorded before it is answered, unmatched ones included.
`expectRequest(method, path, body?)` asserts that exactly one request matched — which is how a
broken cache is caught in #7 — and returns it, so the test can go on to assert on `query` or
`headers`. With `body`, the recorded body is matched with `toMatchObject`. Anything more
elaborate reads `api.requests` directly.

## The test server

`createTestServer(options)` assembles the server the way `cli.ts` does, so tests exercise the real
configuration and selection paths instead of a parallel wiring of their own.

<!-- prettier-ignore -->
```ts
export interface TestServerOptions {
  /** Defaults to ALL_TOOLS. */
  tools?: readonly Tool[];
  routes?: Readonly<Record<RouteKey, Route>>;
  /** Merged over { PRINTIFY_API_TOKEN }, then parsed by the real loadConfig. */
  env?: Env;
  /** Applied after loadConfig, for what is awkward to express in env. */
  config?: Partial<Config>;
}

export interface TestServer {
  /** The real MCP Client. */
  mcp: Client;
  api: FakeApi;
  /** Shorthand for mcp.callTool({ name, arguments: args }, options). */
  call(name: string, args: Record<string, unknown>, options?: CallToolRequestOptions):
    Promise<CallToolResult>;
  /** The stderr lines the server logged. */
  logged: readonly string[];
  /** selectTools' result, for assertions that need no round trip. */
  selection: Selection;
  close(): Promise<void>;
}

export function createTestServer(options?: TestServerOptions): Promise<TestServer>;
```

Internally, in this order:

<!-- prettier-ignore -->
```ts
const config = { ...loadConfig({ PRINTIFY_API_TOKEN: TOKEN, ...env }).config, ...configOverrides };
const api = createFakeApi(routes);
const client = createPrintifyClient({ token: config.token, baseUrl: config.apiBaseUrl, fetch: api.fetch });
const selection = selectTools(tools ?? ALL_TOOLS, config);
const server = createServer({
  tools: selection.enabled,
  services: { client, config, log },
  instructions: serverInstructions(selection.skipped),
});
// InMemoryTransport.createLinkedPair(), server.connect, client.connect
```

Configuration comes from `env` first, so `{ PRINTIFY_TOOLSETS: 'shops' }` or
`{ PRINTIFY_ENABLE_DESTRUCTIVE: 'true' }` exercises the real parser and gives toolset and gate
coverage without a second code path. A config error throws from `createTestServer` naming the
problem, because a test that misconfigures the server should say so rather than fail later with a
missing tool. The `config` override stays for what env cannot express conveniently, such as
`uploadDirs`, which needs directories that exist.

`tools` defaults to `ALL_TOOLS`, so a toolset test is realistic by default and can still pass a
subset or the fixture tools.

### Teardown

`createTestServer` registers `onTestFinished` to close the client and the server and then call
`api.assertNoUnmatched()`, which throws and so fails the test. Tests therefore never call
`close()` themselves; it stays on the interface for the rare test that wants to observe a closed
transport. `assertNoUnmatched` being a method rather than inline teardown logic is what lets the
harness's own test cover the check without trying to assert its own failure.

### Cancellation

The end-to-end coverage #5 left open:

<!-- prettier-ignore -->
```ts
const { call, api } = await createTestServer({ routes: { 'GET /v1/shops.json': never() } });
const controller = new AbortController();
const pending = call('list_shops', {}, { signal: controller.signal });
await vi.waitUntil(() => api.requests.length === 1);
controller.abort();
await expect(pending).rejects.toThrow(/abort/i);
expect(api.requests[0]?.signal.aborted).toBe(true);
```

The last assertion is the one that matters: the abort travelled from the client through
`notifications/cancelled`, `ctx.mcpReq.signal`, `runTool` and `client.request` to `fetch`. The
request does match a declared route, so it never reaches `api.unmatched` and the teardown check
stays quiet.

## Assertions

`test/support/expect.ts` holds two helpers. Both return what they assert on, so a test can narrow
further.

<!-- prettier-ignore -->
```ts
/** Asserts a successful result, that its text block and structuredContent agree, returns the data. */
export function expectToolData(result: CallToolResult): Record<string, unknown>;

/** Normalises both error shapes and, with `expected`, matches the result against it. */
export function expectToolError(result: CallToolResult, expected?: Partial<ToolErrorFields>): ToolErrorFields;

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
```

`expectToolData` checking that the JSON text block parses to the same object as
`structuredContent` is worth its line: the registry promises they agree and nothing currently
tests it.

`expectToolError` covers both shapes #5's notes call out. A registry error is read from
`structuredContent.error`. An SDK input-validation error has no `structuredContent` and only a
text block starting `Input validation error:`; it becomes `kind: 'validation'` with that text as
the message. A result that is not an error, or an error in neither shape, fails with the whole
result in the message.

## Fixtures

One module per Printify resource under `test/fixtures/`, each exporting a constant built from the
documented response example and a builder that takes overrides:

<!-- prettier-ignore -->
```ts
export const SHOP = { id: 12, title: 'My shop', sales_channel: 'etsy' };
export const SHOPS = [SHOP, { id: 13, title: 'API shop', sales_channel: 'disconnected' }];
export const shop = (overrides: Partial<typeof SHOP> = {}) => ({ ...SHOP, ...overrides });
```

#6 writes three:

- `shops.ts` — the documented shop list, including one `disconnected` shop, which #7's resolution
  branches need.
- `products.ts` — one product, with the `null` fields that prove `dropNulls` runs.
- `errors.ts` — both documented envelopes as builders: `apiErrorBody({ code, message, reason })`
  for `{ status: 'error', code, message, errors: { reason, code } }`, and
  `notFoundBody({ error, request_id })` for the 401 and 404 shape.

Each toolset issue adds the module it needs, following the same pattern. Fixtures are TypeScript
rather than JSON so that builders, shared sub-objects and type inference are available, and so
prettier and eslint cover them like the rest of the suite.

## CONTRIBUTING.md

A new file at the repository root, and the only documentation this issue writes. #21 owns the
README; #7 adds the "Adding a tool" section on top of this one.

1. **Getting started** — Node 22, `npm ci`, and what `npm test`, `npm run lint`,
   `npm run typecheck` and `npm run build` each do.
2. **How this project is tested** — plain unit tests for pure functions, the harness for anything
   that goes through a tool or the wire, and `npm run test:live` as out of scope until #20.
3. **The test harness** — one complete worked example first, then a reference for
   `createTestServer`, the route table, the response helpers, `expectRequest`, `expectToolData`
   and `expectToolError`.
4. **Fixtures** — the pattern above and where a new resource module goes.

## Tests

### `test/support/harness.test.ts`

The harness's own coverage, written against the fixture tools rather than real ones so it does not
change when toolsets land:

- lists tools and calls one tool end to end, asserting the request reached the fake API — the
  issue's first acceptance criterion in one test;
- serves a bare value as a 200 JSON body, a `json(body, status)` as that status, and `empty()` as
  an empty body;
- answers a sequence with `inTurn`, and repeats the last reply after it is exhausted;
- passes the query to a responder without the query affecting matching;
- rejects a malformed route key at construction;
- answers an unmatched request with 418, records it in `api.unmatched`, and surfaces the missing
  route in the tool result's message;
- `assertNoUnmatched` throws and names every unmatched request — called directly, since a test
  cannot assert its own teardown failure;
- `expectRequest` matches on method, path and body, and its failure message lists the recorded
  requests;
- `expectToolData` rejects a result whose text block and `structuredContent` disagree;
- `expectToolError` normalises a registry error and an SDK validation error;
- `env` reaches the real `loadConfig`: `PRINTIFY_TOOLSETS` and the gate flags change which tools
  are listed, and an invalid value throws from `createTestServer`;
- a client cancellation aborts the handler's signal, as above.

### `test/server.test.ts`

The existing assertions, rewritten on the harness: initialize data, instructions, the empty tool
list, a tool's listed shape and annotations, gated tools present or absent, a successful call, a
404 with its hint, and an unknown argument rejected before the handler runs. Its local
`fakeFetch`, its `serve` helper and its `getProduct` tool are replaced by routes and the fixture
tools; the `await mcp.close()` calls go away with the teardown hook.

### `test/tools/fixtures.ts`

`fixtureServices()` and `fixtureContext()` build their `fetch` from `createFakeApi`, and both
accept routes. Their existing callers pass nothing and keep working, except that an unplanned
request now fails with the route that was missing instead of "could not reach Printify". The
existing tests in `test/tools/` are otherwise untouched.

## Acceptance criteria mapping

| Requirement                                             | Covered by                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `createTestServer(config, routes)` with a fake `fetch`  | `createTestServer`, `createFakeApi`                                 |
| An MCP `Client` over `InMemoryTransport`                | `createTestServer`, devDependency on `@modelcontextprotocol/client` |
| The client plus the recorded requests                   | `TestServer.mcp`, `TestServer.api.requests`                         |
| Routes as `method + path → response`                    | The route table                                                     |
| Unmatched requests fail the test                        | 418 reply, `api.unmatched`, the teardown check                      |
| Fixtures from documented response examples              | `test/fixtures/`, three modules and the documented pattern          |
| `expectRequest(method, path, bodyMatcher)`              | `FakeApi.expectRequest`                                             |
| `expectToolError(result, code)`                         | `expectToolError`, accepting both error shapes                      |
| A sample test lists tools and calls one tool end to end | `harness.test.ts`, first test                                       |
| The harness is documented                               | `CONTRIBUTING.md`                                                   |

## Out of scope

| Topic                                                           | Where                      |
| --------------------------------------------------------------- | -------------------------- |
| Fixtures for blueprints, variants, orders, uploads and webhooks | #8, #14, #10 and #16       |
| The "Adding a tool" section of `CONTRIBUTING.md`                | #7                         |
| Composing `ALL_TOOLS` from per-toolset arrays                   | #7                         |
| Live, read-only integration tests against the real API          | #20                        |
| README, installation and the tool reference                     | #21                        |
| `:param` patterns in route keys                                 | Not planned; literal paths |
| Migrating `test/printify/client.test.ts` onto the harness       | Not planned                |
| Snapshot testing and a golden-file tool reference               | Not planned                |

## Delivery

1. Branch `feat/6-test-harness` from `origin/main`, which now carries #5 (57869ad). This spec is
   its first commit.
2. Implementation plan via the writing-plans skill, then test-first implementation.
3. Local verification before any claim of success: `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test` and `npm run build`.
4. PR with `Closes #6`, moved to In review on the project board. Watch its CI run on Node 22 and 24.
5. Comment on the issues that build on this — one comment on #7 covering #7–#19, since the harness
   is used the same way by all of them — with the worked example, the route table rules and the
   two assertion helpers.
