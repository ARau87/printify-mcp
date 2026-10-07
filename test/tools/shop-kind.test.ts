import { describe, expect, it } from 'vitest';
import type { Shop, ShopDirectory } from '../../src/printify/shops.js';
import { findShop, publishNextStep, shopKind } from '../../src/tools/shop-kind.js';
import { CUSTOM_SHOP, DISCONNECTED_SHOP, SHOP, shop } from '../fixtures/shops.js';

/** A signal that has not aborted. */
function live(): AbortSignal {
  return new AbortController().signal;
}

/** A directory that answers `cached` from `list` and `fresh` from `refresh`, counting both. */
function stubDirectory(cached: readonly Shop[], fresh: readonly Shop[] = cached) {
  const calls = { list: 0, refresh: 0 };
  const directory: ShopDirectory = {
    list: () => {
      calls.list += 1;
      return Promise.resolve(cached);
    },
    refresh: () => {
      calls.refresh += 1;
      return Promise.resolve(fresh);
    },
    invalidate: () => undefined,
  };
  return { directory, calls };
}

describe('shopKind', () => {
  it('treats a disconnected shop and a custom integration as API shops', () => {
    expect(shopKind(DISCONNECTED_SHOP)).toBe('api');
    expect(shopKind(CUSTOM_SHOP)).toBe('api');
  });

  it('treats every other channel as connected', () => {
    expect(shopKind(SHOP)).toBe('connected');
    expect(shopKind(shop({ sales_channel: 'etsy' }))).toBe('connected');
  });

  it('is unknown without a shop or without a sales channel', () => {
    expect(shopKind(undefined)).toBe('unknown');
    expect(shopKind({ id: 1, title: 'No channel' })).toBe('unknown');
  });
});

describe('publishNextStep', () => {
  it('tells an API shop to report back with the notify tools', () => {
    const text = publishNextStep('api', 'disconnected');
    expect(text).toContain('product:publish:started');
    expect(text).toContain('set_publishing_succeeded');
    expect(text).toContain('set_publishing_failed');
    expect(text).toContain('update_product refuses it');
  });

  it('tells a connected shop to wait for the channel, by name', () => {
    const text = publishNextStep('connected', 'etsy');
    expect(text).toContain('publishing the product to etsy');
    expect(text).toContain('get_product');
    expect(text).not.toContain('set_publishing_succeeded');
  });

  it('covers both cases for an unknown shop', () => {
    const text = publishNextStep('unknown', undefined);
    expect(text).toContain('not in the account');
    expect(text).toContain('set_publishing_succeeded');
    expect(text).toContain('publishing the product to the sales channel');
  });
});

describe('findShop', () => {
  it('finds a cached shop without refreshing', async () => {
    const { directory, calls } = stubDirectory([SHOP, DISCONNECTED_SHOP]);
    expect(await findShop(directory, DISCONNECTED_SHOP.id, live())).toEqual(DISCONNECTED_SHOP);
    expect(calls).toEqual({ list: 1, refresh: 0 });
  });

  it('refreshes once when the cache lacks the shop', async () => {
    const { directory, calls } = stubDirectory([SHOP], [SHOP, CUSTOM_SHOP]);
    expect(await findShop(directory, CUSTOM_SHOP.id, live())).toEqual(CUSTOM_SHOP);
    expect(calls).toEqual({ list: 1, refresh: 1 });
  });

  it('gives up after one refresh', async () => {
    const { directory, calls } = stubDirectory([SHOP]);
    expect(await findShop(directory, 1111, live())).toBeUndefined();
    expect(calls).toEqual({ list: 1, refresh: 1 });
  });
});
