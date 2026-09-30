import { describe, expect, it } from 'vitest';
import { GPSR_SECTIONS, PRODUCT, productsPage } from '../fixtures/products.js';
import { SHOP } from '../fixtures/shops.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { createTestServer } from '../support/harness.js';

const SHOP_ID = SHOP.id;
const PRODUCTS_PATH = `/v1/shops/${String(SHOP_ID)}/products.json`;
const PRODUCT_PATH = `/v1/shops/${String(SHOP_ID)}/products/${PRODUCT.id}.json`;
const GPSR_PATH = `/v1/shops/${String(SHOP_ID)}/products/${PRODUCT.id}/gpsr.json`;
const ID = { shop_id: SHOP_ID, product_id: PRODUCT.id };

describe('list_products', () => {
  it('lists the products as rows', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT]) },
    });
    const data = expectToolData(await call('list_products', { shop_id: SHOP_ID }));
    expect(data).toMatchObject({ page: 1, has_more: false, total: 1, last_page: 1 });
    expect(data['products']).toEqual([
      {
        id: PRODUCT.id,
        title: PRODUCT.title,
        blueprint_id: 6,
        print_provider_id: 99,
        visible: true,
        is_locked: false,
        variant_count: 4,
        enabled_variant_count: 3,
        updated_at: PRODUCT.updated_at,
      },
    ]);
    api.expectRequest('GET', PRODUCTS_PATH);
  });

  it('passes page and limit on, and reports more pages', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT], { last_page: 4, total: 31 }) },
    });
    const data = expectToolData(
      await call('list_products', { shop_id: SHOP_ID, page: 1, limit: 10 }),
    );
    expect(data).toMatchObject({ has_more: true, last_page: 4, total: 31 });
    expect(api.expectRequest('GET', PRODUCTS_PATH).query).toEqual({ page: '1', limit: '10' });
  });

  it('rejects a limit above 50 before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(await call('list_products', { shop_id: SHOP_ID, limit: 51 }), {
      kind: 'validation',
    });
    expect(api.requests).toHaveLength(0);
  });

  it('uses the default shop when shop_id is left out', async () => {
    const { call, api } = await createTestServer({
      routes: {
        'GET /v1/shops.json': [SHOP],
        [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT]),
      },
    });
    expectToolData(await call('list_products'));
    api.expectRequest('GET', '/v1/shops.json');
    api.expectRequest('GET', PRODUCTS_PATH);
  });
});

describe('get_product', () => {
  it('returns the summary by default', async () => {
    const { call, api } = await createTestServer({ routes: { [`GET ${PRODUCT_PATH}`]: PRODUCT } });
    const data = expectToolData(await call('get_product', ID));
    expect(data).toMatchObject({
      id: PRODUCT.id,
      title: PRODUCT.title,
      description: PRODUCT.description,
      tags: PRODUCT.tags,
      variant_count: 4,
      enabled_variant_count: 3,
      mockup_count: 3,
    });
    expect(data['variants']).toEqual([
      {
        id: 17887,
        title: 'Black / S',
        sku: '19473',
        price: 1000,
        cost: 650,
        is_enabled: true,
        is_default: true,
        is_available: true,
      },
      {
        id: 17888,
        title: 'Black / M',
        sku: '19474',
        price: 1000,
        cost: 650,
        is_enabled: false,
        is_default: false,
        is_available: true,
      },
      {
        id: 17889,
        title: 'Black / XL',
        sku: '19475',
        price: 1000,
        cost: 700,
        is_enabled: true,
        is_default: false,
        is_available: true,
      },
      {
        id: 17890,
        title: 'White / XL',
        sku: '19476',
        price: 1000,
        cost: 700,
        is_enabled: true,
        is_default: false,
        is_available: false,
      },
    ]);
    expect(data['mockups']).toEqual([PRODUCT.images[0]]);
    expect(data).not.toHaveProperty('views');
    expect(data).not.toHaveProperty('options');
    expect(data).not.toHaveProperty('external');
    const areas = data['print_areas'] as { placeholders: { images: object[] }[] }[];
    expect(areas[0]?.placeholders[0]?.images[0]).toEqual({
      id: '5cb87a8cd490a2ccb256cec4',
      name: 'art.png',
      height: 4000,
      width: 3000,
      x: 0.5,
      y: 0.5,
      scale: 1,
      angle: 0,
    });
    api.expectRequest('GET', PRODUCT_PATH);
  });

  it('returns the whole product with detail: "full"', async () => {
    const { call } = await createTestServer({ routes: { [`GET ${PRODUCT_PATH}`]: PRODUCT } });
    const data = expectToolData(await call('get_product', { ...ID, detail: 'full' }));
    expect(data).toMatchObject({ views: PRODUCT.views, options: PRODUCT.options });
    expect(data['variants']).toEqual(PRODUCT.variants);
    expect(data).not.toHaveProperty('external');
  });

  it('rejects a product_id with a path separator before any request', async () => {
    const { call, api } = await createTestServer();
    for (const product_id of ['../orders', 'abc/def', '']) {
      expectToolError(await call('get_product', { shop_id: SHOP_ID, product_id }), {
        kind: 'validation',
      });
    }
    expect(api.requests).toHaveLength(0);
  });

  it('rejects an unknown argument', async () => {
    const { call } = await createTestServer();
    expectToolError(await call('get_product', { ...ID, full: true }), { kind: 'validation' });
  });
});

describe('get_product_gpsr', () => {
  it('returns the sections', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${GPSR_PATH}`]: GPSR_SECTIONS },
    });
    expect(expectToolData(await call('get_product_gpsr', ID))).toEqual({
      product_id: PRODUCT.id,
      sections: GPSR_SECTIONS,
    });
    api.expectRequest('GET', GPSR_PATH);
  });
});
