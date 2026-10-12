# Orders Toolset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `orders` toolset: `list_orders`, `get_order` and `calculate_shipping` without a
gate, and `create_order`, `create_express_order`, `send_order_to_production` and `cancel_order`
behind `PRINTIFY_ENABLE_ORDERS`, with `external_id` as the idempotency key and addresses kept out
of results unless asked for.

**Architecture:** The layered layout of the products and publishing toolsets. A request module
`src/printify/orders.ts` owns the Printify schemas and the seven HTTP calls, and turns the
documented 409 duplicate into a normal `created: false` result by reading a new non-enumerable
`body` field on `PrintifyApiError`. Two pure modules, `src/tools/shipping-method.ts` (catalog
method names to order codes, and the transitional shipping-quote keys to rows) and
`src/tools/order-summary.ts` (rows and summaries with the address stripped), carry the logic
that is unit-tested on its own. `src/tools/orders.ts` is the thin tool file.

**Tech Stack:** TypeScript ~6.0, Zod 4, `@modelcontextprotocol/server` v2, Vitest, ESLint +
Prettier (`npm run lint` also checks `docs/`).

**Spec:** `docs/superpowers/specs/2026-10-08-orders-toolset-design.md`

Every code block below was written in the worktree, formatted with Prettier, and verified with
`npm run lint`, `npm run typecheck` and `npm test` (796 → 876 tests) before the prototype was
discarded. Copy the blocks as they are. Eight deliberate mutations of the production code (dropping
the economy refusal, the cancel pre-check, the address option, the final-spelling express rule,
the conflict handling, the non-enumerable body, the cancel gate and the status/code check in
`existingOrderId`) each turned at least one test red.

## Global Constraints

- Work in the worktree `../printify-mcp-worktrees/14-orders-toolset` on branch
  `feat/14-orders-toolset`. Check `git symbolic-ref --short HEAD` before every commit.
- Node >= 22; TypeScript `~6.0`; Zod 4 (`z.strictObject`, `z.looseObject`, `z.url()`; a
  `z.unknown()` key needs `.optional()`).
- Every tool: `defineTool`, snake_case name, all three annotation hints, a `z.strictObject`
  input, `{ signal: ctx.signal }` on every request, a plain object returned (never an array).
- Shipping method names are `standard`, `priority`, `express`, `economy` (`SHIPPING_METHODS`
  from `src/printify/catalog.ts`); `express` is Printify Express, code 3.
- Gated tools carry `gate: 'orders'` and `destructiveHint: true`; nothing else in this plan is
  gated.
- Prettier formats Markdown and the TypeScript inside it; the plan's blocks are already
  formatted. Run `npx prettier --write` on every file you create before linting.
- Never commit with a real token anywhere; the fixtures use `Tok-…` strings.
- Commit messages end with the model's `Co-Authored-By` trailer (see each commit step).

## Review Focus

Inputs the spec implies but did not list a test for; each now has a test in the task named.

1. `quantity: 0` on a line item must be a validation error, not an order for nothing — Task 5,
   the `create_order` rejection table ("a quantity of zero").
2. A three-letter country such as `USA` must be rejected before Printify's 8103 — Task 5,
   the rejection table ("a three-letter country").
3. An on-the-fly `print_areas` position with an empty array must be rejected: Printify would
   create a blank product — Task 5, the rejection table ("an empty print area").
4. A shipping quote with a key this server does not know must still reach the model, under
   `other`, rather than vanish — Task 5, "reports a quote key it does not know under other".
5. A 404 on the cancel pre-check must propagate as that 404 and send no cancel — Task 5,
   "passes a 404 from the status check on, without sending the cancel". Likewise, an error that
   is neither 409 nor code 8503 but whose body carries `order.id` must not be mistaken for a
   duplicate — Task 2, the third `existingOrderId` test.

## File Structure

| File                                 | Responsibility                                                                 | Task |
| ------------------------------------ | ------------------------------------------------------------------------------ | ---- |
| `src/printify/errors.ts`             | `PrintifyApiError.body` (non-enumerable), `'an unexpected order response'`     | 1    |
| `test/printify/errors.test.ts`       | The body is readable, hidden from `inspect`/JSON/keys, undefined otherwise     | 1    |
| `test/fixtures/orders.ts`            | Documented order, express answer, three quote key sets, conflict body, paths   | 2    |
| `src/printify/orders.ts`             | Schemas, seven request functions, `existingOrderId`                            | 2    |
| `test/printify/orders.test.ts`       | Method/path/query/body per function, conflict handling, invalid responses      | 2    |
| `src/tools/shipping-method.ts`       | Name ↔ code, `parseShippingQuote`                                              | 3    |
| `test/tools/shipping-method.test.ts` | The three key generations, `other`, missing methods                            | 3    |
| `src/tools/order-summary.ts`         | `orderRow`, `summarizeOrder`, `lineItemRow`, `expressOrderRow`                 | 4    |
| `test/tools/order-summary.test.ts`   | Address stripped by default, external_id, metadata without shop_order_id       | 4    |
| `src/tools/products.ts`              | Exports `printDetailsInput`                                                    | 5    |
| `src/tools/orders.ts`                | The seven tools and `ordersTools`                                              | 5    |
| `src/tools/index.ts`                 | `orders: ordersTools`                                                          | 5    |
| `.github/workflows/ci.yml`           | Gated names in the must-be-absent loop, read names in the must-be-present loop | 5    |
| `test/tools/orders.test.ts`          | Harness tests: gating, every tool, every line-item shape, the 409, the cancel  | 5    |

---

### Task 1: `PrintifyApiError.body`

**Files:**

- Modify: `src/printify/errors.ts`
- Test: `test/printify/errors.test.ts`

**Interfaces:**

- Consumes: nothing new.
- Produces: `PrintifyApiError.body: unknown`, the parsed JSON of a non-2xx response, set by
  `httpError` from the `{ value }` it already receives; `undefined` on timeout, network and
  limiter errors. Non-enumerable, so `inspect(error)`, `JSON.stringify(error)`,
  `Object.keys(error)` and a spread never show it. `invalidResponseError` accepts the problem
  text `'an unexpected order response'`. `src/printify/client.ts` needs no change: it already
  passes `parseJson(text)` into `httpError`.

- [ ] **Step 1: Add the failing test**

In `test/printify/errors.test.ts`, inside `describe('httpError', …)`, after the test
`'applies the redaction to every text field and always redacts JWTs'`, add:

<!-- prettier-ignore -->
```ts
  it('keeps the parsed body for callers, hidden from inspection and spreads', () => {
    const body = { status: 'error', code: 8503, order: { id: 'dup1' }, note: 'Jane Doe' };
    const error = httpError(PRODUCTS, 409, { value: body }, null);
    expect(error.body).toEqual(body);
    expect(inspect(error)).not.toContain('Jane Doe');
    expect(JSON.stringify(error)).not.toContain('Jane Doe');
    expect(Object.keys(error)).not.toContain('body');
    expect(httpError(PRODUCTS, 502, undefined, null).body).toBeUndefined();
    expect(timeoutError(PRODUCTS, 30000).body).toBeUndefined();
  });
```

`inspect`, `httpError`, `timeoutError` and `PRODUCTS` are already imported or defined in that
file.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/printify/errors.test.ts`
Expected: FAIL with `expected undefined to deeply equal { status: 'error', … }`.

- [ ] **Step 3: Add the field**

In `src/printify/errors.ts`, make these five edits.

In `PrintifyErrorFields`, after `retryAfterSeconds`:

<!-- prettier-ignore -->
```ts
  /** Set only by the rate limiter's fail-fast error: the request was not sent. */
  retryAfterSeconds?: number | undefined;
  /** The parsed JSON body of a non-2xx response, for a caller that needs more than the fields. */
  body?: unknown;
}
```

In the `PrintifyApiError` class, between `retryAfterSeconds` and `hint`:

<!-- prettier-ignore -->
```ts
  readonly retryAfterSeconds: number | undefined;
  /**
   * The parsed JSON body of a non-2xx response, `undefined` for every other error. It is not
   * redacted, so it is non-enumerable: `inspect`, a spread and JSON leave it out, and the registry
   * reports the fields above by name. Only a caller that reads `error.body` on purpose sees it.
   */
  declare readonly body: unknown;
  readonly hint: string | undefined;
```

`declare` matters: a plain field declaration would be re-initialised to `undefined` as an
enumerable property after the constructor's `defineProperty`.

In the constructor, before `this.hint = hintFor(this);`:

<!-- prettier-ignore -->
```ts
    this.retryAfterSeconds = fields.retryAfterSeconds;
    Object.defineProperty(this, 'body', { value: fields.body, enumerable: false, writable: false });
    this.hint = hintFor(this);
```

In `httpError`, the `new PrintifyApiError(message, { … })` call gets one more field:

<!-- prettier-ignore -->
```ts
    reason,
    requestId,
    body: body?.value,
  });
```

And in `invalidResponseError`'s `problem` union:

<!-- prettier-ignore -->
```ts
    | 'an unexpected product response'
    | 'an unexpected order response',
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/printify`
Expected: PASS, including the two redaction tests in `client.test.ts` and `errors.test.ts`
that `inspect` the error (they are why the field is non-enumerable).

- [ ] **Step 5: Lint, typecheck, commit**

Run: `npm run lint && npm run typecheck`
Expected: no output but the scripts' own lines.

```bash
git add src/printify/errors.ts test/printify/errors.test.ts
git commit -F - <<'EOF'
Keep a non-2xx body on PrintifyApiError, hidden from inspection

The orders toolset reads the existing order's id out of a 409 duplicate
body. The field is non-enumerable so an inspected or stringified error
still shows no unredacted text.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

A subagent implementer uses its own model's `Co-Authored-By` line instead.

---

### Task 2: The orders request module

**Files:**

- Create: `test/fixtures/orders.ts`
- Create: `src/printify/orders.ts`
- Test: `test/printify/orders.test.ts`

**Interfaces:**

- Consumes: `PrintifyApiError.body` (Task 1); `fetchPage(client, 'orders', path, { page, limit,
query, signal })` and `PAGE_LIMITS.orders === 10` from `src/printify/pagination.ts`; `lenient`
  from `src/printify/schema.ts`; `apiPath` from `src/printify/path.ts`.
- Produces, from `src/printify/orders.ts`:
  - types `Order`, `OrderLineItem`, `OrderAddress`, `OrderMetadata`, `Shipment`,
    `ExpressOrder { id, fulfilment_type, app_order_id, line_items }`, `OrderPage { orders,
page, hasMore, total, lastPage }`, `ListOrdersOptions { page?, limit?, status?, sku? }`,
    `SubmitResult { id, created }`, `ExpressResult = { created: true, orders } | { created:
false, id }`.
  - `listOrders(client, shopId, options, signal): Promise<OrderPage>`
  - `getOrder(client, shopId, orderId, signal): Promise<Order>`
  - `calculateShipping(client, shopId, body, signal): Promise<Record<string, number>>`
  - `submitOrder(client, shopId, body, signal): Promise<SubmitResult>`
  - `submitExpressOrder(client, shopId, body, signal): Promise<ExpressResult>`
  - `sendOrderToProduction(client, shopId, orderId, signal): Promise<string>`
  - `cancelOrder(client, shopId, orderId, signal): Promise<Order>`
  - `existingOrderId(error: unknown): string | undefined`
- Produces, from `test/fixtures/orders.ts`: `ADDRESS`, `LINE_ITEM`, `LINE_ITEM_MUG`, `ORDER`,
  `order(overrides)`, `ordersPage(items, envelope)`, `EXPRESS_RESPONSE`, `QUOTE_OLD`,
  `QUOTE_TRANSITIONAL`, `QUOTE_FINAL`, `orderConflictBody(id, externalId)`, and the constants
  `SHOP_ID`, `ORDERS_PATH`, `ORDER_PATH`, `EXPRESS_PATH`, `SHIPPING_PATH`, `PRODUCTION_PATH`,
  `CANCEL_PATH`.

- [ ] **Step 1: Write the fixtures**

Create `test/fixtures/orders.ts`:

```ts
import { SHOP } from './shops.js';

/** The documented recipient of the order examples. */
export const ADDRESS = {
  first_name: 'John',
  last_name: 'Smith',
  email: 'example@msn.com',
  phone: '0574 69 21 90',
  country: 'BE',
  region: '',
  address1: 'ExampleBaan 121',
  address2: '45',
  city: 'Retie',
  zip: '2470',
  company: 'MSN',
};

export const LINE_ITEM = {
  product_id: '5b05842f3921c9547531758d',
  quantity: 1,
  variant_id: 17887,
  print_provider_id: 5,
  cost: 1050,
  shipping_cost: 400,
  status: 'on-hold',
  metadata: {
    title: '18K gold plated Necklace',
    price: 2200,
    variant_label: 'Golden indigocoin',
    sku: '168699843',
    country: 'United States',
    external_id: 'line-item-abc-001',
  },
  sent_to_production_at: null as string | null,
  fulfilled_at: null as string | null,
};

export const LINE_ITEM_MUG = {
  ...LINE_ITEM,
  product_id: '5b05842f3921c34764fa478bc',
  variant_id: 33719,
  cost: 650,
  metadata: {
    title: 'Mug 11oz',
    price: 1500,
    variant_label: '11oz',
    sku: '168699844',
    country: 'United States',
  },
};

/** The documented `GET …/orders/{order_id}.json` example, still on hold. */
export const ORDER = {
  id: '5a96f649b2439217d070f507',
  app_order_id: '215014.44',
  address_to: ADDRESS,
  line_items: [LINE_ITEM, LINE_ITEM_MUG],
  metadata: {
    order_type: 'api',
    shop_order_id: 1370762297 as number | string,
    shop_order_label: '1370762297',
    shop_fulfilled_at: '2017-04-18 13:24:28+00:00',
    is_reprint: false,
    reprinted_order_ids: [],
    child_reprinted_order_ids: [],
  },
  total_price: 3700,
  total_shipping: 400,
  total_tax: 0,
  status: 'on-hold',
  shipping_method: 1,
  is_printify_express: false,
  is_economy_shipping: false,
  shipments: [
    {
      carrier: 'usps',
      number: '94001116990045395649372',
      url: 'http://example.com/94001116990045395649372',
      delivered_at: '2017-04-18 13:24:28+00:00',
    },
  ],
  created_at: '2017-04-18 13:24:28+00:00',
  sent_to_production_at: null as string | null,
  fulfilled_at: null as string | null,
  printify_connect: {
    url: 'https://example.com/printify_connect_hash',
    id: 'printify_connect_hash',
  },
};

export function order(overrides: Partial<typeof ORDER> = {}): typeof ORDER {
  return { ...ORDER, ...overrides };
}

/** The Laravel envelope `GET …/orders.json` answers with. */
export function ordersPage(
  items: readonly object[] = [ORDER],
  overrides: { current_page?: number; last_page?: number; total?: number } = {},
): object {
  const { current_page = 1, last_page = 1, total = items.length } = overrides;
  return {
    current_page,
    data: items,
    first_page_url: '/?page=1',
    from: 1,
    last_page,
    last_page_url: `/?page=${String(last_page)}`,
    next_page_url: current_page < last_page ? `/?page=${String(current_page + 1)}` : null,
    path: '/',
    per_page: 10,
    prev_page_url: null,
    to: items.length,
    total,
  };
}

/** The documented `POST …/orders/express.json` answer: one express and one ordinary order. */
export const EXPRESS_RESPONSE = {
  data: [
    {
      type: 'order',
      id: '5a96f649b2439217d070f508',
      attributes: {
        app_order_id: '215014.44',
        fulfilment_type: 'express',
        line_items: [{ ...LINE_ITEM, variant_id: 12359, cost: 2200, shipping_cost: 799 }],
      },
    },
    {
      type: 'order',
      id: '5a96f649b2439597d020a9b4',
      attributes: {
        fulfilment_type: 'ordinary',
        line_items: [LINE_ITEM_MUG],
      },
    },
  ],
};

/** The three generations of `shipping.json` keys from the docs' table. */
export const QUOTE_OLD = { standard: 1000, express: 5000, economy: 399 };
export const QUOTE_TRANSITIONAL = {
  standard: 1000,
  express: 5000,
  priority: 5000,
  printify_express: 799,
  economy: 399,
};
export const QUOTE_FINAL = { standard: 1000, priority: 5000, express: 799, economy: 399 };

/** The openapi example for a duplicate `external_id`: HTTP 409, with the existing order. */
export function orderConflictBody(id = ORDER.id, externalId = 'order-ext-1'): object {
  return {
    status: 'error',
    code: 8503,
    message: 'Operation failed.',
    errors: { reason: 'Order already exists for the given external_id.', code: 8503 },
    order: { id, external_id: externalId },
  };
}

export const SHOP_ID = SHOP.id;
export const ORDERS_PATH = `/v1/shops/${String(SHOP_ID)}/orders.json`;
export const ORDER_PATH = `/v1/shops/${String(SHOP_ID)}/orders/${ORDER.id}.json`;
export const EXPRESS_PATH = `/v1/shops/${String(SHOP_ID)}/orders/express.json`;
export const SHIPPING_PATH = `/v1/shops/${String(SHOP_ID)}/orders/shipping.json`;
export const PRODUCTION_PATH = `/v1/shops/${String(SHOP_ID)}/orders/${ORDER.id}/send_to_production.json`;
export const CANCEL_PATH = `/v1/shops/${String(SHOP_ID)}/orders/${ORDER.id}/cancel.json`;
```

The `null as string | null` and `1370762297 as number | string` casts widen the literal types,
so a test can override those fields without a cast of its own.

- [ ] **Step 2: Write the failing tests**

Create `test/printify/orders.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createPrintifyClient, type PrintifyClient } from '../../src/printify/client.js';
import { httpError, timeoutError } from '../../src/printify/errors.js';
import {
  calculateShipping,
  cancelOrder,
  existingOrderId,
  getOrder,
  listOrders,
  sendOrderToProduction,
  submitExpressOrder,
  submitOrder,
} from '../../src/printify/orders.js';
import { Secret } from '../../src/secret.js';
import { apiErrorBody } from '../fixtures/errors.js';
import {
  ADDRESS,
  CANCEL_PATH,
  EXPRESS_PATH,
  EXPRESS_RESPONSE,
  ORDER,
  ORDER_PATH,
  ORDERS_PATH,
  PRODUCTION_PATH,
  QUOTE_TRANSITIONAL,
  SHIPPING_PATH,
  SHOP_ID,
  order,
  orderConflictBody,
  ordersPage,
} from '../fixtures/orders.js';
import { createFakeApi, json, type FakeApi, type Routes } from '../support/fake-api.js';
import { apiError } from './helpers.js';

const TOKEN = 'Tok-orders-7Q8w9E0r';
const ORDER_BODY = {
  external_id: 'order-ext-1',
  line_items: [{ product_id: ORDER.line_items[0]?.product_id, variant_id: 17887, quantity: 1 }],
  shipping_method: 1,
  send_shipping_notification: false,
  address_to: ADDRESS,
};
const ROUTE = { method: 'POST', path: ORDERS_PATH } as const;

function testClient(routes: Routes = {}): { client: PrintifyClient; api: FakeApi } {
  const api = createFakeApi(routes);
  const client = createPrintifyClient({
    token: new Secret(TOKEN),
    baseUrl: 'https://api.printify.com',
    fetch: api.fetch,
  });
  return { client, api };
}

/** A signal that has not aborted. */
function live(): AbortSignal {
  return new AbortController().signal;
}

describe('listOrders', () => {
  it('fetches a page and parses each order', async () => {
    const { client, api } = testClient({ [`GET ${ORDERS_PATH}`]: ordersPage([ORDER]) });
    const page = await listOrders(client, SHOP_ID, {}, live());
    expect(page).toMatchObject({ page: 1, hasMore: false, total: 1, lastPage: 1 });
    expect(page.orders[0]).toMatchObject({ id: ORDER.id, status: 'on-hold', shipping_method: 1 });
    expect(api.expectRequest('GET', ORDERS_PATH).query).toEqual({});
  });

  it('sends only the filters that were given, and caps limit at 10', async () => {
    const { client, api } = testClient({ [`GET ${ORDERS_PATH}`]: ordersPage([]) });
    await listOrders(client, SHOP_ID, { page: 2, limit: 25, status: 'fulfilled' }, live());
    expect(api.expectRequest('GET', ORDERS_PATH).query).toEqual({
      page: '2',
      limit: '10',
      status: 'fulfilled',
    });
  });

  it('sends the sku filter', async () => {
    const { client, api } = testClient({ [`GET ${ORDERS_PATH}`]: ordersPage([]) });
    await listOrders(client, SHOP_ID, { sku: '168699843' }, live());
    expect(api.expectRequest('GET', ORDERS_PATH).query).toEqual({ sku: '168699843' });
  });

  it('rejects an order without an id as an invalid response', async () => {
    const { client } = testClient({ [`GET ${ORDERS_PATH}`]: ordersPage([{ status: 'x' }]) });
    const error = await apiError(listOrders(client, SHOP_ID, {}, live()));
    expect(error).toMatchObject({ kind: 'invalid_response', method: 'GET', path: ORDERS_PATH });
    expect(error.message).toContain('an unexpected order response');
  });
});

describe('getOrder', () => {
  it('gets one order with every key Printify sent', async () => {
    const { client, api } = testClient({ [`GET ${ORDER_PATH}`]: ORDER });
    const got = await getOrder(client, SHOP_ID, ORDER.id, live());
    expect(got).toMatchObject({ id: ORDER.id, address_to: ADDRESS, shipments: ORDER.shipments });
    expect(got.metadata?.shop_order_id).toBe(1370762297);
    api.expectRequest('GET', ORDER_PATH);
  });

  it('turns null timestamps and a wrong-typed total into undefined', async () => {
    const { client } = testClient({
      [`GET ${ORDER_PATH}`]: order({ total_price: 'free' as unknown as number }),
    });
    const got = await getOrder(client, SHOP_ID, ORDER.id, live());
    expect(got.fulfilled_at).toBeUndefined();
    expect(got.total_price).toBeUndefined();
  });

  it('passes a 404 on with its hint', async () => {
    const { client } = testClient({ [`GET ${ORDER_PATH}`]: json({ error: 'Not found' }, 404) });
    const error = await apiError(getOrder(client, SHOP_ID, ORDER.id, live()));
    expect(error).toMatchObject({ kind: 'http', status: 404 });
  });
});

describe('calculateShipping', () => {
  it('posts the line items and address and returns the raw quote', async () => {
    const { client, api } = testClient({ [`POST ${SHIPPING_PATH}`]: QUOTE_TRANSITIONAL });
    const body = { line_items: ORDER_BODY.line_items, address_to: ADDRESS };
    expect(await calculateShipping(client, SHOP_ID, body, live())).toEqual(QUOTE_TRANSITIONAL);
    expect(api.expectRequest('POST', SHIPPING_PATH).body).toEqual(body);
  });

  it('rejects a non-numeric quote as an invalid response', async () => {
    const { client } = testClient({ [`POST ${SHIPPING_PATH}`]: { standard: 'cheap' } });
    const error = await apiError(calculateShipping(client, SHOP_ID, {}, live()));
    expect(error).toMatchObject({ kind: 'invalid_response', path: SHIPPING_PATH });
  });
});

describe('submitOrder', () => {
  it('posts the body and reports the new order as created', async () => {
    const { client, api } = testClient({ [`POST ${ORDERS_PATH}`]: { id: ORDER.id } });
    expect(await submitOrder(client, SHOP_ID, ORDER_BODY, live())).toEqual({
      id: ORDER.id,
      created: true,
    });
    expect(api.expectRequest('POST', ORDERS_PATH).body).toEqual(ORDER_BODY);
  });

  it('resolves to the existing order on a 409 conflict, without retrying', async () => {
    const { client, api } = testClient({
      [`POST ${ORDERS_PATH}`]: json(orderConflictBody('existing1'), 409),
    });
    expect(await submitOrder(client, SHOP_ID, ORDER_BODY, live())).toEqual({
      id: 'existing1',
      created: false,
    });
    expect(api.requests).toHaveLength(1);
  });

  it('rejects with the API error on a 400', async () => {
    const { client } = testClient({
      [`POST ${ORDERS_PATH}`]: json(apiErrorBody({ code: 8103, reason: 'zip required' }), 400),
    });
    const error = await apiError(submitOrder(client, SHOP_ID, ORDER_BODY, live()));
    expect(error).toMatchObject({ status: 400, code: 8103 });
  });

  it('rejects with the API error on a 409 whose body names no order', async () => {
    const { client } = testClient({
      [`POST ${ORDERS_PATH}`]: json(apiErrorBody({ code: 8503 }), 409),
    });
    const error = await apiError(submitOrder(client, SHOP_ID, ORDER_BODY, live()));
    expect(error).toMatchObject({ status: 409, code: 8503 });
    expect(error.hint).toContain('already exists');
  });

  it('rejects an answer without an id as an invalid response', async () => {
    const { client } = testClient({ [`POST ${ORDERS_PATH}`]: { ok: true } });
    const error = await apiError(submitOrder(client, SHOP_ID, ORDER_BODY, live()));
    expect(error).toMatchObject({ kind: 'invalid_response', method: 'POST', path: ORDERS_PATH });
  });
});

describe('submitExpressOrder', () => {
  it('parses the one-or-two-order envelope', async () => {
    const { client, api } = testClient({ [`POST ${EXPRESS_PATH}`]: EXPRESS_RESPONSE });
    const body = { ...ORDER_BODY, shipping_method: 3 };
    const result = await submitExpressOrder(client, SHOP_ID, body, live());
    expect(result).toEqual({
      created: true,
      orders: [
        {
          id: '5a96f649b2439217d070f508',
          fulfilment_type: 'express',
          app_order_id: '215014.44',
          line_items: EXPRESS_RESPONSE.data[0]?.attributes.line_items.map((item) => ({
            ...item,
            sent_to_production_at: undefined,
            fulfilled_at: undefined,
          })),
        },
        {
          id: '5a96f649b2439597d020a9b4',
          fulfilment_type: 'ordinary',
          app_order_id: undefined,
          line_items: EXPRESS_RESPONSE.data[1]?.attributes.line_items.map((item) => ({
            ...item,
            sent_to_production_at: undefined,
            fulfilled_at: undefined,
          })),
        },
      ],
    });
    expect(api.expectRequest('POST', EXPRESS_PATH).body).toEqual(body);
  });

  it('resolves to the existing order on a conflict', async () => {
    const { client } = testClient({
      [`POST ${EXPRESS_PATH}`]: json(orderConflictBody('existing2'), 409),
    });
    expect(await submitExpressOrder(client, SHOP_ID, ORDER_BODY, live())).toEqual({
      created: false,
      id: 'existing2',
    });
  });

  it('rejects a plain order answer as an invalid response', async () => {
    const { client } = testClient({ [`POST ${EXPRESS_PATH}`]: { id: ORDER.id } });
    const error = await apiError(submitExpressOrder(client, SHOP_ID, ORDER_BODY, live()));
    expect(error).toMatchObject({ kind: 'invalid_response', path: EXPRESS_PATH });
  });
});

describe('sendOrderToProduction', () => {
  it('posts without a body and returns the id', async () => {
    const { client, api } = testClient({ [`POST ${PRODUCTION_PATH}`]: { id: ORDER.id } });
    expect(await sendOrderToProduction(client, SHOP_ID, ORDER.id, live())).toBe(ORDER.id);
    expect(api.expectRequest('POST', PRODUCTION_PATH).body).toBeUndefined();
  });
});

describe('cancelOrder', () => {
  it('posts without a body and returns the cancelled order', async () => {
    const { client, api } = testClient({
      [`POST ${CANCEL_PATH}`]: order({ status: 'canceled' }),
    });
    const cancelled = await cancelOrder(client, SHOP_ID, ORDER.id, live());
    expect(cancelled).toMatchObject({ id: ORDER.id, status: 'canceled' });
    expect(api.expectRequest('POST', CANCEL_PATH).body).toBeUndefined();
  });
});

describe('existingOrderId', () => {
  it('reads the id from a 409 with the documented body', () => {
    const error = httpError(ROUTE, 409, { value: orderConflictBody('dup1') }, null);
    expect(existingOrderId(error)).toBe('dup1');
  });

  it('accepts code 8503 whatever the status', () => {
    const error = httpError(ROUTE, 400, { value: orderConflictBody('dup2') }, null);
    expect(existingOrderId(error)).toBe('dup2');
  });

  it('is undefined for a 409 without order.id, a 500, a timeout and a non-error', () => {
    expect(existingOrderId(httpError(ROUTE, 409, { value: apiErrorBody() }, null))).toBeUndefined();
    expect(existingOrderId(httpError(ROUTE, 500, { value: apiErrorBody() }, null))).toBeUndefined();
    // Another error whose body happens to carry an order: neither 409 nor 8503, so not a duplicate.
    const otherError = { ...orderConflictBody('x'), code: 8502, errors: { code: 8502 } };
    expect(existingOrderId(httpError(ROUTE, 500, { value: otherError }, null))).toBeUndefined();
    expect(existingOrderId(timeoutError(ROUTE, 30_000))).toBeUndefined();
    expect(existingOrderId(new Error('nope'))).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run test/printify/orders.test.ts`
Expected: FAIL, `Cannot find module '../../src/printify/orders.js'`.

- [ ] **Step 4: Write the module**

Create `src/printify/orders.ts`:

```ts
import { z } from 'zod';
import type { PrintifyClient } from './client.js';
import { invalidResponseError, PrintifyApiError, type Route } from './errors.js';
import { fetchPage } from './pagination.js';
import { apiPath, type ApiPath } from './path.js';
import { lenient } from './schema.js';

// Every object is loose and only `id` is required, so a field Printify drops or retypes cannot
// break a read. The address is parsed to strings only: the summary either passes it on whole
// or leaves it out.
const addressSchema = z.looseObject({
  first_name: lenient(z.string()),
  last_name: lenient(z.string()),
  email: lenient(z.string()),
  phone: lenient(z.string()),
  country: lenient(z.string()),
  region: lenient(z.string()),
  address1: lenient(z.string()),
  address2: lenient(z.string()),
  city: lenient(z.string()),
  zip: lenient(z.string()),
  company: lenient(z.string()),
});

const lineItemMetadataSchema = z.looseObject({
  title: lenient(z.string()),
  price: lenient(z.number()),
  variant_label: lenient(z.string()),
  sku: lenient(z.string()),
  country: lenient(z.string()),
  external_id: lenient(z.string()),
});

const lineItemSchema = z.looseObject({
  product_id: lenient(z.string()),
  variant_id: lenient(z.number().int()),
  quantity: lenient(z.number().int()),
  print_provider_id: lenient(z.number().int()),
  cost: lenient(z.number()),
  shipping_cost: lenient(z.number()),
  status: lenient(z.string()),
  metadata: lenient(lineItemMetadataSchema),
  sent_to_production_at: lenient(z.string()),
  fulfilled_at: lenient(z.string()),
});

// shop_order_id is documented as an integer and shown as a string in the cancel example.
const metadataSchema = z.looseObject({
  order_type: lenient(z.string()),
  shop_order_id: lenient(z.union([z.string(), z.number()])),
  shop_order_label: lenient(z.string()),
  shop_fulfilled_at: lenient(z.string()),
  is_reprint: lenient(z.boolean()),
  reprinted_order_ids: lenient(z.array(z.string())),
  child_reprinted_order_ids: lenient(z.array(z.string())),
});

const shipmentSchema = z.looseObject({
  carrier: lenient(z.string()),
  number: lenient(z.string()),
  url: lenient(z.string()),
  delivered_at: lenient(z.string()),
});

const orderSchema = z.looseObject({
  id: z.string().min(1),
  app_order_id: lenient(z.string()),
  address_to: lenient(addressSchema),
  line_items: lenient(z.array(lineItemSchema)),
  metadata: lenient(metadataSchema),
  total_price: lenient(z.number()),
  total_shipping: lenient(z.number()),
  total_tax: lenient(z.number()),
  status: lenient(z.string()),
  shipping_method: lenient(z.number().int()),
  is_printify_express: lenient(z.boolean()),
  is_economy_shipping: lenient(z.boolean()),
  shipments: lenient(z.array(shipmentSchema)),
  created_at: lenient(z.string()),
  sent_to_production_at: lenient(z.string()),
  fulfilled_at: lenient(z.string()),
  printify_connect: lenient(z.looseObject({ url: lenient(z.string()), id: lenient(z.string()) })),
});

// The express endpoint answers a JSON:API envelope, one entry per order it created.
const expressOrderSchema = z.object({
  id: z.string().min(1),
  attributes: z.looseObject({
    app_order_id: lenient(z.string()),
    fulfilment_type: lenient(z.string()),
    line_items: lenient(z.array(lineItemSchema)),
  }),
});
const expressResponseSchema = z.object({ data: z.array(expressOrderSchema) });

const createdSchema = z.object({ id: z.string().min(1) });
const quoteSchema = z.record(z.string(), z.number());
const conflictSchema = z.object({ order: z.object({ id: z.string().min(1) }) });

/** An order as Printify returns it, with every key it sent. */
export type Order = z.infer<typeof orderSchema>;
export type OrderLineItem = z.infer<typeof lineItemSchema>;
export type OrderAddress = z.infer<typeof addressSchema>;
export type OrderMetadata = z.infer<typeof metadataSchema>;
export type Shipment = z.infer<typeof shipmentSchema>;

/** One order the express endpoint created: an `express` one, an `ordinary` one, or both. */
export interface ExpressOrder {
  id: string;
  fulfilment_type: string | undefined;
  app_order_id: string | undefined;
  line_items: OrderLineItem[] | undefined;
}

export interface OrderPage {
  orders: Order[];
  page: number;
  hasMore: boolean;
  total: number | undefined;
  lastPage: number | undefined;
}

export interface ListOrdersOptions {
  page?: number | undefined;
  limit?: number | undefined;
  status?: string | undefined;
  sku?: string | undefined;
}

/** What a create answered: a new order, or the order that already had this `external_id`. */
export interface SubmitResult {
  id: string;
  created: boolean;
}

export type ExpressResult =
  { created: true; orders: ExpressOrder[] } | { created: false; id: string };

const DUPLICATE_CODE = 8503;

function ordersPath(shopId: number): ApiPath {
  return apiPath`/v1/shops/${shopId}/orders.json`;
}

function orderPath(shopId: number, orderId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/orders/${orderId}.json`;
}

/** One page of a shop's orders, newest first. A `limit` above 10 is lowered by `fetchPage`. */
export async function listOrders(
  client: PrintifyClient,
  shopId: number,
  options: ListOrdersOptions,
  signal: AbortSignal,
): Promise<OrderPage> {
  const path = ordersPath(shopId);
  const page = await fetchPage(client, 'orders', path, {
    page: options.page,
    limit: options.limit,
    // Only the filters that were given: buildUrl skips undefined, but the query stays explicit.
    query: {
      ...(options.status !== undefined && { status: options.status }),
      ...(options.sku !== undefined && { sku: options.sku }),
    },
    signal,
  });
  const route: Route = { method: 'GET', path };
  return {
    orders: page.items.map((item) => parseOrder(item, route)),
    page: page.page,
    hasMore: page.hasMore,
    total: page.total,
    lastPage: page.lastPage,
  };
}

export async function getOrder(
  client: PrintifyClient,
  shopId: number,
  orderId: string,
  signal: AbortSignal,
): Promise<Order> {
  const path = orderPath(shopId, orderId);
  const body = await client.request('GET', path, { signal });
  return parseOrder(body, { method: 'GET', path });
}

/**
 * Quotes the shipping cost per method. `body` is the tool's validated `{ line_items, address_to }`.
 * The answer is Printify's flat object of method key to cents, unknown keys kept, so the tool's
 * `parseShippingQuote` can translate the transitional key names.
 */
export async function calculateShipping(
  client: PrintifyClient,
  shopId: number,
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, number>> {
  const path = apiPath`/v1/shops/${shopId}/orders/shipping.json`;
  const response = await client.request('POST', path, { body, signal });
  const parsed = quoteSchema.safeParse(response);
  if (!parsed.success) throw unexpected({ method: 'POST', path });
  return parsed.data;
}

/**
 * Submits an order. A 409 or code 8503 whose body names the order that already has this
 * `external_id` resolves to that order with `created: false`; any other error propagates.
 */
export async function submitOrder(
  client: PrintifyClient,
  shopId: number,
  body: unknown,
  signal: AbortSignal,
): Promise<SubmitResult> {
  const path = ordersPath(shopId);
  let response: unknown;
  try {
    response = await client.request('POST', path, { body, signal });
  } catch (error) {
    const id = existingOrderId(error);
    if (id === undefined) throw error;
    return { id, created: false };
  }
  const parsed = createdSchema.safeParse(response);
  if (!parsed.success) throw unexpected({ method: 'POST', path });
  return { id: parsed.data.id, created: true };
}

/** Submits a Printify Express order, which answers one or two orders. Same conflict rule. */
export async function submitExpressOrder(
  client: PrintifyClient,
  shopId: number,
  body: unknown,
  signal: AbortSignal,
): Promise<ExpressResult> {
  const path = apiPath`/v1/shops/${shopId}/orders/express.json`;
  let response: unknown;
  try {
    response = await client.request('POST', path, { body, signal });
  } catch (error) {
    const id = existingOrderId(error);
    if (id === undefined) throw error;
    return { created: false, id };
  }
  const parsed = expressResponseSchema.safeParse(response);
  if (!parsed.success) throw unexpected({ method: 'POST', path });
  return {
    created: true,
    orders: parsed.data.data.map(({ id, attributes }) => ({
      id,
      fulfilment_type: attributes.fulfilment_type,
      app_order_id: attributes.app_order_id,
      line_items: attributes.line_items,
    })),
  };
}

/** Sends an order to production. Printify answers `{ id }`; the id is returned. */
export async function sendOrderToProduction(
  client: PrintifyClient,
  shopId: number,
  orderId: string,
  signal: AbortSignal,
): Promise<string> {
  const path = apiPath`/v1/shops/${shopId}/orders/${orderId}/send_to_production.json`;
  const response = await client.request('POST', path, { signal });
  const parsed = createdSchema.safeParse(response);
  if (!parsed.success) throw unexpected({ method: 'POST', path });
  return parsed.data.id;
}

/** Cancels an order. Printify answers the whole order, address included. */
export async function cancelOrder(
  client: PrintifyClient,
  shopId: number,
  orderId: string,
  signal: AbortSignal,
): Promise<Order> {
  const path = apiPath`/v1/shops/${shopId}/orders/${orderId}/cancel.json`;
  const response = await client.request('POST', path, { signal });
  return parseOrder(response, { method: 'POST', path });
}

/**
 * The id of the order that already has the submitted `external_id`, read from a duplicate
 * error's body (HTTP 409 or code 8503 with `order.id`), or `undefined` for any other error.
 */
export function existingOrderId(error: unknown): string | undefined {
  if (!(error instanceof PrintifyApiError)) return undefined;
  if (error.status !== 409 && error.code !== DUPLICATE_CODE) return undefined;
  const parsed = conflictSchema.safeParse(error.body);
  return parsed.success ? parsed.data.order.id : undefined;
}

function parseOrder(body: unknown, route: Route): Order {
  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) throw unexpected(route);
  return parsed.data;
}

function unexpected(route: Route): PrintifyApiError {
  return invalidResponseError(route, 200, 'an unexpected order response');
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/printify/orders.test.ts`
Expected: PASS, 22 tests.

- [ ] **Step 6: Lint, typecheck, commit**

Run: `npx prettier --write src/printify/orders.ts test/fixtures/orders.ts test/printify/orders.test.ts && npm run lint && npm run typecheck`

```bash
git add src/printify/orders.ts test/fixtures/orders.ts test/printify/orders.test.ts
git commit -F - <<'EOF'
Add the orders request module: seven calls and the duplicate rule

A 409 or code 8503 whose body names the order that already has the
external_id resolves to that order with created: false; everything else
propagates. Orders are parsed loosely with only the id required.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

A subagent implementer uses its own model's `Co-Authored-By` line instead.

---

### Task 3: Shipping method names, codes and the quote parser

**Files:**

- Create: `src/tools/shipping-method.ts`
- Test: `test/tools/shipping-method.test.ts`

**Interfaces:**

- Consumes: `SHIPPING_METHODS` and `ShippingMethod` from `src/printify/catalog.ts`;
  `QUOTE_OLD`, `QUOTE_TRANSITIONAL`, `QUOTE_FINAL` from Task 2's fixtures.
- Produces: `ORDER_SHIPPING_METHODS` (the same tuple, re-exported), `ShippingMethod`,
  `ShippingMethodCode = 1 | 2 | 3 | 4`, `QuoteRow { method, code, cost }`, `ShippingQuote {
methods, other? }`, `shippingMethodCode(method)`, `shippingMethodName(code | undefined)`,
  `parseShippingQuote(raw)`.

- [ ] **Step 1: Write the failing tests**

Create `test/tools/shipping-method.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ORDER_SHIPPING_METHODS,
  parseShippingQuote,
  shippingMethodCode,
  shippingMethodName,
} from '../../src/tools/shipping-method.js';
import { QUOTE_FINAL, QUOTE_OLD, QUOTE_TRANSITIONAL } from '../fixtures/orders.js';

describe('shippingMethodCode', () => {
  it('maps the four catalog names to the order codes', () => {
    expect(ORDER_SHIPPING_METHODS.map(shippingMethodCode)).toEqual([1, 2, 3, 4]);
    expect(shippingMethodCode('express')).toBe(3);
  });
});

describe('shippingMethodName', () => {
  it('maps the codes back, keeps an unknown code as text and undefined as undefined', () => {
    expect([1, 2, 3, 4].map(shippingMethodName)).toEqual([
      'standard',
      'priority',
      'express',
      'economy',
    ]);
    expect(shippingMethodName(5)).toBe('5');
    expect(shippingMethodName(undefined)).toBeUndefined();
  });
});

describe('parseShippingQuote', () => {
  it('reads the old keys: express is priority, and there is no Printify Express', () => {
    expect(parseShippingQuote(QUOTE_OLD)).toEqual({
      methods: [
        { method: 'standard', code: 1, cost: 1000 },
        { method: 'priority', code: 2, cost: 5000 },
        { method: 'economy', code: 4, cost: 399 },
      ],
    });
  });

  it('reads the transitional keys: printify_express is express', () => {
    expect(parseShippingQuote(QUOTE_TRANSITIONAL)).toEqual({
      methods: [
        { method: 'standard', code: 1, cost: 1000 },
        { method: 'priority', code: 2, cost: 5000 },
        { method: 'express', code: 3, cost: 799 },
        { method: 'economy', code: 4, cost: 399 },
      ],
    });
  });

  it('reads the final keys: express next to priority is Printify Express', () => {
    expect(parseShippingQuote(QUOTE_FINAL)).toEqual({
      methods: [
        { method: 'standard', code: 1, cost: 1000 },
        { method: 'priority', code: 2, cost: 5000 },
        { method: 'express', code: 3, cost: 799 },
        { method: 'economy', code: 4, cost: 399 },
      ],
    });
  });

  it('leaves out a method with no key and reports unknown keys under other', () => {
    expect(parseShippingQuote({ standard: 1000, drone: 1 })).toEqual({
      methods: [{ method: 'standard', code: 1, cost: 1000 }],
      other: { drone: 1 },
    });
    expect(parseShippingQuote({})).toEqual({ methods: [] });
    expect(parseShippingQuote({ standard: 1 })).not.toHaveProperty('other');
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/tools/shipping-method.test.ts`
Expected: FAIL, `Cannot find module '../../src/tools/shipping-method.js'`.

- [ ] **Step 3: Write the module**

Create `src/tools/shipping-method.ts`:

```ts
import { SHIPPING_METHODS, type ShippingMethod } from '../printify/catalog.js';

/** The names `create_order` takes, shared with the catalog's shipping tools. */
export const ORDER_SHIPPING_METHODS = SHIPPING_METHODS;
export type { ShippingMethod };

export type ShippingMethodCode = 1 | 2 | 3 | 4;

// The order endpoints take a code: 1 standard, 2 priority (once called express), 3 Printify
// Express (the docs' transitional printify_express, final name express), 4 economy.
const CODES: Readonly<Record<ShippingMethod, ShippingMethodCode>> = {
  standard: 1,
  priority: 2,
  express: 3,
  economy: 4,
};

const NAMES: ReadonlyMap<number, ShippingMethod> = new Map(
  ORDER_SHIPPING_METHODS.map((method) => [CODES[method], method]),
);

/** One method of a shipping quote: its name, the code `create_order` sends, the cost in cents. */
export interface QuoteRow {
  method: ShippingMethod;
  code: ShippingMethodCode;
  cost: number;
}

export interface ShippingQuote {
  methods: QuoteRow[];
  /** Keys of the quote no rule consumed, so a renamed method is visible rather than lost. */
  other?: Record<string, number>;
}

export function shippingMethodCode(method: ShippingMethod): ShippingMethodCode {
  return CODES[method];
}

/** The name for a code, the code as text when it is not one of the four, undefined for none. */
export function shippingMethodName(code: number | undefined): string | undefined {
  if (code === undefined) return undefined;
  return NAMES.get(code) ?? String(code);
}

/**
 * Translates `shipping.json`'s flat answer into rows named like `create_order`'s input. Printify
 * is renaming its keys: the old set is standard/express/economy, the current one adds priority
 * (same cost as express) and printify_express, and the final one is standard/priority/express/
 * economy with express meaning Printify Express. Each rule consumes the key it reads.
 */
export function parseShippingQuote(raw: Readonly<Record<string, number>>): ShippingQuote {
  const rest = new Map(Object.entries(raw));
  const take = (key: string): number | undefined => {
    const value = rest.get(key);
    rest.delete(key);
    return value;
  };
  const standard = take('standard');
  const priority = take('priority');
  const oldExpress = take('express');
  const printifyExpress = take('printify_express');
  const economy = take('economy');

  const costs: Partial<Record<ShippingMethod, number>> = {
    standard,
    priority: priority ?? oldExpress,
    // With priority present, express is the final spelling of Printify Express.
    express: printifyExpress ?? (priority === undefined ? undefined : oldExpress),
    economy,
  };
  const methods: QuoteRow[] = [];
  for (const method of ORDER_SHIPPING_METHODS) {
    const cost = costs[method];
    if (cost !== undefined) methods.push({ method, code: CODES[method], cost });
  }
  return rest.size === 0 ? { methods } : { methods, other: Object.fromEntries(rest) };
}
```

The `Map` is deliberate: ESLint forbids `delete` on a computed key of a plain object.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/tools/shipping-method.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `npx prettier --write src/tools/shipping-method.ts test/tools/shipping-method.test.ts && npm run lint && npm run typecheck`

```bash
git add src/tools/shipping-method.ts test/tools/shipping-method.test.ts
git commit -F - <<'EOF'
Map the catalog shipping names to order codes and parse the quote

The order endpoints take codes 1-4 and shipping.json answers with keys
Printify is renaming; both are translated to the names list_shipping_methods
uses, with express meaning Printify Express.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

A subagent implementer uses its own model's `Co-Authored-By` line instead.

---

### Task 4: Order rows and summaries

**Files:**

- Create: `src/tools/order-summary.ts`
- Test: `test/tools/order-summary.test.ts`

**Interfaces:**

- Consumes: the types of Task 2; `shippingMethodName` from Task 3; `omitKeys` from
  `src/tools/shape.ts`.
- Produces: `SummaryOptions { includeAddress }`, `OrderRow`, `LineItemRow`, `OrderSummary`,
  `ExpressOrderRow { order_id, fulfilment_type, app_order_id, line_items }`, `orderRow(order,
options)`, `summarizeOrder(order, options)`, `lineItemRow(item)`, `expressOrderRow(order)`.

- [ ] **Step 1: Write the failing tests**

Create `test/tools/order-summary.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Order } from '../../src/printify/orders.js';
import { expressOrderRow, orderRow, summarizeOrder } from '../../src/tools/order-summary.js';
import { ADDRESS, ORDER, order } from '../fixtures/orders.js';

const OFF = { includeAddress: false };
const ON = { includeAddress: true };

/** The fixture as the request module would hand it over: nulls already turned to undefined. */
function parsed(overrides: Partial<typeof ORDER> = {}): Order {
  const raw = order(overrides);
  return {
    ...raw,
    sent_to_production_at: raw.sent_to_production_at ?? undefined,
    fulfilled_at: raw.fulfilled_at ?? undefined,
    line_items: raw.line_items.map((item) => ({
      ...item,
      sent_to_production_at: item.sent_to_production_at ?? undefined,
      fulfilled_at: item.fulfilled_at ?? undefined,
    })),
  };
}

describe('orderRow', () => {
  it('summarises the order without the address, naming the method and the external id', () => {
    const row = orderRow(parsed(), OFF);
    expect(row).toEqual({
      id: ORDER.id,
      app_order_id: '215014.44',
      external_id: '1370762297',
      status: 'on-hold',
      shipping_method: 'standard',
      is_printify_express: false,
      is_economy_shipping: false,
      total_price: 3700,
      total_shipping: 400,
      total_tax: 0,
      line_item_count: 2,
      created_at: ORDER.created_at,
      sent_to_production_at: undefined,
      fulfilled_at: undefined,
    });
    expect(row).not.toHaveProperty('address_to');
  });

  it('passes the address on as sent when asked', () => {
    expect(orderRow(parsed(), ON).address_to).toEqual(ADDRESS);
  });

  it('keeps a string shop_order_id and reports an unknown method code as text', () => {
    const row = orderRow(
      parsed({ metadata: { ...ORDER.metadata, shop_order_id: 'ext-9' }, shipping_method: 7 }),
      OFF,
    );
    expect(row).toMatchObject({ external_id: 'ext-9', shipping_method: '7' });
  });

  it('leaves external_id and line_item_count undefined when Printify sent nothing', () => {
    const row = orderRow({ id: 'bare' }, OFF);
    expect(row.external_id).toBeUndefined();
    expect(row.line_item_count).toBeUndefined();
  });
});

describe('summarizeOrder', () => {
  it('adds flattened line items, metadata without shop_order_id, shipments and connect', () => {
    const summary = summarizeOrder(parsed(), OFF);
    expect(summary.line_items?.[0]).toEqual({
      product_id: '5b05842f3921c9547531758d',
      variant_id: 17887,
      quantity: 1,
      print_provider_id: 5,
      cost: 1050,
      shipping_cost: 400,
      status: 'on-hold',
      title: '18K gold plated Necklace',
      price: 2200,
      variant_label: 'Golden indigocoin',
      sku: '168699843',
      print_provider_country: 'United States',
      external_id: 'line-item-abc-001',
      sent_to_production_at: undefined,
      fulfilled_at: undefined,
    });
    expect(summary.metadata).toEqual({
      order_type: 'api',
      shop_order_label: '1370762297',
      shop_fulfilled_at: '2017-04-18 13:24:28+00:00',
      is_reprint: false,
      reprinted_order_ids: [],
      child_reprinted_order_ids: [],
    });
    expect(summary.metadata).not.toHaveProperty('shop_order_id');
    expect(summary.shipments).toEqual(ORDER.shipments);
    expect(summary.printify_connect).toEqual(ORDER.printify_connect);
    expect(summary).not.toHaveProperty('address_to');
  });

  it('includes the address only when asked', () => {
    expect(summarizeOrder(parsed(), ON).address_to).toEqual(ADDRESS);
  });
});

describe('expressOrderRow', () => {
  it('names the order id and flattens its line items', () => {
    const row = expressOrderRow({
      id: 'x1',
      fulfilment_type: 'express',
      app_order_id: undefined,
      line_items: [{ product_id: 'p', metadata: { title: 'Tee' } }],
    });
    expect(row).toMatchObject({
      order_id: 'x1',
      fulfilment_type: 'express',
      line_items: [{ product_id: 'p', title: 'Tee' }],
    });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/tools/order-summary.test.ts`
Expected: FAIL, `Cannot find module '../../src/tools/order-summary.js'`.

- [ ] **Step 3: Write the module**

Create `src/tools/order-summary.ts`:

```ts
import type {
  ExpressOrder,
  Order,
  OrderAddress,
  OrderLineItem,
  OrderMetadata,
  Shipment,
} from '../printify/orders.js';
import { omitKeys } from './shape.js';
import { shippingMethodName } from './shipping-method.js';

export interface SummaryOptions {
  /** Whether to pass `address_to` on. Off by default, to keep personal data out of transcripts. */
  includeAddress: boolean;
}

/** One row of `list_orders`. */
export interface OrderRow {
  id: string;
  app_order_id: string | undefined;
  /** The `external_id` the order was submitted with, from `metadata.shop_order_id`. */
  external_id: string | undefined;
  status: string | undefined;
  shipping_method: string | undefined;
  is_printify_express: boolean | undefined;
  is_economy_shipping: boolean | undefined;
  total_price: number | undefined;
  total_shipping: number | undefined;
  total_tax: number | undefined;
  line_item_count: number | undefined;
  created_at: string | undefined;
  sent_to_production_at: string | undefined;
  fulfilled_at: string | undefined;
  address_to?: OrderAddress | undefined;
}

/** A line item with its metadata flattened in. */
export interface LineItemRow {
  product_id: string | undefined;
  variant_id: number | undefined;
  quantity: number | undefined;
  print_provider_id: number | undefined;
  cost: number | undefined;
  shipping_cost: number | undefined;
  status: string | undefined;
  title: string | undefined;
  price: number | undefined;
  variant_label: string | undefined;
  sku: string | undefined;
  /** Where the print provider is, e.g. "United States". */
  print_provider_country: string | undefined;
  external_id: string | undefined;
  sent_to_production_at: string | undefined;
  fulfilled_at: string | undefined;
}

/** `get_order`'s result, and `cancel_order`'s. */
export interface OrderSummary extends OrderRow {
  line_items: LineItemRow[] | undefined;
  metadata: Omit<OrderMetadata, 'shop_order_id'> | undefined;
  shipments: Shipment[] | undefined;
  printify_connect: Order['printify_connect'];
}

/** One order of `create_express_order`'s result. */
export interface ExpressOrderRow {
  order_id: string;
  fulfilment_type: string | undefined;
  app_order_id: string | undefined;
  line_items: LineItemRow[] | undefined;
}

export function orderRow(order: Order, { includeAddress }: SummaryOptions): OrderRow {
  const shopOrderId = order.metadata?.shop_order_id;
  return {
    id: order.id,
    app_order_id: order.app_order_id,
    external_id: shopOrderId === undefined ? undefined : String(shopOrderId),
    status: order.status,
    shipping_method: shippingMethodName(order.shipping_method),
    is_printify_express: order.is_printify_express,
    is_economy_shipping: order.is_economy_shipping,
    total_price: order.total_price,
    total_shipping: order.total_shipping,
    total_tax: order.total_tax,
    line_item_count: order.line_items?.length,
    created_at: order.created_at,
    sent_to_production_at: order.sent_to_production_at,
    fulfilled_at: order.fulfilled_at,
    ...(includeAddress && { address_to: order.address_to }),
  };
}

export function summarizeOrder(order: Order, options: SummaryOptions): OrderSummary {
  return {
    ...orderRow(order, options),
    line_items: order.line_items?.map(lineItemRow),
    // shop_order_id is already the row's external_id.
    metadata:
      order.metadata === undefined ? undefined : omitKeys(order.metadata, ['shop_order_id']),
    shipments: order.shipments,
    printify_connect: order.printify_connect,
  };
}

export function lineItemRow(item: OrderLineItem): LineItemRow {
  return {
    product_id: item.product_id,
    variant_id: item.variant_id,
    quantity: item.quantity,
    print_provider_id: item.print_provider_id,
    cost: item.cost,
    shipping_cost: item.shipping_cost,
    status: item.status,
    title: item.metadata?.title,
    price: item.metadata?.price,
    variant_label: item.metadata?.variant_label,
    sku: item.metadata?.sku,
    print_provider_country: item.metadata?.country,
    external_id: item.metadata?.external_id,
    sent_to_production_at: item.sent_to_production_at,
    fulfilled_at: item.fulfilled_at,
  };
}

export function expressOrderRow(order: ExpressOrder): ExpressOrderRow {
  return {
    order_id: order.id,
    fulfilment_type: order.fulfilment_type,
    app_order_id: order.app_order_id,
    line_items: order.line_items?.map(lineItemRow),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/tools/order-summary.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `npx prettier --write src/tools/order-summary.ts test/tools/order-summary.test.ts && npm run lint && npm run typecheck`

```bash
git add src/tools/order-summary.ts test/tools/order-summary.test.ts
git commit -F - <<'EOF'
Summarise orders without the recipient's address

orderRow and summarizeOrder flatten what list_orders and get_order show;
address_to is passed on only when includeAddress is set.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

A subagent implementer uses its own model's `Co-Authored-By` line instead.

---

### Task 5: The seven tools, wiring, CI

**Files:**

- Modify: `src/tools/products.ts` (export `printDetailsInput`)
- Create: `src/tools/orders.ts`
- Modify: `src/tools/index.ts`
- Modify: `.github/workflows/ci.yml`
- Test: `test/tools/orders.test.ts`

**Interfaces:**

- Consumes: everything Tasks 2–4 produce; `productId` and `printDetailsInput` from
  `src/tools/products.ts`; `shopIdInput`, `resolveShopId` from `src/tools/shop-id.ts`;
  `defineTool`, `ToolError` from `src/tools/define.ts`; `PAGE_LIMITS` from
  `src/printify/pagination.ts`.
- Produces: `ordersTools` and the seven tool objects, registered through `TOOLS_BY_TOOLSET.orders`.

- [ ] **Step 1: Export the shared print details schema**

In `src/tools/products.ts`, change the `printDetailsInput` declaration:

<!-- prettier-ignore -->
```ts
/** Shared with the order tools: an on-the-fly line item takes the same print details. */
export const printDetailsInput = z.strictObject({
```

- [ ] **Step 2: Write the failing tests**

Create `test/tools/orders.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { TOOLS_BY_TOOLSET } from '../../src/tools/index.js';
import { omitKeys } from '../../src/tools/shape.js';
import { apiErrorBody, notFoundBody } from '../fixtures/errors.js';
import {
  ADDRESS,
  CANCEL_PATH,
  EXPRESS_PATH,
  EXPRESS_RESPONSE,
  ORDER,
  ORDER_PATH,
  ORDERS_PATH,
  PRODUCTION_PATH,
  QUOTE_TRANSITIONAL,
  SHIPPING_PATH,
  SHOP_ID,
  order,
  orderConflictBody,
  ordersPage,
} from '../fixtures/orders.js';
import { SHOP } from '../fixtures/shops.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { fails, json } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';

const ORDERS_ON = { PRINTIFY_ENABLE_ORDERS: 'true' };
const GATED = ['create_order', 'create_express_order', 'send_order_to_production', 'cancel_order'];
const READ = ['list_orders', 'get_order', 'calculate_shipping'];
const PRODUCT_ITEM = { product_id: '5b05842f3921c9547531758d', variant_id: 17887, quantity: 1 };
const SKU_ITEM = { sku: 'MY-SKU', quantity: 2 };
const NEW_PRODUCT_ITEM = {
  blueprint_id: 9,
  print_provider_id: 5,
  variant_id: 17887,
  quantity: 1,
  print_areas: { front: 'https://images.example.com/image.png' },
};
/** The input address: the documented one without `company`, which the tools take too. */
const ADDRESS_INPUT = omitKeys(ADDRESS, ['company']);
const CREATE_INPUT = {
  shop_id: SHOP_ID,
  external_id: 'order-ext-1',
  line_items: [PRODUCT_ITEM],
  shipping_method: 'standard',
  address_to: ADDRESS_INPUT,
};

describe('the orders toolset', () => {
  it('registers only the read tools without PRINTIFY_ENABLE_ORDERS, and says so', async () => {
    const { mcp, selection } = await createTestServer();
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    for (const name of READ) expect(names).toContain(name);
    for (const name of GATED) expect(names).not.toContain(name);
    expect(selection.skipped.map(({ tool, reason }) => [tool.name, reason])).toEqual(
      expect.arrayContaining(GATED.map((name) => [name, 'orders'])),
    );
    expect(mcp.getInstructions()).toMatch(
      /Order tools that can spend money \(.*cancel_order.*\): set PRINTIFY_ENABLE_ORDERS=true\./,
    );
  });

  it('registers all seven with the flag, in order, with the right annotations', async () => {
    const { mcp } = await createTestServer({ env: ORDERS_ON });
    const { tools } = await mcp.listTools();
    const ours = tools.filter(({ name }) => [...READ, ...GATED].includes(name));
    expect(ours.map(({ name }) => name)).toEqual([...READ, ...GATED]);
    expect(TOOLS_BY_TOOLSET.orders.map(({ name }) => name)).toEqual([...READ, ...GATED]);
    const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
    const gated = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
    for (const tool of ours) {
      expect(tool.annotations).toMatchObject(READ.includes(tool.name) ? readOnly : gated);
    }
    const byName = new Map(ours.map((tool) => [tool.name, tool.description]));
    expect(byName.get('create_order')).toContain('This spends real money');
    expect(byName.get('create_express_order')).toContain('This spends real money');
    expect(byName.get('send_order_to_production')).toContain('This charges the account');
    expect(byName.get('cancel_order')).toContain('on-hold or payment-not-received');
  });
});

describe('list_orders', () => {
  it('lists rows without the address', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${ORDERS_PATH}`]: ordersPage([ORDER]) },
    });
    const data = expectToolData(await call('list_orders', { shop_id: SHOP_ID }));
    expect(data).toMatchObject({ page: 1, has_more: false, total: 1, last_page: 1 });
    expect(data['orders']).toEqual([
      {
        id: ORDER.id,
        app_order_id: '215014.44',
        external_id: '1370762297',
        status: 'on-hold',
        shipping_method: 'standard',
        is_printify_express: false,
        is_economy_shipping: false,
        total_price: 3700,
        total_shipping: 400,
        total_tax: 0,
        line_item_count: 2,
        created_at: ORDER.created_at,
      },
    ]);
    expect(api.expectRequest('GET', ORDERS_PATH).query).toEqual({});
  });

  it('passes page, limit, status and sku on', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${ORDERS_PATH}`]: ordersPage([], { last_page: 3, total: 21 }) },
    });
    const data = expectToolData(
      await call('list_orders', {
        shop_id: SHOP_ID,
        page: 2,
        limit: 10,
        status: 'fulfilled',
        sku: '168699843',
      }),
    );
    expect(data).toMatchObject({ page: 1, has_more: true, last_page: 3, total: 21 });
    expect(api.expectRequest('GET', ORDERS_PATH).query).toEqual({
      page: '2',
      limit: '10',
      status: 'fulfilled',
      sku: '168699843',
    });
  });

  it('includes the address in each row when asked', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ORDERS_PATH}`]: ordersPage([ORDER]) },
    });
    const data = expectToolData(
      await call('list_orders', { shop_id: SHOP_ID, include_address: true }),
    );
    expect(data['orders']).toEqual([expect.objectContaining({ address_to: ADDRESS })]);
  });

  it.each([
    ['a limit above 10', { limit: 11 }],
    ['an unknown status', { status: 'shipped' }],
    ['an unknown argument', { customer: 'x' }],
  ])('rejects %s before any request', async (_, args) => {
    const { call, api } = await createTestServer();
    expectToolError(await call('list_orders', { shop_id: SHOP_ID, ...args }), {
      kind: 'validation',
    });
    expect(api.requests).toEqual([]);
  });

  it('uses the default shop when shop_id is left out', async () => {
    const { call, api } = await createTestServer({
      routes: { 'GET /v1/shops.json': [SHOP], [`GET ${ORDERS_PATH}`]: ordersPage([]) },
    });
    expect(expectToolData(await call('list_orders'))).toMatchObject({ orders: [] });
    api.expectRequest('GET', ORDERS_PATH);
  });
});

describe('get_order', () => {
  it('returns the summary without the address', async () => {
    const { call } = await createTestServer({ routes: { [`GET ${ORDER_PATH}`]: ORDER } });
    const data = expectToolData(await call('get_order', { shop_id: SHOP_ID, order_id: ORDER.id }));
    expect(data).toMatchObject({
      id: ORDER.id,
      external_id: '1370762297',
      line_items: [
        expect.objectContaining({ title: '18K gold plated Necklace', sku: '168699843' }),
        expect.objectContaining({ title: 'Mug 11oz' }),
      ],
      metadata: expect.objectContaining({ order_type: 'api' }) as object,
      shipments: ORDER.shipments,
    });
    expect(data).not.toHaveProperty('address_to');
  });

  it('includes the address when asked', async () => {
    const { call } = await createTestServer({ routes: { [`GET ${ORDER_PATH}`]: ORDER } });
    const data = expectToolData(
      await call('get_order', { shop_id: SHOP_ID, order_id: ORDER.id, include_address: true }),
    );
    expect(data['address_to']).toEqual(ADDRESS);
  });

  it('keeps the not-found hint on a 404', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ORDER_PATH}`]: json(notFoundBody(), 404) },
    });
    expectToolError(await call('get_order', { shop_id: SHOP_ID, order_id: ORDER.id }), {
      kind: 'http',
      status: 404,
      hint: expect.stringContaining('belongs to this shop') as string,
    });
  });

  it('rejects an order id with a slash before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(await call('get_order', { shop_id: SHOP_ID, order_id: '../x' }), {
      kind: 'validation',
    });
    expect(api.requests).toEqual([]);
  });
});

describe('calculate_shipping', () => {
  it('sends the line items and address and returns the quote as rows', async () => {
    const { call, api } = await createTestServer({
      routes: { [`POST ${SHIPPING_PATH}`]: QUOTE_TRANSITIONAL },
    });
    const data = expectToolData(
      await call('calculate_shipping', {
        shop_id: SHOP_ID,
        line_items: [PRODUCT_ITEM, SKU_ITEM, NEW_PRODUCT_ITEM],
        address_to: ADDRESS_INPUT,
      }),
    );
    expect(data).toEqual({
      methods: [
        { method: 'standard', code: 1, cost: 1000 },
        { method: 'priority', code: 2, cost: 5000 },
        { method: 'express', code: 3, cost: 799 },
        { method: 'economy', code: 4, cost: 399 },
      ],
    });
    expect(api.expectRequest('POST', SHIPPING_PATH).body).toEqual({
      line_items: [PRODUCT_ITEM, SKU_ITEM, NEW_PRODUCT_ITEM],
      address_to: ADDRESS_INPUT,
    });
  });

  it('reports a quote key it does not know under other', async () => {
    const { call } = await createTestServer({
      routes: { [`POST ${SHIPPING_PATH}`]: { standard: 1000, drone: 1 } },
    });
    const data = expectToolData(
      await call('calculate_shipping', {
        shop_id: SHOP_ID,
        line_items: [PRODUCT_ITEM],
        address_to: ADDRESS_INPUT,
      }),
    );
    expect(data).toEqual({
      methods: [{ method: 'standard', code: 1, cost: 1000 }],
      other: { drone: 1 },
    });
  });

  it('rejects a line item that matches no shape before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(
      await call('calculate_shipping', {
        shop_id: SHOP_ID,
        line_items: [{ variant_id: 17887, quantity: 1 }],
        address_to: ADDRESS_INPUT,
      }),
      { kind: 'validation' },
    );
    expect(api.requests).toEqual([]);
  });
});

describe('create_order', () => {
  it.each([
    ['an existing product', PRODUCT_ITEM],
    ['a SKU', SKU_ITEM],
    ['a product created on the fly', NEW_PRODUCT_ITEM],
  ])('sends %s line item as given, with the method as a code', async (_, item) => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${ORDERS_PATH}`]: { id: ORDER.id } },
    });
    const data = expectToolData(
      await call('create_order', {
        ...CREATE_INPUT,
        line_items: [item],
        shipping_method: 'express',
      }),
    );
    expect(data).toEqual({
      order_id: ORDER.id,
      created: true,
      external_id: 'order-ext-1',
      shipping_method: 'express',
      next_step: expect.stringContaining('send_order_to_production') as string,
    });
    expect(data['next_step']).toContain('cancel_order');
    expect(api.expectRequest('POST', ORDERS_PATH).body).toEqual({
      external_id: 'order-ext-1',
      line_items: [item],
      shipping_method: 3,
      send_shipping_notification: false,
      address_to: ADDRESS_INPUT,
    });
  });

  it('sends label and send_shipping_notification when given', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${ORDERS_PATH}`]: { id: ORDER.id } },
    });
    expectToolData(
      await call('create_order', {
        ...CREATE_INPUT,
        label: '00012',
        send_shipping_notification: true,
      }),
    );
    expect(api.expectRequest('POST', ORDERS_PATH).body).toMatchObject({
      label: '00012',
      shipping_method: 1,
      send_shipping_notification: true,
    });
  });

  it('reports a duplicate external_id as the existing order, not an error', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${ORDERS_PATH}`]: json(orderConflictBody('existing1'), 409) },
    });
    const result = await call('create_order', CREATE_INPUT);
    expect(result.isError).not.toBe(true);
    expect(expectToolData(result)).toEqual({
      order_id: 'existing1',
      created: false,
      external_id: 'order-ext-1',
      shipping_method: 'standard',
      next_step: expect.stringContaining('nothing new was created') as string,
    });
    expect(api.requests).toHaveLength(1);
  });

  it('refuses economy shipping with an on-the-fly line item before any request', async () => {
    const { call, api } = await createTestServer({ env: ORDERS_ON });
    expectToolError(
      await call('create_order', {
        ...CREATE_INPUT,
        line_items: [PRODUCT_ITEM, NEW_PRODUCT_ITEM],
        shipping_method: 'economy',
      }),
      {
        kind: 'tool',
        message: 'Economy shipping cannot be used with a product created on the fly.',
        hint: expect.stringContaining('create_product') as string,
      },
    );
    expect(api.requests).toEqual([]);
  });

  it.each([
    ['a missing external_id', { external_id: undefined }],
    ['the old printify_express name', { shipping_method: 'printify_express' }],
    ['a line item matching no shape', { line_items: [{ variant_id: 1, quantity: 1 }] }],
    ['an address without a zip', { address_to: { ...ADDRESS_INPUT, zip: undefined } }],
    ['a three-letter country', { address_to: { ...ADDRESS_INPUT, country: 'USA' } }],
    ['a quantity of zero', { line_items: [{ ...PRODUCT_ITEM, quantity: 0 }] }],
    ['an empty print area', { line_items: [{ ...NEW_PRODUCT_ITEM, print_areas: { front: [] } }] }],
    ['an unknown argument', { is_printify_express: true }],
  ])('rejects %s before any request', async (_, args) => {
    const { call, api } = await createTestServer({ env: ORDERS_ON });
    expectToolError(await call('create_order', { ...CREATE_INPUT, ...args }), {
      kind: 'validation',
    });
    expect(api.requests).toEqual([]);
  });

  it('passes an address validation error on with its hint, address redacted', async () => {
    const { call } = await createTestServer({
      env: ORDERS_ON,
      routes: {
        [`POST ${ORDERS_PATH}`]: json(
          apiErrorBody({ code: 8103, message: 'Validation failed.', reason: 'zip required' }),
          400,
        ),
      },
    });
    expectToolError(await call('create_order', CREATE_INPUT), {
      kind: 'http',
      status: 400,
      code: 8103,
      hint: expect.stringContaining('shipping address failed validation') as string,
    });
  });

  it('warns that a failed create may have gone through', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${ORDERS_PATH}`]: fails() },
    });
    const pending = call('create_order', CREATE_INPUT);
    await vi.waitUntil(() => api.requests.length === 1);
    expectToolError(await pending, {
      kind: 'network',
      hint: expect.stringContaining('may still have gone through') as string,
    });
    expect(api.requests).toHaveLength(1);
  });
});

describe('create_express_order', () => {
  const EXPRESS_INPUT = {
    shop_id: SHOP_ID,
    external_id: 'order-ext-2',
    line_items: [PRODUCT_ITEM, SKU_ITEM],
    address_to: ADDRESS_INPUT,
  };

  it('always sends code 3 and returns the express/ordinary split', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${EXPRESS_PATH}`]: EXPRESS_RESPONSE },
    });
    const data = expectToolData(await call('create_express_order', EXPRESS_INPUT));
    expect(data).toMatchObject({
      created: true,
      external_id: 'order-ext-2',
      orders: [
        {
          order_id: '5a96f649b2439217d070f508',
          fulfilment_type: 'express',
          app_order_id: '215014.44',
          line_items: [expect.objectContaining({ title: '18K gold plated Necklace', cost: 2200 })],
        },
        { order_id: '5a96f649b2439597d020a9b4', fulfilment_type: 'ordinary' },
      ],
      next_step: expect.stringContaining('send_order_to_production') as string,
    });
    expect(api.expectRequest('POST', EXPRESS_PATH).body).toEqual({
      external_id: 'order-ext-2',
      line_items: [PRODUCT_ITEM, SKU_ITEM],
      shipping_method: 3,
      send_shipping_notification: false,
      address_to: ADDRESS_INPUT,
    });
  });

  it('reports a duplicate external_id as the existing order', async () => {
    const { call } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${EXPRESS_PATH}`]: json(orderConflictBody('existing2'), 409) },
    });
    expect(expectToolData(await call('create_express_order', EXPRESS_INPUT))).toEqual({
      created: false,
      external_id: 'order-ext-2',
      orders: [{ order_id: 'existing2' }],
      next_step: expect.stringContaining('list_orders shows both') as string,
    });
  });

  it.each([
    ['an address without a phone', { address_to: { ...ADDRESS_INPUT, phone: undefined } }],
    ['an on-the-fly line item', { line_items: [NEW_PRODUCT_ITEM] }],
    ['a shipping_method', { shipping_method: 'express' }],
  ])('rejects %s before any request', async (_, args) => {
    const { call, api } = await createTestServer({ env: ORDERS_ON });
    expectToolError(await call('create_express_order', { ...EXPRESS_INPUT, ...args }), {
      kind: 'validation',
    });
    expect(api.requests).toEqual([]);
  });
});

describe('send_order_to_production', () => {
  it('posts to the order and reports it as sent', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${PRODUCTION_PATH}`]: { id: ORDER.id } },
    });
    expect(
      expectToolData(
        await call('send_order_to_production', { shop_id: SHOP_ID, order_id: ORDER.id }),
      ),
    ).toEqual({ order_id: ORDER.id, sent_to_production: true });
    expect(api.expectRequest('POST', PRODUCTION_PATH).body).toBeUndefined();
  });
});

describe('cancel_order', () => {
  it('checks the status, cancels an on-hold order and returns it without the address', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: {
        [`GET ${ORDER_PATH}`]: ORDER,
        [`POST ${CANCEL_PATH}`]: order({ status: 'canceled', total_price: 0 }),
      },
    });
    const data = expectToolData(
      await call('cancel_order', { shop_id: SHOP_ID, order_id: ORDER.id }),
    );
    expect(data).toMatchObject({ id: ORDER.id, status: 'canceled', cancelled: true });
    expect(data).not.toHaveProperty('address_to');
    expect(api.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET ${ORDER_PATH}`,
      `POST ${CANCEL_PATH}`,
    ]);
  });

  it('accepts payment-not-received', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: {
        [`GET ${ORDER_PATH}`]: order({ status: 'payment-not-received' }),
        [`POST ${CANCEL_PATH}`]: order({ status: 'canceled' }),
      },
    });
    expectToolData(await call('cancel_order', { shop_id: SHOP_ID, order_id: ORDER.id }));
    api.expectRequest('POST', CANCEL_PATH);
  });

  it('passes a 404 from the status check on, without sending the cancel', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`GET ${ORDER_PATH}`]: json(notFoundBody(), 404) },
    });
    expectToolError(await call('cancel_order', { shop_id: SHOP_ID, order_id: ORDER.id }), {
      kind: 'http',
      status: 404,
    });
    expect(api.requests).toHaveLength(1);
  });

  it.each([['in-production'], ['fulfilled'], [undefined]])(
    'refuses an order whose status is %s, without sending the cancel',
    async (status) => {
      const { call, api } = await createTestServer({
        env: ORDERS_ON,
        routes: { [`GET ${ORDER_PATH}`]: order({ status: status as string }) },
      });
      expectToolError(await call('cancel_order', { shop_id: SHOP_ID, order_id: ORDER.id }), {
        kind: 'tool',
        message: `Order ${ORDER.id} has status ${status ?? 'unknown'}, so Printify will not cancel it.`,
        hint: expect.stringContaining('on-hold or payment-not-received') as string,
      });
      expect(api.requests).toHaveLength(1);
    },
  );
});
```

The "may have gone through" test uses `fails()` (a network error) rather than a timeout: the
harness client's timeout is fixed at 30 s, and a POST network error carries the same hint.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run test/tools/orders.test.ts`
Expected: FAIL. Every call reports an unknown tool, because nothing is registered yet.

- [ ] **Step 4: Write the tool file**

Create `src/tools/orders.ts`:

```ts
import { z } from 'zod';
import {
  calculateShipping,
  cancelOrder,
  getOrder,
  listOrders,
  sendOrderToProduction,
  submitExpressOrder,
  submitOrder,
} from '../printify/orders.js';
import { PAGE_LIMITS } from '../printify/pagination.js';
import { defineTool, ToolError, type Tool, type ToolAnnotations } from './define.js';
import { expressOrderRow, orderRow, summarizeOrder } from './order-summary.js';
import { printDetailsInput, productId } from './products.js';
import {
  ORDER_SHIPPING_METHODS,
  parseShippingQuote,
  shippingMethodCode,
} from './shipping-method.js';
import { resolveShopId, shopIdInput } from './shop-id.js';

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/** Spends money or stops an order; a repeat with the same arguments changes nothing more. */
const GATED: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};

/** Printify Express Delivery's code; the express endpoint takes no other. */
const EXPRESS_CODE = 3;

// Letters and digits only, like productId: apiPath URL-encodes anything else.
const orderId = z
  .string()
  .regex(/^[A-Za-z0-9]+$/, 'order_id must be letters and digits')
  .describe('The order id, e.g. from list_orders.');

const ORDER_STATUSES = [
  'pending',
  'on-hold',
  'sending-to-production',
  'in-production',
  'canceled',
  'fulfilled',
  'partially-fulfilled',
  'payment-not-received',
  'has-issues',
  'cost-calculation',
  'unfulfillable',
  'sending_to_production_delegate',
  'sending_to_production_delegate_sync',
  'source-check-failed',
] as const;

/** The statuses Printify cancels an order in. */
const CANCELLABLE_STATUSES: readonly string[] = ['on-hold', 'payment-not-received'];

const includeAddressInput = z
  .boolean()
  .default(false)
  .describe(
    "Include the recipient's address, email and phone. Off by default, to keep personal data " +
      'out of the conversation.',
  );

const addressFields = {
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  address1: z.string().min(1),
  address2: z.string().optional(),
  city: z.string().min(1),
  zip: z.string().min(1),
  country: z.string().length(2).describe('ISO 3166-1 alpha-2, e.g. US.'),
  region: z.string().optional().describe('The state or province, where the country has them.'),
  company: z.string().optional(),
};

const addressInput = z
  .strictObject({
    ...addressFields,
    email: z.string().optional(),
    phone: z.string().optional(),
  })
  .describe("The recipient's address.");

const expressAddressInput = z
  .strictObject({
    ...addressFields,
    email: z.string().min(1).describe('Required for Printify Express.'),
    phone: z.string().min(1).describe('Required for Printify Express.'),
  })
  .describe("The recipient's address. Printify Express needs the email and phone.");

const quantity = z.number().int().positive().describe('How many of this variant.');
const lineItemExternalId = z
  .string()
  .min(1)
  .optional()
  .describe('An id of your own for the line item, kept through replacements.');
const variantId = z.number().int().positive().describe('The variant id, from get_product.');

const productLineItemInput = z.strictObject({
  product_id: productId,
  variant_id: variantId,
  quantity,
  external_id: lineItemExternalId,
});

const skuLineItemInput = z.strictObject({
  sku: z.string().min(1).describe("A variant's SKU, from get_product."),
  quantity,
  external_id: lineItemExternalId,
});

const imageUrl = z.url().describe('A publicly reachable image URL.');
const placedImageInput = z.strictObject({
  src: imageUrl,
  x: z.number().min(0).max(1).describe("The image centre's horizontal position, 0–1."),
  y: z.number().min(0).max(1).describe("The image centre's vertical position, 0–1."),
  scale: z.number().positive().describe('The image width divided by the print area width.'),
  angle: z.number().min(-360).max(360).describe('Rotation in degrees; 0 is upright.'),
});

const newProductLineItemInput = z.strictObject({
  blueprint_id: z.number().int().positive().describe('From search_blueprints.'),
  print_provider_id: z.number().int().positive().describe('From list_blueprint_providers.'),
  variant_id: z.number().int().positive().describe('From list_variants.'),
  quantity,
  print_areas: z
    .record(z.string().min(1), z.union([imageUrl, z.array(placedImageInput).min(1)]))
    .describe(
      'Position to artwork, e.g. { "front": "https://…/art.png" }: a URL fills the print ' +
        'area, or an array of placed images for advanced positioning.',
    ),
  print_details: printDetailsInput.optional(),
  external_id: lineItemExternalId,
});

const lineItemInput = z.union([productLineItemInput, skuLineItemInput, newProductLineItemInput]);
const existingLineItemInput = z.union([productLineItemInput, skuLineItemInput]);

const LINE_ITEM_SHAPES =
  'Each line item is one of: an existing product { product_id, variant_id, quantity }, a SKU ' +
  '{ sku, quantity }, or a product created on the fly { blueprint_id, print_provider_id, ' +
  'variant_id, quantity, print_areas }.';

const shippingMethodInput = z
  .enum(ORDER_SHIPPING_METHODS)
  .describe(
    'standard, priority, express (Printify Express Delivery) or economy. calculate_shipping ' +
      'lists what is available for the items and what each costs.',
  );

const orderFields = {
  external_id: z
    .string()
    .min(1)
    .describe(
      'Your own unique id for this order, e.g. an order number or a fresh UUID. Printify ' +
        'refuses a second order with the same one, so reuse it when retrying.',
    ),
  label: z.string().min(1).optional().describe('A label shown instead of the external_id.'),
  send_shipping_notification: z
    .boolean()
    .default(false)
    .describe('Email the recipient when the order ships.'),
};

const MONEY_WARNING =
  'This spends real money. Confirm the items, quantities, address and shipping method with ' +
  'the user first, and quote the cost with calculate_shipping. Printify charges the account ' +
  "when the order goes to production: with the shop's default automatic approval that " +
  'happens about 24 hours after creation without any further call; with manual approval, ' +
  'when send_order_to_production is called. ';
const EXTERNAL_ID_RULE =
  'external_id is required and must be unique per order. If the call times out or fails ' +
  'with a network error, call again with the SAME external_id, never a new one: Printify then ' +
  'returns the existing order instead of placing a second one, and the result says ' +
  'created: false. ';
const CANCEL_WINDOW =
  'cancel_order can undo the order only while its status is on-hold or payment-not-received.';

const CREATED_NEXT_STEP =
  'The order exists and is not yet charged. If the shop uses automatic order approval ' +
  "(Printify's default for new stores), it goes to production about 24 hours after creation " +
  'and the account is charged then; call send_order_to_production to send it now. With ' +
  'manual approval nothing happens until that call. cancel_order works only while the status ' +
  'is on-hold or payment-not-received; get_order shows the status.';
const DUPLICATE_NEXT_STEP =
  'An order with this external_id already existed, so nothing new was created and nothing ' +
  'was charged by this call. Use get_order with this order_id to see its status.';
const EXPRESS_DUPLICATE_NEXT_STEP =
  DUPLICATE_NEXT_STEP +
  ' An express submission may have produced a second, ordinary order; list_orders shows both.';

export const listOrdersTool = defineTool({
  name: 'list_orders',
  toolset: 'orders',
  description:
    "Lists a shop's orders, newest first, as compact rows: id, external_id, status, shipping " +
    'method, totals in cents, line item count and timestamps. limit is at most 10 ' +
    "(Printify's maximum). status filters by order status; sku keeps the orders that contain " +
    "that SKU. The recipient's address is left out unless include_address is true, to keep " +
    'personal data out of the conversation. Use get_order for the line items.',
  annotations: READ_ONLY,
  input: z.strictObject({
    ...shopIdInput,
    page: z.number().int().positive().optional().describe('The page to fetch, starting at 1.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(PAGE_LIMITS.orders)
      .optional()
      .describe(`Orders per page, at most ${String(PAGE_LIMITS.orders)}.`),
    status: z.enum(ORDER_STATUSES).optional().describe('Only orders with this status.'),
    sku: z.string().min(1).optional().describe('Only orders containing this SKU.'),
    include_address: includeAddressInput,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const page = await listOrders(
      ctx.client,
      shopId,
      { page: input.page, limit: input.limit, status: input.status, sku: input.sku },
      ctx.signal,
    );
    const options = { includeAddress: input.include_address };
    return {
      orders: page.orders.map((order) => orderRow(order, options)),
      page: page.page,
      has_more: page.hasMore,
      total: page.total,
      last_page: page.lastPage,
    };
  },
});

export const getOrderTool = defineTool({
  name: 'get_order',
  toolset: 'orders',
  description:
    'Gets one order: its line items (product, variant, quantity, costs, status, print provider ' +
    'country), totals in cents, status, shipments with tracking, and reprint metadata. The ' +
    "recipient's address is left out unless include_address is true.",
  annotations: READ_ONLY,
  input: z.strictObject({
    ...shopIdInput,
    order_id: orderId,
    include_address: includeAddressInput,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const order = await getOrder(ctx.client, shopId, input.order_id, ctx.signal);
    return { ...summarizeOrder(order, { includeAddress: input.include_address }) };
  },
});

export const calculateShippingTool = defineTool({
  name: 'calculate_shipping',
  toolset: 'orders',
  description:
    'Quotes the shipping cost of an order before it is placed: one row per shipping method, in ' +
    'cents, for the given line items and address. Nothing is created or charged. Each ' +
    "row's method is what create_order takes as shipping_method; a method Printify does not " +
    'offer for these items is absent. ' +
    LINE_ITEM_SHAPES,
  annotations: READ_ONLY,
  input: z.strictObject({
    ...shopIdInput,
    line_items: z.array(lineItemInput).min(1),
    address_to: addressInput,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const raw = await calculateShipping(
      ctx.client,
      shopId,
      { line_items: input.line_items, address_to: input.address_to },
      ctx.signal,
    );
    return { ...parseShippingQuote(raw) };
  },
});

export const createOrderTool = defineTool({
  name: 'create_order',
  toolset: 'orders',
  gate: 'orders',
  description:
    'Creates an order. ' +
    MONEY_WARNING +
    EXTERNAL_ID_RULE +
    LINE_ITEM_SHAPES +
    ' A product created on the fly is slow, may time out, cannot use economy shipping and is ' +
    'slated for deprecation by Printify; create the product first when possible. ' +
    'shipping_method is one of standard, priority, express (Printify Express; every item must ' +
    'be eligible) and economy. ' +
    CANCEL_WINDOW,
  annotations: GATED,
  input: z.strictObject({
    ...shopIdInput,
    ...orderFields,
    line_items: z.array(lineItemInput).min(1),
    shipping_method: shippingMethodInput,
    address_to: addressInput,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    if (
      input.shipping_method === 'economy' &&
      input.line_items.some((item) => 'blueprint_id' in item)
    ) {
      throw new ToolError(
        'Economy shipping cannot be used with a product created on the fly.',
        'Create the product first with create_product, or choose another shipping method.',
      );
    }
    const result = await submitOrder(
      ctx.client,
      shopId,
      {
        external_id: input.external_id,
        label: input.label,
        line_items: input.line_items,
        shipping_method: shippingMethodCode(input.shipping_method),
        send_shipping_notification: input.send_shipping_notification,
        address_to: input.address_to,
      },
      ctx.signal,
    );
    return {
      order_id: result.id,
      created: result.created,
      external_id: input.external_id,
      shipping_method: input.shipping_method,
      next_step: result.created ? CREATED_NEXT_STEP : DUPLICATE_NEXT_STEP,
    };
  },
});

export const createExpressOrderTool = defineTool({
  name: 'create_express_order',
  toolset: 'orders',
  gate: 'orders',
  description:
    'Creates an order with Printify Express Delivery, for existing products only. ' +
    MONEY_WARNING +
    EXTERNAL_ID_RULE +
    'Line items are an existing product { product_id, variant_id, quantity } or a SKU ' +
    '{ sku, quantity }; the address needs email and phone. Printify splits the line items by ' +
    'Printify Express eligibility: all eligible gives one express order, none gives one ' +
    'ordinary order, a mix gives two orders, and the result lists each with its ' +
    'fulfilment_type. Only is_printify_express_eligible on the product and variant counts, ' +
    'not is_printify_express_enabled. Express carriers are not supported by every sales ' +
    'channel, e.g. Amazon and TikTok. ' +
    CANCEL_WINDOW,
  annotations: GATED,
  input: z.strictObject({
    ...shopIdInput,
    ...orderFields,
    line_items: z.array(existingLineItemInput).min(1),
    address_to: expressAddressInput,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const result = await submitExpressOrder(
      ctx.client,
      shopId,
      {
        external_id: input.external_id,
        label: input.label,
        line_items: input.line_items,
        shipping_method: EXPRESS_CODE,
        send_shipping_notification: input.send_shipping_notification,
        address_to: input.address_to,
      },
      ctx.signal,
    );
    if (!result.created) {
      return {
        created: false,
        external_id: input.external_id,
        orders: [{ order_id: result.id }],
        next_step: EXPRESS_DUPLICATE_NEXT_STEP,
      };
    }
    return {
      created: true,
      external_id: input.external_id,
      orders: result.orders.map(expressOrderRow),
      next_step: CREATED_NEXT_STEP,
    };
  },
});

export const sendOrderToProductionTool = defineTool({
  name: 'send_order_to_production',
  toolset: 'orders',
  gate: 'orders',
  description:
    'Sends an order to production now. This charges the account and cannot be undone; confirm ' +
    'with the user first. Needed only when the shop uses manual order approval: with automatic ' +
    'approval Printify sends the order itself about 24 hours after creation. If the call times ' +
    'out, check the status with get_order (sending-to-production or in-production means it ' +
    'went through) before calling again.',
  annotations: GATED,
  input: z.strictObject({ ...shopIdInput, order_id: orderId }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const id = await sendOrderToProduction(ctx.client, shopId, input.order_id, ctx.signal);
    return { order_id: id, sent_to_production: true };
  },
});

export const cancelOrderTool = defineTool({
  name: 'cancel_order',
  toolset: 'orders',
  gate: 'orders',
  description:
    'Cancels an order that has not been paid or sent to production. Printify accepts the ' +
    'cancellation only while the status is on-hold or payment-not-received; the tool checks ' +
    'the status first and refuses otherwise, so an order in production is never touched. An ' +
    "order already in production can only be changed through Printify's support flows " +
    '(reprint, refund, address change), which this server does not offer yet. Returns the ' +
    'cancelled order without the address.',
  annotations: GATED,
  input: z.strictObject({ ...shopIdInput, order_id: orderId }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const current = await getOrder(ctx.client, shopId, input.order_id, ctx.signal);
    const status = current.status ?? 'unknown';
    if (!CANCELLABLE_STATUSES.includes(status)) {
      throw new ToolError(
        `Order ${current.id} has status ${status}, so Printify will not cancel it.`,
        'Only an order with status on-hold or payment-not-received can be cancelled. An order ' +
          'that is already in production can only be changed through Printify support.',
      );
    }
    const cancelled = await cancelOrder(ctx.client, shopId, input.order_id, ctx.signal);
    return { ...summarizeOrder(cancelled, { includeAddress: false }), cancelled: true };
  },
});

/** Every tool of the `orders` toolset, in the order a session uses them. */
export const ordersTools: readonly Tool[] = [
  listOrdersTool,
  getOrderTool,
  calculateShippingTool,
  createOrderTool,
  createExpressOrderTool,
  sendOrderToProductionTool,
  cancelOrderTool,
];
```

- [ ] **Step 5: Wire the toolset in**

In `src/tools/index.ts`, add the import (alphabetical, after `define.js`) and replace the
toolset's empty array:

<!-- prettier-ignore -->
```ts
import type { Tool } from './define.js';
import { ordersTools } from './orders.js';
import { productsTools } from './products.js';
```

<!-- prettier-ignore -->
```ts
  personalization: [],
  orders: ordersTools,
  support: [],
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/tools/orders.test.ts test/tools/catalog.test.ts`
Expected: PASS. `catalog.test.ts` checks every tool against the definition rules and its
toolset.

- [ ] **Step 7: Add the names to the CI smoke step**

In `.github/workflows/ci.yml`, the must-be-absent loop:

<!-- prettier-ignore -->
```yaml
          for tool in disconnect_shop archive_upload delete_product \
            create_order create_express_order send_order_to_production cancel_order; do
```

and the end of the must-be-present loop:

<!-- prettier-ignore -->
```yaml
            publish_product set_publishing_succeeded set_publishing_failed \
            set_product_unpublished \
            list_orders get_order calculate_shipping; do
```

- [ ] **Step 8: Full verification**

Run: `npx prettier --write src/tools/orders.ts test/tools/orders.test.ts && npm run lint && npm run typecheck && npm test && npm run build`
Expected: lint and typecheck silent, 876 tests passing, `dist/` built.

Then the smoke step by hand, once without and once with the flag:

<!-- prettier-ignore -->
```bash
msgs() {
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
}
off=$(msgs | PRINTIFY_API_TOKEN=smoke-test-token timeout 10 node dist/index.js)
on=$(msgs | PRINTIFY_API_TOKEN=smoke-test-token PRINTIFY_ENABLE_ORDERS=true timeout 10 node dist/index.js)
for t in create_order create_express_order send_order_to_production cancel_order; do
  grep -q "\"name\":\"$t\"" <<<"$off" && echo "LEAK: $t registered without the flag"
  grep -q "\"name\":\"$t\"" <<<"$on" || echo "MISSING with flag: $t"
done
for t in list_orders get_order calculate_shipping; do
  grep -q "\"name\":\"$t\"" <<<"$off" || echo "MISSING: $t"
done
```

Expected: no `LEAK` or `MISSING` lines. The stderr banner reads `tools: 27 of 34` without the
flag and `tools: 31 of 34` with it.

- [ ] **Step 9: Commit**

```bash
git add src/tools/orders.ts src/tools/index.ts src/tools/products.ts .github/workflows/ci.yml test/tools/orders.test.ts
git commit -F - <<'EOF'
Add the orders toolset behind PRINTIFY_ENABLE_ORDERS

list_orders, get_order and calculate_shipping are read-only; create_order,
create_express_order, send_order_to_production and cancel_order spend money
and need the flag. external_id is required and a duplicate comes back as the
existing order. Addresses are left out unless include_address is set, and
cancel_order checks the status before sending.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
```

A subagent implementer uses its own model's `Co-Authored-By` line instead.

---

### Task 6: Finish the branch

- [ ] **Step 1: Push and open the PR**

<!-- prettier-ignore -->
```bash
git push -u origin feat/14-orders-toolset
gh pr create --title "Add the orders toolset (#14)" --body-file - <<'EOF'
Closes #14

Adds the `orders` toolset from the spec in `docs/superpowers/specs/2026-10-08-orders-toolset-design.md`:

- `list_orders`, `get_order`, `calculate_shipping` without a gate; the recipient's address is left out unless `include_address: true`.
- `create_order`, `create_express_order`, `send_order_to_production`, `cancel_order` behind `PRINTIFY_ENABLE_ORDERS`.
- `external_id` is required; a 409 duplicate returns the existing order as `created: false` (via a new non-enumerable `PrintifyApiError.body`).
- Shipping methods use the catalog names (`express` = Printify Express); `calculate_shipping` translates Printify's transitional keys.
- `cancel_order` checks for `on-hold` / `payment-not-received` before sending.

876 tests; the CI smoke step asserts the four gated names stay off without the flag.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 2: Move the issue to In review**

Run: `~/.claude/skills/updating-github-project-status/board.sh review`
Expected: `ARau87/printify-mcp#14 … 'In progress' -> 'In review' ✓`.

- [ ] **Step 3: Watch CI**

Run: `gh pr checks --watch`
Expected: lint, typecheck, test, build and the smoke step green on Node 22 and 24. If
`src/tools/index.ts` or `ci.yml` conflicts with a toolset branch that merged first, rebase and
re-apply Task 5's steps 5 and 7.
