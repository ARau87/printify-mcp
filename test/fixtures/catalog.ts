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

/**
 * A catalogue wide enough to rank against: two hoodie-like Gildan records, a tee, a mug, one whose
 * only hit is inside its HTML description, one with a trademark sign, and one missing brand and
 * model. Deliberately not in id or title order, so a test that passes proves the sort ran.
 */
export const SEARCH_BLUEPRINTS = [
  {
    id: 49,
    title: 'Unisex Heavy Blend™ Hooded Sweatshirt',
    description: '<p>A <strong>classic</strong> pullover hoodie.</p>',
    brand: 'Gildan',
    model: '18500',
    images: [],
  },
  {
    id: 77,
    title: 'Unisex Hooded Zip Sweatshirt',
    description: '<p>Full-zip, fleece lined.</p>',
    brand: 'Gildan',
    model: '18600',
    images: [],
  },
  {
    id: 6,
    title: 'Unisex Jersey Short Sleeve Tee',
    description: '<p>Soft cotton, retail fit.</p>',
    brand: 'Bella+Canvas',
    model: '3001',
    images: [],
  },
  {
    id: 12,
    title: 'White Ceramic Mug',
    description: '<p>Dishwasher safe. 11oz.</p>',
    brand: 'Generic',
    model: 'MUG11',
    images: [],
  },
  {
    id: 31,
    title: 'Classic Tote Bag',
    description: '<p>Made from recycled <em>polyester</em> canvas.</p>',
    brand: 'Liberty Bags',
    model: '8870',
    images: [],
  },
  {
    id: 88,
    title: 'Canteen Steel Bottle',
    description: '<p>Vacuum insulated.</p>',
    brand: 'Generic',
    model: 'BTL20',
    images: [],
  },
  {
    id: 2,
    title: 'Adult Fleece Hoodie',
    description: '<p>Midweight.</p>',
    brand: 'Delta',
    model: '97300',
    images: [],
  },
  {
    id: 64,
    images: [],
  },
];
