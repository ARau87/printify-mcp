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
import { MAX_WAIT_MS, createRateLimiter, type RateLimiter } from './rate-limit.js';
import { MAX_ATTEMPTS, retryDelayMs, shouldRetry, type Outcome } from './retry.js';
import { sleep } from './sleep.js';
import type { HttpMethod } from './types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface PrintifyClientOptions {
  token: Secret;
  /** `config.apiBaseUrl`: no trailing slash and no API version. */
  baseUrl: string;
  /** Defaults to the global `fetch`. Tests and #6 pass a fake, which sits below the retries. */
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
   * Sends one request, waiting for a rate-limit slot before each attempt and retrying the failures
   * that are safe to retry. Resolves to the parsed JSON body, or `undefined` when the body is
   * empty. Rejects with a `PrintifyApiError`, or with the caller's abort reason when `signal`
   * aborts.
   */
  request(method: HttpMethod, path: ApiPath, options?: RequestOptions): Promise<unknown>;
}

/**
 * Creates a client with its own rate limiter. It starts no timers and opens no connections until
 * the first request. Throws a `TypeError` if the token contains characters that cannot be sent in
 * an HTTP header.
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
  const limiter = createRateLimiter();

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
      const url = buildUrl(options.baseUrl, path, query);
      const timeout = AbortSignal.timeout(timeoutMs);
      // Covers every attempt, wait and backoff, so a call never takes longer than its timeout.
      const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal]);

      let response: Response;
      let text: string;
      try {
        ({ response, text } = await send(limiter, route, combined, () =>
          fetch(url, { method, headers: { ...headers }, body: payload, signal: combined }),
        ));
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

interface Received {
  response: Response;
  text: string;
}

/**
 * Sends a request up to `MAX_ATTEMPTS` times, taking a rate-limit slot before each attempt.
 * Resolves to the last response with its body read, or rejects with the last error. An abort, and
 * a `PrintifyApiError` such as the limiter's fail-fast error, end it at once.
 */
async function send(
  limiter: RateLimiter,
  route: Route,
  signal: AbortSignal,
  sendOnce: () => Promise<Response>,
): Promise<Received> {
  for (let attempt = 1; ; attempt += 1) {
    await limiter.acquire(route, signal);
    let received: Received | undefined;
    let failure: unknown;
    try {
      const response = await sendOnce();
      // The signal covers the body too, so a stalled download still ends on time. Reading every
      // body in full also frees the connection of a response that is retried.
      received = { response, text: await response.text() };
    } catch (error) {
      if (signal.aborted || error instanceof PrintifyApiError) throw error;
      failure = error;
    }
    const outcome: Outcome =
      received === undefined ? 'network' : { status: received.response.status };
    if (attempt < MAX_ATTEMPTS && shouldRetry(route.method, outcome)) {
      const delay = retryDelayMs(attempt, received?.response.headers.get('retry-after') ?? null);
      if (delay <= MAX_WAIT_MS) {
        await sleep(delay, signal);
        continue;
      }
    }
    if (received === undefined) throw failure;
    return received;
  }
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
