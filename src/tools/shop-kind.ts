import type { Shop, ShopDirectory } from '../printify/shops.js';

/**
 * How a shop publishes. `api`: the user's own integration listens for `product:publish:started`
 * and reports back. `connected`: Printify publishes to the channel itself. `unknown`: the shop is
 * not in the account's list, or has no sales channel.
 */
export type ShopKind = 'api' | 'connected' | 'unknown';

// `disconnected` is documented as the value for a shop with no channel. `custom_integration` is
// what a custom integration built on the API is believed to report; the docs do not say.
const API_CHANNELS: ReadonlySet<string> = new Set(['disconnected', 'custom_integration']);

export function shopKind(shop: Shop | undefined): ShopKind {
  if (shop?.sales_channel === undefined) return 'unknown';
  return API_CHANNELS.has(shop.sales_channel) ? 'api' : 'connected';
}

const API_NEXT_STEP =
  'publish_product only locked the product and sent your integration the ' +
  'product:publish:started event. Create the listing in your sales channel, then call ' +
  'set_publishing_succeeded with its id and handle, or set_publishing_failed with the reason. ' +
  'The product stays locked, and update_product refuses it, until one of them is called.';

function connectedNextStep(channel: string): string {
  return (
    `Printify is publishing the product to ${channel}. It stays locked until the channel ` +
    'reports the result; then get_product shows is_locked false and the external id and handle.'
  );
}

/** What the assistant should do after `publish_product`, for the shop's kind. */
export function publishNextStep(kind: ShopKind, salesChannel: string | undefined): string {
  switch (kind) {
    case 'api':
      return API_NEXT_STEP;
    case 'connected':
      return connectedNextStep(salesChannel ?? 'the sales channel');
    case 'unknown':
      return (
        "This shop is not in the account's shop list, so its sales channel is unknown. If it " +
        `is an API shop: ${API_NEXT_STEP} Otherwise: ${connectedNextStep('the sales channel')}`
      );
  }
}

/**
 * The shop with `shopId` from the cached list, or after one refresh when the cache lacks it (an
 * explicit `shop_id` for a shop added since the list was cached). `undefined` when it is in
 * neither.
 */
export async function findShop(
  shops: ShopDirectory,
  shopId: number,
  signal: AbortSignal,
): Promise<Shop | undefined> {
  const cached = (await shops.list(signal)).find((shop) => shop.id === shopId);
  if (cached !== undefined) return cached;
  return (await shops.refresh(signal)).find((shop) => shop.id === shopId);
}
