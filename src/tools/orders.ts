import { z } from 'zod';
import {
  calculateShipping,
  cancelOrder,
  getOrder,
  listOrders,
  sendOrderToProduction,
  submitExpressOrder,
  submitOrder,
} from '../printify/orders.js';
import { PAGE_LIMITS } from '../printify/pagination.js';
import { defineTool, ToolError, type Tool, type ToolAnnotations } from './define.js';
import { expressOrderRow, orderRow, summarizeOrder } from './order-summary.js';
import { printDetailsInput, productId } from './products.js';
import {
  ORDER_SHIPPING_METHODS,
  parseShippingQuote,
  shippingMethodCode,
} from './shipping-method.js';
import { resolveShopId, shopIdInput } from './shop-id.js';

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/** Spends money or stops an order; a repeat with the same arguments changes nothing more. */
const GATED: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};

/** Printify Express Delivery's code; the express endpoint takes no other. */
const EXPRESS_CODE = 3;

// Letters and digits only, like productId: apiPath URL-encodes anything else.
const orderId = z
  .string()
  .regex(/^[A-Za-z0-9]+$/, 'order_id must be letters and digits')
  .describe('The order id, e.g. from list_orders.');

const ORDER_STATUSES = [
  'pending',
  'on-hold',
  'sending-to-production',
  'in-production',
  'canceled',
  'fulfilled',
  'partially-fulfilled',
  'payment-not-received',
  'has-issues',
  'cost-calculation',
  'unfulfillable',
  'sending_to_production_delegate',
  'sending_to_production_delegate_sync',
  'source-check-failed',
] as const;

/** The statuses Printify cancels an order in. */
const CANCELLABLE_STATUSES: readonly string[] = ['on-hold', 'payment-not-received'];

const includeAddressInput = z
  .boolean()
  .default(false)
  .describe(
    "Include the recipient's address, email and phone. Off by default, to keep personal data " +
      'out of the conversation.',
  );

const addressFields = {
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  address1: z.string().min(1),
  address2: z.string().optional(),
  city: z.string().min(1),
  zip: z.string().min(1),
  country: z.string().length(2).describe('ISO 3166-1 alpha-2, e.g. US.'),
  region: z.string().optional().describe('The state or province, where the country has them.'),
  company: z.string().optional(),
};

const addressInput = z
  .strictObject({
    ...addressFields,
    email: z.string().optional(),
    phone: z.string().optional(),
  })
  .describe("The recipient's address.");

const expressAddressInput = z
  .strictObject({
    ...addressFields,
    email: z.string().min(1).describe('Required for Printify Express.'),
    phone: z.string().min(1).describe('Required for Printify Express.'),
  })
  .describe("The recipient's address. Printify Express needs the email and phone.");

const quantity = z.number().int().positive().describe('How many of this variant.');
const lineItemExternalId = z
  .string()
  .min(1)
  .optional()
  .describe('An id of your own for the line item, kept through replacements.');
const variantId = z.number().int().positive().describe('The variant id, from get_product.');

const productLineItemInput = z.strictObject({
  product_id: productId,
  variant_id: variantId,
  quantity,
  external_id: lineItemExternalId,
});

const skuLineItemInput = z.strictObject({
  sku: z.string().min(1).describe("A variant's SKU, from get_product."),
  quantity,
  external_id: lineItemExternalId,
});

const imageUrl = z.url().describe('A publicly reachable image URL.');
const placedImageInput = z.strictObject({
  src: imageUrl,
  x: z.number().min(0).max(1).describe("The image centre's horizontal position, 0–1."),
  y: z.number().min(0).max(1).describe("The image centre's vertical position, 0–1."),
  scale: z.number().positive().describe('The image width divided by the print area width.'),
  angle: z.number().min(-360).max(360).describe('Rotation in degrees; 0 is upright.'),
});

const newProductLineItemInput = z.strictObject({
  blueprint_id: z.number().int().positive().describe('From search_blueprints.'),
  print_provider_id: z.number().int().positive().describe('From list_blueprint_providers.'),
  variant_id: z.number().int().positive().describe('From list_variants.'),
  quantity,
  print_areas: z
    .record(z.string().min(1), z.union([imageUrl, z.array(placedImageInput).min(1)]))
    .describe(
      'Position to artwork, e.g. { "front": "https://…/art.png" }: a URL fills the print ' +
        'area, or an array of placed images for advanced positioning.',
    ),
  print_details: printDetailsInput.optional(),
  external_id: lineItemExternalId,
});

const lineItemInput = z.union([productLineItemInput, skuLineItemInput, newProductLineItemInput]);
const existingLineItemInput = z.union([productLineItemInput, skuLineItemInput]);

const LINE_ITEM_SHAPES =
  'Each line item is one of: an existing product { product_id, variant_id, quantity }, a SKU ' +
  '{ sku, quantity }, or a product created on the fly { blueprint_id, print_provider_id, ' +
  'variant_id, quantity, print_areas }.';

const shippingMethodInput = z
  .enum(ORDER_SHIPPING_METHODS)
  .describe(
    'standard, priority, express (Printify Express Delivery) or economy. calculate_shipping ' +
      'lists what is available for the items and what each costs.',
  );

const orderFields = {
  external_id: z
    .string()
    .min(1)
    .describe(
      'Your own unique id for this order, e.g. an order number or a fresh UUID. Printify ' +
        'refuses a second order with the same one, so reuse it when retrying.',
    ),
  label: z.string().min(1).optional().describe('A label shown instead of the external_id.'),
  send_shipping_notification: z
    .boolean()
    .default(false)
    .describe('Email the recipient when the order ships.'),
};

const MONEY_WARNING =
  'This spends real money. Confirm the items, quantities, address and shipping method with ' +
  'the user first, and quote the cost with calculate_shipping. Printify charges the account ' +
  "when the order goes to production: with the shop's default automatic approval that " +
  'happens about 24 hours after creation without any further call; with manual approval, ' +
  'when send_order_to_production is called. ';
const EXTERNAL_ID_RULE =
  'external_id is required and must be unique per order. If the call times out or fails ' +
  'with a network error, call again with the SAME external_id, never a new one: Printify then ' +
  'returns the existing order instead of placing a second one, and the result says ' +
  'created: false. ';
const CANCEL_WINDOW =
  'cancel_order can undo the order only while its status is on-hold or payment-not-received.';

const CREATED_NEXT_STEP =
  'The order exists and is not yet charged. If the shop uses automatic order approval ' +
  "(Printify's default for new stores), it goes to production about 24 hours after creation " +
  'and the account is charged then; call send_order_to_production to send it now. With ' +
  'manual approval nothing happens until that call. cancel_order works only while the status ' +
  'is on-hold or payment-not-received; get_order shows the status.';
const DUPLICATE_NEXT_STEP =
  'An order with this external_id already existed, so nothing new was created and nothing ' +
  'was charged by this call. Use get_order with this order_id to see its status.';
const EXPRESS_DUPLICATE_NEXT_STEP =
  DUPLICATE_NEXT_STEP +
  ' An express submission may have produced a second, ordinary order; list_orders shows both.';

export const listOrdersTool = defineTool({
  name: 'list_orders',
  toolset: 'orders',
  description:
    "Lists a shop's orders, newest first, as compact rows: id, external_id, status, shipping " +
    'method, totals in cents, line item count and timestamps. limit is at most 10 ' +
    "(Printify's maximum). status filters by order status; sku keeps the orders that contain " +
    "that SKU. The recipient's address is left out unless include_address is true, to keep " +
    'personal data out of the conversation. Use get_order for the line items.',
  annotations: READ_ONLY,
  input: z.strictObject({
    ...shopIdInput,
    page: z.number().int().positive().optional().describe('The page to fetch, starting at 1.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(PAGE_LIMITS.orders)
      .optional()
      .describe(`Orders per page, at most ${String(PAGE_LIMITS.orders)}.`),
    status: z.enum(ORDER_STATUSES).optional().describe('Only orders with this status.'),
    sku: z.string().min(1).optional().describe('Only orders containing this SKU.'),
    include_address: includeAddressInput,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const page = await listOrders(
      ctx.client,
      shopId,
      { page: input.page, limit: input.limit, status: input.status, sku: input.sku },
      ctx.signal,
    );
    const options = { includeAddress: input.include_address };
    return {
      orders: page.orders.map((order) => orderRow(order, options)),
      page: page.page,
      has_more: page.hasMore,
      total: page.total,
      last_page: page.lastPage,
    };
  },
});

export const getOrderTool = defineTool({
  name: 'get_order',
  toolset: 'orders',
  description:
    'Gets one order: its line items (product, variant, quantity, costs, status, print provider ' +
    'country), totals in cents, status, shipments with tracking, and reprint metadata. The ' +
    "recipient's address is left out unless include_address is true.",
  annotations: READ_ONLY,
  input: z.strictObject({
    ...shopIdInput,
    order_id: orderId,
    include_address: includeAddressInput,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const order = await getOrder(ctx.client, shopId, input.order_id, ctx.signal);
    return { ...summarizeOrder(order, { includeAddress: input.include_address }) };
  },
});

export const calculateShippingTool = defineTool({
  name: 'calculate_shipping',
  toolset: 'orders',
  description:
    'Quotes the shipping cost of an order before it is placed: one row per shipping method, in ' +
    'cents, for the given line items and address. Nothing is created or charged. Each ' +
    "row's method is what create_order takes as shipping_method; a method Printify does not " +
    'offer for these items is absent. ' +
    LINE_ITEM_SHAPES,
  annotations: READ_ONLY,
  input: z.strictObject({
    ...shopIdInput,
    line_items: z.array(lineItemInput).min(1),
    address_to: addressInput,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const raw = await calculateShipping(
      ctx.client,
      shopId,
      { line_items: input.line_items, address_to: input.address_to },
      ctx.signal,
    );
    return { ...parseShippingQuote(raw) };
  },
});

export const createOrderTool = defineTool({
  name: 'create_order',
  toolset: 'orders',
  gate: 'orders',
  description:
    'Creates an order. ' +
    MONEY_WARNING +
    EXTERNAL_ID_RULE +
    LINE_ITEM_SHAPES +
    ' A product created on the fly is slow, may time out, cannot use economy shipping and is ' +
    'slated for deprecation by Printify; create the product first when possible. ' +
    'shipping_method is one of standard, priority, express (Printify Express; every item must ' +
    'be eligible) and economy. ' +
    CANCEL_WINDOW,
  annotations: GATED,
  input: z.strictObject({
    ...shopIdInput,
    ...orderFields,
    line_items: z.array(lineItemInput).min(1),
    shipping_method: shippingMethodInput,
    address_to: addressInput,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    if (
      input.shipping_method === 'economy' &&
      input.line_items.some((item) => 'blueprint_id' in item)
    ) {
      throw new ToolError(
        'Economy shipping cannot be used with a product created on the fly.',
        'Create the product first with create_product, or choose another shipping method.',
      );
    }
    const result = await submitOrder(
      ctx.client,
      shopId,
      {
        external_id: input.external_id,
        label: input.label,
        line_items: input.line_items,
        shipping_method: shippingMethodCode(input.shipping_method),
        send_shipping_notification: input.send_shipping_notification,
        address_to: input.address_to,
      },
      ctx.signal,
    );
    return {
      order_id: result.id,
      created: result.created,
      external_id: input.external_id,
      shipping_method: input.shipping_method,
      next_step: result.created ? CREATED_NEXT_STEP : DUPLICATE_NEXT_STEP,
    };
  },
});

export const createExpressOrderTool = defineTool({
  name: 'create_express_order',
  toolset: 'orders',
  gate: 'orders',
  description:
    'Creates an order with Printify Express Delivery, for existing products only. ' +
    MONEY_WARNING +
    EXTERNAL_ID_RULE +
    'Line items are an existing product { product_id, variant_id, quantity } or a SKU ' +
    '{ sku, quantity }; the address needs email and phone. Printify splits the line items by ' +
    'Printify Express eligibility: all eligible gives one express order, none gives one ' +
    'ordinary order, a mix gives two orders, and the result lists each with its ' +
    'fulfilment_type. Only is_printify_express_eligible on the product and variant counts, ' +
    'not is_printify_express_enabled. Express carriers are not supported by every sales ' +
    'channel, e.g. Amazon and TikTok. ' +
    CANCEL_WINDOW,
  annotations: GATED,
  input: z.strictObject({
    ...shopIdInput,
    ...orderFields,
    line_items: z.array(existingLineItemInput).min(1),
    address_to: expressAddressInput,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const result = await submitExpressOrder(
      ctx.client,
      shopId,
      {
        external_id: input.external_id,
        label: input.label,
        line_items: input.line_items,
        shipping_method: EXPRESS_CODE,
        send_shipping_notification: input.send_shipping_notification,
        address_to: input.address_to,
      },
      ctx.signal,
    );
    if (!result.created) {
      return {
        created: false,
        external_id: input.external_id,
        orders: [{ order_id: result.id }],
        next_step: EXPRESS_DUPLICATE_NEXT_STEP,
      };
    }
    return {
      created: true,
      external_id: input.external_id,
      orders: result.orders.map(expressOrderRow),
      next_step: CREATED_NEXT_STEP,
    };
  },
});

export const sendOrderToProductionTool = defineTool({
  name: 'send_order_to_production',
  toolset: 'orders',
  gate: 'orders',
  description:
    'Sends an order to production now. This charges the account and cannot be undone; confirm ' +
    'with the user first. Needed only when the shop uses manual order approval: with automatic ' +
    'approval Printify sends the order itself about 24 hours after creation. If the call times ' +
    'out, check the status with get_order (sending-to-production or in-production means it ' +
    'went through) before calling again.',
  annotations: GATED,
  input: z.strictObject({ ...shopIdInput, order_id: orderId }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const id = await sendOrderToProduction(ctx.client, shopId, input.order_id, ctx.signal);
    return { order_id: id, sent_to_production: true };
  },
});

export const cancelOrderTool = defineTool({
  name: 'cancel_order',
  toolset: 'orders',
  gate: 'orders',
  description:
    'Cancels an order that has not been paid or sent to production. Printify accepts the ' +
    'cancellation only while the status is on-hold or payment-not-received; the tool checks ' +
    'the status first and refuses otherwise, so an order in production is never touched. An ' +
    "order already in production can only be changed through Printify's support flows " +
    '(reprint, refund, address change), which this server does not offer yet. Returns the ' +
    'cancelled order without the address.',
  annotations: GATED,
  input: z.strictObject({ ...shopIdInput, order_id: orderId }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const current = await getOrder(ctx.client, shopId, input.order_id, ctx.signal);
    const status = current.status ?? 'unknown';
    if (!CANCELLABLE_STATUSES.includes(status)) {
      throw new ToolError(
        `Order ${current.id} has status ${status}, so Printify will not cancel it.`,
        'Only an order with status on-hold or payment-not-received can be cancelled. An order ' +
          'that is already in production can only be changed through Printify support.',
      );
    }
    const cancelled = await cancelOrder(ctx.client, shopId, input.order_id, ctx.signal);
    return { ...summarizeOrder(cancelled, { includeAddress: false }), cancelled: true };
  },
});

/** Every tool of the `orders` toolset, in the order a session uses them. */
export const ordersTools: readonly Tool[] = [
  listOrdersTool,
  getOrderTool,
  calculateShippingTool,
  createOrderTool,
  createExpressOrderTool,
  sendOrderToProductionTool,
  cancelOrderTool,
];
