# Publishing toolset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `publishing` toolset: `publish_product`, `set_publishing_succeeded`, `set_publishing_failed` and `set_product_unpublished`, with a result that tells the assistant whether the shop is an API shop or a connected channel and what to call next.

**Architecture:** A request module `src/printify/publishing.ts` POSTs to the four endpoints and ignores their `{}` answers. A pure module `src/tools/shop-kind.ts` classifies a shop by its `sales_channel`, holds the guidance texts and finds a shop in the cached directory with one refresh on a miss. `src/tools/publishing.ts` holds the thin tools; `publish_product` resolves the shop, looks it up, fetches the product, refuses a locked one with the shared `assertUnlocked`, POSTs and returns the guidance. The locked hint in `product-update.ts` and the `next_step` of `create_product_from_image` now name the new tools.

**Tech Stack:** TypeScript ~6.0, zod 4, `@modelcontextprotocol/server` v2, vitest 5, the fake Printify API in `test/support/`.

**Spec:** `docs/superpowers/specs/2026-10-05-publishing-toolset-design.md`

## Global Constraints

- Work in the worktree `../printify-mcp-worktrees/12-publishing-toolset` on branch `feat/12-publishing-toolset`, cut from `origin/main` at a6106cb. Check `git branch --show-current` before every commit: other sessions share the main checkout.
- Every commit message ends with exactly this trailer, which overrides any attribution your own harness adds: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- No new dependencies. No edits outside the files each task lists.
- Before each commit: `npm run lint` (eslint strictTypeChecked + `prettier --check .`), `npm run typecheck` and `npm test` all pass. Run `npx prettier --write <files>` on the files you touched if lint reports formatting.
- Template literals wrap numbers in `String(...)` (lint rule `restrict-template-expressions`). No `!` non-null assertions. No unused variables, including destructured ones.
- Baseline on `main` after #19: 741 tests. After Task 1: 747. After Task 2: 756. After Task 3: 756. After Task 4: 777.
- Tool descriptions and hints name only tools that exist in `ALL_TOOLS`. After Task 4 that includes the four new ones.
- Every code block below was prototyped, formatted with Prettier, lint-, typecheck- and test-verified, and mutation-checked (forcing `keyFeatures` to `true`, dropping the refresh in `findShop`, dropping `custom_integration`, flipping `locked`, misspelling the hint: each turned at least one test red). Copy the blocks as they are.

## Review Focus

Each line is pinned by a test in the task named.

1. The product is gone between `list_products` and the publish: Printify's 404 on the product GET comes back with the not-found hint and no POST is sent (Task 4: "reports a product that is not found, without publishing").
2. The shop is `PRINTIFY_SHOP_ID`, so `resolveShopId` never fetched the list: the classification still works and the list is fetched once (Task 4: "classifies the shop when PRINTIFY_SHOP_ID is the default").
3. The shop is listed but Printify sent no `sales_channel` (the lenient schema dropped a wrong type): the kind is `unknown` and no refresh is wasted on it, since the id was found (Task 4: "is unknown, without a refresh, for a listed shop that has no sales_channel").
4. The publish POST itself fails with a 5xx after the product GET: the error reaches the model as an http error with the retry hint rather than as a success (Task 4: "reports a server error on the publish itself, with the retry hint").
5. Printify answers `unpublish.json` with a wholly empty body instead of `{}`: the call still resolves (Task 1: "accepts a wholly empty answer, like archiveUpload").

## Files

| File                               | Task | Change                                                    |
| ---------------------------------- | ---- | --------------------------------------------------------- |
| `src/printify/publishing.ts`       | 1    | New: four request functions                               |
| `test/printify/publishing.test.ts` | 1    | New, 6 tests                                              |
| `test/fixtures/shops.ts`           | 2    | Adds `CUSTOM_SHOP`                                        |
| `src/tools/shop-kind.ts`           | 2    | New: `shopKind`, `publishNextStep`, `findShop`            |
| `test/tools/shop-kind.test.ts`     | 2    | New, 9 tests                                              |
| `src/tools/product-update.ts`      | 3    | `LOCKED_HINT` names the unlock tools                      |
| `test/tools/products.test.ts`      | 3    | The locked-refusal hint assertion follows the new wording |
| `src/tools/products.ts`            | 4    | Exports `productId`                                       |
| `src/tools/publishing.ts`          | 4    | New: the four tools and `publishingTools`                 |
| `src/tools/index.ts`               | 4    | `publishing: publishingTools`                             |
| `src/tools/workflows.ts`           | 4    | `NEXT_STEP` names `publish_product`                       |
| `test/tools/workflows.test.ts`     | 4    | The `publish_product` guard flips                         |
| `test/tools/publishing.test.ts`    | 4    | New, 21 tests                                             |
| `.github/workflows/ci.yml`         | 4    | The four names in the smoke step's registered-tools loop  |

---

### Task 1: The request module

**Files:**

- Create: `src/printify/publishing.ts`
- Test: `test/printify/publishing.test.ts`

**Interfaces:**

- Consumes: `PrintifyClient.request(method, path, { body?, signal })` from `src/printify/client.ts`; `apiPath` from `src/printify/path.ts`, which URL-encodes every interpolated value.
- Produces: `interface PublishFlags { title; description; images; variants; tags; keyFeatures; shipping_template }` (all `boolean`), `interface ExternalListing { id: string; handle: string }`, and `publishProduct(client, shopId, productId, flags, signal)`, `setPublishingSucceeded(client, shopId, productId, external, signal)`, `setPublishingFailed(client, shopId, productId, reason, signal)`, `setProductUnpublished(client, shopId, productId, signal)`, each `Promise<void>`. Task 4 calls them.

- [ ] **Step 1: Write the failing tests**

Create `test/printify/publishing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createPrintifyClient, type PrintifyClient } from '../../src/printify/client.js';
import {
  publishProduct,
  setProductUnpublished,
  setPublishingFailed,
  setPublishingSucceeded,
  type PublishFlags,
} from '../../src/printify/publishing.js';
import { Secret } from '../../src/secret.js';
import { PRODUCT } from '../fixtures/products.js';
import { SHOP } from '../fixtures/shops.js';
import { createFakeApi, json, text, type FakeApi, type Routes } from '../support/fake-api.js';

const TOKEN = 'Tok-publishing-7G8h9I0j';
const SHOP_ID = SHOP.id;
const BASE = `/v1/shops/${String(SHOP_ID)}/products/${PRODUCT.id}`;
const PUBLISH_PATH = `${BASE}/publish.json`;
const SUCCEEDED_PATH = `${BASE}/publishing_succeeded.json`;
const FAILED_PATH = `${BASE}/publishing_failed.json`;
const UNPUBLISH_PATH = `${BASE}/unpublish.json`;

const ALL_TRUE: PublishFlags = {
  title: true,
  description: true,
  images: true,
  variants: true,
  tags: true,
  keyFeatures: true,
  shipping_template: true,
};

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

describe('publishProduct', () => {
  it('posts the flags as given, keyFeatures spelled the way Printify wants it', async () => {
    const { client, api } = testClient({ [`POST ${PUBLISH_PATH}`]: json({}) });
    const flags = { ...ALL_TRUE, tags: false };
    await expect(publishProduct(client, SHOP_ID, PRODUCT.id, flags, live())).resolves.toBe(
      undefined,
    );
    expect(api.expectRequest('POST', PUBLISH_PATH).body).toEqual(flags);
  });

  it('URL-encodes the product id', async () => {
    const path = `/v1/shops/${String(SHOP_ID)}/products/a%20b/publish.json`;
    const { client, api } = testClient({ [`POST ${path}`]: json({}) });
    await publishProduct(client, SHOP_ID, 'a b', ALL_TRUE, live());
    api.expectRequest('POST', path);
  });
});

describe('setPublishingSucceeded', () => {
  it('posts the external reference as the documented object', async () => {
    const { client, api } = testClient({ [`POST ${SUCCEEDED_PATH}`]: json({}) });
    const external = { id: '5941187eb8e7e37b3f0e62e5', handle: 'https://example.com/p/tee' };
    await expect(
      setPublishingSucceeded(client, SHOP_ID, PRODUCT.id, external, live()),
    ).resolves.toBeUndefined();
    expect(api.expectRequest('POST', SUCCEEDED_PATH).body).toEqual({ external });
  });
});

describe('setPublishingFailed', () => {
  it('posts the reason', async () => {
    const { client, api } = testClient({ [`POST ${FAILED_PATH}`]: json({}) });
    await expect(
      setPublishingFailed(client, SHOP_ID, PRODUCT.id, 'Request timed out', live()),
    ).resolves.toBeUndefined();
    expect(api.expectRequest('POST', FAILED_PATH).body).toEqual({ reason: 'Request timed out' });
  });
});

describe('setProductUnpublished', () => {
  it('posts without a body', async () => {
    const { client, api } = testClient({ [`POST ${UNPUBLISH_PATH}`]: json({}) });
    await expect(
      setProductUnpublished(client, SHOP_ID, PRODUCT.id, live()),
    ).resolves.toBeUndefined();
    expect(api.expectRequest('POST', UNPUBLISH_PATH).body).toBeUndefined();
  });

  it('accepts a wholly empty answer, like archiveUpload', async () => {
    const { client } = testClient({ [`POST ${UNPUBLISH_PATH}`]: text('', 200) });
    await expect(setProductUnpublished(client, SHOP_ID, PRODUCT.id, live())).resolves.toBe(
      undefined,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/printify/publishing.test.ts`
Expected: FAIL, the suite cannot import `../../src/printify/publishing.js`.

- [ ] **Step 3: Write the module**

Create `src/printify/publishing.ts`:

```ts
import type { PrintifyClient } from './client.js';
import { apiPath, type ApiPath } from './path.js';

/**
 * The publish request body, in Printify's spelling. A flag set to `false` keeps that part of the
 * listing as it is in the sales channel.
 */
export interface PublishFlags {
  title: boolean;
  description: boolean;
  images: boolean;
  variants: boolean;
  tags: boolean;
  keyFeatures: boolean;
  shipping_template: boolean;
}

/** The listing's reference in the sales channel, as `publishing_succeeded` records it. */
export interface ExternalListing {
  id: string;
  handle: string;
}

function publishPath(shopId: number, productId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/products/${productId}/publish.json`;
}

function succeededPath(shopId: number, productId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/products/${productId}/publishing_succeeded.json`;
}

function failedPath(shopId: number, productId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/products/${productId}/publishing_failed.json`;
}

function unpublishPath(shopId: number, productId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/products/${productId}/unpublish.json`;
}

// Every endpoint here answers `{}`, so none of these reads the response, like `deleteProduct`.

/**
 * Publishes a product: on a connected shop Printify updates the listing, on an API shop it only
 * locks the product and fires `product:publish:started`.
 */
export async function publishProduct(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  flags: PublishFlags,
  signal: AbortSignal,
): Promise<void> {
  await client.request('POST', publishPath(shopId, productId), { body: flags, signal });
}

/** Unlocks a product and records the listing's id and handle. */
export async function setPublishingSucceeded(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  external: ExternalListing,
  signal: AbortSignal,
): Promise<void> {
  await client.request('POST', succeededPath(shopId, productId), {
    body: { external },
    signal,
  });
}

/** Unlocks a product; `reason` is shown in the Printify app. */
export async function setPublishingFailed(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  reason: string,
  signal: AbortSignal,
): Promise<void> {
  await client.request('POST', failedPath(shopId, productId), { body: { reason }, signal });
}

/** Tells Printify the listing was removed from the sales channel. No body is documented. */
export async function setProductUnpublished(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  signal: AbortSignal,
): Promise<void> {
  await client.request('POST', unpublishPath(shopId, productId), { signal });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/printify/publishing.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green, 747 tests.

```bash
git add src/printify/publishing.ts test/printify/publishing.test.ts
git commit -m "Add the publishing request module

Four POSTs for publish, publishing_succeeded, publishing_failed and
unpublish, each ignoring Printify's empty answer.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Shop kind and the guidance texts

**Files:**

- Modify: `test/fixtures/shops.ts` (after `DISCONNECTED_SHOP`)
- Create: `src/tools/shop-kind.ts`
- Test: `test/tools/shop-kind.test.ts`

**Interfaces:**

- Consumes: `Shop` (`{ id, title?, sales_channel? }`) and `ShopDirectory` (`list`, `refresh`, `invalidate`) from `src/printify/shops.ts`.
- Produces: `type ShopKind = 'api' | 'connected' | 'unknown'`; `shopKind(shop: Shop | undefined): ShopKind`; `publishNextStep(kind: ShopKind, salesChannel: string | undefined): string`; `findShop(shops: ShopDirectory, shopId: number, signal: AbortSignal): Promise<Shop | undefined>`; the fixture `CUSTOM_SHOP`. Task 4 uses all of them.

- [ ] **Step 1: Add the fixture**

In `test/fixtures/shops.ts`, insert between `DISCONNECTED_SHOP` and `SHOPS` (leave `SHOPS` as `[SHOP, DISCONNECTED_SHOP]`: the shops tests count its two entries):

```ts
/** A shop whose own integration publishes, which #12 treats like a disconnected one. */
export const CUSTOM_SHOP = {
  id: 2468,
  title: 'My custom store',
  sales_channel: 'custom_integration',
};
```

- [ ] **Step 2: Write the failing tests**

Create `test/tools/shop-kind.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Shop, ShopDirectory } from '../../src/printify/shops.js';
import { findShop, publishNextStep, shopKind } from '../../src/tools/shop-kind.js';
import { CUSTOM_SHOP, DISCONNECTED_SHOP, SHOP, shop } from '../fixtures/shops.js';

/** A signal that has not aborted. */
function live(): AbortSignal {
  return new AbortController().signal;
}

/** A directory that answers `cached` from `list` and `fresh` from `refresh`, counting both. */
function stubDirectory(cached: readonly Shop[], fresh: readonly Shop[] = cached) {
  const calls = { list: 0, refresh: 0 };
  const directory: ShopDirectory = {
    list: () => {
      calls.list += 1;
      return Promise.resolve(cached);
    },
    refresh: () => {
      calls.refresh += 1;
      return Promise.resolve(fresh);
    },
    invalidate: () => undefined,
  };
  return { directory, calls };
}

describe('shopKind', () => {
  it('treats a disconnected shop and a custom integration as API shops', () => {
    expect(shopKind(DISCONNECTED_SHOP)).toBe('api');
    expect(shopKind(CUSTOM_SHOP)).toBe('api');
  });

  it('treats every other channel as connected', () => {
    expect(shopKind(SHOP)).toBe('connected');
    expect(shopKind(shop({ sales_channel: 'etsy' }))).toBe('connected');
  });

  it('is unknown without a shop or without a sales channel', () => {
    expect(shopKind(undefined)).toBe('unknown');
    expect(shopKind({ id: 1, title: 'No channel' })).toBe('unknown');
  });
});

describe('publishNextStep', () => {
  it('tells an API shop to report back with the notify tools', () => {
    const text = publishNextStep('api', 'disconnected');
    expect(text).toContain('product:publish:started');
    expect(text).toContain('set_publishing_succeeded');
    expect(text).toContain('set_publishing_failed');
    expect(text).toContain('update_product refuses it');
  });

  it('tells a connected shop to wait for the channel, by name', () => {
    const text = publishNextStep('connected', 'etsy');
    expect(text).toContain('publishing the product to etsy');
    expect(text).toContain('get_product');
    expect(text).not.toContain('set_publishing_succeeded');
  });

  it('covers both cases for an unknown shop', () => {
    const text = publishNextStep('unknown', undefined);
    expect(text).toContain('not in the account');
    expect(text).toContain('set_publishing_succeeded');
    expect(text).toContain('publishing the product to the sales channel');
  });
});

describe('findShop', () => {
  it('finds a cached shop without refreshing', async () => {
    const { directory, calls } = stubDirectory([SHOP, DISCONNECTED_SHOP]);
    expect(await findShop(directory, DISCONNECTED_SHOP.id, live())).toEqual(DISCONNECTED_SHOP);
    expect(calls).toEqual({ list: 1, refresh: 0 });
  });

  it('refreshes once when the cache lacks the shop', async () => {
    const { directory, calls } = stubDirectory([SHOP], [SHOP, CUSTOM_SHOP]);
    expect(await findShop(directory, CUSTOM_SHOP.id, live())).toEqual(CUSTOM_SHOP);
    expect(calls).toEqual({ list: 1, refresh: 1 });
  });

  it('gives up after one refresh', async () => {
    const { directory, calls } = stubDirectory([SHOP]);
    expect(await findShop(directory, 1111, live())).toBeUndefined();
    expect(calls).toEqual({ list: 1, refresh: 1 });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/tools/shop-kind.test.ts`
Expected: FAIL, the suite cannot import `../../src/tools/shop-kind.js`.

- [ ] **Step 4: Write the module**

Create `src/tools/shop-kind.ts`:

```ts
import type { Shop, ShopDirectory } from '../printify/shops.js';

/**
 * How a shop publishes. `api`: the user's own integration listens for `product:publish:started`
 * and reports back. `connected`: Printify publishes to the channel itself. `unknown`: the shop is
 * not in the account's list, or has no sales channel.
 */
export type ShopKind = 'api' | 'connected' | 'unknown';

// `disconnected` is documented as the value for a shop with no channel. `custom_integration` is
// what a custom integration built on the API is believed to report; the docs do not say.
const API_CHANNELS: ReadonlySet<string> = new Set(['disconnected', 'custom_integration']);

export function shopKind(shop: Shop | undefined): ShopKind {
  if (shop?.sales_channel === undefined) return 'unknown';
  return API_CHANNELS.has(shop.sales_channel) ? 'api' : 'connected';
}

const API_NEXT_STEP =
  'publish_product only locked the product and sent your integration the ' +
  'product:publish:started event. Create the listing in your sales channel, then call ' +
  'set_publishing_succeeded with its id and handle, or set_publishing_failed with the reason. ' +
  'The product stays locked, and update_product refuses it, until one of them is called.';

function connectedNextStep(channel: string): string {
  return (
    `Printify is publishing the product to ${channel}. It stays locked until the channel ` +
    'reports the result; then get_product shows is_locked false and the external id and handle.'
  );
}

/** What the assistant should do after `publish_product`, for the shop's kind. */
export function publishNextStep(kind: ShopKind, salesChannel: string | undefined): string {
  switch (kind) {
    case 'api':
      return API_NEXT_STEP;
    case 'connected':
      return connectedNextStep(salesChannel ?? 'the sales channel');
    case 'unknown':
      return (
        "This shop is not in the account's shop list, so its sales channel is unknown. If it " +
        `is an API shop: ${API_NEXT_STEP} Otherwise: ${connectedNextStep('the sales channel')}`
      );
  }
}

/**
 * The shop with `shopId` from the cached list, or after one refresh when the cache lacks it (an
 * explicit `shop_id` for a shop added since the list was cached). `undefined` when it is in
 * neither.
 */
export async function findShop(
  shops: ShopDirectory,
  shopId: number,
  signal: AbortSignal,
): Promise<Shop | undefined> {
  const cached = (await shops.list(signal)).find((shop) => shop.id === shopId);
  if (cached !== undefined) return cached;
  return (await shops.refresh(signal)).find((shop) => shop.id === shopId);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/tools/shop-kind.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 6: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green, 756 tests.

```bash
git add test/fixtures/shops.ts src/tools/shop-kind.ts test/tools/shop-kind.test.ts
git commit -m "Add the shop kind and the publishing guidance texts

A disconnected shop or a custom integration publishes through its own
integration; every other channel is published by Printify. The texts
tell the assistant what to call next after publish_product.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The locked hint names the unlock tools

**Files:**

- Modify: `src/tools/product-update.ts` (`LOCKED_HINT`, lines 25-27)
- Modify: `test/tools/products.test.ts` (the `update_product` test "refuses a locked product before the PUT", around line 443)

**Interfaces:**

- Consumes: nothing new.
- Produces: `LOCKED_HINT`, which `assertUnlocked` already attaches to its `ToolError`. Task 4's `publish_product` reuses `assertUnlocked` and asserts this wording.

`test/tools/product-update.test.ts` compares against the `LOCKED_HINT` constant and needs no change. The tools named here exist only after Task 4, which is why Task 4 follows immediately; until then the suite is green but the hint names tools that are not registered yet.

- [ ] **Step 1: Change the assertion first**

In `test/tools/products.test.ts`, in the `update_product` test "refuses a locked product before the PUT", replace

```ts
expect(error.hint).toContain('publishing result');
```

with

```ts
expect(error.hint).toContain('set_publishing_succeeded');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tools/products.test.ts -t "refuses a locked product before the PUT"`
Expected: FAIL, the hint does not contain `set_publishing_succeeded`.

- [ ] **Step 3: Change the hint**

In `src/tools/product-update.ts`, replace the `LOCKED_HINT` constant with

```ts
export const LOCKED_HINT =
  'Printify unlocks it when the sales channel reports the publishing result. On a connected ' +
  'shop, wait and try again. On an API shop, call set_publishing_succeeded or ' +
  'set_publishing_failed, then retry.';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/products.test.ts test/tools/product-update.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green, 756 tests.

```bash
git add src/tools/product-update.ts test/tools/products.test.ts
git commit -m "Name the publishing tools in the locked-product hint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The tools, wired in

**Files:**

- Modify: `src/tools/products.ts` (line 24: export `productId`)
- Create: `src/tools/publishing.ts`
- Modify: `src/tools/index.ts` (import and the `publishing:` line)
- Modify: `src/tools/workflows.ts` (`NEXT_STEP`, lines 135-137)
- Modify: `test/tools/workflows.test.ts` (the last test of the file, lines 398-404)
- Modify: `.github/workflows/ci.yml` (the registered-tools loop, lines 64-71)
- Test: `test/tools/publishing.test.ts`

**Interfaces:**

- Consumes: Task 1's request functions and `PublishFlags`; Task 2's `findShop`, `shopKind`, `publishNextStep`, `CUSTOM_SHOP`; Task 3's `LOCKED_HINT` via `assertUnlocked`; `getProduct` from `src/printify/products.ts`; `defineTool`, `Tool`, `ToolAnnotations` from `src/tools/define.ts`; `resolveShopId`, `shopIdInput` from `src/tools/shop-id.ts`; `productId` from `src/tools/products.ts` (exported here).
- Produces: `publishingTools: readonly Tool[]`, the tools `publish_product`, `set_publishing_succeeded`, `set_publishing_failed`, `set_product_unpublished`.

- [ ] **Step 1: Export the product id schema**

In `src/tools/products.ts`, change the declaration at line 24 from `const productId = z` to

<!-- prettier-ignore -->
```ts
export const productId = z
```

(the rest of the declaration stays as it is).

- [ ] **Step 2: Write the failing tests**

Create `test/tools/publishing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TOOLS_BY_TOOLSET } from '../../src/tools/index.js';
import { notFoundBody } from '../fixtures/errors.js';
import { PRODUCT, lockedProduct } from '../fixtures/products.js';
import { CUSTOM_SHOP, DISCONNECTED_SHOP, SHOP, SHOPS } from '../fixtures/shops.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { json } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';

const SHOPS_PATH = '/v1/shops.json';
const ALL_SHOPS = [...SHOPS, CUSTOM_SHOP];

function productPath(shopId: number): string {
  return `/v1/shops/${String(shopId)}/products/${PRODUCT.id}.json`;
}

function actionPath(shopId: number, action: string): string {
  return `/v1/shops/${String(shopId)}/products/${PRODUCT.id}/${action}.json`;
}

/** The routes a publish on `shopId` needs: the shop list, the product and the publish endpoint. */
function publishRoutes(shopId: number, product: object = PRODUCT) {
  return {
    [`GET ${SHOPS_PATH}`]: ALL_SHOPS,
    [`GET ${productPath(shopId)}`]: product,
    [`POST ${actionPath(shopId, 'publish')}`]: {},
  };
}

const ALL_TRUE = {
  title: true,
  description: true,
  images: true,
  variants: true,
  tags: true,
  key_features: true,
  shipping_template: true,
};

describe('the publishing toolset', () => {
  it('registers four ungated write tools, in flow order', async () => {
    const { mcp } = await createTestServer();
    const { tools } = await mcp.listTools();
    const names = [
      'publish_product',
      'set_publishing_succeeded',
      'set_publishing_failed',
      'set_product_unpublished',
    ];
    expect(TOOLS_BY_TOOLSET.publishing.map((tool) => tool.name)).toEqual(names);
    for (const name of names) {
      expect(tools.find((tool) => tool.name === name)?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: name !== 'publish_product',
        openWorldHint: true,
      });
    }
  });
});

describe('publish_product', () => {
  it('on a connected shop, says Printify is publishing and names the channel', async () => {
    const { call, api } = await createTestServer({ routes: publishRoutes(SHOP.id) });
    const data = expectToolData(
      await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id }),
    );
    expect(data).toMatchObject({
      product_id: PRODUCT.id,
      title: PRODUCT.title,
      shop_id: SHOP.id,
      sales_channel: SHOP.sales_channel,
      shop_kind: 'connected',
      published: ALL_TRUE,
      locked: true,
    });
    expect(data['next_step']).toContain(`publishing the product to ${SHOP.sales_channel}`);
    expect(data['next_step']).toContain('get_product');
    expect(data['next_step']).not.toContain('set_publishing_succeeded');
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${SHOPS_PATH}`,
      `GET ${productPath(SHOP.id)}`,
      `POST ${actionPath(SHOP.id, 'publish')}`,
    ]);
  });

  it.each([DISCONNECTED_SHOP, CUSTOM_SHOP])(
    'on an API shop ($sales_channel), says the product is locked until the integration reports',
    async (apiShop) => {
      const { call } = await createTestServer({ routes: publishRoutes(apiShop.id) });
      const data = expectToolData(
        await call('publish_product', { shop_id: apiShop.id, product_id: PRODUCT.id }),
      );
      expect(data).toMatchObject({
        sales_channel: apiShop.sales_channel,
        shop_kind: 'api',
        locked: true,
      });
      expect(data['next_step']).toContain('set_publishing_succeeded');
      expect(data['next_step']).toContain('set_publishing_failed');
    },
  );

  it('sends every flag true by default, keyFeatures in camel case', async () => {
    const { call, api } = await createTestServer({ routes: publishRoutes(SHOP.id) });
    expectToolData(await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id }));
    expect(api.expectRequest('POST', actionPath(SHOP.id, 'publish')).body).toEqual({
      title: true,
      description: true,
      images: true,
      variants: true,
      tags: true,
      keyFeatures: true,
      shipping_template: true,
    });
  });

  it('sends a false flag as given, key_features as keyFeatures, and reports what it sent', async () => {
    const { call, api } = await createTestServer({ routes: publishRoutes(SHOP.id) });
    const data = expectToolData(
      await call('publish_product', {
        shop_id: SHOP.id,
        product_id: PRODUCT.id,
        tags: false,
        key_features: false,
      }),
    );
    expect(api.expectRequest('POST', actionPath(SHOP.id, 'publish')).body).toEqual({
      title: true,
      description: true,
      images: true,
      variants: true,
      tags: false,
      keyFeatures: false,
      shipping_template: true,
    });
    expect(data['published']).toEqual({ ...ALL_TRUE, tags: false, key_features: false });
  });

  it('fetches the shop list once per process', async () => {
    const { call, api } = await createTestServer({ routes: publishRoutes(SHOP.id) });
    const args = { shop_id: SHOP.id, product_id: PRODUCT.id };
    expectToolData(await call('publish_product', args));
    expectToolData(await call('publish_product', args));
    expect(api.requests.filter((request) => request.path === SHOPS_PATH)).toHaveLength(1);
  });

  it('refreshes the shop list once for an unknown shop_id, then covers both cases', async () => {
    const { call, api } = await createTestServer({ routes: publishRoutes(1111) });
    const data = expectToolData(
      await call('publish_product', { shop_id: 1111, product_id: PRODUCT.id }),
    );
    expect(data).toMatchObject({ shop_id: 1111, shop_kind: 'unknown', locked: true });
    expect(data).not.toHaveProperty('sales_channel');
    expect(data['next_step']).toContain('not in the account');
    expect(data['next_step']).toContain('set_publishing_succeeded');
    expect(api.requests.filter((request) => request.path === SHOPS_PATH)).toHaveLength(2);
    api.expectRequest('POST', actionPath(1111, 'publish'));
  });

  it('refuses a locked product before the POST, naming the unlock tools', async () => {
    const { call, api } = await createTestServer({
      routes: publishRoutes(DISCONNECTED_SHOP.id, lockedProduct()),
    });
    const error = expectToolError(
      await call('publish_product', { shop_id: DISCONNECTED_SHOP.id, product_id: PRODUCT.id }),
      { kind: 'tool' },
    );
    expect(error.message).toContain('is locked because it is being published');
    expect(error.hint).toContain('set_publishing_succeeded');
    expect(api.requests.map((request) => request.method)).toEqual(['GET', 'GET']);
  });

  it('uses the default shop when shop_id is left out', async () => {
    const { call, api } = await createTestServer({
      routes: { ...publishRoutes(SHOP.id), [`GET ${SHOPS_PATH}`]: [SHOP] },
    });
    const data = expectToolData(await call('publish_product', { product_id: PRODUCT.id }));
    expect(data).toMatchObject({ shop_id: SHOP.id, shop_kind: 'connected' });
    expect(api.requests.filter((request) => request.path === SHOPS_PATH)).toHaveLength(1);
  });

  it('classifies the shop when PRINTIFY_SHOP_ID is the default', async () => {
    const { call, api } = await createTestServer({
      env: { PRINTIFY_SHOP_ID: String(DISCONNECTED_SHOP.id) },
      routes: publishRoutes(DISCONNECTED_SHOP.id),
    });
    const data = expectToolData(await call('publish_product', { product_id: PRODUCT.id }));
    expect(data).toMatchObject({ shop_id: DISCONNECTED_SHOP.id, shop_kind: 'api' });
    expect(api.requests.filter((request) => request.path === SHOPS_PATH)).toHaveLength(1);
  });

  it('is unknown, without a refresh, for a listed shop that has no sales_channel', async () => {
    const { call, api } = await createTestServer({
      routes: { ...publishRoutes(SHOP.id), [`GET ${SHOPS_PATH}`]: [{ id: SHOP.id, title: 'x' }] },
    });
    const data = expectToolData(
      await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id }),
    );
    expect(data).toMatchObject({ shop_kind: 'unknown' });
    expect(data).not.toHaveProperty('sales_channel');
    expect(api.requests.filter((request) => request.path === SHOPS_PATH)).toHaveLength(1);
  });

  it('reports a product that is not found, without publishing', async () => {
    const { call, api } = await createTestServer({
      routes: {
        [`GET ${SHOPS_PATH}`]: ALL_SHOPS,
        [`GET ${productPath(SHOP.id)}`]: json(notFoundBody(), 404),
      },
    });
    const error = expectToolError(
      await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id }),
      { kind: 'http', status: 404 },
    );
    expect(error.hint).toContain('Check the id');
    expect(api.requests.map((request) => request.method)).toEqual(['GET', 'GET']);
  });

  it('reports a server error on the publish itself, with the retry hint', async () => {
    const { call } = await createTestServer({
      routes: {
        ...publishRoutes(SHOP.id),
        [`POST ${actionPath(SHOP.id, 'publish')}`]: json({ error: 'boom' }, 500),
      },
    });
    const error = expectToolError(
      await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id }),
      { kind: 'http', status: 500 },
    );
    expect(error.hint).toContain('Try again');
  });

  it('rejects an unknown argument and a bad product id before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(
      await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id, force: true }),
      { kind: 'validation' },
    );
    expectToolError(await call('publish_product', { shop_id: SHOP.id, product_id: '../x' }), {
      kind: 'validation',
    });
    expect(api.requests).toHaveLength(0);
  });
});

describe('set_publishing_succeeded', () => {
  const PATH = actionPath(SHOP.id, 'publishing_succeeded');
  const ARGS = {
    shop_id: SHOP.id,
    product_id: PRODUCT.id,
    external_id: '5941187eb8e7e37b3f0e62e5',
    handle: 'https://example.com/path/to/product',
  };

  it('sends the documented external object and reports the product unlocked', async () => {
    const { call, api } = await createTestServer({ routes: { [`POST ${PATH}`]: {} } });
    const data = expectToolData(await call('set_publishing_succeeded', ARGS));
    expect(api.expectRequest('POST', PATH).body).toEqual({
      external: { id: ARGS.external_id, handle: ARGS.handle },
    });
    expect(data).toEqual({
      product_id: PRODUCT.id,
      external: { id: ARGS.external_id, handle: ARGS.handle },
      locked: false,
    });
    expect(api.requests).toHaveLength(1);
  });

  it('needs both external_id and handle', async () => {
    const { call, api } = await createTestServer();
    const noHandle = { shop_id: SHOP.id, product_id: PRODUCT.id, external_id: ARGS.external_id };
    expectToolError(await call('set_publishing_succeeded', noHandle), { kind: 'validation' });
    expectToolError(await call('set_publishing_succeeded', { ...ARGS, external_id: '' }), {
      kind: 'validation',
    });
    expect(api.requests).toHaveLength(0);
  });
});

describe('set_publishing_failed', () => {
  const PATH = actionPath(SHOP.id, 'publishing_failed');

  it('sends the reason and reports the product unlocked', async () => {
    const { call, api } = await createTestServer({ routes: { [`POST ${PATH}`]: {} } });
    const data = expectToolData(
      await call('set_publishing_failed', {
        shop_id: SHOP.id,
        product_id: PRODUCT.id,
        reason: 'Request timed out',
      }),
    );
    expect(api.expectRequest('POST', PATH).body).toEqual({ reason: 'Request timed out' });
    expect(data).toEqual({ product_id: PRODUCT.id, reason: 'Request timed out', locked: false });
  });

  it('rejects an empty or missing reason before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(
      await call('set_publishing_failed', { shop_id: SHOP.id, product_id: PRODUCT.id, reason: '' }),
      { kind: 'validation' },
    );
    expectToolError(
      await call('set_publishing_failed', { shop_id: SHOP.id, product_id: PRODUCT.id }),
      { kind: 'validation' },
    );
    expect(api.requests).toHaveLength(0);
  });
});

describe('set_product_unpublished', () => {
  const PATH = actionPath(SHOP.id, 'unpublish');

  it('posts without a body and reports the product unpublished', async () => {
    const { call, api } = await createTestServer({ routes: { [`POST ${PATH}`]: {} } });
    const data = expectToolData(
      await call('set_product_unpublished', { shop_id: SHOP.id, product_id: PRODUCT.id }),
    );
    expect(api.expectRequest('POST', PATH).body).toBeUndefined();
    expect(data).toEqual({ product_id: PRODUCT.id, unpublished: true });
  });

  it('rejects an unknown argument before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(
      await call('set_product_unpublished', { shop_id: SHOP.id, product_id: PRODUCT.id, x: 1 }),
      { kind: 'validation' },
    );
    expect(api.requests).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/tools/publishing.test.ts`
Expected: FAIL, every test: `TOOLS_BY_TOOLSET.publishing` is empty and the server has no `publish_product`.

- [ ] **Step 4: Write the tools**

Create `src/tools/publishing.ts`:

```ts
import { z } from 'zod';
import { getProduct } from '../printify/products.js';
import {
  publishProduct,
  setProductUnpublished,
  setPublishingFailed,
  setPublishingSucceeded,
  type PublishFlags,
} from '../printify/publishing.js';
import { defineTool, type Tool, type ToolAnnotations } from './define.js';
import { assertUnlocked } from './product-update.js';
import { productId } from './products.js';
import { findShop, publishNextStep, shopKind } from './shop-kind.js';
import { resolveShopId, shopIdInput } from './shop-id.js';

/** The three notify tools: a repeat reports the same state again. */
const IDEMPOTENT_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

function flag(description: string): z.ZodDefault<z.ZodBoolean> {
  return z.boolean().default(true).describe(description);
}

export const publishProductTool = defineTool({
  name: 'publish_product',
  toolset: 'publishing',
  description:
    "Publishes a product to the shop's sales channel. On a shop connected to Shopify, Etsy or " +
    'another Printify integration, Printify creates or updates the listing and unlocks the ' +
    'product when the channel reports back. On an API shop it only locks the product and sends ' +
    'the product:publish:started event, and the integration must call set_publishing_succeeded ' +
    'or set_publishing_failed to unlock it; the result says which case applies and what to do ' +
    'next. Each flag set to false keeps that part of the listing as it is in the channel, e.g. ' +
    "tags: false keeps the channel's tags; key_features is sent as Printify's keyFeatures; " +
    'shipping_template matters on Etsy and Amazon only. A locked product is refused before ' +
    'anything is sent. If the call fails with a timeout, check is_locked with get_product ' +
    'before calling it again. Limited to 200 calls per 30 minutes.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: z.strictObject({
    ...shopIdInput,
    product_id: productId,
    title: flag('Publish the title. Default true.'),
    description: flag('Publish the description. Default true.'),
    images: flag(
      'Publish the mock-up images; false keeps the images the channel has. Default true.',
    ),
    variants: flag('Publish the variants. Default true.'),
    tags: flag("Publish the tags; false keeps the channel's tags. Default true."),
    key_features: flag('Publish the key features. Default true.'),
    shipping_template: flag('Publish the shipping template (Etsy and Amazon). Default true.'),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const shop = await findShop(ctx.shops, shopId, ctx.signal);
    const product = await getProduct(ctx.client, shopId, input.product_id, ctx.signal);
    assertUnlocked(product);
    const flags: PublishFlags = {
      title: input.title,
      description: input.description,
      images: input.images,
      variants: input.variants,
      tags: input.tags,
      keyFeatures: input.key_features,
      shipping_template: input.shipping_template,
    };
    await publishProduct(ctx.client, shopId, input.product_id, flags, ctx.signal);
    const kind = shopKind(shop);
    return {
      product_id: input.product_id,
      title: product.title,
      shop_id: shopId,
      sales_channel: shop?.sales_channel,
      shop_kind: kind,
      published: {
        title: input.title,
        description: input.description,
        images: input.images,
        variants: input.variants,
        tags: input.tags,
        key_features: input.key_features,
        shipping_template: input.shipping_template,
      },
      locked: true,
      next_step: publishNextStep(kind, shop?.sales_channel),
    };
  },
});

export const setPublishingSucceededTool = defineTool({
  name: 'set_publishing_succeeded',
  toolset: 'publishing',
  description:
    "Tells Printify that an API shop's integration published the product, which unlocks it and " +
    "records the listing's external id and handle (its URL or path in the sales channel). For " +
    'API shops; a connected shop reports this itself.',
  annotations: IDEMPOTENT_WRITE,
  input: z.strictObject({
    ...shopIdInput,
    product_id: productId,
    external_id: z.string().min(1).describe("The listing's id in the sales channel."),
    handle: z
      .string()
      .min(1)
      .describe("The listing's URL or path in the sales channel, e.g. /products/sunset-tee."),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const external = { id: input.external_id, handle: input.handle };
    await setPublishingSucceeded(ctx.client, shopId, input.product_id, external, ctx.signal);
    return { product_id: input.product_id, external, locked: false };
  },
});

export const setPublishingFailedTool = defineTool({
  name: 'set_publishing_failed',
  toolset: 'publishing',
  description:
    "Tells Printify that an API shop's integration could not publish the product, which unlocks " +
    'it; the reason is shown in the Printify app.',
  annotations: IDEMPOTENT_WRITE,
  input: z.strictObject({
    ...shopIdInput,
    product_id: productId,
    reason: z.string().min(1).describe('Why publishing failed, e.g. "Request timed out".'),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    await setPublishingFailed(ctx.client, shopId, input.product_id, input.reason, ctx.signal);
    return { product_id: input.product_id, reason: input.reason, locked: false };
  },
});

export const setProductUnpublishedTool = defineTool({
  name: 'set_product_unpublished',
  toolset: 'publishing',
  description:
    "Tells Printify that the product's listing was removed from the sales channel, so Printify " +
    'shows it as unpublished. It does not remove anything from a connected store; unpublish ' +
    'there in the channel itself.',
  annotations: IDEMPOTENT_WRITE,
  input: z.strictObject({ ...shopIdInput, product_id: productId }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    await setProductUnpublished(ctx.client, shopId, input.product_id, ctx.signal);
    return { product_id: input.product_id, unpublished: true };
  },
});

/** Every tool of the `publishing` toolset, in the order an API shop's flow calls them. */
export const publishingTools: readonly Tool[] = [
  publishProductTool,
  setPublishingSucceededTool,
  setPublishingFailedTool,
  setProductUnpublishedTool,
];
```

- [ ] **Step 5: Wire the toolset in**

In `src/tools/index.ts`, add the import after the `productsTools` one (imports stay alphabetical):

```ts
import { publishingTools } from './publishing.js';
```

and replace `publishing: [],` in `TOOLS_BY_TOOLSET` with

<!-- prettier-ignore -->
```ts
  publishing: publishingTools,
```

- [ ] **Step 6: Run the new tests, and see the workflows guard fail**

Run: `npx vitest run test/tools/publishing.test.ts test/tools/workflows.test.ts`
Expected: `publishing.test.ts` PASS, 21 tests. `workflows.test.ts` has one failure, "does not name publish_product in next_step, because no such tool exists yet": `ALL_TOOLS` now contains `publish_product`. That guard was written for this moment.

- [ ] **Step 7: Flip the guard and name the tool in next_step**

In `test/tools/workflows.test.ts`, replace the last test of the file,

<!-- prettier-ignore -->
```ts
  it('does not name publish_product in next_step, because no such tool exists yet', async () => {
    // The publishing toolset (#12) makes this fail on purpose: next_step should then name it.
    expect(ALL_TOOLS.map((tool) => tool.name)).not.toContain('publish_product');
    const { call } = await createTestServer({ routes: ROUTES });
    const data = expectToolData(await call(TOOL, RED_FRONT));
    expect(data['next_step']).not.toContain('publish_product');
  });
```

with

<!-- prettier-ignore -->
```ts
  it('names publish_product in next_step, which the publishing toolset provides', async () => {
    expect(ALL_TOOLS.map((tool) => tool.name)).toContain('publish_product');
    const { call } = await createTestServer({ routes: ROUTES });
    const data = expectToolData(await call(TOOL, RED_FRONT));
    expect(data['next_step']).toContain('publish_product');
  });
```

Run: `npx vitest run test/tools/workflows.test.ts`
Expected: that test FAILS on its last line: `next_step` does not contain `publish_product` yet.

In `src/tools/workflows.ts`, replace the `NEXT_STEP` constant with

```ts
const NEXT_STEP =
  'The product is an unpublished draft in the shop. Show the user the mockups and ask whether ' +
  'to change anything with update_product before it is published to the sales channel. When ' +
  'the user is happy, publish_product sends it to the sales channel.';
```

Run: `npx vitest run test/tools/workflows.test.ts`
Expected: PASS.

- [ ] **Step 8: Add the tools to the CI smoke step**

In `.github/workflows/ci.yml`, in the "Smoke-run the built server" step, the loop of tools that must be registered without a flag ends with `create_product_from_image; do`. Change that line so the loop reads (keep the 12-space indentation of the surrounding lines):

```text
            list_products get_product get_product_gpsr create_product update_product \
            create_product_from_image \
            publish_product set_publishing_succeeded set_publishing_failed \
            set_product_unpublished; do
```

Then run the smoke step locally against a fresh build:

```bash
npm run build
output=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | PRINTIFY_API_TOKEN=smoke-test-token timeout 10 node dist/index.js)
for tool in publish_product set_publishing_succeeded set_publishing_failed set_product_unpublished; do
  grep -q "\"name\":\"$tool\"" <<<"$output" && echo "$tool registered"
done
for tool in disconnect_shop archive_upload delete_product; do
  if grep -q "\"name\":\"$tool\"" <<<"$output"; then echo "$tool LEAKED"; fi
done
```

Expected: four "registered" lines and no "LEAKED" line. The server's stderr banner says `tools: 23 of 26`.

- [ ] **Step 9: Verify and commit**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all green, 777 tests.

```bash
git add src/tools/products.ts src/tools/publishing.ts src/tools/index.ts src/tools/workflows.ts \
  test/tools/workflows.test.ts test/tools/publishing.test.ts .github/workflows/ci.yml
git commit -m "Add the publishing toolset

publish_product looks the shop up, refuses a locked product, publishes
and says whether the product now waits for the user's own integration
or for Printify. The three notify tools report the result back.
create_product_from_image's next_step now names publish_product.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the last task

- `git log --format='%h %s | %(trailers:only,unfold)' origin/main..HEAD` shows four implementation commits after the spec and plan commits, each with the trailer above.
- Open the PR with a body starting `Closes #12`, then move the issue to In review with `~/.claude/skills/updating-github-project-status/board.sh review`.
- Hand-off comment on #15 (webhooks): the `product:publish:started` description can point at `set_publishing_succeeded` and `set_publishing_failed`.
- Open question for a later live check: `custom_integration` in `src/tools/shop-kind.ts` is an assumption; a read-only `list_shops` on an API shop confirms or corrects it.
