import type {
  ExpressOrder,
  Order,
  OrderAddress,
  OrderLineItem,
  OrderMetadata,
  Shipment,
} from '../printify/orders.js';
import { omitKeys } from './shape.js';
import { shippingMethodName } from './shipping-method.js';

export interface SummaryOptions {
  /** Whether to pass `address_to` on. Off by default, to keep personal data out of transcripts. */
  includeAddress: boolean;
}

/** One row of `list_orders`. */
export interface OrderRow {
  id: string;
  app_order_id: string | undefined;
  /** The `external_id` the order was submitted with, from `metadata.shop_order_id`. */
  external_id: string | undefined;
  status: string | undefined;
  shipping_method: string | undefined;
  is_printify_express: boolean | undefined;
  is_economy_shipping: boolean | undefined;
  total_price: number | undefined;
  total_shipping: number | undefined;
  total_tax: number | undefined;
  line_item_count: number | undefined;
  created_at: string | undefined;
  sent_to_production_at: string | undefined;
  fulfilled_at: string | undefined;
  address_to?: OrderAddress | undefined;
}

/** A line item with its metadata flattened in. */
export interface LineItemRow {
  product_id: string | undefined;
  variant_id: number | undefined;
  quantity: number | undefined;
  print_provider_id: number | undefined;
  cost: number | undefined;
  shipping_cost: number | undefined;
  status: string | undefined;
  title: string | undefined;
  price: number | undefined;
  variant_label: string | undefined;
  sku: string | undefined;
  /** Where the print provider is, e.g. "United States". */
  print_provider_country: string | undefined;
  external_id: string | undefined;
  sent_to_production_at: string | undefined;
  fulfilled_at: string | undefined;
}

/** `get_order`'s result, and `cancel_order`'s. */
export interface OrderSummary extends OrderRow {
  line_items: LineItemRow[] | undefined;
  metadata: Omit<OrderMetadata, 'shop_order_id'> | undefined;
  shipments: Shipment[] | undefined;
  printify_connect: Order['printify_connect'];
}

/** One order of `create_express_order`'s result. */
export interface ExpressOrderRow {
  order_id: string;
  fulfilment_type: string | undefined;
  app_order_id: string | undefined;
  line_items: LineItemRow[] | undefined;
}

export function orderRow(order: Order, { includeAddress }: SummaryOptions): OrderRow {
  const shopOrderId = order.metadata?.shop_order_id;
  return {
    id: order.id,
    app_order_id: order.app_order_id,
    external_id: shopOrderId === undefined ? undefined : String(shopOrderId),
    status: order.status,
    shipping_method: shippingMethodName(order.shipping_method),
    is_printify_express: order.is_printify_express,
    is_economy_shipping: order.is_economy_shipping,
    total_price: order.total_price,
    total_shipping: order.total_shipping,
    total_tax: order.total_tax,
    line_item_count: order.line_items?.length,
    created_at: order.created_at,
    sent_to_production_at: order.sent_to_production_at,
    fulfilled_at: order.fulfilled_at,
    ...(includeAddress && { address_to: order.address_to }),
  };
}

export function summarizeOrder(order: Order, options: SummaryOptions): OrderSummary {
  return {
    ...orderRow(order, options),
    line_items: order.line_items?.map(lineItemRow),
    // shop_order_id is already the row's external_id.
    metadata:
      order.metadata === undefined ? undefined : omitKeys(order.metadata, ['shop_order_id']),
    shipments: order.shipments,
    printify_connect: order.printify_connect,
  };
}

export function lineItemRow(item: OrderLineItem): LineItemRow {
  return {
    product_id: item.product_id,
    variant_id: item.variant_id,
    quantity: item.quantity,
    print_provider_id: item.print_provider_id,
    cost: item.cost,
    shipping_cost: item.shipping_cost,
    status: item.status,
    title: item.metadata?.title,
    price: item.metadata?.price,
    variant_label: item.metadata?.variant_label,
    sku: item.metadata?.sku,
    print_provider_country: item.metadata?.country,
    external_id: item.metadata?.external_id,
    sent_to_production_at: item.sent_to_production_at,
    fulfilled_at: item.fulfilled_at,
  };
}

export function expressOrderRow(order: ExpressOrder): ExpressOrderRow {
  return {
    order_id: order.id,
    fulfilment_type: order.fulfilment_type,
    app_order_id: order.app_order_id,
    line_items: order.line_items?.map(lineItemRow),
  };
}
