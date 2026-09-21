import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { Logger } from '../log.js';
import { PrintifyApiError } from '../printify/errors.js';
import { redactJwts } from '../redact.js';
import {
  ToolError,
  mcpAnnotations,
  type Tool,
  type ToolContext,
  type ToolServices,
} from './define.js';
import { dropNulls } from './shape.js';

const BUG_HINT =
  'This is a bug in printify-mcp. Please report it at ' +
  'https://github.com/ARau87/printify-mcp/issues with the tool name and this message.';

type ErrorFields = Record<string, string | number | undefined>;

/** Registers every tool on `server`. Each call runs through `runTool`. */
export function registerTools(
  server: McpServer,
  tools: readonly Tool[],
  services: ToolServices,
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, annotations: mcpAnnotations(tool) },
      (input, ctx) => runTool(tool, input, { ...services, signal: ctx.mcpReq.signal }),
    );
  }
}

/**
 * Runs one tool call. The handler's data becomes `structuredContent` and a compact JSON text
 * block, without nulls. Whatever the handler throws becomes an `isError` result, except after
 * `ctx.signal` aborted: then the error is re-thrown, because nobody reads the reply.
 */
export async function runTool(
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
): Promise<CallToolResult> {
  try {
    const data = dropNulls(await tool.handler(input, ctx));
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    const body = { error: dropNulls(errorFields(tool, error, ctx.log)) };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(body) }],
      structuredContent: body,
    };
  }
}

function errorFields(tool: Tool, error: unknown, log: Logger): ErrorFields {
  if (error instanceof PrintifyApiError) {
    // message is one redacted line; a network error's cause is never logged.
    log.warn(`${tool.name} failed: ${error.message}`);
    return {
      kind: error.kind,
      request: `${error.method} ${error.path}`,
      status: error.status,
      code: error.code,
      // Read explicitly: Error's message is not enumerable.
      message: error.printifyMessage ?? error.message,
      reason: error.reason,
      request_id: error.requestId,
      retry_after_seconds: error.retryAfterSeconds,
      hint: error.hint,
    };
  }
  if (error instanceof ToolError) {
    return { kind: 'tool', message: error.message, hint: error.hint };
  }
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log.error(`${tool.name} failed unexpectedly: ${redactJwts(detail)}`);
  return { kind: 'internal', message: redactJwts(message), hint: BUG_HINT };
}
