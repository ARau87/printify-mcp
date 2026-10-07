/** The documented `GET /v1/shops.json` example. */
export const SHOP = { id: 5432, title: 'My new store', sales_channel: 'My Sales Channel' };

/** An API-only shop, which #7's default-shop resolution has to tell apart from a connected one. */
export const DISCONNECTED_SHOP = {
  id: 9876,
  title: 'My other new store',
  sales_channel: 'disconnected',
};

/** A shop whose own integration publishes, which #12 treats like a disconnected one. */
export const CUSTOM_SHOP = {
  id: 2468,
  title: 'My custom store',
  sales_channel: 'custom_integration',
};

export const SHOPS = [SHOP, DISCONNECTED_SHOP];

export function shop(overrides: Partial<typeof SHOP> = {}): typeof SHOP {
  return { ...SHOP, ...overrides };
}
