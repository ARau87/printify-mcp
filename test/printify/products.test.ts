import { describe, expect, it } from 'vitest';
import { createPrintifyClient, type PrintifyClient } from '../../src/printify/client.js';
import {
  createProduct,
  deleteProduct,
  getProduct,
  getProductGpsr,
  listProducts,
  updateProduct,
} from '../../src/printify/products.js';
import { Secret } from '../../src/secret.js';
import {
  GPSR_SECTIONS,
  PRODUCT,
  PRODUCT_MUG,
  product,
  productsPage,
} from '../fixtures/products.js';
import { SHOP } from '../fixtures/shops.js';
import { createFakeApi, json, text, type FakeApi, type Routes } from '../support/fake-api.js';
import { apiError } from './helpers.js';

const TOKEN = 'Tok-products-3C4d5E6f';
const SHOP_ID = SHOP.id;
const PRODUCTS_PATH = `/v1/shops/${String(SHOP_ID)}/products.json`;
const PRODUCT_PATH = `/v1/shops/${String(SHOP_ID)}/products/${PRODUCT.id}.json`;
const GPSR_PATH = `/v1/shops/${String(SHOP_ID)}/products/${PRODUCT.id}/gpsr.json`;
const CREATE_BODY = {
  title: 'Product',
  description: 'Good product',
  blueprint_id: 384,
  print_provider_id: 1,
  variants: [{ id: 45740, price: 400, is_enabled: true }],
  print_areas: [
    {
      variant_ids: [45740],
      placeholders: [
        { position: 'front', images: [{ id: 'img', x: 0.5, y: 0.5, scale: 1, angle: 0 }] },
      ],
    },
  ],
};

function testClient(routes: Routes = {}): { client: PrintifyClient; api: FakeApi } {
  const api = createFakeApi(routes);
  const client = createPrintifyClient({
    token: new Secret(TOKEN),
    baseUrl: 'https://api.printify.com',
    fetch: api.fetch,
  });
  return { client, api };
}

/** A signal that has not aborted. */
function live(): AbortSignal {
  return new AbortController().signal;
}

describe('getProduct', () => {
  it('gets one product, keeping the keys the summary drops', async () => {
    const { client, api } = testClient({ [`GET ${PRODUCT_PATH}`]: PRODUCT_MUG });
    // The route is keyed on PRODUCT.id; the body is the documented mug.
    const got = await getProduct(client, SHOP_ID, PRODUCT.id, live());
    expect(got).toMatchObject({
      id: PRODUCT_MUG.id,
      title: 'Mug 11oz',
      variants: PRODUCT_MUG.variants,
      views: PRODUCT_MUG.views,
      options: PRODUCT_MUG.options,
      sales_channel_properties: [],
    });
    api.expectRequest('GET', PRODUCT_PATH);
  });

  it('turns a null external and a wrong-typed tags into undefined', async () => {
    const { client } = testClient({
      [`GET ${PRODUCT_PATH}`]: product({
        external: null,
        tags: 'not a list' as unknown as string[],
      }),
    });
    const got = await getProduct(client, SHOP_ID, PRODUCT.id, live());
    expect(got.external).toBeUndefined();
    expect(got.tags).toBeUndefined();
    expect(got.title).toBe(PRODUCT.title);
  });

  it('reports a body without an id', async () => {
    const { client } = testClient({ [`GET ${PRODUCT_PATH}`]: { title: 'no id', variants: [] } });
    const error = await apiError(getProduct(client, SHOP_ID, PRODUCT.id, live()));
    expect(error.kind).toBe('invalid_response');
    expect(error.message).toContain('an unexpected product response');
  });

  it('reports a variant without an id or a price, and a variants that is not a list', async () => {
    const withoutPrice = { ...PRODUCT, variants: [{ id: 1, title: 'no price' }] };
    const notAList = { ...PRODUCT, variants: 'none' };
    for (const body of [withoutPrice, notAList]) {
      const { client } = testClient({ [`GET ${PRODUCT_PATH}`]: body });
      const error = await apiError(getProduct(client, SHOP_ID, PRODUCT.id, live()));
      expect(error.kind).toBe('invalid_response');
    }
  });
});

describe('getProductGpsr', () => {
  it('gets the sections', async () => {
    const { client, api } = testClient({ [`GET ${GPSR_PATH}`]: GPSR_SECTIONS });
    expect(await getProductGpsr(client, SHOP_ID, PRODUCT.id, live())).toEqual(GPSR_SECTIONS);
    api.expectRequest('GET', GPSR_PATH);
  });

  it('reports an object instead of a list', async () => {
    const { client } = testClient({ [`GET ${GPSR_PATH}`]: { title: 'x', text: 'y' } });
    const error = await apiError(getProductGpsr(client, SHOP_ID, PRODUCT.id, live()));
    expect(error.kind).toBe('invalid_response');
  });
});

describe('createProduct', () => {
  it('posts the body unchanged and returns the product', async () => {
    const { client, api } = testClient({ [`POST ${PRODUCTS_PATH}`]: PRODUCT });
    const created = await createProduct(client, SHOP_ID, CREATE_BODY, live());
    expect(created.id).toBe(PRODUCT.id);
    expect(api.expectRequest('POST', PRODUCTS_PATH).body).toEqual(CREATE_BODY);
  });
});

describe('updateProduct', () => {
  it('puts the body unchanged and returns the product', async () => {
    const { client, api } = testClient({ [`PUT ${PRODUCT_PATH}`]: product({ title: 'Renamed' }) });
    const updated = await updateProduct(client, SHOP_ID, PRODUCT.id, { title: 'Renamed' }, live());
    expect(updated.title).toBe('Renamed');
    expect(api.expectRequest('PUT', PRODUCT_PATH).body).toEqual({ title: 'Renamed' });
  });
});

describe('deleteProduct', () => {
  it('sends DELETE and accepts the documented empty object', async () => {
    const { client, api } = testClient({ [`DELETE ${PRODUCT_PATH}`]: json({}) });
    await expect(deleteProduct(client, SHOP_ID, PRODUCT.id, live())).resolves.toBeUndefined();
    api.expectRequest('DELETE', PRODUCT_PATH);
  });

  it('accepts a wholly empty body', async () => {
    const { client } = testClient({ [`DELETE ${PRODUCT_PATH}`]: text('', 200) });
    await expect(deleteProduct(client, SHOP_ID, PRODUCT.id, live())).resolves.toBeUndefined();
  });
});

describe('listProducts', () => {
  it('returns the page and its products', async () => {
    const { client, api } = testClient({ [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT]) });
    const page = await listProducts(client, SHOP_ID, { page: 1, limit: 10 }, live());
    expect(page).toMatchObject({ page: 1, hasMore: false, total: 1, lastPage: 1 });
    expect(page.products.map((item) => item.id)).toEqual([PRODUCT.id]);
    expect(api.expectRequest('GET', PRODUCTS_PATH).query).toEqual({ page: '1', limit: '10' });
  });

  it('reports more pages to come', async () => {
    const { client } = testClient({
      [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT], { last_page: 3, total: 22 }),
    });
    expect(await listProducts(client, SHOP_ID, {}, live())).toMatchObject({
      hasMore: true,
      lastPage: 3,
      total: 22,
    });
  });

  it('lowers a limit above the documented maximum of 50', async () => {
    const { client, api } = testClient({ [`GET ${PRODUCTS_PATH}`]: productsPage() });
    await listProducts(client, SHOP_ID, { limit: 500 }, live());
    expect(api.expectRequest('GET', PRODUCTS_PATH).query).toEqual({ limit: '50' });
  });

  it('reports a page with an item that is not a product', async () => {
    const { client } = testClient({
      [`GET ${PRODUCTS_PATH}`]: productsPage([PRODUCT, { title: 'no id', variants: [] }]),
    });
    const error = await apiError(listProducts(client, SHOP_ID, {}, live()));
    expect(error.kind).toBe('invalid_response');
    expect(error.message).toContain('an unexpected product response');
  });
});
