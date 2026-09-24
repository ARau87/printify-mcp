import { z } from 'zod';
import type { PrintifyClient } from './client.js';
import { invalidResponseError } from './errors.js';
import { apiPath } from './path.js';

const SHOPS_PATH = apiPath`/v1/shops.json`;

// Lenient except for the id, so one odd shop cannot break shop resolution for all of them.
const shopSchema = z.object({
  id: z.number().int(),
  title: z.string().optional().catch(undefined),
  sales_channel: z.string().optional().catch(undefined),
});
const shopListSchema = z.array(shopSchema);

/** A shop as `GET /v1/shops.json` lists it. `sales_channel` is "disconnected" when none is. */
export type Shop = z.output<typeof shopSchema>;

export interface ShopDirectory {
  /** The account's shops: fetched on first use, then cached until `invalidate`. */
  list(signal: AbortSignal): Promise<readonly Shop[]>;
  /** Fetches the shops again and replaces the cache. */
  refresh(signal: AbortSignal): Promise<readonly Shop[]>;
  /** Drops the cache, e.g. after a shop is disconnected. */
  invalidate(): void;
}

/**
 * Creates the process's shop list cache. Only a successful fetch is cached. Concurrent misses
 * each send a request rather than share one, so one caller's abort cannot fail another's call.
 */
export function createShopDirectory(client: PrintifyClient): ShopDirectory {
  let cached: readonly Shop[] | undefined;
  // Bumped by invalidate, so a fetch that started before it cannot cache what it got.
  let generation = 0;

  async function fetchShops(signal: AbortSignal): Promise<readonly Shop[]> {
    const started = generation;
    const body = await client.request('GET', SHOPS_PATH, { signal });
    const parsed = shopListSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidResponseError(
        { method: 'GET', path: SHOPS_PATH },
        200,
        'an unexpected shop list',
      );
    }
    const shops = Object.freeze(parsed.data);
    if (generation === started) cached = shops;
    return shops;
  }

  return {
    list: (signal) => (cached === undefined ? fetchShops(signal) : Promise.resolve(cached)),
    refresh: fetchShops,
    invalidate: () => {
      cached = undefined;
      generation += 1;
    },
  };
}
