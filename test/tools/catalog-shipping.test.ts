import { describe, expect, it } from 'vitest';
import { methodList, SHIPPING_METHOD_LIST } from '../fixtures/catalog-shipping.js';
import { expectToolData } from '../support/expect.js';
import { createTestServer } from '../support/harness.js';

const METHODS_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping.json';

const IDS = { blueprint_id: 3, print_provider_id: 29 };

describe('list_shipping_methods', () => {
  it('lists the methods the provider offers', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${METHODS_PATH}`]: SHIPPING_METHOD_LIST },
    });

    const result = await call('list_shipping_methods', IDS);

    expect(expectToolData(result)).toEqual({
      blueprint_id: 3,
      print_provider_id: 29,
      methods: ['standard', 'priority', 'express', 'economy'],
    });
    api.expectRequest('GET', METHODS_PATH);
  });

  it('lists only what this provider offers, including a name Printify added later', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${METHODS_PATH}`]: methodList(['standard', 'sea_freight']) },
    });

    const result = await call('list_shipping_methods', IDS);

    // Dropping an unknown name here would hide a real shipping option from the user.
    expect(expectToolData(result).methods).toEqual(['standard', 'sea_freight']);
  });

  it('answers a second call from the cache', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${METHODS_PATH}`]: SHIPPING_METHOD_LIST },
    });

    await call('list_shipping_methods', IDS);
    await call('list_shipping_methods', IDS);

    api.expectRequest('GET', METHODS_PATH);
  });

  it('is listed as a read-only tool', async () => {
    const { mcp } = await createTestServer();

    const { tools } = await mcp.listTools();
    const listed = tools.find((tool) => tool.name === 'list_shipping_methods');

    expect(listed?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
});
