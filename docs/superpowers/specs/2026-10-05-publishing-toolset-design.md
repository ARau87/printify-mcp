# Publishing toolset — publish, succeeded, failed, unpublished — design

- **Issue:** [#12 Publishing toolset](https://github.com/ARau87/printify-mcp/issues/12)
- **Date:** 2026-10-05
- **Status:** approved
- **Depends on:** #11 (products toolset, merged as PR #36) and #19 (merged as PR #38); the
  branch is cut from `origin/main` at a6106cb

## Goal

Publishing behaves differently per shop. On a shop connected to Shopify, Etsy or another
Printify-integrated channel, `POST …/publish.json` hands the product to Printify, which creates
or updates the listing and unlocks the product when the channel reports back. On an API shop
(no channel, or a custom integration of the user's own), the same call only locks the product
and fires the `product:publish:started` event; the product stays locked, and every update is
refused, until the integration calls `publishing_succeeded` or `publishing_failed`.

This issue adds the `publishing` toolset: four write tools, one per endpoint. The requests are
trivial; the value is in the guidance. After `publish_product`, the assistant must know which of
the two worlds it is in and what to call next, and the locked-product refusal that `update_product`
already makes must name the tools that unlock the product.

## Printify API facts this design relies on

Checked on 2026-10-05 against the HTML docs at https://developers.printify.com/#publish-a-product
and the "Publishing properties" table under Products.

- **Four endpoints**, all `POST` under `/v1/shops/{shop_id}/products/{product_id}/`:
  `publish.json`, `publishing_succeeded.json`, `publishing_failed.json`, `unpublish.json`. **Every
  one answers `{}`**, so nothing can be read from a response.
- **Publish**, verbatim: "This does not implement any publishing action unless the Printify store
  is connected to one of our other supported sales channel integrations, if your store is custom
  and is subscribed to the product::pubish::started event, that event will be triggered and the
  properties that are set in the request body will be set in the event payload for your store to
  react to". And under Publishing properties: "The 'publish' button in the Printify app only locks
  the product on the Printify app and triggers the product:publish:started event … Once done, you
  can use the Publish succeeded endpoint or Publish failed endpoint to unlock the product."
- **Publish body:** the example sends `title`, `description`, `images`, `variants`, `tags`,
  `keyFeatures` and `shipping_template`, all `true`. The properties table marks `images`,
  `variants`, `title`, `description` and `tags` REQUIRED and `shipping_template` OPTIONAL ("Used
  by Etsy and Amazon sales channels only"). `keyFeatures` appears only in the example; the
  webhook payload spells it `key_features`. Each flag set to `false` means "will not be
  updated" in the channel.
- **Publish rate limit:** "200 requests per 30 minutes", on `publish.json` only.
  `src/printify/rate-limit.ts` already files that path under the `publish` bucket.
- **Succeeded**, verbatim: "removes the product from the locked status on the Printify app and
  sets the the it's external property with the handle you provide in the request body". Body:
  `{ "external": { "id": "…", "handle": "https://example.com/path/to/product" } }`, an object,
  while the product read side returns `external` as an array of `{ id, handle,
shipping_template_id }`.
- **Failed**, verbatim: "removes the product from the locked status on the Printify app". Body:
  `{ "reason": "Request timed out" }`.
- **Unpublished:** titled "Notify that a product has been unpublished". No request body is
  documented. It tells Printify the listing is gone from the channel; nothing says it removes a
  listing from a connected store.
- **Locking:** `is_locked` is read-only, "A product is locked during publishing. Locked products
  can't be updated until unlocked." What `publish.json` does to an already-locked product is not
  documented.
- **Shops:** `sales_channel` "defaults to 'disconnected'" when no channel is connected. The docs
  name no other value. Custom integrations built on the API report their own channel; the
  value `custom_integration` is this design's assumption for them (see decision 2).

## What this issue does not build

| Piece                                                         | Where                           | Landed in |
| ------------------------------------------------------------- | ------------------------------- | --------- |
| The `publish` rate-limit bucket and its fail-fast 429 hint    | `src/printify/rate-limit.ts`    | #4        |
| `products.write` scope hint for 403 on these paths            | `src/printify/hints.ts`         | #3        |
| "May still have gone through" on POST timeouts                | `src/printify/hints.ts`         | #3        |
| `ToolError` → `{ kind: 'tool', message, hint }`               | `src/tools/run.ts`              | #5        |
| `shopIdInput`, `resolveShopId`, the cached `ShopDirectory`    | `src/tools/shop-id.ts`, `shops` | #7        |
| `getProduct`, `productRow`, `assertUnlocked`, `LOCKED_HINT`   | `src/printify/products.ts`, …   | #11       |
| `NEXT_STEP` in `create_product_from_image`, with a guard test | `src/tools/workflows.ts`        | #19       |

Nothing here holds state. `ToolServices`, `src/cli.ts`, `test/support/harness.ts` and
`test/tools/fixtures.ts` do not change: the shop list cache the guidance needs already exists.
The HTTP client sends JSON bodies for POST and copes with a `{}` answer.

## Decisions that differ from the issue

1. **`publish_product` fetches the product first and refuses a locked one.** The response is
   `{}`, so the tool cannot learn anything after the POST; the one GET before it gives the
   title for the result and the `is_locked` flag. An already-locked product is refused with the
   same `assertUnlocked` that `update_product` uses, so the model gets the tool names (decision 4)
   instead of an undocumented Printify answer. No GET after the POST: on a connected shop
   `is_locked` is transiently true anyway, so a second read would only mislead.
2. **The shop kind comes from the cached shop list.** `shopKind(shop)` maps `sales_channel`
   `disconnected` and `custom_integration` to `api` and everything else to `connected`. The
   second string is not in the docs; it is what Printify's custom-integration flow is believed to
   report, and the spec flags it for a read-only live check with `list_shops` once an API shop is
   at hand. A misclassified custom shop gets the connected text, which still names the unlock
   tools and tells the model to check `get_product`, so the mistake costs one extra look. If the
   resolved shop id is not in the cached list (an explicit `shop_id` the list never returned),
   the list is refreshed once; if it is still missing, the kind is `unknown` and the guidance
   covers both cases. A failing shop-list request propagates as the API error it is, like the
   product GET would.
3. **`unpublish_product` is named `set_product_unpublished`.** It reports a state, like
   `set_publishing_succeeded` and `set_publishing_failed`, and the docs title it "Notify that a
   product has been unpublished". A model on an Etsy shop must not call it expecting the listing
   to vanish. It is not refused on connected shops: when Printify's view and the channel disagree,
   it is the only way to correct Printify's side.
4. **`LOCKED_HINT` now names the tools.** #11 left it tool-free because #12 did not exist. It
   now says what to do on each shop kind, and `publish_product` reuses it unchanged.
5. **The succeeded body is the documented object**, `{ external: { id, handle } }`, not the array
   the read side uses and not `shipping_template_id`, which the docs say is set on create or
   update.
6. **The flags are optional booleans that default to `true`**, sent all seven every time as the
   example does, so a body always has the five REQUIRED ones. The key is sent as `keyFeatures`,
   as the example spells it; the tool's input calls it `key_features` like every other
   snake_case argument, and the description says so.
7. **The three notify tools do not fetch the product.** The model already holds what it sent,
   and a 200 is the confirmation. Each returns the arguments it sent plus the resulting lock
   state, so the model can say what happened without another call.
8. **No gate.** Publishing is reversible by the channel and spends nothing. All four tools are
   `readOnlyHint: false`, `destructiveHint: false`; `publish_product` is `idempotentHint: false`
   (a repeat fires the event and the channel update again), the other three are idempotent.

## Files

| File                               | Change                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| `src/printify/publishing.ts`       | New: four request functions                                           |
| `src/tools/shop-kind.ts`           | New: `shopKind`, `ShopKind`, the guidance texts                       |
| `src/tools/publishing.ts`          | New: the four tools and `publishingTools`                             |
| `src/tools/product-update.ts`      | `LOCKED_HINT` names the unlock tools                                  |
| `src/tools/workflows.ts`           | `NEXT_STEP` names `publish_product`                                   |
| `src/tools/products.ts`            | Exports `productId`, so the publishing tools share the id schema      |
| `src/tools/index.ts`               | `publishing: publishingTools`                                         |
| `.github/workflows/ci.yml`         | The four names in the smoke step's "reaches a real client" loop       |
| `test/printify/publishing.test.ts` | New                                                                   |
| `test/tools/shop-kind.test.ts`     | New                                                                   |
| `test/tools/publishing.test.ts`    | New                                                                   |
| `test/tools/products.test.ts`      | The locked-refusal hint assertion follows the new wording             |
| `test/tools/workflows.test.ts`     | The `publish_product` guard flips from `not.toContain` to `toContain` |
| `test/fixtures/shops.ts`           | Adds `CUSTOM_SHOP` (`sales_channel: 'custom_integration'`)            |

## `src/printify/publishing.ts`

Four functions, each taking `(client, shopId, productId, …, signal)`, building its path with
`apiPath`, POSTing and ignoring the `{}` body the way `deleteProduct` and `archiveUpload` do.
Nothing is parsed, so there is no response schema.

- `publishProduct(client, shopId, productId, flags: PublishFlags, signal)`: body is `flags`,
  already in Printify's spelling (`keyFeatures`).
- `setPublishingSucceeded(client, shopId, productId, external: { id, handle }, signal)`: body
  `{ external }`.
- `setPublishingFailed(client, shopId, productId, reason, signal)`: body `{ reason }`.
- `setProductUnpublished(client, shopId, productId, signal)`: no body.

`PublishFlags` is the exported interface `{ title, description, images, variants, tags,
keyFeatures, shipping_template }`, all `boolean`.

## `src/tools/shop-kind.ts`

Pure, no I/O, so the guidance is unit-tested verbatim and the tool file stays thin.

- `type ShopKind = 'api' | 'connected' | 'unknown'`.
- `shopKind(shop: Shop | undefined): ShopKind`: `undefined` → `unknown`; `sales_channel`
  `disconnected` or `custom_integration` → `api`; a missing `sales_channel` → `unknown`;
  anything else → `connected`.
- `publishNextStep(kind: ShopKind, salesChannel: string | undefined): string`, the texts:
  - `api`: "publish_product only locked the product and sent your integration the
    product:publish:started event. Create the listing in your sales channel, then call
    set_publishing_succeeded with its id and handle, or set_publishing_failed with the reason.
    The product stays locked, and update_product refuses it, until one of them is called."
  - `connected`: "Printify is publishing the product to {sales_channel}. It stays locked until
    the channel reports the result; then get_product shows is_locked false and the external id
    and handle."
  - `unknown`: "This shop is not in the account's shop list, so its sales channel is unknown. "
    followed by the api text, "Otherwise: " and the connected text with "the sales channel" in
    place of the name.
- `findShop(shops: ShopDirectory, shopId: number, signal): Promise<Shop | undefined>`: looks the
  id up in `shops.list(signal)`, and on a miss once more in `shops.refresh(signal)`. This is the
  only I/O in the module and the only place the refresh-once rule lives.

## Tools

Every tool spreads `shopIdInput`, takes `product_id` with the same letters-and-digits regex as the
products tools (exported from `src/tools/products.ts` as `productId`, which is the one change to
that file), and starts its handler with `resolveShopId`.

### `publish_product`

- Description: publishes a product to the shop's sales channel. On a shop connected to Shopify,
  Etsy or another Printify integration, Printify creates or updates the listing and unlocks the
  product when the channel reports back. On an API shop it only locks the product and sends the
  `product:publish:started` event, and the integration must call `set_publishing_succeeded` or
  `set_publishing_failed` to unlock it; the result says which case applies and what to do next.
  Each flag set to `false` keeps that part of the listing as it is in the channel, e.g.
  `tags: false` keeps the channel's tags; `key_features` is sent as Printify's `keyFeatures`;
  `shipping_template` matters on Etsy and Amazon only. A locked product is refused before
  anything is sent. If the call fails with a timeout, check `get_product` (`is_locked`) before
  calling it again. Limited to 200 calls per 30 minutes.
- Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`.
- Input: `shop_id?`, `product_id`, and `title`, `description`, `images`, `variants`, `tags`,
  `key_features`, `shipping_template`, each `z.boolean().default(true)` with a one-line
  describe.
- Handler: `resolveShopId`; `findShop`; `getProduct`; `assertUnlocked`; `publishProduct` with
  the flags mapped to Printify's spelling; return

  `{ product_id, title, shop_id, sales_channel, shop_kind, published: { title, description,
images, variants, tags, key_features, shipping_template }, locked: true, next_step }`.

  `title` and `sales_channel` are `undefined` when Printify did not send them, and the registry
  drops them. `locked` is always `true`: that is what the POST does on both shop kinds.

### `set_publishing_succeeded`

- Description: tells Printify that an API shop's integration published the product, which
  unlocks it and records the listing's external id and handle (the URL or path in the sales
  channel). For API shops; a connected shop reports this itself.
- Annotations: write, not destructive, idempotent.
- Input: `shop_id?`, `product_id`, `external_id: z.string().min(1)`, `handle: z.string().min(1)`.
- Handler: `resolveShopId`; `setPublishingSucceeded`; return
  `{ product_id, external: { id, handle }, locked: false }`.

### `set_publishing_failed`

- Description: tells Printify that an API shop's integration could not publish the product, which
  unlocks it; `reason` is shown in the Printify app.
- Annotations: write, not destructive, idempotent.
- Input: `shop_id?`, `product_id`, `reason: z.string().min(1)`.
- Handler: `resolveShopId`; `setPublishingFailed`; return `{ product_id, reason, locked: false }`.

### `set_product_unpublished`

- Description: tells Printify that the product's listing was removed from the sales channel, so
  Printify shows it as unpublished. It does not remove anything from a connected store; unpublish
  there in the channel itself.
- Annotations: write, not destructive, idempotent.
- Input: `shop_id?`, `product_id`.
- Handler: `resolveShopId`; `setProductUnpublished`; return `{ product_id, unpublished: true }`.

`publishingTools` lists them in that order.

## Changes to existing files

- `src/tools/product-update.ts`: `LOCKED_HINT` becomes "Printify unlocks it when the sales
  channel reports the publishing result. On a connected shop, wait and try again. On an API shop,
  call set_publishing_succeeded or set_publishing_failed, then retry." `assertUnlocked` is
  unchanged.
- `src/tools/workflows.ts`: `NEXT_STEP` gains the sentence "When the user is happy, publish_product
  sends it to the sales channel."
- `src/tools/products.ts`: exports `productId`.
- `src/tools/index.ts`: `publishing: publishingTools`.
- `.github/workflows/ci.yml`: `publish_product set_publishing_succeeded set_publishing_failed
set_product_unpublished` join the loop of names that must be registered without a flag.

## Error handling

Nothing new in `hints.ts`. The existing envelope covers every case:

- A locked product on `publish_product` is the `ToolError` from `assertUnlocked`, now with the
  tool names in its hint.
- A missing `external_id`, `handle` or `reason`, or an empty one, is a validation error before
  any request.
- A 429 from the publish bucket is the limiter's fail-fast error with the minutes-to-wait hint.
- A 403 gets the `products.write` scope hint, since `scopeFor` already matches
  `/v1/shops/{id}/products/…`.
- A timeout or network error on any of the POSTs carries "The request may still have gone
  through", and `publish_product`'s description says to check `get_product` first.
- A shop-list or product GET failure propagates as the API error it is.

## Tests

### `test/printify/publishing.test.ts`

Each function sends the right method, path and body; `setProductUnpublished` sends no body;
each resolves to `undefined` on `{}`.

### `test/tools/shop-kind.test.ts`

`shopKind`: `disconnected` and `custom_integration` → `api`; `shop({ sales_channel: 'etsy' })`
and the fixture's "My Sales Channel" → `connected`; `undefined` shop and a shop without `sales_channel` →
`unknown`. `publishNextStep`: the api text names `set_publishing_succeeded`,
`set_publishing_failed` and `update_product`; the connected text names the channel and
`get_product`; the unknown text contains both. `findShop`, against a stub `ShopDirectory` that counts
its calls: found in the cached list without a refresh; missing from the list and found by the
refresh; missing from both → `undefined`, one `list` and one `refresh`.

### `test/tools/publishing.test.ts`

Through the harness with the default tools:

- All four tools are registered without a flag, with the annotations above, and
  `TOOLS_BY_TOOLSET.publishing` lists them in order.
- `publish_product` on `SHOP` (connected) returns `shop_kind: 'connected'`, `locked: true`, a
  `next_step` naming "My Sales Channel" and `get_product`; on `DISCONNECTED_SHOP` and
  `CUSTOM_SHOP`, `shop_kind: 'api'` and a `next_step` naming `set_publishing_succeeded`. This is
  the issue's second acceptance criterion.
- The body defaults to all seven flags `true` with `keyFeatures` spelled Printify's way;
  `{ tags: false }` (the issue's example prompt) reaches Printify as `tags: false` with the rest
  `true`, and `published.tags` is `false` in the result.
- The requests are `GET /v1/shops.json`, `GET …/{product_id}.json`, `POST …/publish.json`, in
  that order, and a second call on the same server sends no second shop list.
- An explicit `shop_id` that the list lacks: one refresh, then `shop_kind: 'unknown'` and the
  combined text; the POST is still sent.
- A locked product (`lockedProduct()`) is refused with `kind: 'tool'`, the hint names
  `set_publishing_succeeded`, and no POST is sent.
- `set_publishing_succeeded` sends `{ external: { id, handle } }` and returns `locked: false`;
  a missing `handle` is a validation error with no request.
- `set_publishing_failed` sends `{ reason }`; `reason: ''` is a validation error with no request.
- `set_product_unpublished` sends no body and returns `unpublished: true`.
- An unknown argument on any of the four is a validation error with no request.
- One default-shop test (`shop_id` left out, one shop in the account) for `publish_product`.

### `test/tools/products.test.ts`, `workflows.test.ts`

The `update_product` locked-refusal test asserts the new hint
(`toContain('set_publishing_succeeded')`); `product-update.test.ts` compares against the
`LOCKED_HINT` constant and needs no change. The workflows guard becomes "names publish_product in next_step" and the "does not exist yet"
comment goes.

### CI

The smoke step's name loop gains the four tools. `test/tools/catalog.test.ts` already checks every
tool in `ALL_TOOLS` against the definition rules and its toolset, so nothing is added there.

## Acceptance criteria mapping

| Criterion                                                            | Where                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Harness tests for all tools                                          | `test/tools/publishing.test.ts`                                  |
| Locked-product guidance on an API shop vs a connected shop           | `publish_product` on `SHOP` vs `DISCONNECTED_SHOP`/`CUSTOM_SHOP` |
| Flags default `true`, `keyFeatures` camelCase, `tags: false` example | the body tests                                                   |
| Result says whether the product is locked and what to call next      | `locked`, `shop_kind`, `next_step`; `shop-kind.test.ts`          |
| Uses the publish rate-limit bucket                                   | #4's bucket, matched by path; no change                          |
| Live tests read-only                                                 | no live test for this toolset                                    |

## Out of scope

- Reading the product after the POST, or polling until `is_locked` clears. `get_product` does
  that on request.
- Refusing `set_product_unpublished` or the two notify tools on connected shops.
- Webhooks for `product:publish:started` (#15) and any listing-creation logic for API shops;
  this server only reports the state back.
- A `shipping_template_id` on succeeded; the docs put it on create and update.
- A README; none exists yet.

## Delivery

1. Branch `feat/12-publishing-toolset` from `origin/main` at a6106cb, in the worktree
   `../printify-mcp-worktrees/12-publishing-toolset`, outside the repository so the main
   checkout's `eslint .` does not lint it. This spec is its first commit. The board shows #12 In
   progress.
2. Implementation plan via the writing-plans skill, with every code block prototyped and
   lint/typecheck/test-verified before the plan is written, as #19 did.
3. Test-first implementation.
4. Local verification before any claim of success: `npm run lint`, `npm run typecheck`,
   `npm test` and `npm run build`, plus the CI smoke step's commands against `dist/`.
5. PR starting with `Closes #12`, moved to In review on the project board. Watch its CI run on
   Node 22 and 24. Expect conflicts in `src/tools/index.ts` and `ci.yml` with `feat/18-print-areas`
   if that merges first.
6. Hand-off: #15 (webhooks) can point its `product:publish:started` description at
   `set_publishing_succeeded` and `set_publishing_failed`. Once an API shop is available, a
   read-only `list_shops` confirms or corrects `custom_integration` in `shop-kind.ts`.
