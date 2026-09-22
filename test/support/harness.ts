import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type CallToolResult } from '@modelcontextprotocol/server';
import { onTestFinished } from 'vitest';
import { loadConfig, type Config, type Env } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { createPrintifyClient } from '../../src/printify/client.js';
import { createServer } from '../../src/server.js';
import type { Tool } from '../../src/tools/define.js';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { selectTools, serverInstructions, type Selection } from '../../src/tools/select.js';
import { createFakeApi, type FakeApi, type Routes } from './fake-api.js';

/** The token every harness server runs with. Never a real one. */
export const TEST_TOKEN = 'Tok-harness-9K8j7H6g';

export interface TestServerOptions {
  /** Defaults to `ALL_TOOLS`. */
  tools?: readonly Tool[];
  routes?: Routes;
  /** Merged over `{ PRINTIFY_API_TOKEN }` and parsed by the real `loadConfig`. */
  env?: Env;
  /** Applied after `loadConfig`, for what is awkward to express in `env`. */
  config?: Partial<Config>;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

// Function-typed properties, not methods: destructuring a method trips unbound-method.
export interface TestServer {
  /** The real MCP client. */
  mcp: Client;
  api: FakeApi;
  /** Shorthand for `mcp.callTool({ name, arguments: args }, options)`. */
  call: (
    name: string,
    args?: Record<string, unknown>,
    options?: CallOptions,
  ) => Promise<CallToolResult>;
  /** The lines the server wrote to stderr. */
  logged: readonly string[];
  selection: Selection;
  close: () => Promise<void>;
}

/**
 * Builds the server the way `cli.ts` does, over a fake Printify API, and connects a real MCP
 * client to it. Closes both and asserts that no request went unmatched when the test finishes.
 */
export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const result = loadConfig({ PRINTIFY_API_TOKEN: TEST_TOKEN, ...options.env });
  if (!result.ok) {
    throw new Error(`the test's environment is invalid:\n  ${result.errors.join('\n  ')}`);
  }
  const config: Config = { ...result.config, ...options.config };
  const api = createFakeApi(options.routes);
  const logged: string[] = [];
  const log = createLogger((line) => {
    logged.push(line);
  });
  const client = createPrintifyClient({
    token: config.token,
    baseUrl: config.apiBaseUrl,
    fetch: api.fetch,
  });
  const selection = selectTools(options.tools ?? ALL_TOOLS, config);
  const server = createServer({
    tools: selection.enabled,
    services: { client, config, log },
    instructions: serverInstructions(selection.skipped),
  });

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'printify-mcp-test', version: '0' });
  await server.connect(serverSide);
  await mcp.connect(clientSide);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await mcp.close();
    await server.close();
  };
  onTestFinished(async () => {
    await close();
    api.assertNoUnmatched();
  });

  return {
    mcp,
    api,
    logged,
    selection,
    close,
    call: (name, args = {}, callOptions) => mcp.callTool({ name, arguments: args }, callOptions),
  };
}
