import { describe, expect, it } from 'vitest';
import { hintFor, scopeFor, type HintInput } from '../../src/printify/hints.js';
import type { HttpMethod } from '../../src/printify/types.js';

function http(status: number, code?: number, method: HttpMethod = 'GET', path = '/v1/shops.json') {
  return { kind: 'http', method, path, status, code } satisfies HintInput;
}

describe('hintFor', () => {
  it.each([
    [8203, 'The image resolution is too low'],
    [8201, 'it is too large or not a supported image format'],
    [10300, 'Printify could not download the image'],
    [8103, 'The shipping address failed validation'],
    [8503, 'An order with this `external_id` already exists'],
  ])('explains Printify code %i', (code, text) => {
    expect(hintFor(http(400, code))).toContain(text);
  });

  it.each([
    [409, 'An order with this `external_id` already exists'],
    [401, 'expired (Personal Access Tokens last one year)'],
    [404, 'Check the id, and that it belongs to this shop'],
    [429, 'rate limit was reached'],
    [500, 'Printify had a server error'],
    [502, 'Printify had a server error'],
    [599, 'Printify had a server error'],
  ])('explains HTTP %i', (status, text) => {
    expect(hintFor(http(status))).toContain(text);
  });

  it('prefers the code hint over the status hint', () => {
    expect(hintFor(http(409, 8503))).toBe(hintFor(http(400, 8503)));
    expect(hintFor(http(403, 8203))).toContain('The image resolution is too low');
  });

  it('names the probable scope on a 403', () => {
    const hint = hintFor(http(403, undefined, 'POST', '/v1/shops/12/products.json'));
    expect(hint).toBe(
      'Printify denied access. The token probably lacks the `products.write` scope; the user can ' +
        "create a new token that includes it. Printify's message may name another reason.",
    );
  });

  it('names no scope on a 403 for an unknown path, or with an unknown code', () => {
    const forbidden =
      'Printify denied access. The token may lack a scope this endpoint needs, or the feature is ' +
      'not enabled for this shop.';
    expect(hintFor(http(403, undefined, 'DELETE', '/v1/shops/12/connection.json'))).toBe(forbidden);
    expect(hintFor(http(403, 1234, 'DELETE', '/v1/shops/12/connection.json'))).toBe(forbidden);
  });

  it('gives no hint for other statuses and unknown codes', () => {
    expect(hintFor(http(400))).toBeUndefined();
    expect(hintFor(http(422, 1234))).toBeUndefined();
  });

  it.each([
    ['timeout', 'Printify did not answer in time. Try again in a moment.'],
    ['network', 'Printify could not be reached. Check the network connection and try again.'],
  ] as const)('explains a %s, with a warning for requests that change something', (kind, text) => {
    const base = { kind, path: '/v1/shops.json', status: undefined, code: undefined };
    expect(hintFor({ ...base, method: 'GET' })).toBe(text);
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      expect(hintFor({ ...base, method })).toBe(
        `${text} The request may still have gone through, so check before retrying.`,
      );
    }
  });

  it('gives no hint for an invalid response', () => {
    const error = { kind: 'invalid_response', method: 'GET', path: '/v1/shops.json' } as const;
    expect(hintFor({ ...error, status: 200, code: undefined })).toBeUndefined();
  });
});

describe('scopeFor', () => {
  it.each([
    ['GET', '/v1/shops.json', 'shops.read'],
    ['GET', '/v1/catalog/blueprints.json', 'catalog.read'],
    ['GET', '/v2/catalog/blueprints/6/print_providers/99/shipping/express.json', 'catalog.read'],
    ['GET', '/v1/shops/12/products.json', 'products.read'],
    ['PUT', '/v1/shops/12/products/abc.json', 'products.write'],
    ['POST', '/v1/shops/12/products/abc/publish.json', 'products.write'],
    ['GET', '/v1/shops/12/orders/abc.json', 'orders.read'],
    ['POST', '/v1/shops/12/orders/express.json', 'orders.write'],
    ['GET', '/v1/uploads.json', 'uploads.read'],
    ['POST', '/v1/uploads/images.json', 'uploads.write'],
    ['GET', '/v1/shops/12/webhooks.json', 'webhooks.read'],
    ['DELETE', '/v1/shops/12/webhooks/abc.json', 'webhooks.write'],
  ] as const)('%s %s needs %s', (method, path, scope) => {
    expect(scopeFor(method, path)).toBe(scope);
  });

  it.each([
    ['DELETE', '/v1/shops/12/connection.json'],
    ['POST', '/v1/catalog/blueprints.json'],
    ['GET', '/v1/shops/12/productsx.json'],
    ['GET', '/v1/something-new.json'],
  ] as const)('%s %s has no known scope', (method, path) => {
    expect(scopeFor(method, path)).toBeUndefined();
  });
});
