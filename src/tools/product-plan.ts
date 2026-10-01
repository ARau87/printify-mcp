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
