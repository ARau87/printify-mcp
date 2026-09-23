import { describe, expect, it, vi } from 'vitest';
import { DISCONNECTED_SHOP, SHOP, SHOPS } from '../fixtures/shops.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { inTurn, never } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';
import { getShopId } from './fixtures.js';

const SEVERAL_SHOPS_HINT =
  'Ask the user which shop to use and pass its id as shop_id. To make one the default, set ' +
  'PRINTIFY_SHOP_ID in the "env" block of the printify-mcp entry in the MCP client config.';

describe('resolveShopId', () => {
  it('uses shop_id when it is given, over PRINTIFY_SHOP_ID, without a request', async () => {
    const { call, api } = await createTestServer({
      tools: [getShopId],
      env: { PRINTIFY_SHOP_ID: '9876' },
    });
    expect(expectToolData(await call('get_shop_id', { shop_id: 5432 }))).toEqual({ shop_id: 5432 });
    expect(api.requests).toEqual([]);
  });

  it('uses PRINTIFY_SHOP_ID without a request', async () => {
    const { call, api } = await createTestServer({
      tools: [getShopId],
      env: { PRINTIFY_SHOP_ID: '9876' },
    });
    expect(expectToolData(await call('get_shop_id'))).toEqual({ shop_id: 9876 });
    expect(api.requests).toEqual([]);
  });

  it('uses the only shop, and lists the shops only once', async () => {
    const { call, api } = await createTestServer({
      tools: [getShopId],
      routes: { 'GET /v1/shops.json': [SHOP] },
    });
    expect(expectToolData(await call('get_shop_id'))).toEqual({ shop_id: SHOP.id });
    expect(expectToolData(await call('get_shop_id'))).toEqual({ shop_id: SHOP.id });
    api.expectRequest('GET', '/v1/shops.json');
  });

  it('refuses when the account has no shops', async () => {
    const { call } = await createTestServer({
      tools: [getShopId],
      routes: { 'GET /v1/shops.json': [] },
    });
    expectToolError(await call('get_shop_id'), {
      kind: 'tool',
      message: 'This Printify account has no shops.',
      hint: 'Add a shop in Printify first, then try again.',
    });
  });

  it('refuses and lists the shops when there are several', async () => {
    const { call } = await createTestServer({
      tools: [getShopId],
      routes: { 'GET /v1/shops.json': SHOPS },
    });
    expectToolError(await call('get_shop_id'), {
      kind: 'tool',
      message:
        'This Printify account has 2 shops, so shop_id is needed: 5432 "My new store" ' +
        '(My Sales Channel), 9876 "My other new store" (disconnected).',
      hint: SEVERAL_SHOPS_HINT,
    });
  });

  it('quotes each title and leaves out a missing title or sales channel', async () => {
    const { call } = await createTestServer({
      tools: [getShopId],
      routes: {
        'GET /v1/shops.json': [
          { id: 1, title: 'Say "hi"\nnow', sales_channel: 'etsy' },
          { id: 2, sales_channel: 'shopify' },
          { id: 3, title: 'API' },
        ],
      },
    });
    expectToolError(await call('get_shop_id'), {
      kind: 'tool',
      message:
        'This Printify account has 3 shops, so shop_id is needed: 1 "Say \\"hi\\"\\nnow" (etsy), ' +
        '2 (shopify), 3 "API".',
      hint: SEVERAL_SHOPS_HINT,
    });
  });

  it('cancels the shop list request with the call, and does not cache it', async () => {
    const { call, api } = await createTestServer({
      tools: [getShopId],
      routes: { 'GET /v1/shops.json': inTurn(never(), [DISCONNECTED_SHOP]) },
    });
    const controller = new AbortController();
    const pending = call('get_shop_id', {}, { signal: controller.signal });
    await vi.waitUntil(() => api.requests.length === 1);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(api.requests[0]?.signal.aborted).toBe(true);
    expect(expectToolData(await call('get_shop_id'))).toEqual({ shop_id: DISCONNECTED_SHOP.id });
    expect(api.requests).toHaveLength(2);
  });

  it.each([
    ['zero', 0],
    ['a string', '5432'],
    ['a fraction', 54.32],
  ])('rejects a shop_id that is %s before any request', async (_, shopId) => {
    const { call, api } = await createTestServer({ tools: [getShopId] });
    expectToolError(await call('get_shop_id', { shop_id: shopId }), { kind: 'validation' });
    expect(api.requests).toEqual([]);
  });
});
