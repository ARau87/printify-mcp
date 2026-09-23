import { describe, expect, it } from 'vitest';
import { BLUEPRINT, BLUEPRINT_PROVIDERS, PRINT_PROVIDERS } from '../fixtures/catalog.js';
import { notFoundBody } from '../fixtures/errors.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { json } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';

const BLUEPRINT_PATH = '/v1/catalog/blueprints/3.json';
const BLUEPRINT_PROVIDERS_PATH = '/v1/catalog/blueprints/3/print_providers.json';
const PROVIDERS_PATH = '/v1/catalog/print_providers.json';

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
