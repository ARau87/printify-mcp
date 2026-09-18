import { McpServer } from '@modelcontextprotocol/server';

export function createServer(): McpServer {
  return new McpServer({ name: 'printify-mcp', version: '0.0.0' });
}
