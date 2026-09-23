import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT,
  BLUEPRINT_PROVIDERS,
  PRINT_PROVIDER,
  PRINT_PROVIDERS,
  printProviderWith,
  SHIPPING,
  VARIANTS,
  VARIANTS_WITH_OUT_OF_STOCK,
} from '../fixtures/catalog.js';
import { notFoundBody } from '../fixtures/errors.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { json, type Routes } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';
import { PROVIDER_BLUEPRINT_LIMIT } from '../../src/tools/catalog.js';

const BLUEPRINT_PATH = '/v1/catalog/blueprints/3.json';
const BLUEPRINT_PROVIDERS_PATH = '/v1/catalog/blueprints/3/print_providers.json';
const PROVIDERS_PATH = '/v1/catalog/print_providers.json';
const PROVIDER_PATH = '/v1/catalog/print_providers/3.json';
const VARIANTS_PATH = '/v1/catalog/blueprints/3/print_providers/29/variants.json';
const SHIPPING_PATH = '/v1/catalog/blueprints/3/print_providers/29/shipping.json';

/** The variants route answers by query: a route key cannot carry one. */
const VARIANT_ROUTES: Routes = {
  [`GET ${VARIANTS_PATH}`]: (request) =>
    request.query['show-out-of-stock'] === '1' ? VARIANTS_WITH_OUT_OF_STOCK : VARIANTS,
};

describe('get_blueprint', () => {
  it('returns the blueprint without its images', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${BLUEPRINT_PATH}`]: BLUEPRINT },
    });

    const result = await call('get_blueprint', { blueprint_id: 3 });

    expect(expectToolData(result)).toEqual({
      id: 3,
      title: 'Kids Regular Fit Tee',
      description: 'Description goes here',
      brand: 'Delta',
      model: '11736',
      tags: ['Early Access'],
    });
    api.expectRequest('GET', BLUEPRINT_PATH);
  });

  it('returns the images when asked', async () => {
    const { call } = await createTestServer({ routes: { [`GET ${BLUEPRINT_PATH}`]: BLUEPRINT } });

    const result = await call('get_blueprint', { blueprint_id: 3, include_images: true });

    expect(expectToolData(result).images).toEqual(BLUEPRINT.images);
  });

  it('answers a second call from the cache', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${BLUEPRINT_PATH}`]: BLUEPRINT },
    });

    await call('get_blueprint', { blueprint_id: 3 });
    await call('get_blueprint', { blueprint_id: 3 });

    api.expectRequest('GET', BLUEPRINT_PATH);
  });

  it('reports an unknown blueprint as a 404', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${BLUEPRINT_PATH}`]: json(notFoundBody(), 404) },
    });

    const result = await call('get_blueprint', { blueprint_id: 3 });

    expectToolError(result, { kind: 'http', status: 404 });
  });
});

describe('list_blueprint_providers', () => {
  it('adds each provider location from the provider list', async () => {
    const { call, api } = await createTestServer({
      routes: {
        [`GET ${BLUEPRINT_PROVIDERS_PATH}`]: BLUEPRINT_PROVIDERS,
        [`GET ${PROVIDERS_PATH}`]: PRINT_PROVIDERS,
      },
    });

    const result = await call('list_blueprint_providers', { blueprint_id: 3 });

    expect(expectToolData(result)).toEqual({
      blueprint_id: 3,
      print_providers: [
        {
          id: 3,
          title: 'DJ',
          decoration_methods: ['dtg', 'embroidery'],
          location: { city: 'Brooklyn', region: 'NY', country: 'US' },
        },
        {
          id: 24,
          title: 'Inklocker',
          decoration_methods: ['dtf', 'dtg', 'embroidery'],
          location: { city: 'Charlotte', region: 'NY', country: 'US' },
        },
      ],
    });
    api.expectRequest('GET', BLUEPRINT_PROVIDERS_PATH);
    api.expectRequest('GET', PROVIDERS_PATH);
  });

  it('leaves out the location of a provider the list does not have', async () => {
    const { call } = await createTestServer({
      routes: {
        [`GET ${BLUEPRINT_PROVIDERS_PATH}`]: BLUEPRINT_PROVIDERS,
        [`GET ${PROVIDERS_PATH}`]: [PRINT_PROVIDERS[0]],
      },
    });

    const result = await call('list_blueprint_providers', { blueprint_id: 3 });

    const providers = expectToolData(result).print_providers as { location?: unknown }[];
    expect(providers[0]?.location).toEqual({ city: 'Brooklyn', region: 'NY', country: 'US' });
    expect(providers[1]).not.toHaveProperty('location');
  });

  it('fails rather than answer without locations when the directory request fails', async () => {
    // The location join is the point of this tool; swallowing a failed directory request would
    // silently return providers with no locations instead of failing like the client expects.
    const { call } = await createTestServer({
      routes: {
        [`GET ${BLUEPRINT_PROVIDERS_PATH}`]: BLUEPRINT_PROVIDERS,
        [`GET ${PROVIDERS_PATH}`]: json(notFoundBody(), 404),
      },
    });

    const result = await call('list_blueprint_providers', { blueprint_id: 3 });

    expectToolError(result, { kind: 'http', status: 404 });
  });
});

describe('list_print_providers', () => {
  it('lists every provider with a short location', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${PROVIDERS_PATH}`]: PRINT_PROVIDERS },
    });

    const result = await call('list_print_providers');

    expect(expectToolData(result)).toEqual({
      print_providers: [
        { id: 3, title: 'DJ', location: { city: 'Brooklyn', region: 'NY', country: 'US' } },
        {
          id: 24,
          title: 'Inklocker',
          location: { city: 'Charlotte', region: 'NY', country: 'US' },
        },
      ],
    });
  });
});

describe('list_variants', () => {
  it('lists the variants in stock, with their print positions', async () => {
    const { call, api } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', { blueprint_id: 3, print_provider_id: 29 });

    expect(expectToolData(result)).toEqual({
      print_provider: { id: 3, title: 'DJ' },
      total_variants: 3,
      variant_count: 3,
      option_values: { color: ['Heather Grey', 'Solid Black'], size: ['XS', 'S'] },
      variants: [
        {
          id: 17390,
          title: 'Heather Grey / XS',
          options: { color: 'Heather Grey', size: 'XS' },
          placeholders: [
            { position: 'back', decoration_method: 'dtf', height: 3995, width: 3153 },
            { position: 'front', decoration_method: 'embroidery', height: 3995, width: 3153 },
          ],
        },
        {
          id: 17391,
          title: 'Heather Grey / S',
          options: { color: 'Heather Grey', size: 'S' },
          placeholders: [
            { position: 'back', decoration_method: 'dtf', height: 3995, width: 3153 },
            { position: 'front', decoration_method: 'embroidery', height: 3995, width: 3153 },
          ],
        },
        {
          id: 17426,
          title: 'Solid Black / XS',
          options: { color: 'Solid Black', size: 'XS' },
          placeholders: [
            { position: 'back', decoration_method: 'dtf', height: 3995, width: 3153 },
            { position: 'front', decoration_method: 'embroidery', height: 3995, width: 3153 },
          ],
        },
      ],
    });
    expect(api.expectRequest('GET', VARIANTS_PATH).query).toEqual({});
  });

  it('filters by color, ignoring case and spaces', async () => {
    const { call } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      colors: ['  solid BLACK '],
    });

    const data = expectToolData(result);
    expect(data.variant_count).toBe(1);
    expect(data.total_variants).toBe(3);
    expect((data.variants as { id: number }[]).map((variant) => variant.id)).toEqual([17426]);
  });

  it('filters by size, and by color and size together', async () => {
    const { call } = await createTestServer({ routes: VARIANT_ROUTES });

    const bySize = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      sizes: ['xs'],
    });
    expect((expectToolData(bySize).variants as { id: number }[]).map((item) => item.id)).toEqual([
      17390, 17426,
    ]);

    const byBoth = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      colors: ['Heather Grey'],
      sizes: ['S'],
    });
    expect((expectToolData(byBoth).variants as { id: number }[]).map((item) => item.id)).toEqual([
      17391,
    ]);
  });

  it('keeps option_values when a filter matches nothing', async () => {
    const { call } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      colors: ['black'],
    });

    const data = expectToolData(result);
    expect(data.variant_count).toBe(0);
    expect(data.variants).toEqual([]);
    expect(data.option_values).toEqual({
      color: ['Heather Grey', 'Solid Black'],
      size: ['XS', 'S'],
    });
  });

  it('marks every variant in_stock when out-of-stock variants are included', async () => {
    const { call, api } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      show_out_of_stock: true,
    });

    const variants = expectToolData(result).variants as { id: number; in_stock: boolean }[];
    expect(variants.map((variant) => [variant.id, variant.in_stock])).toEqual([
      [17390, true],
      [17391, true],
      [17426, true],
      [17427, false],
    ]);
    expect(api.requests.map((sent) => sent.query)).toEqual([{ 'show-out-of-stock': '1' }, {}]);
  });

  it('says nothing about stock when the flag is off', async () => {
    const { call } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', { blueprint_id: 3, print_provider_id: 29 });

    expect(expectToolData(result).variants).not.toContainEqual(
      expect.objectContaining({ in_stock: expect.anything() as unknown }),
    );
  });

  it('rejects an empty colors list before any request', async () => {
    const { call, api } = await createTestServer({ routes: VARIANT_ROUTES });

    const result = await call('list_variants', {
      blueprint_id: 3,
      print_provider_id: 29,
      colors: [],
    });

    expectToolError(result, { kind: 'validation' });
    expect(api.requests).toEqual([]);
  });
});

describe('get_shipping_info', () => {
  it('returns the handling time and the profiles', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${SHIPPING_PATH}`]: SHIPPING },
    });

    const result = await call('get_shipping_info', { blueprint_id: 3, print_provider_id: 29 });

    expect(expectToolData(result)).toEqual(SHIPPING);
    // The v1 shipping path includes the print provider id.
    api.expectRequest('GET', SHIPPING_PATH);
  });
});

describe('get_print_provider', () => {
  it('returns the provider with its address and blueprints', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${PROVIDER_PATH}`]: PRINT_PROVIDER },
    });

    const result = await call('get_print_provider', { print_provider_id: 3 });

    expect(expectToolData(result)).toEqual({
      id: 3,
      title: 'DJ',
      location: {
        address1: '89 Weirfield St',
        city: 'Brooklyn',
        region: 'NY',
        country: 'US',
        zip: '11221-5120',
      },
      blueprint_count: 2,
      blueprints: [
        { id: 265, title: 'Slim Iphone 8', brand: 'Case Mate', model: 'Slim Iphone 8' },
        { id: 52, title: 'Slim Iphone 6/6s', brand: 'Case Mate', model: 'Slim Iphone 8' },
      ],
    });
  });

  it('truncates a long blueprint list and says so', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${PROVIDER_PATH}`]: printProviderWith(60) },
    });

    const result = await call('get_print_provider', { print_provider_id: 3 });

    const data = expectToolData(result);
    expect(data.blueprint_count).toBe(60);
    expect(data.blueprints).toHaveLength(PROVIDER_BLUEPRINT_LIMIT);
    expect(data.blueprints_truncated).toBe(true);
  });

  it('says nothing about truncation when everything fits', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${PROVIDER_PATH}`]: printProviderWith(PROVIDER_BLUEPRINT_LIMIT) },
    });

    const result = await call('get_print_provider', { print_provider_id: 3 });

    const data = expectToolData(result);
    expect(data.blueprints).toHaveLength(PROVIDER_BLUEPRINT_LIMIT);
    expect(data).not.toHaveProperty('blueprints_truncated');
  });
});

describe('the catalog toolset', () => {
  it('offers six read-only tools', async () => {
    const { mcp } = await createTestServer();

    const { tools } = await mcp.listTools();

    const catalog = tools.filter((tool) =>
      [
        'get_blueprint',
        'list_blueprint_providers',
        'list_variants',
        'get_shipping_info',
        'list_print_providers',
        'get_print_provider',
      ].includes(tool.name),
    );
    expect(catalog).toHaveLength(6);
    for (const tool of catalog) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });

  it('never sends image arrays unless they were asked for', async () => {
    const { call } = await createTestServer({
      routes: {
        [`GET ${BLUEPRINT_PATH}`]: BLUEPRINT,
        [`GET ${PROVIDER_PATH}`]: PRINT_PROVIDER,
        ...VARIANT_ROUTES,
      },
    });

    const results = [
      await call('get_blueprint', { blueprint_id: 3 }),
      await call('get_print_provider', { print_provider_id: 3 }),
      await call('list_variants', { blueprint_id: 3, print_provider_id: 29 }),
    ];

    for (const result of results) {
      expect(JSON.stringify(expectToolData(result))).not.toContain('images');
    }
  });
});
