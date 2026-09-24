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
