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
