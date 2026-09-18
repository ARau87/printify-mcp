# Printify HTTP client — design

- **Issue:** [#3 Printify HTTP client with typed errors and pagination](https://github.com/ARau87/printify-mcp/issues/3)
- **Date:** 2026-09-18
- **Status:** approved

## Goal

Every tool talks to the same REST API with the same authentication, headers, error bodies and
pagination. A small `fetch`-based client in `src/printify/` handles all of that once. It keeps the
tools small, and it turns every failure into one typed error with a hint, so the AI assistant can
tell the user what went wrong and what to do next.

## API facts this design relies on

Checked on 2026-09-18 against the HTML docs at https://developers.printify.com/ (last updated
Oct 3 2024) and with unauthenticated requests to the real API. `openapi.json` was used only as a
cross-check.

- **Base URLs:** `https://api.printify.com/v1/` and `https://api.printify.com/v2/`. Every path ends
  in `.json` except `POST /v1/shops/{shop_id}/webhooks/{webhook_id}/simulate`. v2 has five GET
  endpoints, all under `/v2/catalog/blueprints/{blueprint_id}/print_providers/{print_provider_id}/`,
  and none of them is paginated.
- **Headers:** "Authorization: Bearer {token}". "All requests must also specify a User-Agent
  header." The content type "should be: application/json;charset=utf-8".
- **Error bodies:**
  - The HTML docs show one shape, and only for 400 responses:

    ```json
    {
      "status": "error",
      "code": 8203,
      "message": "Validation failed.",
      "errors": { "reason": "Image has low quality", "code": 8203 }
    }
    ```

    `errors` is one object, and `reason` can itself be a JSON-encoded string:
    `"{\"zip\":[\"The zip field is required.\"]}"` (code 8103).

  - The HTML docs show no body for 401, 404 or 429. A probe returned
    `{"error":"Unauthenticated","request_id":"1789735516@e08829df-…"}` for a missing or invalid
    token and `{"error":"Not found","request_id":"…"}` for an unknown route.
  - Every probed response carried an `x-pfy-correlation-id` header. `request_id` is
    `<timestamp>@<correlation id>`.
- **Error codes:** the docs have no code table. They show 8203 (image has low quality), 8201 (file
  too large or wrong format), 10300 (image download failed) and 8103 (address validation), all
  with HTTP 400. Only `openapi.json` shows 8503: a 409 for an order whose `external_id` already
  exists.
- **Pagination:** products and uploads return the Laravel envelope: `current_page`, `data`,
  `first_page_url`, `from`, `last_page`, `last_page_url`, `next_page_url`, `path`, `per_page`,
  `prev_page_url`, `to`, `total`. The URLs are relative (`"/?page=2"`). The orders examples show
  only `current_page` and `data`. `limit` defaults to 10 everywhere; the maximum is 50 for
  products, 10 for orders and 100 for uploads. Shops, webhooks and the catalog are not paginated.
- **Rate limits:** no `Retry-After` or `X-RateLimit-*` headers are documented.
- **Scopes:** `shops.read`, `catalog.read`, `products.read`, `products.write`, `orders.read`,
  `orders.write`, `webhooks.read`, `webhooks.write`, `uploads.read`, `uploads.write`,
  `print_providers.read`. The docs do not say which endpoint needs which scope, and there is no
  `user.info`.
- **Tokens:** Personal Access Tokens are valid for one year.
- **Empty results:** delete product, archive upload, disconnect shop, publish and the publishing
  status calls return `{}`. The docs list 204 as a status but show no endpoint that returns it.

## Decisions that differ from the issue

1. **`requestId` falls back to the `x-pfy-correlation-id` header.** The documented 400 body has no
   `request_id`, so without the fallback most errors would have no id to quote to Printify
   support.
2. **A path encoder, `apiPath`, is added.** Ids reach the client from the model. Without encoding,
   a product id such as `../../connection` would turn a product DELETE into a shop disconnect.
3. **More hints than the issue lists:** 404, 429, 5xx, timeouts and network errors also get one.
4. **Customer addresses are scrubbed automatically.** Every string under an `address_to` key in the
   request body is removed from the error, in case Printify echoes it back in a reason.
5. **`PRINTIFY_API_BASE_URL` may not end in `/v1` or `/v2`.** The client adds the version itself.
   This was deferred from #2.
6. **The pagination envelope is read loosely.** Only `current_page` and `data` are required,
   because the orders examples show nothing else.

## Files

```
src/
  redact.ts                # new: redactJwts (moved from config.ts) and redactValues
  config.ts                # rejects /v1 and /v2, imports redactJwts
  printify/
    path.ts                # apiPath tagged template, ApiPath type
    errors.ts              # PrintifyApiError, error-body parsing
    hints.ts               # hint table, scope guess
    client.ts              # createPrintifyClient, request pipeline
    pagination.ts          # PAGE_LIMITS, fetchPage, Page
test/
  redact.test.ts
  config.test.ts           # updated
  printify/
    path.test.ts
    hints.test.ts
    client.test.ts
    pagination.test.ts
```

No new dependencies. The vitest glob `test/**/*.test.ts` already includes `test/printify/`. There
is no barrel file: callers import from the module they need.

## Paths

```ts
type ApiPath = string & { readonly __brand: 'ApiPath' };

function apiPath(strings: TemplateStringsArray, ...values: (string | number)[]): ApiPath;

apiPath`/v1/shops/${shopId}/products/${productId}.json`;
```

- `ApiPath` is a branded string, and `apiPath` is the only way to make one. `request` and
  `fetchPage` accept only an `ApiPath`, so a path built by plain concatenation does not
  type-check.
- Each value is converted with `String()` and encoded with `encodeURIComponent`, so `/`, `?`, `#`
  and spaces cannot change the route.
- A value that is empty, `.` or `..` throws a `TypeError`: encoding leaves dots alone, and the URL
  parser would resolve them as dot segments.
- The literal text must start with `/v1/` or `/v2/`, or `apiPath` throws a `TypeError`.
- These throws are programming errors. Tools validate ids with zod before they build a path (#5).

## Client

```ts
interface PrintifyClientOptions {
  token: Secret;
  /** `config.apiBaseUrl`: no trailing slash, no version. */
  baseUrl: string;
  /** Defaults to `globalThis.fetch`. Tests and #6 pass a fake; #4 wraps it. */
  fetch?: typeof globalThis.fetch;
  /** Default timeout for every request. Defaults to 30 000 ms. */
  timeoutMs?: number;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface RequestOptions {
  /** `undefined` values are dropped. */
  query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** Sent as JSON. Not allowed with GET. */
  body?: unknown;
  /** The caller's cancellation signal, e.g. the MCP request's. */
  signal?: AbortSignal;
  /** Overrides the client's default, e.g. for uploads by URL. */
  timeoutMs?: number;
}

interface PrintifyClient {
  request(method: HttpMethod, path: ApiPath, options?: RequestOptions): Promise<unknown>;
}

function createPrintifyClient(options: PrintifyClientOptions): PrintifyClient;
```

### Request

1. A `body` on a GET throws a `TypeError` before anything is sent. `fetch` would reject it with a
   `TypeError` that would otherwise look like a network error.
2. The URL is `${baseUrl}${path}`, plus `?` and a `URLSearchParams` string when the query has
   values. It is built by concatenation: `new URL(path, baseUrl)` would drop a proxy path prefix
   such as `/printify`.
3. Headers, on every request:
   - `Authorization: Bearer <token>`. This is the only call to `token.reveal()` in the codebase.
   - `User-Agent: printify-mcp/<version>`, with the version from `package-info.ts`.
   - `Content-Type: application/json;charset=utf-8`.
4. The body is `JSON.stringify(body)` when `body` is not `undefined`.
5. `fetch` gets `signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), callerSignal])`, or just
   the timeout signal when the caller passes none.

### Response

1. The body is read with `response.text()`. The timeout covers this read too, so a stalled body
   still ends the call on time.
2. A 2xx body that is empty or only whitespace resolves to `undefined`. Anything else is parsed as
   JSON, whatever the `Content-Type` header says (`openapi.json` labels some v2 responses
   `application/octet-stream`). A 2xx body that is not JSON throws a `PrintifyApiError` of kind
   `invalid_response`.
3. A non-2xx response throws a `PrintifyApiError` of kind `http` (see below).

### Failures before a response

- **Caller abort:** if the caller's signal has aborted, its `reason` is re-thrown unchanged. It is
  not a Printify error, and #4 must never retry it.
- **Timeout:** otherwise, if the timeout signal has aborted, a `PrintifyApiError` of kind `timeout`.
- **Network:** any other rejection from `fetch` or from reading the body becomes a
  `PrintifyApiError` of kind `network`, with the original error as `cause`.

### No side effects

`createPrintifyClient` starts no timers and opens no connections. `createServer` can build one per
server instance, including the probe instance `serveStdio` may discard. Wiring the client into
`createServer(config)` is #5's job; #3 only exports and tests it.

### Extension point for #4

Rate limiting and retries (#4) wrap the injected `fetch`, e.g. `withRetry(withRateLimit(fetch))`.
Everything the wrapper needs is on the `Request` and `Response`: the method (is a retry safe?), the
URL (catalog or publish bucket), the status and any `Retry-After` header. The client's signal covers
all attempts, so one tool call never takes longer than its timeout. The fake `fetch` from #6 sits
below the wrapper. #3 builds none of this.

## Errors

```ts
type PrintifyErrorKind = 'http' | 'timeout' | 'network' | 'invalid_response';

class PrintifyApiError extends Error {
  readonly kind: PrintifyErrorKind;
  readonly method: HttpMethod;
  /** The `ApiPath`, without base URL or query. */
  readonly path: string;
  /** Set for `http` and `invalid_response`. */
  readonly status: number | undefined;
  /** Printify's numeric code, e.g. 8203. */
  readonly code: number | undefined;
  /** Printify's `message` or `error` text, e.g. "Validation failed." or "Not found". */
  readonly printifyMessage: string | undefined;
  readonly reason: string | undefined;
  readonly requestId: string | undefined;
  /** Advice for the assistant; see Hints. */
  readonly hint: string | undefined;
}
```

One class with a `kind` field: #4 and #5 need one `instanceof` check and a `switch`.

### Reading an error body

The body of a non-2xx response is parsed as JSON. If that works and the result is an object, one
loose zod schema reads these fields, each optional, so both envelopes and any mix of them work:

| Field             | Source                                                                              |
| ----------------- | ----------------------------------------------------------------------------------- |
| `code`            | `code` if it is a number, else `errors.code` if that is a number                    |
| `printifyMessage` | `message` if it is a string, else `error` if it is a string                         |
| `reason`          | `errors.reason` if it is a string, else `JSON.stringify(errors)` if `errors` is set |
| `requestId`       | `request_id` if it is a string, else the `x-pfy-correlation-id` header              |

- A JSON-encoded `reason` stays a string. The model can read it.
- A body that is not JSON, not an object, or has none of these fields leaves the fields
  `undefined`. `requestId` still falls back to the header.
- `printifyMessage` and `reason` are cut to 1 000 characters, with `…` at the end when cut.
- The error never stores the request body, the query, the base URL or the raw response body.

### Messages

`message` is one line for logs. Examples:

```
POST /v1/shops/12/products.json failed with HTTP 400 (code 8203): Validation failed. Reason: Image has low quality. Request id: 1789735516@e08829df-…
GET /v1/shops/12/products/abc.json failed with HTTP 404: Not found. Request id: 1789735516@0b0a4088-…
GET /v1/shops.json failed with HTTP 502 (non-JSON response). Request id: …
GET /v1/catalog/blueprints.json timed out after 30000 ms
GET /v1/shops.json failed: could not reach Printify (ENOTFOUND)
GET /v1/uploads.json returned HTTP 200 with a body that is not JSON
GET /v1/uploads.json returned HTTP 200 with an unexpected pagination envelope
```

- The HTTP form is `<method> <path> failed with HTTP <status>`, then ` (code <code>)`,
  ` (non-JSON response)` and `: <printifyMessage>`, then `. Reason: <reason>` and
  `. Request id: <requestId>`. Each piece appears only when its field is set, and
  `(non-JSON response)` only when the body could not be parsed as JSON.
- One trailing `.` is removed from `printifyMessage` and `reason` inside `message`, so the pieces
  never join as `..`. The fields themselves keep Printify's text. `message` has no final period.
- The network message names the `code` of the innermost `cause` that has one (Node's `fetch`
  rejects with `TypeError: fetch failed` and puts the system error in `cause`). Without a code it
  ends at `could not reach Printify`.
- The hint is not part of `message`. #5 shows it separately.

### Redaction

Before any text is stored on the error (`message`, `printifyMessage`, `reason`, `requestId`), it is
redacted. `src/redact.ts` provides:

```ts
function redactJwts(text: string): string; // moved from config.ts, unchanged
function redactValues(text: string, values: Iterable<string>): string;
```

- `redactValues` replaces every occurrence of each value, ignoring letter case, with
  `[redacted]`. Values shorter than 3 characters are skipped, so a two-letter country code does not
  wipe out every `US` in a message. Longer values are replaced first, so a value that contains
  another is not left half-replaced.
- The values are the token and every string found under an `address_to` key anywhere in the
  request body, at any depth.
- `redactJwts` then replaces anything JWT-shaped, as `config.ts` already does.
- `config.ts` imports `redactJwts` from `src/redact.ts` instead of defining it.

### Hints

Hints are for the assistant, not the user. The first matching row wins:

| Match                   | Hint                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| code 8203               | The image resolution is too low for the print area at this size. Use a larger image or a smaller `scale`.                                                                             |
| code 8201               | Printify rejected the file: it is too large or not a supported image format (the reason says which). Upload files over 5 MB by URL rather than base64.                                |
| code 10300              | Printify could not download the image. The URL must be publicly reachable and return the image file itself, not a web page.                                                           |
| code 8103               | The shipping address failed validation. The reason names the fields to fix.                                                                                                           |
| code 8503, or HTTP 409  | An order with this `external_id` already exists. Look it up instead of creating it again.                                                                                             |
| HTTP 401                | Printify rejected the token: it is invalid, expired (Personal Access Tokens last one year) or revoked. The user needs a new token in `PRINTIFY_API_TOKEN` in their MCP client config. |
| HTTP 403, scope known   | Printify denied access. The token probably lacks the `<scope>` scope; the user can create a new token that includes it. Printify's message may name another reason.                   |
| HTTP 403, scope unknown | Printify denied access. The token may lack a scope this endpoint needs, or the feature is not enabled for this shop.                                                                  |
| HTTP 404                | Not found. Check the id, and that it belongs to this shop.                                                                                                                            |
| HTTP 429                | Printify's rate limit was reached. Wait a minute before trying again.                                                                                                                 |
| HTTP 500–599            | Printify had a server error. Try again in a moment.                                                                                                                                   |
| kind `timeout`          | Printify did not answer in time. Try again in a moment.                                                                                                                               |
| kind `network`          | Printify could not be reached. Check the network connection and try again.                                                                                                            |
| anything else           | no hint                                                                                                                                                                               |

For `timeout` and `network`, every method except GET gets one more sentence: "The request may still
have gone through, so check before retrying." An order or product create that timed out may exist.

### Scope guess for 403

The scope comes from the method and the `ApiPath`. GET reads; every other method writes.

| Path                                | GET             | Other methods    |
| ----------------------------------- | --------------- | ---------------- |
| `/v1/shops.json`                    | `shops.read`    | —                |
| `/v1/catalog/…`, `/v2/catalog/…`    | `catalog.read`  | —                |
| `/v1/shops/{id}/products…`          | `products.read` | `products.write` |
| `/v1/shops/{id}/orders…`            | `orders.read`   | `orders.write`   |
| `/v1/uploads…`                      | `uploads.read`  | `uploads.write`  |
| `/v1/shops/{id}/webhooks…`          | `webhooks.read` | `webhooks.write` |
| anything else, e.g. shop disconnect | —               | —                |

A dash means no scope is named, and the "scope unknown" hint applies. Publishing and personalization
paths sit under `/products`, so they map to the products scopes.

## Pagination

```ts
const PAGE_LIMITS = { products: 50, orders: 10, uploads: 100 } as const;
type PagedResource = keyof typeof PAGE_LIMITS;

interface Page {
  items: unknown[];
  page: number;
  lastPage: number | undefined;
  total: number | undefined;
  hasMore: boolean;
}

function fetchPage(
  client: PrintifyClient,
  resource: PagedResource,
  path: ApiPath,
  options?: {
    page?: number;
    limit?: number;
    query?: RequestOptions['query'];
    signal?: AbortSignal;
  },
): Promise<Page>;
```

- **Limits:** tool schemas use `PAGE_LIMITS`, e.g. `.max(PAGE_LIMITS.orders)`, so the model gets a
  local validation error before any request. `fetchPage` also lowers a `limit` above the maximum
  to the maximum, so it never sends a request Printify would reject. Without a `limit`, none is
  sent and Printify's default of 10 applies. A `limit` below 1 or not an integer throws a
  `RangeError`.
- **Page:** sent only when given. A `page` below 1 or not an integer throws a `RangeError`.
- **Query:** `page` and `limit` are merged over `options.query`, so they win.
- **Envelope:** parsed with a loose zod schema. `current_page` (integer) and `data` (array) are
  required. `last_page`, `total` (integers) and `next_page_url` (string or `null`) are optional.
  Other fields are ignored. A body that does not match throws a `PrintifyApiError` of kind
  `invalid_response` with status 200.
- **`hasMore`:** `current_page < last_page` when `last_page` is present; otherwise
  `next_page_url !== null` when `next_page_url` is present; otherwise `items.length` equals the
  limit sent, or 10 when none was sent.
- The URL fields are dropped: they are relative and of no use to the model.
- There is no helper that fetches every page. Tools pass `page` through to the model, and a
  workflow that needs every page loops over `fetchPage` itself.

## Configuration change

In the `PRINTIFY_API_BASE_URL` transform in `config.ts`, after the trailing slashes are removed, a
path ending in `/v1` or `/v2`, in any letter case, is an error:

`PRINTIFY_API_BASE_URL must not end in /v1 or /v2; the server adds the API version itself`

`/printify` and `/v10` are still accepted. The help text does not change.

## Tests

All tests run under `npm test`. None needs the network or a Printify account. The fake `fetch` is a
`vi.fn` that returns real `Response` objects and records each `Request`.

### `test/redact.test.ts`

`redactValues` ignores letter case, skips values under 3 characters, replaces a longer value before
a shorter one it contains, and handles regex characters in values. `redactJwts` behaves as before.

### `test/printify/path.test.ts`

Numbers and strings are inserted; `/`, `?`, `#`, `%` and spaces are encoded; empty, `.` and `..`
throw; a template that does not start with `/v1/` or `/v2/` throws.

### `test/printify/client.test.ts`

- **Success:** the URL, method and all three headers; a proxy base URL keeps its path prefix;
  `undefined` query values are dropped; a POST body arrives as JSON; a 204, an empty 200 and a
  whitespace-only 200 resolve to `undefined`; a JSON body served as `application/octet-stream` is
  parsed.
- **GET with a body** throws a `TypeError` and never calls `fetch`.
- **Error bodies:** the documented 8203 body gives `code`, `printifyMessage`, `reason`, the header
  `requestId` and the 8203 hint; the probed `{error, request_id}` 404 body gives `printifyMessage`
  and the body's `requestId`; the documented 8103 body keeps its JSON-encoded `reason`; an `errors`
  object without `reason` is serialised; long text is cut to 1 000 characters.
- **Timeouts:** with a real timeout of about 20 ms, because `AbortSignal.timeout` does not follow
  vitest's fake timers. One `fetch` never settles until aborted; one returns headers and then
  stalls the body. Both give kind `timeout`. A per-request `timeoutMs` overrides the default.
- **Caller abort:** aborting the caller's signal re-throws its reason, not a `PrintifyApiError`.
- **Non-JSON:** an HTML 502 gives kind `http` with `(non-JSON response)`; an HTML 200 gives kind
  `invalid_response`.
- **Network:** a `fetch` that rejects with `TypeError('fetch failed', { cause })` gives kind
  `network`, keeps `cause`, and names the cause's code in `message`.
- **Redaction:** Printify echoes the token, a JWT and `address_to` values (name, street, email,
  phone) back in `message` and `reason`. None of them appears in `message`, any field, or
  `util.inspect(error)`. The base URL path and the query never appear either.

### `test/printify/hints.test.ts`

Every row of the hint table, the first-match order (code 8503 on a 409, a 403 with a code), and
every row of the scope table, including a path with no scope.

### `test/printify/pagination.test.ts`

- The documented products envelope (with `last_page: 22`) and the documented uploads envelope
  (`next_page_url: null`) give the right `Page`.
- The documented orders shape, only `current_page` and `data`, works, and `hasMore` follows the
  number of items.
- The `hasMore` order: `last_page` wins over `next_page_url`, which wins over the item count.
- A `limit` above the maximum is sent as the maximum; no `limit` sends none; `page` and `limit`
  override the same keys in `query`; `status` from `query` is sent.
- An invalid `page` or `limit` throws before `fetch` is called.
- A body without `data`, or with `data` that is not an array, gives kind `invalid_response`.

### `test/config.test.ts` (updated)

`/v1`, `/v2/`, `/V1` and `/printify/v1` are rejected with the new message. `/printify` and `/v10`
are accepted.

## Acceptance criteria mapping

| Criterion (issue #3)                                                                             | Covered by                         |
| ------------------------------------------------------------------------------------------------ | ---------------------------------- |
| Unit tests with a fake `fetch` cover success, both error envelopes, timeouts and non-JSON bodies | `test/printify/client.test.ts`     |
| Pagination helper tested against the documented envelope                                         | `test/printify/pagination.test.ts` |

The issue's other requirements:

| Requirement                                                  | Covered by                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| `/v1/` and `/v2/` paths under `PRINTIFY_API_BASE_URL`        | `apiPath`, URL building, the config change                     |
| Authorization, Content-Type and User-Agent headers           | `client.ts`, header tests                                      |
| Injectable `fetch`, `AbortSignal.timeout` with 30 s default  | `PrintifyClientOptions`, timeout tests                         |
| Typed `PrintifyApiError` parsing both envelopes              | `errors.ts`, error-body tests                                  |
| Hints for 8203, 8201, 10300, 8103, 8503 / 409, 401 / 403     | `hints.ts`, `test/printify/hints.test.ts`                      |
| Pagination with per-endpoint maximum `limit`                 | `pagination.ts`, `PAGE_LIMITS`                                 |
| Tokens and customer addresses never in thrown error messages | `redact.ts`, redaction tests in `test/printify/client.test.ts` |

## Out of scope

| Topic                                                  | Where                      |
| ------------------------------------------------------ | -------------------------- |
| Rate limiting, retries, `Retry-After`                  | #4                         |
| Building the client in `createServer(config)`          | #5                         |
| Turning `PrintifyApiError` into `isError` tool results | #5                         |
| In-memory MCP client and fake Printify API             | #6                         |
| Response schemas per endpoint                          | The toolset issues, #7–#16 |
| A helper that fetches every page                       | Not planned                |
| A timeout environment variable                         | Not planned                |
| Request logging                                        | Not planned                |

## Delivery

1. Branch `feat/3-http-client` from `origin/main`. This spec is its first commit.
2. Implementation plan via the writing-plans skill, then test-first implementation.
3. Local verification before any claim of success: `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test` and `npm run build`. Then a manual check of the built client against the real API
   with a dummy token and no real credentials: `GET /v1/shops.json` must throw a `PrintifyApiError`
   with status 401, a `requestId` and the 401 hint, and `GET /v1/nope.json` must throw one with
   status 404 (the probe on 2026-09-18 got a 404 for an unknown route even without a token). The
   output goes in the PR description. This check is not part of CI, which must not depend on
   Printify being reachable.
4. PR with `Closes #3`. Watch its CI run on Node 22 and 24.
5. Comment on the issues that build on this:
   - #4: wrap the injected `fetch`; the client's signal covers all attempts; never retry a caller
     abort; Printify documents no `Retry-After` or rate-limit headers; fail-fast errors should be a
     `PrintifyApiError` so #5 handles them like any other.
   - #5: map `PrintifyApiError` fields and `hint` to the `isError` result; use `PAGE_LIMITS` in tool
     schemas; build the client in `createServer(config)`; validate ids before calling `apiPath`.
   - #6: pass the fake `fetch` to `createPrintifyClient`; `requestId` comes from the
     `x-pfy-correlation-id` header when the body has none.
