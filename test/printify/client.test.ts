import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PACKAGE_VERSION } from '../../src/package-info.js';
import {
  DEFAULT_TIMEOUT_MS,
  createPrintifyClient,
  type PrintifyClientOptions,
} from '../../src/printify/client.js';
import { PrintifyApiError } from '../../src/printify/errors.js';
import { apiPath } from '../../src/printify/path.js';
import { Secret } from '../../src/secret.js';
import { apiError, rejection } from './helpers.js';

const TOKEN = 'Tok-client-8H7g6F5e';
const BASE_URL = 'https://api.printify.com';

interface SentRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  signal: AbortSignal;
}

type Responder = (request: SentRequest) => Response | Promise<Response>;

/** A fake `fetch` that records every request and answers with `respond`. */
function fakeFetch(respond: Responder) {
  const requests: SentRequest[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    const sent = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      // Request copies the signal, so keep the original the client passed.
      signal: init?.signal ?? request.signal,
    };
    requests.push(sent);
    return respond(sent);
  });
  return { fetch, requests };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function client(respond: Responder, options: Partial<PrintifyClientOptions> = {}) {
  const fake = fakeFetch(respond);
  const printify = createPrintifyClient({
    token: new Secret(TOKEN),
    baseUrl: BASE_URL,
    fetch: fake.fetch,
    ...options,
  });
  return { printify, ...fake };
}

/** Rejects once the request's signal aborts, or at once if it already has, like the real fetch. */
const neverAnswer: Responder = ({ signal }) =>
  new Promise((_, reject) => {
    const fail = () => {
      reject(signal.reason as Error);
    };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail);
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createPrintifyClient: successful requests', () => {
  it('sends the headers and resolves to the parsed body', async () => {
    const { printify, requests } = client(() => json([{ id: 12, title: 'My shop' }]));
    await expect(printify.request('GET', apiPath`/v1/shops.json`)).resolves.toEqual([
      { id: 12, title: 'My shop' },
    ]);
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe('https://api.printify.com/v1/shops.json');
    expect(request?.method).toBe('GET');
    expect(request?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(request?.headers.get('user-agent')).toBe(`printify-mcp/${PACKAGE_VERSION}`);
    expect(request?.headers.get('content-type')).toBe('application/json;charset=utf-8');
    expect(request?.body).toBe('');
  });

  it('keeps a proxy path prefix and encodes the query, leaving out undefined values', async () => {
    const { printify, requests } = client(() => json({}), {
      baseUrl: 'https://proxy.example.com/printify',
    });
    await printify.request('GET', apiPath`/v1/shops/${12}/orders.json`, {
      query: { status: 'on-hold', sku: 'A&B 1', page: 2, archived: false, limit: undefined },
    });
    expect(requests[0]?.url).toBe(
      'https://proxy.example.com/printify/v1/shops/12/orders.json' +
        '?status=on-hold&sku=A%26B+1&page=2&archived=false',
    );
  });

  it('sends a body as JSON', async () => {
    const { printify, requests, fetch } = client(() => json({ id: 'abc' }));
    const body = { title: 'Shirt', tags: ['cat'] };
    await expect(
      printify.request('POST', apiPath`/v1/shops/${12}/products.json`, { body }),
    ).resolves.toEqual({ id: 'abc' });
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.body).toBe('{"title":"Shirt","tags":["cat"]}');
    // Pins the shape #4 wraps: a URL string and a plain init object.
    expect(fetch).toHaveBeenCalledWith(
      'https://api.printify.com/v1/shops/12/products.json',
      expect.objectContaining({
        method: 'POST',
        body: '{"title":"Shirt","tags":["cat"]}',
        signal: expect.any(AbortSignal) as AbortSignal,
      }),
    );
  });

  it.each([
    ['a 204', () => new Response(null, { status: 204 })],
    ['an empty 200', () => new Response('', { status: 200 })],
    ['a whitespace-only 200', () => new Response(' \n', { status: 200 })],
  ])('resolves to undefined for %s', async (_, respond) => {
    const { printify } = client(respond);
    await expect(
      printify.request('DELETE', apiPath`/v1/shops/${12}/products/${'abc'}.json`),
    ).resolves.toBeUndefined();
  });

  it('parses JSON whatever the Content-Type says', async () => {
    const { printify } = client(
      () =>
        new Response('{"data":[]}', { headers: { 'Content-Type': 'application/octet-stream' } }),
    );
    await expect(
      printify.request(
        'GET',
        apiPath`/v2/catalog/blueprints/${6}/print_providers/${99}/shipping.json`,
      ),
    ).resolves.toEqual({ data: [] });
  });

  it('uses the global fetch by default', async () => {
    // The client is created before the global is stubbed, so this proves the `fetch` option is
    // read on every request rather than captured once at construction.
    const printify = createPrintifyClient({ token: new Secret(TOKEN), baseUrl: BASE_URL });
    const fake = fakeFetch(() => json({ ok: true }));
    vi.stubGlobal('fetch', fake.fetch);
    await expect(printify.request('GET', apiPath`/v1/shops.json`)).resolves.toEqual({ ok: true });
    expect(fake.requests).toHaveLength(1);
  });

  it('gives each request its own headers object', async () => {
    const { printify, fetch } = client(() => json({}));
    await printify.request('GET', apiPath`/v1/shops.json`);
    await printify.request('GET', apiPath`/v1/shops.json`);
    expect(fetch.mock.calls).toHaveLength(2);
    const firstHeaders = fetch.mock.calls[0]?.[1]?.headers;
    const secondHeaders = fetch.mock.calls[1]?.[1]?.headers;
    expect(firstHeaders).not.toBe(secondHeaders);
  });

  it('times out after 30 seconds by default', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { printify } = client(() => json({}));
    await printify.request('GET', apiPath`/v1/shops.json`);
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(timeout).toHaveBeenCalledWith(30_000);
  });
});

describe('createPrintifyClient: construction', () => {
  it('throws if the token cannot be sent in an HTTP header', () => {
    const fake = fakeFetch(() => json({}));
    let error: unknown;
    try {
      createPrintifyClient({
        token: new Secret('Tok-bad\r\nline'),
        baseUrl: BASE_URL,
        fetch: fake.fetch,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(error).toMatchObject({
      message: 'The Printify token contains characters that cannot be sent in an HTTP header',
    });
    expect(inspect(error)).not.toContain('Tok-bad');
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});

describe('createPrintifyClient: failures', () => {
  it('rejects a GET with a body before sending anything', async () => {
    const { printify, fetch } = client(() => json({}));
    const error = await rejection(
      printify.request('GET', apiPath`/v1/shops.json`, { body: { a: 1 } }),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(PrintifyApiError);
    expect(error).toMatchObject({ message: 'A GET request cannot have a body' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a body that cannot be serialised before sending anything', async () => {
    const { printify, fetch } = client(() => json({}));
    const error = await rejection(
      printify.request('POST', apiPath`/v1/shops/${12}/products.json`, { body: { n: 1n } }),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(PrintifyApiError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('turns an error response into a PrintifyApiError', async () => {
    const { printify } = client(() =>
      json(
        {
          status: 'error',
          code: 8203,
          message: 'Validation failed.',
          errors: { reason: 'Image has low quality', code: 8203 },
        },
        400,
        { 'x-pfy-correlation-id': 'corr-1' },
      ),
    );
    const error = await apiError(
      printify.request('POST', apiPath`/v1/shops/${12}/products.json`, { body: {} }),
    );
    expect(error).toMatchObject({
      kind: 'http',
      method: 'POST',
      path: '/v1/shops/12/products.json',
      status: 400,
      code: 8203,
      reason: 'Image has low quality',
      requestId: 'corr-1',
    });
    expect(error.hint).toContain('The image resolution is too low');
  });

  it('marks an HTML error page as a non-JSON response', async () => {
    const { printify } = client(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const error = await apiError(printify.request('GET', apiPath`/v1/shops.json`));
    expect(error).toMatchObject({ kind: 'http', status: 502 });
    expect(error.message).toBe('GET /v1/shops.json failed with HTTP 502 (non-JSON response)');
  });

  it('rejects a 2xx body that is not JSON', async () => {
    const { printify } = client(() => new Response('<html>Welcome</html>', { status: 200 }));
    const error = await apiError(printify.request('GET', apiPath`/v1/shops.json`));
    expect(error).toMatchObject({ kind: 'invalid_response', status: 200 });
    expect(error.message).toBe('GET /v1/shops.json returned HTTP 200 with a body that is not JSON');
  });

  it('times out while waiting for the response', async () => {
    const { printify } = client(neverAnswer, { timeoutMs: 20 });
    const error = await apiError(printify.request('GET', apiPath`/v1/shops.json`));
    expect(error).toMatchObject({ kind: 'timeout', status: undefined });
    expect(error.message).toBe('GET /v1/shops.json timed out after 20 ms');
  });

  it('times out while reading a stalled body', async () => {
    const { printify } = client(
      ({ signal }) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":'));
              signal.addEventListener('abort', () => {
                controller.error(signal.reason);
              });
            },
          }),
        ),
      { timeoutMs: 20 },
    );
    const error = await apiError(printify.request('GET', apiPath`/v1/uploads.json`));
    expect(error.kind).toBe('timeout');
  });

  it('lets a request override the default timeout', async () => {
    const { printify } = client(neverAnswer, { timeoutMs: 60_000 });
    const error = await apiError(
      printify.request('POST', apiPath`/v1/uploads/images.json`, { body: {}, timeoutMs: 20 }),
    );
    expect(error.message).toBe('POST /v1/uploads/images.json timed out after 20 ms');
    expect(error.hint).toContain('The request may still have gone through');
  });

  it("re-throws the caller's abort reason unchanged", async () => {
    const { printify } = client(neverAnswer);
    const controller = new AbortController();
    const reason = new Error('tool call cancelled');
    const pending = printify.request('GET', apiPath`/v1/shops.json`, {
      signal: controller.signal,
    });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('re-throws the reason of a signal that aborted before the request', async () => {
    const { printify } = client(neverAnswer);
    const reason = new Error('already cancelled');
    await expect(
      printify.request('GET', apiPath`/v1/shops.json`, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
  });

  it('re-throws a PrintifyApiError thrown by fetch unchanged', async () => {
    const rateLimited = new PrintifyApiError('GET /v1/shops.json was not sent: rate limit', {
      kind: 'http',
      method: 'GET',
      path: '/v1/shops.json',
      status: 429,
    });
    const { printify } = client(() => Promise.reject(rateLimited));
    await expect(printify.request('GET', apiPath`/v1/shops.json`)).rejects.toBe(rateLimited);
  });

  it('turns a rejected fetch into a network error that keeps the cause', async () => {
    const system = Object.assign(new Error('getaddrinfo ENOTFOUND api.printify.com'), {
      code: 'ENOTFOUND',
    });
    const cause = new TypeError('fetch failed', { cause: system });
    const { printify } = client(() => Promise.reject(cause));
    const error = await apiError(printify.request('GET', apiPath`/v1/shops.json`));
    expect(error).toMatchObject({ kind: 'network', status: undefined });
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('GET /v1/shops.json failed: could not reach Printify (ENOTFOUND)');
  });
});

describe('createPrintifyClient: redaction', () => {
  it('never puts the token, a JWT, the address, the base URL path or the query in an error', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
    const address = {
      first_name: 'Johanna',
      last_name: 'Doe-Smith',
      email: 'johanna@example.com',
      phone: '+49 30 1234567',
      country: 'DE',
      region: 'BE',
      address1: 'Invalidenstrasse 116',
      city: 'Berlin',
      zip: '10115',
    };
    const addressText = Object.values(address).join(' ');
    // A gift's shipping address, nested inside the order body, still counts as an address_to.
    const gift = { address_to: { first_name: 'Konstantin' } };
    const echoed = `${TOKEN} ${jwt} ${addressText} ${gift.address_to.first_name}`;
    const { printify } = client(
      () =>
        json(
          {
            status: 'error',
            code: 8103,
            message: `Validation failed for ${echoed}`,
            errors: { reason: `{"zip":["${echoed} ${addressText.toUpperCase()}"]}`, code: 8103 },
            request_id: echoed,
          },
          400,
        ),
      { baseUrl: 'https://proxy.example.com/secret-prefix' },
    );
    const error = await apiError(
      printify.request('POST', apiPath`/v1/shops/${12}/orders.json`, {
        query: { note: 'query-secret' },
        body: { external_id: 'o-1', line_items: [], address_to: address, gift },
      }),
    );
    const outputs = [
      error.message,
      error.printifyMessage,
      error.reason,
      error.requestId,
      inspect(error),
      JSON.stringify(error),
    ];
    const secrets = [
      TOKEN,
      jwt,
      ...Object.values(address).filter((value) => value.length >= 3),
      gift.address_to.first_name,
      'secret-prefix',
      'query-secret',
    ];
    for (const output of outputs) {
      for (const secret of secrets) {
        expect(output?.toLowerCase()).not.toContain(secret.toLowerCase());
      }
    }
    expect(error.reason).toContain('[redacted]');
  });
});
