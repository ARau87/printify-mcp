import { z } from 'zod';
import { loadConfig, type Config } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { createPrintifyClient } from '../../src/printify/client.js';
import {
  defineTool,
  type Tool,
  type ToolAnnotations,
  type ToolContext,
  type ToolDefinition,
  type ToolServices,
} from '../../src/tools/define.js';

export const TOKEN = 'Tok-tools-4D3c2B1a';

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
};
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};

/** A valid read-only tool in the `shops` toolset, with `overrides` applied. */
export function fixtureTool(overrides: Partial<ToolDefinition<z.ZodObject>> = {}): Tool {
  return defineTool({
    name: 'get_fixture',
    toolset: 'shops',
    description: 'Gets a fixture.',
    annotations: READ_ONLY,
    input: z.strictObject({}),
    handler: () => Promise.resolve({ ok: true }),
    ...overrides,
  });
}

export const listShops = fixtureTool({ name: 'list_shops', description: 'Lists the shops.' });
export const createOrder = fixtureTool({
  name: 'create_order',
  toolset: 'orders',
  gate: 'orders',
  description: 'Places an order.',
  annotations: DESTRUCTIVE,
});
export const deleteProduct = fixtureTool({
  name: 'delete_product',
  toolset: 'products',
  gate: 'destructive',
  description: 'Deletes a product.',
  annotations: DESTRUCTIVE,
});
export const listWebhooks = fixtureTool({
  name: 'list_webhooks',
  toolset: 'webhooks',
  description: 'Lists the webhooks.',
});
export const deleteWebhook = fixtureTool({
  name: 'delete_webhook',
  toolset: 'webhooks',
  gate: 'destructive',
  description: 'Deletes a webhook.',
  annotations: DESTRUCTIVE,
});

/** One read-only tool, both gates, and a toolset (webhooks) with a gated and an ungated tool. */
export const FIXTURE_TOOLS: readonly Tool[] = [
  listShops,
  createOrder,
  deleteProduct,
  listWebhooks,
  deleteWebhook,
];

/** The configuration `loadConfig` gives for just a token, with `overrides` applied. */
export function fixtureConfig(overrides: Partial<Config> = {}): Config {
  const result = loadConfig({ PRINTIFY_API_TOKEN: TOKEN });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return { ...result.config, ...overrides };
}

/** Fails any test that sends a request it did not expect. */
function unexpectedFetch(): Promise<Response> {
  throw new Error('the test did not expect a Printify request');
}

/** Services whose client uses `fetch` and whose log lines land in `logged`. */
export function fixtureServices(fetch: typeof globalThis.fetch = unexpectedFetch) {
  const logged: string[] = [];
  const config = fixtureConfig();
  const services: ToolServices = {
    client: createPrintifyClient({ token: config.token, baseUrl: config.apiBaseUrl, fetch }),
    config,
    log: createLogger((text) => {
      logged.push(text);
    }),
  };
  return { services, logged };
}

/** A tool call's context: `fixtureServices` plus a signal that has not aborted, by default. */
export function fixtureContext(
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
) {
  const { services, logged } = fixtureServices(options.fetch);
  const ctx: ToolContext = { ...services, signal: options.signal ?? new AbortController().signal };
  return { ctx, logged };
}
