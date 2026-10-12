import { SHOP } from './shops.js';

/** The documented recipient of the order examples. */
export const ADDRESS = {
  first_name: 'John',
  last_name: 'Smith',
  email: 'example@msn.com',
  phone: '0574 69 21 90',
  country: 'BE',
  region: '',
  address1: 'ExampleBaan 121',
  address2: '45',
  city: 'Retie',
  zip: '2470',
  company: 'MSN',
};

export const LINE_ITEM = {
  product_id: '5b05842f3921c9547531758d',
  quantity: 1,
  variant_id: 17887,
  print_provider_id: 5,
  cost: 1050,
  shipping_cost: 400,
  status: 'on-hold',
  metadata: {
    title: '18K gold plated Necklace',
    price: 2200,
    variant_label: 'Golden indigocoin',
    sku: '168699843',
    country: 'United States',
    external_id: 'line-item-abc-001',
  },
  sent_to_production_at: null as string | null,
  fulfilled_at: null as string | null,
};

export const LINE_ITEM_MUG = {
  ...LINE_ITEM,
  product_id: '5b05842f3921c34764fa478bc',
  variant_id: 33719,
  cost: 650,
  metadata: {
    title: 'Mug 11oz',
    price: 1500,
    variant_label: '11oz',
    sku: '168699844',
    country: 'United States',
  },
};

/** The documented `GET …/orders/{order_id}.json` example, still on hold. */
export const ORDER = {
  id: '5a96f649b2439217d070f507',
  app_order_id: '215014.44',
  address_to: ADDRESS,
  line_items: [LINE_ITEM, LINE_ITEM_MUG],
  metadata: {
    order_type: 'api',
    shop_order_id: 1370762297 as number | string,
    shop_order_label: '1370762297',
    shop_fulfilled_at: '2017-04-18 13:24:28+00:00',
    is_reprint: false,
    reprinted_order_ids: [],
    child_reprinted_order_ids: [],
  },
  total_price: 3700,
  total_shipping: 400,
  total_tax: 0,
  status: 'on-hold',
  shipping_method: 1,
  is_printify_express: false,
  is_economy_shipping: false,
  shipments: [
    {
      carrier: 'usps',
      number: '94001116990045395649372',
      url: 'http://example.com/94001116990045395649372',
      delivered_at: '2017-04-18 13:24:28+00:00',
    },
  ],
  created_at: '2017-04-18 13:24:28+00:00',
  sent_to_production_at: null as string | null,
  fulfilled_at: null as string | null,
  printify_connect: {
    url: 'https://example.com/printify_connect_hash',
    id: 'printify_connect_hash',
  },
};

export function order(overrides: Partial<typeof ORDER> = {}): typeof ORDER {
  return { ...ORDER, ...overrides };
}

/** The Laravel envelope `GET …/orders.json` answers with. */
export function ordersPage(
  items: readonly object[] = [ORDER],
  overrides: { current_page?: number; last_page?: number; total?: number } = {},
): object {
  const { current_page = 1, last_page = 1, total = items.length } = overrides;
  return {
    current_page,
    data: items,
    first_page_url: '/?page=1',
    from: 1,
    last_page,
    last_page_url: `/?page=${String(last_page)}`,
    next_page_url: current_page < last_page ? `/?page=${String(current_page + 1)}` : null,
    path: '/',
    per_page: 10,
    prev_page_url: null,
    to: items.length,
    total,
  };
}

/** The documented `POST …/orders/express.json` answer: one express and one ordinary order. */
export const EXPRESS_RESPONSE = {
  data: [
    {
      type: 'order',
      id: '5a96f649b2439217d070f508',
      attributes: {
        app_order_id: '215014.44',
        fulfilment_type: 'express',
        line_items: [{ ...LINE_ITEM, variant_id: 12359, cost: 2200, shipping_cost: 799 }],
      },
    },
    {
      type: 'order',
      id: '5a96f649b2439597d020a9b4',
      attributes: {
        fulfilment_type: 'ordinary',
        line_items: [LINE_ITEM_MUG],
      },
    },
  ],
};

/** The three generations of `shipping.json` keys from the docs' table. */
export const QUOTE_OLD = { standard: 1000, express: 5000, economy: 399 };
export const QUOTE_TRANSITIONAL = {
  standard: 1000,
  express: 5000,
  priority: 5000,
  printify_express: 799,
  economy: 399,
};
export const QUOTE_FINAL = { standard: 1000, priority: 5000, express: 799, economy: 399 };

/** The openapi example for a duplicate `external_id`: HTTP 409, with the existing order. */
export function orderConflictBody(id = ORDER.id, externalId = 'order-ext-1'): object {
  return {
    status: 'error',
    code: 8503,
    message: 'Operation failed.',
    errors: { reason: 'Order already exists for the given external_id.', code: 8503 },
    order: { id, external_id: externalId },
  };
}

export const SHOP_ID = SHOP.id;
export const ORDERS_PATH = `/v1/shops/${String(SHOP_ID)}/orders.json`;
export const ORDER_PATH = `/v1/shops/${String(SHOP_ID)}/orders/${ORDER.id}.json`;
export const EXPRESS_PATH = `/v1/shops/${String(SHOP_ID)}/orders/express.json`;
export const SHIPPING_PATH = `/v1/shops/${String(SHOP_ID)}/orders/shipping.json`;
export const PRODUCTION_PATH = `/v1/shops/${String(SHOP_ID)}/orders/${ORDER.id}/send_to_production.json`;
export const CANCEL_PATH = `/v1/shops/${String(SHOP_ID)}/orders/${ORDER.id}/cancel.json`;
