import { describe, expect, it } from 'vitest';
import { TOOLS_BY_TOOLSET } from '../../src/tools/index.js';
import { notFoundBody } from '../fixtures/errors.js';
import { PRODUCT, lockedProduct } from '../fixtures/products.js';
import { CUSTOM_SHOP, DISCONNECTED_SHOP, SHOP, SHOPS } from '../fixtures/shops.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { json } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';

const SHOPS_PATH = '/v1/shops.json';
const ALL_SHOPS = [...SHOPS, CUSTOM_SHOP];

function productPath(shopId: number): string {
  return `/v1/shops/${String(shopId)}/products/${PRODUCT.id}.json`;
}

function actionPath(shopId: number, action: string): string {
  return `/v1/shops/${String(shopId)}/products/${PRODUCT.id}/${action}.json`;
}

/** The routes a publish on `shopId` needs: the shop list, the product and the publish endpoint. */
function publishRoutes(shopId: number, product: object = PRODUCT) {
  return {
    [`GET ${SHOPS_PATH}`]: ALL_SHOPS,
    [`GET ${productPath(shopId)}`]: product,
    [`POST ${actionPath(shopId, 'publish')}`]: {},
  };
}

const ALL_TRUE = {
  title: true,
  description: true,
  images: true,
  variants: true,
  tags: true,
  key_features: true,
  shipping_template: true,
};

describe('the publishing toolset', () => {
  it('registers four ungated write tools, in flow order', async () => {
    const { mcp } = await createTestServer();
    const { tools } = await mcp.listTools();
    const names = [
      'publish_product',
      'set_publishing_succeeded',
      'set_publishing_failed',
      'set_product_unpublished',
    ];
    expect(TOOLS_BY_TOOLSET.publishing.map((tool) => tool.name)).toEqual(names);
    for (const name of names) {
      expect(tools.find((tool) => tool.name === name)?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: name !== 'publish_product',
        openWorldHint: true,
      });
    }
  });
});

describe('publish_product', () => {
  it('on a connected shop, says Printify is publishing and names the channel', async () => {
    const { call, api } = await createTestServer({ routes: publishRoutes(SHOP.id) });
    const data = expectToolData(
      await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id }),
    );
    expect(data).toMatchObject({
      product_id: PRODUCT.id,
      title: PRODUCT.title,
      shop_id: SHOP.id,
      sales_channel: SHOP.sales_channel,
      shop_kind: 'connected',
      published: ALL_TRUE,
      locked: true,
    });
    expect(data['next_step']).toContain(`publishing the product to ${SHOP.sales_channel}`);
    expect(data['next_step']).toContain('get_product');
    expect(data['next_step']).not.toContain('set_publishing_succeeded');
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      `GET ${SHOPS_PATH}`,
      `GET ${productPath(SHOP.id)}`,
      `POST ${actionPath(SHOP.id, 'publish')}`,
    ]);
  });

  it.each([DISCONNECTED_SHOP, CUSTOM_SHOP])(
    'on an API shop ($sales_channel), says the product is locked until the integration reports',
    async (apiShop) => {
      const { call } = await createTestServer({ routes: publishRoutes(apiShop.id) });
      const data = expectToolData(
        await call('publish_product', { shop_id: apiShop.id, product_id: PRODUCT.id }),
      );
      expect(data).toMatchObject({
        sales_channel: apiShop.sales_channel,
        shop_kind: 'api',
        locked: true,
      });
      expect(data['next_step']).toContain('set_publishing_succeeded');
      expect(data['next_step']).toContain('set_publishing_failed');
    },
  );

  it('sends every flag true by default, keyFeatures in camel case', async () => {
    const { call, api } = await createTestServer({ routes: publishRoutes(SHOP.id) });
    expectToolData(await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id }));
    expect(api.expectRequest('POST', actionPath(SHOP.id, 'publish')).body).toEqual({
      title: true,
      description: true,
      images: true,
      variants: true,
      tags: true,
      keyFeatures: true,
      shipping_template: true,
    });
  });

  it('sends a false flag as given, key_features as keyFeatures, and reports what it sent', async () => {
    const { call, api } = await createTestServer({ routes: publishRoutes(SHOP.id) });
    const data = expectToolData(
      await call('publish_product', {
        shop_id: SHOP.id,
        product_id: PRODUCT.id,
        tags: false,
        key_features: false,
      }),
    );
    expect(api.expectRequest('POST', actionPath(SHOP.id, 'publish')).body).toEqual({
      title: true,
      description: true,
      images: true,
      variants: true,
      tags: false,
      keyFeatures: false,
      shipping_template: true,
    });
    expect(data['published']).toEqual({ ...ALL_TRUE, tags: false, key_features: false });
  });

  it('fetches the shop list once per process', async () => {
    const { call, api } = await createTestServer({ routes: publishRoutes(SHOP.id) });
    const args = { shop_id: SHOP.id, product_id: PRODUCT.id };
    expectToolData(await call('publish_product', args));
    expectToolData(await call('publish_product', args));
    expect(api.requests.filter((request) => request.path === SHOPS_PATH)).toHaveLength(1);
  });

  it('refreshes the shop list once for an unknown shop_id, then covers both cases', async () => {
    const { call, api } = await createTestServer({ routes: publishRoutes(1111) });
    const data = expectToolData(
      await call('publish_product', { shop_id: 1111, product_id: PRODUCT.id }),
    );
    expect(data).toMatchObject({ shop_id: 1111, shop_kind: 'unknown', locked: true });
    expect(data).not.toHaveProperty('sales_channel');
    expect(data['next_step']).toContain('not in the account');
    expect(data['next_step']).toContain('set_publishing_succeeded');
    expect(api.requests.filter((request) => request.path === SHOPS_PATH)).toHaveLength(2);
    api.expectRequest('POST', actionPath(1111, 'publish'));
  });

  it('refuses a locked product before the POST, naming the unlock tools', async () => {
    const { call, api } = await createTestServer({
      routes: publishRoutes(DISCONNECTED_SHOP.id, lockedProduct()),
    });
    const error = expectToolError(
      await call('publish_product', { shop_id: DISCONNECTED_SHOP.id, product_id: PRODUCT.id }),
      { kind: 'tool' },
    );
    expect(error.message).toContain('is locked because it is being published');
    expect(error.hint).toContain('set_publishing_succeeded');
    expect(api.requests.map((request) => request.method)).toEqual(['GET', 'GET']);
  });

  it('uses the default shop when shop_id is left out', async () => {
    const { call, api } = await createTestServer({
      routes: { ...publishRoutes(SHOP.id), [`GET ${SHOPS_PATH}`]: [SHOP] },
    });
    const data = expectToolData(await call('publish_product', { product_id: PRODUCT.id }));
    expect(data).toMatchObject({ shop_id: SHOP.id, shop_kind: 'connected' });
    expect(api.requests.filter((request) => request.path === SHOPS_PATH)).toHaveLength(1);
  });

  it('classifies the shop when PRINTIFY_SHOP_ID is the default', async () => {
    const { call, api } = await createTestServer({
      env: { PRINTIFY_SHOP_ID: String(DISCONNECTED_SHOP.id) },
      routes: publishRoutes(DISCONNECTED_SHOP.id),
    });
    const data = expectToolData(await call('publish_product', { product_id: PRODUCT.id }));
    expect(data).toMatchObject({ shop_id: DISCONNECTED_SHOP.id, shop_kind: 'api' });
    expect(api.requests.filter((request) => request.path === SHOPS_PATH)).toHaveLength(1);
  });

  it('is unknown, without a refresh, for a listed shop that has no sales_channel', async () => {
    const { call, api } = await createTestServer({
      routes: { ...publishRoutes(SHOP.id), [`GET ${SHOPS_PATH}`]: [{ id: SHOP.id, title: 'x' }] },
    });
    const data = expectToolData(
      await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id }),
    );
    expect(data).toMatchObject({ shop_kind: 'unknown' });
    expect(data).not.toHaveProperty('sales_channel');
    expect(api.requests.filter((request) => request.path === SHOPS_PATH)).toHaveLength(1);
  });

  it('reports a product that is not found, without publishing', async () => {
    const { call, api } = await createTestServer({
      routes: {
        [`GET ${SHOPS_PATH}`]: ALL_SHOPS,
        [`GET ${productPath(SHOP.id)}`]: json(notFoundBody(), 404),
      },
    });
    const error = expectToolError(
      await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id }),
      { kind: 'http', status: 404 },
    );
    expect(error.hint).toContain('Check the id');
    expect(api.requests.map((request) => request.method)).toEqual(['GET', 'GET']);
  });

  it('reports a server error on the publish itself, with the retry hint', async () => {
    const { call } = await createTestServer({
      routes: {
        ...publishRoutes(SHOP.id),
        [`POST ${actionPath(SHOP.id, 'publish')}`]: json({ error: 'boom' }, 500),
      },
    });
    const error = expectToolError(
      await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id }),
      { kind: 'http', status: 500 },
    );
    expect(error.hint).toContain('Try again');
  });

  it('rejects an unknown argument and a bad product id before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(
      await call('publish_product', { shop_id: SHOP.id, product_id: PRODUCT.id, force: true }),
      { kind: 'validation' },
    );
    expectToolError(await call('publish_product', { shop_id: SHOP.id, product_id: '../x' }), {
      kind: 'validation',
    });
    expect(api.requests).toHaveLength(0);
  });
});

describe('set_publishing_succeeded', () => {
  const PATH = actionPath(SHOP.id, 'publishing_succeeded');
  const ARGS = {
    shop_id: SHOP.id,
    product_id: PRODUCT.id,
    external_id: '5941187eb8e7e37b3f0e62e5',
    handle: 'https://example.com/path/to/product',
  };

  it('sends the documented external object and reports the product unlocked', async () => {
    const { call, api } = await createTestServer({ routes: { [`POST ${PATH}`]: {} } });
    const data = expectToolData(await call('set_publishing_succeeded', ARGS));
    expect(api.expectRequest('POST', PATH).body).toEqual({
      external: { id: ARGS.external_id, handle: ARGS.handle },
    });
    expect(data).toEqual({
      product_id: PRODUCT.id,
      external: { id: ARGS.external_id, handle: ARGS.handle },
      locked: false,
    });
    expect(api.requests).toHaveLength(1);
  });

  it('needs both external_id and handle', async () => {
    const { call, api } = await createTestServer();
    const noHandle = { shop_id: SHOP.id, product_id: PRODUCT.id, external_id: ARGS.external_id };
    expectToolError(await call('set_publishing_succeeded', noHandle), { kind: 'validation' });
    expectToolError(await call('set_publishing_succeeded', { ...ARGS, external_id: '' }), {
      kind: 'validation',
    });
    expect(api.requests).toHaveLength(0);
  });
});

describe('set_publishing_failed', () => {
  const PATH = actionPath(SHOP.id, 'publishing_failed');

  it('sends the reason and reports the product unlocked', async () => {
    const { call, api } = await createTestServer({ routes: { [`POST ${PATH}`]: {} } });
    const data = expectToolData(
      await call('set_publishing_failed', {
        shop_id: SHOP.id,
        product_id: PRODUCT.id,
        reason: 'Request timed out',
      }),
    );
    expect(api.expectRequest('POST', PATH).body).toEqual({ reason: 'Request timed out' });
    expect(data).toEqual({ product_id: PRODUCT.id, reason: 'Request timed out', locked: false });
  });

  it('rejects an empty or missing reason before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(
      await call('set_publishing_failed', { shop_id: SHOP.id, product_id: PRODUCT.id, reason: '' }),
      { kind: 'validation' },
    );
    expectToolError(
      await call('set_publishing_failed', { shop_id: SHOP.id, product_id: PRODUCT.id }),
      { kind: 'validation' },
    );
    expect(api.requests).toHaveLength(0);
  });
});

describe('set_product_unpublished', () => {
  const PATH = actionPath(SHOP.id, 'unpublish');

  it('posts without a body and reports the product unpublished', async () => {
    const { call, api } = await createTestServer({ routes: { [`POST ${PATH}`]: {} } });
    const data = expectToolData(
      await call('set_product_unpublished', { shop_id: SHOP.id, product_id: PRODUCT.id }),
    );
    expect(api.expectRequest('POST', PATH).body).toBeUndefined();
    expect(data).toEqual({ product_id: PRODUCT.id, unpublished: true });
  });

  it('rejects an unknown argument before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(
      await call('set_product_unpublished', { shop_id: SHOP.id, product_id: PRODUCT.id, x: 1 }),
      { kind: 'validation' },
    );
    expect(api.requests).toHaveLength(0);
  });
});
