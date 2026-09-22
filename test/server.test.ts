import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiPath } from '../src/printify/path.js';
import { defineTool } from '../src/tools/define.js';
import { notFoundBody } from './fixtures/errors.js';
import { expectToolData, expectToolError } from './support/expect.js';
import { json } from './support/fake-api.js';
import { createTestServer } from './support/harness.js';
import { FIXTURE_TOOLS, READ_ONLY, deleteProduct } from './tools/fixtures.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

const PRODUCT_ID = '5f3a1b2c3d4e5f6a7b8c9d0e';

const getProduct = defineTool({
  name: 'get_product',
  toolset: 'products',
  description: 'Gets a product.',
  annotations: READ_ONLY,
  input: z.strictObject({ product_id: z.string().regex(/^[0-9a-f]{24}$/) }),
  handler: async ({ product_id }, ctx) => ({
    product: await ctx.client.request('GET', apiPath`/v1/shops/12/products/${product_id}.json`, {
      signal: ctx.signal,
    }),
  }),
});

const PRODUCT_ROUTE = `GET /v1/shops/12/products/${PRODUCT_ID}.json` as const;

describe('createServer', () => {
  it('answers initialize with the name and version from package.json', async () => {
    const { mcp } = await createTestServer({ tools: [] });
    expect(mcp.getServerVersion()).toEqual({
      name: packageJson.name,
      version: packageJson.version,
    });
    expect(mcp.getServerCapabilities()).toEqual({ tools: { listChanged: false } });
    expect(mcp.getInstructions()).toBeUndefined();
  });

  it('sends instructions naming the tools that are turned off', async () => {
    const { mcp } = await createTestServer({ tools: FIXTURE_TOOLS });
    expect(mcp.getInstructions()).toContain('create_order');
  });

  it('answers tools/list with an empty list when there are no tools', async () => {
    const { mcp } = await createTestServer({ tools: [] });
    expect((await mcp.listTools()).tools).toEqual([]);
  });

  it('lists a tool with its hints, openWorldHint and a strict input schema', async () => {
    const { mcp } = await createTestServer({
      tools: [deleteProduct],
      env: { PRINTIFY_ENABLE_DESTRUCTIVE: 'true' },
    });
    expect((await mcp.listTools()).tools).toEqual([
      {
        name: 'delete_product',
        description: 'Deletes a product.',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ]);
  });

  describe.each([
    ['destructive', 'delete_product', 'PRINTIFY_ENABLE_DESTRUCTIVE'],
    ['orders', 'create_order', 'PRINTIFY_ENABLE_ORDERS'],
  ] as const)('a tool gated as %s', (_gate, name, variable) => {
    it('is absent from tools/list without its flag, and the instructions name it', async () => {
      const { mcp } = await createTestServer({ tools: FIXTURE_TOOLS });
      expect((await mcp.listTools()).tools.map((tool) => tool.name)).not.toContain(name);
      expect(mcp.getInstructions()).toContain(name);
    });

    it('is present in tools/list with its flag', async () => {
      const { mcp } = await createTestServer({
        tools: FIXTURE_TOOLS,
        env: { [variable]: 'true' },
      });
      expect((await mcp.listTools()).tools.map((tool) => tool.name)).toContain(name);
    });
  });

  it('returns a successful call as structured content and JSON text', async () => {
    const { call, api } = await createTestServer({
      tools: [getProduct],
      routes: { [PRODUCT_ROUTE]: { id: PRODUCT_ID, title: 'Tee', sku: null } },
    });
    const result = await call('get_product', { product_id: PRODUCT_ID });
    // The null is dropped, and expectToolData checks the text block against it.
    expect(expectToolData(result)).toEqual({ product: { id: PRODUCT_ID, title: 'Tee' } });
    api.expectRequest('GET', `/v1/shops/12/products/${PRODUCT_ID}.json`);
  });

  it('returns a Printify 404 as an isError result with the hint', async () => {
    const { call, api } = await createTestServer({
      tools: [getProduct],
      routes: { [PRODUCT_ROUTE]: json(notFoundBody(), 404) },
    });
    expectToolError(await call('get_product', { product_id: PRODUCT_ID }), {
      kind: 'http',
      request: `GET /v1/shops/12/products/${PRODUCT_ID}.json`,
      status: 404,
      message: 'Not found',
      request_id: 'req-1',
      hint: 'Not found. Check the id, and that it belongs to this shop.',
    });
    // A 404 is never retried, so exactly one request was sent.
    expect(api.requests).toHaveLength(1);
  });

  it('rejects an unknown argument before the handler runs', async () => {
    const { call, api } = await createTestServer({
      tools: [getProduct],
      routes: { [PRODUCT_ROUTE]: { id: PRODUCT_ID } },
    });
    const fields = expectToolError(
      await call('get_product', {
        product_id: PRODUCT_ID,
        detial: 'full',
      }),
    );
    expect(fields.kind).toBe('validation');
    expect(fields.message).toContain(
      'Input validation error: Invalid arguments for tool get_product: Unrecognized key: "detial"',
    );
    expect(api.requests).toEqual([]);
  });
});
