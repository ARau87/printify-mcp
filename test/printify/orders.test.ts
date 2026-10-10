import { describe, expect, it } from 'vitest';
import { createPrintifyClient, type PrintifyClient } from '../../src/printify/client.js';
import { httpError, timeoutError } from '../../src/printify/errors.js';
import {
  calculateShipping,
  cancelOrder,
  existingOrderId,
  getOrder,
  listOrders,
  sendOrderToProduction,
  submitExpressOrder,
  submitOrder,
} from '../../src/printify/orders.js';
import { Secret } from '../../src/secret.js';
import { apiErrorBody } from '../fixtures/errors.js';
import {
  ADDRESS,
  CANCEL_PATH,
  EXPRESS_PATH,
  EXPRESS_RESPONSE,
  ORDER,
  ORDER_PATH,
  ORDERS_PATH,
  PRODUCTION_PATH,
  QUOTE_TRANSITIONAL,
  SHIPPING_PATH,
  SHOP_ID,
  order,
  orderConflictBody,
  ordersPage,
} from '../fixtures/orders.js';
import { createFakeApi, json, type FakeApi, type Routes } from '../support/fake-api.js';
import { apiError } from './helpers.js';

const TOKEN = 'Tok-orders-7Q8w9E0r';
const ORDER_BODY = {
  external_id: 'order-ext-1',
  line_items: [{ product_id: ORDER.line_items[0]?.product_id, variant_id: 17887, quantity: 1 }],
  shipping_method: 1,
  send_shipping_notification: false,
  address_to: ADDRESS,
};
const ROUTE = { method: 'POST', path: ORDERS_PATH } as const;

function testClient(routes: Routes = {}): { client: PrintifyClient; api: FakeApi } {
  const api = createFakeApi(routes);
  const client = createPrintifyClient({
    token: new Secret(TOKEN),
    baseUrl: 'https://api.printify.com',
    fetch: api.fetch,
  });
  return { client, api };
}

/** A signal that has not aborted. */
function live(): AbortSignal {
  return new AbortController().signal;
}

describe('listOrders', () => {
  it('fetches a page and parses each order', async () => {
    const { client, api } = testClient({ [`GET ${ORDERS_PATH}`]: ordersPage([ORDER]) });
    const page = await listOrders(client, SHOP_ID, {}, live());
    expect(page).toMatchObject({ page: 1, hasMore: false, total: 1, lastPage: 1 });
    expect(page.orders[0]).toMatchObject({ id: ORDER.id, status: 'on-hold', shipping_method: 1 });
    expect(api.expectRequest('GET', ORDERS_PATH).query).toEqual({});
  });

  it('sends only the filters that were given, and caps limit at 10', async () => {
    const { client, api } = testClient({ [`GET ${ORDERS_PATH}`]: ordersPage([]) });
    await listOrders(client, SHOP_ID, { page: 2, limit: 25, status: 'fulfilled' }, live());
    expect(api.expectRequest('GET', ORDERS_PATH).query).toEqual({
      page: '2',
      limit: '10',
      status: 'fulfilled',
    });
  });

  it('sends the sku filter', async () => {
    const { client, api } = testClient({ [`GET ${ORDERS_PATH}`]: ordersPage([]) });
    await listOrders(client, SHOP_ID, { sku: '168699843' }, live());
    expect(api.expectRequest('GET', ORDERS_PATH).query).toEqual({ sku: '168699843' });
  });

  it('rejects an order without an id as an invalid response', async () => {
    const { client } = testClient({ [`GET ${ORDERS_PATH}`]: ordersPage([{ status: 'x' }]) });
    const error = await apiError(listOrders(client, SHOP_ID, {}, live()));
    expect(error).toMatchObject({ kind: 'invalid_response', method: 'GET', path: ORDERS_PATH });
    expect(error.message).toContain('an unexpected order response');
  });
});

describe('getOrder', () => {
  it('gets one order with every key Printify sent', async () => {
    const { client, api } = testClient({ [`GET ${ORDER_PATH}`]: ORDER });
    const got = await getOrder(client, SHOP_ID, ORDER.id, live());
    expect(got).toMatchObject({ id: ORDER.id, address_to: ADDRESS, shipments: ORDER.shipments });
    expect(got.metadata?.shop_order_id).toBe(1370762297);
    api.expectRequest('GET', ORDER_PATH);
  });

  it('turns null timestamps and a wrong-typed total into undefined', async () => {
    const { client } = testClient({
      [`GET ${ORDER_PATH}`]: order({ total_price: 'free' as unknown as number }),
    });
    const got = await getOrder(client, SHOP_ID, ORDER.id, live());
    expect(got.fulfilled_at).toBeUndefined();
    expect(got.total_price).toBeUndefined();
  });

  it('passes a 404 on with its hint', async () => {
    const { client } = testClient({ [`GET ${ORDER_PATH}`]: json({ error: 'Not found' }, 404) });
    const error = await apiError(getOrder(client, SHOP_ID, ORDER.id, live()));
    expect(error).toMatchObject({ kind: 'http', status: 404 });
  });
});

describe('calculateShipping', () => {
  it('posts the line items and address and returns the raw quote', async () => {
    const { client, api } = testClient({ [`POST ${SHIPPING_PATH}`]: QUOTE_TRANSITIONAL });
    const body = { line_items: ORDER_BODY.line_items, address_to: ADDRESS };
    expect(await calculateShipping(client, SHOP_ID, body, live())).toEqual(QUOTE_TRANSITIONAL);
    expect(api.expectRequest('POST', SHIPPING_PATH).body).toEqual(body);
  });

  it('rejects a non-numeric quote as an invalid response', async () => {
    const { client } = testClient({ [`POST ${SHIPPING_PATH}`]: { standard: 'cheap' } });
    const error = await apiError(calculateShipping(client, SHOP_ID, {}, live()));
    expect(error).toMatchObject({ kind: 'invalid_response', path: SHIPPING_PATH });
  });
});

describe('submitOrder', () => {
  it('posts the body and reports the new order as created', async () => {
    const { client, api } = testClient({ [`POST ${ORDERS_PATH}`]: { id: ORDER.id } });
    expect(await submitOrder(client, SHOP_ID, ORDER_BODY, live())).toEqual({
      id: ORDER.id,
      created: true,
    });
    expect(api.expectRequest('POST', ORDERS_PATH).body).toEqual(ORDER_BODY);
  });

  it('resolves to the existing order on a 409 conflict, without retrying', async () => {
    const { client, api } = testClient({
      [`POST ${ORDERS_PATH}`]: json(orderConflictBody('existing1'), 409),
    });
    expect(await submitOrder(client, SHOP_ID, ORDER_BODY, live())).toEqual({
      id: 'existing1',
      created: false,
    });
    expect(api.requests).toHaveLength(1);
  });

  it('rejects with the API error on a 400', async () => {
    const { client } = testClient({
      [`POST ${ORDERS_PATH}`]: json(apiErrorBody({ code: 8103, reason: 'zip required' }), 400),
    });
    const error = await apiError(submitOrder(client, SHOP_ID, ORDER_BODY, live()));
    expect(error).toMatchObject({ status: 400, code: 8103 });
  });

  it('rejects with the API error on a 409 whose body names no order', async () => {
    const { client } = testClient({
      [`POST ${ORDERS_PATH}`]: json(apiErrorBody({ code: 8503 }), 409),
    });
    const error = await apiError(submitOrder(client, SHOP_ID, ORDER_BODY, live()));
    expect(error).toMatchObject({ status: 409, code: 8503 });
    expect(error.hint).toContain('already exists');
  });

  it('rejects an answer without an id as an invalid response', async () => {
    const { client } = testClient({ [`POST ${ORDERS_PATH}`]: { ok: true } });
    const error = await apiError(submitOrder(client, SHOP_ID, ORDER_BODY, live()));
    expect(error).toMatchObject({ kind: 'invalid_response', method: 'POST', path: ORDERS_PATH });
  });
});

describe('submitExpressOrder', () => {
  it('parses the one-or-two-order envelope', async () => {
    const { client, api } = testClient({ [`POST ${EXPRESS_PATH}`]: EXPRESS_RESPONSE });
    const body = { ...ORDER_BODY, shipping_method: 3 };
    const result = await submitExpressOrder(client, SHOP_ID, body, live());
    expect(result).toEqual({
      created: true,
      orders: [
        {
          id: '5a96f649b2439217d070f508',
          fulfilment_type: 'express',
          app_order_id: '215014.44',
          line_items: EXPRESS_RESPONSE.data[0]?.attributes.line_items.map((item) => ({
            ...item,
            sent_to_production_at: undefined,
            fulfilled_at: undefined,
          })),
        },
        {
          id: '5a96f649b2439597d020a9b4',
          fulfilment_type: 'ordinary',
          app_order_id: undefined,
          line_items: EXPRESS_RESPONSE.data[1]?.attributes.line_items.map((item) => ({
            ...item,
            sent_to_production_at: undefined,
            fulfilled_at: undefined,
          })),
        },
      ],
    });
    expect(api.expectRequest('POST', EXPRESS_PATH).body).toEqual(body);
  });

  it('resolves to the existing order on a conflict', async () => {
    const { client } = testClient({
      [`POST ${EXPRESS_PATH}`]: json(orderConflictBody('existing2'), 409),
    });
    expect(await submitExpressOrder(client, SHOP_ID, ORDER_BODY, live())).toEqual({
      created: false,
      id: 'existing2',
    });
  });

  it('rejects a plain order answer as an invalid response', async () => {
    const { client } = testClient({ [`POST ${EXPRESS_PATH}`]: { id: ORDER.id } });
    const error = await apiError(submitExpressOrder(client, SHOP_ID, ORDER_BODY, live()));
    expect(error).toMatchObject({ kind: 'invalid_response', path: EXPRESS_PATH });
  });
});

describe('sendOrderToProduction', () => {
  it('posts without a body and returns the id', async () => {
    const { client, api } = testClient({ [`POST ${PRODUCTION_PATH}`]: { id: ORDER.id } });
    expect(await sendOrderToProduction(client, SHOP_ID, ORDER.id, live())).toBe(ORDER.id);
    expect(api.expectRequest('POST', PRODUCTION_PATH).body).toBeUndefined();
  });
});

describe('cancelOrder', () => {
  it('posts without a body and returns the cancelled order', async () => {
    const { client, api } = testClient({
      [`POST ${CANCEL_PATH}`]: order({ status: 'canceled' }),
    });
    const cancelled = await cancelOrder(client, SHOP_ID, ORDER.id, live());
    expect(cancelled).toMatchObject({ id: ORDER.id, status: 'canceled' });
    expect(api.expectRequest('POST', CANCEL_PATH).body).toBeUndefined();
  });
});

describe('existingOrderId', () => {
  it('reads the id from a 409 with the documented body', () => {
    const error = httpError(ROUTE, 409, { value: orderConflictBody('dup1') }, null);
    expect(existingOrderId(error)).toBe('dup1');
  });

  it('accepts code 8503 whatever the status', () => {
    const error = httpError(ROUTE, 400, { value: orderConflictBody('dup2') }, null);
    expect(existingOrderId(error)).toBe('dup2');
  });

  it('is undefined for a 409 without order.id, a 500, a timeout and a non-error', () => {
    expect(existingOrderId(httpError(ROUTE, 409, { value: apiErrorBody() }, null))).toBeUndefined();
    expect(existingOrderId(httpError(ROUTE, 500, { value: apiErrorBody() }, null))).toBeUndefined();
    // Another error whose body happens to carry an order: neither 409 nor 8503, so not a duplicate.
    const otherError = { ...orderConflictBody('x'), code: 8502, errors: { code: 8502 } };
    expect(existingOrderId(httpError(ROUTE, 500, { value: otherError }, null))).toBeUndefined();
    expect(existingOrderId(timeoutError(ROUTE, 30_000))).toBeUndefined();
    expect(existingOrderId(new Error('nope'))).toBeUndefined();
  });
});
