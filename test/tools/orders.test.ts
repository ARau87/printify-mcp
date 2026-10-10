import { describe, expect, it, vi } from 'vitest';
import { TOOLS_BY_TOOLSET } from '../../src/tools/index.js';
import { omitKeys } from '../../src/tools/shape.js';
import { apiErrorBody, notFoundBody } from '../fixtures/errors.js';
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
import { SHOP } from '../fixtures/shops.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { fails, json } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';

const ORDERS_ON = { PRINTIFY_ENABLE_ORDERS: 'true' };
const GATED = ['create_order', 'create_express_order', 'send_order_to_production', 'cancel_order'];
const READ = ['list_orders', 'get_order', 'calculate_shipping'];
const PRODUCT_ITEM = { product_id: '5b05842f3921c9547531758d', variant_id: 17887, quantity: 1 };
const SKU_ITEM = { sku: 'MY-SKU', quantity: 2 };
const NEW_PRODUCT_ITEM = {
  blueprint_id: 9,
  print_provider_id: 5,
  variant_id: 17887,
  quantity: 1,
  print_areas: { front: 'https://images.example.com/image.png' },
};
/** The input address: the documented one without `company`, which the tools take too. */
const ADDRESS_INPUT = omitKeys(ADDRESS, ['company']);
const CREATE_INPUT = {
  shop_id: SHOP_ID,
  external_id: 'order-ext-1',
  line_items: [PRODUCT_ITEM],
  shipping_method: 'standard',
  address_to: ADDRESS_INPUT,
};

describe('the orders toolset', () => {
  it('registers only the read tools without PRINTIFY_ENABLE_ORDERS, and says so', async () => {
    const { mcp, selection } = await createTestServer();
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    for (const name of READ) expect(names).toContain(name);
    for (const name of GATED) expect(names).not.toContain(name);
    expect(selection.skipped.map(({ tool, reason }) => [tool.name, reason])).toEqual(
      expect.arrayContaining(GATED.map((name) => [name, 'orders'])),
    );
    expect(mcp.getInstructions()).toMatch(
      /Order tools that can spend money \(.*cancel_order.*\): set PRINTIFY_ENABLE_ORDERS=true\./,
    );
  });

  it('registers all seven with the flag, in order, with the right annotations', async () => {
    const { mcp } = await createTestServer({ env: ORDERS_ON });
    const { tools } = await mcp.listTools();
    const ours = tools.filter(({ name }) => [...READ, ...GATED].includes(name));
    expect(ours.map(({ name }) => name)).toEqual([...READ, ...GATED]);
    expect(TOOLS_BY_TOOLSET.orders.map(({ name }) => name)).toEqual([...READ, ...GATED]);
    const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
    const gated = { readOnlyHint: false, destructiveHint: true, idempotentHint: true };
    for (const tool of ours) {
      expect(tool.annotations).toMatchObject(READ.includes(tool.name) ? readOnly : gated);
    }
    const byName = new Map(ours.map((tool) => [tool.name, tool.description]));
    expect(byName.get('create_order')).toContain('This spends real money');
    expect(byName.get('create_express_order')).toContain('This spends real money');
    expect(byName.get('send_order_to_production')).toContain('This charges the account');
    expect(byName.get('cancel_order')).toContain('on-hold or payment-not-received');
  });
});

describe('list_orders', () => {
  it('lists rows without the address', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${ORDERS_PATH}`]: ordersPage([ORDER]) },
    });
    const data = expectToolData(await call('list_orders', { shop_id: SHOP_ID }));
    expect(data).toMatchObject({ page: 1, has_more: false, total: 1, last_page: 1 });
    expect(data['orders']).toEqual([
      {
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
      },
    ]);
    expect(api.expectRequest('GET', ORDERS_PATH).query).toEqual({});
  });

  it('passes page, limit, status and sku on', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET ${ORDERS_PATH}`]: ordersPage([], { last_page: 3, total: 21 }) },
    });
    const data = expectToolData(
      await call('list_orders', {
        shop_id: SHOP_ID,
        page: 2,
        limit: 10,
        status: 'fulfilled',
        sku: '168699843',
      }),
    );
    expect(data).toMatchObject({ page: 1, has_more: true, last_page: 3, total: 21 });
    expect(api.expectRequest('GET', ORDERS_PATH).query).toEqual({
      page: '2',
      limit: '10',
      status: 'fulfilled',
      sku: '168699843',
    });
  });

  it('includes the address in each row when asked', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ORDERS_PATH}`]: ordersPage([ORDER]) },
    });
    const data = expectToolData(
      await call('list_orders', { shop_id: SHOP_ID, include_address: true }),
    );
    expect(data['orders']).toEqual([expect.objectContaining({ address_to: ADDRESS })]);
  });

  it.each([
    ['a limit above 10', { limit: 11 }],
    ['an unknown status', { status: 'shipped' }],
    ['an unknown argument', { customer: 'x' }],
  ])('rejects %s before any request', async (_, args) => {
    const { call, api } = await createTestServer();
    expectToolError(await call('list_orders', { shop_id: SHOP_ID, ...args }), {
      kind: 'validation',
    });
    expect(api.requests).toEqual([]);
  });

  it('uses the default shop when shop_id is left out', async () => {
    const { call, api } = await createTestServer({
      routes: { 'GET /v1/shops.json': [SHOP], [`GET ${ORDERS_PATH}`]: ordersPage([]) },
    });
    expect(expectToolData(await call('list_orders'))).toMatchObject({ orders: [] });
    api.expectRequest('GET', ORDERS_PATH);
  });
});

describe('get_order', () => {
  it('returns the summary without the address', async () => {
    const { call } = await createTestServer({ routes: { [`GET ${ORDER_PATH}`]: ORDER } });
    const data = expectToolData(await call('get_order', { shop_id: SHOP_ID, order_id: ORDER.id }));
    expect(data).toMatchObject({
      id: ORDER.id,
      external_id: '1370762297',
      line_items: [
        expect.objectContaining({ title: '18K gold plated Necklace', sku: '168699843' }),
        expect.objectContaining({ title: 'Mug 11oz' }),
      ],
      metadata: expect.objectContaining({ order_type: 'api' }) as object,
      shipments: ORDER.shipments,
    });
    expect(data).not.toHaveProperty('address_to');
  });

  it('includes the address when asked', async () => {
    const { call } = await createTestServer({ routes: { [`GET ${ORDER_PATH}`]: ORDER } });
    const data = expectToolData(
      await call('get_order', { shop_id: SHOP_ID, order_id: ORDER.id, include_address: true }),
    );
    expect(data['address_to']).toEqual(ADDRESS);
  });

  it('keeps the not-found hint on a 404', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${ORDER_PATH}`]: json(notFoundBody(), 404) },
    });
    expectToolError(await call('get_order', { shop_id: SHOP_ID, order_id: ORDER.id }), {
      kind: 'http',
      status: 404,
      hint: expect.stringContaining('belongs to this shop') as string,
    });
  });

  it('rejects an order id with a slash before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(await call('get_order', { shop_id: SHOP_ID, order_id: '../x' }), {
      kind: 'validation',
    });
    expect(api.requests).toEqual([]);
  });
});

describe('calculate_shipping', () => {
  it('sends the line items and address and returns the quote as rows', async () => {
    const { call, api } = await createTestServer({
      routes: { [`POST ${SHIPPING_PATH}`]: QUOTE_TRANSITIONAL },
    });
    const data = expectToolData(
      await call('calculate_shipping', {
        shop_id: SHOP_ID,
        line_items: [PRODUCT_ITEM, SKU_ITEM, NEW_PRODUCT_ITEM],
        address_to: ADDRESS_INPUT,
      }),
    );
    expect(data).toEqual({
      methods: [
        { method: 'standard', code: 1, cost: 1000 },
        { method: 'priority', code: 2, cost: 5000 },
        { method: 'express', code: 3, cost: 799 },
        { method: 'economy', code: 4, cost: 399 },
      ],
    });
    expect(api.expectRequest('POST', SHIPPING_PATH).body).toEqual({
      line_items: [PRODUCT_ITEM, SKU_ITEM, NEW_PRODUCT_ITEM],
      address_to: ADDRESS_INPUT,
    });
  });

  it('reports a quote key it does not know under other', async () => {
    const { call } = await createTestServer({
      routes: { [`POST ${SHIPPING_PATH}`]: { standard: 1000, drone: 1 } },
    });
    const data = expectToolData(
      await call('calculate_shipping', {
        shop_id: SHOP_ID,
        line_items: [PRODUCT_ITEM],
        address_to: ADDRESS_INPUT,
      }),
    );
    expect(data).toEqual({
      methods: [{ method: 'standard', code: 1, cost: 1000 }],
      other: { drone: 1 },
    });
  });

  it('rejects a line item that matches no shape before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(
      await call('calculate_shipping', {
        shop_id: SHOP_ID,
        line_items: [{ variant_id: 17887, quantity: 1 }],
        address_to: ADDRESS_INPUT,
      }),
      { kind: 'validation' },
    );
    expect(api.requests).toEqual([]);
  });
});

describe('create_order', () => {
  it.each([
    ['an existing product', PRODUCT_ITEM],
    ['a SKU', SKU_ITEM],
    ['a product created on the fly', NEW_PRODUCT_ITEM],
  ])('sends %s line item as given, with the method as a code', async (_, item) => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${ORDERS_PATH}`]: { id: ORDER.id } },
    });
    const data = expectToolData(
      await call('create_order', {
        ...CREATE_INPUT,
        line_items: [item],
        shipping_method: 'express',
      }),
    );
    expect(data).toEqual({
      order_id: ORDER.id,
      created: true,
      external_id: 'order-ext-1',
      shipping_method: 'express',
      next_step: expect.stringContaining('send_order_to_production') as string,
    });
    expect(data['next_step']).toContain('cancel_order');
    expect(api.expectRequest('POST', ORDERS_PATH).body).toEqual({
      external_id: 'order-ext-1',
      line_items: [item],
      shipping_method: 3,
      send_shipping_notification: false,
      address_to: ADDRESS_INPUT,
    });
  });

  it('sends label and send_shipping_notification when given', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${ORDERS_PATH}`]: { id: ORDER.id } },
    });
    expectToolData(
      await call('create_order', {
        ...CREATE_INPUT,
        label: '00012',
        send_shipping_notification: true,
      }),
    );
    expect(api.expectRequest('POST', ORDERS_PATH).body).toMatchObject({
      label: '00012',
      shipping_method: 1,
      send_shipping_notification: true,
    });
  });

  it('reports a duplicate external_id as the existing order, not an error', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${ORDERS_PATH}`]: json(orderConflictBody('existing1'), 409) },
    });
    const result = await call('create_order', CREATE_INPUT);
    expect(result.isError).not.toBe(true);
    expect(expectToolData(result)).toEqual({
      order_id: 'existing1',
      created: false,
      external_id: 'order-ext-1',
      shipping_method: 'standard',
      next_step: expect.stringContaining('nothing new was created') as string,
    });
    expect(api.requests).toHaveLength(1);
  });

  it('refuses economy shipping with an on-the-fly line item before any request', async () => {
    const { call, api } = await createTestServer({ env: ORDERS_ON });
    expectToolError(
      await call('create_order', {
        ...CREATE_INPUT,
        line_items: [PRODUCT_ITEM, NEW_PRODUCT_ITEM],
        shipping_method: 'economy',
      }),
      {
        kind: 'tool',
        message: 'Economy shipping cannot be used with a product created on the fly.',
        hint: expect.stringContaining('create_product') as string,
      },
    );
    expect(api.requests).toEqual([]);
  });

  it.each([
    ['a missing external_id', { external_id: undefined }],
    ['the old printify_express name', { shipping_method: 'printify_express' }],
    ['a line item matching no shape', { line_items: [{ variant_id: 1, quantity: 1 }] }],
    ['an address without a zip', { address_to: { ...ADDRESS_INPUT, zip: undefined } }],
    ['a three-letter country', { address_to: { ...ADDRESS_INPUT, country: 'USA' } }],
    ['a quantity of zero', { line_items: [{ ...PRODUCT_ITEM, quantity: 0 }] }],
    ['an empty print area', { line_items: [{ ...NEW_PRODUCT_ITEM, print_areas: { front: [] } }] }],
    ['an unknown argument', { is_printify_express: true }],
  ])('rejects %s before any request', async (_, args) => {
    const { call, api } = await createTestServer({ env: ORDERS_ON });
    expectToolError(await call('create_order', { ...CREATE_INPUT, ...args }), {
      kind: 'validation',
    });
    expect(api.requests).toEqual([]);
  });

  it('passes an address validation error on with its hint, address redacted', async () => {
    const { call } = await createTestServer({
      env: ORDERS_ON,
      routes: {
        [`POST ${ORDERS_PATH}`]: json(
          apiErrorBody({ code: 8103, message: 'Validation failed.', reason: 'zip required' }),
          400,
        ),
      },
    });
    expectToolError(await call('create_order', CREATE_INPUT), {
      kind: 'http',
      status: 400,
      code: 8103,
      hint: expect.stringContaining('shipping address failed validation') as string,
    });
  });

  it('warns that a failed create may have gone through', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${ORDERS_PATH}`]: fails() },
    });
    const pending = call('create_order', CREATE_INPUT);
    await vi.waitUntil(() => api.requests.length === 1);
    expectToolError(await pending, {
      kind: 'network',
      hint: expect.stringContaining('may still have gone through') as string,
    });
    expect(api.requests).toHaveLength(1);
  });
});

describe('create_express_order', () => {
  const EXPRESS_INPUT = {
    shop_id: SHOP_ID,
    external_id: 'order-ext-2',
    line_items: [PRODUCT_ITEM, SKU_ITEM],
    address_to: ADDRESS_INPUT,
  };

  it('always sends code 3 and returns the express/ordinary split', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${EXPRESS_PATH}`]: EXPRESS_RESPONSE },
    });
    const data = expectToolData(await call('create_express_order', EXPRESS_INPUT));
    expect(data).toMatchObject({
      created: true,
      external_id: 'order-ext-2',
      orders: [
        {
          order_id: '5a96f649b2439217d070f508',
          fulfilment_type: 'express',
          app_order_id: '215014.44',
          line_items: [expect.objectContaining({ title: '18K gold plated Necklace', cost: 2200 })],
        },
        { order_id: '5a96f649b2439597d020a9b4', fulfilment_type: 'ordinary' },
      ],
      next_step: expect.stringContaining('send_order_to_production') as string,
    });
    expect(api.expectRequest('POST', EXPRESS_PATH).body).toEqual({
      external_id: 'order-ext-2',
      line_items: [PRODUCT_ITEM, SKU_ITEM],
      shipping_method: 3,
      send_shipping_notification: false,
      address_to: ADDRESS_INPUT,
    });
  });

  it('reports a duplicate external_id as the existing order', async () => {
    const { call } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${EXPRESS_PATH}`]: json(orderConflictBody('existing2'), 409) },
    });
    expect(expectToolData(await call('create_express_order', EXPRESS_INPUT))).toEqual({
      created: false,
      external_id: 'order-ext-2',
      orders: [{ order_id: 'existing2' }],
      next_step: expect.stringContaining('list_orders shows both') as string,
    });
  });

  it.each([
    ['an address without a phone', { address_to: { ...ADDRESS_INPUT, phone: undefined } }],
    ['an on-the-fly line item', { line_items: [NEW_PRODUCT_ITEM] }],
    ['a shipping_method', { shipping_method: 'express' }],
  ])('rejects %s before any request', async (_, args) => {
    const { call, api } = await createTestServer({ env: ORDERS_ON });
    expectToolError(await call('create_express_order', { ...EXPRESS_INPUT, ...args }), {
      kind: 'validation',
    });
    expect(api.requests).toEqual([]);
  });
});

describe('send_order_to_production', () => {
  it('posts to the order and reports it as sent', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`POST ${PRODUCTION_PATH}`]: { id: ORDER.id } },
    });
    expect(
      expectToolData(
        await call('send_order_to_production', { shop_id: SHOP_ID, order_id: ORDER.id }),
      ),
    ).toEqual({ order_id: ORDER.id, sent_to_production: true });
    expect(api.expectRequest('POST', PRODUCTION_PATH).body).toBeUndefined();
  });
});

describe('cancel_order', () => {
  it('checks the status, cancels an on-hold order and returns it without the address', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: {
        [`GET ${ORDER_PATH}`]: ORDER,
        [`POST ${CANCEL_PATH}`]: order({ status: 'canceled', total_price: 0 }),
      },
    });
    const data = expectToolData(
      await call('cancel_order', { shop_id: SHOP_ID, order_id: ORDER.id }),
    );
    expect(data).toMatchObject({ id: ORDER.id, status: 'canceled', cancelled: true });
    expect(data).not.toHaveProperty('address_to');
    expect(api.requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET ${ORDER_PATH}`,
      `POST ${CANCEL_PATH}`,
    ]);
  });

  it('accepts payment-not-received', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: {
        [`GET ${ORDER_PATH}`]: order({ status: 'payment-not-received' }),
        [`POST ${CANCEL_PATH}`]: order({ status: 'canceled' }),
      },
    });
    expectToolData(await call('cancel_order', { shop_id: SHOP_ID, order_id: ORDER.id }));
    api.expectRequest('POST', CANCEL_PATH);
  });

  it('passes a 404 from the status check on, without sending the cancel', async () => {
    const { call, api } = await createTestServer({
      env: ORDERS_ON,
      routes: { [`GET ${ORDER_PATH}`]: json(notFoundBody(), 404) },
    });
    expectToolError(await call('cancel_order', { shop_id: SHOP_ID, order_id: ORDER.id }), {
      kind: 'http',
      status: 404,
    });
    expect(api.requests).toHaveLength(1);
  });

  it.each([['in-production'], ['fulfilled'], [undefined]])(
    'refuses an order whose status is %s, without sending the cancel',
    async (status) => {
      const { call, api } = await createTestServer({
        env: ORDERS_ON,
        routes: { [`GET ${ORDER_PATH}`]: order({ status: status as string }) },
      });
      expectToolError(await call('cancel_order', { shop_id: SHOP_ID, order_id: ORDER.id }), {
        kind: 'tool',
        message: `Order ${ORDER.id} has status ${status ?? 'unknown'}, so Printify will not cancel it.`,
        hint: expect.stringContaining('on-hold or payment-not-received') as string,
      });
      expect(api.requests).toHaveLength(1);
    },
  );
});
