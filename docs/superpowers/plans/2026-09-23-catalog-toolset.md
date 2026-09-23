# Catalog toolset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the six read-only `catalog` tools (blueprints, print providers, variants, v1 shipping) on a per-process, TTL-cached catalog reader.

**Architecture:** `createTtlCache` (generic, bounded, expiry on read plus a sweep on write) sits under `createCatalog(client)`, which fetches each documented catalog endpoint once per TTL, validates it with zod and hands back parsed, shared, read-only values. `cli.ts` builds one catalog per process and puts it in `ToolServices`, so every server instance and every tool call shares one cache. The tools in `src/tools/catalog.ts` only shape what the catalog gives them.

**Tech Stack:** TypeScript ~6.0 (NodeNext, `strict`, `noUncheckedIndexedAccess`), zod 4, MCP TypeScript SDK v2 (`@modelcontextprotocol/server`), vitest 5, Node >= 22.

**Spec:** `docs/superpowers/specs/2026-09-22-catalog-toolset-design.md`

## Global Constraints

- **Test-first.** Write the failing test, watch it fail for the right reason, then implement.
- **Every commit message ends with this trailer, exactly:**
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Verification before any claim of success:** `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. `npm run lint` is `eslint . && prettier --check .`, so run `npx prettier --write src test docs` before committing.
- **Interfaces declare function-typed properties, never methods** (`get: (key: string) => V | undefined`), and test helpers return arrow properties, not methods. A method trips `@typescript-eslint/unbound-method` when a caller destructures it.
- **No `_`-prefixed escape for unused variables.** The ESLint config has no `argsIgnorePattern`; write the code so nothing is unused.
- **Tools return plain objects, never arrays.** The registry drops `null` and `undefined` and serialises the rest.
- **Tool inputs are `z.strictObject`.** Unknown keys are rejected before the handler runs.
- **Never add a route key with a query string.** `createFakeApi` matches on the pathname only; a key with `?` is accepted and then never matches. A route that must vary by query is a function reading `request.query`.
- **Routes must not answer 429 or 5xx** unless the test is about retries: the client retries those on real timers.
- **Base branch:** `feat/8-catalog-toolset`, in the worktree `../printify-mcp-worktrees/feat-8-catalog-toolset`. Run every command there.

---

### Task 1: The TTL cache

**Files:**

- Create: `src/cache.ts`
- Test: `test/cache.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `createTtlCache<V>(options?: { maxEntries?: number; now?: () => number }): TtlCache<V>` with `get: (key: string) => V | undefined` and `set: (key: string, value: V, ttlMs: number) => void`. Task 2 uses it.

- [ ] **Step 1: Write the failing test**

Create `test/cache.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createTtlCache } from '../src/cache.js';

/** A cache whose clock the test moves with `tick`. */
function testCache(maxEntries?: number) {
  let time = 0;
  const cache = createTtlCache<string>({ maxEntries, now: () => time });
  return {
    cache,
    // An arrow property, not a method: destructuring a method trips unbound-method.
    tick: (ms: number): void => {
      time += ms;
    },
  };
}

describe('createTtlCache', () => {
  it('returns a value before its time is up', () => {
    const { cache, tick } = testCache();
    cache.set('a', 'value', 1000);
    tick(999);
    expect(cache.get('a')).toBe('value');
  });

  it('forgets a value at exactly its ttl and after it', () => {
    const { cache, tick } = testCache();
    cache.set('a', 'value', 1000);
    tick(1000);
    expect(cache.get('a')).toBeUndefined();

    cache.set('b', 'value', 1000);
    tick(5000);
    expect(cache.get('b')).toBeUndefined();
  });

  it('has nothing for an unknown key', () => {
    const { cache } = testCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('sweeps expired entries on set, so they do not evict fresh ones', () => {
    const { cache, tick } = testCache(2);
    cache.set('old-1', 'one', 1000);
    cache.set('old-2', 'two', 1000);
    tick(1000);

    // Both are expired: the sweep drops them, so neither counts towards the limit.
    cache.set('fresh-1', 'three', 1000);
    cache.set('fresh-2', 'four', 1000);

    expect(cache.get('fresh-1')).toBe('three');
    expect(cache.get('fresh-2')).toBe('four');
  });

  it('evicts the oldest entry past maxEntries', () => {
    const { cache } = testCache(2);
    cache.set('a', 'one', 1000);
    cache.set('b', 'two', 1000);
    cache.set('c', 'three', 1000);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('two');
    expect(cache.get('c')).toBe('three');
  });

  it('makes a re-set key the newest, so it survives the next eviction', () => {
    const { cache } = testCache(2);
    cache.set('a', 'one', 1000);
    cache.set('b', 'two', 1000);
    cache.set('a', 'again', 1000);
    cache.set('c', 'three', 1000);

    expect(cache.get('a')).toBe('again');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('three');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cache.test.ts`
Expected: FAIL — `Failed to resolve import "../src/cache.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/cache.ts`:

```ts
// Function-typed properties, not methods: destructuring a method trips unbound-method.
export interface TtlCache<V> {
  /** The value, or `undefined` when there is none or it has expired. */
  get: (key: string) => V | undefined;
  set: (key: string, value: V, ttlMs: number) => void;
}

export interface TtlCacheOptions {
  /** The most entries to keep. The oldest go first. Defaults to 200. */
  maxEntries?: number;
  /** Milliseconds from a monotonic clock. Defaults to `performance.now`. */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 200;

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * A cache whose entries expire. It starts no timers: an entry is dropped when it is read after
 * its time, and `set` sweeps the expired ones, so keys nobody reads again do not pile up.
 */
export function createTtlCache<V>(options: TtlCacheOptions = {}): TtlCache<V> {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = options.now ?? (() => performance.now());
  const entries = new Map<string, Entry<V>>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (now() >= entry.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },

    set(key, value, ttlMs) {
      const time = now();
      for (const [other, entry] of entries) {
        if (time >= entry.expiresAt) entries.delete(other);
      }
      // Deleted first, so a re-set entry moves to the end and is evicted last.
      entries.delete(key);
      entries.set(key, { value, expiresAt: time + ttlMs });
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(oldest);
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/cache.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify and commit**

```bash
npx prettier --write src/cache.ts test/cache.test.ts
npm run lint && npm run typecheck
git add src/cache.ts test/cache.test.ts
git commit -m "$(cat <<'EOF'
Add a bounded cache whose entries expire

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: The catalog reader

**Files:**

- Create: `src/printify/catalog.ts`, `test/fixtures/catalog.ts`, `test/printify/catalog.test.ts`
- Modify: `src/printify/errors.ts` (widen the `problem` union of `invalidResponseError`)

**Interfaces:**

- Consumes: `createTtlCache` (Task 1); `PrintifyClient.request(method, path, { query, signal })`, `apiPath`, `invalidResponseError` from the existing `src/printify/`.
- Produces: `createCatalog(client: PrintifyClient, options?: { now?: () => number }): Catalog` with `allBlueprints`, `blueprint`, `blueprintProviders`, `printProviders`, `printProvider`, `variants`, `shipping`; the types `Blueprint`, `BlueprintProvider`, `PrintProvider`, `PrintProviderDetail`, `Variant`, `VariantList`, `Shipping`, `Location`; the constants `STABLE_TTL_MS` (24 h) and `VOLATILE_TTL_MS` (1 h). Tasks 3–7 use these. The fixtures `BLUEPRINT`, `BLUEPRINTS`, `BLUEPRINT_PROVIDERS`, `LOCATION`, `PRINT_PROVIDERS`, `PRINT_PROVIDER`, `printProviderWith`, `variant`, `VARIANTS`, `VARIANTS_WITH_OUT_OF_STOCK`, `SHIPPING` are used by Tasks 4–7.

- [ ] **Step 1: Write the fixtures**

These are not a test; they are the documented response examples from https://developers.printify.com/#catalog. Create `test/fixtures/catalog.ts`:

```ts
/** Catalog fixtures, built from the examples in https://developers.printify.com/#catalog. */

export const BLUEPRINT = {
  id: 3,
  title: 'Kids Regular Fit Tee',
  description: 'Description goes here',
  brand: 'Delta',
  model: '11736',
  images: [
    'https://images.printify.com/5853fe7dce46f30f8327f5cd',
    'https://images.printify.com/5c487ee2a342bc9b8b2fc4d2',
  ],
  tags: ['Early Access'],
};

/** The list leaves out `tags`. */
export const BLUEPRINTS = [
  {
    id: BLUEPRINT.id,
    title: BLUEPRINT.title,
    description: BLUEPRINT.description,
    brand: BLUEPRINT.brand,
    model: BLUEPRINT.model,
    images: BLUEPRINT.images,
  },
  {
    id: 5,
    title: "Men's Cotton Crew Tee",
    description: 'Description goes here',
    brand: 'Next Level',
    model: '3600',
    images: ['https://images.printify.com/5a2ffc81b8e7e3656268fb44'],
  },
];

export function blueprint(overrides: Partial<typeof BLUEPRINT> = {}): typeof BLUEPRINT {
  return { ...BLUEPRINT, ...overrides };
}

export const BLUEPRINT_PROVIDERS = [
  { id: 3, title: 'DJ', decoration_methods: ['dtg', 'embroidery'] },
  { id: 24, title: 'Inklocker', decoration_methods: ['dtf', 'dtg', 'embroidery'] },
];

export const LOCATION = {
  address1: '89 Weirfield St',
  address2: null,
  city: 'Brooklyn',
  country: 'US',
  region: 'NY',
  zip: '11221-5120',
};

export const PRINT_PROVIDERS = [
  { id: 3, title: 'DJ', location: LOCATION },
  { id: 24, title: 'Inklocker', location: { ...LOCATION, address2: '', city: 'Charlotte' } },
];

export const PROVIDER_BLUEPRINT = {
  id: 265,
  title: 'Slim Iphone 8',
  brand: 'Case Mate',
  model: 'Slim Iphone 8',
  images: ['https://images.printify.com/59b261c9b8e7e361c9147b1b.png'],
};

export const PRINT_PROVIDER = {
  id: 3,
  title: 'DJ',
  location: LOCATION,
  blueprints: [PROVIDER_BLUEPRINT, { ...PROVIDER_BLUEPRINT, id: 52, title: 'Slim Iphone 6/6s' }],
};

/** A provider offering `count` blueprints, for the truncation cases. */
export function printProviderWith(count: number): typeof PRINT_PROVIDER {
  return {
    ...PRINT_PROVIDER,
    blueprints: Array.from({ length: count }, (_item, index) => ({
      ...PROVIDER_BLUEPRINT,
      id: 1000 + index,
      title: `Blueprint ${String(index)}`,
    })),
  };
}

const PLACEHOLDERS = [
  { position: 'back', decoration_method: 'dtf', height: 3995, width: 3153 },
  { position: 'front', decoration_method: 'embroidery', height: 3995, width: 3153 },
];

export function variant(
  id: number,
  color: string,
  size: string,
): {
  id: number;
  title: string;
  options: Record<string, string>;
  placeholders: typeof PLACEHOLDERS;
  decoration_methods: string[];
} {
  return {
    id,
    title: `${color} / ${size}`,
    options: { color, size },
    placeholders: PLACEHOLDERS,
    decoration_methods: ['dtf', 'embroidery'],
  };
}

/** The variants in stock: the provider's id and title, not the blueprint's. */
export const VARIANTS = {
  id: 3,
  title: 'DJ',
  variants: [
    variant(17390, 'Heather Grey', 'XS'),
    variant(17391, 'Heather Grey', 'S'),
    variant(17426, 'Solid Black', 'XS'),
  ],
};

/** `show-out-of-stock=1` adds one variant, in a color the in-stock list does not have. */
export const VARIANTS_WITH_OUT_OF_STOCK = {
  ...VARIANTS,
  variants: [...VARIANTS.variants, variant(17427, 'Solid White', 'S')],
};

export const SHIPPING = {
  handling_time: { value: 30, unit: 'day' },
  profiles: [
    {
      variant_ids: [17390, 17391, 17426],
      first_item: { cost: 450, currency: 'USD' },
      additional_items: { cost: 0, currency: 'USD' },
      countries: ['US'],
    },
    {
      variant_ids: [17390, 17391, 17426],
      first_item: { cost: 1100, currency: 'USD' },
      additional_items: { cost: 0, currency: 'USD' },
      countries: ['REST_OF_THE_WORLD'],
    },
  ],
};
```

- [ ] **Step 2: Write the failing test**

Create `test/printify/catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  createCatalog,
  STABLE_TTL_MS,
  VOLATILE_TTL_MS,
  type Catalog,
} from '../../src/printify/catalog.js';
import { createPrintifyClient } from '../../src/printify/client.js';
import { Secret } from '../../src/secret.js';
import {
  BLUEPRINT,
  BLUEPRINTS,
  BLUEPRINT_PROVIDERS,
  PRINT_PROVIDER,
  PRINT_PROVIDERS,
  SHIPPING,
  VARIANTS,
  VARIANTS_WITH_OUT_OF_STOCK,
} from '../fixtures/catalog.js';
import { notFoundBody } from '../fixtures/errors.js';
import { createFakeApi, json, never, type FakeApi, type Routes } from '../support/fake-api.js';
import { apiError } from './helpers.js';

const TOKEN = 'Tok-catalog-7H6g5F4e';
const VARIANTS_PATH = '/v1/catalog/blueprints/3/print_providers/29/variants.json';
const SHIPPING_PATH = '/v1/catalog/blueprints/3/print_providers/29/shipping.json';

/** A catalog over a real client and a fake API, with a clock the test moves. */
function testCatalog(routes: Routes = {}): {
  catalog: Catalog;
  api: FakeApi;
  tick: (ms: number) => void;
} {
  const api = createFakeApi(routes);
  const client = createPrintifyClient({
    token: new Secret(TOKEN),
    baseUrl: 'https://api.printify.com',
    fetch: api.fetch,
  });
  let time = 0;
  return {
    catalog: createCatalog(client, { now: () => time }),
    api,
    tick(ms) {
      time += ms;
    },
  };
}

const signal = () => new AbortController().signal;

describe('createCatalog', () => {
  it('reads every documented path', async () => {
    const { catalog, api } = testCatalog({
      'GET /v1/catalog/blueprints.json': BLUEPRINTS,
      'GET /v1/catalog/blueprints/3.json': BLUEPRINT,
      'GET /v1/catalog/blueprints/3/print_providers.json': BLUEPRINT_PROVIDERS,
      'GET /v1/catalog/print_providers.json': PRINT_PROVIDERS,
      'GET /v1/catalog/print_providers/3.json': PRINT_PROVIDER,
      [`GET ${VARIANTS_PATH}`]: VARIANTS,
      [`GET ${SHIPPING_PATH}`]: SHIPPING,
    });

    expect(await catalog.allBlueprints(signal())).toHaveLength(2);
    expect((await catalog.blueprint(3, signal())).tags).toEqual(['Early Access']);
    expect(await catalog.blueprintProviders(3, signal())).toHaveLength(2);
    expect(await catalog.printProviders(signal())).toHaveLength(2);
    expect((await catalog.printProvider(3, signal())).blueprints).toHaveLength(2);
    expect(
      (await catalog.variants(3, 29, { showOutOfStock: false }, signal())).variants,
    ).toHaveLength(3);
    expect((await catalog.shipping(3, 29, signal())).profiles).toHaveLength(2);

    // The v1 shipping path includes the print provider id; openapi.json drops it.
    api.expectRequest('GET', SHIPPING_PATH);
    expect(api.requests).toHaveLength(7);
  });

  it('sends the caller signal with the request', async () => {
    const { catalog, api } = testCatalog({
      'GET /v1/catalog/print_providers.json': PRINT_PROVIDERS,
    });
    const controller = new AbortController();

    await catalog.printProviders(controller.signal);

    const sent = api.expectRequest('GET', '/v1/catalog/print_providers.json');
    expect(sent.signal.aborted).toBe(false);
    controller.abort();
    expect(sent.signal.aborted).toBe(true);
  });

  it('asks for out-of-stock variants only when told to', async () => {
    const { catalog, api } = testCatalog({
      [`GET ${VARIANTS_PATH}`]: (request) =>
        request.query['show-out-of-stock'] === '1' ? VARIANTS_WITH_OUT_OF_STOCK : VARIANTS,
    });

    const inStock = await catalog.variants(3, 29, { showOutOfStock: false }, signal());
    const all = await catalog.variants(3, 29, { showOutOfStock: true }, signal());

    expect(inStock.variants).toHaveLength(3);
    expect(all.variants).toHaveLength(4);
    expect(api.requests.map((sent) => sent.query)).toEqual([{}, { 'show-out-of-stock': '1' }]);
  });

  it('answers a second call from the cache', async () => {
    const { catalog, api } = testCatalog({ 'GET /v1/catalog/blueprints/3.json': BLUEPRINT });

    const first = await catalog.blueprint(3, signal());
    const second = await catalog.blueprint(3, signal());

    expect(second).toBe(first);
    api.expectRequest('GET', '/v1/catalog/blueprints/3.json');
  });

  it('fetches again once the blueprint entry is 24 h old', async () => {
    const { catalog, api, tick } = testCatalog({ 'GET /v1/catalog/blueprints/3.json': BLUEPRINT });

    await catalog.blueprint(3, signal());
    tick(STABLE_TTL_MS - 1);
    await catalog.blueprint(3, signal());
    expect(api.requests).toHaveLength(1);

    tick(1);
    await catalog.blueprint(3, signal());
    expect(api.requests).toHaveLength(2);
  });

  it('fetches again once the variants entry is 1 h old', async () => {
    const { catalog, api, tick } = testCatalog({ [`GET ${VARIANTS_PATH}`]: VARIANTS });

    await catalog.variants(3, 29, { showOutOfStock: false }, signal());
    tick(VOLATILE_TTL_MS);
    await catalog.variants(3, 29, { showOutOfStock: false }, signal());

    expect(api.requests).toHaveLength(2);
  });

  it('caches each blueprint and each stock setting separately', async () => {
    const { catalog, api } = testCatalog({
      'GET /v1/catalog/blueprints/3.json': BLUEPRINT,
      'GET /v1/catalog/blueprints/5.json': { ...BLUEPRINT, id: 5 },
      [`GET ${VARIANTS_PATH}`]: (request) =>
        request.query['show-out-of-stock'] === '1' ? VARIANTS_WITH_OUT_OF_STOCK : VARIANTS,
    });

    await catalog.blueprint(3, signal());
    await catalog.blueprint(5, signal());
    await catalog.variants(3, 29, { showOutOfStock: false }, signal());
    await catalog.variants(3, 29, { showOutOfStock: true }, signal());

    expect(api.requests).toHaveLength(4);
  });

  it('does not cache a failed request', async () => {
    const { catalog, api } = testCatalog({
      'GET /v1/catalog/blueprints/3.json': json(notFoundBody(), 404),
    });

    const error = await apiError(catalog.blueprint(3, signal()));
    expect(error.status).toBe(404);

    await apiError(catalog.blueprint(3, signal()));
    expect(api.requests).toHaveLength(2);
  });

  it('does not cache an aborted request', async () => {
    const { catalog, api } = testCatalog({ 'GET /v1/catalog/blueprints/3.json': never() });
    const controller = new AbortController();

    const pending = catalog.blueprint(3, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);

    expect(api.requests).toHaveLength(1);
  });

  it('rejects a response that does not parse, and does not cache it', async () => {
    const { catalog, api } = testCatalog({ 'GET /v1/catalog/blueprints/3.json': { id: 'three' } });

    const error = await apiError(catalog.blueprint(3, signal()));
    expect(error.kind).toBe('invalid_response');
    expect(error.message).toContain('an unexpected catalog response');

    await apiError(catalog.blueprint(3, signal()));
    expect(api.requests).toHaveLength(2);
  });

  it('drops a field of the wrong type instead of failing the response', async () => {
    const { catalog } = testCatalog({
      'GET /v1/catalog/blueprints/3.json': { ...BLUEPRINT, title: 42, images: 'not an array' },
    });

    const parsed = await catalog.blueprint(3, signal());

    expect(parsed.title).toBeUndefined();
    expect(parsed.images).toBeUndefined();
    expect(parsed.brand).toBe('Delta');
  });

  it('fails a variant whose options are not strings', async () => {
    const { catalog } = testCatalog({
      [`GET ${VARIANTS_PATH}`]: {
        ...VARIANTS,
        variants: [{ ...VARIANTS.variants[0], options: { color: 7 } }],
      },
    });

    const error = await apiError(catalog.variants(3, 29, { showOutOfStock: false }, signal()));
    expect(error.kind).toBe('invalid_response');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/printify/catalog.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/printify/catalog.js"`.

- [ ] **Step 4: Widen the `invalidResponseError` problem union**

In `src/printify/errors.ts`, the `problem` parameter of `invalidResponseError`:

<!-- prettier-ignore -->
```ts
  problem:
    | 'a body that is not JSON'
    | 'an unexpected pagination envelope'
    | 'an unexpected catalog response',
```

- [ ] **Step 5: Write the implementation**

Create `src/printify/catalog.ts`:

```ts
import { z } from 'zod';
import { createTtlCache } from '../cache.js';
import type { PrintifyClient, Query } from './client.js';
import { invalidResponseError } from './errors.js';
import { apiPath, type ApiPath } from './path.js';

const HOUR_MS = 3_600_000;

/** Blueprints and print providers change rarely. */
export const STABLE_TTL_MS = 24 * HOUR_MS;
/** Variants carry stock, and shipping carries costs. */
export const VOLATILE_TTL_MS = HOUR_MS;

/** A field Printify may send as null, as the wrong type, or not at all. */
function lenient<T>(schema: z.ZodType<T>) {
  return schema
    .nullable()
    .catch(null)
    .transform((value) => value ?? undefined)
    .optional();
}

const lenientString = lenient(z.string());
const lenientNumber = lenient(z.number());
const lenientStrings = lenient(z.array(z.string()));

const blueprintSchema = z.object({
  id: z.number().int(),
  title: lenientString,
  brand: lenientString,
  model: lenientString,
  description: lenientString,
  images: lenientStrings,
  // Only the single-blueprint response has tags.
  tags: lenientStrings,
});

const blueprintListSchema = z.array(blueprintSchema);

const blueprintProviderSchema = z.object({
  id: z.number().int(),
  title: lenientString,
  decoration_methods: lenientStrings,
});

const blueprintProviderListSchema = z.array(blueprintProviderSchema);

const locationSchema = lenient(
  z.object({
    address1: lenientString,
    address2: lenientString,
    city: lenientString,
    region: lenientString,
    country: lenientString,
    zip: lenientString,
  }),
);

const printProviderSchema = z.object({
  id: z.number().int(),
  title: lenientString,
  location: locationSchema,
});

const printProviderListSchema = z.array(printProviderSchema);

const printProviderDetailSchema = printProviderSchema.extend({
  blueprints: z.array(
    z.object({
      id: z.number().int(),
      title: lenientString,
      brand: lenientString,
      model: lenientString,
    }),
  ),
});

const variantSchema = z.object({
  id: z.number().int(),
  title: lenientString,
  // Strict: the filters read these.
  options: z.record(z.string(), z.string()),
  placeholders: z.array(
    z.object({
      position: z.string(),
      decoration_method: lenientString,
      width: z.number(),
      height: z.number(),
    }),
  ),
});

const variantListSchema = z.object({
  // The print provider's id and title, not the blueprint's.
  id: lenientNumber,
  title: lenientString,
  variants: z.array(variantSchema),
});

const costSchema = z.object({ cost: z.number(), currency: z.string() });

const shippingSchema = z.object({
  handling_time: lenient(z.object({ value: z.number(), unit: z.string() })),
  profiles: z.array(
    z.object({
      variant_ids: z.array(z.number().int()),
      countries: z.array(z.string()),
      first_item: costSchema,
      additional_items: costSchema,
    }),
  ),
});

export type Blueprint = z.infer<typeof blueprintSchema>;
export type BlueprintProvider = z.infer<typeof blueprintProviderSchema>;
export type PrintProvider = z.infer<typeof printProviderSchema>;
export type PrintProviderDetail = z.infer<typeof printProviderDetailSchema>;
export type VariantList = z.infer<typeof variantListSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type Shipping = z.infer<typeof shippingSchema>;
export type Location = NonNullable<PrintProvider['location']>;

// Function-typed properties, not methods: destructuring a method trips unbound-method.
export interface Catalog {
  /** Every blueprint in the catalog. Cached for 24 h. */
  allBlueprints: (signal: AbortSignal) => Promise<readonly Blueprint[]>;
  /** One blueprint, with its tags. Cached for 24 h. */
  blueprint: (blueprintId: number, signal: AbortSignal) => Promise<Blueprint>;
  /** The print providers that can make a blueprint. Cached for 24 h. */
  blueprintProviders: (
    blueprintId: number,
    signal: AbortSignal,
  ) => Promise<readonly BlueprintProvider[]>;
  /** Every print provider, with locations. Cached for 24 h. */
  printProviders: (signal: AbortSignal) => Promise<readonly PrintProvider[]>;
  /** One print provider with the blueprints it offers. Cached for 24 h. */
  printProvider: (printProviderId: number, signal: AbortSignal) => Promise<PrintProviderDetail>;
  /** A provider's variants for a blueprint. Cached for 1 h, per stock setting. */
  variants: (
    blueprintId: number,
    printProviderId: number,
    options: { showOutOfStock: boolean },
    signal: AbortSignal,
  ) => Promise<VariantList>;
  /** A provider's shipping profiles for a blueprint. Cached for 1 h. */
  shipping: (
    blueprintId: number,
    printProviderId: number,
    signal: AbortSignal,
  ) => Promise<Shipping>;
}

export interface CatalogOptions {
  /** Passed to the cache. Defaults to `performance.now`. */
  now?: () => number;
}

/**
 * Reads the Printify catalog through `client` and caches what it parses, per process. Failures,
 * aborts and responses that do not parse are never cached. Cached values are shared by every
 * later caller, so callers must not change them.
 */
export function createCatalog(client: PrintifyClient, options: CatalogOptions = {}): Catalog {
  const cache = createTtlCache<unknown>({ now: options.now });

  async function fetchCached<T>(
    schema: z.ZodType<T>,
    path: ApiPath,
    ttlMs: number,
    signal: AbortSignal,
    query?: Query,
  ): Promise<T> {
    const key = cacheKey(path, query);
    const cached = cache.get(key);
    if (cached !== undefined) return cached as T;
    const body = await client.request('GET', path, { query, signal });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw invalidResponseError({ method: 'GET', path }, 200, 'an unexpected catalog response');
    }
    cache.set(key, parsed.data, ttlMs);
    return parsed.data;
  }

  return {
    allBlueprints(signal) {
      return fetchCached(
        blueprintListSchema,
        apiPath`/v1/catalog/blueprints.json`,
        STABLE_TTL_MS,
        signal,
      );
    },

    blueprint(blueprintId, signal) {
      return fetchCached(
        blueprintSchema,
        apiPath`/v1/catalog/blueprints/${blueprintId}.json`,
        STABLE_TTL_MS,
        signal,
      );
    },

    blueprintProviders(blueprintId, signal) {
      return fetchCached(
        blueprintProviderListSchema,
        apiPath`/v1/catalog/blueprints/${blueprintId}/print_providers.json`,
        STABLE_TTL_MS,
        signal,
      );
    },

    printProviders(signal) {
      return fetchCached(
        printProviderListSchema,
        apiPath`/v1/catalog/print_providers.json`,
        STABLE_TTL_MS,
        signal,
      );
    },

    printProvider(printProviderId, signal) {
      return fetchCached(
        printProviderDetailSchema,
        apiPath`/v1/catalog/print_providers/${printProviderId}.json`,
        STABLE_TTL_MS,
        signal,
      );
    },

    variants(blueprintId, printProviderId, { showOutOfStock }, signal) {
      return fetchCached(
        variantListSchema,
        apiPath`/v1/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`,
        VOLATILE_TTL_MS,
        signal,
        // Left out, the endpoint already lists only the variants in stock.
        showOutOfStock ? { 'show-out-of-stock': 1 } : undefined,
      );
    },

    shipping(blueprintId, printProviderId, signal) {
      return fetchCached(
        shippingSchema,
        apiPath`/v1/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/shipping.json`,
        VOLATILE_TTL_MS,
        signal,
      );
    },
  };
}

/** The path with the query as it is sent, so the two stock settings are separate entries. */
function cacheKey(path: ApiPath, query: Query | undefined): string {
  if (query === undefined) return path;
  const params = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]): [string, string] => [name, String(value)]),
  );
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run test/printify/catalog.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 7: Verify and commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck && npm test
git add src/printify/catalog.ts src/printify/errors.ts test/fixtures/catalog.ts test/printify/catalog.test.ts
git commit -m "$(cat <<'EOF'
Read and cache the Printify catalog

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: One catalog per process

**Files:**

- Modify: `src/tools/define.ts`, `src/cli.ts`, `test/support/harness.ts`, `test/tools/fixtures.ts`, `test/cli.test.ts`

**Interfaces:**

- Consumes: `createCatalog` (Task 2).
- Produces: `ToolServices.catalog: Catalog`, so `ctx.catalog` is available to every handler in Tasks 4–7.

- [ ] **Step 1: Write the failing test**

In `test/cli.test.ts`, next to the existing "creates one client" test, add the catalog spy. At the top, beside the existing `vi.mock('../src/printify/client.js', { spy: true });`:

<!-- prettier-ignore -->
```ts
import { createCatalog } from '../src/printify/catalog.js';
vi.mock('../src/printify/catalog.js', { spy: true });
```

Then the test itself (put it directly after the existing one-client test, inside the same `describe`):

```ts
it('creates one catalog for the process, however many servers it builds', () => {
  vi.mocked(createCatalog).mockClear();
  const io = testIo();

  main([], { PRINTIFY_API_TOKEN: TOKEN }, io);
  io.factory?.();
  io.factory?.();

  expect(createCatalog).toHaveBeenCalledTimes(1);
});
```

Use whatever the file's existing one-client test uses to capture the factory and call it twice; mirror that test line for line and change only the spy and the assertion.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL — `expected "createCatalog" to be called 1 times, but got 0 times`.

- [ ] **Step 3: Add `catalog` to the services**

In `src/tools/define.ts`, add the import and the field:

<!-- prettier-ignore -->
```ts
import type { Catalog } from '../printify/catalog.js';
```

<!-- prettier-ignore -->
```ts
export interface ToolServices {
  client: PrintifyClient;
  config: Config;
  log: Logger;
  /** The catalog reader and its cache, one per process. */
  catalog: Catalog;
}
```

In `src/cli.ts`, add the import and build it next to the client:

<!-- prettier-ignore -->
```ts
import { createCatalog } from './printify/catalog.js';
```

<!-- prettier-ignore -->
```ts
  const client = createPrintifyClient({ token: config.token, baseUrl: config.apiBaseUrl });
  const services: ToolServices = { client, config, log, catalog: createCatalog(client) };
```

In `test/support/harness.ts`, the same for the server the harness builds:

<!-- prettier-ignore -->
```ts
import { createCatalog } from '../../src/printify/catalog.js';
```

<!-- prettier-ignore -->
```ts
  const server = createServer({
    tools: selection.enabled,
    services: { client, config, log, catalog: createCatalog(client) },
```

In `test/tools/fixtures.ts`, `fixtureServices` needs the client in a variable, because the catalog takes it:

<!-- prettier-ignore -->
```ts
  const config = fixtureConfig();
  const client = createPrintifyClient({
    token: config.token,
    baseUrl: config.apiBaseUrl,
    fetch: api.fetch,
  });
  const services: ToolServices = {
    client,
    catalog: createCatalog(client),
    config,
```

(plus `import { createCatalog } from '../../src/printify/catalog.js';`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — every existing test plus the new one. If a test file fails to compile because it builds `ToolServices` by hand, add `catalog: createCatalog(client)` there too.

- [ ] **Step 5: Verify and commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck && npm test
git add src/tools/define.ts src/cli.ts test/support/harness.ts test/tools/fixtures.ts test/cli.test.ts
git commit -m "$(cat <<'EOF'
Share one catalog across every server of the process

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The toolset, wired in, with `get_blueprint`

**Files:**

- Create: `src/tools/catalog.ts`, `test/tools/catalog-toolset.test.ts`
- Modify: `src/tools/index.ts`, `test/tools/catalog.test.ts`

**Interfaces:**

- Consumes: `ctx.catalog` (Task 3); `defineTool`, `ToolAnnotations`, `Tool` from `src/tools/define.js`; `omitKeys` from `src/tools/shape.js`; the fixtures from Task 2.
- Produces: `getBlueprintTool`, `catalogTools`, `PROVIDER_BLUEPRINT_LIMIT = 50`, the module-level `READ_ONLY` annotations, and the `blueprintId` / `printProviderId` input fields. Tasks 5–7 add their tools to the same file and append them to `catalogTools`. `TOOLS_BY_TOOLSET` is introduced here.

**Note on #7:** if `feat/7-shops` has already merged, `src/tools/index.ts` and `test/tools/catalog.test.ts` already hold `TOOLS_BY_TOOLSET` and its per-key check. Then this task only changes `catalog: []` to `catalog: catalogTools` and skips the rest of Step 3 and Step 1's second test.

- [ ] **Step 1: Write the failing tests**

In `test/tools/catalog.test.ts`, replace the file with:

```ts
import { describe, expect, it } from 'vitest';
import { toolProblems } from '../../src/tools/check.js';
import { ALL_TOOLS, TOOLS_BY_TOOLSET } from '../../src/tools/index.js';

describe('ALL_TOOLS', () => {
  it('follows every rule for tool definitions', () => {
    expect(toolProblems(ALL_TOOLS)).toEqual([]);
  });

  it('files every tool under its own toolset', () => {
    const misfiled = Object.entries(TOOLS_BY_TOOLSET).flatMap(([toolset, tools]) =>
      tools.filter((tool) => tool.toolset !== toolset).map((tool) => `${tool.name}: ${toolset}`),
    );
    expect(misfiled).toEqual([]);
  });
});
```

Create `test/tools/catalog-toolset.test.ts` with the shared header and the `get_blueprint` block:

```ts
import { describe, expect, it } from 'vitest';
import { PROVIDER_BLUEPRINT_LIMIT } from '../../src/tools/catalog.js';
import {
  BLUEPRINT,
  BLUEPRINT_PROVIDERS,
  PRINT_PROVIDER,
  PRINT_PROVIDERS,
  SHIPPING,
  VARIANTS,
  VARIANTS_WITH_OUT_OF_STOCK,
  printProviderWith,
} from '../fixtures/catalog.js';
import { notFoundBody } from '../fixtures/errors.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { json, type Routes } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';

const BLUEPRINT_PATH = '/v1/catalog/blueprints/3.json';
const BLUEPRINT_PROVIDERS_PATH = '/v1/catalog/blueprints/3/print_providers.json';
const PROVIDERS_PATH = '/v1/catalog/print_providers.json';
const PROVIDER_PATH = '/v1/catalog/print_providers/3.json';
const VARIANTS_PATH = '/v1/catalog/blueprints/3/print_providers/29/variants.json';
const SHIPPING_PATH = '/v1/catalog/blueprints/3/print_providers/29/shipping.json';

/** The variants route answers by query: a route key cannot carry one. */
const VARIANT_ROUTES: Routes = {
  [`GET ${VARIANTS_PATH}`]: (request) =>
    request.query['show-out-of-stock'] === '1' ? VARIANTS_WITH_OUT_OF_STOCK : VARIANTS,
};

describe('get_blueprint', () => {
  it('returns the blueprint without its images', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${BLUEPRINT_PATH}`]: BLUEPRINT },
    });

    const result = await call('get_blueprint', { blueprint_id: 3 });

    expect(expectToolData(result)).toEqual({
      id: 3,
      title: 'Kids Regular Fit Tee',
      description: 'Description goes here',
      brand: 'Delta',
      model: '11736',
      tags: ['Early Access'],
    });
    api.expectRequest('GET', BLUEPRINT_PATH);
  });

  it('returns the images when asked', async () => {
    const { call } = await createTestServer({ routes: { [`GET ${BLUEPRINT_PATH}`]: BLUEPRINT } });

    const result = await call('get_blueprint', { blueprint_id: 3, include_images: true });

    expect(expectToolData(result).images).toEqual(BLUEPRINT.images);
  });

  it('answers a second call from the cache', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${BLUEPRINT_PATH}`]: BLUEPRINT },
    });

    await call('get_blueprint', { blueprint_id: 3 });
    await call('get_blueprint', { blueprint_id: 3 });

    api.expectRequest('GET', BLUEPRINT_PATH);
  });

  it('reports an unknown blueprint as a 404', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${BLUEPRINT_PATH}`]: json(notFoundBody(), 404) },
    });

    const result = await call('get_blueprint', { blueprint_id: 3 });

    expectToolError(result, { kind: 'http', status: 404 });
  });
});
```

The unused imports (`BLUEPRINT_PROVIDERS`, `VARIANTS`, …) are filled in by Tasks 5–7. Until then, lint will flag them, so **add them as each task needs them** rather than all at once: for this task import only `BLUEPRINT`, `notFoundBody`, `expectToolData`, `expectToolError`, `json`, `createTestServer`, `PROVIDER_BLUEPRINT_LIMIT` is not needed yet either. Keep the path constants and `VARIANT_ROUTES` for later tasks, adding each when its first test arrives.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tools/catalog-toolset.test.ts test/tools/catalog.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/tools/catalog.js"`, and `TOOLS_BY_TOOLSET` is not exported.

- [ ] **Step 3: Write the implementation**

Create `src/tools/catalog.ts`:

```ts
import { z } from 'zod';
import { defineTool, type Tool, type ToolAnnotations } from './define.js';
import { omitKeys } from './shape.js';

/** The blueprints `get_print_provider` lists before it truncates. */
export const PROVIDER_BLUEPRINT_LIMIT = 50;

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

const blueprintId = z
  .number()
  .int()
  .positive()
  .describe('The catalog blueprint id, e.g. from get_print_provider.');

const printProviderId = z
  .number()
  .int()
  .positive()
  .describe('The print provider id, e.g. from list_blueprint_providers.');

export const getBlueprintTool = defineTool({
  name: 'get_blueprint',
  toolset: 'catalog',
  description:
    'Gets one catalog blueprint (a product template such as a t-shirt or a mug) by id: its ' +
    'title, brand, model, description and tags. Next, list_blueprint_providers shows who can ' +
    'print it.',
  annotations: READ_ONLY,
  input: z.strictObject({
    blueprint_id: blueprintId,
    include_images: z
      .boolean()
      .default(false)
      .describe("Also return the blueprint's catalog photos as URLs."),
  }),
  handler: async (input, ctx) => {
    const blueprint = await ctx.catalog.blueprint(input.blueprint_id, ctx.signal);
    return input.include_images ? { ...blueprint } : omitKeys(blueprint, ['images']);
  },
});

/** Every tool of the `catalog` toolset, in the order the drill-down uses them. */
export const catalogTools: readonly Tool[] = [getBlueprintTool];
```

`printProviderId` is unused until Task 5; add it in that task instead if lint complains now.

Replace `src/tools/index.ts` with:

```ts
import { TOOLSETS, type Toolset } from '../toolsets.js';
import { catalogTools } from './catalog.js';
import type { Tool } from './define.js';

/** Each toolset's tools. A toolset issue fills in its own line. */
export const TOOLS_BY_TOOLSET: Readonly<Record<Toolset, readonly Tool[]>> = {
  shops: [],
  catalog: catalogTools,
  uploads: [],
  products: [],
  publishing: [],
  personalization: [],
  orders: [],
  support: [],
  webhooks: [],
  workflows: [],
};

/** Every tool the server can offer, in `TOOLSETS` order. */
export const ALL_TOOLS: readonly Tool[] = TOOLSETS.flatMap((toolset) => TOOLS_BY_TOOLSET[toolset]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. `test/cli.test.ts` mocks `ALL_TOOLS`, so its counts do not move.

- [ ] **Step 5: Verify and commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck && npm test
git add src/tools/catalog.ts src/tools/index.ts test/tools/catalog-toolset.test.ts test/tools/catalog.test.ts
git commit -m "$(cat <<'EOF'
Offer the catalog toolset, starting with get_blueprint

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `list_blueprint_providers` and `list_print_providers`

**Files:**

- Modify: `src/tools/catalog.ts`, `test/tools/catalog-toolset.test.ts`

**Interfaces:**

- Consumes: `ctx.catalog.blueprintProviders`, `ctx.catalog.printProviders`, the `Location` type (Task 2); `blueprintId` and `READ_ONLY` (Task 4).
- Produces: `listBlueprintProvidersTool`, `listPrintProvidersTool`, and the private `shortLocation(location)` helper the two share.

- [ ] **Step 1: Write the failing tests**

Add to `test/tools/catalog-toolset.test.ts` (and add `BLUEPRINT_PROVIDERS` and `PRINT_PROVIDERS` to its fixture import):

```ts
describe('list_blueprint_providers', () => {
  it('adds each provider location from the provider list', async () => {
    const { call, api } = await createTestServer({
      routes: {
        [`GET ${BLUEPRINT_PROVIDERS_PATH}`]: BLUEPRINT_PROVIDERS,
        [`GET ${PROVIDERS_PATH}`]: PRINT_PROVIDERS,
      },
    });

    const result = await call('list_blueprint_providers', { blueprint_id: 3 });

    expect(expectToolData(result)).toEqual({
      blueprint_id: 3,
      print_providers: [
        {
          id: 3,
          title: 'DJ',
          decoration_methods: ['dtg', 'embroidery'],
          location: { city: 'Brooklyn', region: 'NY', country: 'US' },
        },
        {
          id: 24,
          title: 'Inklocker',
          decoration_methods: ['dtf', 'dtg', 'embroidery'],
          location: { city: 'Charlotte', region: 'NY', country: 'US' },
        },
      ],
    });
    api.expectRequest('GET', BLUEPRINT_PROVIDERS_PATH);
    api.expectRequest('GET', PROVIDERS_PATH);
  });

  it('leaves out the location of a provider the list does not have', async () => {
    const { call } = await createTestServer({
      routes: {
        [`GET ${BLUEPRINT_PROVIDERS_PATH}`]: BLUEPRINT_PROVIDERS,
        [`GET ${PROVIDERS_PATH}`]: [PRINT_PROVIDERS[0]],
      },
    });

    const result = await call('list_blueprint_providers', { blueprint_id: 3 });

    const providers = expectToolData(result).print_providers as { location?: unknown }[];
    expect(providers[0]?.location).toEqual({ city: 'Brooklyn', region: 'NY', country: 'US' });
    expect(providers[1]).not.toHaveProperty('location');
  });
});

describe('list_print_providers', () => {
  it('lists every provider with a short location', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${PROVIDERS_PATH}`]: PRINT_PROVIDERS },
    });

    const result = await call('list_print_providers');

    expect(expectToolData(result)).toEqual({
      print_providers: [
        { id: 3, title: 'DJ', location: { city: 'Brooklyn', region: 'NY', country: 'US' } },
        {
          id: 24,
          title: 'Inklocker',
          location: { city: 'Charlotte', region: 'NY', country: 'US' },
        },
      ],
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tools/catalog-toolset.test.ts`
Expected: FAIL — `Tool list_blueprint_providers not found` (the MCP client rejects an unknown tool name).

- [ ] **Step 3: Write the implementation**

In `src/tools/catalog.ts`, add the import of the `Location` type:

<!-- prettier-ignore -->
```ts
import type { Location } from '../printify/catalog.js';
```

Add both tools after `getBlueprintTool`:

```ts
export const listBlueprintProvidersTool = defineTool({
  name: 'list_blueprint_providers',
  toolset: 'catalog',
  description:
    "Lists the print providers that can make a blueprint, with each one's decoration methods " +
    '(such as dtg or embroidery) and location. Pick a provider, then use list_variants for its ' +
    'sizes and colors and get_shipping_info for its shipping costs.',
  annotations: READ_ONLY,
  input: z.strictObject({ blueprint_id: blueprintId }),
  handler: async (input, ctx) => {
    // The blueprint's providers carry no location, so they are joined with the provider list.
    const [providers, directory] = await Promise.all([
      ctx.catalog.blueprintProviders(input.blueprint_id, ctx.signal),
      ctx.catalog.printProviders(ctx.signal),
    ]);
    const locations = new Map(directory.map((provider) => [provider.id, provider.location]));
    return {
      blueprint_id: input.blueprint_id,
      print_providers: providers.map((provider) => ({
        ...provider,
        location: shortLocation(locations.get(provider.id)),
      })),
    };
  },
});

export const listPrintProvidersTool = defineTool({
  name: 'list_print_providers',
  toolset: 'catalog',
  description:
    'Lists every Printify print provider with its id, name and location. To find the providers ' +
    'that can make a particular product, use list_blueprint_providers instead.',
  annotations: READ_ONLY,
  input: z.strictObject({}),
  handler: async (_input, ctx) => {
    const providers = await ctx.catalog.printProviders(ctx.signal);
    return {
      print_providers: providers.map((provider) => ({
        id: provider.id,
        title: provider.title,
        location: shortLocation(provider.location),
      })),
    };
  },
});
```

And the helper, at the bottom of the file:

```ts
/** Where the provider is, without the street address the model has no use for. */
function shortLocation(location: Location | undefined) {
  if (location === undefined) return undefined;
  return { city: location.city, region: location.region, country: location.country };
}
```

Append both to the exported array:

<!-- prettier-ignore -->
```ts
export const catalogTools: readonly Tool[] = [
  getBlueprintTool,
  listBlueprintProvidersTool,
  listPrintProvidersTool,
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Verify and commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck && npm test
git add src/tools/catalog.ts test/tools/catalog-toolset.test.ts
git commit -m "$(cat <<'EOF'
List print providers, with where they are

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `list_variants`

**Files:**

- Modify: `src/tools/catalog.ts`, `test/tools/catalog-toolset.test.ts`

**Interfaces:**

- Consumes: `ctx.catalog.variants`, the `Variant` and `VariantList` types (Task 2); `blueprintId`, `printProviderId`, `READ_ONLY` (Task 4).
- Produces: `listVariantsTool`, and the private helpers `matchesOption(variant, option, wanted)` and `optionValues(variants)`.

- [ ] **Step 1: Write the failing tests**

Add to `test/tools/catalog-toolset.test.ts` (adding `VARIANTS` and `VARIANTS_WITH_OUT_OF_STOCK` to the fixture import; `VARIANT_ROUTES` and `VARIANTS_PATH` are already in the header from Task 4):

```ts
describe('list_variants', () => {
  it('lists the variants in stock, with their print positions', async () => {
    const { call, api } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', { blueprint_id: 3, print_provider_id: 29 });

    expect(expectToolData(result)).toEqual({
      print_provider: { id: 3, title: 'DJ' },
      total_variants: 3,
      variant_count: 3,
      option_values: { color: ['Heather Grey', 'Solid Black'], size: ['XS', 'S'] },
      variants: [
        {
          id: 17390,
          title: 'Heather Grey / XS',
          options: { color: 'Heather Grey', size: 'XS' },
          placeholders: [
            { position: 'back', decoration_method: 'dtf', height: 3995, width: 3153 },
            { position: 'front', decoration_method: 'embroidery', height: 3995, width: 3153 },
          ],
        },
        {
          id: 17391,
          title: 'Heather Grey / S',
          options: { color: 'Heather Grey', size: 'S' },
          placeholders: [
            { position: 'back', decoration_method: 'dtf', height: 3995, width: 3153 },
            { position: 'front', decoration_method: 'embroidery', height: 3995, width: 3153 },
          ],
        },
        {
          id: 17426,
          title: 'Solid Black / XS',
          options: { color: 'Solid Black', size: 'XS' },
          placeholders: [
            { position: 'back', decoration_method: 'dtf', height: 3995, width: 3153 },
            { position: 'front', decoration_method: 'embroidery', height: 3995, width: 3153 },
          ],
        },
      ],
    });
    expect(api.expectRequest('GET', VARIANTS_PATH).query).toEqual({});
  });

  it('filters by color, ignoring case and spaces', async () => {
    const { call } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      colors: ['  solid BLACK '],
    });

    const data = expectToolData(result);
    expect(data.variant_count).toBe(1);
    expect(data.total_variants).toBe(3);
    expect((data.variants as { id: number }[]).map((variant) => variant.id)).toEqual([17426]);
  });

  it('filters by size, and by color and size together', async () => {
    const { call } = await createTestServer({ routes: VARIANT_ROUTES });

    const bySize = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      sizes: ['xs'],
    });
    expect((expectToolData(bySize).variants as { id: number }[]).map((item) => item.id)).toEqual([
      17390, 17426,
    ]);

    const byBoth = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      colors: ['Heather Grey'],
      sizes: ['S'],
    });
    expect((expectToolData(byBoth).variants as { id: number }[]).map((item) => item.id)).toEqual([
      17391,
    ]);
  });

  it('keeps option_values when a filter matches nothing', async () => {
    const { call } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      colors: ['black'],
    });

    const data = expectToolData(result);
    expect(data.variant_count).toBe(0);
    expect(data.variants).toEqual([]);
    expect(data.option_values).toEqual({
      color: ['Heather Grey', 'Solid Black'],
      size: ['XS', 'S'],
    });
  });

  it('marks every variant in_stock when out-of-stock variants are included', async () => {
    const { call, api } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      show_out_of_stock: true,
    });

    const variants = expectToolData(result).variants as { id: number; in_stock: boolean }[];
    expect(variants.map((variant) => [variant.id, variant.in_stock])).toEqual([
      [17390, true],
      [17391, true],
      [17426, true],
      [17427, false],
    ]);
    expect(api.requests.map((sent) => sent.query)).toEqual([{ 'show-out-of-stock': '1' }, {}]);
  });

  it('says nothing about stock when the flag is off', async () => {
    const { call } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', { blueprint_id: 3, print_provider_id: 29 });

    expect(expectToolData(result).variants).not.toContainEqual(
      expect.objectContaining({ in_stock: expect.anything() as unknown }),
    );
  });

  it('rejects an empty colors list before any request', async () => {
    const { call, api } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      colors: [],
    });

    expectToolError(result, { kind: 'validation' });
    expect(api.requests).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tools/catalog-toolset.test.ts`
Expected: FAIL — `Tool list_variants not found`.

- [ ] **Step 3: Write the implementation**

In `src/tools/catalog.ts`, extend the type import to `import type { Location, Variant, VariantList } from '../printify/catalog.js';`, add the filter field builder next to the id fields:

```ts
const optionFilter = (option: string) =>
  z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .optional()
    .describe(
      `Only variants whose ${option} is one of these. Exact names, ignoring case and surrounding ` +
        `spaces; option_values lists every name.`,
    );
```

Add the tool:

```ts
export const listVariantsTool = defineTool({
  name: 'list_variants',
  toolset: 'catalog',
  description:
    'Lists the variants (the size and color combinations) a print provider offers for a ' +
    'blueprint. Each has the variant id that products and orders use, its options, and its ' +
    'print positions with their size in pixels. Filter with colors and sizes: exact names, ' +
    'ignoring case, and option_values lists every name. Only variants in stock are listed ' +
    'unless show_out_of_stock is set; then every variant says whether it is in_stock.',
  annotations: READ_ONLY,
  input: z.strictObject({
    blueprint_id: blueprintId,
    print_provider_id: printProviderId,
    colors: optionFilter('color'),
    sizes: optionFilter('size'),
    show_out_of_stock: z
      .boolean()
      .default(false)
      .describe('Also list the variants that are out of stock, marked in_stock: false.'),
  }),
  handler: async (input, ctx) => {
    const { blueprint_id: blueprint, print_provider_id: provider } = input;
    let list: VariantList;
    let inStockIds: Set<number> | undefined;
    if (input.show_out_of_stock) {
      const [all, inStock] = await Promise.all([
        ctx.catalog.variants(blueprint, provider, { showOutOfStock: true }, ctx.signal),
        ctx.catalog.variants(blueprint, provider, { showOutOfStock: false }, ctx.signal),
      ]);
      list = all;
      inStockIds = new Set(inStock.variants.map((variant) => variant.id));
    } else {
      list = await ctx.catalog.variants(blueprint, provider, { showOutOfStock: false }, ctx.signal);
    }

    const matched = list.variants.filter(
      (variant) =>
        matchesOption(variant, 'color', input.colors) &&
        matchesOption(variant, 'size', input.sizes),
    );
    return {
      print_provider: { id: list.id, title: list.title },
      total_variants: list.variants.length,
      variant_count: matched.length,
      option_values: optionValues(list.variants),
      variants: matched.map((variant) => ({
        id: variant.id,
        title: variant.title,
        options: variant.options,
        placeholders: variant.placeholders,
        in_stock: inStockIds === undefined ? undefined : inStockIds.has(variant.id),
      })),
    };
  },
});
```

And the two helpers at the bottom of the file:

```ts
/** True when no filter is set, or one of its values is the variant's option, ignoring case. */
function matchesOption(
  variant: Variant,
  option: string,
  wanted: readonly string[] | undefined,
): boolean {
  if (wanted === undefined) return true;
  const value = variant.options[option];
  if (value === undefined) return false;
  const normalised = value.trim().toLowerCase();
  return wanted.some((name) => name.trim().toLowerCase() === normalised);
}

/** Each option's distinct values, in the order Printify sends them. */
function optionValues(variants: readonly Variant[]): Record<string, string[]> {
  const values: Record<string, string[]> = {};
  for (const variant of variants) {
    for (const [option, value] of Object.entries(variant.options)) {
      const seen = (values[option] ??= []);
      if (!seen.includes(value)) seen.push(value);
    }
  }
  return values;
}
```

Put `listVariantsTool` into `catalogTools` after `listBlueprintProvidersTool`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Prove the filter and the stock marking are really tested**

Break each one and watch a test fail, then undo the break:

1. In `matchesOption`, replace the last line with `return wanted.some((name) => normalised.includes(name.trim().toLowerCase()));` → "keeps option_values when a filter matches nothing" must fail.
2. In the tool's result, replace `in_stock: inStockIds === undefined ? …` with `in_stock: inStockIds?.has(variant.id) ?? true,` → "says nothing about stock when the flag is off" must fail.

Run after each: `npx vitest run test/tools/catalog-toolset.test.ts`. Restore the code before moving on.

- [ ] **Step 6: Verify and commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck && npm test
git add src/tools/catalog.ts test/tools/catalog-toolset.test.ts
git commit -m "$(cat <<'EOF'
List a provider's variants, filtered and with stock

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: `get_shipping_info` and `get_print_provider`

**Files:**

- Modify: `src/tools/catalog.ts`, `test/tools/catalog-toolset.test.ts`

**Interfaces:**

- Consumes: `ctx.catalog.shipping`, `ctx.catalog.printProvider` (Task 2); `blueprintId`, `printProviderId`, `READ_ONLY`, `PROVIDER_BLUEPRINT_LIMIT` (Task 4).
- Produces: `getShippingInfoTool`, `getPrintProviderTool`, and the complete `catalogTools` array of six tools.

- [ ] **Step 1: Write the failing tests**

Add to `test/tools/catalog-toolset.test.ts` (adding `SHIPPING`, `PRINT_PROVIDER`, `printProviderWith` and `PROVIDER_BLUEPRINT_LIMIT` to the imports):

```ts
describe('get_shipping_info', () => {
  it('returns the handling time and the profiles', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${SHIPPING_PATH}`]: SHIPPING },
    });

    const result = await call('get_shipping_info', { blueprint_id: 3, print_provider_id: 29 });

    expect(expectToolData(result)).toEqual(SHIPPING);
    // The v1 shipping path includes the print provider id.
    api.expectRequest('GET', SHIPPING_PATH);
  });
});

describe('get_print_provider', () => {
  it('returns the provider with its address and blueprints', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${PROVIDER_PATH}`]: PRINT_PROVIDER },
    });

    const result = await call('get_print_provider', { print_provider_id: 3 });

    expect(expectToolData(result)).toEqual({
      id: 3,
      title: 'DJ',
      location: {
        address1: '89 Weirfield St',
        city: 'Brooklyn',
        region: 'NY',
        country: 'US',
        zip: '11221-5120',
      },
      blueprint_count: 2,
      blueprints: [
        { id: 265, title: 'Slim Iphone 8', brand: 'Case Mate', model: 'Slim Iphone 8' },
        { id: 52, title: 'Slim Iphone 6/6s', brand: 'Case Mate', model: 'Slim Iphone 8' },
      ],
    });
  });

  it('truncates a long blueprint list and says so', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${PROVIDER_PATH}`]: printProviderWith(60) },
    });

    const result = await call('get_print_provider', { print_provider_id: 3 });

    const data = expectToolData(result);
    expect(data.blueprint_count).toBe(60);
    expect(data.blueprints).toHaveLength(PROVIDER_BLUEPRINT_LIMIT);
    expect(data.blueprints_truncated).toBe(true);
  });

  it('says nothing about truncation when everything fits', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${PROVIDER_PATH}`]: printProviderWith(PROVIDER_BLUEPRINT_LIMIT) },
    });

    const result = await call('get_print_provider', { print_provider_id: 3 });

    const data = expectToolData(result);
    expect(data.blueprints).toHaveLength(PROVIDER_BLUEPRINT_LIMIT);
    expect(data).not.toHaveProperty('blueprints_truncated');
  });
});

describe('the catalog toolset', () => {
  it('offers six read-only tools', async () => {
    const { mcp } = await createTestServer();

    const { tools } = await mcp.listTools();

    const catalog = tools.filter((tool) =>
      [
        'get_blueprint',
        'list_blueprint_providers',
        'list_variants',
        'get_shipping_info',
        'list_print_providers',
        'get_print_provider',
      ].includes(tool.name),
    );
    expect(catalog).toHaveLength(6);
    for (const tool of catalog) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it('never sends image arrays unless they were asked for', async () => {
    const { call } = await createTestServer({
      routes: {
        [`GET ${BLUEPRINT_PATH}`]: BLUEPRINT,
        [`GET ${PROVIDER_PATH}`]: PRINT_PROVIDER,
        ...VARIANT_ROUTES,
      },
    });

    const results = [
      await call('get_blueprint', { blueprint_id: 3 }),
      await call('get_print_provider', { print_provider_id: 3 }),
      await call('list_variants', { blueprint_id: 3, print_provider_id: 29 }),
    ];

    for (const result of results) {
      expect(JSON.stringify(expectToolData(result))).not.toContain('images');
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tools/catalog-toolset.test.ts`
Expected: FAIL — `Tool get_shipping_info not found`, and the six-tool count is 4.

- [ ] **Step 3: Write the implementation**

Add both tools to `src/tools/catalog.ts`:

```ts
export const getShippingInfoTool = defineTool({
  name: 'get_shipping_info',
  toolset: 'catalog',
  description:
    "Gets a print provider's shipping costs and handling time for a blueprint. Each profile " +
    'covers a set of countries and variant ids; REST_OF_THE_WORLD covers every country no ' +
    'profile lists. Costs are in cents of currency (450 = 4.50 USD): first_item is charged for ' +
    'the first item of this blueprint and provider in an order, additional_items for every ' +
    'further one. The costs are not broken down by shipping method.',
  annotations: READ_ONLY,
  input: z.strictObject({ blueprint_id: blueprintId, print_provider_id: printProviderId }),
  handler: async (input, ctx) => {
    const shipping = await ctx.catalog.shipping(
      input.blueprint_id,
      input.print_provider_id,
      ctx.signal,
    );
    return { ...shipping };
  },
});

export const getPrintProviderTool = defineTool({
  name: 'get_print_provider',
  toolset: 'catalog',
  description:
    'Gets one print provider: its name, its address, and the blueprints it offers (id, title, ' +
    `brand and model). Only the first ${String(PROVIDER_BLUEPRINT_LIMIT)} blueprints are ` +
    'listed; blueprint_count gives the total.',
  annotations: READ_ONLY,
  input: z.strictObject({ print_provider_id: printProviderId }),
  handler: async (input, ctx) => {
    const provider = await ctx.catalog.printProvider(input.print_provider_id, ctx.signal);
    const truncated = provider.blueprints.length > PROVIDER_BLUEPRINT_LIMIT;
    return {
      id: provider.id,
      title: provider.title,
      location: provider.location,
      blueprint_count: provider.blueprints.length,
      blueprints: provider.blueprints.slice(0, PROVIDER_BLUEPRINT_LIMIT),
      blueprints_truncated: truncated ? true : undefined,
    };
  },
});
```

And complete the array:

<!-- prettier-ignore -->
```ts
export const catalogTools: readonly Tool[] = [
  getBlueprintTool,
  listBlueprintProvidersTool,
  listVariantsTool,
  getShippingInfoTool,
  listPrintProvidersTool,
  getPrintProviderTool,
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — 20 tests in `catalog-toolset.test.ts`.

- [ ] **Step 5: Prove the truncation is really tested**

Change the slice to `provider.blueprints.slice(0, PROVIDER_BLUEPRINT_LIMIT + 1)` and run
`npx vitest run test/tools/catalog-toolset.test.ts`: "truncates a long blueprint list and says so" must fail. Undo the change.

- [ ] **Step 6: Verify and commit**

```bash
npx prettier --write src test
npm run lint && npm run typecheck && npm test
git add src/tools/catalog.ts test/tools/catalog-toolset.test.ts
git commit -m "$(cat <<'EOF'
Get shipping profiles and one print provider

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Verify the branch and open the PR

**Files:** none changed unless a check fails.

**Interfaces:**

- Consumes: everything from Tasks 1–7.
- Produces: a pushed branch and a PR that closes #8.

- [ ] **Step 1: Run every check**

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: lint and typecheck silent, build silent, and roughly 428 tests passing (354 before this branch, plus 6 for the cache, 12 for the catalog reader, 20 for the toolset, 1 for the CLI and the new `TOOLS_BY_TOOLSET` check).

- [ ] **Step 2: Check the startup summary by hand**

```bash
PRINTIFY_API_TOKEN=Tok-example node dist/index.js < /dev/null
```

Expected on stderr: `printify-mcp: 0.0.0 on stdio (tools: 6 of 6; toolsets: all; …)`. Then:

```bash
PRINTIFY_API_TOKEN=Tok-example PRINTIFY_TOOLSETS=shops node dist/index.js < /dev/null
```

Expected: `tools: 0 of 6` and a skip line naming the six catalog tools.

- [ ] **Step 3: Rebase if #7 landed meanwhile**

```bash
git fetch origin
git rebase origin/main
npm ci && npm run lint && npm run typecheck && npm test
```

If #7 merged, the conflicts are in `src/tools/index.ts` (keep both toolset lines), `src/tools/define.ts` and `src/cli.ts` (keep both services), `test/support/harness.ts` and `test/tools/fixtures.ts` (keep both), and `test/tools/catalog.test.ts` (keep one copy of the per-key check).

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/8-catalog-toolset
gh pr create --title "Catalog toolset: blueprints, print providers, variants and shipping" --body "$(cat <<'EOF'
Closes #8

Adds the six read-only `catalog` tools on a per-process, TTL-cached catalog reader.

## What's in it

- `createTtlCache` (`src/cache.ts`): bounded, expiry on read, a sweep on write, no timers.
- `createCatalog` (`src/printify/catalog.ts`): one accessor per documented endpoint, zod-validated,
  cached 24 h (blueprints, providers) or 1 h (variants, shipping). Failures, aborts and
  unparseable responses are never cached. `allBlueprints()` is there for #17.
- Six tools (`src/tools/catalog.ts`): `get_blueprint`, `list_blueprint_providers`,
  `list_variants`, `get_shipping_info`, `list_print_providers`, `get_print_provider`.
- `ToolServices.catalog`, built once per process in `cli.ts`.

## Decisions worth a look

- `list_blueprint_providers` joins the cached provider list, because the endpoint carries no
  location and the issue's example prompt asks where the providers are.
- `show_out_of_stock` fetches both lists and marks every variant `in_stock`, because Printify's
  catalog variants carry no stock field.
- Filters match exact option names, ignoring case; `option_values` lists the names, so a missed
  filter can be corrected without fetching everything.
- The v1 shipping path keeps `{print_provider_id}`, which `openapi.json` and Postman drop.

Spec: `docs/superpowers/specs/2026-09-22-catalog-toolset-design.md`
Plan: `docs/superpowers/plans/2026-09-23-catalog-toolset.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
~/.claude/skills/updating-github-project-status/board.sh review
```

- [ ] **Step 5: Watch CI and post the hand-off comments**

```bash
gh pr checks --watch
```

Then comment on #9, #17 and #18 (and #7 if it has not merged) with what this branch gives them, as the spec's Delivery section lists.

---

## Self-review

**Spec coverage:** TTL cache → Task 1. Catalog service, schemas, TTLs, cache keys, error handling → Task 2. Wiring and one-per-process → Task 3. `ALL_TOOLS` composition and `get_blueprint` → Task 4. `list_blueprint_providers` with locations and `list_print_providers` → Task 5. `list_variants` with filters, `option_values` and stock marking → Task 6. `get_shipping_info` and `get_print_provider` truncation → Task 7. Acceptance criteria (harness tests per tool, filters, cache hits, no `images` unless asked) → Tasks 4–7. Delivery → Task 8.

**Types:** `Catalog`'s member names are used identically in Tasks 4–7 (`blueprint`, `blueprintProviders`, `printProviders`, `printProvider`, `variants`, `shipping`). `PROVIDER_BLUEPRINT_LIMIT` is defined in Task 4 and used in Task 7. `shortLocation` is introduced in Task 5 and used by both tools there. `Location`, `Variant` and `VariantList` come from Task 2.

**Not covered here, by design:** `search_blueprints` (#17), `get_print_areas` (#18), v2 shipping (#9), the README's tool reference (#21).
