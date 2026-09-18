import { describe, expect, it, vi } from 'vitest';
import type { PrintifyClient } from '../../src/printify/client.js';
import { PrintifyApiError } from '../../src/printify/errors.js';
import { PAGE_LIMITS, fetchPage } from '../../src/printify/pagination.js';
import { apiPath } from '../../src/printify/path.js';

const PRODUCTS = apiPath`/v1/shops/${12}/products.json`;
const ORDERS = apiPath`/v1/shops/${12}/orders.json`;
const UPLOADS = apiPath`/v1/uploads.json`;

// Shape of the documented GET /v1/shops/{shop_id}/products.json?page=2 example (one item).
const PRODUCTS_PAGE = {
  current_page: 2,
  data: [{ id: '5d39b411749d0a000f30e0f4', title: 'Cotton T-shirt' }],
  first_page_url: '/?page=1',
  from: 2,
  last_page: 22,
  last_page_url: '/?page=22',
  next_page_url: '/?page=3',
  path: '/',
  per_page: 1,
  prev_page_url: '/?page=1',
  to: 2,
  total: 22,
};

// Documented GET /v1/uploads.json example, shortened to one item.
const UPLOADS_PAGE = {
  current_page: 1,
  data: [{ id: '5e16d66791287a0006e522b2', file_name: 'png-images-logo-1.jpg' }],
  first_page_url: '/?page=1',
  from: 1,
  last_page: 1,
  last_page_url: '/?page=1',
  next_page_url: null,
  path: '/',
  per_page: 10,
  prev_page_url: null,
  to: 1,
  total: 1,
};

/** A client whose `request` resolves to `body` and records its arguments. */
function clientReturning(body: unknown) {
  const request = vi.fn<PrintifyClient['request']>(() => Promise.resolve(body));
  return { client: { request } satisfies PrintifyClient, request };
}

describe('fetchPage', () => {
  it('reads the documented products envelope', async () => {
    const { client, request } = clientReturning(PRODUCTS_PAGE);
    await expect(fetchPage(client, 'products', PRODUCTS, { page: 2, limit: 1 })).resolves.toEqual({
      items: PRODUCTS_PAGE.data,
      page: 2,
      lastPage: 22,
      total: 22,
      hasMore: true,
    });
    expect(request).toHaveBeenCalledWith('GET', '/v1/shops/12/products.json', {
      query: { page: 2, limit: 1 },
      signal: undefined,
    });
  });

  it('reads the documented uploads envelope', async () => {
    const { client } = clientReturning(UPLOADS_PAGE);
    await expect(fetchPage(client, 'uploads', UPLOADS)).resolves.toEqual({
      items: UPLOADS_PAGE.data,
      page: 1,
      lastPage: 1,
      total: 1,
      hasMore: false,
    });
  });

  it('works with the documented orders shape of only current_page and data', async () => {
    const tenOrders = Array.from({ length: 10 }, (_, index) => ({ id: `order-${String(index)}` }));
    const full = clientReturning({ current_page: 1, data: tenOrders });
    await expect(fetchPage(full.client, 'orders', ORDERS)).resolves.toEqual({
      items: tenOrders,
      page: 1,
      lastPage: undefined,
      total: undefined,
      hasMore: true,
    });
    const partial = clientReturning({ current_page: 2, data: tenOrders.slice(0, 3) });
    const page = await fetchPage(partial.client, 'orders', ORDERS, { page: 2 });
    expect(page.hasMore).toBe(false);
  });

  it('decides hasMore by last_page, then next_page_url, then the item count', async () => {
    const lastPageWins = clientReturning({
      current_page: 3,
      last_page: 3,
      next_page_url: '/?p=4',
      data: [],
    });
    expect((await fetchPage(lastPageWins.client, 'products', PRODUCTS)).hasMore).toBe(false);
    const nextUrlWins = clientReturning({ current_page: 1, next_page_url: '/?page=2', data: [] });
    expect((await fetchPage(nextUrlWins.client, 'products', PRODUCTS)).hasMore).toBe(true);
    const noNextPage = clientReturning({ current_page: 1, next_page_url: null, data: [{}, {}] });
    expect((await fetchPage(noNextPage.client, 'products', PRODUCTS, { limit: 2 })).hasMore).toBe(
      false,
    );
    const byCount = clientReturning({ current_page: 1, data: [{}, {}] });
    expect((await fetchPage(byCount.client, 'products', PRODUCTS, { limit: 2 })).hasMore).toBe(
      true,
    );
  });

  it.each([
    ['products', 51, 50],
    ['orders', 100, 10],
    ['uploads', 101, 100],
  ] as const)('lowers a %s limit of %i to %i', async (resource, limit, sent) => {
    expect(PAGE_LIMITS[resource]).toBe(sent);
    const { client, request } = clientReturning({ current_page: 1, data: [] });
    await fetchPage(client, resource, PRODUCTS, { limit });
    expect(request.mock.calls[0]?.[2]?.query).toEqual({ page: undefined, limit: sent });
  });

  it('merges page and limit over the query and passes the signal', async () => {
    const { client, request } = clientReturning({ current_page: 1, data: [] });
    const signal = new AbortController().signal;
    await fetchPage(client, 'orders', ORDERS, {
      page: 3,
      query: { status: 'on-hold', page: 9, limit: 9 },
      signal,
    });
    expect(request).toHaveBeenCalledWith('GET', '/v1/shops/12/orders.json', {
      query: { status: 'on-hold', page: 3, limit: undefined },
      signal,
    });
  });

  it.each([
    ['page', { page: 0 }],
    ['page', { page: 1.5 }],
    ['limit', { limit: 0 }],
    ['limit', { limit: Number.NaN }],
  ])('rejects an invalid %s before sending anything', async (name, options) => {
    const { client, request } = clientReturning({ current_page: 1, data: [] });
    await expect(fetchPage(client, 'products', PRODUCTS, options)).rejects.toThrow(
      new RangeError(
        `${name} must be an integer of at least 1, got ${String(Object.values(options)[0])}`,
      ),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['no data', { current_page: 1 }],
    ['data that is not an array', { current_page: 1, data: {} }],
    ['no current_page', { data: [] }],
    ['a plain array', []],
    ['an empty body', undefined],
  ])('rejects an envelope with %s', async (_, body) => {
    const { client } = clientReturning(body);
    const error = await fetchPage(client, 'products', PRODUCTS).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PrintifyApiError);
    expect(error).toMatchObject({ kind: 'invalid_response', status: 200 });
    expect((error as PrintifyApiError).message).toBe(
      'GET /v1/shops/12/products.json returned HTTP 200 with an unexpected pagination envelope',
    );
  });
});
