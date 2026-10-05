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

function toSize(bucket: SizeBucket): PrintAreaSize {
  return {
    width_px: bucket.width,
    height_px: bucket.height,
    ...withAspectRatio(bucket.width, bucket.height),
    variant_count: bucket.variantIds.length,
    variant_ids: bucket.variantIds,
  };
}

/** Greater width first; equal widths by greater height. Scale is relative to width. */
function byLargest(a: SizeBucket, b: SizeBucket): number {
  if (a.width !== b.width) return b.width - a.width;
  return b.height - a.height;
}

/** `{ aspect_ratio }` when it exists, `{}` otherwise, so an absent ratio is absent, not undefined. */
function withAspectRatio(width: number, height: number): { aspect_ratio?: number } {
  const ratio = aspectRatio(width, height);
  return ratio === undefined ? {} : { aspect_ratio: ratio };
}
