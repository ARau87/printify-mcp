# Products toolset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the six `products` tools — list, get, GPSR, create, update, delete — with compact responses, an update that merges partial variant changes into the complete list Printify needs, and a refusal for locked products before any write.

**Architecture:** Four new modules. `src/printify/products.ts` owns the API shape: the lenient product schema and six stateless requests, no MCP. `src/tools/product-summary.ts` and `src/tools/product-update.ts` are pure: the compact views, the variant merge and the locked check, each unit-tested on its own. `src/tools/products.ts` holds the input schemas and the six tool definitions, and its handlers do nothing but resolve the shop, call those modules and shape the result. A shared `src/printify/schema.ts` takes over the `lenient` helper from `uploads.ts`.

**Tech Stack:** TypeScript ~6.0 (NodeNext, `strict`, `noUncheckedIndexedAccess`), zod 4, MCP TypeScript SDK v2 (`@modelcontextprotocol/server`), vitest 5, Node >= 22.

**Spec:** `docs/superpowers/specs/2026-09-25-products-toolset-design.md`

## Global Constraints

- **Test-first.** Write the failing test, run it, watch it fail for the right reason, then implement.
- **Every commit message ends with this trailer, exactly, overriding any default attribution the implementer's harness adds:**
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Verification before any claim of success:** `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. `npm run lint` is `eslint . && prettier --check .`, so run `npx prettier --write src test docs .github` before committing.
- **Base branch:** `feat/11-products-toolset`, in the worktree `../printify-mcp-worktrees/11-products-toolset`. Run every command there. Never `git checkout` in the main checkout: other sessions may work there. Before every commit, `git symbolic-ref --short HEAD` must print `feat/11-products-toolset`.
- **Imports carry the `.js` extension** (`../printify/products.js`). NodeNext resolution requires it.
- **No new dependencies.**
- **Tool input schemas are plain `z.strictObject`s, nested objects included: no `.refine()`, no `.transform()`, no `.superRefine()`.** `toolProblems` in `src/tools/check.ts` runs `z.toJSONSchema(input, { io: 'input' })` over every tool input. Cross-field rules ("at least one field", "every variant needs a price with `replace_variants`") are `ToolError`s thrown in the handler. Chain `.optional()` before `.describe()`, as `shopIdInput` does.
- **Response schemas use `lenient()` from `src/printify/schema.ts`** (Task 1) for every field Printify may omit or send as `null`. In zod 4 a key declared without `.optional()` is required.
- **Tools return plain objects, never arrays.** The registry drops `null` and `undefined` properties. A tool that returns a typed interface value spreads it (`{ ...summarizeProduct(p) }`), because an interface is not assignable to `Record<string, unknown>`.
- **Interfaces declare function-typed properties, never methods.**
- **No `_`-prefixed escape for unused variables.** Write the code so nothing is unused; in particular, do not destructure `shop_id` out of an input just to drop it — pick the fields to send by name instead.
- **Never add a fake-API route key with a query string.** `createFakeApi` matches on the pathname only.
- **Routes must not answer 429 or 5xx** unless the test is about retries: the client retries those on real timers.
- **A body key that is absent and one that is `undefined` are different things** to `toHaveProperty`. When a test proves a key is absent, build the object without the key, and assert with `expect(x).not.toHaveProperty('k')`, never with `not.objectContaining({ k: expect.anything() })`.
- **Request assertions run after the awaited tool call.** `api.expectRequest` throws unless exactly one request matched, and the teardown fails on any request that matched no route, so every route a test provokes must be declared.
- **Commit messages are one imperative sentence** ("Add the products request layer"), no `feat:` prefix, as the branch history shows.

## Review Focus

Inputs the spec implies but its test list does not name. Each has its test in the task that owns the code.

1. A `product_id` like `../orders` or `abc/def` would reach `apiPath`, which throws a plain error that the registry reports as an internal bug. Expected: a validation error, no request. Pinned in Task 5 by a `product_id` regex.
2. `create_product` with `variants: []` or `print_areas: []` would send a body Printify rejects with a 400 the model cannot act on. Expected: a validation error before any request. Task 6.
3. `update_product` when the fetched product has a variant without a `price` cannot resend the list without losing that variant. Expected: an `invalid_response` error and no PUT. Task 7.
4. `update_product` with `variants: []` and the default merge would resend the whole current list unchanged, a pointless PUT that re-renders mock-ups. Expected: a validation error (`.min(1)`). Task 7.
5. `list_products` with one malformed item (no `id`) in the page. Expected: an `invalid_response` error for the page, not a row with a missing id, because every row's id is what the model acts on next. Task 2.

---

### Task 1: Move `lenient` into a shared schema module

**Files:**

- Create: `src/printify/schema.ts`
- Create: `test/printify/schema.test.ts`
- Modify: `src/printify/uploads.ts` (remove the local `lenient`, import it)

**Interfaces:**

- Consumes: `zod`.
- Produces: `lenient<T>(schema: z.ZodType<T>)` — a schema that yields `T | undefined`, turning `null` and a wrong-typed value into `undefined` and accepting a missing key. Used by Task 2.

- [ ] **Step 1: Write the failing test**

Create `test/printify/schema.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { lenient } from '../../src/printify/schema.js';

describe('lenient', () => {
  const schema = z.object({ width: lenient(z.number()) });

  it('keeps a value of the right type', () => {
    expect(schema.parse({ width: 400 })).toEqual({ width: 400 });
  });

  it('turns null into undefined', () => {
    expect(schema.parse({ width: null })).toEqual({});
  });

  it('turns a value of the wrong type into undefined', () => {
    expect(schema.parse({ width: 'wide' })).toEqual({});
  });

  it('accepts a missing key', () => {
    expect(schema.parse({})).toEqual({});
  });

  it('does not touch the schema around it', () => {
    expect(() => schema.parse('not an object')).toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/printify/schema.test.ts`
Expected: FAIL, "Failed to resolve import ../../src/printify/schema.js".

- [ ] **Step 3: Create the module and point uploads at it**

Create `src/printify/schema.ts`:

<!-- prettier-ignore -->
```ts
import type { z } from 'zod';

/** A field Printify may send as null, as the wrong type, or not at all. */
export function lenient<T>(schema: z.ZodType<T>) {
  return schema
    .nullable()
    .catch(null)
    .transform((value) => value ?? undefined)
    .optional();
}
```

In `src/printify/uploads.ts`, delete the local `lenient` function (the eight lines from `/** A field Printify may send as null` to its closing brace) and add the import after the `apiPath` import:

```ts
import { lenient } from './schema.js';
```

The `import { z } from 'zod'` at the top of `uploads.ts` stays: `uploadSchema` still uses it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/printify/schema.test.ts test/printify/uploads.test.ts`
Expected: PASS, both files.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck
git symbolic-ref --short HEAD   # must print feat/11-products-toolset
git add src/printify/schema.ts src/printify/uploads.ts test/printify/schema.test.ts
git commit -m "Share the lenient response-field helper

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The products request layer

**Files:**

- Create: `src/printify/products.ts`
- Modify: `test/fixtures/products.ts` (replace the whole file)
- Create: `test/printify/products.test.ts`
- Modify: `src/printify/errors.ts` (one literal added to the `problem` union in `invalidResponseError`)

**Interfaces:**

- Consumes: `PrintifyClient` from `src/printify/client.js`, `fetchPage` from `src/printify/pagination.js`, `apiPath` and `ApiPath` from `src/printify/path.js`, `invalidResponseError` and `Route` from `src/printify/errors.js`, `lenient` from Task 1.
- Produces, used by Tasks 3–8:
  - `type Product` — `{ id: string; variants: ProductVariant[]; title?: string; description?: string; safety_information?: string; tags?: string[]; blueprint_id?: number; print_provider_id?: number; shop_id?: number; visible?: boolean; is_locked?: boolean; is_printify_express_eligible?: boolean; is_printify_express_enabled?: boolean; is_economy_shipping_eligible?: boolean; is_economy_shipping_enabled?: boolean; external?: ExternalRef[]; images?: Mockup[]; print_areas?: PrintArea[]; created_at?: string; updated_at?: string; [key: string]: unknown }`
  - `type ProductVariant` — `{ id: number; price: number; title?: string; sku?: string; cost?: number; grams?: number; is_enabled?: boolean; is_default?: boolean; is_available?: boolean; is_printify_express_eligible?: boolean; options?: number[]; [key: string]: unknown }`
  - `type Mockup` — `{ src?: string; variant_ids?: number[]; position?: string; is_default?: boolean; [key: string]: unknown }`
  - `type ExternalRef` — `{ id?: string; handle?: string; shipping_template_id?: string; [key: string]: unknown }`
  - `type PrintArea` — `{ variant_ids?: number[]; placeholders?: { position?: string; images?: Record<string, unknown>[]; [key: string]: unknown }[]; [key: string]: unknown }`
  - `interface GpsrSection { title: string; text: string }`
  - `interface ProductPage { products: Product[]; page: number; hasMore: boolean; total: number | undefined; lastPage: number | undefined }`
  - `listProducts(client, shopId: number, options: { page?: number; limit?: number }, signal: AbortSignal): Promise<ProductPage>`
  - `getProduct(client, shopId: number, productId: string, signal): Promise<Product>`
  - `getProductGpsr(client, shopId: number, productId: string, signal): Promise<GpsrSection[]>`
  - `createProduct(client, shopId: number, body: unknown, signal): Promise<Product>`
  - `updateProduct(client, shopId: number, productId: string, body: unknown, signal): Promise<Product>`
  - `deleteProduct(client, shopId: number, productId: string, signal): Promise<void>`

- [ ] **Step 1: Write the fixtures**

Replace `test/fixtures/products.ts` with the following. Nothing imports the old `PRODUCT`, so its shape is free to change. The four variants let the update tests change two XL variants out of four; the `back` placeholder carries a text layer; `external` is `null` on purpose, as Printify sends it for a never-published product.

<!-- prettier-ignore -->
```ts
import { SHOP } from './shops.js';

const ART_IMAGE = {
  id: '5cb87a8cd490a2ccb256cec4',
  src: 'https://image-storage.example.com/art.png',
  name: 'art.png',
  type: 'image/png',
  height: 4000,
  width: 3000,
  x: 0.5,
  y: 0.5,
  scale: 1,
  angle: 0,
};

/** A text layer, which Printify documents as read-only: the font fields mark it. */
const TEXT_LAYER = {
  id: '5cb87a8cd490a2ccb256cec5',
  src: 'https://image-storage.example.com/text.png',
  name: 'text.png',
  type: 'image/png',
  height: 400,
  width: 1200,
  x: 0.5,
  y: 0.2,
  scale: 0.6,
  angle: 0,
  font_family: 'Arial',
  font_size: 48,
  font_color: '#000000',
  input_text: 'Hello',
};

/**
 * A product as `GET /v1/shops/{shop_id}/products/{product_id}.json` returns one. Four variants,
 * two of them XL, so a partial update of "all XL variants" changes two of four. `external` is
 * null on purpose: Printify sends null for a product that was never published.
 */
export const PRODUCT = {
  id: '5d39b159e7c48c000728c89f',
  title: 'Unisex Jersey Short Sleeve Tee',
  description: 'A soft cotton tee.',
  safety_information: 'GPSR information: John Doe, john@example.com, 123 Main St, New York, US',
  tags: ['T-shirt', 'Men'],
  options: [
    {
      name: 'Colors',
      type: 'color',
      values: [
        { id: 1, title: 'Black', colors: ['#000000'] },
        { id: 5, title: 'White', colors: ['#ffffff'] },
      ],
    },
    {
      name: 'Sizes',
      type: 'size',
      values: [
        { id: 2, title: 'S' },
        { id: 3, title: 'M' },
        { id: 4, title: 'XL' },
      ],
    },
  ],
  variants: [
    {
      id: 17887,
      sku: '19473',
      cost: 650,
      price: 1000,
      title: 'Black / S',
      grams: 180,
      is_enabled: true,
      is_default: true,
      is_available: true,
      is_printify_express_eligible: true,
      options: [1, 2],
    },
    {
      id: 17888,
      sku: '19474',
      cost: 650,
      price: 1000,
      title: 'Black / M',
      grams: 180,
      is_enabled: false,
      is_default: false,
      is_available: true,
      is_printify_express_eligible: true,
      options: [1, 3],
    },
    {
      id: 17889,
      sku: '19475',
      cost: 700,
      price: 1000,
      title: 'Black / XL',
      grams: 200,
      is_enabled: true,
      is_default: false,
      is_available: true,
      is_printify_express_eligible: true,
      options: [1, 4],
    },
    {
      id: 17890,
      sku: '19476',
      cost: 700,
      price: 1000,
      title: 'White / XL',
      grams: 200,
      is_enabled: true,
      is_default: false,
      is_available: false,
      is_printify_express_eligible: false,
      options: [5, 4],
    },
  ],
  images: [
    {
      src: 'https://images.printify.com/mockup/1.png',
      variant_ids: [17887, 17888, 17889],
      position: 'front',
      is_default: true,
    },
    {
      src: 'https://images.printify.com/mockup/2.png',
      variant_ids: [17887, 17888, 17889],
      position: 'back',
      is_default: false,
    },
    {
      src: 'https://images.printify.com/mockup/3.png',
      variant_ids: [17890],
      position: 'front',
      is_default: false,
    },
  ],
  created_at: '2019-07-25 13:40:41+00:00',
  updated_at: '2019-07-25 13:40:59+00:00',
  visible: true,
  is_locked: false,
  is_printify_express_eligible: true,
  is_printify_express_enabled: false,
  is_economy_shipping_eligible: false,
  is_economy_shipping_enabled: false,
  blueprint_id: 6,
  user_id: 1337,
  shop_id: SHOP.id,
  print_provider_id: 99,
  print_areas: [
    {
      variant_ids: [17887, 17888, 17889, 17890],
      placeholders: [
        { position: 'front', images: [ART_IMAGE] },
        { position: 'back', images: [TEXT_LAYER] },
      ],
      background: '#ffffff',
    },
  ],
  views: [
    {
      id: 34395,
      label: 'Front side',
      position: 'front',
      files: [{ src: 'https://images.printify.com/api/catalog/1.svg', variant_ids: [17887] }],
    },
  ],
  external: null,
  sales_channel_properties: [],
};

export function product(overrides: Partial<typeof PRODUCT> = {}): typeof PRODUCT {
  return { ...PRODUCT, ...overrides };
}

/** The same product while a sales channel publishes it. */
export function lockedProduct(): typeof PRODUCT {
  return product({ is_locked: true });
}

/** The documented `GET /v1/shops/{shop_id}/products.json` item, a single-variant mug. */
export const PRODUCT_MUG = {
  id: '5d39b159e7c48c000728c8a0',
  title: 'Mug 11oz',
  description:
    'Perfect for coffee, tea and hot chocolate, this classic shape white, durable ceramic mug in ' +
    'the most popular size.',
  safety_information:
    'GPSR information: John Doe, test@example.com, 123 Main St, Apt 1, New York, NY, 10001, US',
  tags: ['Home & Living', 'Mugs', '11 oz', 'White base', 'Sublimation'],
  options: [{ name: 'Sizes', type: 'size', values: [{ id: 1189, title: '11oz' }] }],
  variants: [
    {
      id: 33719,
      sku: '866366009',
      cost: 516,
      price: 860,
      title: '11oz',
      grams: 460,
      is_enabled: true,
      is_default: true,
      is_available: true,
      is_printify_express_eligible: true,
      options: [1189],
    },
  ],
  images: [
    {
      src: 'https://images.printify.com/mockup/5d39b159e7c48c000728c89f/33719/145/mug-11oz.jpg',
      variant_ids: [33719],
      position: 'front',
      is_default: false,
    },
    {
      src: 'https://images.printify.com/mockup/5d39b159e7c48c000728c89f/33719/147/mug-11oz.jpg',
      variant_ids: [33719],
      position: 'other',
      is_default: true,
    },
  ],
  created_at: '2019-07-25 13:40:41+00:00',
  updated_at: '2019-07-25 13:40:59+00:00',
  visible: true,
  is_locked: false,
  is_printify_express_eligible: true,
  is_printify_express_enabled: true,
  is_economy_shipping_eligible: true,
  is_economy_shipping_enabled: true,
  blueprint_id: 68,
  user_id: 1337,
  shop_id: 1337,
  print_provider_id: 9,
  print_areas: [
    {
      variant_ids: [33719],
      placeholders: [
        {
          position: 'front',
          images: [
            {
              id: '5c7665205342af161e1cb26e',
              src: 'https://image-storage.example.com/5d39b159e7c48c000728c89f',
              name: 'Test.png',
              type: 'image/png',
              height: 5850,
              width: 4350,
              x: 0.5,
              y: 0.5,
              scale: 1.01,
              angle: 0,
            },
          ],
        },
      ],
      background: '#ffffff',
    },
  ],
  views: [
    {
      id: 34395,
      label: 'Front side',
      position: 'front',
      files: [
        {
          src: 'https://images.printify.com/api/catalog/618e1792f80e2001a840687b.svg',
          variant_ids: [33719],
        },
      ],
    },
  ],
  sales_channel_properties: [],
};

/** The documented paginated envelope, around `items`. */
export function productsPage(
  items: readonly object[] = [PRODUCT],
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

/** The documented `GET …/gpsr.json` response. */
export const GPSR_SECTIONS = [
  { title: 'GPSR information', text: 'John Doe, test@example.com, 123 Main St, New York, US' },
  { title: 'Product information', text: 'Gildan, 5000, 2 year warranty in EU and UK' },
  { title: 'Warnings, Hazzard', text: 'No warranty, US' },
  { title: 'Care instructions', text: 'Machine wash: warm (max 40C or 105F), Do not iron' },
];
```

- [ ] **Step 2: Write the failing test**

Create `test/printify/products.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from 'vitest';
import { createPrintifyClient, type PrintifyClient } from '../../src/printify/client.js';
import {
  createProduct,
  deleteProduct,
  getProduct,
  getProductGpsr,
  listProducts,
  updateProduct,
} from '../../src/printify/products.js';
import { Secret } from '../../src/secret.js';
import { GPSR_SECTIONS, PRODUCT, PRODUCT_MUG, product, productsPage } from '../fixtures/products.js';
import { SHOP } from '../fixtures/shops.js';
import { createFakeApi, json, text, type FakeApi, type Routes } from '../support/fake-api.js';
import { apiError } from './helpers.js';

const TOKEN = 'Tok-products-3C4d5E6f';
const SHOP_ID = SHOP.id;
const PRODUCTS_PATH = `/v1/shops/${String(SHOP_ID)}/products.json`;
const PRODUCT_PATH = `/v1/shops/${String(SHOP_ID)}/products/${PRODUCT.id}.json`;
const GPSR_PATH = `/v1/shops/${String(SHOP_ID)}/products/${PRODUCT.id}/gpsr.json`;
const CREATE_BODY = {
  title: 'Product',
  description: 'Good product',
  blueprint_id: 384,
  print_provider_id: 1,
  variants: [{ id: 45740, price: 400, is_enabled: true }],
  print_areas: [
    {
      variant_ids: [45740],
      placeholders: [{ position: 'front', images: [{ id: 'img', x: 0.5, y: 0.5, scale: 1, angle: 0 }] }],
    },
  ],
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

describe('getProduct', () => {
  it('gets one product, keeping the keys the summary drops', async () => {
    const { client, api } = testClient({ [`GET ${PRODUCT_PATH}`]: PRODUCT_MUG });
    // The route is keyed on PRODUCT.id; the body is the documented mug.
    const got = await getProduct(client, SHOP_ID, PRODUCT.id, live());
    expect(got).toMatchObject({
      id: PRODUCT_MUG.id,
      title: 'Mug 11oz',
      variants: PRODUCT_MUG.variants,
      views: PRODUCT_MUG.views,
      options: PRODUCT_MUG.options,
      sales_channel_properties: [],
    });
    api.expectRequest('GET', PRODUCT_PATH);
  });

  it('turns a null external and a wrong-typed tags into undefined', async () => {
    const { client } = testClient({
      [`GET ${PRODUCT_PATH}`]: product({ external: null, tags: 'not a list' as unknown as string[] }),
    });
    const got = await getProduct(client, SHOP_ID, PRODUCT.id, live());
    expect(got).not.toHaveProperty('external');
    expect(got).not.toHaveProperty('tags');
    expect(got.title).toBe(PRODUCT.title);
  });

  it('reports a body without an id', async () => {
    const { client } = testClient({ [`GET ${PRODUCT_PATH}`]: { title: 'no id', variants: [] } });
    const error = await apiError(getProduct(client, SHOP_ID, PRODUCT.id, live()));
    expect(error.kind).toBe('invalid_response');
    expect(error.message).toContain('an unexpected product response');
  });

  it('reports a variant without an id or a price, and a variants that is not a list', async () => {
    const withoutPrice = { ...PRODUCT, variants: [{ id: 1, title: 'no price' }] };
    const notAList = { ...PRODUCT, variants: 'none' };
    for (const body of [withoutPrice, notAList]) {
      const { client } = testClient({ [`GET ${PRODUCT_PATH}`]: body });
      const error = await apiError(getProduct(client, SHOP_ID, PRODUCT.id, live()));
      expect(error.kind).toBe('invalid_response');
    }
  });
});

describe('getProductGpsr', () => {
  it('gets the sections', async () => {
    const { client, api } = testClient({ [`GET ${GPSR_PATH}`]: GPSR_SECTIONS });
    expect(await getProductGpsr(client, SHOP_ID, PRODUCT.id, live())).toEqual(GPSR_SECTIONS);
    api.expectRequest('GET', GPSR_PATH);
  });

  it('reports an object instead of a list', async () => {
    const { client } = testClient({ [`GET ${GPSR_PATH}`]: { title: 'x', text: 'y' } });
    const error = await apiError(getProductGpsr(client, SHOP_ID, PRODUCT.id, live()));
    expect(error.kind).toBe('invalid_response');
  });
});

describe('createProduct', () => {
  it('posts the body unchanged and returns the product', async () => {
    const { client, api } = testClient({ [`POST ${PRODUCTS_PATH}`]: PRODUCT });
    const created = await createProduct(client, SHOP_ID, CREATE_BODY, live());
    expect(created.id).toBe(PRODUCT.id);
    expect(api.expectRequest('POST', PRODUCTS_PATH).body).toEqual(CREATE_BODY);
  });
});

describe('updateProduct', () => {
  it('puts the body unchanged and returns the product', async () => {
    const { client, api } = testClient({ [`PUT ${PRODUCT_PATH}`]: product({ title: 'Renamed' }) });
    const updated = await updateProduct(client, SHOP_ID, PRODUCT.id, { title: 'Renamed' }, live());
    expect(updated.title).toBe('Renamed');
    expect(api.expectRequest('PUT', PRODUCT_PATH).body).toEqual({ title: 'Renamed' });
  });
});

describe('deleteProduct', () => {
  it('sends DELETE and accepts the documented empty object', async () => {
    const { client, api } = testClient({ [`DELETE ${PRODUCT_PATH}`]: json({}) });
    await expect(deleteProduct(client, SHOP_ID, PRODUCT.id, live())).resolves.toBeUndefined();
    api.expectRequest('DELETE', PRODUCT_PATH);
  });

  it('accepts a wholly empty body', async () => {
    const { client } = testClient({ [`DELETE ${PRODUCT_PATH}`]: text('', 200) });
    await expect(deleteProduct(client, SHOP_ID, PRODUCT.id, live())).resolves.toBeUndefined();
  });
});

describe('listProducts', () => {
  it('returns the page and its products', async () => {
    const { client, api } = testClient({ [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT]) });
    const page = await listProducts(client, SHOP_ID, { page: 1, limit: 10 }, live());
    expect(page).toMatchObject({ page: 1, hasMore: false, total: 1, lastPage: 1 });
    expect(page.products.map((item) => item.id)).toEqual([PRODUCT.id]);
    expect(api.expectRequest('GET', PRODUCTS_PATH).query).toEqual({ page: '1', limit: '10' });
  });

  it('reports more pages to come', async () => {
    const { client } = testClient({
      [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT], { last_page: 3, total: 22 }),
    });
    expect(await listProducts(client, SHOP_ID, {}, live())).toMatchObject({
      hasMore: true,
      lastPage: 3,
      total: 22,
    });
  });

  it('lowers a limit above the documented maximum of 50', async () => {
    const { client, api } = testClient({ [`GET ${PRODUCTS_PATH}`]: productsPage() });
    await listProducts(client, SHOP_ID, { limit: 500 }, live());
    expect(api.expectRequest('GET', PRODUCTS_PATH).query).toEqual({ limit: '50' });
  });

  it('reports a page with an item that is not a product', async () => {
    const { client } = testClient({
      [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT, { title: 'no id', variants: [] }]),
    });
    const error = await apiError(listProducts(client, SHOP_ID, {}, live()));
    expect(error.kind).toBe('invalid_response');
    expect(error.message).toContain('an unexpected product response');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/printify/products.test.ts`
Expected: FAIL, "Failed to resolve import ../../src/printify/products.js".

- [ ] **Step 4: Add the error literal**

In `src/printify/errors.ts`, extend the `problem` union of `invalidResponseError`:

<!-- prettier-ignore -->
```ts
  problem:
    | 'a body that is not JSON'
    | 'an unexpected pagination envelope'
    | 'an unexpected shop list'
    | 'an unexpected catalog response'
    | 'an unexpected uploads response'
    | 'an unexpected product response',
```

- [ ] **Step 5: Write the module**

Create `src/printify/products.ts`:

<!-- prettier-ignore -->
```ts
import { z } from 'zod';
import type { PrintifyClient } from './client.js';
import { invalidResponseError, type Route } from './errors.js';
import { fetchPage } from './pagination.js';
import { apiPath, type ApiPath } from './path.js';
import { lenient } from './schema.js';

// Every object is loose, so `detail: "full"` can return what Printify sent, keys this server does
// not know included. Only `id` and each variant's `id` and `price` are required: an update is
// built on the fetched variant list, and a variant that cannot be resent would be removed by it.
const variantSchema = z.looseObject({
  id: z.number().int(),
  price: z.number(),
  title: lenient(z.string()),
  sku: lenient(z.string()),
  cost: lenient(z.number()),
  grams: lenient(z.number()),
  is_enabled: lenient(z.boolean()),
  is_default: lenient(z.boolean()),
  is_available: lenient(z.boolean()),
  is_printify_express_eligible: lenient(z.boolean()),
  options: lenient(z.array(z.number())),
});

const mockupSchema = z.looseObject({
  src: lenient(z.string()),
  variant_ids: lenient(z.array(z.number())),
  position: lenient(z.string()),
  is_default: lenient(z.boolean()),
});

const placeholderSchema = z.looseObject({
  position: lenient(z.string()),
  images: lenient(z.array(z.looseObject({}))),
});

const printAreaSchema = z.looseObject({
  variant_ids: lenient(z.array(z.number())),
  placeholders: lenient(z.array(placeholderSchema)),
});

const externalSchema = z.looseObject({
  id: lenient(z.string()),
  handle: lenient(z.string()),
  shipping_template_id: lenient(z.string()),
});

const productSchema = z.looseObject({
  id: z.string().min(1),
  title: lenient(z.string()),
  description: lenient(z.string()),
  safety_information: lenient(z.string()),
  tags: lenient(z.array(z.string())),
  blueprint_id: lenient(z.number().int()),
  print_provider_id: lenient(z.number().int()),
  shop_id: lenient(z.number().int()),
  visible: lenient(z.boolean()),
  is_locked: lenient(z.boolean()),
  is_printify_express_eligible: lenient(z.boolean()),
  is_printify_express_enabled: lenient(z.boolean()),
  is_economy_shipping_eligible: lenient(z.boolean()),
  is_economy_shipping_enabled: lenient(z.boolean()),
  external: lenient(z.array(externalSchema)),
  variants: z.array(variantSchema),
  images: lenient(z.array(mockupSchema)),
  print_areas: lenient(z.array(printAreaSchema)),
  created_at: lenient(z.string()),
  updated_at: lenient(z.string()),
});

const gpsrSchema = z.array(z.object({ title: z.string(), text: z.string() }));

/** A product as Printify returns it, with every key it sent. */
export type Product = z.infer<typeof productSchema>;
export type ProductVariant = z.infer<typeof variantSchema>;
export type Mockup = z.infer<typeof mockupSchema>;
export type PrintArea = z.infer<typeof printAreaSchema>;
export type ExternalRef = z.infer<typeof externalSchema>;
/** One section of a product's GPSR information. */
export type GpsrSection = z.infer<typeof gpsrSchema>[number];

export interface ProductPage {
  products: Product[];
  page: number;
  hasMore: boolean;
  total: number | undefined;
  lastPage: number | undefined;
}

function productsPath(shopId: number): ApiPath {
  return apiPath`/v1/shops/${shopId}/products.json`;
}

function productPath(shopId: number, productId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/products/${productId}.json`;
}

/** One page of a shop's products. A `limit` above 50 is lowered by `fetchPage`. */
export async function listProducts(
  client: PrintifyClient,
  shopId: number,
  options: { page?: number; limit?: number },
  signal: AbortSignal,
): Promise<ProductPage> {
  const path = productsPath(shopId);
  const page = await fetchPage(client, 'products', path, { ...options, signal });
  const route: Route = { method: 'GET', path };
  return {
    products: page.items.map((item) => parseProduct(item, route)),
    page: page.page,
    hasMore: page.hasMore,
    total: page.total,
    lastPage: page.lastPage,
  };
}

export async function getProduct(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  signal: AbortSignal,
): Promise<Product> {
  const path = productPath(shopId, productId);
  const body = await client.request('GET', path, { signal });
  return parseProduct(body, { method: 'GET', path });
}

export async function getProductGpsr(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  signal: AbortSignal,
): Promise<GpsrSection[]> {
  const path = apiPath`/v1/shops/${shopId}/products/${productId}/gpsr.json`;
  const body = await client.request('GET', path, { signal });
  const parsed = gpsrSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidResponseError({ method: 'GET', path }, 200, 'an unexpected product response');
  }
  return parsed.data;
}

/** Creates a product. `body` is the tool's validated input, sent as is. */
export async function createProduct(
  client: PrintifyClient,
  shopId: number,
  body: unknown,
  signal: AbortSignal,
): Promise<Product> {
  const path = productsPath(shopId);
  const response = await client.request('POST', path, { body, signal });
  return parseProduct(response, { method: 'POST', path });
}

/** Updates a product. `body` carries only the fields to change; `variants`, if present, complete. */
export async function updateProduct(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Product> {
  const path = productPath(shopId, productId);
  const response = await client.request('PUT', path, { body, signal });
  return parseProduct(response, { method: 'PUT', path });
}

/** Deletes a product. Printify answers `{}`, so no response is read. */
export async function deleteProduct(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  signal: AbortSignal,
): Promise<void> {
  await client.request('DELETE', productPath(shopId, productId), { signal });
}

function parseProduct(body: unknown, route: Route): Product {
  const parsed = productSchema.safeParse(body);
  if (!parsed.success) throw invalidResponseError(route, 200, 'an unexpected product response');
  return parsed.data;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/printify/products.test.ts`
Expected: PASS, 14 tests.

If `expect(got).not.toHaveProperty('external')` fails because the key is present with `undefined`: zod 4 keeps an optional key absent when the input lacks it, but a `null` input goes through `.catch(null).transform(...)` and may leave `external: undefined` on the object. In that case change both `not.toHaveProperty` assertions in that test to `expect(got.external).toBeUndefined()` and `expect(got.tags).toBeUndefined()`; the registry's `dropNulls` removes an `undefined` key before the model sees it either way.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck
git symbolic-ref --short HEAD
git add src/printify/products.ts src/printify/errors.ts test/fixtures/products.ts test/printify/products.test.ts
git commit -m "Add the products request layer

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The compact product views

**Files:**

- Create: `src/tools/product-summary.ts`
- Create: `test/tools/product-summary.test.ts`

**Interfaces:**

- Consumes: `Product`, `ProductVariant`, `Mockup`, `PrintArea` from Task 2; `omitKeys` from `src/tools/shape.js`.
- Produces, used by Tasks 5–7:
  - `interface VariantRow { id: number; title: string | undefined; sku: string | undefined; price: number; cost: number | undefined; is_enabled: boolean | undefined; is_default: boolean | undefined; is_available: boolean | undefined }`
  - `interface ProductRow { id: string; title: string | undefined; blueprint_id: number | undefined; print_provider_id: number | undefined; visible: boolean | undefined; is_locked: boolean | undefined; variant_count: number; enabled_variant_count: number; external: { id: string | undefined; handle: string | undefined }[] | undefined; updated_at: string | undefined }`
  - `interface ProductSummary extends ProductRow { description; safety_information; tags; is_printify_express_eligible; is_printify_express_enabled; is_economy_shipping_eligible; is_economy_shipping_enabled; created_at (each `T | undefined`); variants: VariantRow[]; print_areas: PrintArea[] | undefined; mockups: Mockup[] | undefined; mockup_count: number | undefined }`
  - `productRow(product: Product): ProductRow`
  - `summarizeProduct(product: Product): ProductSummary`

- [ ] **Step 1: Write the failing test**

Create `test/tools/product-summary.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from 'vitest';
import type { Product } from '../../src/printify/products.js';
import { productRow, summarizeProduct } from '../../src/tools/product-summary.js';

const ART = {
  id: 'img-1',
  src: 'https://image-storage.example.com/art.png',
  name: 'art.png',
  type: 'image/png',
  width: 3000,
  height: 4000,
  x: 0.5,
  y: 0.5,
  scale: 1,
  angle: 0,
};

const TEXT_LAYER = {
  id: 'img-2',
  src: 'https://image-storage.example.com/text.png',
  type: 'image/png',
  x: 0.5,
  y: 0.2,
  scale: 0.6,
  angle: 0,
  font_family: 'Arial',
  input_text: 'Hello',
};

/** A product with the fields the views read; a test overrides only what it varies. */
function aProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    title: 'Tee',
    description: 'Soft.',
    tags: ['a'],
    blueprint_id: 6,
    print_provider_id: 99,
    visible: true,
    is_locked: false,
    is_printify_express_enabled: false,
    external: [{ id: 'ext-1', handle: '/products/tee', shipping_template_id: 'tpl-1' }],
    variants: [
      { id: 1, price: 1000, title: 'S', sku: 'S-1', cost: 650, is_enabled: true, is_default: true, is_available: true, grams: 180 },
      { id: 2, price: 1000, title: 'M', sku: 'M-1', cost: 650, is_enabled: false, is_default: false, is_available: false, grams: 180 },
    ],
    images: [
      { src: 'https://images.example.com/1.png', variant_ids: [1, 2], position: 'front', is_default: true },
      { src: 'https://images.example.com/2.png', variant_ids: [1, 2], position: 'back', is_default: false },
    ],
    print_areas: [
      {
        variant_ids: [1, 2],
        placeholders: [
          { position: 'front', images: [ART] },
          { position: 'back', images: [TEXT_LAYER] },
        ],
        background: '#ffffff',
      },
    ],
    views: [{ id: 1, label: 'Front', position: 'front', files: [] }],
    options: [{ name: 'Sizes', type: 'size', values: [] }],
    created_at: '2019-07-25 13:40:41+00:00',
    updated_at: '2019-07-25 13:40:59+00:00',
    ...overrides,
  };
}

describe('productRow', () => {
  it('summarises a product to its list row', () => {
    expect(productRow(aProduct())).toEqual({
      id: 'p1',
      title: 'Tee',
      blueprint_id: 6,
      print_provider_id: 99,
      visible: true,
      is_locked: false,
      variant_count: 2,
      enabled_variant_count: 1,
      external: [{ id: 'ext-1', handle: '/products/tee' }],
      updated_at: '2019-07-25 13:40:59+00:00',
    });
  });

  it('counts a variant without is_enabled as not enabled', () => {
    const row = productRow(aProduct({ variants: [{ id: 1, price: 1 }, { id: 2, price: 1, is_enabled: true }] }));
    expect(row).toMatchObject({ variant_count: 2, enabled_variant_count: 1 });
  });

  it('leaves external out when the product has none', () => {
    const row = productRow(aProduct({ external: undefined }));
    expect(row.external).toBeUndefined();
  });
});

describe('summarizeProduct', () => {
  it('keeps the scalar fields and the counts', () => {
    expect(summarizeProduct(aProduct())).toMatchObject({
      id: 'p1',
      title: 'Tee',
      description: 'Soft.',
      tags: ['a'],
      is_printify_express_enabled: false,
      variant_count: 2,
      enabled_variant_count: 1,
      created_at: '2019-07-25 13:40:41+00:00',
    });
  });

  it('lists every variant as a compact row', () => {
    expect(summarizeProduct(aProduct()).variants).toEqual([
      { id: 1, title: 'S', sku: 'S-1', price: 1000, cost: 650, is_enabled: true, is_default: true, is_available: true },
      { id: 2, title: 'M', sku: 'M-1', price: 1000, cost: 650, is_enabled: false, is_default: false, is_available: false },
    ]);
  });

  it('strips src and type from print-area images and keeps a text layer', () => {
    const [area] = summarizeProduct(aProduct()).print_areas ?? [];
    expect(area).toMatchObject({ variant_ids: [1, 2], background: '#ffffff' });
    const [front, back] = area?.placeholders ?? [];
    const [art] = front?.images ?? [];
    expect(art).toEqual({ id: 'img-1', name: 'art.png', width: 3000, height: 4000, x: 0.5, y: 0.5, scale: 1, angle: 0 });
    const [textLayer] = back?.images ?? [];
    expect(textLayer).toMatchObject({ font_family: 'Arial', input_text: 'Hello' });
    expect(textLayer).not.toHaveProperty('src');
  });

  it('returns the default mock-ups with the total count', () => {
    const summary = summarizeProduct(aProduct());
    expect(summary.mockups).toEqual([
      { src: 'https://images.example.com/1.png', variant_ids: [1, 2], position: 'front', is_default: true },
    ]);
    expect(summary.mockup_count).toBe(2);
  });

  it('copies neither views nor options', () => {
    const summary = summarizeProduct(aProduct());
    expect(summary).not.toHaveProperty('views');
    expect(summary).not.toHaveProperty('options');
  });

  it('summarises a product with no images and no print areas', () => {
    const summary = summarizeProduct(aProduct({ images: undefined, print_areas: undefined }));
    expect(summary.mockups).toBeUndefined();
    expect(summary.mockup_count).toBeUndefined();
    expect(summary.print_areas).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/tools/product-summary.test.ts`
Expected: FAIL, "Failed to resolve import ../../src/tools/product-summary.js".

- [ ] **Step 3: Write the module**

Create `src/tools/product-summary.ts`:

<!-- prettier-ignore -->
```ts
import type { Mockup, PrintArea, Product, ProductVariant } from '../printify/products.js';
import { omitKeys } from './shape.js';

/** A variant as the summary lists it: the fields a price change or a stock question needs. */
export interface VariantRow {
  id: number;
  title: string | undefined;
  sku: string | undefined;
  price: number;
  cost: number | undefined;
  is_enabled: boolean | undefined;
  is_default: boolean | undefined;
  is_available: boolean | undefined;
}

/** One row of `list_products`. */
export interface ProductRow {
  id: string;
  title: string | undefined;
  blueprint_id: number | undefined;
  print_provider_id: number | undefined;
  visible: boolean | undefined;
  is_locked: boolean | undefined;
  variant_count: number;
  enabled_variant_count: number;
  external: { id: string | undefined; handle: string | undefined }[] | undefined;
  updated_at: string | undefined;
}

/** `get_product`'s default view, and what `create_product` and `update_product` return. */
export interface ProductSummary extends ProductRow {
  description: string | undefined;
  safety_information: string | undefined;
  tags: string[] | undefined;
  is_printify_express_eligible: boolean | undefined;
  is_printify_express_enabled: boolean | undefined;
  is_economy_shipping_eligible: boolean | undefined;
  is_economy_shipping_enabled: boolean | undefined;
  created_at: string | undefined;
  variants: VariantRow[];
  /** As Printify sent them, minus each image's `src` and `type`. */
  print_areas: PrintArea[] | undefined;
  /** The `is_default` mock-ups: the title images. */
  mockups: Mockup[] | undefined;
  mockup_count: number | undefined;
}

export function productRow(product: Product): ProductRow {
  return {
    id: product.id,
    title: product.title,
    blueprint_id: product.blueprint_id,
    print_provider_id: product.print_provider_id,
    visible: product.visible,
    is_locked: product.is_locked,
    variant_count: product.variants.length,
    enabled_variant_count: product.variants.filter((variant) => variant.is_enabled === true).length,
    external: product.external?.map(({ id, handle }) => ({ id, handle })),
    updated_at: product.updated_at,
  };
}

export function summarizeProduct(product: Product): ProductSummary {
  return {
    ...productRow(product),
    description: product.description,
    safety_information: product.safety_information,
    tags: product.tags,
    is_printify_express_eligible: product.is_printify_express_eligible,
    is_printify_express_enabled: product.is_printify_express_enabled,
    is_economy_shipping_eligible: product.is_economy_shipping_eligible,
    is_economy_shipping_enabled: product.is_economy_shipping_enabled,
    created_at: product.created_at,
    variants: product.variants.map(variantRow),
    print_areas: product.print_areas?.map(trimPrintArea),
    mockups: product.images?.filter((mockup) => mockup.is_default === true),
    mockup_count: product.images?.length,
  };
}

function variantRow(variant: ProductVariant): VariantRow {
  return {
    id: variant.id,
    title: variant.title,
    sku: variant.sku,
    price: variant.price,
    cost: variant.cost,
    is_enabled: variant.is_enabled,
    is_default: variant.is_default,
    is_available: variant.is_available,
  };
}

/** The print area as sent, with each image's `src` and `type` removed; a text layer keeps its fields. */
function trimPrintArea(area: PrintArea): PrintArea {
  return {
    ...area,
    placeholders: area.placeholders?.map((placeholder) => ({
      ...placeholder,
      images: placeholder.images?.map((image) => omitKeys(image, ['src', 'type'])),
    })),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/product-summary.test.ts`
Expected: PASS, 9 tests.

If the `aProduct` literal does not typecheck against `Product` (for example because `z.infer` of a loose object with transformed fields is narrower than expected), do not change the exported type; cast in this one test helper instead, `return { …, ...overrides } as Product;`, with a comment saying the assertions check the literal's shape.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck
git symbolic-ref --short HEAD
git add src/tools/product-summary.ts test/tools/product-summary.test.ts
git commit -m "Add the compact product views

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The variant merge and the locked check

**Files:**

- Create: `src/tools/product-update.ts`
- Create: `test/tools/product-update.test.ts`

**Interfaces:**

- Consumes: `Product`, `ProductVariant` from Task 2; `ToolError` from `src/tools/define.js`.
- Produces, used by Task 7:
  - `interface VariantPatch { id: number; price?: number | undefined; is_enabled?: boolean | undefined; is_default?: boolean | undefined; sku?: string | undefined }`
  - `interface VariantBody { id: number; price: number; is_enabled?: boolean; is_default?: boolean; sku?: string }`
  - `type MergeResult = { ok: true; variants: VariantBody[] } | { ok: false; unknownIds: number[] }`
  - `mergeVariants(current: readonly ProductVariant[], patches: readonly VariantPatch[]): MergeResult`
  - `assertUnlocked(product: Product): void` — throws a `ToolError`
  - `LOCKED_HINT: string`

- [ ] **Step 1: Write the failing test**

Create `test/tools/product-update.test.ts`:

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from 'vitest';
import type { Product, ProductVariant } from '../../src/printify/products.js';
import { ToolError } from '../../src/tools/define.js';
import { assertUnlocked, LOCKED_HINT, mergeVariants } from '../../src/tools/product-update.js';

/** A full variant as Printify returns one; a test overrides only what it varies. */
function variant(overrides: Partial<ProductVariant> & { id: number }): ProductVariant {
  return { price: 1000, is_enabled: true, is_default: false, sku: `SKU-${String(overrides.id)}`, ...overrides };
}

const CURRENT = [
  variant({ id: 1, is_default: true }),
  variant({ id: 2, is_enabled: false }),
  variant({ id: 3 }),
];

function merged(patches: Parameters<typeof mergeVariants>[1]) {
  const result = mergeVariants(CURRENT, patches);
  if (!result.ok) throw new Error(`expected a merged list, got unknown ids ${String(result.unknownIds)}`);
  return result.variants;
}

describe('mergeVariants', () => {
  it('changes one price and keeps every other variant, in the original order', () => {
    expect(merged([{ id: 3, price: 2499 }])).toEqual([
      { id: 1, price: 1000, is_enabled: true, is_default: true, sku: 'SKU-1' },
      { id: 2, price: 1000, is_enabled: false, is_default: false, sku: 'SKU-2' },
      { id: 3, price: 2499, is_enabled: true, is_default: false, sku: 'SKU-3' },
    ]);
  });

  it('keeps the current price when the patch has none, and sets a sku', () => {
    const [, , third] = merged([{ id: 3, sku: 'NEW' }]);
    expect(third).toEqual({ id: 3, price: 1000, is_enabled: true, is_default: false, sku: 'NEW' });
  });

  it('unsets the old default when a patch sets a new one', () => {
    expect(merged([{ id: 3, is_default: true }]).map((body) => body.is_default)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('keeps the current defaults when no patch sets one', () => {
    expect(merged([{ id: 2, is_enabled: true }]).map((body) => body.is_default)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('leaves a field out of the body when neither the product nor the patch has it', () => {
    const result = mergeVariants([{ id: 9, price: 500 }], [{ id: 9, price: 600 }]);
    if (!result.ok) throw new Error('expected a merged list');
    const [only] = result.variants;
    expect(only).toEqual({ id: 9, price: 600 });
    expect(only).not.toHaveProperty('is_enabled');
    expect(only).not.toHaveProperty('is_default');
    expect(only).not.toHaveProperty('sku');
  });

  it('returns every unknown id and no list', () => {
    const result = mergeVariants(CURRENT, [{ id: 3, price: 1 }, { id: 7, price: 1 }, { id: 8 }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected unknown ids');
    expect(result.unknownIds).toEqual([7, 8]);
    expect(result).not.toHaveProperty('variants');
  });

  it('returns the current list unchanged for no patches', () => {
    expect(merged([])).toEqual([
      { id: 1, price: 1000, is_enabled: true, is_default: true, sku: 'SKU-1' },
      { id: 2, price: 1000, is_enabled: false, is_default: false, sku: 'SKU-2' },
      { id: 3, price: 1000, is_enabled: true, is_default: false, sku: 'SKU-3' },
    ]);
  });
});

describe('assertUnlocked', () => {
  const base: Product = { id: 'p1', title: 'Mug "11oz"', variants: [] };

  it('throws a ToolError naming the product when it is locked', () => {
    expect(() => {
      assertUnlocked({ ...base, is_locked: true });
    }).toThrow(ToolError);
    try {
      assertUnlocked({ ...base, is_locked: true });
    } catch (error) {
      const toolError = error as ToolError;
      expect(toolError.message).toBe(
        'Product p1 ("Mug \\"11oz\\"") is locked because it is being published, and Printify ' +
          'refuses updates to a locked product.',
      );
      expect(toolError.hint).toBe(LOCKED_HINT);
    }
  });

  it('names the product by id alone when it has no title', () => {
    try {
      assertUnlocked({ id: 'p1', variants: [], is_locked: true });
      throw new Error('expected a ToolError');
    } catch (error) {
      expect((error as Error).message).toMatch(/^Product p1 is locked/);
    }
  });

  it('returns for an unlocked product, and for one that does not say', () => {
    expect(() => {
      assertUnlocked({ ...base, is_locked: false });
    }).not.toThrow();
    expect(() => {
      assertUnlocked(base);
    }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/tools/product-update.test.ts`
Expected: FAIL, "Failed to resolve import ../../src/tools/product-update.js".

- [ ] **Step 3: Write the module**

Create `src/tools/product-update.ts`:

<!-- prettier-ignore -->
```ts
import type { Product, ProductVariant } from '../printify/products.js';
import { ToolError } from './define.js';

/** What `update_product` accepts per variant. Only `id` is required. */
export interface VariantPatch {
  id: number;
  price?: number | undefined;
  is_enabled?: boolean | undefined;
  is_default?: boolean | undefined;
  sku?: string | undefined;
}

/** What the PUT carries per variant: the writable fields only, and no key for an unknown value. */
export interface VariantBody {
  id: number;
  price: number;
  is_enabled?: boolean;
  is_default?: boolean;
  sku?: string;
}

export type MergeResult =
  | { ok: true; variants: VariantBody[] }
  | { ok: false; unknownIds: number[] };

export const LOCKED_HINT =
  'Printify unlocks it when the sales channel reports the publishing result (succeeded or ' +
  'failed). Wait and try again, or check the product in the Printify app.';

/**
 * The complete variant list an update must send: every current variant in its order, with the
 * patched fields replaced. A patch that sets `is_default` makes every other variant not default,
 * since Printify allows one. An id that is not on the product makes the whole merge fail, so a
 * partial list can never be sent by mistake.
 */
export function mergeVariants(
  current: readonly ProductVariant[],
  patches: readonly VariantPatch[],
): MergeResult {
  const known = new Set(current.map((variant) => variant.id));
  const unknownIds = patches.filter((patch) => !known.has(patch.id)).map((patch) => patch.id);
  if (unknownIds.length > 0) return { ok: false, unknownIds };

  const patchById = new Map(patches.map((patch) => [patch.id, patch]));
  const newDefault = patches.some((patch) => patch.is_default === true);
  const variants = current.map((variant) => {
    const patch = patchById.get(variant.id);
    const body: VariantBody = { id: variant.id, price: patch?.price ?? variant.price };
    const isEnabled = patch?.is_enabled ?? variant.is_enabled;
    if (isEnabled !== undefined) body.is_enabled = isEnabled;
    const isDefault = newDefault ? patch?.is_default === true : (patch?.is_default ?? variant.is_default);
    if (isDefault !== undefined) body.is_default = isDefault;
    const sku = patch?.sku ?? variant.sku;
    if (sku !== undefined) body.sku = sku;
    return body;
  });
  return { ok: true, variants };
}

/** Refuses a product that is locked for publishing, before anything is sent. */
export function assertUnlocked(product: Product): void {
  if (product.is_locked !== true) return;
  // JSON-quoted, so a quote or line break in the title cannot garble the message.
  const title = product.title === undefined ? '' : ` (${JSON.stringify(product.title)})`;
  throw new ToolError(
    `Product ${product.id}${title} is locked because it is being published, and Printify ` +
      'refuses updates to a locked product.',
    LOCKED_HINT,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/product-update.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck
git symbolic-ref --short HEAD
git add src/tools/product-update.ts test/tools/product-update.test.ts
git commit -m "Merge partial variant changes into the complete list

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The three read-only tools

**Files:**

- Create: `src/tools/products.ts`
- Create: `test/tools/products.test.ts`
- Modify: `src/tools/index.ts` (`products: []` → `products: productsTools`)

**Interfaces:**

- Consumes: `listProducts`, `getProduct`, `getProductGpsr` from Task 2; `productRow`, `summarizeProduct` from Task 3; `defineTool`, `Tool`, `ToolAnnotations` from `src/tools/define.js`; `shopIdInput`, `resolveShopId` from `src/tools/shop-id.js`; `PAGE_LIMITS` from `src/printify/pagination.js`.
- Produces: `listProductsTool`, `getProductTool`, `getProductGpsrTool`, `productsTools: readonly Tool[]`, and the module-level `productId` schema and `READ_ONLY` annotations that Tasks 6–8 extend in the same file.

- [ ] **Step 1: Write the failing test**

Create `test/tools/products.test.ts`. Tasks 6–8 append their `describe` blocks to this file.

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from 'vitest';
import { GPSR_SECTIONS, PRODUCT, productsPage } from '../fixtures/products.js';
import { SHOP } from '../fixtures/shops.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { createTestServer } from '../support/harness.js';

const SHOP_ID = SHOP.id;
const PRODUCTS_PATH = `/v1/shops/${String(SHOP_ID)}/products.json`;
const PRODUCT_PATH = `/v1/shops/${String(SHOP_ID)}/products/${PRODUCT.id}.json`;
const GPSR_PATH = `/v1/shops/${String(SHOP_ID)}/products/${PRODUCT.id}/gpsr.json`;
const ID = { shop_id: SHOP_ID, product_id: PRODUCT.id };

describe('list_products', () => {
  it('lists the products as rows', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT]) },
    });
    const data = expectToolData(await call('list_products', { shop_id: SHOP_ID }));
    expect(data).toMatchObject({ page: 1, has_more: false, total: 1, last_page: 1 });
    expect(data['products']).toEqual([
      {
        id: PRODUCT.id,
        title: PRODUCT.title,
        blueprint_id: 6,
        print_provider_id: 99,
        visible: true,
        is_locked: false,
        variant_count: 4,
        enabled_variant_count: 3,
        updated_at: PRODUCT.updated_at,
      },
    ]);
    api.expectRequest('GET', PRODUCTS_PATH);
  });

  it('passes page and limit on, and reports more pages', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT], { last_page: 4, total: 31 }) },
    });
    const data = expectToolData(await call('list_products', { shop_id: SHOP_ID, page: 1, limit: 10 }));
    expect(data).toMatchObject({ has_more: true, last_page: 4, total: 31 });
    expect(api.expectRequest('GET', PRODUCTS_PATH).query).toEqual({ page: '1', limit: '10' });
  });

  it('rejects a limit above 50 before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(await call('list_products', { shop_id: SHOP_ID, limit: 51 }), {
      kind: 'validation',
    });
    expect(api.requests).toHaveLength(0);
  });

  it('uses the default shop when shop_id is left out', async () => {
    const { call, api } = await createTestServer({
      routes: {
        'GET /v1/shops.json': [SHOP],
        [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT]),
      },
    });
    expectToolData(await call('list_products'));
    api.expectRequest('GET', '/v1/shops.json');
    api.expectRequest('GET', PRODUCTS_PATH);
  });
});

describe('get_product', () => {
  it('returns the summary by default', async () => {
    const { call, api } = await createTestServer({ routes: { [`GET ${PRODUCT_PATH}`]: PRODUCT } });
    const data = expectToolData(await call('get_product', ID));
    expect(data).toMatchObject({
      id: PRODUCT.id,
      title: PRODUCT.title,
      description: PRODUCT.description,
      tags: PRODUCT.tags,
      variant_count: 4,
      enabled_variant_count: 3,
      mockup_count: 3,
    });
    expect(data['variants']).toEqual([
      { id: 17887, title: 'Black / S', sku: '19473', price: 1000, cost: 650, is_enabled: true, is_default: true, is_available: true },
      { id: 17888, title: 'Black / M', sku: '19474', price: 1000, cost: 650, is_enabled: false, is_default: false, is_available: true },
      { id: 17889, title: 'Black / XL', sku: '19475', price: 1000, cost: 700, is_enabled: true, is_default: false, is_available: true },
      { id: 17890, title: 'White / XL', sku: '19476', price: 1000, cost: 700, is_enabled: true, is_default: false, is_available: false },
    ]);
    expect(data['mockups']).toEqual([PRODUCT.images[0]]);
    expect(data).not.toHaveProperty('views');
    expect(data).not.toHaveProperty('options');
    expect(data).not.toHaveProperty('external');
    const areas = data['print_areas'] as { placeholders: { images: object[] }[] }[];
    expect(areas[0]?.placeholders[0]?.images[0]).toEqual({
      id: '5cb87a8cd490a2ccb256cec4',
      name: 'art.png',
      height: 4000,
      width: 3000,
      x: 0.5,
      y: 0.5,
      scale: 1,
      angle: 0,
    });
    api.expectRequest('GET', PRODUCT_PATH);
  });

  it('returns the whole product with detail: "full"', async () => {
    const { call } = await createTestServer({ routes: { [`GET ${PRODUCT_PATH}`]: PRODUCT } });
    const data = expectToolData(await call('get_product', { ...ID, detail: 'full' }));
    expect(data).toMatchObject({ views: PRODUCT.views, options: PRODUCT.options });
    expect(data['variants']).toEqual(PRODUCT.variants);
    expect(data).not.toHaveProperty('external');
  });

  it('rejects a product_id with a path separator before any request', async () => {
    const { call, api } = await createTestServer();
    for (const product_id of ['../orders', 'abc/def', '']) {
      expectToolError(await call('get_product', { shop_id: SHOP_ID, product_id }), {
        kind: 'validation',
      });
    }
    expect(api.requests).toHaveLength(0);
  });

  it('rejects an unknown argument', async () => {
    const { call } = await createTestServer();
    expectToolError(await call('get_product', { ...ID, full: true }), { kind: 'validation' });
  });
});

describe('get_product_gpsr', () => {
  it('returns the sections', async () => {
    const { call, api } = await createTestServer({ routes: { [`GET ${GPSR_PATH}`]: GPSR_SECTIONS } });
    expect(expectToolData(await call('get_product_gpsr', ID))).toEqual({
      product_id: PRODUCT.id,
      sections: GPSR_SECTIONS,
    });
    api.expectRequest('GET', GPSR_PATH);
  });
});
```

Tasks 6 and 7 add `apiErrorBody`, `json`, `lockedProduct` and `product` to these imports when they first use them, so lint stays clean at every commit.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/tools/products.test.ts`
Expected: FAIL: no such tool is registered, so each `call(...)` either rejects with the SDK's "tool not found" error or returns an error result that makes `expectToolData` throw.

- [ ] **Step 3: Write the tools**

Create `src/tools/products.ts`:

<!-- prettier-ignore -->
```ts
import { z } from 'zod';
import { PAGE_LIMITS } from '../printify/pagination.js';
import { getProduct, getProductGpsr, listProducts } from '../printify/products.js';
import { defineTool, type Tool, type ToolAnnotations } from './define.js';
import { productRow, summarizeProduct } from './product-summary.js';
import { resolveShopId, shopIdInput } from './shop-id.js';

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

// Letters and digits only: Printify ids are hex strings, and anything else would reach apiPath,
// which throws on a path segment it cannot use.
const productId = z
  .string()
  .regex(/^[A-Za-z0-9]+$/, 'product_id must be letters and digits')
  .describe('The product id, e.g. from list_products.');

export const listProductsTool = defineTool({
  name: 'list_products',
  toolset: 'products',
  description:
    "Lists the products in a shop: each one's id, title, blueprint and print provider ids, " +
    'whether it is visible in the sales channel, whether it is locked for publishing, how many ' +
    'variants it has and how many are enabled, and its sales-channel reference. Paginate with ' +
    "page and limit (at most 50; Printify's default is 10). Use get_product for a product's " +
    'variants, print areas and mock-ups.',
  annotations: READ_ONLY,
  input: z.strictObject({
    ...shopIdInput,
    page: z.number().int().positive().optional().describe('The page to fetch, starting at 1.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(PAGE_LIMITS.products)
      .optional()
      .describe(
        `Products per page, at most ${String(PAGE_LIMITS.products)}. Printify's default is 10.`,
      ),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const page = await listProducts(
      ctx.client,
      shopId,
      { page: input.page, limit: input.limit },
      ctx.signal,
    );
    return {
      products: page.products.map(productRow),
      page: page.page,
      has_more: page.hasMore,
      total: page.total,
      last_page: page.lastPage,
    };
  },
});

export const getProductTool = defineTool({
  name: 'get_product',
  toolset: 'products',
  description:
    "Gets one product. The summary (the default) has the product's fields, every variant as a " +
    'compact row (id, title, sku, price and cost in cents, is_enabled, is_default, ' +
    "is_available), its print areas with each image's id and placement, and the default " +
    'mock-up URLs. detail: "full" returns the whole product as Printify sends it, including ' +
    'every mock-up, the blank views and the option tables; it is large. A text layer in a print ' +
    'area is shown but cannot be edited here.',
  annotations: READ_ONLY,
  input: z.strictObject({
    ...shopIdInput,
    product_id: productId,
    detail: z
      .enum(['summary', 'full'])
      .default('summary')
      .describe('summary (the default) is compact; full is the whole product and is large.'),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const found = await getProduct(ctx.client, shopId, input.product_id, ctx.signal);
    return input.detail === 'full' ? { ...found } : { ...summarizeProduct(found) };
  },
});

export const getProductGpsrTool = defineTool({
  name: 'get_product_gpsr',
  toolset: 'products',
  description:
    "Gets a product's General Product Safety Regulation (GPSR) information: the sections " +
    'Printify derives from its safety_information, each with a title and text. Set ' +
    'safety_information with create_product or update_product to change them.',
  annotations: READ_ONLY,
  input: z.strictObject({ ...shopIdInput, product_id: productId }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const sections = await getProductGpsr(ctx.client, shopId, input.product_id, ctx.signal);
    return { product_id: input.product_id, sections };
  },
});

/** Every tool of the `products` toolset, in the order a session uses them. */
export const productsTools: readonly Tool[] = [listProductsTool, getProductTool, getProductGpsrTool];
```

In `src/tools/index.ts`, add the import and file the toolset:

```ts
import { productsTools } from './products.js';
```

<!-- prettier-ignore -->
```ts
  products: productsTools,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/products.test.ts test/tools/catalog.test.ts`
Expected: PASS. `catalog.test.ts` runs `toolProblems` over `ALL_TOOLS` and checks each tool is filed under its own toolset; if it reports "the input cannot be converted to JSON Schema", a `.regex()` or `.enum()` is not the cause (both convert); look for a stray `.refine()`.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck
git symbolic-ref --short HEAD
git add src/tools/products.ts src/tools/index.ts test/tools/products.test.ts
git commit -m "Add list_products, get_product and get_product_gpsr

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `create_product` and the shared input schemas

**Files:**

- Modify: `src/tools/products.ts` (schemas, `pickFields`, the tool, `productsTools`)
- Modify: `test/tools/products.test.ts` (append a `describe`)

**Interfaces:**

- Consumes: `createProduct` from Task 2; `summarizeProduct` from Task 3.
- Produces, used by Task 7 in the same file: `titleInput`, `descriptionInput`, `variantFields`, `priceInput`, `printAreaInput`, `optionalProductFields`, `pickFields(input: Record<string, unknown>, fields: readonly string[]): Record<string, unknown>`.

- [ ] **Step 1: Write the failing test**

Append to `test/tools/products.test.ts`:

<!-- prettier-ignore -->
```ts
const NEW_PRODUCT = {
  title: 'Product',
  description: 'Good product',
  blueprint_id: 384,
  print_provider_id: 1,
  variants: [
    { id: 45740, price: 400, is_enabled: true, is_default: true },
    { id: 45742, price: 400, is_enabled: false },
  ],
  print_areas: [
    {
      variant_ids: [45740, 45742],
      placeholders: [
        {
          position: 'front',
          images: [{ id: '5d15ca551163cde90d7b2203', x: 0.5, y: 0.5, scale: 1, angle: 0 }],
        },
      ],
    },
  ],
  tags: ['Tee'],
  print_details: { print_on_side: 'regular' },
  is_printify_express_enabled: false,
  sales_channel_properties: { free_shipping: false },
};

describe('create_product', () => {
  it('posts the body as given and returns the summary', async () => {
    const { call, api } = await createTestServer({ routes: { [`POST ${PRODUCTS_PATH}`]: PRODUCT } });
    const data = expectToolData(await call('create_product', { shop_id: SHOP_ID, ...NEW_PRODUCT }));
    expect(data).toMatchObject({ id: PRODUCT.id, title: PRODUCT.title, variant_count: 4 });
    expect(data).not.toHaveProperty('views');
    expect(api.expectRequest('POST', PRODUCTS_PATH).body).toEqual(NEW_PRODUCT);
  });

  it('rejects a missing required field before any request', async () => {
    const { call, api } = await createTestServer();
    const { variants, ...withoutVariants } = NEW_PRODUCT;
    expect(variants).toHaveLength(2);
    expectToolError(await call('create_product', { shop_id: SHOP_ID, ...withoutVariants }), {
      kind: 'validation',
    });
    expect(api.requests).toHaveLength(0);
  });

  it('rejects empty variants and empty print_areas', async () => {
    const { call, api } = await createTestServer();
    expectToolError(await call('create_product', { shop_id: SHOP_ID, ...NEW_PRODUCT, variants: [] }), {
      kind: 'validation',
    });
    expectToolError(
      await call('create_product', { shop_id: SHOP_ID, ...NEW_PRODUCT, print_areas: [] }),
      { kind: 'validation' },
    );
    expect(api.requests).toHaveLength(0);
  });

  it('rejects a bad image placement, a placeholder without a position and an unknown key', async () => {
    const { call, api } = await createTestServer();
    const withImage = (image: Record<string, unknown>) => ({
      shop_id: SHOP_ID,
      ...NEW_PRODUCT,
      print_areas: [
        { variant_ids: [45740], placeholders: [{ position: 'front', images: [image] }] },
      ],
    });
    const good = { id: 'img', x: 0.5, y: 0.5, scale: 1, angle: 0 };
    for (const bad of [
      { ...good, x: 1.5 },
      { ...good, y: -0.1 },
      { ...good, scale: 0 },
      { ...good, angle: 361 },
      { ...good, angle: 1.5 },
      { ...good, src: 'https://example.com/a.png' },
    ]) {
      expectToolError(await call('create_product', withImage(bad)), { kind: 'validation' });
    }
    expectToolError(
      await call('create_product', {
        shop_id: SHOP_ID,
        ...NEW_PRODUCT,
        print_areas: [{ variant_ids: [45740], placeholders: [{ images: [good] }] }],
      }),
      { kind: 'validation' },
    );
    expectToolError(
      await call('create_product', {
        shop_id: SHOP_ID,
        ...NEW_PRODUCT,
        print_areas: [{ variant_ids: [], placeholders: [{ position: 'front', images: [good] }] }],
      }),
      { kind: 'validation' },
    );
    expectToolError(
      await call('create_product', {
        shop_id: SHOP_ID,
        ...NEW_PRODUCT,
        variants: [{ id: 45740, price: 400, is_enable: true }],
      }),
      { kind: 'validation' },
    );
    expect(api.requests).toHaveLength(0);
  });

  it("passes Printify's low-quality image error back with its hint", async () => {
    const body = apiErrorBody({
      code: 8203,
      message: 'Validation failed.',
      reason: 'Image has low quality',
    });
    const { call } = await createTestServer({ routes: { [`POST ${PRODUCTS_PATH}`]: json(body, 400) } });
    const error = expectToolError(await call('create_product', { shop_id: SHOP_ID, ...NEW_PRODUCT }), {
      kind: 'http',
      status: 400,
      code: 8203,
    });
    expect(error.hint).toContain('resolution is too low');
  });
});
```

Add `apiErrorBody` (from `../fixtures/errors.js`) and `json` (from `../support/fake-api.js`) to the file's imports now.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/tools/products.test.ts -t create_product`
Expected: FAIL, the tool is not registered.

- [ ] **Step 3: Add the schemas and the tool**

In `src/tools/products.ts`, add `createProduct` to the import from `../printify/products.js`, then insert after the `productId` schema:

<!-- prettier-ignore -->
```ts
const titleInput = z.string().min(1).describe('The product name.');
const descriptionInput = z
  .string()
  .describe('The product description. HTML is allowed for compatible sales channels.');

const variantId = z.number().int().positive();
const priceInput = z.number().int().min(0).describe('The price in cents, e.g. 2499 for 24.99.');

/** The writable variant fields besides `price`, whose optionality differs between the tools. */
const variantFields = {
  id: variantId.describe('The variant id, from list_variants.'),
  is_enabled: z.boolean().optional().describe('Whether the variant is offered for sale.'),
  is_default: z
    .boolean()
    .optional()
    .describe('The default variant gives the product its title image. Only one can be default.'),
  sku: z.string().optional().describe('A SKU of your own. Printify generates one when it is left out.'),
};

const patternInput = z.strictObject({
  spacing_x: z
    .number()
    .describe('Horizontal spacing relative to the image width: 1 is no gap, 0.5 repeats every half width.'),
  spacing_y: z.number().describe('Vertical spacing relative to the image height, like spacing_x.'),
  angle: z.number().optional().describe('The axis the pattern repeats along, in degrees, -45 to 45.'),
  offset: z.number().optional().describe('The offset between rows, -1 to 1; 0.5 makes a brick pattern.'),
  scale: z.number().optional().describe('The scale of each repeat.'),
});

const imageInput = z.strictObject({
  id: z.string().min(1).describe('An image id from upload_image or list_uploads.'),
  x: z
    .number()
    .min(0)
    .max(1)
    .describe("The image centre's horizontal position, 0–1 from the left; 0.5 is the middle."),
  y: z
    .number()
    .min(0)
    .max(1)
    .describe("The image centre's vertical position, 0–1 from the top; 0.5 is the middle."),
  scale: z
    .number()
    .positive()
    .describe('The image width divided by the placeholder width; 1 fills the print area.'),
  angle: z.number().int().min(-360).max(360).describe('Rotation in degrees; 0 is upright.'),
  pattern: patternInput.optional().describe('Repeat the image as a pattern.'),
});

const placeholderInput = z.strictObject({
  position: z
    .string()
    .min(1)
    .describe('A position from list_variants, e.g. front. It selects the decoration method.'),
  images: z.array(imageInput).describe('The images to print at this position, in stacking order.'),
});

const printAreaInput = z.strictObject({
  variant_ids: z.array(variantId).min(1).describe('The variants this print area applies to.'),
  placeholders: z.array(placeholderInput).min(1),
  background: z.string().optional().describe('A background colour as a hex code, e.g. #ffffff.'),
});

const printDetailsInput = z.strictObject({
  print_on_side: z
    .enum(['regular', 'mirror', 'off'])
    .optional()
    .describe('For canvases: regular extends the print to the sides, mirror mirrors it, off leaves them blank.'),
  separator_type: z.string().optional().describe('For clocks: Numbers, Lines or None.'),
  separator_color: z.string().optional().describe('For clocks: a hex colour code.'),
});

const externalInput = z
  .array(
    z.strictObject({
      id: z.string().optional(),
      handle: z.string().optional(),
      shipping_template_id: z.string().optional().describe('An Etsy or Amazon shipping template id.'),
    }),
  )
  .describe('The sales-channel reference. Only shipping_template_id is normally set by hand.');

/** The product fields both tools accept, all optional. */
const optionalProductFields = {
  tags: z.array(z.string()).optional().describe('Tags, published to the sales channel.'),
  safety_information: z
    .string()
    .optional()
    .describe('GPSR and care information; HTML is allowed. get_product_gpsr shows how Printify splits it.'),
  print_details: printDetailsInput.optional(),
  external: externalInput.optional(),
  is_printify_express_enabled: z
    .boolean()
    .optional()
    .describe('Enable Printify Express delivery. Only an eligible product accepts it.'),
  sales_channel_properties: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Sales-channel specific settings, passed through as given.'),
};

const CREATE_FIELDS = [
  'title',
  'description',
  'blueprint_id',
  'print_provider_id',
  'variants',
  'print_areas',
  'tags',
  'safety_information',
  'print_details',
  'external',
  'is_printify_express_enabled',
  'sales_channel_properties',
] as const;

/** The given fields of `input`, as the request body. An absent field is left out, so Printify keeps it. */
function pickFields(
  input: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    if (input[field] !== undefined) body[field] = input[field];
  }
  return body;
}
```

Then, after `getProductGpsrTool`, add the tool and extend the list:

<!-- prettier-ignore -->
```ts
export const createProductTool = defineTool({
  name: 'create_product',
  toolset: 'products',
  description:
    'Creates a product from a catalog blueprint and print provider (from search_blueprints and ' +
    'list_blueprint_providers), with the variants to offer (ids from list_variants, prices in ' +
    'cents) and the artwork to print. print_areas maps variant ids to placeholders: each has a ' +
    'position from list_variants and the images to print there, by image id from upload_image ' +
    "or list_uploads. x and y place the image's centre, 0–1 from the top-left with 0.5/0.5 the " +
    'centre of the print area; scale is the image width divided by the placeholder width, 1 ' +
    'fills it; angle rotates in degrees. Only one variant can be is_default; it gives the ' +
    'product its title image. Printify renders the mock-ups during the call, so it can take a ' +
    "while. Returns the new product's summary, including its id for update_product.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: z.strictObject({
    ...shopIdInput,
    title: titleInput,
    description: descriptionInput,
    blueprint_id: z.number().int().positive().describe('The catalog blueprint id, from search_blueprints.'),
    print_provider_id: z
      .number()
      .int()
      .positive()
      .describe('The print provider id, from list_blueprint_providers.'),
    variants: z
      .array(z.strictObject({ ...variantFields, price: priceInput }))
      .min(1)
      .describe('The variants to offer, each with its price. Disabled ones are kept but not sold.'),
    print_areas: z.array(printAreaInput).min(1),
    ...optionalProductFields,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const body = pickFields(input, CREATE_FIELDS);
    const created = await createProduct(ctx.client, shopId, body, ctx.signal);
    return { ...summarizeProduct(created) };
  },
});
```

```ts
export const productsTools: readonly Tool[] = [
  listProductsTool,
  getProductTool,
  getProductGpsrTool,
  createProductTool,
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/products.test.ts test/tools/catalog.test.ts`
Expected: PASS.

If `pickFields(input, …)` does not typecheck because the zod output type is not assignable to `Record<string, unknown>`, change the parameter to `input: object` and read through `(input as Record<string, unknown>)[field]` inside the function, with a comment that the caller passes a validated strict object.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck
git symbolic-ref --short HEAD
git add src/tools/products.ts test/tools/products.test.ts
git commit -m "Add create_product with strict print-area schemas

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: `update_product`

**Files:**

- Modify: `src/tools/products.ts` (the tool, its checks, `productsTools`)
- Modify: `test/tools/products.test.ts` (append a `describe`)

**Interfaces:**

- Consumes: `getProduct`, `updateProduct` from Task 2; `summarizeProduct` from Task 3; `mergeVariants`, `assertUnlocked`, `VariantPatch` from Task 4; the schemas and `pickFields` from Task 6; `ToolError` from `src/tools/define.js`.
- Produces: `updateProductTool`.

- [ ] **Step 1: Write the failing test**

Append to `test/tools/products.test.ts`, and add `lockedProduct` and `product` to the fixture import:

<!-- prettier-ignore -->
```ts
describe('update_product', () => {
  const routes = (updated: object = product({ title: 'Renamed' })) => ({
    [`GET ${PRODUCT_PATH}`]: PRODUCT,
    [`PUT ${PRODUCT_PATH}`]: updated,
  });
  /** The writable fields of a fixture variant, as the merge sends them. */
  const sent = (index: number, overrides: Record<string, unknown> = {}) => {
    const variant = PRODUCT.variants[index];
    if (variant === undefined) throw new Error(`no fixture variant ${String(index)}`);
    const { id, price, is_enabled, is_default, sku } = variant;
    return { id, price, is_enabled, is_default, sku, ...overrides };
  };

  it('fetches, then puts a title-only update and returns the summary', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    const data = expectToolData(await call('update_product', { ...ID, title: 'Renamed' }));
    expect(data).toMatchObject({ id: PRODUCT.id, title: 'Renamed', sent_fields: ['title'] });
    expect(data).not.toHaveProperty('views');
    api.expectRequest('GET', PRODUCT_PATH);
    expect(api.expectRequest('PUT', PRODUCT_PATH).body).toEqual({ title: 'Renamed' });
  });

  it('sends the complete variant list for a partial change (the XL example)', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    const data = expectToolData(
      await call('update_product', {
        ...ID,
        variants: [
          { id: 17889, price: 2499 },
          { id: 17890, price: 2499 },
        ],
      }),
    );
    expect(data['sent_fields']).toEqual(['variants']);
    expect(api.expectRequest('PUT', PRODUCT_PATH).body).toEqual({
      variants: [sent(0), sent(1), sent(2, { price: 2499 }), sent(3, { price: 2499 })],
    });
  });

  it('unsets the other defaults when one variant becomes the default', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    expectToolData(await call('update_product', { ...ID, variants: [{ id: 17890, is_default: true }] }));
    const body = api.expectRequest('PUT', PRODUCT_PATH).body as { variants: { is_default: boolean }[] };
    expect(body.variants.map((variant) => variant.is_default)).toEqual([false, false, false, true]);
  });

  it('refuses a variant id the product does not have, after the GET only', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    const error = expectToolError(
      await call('update_product', { ...ID, variants: [{ id: 17889, price: 1 }, { id: 99, price: 1 }] }),
      { kind: 'tool' },
    );
    expect(error.message).toBe(`Product ${PRODUCT.id} has no variant 99.`);
    expect(error.hint).toContain('replace_variants');
    expect(api.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('sends the variants as given with replace_variants', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    const variants = [{ id: 17887, price: 1200, is_enabled: true }, { id: 17891, price: 1300 }];
    expectToolData(await call('update_product', { ...ID, variants, replace_variants: true }));
    expect(api.expectRequest('PUT', PRODUCT_PATH).body).toEqual({ variants });
  });

  it('refuses replace_variants without variants, or with a variant lacking a price', async () => {
    const { call, api } = await createTestServer();
    const noList = await call('update_product', { ...ID, title: 'x', replace_variants: true });
    expect(expectToolError(noList, { kind: 'tool' }).message).toContain('replace_variants needs variants');
    const unpriced = await call('update_product', {
      ...ID,
      variants: [{ id: 17887, price: 1 }, { id: 17888 }],
      replace_variants: true,
    });
    expect(expectToolError(unpriced, { kind: 'tool' }).message).toContain('17888');
    expect(api.requests).toHaveLength(0);
  });

  it('refuses duplicate variant ids, an empty variants list and an empty update', async () => {
    const { call, api } = await createTestServer();
    const duplicate = await call('update_product', {
      ...ID,
      variants: [{ id: 17887, price: 1 }, { id: 17887, price: 2 }],
    });
    expect(expectToolError(duplicate, { kind: 'tool' }).message).toContain('17887');
    expectToolError(await call('update_product', { ...ID, variants: [] }), { kind: 'validation' });
    const empty = await call('update_product', ID);
    expect(expectToolError(empty, { kind: 'tool' }).message).toContain('Nothing to update');
    expect(api.requests).toHaveLength(0);
  });

  it('refuses a locked product before the PUT', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${PRODUCT_PATH}`]: lockedProduct() },
    });
    const error = expectToolError(await call('update_product', { ...ID, title: 'x' }), {
      kind: 'tool',
    });
    expect(error.message).toContain('is locked because it is being published');
    expect(error.hint).toContain('publishing result');
    expect(api.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('refuses to merge into a product whose variants cannot be resent', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${PRODUCT_PATH}`]: { ...PRODUCT, variants: [{ id: 17887, title: 'no price' }] } },
    });
    expectToolError(await call('update_product', { ...ID, variants: [{ id: 17887, price: 1 }] }), {
      kind: 'invalid_response',
    });
    expect(api.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('sends print_areas and the other fields as given', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    const print_areas = NEW_PRODUCT.print_areas;
    expectToolData(
      await call('update_product', {
        ...ID,
        print_areas,
        tags: ['New'],
        external: [{ shipping_template_id: 'tpl-1' }],
      }),
    );
    expect(api.expectRequest('PUT', PRODUCT_PATH).body).toEqual({
      print_areas,
      tags: ['New'],
      external: [{ shipping_template_id: 'tpl-1' }],
    });
  });

  it("passes Printify's low-quality image error from the PUT back with its hint", async () => {
    const body = apiErrorBody({ code: 8203, message: 'Validation failed.', reason: 'Image has low quality' });
    const { call } = await createTestServer({ routes: routes(json(body, 400)) });
    const error = expectToolError(await call('update_product', { ...ID, title: 'x' }), {
      kind: 'http',
      code: 8203,
    });
    expect(error.hint).toContain('resolution is too low');
  });
});
```

The `routes` helper's default parameter is typed `object`; passing `json(body, 400)` (a `Response`) is fine since `Response` is an object. If TypeScript complains about the `Routes` value type, annotate the helper's return as `Routes` (import the type from `../support/fake-api.js`) and the parameter as `Route`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/tools/products.test.ts -t update_product`
Expected: FAIL, the tool is not registered.

- [ ] **Step 3: Write the tool**

In `src/tools/products.ts`, extend the imports:

```ts
import {
  createProduct,
  getProduct,
  getProductGpsr,
  listProducts,
  updateProduct,
} from '../printify/products.js';
import { defineTool, ToolError, type Tool, type ToolAnnotations } from './define.js';
import { assertUnlocked, mergeVariants, type VariantPatch } from './product-update.js';
```

Add after `CREATE_FIELDS`:

<!-- prettier-ignore -->
```ts
const UPDATE_FIELDS = [
  'title',
  'description',
  'tags',
  'safety_information',
  'variants',
  'print_areas',
  'print_details',
  'external',
  'is_printify_express_enabled',
  'sales_channel_properties',
] as const;

const REPLACE_HINT =
  'Pass replace_variants: true only with the complete variant list, every entry with its price, ' +
  'and print_areas that cover any new variant ids.';
const UNKNOWN_VARIANT_HINT =
  'Use list_variants for the ids this blueprint and print provider offer. To add or remove ' +
  'variants, pass replace_variants: true with the complete list, and print_areas that cover the ' +
  'new ids.';

/** The refusals that need no request: they are about the input alone. */
function checkVariantPatches(
  variants: readonly VariantPatch[] | undefined,
  replace: boolean,
): void {
  if (variants === undefined) {
    if (replace) {
      throw new ToolError('replace_variants needs variants: the complete list to set.', REPLACE_HINT);
    }
    return;
  }
  const ids = variants.map((variant) => variant.id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) {
    throw new ToolError(
      `variants lists ${duplicates.map(String).join(', ')} more than once.`,
      'Give each variant id once.',
    );
  }
  if (replace) {
    const unpriced = variants.filter((variant) => variant.price === undefined);
    if (unpriced.length > 0) {
      throw new ToolError(
        'With replace_variants every variant needs a price; ' +
          `${unpriced.map((variant) => String(variant.id)).join(', ')} have none.`,
        REPLACE_HINT,
      );
    }
  }
}
```

Add the tool after `createProductTool`:

<!-- prettier-ignore -->
```ts
export const updateProductTool = defineTool({
  name: 'update_product',
  toolset: 'products',
  description:
    'Updates a product. Any of title, description, tags, safety_information, variants, ' +
    'print_areas, print_details, external, is_printify_express_enabled and ' +
    'sales_channel_properties can be given; fields left out keep their value. variants are ' +
    "merged by id into the product's current variants: give only the variants to change, with " +
    'only the fields to change (price in cents, is_enabled, is_default, sku). The tool fetches ' +
    'the product and sends the complete list, because Printify removes every variant missing ' +
    'from an update. Setting is_default on one variant unsets it on the others. A variant id ' +
    'the product does not have is refused; to add or remove variants, pass ' +
    'replace_variants: true with the complete list (every entry with a price) and print_areas ' +
    'that cover the new ids. print_areas, when given, replace all print areas, text layers ' +
    'included. A product that is locked for publishing is refused before anything is sent. ' +
    "Returns the updated product's summary.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: z.strictObject({
    ...shopIdInput,
    product_id: productId,
    title: titleInput.optional(),
    description: descriptionInput.optional(),
    variants: z
      .array(z.strictObject({ ...variantFields, price: priceInput.optional() }))
      .min(1)
      .optional()
      .describe('The variants to change, by id, with only the fields to change.'),
    print_areas: z
      .array(printAreaInput)
      .min(1)
      .optional()
      .describe('Replaces every print area of the product.'),
    ...optionalProductFields,
    replace_variants: z
      .boolean()
      .default(false)
      .describe(
        'Send variants exactly as given instead of merging them. Needs the complete list, ' +
          'each with a price; every variant not listed is removed.',
      ),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const body = pickFields(input, UPDATE_FIELDS);
    const sentFields = Object.keys(body);
    if (sentFields.length === 0) {
      throw new ToolError(
        'Nothing to update: no field was given.',
        `Give at least one of ${UPDATE_FIELDS.join(', ')}.`,
      );
    }
    checkVariantPatches(input.variants, input.replace_variants);

    const current = await getProduct(ctx.client, shopId, input.product_id, ctx.signal);
    assertUnlocked(current);
    if (input.variants !== undefined && !input.replace_variants) {
      const merged = mergeVariants(current.variants, input.variants);
      if (!merged.ok) {
        throw new ToolError(
          `Product ${current.id} has no variant ${merged.unknownIds.map(String).join(', ')}.`,
          UNKNOWN_VARIANT_HINT,
        );
      }
      body['variants'] = merged.variants;
    }

    const updated = await updateProduct(ctx.client, shopId, input.product_id, body, ctx.signal);
    return { ...summarizeProduct(updated), sent_fields: sentFields };
  },
});
```

And extend the list:

```ts
export const productsTools: readonly Tool[] = [
  listProductsTool,
  getProductTool,
  getProductGpsrTool,
  createProductTool,
  updateProductTool,
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/products.test.ts test/tools/catalog.test.ts`
Expected: PASS. In the XL test, the PUT body's variants carry `id`, `price`, `is_enabled`, `is_default` and `sku` for all four fixture variants and nothing else (no `cost`, `title`, `grams`, `options`), which is what `sent()` builds.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck
git symbolic-ref --short HEAD
git add src/tools/products.ts test/tools/products.test.ts
git commit -m "Add update_product, which merges variants and refuses locked products

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: `delete_product`, the CI smoke step and the full verification

**Files:**

- Modify: `src/tools/products.ts` (the tool, `productsTools`)
- Modify: `test/tools/products.test.ts` (append a `describe`)
- Modify: `.github/workflows/ci.yml` (the smoke step's name list and the gated-tool check)

**Interfaces:**

- Consumes: `deleteProduct` from Task 2.
- Produces: `deleteProductTool`; the final `productsTools`.

- [ ] **Step 1: Write the failing test**

Append to `test/tools/products.test.ts`:

<!-- prettier-ignore -->
```ts
describe('delete_product', () => {
  it('is turned off without PRINTIFY_ENABLE_DESTRUCTIVE, and the instructions say so', async () => {
    const { mcp, selection } = await createTestServer();
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('update_product');
    expect(names).not.toContain('delete_product');
    expect(selection.skipped.map(({ tool, reason }) => [tool.name, reason])).toContainEqual([
      'delete_product',
      'destructive',
    ]);
    expect(mcp.getInstructions()).toMatch(
      /Irreversible tools \(.*delete_product.*\): set PRINTIFY_ENABLE_DESTRUCTIVE=true\./,
    );
  });

  it('deletes a product when the flag is on', async () => {
    const { call, api } = await createTestServer({
      env: { PRINTIFY_ENABLE_DESTRUCTIVE: 'true' },
      routes: { [`DELETE ${PRODUCT_PATH}`]: json({}) },
    });
    expect(expectToolData(await call('delete_product', ID))).toEqual({
      product_id: PRODUCT.id,
      deleted: true,
    });
    api.expectRequest('DELETE', PRODUCT_PATH);
  });

  it('is annotated as destructive rather than read-only, and the tools list ends with it', async () => {
    const { mcp } = await createTestServer({ env: { PRINTIFY_ENABLE_DESTRUCTIVE: 'true' } });
    const tools = (await mcp.listTools()).tools;
    const tool = tools.find(({ name }) => name === 'delete_product');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const products = tools
      .map(({ name }) => name)
      .filter((name) =>
        ['list_products', 'get_product', 'get_product_gpsr', 'create_product', 'update_product', 'delete_product'].includes(name),
      );
    expect(products).toEqual([
      'list_products',
      'get_product',
      'get_product_gpsr',
      'create_product',
      'update_product',
      'delete_product',
    ]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/tools/products.test.ts -t delete_product`
Expected: FAIL: `selection.skipped` does not contain `delete_product`, and the flag-on test reports the tool is not registered.

- [ ] **Step 3: Write the tool**

In `src/tools/products.ts`, add `deleteProduct` to the import from `../printify/products.js`, then add after `updateProductTool`:

<!-- prettier-ignore -->
```ts
export const deleteProductTool = defineTool({
  name: 'delete_product',
  toolset: 'products',
  gate: 'destructive',
  description:
    "Deletes a product from the shop. This cannot be undone. Confirm the product's id and title " +
    'with the user first, e.g. from get_product. If the call fails with a timeout or a 404, ' +
    'check with get_product before calling it again rather than assuming nothing happened: a ' +
    'retried delete can succeed and still report 404.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  input: z.strictObject({ ...shopIdInput, product_id: productId }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    await deleteProduct(ctx.client, shopId, input.product_id, ctx.signal);
    return { product_id: input.product_id, deleted: true };
  },
});
```

```ts
/** Every tool of the `products` toolset, in the order a session uses them. */
export const productsTools: readonly Tool[] = [
  listProductsTool,
  getProductTool,
  getProductGpsrTool,
  createProductTool,
  updateProductTool,
  deleteProductTool,
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/products.test.ts test/tools/catalog.test.ts test/tools/select.test.ts`
Expected: PASS.

- [ ] **Step 5: Extend the CI smoke step**

In `.github/workflows/ci.yml`, in the step that pipes `tools/list` into `node dist/index.js`, add one line after `! grep -q '"name":"archive_upload"' <<<"$output"`:

<!-- prettier-ignore -->
```yaml
          ! grep -q '"name":"delete_product"' <<<"$output"
```

and extend the `for tool in …` list so it ends:

<!-- prettier-ignore -->
```yaml
          for tool in search_blueprints get_blueprint list_blueprint_providers list_variants \
            get_shipping_info list_print_providers get_print_provider \
            list_shipping_methods get_shipping_costs \
            upload_image list_uploads get_upload \
            list_products get_product get_product_gpsr create_product update_product; do
```

- [ ] **Step 6: Reproduce the smoke step locally**

```bash
npm run build
output=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | PRINTIFY_API_TOKEN=smoke-test-token timeout 10 node dist/index.js 2>/dev/null)
for tool in list_products get_product get_product_gpsr create_product update_product; do
  grep -q "\"name\":\"$tool\"" <<<"$output" && echo "ok $tool"
done
! grep -q '"name":"delete_product"' <<<"$output" && echo "ok delete_product absent"
```

Expected: five `ok` lines and `ok delete_product absent`. (`timeout` is GNU coreutils; on macOS use `gtimeout` from `brew install coreutils`, or drop it and close stdin, which the `printf` pipe already does.)

- [ ] **Step 7: Full verification**

```bash
npx prettier --write src test docs .github
npm run lint && npm run typecheck && npm test && npm run build
```

Expected: lint clean, typecheck clean, every test file passing (the suite was 614 tests before this branch; expect roughly 60 more), build clean.

- [ ] **Step 8: Commit**

```bash
git symbolic-ref --short HEAD
git add src/tools/products.ts test/tools/products.test.ts .github/workflows/ci.yml
git commit -m "Add delete_product behind the destructive gate

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## After the last task

1. Push the branch and open the PR with `gh pr create`, the body starting with `Closes #11`, describing the six tools, the merge, the locked check and the strict schemas, and ending with the attribution line the session's instructions give for PR bodies.
2. Move the issue to In review: `~/.claude/skills/updating-github-project-status/board.sh review`.
3. Watch the CI run on Node 22 and 24; the smoke step is the one most likely to fail if a name was mistyped.
4. Hand-off comments, as the spec's Delivery section lists them: on #12 (`getProduct`, `summarizeProduct`, and where the locked message lives) and on #19 (`createProduct()` and the reusable input schemas `variantFields`, `printAreaInput`, `imageInput` in `src/tools/products.ts`).
