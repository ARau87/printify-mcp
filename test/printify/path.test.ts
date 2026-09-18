import { describe, expect, it } from 'vitest';
import { apiPath } from '../../src/printify/path.js';

describe('apiPath', () => {
  it('inserts numbers and strings', () => {
    const shopId = 12;
    const productId = '5d39b411749d0a000f30e0f4';
    expect(apiPath`/v1/shops/${shopId}/products/${productId}.json`).toBe(
      '/v1/shops/12/products/5d39b411749d0a000f30e0f4.json',
    );
  });

  it('accepts a path without values and v2 paths', () => {
    expect(apiPath`/v1/shops.json`).toBe('/v1/shops.json');
    expect(apiPath`/v2/catalog/blueprints/${6}/print_providers/${99}/shipping.json`).toBe(
      '/v2/catalog/blueprints/6/print_providers/99/shipping.json',
    );
  });

  it('encodes characters that would change the route', () => {
    const productId = '../x/y?z=1#frag 100%';
    expect(apiPath`/v1/shops/12/products/${productId}.json`).toBe(
      '/v1/shops/12/products/..%2Fx%2Fy%3Fz%3D1%23frag%20100%25.json',
    );
  });

  it.each(['', '.', '..'])('rejects the value "%s"', (value) => {
    expect(() => apiPath`/v1/shops/${value}/products.json`).toThrow(
      new TypeError('API path values must not be empty, "." or ".."'),
    );
  });

  it.each([
    ['a relative path', () => apiPath`v1/shops.json`],
    ['an unknown version', () => apiPath`/v3/shops.json`],
    ['a leading value', () => apiPath`${'/v1'}/shops.json`],
  ])('rejects %s', (_, build) => {
    expect(build).toThrow(TypeError);
    expect(build).toThrow('API paths must start with /v1/ or /v2/');
  });
});
