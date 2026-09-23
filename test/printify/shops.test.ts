import { describe, expect, it, vi } from 'vitest';
import type { PrintifyClient } from '../../src/printify/client.js';
import { httpError } from '../../src/printify/errors.js';
import { createShopDirectory } from '../../src/printify/shops.js';
import { DISCONNECTED_SHOP, SHOP, SHOPS } from '../fixtures/shops.js';
import { apiError, rejection } from './helpers.js';

const signal = new AbortController().signal;

/** A client whose nth request resolves to the nth answer, or rejects with it if it is an Error. */
function clientAnswering(...answers: unknown[]) {
  const request = vi.fn<PrintifyClient['request']>(() => {
    const answer = answers.shift();
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  return { client: { request } satisfies PrintifyClient, request };
}

describe('createShopDirectory', () => {
  it('fetches the shops on the first list, with the caller signal', async () => {
    const { client, request } = clientAnswering(SHOPS);
    expect(await createShopDirectory(client).list(signal)).toEqual(SHOPS);
    expect(request).toHaveBeenCalledWith('GET', '/v1/shops.json', { signal });
  });

  it('answers a second list from the cache', async () => {
    const { client, request } = clientAnswering(SHOPS);
    const shops = createShopDirectory(client);
    await shops.list(signal);
    expect(await shops.list(signal)).toEqual(SHOPS);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fetches again on refresh and caches what it got', async () => {
    const { client, request } = clientAnswering(SHOPS, [SHOP]);
    const shops = createShopDirectory(client);
    await shops.list(signal);
    expect(await shops.refresh(signal)).toEqual([SHOP]);
    expect(await shops.list(signal)).toEqual([SHOP]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('fetches again after invalidate', async () => {
    const { client, request } = clientAnswering(SHOPS, [DISCONNECTED_SHOP]);
    const shops = createShopDirectory(client);
    await shops.list(signal);
    shops.invalidate();
    expect(await shops.list(signal)).toEqual([DISCONNECTED_SHOP]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed fetch', async () => {
    const error = httpError({ method: 'GET', path: '/v1/shops.json' }, 500, undefined, null);
    const { client, request } = clientAnswering(error, SHOPS);
    const shops = createShopDirectory(client);
    expect(await rejection(shops.list(signal))).toBe(error);
    expect(await shops.list(signal)).toEqual(SHOPS);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('returns, but does not cache, a list that arrives after invalidate', async () => {
    let release: (body: unknown) => void = () => undefined;
    const request = vi
      .fn<PrintifyClient['request']>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce([DISCONNECTED_SHOP]);
    const shops = createShopDirectory({ request });
    const pending = shops.list(signal);
    shops.invalidate();
    release(SHOPS);
    expect(await pending).toEqual(SHOPS);
    expect(await shops.list(signal)).toEqual([DISCONNECTED_SHOP]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['an object', { data: SHOPS }],
    ['an empty body', undefined],
    ['a shop without an id', [{ title: 'My new store' }]],
    ['a shop whose id is a string', [{ id: '5432', title: 'My new store' }]],
  ])('rejects %s as an invalid response', async (_, body) => {
    const { client } = clientAnswering(body);
    const error = await apiError(createShopDirectory(client).list(signal));
    expect(error).toMatchObject({ kind: 'invalid_response', status: 200 });
    expect(error.message).toBe('GET /v1/shops.json returned HTTP 200 with an unexpected shop list');
  });

  it('keeps a shop with an odd title or sales channel, and drops unknown keys', async () => {
    const { client } = clientAnswering([
      { id: 5432, title: null, sales_channel: 7, created_at: '2026-09-22' },
    ]);
    expect(await createShopDirectory(client).list(signal)).toEqual([{ id: 5432 }]);
  });
});
