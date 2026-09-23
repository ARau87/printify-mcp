import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { notFoundBody } from '../fixtures/errors.js';
import { DISCONNECTED_SHOP, SHOP, SHOPS } from '../fixtures/shops.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { inTurn, json } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';
import { getShopId } from './fixtures.js';

const DESTRUCTIVE_ON = { PRINTIFY_ENABLE_DESTRUCTIVE: 'true' };
const DISCONNECT_PATH = `/v1/shops/${String(DISCONNECTED_SHOP.id)}/connection.json`;
const DISCONNECT_ROUTE = `DELETE ${DISCONNECT_PATH}` as const;

describe('list_shops', () => {
  it('lists the shops, with PRINTIFY_SHOP_ID as the default', async () => {
    const { call, api } = await createTestServer({
      env: { PRINTIFY_SHOP_ID: '9876' },
      routes: { 'GET /v1/shops.json': SHOPS },
    });
    expect(expectToolData(await call('list_shops'))).toEqual({
      shops: SHOPS,
      default_shop_id: 9876,
    });
    api.expectRequest('GET', '/v1/shops.json');
  });

  it('makes the only shop the default', async () => {
    const { call } = await createTestServer({ routes: { 'GET /v1/shops.json': [SHOP] } });
    expect(expectToolData(await call('list_shops'))).toEqual({
      shops: [SHOP],
      default_shop_id: SHOP.id,
    });
  });

  it('leaves out default_shop_id with several shops and no PRINTIFY_SHOP_ID', async () => {
    const { call } = await createTestServer({ routes: { 'GET /v1/shops.json': SHOPS } });
    expect(expectToolData(await call('list_shops'))).toEqual({ shops: SHOPS });
  });

  it('fetches on every call and refreshes the cache that shop-scoped tools use', async () => {
    const { call, api } = await createTestServer({
      tools: [...ALL_TOOLS, getShopId],
      routes: { 'GET /v1/shops.json': inTurn(SHOPS, [DISCONNECTED_SHOP]) },
    });
    await call('list_shops');
    expect(expectToolData(await call('list_shops'))).toEqual({
      shops: [DISCONNECTED_SHOP],
      default_shop_id: DISCONNECTED_SHOP.id,
    });
    expect(expectToolData(await call('get_shop_id'))).toEqual({ shop_id: DISCONNECTED_SHOP.id });
    expect(api.requests).toHaveLength(2);
  });
});

describe('disconnect_shop', () => {
  it('is turned off without PRINTIFY_ENABLE_DESTRUCTIVE, and the instructions say so', async () => {
    const { mcp, selection } = await createTestServer();
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('list_shops');
    expect(names).not.toContain('disconnect_shop');
    expect(selection.skipped.map(({ tool, reason }) => [tool.name, reason])).toContainEqual([
      'disconnect_shop',
      'destructive',
    ]);
    expect(mcp.getInstructions()).toMatch(
      /Irreversible tools \(.*disconnect_shop.*\): set PRINTIFY_ENABLE_DESTRUCTIVE=true\./,
    );
  });

  it('is listed with PRINTIFY_ENABLE_DESTRUCTIVE, after the read-only list_shops', async () => {
    const { mcp } = await createTestServer({ env: DESTRUCTIVE_ON });
    const { tools } = await mcp.listTools();
    const shopTools = tools.filter(({ name }) => ['list_shops', 'disconnect_shop'].includes(name));
    expect(shopTools).toMatchObject([
      {
        name: 'list_shops',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'disconnect_shop',
        inputSchema: { required: ['shop_id'], additionalProperties: false },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ]);
  });

  it('sends DELETE to the shop connection and reports the shop as disconnected', async () => {
    const { call, api } = await createTestServer({
      env: DESTRUCTIVE_ON,
      routes: { [DISCONNECT_ROUTE]: {} },
    });
    expect(
      expectToolData(await call('disconnect_shop', { shop_id: DISCONNECTED_SHOP.id })),
    ).toEqual({ shop_id: DISCONNECTED_SHOP.id, disconnected: true });
    api.expectRequest('DELETE', DISCONNECT_PATH);
    expect(api.requests).toHaveLength(1);
  });

  it('needs shop_id even with PRINTIFY_SHOP_ID set, and sends nothing without it', async () => {
    const { call, api } = await createTestServer({
      env: { ...DESTRUCTIVE_ON, PRINTIFY_SHOP_ID: String(DISCONNECTED_SHOP.id) },
    });
    expectToolError(await call('disconnect_shop'), { kind: 'validation' });
    expect(api.requests).toEqual([]);
  });

  it.each([
    ['succeeds', {}],
    ['fails', json(notFoundBody(), 404)],
  ])('drops the shop cache when the disconnect %s', async (outcome, reply) => {
    const { call, api } = await createTestServer({
      tools: [...ALL_TOOLS, getShopId],
      env: DESTRUCTIVE_ON,
      routes: { 'GET /v1/shops.json': inTurn(SHOPS, [SHOP]), [DISCONNECT_ROUTE]: reply },
    });
    expectToolError(await call('get_shop_id'), { kind: 'tool' });
    const result = await call('disconnect_shop', { shop_id: DISCONNECTED_SHOP.id });
    expect(result.isError ?? false).toBe(outcome === 'fails');
    expect(expectToolData(await call('get_shop_id'))).toEqual({ shop_id: SHOP.id });
    expect(api.requests.map(({ method }) => method)).toEqual(['GET', 'DELETE', 'GET']);
  });
});
