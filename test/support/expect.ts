import type { CallToolResult } from '@modelcontextprotocol/server';
import { expect } from 'vitest';

/** The registry's error kinds, plus `validation` for the SDK's input validation error. */
export interface ToolErrorFields {
  kind: 'http' | 'timeout' | 'network' | 'invalid_response' | 'tool' | 'internal' | 'validation';
  request?: string;
  status?: number;
  code?: number;
  message: string;
  reason?: string;
  request_id?: string;
  retry_after_seconds?: number;
  hint?: string;
}

/**
 * Asserts a successful tool result, and that its JSON text block and `structuredContent` agree.
 * Returns the data.
 */
export function expectToolData(result: CallToolResult): Record<string, unknown> {
  if (result.isError === true) {
    throw new Error(`expected a successful tool result, got ${JSON.stringify(result)}`);
  }
  const data: unknown = result.structuredContent;
  if (typeof data !== 'object' || data === null) {
    throw new Error(`the tool result has no structuredContent: ${JSON.stringify(result)}`);
  }
  expect(JSON.parse(textOf(result))).toEqual(data);
  return data as Record<string, unknown>;
}

/**
 * Asserts an error tool result and normalises both shapes: the registry's
 * `structuredContent.error`, and the SDK's text-only input validation error, which becomes
 * `kind: 'validation'`. With `expected`, the normalised fields are matched against it.
 */
export function expectToolError(
  result: CallToolResult,
  expected?: Partial<ToolErrorFields>,
): ToolErrorFields {
  if (result.isError !== true) {
    throw new Error(`expected an error tool result, got ${JSON.stringify(result)}`);
  }
  const fields = errorFields(result);
  if (expected !== undefined) expect(fields).toMatchObject(expected);
  return fields;
}

function errorFields(result: CallToolResult): ToolErrorFields {
  const structured: unknown = result.structuredContent;
  if (typeof structured === 'object' && structured !== null && 'error' in structured) {
    return structured.error as ToolErrorFields;
  }
  const message = textOf(result);
  if (message.startsWith('Input validation error:')) return { kind: 'validation', message };
  throw new Error(`the error result is in neither known shape: ${JSON.stringify(result)}`);
}

/** The first text content block. */
function textOf(result: CallToolResult): string {
  const block = result.content.find((item) => item.type === 'text');
  if (block === undefined) {
    throw new Error(`the tool result has no text block: ${JSON.stringify(result)}`);
  }
  return block.text;
}
