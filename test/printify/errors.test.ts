import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  PrintifyApiError,
  httpError,
  invalidResponseError,
  networkError,
  parseJson,
  timeoutError,
} from '../../src/printify/errors.js';

const PRODUCTS = { method: 'POST', path: '/v1/shops/12/products.json' } as const;
const PRODUCT = { method: 'GET', path: '/v1/shops/12/products/abc.json' } as const;
const CORRELATION_ID = 'e08829df-8558-47a5-8da9-66357db48760';

// Documented example for POST /v1/shops/{shop_id}/products.json.
const LOW_QUALITY = {
  status: 'error',
  code: 8203,
  message: 'Validation failed.',
  errors: { reason: 'Image has low quality', code: 8203 },
};

describe('parseJson', () => {
  it('wraps parsed JSON, including null', () => {
    expect(parseJson('{"a":1}')).toEqual({ value: { a: 1 } });
    expect(parseJson('null')).toEqual({ value: null });
  });

  it('returns undefined for text that is not JSON', () => {
    expect(parseJson('<html>Bad gateway</html>')).toBeUndefined();
    expect(parseJson('')).toBeUndefined();
  });
});

describe('httpError', () => {
  it('reads the documented error body and falls back to the correlation id', () => {
    const error = httpError(PRODUCTS, 400, { value: LOW_QUALITY }, CORRELATION_ID);
    expect(error).toBeInstanceOf(PrintifyApiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('PrintifyApiError');
    expect(error).toMatchObject({
      kind: 'http',
      method: 'POST',
      path: '/v1/shops/12/products.json',
      status: 400,
      code: 8203,
      printifyMessage: 'Validation failed.',
      reason: 'Image has low quality',
      requestId: CORRELATION_ID,
    });
    expect(error.message).toBe(
      'POST /v1/shops/12/products.json failed with HTTP 400 (code 8203): Validation failed. ' +
        `Reason: Image has low quality. Request id: ${CORRELATION_ID}`,
    );
    expect(error.hint).toContain('The image resolution is too low');
  });

  it('treats a blank message as missing and falls back to error', () => {
    const error = httpError(PRODUCT, 404, { value: { message: '  ', error: 'Not found' } }, null);
    expect(error.printifyMessage).toBe('Not found');
  });

  it('treats a blank request_id as missing and falls back to the correlation id', () => {
    const body = { error: 'Not found', request_id: '' };
    const error = httpError(PRODUCT, 404, { value: body }, 'corr-2');
    expect(error.requestId).toBe('corr-2');
  });

  it('treats a blank errors.reason as missing and falls back to stringifying errors', () => {
    const body = { errors: { reason: ' ', code: 8150 } };
    const error = httpError(PRODUCT, 422, { value: body }, null);
    expect(error.reason).toBe('{"reason":" ","code":8150}');
    expect(error.code).toBe(8150);
  });

  it('reads the {error, request_id} body and prefers its request id', () => {
    const body = { error: 'Not found', request_id: `1789735516@${CORRELATION_ID}` };
    const error = httpError(PRODUCT, 404, { value: body }, 'header-id');
    expect(error).toMatchObject({
      status: 404,
      code: undefined,
      printifyMessage: 'Not found',
      reason: undefined,
      requestId: `1789735516@${CORRELATION_ID}`,
    });
    expect(error.message).toBe(
      'GET /v1/shops/12/products/abc.json failed with HTTP 404: Not found. ' +
        `Request id: 1789735516@${CORRELATION_ID}`,
    );
    expect(error.hint).toContain('Check the id');
  });

  it('keeps a JSON-encoded reason as a string', () => {
    const body = {
      status: 'error',
      code: 8103,
      message: 'Validation failed.',
      errors: { reason: '{"zip":["The zip field is required."]}', code: 8103 },
    };
    const error = httpError(PRODUCTS, 400, { value: body }, null);
    expect(error.reason).toBe('{"zip":["The zip field is required."]}');
    expect(error.message).toBe(
      'POST /v1/shops/12/products.json failed with HTTP 400 (code 8103): Validation failed. ' +
        'Reason: {"zip":["The zip field is required."]}',
    );
  });

  it('serialises an errors object without a reason and uses its code', () => {
    const body = { message: 'Invalid data.', errors: { code: 8150, title: ['Too long'] } };
    const error = httpError(PRODUCTS, 422, { value: body }, null);
    expect(error.code).toBe(8150);
    expect(error.reason).toBe('{"code":8150,"title":["Too long"]}');
  });

  it('marks a body that is not JSON and keeps the correlation id', () => {
    const error = httpError(PRODUCT, 502, undefined, CORRELATION_ID);
    expect(error).toMatchObject({ status: 502, printifyMessage: undefined, reason: undefined });
    expect(error.message).toBe(
      'GET /v1/shops/12/products/abc.json failed with HTTP 502 (non-JSON response). ' +
        `Request id: ${CORRELATION_ID}`,
    );
    expect(error.hint).toBe('Printify had a server error. Try again in a moment.');
  });

  it('ignores JSON that is not an object, fields of the wrong type and empty text', () => {
    for (const value of [['a'], 'text', 42, null, { code: '8203', message: 7, error: '  ' }]) {
      const error = httpError(PRODUCT, 400, { value }, null);
      expect(error).toMatchObject({
        code: undefined,
        printifyMessage: undefined,
        reason: undefined,
      });
      expect(error.message).toBe('GET /v1/shops/12/products/abc.json failed with HTTP 400');
    }
  });

  it('removes one trailing period from each piece of the message', () => {
    const body = { message: 'Validation failed.', errors: { reason: 'Title is too long.' } };
    expect(httpError(PRODUCTS, 400, { value: body }, 'id-1').message).toBe(
      'POST /v1/shops/12/products.json failed with HTTP 400: Validation failed. ' +
        'Reason: Title is too long. Request id: id-1',
    );
  });

  it('cuts long text to 1000 characters', () => {
    const body = { message: 'm'.repeat(1500), errors: { reason: 'r'.repeat(1000) } };
    const error = httpError(PRODUCTS, 400, { value: body }, null);
    expect(error.printifyMessage).toBe(`${'m'.repeat(999)}…`);
    expect(error.reason).toBe('r'.repeat(1000));
  });

  it('redacts before cutting, so no part of a secret survives', () => {
    const secret = 'Tok-Secret-7Q2w9e';
    const body = { errors: { reason: `${'x'.repeat(995)}${secret}` } };
    const error = httpError(PRODUCTS, 400, { value: body }, null, (text) =>
      text.replaceAll(secret, '[redacted]'),
    );
    expect(error.reason).toBe(`${'x'.repeat(995)}[red…`);
    expect(error.reason).not.toContain('Tok-');
  });

  it('applies the redaction to every text field and always redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
    const body = {
      message: 'Bad value Jane Doe',
      errors: { reason: `token ${jwt} for Jane Doe` },
      request_id: 'Jane Doe',
    };
    const error = httpError(PRODUCTS, 400, { value: body }, null, (text) =>
      text.replaceAll('Jane Doe', '[redacted]'),
    );
    const output = [
      error.message,
      error.printifyMessage,
      error.reason,
      error.requestId,
      inspect(error),
    ];
    for (const text of output) {
      expect(text).not.toContain('Jane Doe');
      expect(text).not.toContain(jwt);
    }
    expect(error.reason).toBe('token [redacted] for [redacted]');
  });
});

describe('timeoutError', () => {
  it('names the timeout and warns that a POST may have gone through', () => {
    const error = timeoutError(PRODUCTS, 30000);
    expect(error).toMatchObject({ kind: 'timeout', status: undefined });
    expect(error.message).toBe('POST /v1/shops/12/products.json timed out after 30000 ms');
    expect(error.hint).toContain('The request may still have gone through');
  });
});

describe('networkError', () => {
  it('keeps the cause and names the innermost system error code', () => {
    const system = Object.assign(new Error('getaddrinfo ENOTFOUND api.printify.com'), {
      code: 'ENOTFOUND',
    });
    const cause = new TypeError('fetch failed', { cause: system });
    const error = networkError(PRODUCT, cause);
    expect(error).toMatchObject({ kind: 'network', status: undefined });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe(
      'GET /v1/shops/12/products/abc.json failed: could not reach Printify (ENOTFOUND)',
    );
    expect(error.hint).toBe(
      'Printify could not be reached. Check the network connection and try again.',
    );
  });

  it('leaves out the code when no error in the chain has one', () => {
    expect(networkError(PRODUCT, new TypeError('fetch failed')).message).toBe(
      'GET /v1/shops/12/products/abc.json failed: could not reach Printify',
    );
    expect(networkError(PRODUCT, 'not an error').message).toBe(
      'GET /v1/shops/12/products/abc.json failed: could not reach Printify',
    );
  });
});

describe('invalidResponseError', () => {
  it('names the problem and has no hint', () => {
    const error = invalidResponseError(PRODUCT, 200, 'a body that is not JSON');
    expect(error).toMatchObject({ kind: 'invalid_response', status: 200, hint: undefined });
    expect(error.message).toBe(
      'GET /v1/shops/12/products/abc.json returned HTTP 200 with a body that is not JSON',
    );
  });
});
