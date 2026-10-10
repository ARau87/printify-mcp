import { describe, expect, it } from 'vitest';
import type { Order } from '../../src/printify/orders.js';
import { expressOrderRow, orderRow, summarizeOrder } from '../../src/tools/order-summary.js';
import { ADDRESS, ORDER, order } from '../fixtures/orders.js';

const OFF = { includeAddress: false };
const ON = { includeAddress: true };

/** The fixture as the request module would hand it over: nulls already turned to undefined. */
function parsed(overrides: Partial<typeof ORDER> = {}): Order {
  const raw = order(overrides);
  return {
    ...raw,
    sent_to_production_at: raw.sent_to_production_at ?? undefined,
    fulfilled_at: raw.fulfilled_at ?? undefined,
    line_items: raw.line_items.map((item) => ({
      ...item,
      sent_to_production_at: item.sent_to_production_at ?? undefined,
      fulfilled_at: item.fulfilled_at ?? undefined,
    })),
  };
}

describe('orderRow', () => {
  it('summarises the order without the address, naming the method and the external id', () => {
    const row = orderRow(parsed(), OFF);
    expect(row).toEqual({
      id: ORDER.id,
      app_order_id: '215014.44',
      external_id: '1370762297',
      status: 'on-hold',
      shipping_method: 'standard',
      is_printify_express: false,
      is_economy_shipping: false,
      total_price: 3700,
      total_shipping: 400,
      total_tax: 0,
      line_item_count: 2,
      created_at: ORDER.created_at,
      sent_to_production_at: undefined,
      fulfilled_at: undefined,
    });
    expect(row).not.toHaveProperty('address_to');
  });

  it('passes the address on as sent when asked', () => {
    expect(orderRow(parsed(), ON).address_to).toEqual(ADDRESS);
  });

  it('keeps a string shop_order_id and reports an unknown method code as text', () => {
    const row = orderRow(
      parsed({ metadata: { ...ORDER.metadata, shop_order_id: 'ext-9' }, shipping_method: 7 }),
      OFF,
    );
    expect(row).toMatchObject({ external_id: 'ext-9', shipping_method: '7' });
  });

  it('leaves external_id and line_item_count undefined when Printify sent nothing', () => {
    const row = orderRow({ id: 'bare' }, OFF);
    expect(row.external_id).toBeUndefined();
    expect(row.line_item_count).toBeUndefined();
  });
});

describe('summarizeOrder', () => {
  it('adds flattened line items, metadata without shop_order_id, shipments and connect', () => {
    const summary = summarizeOrder(parsed(), OFF);
    expect(summary.line_items?.[0]).toEqual({
      product_id: '5b05842f3921c9547531758d',
      variant_id: 17887,
      quantity: 1,
      print_provider_id: 5,
      cost: 1050,
      shipping_cost: 400,
      status: 'on-hold',
      title: '18K gold plated Necklace',
      price: 2200,
      variant_label: 'Golden indigocoin',
      sku: '168699843',
      print_provider_country: 'United States',
      external_id: 'line-item-abc-001',
      sent_to_production_at: undefined,
      fulfilled_at: undefined,
    });
    expect(summary.metadata).toEqual({
      order_type: 'api',
      shop_order_label: '1370762297',
      shop_fulfilled_at: '2017-04-18 13:24:28+00:00',
      is_reprint: false,
      reprinted_order_ids: [],
      child_reprinted_order_ids: [],
    });
    expect(summary.metadata).not.toHaveProperty('shop_order_id');
    expect(summary.shipments).toEqual(ORDER.shipments);
    expect(summary.printify_connect).toEqual(ORDER.printify_connect);
    expect(summary).not.toHaveProperty('address_to');
  });

  it('includes the address only when asked', () => {
    expect(summarizeOrder(parsed(), ON).address_to).toEqual(ADDRESS);
  });
});

describe('expressOrderRow', () => {
  it('names the order id and flattens its line items', () => {
    const row = expressOrderRow({
      id: 'x1',
      fulfilment_type: 'express',
      app_order_id: undefined,
      line_items: [{ product_id: 'p', metadata: { title: 'Tee' } }],
    });
    expect(row).toMatchObject({
      order_id: 'x1',
      fulfilment_type: 'express',
      line_items: [{ product_id: 'p', title: 'Tee' }],
    });
  });
});
