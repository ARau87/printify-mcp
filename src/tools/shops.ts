import { z } from 'zod';
import { apiPath } from '../printify/path.js';
import { defineTool, type Tool } from './define.js';

export const listShopsTool = defineTool({
  name: 'list_shops',
  toolset: 'shops',
  description:
    'Lists the shops in the Printify account with their id, title and sales channel ' +
    '("disconnected" when no sales channel is connected, e.g. an API shop). `default_shop_id` ' +
    'is the shop that shop-scoped tools use when `shop_id` is left out; it is missing when ' +
    'there is no default. Call this when the user asks about their shops or when a tool needs ' +
    'a `shop_id`.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  input: z.strictObject({}),
  handler: async (_input, ctx) => {
    // Always fetched, so the answer is current and the cache picks up newly connected shops.
    const shops = await ctx.shops.refresh(ctx.signal);
    const onlyShop = shops.length === 1 ? shops[0]?.id : undefined;
    return { shops, default_shop_id: ctx.config.shopId ?? onlyShop };
  },
});

export const disconnectShopTool = defineTool({
  name: 'disconnect_shop',
  toolset: 'shops',
  gate: 'destructive',
  description:
    'Disconnects a shop from Printify. This cannot be undone with this server; reconnecting ' +
    'happens in the Printify app. Needs an explicit `shop_id` and never uses the default shop. ' +
    "Before calling it, confirm the shop's id and title with the user, e.g. from `list_shops`.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  input: z.strictObject({
    shop_id: z
      .number()
      .int()
      .positive()
      .describe('The shop to disconnect. Required: this tool never uses the default shop.'),
  }),
  handler: async ({ shop_id }, ctx) => {
    try {
      await ctx.client.request('DELETE', apiPath`/v1/shops/${shop_id}/connection.json`, {
        signal: ctx.signal,
      });
    } finally {
      // Also after a failure: after a timeout, nobody knows whether the shop was disconnected.
      ctx.shops.invalidate();
    }
    return { shop_id, disconnected: true };
  },
});

export const shopsTools: readonly Tool[] = [listShopsTool, disconnectShopTool];
