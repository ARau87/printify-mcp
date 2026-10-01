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
