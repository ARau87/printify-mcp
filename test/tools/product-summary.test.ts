import { describe, expect, it } from 'vitest';
import type { Product } from '../../src/printify/products.js';
import { productRow, summarizeProduct } from '../../src/tools/product-summary.js';

const ART = {
  id: 'img-1',
  src: 'https://image-storage.example.com/art.png',
  name: 'art.png',
  type: 'image/png',
  width: 3000,
  height: 4000,
  x: 0.5,
  y: 0.5,
  scale: 1,
  angle: 0,
};

const TEXT_LAYER = {
  id: 'img-2',
  src: 'https://image-storage.example.com/text.png',
  type: 'image/png',
  x: 0.5,
  y: 0.2,
  scale: 0.6,
  angle: 0,
  font_family: 'Arial',
  input_text: 'Hello',
};

/** A product with the fields the views read; a test overrides only what it varies. */
function aProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    title: 'Tee',
    description: 'Soft.',
    tags: ['a'],
    blueprint_id: 6,
    print_provider_id: 99,
    visible: true,
    is_locked: false,
    is_printify_express_enabled: false,
    external: [{ id: 'ext-1', handle: '/products/tee', shipping_template_id: 'tpl-1' }],
    variants: [
      {
        id: 1,
        price: 1000,
        title: 'S',
        sku: 'S-1',
        cost: 650,
        is_enabled: true,
        is_default: true,
        is_available: true,
        grams: 180,
      },
      {
        id: 2,
        price: 1000,
        title: 'M',
        sku: 'M-1',
        cost: 650,
        is_enabled: false,
        is_default: false,
        is_available: false,
        grams: 180,
      },
    ],
    images: [
      {
        src: 'https://images.example.com/1.png',
        variant_ids: [1, 2],
        position: 'front',
        is_default: true,
      },
      {
        src: 'https://images.example.com/2.png',
        variant_ids: [1, 2],
        position: 'back',
        is_default: false,
      },
    ],
    print_areas: [
      {
        variant_ids: [1, 2],
        placeholders: [
          { position: 'front', images: [ART] },
          { position: 'back', images: [TEXT_LAYER] },
        ],
        background: '#ffffff',
      },
    ],
    views: [{ id: 1, label: 'Front', position: 'front', files: [] }],
    options: [{ name: 'Sizes', type: 'size', values: [] }],
    created_at: '2019-07-25 13:40:41+00:00',
    updated_at: '2019-07-25 13:40:59+00:00',
    ...overrides,
  };
}

describe('productRow', () => {
  it('summarises a product to its list row', () => {
    expect(productRow(aProduct())).toEqual({
      id: 'p1',
      title: 'Tee',
      blueprint_id: 6,
      print_provider_id: 99,
      visible: true,
      is_locked: false,
      variant_count: 2,
      enabled_variant_count: 1,
      external: [{ id: 'ext-1', handle: '/products/tee' }],
      updated_at: '2019-07-25 13:40:59+00:00',
    });
  });

  it('counts a variant without is_enabled as not enabled', () => {
    const row = productRow(
      aProduct({
        variants: [
          { id: 1, price: 1 },
          { id: 2, price: 1, is_enabled: true },
        ],
      }),
    );
    expect(row).toMatchObject({ variant_count: 2, enabled_variant_count: 1 });
  });

  it('leaves external out when the product has none', () => {
    const row = productRow(aProduct({ external: undefined }));
    expect(row.external).toBeUndefined();
  });
});

describe('summarizeProduct', () => {
  it('keeps the scalar fields and the counts', () => {
    expect(summarizeProduct(aProduct())).toMatchObject({
      id: 'p1',
      title: 'Tee',
      description: 'Soft.',
      tags: ['a'],
      is_printify_express_enabled: false,
      variant_count: 2,
      enabled_variant_count: 1,
      created_at: '2019-07-25 13:40:41+00:00',
    });
  });

  it('lists every variant as a compact row', () => {
    expect(summarizeProduct(aProduct()).variants).toEqual([
      {
        id: 1,
        title: 'S',
        sku: 'S-1',
        price: 1000,
        cost: 650,
        is_enabled: true,
        is_default: true,
        is_available: true,
      },
      {
        id: 2,
        title: 'M',
        sku: 'M-1',
        price: 1000,
        cost: 650,
        is_enabled: false,
        is_default: false,
        is_available: false,
      },
    ]);
  });

  it('strips src and type from print-area images and keeps a text layer', () => {
    const [area] = summarizeProduct(aProduct()).print_areas ?? [];
    expect(area).toMatchObject({ variant_ids: [1, 2], background: '#ffffff' });
    const [front, back] = area?.placeholders ?? [];
    const [art] = front?.images ?? [];
    expect(art).toEqual({
      id: 'img-1',
      name: 'art.png',
      width: 3000,
      height: 4000,
      x: 0.5,
      y: 0.5,
      scale: 1,
      angle: 0,
    });
    const [textLayer] = back?.images ?? [];
    expect(textLayer).toMatchObject({ font_family: 'Arial', input_text: 'Hello' });
    expect(textLayer).not.toHaveProperty('src');
  });

  it('returns the default mock-ups with the total count', () => {
    const summary = summarizeProduct(aProduct());
    expect(summary.mockups).toEqual([
      {
        src: 'https://images.example.com/1.png',
        variant_ids: [1, 2],
        position: 'front',
        is_default: true,
      },
    ]);
    expect(summary.mockup_count).toBe(2);
  });

  it('copies neither views nor options', () => {
    const summary = summarizeProduct(aProduct());
    expect(summary).not.toHaveProperty('views');
    expect(summary).not.toHaveProperty('options');
  });

  it('summarises a product with no images and no print areas', () => {
    const summary = summarizeProduct(aProduct({ images: undefined, print_areas: undefined }));
    expect(summary.mockups).toBeUndefined();
    expect(summary.mockup_count).toBeUndefined();
    expect(summary.print_areas).toBeUndefined();
  });
});
