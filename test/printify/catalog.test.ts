import { describe, expect, it, vi } from 'vitest';
import {
  createCatalog,
  STABLE_TTL_MS,
  VOLATILE_TTL_MS,
  type Catalog,
} from '../../src/printify/catalog.js';
import { createPrintifyClient } from '../../src/printify/client.js';
import { Secret } from '../../src/secret.js';
import {
  BLUEPRINT,
  BLUEPRINTS,
  BLUEPRINT_PROVIDERS,
  PRINT_PROVIDER,
  PRINT_PROVIDERS,
  SHIPPING,
  VARIANTS,
  VARIANTS_WITH_OUT_OF_STOCK,
} from '../fixtures/catalog.js';
import {
  ECONOMY_COSTS,
  methodList,
  shippingEntry,
  shippingResponse,
  SHIPPING_METHOD_LIST,
} from '../fixtures/catalog-shipping.js';
import { notFoundBody } from '../fixtures/errors.js';
import {
  createFakeApi,
  inTurn,
  json,
  never,
  type FakeApi,
  type Routes,
} from '../support/fake-api.js';
import { apiError } from './helpers.js';

const TOKEN = 'Tok-catalog-7H6g5F4e';
const VARIANTS_PATH = '/v1/catalog/blueprints/3/print_providers/29/variants.json';
const SHIPPING_PATH = '/v1/catalog/blueprints/3/print_providers/29/shipping.json';
const V2_METHODS_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping.json';
const V2_ECONOMY_PATH = '/v2/catalog/blueprints/3/print_providers/29/shipping/economy.json';

/** A catalog over a real client and a fake API, with a clock the test moves. */
function testCatalog(routes: Routes = {}): {
  catalog: Catalog;
  api: FakeApi;
  tick: (ms: number) => void;
} {
  const api = createFakeApi(routes);
  const client = createPrintifyClient({
    token: new Secret(TOKEN),
    baseUrl: 'https://api.printify.com',
    fetch: api.fetch,
  });
  let time = 0;
  return {
    catalog: createCatalog(client, { now: () => time }),
    api,
    tick(ms) {
      time += ms;
    },
  };
}

const signal = () => new AbortController().signal;

describe('createCatalog', () => {
  it('reads every documented path', async () => {
    const { catalog, api } = testCatalog({
      'GET /v1/catalog/blueprints.json': BLUEPRINTS,
      'GET /v1/catalog/blueprints/3.json': BLUEPRINT,
      'GET /v1/catalog/blueprints/3/print_providers.json': BLUEPRINT_PROVIDERS,
      'GET /v1/catalog/print_providers.json': PRINT_PROVIDERS,
      'GET /v1/catalog/print_providers/3.json': PRINT_PROVIDER,
      [`GET ${VARIANTS_PATH}`]: VARIANTS,
      [`GET ${SHIPPING_PATH}`]: SHIPPING,
    });

    expect(await catalog.allBlueprints(signal())).toHaveLength(2);
    expect((await catalog.blueprint(3, signal())).tags).toEqual(['Early Access']);
    expect(await catalog.blueprintProviders(3, signal())).toHaveLength(2);
    expect(await catalog.printProviders(signal())).toHaveLength(2);
    expect((await catalog.printProvider(3, signal())).blueprints).toHaveLength(2);
    expect(
      (await catalog.variants(3, 29, { showOutOfStock: false }, signal())).variants,
    ).toHaveLength(3);
    expect((await catalog.shipping(3, 29, signal())).profiles).toHaveLength(2);

    // The v1 shipping path includes the print provider id; openapi.json drops it.
    api.expectRequest('GET', SHIPPING_PATH);
    expect(api.requests).toHaveLength(7);
  });

  it('sends the caller signal with the request', async () => {
    const { catalog, api } = testCatalog({
      'GET /v1/catalog/print_providers.json': PRINT_PROVIDERS,
    });
    const controller = new AbortController();

    await catalog.printProviders(controller.signal);

    const sent = api.expectRequest('GET', '/v1/catalog/print_providers.json');
    expect(sent.signal.aborted).toBe(false);
    controller.abort();
    expect(sent.signal.aborted).toBe(true);
  });

  it('asks for out-of-stock variants only when told to', async () => {
    const { catalog, api } = testCatalog({
      [`GET ${VARIANTS_PATH}`]: (request) =>
        request.query['show-out-of-stock'] === '1' ? VARIANTS_WITH_OUT_OF_STOCK : VARIANTS,
    });

    const inStock = await catalog.variants(3, 29, { showOutOfStock: false }, signal());
    const all = await catalog.variants(3, 29, { showOutOfStock: true }, signal());

    expect(inStock.variants).toHaveLength(3);
    expect(all.variants).toHaveLength(4);
    expect(api.requests.map((sent) => sent.query)).toEqual([{}, { 'show-out-of-stock': '1' }]);
  });

  it('answers a second call from the cache', async () => {
    const { catalog, api } = testCatalog({ 'GET /v1/catalog/blueprints/3.json': BLUEPRINT });

    const first = await catalog.blueprint(3, signal());
    const second = await catalog.blueprint(3, signal());

    expect(second).toBe(first);
    api.expectRequest('GET', '/v1/catalog/blueprints/3.json');
  });

  it('fetches again once the blueprint entry is 24 h old', async () => {
    const { catalog, api, tick } = testCatalog({ 'GET /v1/catalog/blueprints/3.json': BLUEPRINT });

    await catalog.blueprint(3, signal());
    tick(STABLE_TTL_MS - 1);
    await catalog.blueprint(3, signal());
    expect(api.requests).toHaveLength(1);

    tick(1);
    await catalog.blueprint(3, signal());
    expect(api.requests).toHaveLength(2);
  });

  it('fetches again once the variants entry is 1 h old', async () => {
    const { catalog, api, tick } = testCatalog({ [`GET ${VARIANTS_PATH}`]: VARIANTS });

    await catalog.variants(3, 29, { showOutOfStock: false }, signal());
    tick(VOLATILE_TTL_MS);
    await catalog.variants(3, 29, { showOutOfStock: false }, signal());

    expect(api.requests).toHaveLength(2);
  });

  it('caches each blueprint and each stock setting separately', async () => {
    const { catalog, api } = testCatalog({
      'GET /v1/catalog/blueprints/3.json': BLUEPRINT,
      'GET /v1/catalog/blueprints/5.json': { ...BLUEPRINT, id: 5 },
      [`GET ${VARIANTS_PATH}`]: (request) =>
        request.query['show-out-of-stock'] === '1' ? VARIANTS_WITH_OUT_OF_STOCK : VARIANTS,
    });

    await catalog.blueprint(3, signal());
    await catalog.blueprint(5, signal());
    await catalog.variants(3, 29, { showOutOfStock: false }, signal());
    await catalog.variants(3, 29, { showOutOfStock: true }, signal());

    expect(api.requests).toHaveLength(4);
  });

  it('does not cache a failed request', async () => {
    const { catalog, api } = testCatalog({
      'GET /v1/catalog/blueprints/3.json': json(notFoundBody(), 404),
    });

    const error = await apiError(catalog.blueprint(3, signal()));
    expect(error.status).toBe(404);

    await apiError(catalog.blueprint(3, signal()));
    expect(api.requests).toHaveLength(2);
  });

  it('does not cache an aborted request', async () => {
    const { catalog, api } = testCatalog({
      // The first call hangs until aborted; the second answers normally.
      'GET /v1/catalog/blueprints/3.json': inTurn(never(), BLUEPRINT),
    });
    const controller = new AbortController();

    const pending = catalog.blueprint(3, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);

    // If the aborted attempt had cached anything, this would resolve from the cache instead of
    // reaching the API, and the request count below would stay at 1.
    await expect(catalog.blueprint(3, signal())).resolves.toEqual(BLUEPRINT);

    expect(api.requests).toHaveLength(2);
  });

  it('rejects a response that does not parse, and does not cache it', async () => {
    const { catalog, api } = testCatalog({ 'GET /v1/catalog/blueprints/3.json': { id: 'three' } });

    const error = await apiError(catalog.blueprint(3, signal()));
    expect(error.kind).toBe('invalid_response');
    expect(error.message).toContain('an unexpected catalog response');

    await apiError(catalog.blueprint(3, signal()));
    expect(api.requests).toHaveLength(2);
  });

  it('drops a field of the wrong type instead of failing the response', async () => {
    const { catalog } = testCatalog({
      'GET /v1/catalog/blueprints/3.json': { ...BLUEPRINT, title: 42, images: 'not an array' },
    });

    const parsed = await catalog.blueprint(3, signal());

    expect(parsed.title).toBeUndefined();
    expect(parsed.images).toBeUndefined();
    expect(parsed.brand).toBe('Delta');
  });

  it('fails a variant whose options are not strings', async () => {
    const { catalog } = testCatalog({
      [`GET ${VARIANTS_PATH}`]: {
        ...VARIANTS,
        variants: [{ ...VARIANTS.variants[0], options: { color: 7 } }],
      },
    });

    const error = await apiError(catalog.variants(3, 29, { showOutOfStock: false }, signal()));
    expect(error.kind).toBe('invalid_response');
  });
});

describe('createCatalog: v2 shipping methods', () => {
  it('reads the documented v2 path and returns the names in order', async () => {
    const { catalog, api } = testCatalog({ [`GET ${V2_METHODS_PATH}`]: SHIPPING_METHOD_LIST });

    const methods = await catalog.shippingMethods(3, 29, signal());

    expect(methods).toEqual(['standard', 'priority', 'express', 'economy']);
    api.expectRequest('GET', V2_METHODS_PATH);
  });

  it('passes an undocumented method name through', async () => {
    const { catalog } = testCatalog({
      [`GET ${V2_METHODS_PATH}`]: methodList(['standard', 'sea_freight']),
    });

    expect(await catalog.shippingMethods(3, 29, signal())).toEqual(['standard', 'sea_freight']);
  });

  it('caches the method list for an hour', async () => {
    const { catalog, api, tick } = testCatalog({
      [`GET ${V2_METHODS_PATH}`]: SHIPPING_METHOD_LIST,
    });

    await catalog.shippingMethods(3, 29, signal());
    tick(VOLATILE_TTL_MS - 1);
    await catalog.shippingMethods(3, 29, signal());
    expect(api.requests).toHaveLength(1);

    tick(1);
    await catalog.shippingMethods(3, 29, signal());
    expect(api.requests).toHaveLength(2);
  });

  it('sends the caller signal', async () => {
    const { catalog, api } = testCatalog({ [`GET ${V2_METHODS_PATH}`]: SHIPPING_METHOD_LIST });
    const controller = new AbortController();

    await catalog.shippingMethods(3, 29, controller.signal);

    const sent = api.expectRequest('GET', V2_METHODS_PATH);
    expect(sent.signal.aborted).toBe(false);
    controller.abort();
    expect(sent.signal.aborted).toBe(true);
  });

  it('fails a method entry with no name', async () => {
    const { catalog } = testCatalog({
      [`GET ${V2_METHODS_PATH}`]: { data: [{ type: 'shipping_method', id: '1', attributes: {} }] },
    });

    const error = await apiError(catalog.shippingMethods(3, 29, signal()));
    expect(error.kind).toBe('invalid_response');
  });
});

describe('createCatalog: v2 shipping costs', () => {
  it('flattens the documented response into rows', async () => {
    const { catalog, api } = testCatalog({ [`GET ${V2_ECONOMY_PATH}`]: ECONOMY_COSTS });

    const rows = await catalog.shippingCosts(3, 29, 'economy', signal());

    expect(rows).toHaveLength(9);
    expect(rows[0]).toEqual({
      variant_id: 23494,
      country: 'US',
      first_item: { cost: 399, currency: 'USD' },
      additional_items: { cost: 219, currency: 'USD' },
      handling_days: { from: 4, to: 8 },
    });
    api.expectRequest('GET', V2_ECONOMY_PATH);
  });

  it('keeps nothing Printify sends that a tool has no use for', async () => {
    const { catalog } = testCatalog({ [`GET ${V2_ECONOMY_PATH}`]: ECONOMY_COSTS });

    const rows = await catalog.shippingCosts(3, 29, 'economy', signal());

    expect(JSON.stringify(rows)).not.toContain('shippingPlanId');
    expect(JSON.stringify(rows)).not.toContain('shippingType');
    expect(JSON.stringify(rows)).not.toContain('variant_shipping');
  });

  it('caches each method separately, for an hour', async () => {
    const { catalog, api, tick } = testCatalog({
      [`GET ${V2_ECONOMY_PATH}`]: ECONOMY_COSTS,
      'GET /v2/catalog/blueprints/3/print_providers/29/shipping/standard.json': ECONOMY_COSTS,
    });

    await catalog.shippingCosts(3, 29, 'economy', signal());
    await catalog.shippingCosts(3, 29, 'economy', signal());
    await catalog.shippingCosts(3, 29, 'standard', signal());
    expect(api.requests).toHaveLength(2);

    tick(VOLATILE_TTL_MS);
    await catalog.shippingCosts(3, 29, 'economy', signal());
    expect(api.requests).toHaveLength(3);
  });

  it('turns a missing handling time into undefined without failing the response', async () => {
    const { catalog } = testCatalog({
      [`GET ${V2_ECONOMY_PATH}`]: shippingResponse([shippingEntry({ handlingTime: null })]),
    });

    const rows = await catalog.shippingCosts(3, 29, 'economy', signal());

    expect(rows[0]?.handling_days).toBeUndefined();
    expect(rows[0]?.first_item).toEqual({ cost: 399, currency: 'USD' });
  });

  it('fails a row with no variant id, and does not cache it', async () => {
    const entry = shippingEntry();
    const broken = { ...entry, attributes: { ...entry.attributes, variantId: 'twenty' } };
    const { catalog, api } = testCatalog({ [`GET ${V2_ECONOMY_PATH}`]: { data: [broken] } });

    const error = await apiError(catalog.shippingCosts(3, 29, 'economy', signal()));
    expect(error.kind).toBe('invalid_response');
    expect(error.message).toContain('an unexpected catalog response');

    await apiError(catalog.shippingCosts(3, 29, 'economy', signal()));
    expect(api.requests).toHaveLength(2);
  });

  it('fails a row with no cost', async () => {
    const entry = shippingEntry();
    const broken = {
      ...entry,
      attributes: { ...entry.attributes, shippingCost: { firstItem: { currency: 'USD' } } },
    };
    const { catalog } = testCatalog({ [`GET ${V2_ECONOMY_PATH}`]: { data: [broken] } });

    const error = await apiError(catalog.shippingCosts(3, 29, 'economy', signal()));
    expect(error.kind).toBe('invalid_response');
  });

  it('sends the caller signal, and caches nothing when the call is aborted', async () => {
    const { catalog, api } = testCatalog({
      // The first call hangs until aborted; the second answers normally.
      [`GET ${V2_ECONOMY_PATH}`]: inTurn(never(), ECONOMY_COSTS),
    });
    const controller = new AbortController();

    const pending = catalog.shippingCosts(3, 29, 'economy', controller.signal);
    // The request reaches the fake API only after the rate limiter's own await, same as the
    // cancellation tests in shop-id.test.ts and harness.test.ts.
    await vi.waitUntil(() => api.requests.length === 1);
    const sent = api.expectRequest('GET', V2_ECONOMY_PATH);
    expect(sent.signal.aborted).toBe(false);
    controller.abort();
    expect(sent.signal.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/abort/i);

    // Resolving from the cache here would leave the request count at 1.
    await catalog.shippingCosts(3, 29, 'economy', signal());
    expect(api.requests).toHaveLength(2);
  });

  it('returns no rows for a method the provider does not serve', async () => {
    const { catalog } = testCatalog({ [`GET ${V2_ECONOMY_PATH}`]: { data: [] } });

    expect(await catalog.shippingCosts(3, 29, 'economy', signal())).toEqual([]);
  });
});
