import { describe, expect, it } from 'vitest';
import { ECONOMY_COSTS, methodList, SHIPPING_METHOD_LIST } from '../fixtures/catalog-shipping.js';
import { notFoundBody } from '../fixtures/errors.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { json } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';

const METHODS_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping.json';
const ECONOMY_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping/economy.json';

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

describe('get_shipping_costs', () => {
  it('groups the rows of one method into profiles', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy' });

    expect(expectToolData(result)).toEqual({
      blueprint_id: 3,
      print_provider_id: 29,
      methods: [
        {
          method: 'economy',
          profile_count: 4,
          profiles: [
            {
              countries: ['US'],
              variant_ids: [23494, 23495],
              variant_count: 2,
              first_item: { cost: 399, currency: 'USD' },
              additional_items: { cost: 219, currency: 'USD' },
              handling_days: { from: 4, to: 8 },
            },
            {
              countries: ['US'],
              variant_ids: [23496],
              variant_count: 1,
              first_item: { cost: 599, currency: 'USD' },
              additional_items: { cost: 219, currency: 'USD' },
              handling_days: { from: 4, to: 8 },
            },
            {
              countries: ['CA'],
              variant_ids: [23494, 23495, 23496],
              variant_count: 3,
              first_item: { cost: 399, currency: 'USD' },
              additional_items: { cost: 219, currency: 'USD' },
              handling_days: { from: 4, to: 8 },
            },
            {
              countries: ['REST_OF_THE_WORLD'],
              variant_ids: [23494, 23495, 23496],
              variant_count: 3,
              first_item: { cost: 1100, currency: 'USD' },
              additional_items: { cost: 0, currency: 'USD' },
              handling_days: { from: 4, to: 8 },
            },
          ],
        },
      ],
    });
    api.expectRequest('GET', ECONOMY_PATH);
  });

  it('sends one request for one method and answers a second call from the cache', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    await call('get_shipping_costs', { ...IDS, method: 'economy' });
    await call('get_shipping_costs', { ...IDS, method: 'economy' });

    api.expectRequest('GET', ECONOMY_PATH);
  });

  it('returns no profiles for a method the provider does not serve', async () => {
    const { call } = await createTestServer({ routes: { [`GET ${ECONOMY_PATH}`]: { data: [] } } });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy' });

    expect(expectToolData(result).methods).toEqual([
      { method: 'economy', profile_count: 0, profiles: [] },
    ]);
  });

  it('reports an unknown blueprint as a 404', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: json(notFoundBody(), 404) },
    });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy' });

    expectToolError(result, { kind: 'http', status: 404 });
  });

  it('rejects a method Printify does not have', async () => {
    const { call, api } = await createTestServer();

    const result = await call('get_shipping_costs', { ...IDS, method: 'overnight' });

    expectToolError(result, { kind: 'validation' });
    expect(api.requests).toEqual([]);
  });

  it('leaks nothing Printify sends that the model has no use for', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy' });

    const text = JSON.stringify(expectToolData(result));
    expect(text).not.toContain('shipping_plan_id');
    expect(text).not.toContain('shippingPlanId');
    expect(text).not.toContain('shippingType');
    expect(text).not.toContain('variant_shipping');
  });

  it('is listed as a read-only tool', async () => {
    const { mcp } = await createTestServer();

    const { tools } = await mcp.listTools();
    const listed = tools.find((tool) => tool.name === 'get_shipping_costs');

    expect(listed?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  });
});
