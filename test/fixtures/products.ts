import { SHOP } from './shops.js';

const SHOP_ID = SHOP.id;

/**
 * A product as `GET /v1/shops/{shop_id}/products/{product_id}.json` returns one, trimmed to the
 * fields tools read. `external` is null on purpose: it proves the registry drops nulls.
 */
export const PRODUCT = {
  id: '5d39b159e7c48c000728c89f',
  title: 'Unisex Jersey Short Sleeve Tee',
  description: 'A soft cotton tee.',
  tags: ['T-shirt', 'Men'],
  blueprint_id: 6,
  print_provider_id: 99,
  shop_id: SHOP_ID,
  visible: true,
  is_locked: false,
  external: null,
  variants: [
    { id: 17887, sku: '19473', price: 1000, is_enabled: true, is_default: true, grams: 180 },
    { id: 17888, sku: '19474', price: 1000, is_enabled: false, is_default: false, grams: 180 },
  ],
  images: [
    {
      src: 'https://images.printify.com/mockup/1.png',
      variant_ids: [17887],
      position: 'front',
      is_default: true,
    },
  ],
  print_areas: [
    {
      variant_ids: [17887, 17888],
      placeholders: [
        {
          position: 'front',
          images: [{ id: '5cb87a8cd490a2ccb256cec4', x: 0.5, y: 0.5, scale: 1, angle: 0 }],
        },
      ],
    },
  ],
  created_at: '2019-07-25 13:40:41+00:00',
};

export function product(overrides: Partial<typeof PRODUCT> = {}): typeof PRODUCT {
  return { ...PRODUCT, ...overrides };
}
