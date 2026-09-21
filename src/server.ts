import { McpServer } from '@modelcontextprotocol/server';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';
import type { Tool, ToolServices } from './tools/define.js';
import { registerTools } from './tools/run.js';

export interface CreateServerOptions {
  /** The tools to register: `selectTools(...).enabled`. */
  tools: readonly Tool[];
  /** Shared by every server instance of the process, so the rate limiter is too. */
  services: ToolServices;
  /** `serverInstructions(...)`: what is turned off, or `undefined` when nothing is. */
  instructions: string | undefined;
}

/**
 * Builds a fresh MCP server. `serveStdio` may call this for a `server/discover` probe and discard
 * the instance, so it must stay free of side effects: no timers, clients or open handles.
 */
export function createServer({ tools, services, instructions }: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    // Declaring tools up front installs the tools/list handler before any tool is registered.
    // Tools are registered once per instance, so the list never changes at runtime.
    { capabilities: { tools: { listChanged: false } }, instructions },
  );
  registerTools(server, tools, services);
  return server;
}
