import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiPath } from '../../src/printify/path.js';
import { defineTool } from '../../src/tools/define.js';
import { SHOPS } from '../fixtures/shops.js';
import { createOrder, READ_ONLY } from '../tools/fixtures.js';
import { expectToolData, expectToolError } from './expect.js';
import { never } from './fake-api.js';
import { createTestServer } from './harness.js';

const listShops = defineTool({
  name: 'list_shops',
  toolset: 'shops',
  description: 'Lists the shops.',
  annotations: READ_ONLY,
  input: z.strictObject({}),
  handler: async (_input, ctx) => ({
    shops: await ctx.client.request('GET', apiPath`/v1/shops.json`, { signal: ctx.signal }),
  }),
});

// createOrder comes from the shared fixtures: it is gated on orders, which is all these tests
// need from it. Only list_shops needs a handler that reaches the fake API.
const TOOLS = [listShops, createOrder];

describe('createTestServer', () => {
  it('lists the tools and calls one end to end', async () => {
    const { mcp, api, call } = await createTestServer({
      tools: TOOLS,
      env: { PRINTIFY_ENABLE_ORDERS: 'true' },
      routes: { 'GET /v1/shops.json': SHOPS },
    });
    const { tools } = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['list_shops', 'create_order']);
    expect(expectToolData(await call('list_shops'))).toEqual({ shops: SHOPS });
    expect(api.expectRequest('GET', '/v1/shops.json').method).toBe('GET');
  });

  it('parses env with the real loadConfig, so a gate hides a tool', async () => {
    const { mcp, selection } = await createTestServer({ tools: TOOLS });
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(['list_shops']);
    expect(selection.skipped.map(({ tool }) => tool.name)).toEqual(['create_order']);
    expect(mcp.getInstructions()).toContain('create_order');
  });

  it('narrows the tools with PRINTIFY_TOOLSETS', async () => {
    const { mcp } = await createTestServer({
      tools: TOOLS,
      env: { PRINTIFY_TOOLSETS: 'orders', PRINTIFY_ENABLE_ORDERS: 'true' },
    });
    expect((await mcp.listTools()).tools.map((tool) => tool.name)).toEqual(['create_order']);
  });

  it('throws when the environment is invalid', async () => {
    await expect(createTestServer({ env: { PRINTIFY_SHOP_ID: 'abc' } })).rejects.toThrow(
      /PRINTIFY_SHOP_ID must be a numeric shop id/,
    );
  });

  it('applies a config override after loadConfig', async () => {
    const { selection } = await createTestServer({
      tools: TOOLS,
      config: { enableOrders: true },
    });
    expect(selection.enabled.map((tool) => tool.name)).toEqual(['list_shops', 'create_order']);
  });

  it('surfaces a missing route in the tool result, with no hint', async () => {
    const { call, api } = await createTestServer({ tools: TOOLS });
    const fields = expectToolError(await call('list_shops'), { kind: 'http', status: 418 });
    expect(fields.message).toContain('no route for GET /v1/shops.json');
    expect(fields.hint).toBeUndefined();
    expect(api.takeUnmatched()).toHaveLength(1);
  });

  it('reports an SDK validation error through expectToolError', async () => {
    const { call } = await createTestServer({
      tools: TOOLS,
      routes: { 'GET /v1/shops.json': SHOPS },
    });
    const fields = expectToolError(await call('list_shops', { nope: 1 }));
    expect(fields.kind).toBe('validation');
    expect(fields.message).toContain('Input validation error:');
  });

  it('aborts the handler signal when the client cancels', async () => {
    const { call, api } = await createTestServer({
      tools: TOOLS,
      routes: { 'GET /v1/shops.json': never() },
    });
    const controller = new AbortController();
    const pending = call('list_shops', {}, { signal: controller.signal });
    await vi.waitUntil(() => api.requests.length === 1);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    expect(api.requests[0]?.signal.aborted).toBe(true);
  });
});
