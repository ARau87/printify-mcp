import { z } from 'zod';
import type { Shop } from '../printify/shops.js';
import { ToolError, type ToolContext } from './define.js';

const NO_SHOPS = 'This Printify account has no shops.';
const NO_SHOPS_HINT = 'Add a shop in Printify first, then try again.';
const SEVERAL_SHOPS_HINT =
  'Ask the user which shop to use and pass its id as shop_id. To make one the default, set ' +
  'PRINTIFY_SHOP_ID in the "env" block of the printify-mcp entry in the MCP client config.';

/**
 * The `shop_id` field of every shop-scoped tool. Spread it into the tool's input:
 * `z.strictObject({ ...shopIdInput, product_id: … })`, then call `resolveShopId`.
 */
export const shopIdInput = {
  shop_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The shop to use. Leave it out to use the default: PRINTIFY_SHOP_ID, or the only shop in ' +
        'the account.',
    ),
};

/**
 * The shop a call is for: `shop_id` if given, else PRINTIFY_SHOP_ID, else the account's only
 * shop. Only the last costs a request, and only until the shop list is cached. Throws a
 * `ToolError` when the account has no shops or several.
 */
export async function resolveShopId(
  input: { shop_id?: number | undefined },
  ctx: ToolContext,
): Promise<number> {
  if (input.shop_id !== undefined) return input.shop_id;
  if (ctx.config.shopId !== undefined) return ctx.config.shopId;
  const shops = await ctx.shops.list(ctx.signal);
  const [first] = shops;
  if (first === undefined) throw new ToolError(NO_SHOPS, NO_SHOPS_HINT);
  if (shops.length === 1) return first.id;
  throw new ToolError(
    `This Printify account has ${String(shops.length)} shops, so shop_id is needed: ` +
      `${shops.map(describeShop).join(', ')}.`,
    SEVERAL_SHOPS_HINT,
  );
}

/** `5432 "My new store" (Etsy)`, leaving out a missing title or sales channel. */
function describeShop({ id, title, sales_channel }: Shop): string {
  const parts = [String(id)];
  // JSON-quoted, so a quote or line break in a title cannot garble the list.
  if (title !== undefined) parts.push(JSON.stringify(title));
  if (sales_channel !== undefined) parts.push(`(${sales_channel})`);
  return parts.join(' ');
}
