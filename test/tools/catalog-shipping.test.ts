import { describe, expect, it } from 'vitest';
import {
  ECONOMY_COSTS,
  methodList,
  SHIPPING_METHOD_LIST,
  shippingEntry,
  shippingResponse,
  STANDARD_COSTS,
} from '../fixtures/catalog-shipping.js';
import { notFoundBody } from '../fixtures/errors.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { json } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';

const METHODS_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping.json';
const ECONOMY_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping/economy.json';
const STANDARD_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping/standard.json';

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

  it('returns only the rates that name the country', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy', country: 'US' });

    expect(expectToolData(result)).toMatchObject({
      country: 'US',
      methods: [
        {
          method: 'economy',
          matched: 'country',
          profile_count: 2,
          profiles: [
            expect.objectContaining({ countries: ['US'], variant_ids: [23494, 23495] }),
            expect.objectContaining({ countries: ['US'], variant_ids: [23496] }),
          ],
        },
      ],
    });
  });

  it('falls back to the rest-of-the-world rate for a country with no rate of its own', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy', country: 'DE' });

    expect(expectToolData(result)).toMatchObject({
      country: 'DE',
      methods: [
        {
          matched: 'rest_of_the_world',
          profile_count: 1,
          profiles: [
            expect.objectContaining({
              countries: ['REST_OF_THE_WORLD'],
              first_item: { cost: 1100, currency: 'USD' },
            }),
          ],
        },
      ],
    });
  });

  it('trims and upper-cases the country', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy', country: ' us ' });

    expect(expectToolData(result)).toMatchObject({
      country: 'US',
      methods: [{ matched: 'country' }],
    });
  });

  it('accepts REST_OF_THE_WORLD as a country in its own right', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', {
      ...IDS,
      method: 'economy',
      country: 'rest_of_the_world',
    });

    expect(expectToolData(result)).toMatchObject({
      country: 'REST_OF_THE_WORLD',
      methods: [{ matched: 'country', profile_count: 1 }],
    });
  });

  it('says none when there is no rate for the country and no catch-all', async () => {
    const { call } = await createTestServer({
      routes: {
        [`GET ${ECONOMY_PATH}`]: shippingResponse([shippingEntry({ country: 'US' })]),
      },
    });

    const result = await call('get_shipping_costs', { ...IDS, method: 'economy', country: 'DE' });

    expect(expectToolData(result).methods).toEqual([
      { method: 'economy', matched: 'none', profile_count: 0, profiles: [] },
    ]);
  });

  it('rejects a country that is not a code, without sending a request', async () => {
    const { call, api } = await createTestServer();

    const result = await call('get_shipping_costs', {
      ...IDS,
      method: 'economy',
      country: 'Germany',
    });

    expectToolError(result, { kind: 'validation' });
    expect(api.requests).toEqual([]);
  });

  it('has no country or matched key when no country was asked for', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const data = expectToolData(await call('get_shipping_costs', { ...IDS, method: 'economy' }));

    expect(data).not.toHaveProperty('country');
    const methods = data.methods as { method: string }[];
    expect(methods).toHaveLength(1);
    expect(methods[0]).not.toHaveProperty('matched');
  });

  it('returns only the rates for the variants asked for', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', {
      ...IDS,
      method: 'economy',
      variant_ids: [23496],
    });

    expect(expectToolData(result).methods).toEqual([
      {
        method: 'economy',
        profile_count: 3,
        profiles: [
          expect.objectContaining({
            countries: ['US'],
            variant_ids: [23496],
            first_item: { cost: 599, currency: 'USD' },
          }),
          expect.objectContaining({
            countries: ['CA'],
            variant_ids: [23496],
            first_item: { cost: 399, currency: 'USD' },
          }),
          expect.objectContaining({
            countries: ['REST_OF_THE_WORLD'],
            variant_ids: [23496],
            first_item: { cost: 1100, currency: 'USD' },
          }),
        ],
      },
    ]);
  });

  it('merges countries that only differ over variants the filter dropped', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', {
      ...IDS,
      method: 'economy',
      variant_ids: [23494, 23495],
    });

    // Without 23496, the US and Canada rates become identical and collapse into one profile.
    expect(expectToolData(result).methods).toEqual([
      {
        method: 'economy',
        profile_count: 2,
        profiles: [
          expect.objectContaining({
            countries: ['US', 'CA'],
            variant_ids: [23494, 23495],
            variant_count: 2,
          }),
          expect.objectContaining({ countries: ['REST_OF_THE_WORLD'] }),
        ],
      },
    ]);
  });

  it('combines the country and variant filters', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', {
      ...IDS,
      method: 'economy',
      country: 'US',
      variant_ids: [23496],
    });

    expect(expectToolData(result).methods).toEqual([
      {
        method: 'economy',
        matched: 'country',
        profile_count: 1,
        profiles: [
          expect.objectContaining({
            countries: ['US'],
            variant_ids: [23496],
            first_item: { cost: 599, currency: 'USD' },
          }),
        ],
      },
    ]);
  });

  it('returns no profiles for variant ids the provider does not price', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    const result = await call('get_shipping_costs', {
      ...IDS,
      method: 'economy',
      variant_ids: [99999],
    });

    expect(expectToolData(result).methods).toEqual([
      { method: 'economy', profile_count: 0, profiles: [] },
    ]);
  });

  it('rejects an empty variant_ids array, without sending a request', async () => {
    const { call, api } = await createTestServer();

    const result = await call('get_shipping_costs', {
      ...IDS,
      method: 'economy',
      variant_ids: [],
    });

    expectToolError(result, { kind: 'validation' });
    expect(api.requests).toEqual([]);
  });

  it('compares every method the provider offers when none is named', async () => {
    const { call, api } = await createTestServer({
      routes: {
        [`GET ${METHODS_PATH}`]: methodList(['standard', 'economy']),
        [`GET ${STANDARD_PATH}`]: STANDARD_COSTS,
        [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS,
      },
    });

    const result = await call('get_shipping_costs', IDS);

    const data = expectToolData(result);
    expect((data.methods as { method: string }[]).map((entry) => entry.method)).toEqual([
      'standard',
      'economy',
    ]);
    expect(api.requests).toHaveLength(3);
  });

  it('resolves the country separately for each method', async () => {
    const { call } = await createTestServer({
      routes: {
        [`GET ${METHODS_PATH}`]: methodList(['standard', 'economy']),
        [`GET ${STANDARD_PATH}`]: STANDARD_COSTS,
        [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS,
      },
    });

    const result = await call('get_shipping_costs', { ...IDS, country: 'DE' });

    // Standard names Germany; economy does not, so only economy falls back.
    expect(expectToolData(result)).toMatchObject({
      country: 'DE',
      methods: [
        {
          method: 'standard',
          matched: 'country',
          profiles: [
            expect.objectContaining({
              countries: ['DE'],
              first_item: { cost: 499, currency: 'USD' },
            }),
          ],
        },
        {
          method: 'economy',
          matched: 'rest_of_the_world',
          profiles: [
            expect.objectContaining({
              countries: ['REST_OF_THE_WORLD'],
              first_item: { cost: 1100, currency: 'USD' },
            }),
          ],
        },
      ],
    });
  });

  it('does not request a method name it does not recognise', async () => {
    const { call, api } = await createTestServer({
      routes: {
        [`GET ${METHODS_PATH}`]: methodList(['standard', 'sea_freight']),
        [`GET ${STANDARD_PATH}`]: STANDARD_COSTS,
      },
    });

    const result = await call('get_shipping_costs', IDS);

    expect((expectToolData(result).methods as { method: string }[]).map((e) => e.method)).toEqual([
      'standard',
    ]);
    // Two requests, and the teardown check proves no request went to a sea_freight path.
    expect(api.requests).toHaveLength(2);
  });

  it('still sends one request when a method is named', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${ECONOMY_PATH}`]: ECONOMY_COSTS },
    });

    await call('get_shipping_costs', { ...IDS, method: 'economy' });

    expect(api.requests).toHaveLength(1);
  });

  it('fails the whole call when one method cannot be read', async () => {
    const { call } = await createTestServer({
      routes: {
        [`GET ${METHODS_PATH}`]: methodList(['standard', 'economy']),
        [`GET ${STANDARD_PATH}`]: STANDARD_COSTS,
        [`GET ${ECONOMY_PATH}`]: json(notFoundBody(), 404),
      },
    });

    const result = await call('get_shipping_costs', IDS);

    expectToolError(result, { kind: 'http', status: 404 });
  });
});

describe('the two shipping tools', () => {
  it('point at each other, so the model can choose between them', async () => {
    const { mcp } = await createTestServer();

    const { tools } = await mcp.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool.description ?? '']));

    expect(byName.get('get_shipping_info')).toContain('get_shipping_costs');
    expect(byName.get('get_shipping_costs')).toContain('get_shipping_info');
    expect(byName.get('list_shipping_methods')).toContain('get_shipping_costs');
    expect(byName.get('get_shipping_costs')).toContain('list_shipping_methods');
  });
});
