# get_print_areas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `get_print_areas` tool to the `catalog` toolset that aggregates one blueprint's variant placeholders at one print provider into unique print positions with pixel sizes, every distinct size where variants differ, and the option values to pick variants from.

**Architecture:** One pure module (`src/tools/print-areas.ts`) groups a `readonly Variant[]` into one row per position and decoration method, with no I/O, so the grouping is unit-testable without the MCP harness. One tool in the existing `catalog` toolset calls `ctx.catalog.variants()` — already cached for 1 h and shared with `list_variants` — and hands the list to that module plus the existing `optionValues` helper. No new endpoint, no new `Catalog` method, no new dependency.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), zod 4, `@modelcontextprotocol/server`, vitest, eslint + prettier.

**Spec:** `docs/superpowers/specs/2026-10-05-get-print-areas-design.md`

## Global Constraints

- **Worktree:** work in `../printify-mcp-worktrees/18-print-areas` on branch `feat/18-print-areas`. Another session may switch branches in the main checkout — never `cd` into it. Run `npm ci` once before Task 1 if `node_modules` is absent. Baseline: 741 tests in 44 files.
- **Commit trailer:** every commit message ends with exactly `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. This overrides any default attribution of the harness you run in.
- **ESM:** every relative import carries a `.js` extension, including in tests.
- **Injected services:** interfaces use function-typed properties, not methods (destructuring a method trips `unbound-method`).
- **Verify before claiming:** `npm run lint && npm run typecheck && npm test` must pass before any task's commit. Paste real output; never assert a pass you did not see.
- **Absence assertions:** prove a missing key with `expect(x).not.toHaveProperty('k')`, never with `not.objectContaining({ k: expect.anything() })`, which passes for a key that is present-as-`undefined`.
- **No new dependencies. `src/printify/catalog.ts` does not change.**

## Review Focus

Input classes the spec implies but no acceptance criterion names. Each has a test in the task that owns the code.

1. A variant whose `placeholders` is empty must be counted in the top-level `variant_count` but in no row (Task 3's shape test includes no such variant; Task 1 covers the module, Task 3's cache test does not). → Task 1, "a variant without placeholders joins no row".
2. A placeholder with `height: 0` must not produce `Infinity`, which `JSON.stringify` turns into `null` and `dropNulls` would then strip or keep inconsistently. → Task 1, "aspect_ratio is absent for a zero height".
3. The same position with a different `decoration_method` on another variant must be a second row, not merged into the first. → Task 1, "the same position with two methods gives two rows".
4. A size that is wider but shorter must still be the headline, since `scale` is relative to width. → Task 2, "a wider but shorter size wins".
5. A blueprint with no variants in stock must return a successful empty summary, not an error, because this tool has no `ToolError` for the empty case (unlike `create_product_from_image`). → Task 3, "summarises an empty list as zero variants and no print areas".

---

### Task 1: The print-areas module — one size per position

The simplest complete behaviour: every variant agrees on each position's size. This lands the module, its exported types, the row key (position + decoration method), the counts, `aspect_ratio`, and the edge cases.

**Files:**

- Create: `src/tools/print-areas.ts`
- Create: `test/tools/print-areas.test.ts`

**Interfaces:**

- Consumes: `Variant` from `src/printify/catalog.js` — `{ id: number; title?: string; options: Record<string, string>; placeholders: { position: string; decoration_method?: string; width: number; height: number }[] }`. `decoration_method` is lenient, so it can be `undefined`.
- Produces: `summarisePrintAreas(variants: readonly Variant[]): readonly PrintArea[]`, `PrintArea`, `PrintAreaSize`, `aspectRatio(width, height)`. Task 2 extends the same file; Task 3 imports `summarisePrintAreas` and `PrintArea`.

- [ ] **Step 1: Write the failing tests**

Create `test/tools/print-areas.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Variant } from '../../src/printify/catalog.js';
import { aspectRatio, summarisePrintAreas } from '../../src/tools/print-areas.js';

type Placeholder = Variant['placeholders'][number];

function variantWith(id: number, placeholders: readonly Placeholder[]): Variant {
  return {
    id,
    title: `Variant ${String(id)}`,
    options: { size: 'M' },
    placeholders: [...placeholders],
  };
}

function at(position: string, width: number, height: number, method?: string): Placeholder {
  return { position, decoration_method: method, width, height };
}

describe('summarisePrintAreas with one size per position', () => {
  it('gives one row per position, counting every variant, with no sizes list', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('front', 3153, 3995, 'dtg'), at('back', 3153, 3995, 'dtg')]),
      variantWith(2, [at('front', 3153, 3995, 'dtg'), at('back', 3153, 3995, 'dtg')]),
    ]);

    expect(rows).toEqual([
      {
        position: 'front',
        decoration_method: 'dtg',
        width_px: 3153,
        height_px: 3995,
        aspect_ratio: 0.789,
        variant_count: 2,
      },
      {
        position: 'back',
        decoration_method: 'dtg',
        width_px: 3153,
        height_px: 3995,
        aspect_ratio: 0.789,
        variant_count: 2,
      },
    ]);
    for (const row of rows) expect(row).not.toHaveProperty('sizes');
  });

  it('keeps the rows in the order Printify first lists the positions', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('back', 10, 10, 'dtg'), at('front', 10, 10, 'dtg')]),
      variantWith(2, [
        at('front', 10, 10, 'dtg'),
        at('back', 10, 10, 'dtg'),
        at('neck', 5, 5, 'dtg'),
      ]),
    ]);

    expect(rows.map((row) => row.position)).toEqual(['back', 'front', 'neck']);
    expect(rows.map((row) => row.variant_count)).toEqual([2, 2, 1]);
  });

  it('gives the same position with two methods two rows', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('front', 3153, 3995, 'dtg')]),
      variantWith(2, [at('front', 3153, 3995, 'embroidery')]),
    ]);

    expect(rows).toMatchObject([
      { position: 'front', decoration_method: 'dtg', variant_count: 1 },
      { position: 'front', decoration_method: 'embroidery', variant_count: 1 },
    ]);
  });

  it('keeps a row for a placeholder without a decoration method', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('front', 100, 200)]),
      variantWith(2, [at('front', 100, 200)]),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ position: 'front', variant_count: 2 });
    expect(rows[0]?.decoration_method).toBeUndefined();
  });

  it('counts a variant that lists a position twice once, with the first placeholder', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('front', 100, 200, 'dtg'), at('front', 999, 999, 'dtg')]),
    ]);

    expect(rows).toEqual([
      {
        position: 'front',
        decoration_method: 'dtg',
        width_px: 100,
        height_px: 200,
        aspect_ratio: 0.5,
        variant_count: 1,
      },
    ]);
  });

  it('joins a variant without placeholders to no row, and summarises nothing as nothing', () => {
    expect(
      summarisePrintAreas([variantWith(1, []), variantWith(2, [at('front', 10, 10, 'dtg')])]),
    ).toMatchObject([{ position: 'front', variant_count: 1 }]);
    expect(summarisePrintAreas([])).toEqual([]);
  });

  it('does not change the variants it is given', () => {
    const variants = [
      variantWith(1, [at('front', 100, 200, 'dtg'), at('front', 300, 400, 'dtg')]),
      variantWith(2, [at('front', 100, 200, 'dtg')]),
    ];
    const before = structuredClone(variants);

    summarisePrintAreas(variants);

    expect(variants).toEqual(before);
  });
});

describe('aspectRatio', () => {
  it('rounds width over height to three decimals', () => {
    expect(aspectRatio(3153, 3995)).toBe(0.789);
    expect(aspectRatio(4500, 5100)).toBe(0.882);
    expect(aspectRatio(1200, 1200)).toBe(1);
  });

  it('is absent for a zero height rather than Infinity', () => {
    expect(aspectRatio(100, 0)).toBeUndefined();
    const [row] = summarisePrintAreas([variantWith(1, [at('front', 100, 0, 'dtg')])]);
    expect(row).toMatchObject({ width_px: 100, height_px: 0 });
    expect(row).not.toHaveProperty('aspect_ratio');
  });
});
```

Note on the last assertion: the module leaves `aspect_ratio` out of the object entirely when it is undefined (see Step 3), so `not.toHaveProperty` holds at the module level, and the registry's `dropNulls` would remove it anyway.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tools/print-areas.test.ts`
Expected: FAIL — `Failed to load url ../../src/tools/print-areas.js` (the module does not exist).

- [ ] **Step 3: Write the module**

Create `src/tools/print-areas.ts`:

```ts
import type { Variant } from '../printify/catalog.js';

/** One distinct placeholder size at a position, and the variants that have it. */
export interface PrintAreaSize {
  width_px: number;
  height_px: number;
  /** width / height to three decimals. Left out when the height is 0. */
  aspect_ratio?: number;
  variant_count: number;
  /** The variants with this size at this position, in catalog order. */
  variant_ids: readonly number[];
}

/** One print position and decoration method, aggregated over every variant that has it. */
export interface PrintArea {
  position: string;
  decoration_method: string | undefined;
  /** The largest size's: artwork this wide at scale 1 is never narrower than any variant's placeholder. */
  width_px: number;
  height_px: number;
  aspect_ratio?: number;
  /** The variants that have this position and method at all. */
  variant_count: number;
  /** Every distinct size, largest first. Left out when there is only one. */
  sizes?: readonly PrintAreaSize[];
}

interface SizeBucket {
  width: number;
  height: number;
  variantIds: number[];
}

interface RowBucket {
  position: string;
  decorationMethod: string | undefined;
  /** Keyed by `${width}x${height}`, in first-seen order. */
  sizes: Map<string, SizeBucket>;
}

/**
 * Aggregates variant placeholders into one row per position and decoration method, in the order
 * Printify first lists them. A variant listing a position twice counts once, with the first
 * placeholder. Never changes `variants`.
 */
export function summarisePrintAreas(variants: readonly Variant[]): readonly PrintArea[] {
  const rows = new Map<string, RowBucket>();
  for (const variant of variants) {
    const positionsSeen = new Set<string>();
    for (const placeholder of variant.placeholders) {
      if (positionsSeen.has(placeholder.position)) continue;
      positionsSeen.add(placeholder.position);

      const rowKey = JSON.stringify([placeholder.position, placeholder.decoration_method ?? null]);
      let row = rows.get(rowKey);
      if (row === undefined) {
        row = {
          position: placeholder.position,
          decorationMethod: placeholder.decoration_method,
          sizes: new Map(),
        };
        rows.set(rowKey, row);
      }

      const sizeKey = `${String(placeholder.width)}x${String(placeholder.height)}`;
      const size = row.sizes.get(sizeKey);
      if (size === undefined) {
        row.sizes.set(sizeKey, {
          width: placeholder.width,
          height: placeholder.height,
          variantIds: [variant.id],
        });
      } else {
        size.variantIds.push(variant.id);
      }
    }
  }
  return [...rows.values()].map(toPrintArea);
}

/** width / height to three decimals, or undefined when the height is 0 (never Infinity). */
export function aspectRatio(width: number, height: number): number | undefined {
  if (height === 0) return undefined;
  return Math.round((width / height) * 1000) / 1000;
}

function toPrintArea(row: RowBucket): PrintArea {
  const sizes = [...row.sizes.values()].map(toSize);
  const [largest] = sizes;
  if (largest === undefined) {
    // Unreachable: a row is only created together with its first size.
    throw new TypeError(`the ${row.position} print area has no size`);
  }
  return {
    position: row.position,
    decoration_method: row.decorationMethod,
    width_px: largest.width_px,
    height_px: largest.height_px,
    ...withAspectRatio(largest.width_px, largest.height_px),
    variant_count: sizes.reduce((sum, size) => sum + size.variant_count, 0),
  };
}

function toSize(bucket: SizeBucket): PrintAreaSize {
  return {
    width_px: bucket.width,
    height_px: bucket.height,
    ...withAspectRatio(bucket.width, bucket.height),
    variant_count: bucket.variantIds.length,
    variant_ids: bucket.variantIds,
  };
}

/** `{ aspect_ratio }` when it exists, `{}` otherwise, so an absent ratio is absent, not undefined. */
function withAspectRatio(width: number, height: number): { aspect_ratio?: number } {
  const ratio = aspectRatio(width, height);
  return ratio === undefined ? {} : { aspect_ratio: ratio };
}
```

Task 2 adds the largest-first ordering and the `sizes` list; in this task every row has exactly one size, so `sizes[0]` is the only size.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/print-areas.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Lint, typecheck, full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: clean lint, clean typecheck, 750 tests passing in 45 files (741 + 9). If `prettier --check` complains, run `npx prettier --write src/tools/print-areas.ts test/tools/print-areas.test.ts` and re-run.

- [ ] **Step 6: Commit**

```bash
git add src/tools/print-areas.ts test/tools/print-areas.test.ts
git commit -m "Add the print-areas module: one row per position and method

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The print-areas module — several sizes per position

When variants disagree on a position's size, the row's headline is the largest size and a `sizes` list carries every distinct size with its `variant_ids`.

**Files:**

- Modify: `src/tools/print-areas.ts` (`toPrintArea` only)
- Modify: `test/tools/print-areas.test.ts` (append a `describe`)

**Interfaces:**

- Consumes: everything Task 1 produced.
- Produces: `PrintArea.sizes` populated whenever a row has more than one distinct size, ordered largest first. Task 3's fixture relies on this exact ordering: `[4500 × 5100, 3600 × 4800]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/tools/print-areas.test.ts`, after the `aspectRatio` describe. The helpers `variantWith` and `at` from Task 1 are reused.

```ts
describe('summarisePrintAreas with several sizes per position', () => {
  it('headlines the largest size and lists every size with its variant ids', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('front', 3600, 4800, 'dtg'), at('back', 4500, 5100, 'dtg')]),
      variantWith(2, [at('front', 4500, 5100, 'dtg'), at('back', 4500, 5100, 'dtg')]),
      variantWith(3, [at('front', 3600, 4800, 'dtg'), at('back', 4500, 5100, 'dtg')]),
    ]);

    expect(rows).toEqual([
      {
        position: 'front',
        decoration_method: 'dtg',
        width_px: 4500,
        height_px: 5100,
        aspect_ratio: 0.882,
        variant_count: 3,
        sizes: [
          {
            width_px: 4500,
            height_px: 5100,
            aspect_ratio: 0.882,
            variant_count: 1,
            variant_ids: [2],
          },
          {
            width_px: 3600,
            height_px: 4800,
            aspect_ratio: 0.75,
            variant_count: 2,
            variant_ids: [1, 3],
          },
        ],
      },
      {
        position: 'back',
        decoration_method: 'dtg',
        width_px: 4500,
        height_px: 5100,
        aspect_ratio: 0.882,
        variant_count: 3,
      },
    ]);
    expect(rows[1]).not.toHaveProperty('sizes');
  });

  it('lets a wider but shorter size win the headline', () => {
    const [row] = summarisePrintAreas([
      variantWith(1, [at('front', 3000, 6000, 'dtg')]),
      variantWith(2, [at('front', 4000, 2000, 'dtg')]),
    ]);

    expect(row).toMatchObject({ width_px: 4000, height_px: 2000, aspect_ratio: 2 });
    expect(row?.sizes?.map((size) => size.width_px)).toEqual([4000, 3000]);
  });

  it('breaks an equal width by the greater height', () => {
    const [row] = summarisePrintAreas([
      variantWith(1, [at('front', 4000, 2000, 'dtg')]),
      variantWith(2, [at('front', 4000, 5000, 'dtg')]),
      variantWith(3, [at('front', 4000, 3000, 'dtg')]),
    ]);

    expect(row).toMatchObject({ width_px: 4000, height_px: 5000 });
    expect(row?.sizes?.map((size) => size.height_px)).toEqual([5000, 3000, 2000]);
  });

  it('keeps variant ids in catalog order within a size, not sorted', () => {
    const [row] = summarisePrintAreas([
      variantWith(30, [at('front', 100, 100, 'dtg')]),
      variantWith(10, [at('front', 200, 200, 'dtg')]),
      variantWith(20, [at('front', 100, 100, 'dtg')]),
    ]);

    expect(row?.sizes).toEqual([
      { width_px: 200, height_px: 200, aspect_ratio: 1, variant_count: 1, variant_ids: [10] },
      { width_px: 100, height_px: 100, aspect_ratio: 1, variant_count: 2, variant_ids: [30, 20] },
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tools/print-areas.test.ts`
Expected: the four new tests FAIL. The first fails because `sizes` is missing and the headline is 3600 (first seen); the other three fail on the headline or the missing `sizes`. The Task 1 tests still pass.

- [ ] **Step 3: Order the sizes and add the list**

In `src/tools/print-areas.ts`, replace `toPrintArea` with:

```ts
function toPrintArea(row: RowBucket): PrintArea {
  // Stable sort: sizes that compare equal are the same bucket, so order among them never arises.
  const sizes = [...row.sizes.values()].sort(byLargest).map(toSize);
  const [largest] = sizes;
  if (largest === undefined) {
    // Unreachable: a row is only created together with its first size.
    throw new TypeError(`the ${row.position} print area has no size`);
  }
  return {
    position: row.position,
    decoration_method: row.decorationMethod,
    width_px: largest.width_px,
    height_px: largest.height_px,
    ...withAspectRatio(largest.width_px, largest.height_px),
    variant_count: sizes.reduce((sum, size) => sum + size.variant_count, 0),
    ...(sizes.length > 1 ? { sizes } : {}),
  };
}

/** Greater width first; equal widths by greater height. Scale is relative to width. */
function byLargest(a: SizeBucket, b: SizeBucket): number {
  if (a.width !== b.width) return b.width - a.width;
  return b.height - a.height;
}
```

`byLargest` goes below `toSize`, next to the other helpers. Also update the `PrintArea.sizes` doc comment if you shortened it in Task 1; the interface itself does not change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/print-areas.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Lint, typecheck, full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: clean, 754 tests in 45 files.

- [ ] **Step 6: Commit**

```bash
git add src/tools/print-areas.ts test/tools/print-areas.test.ts
git commit -m "List every placeholder size per position, largest first

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The `get_print_areas` tool, its fixture and harness tests

**Files:**

- Modify: `src/tools/catalog.ts` (imports; new tool after `listVariantsTool`; `catalogTools` entry; `export` on `optionValues`)
- Modify: `test/fixtures/catalog.ts` (append `PRINT_AREA_VARIANTS` after `VARIANTS_WITH_OUT_OF_STOCK`)
- Modify: `test/tools/catalog-toolset.test.ts` (imports; new `describe('get_print_areas')` after the `list_variants` describe)

**Interfaces:**

- Consumes: `summarisePrintAreas` from `./print-areas.js`; `optionValues(variants: readonly Variant[]): Record<string, string[]>`, already in `src/tools/catalog.ts` as a module-private function; `ctx.catalog.variants(blueprintId, printProviderId, { showOutOfStock }, signal): Promise<VariantList>` where `VariantList` is `{ id?: number; title?: string; variants: Variant[] }`; the schemas `blueprintId`, `printProviderId` and the `READ_ONLY` annotations constant, all at the top of `catalog.ts`.
- Produces: `getPrintAreasTool`, registered in `catalogTools`; the `PRINT_AREA_VARIANTS` fixture. Task 4 adds the tool's name to the CI loop and cross-references it from two descriptions.

- [ ] **Step 1: Add the fixture**

Append to `test/fixtures/catalog.ts`, directly after `VARIANTS_WITH_OUT_OF_STOCK`:

```ts
/**
 * Four variants whose `front` comes in two sizes (4500 × 5100 on S, 3600 × 4800 on XL), whose
 * `back` is one size on all four, and one of which adds a `left_sleeve`.
 */
export const PRINT_AREA_VARIANTS = {
  id: 3,
  title: 'DJ',
  variants: [
    {
      id: 18001,
      title: 'White / S',
      options: { color: 'White', size: 'S' },
      placeholders: [
        { position: 'front', decoration_method: 'dtg', height: 5100, width: 4500 },
        { position: 'back', decoration_method: 'dtg', height: 5100, width: 4500 },
      ],
    },
    {
      id: 18002,
      title: 'White / XL',
      options: { color: 'White', size: 'XL' },
      placeholders: [
        { position: 'front', decoration_method: 'dtg', height: 4800, width: 3600 },
        { position: 'back', decoration_method: 'dtg', height: 5100, width: 4500 },
      ],
    },
    {
      id: 18003,
      title: 'Black / S',
      options: { color: 'Black', size: 'S' },
      placeholders: [
        { position: 'front', decoration_method: 'dtg', height: 5100, width: 4500 },
        { position: 'back', decoration_method: 'dtg', height: 5100, width: 4500 },
      ],
    },
    {
      id: 18004,
      title: 'Black / XL',
      options: { color: 'Black', size: 'XL' },
      placeholders: [
        { position: 'front', decoration_method: 'dtg', height: 4800, width: 3600 },
        { position: 'back', decoration_method: 'dtg', height: 5100, width: 4500 },
        { position: 'left_sleeve', decoration_method: 'dtg', height: 1200, width: 1200 },
      ],
    },
  ],
};
```

- [ ] **Step 2: Write the failing harness tests**

In `test/tools/catalog-toolset.test.ts`:

Add `PRINT_AREA_VARIANTS` to the import list from `'../fixtures/catalog.js'` (alphabetical: between `PRINT_PROVIDERS` and `printProviderWith`? No — the list is sorted case-insensitively: `PRINT_AREA_VARIANTS` goes before `PRINT_PROVIDER`).

Add one path constant next to the others at the top:

```ts
const PRINT_AREA_VARIANTS_PATH = '/v1/catalog/blueprints/5/print_providers/29/variants.json';
```

Then add, directly after the `describe('list_variants', …)` block's closing `});`:

```ts
describe('get_print_areas', () => {
  it('aggregates the placeholders into positions, with sizes only where they differ', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${PRINT_AREA_VARIANTS_PATH}`]: PRINT_AREA_VARIANTS },
    });

    const data = expectToolData(
      await call('get_print_areas', { blueprint_id: 5, print_provider_id: 29 }),
    );

    expect(data).toEqual({
      print_provider: { id: 3, title: 'DJ' },
      variant_count: 4,
      option_values: { color: ['White', 'Black'], size: ['S', 'XL'] },
      print_areas: [
        {
          position: 'front',
          decoration_method: 'dtg',
          width_px: 4500,
          height_px: 5100,
          aspect_ratio: 0.882,
          variant_count: 4,
          sizes: [
            {
              width_px: 4500,
              height_px: 5100,
              aspect_ratio: 0.882,
              variant_count: 2,
              variant_ids: [18001, 18003],
            },
            {
              width_px: 3600,
              height_px: 4800,
              aspect_ratio: 0.75,
              variant_count: 2,
              variant_ids: [18002, 18004],
            },
          ],
        },
        {
          position: 'back',
          decoration_method: 'dtg',
          width_px: 4500,
          height_px: 5100,
          aspect_ratio: 0.882,
          variant_count: 4,
        },
        {
          position: 'left_sleeve',
          decoration_method: 'dtg',
          width_px: 1200,
          height_px: 1200,
          aspect_ratio: 1,
          variant_count: 1,
        },
      ],
    });
    const areas = data['print_areas'] as Record<string, unknown>[];
    expect(areas[1]).not.toHaveProperty('sizes');
    expect(areas[2]).not.toHaveProperty('sizes');
    expect(api.expectRequest('GET', PRINT_AREA_VARIANTS_PATH).query).toEqual({});
  });

  it('shares its cache entry with list_variants', async () => {
    const { call, api } = await createTestServer({ routes: VARIANT_ROUTES });

    await call('list_variants', { blueprint_id: 3, print_provider_id: 29 });
    const data = expectToolData(
      await call('get_print_areas', { blueprint_id: 3, print_provider_id: 29 }),
    );

    expect(data).toMatchObject({
      variant_count: 3,
      print_areas: [
        {
          position: 'back',
          decoration_method: 'dtf',
          width_px: 3153,
          height_px: 3995,
          variant_count: 3,
        },
        {
          position: 'front',
          decoration_method: 'embroidery',
          width_px: 3153,
          height_px: 3995,
          variant_count: 3,
        },
      ],
    });
    api.expectRequest('GET', VARIANTS_PATH);
  });

  it('summarises an empty list as zero variants and no print areas', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${PRINT_AREA_VARIANTS_PATH}`]: { id: 3, title: 'DJ', variants: [] } },
    });

    const data = expectToolData(
      await call('get_print_areas', { blueprint_id: 5, print_provider_id: 29 }),
    );

    expect(data).toEqual({
      print_provider: { id: 3, title: 'DJ' },
      variant_count: 0,
      option_values: {},
      print_areas: [],
    });
  });

  it('reports an unknown blueprint or provider as a 404', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${PRINT_AREA_VARIANTS_PATH}`]: json(notFoundBody(), 404) },
    });

    const result = await call('get_print_areas', { blueprint_id: 5, print_provider_id: 29 });

    expectToolError(result, { kind: 'http', status: 404 });
  });

  it('rejects an unknown input key before any request', async () => {
    const { call, api } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('get_print_areas', {
      blueprint_id: 3,
      print_provider_id: 29,
      show_out_of_stock: true,
    });

    expectToolError(result, { kind: 'validation' });
    expect(api.requests).toEqual([]);
  });
});
```

`VARIANT_ROUTES`, `VARIANTS_PATH`, `json`, `notFoundBody`, `expectToolData` and `expectToolError` are already imported or defined in this file.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/tools/catalog-toolset.test.ts`
Expected: the five new tests FAIL. Each `call('get_print_areas', …)` returns an error result for an unknown tool, so `expectToolData` throws "expected a successful tool result" and the two `expectToolError` tests fail on `kind` (they get the SDK's unknown-tool error, not `http`/`validation`). All existing tests still pass.

- [ ] **Step 4: Add the tool**

In `src/tools/catalog.ts`:

1. Add the import, after the `blueprint-search.js` import:

```ts
import { summarisePrintAreas } from './print-areas.js';
```

2. Change `function optionValues(` to `export function optionValues(`. Its doc comment and body stay as they are.

3. Insert the tool directly after `listVariantsTool` (before `listPrintProvidersTool`):

```ts
export const getPrintAreasTool = defineTool({
  name: 'get_print_areas',
  toolset: 'catalog',
  description:
    'Summarises where artwork can go on a blueprint from one print provider and how big it must ' +
    'be: each print position (front, back, sleeve …) with its decoration method, its printable ' +
    'size in pixels and its aspect ratio, aggregated over every variant in stock, plus the ' +
    'colors and sizes to choose variants from. Use it before create_product or ' +
    'create_product_from_image to size and place artwork; list_variants gives the same ' +
    'placeholders per variant. Placement: x and y run from 0 to 1 across the print area with ' +
    '0.5/0.5 the centre; scale is the image width divided by the placeholder width, so 1 fills ' +
    'the width. Artwork at least width_px wide at scale 1 avoids the low-resolution error (code ' +
    "8203). When a position's size differs between variants, width_px and height_px are the " +
    'largest and sizes lists each size with its variant_ids, so print_areas can give each group ' +
    'its own placement.',
  annotations: READ_ONLY,
  input: z.strictObject({ blueprint_id: blueprintId, print_provider_id: printProviderId }),
  handler: async (input, ctx) => {
    const list = await ctx.catalog.variants(
      input.blueprint_id,
      input.print_provider_id,
      { showOutOfStock: false },
      ctx.signal,
    );
    return {
      print_provider: { id: list.id, title: list.title },
      variant_count: list.variants.length,
      option_values: optionValues(list.variants),
      print_areas: summarisePrintAreas(list.variants),
    };
  },
});
```

4. Register it in `catalogTools`, after `listVariantsTool`:

```ts
export const catalogTools: readonly Tool[] = [
  searchBlueprintsTool,
  getBlueprintTool,
  listBlueprintProvidersTool,
  listVariantsTool,
  getPrintAreasTool,
  getShippingInfoTool,
  listPrintProvidersTool,
  getPrintProviderTool,
  listShippingMethodsTool,
  getShippingCostsTool,
];
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/tools/catalog-toolset.test.ts test/tools/catalog.test.ts`
Expected: PASS. The registry lint in `catalog.test.ts` passes the new tool unchanged: read-only, no gate, snake_case name, `strictObject` input.

- [ ] **Step 6: Lint, typecheck, full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: clean, 759 tests in 45 files. If Prettier rewraps the long `expectToolData(await call(...))` lines in the test, accept its formatting with `npx prettier --write test/tools/catalog-toolset.test.ts test/fixtures/catalog.ts`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/catalog.ts test/fixtures/catalog.ts test/tools/catalog-toolset.test.ts
git commit -m "Add get_print_areas to the catalog toolset

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Cross-references and the CI smoke test

Two one-sentence description edits that point models at the new tool, and the smoke-test loop that proves the built artifact registers it.

**Files:**

- Modify: `src/tools/catalog.ts` (`listVariantsTool` description)
- Modify: `src/tools/workflows.ts` (`create_product_from_image` description)
- Modify: `.github/workflows/ci.yml` (the `for tool in` loop)
- Modify: `test/tools/catalog-toolset.test.ts` (one assertion)

**Interfaces:**

- Consumes: the `get_print_areas` tool from Task 3.
- Produces: nothing new in code.

- [ ] **Step 1: Write the failing test**

In `test/tools/catalog-toolset.test.ts`, inside `describe('get_print_areas')`, add:

```ts
it('is pointed at by the list_variants and create_product_from_image descriptions', async () => {
  const { mcp } = await createTestServer();

  const { tools } = await mcp.listTools();

  for (const name of ['list_variants', 'create_product_from_image']) {
    const tool = tools.find((candidate) => candidate.name === name);
    expect(tool?.description).toContain('get_print_areas');
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tools/catalog-toolset.test.ts -t "pointed at"`
Expected: FAIL — `expected '…' to contain 'get_print_areas'` for `list_variants`.

- [ ] **Step 3: Edit the two descriptions**

In `src/tools/catalog.ts`, `listVariantsTool`'s description currently ends:

```ts
    'print positions with their size in pixels. Filter with colors and sizes: exact names, ' +
    'ignoring case, and option_values lists every name. Only variants in stock are listed ' +
    'unless show_out_of_stock is set; then every variant says whether it is in_stock.',
```

Change the last line to:

```ts
    'unless show_out_of_stock is set; then every variant says whether it is in_stock. ' +
    'get_print_areas summarises the print positions and their sizes across all variants.',
```

In `src/tools/workflows.ts`, `create_product_from_image`'s description contains:

```ts
    'every variant in stock), and the price in cents, optionally per size. Warns when an image ' +
    'has fewer pixels than it is printed across; strict refuses instead. If the call fails ' +
```

Change those two lines to:

```ts
    'every variant in stock), and the price in cents, optionally per size. get_print_areas ' +
    'shows the positions and their pixel sizes first. Warns when an image has fewer pixels ' +
    'than it is printed across; strict refuses instead. If the call fails ' +
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/tools/catalog-toolset.test.ts test/tools/workflows.test.ts`
Expected: PASS. If a workflows test pins the full description text, it will fail here and show the pinned string; update that string to the new wording — the spec requires the sentence.

- [ ] **Step 5: Add the tool to the CI smoke loop**

In `.github/workflows/ci.yml`, the loop currently reads:

<!-- prettier-ignore -->
```yaml
          for tool in search_blueprints get_blueprint list_blueprint_providers list_variants \
            get_shipping_info list_print_providers get_print_provider \
            list_shipping_methods get_shipping_costs \
            upload_image list_uploads get_upload \
            list_products get_product get_product_gpsr create_product update_product \
            create_product_from_image; do
```

Change the first line to:

<!-- prettier-ignore -->
```yaml
          for tool in search_blueprints get_blueprint list_blueprint_providers list_variants \
            get_print_areas \
```

so the loop begins `search_blueprints get_blueprint list_blueprint_providers list_variants \` then `get_print_areas \` then `get_shipping_info …` as before.

- [ ] **Step 6: Run the smoke check locally**

Run, from the worktree root:

```bash
npm run build && output=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | PRINTIFY_API_TOKEN=smoke-token-not-real node dist/index.js 2>/dev/null) && grep -q '"name":"get_print_areas"' <<<"$output" && echo registered
```

Expected: `registered`. This is the CI step's own request sequence (`.github/workflows/ci.yml`, "Smoke-run the built server") without its `timeout 10`, which macOS lacks.

- [ ] **Step 7: Lint, typecheck, full suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: clean, 760 tests in 45 files.

- [ ] **Step 8: Commit**

```bash
git add src/tools/catalog.ts src/tools/workflows.ts .github/workflows/ci.yml test/tools/catalog-toolset.test.ts
git commit -m "Point list_variants and create_product_from_image at get_print_areas, smoke-test it

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

- [ ] **Step 9: Check the trailers**

Run: `git log --format='%h %s | %(trailers:only,unfold)' origin/main..HEAD`
Expected: five commits (the spec, Tasks 1–4), each ending with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

---

## Spec coverage

| Spec section                                                                       | Task                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/tools/print-areas.ts` interface, algorithm, largest size, numbers, edge cases | 1, 2                                                         |
| `get_print_areas` input, handler, output, description, registration                | 3                                                            |
| Cross-references (`list_variants`, `create_product_from_image`)                    | 4                                                            |
| `test/tools/print-areas.test.ts` cases                                             | 1, 2                                                         |
| `test/tools/catalog-toolset.test.ts` cases                                         | 3 (shape, cache sharing, 404, unknown key), 4 (descriptions) |
| `PRINT_AREA_VARIANTS` fixture                                                      | 3                                                            |
| CI smoke loop                                                                      | 4                                                            |
| Decisions 1–6                                                                      | 1–3 embody them; nothing to implement separately             |
