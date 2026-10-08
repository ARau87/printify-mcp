# Orders toolset — list, get, shipping quotes, create, produce, cancel — design

- **Issue:** [#14 Orders toolset](https://github.com/ARau87/printify-mcp/issues/14)
- **Date:** 2026-10-08
- **Status:** approved
- **Depends on:** #7 (shops, merged as PR #31); the branch is cut from `origin/main` at 885c8f6
  (#12 merged as PR #40)

## Goal

Order tools spend real money. A new Printify store auto-approves orders after 24 hours, so
creating an order charges the account even when nothing calls `send_to_production`. A model that
retries a timed-out create can place the order twice, and every order carries the recipient's
address, email and phone.

This issue adds the `orders` toolset: three read tools without a gate (`list_orders`, `get_order`,
`calculate_shipping`) and four tools behind `PRINTIFY_ENABLE_ORDERS` (`create_order`,
`create_express_order`, `send_order_to_production`, `cancel_order`). The design makes the two
risks hard to trip: `external_id` is required and doubles as the idempotency key, with a duplicate
reported as a normal result, and addresses stay out of transcripts unless asked for.

## Printify API facts this design relies on

Checked on 2026-10-07 against the HTML docs at https://developers.printify.com/#orders and the
`openapi.json` next to them.

- **Seven endpoints** under `/v1/shops/{shop_id}/orders`: `GET …/orders.json` (`limit` at most 10,
  `page`, `status`, `sku` filters), `GET …/orders/{order_id}.json`, `POST …/orders.json`,
  `POST …/orders/express.json`, `POST …/orders/{order_id}/send_to_production.json`,
  `POST …/orders/shipping.json`, `POST …/orders/{order_id}/cancel.json`. The docs' endpoint index
  lists the express path once as `/v1/shops/{shop_id}/express.json`; the endpoint section, every
  example and the openapi use `…/orders/express.json`, which this design follows.
- **Auto-approval**, verbatim: "By default, new stores have automatic order approval enabled (24
  hours). If auto-approval is active, orders will be sent to production automatically once
  imported/created, without calling the Send to production API endpoint."
- **Line items** take one of three shapes: an existing product `{ product_id, variant_id,
quantity }`, a SKU `{ sku, quantity }`, or an on-the-fly product `{ blueprint_id,
print_provider_id, variant_id, quantity, print_areas, print_details? }` where `print_areas`
  maps a position to an image URL or to an array of `{ src, scale, x, y, angle }`. Each may carry
  an `external_id`. On-the-fly creation "is a time-consuming operation and may lead to timeouts"
  and "will be deprecated in the future". Shipping method 4 (economy) "will not be usable when
  creating a product with an order". A line item may also carry `personalisation`; that is #13's.
- **Shipping method codes:** 1 standard, 2 priority (the old `express`), 3 Printify Express (the
  docs' transitional `printify_express`, final name `express`), 4 economy. The quote endpoint
  answers a flat object; the docs' example has `standard`, `express`, `priority` (both 5000),
  `printify_express` and `economy`. The docs' table gives three generations of keys: old
  (`standard`, `express`, `economy`), transitional (`standard`, `express` and `priority` for
  code 2, `printify_express` for 3, `economy`) and final (`standard`, `priority`, `express` for
  3, `economy`).
- **Submission body:** `external_id` REQUIRED ("a unique string identifier from the sales channel
  specifying the order name or id"), `label` OPTIONAL, `line_items` REQUIRED, `shipping_method`
  REQUIRED (an integer), `send_shipping_notification` BOOLEAN, `address_to` REQUIRED. The address
  fields are `first_name`, `last_name`, `email`, `phone`, `country`, `region`, `address1`,
  `address2`, `city`, `zip`, `company`; the documented validation failure is code 8103 with the
  field names in `errors.reason`.
- **Duplicate `external_id`:** openapi documents a 409 `errorOrderConflict` on both create
  endpoints: `{ status: "error", code: 8503, message: "Operation failed.", errors: { reason: "Order
already exists for the given external_id.", code: 8503 }, order: { id, external_id } }`. The
  existing order's id is in the body.
- **Create** answers `{ id }`. **Send to production** answers `{ id }`. **Cancel** answers the
  whole order, address included, and "will only be accepted if the order to be canceled has the
  status on-hold or payment-not-received".
- **Express** "creates one or two separate orders": one `ordinary`, one `express`, or both when
  the line items' eligibility is mixed. It answers a JSON:API envelope `{ data: [{ type, id,
attributes: { app_order_id?, fulfilment_type, line_items } }] }`. `address_to.email` and
  `address_to.phone` are required, the endpoint "works only with already existing products", and
  only `is_printify_express_eligible` counts, not `is_printify_express_enabled`.
- **Order statuses:** pending, on-hold, sending-to-production, in-production, canceled,
  fulfilled, partially-fulfilled, payment-not-received, has-issues, cost-calculation,
  unfulfillable, sending_to_production_delegate, sending_to_production_delegate_sync,
  source-check-failed. The `metadata.shop_order_id` of an order holds the `external_id` it was
  submitted with (the cancel example shows the same string in both), as a string or a number.
- **Retries:** `src/printify/retry.ts` never resends a POST after a timeout, a network error, a
  502 or a 503, so this server cannot duplicate an order by itself. Only a model that calls
  `create_order` again can, which is what the required `external_id` guards.

## What this issue does not build

| Piece                                                             | Where                           | Landed in |
| ----------------------------------------------------------------- | ------------------------------- | --------- |
| `Gate = 'orders'`, `PRINTIFY_ENABLE_ORDERS`, the skip texts       | `src/config.ts`, `select.ts`    | #2, #5    |
| The `orders` slot in `TOOLS_BY_TOOLSET`, `PAGE_LIMITS.orders: 10` | `src/tools/index.ts`, …         | #5, #3    |
| 409 and code 8503 "already exists" hints, 8103 address hint       | `src/printify/hints.ts`         | #3        |
| `orders.read` / `orders.write` scope hints for 403                | `src/printify/hints.ts`         | #3        |
| Address values redacted from error text                           | `src/printify/client.ts`        | #3        |
| "May still have gone through" on POST timeouts                    | `src/printify/hints.ts`         | #3        |
| `fetchPage` with `query`, the Laravel envelope                    | `src/printify/pagination.ts`    | #3        |
| `shopIdInput`, `resolveShopId`, the cached `ShopDirectory`        | `src/tools/shop-id.ts`, `shops` | #7        |
| `SHIPPING_METHODS` (`standard`, `priority`, `express`, `economy`) | `src/printify/catalog.ts`       | #9        |

Nothing here holds state. `ToolServices`, `src/cli.ts`, `test/support/harness.ts` and
`test/tools/fixtures.ts` do not change.

## Decisions that differ from the issue

1. **Shipping methods use the catalog's names.** The issue spelled the third method
   `printify_express`. The tools take `standard`, `priority`, `express`, `economy`, the same
   `SHIPPING_METHODS` enum `list_shipping_methods` and `get_shipping_costs` already use, where
   `express` is Printify Express Delivery. A model can carry a method name from the catalog into
   `create_order` unchanged, and `calculate_shipping` translates Printify's transitional keys into
   these names with their codes. Decided with the user on 2026-10-07.
2. **The duplicate's id comes out of the 409 body.** `PrintifyApiError` gains `body`, the parsed
   JSON of the failed response, and the request module reads `body.order.id` on a 409 or code 8503. The issue only said "returns the existing order id"; this is how. The field is never
   redacted, logged or serialised: `src/tools/run.ts` copies the fields it reports by name, and the
   warn line uses the message. Only `src/printify/orders.ts` reads it.
3. **Line items are a plain `z.union` of three strict objects**, in the API's own shape, rather
   than a discriminated union with an extra `kind` field. The model copies what the docs and
   `get_order` show and the tool strips nothing. A line item that matches no shape is a
   validation error whose message lists the branches; the description names the three shapes to
   make it readable.
4. **`create_express_order` takes no `shipping_method`.** The endpoint is Printify Express by
   definition and the documented body sends code 3; the tool always sends 3. Its line items are
   product or SKU only, as the endpoint accepts only existing products.
5. **`create_order` refuses `economy` with an on-the-fly line item before sending**, because the
   docs rule the combination out. This is the only input check that spans two fields.
6. **`cancel_order` returns the order summary without the address.** Printify answers the whole
   order; the tool strips `address_to` the way `get_order` does by default, and has no
   `include_address` option: a cancellation needs no address.
7. **`create_order` and `create_express_order` are `idempotentHint: true`.** With `external_id`
   required, a repeat with the same arguments returns the existing order and creates nothing.
   `send_order_to_production` and `cancel_order` are idempotent too: a second call changes
   nothing more. All four are `destructiveHint: true`, as the issue says, because they spend money
   or stop an order.
8. **Personalisation and `is_printify_express` / `is_economy_shipping` flags are not inputs.**
   The two flags are read-only on the order and redundant with the method code; personalisation
   is #13's. The strict line-item objects reject them, which #13 will relax.

## Files

| File                                 | Change                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `src/printify/errors.ts`             | `PrintifyApiError.body`, `'an unexpected order response'`                     |
| `src/printify/client.ts`             | Passes the parsed body into `httpError`                                       |
| `src/printify/orders.ts`             | New: schemas, seven request functions, `existingOrderId`                      |
| `src/tools/shipping-method.ts`       | New: name/code mapping, `parseShippingQuote`                                  |
| `src/tools/order-summary.ts`         | New: `orderRow`, `summarizeOrder`                                             |
| `src/tools/orders.ts`                | New: the seven tools and `ordersTools`                                        |
| `src/tools/index.ts`                 | `orders: ordersTools`                                                         |
| `.github/workflows/ci.yml`           | Read tools in the must-be-present loop, gated tools in the must-be-absent one |
| `test/fixtures/orders.ts`            | New                                                                           |
| `test/printify/errors.test.ts`       | `body` is set from a JSON error response and `undefined` otherwise            |
| `test/printify/orders.test.ts`       | New                                                                           |
| `test/tools/shipping-method.test.ts` | New                                                                           |
| `test/tools/order-summary.test.ts`   | New                                                                           |
| `test/tools/orders.test.ts`          | New                                                                           |

## `src/printify/errors.ts` and `client.ts`

`PrintifyErrorFields` gains `body?: unknown` and `PrintifyApiError` the readonly field `body:
unknown`. `httpError` sets it to `body?.value`, the JSON it already parses for the envelope, so a
non-JSON response leaves it `undefined`. Timeout, network and limiter errors leave it `undefined`.
`invalidResponseError`'s problem union gains `'an unexpected order response'`.

## `src/printify/orders.ts`

Loose Zod objects with `lenient` fields, like `products.ts`: only `id` is required on an order, so
a field Printify drops or retypes cannot break a read.

- `orderSchema`: `id: z.string().min(1)`; lenient `app_order_id`, `address_to` (a loose object of
  lenient strings: `first_name`, `last_name`, `email`, `phone`, `country`, `region`, `address1`,
  `address2`, `city`, `zip`, `company`), `line_items` (array of loose rows with lenient
  `product_id`, `variant_id`, `quantity`, `print_provider_id`, `cost`, `shipping_cost`, `status`,
  `metadata` { `title`, `price`, `variant_label`, `sku`, `country`, `external_id` },
  `sent_to_production_at`, `fulfilled_at`), `metadata` (`order_type`, `shop_order_id` as a string
  or a number, `shop_order_label`, `shop_fulfilled_at`, `is_reprint`, `reprinted_order_ids`,
  `child_reprinted_order_ids`), `total_price`, `total_shipping`, `total_tax`, `status`,
  `shipping_method`, `is_printify_express`, `is_economy_shipping`, `shipments` (array of loose
  { `carrier`, `number`, `url`, `delivered_at` }), `created_at`, `sent_to_production_at`,
  `fulfilled_at`, `printify_connect` ({ `url`, `id` }). Exported types `Order`, `OrderLineItem`.
- `listOrders(client, shopId, { page, limit, status, sku }, signal): Promise<OrderPage>` calls
  `fetchPage(client, 'orders', path, { page, limit, query, signal })` with a `query` holding only
  the filters that were given, and parses each item with `orderSchema`. `OrderPage` mirrors
  `ProductPage`.
- `getOrder(client, shopId, orderId, signal): Promise<Order>`.
- `calculateShipping(client, shopId, body, signal): Promise<Record<string, number>>` POSTs the
  tool's validated `{ line_items, address_to }` and parses `z.record(z.string(), z.number())`;
  unknown keys are kept for `parseShippingQuote`.
- `submitOrder(client, shopId, body, signal): Promise<{ id: string; created: boolean }>` POSTs
  `orders.json`; the `{ id }` answer gives `created: true`. A thrown `PrintifyApiError` for which
  `existingOrderId` returns an id gives `{ id, created: false }`; any other error propagates.
- `submitExpressOrder(client, shopId, body, signal): Promise<ExpressResult>` POSTs
  `orders/express.json` and parses the envelope into `{ created: true, orders: [{ id,
fulfilment_type, app_order_id, line_items }] }` (`fulfilment_type` lenient, `line_items` the
  same loose rows as an order's); the conflict rule gives `{ created: false, id }`.
- `sendOrderToProduction(client, shopId, orderId, signal): Promise<string>` returns the id from
  `{ id }`.
- `cancelOrder(client, shopId, orderId, signal): Promise<Order>`.
- `existingOrderId(error: PrintifyApiError): string | undefined`: when `error.status === 409` or
  `error.code === 8503`, and `error.body` parses as `{ order: { id: string } }`, the id; else
  `undefined`. Exported for its own tests.

Every parse failure throws `invalidResponseError(route, 200, 'an unexpected order response')`.

## `src/tools/shipping-method.ts`

Pure, no I/O.

- `ORDER_SHIPPING_METHODS` is `SHIPPING_METHODS` from `src/printify/catalog.ts`, re-exported so the
  tool file has one import; `ShippingMethod` is its type.
- `shippingMethodCode(method: ShippingMethod): 1 | 2 | 3 | 4` maps `standard` 1, `priority` 2,
  `express` 3, `economy` 4. `shippingMethodName(code: number | undefined): string | undefined`
  is the inverse for summaries; an unknown code comes back as its decimal string, `undefined`
  stays `undefined`.
- `parseShippingQuote(raw: Record<string, number>): { methods: QuoteRow[]; other?:
Record<string, number> }` where `QuoteRow` is `{ method, code, cost }`, in method order, cost in
  cents as Printify sent it. Rules, each consuming the key it reads: `standard` from `standard`;
  `priority` from `priority`, else from `express` (old spelling); `express` from
  `printify_express`, else from `express` when `priority` was also present (final spelling);
  `economy` from `economy`. A method with no key is left out. Keys no rule consumed are returned
  under `other`, absent when empty, so a rename Printify makes later is visible rather than lost.

## `src/tools/order-summary.ts`

Pure, no I/O.

- `orderRow(order: Order, options: { includeAddress: boolean }): OrderRow`: `id`,
  `app_order_id`, `external_id` (from `metadata.shop_order_id`, converted to a string), `status`,
  `shipping_method` (the name via `shippingMethodName`), `is_printify_express`,
  `is_economy_shipping`, `total_price`, `total_shipping`, `total_tax`, `line_item_count`,
  `created_at`, `sent_to_production_at`, `fulfilled_at`, and `address_to` only when
  `includeAddress` is true, as Printify sent it. Missing values are `undefined` and the registry
  drops them.
- `summarizeOrder(order, options): OrderSummary`: the row plus `line_items` (each with
  `product_id`, `variant_id`, `quantity`, `print_provider_id`, `cost`, `shipping_cost`,
  `status`, the metadata fields flattened to `title`, `price`, `variant_label`, `sku`,
  `print_provider_country`, `external_id`, and `sent_to_production_at`, `fulfilled_at`),
  `metadata` (`order_type`, `shop_order_label`, `shop_fulfilled_at`, `is_reprint`,
  `reprinted_order_ids`, `child_reprinted_order_ids`), `shipments` and `printify_connect`.
  `address_to` follows the same option. Nothing else in an order is personal data, so there is no
  second level of stripping.

## Tools

Every tool spreads `shopIdInput` and starts its handler with `resolveShopId`. `orderId` is a
`z.string().regex(/^[A-Za-z0-9]+$/)` defined in the tool file, the same rule as `productId`.

### Shared inputs

- `addressInput`, a strict object: `first_name`, `last_name`, `address1`, `city`, `zip`
  (`z.string().min(1)`) and `country` (`z.string().length(2)`, "ISO 3166-1 alpha-2, e.g. US")
  required; `email`, `phone`, `region`, `address2`, `company` optional strings. Which fields
  Printify itself requires is not documented beyond the 8103 example; the six required ones are
  the minimum a parcel needs, and a missing `region` for a country that needs one surfaces as
  Printify's 8103 error with the field name.
- `expressAddressInput`: `addressInput` with `email` and `phone` required.
- `productLineItemInput`: strict `{ product_id, variant_id, quantity, external_id? }`;
  `skuLineItemInput`: strict `{ sku, quantity, external_id? }`; `newProductLineItemInput`: strict
  `{ blueprint_id, print_provider_id, variant_id, quantity, print_areas, print_details?,
external_id? }`. `quantity` is a positive integer, ids positive integers, `product_id` the
  letters-and-digits rule, `sku` and `external_id` non-empty strings. `print_areas` is
  `z.record(z.string().min(1), z.union([url, z.array(imageInput).min(1)]))` with `url` a
  `z.string().url()` and `imageInput` strict `{ src: url, scale, x, y, angle }` with the number
  rules `create_product` uses; `print_details` is the same strict object as `create_product`'s.
- `lineItemInput` is `z.union([productLineItemInput, skuLineItemInput,
newProductLineItemInput])`; `existingLineItemInput` is the union of the first two.
- `shippingMethodInput` is `z.enum(ORDER_SHIPPING_METHODS)`, described as "standard, priority,
  express (Printify Express Delivery) or economy; calculate_shipping lists what is available
  and what each costs".
- `orderStatusInput` is `z.enum` of the fourteen documented statuses.

### `list_orders`

- Description: lists a shop's orders, newest first, as compact rows: id, external_id, status,
  shipping method, totals in cents, line item count and timestamps. `limit` is at most 10
  (Printify's maximum). `status` filters by order status; `sku` keeps orders that contain that
  SKU. The recipient's address is left out unless `include_address` is true, to keep personal
  data out of the conversation. Use `get_order` for the line items.
- Annotations: read-only, not destructive, idempotent.
- Input: `shop_id?`, `page?`, `limit?` (`.max(PAGE_LIMITS.orders)`), `status?`, `sku?`,
  `include_address` default `false`.
- Handler: `resolveShopId`; `listOrders`; return `{ orders: rows, page, has_more, total,
last_page }`.

### `get_order`

- Description: gets one order with its line items (product, variant, quantity, costs, status,
  print provider country), totals, status, shipments with tracking, and reprint metadata. The
  recipient's address is left out unless `include_address` is true.
- Annotations: read-only, not destructive, idempotent.
- Input: `shop_id?`, `order_id`, `include_address` default `false`.
- Handler: `resolveShopId`; `getOrder`; return `{ ...summarizeOrder(order, { includeAddress }) }`.

### `calculate_shipping`

- Description: quotes the shipping cost of an order before it is placed, per shipping method, in
  cents, for the given line items and address; nothing is created or charged. The `method` of
  each row is what `create_order` takes as `shipping_method`. A method Printify does not offer for
  these items is absent. Line items take the same three shapes as `create_order`.
- Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`. It is a
  POST with no side effects; the live-test rule already allows it.
- Input: `shop_id?`, `line_items: z.array(lineItemInput).min(1)`, `address_to: addressInput`.
- Handler: `resolveShopId`; `calculateShipping` with `{ line_items, address_to }`; return
  `parseShippingQuote(raw)`.

### `create_order`

- Description, opening with the warning: creates an order, which spends real money. Confirm the
  items, quantities, address and shipping method with the user first, and quote the cost with
  `calculate_shipping`. Printify charges the account when the order goes to production: with the
  shop's default automatic approval that happens 24 hours after creation without any further
  call; with manual approval, when `send_order_to_production` is called. `external_id` is
  required and must be unique per order (an order number of the user's own or a fresh UUID); if
  the call times out, call again with the same `external_id`, never a new one: Printify then
  returns the existing order instead of a second one, and the result says `created: false`. Line
  items: an existing product `{ product_id, variant_id, quantity }`, a SKU `{ sku, quantity }`,
  or a product created on the fly `{ blueprint_id, print_provider_id, variant_id, quantity,
print_areas }`, which is slow, may time out, cannot use economy shipping and is slated for
  deprecation; create the product first when possible. `shipping_method` is one of standard,
  priority, express (Printify Express; every item must be eligible) and economy. `cancel_order`
  can undo the order only while its status is on-hold or payment-not-received.
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`. Gate
  `orders`.
- Input: `shop_id?`, `external_id: z.string().min(1)`, `label?`, `line_items:
z.array(lineItemInput).min(1)`, `shipping_method: shippingMethodInput`,
  `send_shipping_notification: z.boolean().default(false)`, `address_to: addressInput`.
- Handler: `resolveShopId`; if `shipping_method` is `economy` and any line item has
  `blueprint_id`, throw `ToolError('Economy shipping cannot be used with a product created on the
fly.', 'Create the product first with create_product, or choose another shipping method.')`;
  build the body `{ external_id, label, line_items, shipping_method: code,
send_shipping_notification, address_to }` (an absent `label` left out); `submitOrder`; return
  `{ order_id, created, external_id, shipping_method, next_step }`.
  - `created: true` next step: "The order exists and is not yet charged. If the shop uses
    automatic order approval (Printify's default for new stores), it goes to production about 24
    hours after creation and the account is charged then; call send_order_to_production to send
    it now. With manual approval nothing happens until that call. cancel_order works only while
    the status is on-hold or payment-not-received; get_order shows the status."
  - `created: false` next step: "An order with this external_id already existed, so nothing new
    was created and nothing was charged by this call. Use get_order with this order_id to see its
    status."

### `create_express_order`

- Description: like `create_order`, with the differences: Printify Express Delivery, for existing
  products only (product or SKU line items), and the address needs `email` and `phone`. Printify
  splits the line items by Printify Express eligibility: all eligible gives one express order,
  none gives one ordinary order, a mix gives two orders, and the result lists each with its
  `fulfilment_type`. Only `is_printify_express_eligible` on the product and variant counts.
  Carriers may not be supported by every sales channel, e.g. Amazon and TikTok. The same money
  warning, `external_id` rule and approval guidance as `create_order`.
- Annotations and gate as `create_order`.
- Input: `shop_id?`, `external_id`, `label?`, `line_items: z.array(existingLineItemInput).min(1)`,
  `send_shipping_notification` default `false`, `address_to: expressAddressInput`.
- Handler: `resolveShopId`; body with `shipping_method: 3`; `submitExpressOrder`; return
  `{ created, external_id, orders: [{ order_id, fulfilment_type, app_order_id, line_items }],
next_step }` where each `line_items` entry is summarised like an order's. On `created: false`,
  `orders` is `[{ order_id }]` and the next step is `create_order`'s duplicate text, plus "An
  express submission may have produced a second, ordinary order; list_orders shows both."

### `send_order_to_production`

- Description: sends an order to production now. This charges the account and cannot be undone;
  confirm with the user first. Needed only when the shop uses manual order approval; with
  automatic approval Printify sends the order itself about 24 hours after creation. If the call
  times out, check the status with `get_order` (sending-to-production or in-production means it
  went through) before calling again.
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`. Gate
  `orders`.
- Input: `shop_id?`, `order_id`.
- Handler: `resolveShopId`; `sendOrderToProduction`; return `{ order_id, sent_to_production:
true }`.

### `cancel_order`

- Description: cancels an order that has not been paid or sent to production. Printify accepts the
  cancellation only while the status is on-hold or payment-not-received; the tool checks the
  status first and refuses otherwise, so an order in production is never touched. An order
  already in production can only be changed through Printify's support flows (reprint, refund,
  address change), which this server does not offer yet. Returns the cancelled order without the
  address.
- Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`. Gate
  `orders`.
- Input: `shop_id?`, `order_id`.
- Handler: `resolveShopId`; `getOrder`; if `status` is not `on-hold` or `payment-not-received`,
  throw `ToolError(`Order ${id} has status ${status}, so Printify will not cancel it.`, 'Only an
order with status on-hold or payment-not-received can be cancelled. An order that is already in
production can only be changed through Printify support.')`; a missing status is treated as not
  cancellable, with "unknown" as the status; `cancelOrder`; return
  `{ ...summarizeOrder(order, { includeAddress: false }), cancelled: true }`.

`ordersTools` lists them in that order. `src/tools/index.ts` sets `orders: ordersTools`.

## CI

The smoke step's must-be-absent loop gains `create_order create_express_order
send_order_to_production cancel_order`; the must-be-present loop gains `list_orders get_order
calculate_shipping`.

## Error handling

Nothing new in `hints.ts`.

- A 409 or code 8503 with `order.id` in the body never reaches the model as an error: the request
  module turns it into `created: false`. Without the id (a body Printify changed), the existing
  "An order with this `external_id` already exists" hint applies.
- Code 8103 (address validation) keeps its hint naming the fields; the client already redacts
  the address values from the reason text.
- A 403 gets the `orders.write` or `orders.read` scope hint from `scopeFor`.
- A POST timeout or network error carries "The request may still have gone through"; the create
  descriptions say to retry with the same `external_id`, and the production and cancel
  descriptions say to check `get_order` first.
- The refusals that send nothing are `ToolError`s: cancel on a wrong status (after the GET),
  economy with an on-the-fly item, no or several shops. Validation errors before any request: a
  line item matching no shape, `limit` above 10, an unknown `status`, a missing `external_id`, a
  missing `email` or `phone` on an express order, an unknown argument.
- A 404 on `get_order`, `send_order_to_production` or `cancel_order` keeps the "check the id and
  that it belongs to this shop" hint.

## Tests

### `test/fixtures/orders.ts`

`ORDER`: the docs' order example with address, two line items, metadata, shipments and
`printify_connect`, status `on-hold`. `order(overrides)` builder. `ordersPage(items, envelope?)`
like `productsPage`. `EXPRESS_RESPONSE`: the docs' two-order envelope. `QUOTE_OLD`,
`QUOTE_TRANSITIONAL`, `QUOTE_FINAL`: the three key sets. `orderConflictBody(id, externalId)`:
the openapi 8503 example with `order: { id, external_id }`.

### `test/printify/errors.test.ts`

`httpError` sets `body` to the parsed JSON for a JSON error response, and leaves it `undefined`
for a non-JSON one; `timeoutError` and `networkError` leave it `undefined`.

### `test/printify/orders.test.ts`

Each function's method, path, query (`status` and `sku` only when given, `limit` capped at 10)
and body. `submitOrder` resolves `created: true` on `{ id }`, `created: false` with the body's
id on a 409 conflict body, and rejects with the API error on a 400 (8103) and on a 409 without
`order.id`. `submitExpressOrder` parses the two-order envelope and handles the conflict the same
way. `existingOrderId`: a 409 with the id, a 400 with code 8503 and the id, a 409 without an
id, a 500, a timeout error. A non-object order response and a non-numeric quote value are
`invalid_response` errors.

### `test/tools/shipping-method.test.ts`

`shippingMethodCode` for the four names; `shippingMethodName` for 1–4, 5 and `undefined`.
`parseShippingQuote` on the old set gives standard, priority (from `express`) and economy with
no `express` row and no `other`; on the transitional set gives all four with `priority` 5000 and
`express` 799; on the final set gives all four with `express` from `express`; an extra
`drone: 1` key lands in `other`; an empty object gives `methods: []`.

### `test/tools/order-summary.test.ts`

`orderRow` on `ORDER` has `external_id` as a string from a numeric `shop_order_id`, the method
name `standard`, `line_item_count` 2 and no `address_to` property (`not.toHaveProperty`);
with `includeAddress` it has the address as sent. `summarizeOrder` flattens the line item
metadata, includes shipments, and leaves `address_to` out by default. A null `fulfilled_at`
becomes `undefined`.

### `test/tools/orders.test.ts`

Through the harness with the default tools, with `ORDERS_ON = { PRINTIFY_ENABLE_ORDERS: 'true'
}` where needed:

- Without the flag, `create_order`, `create_express_order`, `send_order_to_production` and
  `cancel_order` are absent from `tools/list`, the three read tools are present, and the server
  instructions name `PRINTIFY_ENABLE_ORDERS`. With it, all seven are listed in `ordersTools`
  order with the annotations above. The issue's third criterion.
- `list_orders`: rows without `address_to`; `page`, `limit`, `status`, `sku` reach the query;
  `limit: 11` is a validation error with no request; `include_address: true` adds the address to
  each row.
- `get_order`: the summary without the address, then with it; a 404 keeps the not-found hint.
- `calculate_shipping`: sends `{ line_items, address_to }`, returns the parsed rows from the
  transitional body; a SKU line item and an on-the-fly line item are accepted.
- `create_order`: each of the three line-item shapes reaches Printify as given with
  `shipping_method` as its code and `send_shipping_notification: false`; the result has
  `created: true` and a `next_step` naming `send_order_to_production` and `cancel_order`; a 409
  conflict body gives a normal result with `created: false` and the existing id, no `isError`
  (the issue's second criterion); a missing `external_id`, a line item matching no shape and
  `shipping_method: 'printify_express'` are validation errors with no request; `economy` with an
  on-the-fly item is a `tool` refusal with no request; a never-answering create (`never()`)
  times out with the "may still have gone through" hint, asserted after `vi.waitUntil` sees the
  request.
- `create_express_order`: sends `shipping_method: 3`, returns two orders with their
  `fulfilment_type`; an address without `phone` is a validation error with no request; a SKU
  line item is accepted and an on-the-fly one rejected; the 409 path.
- `send_order_to_production`: POSTs the path and returns `sent_to_production: true`.
- `cancel_order`: on `ORDER` (on-hold) GETs then POSTs the cancel and returns `cancelled: true`
  without an address; on `order({ status: 'in-production' })` refuses with `kind: 'tool'`, a
  hint naming the two statuses, and exactly one request; `payment-not-received` is accepted.
- One default-shop test (`shop_id` left out, one shop in the account) for `list_orders`.

`test/tools/catalog.test.ts` already checks every tool against the definition rules.

## Acceptance criteria mapping

| Criterion                                              | Where                                                   |
| ------------------------------------------------------ | ------------------------------------------------------- |
| Harness tests for every tool and line-item shape       | `test/tools/orders.test.ts`                             |
| Duplicate `external_id` handling                       | `submitOrder` conflict tests, the harness 409 test      |
| Cancel pre-check                                       | the `in-production` refusal and the `on-hold` success   |
| Gated tools absent without `PRINTIFY_ENABLE_ORDERS`    | the flag tests, CI's must-be-absent loop                |
| Descriptions warn about auto-approval and real charges | every gated description; the `next_step` texts          |
| `address_to` omitted unless `include_address: true`    | `order-summary.test.ts`, the list and get harness tests |

## Out of scope

- Personalisation on line items, and the `is_printify_express` / `is_economy_shipping` request
  flags (#13 for the former; the latter are read-only on the order).
- Reprint, refund and address-change support requests (#15).
- Checking a product's express eligibility before `create_express_order`; Printify's split and
  errors report it.
- A pre-check on `send_order_to_production`; Printify's answer to a second send is not documented
  and the tool is idempotent in effect.
- Any live test; #20 may add `calculate_shipping` to the read-only suite.
- A README (#21).

## Delivery

1. Branch `feat/14-orders-toolset` from `origin/main` at 885c8f6, in the worktree
   `../printify-mcp-worktrees/14-orders-toolset`, outside the repository so the main checkout's
   `eslint .` does not lint it. This spec is its first commit. The board moves #14 to In progress.
2. Implementation plan via the writing-plans skill, with every code block prototyped and
   lint/typecheck/test-verified before the plan is written, and every negative assertion checked
   against a broken implementation once.
3. Test-first implementation.
4. Local verification before any claim of success: `npm run lint`, `npm run typecheck`,
   `npm test` and `npm run build`, plus the CI smoke step's commands against `dist/`.
5. PR starting with `Closes #14`, moved to In review on the project board. Watch its CI run on
   Node 22 and 24. Expect conflicts in `src/tools/index.ts` and `ci.yml` with any toolset branch
   that merges first.
6. Hand-off: #15 (support requests) reuses `orderId`, `summarizeOrder` and
   `PrintifyApiError.body`; #13 relaxes the line-item objects for `personalisation`; #16's
   `order:*` events can point at `get_order`.
