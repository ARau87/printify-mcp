# Catalog shipping v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the two read-only `catalog` tools `list_shipping_methods` and `get_shipping_costs`
over Printify's v2 JSON:API shipping endpoints, so a model can answer "how much is economy shipping
to Germany for this variant" — which v1 cannot answer at all.

**Architecture:** Two new methods on the existing `Catalog` service fetch, validate and cache the
v2 responses (1 h, the TTL `shipping()` already uses), transforming them into flat `ShippingRow`s at
parse time. A pure `groupShippingProfiles` regroups those rows losslessly into the country-and-
variant profiles v1's `get_shipping_info` already returns, because a raw v2 response repeats the
same few rates once per variant per country. The two tools filter the cached rows, group them, and
shape the result.

**Tech Stack:** TypeScript ~6.0 (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`),
Zod 4, `@modelcontextprotocol/server` v2, Vitest, ESLint + Prettier. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-catalog-shipping-v2-design.md` — read it before Task 1.
It records which decisions deviate from issue #9 and why.

**Worktree:** `/Users/andreasrau/Desktop/projects/printify-mcp-worktrees/feat-9-catalog-shipping-v2`,
branch `feat/9-catalog-shipping-v2`, branched from `origin/main` at 94e8c6f. Work only here — the
main checkout at `/Users/andreasrau/Desktop/projects/printify-mcp` is shared with other sessions
and may be on another branch.

## Global Constraints

- **Every commit message ends with this trailer, exactly:**
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Test-first.** Every task writes a failing test, watches it fail for the right reason, then
  implements. Never write implementation before its test.
- **No new dependencies.** Nothing is added to `package.json`.
- **Verification commands** (run from the worktree): `npm run lint`, `npm run typecheck`,
  `npm test`, `npm run build`. Never claim success without running them.
- **Tool definitions** use `z.strictObject` for input and the `READ_ONLY` annotations constant
  already in `src/tools/catalog.ts`. `test/tools/catalog.test.ts` runs `toolProblems(ALL_TOOLS)`
  over every tool and needs no edit.
- **`dropNulls` in `src/tools/run.ts` strips `undefined` from a handler's result at any depth**, so
  returning `country: undefined` simply leaves the key out of the response. Do not add
  `if (x !== undefined)` guards in handlers for this.
- **Costs are in cents.** v2 sends `{ amount, currency }`; this codebase uses `{ cost, currency }`,
  and the service renames the field at parse time.
- **Interfaces use function-typed properties, not methods** (`foo: (a: A) => B`, not `foo(a: A): B`).
  Destructuring a method trips `@typescript-eslint/unbound-method`.
- **Lenient vs strict schema fields:** ids, countries and costs are strict — a response missing them
  fails with `invalid_response`. Only `handlingTime` is lenient, through the existing `lenient()`
  helper in `src/printify/catalog.ts`.
- **Printify API facts** (checked 2026-09-24, HTML docs beat `openapi.json`): the five endpoints are
  `/v2/catalog/blueprints/{blueprint_id}/print_providers/{print_provider_id}/shipping.json` and
  `…/shipping/{standard|priority|express|economy}.json`. None is paginated and none accepts a query
  parameter, so every filter here is client-side. `country.code` may be `REST_OF_THE_WORLD`.

---

## File Structure

**Created:**

- `src/tools/shipping-profiles.ts` — `groupShippingProfiles` and `ShippingProfile`. Pure: rows in,
  profiles out. No Printify client, no cache, no MCP.
- `test/tools/shipping-profiles.test.ts` — the grouping function directly.
- `test/tools/catalog-shipping.test.ts` — both tools through the MCP harness.
- `test/fixtures/catalog-shipping.ts` — the documented v2 examples and builders.

**Modified:**

- `src/printify/catalog.ts` — two schemas, `SHIPPING_METHODS`, `ShippingRow`, and the two `Catalog`
  methods. It stays the only file that knows how Printify shapes a response.
- `src/tools/catalog.ts` — the two tool definitions, two shared input field schemas, two private
  helpers, and one sentence added to `get_shipping_info`'s description. Both tools join
  `catalogTools`, so `src/tools/index.ts` does not change.
- `test/printify/catalog.test.ts` — a new `describe` block for the two service methods.

**Unchanged on purpose:** `src/tools/index.ts`, `src/printify/rate-limit.ts` (`bucketsFor` already
matches `/^\/v[12]\/catalog\//`), `src/printify/path.ts` (`apiPath` already accepts `/v2/`),
`test/support/harness.ts`, `test/tools/fixtures.ts`, `test/cli.test.ts` (their services already
carry `catalog`), and `test/tools/catalog.test.ts`.

---

## Task 1: v2 fixtures and `Catalog.shippingMethods`

**Files:**

- Create: `test/fixtures/catalog-shipping.ts`
- Modify: `src/printify/catalog.ts`
- Test: `test/printify/catalog.test.ts`

**Interfaces:**

- Consumes: the private `fetchCached(schema, path, ttlMs, signal, query?)` and `VOLATILE_TTL_MS`,
  both already in `src/printify/catalog.ts`.
- Produces: `SHIPPING_METHODS`, `type ShippingMethod`, `type ShippingMethodName`, and
  `Catalog.shippingMethods(blueprintId, printProviderId, signal): Promise<readonly ShippingMethodName[]>`.
  Fixtures `methodList(names?)` and `SHIPPING_METHOD_LIST`.

- [ ] **Step 1: Install dependencies in the worktree**

The worktree has no `node_modules` yet. Run from the worktree root:

```bash
npm ci
```

Expected: completes with no errors. Do not run `npm ci` in the main checkout.

- [ ] **Step 2: Create the fixture file**

Create `test/fixtures/catalog-shipping.ts` with the method-list fixtures only. The cost fixtures
come in Task 2.

```ts
/** Catalog v2 shipping fixtures, from https://developers.printify.com/#catalog-v2. */

/** The four documented methods, or whichever names a test needs. */
export function methodList(
  names: readonly string[] = ['standard', 'priority', 'express', 'economy'],
) {
  return {
    data: names.map((name, index) => ({
      type: 'shipping_method',
      id: String(index + 1),
      attributes: { name },
    })),
    // The docs' own links object has a typo (priority twice); nothing may read it.
    links: {
      standard:
        'https://api.printify.com/v2/catalog/blueprints/3/print_providers/29/shipping/standard.json',
    },
  };
}

/** The documented response: all four methods. */
export const SHIPPING_METHOD_LIST = methodList();
```

- [ ] **Step 3: Write the failing test**

Add to `test/printify/catalog.test.ts`. Add `SHIPPING_METHOD_LIST` and `methodList` to the import
from `../fixtures/catalog-shipping.js` (a new import line), and add these path constants next to the
existing `SHIPPING_PATH`:

```ts
const V2_METHODS_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping.json';
```

Then append this `describe` block at the end of the file, after the closing `});` of
`describe('createCatalog')`:

```ts
describe('createCatalog: v2 shipping methods', () => {
  it('reads the documented v2 path and returns the names in order', async () => {
    const { catalog, api } = testCatalog({ [`GET ${V2_METHODS_PATH}`]: SHIPPING_METHOD_LIST });

    const methods = await catalog.shippingMethods(3, 29, signal());

    expect(methods).toEqual(['standard', 'priority', 'express', 'economy']);
    api.expectRequest('GET', V2_METHODS_PATH);
  });

  it('passes an undocumented method name through', async () => {
    const { catalog } = testCatalog({
      [`GET ${V2_METHODS_PATH}`]: methodList(['standard', 'sea_freight']),
    });

    expect(await catalog.shippingMethods(3, 29, signal())).toEqual(['standard', 'sea_freight']);
  });

  it('caches the method list for an hour', async () => {
    const { catalog, api, tick } = testCatalog({
      [`GET ${V2_METHODS_PATH}`]: SHIPPING_METHOD_LIST,
    });

    await catalog.shippingMethods(3, 29, signal());
    tick(VOLATILE_TTL_MS - 1);
    await catalog.shippingMethods(3, 29, signal());
    expect(api.requests).toHaveLength(1);

    tick(1);
    await catalog.shippingMethods(3, 29, signal());
    expect(api.requests).toHaveLength(2);
  });

  it('sends the caller signal', async () => {
    const { catalog, api } = testCatalog({ [`GET ${V2_METHODS_PATH}`]: SHIPPING_METHOD_LIST });
    const controller = new AbortController();

    await catalog.shippingMethods(3, 29, controller.signal);

    const sent = api.expectRequest('GET', V2_METHODS_PATH);
    expect(sent.signal.aborted).toBe(false);
    controller.abort();
    expect(sent.signal.aborted).toBe(true);
  });

  it('fails a method entry with no name', async () => {
    const { catalog } = testCatalog({
      [`GET ${V2_METHODS_PATH}`]: { data: [{ type: 'shipping_method', id: '1', attributes: {} }] },
    });

    const error = await apiError(catalog.shippingMethods(3, 29, signal()));
    expect(error.kind).toBe('invalid_response');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
npx vitest run test/printify/catalog.test.ts
```

Expected: FAIL. TypeScript/Vitest reports `catalog.shippingMethods is not a function`, or the
editor reports that `shippingMethods` does not exist on `Catalog`. That is the right failure — the
method does not exist yet.

- [ ] **Step 5: Add the schema and the constants**

In `src/printify/catalog.ts`, add after the existing `shippingSchema` declaration:

<!-- prettier-ignore -->
```ts
/** The four shipping methods `get_shipping_costs` can request, in the docs' order. */
export const SHIPPING_METHODS = ['standard', 'priority', 'express', 'economy'] as const;

export type ShippingMethod = (typeof SHIPPING_METHODS)[number];

/** A method name as `shipping.json` lists it: one of the four, or something Printify added. */
export type ShippingMethodName = string;

// The JSON:API envelope is flattened here, so the cache holds names and nothing else. `type`,
// `id` and the `links` object are stripped: the docs' links object has a typo and no use.
const shippingMethodListSchema = z
  .object({ data: z.array(z.object({ attributes: z.object({ name: z.string() }) })) })
  .transform(({ data }): ShippingMethodName[] => data.map((entry) => entry.attributes.name));
```

- [ ] **Step 6: Add the method to the `Catalog` interface**

In the `Catalog` interface, after the `shipping` property:

<!-- prettier-ignore -->
```ts
  /** The shipping methods a provider offers for a blueprint, in Printify's order. 1 h. */
  shippingMethods: (
    blueprintId: number,
    printProviderId: number,
    signal: AbortSignal,
  ) => Promise<readonly ShippingMethodName[]>;
```

- [ ] **Step 7: Implement the method**

In the object `createCatalog` returns, after the `shipping(…)` property:

<!-- prettier-ignore -->
```ts
    shippingMethods(blueprintId, printProviderId, signal) {
      return fetchCached(
        shippingMethodListSchema,
        apiPath`/v2/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/shipping.json`,
        VOLATILE_TTL_MS,
        signal,
      );
    },
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npx vitest run test/printify/catalog.test.ts
```

Expected: PASS, including the five new tests.

- [ ] **Step 9: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/printify/catalog.ts test/printify/catalog.test.ts test/fixtures/catalog-shipping.ts
git commit -m "$(cat <<'MSG'
Read the v2 shipping method list (#9)

Adds Catalog.shippingMethods over
/v2/catalog/blueprints/{id}/print_providers/{pp}/shipping.json, cached
for an hour like the v1 shipping profiles. The JSON:API envelope is
flattened at parse time, so the cache holds method names only.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 2: `Catalog.shippingCosts`

**Files:**

- Modify: `src/printify/catalog.ts`, `test/fixtures/catalog-shipping.ts`
- Test: `test/printify/catalog.test.ts`

**Interfaces:**

- Consumes: `fetchCached`, `VOLATILE_TTL_MS`, the `lenient()` helper, `ShippingMethod` (Task 1).
- Produces: `interface ShippingRow` and
  `Catalog.shippingCosts(blueprintId, printProviderId, method, signal): Promise<readonly ShippingRow[]>`.
  Fixtures `shippingEntry(overrides?)`, `shippingResponse(entries)`, `ECONOMY_COSTS`,
  `STANDARD_COSTS`.

- [ ] **Step 1: Add the cost fixtures**

Append to `test/fixtures/catalog-shipping.ts`:

```ts
export interface ShippingEntryOverrides {
  method?: string;
  country?: string;
  variantId?: number;
  /** Cents. */
  firstItem?: number;
  /** Cents. */
  additionalItems?: number;
  currency?: string;
  /** `null` stands for a response that omits the handling time. */
  handlingTime?: { from: number; to: number } | null;
}

/** One `data[]` entry, shaped exactly as the docs show it. */
export function shippingEntry({
  method = 'economy',
  country = 'US',
  variantId = 23494,
  firstItem = 399,
  additionalItems = 219,
  currency = 'USD',
  handlingTime = { from: 4, to: 8 },
}: ShippingEntryOverrides = {}) {
  return {
    type: `variant_shipping_${method}_${country.toLowerCase()}`,
    id: String(variantId),
    attributes: {
      shippingType: method,
      country: { code: country },
      variantId,
      shippingPlanId: '65a7c0825b50fcd56a018e02',
      handlingTime,
      shippingCost: {
        firstItem: { amount: firstItem, currency },
        additionalItems: { amount: additionalItems, currency },
      },
    },
  };
}

/** The `data` envelope around some entries. */
export function shippingResponse(entries: readonly ReturnType<typeof shippingEntry>[]) {
  return { data: entries };
}

/**
 * Economy costs for three variants. 23494 and 23495 cost the same in the US and Canada; 23496
 * costs more in the US only, so it must not be folded into their profile. Everything else falls
 * under one REST_OF_THE_WORLD rate. Germany is deliberately absent.
 */
export const ECONOMY_COSTS = shippingResponse([
  shippingEntry({ variantId: 23494, country: 'US' }),
  shippingEntry({ variantId: 23495, country: 'US' }),
  shippingEntry({ variantId: 23496, country: 'US', firstItem: 599 }),
  shippingEntry({ variantId: 23494, country: 'CA' }),
  shippingEntry({ variantId: 23495, country: 'CA' }),
  shippingEntry({ variantId: 23496, country: 'CA' }),
  shippingEntry({
    variantId: 23494,
    country: 'REST_OF_THE_WORLD',
    firstItem: 1100,
    additionalItems: 0,
  }),
  shippingEntry({
    variantId: 23495,
    country: 'REST_OF_THE_WORLD',
    firstItem: 1100,
    additionalItems: 0,
  }),
  shippingEntry({
    variantId: 23496,
    country: 'REST_OF_THE_WORLD',
    firstItem: 1100,
    additionalItems: 0,
  }),
]);

/** Standard costs, which unlike economy do name Germany. Two variants only. */
export const STANDARD_COSTS = shippingResponse([
  shippingEntry({
    method: 'standard',
    variantId: 23494,
    country: 'DE',
    firstItem: 499,
    additionalItems: 299,
  }),
  shippingEntry({
    method: 'standard',
    variantId: 23495,
    country: 'DE',
    firstItem: 499,
    additionalItems: 299,
  }),
  shippingEntry({
    method: 'standard',
    variantId: 23494,
    country: 'REST_OF_THE_WORLD',
    firstItem: 1300,
    additionalItems: 0,
  }),
  shippingEntry({
    method: 'standard',
    variantId: 23495,
    country: 'REST_OF_THE_WORLD',
    firstItem: 1300,
    additionalItems: 0,
  }),
]);
```

- [ ] **Step 2: Write the failing test**

Add `ECONOMY_COSTS`, `shippingEntry` and `shippingResponse` to the
`../fixtures/catalog-shipping.js` import in `test/printify/catalog.test.ts` (`inTurn` and `never`
are already imported from `../support/fake-api.js`), add the path constant

```ts
const V2_ECONOMY_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping/economy.json';
```

and append this `describe` block at the end of the file:

```ts
describe('createCatalog: v2 shipping costs', () => {
  it('flattens the documented response into rows', async () => {
    const { catalog, api } = testCatalog({ [`GET ${V2_ECONOMY_PATH}`]: ECONOMY_COSTS });

    const rows = await catalog.shippingCosts(3, 29, 'economy', signal());

    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({
      variant_id: 23494,
      country: 'US',
      first_item: { cost: 399, currency: 'USD' },
      additional_items: { cost: 219, currency: 'USD' },
      handling_days: { from: 4, to: 8 },
    });
    api.expectRequest('GET', V2_ECONOMY_PATH);
  });

  it('keeps nothing Printify sends that a tool has no use for', async () => {
    const { catalog } = testCatalog({ [`GET ${V2_ECONOMY_PATH}`]: ECONOMY_COSTS });

    const rows = await catalog.shippingCosts(3, 29, 'economy', signal());

    expect(JSON.stringify(rows)).not.toContain('shippingPlanId');
    expect(JSON.stringify(rows)).not.toContain('shippingType');
    expect(JSON.stringify(rows)).not.toContain('variant_shipping');
  });

  it('caches each method separately, for an hour', async () => {
    const { catalog, api, tick } = testCatalog({
      [`GET ${V2_ECONOMY_PATH}`]: ECONOMY_COSTS,
      'GET /v2/catalog/blueprints/3/print_providers/29/shipping/standard.json': ECONOMY_COSTS,
    });

    await catalog.shippingCosts(3, 29, 'economy', signal());
    await catalog.shippingCosts(3, 29, 'economy', signal());
    await catalog.shippingCosts(3, 29, 'standard', signal());
    expect(api.requests).toHaveLength(2);

    tick(VOLATILE_TTL_MS);
    await catalog.shippingCosts(3, 29, 'economy', signal());
    expect(api.requests).toHaveLength(3);
  });

  it('turns a missing handling time into undefined without failing the response', async () => {
    const { catalog } = testCatalog({
      [`GET ${V2_ECONOMY_PATH}`]: shippingResponse([shippingEntry({ handlingTime: null })]),
    });

    const rows = await catalog.shippingCosts(3, 29, 'economy', signal());

    expect(rows[0]?.handling_days).toBeUndefined();
    expect(rows[0]?.first_item).toEqual({ cost: 399, currency: 'USD' });
  });

  it('fails a row with no variant id, and does not cache it', async () => {
    const entry = shippingEntry();
    const broken = { ...entry, attributes: { ...entry.attributes, variantId: 'twenty' } };
    const { catalog, api } = testCatalog({ [`GET ${V2_ECONOMY_PATH}`]: { data: [broken] } });

    const error = await apiError(catalog.shippingCosts(3, 29, 'economy', signal()));
    expect(error.kind).toBe('invalid_response');
    expect(error.message).toContain('an unexpected catalog response');

    await apiError(catalog.shippingCosts(3, 29, 'economy', signal()));
    expect(api.requests).toHaveLength(2);
  });

  it('fails a row with no cost', async () => {
    const entry = shippingEntry();
    const broken = {
      ...entry,
      attributes: { ...entry.attributes, shippingCost: { firstItem: { currency: 'USD' } } },
    };
    const { catalog } = testCatalog({ [`GET ${V2_ECONOMY_PATH}`]: { data: [broken] } });

    const error = await apiError(catalog.shippingCosts(3, 29, 'economy', signal()));
    expect(error.kind).toBe('invalid_response');
  });

  it('sends the caller signal, and caches nothing when the call is aborted', async () => {
    const { catalog, api } = testCatalog({
      // The first call hangs until aborted; the second answers normally.
      [`GET ${V2_ECONOMY_PATH}`]: inTurn(never(), ECONOMY_COSTS),
    });
    const controller = new AbortController();

    const pending = catalog.shippingCosts(3, 29, 'economy', controller.signal);
    const sent = api.expectRequest('GET', V2_ECONOMY_PATH);
    expect(sent.signal.aborted).toBe(false);
    controller.abort();
    expect(sent.signal.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/abort/i);

    // Resolving from the cache here would leave the request count at 1.
    await catalog.shippingCosts(3, 29, 'economy', signal());
    expect(api.requests).toHaveLength(2);
  });

  it('returns no rows for a method the provider does not serve', async () => {
    const { catalog } = testCatalog({ [`GET ${V2_ECONOMY_PATH}`]: { data: [] } });

    expect(await catalog.shippingCosts(3, 29, 'economy', signal())).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
npx vitest run test/printify/catalog.test.ts
```

Expected: FAIL — `catalog.shippingCosts is not a function`.

- [ ] **Step 4: Add the row type and schema**

In `src/printify/catalog.ts`, after the `shippingMethodListSchema` from Task 1:

<!-- prettier-ignore -->
```ts
/** One variant's cost to one country, flattened from a v2 `data[]` entry. */
export interface ShippingRow {
  variant_id: number;
  /** An ISO code, or REST_OF_THE_WORLD for every country no other row names. */
  country: string;
  first_item: { cost: number; currency: string };
  additional_items: { cost: number; currency: string };
  handling_days: { from: number; to: number } | undefined;
}

// v2 sends `amount`; the rest of this codebase says `cost`, so the rename happens here.
const v2CostSchema = z
  .object({ amount: z.number(), currency: z.string() })
  .transform(({ amount, currency }) => ({ cost: amount, currency }));

const shippingRowsSchema = z
  .object({
    data: z.array(
      z.object({
        attributes: z.object({
          variantId: z.number().int(),
          country: z.object({ code: z.string() }),
          handlingTime: lenient(z.object({ from: z.number(), to: z.number() })),
          shippingCost: z.object({
            firstItem: v2CostSchema,
            additionalItems: v2CostSchema,
          }),
        }),
      }),
    ),
  })
  .transform(({ data }): ShippingRow[] =>
    data.map(({ attributes }) => ({
      variant_id: attributes.variantId,
      country: attributes.country.code,
      first_item: attributes.shippingCost.firstItem,
      additional_items: attributes.shippingCost.additionalItems,
      handling_days: attributes.handlingTime,
    })),
  );
```

- [ ] **Step 5: Add the method to the `Catalog` interface**

After the `shippingMethods` property:

<!-- prettier-ignore -->
```ts
  /** One method's costs, one row per variant and country. 1 h. */
  shippingCosts: (
    blueprintId: number,
    printProviderId: number,
    method: ShippingMethod,
    signal: AbortSignal,
  ) => Promise<readonly ShippingRow[]>;
```

- [ ] **Step 6: Implement the method**

After the `shippingMethods(…)` property in the returned object:

<!-- prettier-ignore -->
```ts
    shippingCosts(blueprintId, printProviderId, method, signal) {
      return fetchCached(
        shippingRowsSchema,
        apiPath`/v2/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/shipping/${method}.json`,
        VOLATILE_TTL_MS,
        signal,
      );
    },
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run test/printify/catalog.test.ts
```

Expected: PASS.

- [ ] **Step 8: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/printify/catalog.ts test/printify/catalog.test.ts test/fixtures/catalog-shipping.ts
git commit -m "$(cat <<'MSG'
Read v2 per-method shipping costs (#9)

Adds Catalog.shippingCosts over
.../shipping/{method}.json, flattening the JSON:API envelope into rows
of variant, country, costs and handling days at parse time. v2's
`amount` becomes `cost`, matching the v1 shipping profiles, and the
internal shippingPlanId never leaves the parser.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 3: `groupShippingProfiles`

**Files:**

- Create: `src/tools/shipping-profiles.ts`
- Test: `test/tools/shipping-profiles.test.ts`

**Interfaces:**

- Consumes: `type ShippingRow` from `src/printify/catalog.ts` (Task 2).
- Produces: `interface ShippingProfile` and
  `groupShippingProfiles(rows: readonly ShippingRow[]): ShippingProfile[]`.

Why two passes: rows are per variant _and_ per country, so a rate can cover different variant sets
in different countries. Grouping by rate alone would invent a cross product that Printify never
sent. Grouping by rate _and_ country first, then merging only countries whose variant list is
identical, makes the cross product exact.

- [ ] **Step 1: Write the failing test**

Create `test/tools/shipping-profiles.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ShippingRow } from '../../src/printify/catalog.js';
import { groupShippingProfiles } from '../../src/tools/shipping-profiles.js';

/** A row with the usual rate, so a test only states what it varies. */
function row(overrides: Partial<ShippingRow> = {}): ShippingRow {
  return {
    variant_id: 1,
    country: 'US',
    first_item: { cost: 399, currency: 'USD' },
    additional_items: { cost: 219, currency: 'USD' },
    handling_days: { from: 4, to: 8 },
    ...overrides,
  };
}

describe('groupShippingProfiles', () => {
  it('returns no profiles for no rows', () => {
    expect(groupShippingProfiles([])).toEqual([]);
  });

  it('collapses one rate over many variants into one profile', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1 }),
      row({ variant_id: 2 }),
      row({ variant_id: 3 }),
    ]);

    expect(profiles).toEqual([
      {
        countries: ['US'],
        variant_ids: [1, 2, 3],
        variant_count: 3,
        first_item: { cost: 399, currency: 'USD' },
        additional_items: { cost: 219, currency: 'USD' },
        handling_days: { from: 4, to: 8 },
      },
    ]);
  });

  it('merges countries that share a rate and the same variants', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1, country: 'US' }),
      row({ variant_id: 2, country: 'US' }),
      row({ variant_id: 1, country: 'CA' }),
      row({ variant_id: 2, country: 'CA' }),
    ]);

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.countries).toEqual(['US', 'CA']);
    expect(profiles[0]?.variant_ids).toEqual([1, 2]);
  });

  it('keeps countries apart when the same rate covers different variants', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1, country: 'US' }),
      row({ variant_id: 1, country: 'CA' }),
      row({ variant_id: 2, country: 'CA' }),
    ]);

    expect(profiles.map((profile) => profile.countries)).toEqual([['US'], ['CA']]);
    expect(profiles.map((profile) => profile.variant_ids)).toEqual([[1], [1, 2]]);
  });

  it('does not fold a variant priced differently in one country into the others', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1, country: 'US' }),
      row({ variant_id: 2, country: 'US' }),
      row({ variant_id: 3, country: 'US', first_item: { cost: 599, currency: 'USD' } }),
      row({ variant_id: 1, country: 'CA' }),
      row({ variant_id: 2, country: 'CA' }),
      row({ variant_id: 3, country: 'CA' }),
    ]);

    expect(profiles).toEqual([
      expect.objectContaining({ countries: ['US'], variant_ids: [1, 2] }),
      expect.objectContaining({
        countries: ['US'],
        variant_ids: [3],
        first_item: { cost: 599, currency: 'USD' },
      }),
      expect.objectContaining({ countries: ['CA'], variant_ids: [1, 2, 3] }),
    ]);
  });

  it('does not merge rows that differ only in handling time', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1, handling_days: { from: 4, to: 8 } }),
      row({ variant_id: 2, handling_days: { from: 1, to: 3 } }),
    ]);

    expect(profiles).toHaveLength(2);
  });

  it('does not merge rows that differ only in currency', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1 }),
      row({ variant_id: 2, first_item: { cost: 399, currency: 'EUR' } }),
    ]);

    expect(profiles).toHaveLength(2);
  });

  it('omits handling_days entirely when the rows have none', () => {
    const profiles = groupShippingProfiles([row({ handling_days: undefined })]);

    expect(profiles[0]).not.toHaveProperty('handling_days');
  });

  it('does not merge a row with a handling time into one without', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1, handling_days: undefined }),
      row({ variant_id: 2 }),
    ]);

    expect(profiles).toHaveLength(2);
  });

  it('keeps Printify order for profiles, countries and variant ids', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 9, country: 'GB', first_item: { cost: 700, currency: 'USD' } }),
      row({ variant_id: 3, country: 'US' }),
      row({ variant_id: 1, country: 'US' }),
      row({ variant_id: 3, country: 'CA' }),
      row({ variant_id: 1, country: 'CA' }),
    ]);

    expect(profiles[0]?.countries).toEqual(['GB']);
    expect(profiles[1]?.countries).toEqual(['US', 'CA']);
    expect(profiles[1]?.variant_ids).toEqual([3, 1]);
  });

  it('counts every variant it lists, however many there are', () => {
    const rows = Array.from({ length: 120 }, (_unused, index) => row({ variant_id: index + 1 }));

    const profiles = groupShippingProfiles(rows);

    expect(profiles[0]?.variant_ids).toHaveLength(120);
    expect(profiles[0]?.variant_count).toBe(120);
  });

  it('ignores a repeated variant id in one country', () => {
    const profiles = groupShippingProfiles([row({ variant_id: 1 }), row({ variant_id: 1 })]);

    expect(profiles[0]?.variant_ids).toEqual([1]);
    expect(profiles[0]?.variant_count).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/tools/shipping-profiles.test.ts
```

Expected: FAIL — cannot resolve `../../src/tools/shipping-profiles.js`.

- [ ] **Step 3: Write the implementation**

Create `src/tools/shipping-profiles.ts`:

```ts
import type { ShippingRow } from '../printify/catalog.js';

/** One rate, and every country and variant it applies to. The shape v1 shipping already uses. */
export interface ShippingProfile {
  countries: string[];
  variant_ids: number[];
  /** The length of `variant_ids`, so the model never has to count the array. */
  variant_count: number;
  first_item: { cost: number; currency: string };
  additional_items: { cost: number; currency: string };
  handling_days?: { from: number; to: number };
}

/**
 * Regroups per-variant, per-country rows into profiles. Two passes: by rate and country first,
 * then merging only the countries whose variant list is identical, so the cross product a profile
 * implies is exactly what Printify sent — a variant priced differently in one country keeps its
 * own profile. Profiles, countries and variant ids all stay in first-appearance order.
 */
export function groupShippingProfiles(rows: readonly ShippingRow[]): ShippingProfile[] {
  const byCountry = new Map<string, { row: ShippingRow; variantIds: number[] }>();
  for (const row of rows) {
    const key = `${row.country}\u0000${rateKey(row)}`;
    const entry = byCountry.get(key);
    if (entry === undefined) {
      byCountry.set(key, { row, variantIds: [row.variant_id] });
    } else if (!entry.variantIds.includes(row.variant_id)) {
      entry.variantIds.push(row.variant_id);
    }
  }

  const profiles = new Map<string, ShippingProfile>();
  for (const { row, variantIds } of byCountry.values()) {
    const key = `${rateKey(row)}\u0000${variantIds.join(',')}`;
    const profile = profiles.get(key);
    if (profile !== undefined) {
      if (!profile.countries.includes(row.country)) profile.countries.push(row.country);
      continue;
    }
    const created: ShippingProfile = {
      countries: [row.country],
      variant_ids: variantIds,
      variant_count: variantIds.length,
      first_item: row.first_item,
      additional_items: row.additional_items,
    };
    // Set conditionally, so a provider that sends no handling time has no such key at all.
    if (row.handling_days !== undefined) created.handling_days = row.handling_days;
    profiles.set(key, created);
  }
  return [...profiles.values()];
}

/** Everything two rows must agree on to belong to the same profile. */
function rateKey(row: ShippingRow): string {
  const handling = row.handling_days;
  return JSON.stringify([
    row.first_item.cost,
    row.first_item.currency,
    row.additional_items.cost,
    row.additional_items.currency,
    handling === undefined ? null : [handling.from, handling.to],
  ]);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/tools/shipping-profiles.test.ts
```

Expected: PASS, all 12 tests.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/tools/shipping-profiles.ts test/tools/shipping-profiles.test.ts
git commit -m "$(cat <<'MSG'
Regroup v2 shipping rows into profiles (#9)

A v2 per-method response is one row per variant and country, repeating
the same few rates. groupShippingProfiles collapses them into the
country-and-variant profiles v1 shipping already returns.

It merges countries only when their variant list is identical, so the
cross product a profile implies is exactly what Printify sent: a variant
priced differently in one country keeps its own profile.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 4: The `list_shipping_methods` tool

**Files:**

- Modify: `src/tools/catalog.ts`
- Create: `test/tools/catalog-shipping.test.ts`

**Interfaces:**

- Consumes: `Catalog.shippingMethods` (Task 1); `defineTool`, the module-private `READ_ONLY`,
  `blueprintId` and `printProviderId` already in `src/tools/catalog.ts`.
- Produces: `listShippingMethodsTool`, added to `catalogTools`.

- [ ] **Step 1: Write the failing test**

Create `test/tools/catalog-shipping.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { methodList, SHIPPING_METHOD_LIST } from '../fixtures/catalog-shipping.js';
import { expectToolData } from '../support/expect.js';
import { createTestServer } from '../support/harness.js';

const METHODS_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping.json';

const IDS = { blueprint_id: 3, print_provider_id: 29 };

describe('list_shipping_methods', () => {
  it('lists the methods the provider offers', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${METHODS_PATH}`]: SHIPPING_METHOD_LIST },
    });

    const result = await call('list_shipping_methods', IDS);

    expect(expectToolData(result)).toEqual({
      blueprint_id: 3,
      print_provider_id: 29,
      methods: ['standard', 'priority', 'express', 'economy'],
    });
    api.expectRequest('GET', METHODS_PATH);
  });

  it('lists only what this provider offers, including a name Printify added later', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${METHODS_PATH}`]: methodList(['standard', 'sea_freight']) },
    });

    const result = await call('list_shipping_methods', IDS);

    // Dropping an unknown name here would hide a real shipping option from the user.
    expect(expectToolData(result).methods).toEqual(['standard', 'sea_freight']);
  });

  it('answers a second call from the cache', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${METHODS_PATH}`]: SHIPPING_METHOD_LIST },
    });

    await call('list_shipping_methods', IDS);
    await call('list_shipping_methods', IDS);

    api.expectRequest('GET', METHODS_PATH);
  });

  it('is listed as a read-only tool', async () => {
    const { mcp } = await createTestServer();

    const { tools } = await mcp.listTools();
    const listed = tools.find((tool) => tool.name === 'list_shipping_methods');

    expect(listed?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/tools/catalog-shipping.test.ts
```

Expected: FAIL — the tool call returns an error saying the tool is unknown, and `listed` is
`undefined`.

- [ ] **Step 3: Write the tool**

In `src/tools/catalog.ts`, add the definition immediately after `getPrintProviderTool` and before
the `catalogTools` array:

```ts
export const listShippingMethodsTool = defineTool({
  name: 'list_shipping_methods',
  toolset: 'catalog',
  description:
    'Lists the shipping methods a print provider offers for a blueprint: standard, priority, ' +
    'express or economy. Economy rates exist only here, not in get_shipping_info. Use ' +
    'get_shipping_costs for what each method costs.',
  annotations: READ_ONLY,
  input: z.strictObject({ blueprint_id: blueprintId, print_provider_id: printProviderId }),
  handler: async (input, ctx) => {
    const methods = await ctx.catalog.shippingMethods(
      input.blueprint_id,
      input.print_provider_id,
      ctx.signal,
    );
    return {
      blueprint_id: input.blueprint_id,
      print_provider_id: input.print_provider_id,
      methods,
    };
  },
});
```

- [ ] **Step 4: Register it**

Add `listShippingMethodsTool` to the `catalogTools` array, after `getPrintProviderTool`:

<!-- prettier-ignore -->
```ts
export const catalogTools: readonly Tool[] = [
  getBlueprintTool,
  listBlueprintProvidersTool,
  listVariantsTool,
  getShippingInfoTool,
  listPrintProvidersTool,
  getPrintProviderTool,
  listShippingMethodsTool,
];
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npx vitest run test/tools/catalog-shipping.test.ts test/tools/catalog.test.ts
```

Expected: PASS. `test/tools/catalog.test.ts` covers the new tool through `toolProblems(ALL_TOOLS)`
without being edited.

- [ ] **Step 6: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/tools/catalog.ts test/tools/catalog-shipping.test.ts
git commit -m "$(cat <<'MSG'
Add the list_shipping_methods tool (#9)

One cheap cached call that answers whether a provider does economy at
all, without pulling every cost row for every method.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 5: `get_shipping_costs` — one method, no filters

**Files:**

- Modify: `src/tools/catalog.ts`
- Test: `test/tools/catalog-shipping.test.ts`

**Interfaces:**

- Consumes: `Catalog.shippingCosts` (Task 2), `groupShippingProfiles` (Task 3), `SHIPPING_METHODS`
  (Task 1).
- Produces: `getShippingCostsTool`, added to `catalogTools`. Tasks 6 to 8 extend its input schema,
  its handler and its description; nothing else consumes it.

At this stage `method` is required. Task 8 makes it optional. The output is already a `methods[]`
array of one entry, so that change adds entries rather than changing the shape.

- [ ] **Step 1: Write the failing test**

Add to `test/tools/catalog-shipping.test.ts`. Extend the fixture import with `ECONOMY_COSTS`, add
`expectToolError` to the `../support/expect.js` import, add `json` from `../support/fake-api.js` and
`notFoundBody` from `../fixtures/errors.js`, and add the path constant:

```ts
const ECONOMY_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping/economy.json';
```

Then append:

```ts
describe('get_shipping_costs', () => {
  it('groups the rows of one method into profiles', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy' });

    expect(expectToolData(result)).toEqual({
      blueprint_id: 3,
      print_provider_id: 29,
      methods: [
        {
          method: 'economy',
          profile_count: 4,
          profiles: [
            {
              countries: ['US'],
              variant_ids: [23494, 23495],
              variant_count: 2,
              first_item: { cost: 399, currency: 'USD' },
              additional_items: { cost: 219, currency: 'USD' },
              handling_days: { from: 4, to: 8 },
            },
            {
              countries: ['US'],
              variant_ids: [23496],
              variant_count: 1,
              first_item: { cost: 599, currency: 'USD' },
              additional_items: { cost: 219, currency: 'USD' },
              handling_days: { from: 4, to: 8 },
            },
            {
              countries: ['CA'],
              variant_ids: [23494, 23495, 23496],
              variant_count: 3,
              first_item: { cost: 399, currency: 'USD' },
              additional_items: { cost: 219, currency: 'USD' },
              handling_days: { from: 4, to: 8 },
            },
            {
              countries: ['REST_OF_THE_WORLD'],
              variant_ids: [23494, 23495, 23496],
              variant_count: 3,
              first_item: { cost: 1100, currency: 'USD' },
              additional_items: { cost: 0, currency: 'USD' },
              handling_days: { from: 4, to: 8 },
            },
          ],
        },
      ],
    });
    api.expectRequest('GET', ECONOMY_PATH);
  });

  it('sends one request for one method and answers a second call from the cache', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    await call('get_shipping_costs', { ...IDS, method: 'economy' });
    await call('get_shipping_costs', { ...IDS, method: 'economy' });

    api.expectRequest('GET', ECONOMY_PATH);
  });

  it('returns no profiles for a method the provider does not serve', async () => {
    const { call } = await createTestServer({ routes: { [`GET ${ECONOMY_PATH}`]: { data: [] } } });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy' });

    expect(expectToolData(result).methods).toEqual([
      { method: 'economy', profile_count: 0, profiles: [] },
    ]);
  });

  it('reports an unknown blueprint as a 404', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: json(notFoundBody(), 404) },
    });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy' });

    expectToolError(result, { kind: 'http', status: 404 });
  });

  it('rejects a method Printify does not have', async () => {
    const { call, api } = await createTestServer();

    const result = await call('get_shipping_costs', { ...IDS, method: 'overnight' });

    expectToolError(result, { kind: 'validation' });
    expect(api.requests).toEqual([]);
  });

  it('leaks nothing Printify sends that the model has no use for', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy' });

    const text = JSON.stringify(expectToolData(result));
    expect(text).not.toContain('shipping_plan_id');
    expect(text).not.toContain('shippingPlanId');
    expect(text).not.toContain('shippingType');
    expect(text).not.toContain('variant_shipping');
  });

  it('is listed as a read-only tool', async () => {
    const { mcp } = await createTestServer();

    const { tools } = await mcp.listTools();
    const listed = tools.find((tool) => tool.name === 'get_shipping_costs');

    expect(listed?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/tools/catalog-shipping.test.ts
```

Expected: FAIL — `get_shipping_costs` is an unknown tool.

- [ ] **Step 3: Extend the imports**

At the top of `src/tools/catalog.ts`, replace the existing catalog import with a combined one and
add the grouping import after the `./shape.js` line:

<!-- prettier-ignore -->
```ts
import {
  SHIPPING_METHODS,
  type Location,
  type Variant,
  type VariantList,
} from '../printify/catalog.js';
import { defineTool, type Tool, type ToolAnnotations } from './define.js';
import { omitKeys } from './shape.js';
import { groupShippingProfiles } from './shipping-profiles.js';
```

- [ ] **Step 4: Write the tool**

Add after `listShippingMethodsTool` and before the `catalogTools` array:

```ts
export const getShippingCostsTool = defineTool({
  name: 'get_shipping_costs',
  toolset: 'catalog',
  description:
    "Gets a print provider's shipping costs and handling time for a blueprint, broken down by " +
    'shipping method. Costs are in cents of currency (399 = 3.99 USD): first_item is charged for ' +
    'the first item of this blueprint and provider in an order, additional_items for every ' +
    "further one. A profile's rate applies to every country and variant it lists. " +
    'REST_OF_THE_WORLD covers every country no profile names. For a single overall rate in one ' +
    'request, use get_shipping_info.',
  annotations: READ_ONLY,
  input: z.strictObject({
    blueprint_id: blueprintId,
    print_provider_id: printProviderId,
    method: z.enum(SHIPPING_METHODS).describe('The shipping method to price.'),
  }),
  handler: async (input, ctx) => {
    const rows = await ctx.catalog.shippingCosts(
      input.blueprint_id,
      input.print_provider_id,
      input.method,
      ctx.signal,
    );
    const profiles = groupShippingProfiles(rows);
    return {
      blueprint_id: input.blueprint_id,
      print_provider_id: input.print_provider_id,
      methods: [{ method: input.method, profile_count: profiles.length, profiles }],
    };
  },
});
```

- [ ] **Step 5: Register it**

Add `getShippingCostsTool` to `catalogTools`, after `listShippingMethodsTool`.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/tools/catalog-shipping.test.ts test/tools/catalog.test.ts
```

Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/tools/catalog.ts test/tools/catalog-shipping.test.ts
git commit -m "$(cat <<'MSG'
Add get_shipping_costs for one shipping method (#9)

Fetches one method's v2 rows and returns them as profiles, so a model
can finally price economy shipping. Filters and the multi-method
comparison follow.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 6: The `country` filter and the REST_OF_THE_WORLD fallback

**Files:**

- Modify: `src/tools/catalog.ts`
- Test: `test/tools/catalog-shipping.test.ts`

**Interfaces:**

- Consumes: `type ShippingRow` from `src/printify/catalog.ts`.
- Produces: the `country` input on `get_shipping_costs`, the `matched` field on each `methods[]`
  entry, and the module-private `matchCountry`.

Printify lists only the countries it charges a specific rate for, so "economy to Germany" usually
has no `DE` row while Germany is still shippable at the catch-all rate. Returning nothing would be
wrong; returning the catch-all rate without saying so would be worse.

- [ ] **Step 1: Write the failing test**

Add `shippingEntry` and `shippingResponse` to the fixture import, then append to the
`describe('get_shipping_costs')` block:

```ts
it('returns only the rates that name the country', async () => {
  const { call } = await createTestServer({
    routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
  });

  const result = await call('get_shipping_costs', { ...IDS, method: 'economy', country: 'US' });

  expect(expectToolData(result)).toMatchObject({
    country: 'US',
    methods: [
      {
        method: 'economy',
        matched: 'country',
        profile_count: 2,
        profiles: [
          expect.objectContaining({ countries: ['US'], variant_ids: [23494, 23495] }),
          expect.objectContaining({ countries: ['US'], variant_ids: [23496] }),
        ],
      },
    ],
  });
});

it('falls back to the rest-of-the-world rate for a country with no rate of its own', async () => {
  const { call } = await createTestServer({
    routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
  });

  const result = await call('get_shipping_costs', { ...IDS, method: 'economy', country: 'DE' });

  expect(expectToolData(result)).toMatchObject({
    country: 'DE',
    methods: [
      {
        matched: 'rest_of_the_world',
        profile_count: 1,
        profiles: [
          expect.objectContaining({
            countries: ['REST_OF_THE_WORLD'],
            first_item: { cost: 1100, currency: 'USD' },
          }),
        ],
      },
    ],
  });
});

it('trims and upper-cases the country', async () => {
  const { call } = await createTestServer({
    routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
  });

  const result = await call('get_shipping_costs', { ...IDS, method: 'economy', country: ' us ' });

  expect(expectToolData(result)).toMatchObject({
    country: 'US',
    methods: [{ matched: 'country' }],
  });
});

it('accepts REST_OF_THE_WORLD as a country in its own right', async () => {
  const { call } = await createTestServer({
    routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
  });

  const result = await call('get_shipping_costs', {
    ...IDS,
    method: 'economy',
    country: 'rest_of_the_world',
  });

  expect(expectToolData(result)).toMatchObject({
    country: 'REST_OF_THE_WORLD',
    methods: [{ matched: 'country', profile_count: 1 }],
  });
});

it('says none when there is no rate for the country and no catch-all', async () => {
  const { call } = await createTestServer({
    routes: {
      [`GET ${ECONOMY_PATH}`]: shippingResponse([shippingEntry({ country: 'US' })]),
    },
  });

  const result = await call('get_shipping_costs', { ...IDS, method: 'economy', country: 'DE' });

  expect(expectToolData(result).methods).toEqual([
    { method: 'economy', matched: 'none', profile_count: 0, profiles: [] },
  ]);
});

it('rejects a country that is not a code, without sending a request', async () => {
  const { call, api } = await createTestServer();

  const result = await call('get_shipping_costs', {
    ...IDS,
    method: 'economy',
    country: 'Germany',
  });

  expectToolError(result, { kind: 'validation' });
  expect(api.requests).toEqual([]);
});

it('has no country or matched key when no country was asked for', async () => {
  const { call } = await createTestServer({
    routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
  });

  const data = expectToolData(await call('get_shipping_costs', { ...IDS, method: 'economy' }));

  expect(data).not.toHaveProperty('country');
  expect(data.methods).toEqual([
    expect.not.objectContaining({ matched: expect.anything() as unknown }),
  ]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/tools/catalog-shipping.test.ts
```

Expected: FAIL — `country` is rejected as an unknown key by `z.strictObject`, so the first six new
tests report a `validation` error instead of data.

- [ ] **Step 3: Add the input field**

In `src/tools/catalog.ts`, after the existing `optionFilter` declaration near the top:

```ts
const shippingCountry = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^([A-Z]{2}|REST_OF_THE_WORLD)$/,
    'country must be a two-letter ISO code such as DE, or REST_OF_THE_WORLD',
  )
  .optional()
  .describe(
    'Only the costs that apply to this country, as an ISO 3166-1 alpha-2 code such as DE. When ' +
      'no rate names it, the REST_OF_THE_WORLD rate is returned and matched says so.',
  );
```

The checks run in order, so the value is trimmed and upper-cased before the pattern is applied:
`" de "` becomes `"DE"`, and `"Germany"` is rejected. `z.toJSONSchema` still converts this schema,
which `toolProblems` requires.

- [ ] **Step 4: Add the matching helper**

At the bottom of `src/tools/catalog.ts`, next to the other private helpers:

```ts
const REST_OF_THE_WORLD = 'REST_OF_THE_WORLD';

/** How a country filter matched: not at all, by name, or through the catch-all rate. */
type CountryMatch = 'country' | 'rest_of_the_world' | 'none';

/**
 * The rows that apply to `country`. Printify lists only the countries it charges a specific rate
 * for, so a country with no row of its own is shipped at the REST_OF_THE_WORLD rate — returned
 * here, but never silently: `matched` says which rate this is.
 */
function matchCountry(
  rows: readonly ShippingRow[],
  country: string | undefined,
): { rows: readonly ShippingRow[]; matched: CountryMatch | undefined } {
  if (country === undefined) return { rows, matched: undefined };
  const named = rows.filter((row) => row.country.toUpperCase() === country);
  if (named.length > 0) return { rows: named, matched: 'country' };
  const rest = rows.filter((row) => row.country.toUpperCase() === REST_OF_THE_WORLD);
  if (rest.length > 0) return { rows: rest, matched: 'rest_of_the_world' };
  return { rows: [], matched: 'none' };
}
```

Add `type ShippingRow` to the `../printify/catalog.js` import.

- [ ] **Step 5: Use it in the handler**

Replace `getShippingCostsTool`'s `input` and `handler` with:

```ts
  input: z.strictObject({
    blueprint_id: blueprintId,
    print_provider_id: printProviderId,
    method: z.enum(SHIPPING_METHODS).describe('The shipping method to price.'),
    country: shippingCountry,
  }),
  handler: async (input, ctx) => {
    const all = await ctx.catalog.shippingCosts(
      input.blueprint_id,
      input.print_provider_id,
      input.method,
      ctx.signal,
    );
    const { rows, matched } = matchCountry(all, input.country);
    const profiles = groupShippingProfiles(rows);
    return {
      blueprint_id: input.blueprint_id,
      print_provider_id: input.print_provider_id,
      country: input.country,
      methods: [{ method: input.method, matched, profile_count: profiles.length, profiles }],
    };
  },
```

`country` and `matched` are `undefined` when no filter was given; `dropNulls` in `src/tools/run.ts`
removes them from the result, which is what the last test asserts.

- [ ] **Step 6: Extend the description**

Replace the description with:

```ts
  description:
    "Gets a print provider's shipping costs and handling time for a blueprint, broken down by " +
    'shipping method. Filter with country (an ISO code such as DE). Costs are in cents of ' +
    'currency (399 = 3.99 USD): first_item is charged for the first item of this blueprint and ' +
    "provider in an order, additional_items for every further one. A profile's rate applies to " +
    'every country and variant it lists. REST_OF_THE_WORLD covers every country no profile ' +
    'names; matched says when a country fell back to it. For a single overall rate in one ' +
    'request, use get_shipping_info.',
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npx vitest run test/tools/catalog-shipping.test.ts
```

Expected: PASS.

- [ ] **Step 8: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/tools/catalog.ts test/tools/catalog-shipping.test.ts
git commit -m "$(cat <<'MSG'
Filter shipping costs by country, with a catch-all fallback (#9)

Printify names only the countries it charges a specific rate for, so
"economy to Germany" often has no DE row while Germany still ships at
the REST_OF_THE_WORLD rate. The filter returns that rate rather than
nothing, and `matched` says whether the rate names the country or is
the catch-all.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 7: The `variant_ids` filter

**Files:**

- Modify: `src/tools/catalog.ts`
- Test: `test/tools/catalog-shipping.test.ts`

**Interfaces:**

- Produces: the `variant_ids` input on `get_shipping_costs`. No new exports.

Filters apply in order: `variant_ids` narrows the rows, then `matchCountry` runs on what is left,
then grouping. So a variant with no `DE` row falls back to the catch-all even when another variant
of the same blueprint has one.

- [ ] **Step 1: Write the failing test**

Append to the `describe('get_shipping_costs')` block:

```ts
it('returns only the rates for the variants asked for', async () => {
  const { call } = await createTestServer({
    routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
  });

  const result = await call('get_shipping_costs', {
    ...IDS,
    method: 'economy',
    variant_ids: [23496],
  });

  expect(expectToolData(result).methods).toEqual([
    {
      method: 'economy',
      profile_count: 3,
      profiles: [
        expect.objectContaining({
          countries: ['US'],
          variant_ids: [23496],
          first_item: { cost: 599, currency: 'USD' },
        }),
        expect.objectContaining({
          countries: ['CA'],
          variant_ids: [23496],
          first_item: { cost: 399, currency: 'USD' },
        }),
        expect.objectContaining({
          countries: ['REST_OF_THE_WORLD'],
          variant_ids: [23496],
          first_item: { cost: 1100, currency: 'USD' },
        }),
      ],
    },
  ]);
});

it('merges countries that only differ over variants the filter dropped', async () => {
  const { call } = await createTestServer({
    routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
  });

  const result = await call('get_shipping_costs', {
    ...IDS,
    method: 'economy',
    variant_ids: [23494, 23495],
  });

  // Without 23496, the US and Canada rates become identical and collapse into one profile.
  expect(expectToolData(result).methods).toEqual([
    {
      method: 'economy',
      profile_count: 2,
      profiles: [
        expect.objectContaining({
          countries: ['US', 'CA'],
          variant_ids: [23494, 23495],
          variant_count: 2,
        }),
        expect.objectContaining({ countries: ['REST_OF_THE_WORLD'] }),
      ],
    },
  ]);
});

it('combines the country and variant filters', async () => {
  const { call } = await createTestServer({
    routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
  });

  const result = await call('get_shipping_costs', {
    ...IDS,
    method: 'economy',
    country: 'US',
    variant_ids: [23496],
  });

  expect(expectToolData(result).methods).toEqual([
    {
      method: 'economy',
      matched: 'country',
      profile_count: 1,
      profiles: [
        expect.objectContaining({
          countries: ['US'],
          variant_ids: [23496],
          first_item: { cost: 599, currency: 'USD' },
        }),
      ],
    },
  ]);
});

it('returns no profiles for variant ids the provider does not price', async () => {
  const { call } = await createTestServer({
    routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
  });

  const result = await call('get_shipping_costs', {
    ...IDS,
    method: 'economy',
    variant_ids: [99999],
  });

  expect(expectToolData(result).methods).toEqual([
    { method: 'economy', profile_count: 0, profiles: [] },
  ]);
});

it('rejects an empty variant_ids array, without sending a request', async () => {
  const { call, api } = await createTestServer();

  const result = await call('get_shipping_costs', {
    ...IDS,
    method: 'economy',
    variant_ids: [],
  });

  expectToolError(result, { kind: 'validation' });
  expect(api.requests).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/tools/catalog-shipping.test.ts
```

Expected: FAIL — `variant_ids` is an unknown key, so the first four tests get a `validation` error.
The fifth passes for the wrong reason; that is fine, the others carry the task.

- [ ] **Step 3: Add the input field**

In `src/tools/catalog.ts`, after `shippingCountry`:

```ts
const shippingVariantIds = z
  .array(z.number().int().positive())
  .min(1)
  .max(100)
  .optional()
  .describe(
    'Only the costs for these variant ids, e.g. from list_variants. Leave it out for every ' +
      'variant; an empty list is an error.',
  );
```

- [ ] **Step 4: Use it in the handler**

Add `variant_ids: shippingVariantIds,` to the input object, and narrow the rows before the country
match:

<!-- prettier-ignore -->
```ts
    const wanted = input.variant_ids === undefined ? undefined : new Set(input.variant_ids);
    const forVariants = wanted === undefined ? all : all.filter((row) => wanted.has(row.variant_id));
    const { rows, matched } = matchCountry(forVariants, input.country);
```

(`all` is the rows fetched at the top of the handler, named in Task 6; this `matchCountry` line
replaces the one Task 6 added.)

- [ ] **Step 5: Extend the description**

Change `'shipping method. Filter with country (an ISO code such as DE). Costs are in cents of '` to:

```ts
    'shipping method. Filter with country (an ISO code such as DE) and with variant_ids from ' +
    'list_variants. Costs are in cents of ' +
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/tools/catalog-shipping.test.ts
```

Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/tools/catalog.ts test/tools/catalog-shipping.test.ts
git commit -m "$(cat <<'MSG'
Filter shipping costs by variant id (#9)

Narrows the rows before the country match and the grouping, so asking
about one variant returns one rate per country rather than the whole
blueprint's.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 8: Comparing every method when `method` is left out

**Files:**

- Modify: `src/tools/catalog.ts`
- Test: `test/tools/catalog-shipping.test.ts`

**Interfaces:**

- Consumes: `Catalog.shippingMethods` (Task 1), `type ShippingMethod` (Task 1).
- Produces: `method` becomes optional on `get_shipping_costs`; the module-private
  `isShippingMethod`.

The output was already a `methods[]` array of one entry, so this adds entries rather than changing
the shape. `matched` sits on each entry because methods resolve differently: `standard` may name
Germany while `economy` does not.

- [ ] **Step 1: Write the failing test**

Add `STANDARD_COSTS` to the fixture import and this path constant:

```ts
const STANDARD_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping/standard.json';
```

Then append to the `describe('get_shipping_costs')` block:

```ts
it('compares every method the provider offers when none is named', async () => {
  const { call, api } = await createTestServer({
    routes: {
      [`GET ${METHODS_PATH}`]: methodList(['standard', 'economy']),
      [`GET ${STANDARD_PATH}`]: STANDARD_COSTS,
      [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS,
    },
  });

  const result = await call('get_shipping_costs', IDS);

  const data = expectToolData(result);
  expect((data.methods as { method: string }[]).map((entry) => entry.method)).toEqual([
    'standard',
    'economy',
  ]);
  expect(api.requests).toHaveLength(3);
});

it('resolves the country separately for each method', async () => {
  const { call } = await createTestServer({
    routes: {
      [`GET ${METHODS_PATH}`]: methodList(['standard', 'economy']),
      [`GET ${STANDARD_PATH}`]: STANDARD_COSTS,
      [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS,
    },
  });

  const result = await call('get_shipping_costs', { ...IDS, country: 'DE' });

  // Standard names Germany; economy does not, so only economy falls back.
  expect(expectToolData(result)).toMatchObject({
    country: 'DE',
    methods: [
      {
        method: 'standard',
        matched: 'country',
        profiles: [
          expect.objectContaining({
            countries: ['DE'],
            first_item: { cost: 499, currency: 'USD' },
          }),
        ],
      },
      {
        method: 'economy',
        matched: 'rest_of_the_world',
        profiles: [
          expect.objectContaining({
            countries: ['REST_OF_THE_WORLD'],
            first_item: { cost: 1100, currency: 'USD' },
          }),
        ],
      },
    ],
  });
});

it('does not request a method name it does not recognise', async () => {
  const { call, api } = await createTestServer({
    routes: {
      [`GET ${METHODS_PATH}`]: methodList(['standard', 'sea_freight']),
      [`GET ${STANDARD_PATH}`]: STANDARD_COSTS,
    },
  });

  const result = await call('get_shipping_costs', IDS);

  expect((expectToolData(result).methods as { method: string }[]).map((e) => e.method)).toEqual([
    'standard',
  ]);
  // Two requests, and the teardown check proves no request went to a sea_freight path.
  expect(api.requests).toHaveLength(2);
});

it('still sends one request when a method is named', async () => {
  const { call, api } = await createTestServer({
    routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
  });

  await call('get_shipping_costs', { ...IDS, method: 'economy' });

  expect(api.requests).toHaveLength(1);
});

it('fails the whole call when one method cannot be read', async () => {
  const { call } = await createTestServer({
    routes: {
      [`GET ${METHODS_PATH}`]: methodList(['standard', 'economy']),
      [`GET ${STANDARD_PATH}`]: STANDARD_COSTS,
      [`GET ${ECONOMY_PATH}`]: json(notFoundBody(), 404),
    },
  });

  const result = await call('get_shipping_costs', IDS);

  expectToolError(result, { kind: 'http', status: 404 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/tools/catalog-shipping.test.ts
```

Expected: FAIL — `method` is required, so calls without it report a `validation` error.

- [ ] **Step 3: Add the method guard**

At the bottom of `src/tools/catalog.ts`, next to `matchCountry`:

```ts
/** Whether a name Printify listed is one of the four methods this server can price. */
function isShippingMethod(name: string): name is ShippingMethod {
  return (SHIPPING_METHODS as readonly string[]).includes(name);
}
```

Add `type ShippingMethod` to the `../printify/catalog.js` import.

- [ ] **Step 4: Make `method` optional and fan out**

Replace `getShippingCostsTool`'s `input` and `handler` with their final form:

```ts
  input: z.strictObject({
    blueprint_id: blueprintId,
    print_provider_id: printProviderId,
    method: z
      .enum(SHIPPING_METHODS)
      .optional()
      .describe('Leave out to compare every method this provider offers.'),
    country: shippingCountry,
    variant_ids: shippingVariantIds,
  }),
  handler: async (input, ctx) => {
    const { blueprint_id: blueprint, print_provider_id: provider } = input;
    // Only the four known names can be priced; an undocumented one has no path we know.
    const methods =
      input.method === undefined
        ? (await ctx.catalog.shippingMethods(blueprint, provider, ctx.signal)).filter(
            isShippingMethod,
          )
        : [input.method];
    const wanted = input.variant_ids === undefined ? undefined : new Set(input.variant_ids);

    const entries = await Promise.all(
      methods.map(async (method) => {
        const all = await ctx.catalog.shippingCosts(blueprint, provider, method, ctx.signal);
        const forVariants =
          wanted === undefined ? all : all.filter((row) => wanted.has(row.variant_id));
        const { rows, matched } = matchCountry(forVariants, input.country);
        const profiles = groupShippingProfiles(rows);
        return { method, matched, profile_count: profiles.length, profiles };
      }),
    );

    return {
      blueprint_id: blueprint,
      print_provider_id: provider,
      country: input.country,
      methods: entries,
    };
  },
```

- [ ] **Step 5: Extend the description to its final form**

```ts
  description:
    "Gets a print provider's shipping costs and handling time for a blueprint, broken down by " +
    'shipping method. Leave method out to compare every method the provider offers. Filter with ' +
    'country (an ISO code such as DE) and with variant_ids from list_variants. Costs are in ' +
    'cents of currency (399 = 3.99 USD): first_item is charged for the first item of this ' +
    "blueprint and provider in an order, additional_items for every further one. A profile's " +
    'rate applies to every country and variant it lists. REST_OF_THE_WORLD covers every country ' +
    'no profile names; matched says when a country fell back to it. For a single overall rate ' +
    'in one request, use get_shipping_info.',
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npx vitest run test/tools/catalog-shipping.test.ts
```

Expected: PASS.

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add src/tools/catalog.ts test/tools/catalog-shipping.test.ts
git commit -m "$(cat <<'MSG'
Compare every shipping method in one call (#9)

Leaving `method` out fetches the provider's method list and prices each
known method concurrently, so "what are my options to Germany" is one
tool call rather than four. The country match runs per method, because
standard may name a country economy does not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

---

## Task 9: Cross-reference the v1 tool, and verify the whole branch

**Files:**

- Modify: `src/tools/catalog.ts`
- Test: `test/tools/catalog-shipping.test.ts`

**Interfaces:** none. This task only changes description text and runs the full verification.

`get_shipping_info` and `get_shipping_costs` answer nearly the same question. Both descriptions must
say when to use the other, or the model will pick one at random.

- [ ] **Step 1: Write the failing test**

Append to `test/tools/catalog-shipping.test.ts`:

```ts
describe('the two shipping tools', () => {
  it('point at each other, so the model can choose between them', async () => {
    const { mcp } = await createTestServer();

    const { tools } = await mcp.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']));

    expect(byName.get('get_shipping_info')).toContain('get_shipping_costs');
    expect(byName.get('get_shipping_costs')).toContain('get_shipping_info');
    expect(byName.get('list_shipping_methods')).toContain('get_shipping_costs');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/tools/catalog-shipping.test.ts -t 'point at each other'
```

Expected: FAIL — `get_shipping_info`'s description does not mention `get_shipping_costs`.

- [ ] **Step 3: Extend `get_shipping_info`'s description**

In `src/tools/catalog.ts`, in `getShippingInfoTool`, replace the final line

```ts
    'further one. The costs are not broken down by shipping method.',
```

with

```ts
    'further one. The costs are not broken down by shipping method; get_shipping_costs gives ' +
    'them per method, including economy.',
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run test/tools/catalog-shipping.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full verification**

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

Expected: all four succeed. `npm test` should report roughly 510 to 520 tests passing (the branch
started at 467 and this plan adds about 50). Do not claim success without seeing this output.

- [ ] **Step 6: Commit**

```bash
git add src/tools/catalog.ts test/tools/catalog-shipping.test.ts
git commit -m "$(cat <<'MSG'
Point the v1 and v2 shipping tools at each other (#9)

get_shipping_info is one request and one blended rate; get_shipping_costs
is per method and carries economy. Each description now says when to
reach for the other.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
MSG
)"
```

- [ ] **Step 7: Open the pull request**

Confirm the branch first — other sessions share this repository:

```bash
git rev-parse --abbrev-ref HEAD   # must print feat/9-catalog-shipping-v2
git log --oneline origin/main..HEAD
```

Then push and open the PR, whose body starts with `Closes #9` and ends with
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Move the issue to In review on
the project board, and watch CI on Node 22 and 24.

---

## Notes for the reviewer

- **The one place to look hardest** is `groupShippingProfiles`. Its correctness claim is that a
  profile's `countries × variant_ids` cross product is exactly the set of rows Printify sent. The
  test "does not fold a variant priced differently in one country into the others" is the one that
  would catch a wrong merge; if it is deleted or weakened, the tool starts quoting rates that do
  not apply.
- **`matched` is not decoration.** Without it, a catch-all rate is indistinguishable from a
  country-specific one, and a model will state the wrong shipping cost with confidence.
- **Row volume is unmeasured.** The account has no test shop, so nobody has seen a real v2 response.
  If one turns out to be far larger than assumed, the fix is a cap on `variant_ids` per profile —
  deliberately rejected in the spec, so reopen that decision rather than adding it quietly.
