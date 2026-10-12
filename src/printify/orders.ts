import { z } from 'zod';
import type { PrintifyClient } from './client.js';
import { invalidResponseError, PrintifyApiError, type Route } from './errors.js';
import { fetchPage } from './pagination.js';
import { apiPath, type ApiPath } from './path.js';
import { lenient } from './schema.js';

// Every object is loose and only `id` is required, so a field Printify drops or retypes cannot
// break a read. The address is parsed to strings only: the summary either passes it on whole
// or leaves it out.
const addressSchema = z.looseObject({
  first_name: lenient(z.string()),
  last_name: lenient(z.string()),
  email: lenient(z.string()),
  phone: lenient(z.string()),
  country: lenient(z.string()),
  region: lenient(z.string()),
  address1: lenient(z.string()),
  address2: lenient(z.string()),
  city: lenient(z.string()),
  zip: lenient(z.string()),
  company: lenient(z.string()),
});

const lineItemMetadataSchema = z.looseObject({
  title: lenient(z.string()),
  price: lenient(z.number()),
  variant_label: lenient(z.string()),
  sku: lenient(z.string()),
  country: lenient(z.string()),
  external_id: lenient(z.string()),
});

const lineItemSchema = z.looseObject({
  product_id: lenient(z.string()),
  variant_id: lenient(z.number().int()),
  quantity: lenient(z.number().int()),
  print_provider_id: lenient(z.number().int()),
  cost: lenient(z.number()),
  shipping_cost: lenient(z.number()),
  status: lenient(z.string()),
  metadata: lenient(lineItemMetadataSchema),
  sent_to_production_at: lenient(z.string()),
  fulfilled_at: lenient(z.string()),
});

// shop_order_id is documented as an integer and shown as a string in the cancel example.
const metadataSchema = z.looseObject({
  order_type: lenient(z.string()),
  shop_order_id: lenient(z.union([z.string(), z.number()])),
  shop_order_label: lenient(z.string()),
  shop_fulfilled_at: lenient(z.string()),
  is_reprint: lenient(z.boolean()),
  reprinted_order_ids: lenient(z.array(z.string())),
  child_reprinted_order_ids: lenient(z.array(z.string())),
});

const shipmentSchema = z.looseObject({
  carrier: lenient(z.string()),
  number: lenient(z.string()),
  url: lenient(z.string()),
  delivered_at: lenient(z.string()),
});

const orderSchema = z.looseObject({
  id: z.string().min(1),
  app_order_id: lenient(z.string()),
  address_to: lenient(addressSchema),
  line_items: lenient(z.array(lineItemSchema)),
  metadata: lenient(metadataSchema),
  total_price: lenient(z.number()),
  total_shipping: lenient(z.number()),
  total_tax: lenient(z.number()),
  status: lenient(z.string()),
  shipping_method: lenient(z.number().int()),
  is_printify_express: lenient(z.boolean()),
  is_economy_shipping: lenient(z.boolean()),
  shipments: lenient(z.array(shipmentSchema)),
  created_at: lenient(z.string()),
  sent_to_production_at: lenient(z.string()),
  fulfilled_at: lenient(z.string()),
  printify_connect: lenient(z.looseObject({ url: lenient(z.string()), id: lenient(z.string()) })),
});

// The express endpoint answers a JSON:API envelope, one entry per order it created.
const expressOrderSchema = z.object({
  id: z.string().min(1),
  attributes: z.looseObject({
    app_order_id: lenient(z.string()),
    fulfilment_type: lenient(z.string()),
    line_items: lenient(z.array(lineItemSchema)),
  }),
});
const expressResponseSchema = z.object({ data: z.array(expressOrderSchema) });

const createdSchema = z.object({ id: z.string().min(1) });
const quoteSchema = z.record(z.string(), z.number());
const conflictSchema = z.object({ order: z.object({ id: z.string().min(1) }) });

/** An order as Printify returns it, with every key it sent. */
export type Order = z.infer<typeof orderSchema>;
export type OrderLineItem = z.infer<typeof lineItemSchema>;
export type OrderAddress = z.infer<typeof addressSchema>;
export type OrderMetadata = z.infer<typeof metadataSchema>;
export type Shipment = z.infer<typeof shipmentSchema>;

/** One order the express endpoint created: an `express` one, an `ordinary` one, or both. */
export interface ExpressOrder {
  id: string;
  fulfilment_type: string | undefined;
  app_order_id: string | undefined;
  line_items: OrderLineItem[] | undefined;
}

export interface OrderPage {
  orders: Order[];
  page: number;
  hasMore: boolean;
  total: number | undefined;
  lastPage: number | undefined;
}

export interface ListOrdersOptions {
  page?: number | undefined;
  limit?: number | undefined;
  status?: string | undefined;
  sku?: string | undefined;
}

/** What a create answered: a new order, or the order that already had this `external_id`. */
export interface SubmitResult {
  id: string;
  created: boolean;
}

export type ExpressResult =
  { created: true; orders: ExpressOrder[] } | { created: false; id: string };

const DUPLICATE_CODE = 8503;

function ordersPath(shopId: number): ApiPath {
  return apiPath`/v1/shops/${shopId}/orders.json`;
}

function orderPath(shopId: number, orderId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/orders/${orderId}.json`;
}

/** One page of a shop's orders, newest first. A `limit` above 10 is lowered by `fetchPage`. */
export async function listOrders(
  client: PrintifyClient,
  shopId: number,
  options: ListOrdersOptions,
  signal: AbortSignal,
): Promise<OrderPage> {
  const path = ordersPath(shopId);
  const page = await fetchPage(client, 'orders', path, {
    page: options.page,
    limit: options.limit,
    // Only the filters that were given: buildUrl skips undefined, but the query stays explicit.
    query: {
      ...(options.status !== undefined && { status: options.status }),
      ...(options.sku !== undefined && { sku: options.sku }),
    },
    signal,
  });
  const route: Route = { method: 'GET', path };
  return {
    orders: page.items.map((item) => parseOrder(item, route)),
    page: page.page,
    hasMore: page.hasMore,
    total: page.total,
    lastPage: page.lastPage,
  };
}

export async function getOrder(
  client: PrintifyClient,
  shopId: number,
  orderId: string,
  signal: AbortSignal,
): Promise<Order> {
  const path = orderPath(shopId, orderId);
  const body = await client.request('GET', path, { signal });
  return parseOrder(body, { method: 'GET', path });
}

/**
 * Quotes the shipping cost per method. `body` is the tool's validated `{ line_items, address_to }`.
 * The answer is Printify's flat object of method key to cents, unknown keys kept, so the tool's
 * `parseShippingQuote` can translate the transitional key names.
 */
export async function calculateShipping(
  client: PrintifyClient,
  shopId: number,
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, number>> {
  const path = apiPath`/v1/shops/${shopId}/orders/shipping.json`;
  const response = await client.request('POST', path, { body, signal });
  const parsed = quoteSchema.safeParse(response);
  if (!parsed.success) throw unexpected({ method: 'POST', path });
  return parsed.data;
}

/**
 * Submits an order. A 409 or code 8503 whose body names the order that already has this
 * `external_id` resolves to that order with `created: false`; any other error propagates.
 */
export async function submitOrder(
  client: PrintifyClient,
  shopId: number,
  body: unknown,
  signal: AbortSignal,
): Promise<SubmitResult> {
  const path = ordersPath(shopId);
  let response: unknown;
  try {
    response = await client.request('POST', path, { body, signal });
  } catch (error) {
    const id = existingOrderId(error);
    if (id === undefined) throw error;
    return { id, created: false };
  }
  const parsed = createdSchema.safeParse(response);
  if (!parsed.success) throw unexpected({ method: 'POST', path });
  return { id: parsed.data.id, created: true };
}

/** Submits a Printify Express order, which answers one or two orders. Same conflict rule. */
export async function submitExpressOrder(
  client: PrintifyClient,
  shopId: number,
  body: unknown,
  signal: AbortSignal,
): Promise<ExpressResult> {
  const path = apiPath`/v1/shops/${shopId}/orders/express.json`;
  let response: unknown;
  try {
    response = await client.request('POST', path, { body, signal });
  } catch (error) {
    const id = existingOrderId(error);
    if (id === undefined) throw error;
    return { created: false, id };
  }
  const parsed = expressResponseSchema.safeParse(response);
  if (!parsed.success) throw unexpected({ method: 'POST', path });
  return {
    created: true,
    orders: parsed.data.data.map(({ id, attributes }) => ({
      id,
      fulfilment_type: attributes.fulfilment_type,
      app_order_id: attributes.app_order_id,
      line_items: attributes.line_items,
    })),
  };
}

/** Sends an order to production. Printify answers `{ id }`; the id is returned. */
export async function sendOrderToProduction(
  client: PrintifyClient,
  shopId: number,
  orderId: string,
  signal: AbortSignal,
): Promise<string> {
  const path = apiPath`/v1/shops/${shopId}/orders/${orderId}/send_to_production.json`;
  const response = await client.request('POST', path, { signal });
  const parsed = createdSchema.safeParse(response);
  if (!parsed.success) throw unexpected({ method: 'POST', path });
  return parsed.data.id;
}

/** Cancels an order. Printify answers the whole order, address included. */
export async function cancelOrder(
  client: PrintifyClient,
  shopId: number,
  orderId: string,
  signal: AbortSignal,
): Promise<Order> {
  const path = apiPath`/v1/shops/${shopId}/orders/${orderId}/cancel.json`;
  const response = await client.request('POST', path, { signal });
  return parseOrder(response, { method: 'POST', path });
}

/**
 * The id of the order that already has the submitted `external_id`, read from a duplicate
 * error's body (HTTP 409 or code 8503 with `order.id`), or `undefined` for any other error.
 */
export function existingOrderId(error: unknown): string | undefined {
  if (!(error instanceof PrintifyApiError)) return undefined;
  if (error.status !== 409 && error.code !== DUPLICATE_CODE) return undefined;
  const parsed = conflictSchema.safeParse(error.body);
  return parsed.success ? parsed.data.order.id : undefined;
}

function parseOrder(body: unknown, route: Route): Order {
  const parsed = orderSchema.safeParse(body);
  if (!parsed.success) throw unexpected(route);
  return parsed.data;
}

function unexpected(route: Route): PrintifyApiError {
  return invalidResponseError(route, 200, 'an unexpected order response');
}
