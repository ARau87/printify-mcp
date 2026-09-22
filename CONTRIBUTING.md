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
