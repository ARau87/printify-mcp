# `create_product_from_image` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One write tool, `create_product_from_image` (toolset `workflows`), that uploads artwork, selects variants, computes placement per placeholder size and creates an unpublished product in one call.

**Architecture:** Three pure modules in `src/tools/` (`placement.ts`, `variant-selection.ts`, `product-plan.ts`) hold all the maths and validation; `src/tools/workflows.ts` only does I/O in a fixed order (shop, variants, validate, resolve images, upload, place, create). A failure after the first upload is wrapped in `PartialFailureError`, which `runTool` reports as its cause plus an `uploaded` field.

**Tech Stack:** TypeScript ~6.0, zod 4, `@modelcontextprotocol/server` v2, vitest 5, the fake Printify API in `test/support/`.

**Spec:** `docs/superpowers/specs/2026-09-30-create-product-from-image-design.md`

## Global Constraints

- Work in the worktree `../printify-mcp-worktrees/19-create-product-from-image` on branch `feat/19-create-product-from-image`. Check `git branch --show-current` before every commit: other sessions share the main checkout.
- Every commit message ends with exactly this trailer, which overrides any attribution your own harness adds: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- No new dependencies. No edits outside the files each task lists.
- Before each commit: `npm run lint` (eslint strictTypeChecked + `prettier --check .`), `npm run typecheck` and `npm test` all pass. Run `npx prettier --write <files>` on the files you touched if lint reports formatting.
- Template literals wrap numbers in `String(...)` (lint rule `restrict-template-expressions`). No `!` non-null assertions.
- Baseline on `main` after #11: 681 tests. After Task 5: 736.
- Tool descriptions name only tools that exist in `ALL_TOOLS`.

## Review Focus

Each line is pinned by a test in the task named.

1. A blueprint without a `size` option (posters) given `sizes` or `by_size`: the error says the variants have no size, not "unknown size" with an empty list (Task 2: "says so when the variants have no size option at all", "says \"none\" when …").
2. An image with two sources: the error names `upload_id`, `url` and `file_path`, never `base64`, and nothing is posted (Task 5: "refuses an image with two sources").
3. An unknown `upload_id`: Printify's 404 comes back before any upload, with no `uploaded` field (Task 5: "passes on a 404 for an unknown upload_id").
4. Printify reports no pixel size: `contain` refuses with a hint pointing at `custom` and lists the upload; `custom` succeeds with a warning (Task 5: two tests).
5. The second of two uploads fails: `uploaded` lists only the first (Task 5: "lists only the uploads that happened").

Also for reviewers: every negative assertion in these tests was mutation-checked while the plan was written (no wrapping, no dedup, upload before validation each turn tests red). If you change a test, keep it able to fail.

## Deviation from the spec

The spec says `next_step` names `publish_product` only when that tool exists in `ALL_TOOLS`. Reading `ALL_TOOLS` from `workflows.ts` would import `index.ts`, which imports `workflows.ts`: a cycle that throws a TDZ `ReferenceError` whenever a module imports `workflows.ts` first. `next_step` is therefore static text without a tool name, and a guard test ("does not name publish_product in next_step …") fails on purpose once the publishing toolset (#12) adds `publish_product`, so that issue updates the text. The spec is amended to match in Task 5.

## Files

- Create `src/tools/placement.ts`: placement maths and the resolution check. Pure.
- Create `src/tools/variant-selection.ts`: filters, position and `by_size` checks, grouping by placeholder size. Pure; #18 reuses the grouping.
- Create `src/tools/product-plan.ts`: prices, the create payload, mock-up selection. Pure.
- Create `src/tools/workflows.ts`: the tool and `workflowsTools`.
- Modify `src/tools/define.ts` (`PartialFailureError`), `src/tools/run.ts` (its branch), `src/tools/index.ts` (the `workflows:` line), `test/support/expect.ts` (`uploaded` field), `.github/workflows/ci.yml` (smoke list).
- Tests: `test/tools/placement.test.ts`, `test/tools/variant-selection.test.ts`, `test/tools/product-plan.test.ts`, `test/tools/workflows.test.ts` (new); `test/tools/run.test.ts` (two cases added).

---

### Task 1: Placement maths

**Files:**

- Create: `src/tools/placement.ts`
- Test: `test/tools/placement.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `interface Size { width: number; height: number }`; `type Placement` (contain | cover | width | custom, see code); `interface ImagePlacement { x; y; scale; angle }`; `interface Placed { image: ImagePlacement; printedWidth: number }`; `const DEFAULT_PLACEMENT: Placement`; `placeImage(placeholder: Size, image: Size | undefined, placement: Placement): Placed`; `resolutionWarning(check: { fileName; imageWidth; printedWidth; position; variantCount }): string | undefined`.

- [ ] **Step 1: Write the failing test** — `test/tools/placement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { placeImage, resolutionWarning } from '../../src/tools/placement.js';

const PORTRAIT_AREA = { width: 4000, height: 5000 };
const PORTRAIT_ART = { width: 2000, height: 3000 };
const LANDSCAPE_ART = { width: 3000, height: 2000 };

describe('placeImage', () => {
  it('contain shrinks artwork taller than the print area until it fits', () => {
    expect(placeImage(PORTRAIT_AREA, PORTRAIT_ART, { mode: 'contain' })).toEqual({
      image: { x: 0.5, y: 0.5, scale: 0.8333, angle: 0 },
      printedWidth: (5000 / 4000) * (2000 / 3000) * 4000,
    });
  });

  it('contain never scales past the print area width', () => {
    expect(placeImage(PORTRAIT_AREA, LANDSCAPE_ART, { mode: 'contain' }).image).toEqual({
      x: 0.5,
      y: 0.5,
      scale: 1,
      angle: 0,
    });
  });

  it('cover fills the print area in both directions', () => {
    expect(placeImage(PORTRAIT_AREA, PORTRAIT_ART, { mode: 'cover' }).image.scale).toBe(1);
    expect(placeImage(PORTRAIT_AREA, LANDSCAPE_ART, { mode: 'cover' }).image.scale).toBe(1.875);
  });

  it('width sets the scale from width_pct', () => {
    expect(placeImage(PORTRAIT_AREA, PORTRAIT_ART, { mode: 'width', width_pct: 80 })).toEqual({
      image: { x: 0.5, y: 0.5, scale: 0.8, angle: 0 },
      printedWidth: 3200,
    });
  });

  it('top puts the top edge of the artwork at the top of the print area', () => {
    // The artwork is 0.8 × 2/3 = 0.5333 of the print area high, so its centre is at 0.2667.
    expect(
      placeImage(PORTRAIT_AREA, LANDSCAPE_ART, { mode: 'contain', align: 'top' }).image.y,
    ).toBe(0.2667);
  });

  it('offset_y_pct moves the artwork down from either alignment, or up when negative', () => {
    expect(
      placeImage(PORTRAIT_AREA, LANDSCAPE_ART, { mode: 'contain', align: 'top', offset_y_pct: 5 })
        .image.y,
    ).toBe(0.3167);
    expect(
      placeImage(PORTRAIT_AREA, LANDSCAPE_ART, { mode: 'contain', offset_y_pct: -10 }).image.y,
    ).toBe(0.4);
  });

  it('passes angle on', () => {
    expect(
      placeImage(PORTRAIT_AREA, PORTRAIT_ART, { mode: 'contain', angle: 90 }).image.angle,
    ).toBe(90);
  });

  it('passes custom through unchanged, without needing the image size', () => {
    expect(
      placeImage(PORTRAIT_AREA, undefined, {
        mode: 'custom',
        x: 0.31234567,
        y: 0.7,
        scale: 1.2,
        angle: 45,
      }),
    ).toEqual({ image: { x: 0.31234567, y: 0.7, scale: 1.2, angle: 45 }, printedWidth: 4800 });
  });

  it('rounds to 4 decimal places', () => {
    // fit = 4919/3951 × 4000/5000 = 0.99600101…
    const placed = placeImage(
      { width: 3951, height: 4919 },
      { width: 4000, height: 5000 },
      {
        mode: 'contain',
      },
    );
    expect(placed.image.scale).toBe(0.996);
  });

  it('refuses a mode that needs the image size without one', () => {
    expect(() => placeImage(PORTRAIT_AREA, undefined, { mode: 'contain' })).toThrow(
      'placement mode "contain" needs the image size',
    );
  });
});

describe('resolutionWarning', () => {
  const check = { fileName: 'sunset.png', printedWidth: 2000, position: 'front', variantCount: 3 };

  it('says nothing when the image is exactly as wide as it is printed', () => {
    expect(resolutionWarning({ ...check, imageWidth: 2000 })).toBeUndefined();
  });

  it('warns when the image is one pixel narrower', () => {
    expect(resolutionWarning({ ...check, imageWidth: 1999 })).toBe(
      'sunset.png is 1999 px wide but needs 2000 px on front (99%) for 3 variants',
    );
  });

  it('says "1 variant" for one', () => {
    expect(resolutionWarning({ ...check, imageWidth: 500, variantCount: 1 })).toBe(
      'sunset.png is 500 px wide but needs 2000 px on front (25%) for 1 variant',
    );
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/tools/placement.test.ts`
Expected: FAIL: cannot resolve `../../src/tools/placement.js`.

- [ ] **Step 3: Implement** — `src/tools/placement.ts`:

```ts
/** A pixel size: a placeholder's or an image's. */
export interface Size {
  width: number;
  height: number;
}

export type Align = 'center' | 'top';

/** Where a design's artwork goes, as the tool takes it. */
export type Placement =
  | {
      mode: 'contain' | 'cover';
      align?: Align | undefined;
      offset_y_pct?: number | undefined;
      angle?: number | undefined;
    }
  | {
      mode: 'width';
      width_pct: number;
      align?: Align | undefined;
      offset_y_pct?: number | undefined;
      angle?: number | undefined;
    }
  | { mode: 'custom'; x: number; y: number; scale: number; angle?: number | undefined };

/** One image's position in one placeholder, as `print_areas` takes it. */
export interface ImagePlacement {
  x: number;
  y: number;
  scale: number;
  angle: number;
}

export interface Placed {
  /** Rounded to 4 decimal places, except `custom`, which is passed through. */
  image: ImagePlacement;
  /** The printed width in placeholder pixels, before rounding: what the resolution check uses. */
  printedWidth: number;
}

export const DEFAULT_PLACEMENT: Placement = { mode: 'contain' };

/**
 * Places an image in a placeholder. Printify's `x` and `y` are the image centre as a fraction of
 * the placeholder, and `scale` is the image width divided by the placeholder width. `image` may
 * be undefined only for `custom`, which needs no image size.
 */
export function placeImage(
  placeholder: Size,
  image: Size | undefined,
  placement: Placement,
): Placed {
  const angle = placement.angle ?? 0;
  if (placement.mode === 'custom') {
    const { x, y, scale } = placement;
    return { image: { x, y, scale, angle }, printedWidth: scale * placeholder.width };
  }
  if (image === undefined) {
    throw new TypeError(`placement mode "${placement.mode}" needs the image size`);
  }
  const scale = scaleFor(placeholder, image, placement);
  // The image height as a fraction of the placeholder height.
  const heightFraction =
    scale * (placeholder.width / placeholder.height) * (image.height / image.width);
  const top = placement.align === 'top' ? heightFraction / 2 : 0.5;
  const y = top + (placement.offset_y_pct ?? 0) / 100;
  return {
    image: { x: 0.5, y: round(y), scale: round(scale), angle },
    printedWidth: scale * placeholder.width,
  };
}

function scaleFor(
  placeholder: Size,
  image: Size,
  placement: Exclude<Placement, { mode: 'custom' }>,
): number {
  if (placement.mode === 'width') return placement.width_pct / 100;
  // The scale at which the image height equals the placeholder height.
  const fit = (placeholder.height / placeholder.width) * (image.width / image.height);
  return placement.mode === 'contain' ? Math.min(1, fit) : Math.max(1, fit);
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export interface ResolutionCheck {
  fileName: string;
  imageWidth: number;
  printedWidth: number;
  position: string;
  variantCount: number;
}

/**
 * A warning when the image has fewer pixels than it is printed across, else undefined. Printify
 * does not publish the threshold of its error 8203, so this catches the obvious cases only.
 */
export function resolutionWarning(check: ResolutionCheck): string | undefined {
  const { fileName, imageWidth, printedWidth, position, variantCount } = check;
  if (imageWidth >= printedWidth) return undefined;
  const needed = Math.ceil(printedWidth);
  const percent = Math.floor((imageWidth / printedWidth) * 100);
  const variants = `${String(variantCount)} variant${variantCount === 1 ? '' : 's'}`;
  return (
    `${fileName} is ${String(imageWidth)} px wide but needs ${String(needed)} px on ${position} ` +
    `(${String(percent)}%) for ${variants}`
  );
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run test/tools/placement.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Lint, typecheck, full suite, commit**

Run `npm run lint && npm run typecheck && npm test` (694 tests), then:

```bash
git add src/tools/placement.ts test/tools/placement.test.ts
git commit -m "Add the placement maths for create_product_from_image

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Variant selection and grouping

**Files:**

- Create: `src/tools/variant-selection.ts`
- Test: `test/tools/variant-selection.test.ts`

**Interfaces:**

- Consumes: `Size` from Task 1; `Variant` from `src/printify/catalog.ts` (`{ id: number; title; options: Record<string, string>; placeholders: { position; decoration_method; width; height }[] }`); `ToolError` from `src/tools/define.ts`.
- Produces: `interface VariantFilters { colors?; sizes? }`; `interface PlaceholderGroup { variantIds: number[]; placeholders: ReadonlyMap<string, Size> }`; `selectVariants(variants: readonly Variant[], filters: VariantFilters): Variant[]`; `checkPositions(selected: readonly Variant[], positions: readonly string[]): void`; `checkPriceSizes(selected: readonly Variant[], bySize: Readonly<Record<string, number>> | undefined): void`; `groupByPlaceholders(selected: readonly Variant[], positions: readonly string[]): PlaceholderGroup[]`. All refusals are `ToolError`s with the exact messages the tests assert.

- [ ] **Step 1: Write the failing test** — `test/tools/variant-selection.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Variant } from '../../src/printify/catalog.js';
import { ToolError } from '../../src/tools/define.js';
import {
  checkPositions,
  checkPriceSizes,
  groupByPlaceholders,
  selectVariants,
} from '../../src/tools/variant-selection.js';

const REGULAR = { width: 4000, height: 5000 };
const LARGE = { width: 4800, height: 5000 };

function tee(id: number, color: string, size: string, front = REGULAR): Variant {
  return {
    id,
    title: `${color} / ${size}`,
    options: { color, size },
    placeholders: [
      { position: 'front', decoration_method: 'dtg', ...front },
      { position: 'back', decoration_method: 'dtg', ...REGULAR },
    ],
  };
}

const TEES = [tee(1, 'Black', 'S'), tee(2, 'Black', 'M'), tee(3, 'White', 'S'), tee(4, 'Red', 'M')];

/** Runs `run`, expecting a ToolError, and returns it. */
function toolError(run: () => unknown): ToolError {
  try {
    run();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected a ToolError, nothing was thrown');
}

describe('selectVariants', () => {
  it('keeps every variant when no filter is given', () => {
    expect(selectVariants(TEES, {}).map((variant) => variant.id)).toEqual([1, 2, 3, 4]);
  });

  it('matches colors and sizes ignoring case and surrounding spaces', () => {
    const selected = selectVariants(TEES, { colors: [' black', 'WHITE '], sizes: ['s'] });
    expect(selected.map((variant) => variant.id)).toEqual([1, 3]);
  });

  it('names an unknown color and lists the colors in stock', () => {
    const error = toolError(() => selectVariants(TEES, { colors: ['Black', 'Neon', 'Pink'] }));
    expect(error.message).toBe(
      'Unknown colors: "Neon", "Pink". The colors in stock are: Black, White, Red.',
    );
  });

  it('names an unknown size and lists the sizes in stock', () => {
    const error = toolError(() => selectVariants(TEES, { sizes: ['XXL'] }));
    expect(error.message).toBe('Unknown sizes: "XXL". The sizes in stock are: S, M.');
  });

  it('refuses a combination no variant has', () => {
    const error = toolError(() => selectVariants(TEES, { colors: ['White'], sizes: ['M'] }));
    expect(error.message).toBe(
      'No variant in stock has one of the colors White in one of the sizes M.',
    );
  });

  it('refuses when nothing is in stock', () => {
    expect(toolError(() => selectVariants([], {})).message).toBe(
      'No variant of this blueprint is in stock at this print provider.',
    );
  });

  it('says so when the variants have no size option at all', () => {
    const poster: Variant = {
      id: 9,
      title: 'Matte',
      options: { paper: 'Matte' },
      placeholders: [{ position: 'front', decoration_method: undefined, ...REGULAR }],
    };
    const error = toolError(() => selectVariants([poster], { sizes: ['M'] }));
    expect(error.message).toBe('These variants have no size option, so sizes cannot filter them.');
  });
});

describe('checkPositions', () => {
  it('accepts positions every selected variant has', () => {
    expect(() => {
      checkPositions(TEES, ['front', 'back']);
    }).not.toThrow();
  });

  it('names the positions the selected variants have', () => {
    const error = toolError(() => {
      checkPositions(TEES, ['sleeve']);
    });
    expect(error.message).toBe(
      '"sleeve" is not a print position of 4 of the 4 selected variants. Every selected ' +
        'variant has: front, back.',
    );
  });

  it('counts only the variants that lack the position', () => {
    const frontOnly: Variant = {
      ...tee(5, 'Blue', 'S'),
      placeholders: [{ position: 'front', decoration_method: 'dtg', ...REGULAR }],
    };
    const error = toolError(() => {
      checkPositions([...TEES, frontOnly], ['back']);
    });
    expect(error.message).toBe(
      '"back" is not a print position of 1 of the 5 selected variants. Every selected ' +
        'variant has: front.',
    );
  });

  it('refuses a position given twice', () => {
    const error = toolError(() => {
      checkPositions(TEES, ['front', 'front']);
    });
    expect(error.message).toBe('Two designs use the position "front".');
  });
});

describe('checkPriceSizes', () => {
  it('accepts by_size keys that match a selected size in any case', () => {
    expect(() => {
      checkPriceSizes(TEES, { m: 2799, ' S ': 2499 });
    }).not.toThrow();
  });

  it('accepts no by_size at all', () => {
    expect(() => {
      checkPriceSizes(TEES, undefined);
    }).not.toThrow();
  });

  it('refuses a by_size key that matches no selected size', () => {
    const error = toolError(() => {
      checkPriceSizes(TEES, { M: 2799, '2XL': 2999 });
    });
    expect(error.message).toBe(
      'price.by_size names sizes no selected variant has: "2XL". The selected sizes are: S, M.',
    );
  });

  it('says "none" when the selected variants have no size', () => {
    const poster: Variant = { ...tee(9, 'White', 'S'), options: { paper: 'Matte' } };
    const error = toolError(() => {
      checkPriceSizes([poster], { S: 999 });
    });
    expect(error.message).toBe(
      'price.by_size names sizes no selected variant has: "S". The selected sizes are: none.',
    );
  });
});

describe('groupByPlaceholders', () => {
  it('puts variants with the same placeholder sizes in one group', () => {
    expect(groupByPlaceholders(TEES, ['front'])).toEqual([
      { variantIds: [1, 2, 3, 4], placeholders: new Map([['front', REGULAR]]) },
    ]);
  });

  it('splits by placeholder size, sorts groups by lowest id and ids ascending', () => {
    const variants = [
      tee(203, 'Black', '2XL', LARGE),
      tee(201, 'Black', 'M'),
      tee(202, 'White', '2XL', LARGE),
      tee(200, 'Black', 'S'),
    ];
    expect(groupByPlaceholders(variants, ['front', 'back'])).toEqual([
      {
        variantIds: [200, 201],
        placeholders: new Map([
          ['front', REGULAR],
          ['back', REGULAR],
        ]),
      },
      {
        variantIds: [202, 203],
        placeholders: new Map([
          ['front', LARGE],
          ['back', REGULAR],
        ]),
      },
    ]);
  });

  it('ignores the sizes of positions that were not requested', () => {
    const variants = [tee(1, 'Black', 'S'), tee(2, 'Black', '2XL', LARGE)];
    expect(groupByPlaceholders(variants, ['back'])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/tools/variant-selection.test.ts`
Expected: FAIL: cannot resolve `../../src/tools/variant-selection.js`.

- [ ] **Step 3: Implement** — `src/tools/variant-selection.ts`:

```ts
import type { Variant } from '../printify/catalog.js';
import { ToolError } from './define.js';
import type { Size } from './placement.js';

export interface VariantFilters {
  colors?: readonly string[] | undefined;
  sizes?: readonly string[] | undefined;
}

/** Variants whose placeholders have the same size at every requested position: one print area. */
export interface PlaceholderGroup {
  /** Ascending. */
  variantIds: number[];
  /** Each requested position's placeholder size, in the order the positions were given. */
  placeholders: ReadonlyMap<string, Size>;
}

type FilterOption = 'color' | 'size';

/**
 * The variants matching the filters, in catalog order. Matching ignores case and surrounding
 * spaces; an omitted filter keeps every value. Throws a `ToolError` listing the valid values for
 * a value no variant has, and for a combination no variant has.
 */
export function selectVariants(variants: readonly Variant[], filters: VariantFilters): Variant[] {
  if (variants.length === 0) {
    throw new ToolError(
      'No variant of this blueprint is in stock at this print provider.',
      'Pick another print provider for the blueprint with list_blueprint_providers.',
    );
  }
  checkValues(variants, 'color', filters.colors);
  checkValues(variants, 'size', filters.sizes);
  const selected = variants.filter(
    (variant) =>
      matches(variant, 'color', filters.colors) && matches(variant, 'size', filters.sizes),
  );
  if (selected.length === 0) {
    throw new ToolError(
      `No variant in stock has one of the colors ${describe(filters.colors)} in one of the ` +
        `sizes ${describe(filters.sizes)}.`,
      'Not every color comes in every size. Pick other colors or sizes.',
    );
  }
  return selected;
}

/**
 * Throws a `ToolError` when a position is given twice, or when a selected variant cannot print
 * at a position. The message names the positions every selected variant has.
 */
export function checkPositions(selected: readonly Variant[], positions: readonly string[]): void {
  const seen = new Set<string>();
  for (const position of positions) {
    if (seen.has(position)) {
      throw new ToolError(
        `Two designs use the position "${position}".`,
        'Give each position once, with one image.',
      );
    }
    seen.add(position);
  }
  for (const position of positions) {
    const missing = selected.filter((variant) => !hasPosition(variant, position)).length;
    if (missing === 0) continue;
    const common = commonPositions(selected);
    throw new ToolError(
      `"${position}" is not a print position of ${String(missing)} of the ` +
        `${String(selected.length)} selected variants. Every selected variant has: ` +
        `${common.length === 0 ? 'none' : common.join(', ')}.`,
      'Use one of those positions, or narrow colors and sizes to variants that have it.',
    );
  }
}

/** Throws a `ToolError` for a `by_size` key that matches none of the selected sizes. */
export function checkPriceSizes(
  selected: readonly Variant[],
  bySize: Readonly<Record<string, number>> | undefined,
): void {
  if (bySize === undefined) return;
  const sizes = distinctValues(selected, 'size');
  const known = new Set(sizes.map(normalise));
  const unknown = Object.keys(bySize).filter((key) => !known.has(normalise(key)));
  if (unknown.length === 0) return;
  throw new ToolError(
    `price.by_size names sizes no selected variant has: ${quoteAll(unknown)}. The selected ` +
      `sizes are: ${sizes.length === 0 ? 'none' : sizes.join(', ')}.`,
    'Use the size names as listed, or add the size to variants.sizes.',
  );
}

/**
 * Groups the selected variants by the placeholder size at each requested position. Groups are
 * sorted by their lowest variant id. Call `checkPositions` first.
 */
export function groupByPlaceholders(
  selected: readonly Variant[],
  positions: readonly string[],
): PlaceholderGroup[] {
  const groups = new Map<string, PlaceholderGroup>();
  for (const variant of selected) {
    const sizes = new Map<string, Size>();
    for (const position of positions) {
      // A variant listing a position twice uses the first.
      const placeholder = variant.placeholders.find((entry) => entry.position === position);
      if (placeholder === undefined) {
        throw new TypeError(`variant ${String(variant.id)} has no ${position} placeholder`);
      }
      sizes.set(position, { width: placeholder.width, height: placeholder.height });
    }
    const key = [...sizes]
      .map(([position, size]) => `${position}:${String(size.width)}x${String(size.height)}`)
      .join('|');
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { variantIds: [variant.id], placeholders: sizes });
    else group.variantIds.push(variant.id);
  }
  const result = [...groups.values()];
  for (const group of result) group.variantIds.sort((a, b) => a - b);
  return result.sort((a, b) => (a.variantIds[0] ?? 0) - (b.variantIds[0] ?? 0));
}

function checkValues(
  variants: readonly Variant[],
  option: FilterOption,
  wanted: readonly string[] | undefined,
): void {
  if (wanted === undefined) return;
  const known = distinctValues(variants, option);
  if (known.length === 0) {
    throw new ToolError(
      `These variants have no ${option} option, so ${option}s cannot filter them.`,
      `Leave ${option}s out.`,
    );
  }
  const knownSet = new Set(known.map(normalise));
  const unknown = wanted.filter((value) => !knownSet.has(normalise(value)));
  if (unknown.length === 0) return;
  throw new ToolError(
    `Unknown ${option}s: ${quoteAll(unknown)}. The ${option}s in stock are: ${known.join(', ')}.`,
    'Use the names as listed; case does not matter.',
  );
}

function matches(
  variant: Variant,
  option: FilterOption,
  wanted: readonly string[] | undefined,
): boolean {
  if (wanted === undefined) return true;
  const value = variant.options[option];
  if (value === undefined) return false;
  const normalised = normalise(value);
  return wanted.some((name) => normalise(name) === normalised);
}

function hasPosition(variant: Variant, position: string): boolean {
  return variant.placeholders.some((entry) => entry.position === position);
}

/** The positions every variant has, in the first variant's order. */
function commonPositions(variants: readonly Variant[]): string[] {
  const [first] = variants;
  if (first === undefined) return [];
  const positions = [...new Set(first.placeholders.map((entry) => entry.position))];
  return positions.filter((position) =>
    variants.every((variant) => hasPosition(variant, position)),
  );
}

/** An option's distinct values, in catalog order. */
function distinctValues(variants: readonly Variant[], option: FilterOption): string[] {
  const values: string[] = [];
  for (const variant of variants) {
    const value = variant.options[option];
    if (value !== undefined && !values.includes(value)) values.push(value);
  }
  return values;
}

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

function quoteAll(values: readonly string[]): string {
  return values.map((value) => JSON.stringify(value)).join(', ');
}

function describe(values: readonly string[] | undefined): string {
  return values === undefined ? '(any)' : values.join(', ');
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run test/tools/variant-selection.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Lint, typecheck, full suite, commit**

Run `npm run lint && npm run typecheck && npm test` (712 tests), then:

```bash
git add src/tools/variant-selection.ts test/tools/variant-selection.test.ts
git commit -m "Add variant selection and placeholder grouping for create_product_from_image

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Product payload and mock-ups

**Files:**

- Create: `src/tools/product-plan.ts`
- Test: `test/tools/product-plan.test.ts`

**Interfaces:**

- Consumes: `ImagePlacement` from Task 1; `Variant` from `src/printify/catalog.ts`; `Mockup` from `src/printify/products.ts` (`{ src?; variant_ids?; position?; is_default? }`, all lenient).
- Produces: `type Price = number | { default: number; by_size?: Readonly<Record<string, number>> }`; `interface PlannedArea { variantIds: readonly number[]; images: readonly { position: string; imageId: string; placement: ImagePlacement }[] }`; `interface ProductPlan { title; description; tags?; blueprintId; printProviderId; variants: readonly Variant[]; price: Price; areas: readonly PlannedArea[] }`; `interface ProductPayload` (the POST body); `priceOf(variant, price): number`; `buildProductPayload(plan: ProductPlan): ProductPayload`; `const MOCKUP_LIMIT = 6`; `selectMockups(images: readonly Mockup[]): { src; position; is_default }[]`.

- [ ] **Step 1: Write the failing test** — `test/tools/product-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Variant } from '../../src/printify/catalog.js';
import {
  buildProductPayload,
  priceOf,
  selectMockups,
  type ProductPlan,
} from '../../src/tools/product-plan.js';
import { PRODUCT } from '../fixtures/products.js';

function tee(id: number, size: string): Variant {
  return { id, title: `Black / ${size}`, options: { color: 'Black', size }, placeholders: [] };
}

const CENTRE = { x: 0.5, y: 0.5, scale: 1, angle: 0 };
const TOP = { x: 0.5, y: 0.25, scale: 0.5, angle: 0 };

const PLAN: ProductPlan = {
  title: 'Sunset tee',
  description: '<p>Warm.</p>',
  blueprintId: 6,
  printProviderId: 99,
  variants: [tee(1, 'S'), tee(2, '2XL')],
  price: 2499,
  areas: [
    {
      variantIds: [1],
      images: [
        { position: 'front', imageId: 'art-1', placement: CENTRE },
        { position: 'back', imageId: 'art-2', placement: TOP },
      ],
    },
    {
      variantIds: [2],
      images: [
        { position: 'front', imageId: 'art-1', placement: { ...CENTRE, scale: 0.8333 } },
        { position: 'back', imageId: 'art-2', placement: TOP },
      ],
    },
  ],
};

describe('priceOf', () => {
  it('gives every variant a single price', () => {
    expect(priceOf(tee(1, 'S'), 2499)).toBe(2499);
  });

  it('uses by_size for its size, ignoring case, and default for the rest', () => {
    const price = { default: 2499, by_size: { '2xl ': 2799 } };
    expect(priceOf(tee(2, '2XL'), price)).toBe(2799);
    expect(priceOf(tee(1, 'S'), price)).toBe(2499);
  });

  it('uses default for a variant without a size', () => {
    const mug: Variant = { id: 7, title: '11oz', options: {}, placeholders: [] };
    expect(priceOf(mug, { default: 1500, by_size: { S: 999 } })).toBe(1500);
  });
});

describe('buildProductPayload', () => {
  it('enables every variant and builds one print area per group', () => {
    expect(
      buildProductPayload({ ...PLAN, price: { default: 2499, by_size: { '2XL': 2799 } } }),
    ).toEqual({
      title: 'Sunset tee',
      description: '<p>Warm.</p>',
      blueprint_id: 6,
      print_provider_id: 99,
      variants: [
        { id: 1, price: 2499, is_enabled: true },
        { id: 2, price: 2799, is_enabled: true },
      ],
      print_areas: [
        {
          variant_ids: [1],
          placeholders: [
            { position: 'front', images: [{ id: 'art-1', ...CENTRE }] },
            { position: 'back', images: [{ id: 'art-2', ...TOP }] },
          ],
        },
        {
          variant_ids: [2],
          placeholders: [
            { position: 'front', images: [{ id: 'art-1', ...CENTRE, scale: 0.8333 }] },
            { position: 'back', images: [{ id: 'art-2', ...TOP }] },
          ],
        },
      ],
    });
  });

  it('leaves tags out unless given', () => {
    expect(buildProductPayload(PLAN)).not.toHaveProperty('tags');
    expect(buildProductPayload({ ...PLAN, tags: ['summer'] }).tags).toEqual(['summer']);
  });
});

describe('selectMockups', () => {
  it('lists the default first, then one per camera position', () => {
    expect(selectMockups(PRODUCT.images)).toEqual([
      { src: 'https://images.printify.com/mockup/1.png', position: 'front', is_default: true },
      { src: 'https://images.printify.com/mockup/2.png', position: 'back', is_default: false },
    ]);
  });

  it('returns at most 6', () => {
    const images = Array.from({ length: 8 }, (_item, index) => ({
      src: `https://images.printify.com/mockup/m${String(index)}.png`,
      variant_ids: [1],
      position: `camera-${String(index)}`,
      is_default: index === 7,
    }));
    expect(selectMockups(images).map((image) => image.position)).toEqual([
      'camera-7',
      'camera-0',
      'camera-1',
      'camera-2',
      'camera-3',
      'camera-4',
    ]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/tools/product-plan.test.ts`
Expected: FAIL: cannot resolve `../../src/tools/product-plan.js`.

- [ ] **Step 3: Implement** — `src/tools/product-plan.ts`:

```ts
import type { Variant } from '../printify/catalog.js';
import type { Mockup } from '../printify/products.js';
import type { ImagePlacement } from './placement.js';

/** Cents for every variant, or a default with per-size overrides matched ignoring case. */
export type Price =
  number | { default: number; by_size?: Readonly<Record<string, number>> | undefined };

/** One print area of the new product: the variants it covers and each position's image. */
export interface PlannedArea {
  variantIds: readonly number[];
  /** In the order of the designs. */
  images: readonly { position: string; imageId: string; placement: ImagePlacement }[];
}

export interface ProductPlan {
  title: string;
  description: string;
  tags?: readonly string[] | undefined;
  blueprintId: number;
  printProviderId: number;
  /** The selected variants: each is sent enabled. */
  variants: readonly Variant[];
  price: Price;
  areas: readonly PlannedArea[];
}

/** The `POST /v1/shops/{shop_id}/products.json` body. */
export interface ProductPayload {
  title: string;
  description: string;
  tags?: string[];
  blueprint_id: number;
  print_provider_id: number;
  variants: { id: number; price: number; is_enabled: true }[];
  print_areas: {
    variant_ids: number[];
    placeholders: { position: string; images: ({ id: string } & ImagePlacement)[] }[];
  }[];
}

/** The most mock-ups the tool returns; `get_product` has them all. */
export const MOCKUP_LIMIT = 6;

export interface MockupRow {
  src: string | undefined;
  position: string | undefined;
  is_default: boolean | undefined;
}

/** A variant's price: its size's `by_size` entry, else `default`. */
export function priceOf(variant: Variant, price: Price): number {
  if (typeof price === 'number') return price;
  const size = variant.options['size'];
  if (size !== undefined && price.by_size !== undefined) {
    const wanted = size.trim().toLowerCase();
    for (const [key, cents] of Object.entries(price.by_size)) {
      if (key.trim().toLowerCase() === wanted) return cents;
    }
  }
  return price.default;
}

export function buildProductPayload(plan: ProductPlan): ProductPayload {
  return {
    title: plan.title,
    description: plan.description,
    ...(plan.tags === undefined ? {} : { tags: [...plan.tags] }),
    blueprint_id: plan.blueprintId,
    print_provider_id: plan.printProviderId,
    variants: plan.variants.map((variant) => ({
      id: variant.id,
      price: priceOf(variant, plan.price),
      is_enabled: true as const,
    })),
    print_areas: plan.areas.map((area) => ({
      variant_ids: [...area.variantIds],
      placeholders: area.images.map(({ position, imageId, placement }) => ({
        position,
        images: [{ id: imageId, ...placement }],
      })),
    })),
  };
}

/**
 * At most `MOCKUP_LIMIT` mock-ups: the default ones first, then the first of each camera position
 * not yet shown, in response order.
 */
export function selectMockups(images: readonly Mockup[]): MockupRow[] {
  const chosen = images.filter((image) => image.is_default === true);
  const shown = new Set(chosen.map((image) => image.position));
  for (const image of images) {
    if (image.is_default === true || shown.has(image.position)) continue;
    chosen.push(image);
    shown.add(image.position);
  }
  return chosen
    .slice(0, MOCKUP_LIMIT)
    .map(({ src, position, is_default }) => ({ src, position, is_default }));
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run test/tools/product-plan.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Lint, typecheck, full suite, commit**

Run `npm run lint && npm run typecheck && npm test` (719 tests), then:

```bash
git add src/tools/product-plan.ts test/tools/product-plan.test.ts
git commit -m "Add the product payload and mock-up selection for create_product_from_image

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `PartialFailureError` in the registry

**Files:**

- Modify: `src/tools/define.ts` (append after `ToolError`)
- Modify: `src/tools/run.ts` (import, `ErrorFields`, first branch of `errorFields`)
- Modify: `test/support/expect.ts` (`uploaded` on `ToolErrorFields`)
- Test: `test/tools/run.test.ts` (import, two new cases before "maps a ToolError to kind \"tool\"")

**Interfaces:**

- Consumes: `ToolData`, `ToolError` in `define.ts`; `errorFields` in `run.ts`.
- Produces: `class PartialFailureError extends Error { readonly done: ToolData; constructor(cause: unknown, done: ToolData) }` with the standard `cause` property. `runTool` reports it as `{ ...fields of cause, ...done }`: a thrown `PartialFailureError(cause, { uploaded })` becomes an error result whose `error.uploaded` is that list, with every field `cause` would have had on its own.

- [ ] **Step 1: Write the failing tests** — apply this to `test/tools/run.test.ts`:

```diff
diff --git a/test/tools/run.test.ts b/test/tools/run.test.ts
index a81dabd..cb92a0f 100644
--- a/test/tools/run.test.ts
+++ b/test/tools/run.test.ts
@@ -1,7 +1,7 @@
 import type { CallToolResult } from '@modelcontextprotocol/server';
 import { describe, expect, it, vi } from 'vitest';
 import { PrintifyApiError, httpError, timeoutError } from '../../src/printify/errors.js';
-import { ToolError } from '../../src/tools/define.js';
+import { PartialFailureError, ToolError } from '../../src/tools/define.js';
 import { runTool } from '../../src/tools/run.js';
 import { rejection } from '../printify/helpers.js';
 import { fixtureContext, fixtureTool } from './fixtures.js';
@@ -123,6 +123,46 @@ describe('runTool', () => {
     });
   });

+  it('reports a PartialFailureError as its cause, plus what was done', async () => {
+    const uploaded = [{ upload_id: 'art-1', file_name: 'sunset.png', positions: ['front'] }];
+    const error = new PartialFailureError(
+      new ToolError(
+        'strict is set and the artwork would print at low resolution.',
+        'Use more pixels.',
+      ),
+      { uploaded },
+    );
+    const { ctx, logged } = fixtureContext();
+    expect(await runTool(failing(error), {}, ctx)).toEqual(
+      errorResult({
+        kind: 'tool',
+        message: 'strict is set and the artwork would print at low resolution.',
+        hint: 'Use more pixels.',
+        uploaded,
+      }),
+    );
+    expect(logged).toEqual([]);
+  });
+
+  it('keeps every field of a PrintifyApiError cause next to what was done', async () => {
+    const uploaded = [{ upload_id: 'art-1', file_name: 'sunset.png', positions: ['front'] }];
+    const cause = timeoutError({ method: 'POST', path: '/v1/shops/12/products.json' }, 30_000);
+    const { ctx, logged } = fixtureContext();
+    const result = await runTool(failing(new PartialFailureError(cause, { uploaded })), {}, ctx);
+    expect(result.structuredContent).toStrictEqual({
+      error: {
+        kind: 'timeout',
+        request: 'POST /v1/shops/12/products.json',
+        message: 'POST /v1/shops/12/products.json timed out after 30000 ms',
+        hint:
+          'Printify did not answer in time. Try again in a moment. The request may still have ' +
+          'gone through, so check before retrying.',
+        uploaded,
+      },
+    });
+    expect(logged).toHaveLength(1);
+  });
+
   it('maps a ToolError to kind "tool" and logs nothing', async () => {
     const error = new ToolError(
       'Product 5f3 is locked while it is being published.',
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/tools/run.test.ts`
Expected: FAIL: `PartialFailureError` is not exported from `define.js` (a SyntaxError or "is not a constructor").

- [ ] **Step 3: Implement** — apply these three changes:

```diff
diff --git a/src/tools/define.ts b/src/tools/define.ts
index c031f6c..e2d9bd2 100644
--- a/src/tools/define.ts
+++ b/src/tools/define.ts
@@ -99,3 +99,17 @@ export class ToolError extends Error {
     this.hint = hint;
   }
 }
+
+/**
+ * A failure after the call already changed something, e.g. uploaded images. The registry reports
+ * `cause` as it would on its own and adds the fields of `done`, so the model can reuse the work.
+ */
+export class PartialFailureError extends Error {
+  override readonly name = 'PartialFailureError';
+  readonly done: ToolData;
+
+  constructor(cause: unknown, done: ToolData) {
+    super(cause instanceof Error ? cause.message : String(cause), { cause });
+    this.done = done;
+  }
+}
diff --git a/src/tools/run.ts b/src/tools/run.ts
index 2296edc..6641f76 100644
--- a/src/tools/run.ts
+++ b/src/tools/run.ts
@@ -3,6 +3,7 @@ import type { Logger } from '../log.js';
 import { PrintifyApiError } from '../printify/errors.js';
 import { redactJwts } from '../redact.js';
 import {
+  PartialFailureError,
   ToolError,
   mcpAnnotations,
   type Tool,
@@ -15,7 +16,7 @@ const BUG_HINT =
   'This is a bug in printify-mcp. Please report it at ' +
   'https://github.com/ARau87/printify-mcp/issues with the tool name and this message.';

-type ErrorFields = Record<string, string | number | undefined>;
+type ErrorFields = Record<string, unknown>;

 /** Registers every tool on `server`. Each call runs through `runTool`. */
 export function registerTools(
@@ -57,6 +58,9 @@ export async function runTool(
 }

 function errorFields(tool: Tool, error: unknown, log: Logger): ErrorFields {
+  if (error instanceof PartialFailureError) {
+    return { ...errorFields(tool, error.cause, log), ...error.done };
+  }
   if (error instanceof PrintifyApiError) {
     // message is one redacted line; a network error's cause is never logged.
     log.warn(`${tool.name} failed: ${error.message}`);
diff --git a/test/support/expect.ts b/test/support/expect.ts
index 5ea3e59..da213f2 100644
--- a/test/support/expect.ts
+++ b/test/support/expect.ts
@@ -12,6 +12,8 @@ export interface ToolErrorFields {
   request_id?: string;
   retry_after_seconds?: number;
   hint?: string;
+  /** What a workflow tool did before it failed, e.g. the images it uploaded. */
+  uploaded?: unknown;
 }

 /**
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run test/tools/run.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Lint, typecheck, full suite, commit**

Run `npm run lint && npm run typecheck && npm test` (721 tests), then:

```bash
git add src/tools/define.ts src/tools/run.ts test/support/expect.ts test/tools/run.test.ts
git commit -m "Report what a tool did before it failed with PartialFailureError

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The `create_product_from_image` tool

**Files:**

- Create: `src/tools/workflows.ts`
- Modify: `src/tools/index.ts` (import and the `workflows:` line)
- Modify: `.github/workflows/ci.yml` (smoke-step tool list)
- Modify: `docs/superpowers/specs/2026-09-30-create-product-from-image-design.md` (the `next_step` bullet, see "Deviation from the spec")
- Test: `test/tools/workflows.test.ts`

**Interfaces:**

- Consumes: everything Tasks 1–4 produce; `resolveShopId`, `shopIdInput` (`src/tools/shop-id.ts`); `ctx.catalog.variants(blueprintId, printProviderId, { showOutOfStock: false }, signal)`; `resolveUploadSource({ url | file_path, file_name }, uploadDirs): Promise<{ body: UploadBody; warning }>` (`src/tools/upload-source.ts`); `uploadImage`, `getUpload` (`src/printify/uploads.ts`, returning `{ id; file_name; width?; height? }`); `createProduct(client, shopId, body, signal): Promise<Product>` (`src/printify/products.ts`).
- Produces: `createProductFromImageTool`, `workflowsTools: readonly Tool[]`.

- [ ] **Step 1: Write the failing test** — `test/tools/workflows.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, TOOLS_BY_TOOLSET } from '../../src/tools/index.js';
import { apiErrorBody, notFoundBody } from '../fixtures/errors.js';
import { PRODUCT, product } from '../fixtures/products.js';
import { SHOP } from '../fixtures/shops.js';
import { upload } from '../fixtures/uploads.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { inTurn, json } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';

const TOOL = 'create_product_from_image';
const SHOP_ID = SHOP.id;
const VARIANTS_PATH = '/v1/catalog/blueprints/6/print_providers/99/variants.json';
const UPLOAD_PATH = '/v1/uploads/images.json';
const PRODUCTS_PATH = `/v1/shops/${String(SHOP_ID)}/products.json`;
const ART_URL = 'https://example.com/art/sunset.png';
/** 4400 × 5500: wide enough for every print area below at scale 1. */
const ART = upload({ id: 'art-1', file_name: 'sunset.png', width: 4400, height: 5500 });

function tee(id: number, color: string, size: string, frontWidth = 4000) {
  return {
    id,
    title: `${color} / ${size}`,
    options: { color, size },
    placeholders: [
      { position: 'front', decoration_method: 'dtg', width: frontWidth, height: 5000 },
      { position: 'back', decoration_method: 'dtg', width: 4000, height: 5000 },
    ],
  };
}

/** 2XL has a wider front print area, so it needs a print area of its own. */
const TEES = {
  id: 99,
  title: 'Monster Digital',
  variants: [
    tee(101, 'Black', 'S'),
    tee(102, 'Black', 'M'),
    tee(103, 'Black', '2XL', 4800),
    tee(104, 'White', 'S'),
    tee(105, 'Red', 'M'),
  ],
};

const ROUTES = {
  [`GET ${VARIANTS_PATH}`]: TEES,
  [`POST ${UPLOAD_PATH}`]: ART,
  [`POST ${PRODUCTS_PATH}`]: PRODUCT,
};

const BASE = {
  shop_id: SHOP_ID,
  blueprint_id: 6,
  print_provider_id: 99,
  title: 'Sunset tee',
  description: '<p>Warm.</p>',
};
const FRONT = { position: 'front', image: { url: ART_URL } };
/** One variant, Red M, one design and one price: the smallest valid call. */
const RED_FRONT = { ...BASE, designs: [FRONT], variants: { colors: ['Red'] }, price: 2000 };
const UPLOADED = [{ upload_id: 'art-1', file_name: 'sunset.png', positions: ['front'] }];

describe('create_product_from_image', () => {
  it('uploads, then creates the product with one print area per placeholder size', async () => {
    const { call, api } = await createTestServer({ routes: ROUTES });
    const data = expectToolData(
      await call(TOOL, {
        ...BASE,
        designs: [FRONT],
        variants: { colors: ['black', 'WHITE'], sizes: ['s', 'M', '2xl'] },
        price: { default: 2499, by_size: { '2XL': 2799 } },
      }),
    );
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${VARIANTS_PATH}`,
      `POST ${UPLOAD_PATH}`,
      `POST ${PRODUCTS_PATH}`,
    ]);
    expect(api.expectRequest('POST', UPLOAD_PATH).body).toEqual({
      file_name: 'sunset.png',
      url: ART_URL,
    });
    expect(api.expectRequest('POST', PRODUCTS_PATH).body).toEqual({
      title: 'Sunset tee',
      description: '<p>Warm.</p>',
      blueprint_id: 6,
      print_provider_id: 99,
      variants: [
        { id: 101, price: 2499, is_enabled: true },
        { id: 102, price: 2499, is_enabled: true },
        { id: 103, price: 2799, is_enabled: true },
        { id: 104, price: 2499, is_enabled: true },
      ],
      print_areas: [
        {
          variant_ids: [101, 102, 104],
          placeholders: [
            { position: 'front', images: [{ id: 'art-1', x: 0.5, y: 0.5, scale: 1, angle: 0 }] },
          ],
        },
        {
          variant_ids: [103],
          placeholders: [
            {
              position: 'front',
              images: [{ id: 'art-1', x: 0.5, y: 0.5, scale: 0.8333, angle: 0 }],
            },
          ],
        },
      ],
    });
    expect(data).toEqual({
      product_id: PRODUCT.id,
      shop_id: SHOP_ID,
      title: PRODUCT.title,
      enabled_variants: 4,
      print_area_groups: 2,
      images: [
        {
          upload_id: 'art-1',
          file_name: 'sunset.png',
          width: 4400,
          height: 5500,
          positions: ['front'],
          reused: false,
        },
      ],
      mockups: [
        { src: 'https://images.printify.com/mockup/1.png', position: 'front', is_default: true },
        { src: 'https://images.printify.com/mockup/2.png', position: 'back', is_default: false },
      ],
      mockup_count: 3,
      next_step: expect.stringContaining('unpublished draft') as unknown,
    });
  });

  it('uploads an image used on two positions once', async () => {
    const { call, api } = await createTestServer({ routes: ROUTES });
    const back = {
      position: 'back',
      image: { url: ART_URL },
      placement: { mode: 'width', width_pct: 50, align: 'top' },
    };
    const data = expectToolData(await call(TOOL, { ...RED_FRONT, designs: [FRONT, back] }));
    api.expectRequest('POST', UPLOAD_PATH);
    expect(api.expectRequest('POST', PRODUCTS_PATH).body).toMatchObject({
      print_areas: [
        {
          variant_ids: [105],
          placeholders: [
            { position: 'front', images: [{ id: 'art-1', x: 0.5, y: 0.5, scale: 1, angle: 0 }] },
            // Half the width, so half the height: 0.5 × 0.8 × 1.25 = 0.5, centred at 0.25.
            { position: 'back', images: [{ id: 'art-1', x: 0.5, y: 0.25, scale: 0.5, angle: 0 }] },
          ],
        },
      ],
    });
    expect(data['images']).toEqual([
      {
        upload_id: 'art-1',
        file_name: 'sunset.png',
        width: 4400,
        height: 5500,
        positions: ['front', 'back'],
        reused: false,
      },
    ]);
  });

  it('reads the size of an upload_id instead of uploading', async () => {
    const { call, api } = await createTestServer({
      routes: {
        [`GET ${VARIANTS_PATH}`]: TEES,
        'GET /v1/uploads/art-1.json': ART,
        [`POST ${PRODUCTS_PATH}`]: PRODUCT,
      },
    });
    const data = expectToolData(
      await call(TOOL, {
        ...RED_FRONT,
        designs: [{ position: 'front', image: { upload_id: 'art-1' } }],
      }),
    );
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${VARIANTS_PATH}`,
      'GET /v1/uploads/art-1.json',
      `POST ${PRODUCTS_PATH}`,
    ]);
    expect(data['images']).toEqual([
      {
        upload_id: 'art-1',
        file_name: 'sunset.png',
        width: 4400,
        height: 5500,
        positions: ['front'],
        reused: true,
      },
    ]);
  });

  it('reports the uploads when Printify rejects the create', async () => {
    const body = apiErrorBody({
      code: 8203,
      message: 'Validation failed.',
      reason: 'Image has low quality',
    });
    const { call } = await createTestServer({
      routes: { ...ROUTES, [`POST ${PRODUCTS_PATH}`]: json(body, 400) },
    });
    expectToolError(await call(TOOL, RED_FRONT), {
      kind: 'http',
      status: 400,
      code: 8203,
      reason: 'Image has low quality',
      uploaded: UPLOADED,
    });
  });

  it('warns about an image narrower than it is printed, and still creates the product', async () => {
    const small = upload({ id: 'art-1', file_name: 'sunset.png', width: 1000, height: 1250 });
    const { call, api } = await createTestServer({
      routes: { ...ROUTES, [`POST ${UPLOAD_PATH}`]: small },
    });
    const data = expectToolData(await call(TOOL, RED_FRONT));
    expect(data['warnings']).toEqual([
      'sunset.png is 1000 px wide but needs 4000 px on front (25%) for 1 variant',
    ]);
    api.expectRequest('POST', PRODUCTS_PATH);
  });

  it('refuses a too-small image with strict, after the upload, and reports the upload', async () => {
    const small = upload({ id: 'art-1', file_name: 'sunset.png', width: 1000, height: 1250 });
    const { call, api } = await createTestServer({
      routes: { ...ROUTES, [`POST ${UPLOAD_PATH}`]: small },
    });
    const error = expectToolError(await call(TOOL, { ...RED_FRONT, strict: true }), {
      kind: 'tool',
      uploaded: UPLOADED,
    });
    expect(error.message).toContain(
      'sunset.png is 1000 px wide but needs 4000 px on front (25%) for 1 variant',
    );
    api.expectRequest('POST', UPLOAD_PATH);
    expect(api.requests.filter((request) => request.path === PRODUCTS_PATH)).toHaveLength(0);
  });

  it('checks the colors before uploading anything', async () => {
    const { call, api } = await createTestServer({ routes: ROUTES });
    const uploads = () => api.requests.filter((request) => request.path === UPLOAD_PATH).length;
    // A valid call first, so the count below is known to move when an upload happens.
    expectToolData(await call(TOOL, RED_FRONT));
    expect(uploads()).toBe(1);
    const error = expectToolError(
      await call(TOOL, { ...RED_FRONT, variants: { colors: ['Neon'] } }),
      { kind: 'tool' },
    );
    expect(error.message).toBe(
      'Unknown colors: "Neon". The colors in stock are: Black, White, Red.',
    );
    expect(error).not.toHaveProperty('uploaded');
    expect(uploads()).toBe(1);
  });

  it('refuses an image with two sources, naming the three it takes', async () => {
    const { call, api } = await createTestServer({ routes: ROUTES });
    const error = expectToolError(
      await call(TOOL, {
        ...RED_FRONT,
        designs: [{ position: 'front', image: { upload_id: 'art-1', url: ART_URL } }],
      }),
      { kind: 'tool' },
    );
    expect(error.message).toBe(
      'designs[0].image needs exactly one of upload_id, url or file_path; got upload_id and url.',
    );
    expect(api.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('passes on a 404 for an unknown upload_id, before uploading anything', async () => {
    const { call, api } = await createTestServer({
      routes: {
        ...ROUTES,
        'GET /v1/uploads/nope.json': json(notFoundBody(), 404),
      },
    });
    const error = expectToolError(
      await call(TOOL, {
        ...RED_FRONT,
        designs: [FRONT, { position: 'back', image: { upload_id: 'nope' } }],
      }),
      { kind: 'http', status: 404 },
    );
    expect(error).not.toHaveProperty('uploaded');
    expect(api.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('refuses contain when Printify reports no pixel size, and reports the upload', async () => {
    const sizeless = { ...ART, width: null, height: null };
    const { call } = await createTestServer({
      routes: { ...ROUTES, [`POST ${UPLOAD_PATH}`]: sizeless },
    });
    const error = expectToolError(await call(TOOL, RED_FRONT), {
      kind: 'tool',
      message:
        'Printify did not report the pixel size of sunset.png, so placement mode "contain" ' +
        'cannot be worked out.',
      uploaded: UPLOADED,
    });
    expect(error.hint).toContain('mode: "custom"');
  });

  it('places custom without a pixel size, and warns that it could not check it', async () => {
    const sizeless = { ...ART, width: null, height: null };
    const { call } = await createTestServer({
      routes: { ...ROUTES, [`POST ${UPLOAD_PATH}`]: sizeless },
    });
    const custom = { ...FRONT, placement: { mode: 'custom', x: 0.5, y: 0.4, scale: 0.9 } };
    const data = expectToolData(await call(TOOL, { ...RED_FRONT, designs: [custom] }));
    expect(data['warnings']).toEqual([
      'resolution of sunset.png could not be checked: Printify did not report its size',
    ]);
  });

  it('lists only the uploads that happened when a later upload fails', async () => {
    const rejected = apiErrorBody({
      code: 10100,
      message: 'Validation failed.',
      reason: 'Bad image',
    });
    const { call } = await createTestServer({
      routes: { ...ROUTES, [`POST ${UPLOAD_PATH}`]: inTurn(ART, json(rejected, 400)) },
    });
    const back = { position: 'back', image: { url: 'https://example.com/art/moon.png' } };
    expectToolError(await call(TOOL, { ...RED_FRONT, designs: [FRONT, back] }), {
      kind: 'http',
      status: 400,
      uploaded: UPLOADED,
    });
  });

  it('returns at most 6 mockups and the full count', async () => {
    const images = Array.from({ length: 8 }, (_item, index) => ({
      src: `https://images.printify.com/mockup/m${String(index)}.png`,
      variant_ids: [105],
      position: `camera-${String(index)}`,
      is_default: index === 7,
    }));
    const { call } = await createTestServer({
      routes: { ...ROUTES, [`POST ${PRODUCTS_PATH}`]: product({ images }) },
    });
    const data = expectToolData(await call(TOOL, RED_FRONT));
    expect(data['mockups']).toHaveLength(6);
    expect(data['mockup_count']).toBe(8);
    expect(data).not.toHaveProperty('warnings');
  });

  it('is a write tool, filed under workflows and registered by default', async () => {
    const { mcp } = await createTestServer();
    const { tools } = await mcp.listTools();
    expect(tools.find((tool) => tool.name === TOOL)?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(TOOLS_BY_TOOLSET.workflows.map((tool) => tool.name)).toEqual([TOOL]);
  });

  it('does not name publish_product in next_step, because no such tool exists yet', async () => {
    // The publishing toolset (#12) makes this fail on purpose: next_step should then name it.
    expect(ALL_TOOLS.map((tool) => tool.name)).not.toContain('publish_product');
    const { call } = await createTestServer({ routes: ROUTES });
    const data = expectToolData(await call(TOOL, RED_FRONT));
    expect(data['next_step']).not.toContain('publish_product');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run test/tools/workflows.test.ts`
Expected: FAIL: every case reports an unknown tool `create_product_from_image`, and the filing case finds `[]`.

- [ ] **Step 3: Implement the tool** — `src/tools/workflows.ts`:

```ts
import { z } from 'zod';
import { createProduct } from '../printify/products.js';
import { getUpload, uploadImage, type UploadBody } from '../printify/uploads.js';
import {
  PartialFailureError,
  ToolError,
  defineTool,
  type Tool,
  type ToolContext,
} from './define.js';
import { DEFAULT_PLACEMENT, placeImage, resolutionWarning, type Size } from './placement.js';
import {
  buildProductPayload,
  selectMockups,
  type PlannedArea,
  type Price,
} from './product-plan.js';
import { resolveShopId, shopIdInput } from './shop-id.js';
import { resolveUploadSource } from './upload-source.js';
import {
  checkPositions,
  checkPriceSizes,
  groupByPlaceholders,
  selectVariants,
  type PlaceholderGroup,
} from './variant-selection.js';

const cents = z.number().int().positive();

const angle = z.number().int().optional().describe('Rotation in degrees. Default 0.');

const alignFields = {
  align: z
    .enum(['center', 'top'])
    .optional()
    .describe(
      'center (the default) centres the artwork in the print area; top puts its top edge at ' +
        'the top, as for a chest print.',
    ),
  offset_y_pct: z
    .number()
    .optional()
    .describe(
      'Moves the artwork down by this percentage of the print area height; negative moves it ' +
        'up. Default 0.',
    ),
  angle,
};

const placementInput = z
  .discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('contain'), ...alignFields }),
    z.strictObject({ mode: z.literal('cover'), ...alignFields }),
    z.strictObject({
      mode: z.literal('width'),
      width_pct: z
        .number()
        .gt(0)
        .max(100)
        .describe('The artwork width as a percentage of the print area width, e.g. 80.'),
      ...alignFields,
    }),
    z.strictObject({
      mode: z.literal('custom'),
      x: z.number().describe("The artwork centre's x, 0–1 from the left; 0.5 is the middle."),
      y: z.number().describe("The artwork centre's y, 0–1 from the top; 0.5 is the middle."),
      scale: z
        .number()
        .positive()
        .describe('The artwork width divided by the print area width; 1 fills the width.'),
      angle,
    }),
  ])
  .describe(
    'Where the artwork goes. contain (the default) fits the whole image inside the print area; ' +
      'cover fills it and crops the overflow; width sets the width as a percentage; custom ' +
      'takes x, y and scale as given.',
  );

const imageInput = z
  .strictObject({
    upload_id: z
      .string()
      .min(1)
      .optional()
      .describe('An image already in the library, from upload_image or list_uploads.'),
    url: z
      .string()
      .optional()
      .describe('A public http or https URL of the image. Printify downloads it itself.'),
    file_path: z
      .string()
      .optional()
      .describe(
        "The absolute path of a .png, .jpg or .jpeg on the user's machine, inside the " +
          'directories the user allowed.',
      ),
    file_name: z
      .string()
      .optional()
      .describe('The name an uploaded image gets in the library. Taken from the URL or path.'),
  })
  .describe('Exactly one of upload_id, url or file_path. The same url or path is uploaded once.');

const designInput = z.strictObject({
  position: z
    .string()
    .min(1)
    .describe('The print position, e.g. front or back, as list_variants names it.'),
  image: imageInput,
  placement: placementInput.optional(),
});

type DesignInput = z.output<typeof designInput>;

const SOURCES = ['upload_id', 'url', 'file_path'] as const;

type Source = (typeof SOURCES)[number];

const IMAGE_HINT =
  'upload_id is an image already in the library, url a public image URL, file_path a file on ' +
  "the user's machine.";
const NO_SIZE_HINT =
  'Pass placement: { mode: "custom", x: 0.5, y: 0.5, scale: 1 } for this design to centre it ' +
  'at the full print area width, or adjust scale.';
const STRICT_HINT =
  'Use a larger image or a smaller placement (mode "width" with a lower width_pct), or leave ' +
  'strict out to create the product with a warning.';
const NEXT_STEP =
  'The product is an unpublished draft in the shop. Show the user the mockups and ask whether ' +
  'to change anything with update_product before it is published to the sales channel.';

/** One distinct image of the call. Designs with the same source share one. */
interface ImageSlot {
  positions: string[];
  /** Known for an upload_id input, and once the image is uploaded. */
  uploadId: string | undefined;
  /** The upload request for a url or file_path input. */
  body: UploadBody | undefined;
  fileName: string;
  width: number | undefined;
  height: number | undefined;
  reused: boolean;
  warning: string | undefined;
}

/** What the error of a call that failed after uploading lists, so the uploads can be reused. */
interface UploadedImage {
  upload_id: string;
  file_name: string;
  positions: string[];
}

export const createProductFromImageTool = defineTool({
  name: 'create_product_from_image',
  toolset: 'workflows',
  description:
    'Creates a product from artwork in one call: uploads the images, picks the variants, works ' +
    'out where each image sits on each print area, and creates the product as an unpublished ' +
    'draft. Give the blueprint and print provider (from search_blueprints and ' +
    'list_blueprint_providers), one design per print position with its image and placement, ' +
    'optionally colors and sizes (names as list_variants shows them, any case; by default ' +
    'every variant in stock), and the price in cents, optionally per size. Warns when an image ' +
    'has fewer pixels than it is printed across; strict refuses instead. If the call fails ' +
    'after uploading, the error lists the images under uploaded: retry with image.upload_id ' +
    'set to them rather than uploading again. Does not publish.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: z.strictObject({
    ...shopIdInput,
    blueprint_id: z
      .number()
      .int()
      .positive()
      .describe('The catalog blueprint id, from search_blueprints.'),
    print_provider_id: z
      .number()
      .int()
      .positive()
      .describe('The print provider id, from list_blueprint_providers.'),
    title: z.string().min(1).describe('The product title.'),
    description: z.string().describe('The product description. HTML is allowed.'),
    tags: z.array(z.string()).optional().describe('Tags for the sales channel.'),
    designs: z
      .array(designInput)
      .min(1)
      .describe('One design per print position, each position at most once.'),
    variants: z
      .strictObject({
        colors: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Color names, e.g. ["Black", "White"]. Default: every color in stock.'),
        sizes: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Size names, e.g. ["S", "M", "L", "XL"]. Default: every size in stock.'),
      })
      .optional()
      .describe('Which variants to offer. Every matching variant in stock is enabled.'),
    price: z
      .union([
        cents,
        z.strictObject({
          default: cents,
          by_size: z
            .record(z.string(), cents)
            .optional()
            .describe('Prices for particular sizes, e.g. { "2XL": 2799 }.'),
        }),
      ])
      .describe('The price in cents, e.g. 2499 for 24.99, or { default, by_size }.'),
    strict: z
      .boolean()
      .optional()
      .describe('Refuse, rather than warn, when an image is too small for its placement.'),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const list = await ctx.catalog.variants(
      input.blueprint_id,
      input.print_provider_id,
      { showOutOfStock: false },
      ctx.signal,
    );
    const selected = selectVariants(list.variants, input.variants ?? {});
    const positions = input.designs.map((design) => design.position);
    checkPositions(selected, positions);
    const price: Price = input.price;
    checkPriceSizes(selected, typeof price === 'number' ? undefined : price.by_size);

    const slotOf = await resolveImages(input.designs, ctx);
    const slots = [...new Set(slotOf.values())];
    const warnings = slots.flatMap((slot) => (slot.warning === undefined ? [] : [slot.warning]));
    const uploaded: UploadedImage[] = [];
    try {
      for (const slot of slots) {
        if (slot.body === undefined) continue;
        const record = await uploadImage(ctx.client, slot.body, ctx.signal);
        slot.uploadId = record.id;
        slot.fileName = record.file_name;
        slot.width = record.width;
        slot.height = record.height;
        uploaded.push({
          upload_id: record.id,
          file_name: record.file_name,
          positions: slot.positions,
        });
      }
      const groups = groupByPlaceholders(selected, positions);
      const areas = placeDesigns(groups, input.designs, slotOf, input.strict ?? false, warnings);
      const payload = buildProductPayload({
        title: input.title,
        description: input.description,
        tags: input.tags,
        blueprintId: input.blueprint_id,
        printProviderId: input.print_provider_id,
        variants: selected,
        price,
        areas,
      });
      const product = await createProduct(ctx.client, shopId, payload, ctx.signal);
      return {
        product_id: product.id,
        shop_id: shopId,
        title: product.title,
        enabled_variants: payload.variants.length,
        print_area_groups: payload.print_areas.length,
        images: slots.map((slot) => ({
          upload_id: slot.uploadId,
          file_name: slot.fileName,
          width: slot.width,
          height: slot.height,
          positions: slot.positions,
          reused: slot.reused,
        })),
        mockups: selectMockups(product.images ?? []),
        mockup_count: product.images?.length ?? 0,
        warnings: warnings.length === 0 ? undefined : warnings,
        next_step: NEXT_STEP,
      };
    } catch (error) {
      if (uploaded.length === 0) throw error;
      throw new PartialFailureError(error, { uploaded });
    }
  },
});

/**
 * Checks each design's image source and reads what it can without writing: an upload_id's pixel
 * size, and a url or file_path's upload request. Returns each position's image.
 */
async function resolveImages(
  designs: readonly DesignInput[],
  ctx: ToolContext,
): Promise<Map<string, ImageSlot>> {
  const bySource = new Map<string, ImageSlot>();
  const byPosition = new Map<string, ImageSlot>();
  for (const [index, design] of designs.entries()) {
    const { image } = design;
    const given = SOURCES.filter((source) => image[source] !== undefined);
    const [source] = given;
    if (given.length !== 1 || source === undefined) {
      throw new ToolError(
        `designs[${String(index)}].image needs exactly one of upload_id, url or file_path; ` +
          `${given.length === 0 ? 'none was given' : `got ${given.join(' and ')}`}.`,
        IMAGE_HINT,
      );
    }
    const value = image[source] ?? '';
    const key = `${source}:${value}`;
    let slot = bySource.get(key);
    if (slot === undefined) {
      slot = await newSlot(source, value, image.file_name, ctx);
      bySource.set(key, slot);
    }
    slot.positions.push(design.position);
    byPosition.set(design.position, slot);
  }
  return byPosition;
}

async function newSlot(
  source: Source,
  value: string,
  fileName: string | undefined,
  ctx: ToolContext,
): Promise<ImageSlot> {
  if (source === 'upload_id') {
    const record = await getUpload(ctx.client, value, ctx.signal);
    return {
      positions: [],
      uploadId: record.id,
      body: undefined,
      fileName: record.file_name,
      width: record.width,
      height: record.height,
      reused: true,
      warning: undefined,
    };
  }
  const { body, warning } = await resolveUploadSource(
    source === 'url'
      ? { url: value, file_name: fileName }
      : { file_path: value, file_name: fileName },
    ctx.config.uploadDirs,
  );
  return {
    positions: [],
    uploadId: undefined,
    body,
    fileName: body.file_name,
    width: undefined,
    height: undefined,
    reused: false,
    warning,
  };
}

/**
 * Places every design in every group. Adds resolution warnings to `warnings`, or throws when
 * `strict` is set and there are any.
 */
function placeDesigns(
  groups: readonly PlaceholderGroup[],
  designs: readonly DesignInput[],
  slotOf: ReadonlyMap<string, ImageSlot>,
  strict: boolean,
  warnings: string[],
): PlannedArea[] {
  const lowResolution: string[] = [];
  const unchecked = new Set<ImageSlot>();
  const areas = groups.map((group) => ({
    variantIds: group.variantIds,
    images: designs.map((design) => {
      const slot = slotOf.get(design.position);
      const placeholder = group.placeholders.get(design.position);
      if (slot?.uploadId === undefined || placeholder === undefined) {
        throw new TypeError(`no image or placeholder for ${design.position}`);
      }
      const placement = design.placement ?? DEFAULT_PLACEMENT;
      const size = sizeOf(slot);
      if (size === undefined && placement.mode !== 'custom') {
        throw new ToolError(
          `Printify did not report the pixel size of ${slot.fileName}, so placement mode ` +
            `"${placement.mode}" cannot be worked out.`,
          NO_SIZE_HINT,
        );
      }
      const placed = placeImage(placeholder, size, placement);
      if (size === undefined) {
        unchecked.add(slot);
      } else {
        const warning = resolutionWarning({
          fileName: slot.fileName,
          imageWidth: size.width,
          printedWidth: placed.printedWidth,
          position: design.position,
          variantCount: group.variantIds.length,
        });
        if (warning !== undefined) lowResolution.push(warning);
      }
      return { position: design.position, imageId: slot.uploadId, placement: placed.image };
    }),
  }));
  if (strict && lowResolution.length > 0) {
    throw new ToolError(
      `strict is set and the artwork would print at low resolution: ${lowResolution.join('; ')}.`,
      STRICT_HINT,
    );
  }
  warnings.push(...lowResolution);
  for (const slot of unchecked) {
    warnings.push(
      `resolution of ${slot.fileName} could not be checked: Printify did not report its size`,
    );
  }
  return areas;
}

function sizeOf(slot: ImageSlot): Size | undefined {
  if (slot.width === undefined || slot.height === undefined) return undefined;
  return { width: slot.width, height: slot.height };
}

export const workflowsTools: readonly Tool[] = [createProductFromImageTool];
```

- [ ] **Step 4: Wire it in** — apply to `src/tools/index.ts` and `.github/workflows/ci.yml`:

```diff
diff --git a/src/tools/index.ts b/src/tools/index.ts
index 05cc5ef..ea54755 100644
--- a/src/tools/index.ts
+++ b/src/tools/index.ts
@@ -4,6 +4,7 @@ import type { Tool } from './define.js';
 import { productsTools } from './products.js';
 import { shopsTools } from './shops.js';
 import { uploadsTools } from './uploads.js';
+import { workflowsTools } from './workflows.js';

 /**
  * Each toolset's tools, from `src/tools/<toolset>.ts`. A toolset's issue replaces its `[]` with
@@ -19,7 +20,7 @@ export const TOOLS_BY_TOOLSET: Readonly<Record<Toolset, readonly Tool[]>> = {
   orders: [],
   support: [],
   webhooks: [],
-  workflows: [],
+  workflows: workflowsTools,
 };

 /** Every tool the server can offer, in `TOOLSETS` order. */
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
index 96dd331..0bf07ce 100644
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -65,7 +65,8 @@ jobs:
             get_shipping_info list_print_providers get_print_provider \
             list_shipping_methods get_shipping_costs \
             upload_image list_uploads get_upload \
-            list_products get_product get_product_gpsr create_product update_product; do
+            list_products get_product get_product_gpsr create_product update_product \
+            create_product_from_image; do
             grep -q "\"name\":\"$tool\"" <<<"$output"
           done
       - name: Check --version
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run test/tools/workflows.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 6: Amend the spec's `next_step` bullet** — in `docs/superpowers/specs/2026-09-30-create-product-from-image-design.md`, replace the bullet that starts `- **\`next_step\`** says the product is an unpublished draft` with:

```markdown
- **`next_step`** says the product is an unpublished draft whose mockups can be reviewed and
  changed with `update_product`. It does not name `publish_product`: reading `ALL_TOOLS` from
  `workflows.ts` would be an import cycle. A test fails once `publish_product` exists, so the
  publishing toolset (#12) updates this text.
```

- [ ] **Step 7: Full verification, including the CI smoke step**

Run `npm run lint && npm run typecheck && npm test && npm run build` (736 tests), then reproduce the smoke step:

```bash
output=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | PRINTIFY_API_TOKEN=smoke-test-token timeout 10 node dist/index.js 2>/dev/null)
grep -q '"name":"create_product_from_image"' <<<"$output" && echo SMOKE-OK
```

Expected: `SMOKE-OK`.

- [ ] **Step 8: Commit**

```bash
git add src/tools/workflows.ts src/tools/index.ts .github/workflows/ci.yml test/tools/workflows.test.ts docs/superpowers/specs/2026-09-30-create-product-from-image-design.md
git commit -m "Add create_product_from_image to the workflows toolset

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Spec coverage

- Inputs, semantics, annotations, no gate: Task 5 (schema) and Tasks 1–3 (semantics).
- Data-flow order, validation before writes, dedup: Task 5 ("checks the colors before uploading anything", "uploads an image used on two positions once", "reads the size of an upload_id").
- Grouping by placeholder size: Task 2, and Task 5's full-sequence body.
- Placement maths, rounding, resolution check, unknown size: Task 1, Task 5.
- Payload and pricing: Task 3, Task 5.
- Output shape, mock-up cap, warnings omitted when empty: Tasks 3 and 5.
- Partial failure with `uploaded`; cancellation unchanged: Task 4, Task 5.
- CI smoke: Task 5.
- Acceptance criteria: placement and filtering unit tests (Tasks 1–2), harness full sequence (Task 5), failure midway reports uploads (Tasks 4–5).
