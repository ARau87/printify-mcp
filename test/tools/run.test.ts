import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { PrintifyApiError, httpError, timeoutError } from '../../src/printify/errors.js';
import { ToolError } from '../../src/tools/define.js';
import { runTool } from '../../src/tools/run.js';
import { rejection } from '../printify/helpers.js';
import { fixtureContext, fixtureTool } from './fixtures.js';

const BUG_HINT =
  'This is a bug in printify-mcp. Please report it at ' +
  'https://github.com/ARau87/printify-mcp/issues with the tool name and this message.';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl';

/** A tool whose handler rejects with `error`. */
function failing(error: unknown, name = 'get_fixture') {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- handlers can throw anything
  return fixtureTool({ name, handler: () => Promise.reject(error) });
}

/** The result `runTool` gives for an error: the same object as text and structured content. */
function errorResult(error: Record<string, unknown>): CallToolResult {
  const body = { error };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

describe('runTool', () => {
  it('returns the data as compact JSON text and structured content, without nulls', async () => {
    const tool = fixtureTool({
      handler: () =>
        Promise.resolve({ id: 1, sku: null, tags: ['a', null], variants: [{ id: 2, cost: null }] }),
    });
    const { ctx, logged } = fixtureContext();
    expect(await runTool(tool, {}, ctx)).toEqual({
      content: [{ type: 'text', text: '{"id":1,"tags":["a",null],"variants":[{"id":2}]}' }],
      structuredContent: { id: 1, tags: ['a', null], variants: [{ id: 2 }] },
    });
    expect(logged).toEqual([]);
  });

  it('passes the input and the context to the handler', async () => {
    const handler = vi.fn(() => Promise.resolve({}));
    const { ctx } = fixtureContext();
    await runTool(fixtureTool({ handler }), { id: '5f3' }, ctx);
    expect(handler).toHaveBeenCalledWith({ id: '5f3' }, ctx);
  });

  it('maps a PrintifyApiError to every field it has and logs one warning', async () => {
    const error = httpError(
      { method: 'POST', path: '/v1/shops/12/products.json' },
      400,
      {
        value: {
          status: 'error',
          code: 8203,
          message: 'Validation failed.',
          errors: { reason: 'Image has low quality', code: 8203 },
        },
      },
      'corr-1',
    );
    const { ctx, logged } = fixtureContext();
    expect(await runTool(failing(error, 'create_product'), {}, ctx)).toEqual(
      errorResult({
        kind: 'http',
        request: 'POST /v1/shops/12/products.json',
        status: 400,
        code: 8203,
        message: 'Validation failed.',
        reason: 'Image has low quality',
        request_id: 'corr-1',
        hint:
          'The image resolution is too low for the print area at this size. Use a larger image ' +
          'or a smaller `scale`.',
      }),
    );
    expect(logged).toEqual([
      'printify-mcp: warning: create_product failed: POST /v1/shops/12/products.json failed with ' +
        'HTTP 400 (code 8203): Validation failed. Reason: Image has low quality. Request id: corr-1\n',
    ]);
  });

  it('includes retry_after_seconds for a request the rate limiter did not send', async () => {
    const message =
      'GET /v1/shops.json was not sent: the limit of 600 requests per minute is used up. ' +
      'Retry in 12 seconds';
    const error = new PrintifyApiError(message, {
      kind: 'http',
      method: 'GET',
      path: '/v1/shops.json',
      status: 429,
      retryAfterSeconds: 12,
    });
    const { ctx } = fixtureContext();
    expect(await runTool(failing(error), {}, ctx)).toEqual(
      errorResult({
        kind: 'http',
        request: 'GET /v1/shops.json',
        status: 429,
        message,
        retry_after_seconds: 12,
        hint:
          "Printify's rate limit is used up, so the request was not sent. Wait 12 seconds before " +
          'trying again.',
      }),
    );
  });

  it('uses the error message when Printify sent none, and leaves out missing fields', async () => {
    const error = timeoutError({ method: 'GET', path: '/v1/shops.json' }, 30_000);
    const { ctx } = fixtureContext();
    const result = await runTool(failing(error), {}, ctx);
    expect(result.structuredContent).toStrictEqual({
      error: {
        kind: 'timeout',
        request: 'GET /v1/shops.json',
        message: 'GET /v1/shops.json timed out after 30000 ms',
        hint: 'Printify did not answer in time. Try again in a moment.',
      },
    });
  });

  it('maps a ToolError to kind "tool" and logs nothing', async () => {
    const error = new ToolError(
      'Product 5f3 is locked while it is being published.',
      'Wait until publishing has succeeded or failed.',
    );
    const { ctx, logged } = fixtureContext();
    expect(await runTool(failing(error), {}, ctx)).toEqual(
      errorResult({
        kind: 'tool',
        message: 'Product 5f3 is locked while it is being published.',
        hint: 'Wait until publishing has succeeded or failed.',
      }),
    );
    expect(logged).toEqual([]);
  });

  it('redacts a JWT in the message and hint of a ToolError', async () => {
    const error = new ToolError(`Token ${JWT} is locked.`, `Rotate ${JWT} and try again.`);
    const { ctx } = fixtureContext();
    const result = await runTool(failing(error), {}, ctx);
    expect(result.structuredContent).toStrictEqual({
      error: {
        kind: 'tool',
        message: 'Token [redacted] is locked.',
        hint: 'Rotate [redacted] and try again.',
      },
    });
  });

  it('leaves out the hint of a ToolError that has none', async () => {
    const { ctx } = fixtureContext();
    const result = await runTool(failing(new ToolError('No shop.')), {}, ctx);
    expect(result.structuredContent).toStrictEqual({
      error: { kind: 'tool', message: 'No shop.' },
    });
  });

  it.each([
    ['the abort reason', new Error('The user cancelled')],
    ['a PrintifyApiError', timeoutError({ method: 'GET', path: '/v1/shops.json' }, 30_000)],
  ])('re-throws %s once the signal has aborted', async (_, error) => {
    const controller = new AbortController();
    controller.abort(error);
    const { ctx, logged } = fixtureContext({ signal: controller.signal });
    expect(await rejection(runTool(failing(error), {}, ctx))).toBe(error);
    expect(logged).toEqual([]);
  });

  it('maps an unexpected error to kind "internal", redacted, and logs its stack', async () => {
    const { ctx, logged } = fixtureContext();
    const result = await runTool(failing(new TypeError(`bad token ${JWT}`)), {}, ctx);
    expect(result).toEqual(
      errorResult({ kind: 'internal', message: 'bad token [redacted]', hint: BUG_HINT }),
    );
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(
      /^printify-mcp: error: get_fixture failed unexpectedly: TypeError: bad token \[redacted\]\n\s+at /,
    );
    expect(logged[0]).not.toContain(JWT);
  });

  it('maps a thrown non-Error to kind "internal"', async () => {
    const { ctx, logged } = fixtureContext();
    const result = await runTool(failing('boom'), {}, ctx);
    expect(result).toEqual(errorResult({ kind: 'internal', message: 'boom', hint: BUG_HINT }));
    expect(logged).toEqual(['printify-mcp: error: get_fixture failed unexpectedly: boom\n']);
  });

  it('maps data that cannot be JSON-encoded to kind "internal"', async () => {
    const tool = fixtureTool({ handler: () => Promise.resolve({ id: 1n }) });
    const { ctx } = fixtureContext();
    const result = await runTool(tool, {}, ctx);
    expect(result).toEqual(
      errorResult({
        kind: 'internal',
        message: 'Do not know how to serialize a BigInt',
        hint: BUG_HINT,
      }),
    );
  });
});
