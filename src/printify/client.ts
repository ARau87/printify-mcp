import { PACKAGE_VERSION } from '../package-info.js';
import { redactValues } from '../redact.js';
import type { Secret } from '../secret.js';
import {
  PrintifyApiError,
  httpError,
  invalidResponseError,
  networkError,
  parseJson,
  timeoutError,
  type Route,
} from './errors.js';
import type { ApiPath } from './path.js';
import type { HttpMethod } from './types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface PrintifyClientOptions {
  token: Secret;
  /** `config.apiBaseUrl`: no trailing slash and no API version. */
  baseUrl: string;
  /** Defaults to the global `fetch`. Tests and #6 pass a fake; #4 wraps it. */
  fetch?: typeof globalThis.fetch;
  /** Default timeout for every request, in milliseconds. */
  timeoutMs?: number;
}

/** Query parameters. `undefined` values are left out. */
export type Query = Readonly<Record<string, string | number | boolean | undefined>>;

export interface RequestOptions {
  query?: Query;
  /** Sent as JSON. Not allowed with GET. */
  body?: unknown;
  /** The caller's cancellation signal, e.g. the MCP request's. */
  signal?: AbortSignal;
  /** Overrides the client's default timeout, e.g. for uploads by URL. */
  timeoutMs?: number;
}

export interface PrintifyClient {
  /**
   * Sends one request. Resolves to the parsed JSON body, or `undefined` when the body is empty.
   * Rejects with a `PrintifyApiError`, or with the caller's abort reason when `signal` aborts.
   */
  request(method: HttpMethod, path: ApiPath, options?: RequestOptions): Promise<unknown>;
}

/**
 * Creates a client. It starts no timers and opens no connections until the first request. Throws
 * a `TypeError` if the token contains characters that cannot be sent in an HTTP header.
 */
export function createPrintifyClient(options: PrintifyClientOptions): PrintifyClient {
  // The only reveal() in the codebase: the header needs the token, and errors must scrub it.
  const token = options.token.reveal();
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': `printify-mcp/${PACKAGE_VERSION}`,
    'Content-Type': 'application/json;charset=utf-8',
  };
  try {
    new Headers(headers);
  } catch {
    throw new TypeError(
      'The Printify token contains characters that cannot be sent in an HTTP header',
    );
  }

  return {
    async request(method, path, { query, body, signal, timeoutMs = defaultTimeoutMs } = {}) {
      // fetch would reject this with a TypeError that looks like a network error.
      if (method === 'GET' && body !== undefined) {
        throw new TypeError('A GET request cannot have a body');
      }
      // Serialised before the try: a body that cannot be JSON-encoded (e.g. a BigInt) must not
      // be reported as a network error.
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const route: Route = { method, path };
      const fetch = options.fetch ?? globalThis.fetch;
      const timeout = AbortSignal.timeout(timeoutMs);

      let response: Response;
      let text: string;
      try {
        response = await fetch(buildUrl(options.baseUrl, path, query), {
          method,
          headers: { ...headers },
          body: payload,
          signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
        });
        // The timeout covers the body too, so a stalled download still ends on time.
        text = await response.text();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof PrintifyApiError) throw error;
        if (timeout.aborted) throw timeoutError(route, timeoutMs);
        throw networkError(route, error);
      }

      if (!response.ok) {
        const secrets = [token, ...addressValues(body)];
        throw httpError(
          route,
          response.status,
          parseJson(text),
          response.headers.get('x-pfy-correlation-id'),
          (value) => redactValues(value, secrets),
        );
      }
      if (text.trim() === '') return undefined;
      // Parsed whatever the Content-Type says: openapi.json labels some v2 JSON octet-stream.
      const json = parseJson(text);
      if (json === undefined) {
        throw invalidResponseError(route, response.status, 'a body that is not JSON');
      }
      return json.value;
    },
  };
}

/** Concatenates rather than using `new URL(path, base)`, which would drop a proxy path prefix. */
function buildUrl(baseUrl: string, path: ApiPath, query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.append(key, String(value));
  }
  const search = params.toString();
  return search === '' ? `${baseUrl}${path}` : `${baseUrl}${path}?${search}`;
}

/** Every string under an `address_to` key in a request body, at any depth. */
function addressValues(value: unknown, inAddress = false): string[] {
  if (typeof value === 'string') return inAddress ? [value] : [];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    addressValues(item, inAddress || key === 'address_to'),
  );
}
