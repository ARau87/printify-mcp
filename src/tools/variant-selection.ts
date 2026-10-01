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
