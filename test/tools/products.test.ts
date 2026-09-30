import { describe, expect, it } from 'vitest';
import { apiErrorBody } from '../fixtures/errors.js';
import {
  GPSR_SECTIONS,
  PRODUCT,
  lockedProduct,
  product,
  productsPage,
} from '../fixtures/products.js';
import { SHOP } from '../fixtures/shops.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { json } from '../support/fake-api.js';
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

const NEW_PRODUCT = {
  title: 'Product',
  description: 'Good product',
  blueprint_id: 384,
  print_provider_id: 1,
  variants: [
    { id: 45740, price: 400, is_enabled: true, is_default: true },
    { id: 45742, price: 400, is_enabled: false },
  ],
  print_areas: [
    {
      variant_ids: [45740, 45742],
      placeholders: [
        {
          position: 'front',
          images: [{ id: '5d15ca551163cde90d7b2203', x: 0.5, y: 0.5, scale: 1, angle: 0 }],
        },
      ],
    },
  ],
  tags: ['Tee'],
  print_details: { print_on_side: 'regular' },
  is_printify_express_enabled: false,
  sales_channel_properties: { free_shipping: false },
};

describe('create_product', () => {
  it('posts the body as given and returns the summary', async () => {
    const { call, api } = await createTestServer({
      routes: { [`POST ${PRODUCTS_PATH}`]: PRODUCT },
    });
    const data = expectToolData(await call('create_product', { shop_id: SHOP_ID, ...NEW_PRODUCT }));
    expect(data).toMatchObject({ id: PRODUCT.id, title: PRODUCT.title, variant_count: 4 });
    expect(data).not.toHaveProperty('views');
    expect(api.expectRequest('POST', PRODUCTS_PATH).body).toEqual(NEW_PRODUCT);
  });

  it('rejects a missing required field before any request', async () => {
    const { call, api } = await createTestServer();
    const { variants, ...withoutVariants } = NEW_PRODUCT;
    expect(variants).toHaveLength(2);
    expectToolError(await call('create_product', { shop_id: SHOP_ID, ...withoutVariants }), {
      kind: 'validation',
    });
    expect(api.requests).toHaveLength(0);
  });

  it('rejects empty variants and empty print_areas', async () => {
    const { call, api } = await createTestServer();
    expectToolError(
      await call('create_product', { shop_id: SHOP_ID, ...NEW_PRODUCT, variants: [] }),
      {
        kind: 'validation',
      },
    );
    expectToolError(
      await call('create_product', { shop_id: SHOP_ID, ...NEW_PRODUCT, print_areas: [] }),
      { kind: 'validation' },
    );
    expect(api.requests).toHaveLength(0);
  });

  it('rejects a bad image placement, a placeholder without a position and an unknown key', async () => {
    const { call, api } = await createTestServer();
    const withImage = (image: Record<string, unknown>) => ({
      shop_id: SHOP_ID,
      ...NEW_PRODUCT,
      print_areas: [
        { variant_ids: [45740], placeholders: [{ position: 'front', images: [image] }] },
      ],
    });
    const good = { id: 'img', x: 0.5, y: 0.5, scale: 1, angle: 0 };
    for (const bad of [
      { ...good, x: 1.5 },
      { ...good, y: -0.1 },
      { ...good, scale: 0 },
      { ...good, angle: 361 },
      { ...good, angle: 1.5 },
      { ...good, src: 'https://example.com/a.png' },
    ]) {
      expectToolError(await call('create_product', withImage(bad)), { kind: 'validation' });
    }
    expectToolError(
      await call('create_product', {
        shop_id: SHOP_ID,
        ...NEW_PRODUCT,
        print_areas: [{ variant_ids: [45740], placeholders: [{ images: [good] }] }],
      }),
      { kind: 'validation' },
    );
    expectToolError(
      await call('create_product', {
        shop_id: SHOP_ID,
        ...NEW_PRODUCT,
        print_areas: [{ variant_ids: [], placeholders: [{ position: 'front', images: [good] }] }],
      }),
      { kind: 'validation' },
    );
    expectToolError(
      await call('create_product', {
        shop_id: SHOP_ID,
        ...NEW_PRODUCT,
        variants: [{ id: 45740, price: 400, is_enable: true }],
      }),
      { kind: 'validation' },
    );
    expect(api.requests).toHaveLength(0);
  });

  it("passes Printify's low-quality image error back with its hint", async () => {
    const body = apiErrorBody({
      code: 8203,
      message: 'Validation failed.',
      reason: 'Image has low quality',
    });
    const { call } = await createTestServer({
      routes: { [`POST ${PRODUCTS_PATH}`]: json(body, 400) },
    });
    const error = expectToolError(
      await call('create_product', { shop_id: SHOP_ID, ...NEW_PRODUCT }),
      {
        kind: 'http',
        status: 400,
        code: 8203,
      },
    );
    expect(error.hint).toContain('resolution is too low');
  });
});

describe('update_product', () => {
  const routes = (updated: object = product({ title: 'Renamed' })) => ({
    [`GET ${PRODUCT_PATH}`]: PRODUCT,
    [`PUT ${PRODUCT_PATH}`]: updated,
  });
  /** The writable fields of a fixture variant, as the merge sends them. */
  const sent = (index: number, overrides: Record<string, unknown> = {}) => {
    const variant = PRODUCT.variants[index];
    if (variant === undefined) throw new Error(`no fixture variant ${String(index)}`);
    const { id, price, is_enabled, is_default, sku } = variant;
    return { id, price, is_enabled, is_default, sku, ...overrides };
  };

  it('fetches, then puts a title-only update and returns the summary', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    const data = expectToolData(await call('update_product', { ...ID, title: 'Renamed' }));
    expect(data).toMatchObject({ id: PRODUCT.id, title: 'Renamed', sent_fields: ['title'] });
    expect(data).not.toHaveProperty('views');
    api.expectRequest('GET', PRODUCT_PATH);
    expect(api.expectRequest('PUT', PRODUCT_PATH).body).toEqual({ title: 'Renamed' });
  });

  it('sends the complete variant list for a partial change (the XL example)', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    const data = expectToolData(
      await call('update_product', {
        ...ID,
        variants: [
          { id: 17889, price: 2499 },
          { id: 17890, price: 2499 },
        ],
      }),
    );
    expect(data['sent_fields']).toEqual(['variants']);
    expect(api.expectRequest('PUT', PRODUCT_PATH).body).toEqual({
      variants: [sent(0), sent(1), sent(2, { price: 2499 }), sent(3, { price: 2499 })],
    });
  });

  it('unsets the other defaults when one variant becomes the default', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    expectToolData(
      await call('update_product', { ...ID, variants: [{ id: 17890, is_default: true }] }),
    );
    const body = api.expectRequest('PUT', PRODUCT_PATH).body as {
      variants: { is_default: boolean }[];
    };
    expect(body.variants.map((variant) => variant.is_default)).toEqual([false, false, false, true]);
  });

  it('refuses a variant id the product does not have, after the GET only', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    const error = expectToolError(
      await call('update_product', {
        ...ID,
        variants: [
          { id: 17889, price: 1 },
          { id: 99, price: 1 },
        ],
      }),
      { kind: 'tool' },
    );
    expect(error.message).toBe(`Product ${PRODUCT.id} has no variant 99.`);
    expect(error.hint).toContain('replace_variants');
    expect(api.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('sends the variants as given with replace_variants', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    const variants = [
      { id: 17887, price: 1200, is_enabled: true },
      { id: 17891, price: 1300 },
    ];
    expectToolData(await call('update_product', { ...ID, variants, replace_variants: true }));
    expect(api.expectRequest('PUT', PRODUCT_PATH).body).toEqual({ variants });
  });

  it('refuses replace_variants without variants, or with a variant lacking a price', async () => {
    const { call, api } = await createTestServer();
    const noList = await call('update_product', { ...ID, title: 'x', replace_variants: true });
    expect(expectToolError(noList, { kind: 'tool' }).message).toContain(
      'replace_variants needs variants',
    );
    const unpriced = await call('update_product', {
      ...ID,
      variants: [{ id: 17887, price: 1 }, { id: 17888 }],
      replace_variants: true,
    });
    expect(expectToolError(unpriced, { kind: 'tool' }).message).toContain('17888');
    expect(api.requests).toHaveLength(0);
  });

  it('refuses duplicate variant ids, an empty variants list and an empty update', async () => {
    const { call, api } = await createTestServer();
    const duplicate = await call('update_product', {
      ...ID,
      variants: [
        { id: 17887, price: 1 },
        { id: 17887, price: 2 },
      ],
    });
    expect(expectToolError(duplicate, { kind: 'tool' }).message).toContain('17887');
    expectToolError(await call('update_product', { ...ID, variants: [] }), { kind: 'validation' });
    const empty = await call('update_product', ID);
    expect(expectToolError(empty, { kind: 'tool' }).message).toContain('Nothing to update');
    expect(api.requests).toHaveLength(0);
  });

  it('refuses a locked product before the PUT', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${PRODUCT_PATH}`]: lockedProduct() },
    });
    const error = expectToolError(await call('update_product', { ...ID, title: 'x' }), {
      kind: 'tool',
    });
    expect(error.message).toContain('is locked because it is being published');
    expect(error.hint).toContain('publishing result');
    expect(api.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('refuses to merge into a product whose variants cannot be resent', async () => {
    const { call, api } = await createTestServer({
      routes: {
        [`GET ${PRODUCT_PATH}`]: { ...PRODUCT, variants: [{ id: 17887, title: 'no price' }] },
      },
    });
    expectToolError(await call('update_product', { ...ID, variants: [{ id: 17887, price: 1 }] }), {
      kind: 'invalid_response',
    });
    expect(api.requests.map((request) => request.method)).toEqual(['GET']);
  });

  it('sends print_areas and the other fields as given', async () => {
    const { call, api } = await createTestServer({ routes: routes() });
    const print_areas = NEW_PRODUCT.print_areas;
    expectToolData(
      await call('update_product', {
        ...ID,
        print_areas,
        tags: ['New'],
        external: [{ shipping_template_id: 'tpl-1' }],
      }),
    );
    expect(api.expectRequest('PUT', PRODUCT_PATH).body).toEqual({
      print_areas,
      tags: ['New'],
      external: [{ shipping_template_id: 'tpl-1' }],
    });
  });

  it("passes Printify's low-quality image error from the PUT back with its hint", async () => {
    const body = apiErrorBody({
      code: 8203,
      message: 'Validation failed.',
      reason: 'Image has low quality',
    });
    const { call } = await createTestServer({ routes: routes(json(body, 400)) });
    const error = expectToolError(await call('update_product', { ...ID, title: 'x' }), {
      kind: 'http',
      code: 8203,
    });
    expect(error.hint).toContain('resolution is too low');
  });
});
