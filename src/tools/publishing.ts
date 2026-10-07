import { z } from 'zod';
import { getProduct } from '../printify/products.js';
import {
  publishProduct,
  setProductUnpublished,
  setPublishingFailed,
  setPublishingSucceeded,
  type PublishFlags,
} from '../printify/publishing.js';
import { defineTool, type Tool, type ToolAnnotations } from './define.js';
import { assertUnlocked } from './product-update.js';
import { productId } from './products.js';
import { findShop, publishNextStep, shopKind } from './shop-kind.js';
import { resolveShopId, shopIdInput } from './shop-id.js';

/** The three notify tools: a repeat reports the same state again. */
const IDEMPOTENT_WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
};

function flag(description: string): z.ZodDefault<z.ZodBoolean> {
  return z.boolean().default(true).describe(description);
}

export const publishProductTool = defineTool({
  name: 'publish_product',
  toolset: 'publishing',
  description:
    "Publishes a product to the shop's sales channel. On a shop connected to Shopify, Etsy or " +
    'another Printify integration, Printify creates or updates the listing and unlocks the ' +
    'product when the channel reports back. On an API shop it only locks the product and sends ' +
    'the product:publish:started event, and the integration must call set_publishing_succeeded ' +
    'or set_publishing_failed to unlock it; the result says which case applies and what to do ' +
    'next. Each flag set to false keeps that part of the listing as it is in the channel, e.g. ' +
    "tags: false keeps the channel's tags; key_features is sent as Printify's keyFeatures; " +
    'shipping_template matters on Etsy and Amazon only. A locked product is refused before ' +
    'anything is sent. If the call fails with a timeout, check is_locked with get_product ' +
    'before calling it again. Limited to 200 calls per 30 minutes.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: z.strictObject({
    ...shopIdInput,
    product_id: productId,
    title: flag('Publish the title. Default true.'),
    description: flag('Publish the description. Default true.'),
    images: flag(
      'Publish the mock-up images; false keeps the images the channel has. Default true.',
    ),
    variants: flag('Publish the variants. Default true.'),
    tags: flag("Publish the tags; false keeps the channel's tags. Default true."),
    key_features: flag('Publish the key features. Default true.'),
    shipping_template: flag('Publish the shipping template (Etsy and Amazon). Default true.'),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const shop = await findShop(ctx.shops, shopId, ctx.signal);
    const product = await getProduct(ctx.client, shopId, input.product_id, ctx.signal);
    assertUnlocked(product);
    const flags: PublishFlags = {
      title: input.title,
      description: input.description,
      images: input.images,
      variants: input.variants,
      tags: input.tags,
      keyFeatures: input.key_features,
      shipping_template: input.shipping_template,
    };
    await publishProduct(ctx.client, shopId, input.product_id, flags, ctx.signal);
    const kind = shopKind(shop);
    return {
      product_id: input.product_id,
      title: product.title,
      shop_id: shopId,
      sales_channel: shop?.sales_channel,
      shop_kind: kind,
      published: {
        title: input.title,
        description: input.description,
        images: input.images,
        variants: input.variants,
        tags: input.tags,
        key_features: input.key_features,
        shipping_template: input.shipping_template,
      },
      locked: true,
      next_step: publishNextStep(kind, shop?.sales_channel),
    };
  },
});

export const setPublishingSucceededTool = defineTool({
  name: 'set_publishing_succeeded',
  toolset: 'publishing',
  description:
    "Tells Printify that an API shop's integration published the product, which unlocks it and " +
    "records the listing's external id and handle (its URL or path in the sales channel). For " +
    'API shops; a connected shop reports this itself.',
  annotations: IDEMPOTENT_WRITE,
  input: z.strictObject({
    ...shopIdInput,
    product_id: productId,
    external_id: z.string().min(1).describe("The listing's id in the sales channel."),
    handle: z
      .string()
      .min(1)
      .describe("The listing's URL or path in the sales channel, e.g. /products/sunset-tee."),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const external = { id: input.external_id, handle: input.handle };
    await setPublishingSucceeded(ctx.client, shopId, input.product_id, external, ctx.signal);
    return { product_id: input.product_id, external, locked: false };
  },
});

export const setPublishingFailedTool = defineTool({
  name: 'set_publishing_failed',
  toolset: 'publishing',
  description:
    "Tells Printify that an API shop's integration could not publish the product, which unlocks " +
    'it; the reason is shown in the Printify app.',
  annotations: IDEMPOTENT_WRITE,
  input: z.strictObject({
    ...shopIdInput,
    product_id: productId,
    reason: z.string().min(1).describe('Why publishing failed, e.g. "Request timed out".'),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    await setPublishingFailed(ctx.client, shopId, input.product_id, input.reason, ctx.signal);
    return { product_id: input.product_id, reason: input.reason, locked: false };
  },
});

export const setProductUnpublishedTool = defineTool({
  name: 'set_product_unpublished',
  toolset: 'publishing',
  description:
    "Tells Printify that the product's listing was removed from the sales channel, so Printify " +
    'shows it as unpublished. It does not remove anything from a connected store; unpublish ' +
    'there in the channel itself.',
  annotations: IDEMPOTENT_WRITE,
  input: z.strictObject({ ...shopIdInput, product_id: productId }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    await setProductUnpublished(ctx.client, shopId, input.product_id, ctx.signal);
    return { product_id: input.product_id, unpublished: true };
  },
});

/** Every tool of the `publishing` toolset, in the order an API shop's flow calls them. */
export const publishingTools: readonly Tool[] = [
  publishProductTool,
  setPublishingSucceededTool,
  setPublishingFailedTool,
  setProductUnpublishedTool,
];
