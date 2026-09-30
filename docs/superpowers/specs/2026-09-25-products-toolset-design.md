# Products toolset — list, get, create, update, delete, GPSR — design

- **Issue:** [#11 Products toolset — list, get, create, update, delete, GPSR](https://github.com/ARau87/printify-mcp/issues/11)
- **Date:** 2026-09-25
- **Status:** approved

## Goal

Creating and maintaining products is what this server is for. The product payload is deeply
nested (`variants`, `print_areas → placeholders → images`), a product object is huge (mock-ups,
views, option tables), and an update has a trap: Printify replaces the variant list with whatever
the request carries, so a partial `variants` array silently removes the variants it leaves out.

This issue adds the six `products` tools with compact responses, an `update_product` that turns a
partial variant change into the complete list Printify needs, a refusal for products that are
locked for publishing, and input schemas that reject a bad print area before any request is sent.
It also lands the request layer and the summary view that #12 (publishing) and #19
(`create_product_from_image`) reuse.

## Printify API facts this design relies on

Checked on 2026-09-25 against the HTML docs at https://developers.printify.com/#products. The
`openapi.json` linked from them is thinner (its create body lacks `tags`, `external`,
`print_details`, `sales_channel_properties`, `is_printify_express_enabled`), so the HTML wins,
as the design decisions memory already says for shipping.

- **Six endpoints** under `/v1/shops/{shop_id}/products`: `GET …/products.json` (list),
  `GET …/{product_id}.json`, `GET …/{product_id}/gpsr.json`, `POST …/products.json`,
  `PUT …/{product_id}.json`, `DELETE …/{product_id}.json`. The four publishing endpoints
  (`publish`, `publishing_succeeded`, `publishing_failed`, `unpublish`) are #12's.
- **The list** takes only `limit` ("default: 10, maximum: 50") and `page`, and returns the Laravel
  envelope `fetchPage` parses. `PAGE_LIMITS.products` is already 50. **List items are full
  product objects**, mock-ups and views included, so trimming is this server's job.
- **Update semantics**, verbatim: "A product can be updated partially or as a whole document. When
  updating variants, all variants must be present in the request." The documented PUT example
  sends `{ "title": "Product" }` alone. Nothing says that `print_areas` merges, so a `print_areas`
  array is taken to replace all print areas, like `variants` replaces all variants.
- **Locked products**, verbatim: "A product is locked during publishing. Locked products can't be
  updated until unlocked." `is_locked` is read-only. What a PUT on a locked product returns is not
  documented, which is why the tool checks before it writes.
- **Read-only after creation:** `blueprint_id` and `print_provider_id` ("Required when creating a
  product, but is read only after"). Read-only always: `id`, `options`, `images` (mock-ups),
  `views`, `visible`, `user_id`, `shop_id`, `created_at`, `updated_at`, `is_locked`,
  `is_printify_express_eligible`, `is_economy_shipping_eligible`, `is_economy_shipping_enabled`.
  The docs spell the timestamp `update_at` in the property table and `updated_at` in every
  example; the examples are what the API sends.
- **Variant fields:** writable `id`, `price` (cents), `sku`, `is_enabled`, `is_default` ("Only
  one variant can be default"); read-only `title`, `cost`, `grams`, `is_available`,
  `is_printify_express_eligible`, `options`. "During product creation, only the variant id and
  price are necessary."
- **Placeholder and image fields:** `position` is one of the positions `list_variants` shows,
  and "by selecting a position for your images, you also select the decoration method";
  `decoration_method` is read-only. An image has `id`, `x`, `y`, `scale`, `angle` (all
  required), and optional `pattern` (`spacing_x`, `spacing_y`, `angle`, `offset`; the create
  example sends `scale` instead of `angle`, so the table and the example disagree). Read-only on
  an image: `src`, `name`, `type`, `width`, `height`, and the text-layer fields `font_family`,
  `font_size`, `font_weight`, `font_color`, `font_style`, `input_text`, `text_align`.
- **Positioning rules:** "[0,00; 0,00] .. [1,00; 1,00] cartesian coordinate system, with the
  placeholder center being x=0,5, y=0,5"; scale is "the image (width) relative to the print area
  placeholder (width)", "from 0,00 to infinity", 1 fills the area; the angle is an integer
  ("Artwork angle - 360° angle").
- **`print_details`:** `print_on_side` is `regular`, `mirror` or `off`; `separator_type` and
  `separator_color` are for clocks. **`external`** is documented as an array of
  `{ id, handle, shipping_template_id }`, "updated by sales channel with publishing succeeded
  endpoint", where only "Shipping Template ID is optional and can be passed during product
  creation or update". **`sales_channel_properties`** is a channel-specific object; for custom
  integrations "it will either be null or an empty array".
- **GPSR:** `GET …/gpsr.json` returns a bare array of `{ title, text }` sections, derived from
  `safety_information`.
- **Errors:** code 8203 "Validation failed." with reason "Image has low quality" is the documented
  create/update failure, and `hints.ts` already covers it. `scopeFor` already maps the products
  paths to `products.read` / `products.write`. No products-specific rate limit is documented
  besides the publishing one, which is #12's.

## What this issue does not build

| Piece                                                           | Where                        | Landed in |
| --------------------------------------------------------------- | ---------------------------- | --------- |
| `fetchPage` and `PAGE_LIMITS.products = 50`                     | `src/printify/pagination.ts` | #3        |
| Hint for code 8203, scope hint for `products.*` on a 403        | `src/printify/hints.ts`      | #3        |
| `gate: 'destructive'` and its skip messages                     | `src/tools/select.ts`        | #5        |
| `ToolError` → `{ kind: 'tool', message, hint }`                 | `src/tools/run.ts`           | #5        |
| `shopIdInput`, `resolveShopId`                                  | `src/tools/shop-id.ts`       | #7        |
| The variant ids and positions a product needs (`list_variants`) | `src/tools/catalog.ts`       | #8        |
| The image ids `print_areas` refers to (`upload_image`)          | `src/tools/uploads.ts`       | #10       |
| A trimmed product fixture, so far unused                        | `test/fixtures/products.ts`  | #5        |

Nothing here holds state, so `ToolServices`, `src/cli.ts`, `test/support/harness.ts` and
`test/tools/fixtures.ts` do not change. The HTTP client needs no change: it sends JSON bodies for
POST and PUT and the 30 s default timeout stands. Creating a product makes Printify render
mock-ups, but no timing is documented, so the timeout is not raised until a real run shows a
need.

## Decisions that differ from the issue

1. **`update_product` merges by id, and `replace_variants: true` is the explicit way to add or
   remove variants.** The issue asks for the merge. It leaves open what happens to an id the
   product does not have: silently appending it would create a variant no print area covers, and
   silently dropping it would hide the mistake. So an unknown id is refused, with a hint that
   names `replace_variants`. With `replace_variants: true` the list is sent exactly as given —
   what the API does anyway — so adding and removing variants stay possible, but only when the
   model says so, and its description says the new ids need `print_areas` too.
2. **The summary view lists every variant, compactly.** The issue says enabled variants only.
   A merge keeps the disabled ones, and re-enabling a size is a common edit, so the model needs
   to see them; a row is `id`, `title`, `sku`, `price`, `cost`, `is_enabled`, `is_default`,
   `is_available`, about 80 bytes. `variant_count` and `enabled_variant_count` give the totals.
3. **`update_product` always fetches the product first**, also when no `variants` are given.
   The locked check needs it, the issue asks for that check before any write, and the one GET
   costs little next to a PUT that makes Printify re-render mock-ups.
4. **One default variant.** When an input variant sets `is_default: true`, the merge sends every
   other variant with `is_default: false`, since Printify allows one default. Without that, "make
   XL the default" would need the model to unset the old default in the same call, or get a 400.
5. **`external` is an array**, `[{ id?, handle?, shipping_template_id? }]`, matching the
   documented read shape rather than the issue's `external.shipping_template_id`. Sending the
   documented shape is the safest bet for a field the docs describe only from the read side.
6. **Cross-field rules are checked in the handler, not the schema.** "At least one field to
   update", "`replace_variants` needs `variants`", "every variant needs a `price` with
   `replace_variants`" and "no duplicate variant ids" are `ToolError`s, so the model gets the
   `{ kind, message, hint }` envelope; a `.refine()` failure is reported by the SDK before the
   handler and bypasses it, and `toolProblems` converts every input to JSON Schema. Same reasoning
   as #10's decision 3.
7. **`print_areas` are sent as given and replace all print areas.** No merge: the docs give no
   merge semantics for them, and a print area is small enough to resend whole. The description
   says so. Text layers cannot be written through this server, as the issue says; the summary
   shows them so the model knows a resend would drop them.
8. **Mock-ups in the summary are the `is_default` ones only**, plus `mockup_count`. A t-shirt
   with several colours and camera positions has dozens; the default ones are the title images.
   `detail: "full"` has all of them.
9. **`delete_product` resolves the shop like every other tool.** `disconnect_shop` required an
   explicit `shop_id` because it acts on a whole shop; `delete_product` acts on the one product the
   model named, so the default shop is fine.
10. **The locked refusal names no tool.** #12 is not merged, and #8 set the rule that a
    description or hint must not name an absent tool. The hint explains what unlocks a product
    (the sales channel reporting the publishing result) without naming the tools that will do it.
11. **The response schema requires `id` and every variant's `id` and `price`; everything else is
    lenient.** An update is built on the fetched variant list, so a list with a variant that
    cannot be resent would remove that variant — an `invalid_response` error is safer than a
    partial merge. Every other field follows the shop and upload schemas: optional, and dropped
    with `.catch` when it has the wrong type.
12. **The `lenient` helper moves out of `src/printify/uploads.ts`** into a shared
    `src/printify/schema.ts`, since this is its second user. `uploads.ts` imports it from there;
    nothing else about #10 changes.

## Files

<!-- prettier-ignore -->
```
src/printify/
  schema.ts                 # new: lenient(), moved from uploads.ts
  uploads.ts                # imports lenient from schema.ts
  products.ts               # new: Product, GpsrSection, the six requests
  errors.ts                 # invalidResponseError gains 'an unexpected product response'
src/tools/
  product-summary.ts        # new, pure: productRow, summarizeProduct
  product-update.ts         # new, pure: mergeVariants, assertUnlocked
  products.ts               # new: the sub-schemas, the six tools, productsTools
  index.ts                  # products: productsTools
.github/workflows/ci.yml    # smoke step asserts the five ungated names; delete_product absent
test/printify/
  schema.test.ts            # new: lenient()
  products.test.ts          # new: requests and parsing
test/tools/
  product-summary.test.ts   # new
  product-update.test.ts    # new
  products.test.ts          # new: the six tools through the harness
test/fixtures/
  products.ts               # grows: the documented mug, a locked product, a page, GPSR sections
docs/superpowers/specs/
  2026-09-25-products-toolset-design.md
```

No new dependencies. `src/printify/products.ts` follows `uploads.ts`: request, validate, return
typed records, no factory, no cache. A cached product would be exactly the stale variant list this
issue exists to avoid. The two `src/tools/product-*.ts` modules follow `shipping-profiles.ts`:
pure functions with their own unit tests, so the tool handlers stay a few lines each.

## `src/printify/products.ts`

### The records

<!-- prettier-ignore -->
```ts
export interface ProductVariant {
  id: number;
  price: number;                       // cents; required, see decision 11
  title?: string; sku?: string; cost?: number; grams?: number;
  is_enabled?: boolean; is_default?: boolean; is_available?: boolean;
  is_printify_express_eligible?: boolean;
  options?: number[];
}

export interface Mockup { src?: string; variant_ids?: number[]; position?: string; is_default?: boolean }

export interface ExternalRef { id?: string; handle?: string; shipping_template_id?: string }

export interface Product {
  id: string;
  title?: string; description?: string; safety_information?: string; tags?: string[];
  blueprint_id?: number; print_provider_id?: number; shop_id?: number;
  visible?: boolean; is_locked?: boolean;
  is_printify_express_eligible?: boolean; is_printify_express_enabled?: boolean;
  is_economy_shipping_eligible?: boolean; is_economy_shipping_enabled?: boolean;
  external?: ExternalRef[];
  variants: ProductVariant[];
  images?: Mockup[];
  print_areas?: PrintArea[];           // loose objects: placeholders and their images pass through
  created_at?: string; updated_at?: string;
  [key: string]: unknown;              // z.looseObject: options, views, sales_channel_properties, …
}

export interface GpsrSection { title: string; text: string }
```

`productSchema` is a `z.looseObject`, so `detail: "full"` can return the parsed product with every
key Printify sent, including the ones the summary drops. `print_areas` is an array of loose
objects: `variant_ids`, `placeholders[].position` and `placeholders[].images[]` are typed enough
for the summary to trim, and text-layer fields and anything undocumented pass through. `variants`
must be an array whose every item has an integer `id` and a number `price`; the array may be empty.
`external` is normalised: Printify sends `null` for a product that was never published (the
existing fixture encodes that), and `lenient` turns it into `undefined`. Anything that fails the
schema is `invalidResponseError(route, 200, 'an unexpected product response')`.

`gpsrSchema` is `z.array(z.object({ title: z.string(), text: z.string() }))`; a body that is not
that is the same error.

### Requests

| Function                                                 | Request                                                |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `listProducts(client, shopId, { page, limit }, signal)`  | `fetchPage(client, 'products', …)`; each item parsed   |
| `getProduct(client, shopId, productId, signal)`          | `GET /v1/shops/{shop_id}/products/{product_id}.json`   |
| `getProductGpsr(client, shopId, productId, signal)`      | `GET …/products/{product_id}/gpsr.json`                |
| `createProduct(client, shopId, body, signal)`            | `POST …/products.json`                                 |
| `updateProduct(client, shopId, productId, body, signal)` | `PUT …/products/{product_id}.json`                     |
| `deleteProduct(client, shopId, productId, signal)`       | `DELETE …/products/{product_id}.json`; response unread |

`listProducts` returns `{ products, page, hasMore, total, lastPage }` like `listUploads`.
`createProduct` and `updateProduct` take `unknown` bodies (the tool has already validated them)
and return the parsed `Product` the API answers with. Paths go through `apiPath`, which encodes
the product id and rejects `""`, `"."` and `".."`.

## `src/tools/product-summary.ts`

Pure. Two functions over a `Product`:

<!-- prettier-ignore -->
```ts
export interface ProductRow {
  id: string; title?: string;
  blueprint_id?: number; print_provider_id?: number;
  visible?: boolean; is_locked?: boolean;
  variant_count: number; enabled_variant_count: number;
  external?: { id?: string; handle?: string };
  updated_at?: string;
}
export function productRow(product: Product): ProductRow;

export interface ProductSummary extends ProductRow {
  description?: string; safety_information?: string; tags?: string[];
  is_printify_express_eligible?: boolean; is_printify_express_enabled?: boolean;
  is_economy_shipping_eligible?: boolean; is_economy_shipping_enabled?: boolean;
  created_at?: string;
  variants: VariantRow[];             // id, title, sku, price, cost, is_enabled, is_default, is_available
  print_areas?: unknown[];            // as sent, each image without src and type
  mockups?: Mockup[];                 // the is_default ones
  mockup_count?: number;
}
export function summarizeProduct(product: Product): ProductSummary;
```

`summarizeProduct` walks `print_areas → placeholders → images` and removes `src` and `type` from
each image with `omitKeys`; `id`, `name`, `width`, `height`, `x`, `y`, `scale`, `angle`, `pattern`
and any text-layer field stay. `options`, `views`, `sales_channel_properties`, `user_id` and
`shop_id` are not copied. `external` keeps `id` and `handle` only. Counts are computed from
`variants`, so they are right even when the summary is built from a create or update response.

## `src/tools/product-update.ts`

Pure. The merge and the locked check, each a `ToolError` source the tool test can cover without
the harness.

<!-- prettier-ignore -->
```ts
/** What update_product accepts per variant. Only `id` is required. */
export interface VariantPatch {
  id: number; price?: number; is_enabled?: boolean; is_default?: boolean; sku?: string;
}
/** What the PUT carries per variant: the writable fields only. */
export interface VariantBody {
  id: number; price: number; is_enabled?: boolean; is_default?: boolean; sku?: string;
}

export type MergeResult =
  | { ok: true; variants: VariantBody[] }
  | { ok: false; unknownIds: number[] };

export function mergeVariants(
  current: readonly ProductVariant[],
  patches: readonly VariantPatch[],
): MergeResult;

/** Throws the locked ToolError when `product.is_locked` is true. */
export function assertUnlocked(product: Product): void;
```

`mergeVariants` keeps the current order and every current variant. For each, the body takes
`price`, `is_enabled`, `is_default` and `sku` from the patch when given, else from the current
variant; a current field that is `undefined` stays out of the body, since Printify keeps a field
that is not sent. If any patch sets `is_default: true`, every other body gets `is_default: false`
(decision 4). Patch ids not found in `current` are collected and returned as `unknownIds`; the
result is then not a list, so the caller cannot send a partial one by mistake. Duplicate patch ids
are the handler's check, before the fetch.

The locked error:

> Product `5d39b1…` ("Mug 11oz") is locked because it is being published, and Printify refuses
> updates to a locked product.
>
> Hint: Printify unlocks it when the sales channel reports the publishing result (succeeded or
> failed). Wait and try again, or check the product in the Printify app.

## Tools

`src/tools/products.ts` exports the six tools and `productsTools`, in the order `list_products`,
`get_product`, `get_product_gpsr`, `create_product`, `update_product`, `delete_product`, and
`src/tools/index.ts` replaces `products: []`. Every tool spreads `shopIdInput` and starts with
`resolveShopId`.

### Shared input schemas

Defined once at the top of the file and reused by `create_product` and `update_product`. Every
object is a `z.strictObject`, nested ones included, so a misspelt `is_enable` or `varaint_ids` is
rejected rather than dropped — except `sales_channel_properties`, a pass-through
`z.record(z.string(), z.unknown())`, because its keys are the sales channel's.

| Schema              | Fields                                                                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `productId`         | `z.string().min(1)`, "The product id, e.g. from list_products."                                                                                                                                                                         |
| `variantInput`      | `id` int > 0; `price` int ≥ 0 (cents); `is_enabled`, `is_default` booleans; `sku` string. `price` is required in `create_product`'s copy and optional in `update_product`'s (`variantInput.extend`/`.partial()` on the one definition). |
| `imageInput`        | `id` non-empty string; `x`, `y` numbers 0–1 inclusive; `scale` number > 0, finite; `angle` integer −360…360; `pattern?` = `spacing_x`, `spacing_y` numbers (required), `angle`, `offset`, `scale` numbers (optional)                    |
| `placeholderInput`  | `position` non-empty string; `images` array of `imageInput` (may be empty, as in the docs)                                                                                                                                              |
| `printAreaInput`    | `variant_ids` array of int > 0, min 1; `placeholders` array of `placeholderInput`, min 1; `background?` string                                                                                                                          |
| `printDetailsInput` | `print_on_side?` enum `regular \| mirror \| off`; `separator_type?`, `separator_color?` strings                                                                                                                                         |
| `externalInput`     | array of `{ id?, handle?, shipping_template_id? }` strings                                                                                                                                                                              |
| `productFields`     | `title` min 1; `description` string; `tags` array of strings; `safety_information` string; `print_details`; `external`; `is_printify_express_enabled` boolean; `sales_channel_properties` record                                        |

The `.describe()` texts carry the positioning rules: `x` and `y` are "0–1 from the top-left of
the print area; 0.5/0.5 is the centre", `scale` is "the image width divided by the placeholder
width; 1 fills the area", `angle` is "rotation in degrees", `price` is "in cents, e.g. 2499 for
24.99", `position` is "a position from list_variants, e.g. front; it selects the decoration
method", `id` on an image is "an image id from upload_image or list_uploads".

### `list_products`

| Field       | Value                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| Input       | `shop_id?`, `page?` int ≥ 1, `limit?` int 1–50 (`PAGE_LIMITS.products`) |
| Annotations | read-only                                                               |
| Requests    | `GET /v1/shops/{shop_id}/products.json`                                 |
| Output      | `{ products: ProductRow[], page, has_more, total?, last_page? }`        |

> Lists the products in a shop: each one's id, title, blueprint and print provider ids, whether it
> is visible in the sales channel, whether it is locked for publishing, how many variants it has
> and how many are enabled, and its sales-channel reference. Paginate with `page` and `limit` (at
> most 50; Printify's default is 10). Use `get_product` for a product's variants, print areas and
> mock-ups.

### `get_product`

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| Input       | `shop_id?`, `product_id`, `detail: "summary" \| "full"` (default `summary`)      |
| Annotations | read-only                                                                        |
| Requests    | `GET /v1/shops/{shop_id}/products/{product_id}.json`                             |
| Output      | `ProductSummary`, or with `full` the parsed product with every key Printify sent |

> Gets one product. The summary (the default) has the product's fields, every variant as a compact
> row (id, title, sku, price and cost in cents, is_enabled, is_default, is_available), its print
> areas with each image's id and placement, and the default mock-up URLs. `detail: "full"` returns
> the whole product as Printify sends it, including every mock-up, the blank views and the option
> tables; it is large. A text layer in a print area is shown but cannot be edited here.

### `get_product_gpsr`

| Field       | Value                                                     |
| ----------- | --------------------------------------------------------- |
| Input       | `shop_id?`, `product_id`                                  |
| Annotations | read-only                                                 |
| Requests    | `GET /v1/shops/{shop_id}/products/{product_id}/gpsr.json` |
| Output      | `{ product_id, sections: [{ title, text }] }`             |

> Gets a product's General Product Safety Regulation (GPSR) information: the sections Printify
> derives from its `safety_information`, each with a title and text. Set `safety_information`
> with `create_product` or `update_product` to change them.

### `create_product`

| Field       | Value                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input       | `shop_id?`, `title`, `description`, `blueprint_id`, `print_provider_id`, `variants` (min 1, `price` required), `print_areas` (min 1), and the optional `productFields` |
| Annotations | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`                                                                                               |
| Requests    | `POST /v1/shops/{shop_id}/products.json`                                                                                                                               |
| Output      | `ProductSummary` of the created product                                                                                                                                |

`idempotentHint: false` is the honest answer: the same body twice makes two products. The body is
the input minus `shop_id`, sent as validated; the tool adds nothing.

> Creates a product from a catalog blueprint and print provider (from `search_blueprints` and
> `list_blueprint_providers`), with the variants to offer (ids from `list_variants`, prices in
> cents) and the artwork to print. `print_areas` maps variant ids to placeholders: each has a
> position from `list_variants` and the images to print there, by image id from `upload_image` or
> `list_uploads`. `x` and `y` place the image's centre, 0–1 from the top-left with 0.5/0.5 the
> centre of the print area; `scale` is the image width divided by the placeholder width, 1 fills
> it; `angle` rotates in degrees. Only one variant can be `is_default`; it gives the product its
> title image. Printify renders the mock-ups during the call, so it can take a while. Returns the
> new product's summary, including its id for `update_product`.

### `update_product`

| Field       | Value                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input       | `shop_id?`, `product_id`, every `productFields` entry optional, `variants?` (`price` optional), `print_areas?`, `replace_variants` boolean default `false` |
| Annotations | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: true`                                                                                    |
| Requests    | `GET …/products/{product_id}.json`, then `PUT …/products/{product_id}.json`                                                                                |
| Output      | `ProductSummary` of the updated product, plus `sent_fields: string[]`                                                                                      |

The handler, in order:

1. `resolveShopId`.
2. Refusals that need no request, each a `ToolError`: no updatable field given ("Nothing to
   update: give at least one of title, description, …"); `replace_variants: true` without
   `variants`; `replace_variants: true` with a variant lacking `price`; duplicate ids in
   `variants`.
3. `getProduct`, then `assertUnlocked`.
4. With `variants` and not `replace_variants`: `mergeVariants(product.variants, input.variants)`.
   `unknownIds` is a `ToolError`: "Product … has no variant 12345, 12346" with the hint "Use
   `list_variants` for the ids this blueprint and provider offer. To add or remove variants, pass
   `replace_variants: true` with the complete list, and `print_areas` that cover the new ids."
5. The PUT body: every input field except `shop_id`, `product_id` and `replace_variants`, with
   `variants` replaced by the merged list (or sent as given with `replace_variants`).
6. Return `summarizeProduct(response)` with `sent_fields`, the body's top-level keys, so the model
   sees that `variants` went out complete.

> Updates a product. Any of `title`, `description`, `tags`, `safety_information`, `variants`,
> `print_areas`, `print_details`, `external`, `is_printify_express_enabled` and
> `sales_channel_properties` can be given; fields left out keep their value. `variants` are merged
> by id into the product's current variants: give only the variants to change, with only the
> fields to change (`price` in cents, `is_enabled`, `is_default`, `sku`). The tool fetches the
> product and sends the complete list, because Printify removes every variant missing from an
> update. Setting `is_default` on one variant unsets it on the others. A variant id the product
> does not have is refused; to add or remove variants, pass `replace_variants: true` with the
> complete list (every entry with a `price`) and `print_areas` that cover the new ids.
> `print_areas`, when given, replace all print areas, text layers included. A product that is
> locked for publishing is refused before anything is sent. Returns the updated product's summary.

### `delete_product`

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Input       | `shop_id?`, `product_id`                                               |
| Gate        | `destructive`                                                          |
| Annotations | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` |
| Requests    | `DELETE /v1/shops/{shop_id}/products/{product_id}.json`                |
| Output      | `{ product_id, deleted: true }`                                        |

> Deletes a product from the shop. This cannot be undone. Confirm the product's id and title with
> the user first, e.g. from `get_product`. If the call fails with a timeout or a 404, check with
> `get_product` before calling it again rather than assuming nothing happened: a retried delete
> can succeed and still report 404.

## Error handling

- A `PrintifyApiError` propagates; the registry adds the hint. Code 8203 (low-quality image) and
  the `products.read`/`products.write` scope hint on a 403 already exist from #3.
- Every refusal in `update_product` is a `ToolError` with an action the model can take. None of
  them sends a request, and the locked one sends only the GET.
- A malformed product or GPSR body is an `invalid_response` error; for `update_product` that
  happens before the PUT, so a product whose variants cannot be resent is never partially
  rewritten (decision 11).
- `ctx.signal` goes into every request, so a cancelled update aborts whichever of its two requests
  is in flight.
- Nothing here logs a body: `run.ts` logs only a `PrintifyApiError`'s one-line message, and
  product titles or descriptions never appear in a hint.

## Tests

Test-first. None needs the network or a Printify account.

### `test/printify/schema.test.ts`

`lenient` accepts the value, turns `null` and a wrong type into `undefined`, and accepts a missing
key. The uploads test that covers the same behaviour through `uploadSchema` stays where it is.

### `test/printify/products.test.ts`

- each of the six requests uses the documented method and path, and `deleteProduct` succeeds
  against `{}` and an empty body
- `createProduct` and `updateProduct` send the body unchanged
- `listProducts` maps `fetchPage`'s envelope and a `limit` over 50 is lowered
- the documented mug parses, with `views`, `options` and `sales_channel_properties` kept
- `external: null` becomes `undefined`; a wrong-typed `tags` is dropped, the product still parses
- a body without `id`, a variant without `id` or `price`, and a non-array `variants` are each an
  `invalid_response` error naming "an unexpected product response"
- GPSR: the documented four sections parse; an object instead of an array is an error

### `test/tools/product-summary.test.ts`

- `productRow` counts variants and enabled variants, keeps `id` and `handle` of `external`
- `summarizeProduct` keeps the scalar fields, lists every variant compactly, strips `src` and
  `type` from print-area images and keeps a text layer's fields, returns the default mock-ups with
  `mockup_count`, and copies neither `views` nor `options`
- a product with no `images` and no `print_areas` summarises without those keys

### `test/tools/product-update.test.ts`

- a patch of one variant's price yields the full list in the original order, other fields
  unchanged
- a patch without `price` keeps the current price; a patch with `sku` sets it
- `is_default: true` on one patch sets `is_default: false` on every other body
- a current variant's `undefined` field stays out of the body
- unknown ids come back as `unknownIds`, all of them, and no list — checked with
  `expect(result.ok).toBe(false)` and the ids, not with a matcher that passes on absence
- an empty patch list returns the current list unchanged
- `assertUnlocked` throws a `ToolError` naming the product for `is_locked: true` and returns for
  `false` and `undefined`

### `test/tools/products.test.ts`

Through `createTestServer` with the default `ALL_TOOLS`, so a tool that was never wired in fails
here. Requests are asserted with `api.expectRequest` after the awaited call.

- `list_products`: the request with `page` and `limit` in the query, the rows, `has_more`; a
  `limit` of 51 is a validation error with no request
- `get_product`: the summary; `detail: "full"` returns the parsed product including `views`; an
  unknown key is a validation error
- `get_product_gpsr`: `{ product_id, sections }`
- `create_product`: the body reaches `POST …/products.json` unchanged and the summary comes back;
  a missing `variants` is a validation error; the schema rejects `x: 1.5`, `y: -0.1`, `scale: 0`,
  a placeholder without `position`, an empty `variant_ids`, an unknown key in an image — each
  with `api.requests` empty
- `update_product`:
  - a title-only update sends `GET` then `PUT { title }` and returns the summary with
    `sent_fields: ['title']`
  - the issue's example: two XL variants at 2499 → the PUT body carries every variant of the
    fixture, the two with the new price, the rest unchanged, in the original order
  - `is_default` on one variant unsets the others in the PUT body
  - an unknown variant id is refused with `kind: 'tool'`, and only the GET was sent
  - `replace_variants: true` sends the list as given; without `variants`, or with a variant
    missing `price`, it is refused with no request
  - duplicate variant ids and an empty update are refused with no request
  - a locked product is refused with `kind: 'tool'` and the hint, and only the GET was sent
  - a 400 with code 8203 from the PUT reaches the model with its hint
- `delete_product`: absent by default and present with `PRINTIFY_ENABLE_DESTRUCTIVE=true`, the
  skip line and instructions name it; it sends `DELETE` and returns `{ product_id, deleted: true }`
- every tool resolves the default shop: one test calls `list_products` without `shop_id` against
  a single-shop account and asserts the shop list request and the products request

### `test/fixtures/products.ts`

Nothing imports the existing `PRODUCT` yet (#5 added it for tests that ended up defining their
own), so it is free to change. It gains the fields the summary reads: `cost`, `title` and
`is_available` on the variants, `updated_at`, `safety_information`, a second, non-default mock-up
and a text-layer image. New: `PRODUCT_MUG`, the documented example, verbatim; `lockedProduct()`;
`productsPage(items, overrides)` like `uploadsPage`; `GPSR_SECTIONS`, the documented four.

### CI

The smoke step's `for tool in …` list gains `list_products get_product get_product_gpsr
create_product update_product`, and a `! grep -q '"name":"delete_product"'` line joins the two
gated names, since the step runs without `PRINTIFY_ENABLE_DESTRUCTIVE`.

## Acceptance criteria mapping

| Criterion (issue #11)                                      | Covered by                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------- |
| Harness tests for every tool                               | `test/tools/products.test.ts`, one block per tool                 |
| … including the variant merge                              | the XL example and the `is_default` case, on the PUT body         |
| … and the locked-product pre-check                         | the locked case: `kind: 'tool'`, GET only                         |
| Schema tests reject invalid print areas before any request | the `create_product` schema cases, each with `api.requests` empty |

The issue's other requirements:

| Requirement                                                     | Covered by                                                   |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| Six tools, toolset `products`, `delete_product` gated           | `src/tools/products.ts`, the rule check in `catalog.test.ts` |
| Input schemas mirror the documented fields                      | the shared sub-schemas                                       |
| Descriptions explain `x`/`y`, `scale`, `angle`                  | the `.describe()` texts and `create_product`'s description   |
| Text layers not exposed for writing                             | no text fields in `imageInput`; shown in the summary         |
| `list_products` summaries                                       | `productRow`                                                 |
| `get_product` compact view and `detail: "full"`                 | `summarizeProduct`; decision 2 widens it to all variants     |
| Partial variant updates send the merged, complete list          | `mergeVariants`, decision 1                                  |
| Locked product refused before the API call, with an explanation | `assertUnlocked`, decision 10                                |
| Example: raise all XL variants to $24.99                        | the merge test                                               |

## Out of scope

| Topic                                                     | Where                                              |
| --------------------------------------------------------- | -------------------------------------------------- |
| Publishing, unpublishing, reporting the publishing result | #12                                                |
| Personalisation endpoints under `/products/{id}/`         | #13                                                |
| `create_product_from_image` over `createProduct()`        | #19                                                |
| Checking an image's pixel size against a placeholder      | #19, with `get_upload`                             |
| Writing text layers                                       | Printify documents them read-only                  |
| Merging `print_areas`                                     | Not planned: sent whole (decision 7)               |
| Removing variants without `replace_variants`              | Not planned: `is_enabled: false` hides one instead |
| A longer timeout for `create_product`                     | Not until a real run shows the 30 s default fails  |
| Filtering or searching the product list                   | Printify offers only `page` and `limit`            |
| Rendering the tool reference                              | #21                                                |

## Delivery

1. Branch `feat/11-products-toolset` from `origin/main` at d22a4a8, which carries #10 and #17, in
   its own worktree at `../printify-mcp-worktrees/11-products-toolset`, outside the repository so
   the main checkout's `eslint .` does not lint it. This spec is its first commit.
2. Implementation plan via the writing-plans skill.
3. Test-first implementation.
4. Local verification before any claim of success: `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test` and `npm run build`, plus the CI smoke step's commands against `dist/`.
5. PR starting with `Closes #11`, moved to In review on the project board. Watch its CI run on
   Node 22 and 24.
6. Hand-off comments:
   - #12: `getProduct` and `summarizeProduct` give a publishing tool the product and its compact
     view; the locked message in `product-update.ts` is where to add the tool names once they
     exist.
   - #19: `createProduct()` takes a validated body; the sub-schemas in `src/tools/products.ts`
     (`variantInput`, `printAreaInput`, `imageInput`) can be reused for its input.
