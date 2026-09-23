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
finishes, and fails the test if any request matched no route. That teardown hooks itself to the
running test, so call `createTestServer` inside the `it`, not in `beforeAll`, and don't combine it
with `.concurrent`.

### `createTestServer(options)`

| Option   | Meaning                                                                           |
| -------- | --------------------------------------------------------------------------------- |
| `tools`  | The tools to offer. Defaults to `ALL_TOOLS`.                                      |
| `routes` | The fake Printify API's route table.                                              |
| `env`    | Environment variables, merged over the token and parsed by the real `loadConfig`. |
| `config` | Overrides applied after `loadConfig`, for what `env` cannot express.              |

It returns:

| Property    | Meaning                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------- |
| `mcp`       | The real MCP `Client`: `listTools()`, `getInstructions()`, `callTool()`.                  |
| `call`      | Shorthand: `call('list_shops', { page: 2 })`.                                             |
| `api`       | The fake Printify API — the recorded requests and `expectRequest`.                        |
| `logged`    | The lines the tools and the registry logged during a call (not `cli.ts`'s startup lines). |
| `selection` | What `selectTools` enabled and skipped.                                                   |
| `close`     | Closes the client and server. Called automatically on test finish.                        |

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

The other response helpers are `text(body, status)` for a body that is not JSON, `fails(cause)`
for a network failure, and `never()` for a server that answers only when the request is cancelled.

**Retries wait on real timers.** `src/printify/client.ts` awaits `sleep(...)` between attempts, so
a route that makes the client retry costs real wall-clock time: roughly 500–1000 ms for one 429
retry like the `orders.json` example above, and roughly 1.5–3 s across all attempts for `fails()`
on an idempotent method (GET, PUT, DELETE), which retries on every attempt. Thirteen tests copying
that pattern add up. To make a 429 retry immediate, send `retry-after: 0`:

```ts
'POST /v1/shops/12/orders.json': inTurn(json({}, 429, { 'retry-after': '0' }), json(ORDER, 201)),
```

`parseRetryAfter` in `src/printify/retry.ts` reads `'0'` as 0 ms, so the client retries at once
instead of backing off. `vi.useFakeTimers()` is the alternative when a retry-after header cannot
avoid the wait, but reach for it only then: the client's 30 s `AbortSignal.timeout` and the MCP
client's own request timeout both interact badly with fake timers.

**A request that matches no route** is answered with `418` and a body naming the missing route and
listing the ones you declared, so the tool result says exactly what was missing. The test also
fails at the end if any request went unmatched. When a test provokes a miss on purpose, consume it
with `api.takeUnmatched()`.

### Asserting

```ts
// Exactly one matching request; returns it, so you can assert further. The body is matched
// partially (toMatchObject): extra keys pass. For an exact check, assert on request.body with
// toEqual instead.
const request = api.expectRequest('POST', '/v1/shops/12/orders.json', { external_id: 'abc' });
expect(request.query).toEqual({ limit: '10' });

// A successful result. Also checks the JSON text block against structuredContent.
const data = expectToolData(result);

// An error result, in either shape a failure can take.
expectToolError(result, { kind: 'http', status: 404 });
expectToolError(result, { kind: 'validation' }); // the SDK's input validation error
```

`expectToolError` normalises both shapes: the registry's `structuredContent.error` (with `kind`,
`request`, `status`, `code`, `message`, `reason`, `request_id`, `retry_after_seconds`, `hint`),
and the SDK's text-only `Input validation error: …`, which becomes `kind: 'validation'`.

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

## Adding a tool

Tools are grouped into toolsets (`src/toolsets.ts`), and each toolset lives in one file,
`src/tools/<toolset>.ts`. `src/tools/shops.ts` is a small, complete example.

### Define it

Use `defineTool` from `src/tools/define.ts`:

- `name` in snake_case, and the `toolset` it belongs to.
- `description`, written for the model: what the tool does, when to use it and what it costs.
- All three `annotations` hints: `readOnlyHint`, `destructiveHint` and `idempotentHint`.
  `openWorldHint` is added for you.
- `gate: 'orders'` for a tool that spends money, `gate: 'destructive'` for one that cannot be
  undone (it also needs `destructiveHint: true`). A read-only tool has no gate. A gated tool is
  registered only when the user sets `PRINTIFY_ENABLE_ORDERS` or `PRINTIFY_ENABLE_DESTRUCTIVE`.
- `input`, a `z.strictObject`, so a misspelt argument is rejected rather than dropped.
- `handler(input, ctx)`. Pass `{ signal: ctx.signal }` to `ctx.client.request`, and return a plain
  object, never an array: `{ shops: [...] }`. The registry drops nulls and sends the object as
  `structuredContent` and as JSON text. Drop heavy fields yourself; `omitKeys` in
  `src/tools/shape.ts` helps.

Let a `PrintifyApiError` propagate: the registry turns it into an error result with a hint. Throw
`new ToolError(message, hint)` for a deliberate refusal. Keep tokens out of both.

State that lives as long as the process, like the shop cache, belongs in `ToolServices`, which
`src/cli.ts` creates once. Never keep it in module scope or create it in `createServer`.

### Resolve the shop

A shop-scoped tool spreads `shopIdInput` from `src/tools/shop-id.ts` into its input and starts
its handler with `resolveShopId`:

```ts
input: z.strictObject({ ...shopIdInput, product_id: z.string() }),
handler: async (input, ctx) => {
  const shopId = await resolveShopId(input, ctx);
  // apiPath`/v1/shops/${shopId}/products/${input.product_id}.json`
},
```

`resolveShopId` uses `shop_id`, else `PRINTIFY_SHOP_ID`, else the account's only shop. Otherwise
it refuses with a `ToolError` that lists the shops. Only the last case costs a request, and the
shop list is cached for the process. A destructive tool that acts on a whole shop, like
`disconnect_shop`, takes a required `shop_id` instead, so it never acts on a shop the model did not
name.

### Wire it in

Export the toolset's tools as `<toolset>Tools` and replace the toolset's `[]` in
`TOOLS_BY_TOOLSET` in `src/tools/index.ts`. `ALL_TOOLS` is derived from that record in `TOOLSETS`
order, so two toolsets never edit the same line. `test/tools/catalog.test.ts` checks every tool
against the rules above, and that each one is filed under its own toolset.

### Test it

Test through the harness with the default tools, so every test goes through `ALL_TOOLS` and a tool
that was never wired in fails its own tests. Pass `tools` only to add a fixture tool next to the
real ones, e.g. `tools: [...ALL_TOOLS, getShopId]`. `test/tools/shops.test.ts` is a complete
example, gated tool included.
