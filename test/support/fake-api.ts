import { expect } from 'vitest';
import type { HttpMethod } from '../../src/printify/types.js';

const METHODS: readonly string[] = ['GET', 'POST', 'PUT', 'DELETE'];

/** A route key: the method, one space, and the exact pathname. */
export type RouteKey = `${HttpMethod} /${string}`;

export interface FakeRequest {
  method: string;
  /** The pathname only: no base URL and no query. */
  path: string;
  query: Record<string, string>;
  headers: Headers;
  /** The parsed JSON body, the raw text when it is not JSON, or `undefined` when there was none. */
  body: unknown;
  /** The signal the client passed to `fetch`, not the `Request` copy of it. */
  signal: AbortSignal;
}

/** Answers one request. Returning anything but a `Response` sends it as a 200 JSON body. */
export type Responder = (request: FakeRequest) => unknown;

/** Anything sent as a JSON body. `object`, so a fixture declared as an interface is assignable. */
export type JsonBody = object | string | number | boolean | null;

/**
 * What a route answers with, discriminated at runtime: a `Response` is used as is, a `Responder`
 * is called, and anything else is sent as a 200 JSON body. `Responder` is a member of the union
 * rather than the whole type being `unknown`, because only a union with a function member gives a
 * route written as `(request) => …` a typed parameter.
 */
export type Route = Response | Responder | JsonBody;

export type Routes = Readonly<Record<RouteKey, Route>>;

// Every member is a function-typed property rather than a method, because destructuring a method
// off the object trips @typescript-eslint/unbound-method.
export interface FakeApi {
  fetch: typeof globalThis.fetch;
  requests: readonly FakeRequest[];
  /** Requests that matched no route. */
  unmatched: readonly FakeRequest[];
  /** Asserts exactly one matching request and returns it. */
  expectRequest: (method: HttpMethod, path: string, body?: unknown) => FakeRequest;
  /**
   * Returns the unmatched requests and forgets them, so the teardown check passes. Only a test
   * that means to provoke a miss calls this.
   */
  takeUnmatched: () => readonly FakeRequest[];
  /** Throws, naming them, when any request matched no route. The teardown hook calls this. */
  assertNoUnmatched: () => void;
}

/** A JSON response. The default status is 200. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** A plain-text response, for the paths that must cope with a body that is not JSON. */
export function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

/** An empty response, as a delete returns. */
export function empty(status = 204): Response {
  return new Response(null, { status });
}

/** Answers the nth request with the nth reply, and every later one with the last. */
export function inTurn(...replies: readonly Route[]): Responder {
  if (replies.length === 0) throw new TypeError('inTurn needs at least one reply');
  let count = 0;
  return (request) => {
    const reply = replies[Math.min(count, replies.length - 1)];
    count += 1;
    // Unreachable: the index is clamped and the list is not empty. Route excludes undefined.
    if (reply === undefined) throw new TypeError('inTurn ran out of replies');
    return resolveRoute(reply, request);
  };
}

/** Rejects, the way `fetch` does when the request never reached a server. */
export function fails(cause: Error = new TypeError('fetch failed')): Responder {
  return () => Promise.reject(cause);
}

/** Answers only once the request's signal aborts, like a server that never replies. */
export function never(): Responder {
  return ({ signal }) =>
    new Promise<Response>((_resolve, reject) => {
      const fail = () => {
        reject(signal.reason as Error);
      };
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail);
    });
}

/**
 * A fake `fetch` for `createPrintifyClient`, answering from `routes` and recording every request.
 * A request that matches no route is recorded in `unmatched` and answered with 418, which carries
 * no hint and is never retried, so the tool result names the missing route.
 */
export function createFakeApi(routes: Routes = {}): FakeApi {
  for (const key of Object.keys(routes)) checkRouteKey(key);
  const table: Readonly<Record<string, Route>> = routes;
  const requests: FakeRequest[] = [];
  const unmatched: FakeRequest[] = [];

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const sent: FakeRequest = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body: parseBody(await request.text()),
      // Request copies the signal, so keep the one the client passed.
      signal: init?.signal ?? request.signal,
    };
    requests.push(sent);
    const key = `${sent.method} ${sent.path}`;
    const route = table[key];
    // Route excludes undefined, so a missing value means the route was never declared.
    if (route === undefined) {
      unmatched.push(sent);
      return json({ error: noRouteMessage(key, Object.keys(table)) }, 418);
    }
    return resolveRoute(route, sent);
  };

  return {
    fetch,
    requests,
    unmatched,
    expectRequest(method, path, body) {
      const matching = requests.filter((sent) => sent.method === method && sent.path === path);
      const only = matching[0];
      if (matching.length !== 1 || only === undefined) {
        throw new Error(
          `expected exactly one "${method} ${path}", got ${String(matching.length)}. ` +
            `Recorded: ${describeRequests(requests)}`,
        );
      }
      if (body !== undefined) expect(only.body).toMatchObject(body as object);
      return only;
    },
    takeUnmatched() {
      return unmatched.splice(0, unmatched.length);
    },
    assertNoUnmatched() {
      if (unmatched.length === 0) return;
      throw new Error(
        `the test sent ${String(unmatched.length)} request(s) that matched no route: ` +
          describeRequests(unmatched),
      );
    },
  };
}

/** Cloned, so a route may answer more than one request. */
async function resolveRoute(route: Route, request: FakeRequest): Promise<Response> {
  const value = typeof route === 'function' ? await (route as Responder)(request) : route;
  return value instanceof Response ? value.clone() : json(value);
}

function parseBody(body: string): unknown {
  if (body === '') return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function checkRouteKey(key: string): void {
  const parts = key.split(' ');
  const [method, path] = parts;
  if (parts.length !== 2 || method === undefined || !METHODS.includes(method)) {
    throw new TypeError(
      `Invalid route key "${key}": use "<METHOD> /path", e.g. "GET /v1/shops.json". ` +
        `Methods: ${METHODS.join(', ')}`,
    );
  }
  if (path === undefined || !path.startsWith('/')) {
    throw new TypeError(`Invalid route key "${key}": the path must start with "/"`);
  }
}

function noRouteMessage(key: string, declared: readonly string[]): string {
  return (
    `printify-mcp test harness: no route for ${key}. Declared routes: ` +
    (declared.length === 0 ? '(none)' : declared.join(', '))
  );
}

function describeRequests(requests: readonly FakeRequest[]): string {
  if (requests.length === 0) return '(none)';
  return requests.map((sent) => `${sent.method} ${sent.path}`).join(', ');
}
