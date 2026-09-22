import type { CallToolResult } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { expectToolData, expectToolError } from './expect.js';

function success(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function registryError(error: Record<string, unknown>): CallToolResult {
  const body = { error };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

const validationError: CallToolResult = {
  isError: true,
  content: [
    {
      type: 'text',
      text: 'Input validation error: Invalid arguments for tool get_product: Unrecognized key: "detial"',
    },
  ],
};

describe('expectToolData', () => {
  it('returns the data of a successful result', () => {
    expect(expectToolData(success({ shops: [{ id: 1 }] }))).toEqual({ shops: [{ id: 1 }] });
  });

  it('rejects an error result', () => {
    expect(() => expectToolData(registryError({ kind: 'http', message: 'no' }))).toThrow(
      /expected a successful tool result/,
    );
  });

  it('rejects a result without structuredContent', () => {
    expect(() => expectToolData({ content: [{ type: 'text', text: '{}' }] })).toThrow(
      /no structuredContent/,
    );
  });

  it('rejects a result whose text block and structuredContent disagree', () => {
    expect(() =>
      expectToolData({
        content: [{ type: 'text', text: '{"shops":[]}' }],
        structuredContent: { shops: [{ id: 1 }] },
      }),
    ).toThrow();
  });
});

describe('expectToolError', () => {
  it('returns the registry error fields', () => {
    const result = registryError({
      kind: 'http',
      request: 'GET /v1/shops.json',
      status: 404,
      message: 'Not found',
      hint: 'Check the id.',
    });
    expect(expectToolError(result)).toMatchObject({ kind: 'http', status: 404 });
  });

  it('matches the expected fields when they are given', () => {
    const result = registryError({ kind: 'tool', message: 'No default shop' });
    expect(expectToolError(result, { kind: 'tool' }).message).toBe('No default shop');
    expect(() => expectToolError(result, { kind: 'http' })).toThrow();
  });

  it('normalises an SDK validation error', () => {
    const fields = expectToolError(validationError);
    expect(fields.kind).toBe('validation');
    expect(fields.message).toContain('Unrecognized key');
  });

  it('rejects a successful result', () => {
    expect(() => expectToolError(success({ ok: true }))).toThrow(/expected an error tool result/);
  });

  it('rejects an error result in neither shape', () => {
    expect(() =>
      expectToolError({ isError: true, content: [{ type: 'text', text: 'something else' }] }),
    ).toThrow(/neither known shape/);
  });
});
