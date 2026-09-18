import { McpServer } from '@modelcontextprotocol/server';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';

/**
 * Builds a fresh MCP server. `serveStdio` may call this for a `server/discover` probe and discard
 * the instance, so it must stay free of side effects: no timers, clients or open handles.
 */
export function createServer(): McpServer {
  return new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    // Declaring tools up front installs the tools/list handler before any tool is registered.
    // Tools are registered once per instance, so the list never changes at runtime.
    { capabilities: { tools: { listChanged: false } } },
  );
}
