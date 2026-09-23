import type { z } from 'zod';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { Catalog } from '../printify/catalog.js';
import type { PrintifyClient } from '../printify/client.js';
import type { Toolset } from '../toolsets.js';

/**
 * The flag a tool needs besides its toolset: `orders` needs PRINTIFY_ENABLE_ORDERS, `destructive`
 * needs PRINTIFY_ENABLE_DESTRUCTIVE.
 */
export type Gate = 'orders' | 'destructive';

/** Created once per process and shared by every tool call. */
export interface ToolServices {
  client: PrintifyClient;
  config: Config;
  log: Logger;
  /** The catalog reader and its cache, one per process. */
  catalog: Catalog;
}

/** What a handler gets: the shared services plus the request's cancellation signal. */
export interface ToolContext extends ToolServices {
  signal: AbortSignal;
}

/** All three are required: MCP assumes `destructiveHint: true` for a tool that is not read-only. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

/** What a handler returns: a JSON object, never an array. */
export type ToolData = Record<string, unknown>;

export interface ToolDefinition<Input extends z.ZodObject> {
  /** snake_case, unique across all tools. */
  name: string;
  toolset: Toolset;
  /** Registered only when the gate's flag is on. */
  gate?: Gate;
  /** Written for the model: what the tool does, when to use it, what it costs. */
  description: string;
  annotations: ToolAnnotations;
  /** A `z.strictObject`, so unknown keys are rejected before the handler runs. */
  input: Input;
  handler: (input: z.output<Input>, ctx: ToolContext) => Promise<ToolData>;
}

/** A tool with its input type erased, so `ALL_TOOLS` can be a plain `readonly Tool[]`. */
export interface Tool {
  readonly name: string;
  readonly toolset: Toolset;
  readonly gate: Gate | undefined;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly input: z.ZodObject;
  readonly handler: (input: unknown, ctx: ToolContext) => Promise<ToolData>;
}

/**
 * Defines a tool. The handler returns plain data; the registry turns it into the MCP result and
 * turns a thrown `PrintifyApiError` or `ToolError` into an `isError` result.
 */
export function defineTool<Input extends z.ZodObject>(definition: ToolDefinition<Input>): Tool {
  const { handler } = definition;
  return {
    name: definition.name,
    toolset: definition.toolset,
    gate: definition.gate,
    description: definition.description,
    annotations: definition.annotations,
    input: definition.input,
    // Only registerTools calls this, with arguments the SDK has already parsed with `input`.
    handler: (input, ctx) => handler(input as z.output<Input>, ctx),
  };
}

/** The annotations sent to clients: the tool's hints, plus `openWorldHint` for every tool. */
export function mcpAnnotations(tool: Tool): ToolAnnotations & { openWorldHint: true } {
  return { ...tool.annotations, openWorldHint: true };
}

/**
 * A deliberate refusal, e.g. a locked product or a missing shop id. It becomes an `isError` result
 * of kind `tool` with this message and hint.
 */
export class ToolError extends Error {
  override readonly name = 'ToolError';
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}
