import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiPath } from '../src/printify/path.js';
import { createServer } from '../src/server.js';
import { defineTool, type Tool } from '../src/tools/define.js';
import { selectTools, serverInstructions, type SelectionConfig } from '../src/tools/select.js';
import { TOOLSETS } from '../src/toolsets.js';
import { connect } from './support/json-rpc.js';
import { FIXTURE_TOOLS, READ_ONLY, deleteProduct, fixtureServices } from './tools/fixtures.js';

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

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function serve(
  tools: readonly Tool[],
  options: { fetch?: typeof globalThis.fetch; instructions?: string } = {},
) {
  const { services } = fixtureServices(options.fetch);
  return connect(createServer({ tools, services, instructions: options.instructions }));
}

describe('createServer', () => {
  it('answers initialize with the name and version from package.json', async () => {
    const mcp = await serve([]);
    expect(mcp.initialized).toMatchObject({
      serverInfo: { name: packageJson.name, version: packageJson.version },
      capabilities: { tools: { listChanged: false } },
    });
    expect(mcp.initialized).not.toHaveProperty('instructions');
    await mcp.close();
  });

  it('sends the instructions in the initialize result', async () => {
    const mcp = await serve([], { instructions: 'Some Printify tools are turned off.' });
    expect(mcp.initialized).toHaveProperty('instructions', 'Some Printify tools are turned off.');
    await mcp.close();
  });

  it('answers tools/list with an empty list when there are no tools', async () => {
    const mcp = await serve([]);
    expect(await mcp.listTools()).toEqual([]);
    await mcp.close();
  });

  it('lists a tool with its hints, openWorldHint and a strict input schema', async () => {
    const mcp = await serve([deleteProduct]);
    expect(await mcp.listTools()).toEqual([
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
    await mcp.close();
  });

  describe.each([
    ['destructive', 'delete_product', { enableDestructive: true }],
    ['orders', 'create_order', { enableOrders: true }],
  ] as const)('a tool gated as %s', (_, name, flagOn) => {
    const flagsOff: SelectionConfig = {
      toolsets: new Set(TOOLSETS),
      enableOrders: false,
      enableDestructive: false,
    };

    async function listedNames(config: SelectionConfig) {
      const { enabled, skipped } = selectTools(FIXTURE_TOOLS, config);
      const mcp = await serve(enabled, { instructions: serverInstructions(skipped) });
      const listed = (await mcp.listTools()).map((tool) => tool.name);
      await mcp.close();
      return { listed, instructions: mcp.initialized.instructions };
    }

    it('is absent from tools/list without its flag, and the instructions name it', async () => {
      const { listed, instructions } = await listedNames(flagsOff);
      expect(listed).not.toContain(name);
      expect(instructions).toContain(name);
    });

    it('is present in tools/list with its flag', async () => {
      const { listed } = await listedNames({ ...flagsOff, ...flagOn });
      expect(listed).toContain(name);
    });
  });

  it('returns a successful call as structured content and JSON text', async () => {
    const fetch = fakeFetch(200, { id: PRODUCT_ID, title: 'Tee', sku: null });
    const mcp = await serve([getProduct], { fetch });
    const product = { id: PRODUCT_ID, title: 'Tee' };
    expect(await mcp.callTool('get_product', { product_id: PRODUCT_ID })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ product }) }],
      structuredContent: { product },
    });
    await mcp.close();
  });

  it('returns a Printify 404 as an isError result with the hint', async () => {
    const fetch = fakeFetch(404, { error: 'Not found', request_id: 'req-1' });
    const mcp = await serve([getProduct], { fetch });
    const error = {
      kind: 'http',
      request: `GET /v1/shops/12/products/${PRODUCT_ID}.json`,
      status: 404,
      message: 'Not found',
      request_id: 'req-1',
      hint: 'Not found. Check the id, and that it belongs to this shop.',
    };
    expect(await mcp.callTool('get_product', { product_id: PRODUCT_ID })).toEqual({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error }) }],
      structuredContent: { error },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await mcp.close();
  });

  it('rejects an unknown argument before the handler runs', async () => {
    const fetch = fakeFetch(200, {});
    const mcp = await serve([getProduct], { fetch });
    const result = await mcp.callTool('get_product', { product_id: PRODUCT_ID, detial: 'full' });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result.content)).toContain(
      'Input validation error: Invalid arguments for tool get_product: Unrecognized key: \\"detial\\"',
    );
    expect(fetch).not.toHaveBeenCalled();
    await mcp.close();
  });
});
