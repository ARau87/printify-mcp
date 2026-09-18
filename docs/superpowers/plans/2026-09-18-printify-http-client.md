# Printify HTTP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A small `fetch`-based Printify client in `src/printify/` that sends authenticated requests
with the required headers and a timeout, turns every failure into one typed `PrintifyApiError` with
a hint for the assistant, never leaks the token or a customer address, and reads Laravel-style
pages.

**Architecture:** `path.ts` builds encoded, branded `ApiPath`s. `hints.ts` maps an error to advice
and guesses the missing scope on a 403. `errors.ts` holds `PrintifyApiError` and the factories that
parse Printify's error bodies, format messages and redact text. `client.ts` has
`createPrintifyClient`, whose single `request()` builds the URL and headers, applies the timeout and
the caller's signal, and maps every outcome to a value or a `PrintifyApiError`. `pagination.ts`
calls `request()` for one page and reads the envelope. `src/redact.ts` is shared with `config.ts`,
which also starts rejecting base URLs that end in `/v1` or `/v2`.

**Tech Stack:** Node >= 22, TypeScript ~6.0.3, zod 4 (4.6.5 installed), Vitest 5, ESLint 10 with
typescript-eslint 8 `strictTypeChecked`, Prettier 3. The global `fetch`, `AbortSignal.timeout` and
`AbortSignal.any` come with Node 22.

**Spec:** `docs/superpowers/specs/2026-09-18-printify-http-client-design.md`. Read it before
starting. This plan implements it exactly.

## Global Constraints

- Branch: `feat/3-http-client` (already exists, and the spec and this plan are committed on it).
  Never commit to `main`. The branch has no upstream yet; Task 8 pushes it with `-u`.
- No new dependencies. `package.json` and `package-lock.json` do not change.
- `"type": "module"` and NodeNext: relative imports use the `.js` suffix, including in tests.
- Nothing in `src/` may use `console.*` (ESLint `no-console`).
- `createPrintifyClient` must stay free of side effects: no timers or connections until a request.
  #5 builds one per server instance, and `serveStdio` may discard a probe instance.
- `token.reveal()` is called in exactly one place: `createPrintifyClient`.
- The token, JWT-shaped values and every string under an `address_to` key of the request body must
  never appear in a `PrintifyApiError`'s message, fields, `util.inspect` or `JSON.stringify` output.
- Error messages, hints and `RangeError`/`TypeError` texts are part of the interface. Tests assert
  them exactly, so copy them verbatim from this plan.
- zod 4: a `z.unknown()` object key is required unless it is marked `.optional()`. Fields that
  should be ignored when they have the wrong type use `.optional().catch(undefined)`.
- `AbortSignal.timeout` does not follow Vitest's fake timers, so timeout tests use real 20 ms
  timeouts.
- Lint is typescript-eslint `strictTypeChecked`. No non-null assertions (`!`). Numbers in template
  literals must be wrapped in `String(…)`.
- Prettier: `singleQuote: true`, `printWidth: 100`. Every file must pass `prettier --check`. The
  code in this plan is already Prettier-formatted.
- Commit messages use this repo's style: a short imperative sentence with no conventional-commit
  prefix, a blank line, then the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Everything below was prototyped on 2026-09-18 with Node 24.13.1, zod 4.6.5, Vitest 5.0.1 and
  TypeScript 6.0.3, including a run of the built client against the real API with a dummy token.
  The expected outputs come from that run.

## File Map

| File                               | Responsibility                                                    | Task |
| ---------------------------------- | ----------------------------------------------------------------- | ---- |
| `src/redact.ts`                    | `redactJwts` (moved from `config.ts`), `redactValues`             | 1    |
| `test/redact.test.ts`              | Case-insensitive, length floor, longest first, regex characters   | 1    |
| `src/config.ts`                    | Imports `redactJwts`; rejects a base URL ending in `/v1` or `/v2` | 1, 2 |
| `test/config.test.ts`              | Base URL cases for the version rule                               | 2    |
| `src/printify/path.ts`             | `ApiPath`, `apiPath` tagged template                              | 3    |
| `test/printify/path.test.ts`       | Encoding, rejected values, version prefix                         | 3    |
| `src/printify/types.ts`            | `HttpMethod`, `PrintifyErrorKind`                                 | 4    |
| `src/printify/hints.ts`            | `hintFor`, `scopeFor`, `HintInput`                                | 4    |
| `test/printify/hints.test.ts`      | Every hint and scope row, first-match order                       | 4    |
| `src/printify/errors.ts`           | `PrintifyApiError`, `parseJson`, the four error factories         | 5    |
| `test/printify/errors.test.ts`     | Body parsing, messages, cutting, redaction                        | 5    |
| `src/printify/client.ts`           | `createPrintifyClient`, `request()`, URL, headers, timeouts       | 6    |
| `test/printify/client.test.ts`     | Requests, responses, failures and redaction with a fake `fetch`   | 6    |
| `src/printify/pagination.ts`       | `PAGE_LIMITS`, `fetchPage`, `Page`                                | 7    |
| `test/printify/pagination.test.ts` | Documented envelopes, `hasMore`, limits, invalid envelopes        | 7    |

---

### Task 1: Shared redaction helpers

**Files:**

- Create: `src/redact.ts`
- Test: `test/redact.test.ts`
- Modify: `src/config.ts` (the imports at the top, the `JWT_PATTERN` block below
  `LOOPBACK_HOSTS`, and the comment in `loadConfig`)

**Interfaces:**

- Consumes: nothing.
- Produces: `src/redact.ts` exports `redactJwts(text: string): string` and
  `redactValues(text: string, values: Iterable<string>): string`. Both replace matches with the
  string `[redacted]`. Task 5 applies `redactJwts` to all error text; Task 6 passes the token and
  address values through `redactValues`.

- [ ] **Step 1: Write the failing test**

Create `test/redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { redactJwts, redactValues } from '../src/redact.js';

describe('redactJwts', () => {
  it('replaces JWT-shaped values', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcmludGlmeS1tY3AifQ.c2lnbmF0dXJl';
    expect(redactJwts(`token ${jwt} leaked`)).toBe('token [redacted] leaked');
  });

  it('leaves other text alone', () => {
    expect(redactJwts('Validation failed.')).toBe('Validation failed.');
  });
});

describe('redactValues', () => {
  it('replaces every occurrence, ignoring letter case', () => {
    expect(redactValues('Jane Doe; JANE DOE; jane doe', ['Jane Doe'])).toBe(
      '[redacted]; [redacted]; [redacted]',
    );
  });

  it('skips values shorter than 3 characters', () => {
    expect(redactValues('US address in USPS', ['US', 'Bob'])).toBe('US address in USPS');
  });

  it('replaces a longer value before a shorter one it contains', () => {
    expect(redactValues('Main Street 1', ['Main', 'Main Street 1'])).toBe('[redacted]');
  });

  it('never matches inside an earlier replacement', () => {
    expect(redactValues('Rosa Red', ['Rosa Red', 'act', 'red'])).toBe('[redacted]');
  });

  it('treats regex characters in values literally', () => {
    expect(redactValues('a+b (c) a.b', ['a+b (c)'])).toBe('[redacted] a.b');
    expect(redactValues('axb', ['a.b'])).toBe('axb');
  });

  it('returns the text unchanged when no value qualifies', () => {
    expect(redactValues('unchanged', [])).toBe('unchanged');
    expect(redactValues('unchanged', ['', 'ab'])).toBe('unchanged');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/redact.test.ts`
Expected: FAIL with `Error: Cannot find module '../src/redact.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/redact.ts`:

```ts
const REDACTED = '[redacted]';

// Printify Personal Access Tokens are JWTs.
const JWT_PATTERN = /eyJ[\w-]*\.[\w-]*\.[\w-]*/g;

/** Shorter values are skipped, so a country code such as "US" does not wipe out other text. */
const MIN_VALUE_LENGTH = 3;

/** Replaces everything JWT-shaped, such as a Printify token, with `[redacted]`. */
export function redactJwts(text: string): string {
  return text.replace(JWT_PATTERN, REDACTED);
}

/**
 * Replaces every occurrence of each value, ignoring letter case, with `[redacted]`. One pass with
 * the longest values first, so a value inside another, or inside `[redacted]`, is never matched.
 */
export function redactValues(text: string, values: Iterable<string>): string {
  const patterns = [...new Set(values)]
    .filter((value) => value.length >= MIN_VALUE_LENGTH)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (patterns.length === 0) return text;
  return text.replace(new RegExp(patterns.join('|'), 'gi'), REDACTED);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/redact.test.ts`
Expected: PASS, `Tests  8 passed (8)`.

- [ ] **Step 5: Use the shared `redactJwts` in `config.ts`**

In `src/config.ts`, add the import between the `zod` and `Secret` imports:

```ts
import { z } from 'zod';
import { redactJwts } from './redact.js';
import { Secret } from './secret.js';
```

Delete this block, which sits right below `const LOOPBACK_HOSTS = …`:

```ts
// Printify Personal Access Tokens are JWTs. A token pasted into the wrong variable while
// PRINTIFY_API_TOKEN is left empty would otherwise be echoed in full in that variable's error.
const JWT_PATTERN = /eyJ[\w-]*\.[\w-]*\.[\w-]*/g;

function redactJwts(message: string): string {
  return message.replace(JWT_PATTERN, '[redacted]');
}
```

In `loadConfig`, the deleted comment's reason moves to the call site. Replace:

<!-- prettier-ignore -->
```ts
    // A token pasted into the wrong variable would otherwise be echoed in that variable's error.
    // The truthiness check matters: replaceAll('', …) would insert between every character.
```

with:

<!-- prettier-ignore -->
```ts
    // A token pasted into the wrong variable would otherwise be echoed in that variable's error.
    // The truthiness check matters: replaceAll('', …) would insert between every character.
    // redactJwts covers a token pasted into another variable while PRINTIFY_API_TOKEN is empty.
```

- [ ] **Step 6: Run the config and redaction tests**

Run: `npx vitest run test/config.test.ts test/redact.test.ts`
Expected: PASS, `Tests  58 passed (58)`. The config tests are unchanged and still pass, including
`redacts a JWT-shaped token pasted into other variables when PRINTIFY_API_TOKEN is empty`.

- [ ] **Step 7: Check formatting, lint and types**

Run: `npx prettier --check src test && npx eslint src test && npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/redact.ts test/redact.test.ts src/config.ts
git commit -F - <<'EOF'
Move JWT redaction into a shared module and add redactValues

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Reject a base URL that already names an API version

**Files:**

- Modify: `src/config.ts` (the end of the `PRINTIFY_API_BASE_URL` transform)
- Test: `test/config.test.ts` (the `describe('PRINTIFY_API_BASE_URL', …)` block)

**Interfaces:**

- Consumes: nothing new.
- Produces: `config.apiBaseUrl` never ends in `/v1` or `/v2`, so the client (Task 6) can append
  `/v1/…` and `/v2/…` directly. The new error text is
  `PRINTIFY_API_BASE_URL must not end in /v1 or /v2; the server adds the API version itself`.

- [ ] **Step 1: Write the failing tests**

In `test/config.test.ts`, inside `describe('PRINTIFY_API_BASE_URL', …)`, add two rows to the end of
the `it.each` table of accepted values, so the table ends like this:

<!-- prettier-ignore -->
```ts
      ['http://[::1]:8080', 'http://[::1]:8080'],
      ['https://proxy.example.com/v10', 'https://proxy.example.com/v10'],
      ['https://v1', 'https://v1'],
    ])('accepts %s', (value, expected) => {
```

Then add this test directly after that `it.each` and before
`it('rejects a value that is not a URL', …)`:

<!-- prettier-ignore -->
```ts
    it.each([
      'https://api.printify.com/v1',
      'https://api.printify.com/v2/',
      'https://api.printify.com/V1',
      'https://proxy.example.com/printify/v1',
    ])('rejects %s, which already names an API version', (value) => {
      expect(errorsOf(load({ PRINTIFY_API_BASE_URL: value }))).toEqual([
        'PRINTIFY_API_BASE_URL must not end in /v1 or /v2; the server adds the API version itself',
      ]);
    });
```

`https://v1` is a host named `v1` with no path. It must stay accepted, which is why the rule looks
at the URL's path and not at the whole string.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, `Tests  4 failed | 52 passed (56)`. The four failures are the new
`rejects …, which already names an API version` cases.

- [ ] **Step 3: Write the implementation**

In `src/config.ts`, at the end of the `PRINTIFY_API_BASE_URL` transform, replace:

<!-- prettier-ignore -->
```ts
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  }),
```

with:

<!-- prettier-ignore -->
```ts
    const pathname = url.pathname.replace(/\/+$/, '');
    if (/\/v[12]$/i.test(pathname)) {
      ctx.addIssue(
        'PRINTIFY_API_BASE_URL must not end in /v1 or /v2; the server adds the API version itself',
      );
      return z.NEVER;
    }
    return `${url.origin}${pathname}`;
  }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/config.test.ts`
Expected: PASS, `Tests  56 passed (56)`.

- [ ] **Step 5: Check formatting, lint and types**

Run: `npx prettier --check src test && npx eslint src test && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -F - <<'EOF'
Reject a PRINTIFY_API_BASE_URL that already names an API version

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: `apiPath`, the encoded path builder

**Files:**

- Create: `src/printify/path.ts`
- Test: `test/printify/path.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `src/printify/path.ts` exports
  `type ApiPath = string & { readonly __brand: 'ApiPath' }` and the tagged template
  `apiPath(strings: TemplateStringsArray, ...values: readonly (string | number)[]): ApiPath`. It
  throws `TypeError('API paths must start with /v1/ or /v2/, got "<head>"')` and
  `TypeError('API path values must not be empty, "." or ".."')`. Tasks 6 and 7 accept only
  `ApiPath`.

- [ ] **Step 1: Write the failing test**

Create `test/printify/path.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { apiPath } from '../../src/printify/path.js';

describe('apiPath', () => {
  it('inserts numbers and strings', () => {
    const shopId = 12;
    const productId = '5d39b411749d0a000f30e0f4';
    expect(apiPath`/v1/shops/${shopId}/products/${productId}.json`).toBe(
      '/v1/shops/12/products/5d39b411749d0a000f30e0f4.json',
    );
  });

  it('accepts a path without values and v2 paths', () => {
    expect(apiPath`/v1/shops.json`).toBe('/v1/shops.json');
    expect(apiPath`/v2/catalog/blueprints/${6}/print_providers/${99}/shipping.json`).toBe(
      '/v2/catalog/blueprints/6/print_providers/99/shipping.json',
    );
  });

  it('encodes characters that would change the route', () => {
    const productId = '../x/y?z=1#frag 100%';
    expect(apiPath`/v1/shops/12/products/${productId}.json`).toBe(
      '/v1/shops/12/products/..%2Fx%2Fy%3Fz%3D1%23frag%20100%25.json',
    );
  });

  it.each(['', '.', '..'])('rejects the value "%s"', (value) => {
    expect(() => apiPath`/v1/shops/${value}/products.json`).toThrow(
      new TypeError('API path values must not be empty, "." or ".."'),
    );
  });

  it.each([
    ['a relative path', () => apiPath`v1/shops.json`],
    ['an unknown version', () => apiPath`/v3/shops.json`],
    ['a leading value', () => apiPath`${'/v1'}/shops.json`],
  ])('rejects %s', (_, build) => {
    expect(build).toThrow(TypeError);
    expect(build).toThrow('API paths must start with /v1/ or /v2/');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/printify/path.test.ts`
Expected: FAIL with `Error: Cannot find module '../../src/printify/path.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/printify/path.ts`:

```ts
/** A Printify API path such as `/v1/shops/12/products.json`. Only `apiPath` makes one. */
export type ApiPath = string & { readonly __brand: 'ApiPath' };

/**
 * Builds an `ApiPath` from a template, URL-encoding every value, so an id that came from the model
 * cannot change the route: apiPath`/v1/shops/${shopId}/products/${productId}.json`.
 */
export function apiPath(
  strings: TemplateStringsArray,
  ...values: readonly (string | number)[]
): ApiPath {
  const head = strings[0] ?? '';
  if (!head.startsWith('/v1/') && !head.startsWith('/v2/')) {
    throw new TypeError(`API paths must start with /v1/ or /v2/, got "${head}"`);
  }
  let path = head;
  values.forEach((value, index) => {
    const text = String(value);
    // encodeURIComponent leaves dots alone, and the URL parser would resolve "." and ".." segments.
    if (text === '' || text === '.' || text === '..') {
      throw new TypeError('API path values must not be empty, "." or ".."');
    }
    path += encodeURIComponent(text) + (strings[index + 1] ?? '');
  });
  return path as ApiPath;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/printify/path.test.ts`
Expected: PASS, `Tests  9 passed (9)`.

- [ ] **Step 5: Check formatting, lint and types**

Run: `npx prettier --check src test && npx eslint src test && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/printify/path.ts test/printify/path.test.ts
git commit -F - <<'EOF'
Add apiPath, which URL-encodes every value in a Printify API path

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Hints and the scope guess

**Files:**

- Create: `src/printify/types.ts`
- Create: `src/printify/hints.ts`
- Test: `test/printify/hints.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `src/printify/types.ts` exports `type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'` and
    `type PrintifyErrorKind = 'http' | 'timeout' | 'network' | 'invalid_response'`. They live in
    their own module so `hints.ts` and `errors.ts` do not import each other's types in a cycle.
  - `src/printify/hints.ts` exports
    `interface HintInput { kind: PrintifyErrorKind; method: HttpMethod; path: string; status: number | undefined; code: number | undefined }`,
    `hintFor(error: HintInput): string | undefined` and
    `scopeFor(method: HttpMethod, path: string): string | undefined`. Task 5's `PrintifyApiError`
    satisfies `HintInput` and calls `hintFor(this)`.

- [ ] **Step 1: Write the failing test**

Create `test/printify/hints.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hintFor, scopeFor, type HintInput } from '../../src/printify/hints.js';
import type { HttpMethod } from '../../src/printify/types.js';

function http(status: number, code?: number, method: HttpMethod = 'GET', path = '/v1/shops.json') {
  return { kind: 'http', method, path, status, code } satisfies HintInput;
}

describe('hintFor', () => {
  it.each([
    [8203, 'The image resolution is too low'],
    [8201, 'it is too large or not a supported image format'],
    [10300, 'Printify could not download the image'],
    [8103, 'The shipping address failed validation'],
    [8503, 'An order with this `external_id` already exists'],
  ])('explains Printify code %i', (code, text) => {
    expect(hintFor(http(400, code))).toContain(text);
  });

  it.each([
    [409, 'An order with this `external_id` already exists'],
    [401, 'expired (Personal Access Tokens last one year)'],
    [404, 'Check the id, and that it belongs to this shop'],
    [429, 'rate limit was reached'],
    [500, 'Printify had a server error'],
    [502, 'Printify had a server error'],
    [599, 'Printify had a server error'],
  ])('explains HTTP %i', (status, text) => {
    expect(hintFor(http(status))).toContain(text);
  });

  it('prefers the code hint over the status hint', () => {
    expect(hintFor(http(409, 8503))).toBe(hintFor(http(400, 8503)));
    expect(hintFor(http(403, 8203))).toContain('The image resolution is too low');
  });

  it('names the probable scope on a 403', () => {
    const hint = hintFor(http(403, undefined, 'POST', '/v1/shops/12/products.json'));
    expect(hint).toBe(
      'Printify denied access. The token probably lacks the `products.write` scope; the user can ' +
        "create a new token that includes it. Printify's message may name another reason.",
    );
  });

  it('names no scope on a 403 for an unknown path, or with an unknown code', () => {
    const forbidden =
      'Printify denied access. The token may lack a scope this endpoint needs, or the feature is ' +
      'not enabled for this shop.';
    expect(hintFor(http(403, undefined, 'DELETE', '/v1/shops/12/connection.json'))).toBe(forbidden);
    expect(hintFor(http(403, 1234, 'DELETE', '/v1/shops/12/connection.json'))).toBe(forbidden);
  });

  it('gives no hint for other statuses and unknown codes', () => {
    expect(hintFor(http(400))).toBeUndefined();
    expect(hintFor(http(422, 1234))).toBeUndefined();
  });

  it.each([
    ['timeout', 'Printify did not answer in time. Try again in a moment.'],
    ['network', 'Printify could not be reached. Check the network connection and try again.'],
  ] as const)('explains a %s, with a warning for requests that change something', (kind, text) => {
    const base = { kind, path: '/v1/shops.json', status: undefined, code: undefined };
    expect(hintFor({ ...base, method: 'GET' })).toBe(text);
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      expect(hintFor({ ...base, method })).toBe(
        `${text} The request may still have gone through, so check before retrying.`,
      );
    }
  });

  it('gives no hint for an invalid response', () => {
    const error = { kind: 'invalid_response', method: 'GET', path: '/v1/shops.json' } as const;
    expect(hintFor({ ...error, status: 200, code: undefined })).toBeUndefined();
  });
});

describe('scopeFor', () => {
  it.each([
    ['GET', '/v1/shops.json', 'shops.read'],
    ['GET', '/v1/catalog/blueprints.json', 'catalog.read'],
    ['GET', '/v2/catalog/blueprints/6/print_providers/99/shipping/express.json', 'catalog.read'],
    ['GET', '/v1/shops/12/products.json', 'products.read'],
    ['PUT', '/v1/shops/12/products/abc.json', 'products.write'],
    ['POST', '/v1/shops/12/products/abc/publish.json', 'products.write'],
    ['GET', '/v1/shops/12/orders/abc.json', 'orders.read'],
    ['POST', '/v1/shops/12/orders/express.json', 'orders.write'],
    ['GET', '/v1/uploads.json', 'uploads.read'],
    ['POST', '/v1/uploads/images.json', 'uploads.write'],
    ['GET', '/v1/shops/12/webhooks.json', 'webhooks.read'],
    ['DELETE', '/v1/shops/12/webhooks/abc.json', 'webhooks.write'],
  ] as const)('%s %s needs %s', (method, path, scope) => {
    expect(scopeFor(method, path)).toBe(scope);
  });

  it.each([
    ['DELETE', '/v1/shops/12/connection.json'],
    ['POST', '/v1/catalog/blueprints.json'],
    ['GET', '/v1/shops/12/productsx.json'],
    ['GET', '/v1/something-new.json'],
  ] as const)('%s %s has no known scope', (method, path) => {
    expect(scopeFor(method, path)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/printify/hints.test.ts`
Expected: FAIL with `Error: Cannot find module '../../src/printify/hints.js'`.

- [ ] **Step 3: Write the shared types**

Create `src/printify/types.ts`:

```ts
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export type PrintifyErrorKind = 'http' | 'timeout' | 'network' | 'invalid_response';
```

- [ ] **Step 4: Write the implementation**

Create `src/printify/hints.ts`:

```ts
import type { HttpMethod, PrintifyErrorKind } from './types.js';

/** What a hint depends on. `PrintifyApiError` has all of these fields. */
export interface HintInput {
  kind: PrintifyErrorKind;
  method: HttpMethod;
  path: string;
  status: number | undefined;
  code: number | undefined;
}

const DUPLICATE_ORDER =
  'An order with this `external_id` already exists. Look it up instead of creating it again.';

const CODE_HINTS: ReadonlyMap<number, string> = new Map([
  [
    8203,
    'The image resolution is too low for the print area at this size. Use a larger image or a ' +
      'smaller `scale`.',
  ],
  [
    8201,
    'Printify rejected the file: it is too large or not a supported image format (the reason ' +
      'says which). Upload files over 5 MB by URL rather than base64.',
  ],
  [
    10300,
    'Printify could not download the image. The URL must be publicly reachable and return the ' +
      'image file itself, not a web page.',
  ],
  [8103, 'The shipping address failed validation. The reason names the fields to fix.'],
  [8503, DUPLICATE_ORDER],
]);

const UNAUTHORIZED =
  'Printify rejected the token: it is invalid, expired (Personal Access Tokens last one year) or ' +
  'revoked. The user needs a new token in `PRINTIFY_API_TOKEN` in their MCP client config.';
const FORBIDDEN =
  'Printify denied access. The token may lack a scope this endpoint needs, or the feature is not ' +
  'enabled for this shop.';
const NOT_FOUND = 'Not found. Check the id, and that it belongs to this shop.';
const RATE_LIMITED = "Printify's rate limit was reached. Wait a minute before trying again.";
const SERVER_ERROR = 'Printify had a server error. Try again in a moment.';
const TIMEOUT = 'Printify did not answer in time. Try again in a moment.';
const NETWORK = 'Printify could not be reached. Check the network connection and try again.';
const MAY_HAVE_GONE_THROUGH = ' The request may still have gone through, so check before retrying.';

// Path pattern, scope for GET, scope for every other method. The docs do not map scopes to
// endpoints, so this is a best guess and the hint says "probably".
const SCOPES: readonly (readonly [RegExp, string, string | undefined])[] = [
  [/^\/v1\/shops\.json$/, 'shops.read', undefined],
  [/^\/v[12]\/catalog\//, 'catalog.read', undefined],
  [/^\/v1\/shops\/[^/]+\/products[/.]/, 'products.read', 'products.write'],
  [/^\/v1\/shops\/[^/]+\/orders[/.]/, 'orders.read', 'orders.write'],
  [/^\/v1\/uploads[/.]/, 'uploads.read', 'uploads.write'],
  [/^\/v1\/shops\/[^/]+\/webhooks[/.]/, 'webhooks.read', 'webhooks.write'],
];

/** The token scope the endpoint probably needs, or `undefined` when it is not known. */
export function scopeFor(method: HttpMethod, path: string): string | undefined {
  for (const [pattern, readScope, writeScope] of SCOPES) {
    if (pattern.test(path)) return method === 'GET' ? readScope : writeScope;
  }
  return undefined;
}

/** Advice for the AI assistant about an error, or `undefined` when there is none. */
export function hintFor(error: HintInput): string | undefined {
  const codeHint = error.code === undefined ? undefined : CODE_HINTS.get(error.code);
  if (codeHint !== undefined) return codeHint;
  switch (error.kind) {
    case 'http':
      return statusHint(error);
    case 'timeout':
      return error.method === 'GET' ? TIMEOUT : TIMEOUT + MAY_HAVE_GONE_THROUGH;
    case 'network':
      return error.method === 'GET' ? NETWORK : NETWORK + MAY_HAVE_GONE_THROUGH;
    case 'invalid_response':
      return undefined;
  }
}

function statusHint({ status, method, path }: HintInput): string | undefined {
  if (status === undefined) return undefined;
  if (status === 409) return DUPLICATE_ORDER;
  if (status === 401) return UNAUTHORIZED;
  if (status === 403) {
    const scope = scopeFor(method, path);
    if (scope === undefined) return FORBIDDEN;
    return (
      `Printify denied access. The token probably lacks the \`${scope}\` scope; the user can ` +
      "create a new token that includes it. Printify's message may name another reason."
    );
  }
  if (status === 404) return NOT_FOUND;
  if (status === 429) return RATE_LIMITED;
  if (status >= 500 && status <= 599) return SERVER_ERROR;
  return undefined;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/printify/hints.test.ts`
Expected: PASS, `Tests  35 passed (35)`.

- [ ] **Step 6: Check formatting, lint and types**

Run: `npx prettier --check src test && npx eslint src test && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/printify/types.ts src/printify/hints.ts test/printify/hints.test.ts
git commit -F - <<'EOF'
Add hints for the assistant and a scope guess for 403 errors

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: `PrintifyApiError` and Printify's error bodies

**Files:**

- Create: `src/printify/errors.ts`
- Test: `test/printify/errors.test.ts`

**Interfaces:**

- Consumes: `redactJwts` from `src/redact.ts` (Task 1); `hintFor` from `src/printify/hints.ts` and
  `HttpMethod`, `PrintifyErrorKind` from `src/printify/types.ts` (Task 4).
- Produces: `src/printify/errors.ts` exports:
  - `interface Route { method: HttpMethod; path: string }`
  - `interface PrintifyErrorFields extends Route` with `kind` and the optional `status`, `code`,
    `printifyMessage`, `reason`, `requestId`.
  - `class PrintifyApiError extends Error` with `name === 'PrintifyApiError'`, the readonly fields
    `kind`, `method`, `path`, `status`, `code`, `printifyMessage`, `reason`, `requestId`, `hint`,
    and the public constructor `(message: string, fields: PrintifyErrorFields, options?: ErrorOptions)`,
    which derives `hint` itself.
  - `type Redact = (text: string) => string`
  - `parseJson(text: string): { value: unknown } | undefined`
  - `httpError(route, status: number, body: { value: unknown } | undefined, correlationId: string | null, redact?: Redact): PrintifyApiError`
  - `timeoutError(route, timeoutMs: number): PrintifyApiError`
  - `networkError(route, cause: unknown): PrintifyApiError`
  - `invalidResponseError(route, status: number, problem: 'a body that is not JSON' | 'an unexpected pagination envelope'): PrintifyApiError`

- [ ] **Step 1: Write the failing test**

Create `test/printify/errors.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/printify/errors.test.ts`
Expected: FAIL with `Error: Cannot find module '../../src/printify/errors.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/printify/errors.ts`:

```ts
import { z } from 'zod';
import { redactJwts } from '../redact.js';
import { hintFor } from './hints.js';
import type { HttpMethod, PrintifyErrorKind } from './types.js';

/** The request an error belongs to. `path` is the `ApiPath`, without base URL or query. */
export interface Route {
  method: HttpMethod;
  path: string;
}

export interface PrintifyErrorFields extends Route {
  kind: PrintifyErrorKind;
  status?: number | undefined;
  code?: number | undefined;
  printifyMessage?: string | undefined;
  reason?: string | undefined;
  requestId?: string | undefined;
}

/** Every failure of a Printify request. `kind` says which. The hint is advice for the assistant. */
export class PrintifyApiError extends Error {
  override readonly name = 'PrintifyApiError';
  readonly kind: PrintifyErrorKind;
  readonly method: HttpMethod;
  readonly path: string;
  readonly status: number | undefined;
  readonly code: number | undefined;
  readonly printifyMessage: string | undefined;
  readonly reason: string | undefined;
  readonly requestId: string | undefined;
  readonly hint: string | undefined;

  constructor(message: string, fields: PrintifyErrorFields, options?: ErrorOptions) {
    super(message, options);
    this.kind = fields.kind;
    this.method = fields.method;
    this.path = fields.path;
    this.status = fields.status;
    this.code = fields.code;
    this.printifyMessage = fields.printifyMessage;
    this.reason = fields.reason;
    this.requestId = fields.requestId;
    this.hint = hintFor(this);
  }
}

/** Extra redaction for text from Printify, e.g. the token and the customer's address. */
export type Redact = (text: string) => string;

const MAX_TEXT_LENGTH = 1000;

// A field with an unexpected type is ignored rather than failing the whole body.
const optionalString = z.string().optional().catch(undefined);
const optionalNumber = z.number().optional().catch(undefined);

// Reads both envelopes, {status, code, message, errors} and {error, request_id}, and any mix.
// In zod 4 a z.unknown() key is required unless marked optional.
const errorBodySchema = z.object({
  code: optionalNumber,
  message: optionalString,
  error: optionalString,
  errors: z.unknown().optional(),
  request_id: optionalString,
});
const errorsSchema = z.object({ reason: optionalString, code: optionalNumber });

/** `{ value }` when `text` is JSON, `undefined` when it is not. */
export function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * The error for a non-2xx response. `body` is the parsed body, or `undefined` when it was not
 * JSON. `correlationId` is the `x-pfy-correlation-id` header.
 */
export function httpError(
  route: Route,
  status: number,
  body: { value: unknown } | undefined,
  correlationId: string | null,
  redact: Redact = (text) => text,
): PrintifyApiError {
  const parsed = errorBodySchema.safeParse(body?.value);
  const fields = parsed.success ? parsed.data : undefined;
  const errors = errorsSchema.safeParse(fields?.errors);
  const detail = errors.success ? errors.data : undefined;
  const rawReason =
    detail?.reason ??
    (fields?.errors === undefined || fields.errors === null
      ? undefined
      : JSON.stringify(fields.errors));

  const code = fields?.code ?? detail?.code;
  const printifyMessage = clean(fields?.message ?? fields?.error, redact);
  const reason = clean(rawReason, redact);
  const requestId = clean(fields?.request_id ?? correlationId ?? undefined, redact);

  let message = `${route.method} ${route.path} failed with HTTP ${String(status)}`;
  if (code !== undefined) message += ` (code ${String(code)})`;
  if (body === undefined) message += ' (non-JSON response)';
  if (printifyMessage !== undefined) message += `: ${withoutPeriod(printifyMessage)}`;
  if (reason !== undefined) message += `. Reason: ${withoutPeriod(reason)}`;
  if (requestId !== undefined) message += `. Request id: ${requestId}`;
  return new PrintifyApiError(message, {
    kind: 'http',
    ...route,
    status,
    code,
    printifyMessage,
    reason,
    requestId,
  });
}

export function timeoutError(route: Route, timeoutMs: number): PrintifyApiError {
  return new PrintifyApiError(
    `${route.method} ${route.path} timed out after ${String(timeoutMs)} ms`,
    { kind: 'timeout', ...route },
  );
}

/** The error for a request that failed before any response, e.g. DNS or a reset connection. */
export function networkError(route: Route, cause: unknown): PrintifyApiError {
  const code = systemCode(cause);
  const suffix = code === undefined ? '' : ` (${code})`;
  return new PrintifyApiError(
    `${route.method} ${route.path} failed: could not reach Printify${suffix}`,
    { kind: 'network', ...route },
    { cause },
  );
}

export function invalidResponseError(
  route: Route,
  status: number,
  problem: 'a body that is not JSON' | 'an unexpected pagination envelope',
): PrintifyApiError {
  return new PrintifyApiError(
    `${route.method} ${route.path} returned HTTP ${String(status)} with ${problem}`,
    { kind: 'invalid_response', ...route, status },
  );
}

/** Redacts first, then cuts: cutting first could leave half a token that no longer matches. */
function clean(text: string | undefined, redact: Redact): string | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const redacted = redactJwts(redact(text));
  return redacted.length > MAX_TEXT_LENGTH
    ? `${redacted.slice(0, MAX_TEXT_LENGTH - 1)}…`
    : redacted;
}

function withoutPeriod(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

/** The `code` of the innermost error in the `cause` chain that has one, e.g. `ENOTFOUND`. */
function systemCode(error: unknown): string | undefined {
  let code: string | undefined;
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') code = current.code;
    current = current.cause;
  }
  return code;
}
```

Two details matter here. `errors: z.unknown().optional()` must keep `.optional()`: without it zod 4
rejects every body that has no `errors` key, including the `{error, request_id}` body of every 401
and 404. And `clean` redacts before it cuts, so a token at the 1 000-character mark is replaced
whole instead of leaving its first characters behind.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/printify/errors.test.ts`
Expected: PASS, `Tests  16 passed (16)`.

- [ ] **Step 5: Check formatting, lint and types**

Run: `npx prettier --check src test && npx eslint src test && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/printify/errors.ts test/printify/errors.test.ts
git commit -F - <<'EOF'
Add PrintifyApiError and parse both Printify error bodies

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: The client

**Files:**

- Create: `src/printify/client.ts`
- Test: `test/printify/client.test.ts`

**Interfaces:**

- Consumes: `PACKAGE_VERSION` from `src/package-info.ts`; `Secret` from `src/secret.ts`;
  `redactValues` (Task 1); `ApiPath` and `apiPath` (Task 3); `HttpMethod` (Task 4); `Route`,
  `parseJson`, `httpError`, `timeoutError`, `networkError`, `invalidResponseError` and
  `PrintifyApiError` (Task 5).
- Produces: `src/printify/client.ts` exports:
  - `DEFAULT_TIMEOUT_MS = 30_000`
  - `interface PrintifyClientOptions { token: Secret; baseUrl: string; fetch?: typeof globalThis.fetch; timeoutMs?: number }`
  - `type Query = Readonly<Record<string, string | number | boolean | undefined>>`
  - `interface RequestOptions { query?: Query; body?: unknown; signal?: AbortSignal; timeoutMs?: number }`
  - `interface PrintifyClient { request(method: HttpMethod, path: ApiPath, options?: RequestOptions): Promise<unknown> }`
  - `createPrintifyClient(options: PrintifyClientOptions): PrintifyClient`

  Task 7 calls `request('GET', path, { query, signal })`. `fetch` is called as
  `fetch(urlString, { method, headers, body, signal })`, which is the seam #4 wraps.

- [ ] **Step 1: Write the failing test**

Create `test/printify/client.test.ts`:

```ts
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

/** Awaits a promise that must reject, and returns the reason. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function apiError(promise: Promise<unknown>): Promise<PrintifyApiError> {
  const error = await rejection(promise);
  if (error instanceof PrintifyApiError) return error;
  throw new Error(`expected a PrintifyApiError, got ${String(error)}`);
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
    const { printify, requests } = client(() => json({ id: 'abc' }));
    const body = { title: 'Shirt', tags: ['cat'] };
    await expect(
      printify.request('POST', apiPath`/v1/shops/${12}/products.json`, { body }),
    ).resolves.toEqual({ id: 'abc' });
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.body).toBe('{"title":"Shirt","tags":["cat"]}');
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
    const fake = fakeFetch(() => json({ ok: true }));
    vi.stubGlobal('fetch', fake.fetch);
    const printify = createPrintifyClient({ token: new Secret(TOKEN), baseUrl: BASE_URL });
    await expect(printify.request('GET', apiPath`/v1/shops.json`)).resolves.toEqual({ ok: true });
    expect(fake.requests).toHaveLength(1);
  });

  it('times out after 30 seconds by default', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { printify } = client(() => json({}));
    await printify.request('GET', apiPath`/v1/shops.json`);
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(timeout).toHaveBeenCalledWith(30_000);
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
    const echoed = `${TOKEN} ${jwt} ${addressText}`;
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
        body: { external_id: 'o-1', line_items: [], address_to: address },
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
```

The fake `fetch` records the signal the client passed (`init.signal`), not the copy that
`new Request` makes. `neverAnswer` also checks `signal.aborted` first: the real `fetch` rejects at
once for a signal that has already aborted, and the caller-abort tests abort before the fake runs,
so a fake that only listens for the `abort` event would hang until the test times out.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/printify/client.test.ts`
Expected: FAIL with `Error: Cannot find module '../../src/printify/client.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/printify/client.ts`:

```ts
import { PACKAGE_VERSION } from '../package-info.js';
import { redactValues } from '../redact.js';
import type { Secret } from '../secret.js';
import {
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

/** Creates a client. It starts no timers and opens no connections until the first request. */
export function createPrintifyClient(options: PrintifyClientOptions): PrintifyClient {
  // The only reveal() in the codebase: the header needs the token, and errors must scrub it.
  const token = options.token.reveal();
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': `printify-mcp/${PACKAGE_VERSION}`,
    'Content-Type': 'application/json;charset=utf-8',
  };

  return {
    async request(method, path, { query, body, signal, timeoutMs = defaultTimeoutMs } = {}) {
      // fetch would reject this with a TypeError that looks like a network error.
      if (method === 'GET' && body !== undefined) {
        throw new TypeError('A GET request cannot have a body');
      }
      const route: Route = { method, path };
      const fetch = options.fetch ?? globalThis.fetch;
      const timeout = AbortSignal.timeout(timeoutMs);

      let response: Response;
      let text: string;
      try {
        response = await fetch(buildUrl(options.baseUrl, path, query), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]),
        });
        // The timeout covers the body too, so a stalled download still ends on time.
        text = await response.text();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/printify/client.test.ts`
Expected: PASS, `Tests  20 passed (20)`, in well under a second: the timeout tests use 20 ms.

- [ ] **Step 5: Check that the redaction test guards the redaction**

Temporarily change the line `const secrets = [token, ...addressValues(body)];` in
`src/printify/client.ts` to `const secrets = [token];`, then run
`npx vitest run test/printify/client.test.ts`.
Expected: FAIL, `Tests  1 failed | 19 passed (20)`, with
`expected 'post /v1/shops/12/orders.json failed …' not to contain 'johanna'`.
Change it to `const secrets = [...addressValues(body)];` and run again.
Expected: FAIL, the same count, `not to contain 'tok-client-8h7g6f5e'`.
Restore `const secrets = [token, ...addressValues(body)];` and run again.
Expected: PASS, `Tests  20 passed (20)`.

- [ ] **Step 6: Check formatting, lint and types**

Run: `npx prettier --check src test && npx eslint src test && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/printify/client.ts test/printify/client.test.ts
git commit -F - <<'EOF'
Add the Printify HTTP client with timeouts and redacted errors

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7: Pagination

**Files:**

- Create: `src/printify/pagination.ts`
- Test: `test/printify/pagination.test.ts`

**Interfaces:**

- Consumes: `PrintifyClient` and `Query` (Task 6); `invalidResponseError` and `PrintifyApiError`
  (Task 5); `ApiPath` and `apiPath` (Task 3).
- Produces: `src/printify/pagination.ts` exports
  `PAGE_LIMITS = { products: 50, orders: 10, uploads: 100 } as const`,
  `type PagedResource = keyof typeof PAGE_LIMITS`,
  `interface Page { items: unknown[]; page: number; lastPage: number | undefined; total: number | undefined; hasMore: boolean }`,
  `interface PageOptions { page?: number; limit?: number; query?: Query; signal?: AbortSignal }`
  and `fetchPage(client, resource, path, options?): Promise<Page>`. It throws
  `RangeError('<page|limit> must be an integer of at least 1, got <value>')`. #5 uses `PAGE_LIMITS`
  in tool schemas.

- [ ] **Step 1: Write the failing test**

Create `test/printify/pagination.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { PrintifyClient } from '../../src/printify/client.js';
import { PrintifyApiError } from '../../src/printify/errors.js';
import { PAGE_LIMITS, fetchPage } from '../../src/printify/pagination.js';
import { apiPath } from '../../src/printify/path.js';

const PRODUCTS = apiPath`/v1/shops/${12}/products.json`;
const ORDERS = apiPath`/v1/shops/${12}/orders.json`;
const UPLOADS = apiPath`/v1/uploads.json`;

// Shape of the documented GET /v1/shops/{shop_id}/products.json?page=2 example (one item).
const PRODUCTS_PAGE = {
  current_page: 2,
  data: [{ id: '5d39b411749d0a000f30e0f4', title: 'Cotton T-shirt' }],
  first_page_url: '/?page=1',
  from: 2,
  last_page: 22,
  last_page_url: '/?page=22',
  next_page_url: '/?page=3',
  path: '/',
  per_page: 1,
  prev_page_url: '/?page=1',
  to: 2,
  total: 22,
};

// Documented GET /v1/uploads.json example, shortened to one item.
const UPLOADS_PAGE = {
  current_page: 1,
  data: [{ id: '5e16d66791287a0006e522b2', file_name: 'png-images-logo-1.jpg' }],
  first_page_url: '/?page=1',
  from: 1,
  last_page: 1,
  last_page_url: '/?page=1',
  next_page_url: null,
  path: '/',
  per_page: 10,
  prev_page_url: null,
  to: 1,
  total: 1,
};

/** A client whose `request` resolves to `body` and records its arguments. */
function clientReturning(body: unknown) {
  const request = vi.fn<PrintifyClient['request']>(() => Promise.resolve(body));
  return { client: { request } satisfies PrintifyClient, request };
}

describe('fetchPage', () => {
  it('reads the documented products envelope', async () => {
    const { client, request } = clientReturning(PRODUCTS_PAGE);
    await expect(fetchPage(client, 'products', PRODUCTS, { page: 2, limit: 1 })).resolves.toEqual({
      items: PRODUCTS_PAGE.data,
      page: 2,
      lastPage: 22,
      total: 22,
      hasMore: true,
    });
    expect(request).toHaveBeenCalledWith('GET', '/v1/shops/12/products.json', {
      query: { page: 2, limit: 1 },
      signal: undefined,
    });
  });

  it('reads the documented uploads envelope', async () => {
    const { client } = clientReturning(UPLOADS_PAGE);
    await expect(fetchPage(client, 'uploads', UPLOADS)).resolves.toEqual({
      items: UPLOADS_PAGE.data,
      page: 1,
      lastPage: 1,
      total: 1,
      hasMore: false,
    });
  });

  it('works with the documented orders shape of only current_page and data', async () => {
    const tenOrders = Array.from({ length: 10 }, (_, index) => ({ id: `order-${String(index)}` }));
    const full = clientReturning({ current_page: 1, data: tenOrders });
    await expect(fetchPage(full.client, 'orders', ORDERS)).resolves.toEqual({
      items: tenOrders,
      page: 1,
      lastPage: undefined,
      total: undefined,
      hasMore: true,
    });
    const partial = clientReturning({ current_page: 2, data: tenOrders.slice(0, 3) });
    const page = await fetchPage(partial.client, 'orders', ORDERS, { page: 2 });
    expect(page.hasMore).toBe(false);
  });

  it('decides hasMore by last_page, then next_page_url, then the item count', async () => {
    const lastPageWins = clientReturning({
      current_page: 3,
      last_page: 3,
      next_page_url: '/?p=4',
      data: [],
    });
    expect((await fetchPage(lastPageWins.client, 'products', PRODUCTS)).hasMore).toBe(false);
    const nextUrlWins = clientReturning({ current_page: 1, next_page_url: '/?page=2', data: [] });
    expect((await fetchPage(nextUrlWins.client, 'products', PRODUCTS)).hasMore).toBe(true);
    const noNextPage = clientReturning({ current_page: 1, next_page_url: null, data: [{}, {}] });
    expect((await fetchPage(noNextPage.client, 'products', PRODUCTS, { limit: 2 })).hasMore).toBe(
      false,
    );
    const byCount = clientReturning({ current_page: 1, data: [{}, {}] });
    expect((await fetchPage(byCount.client, 'products', PRODUCTS, { limit: 2 })).hasMore).toBe(
      true,
    );
  });

  it.each([
    ['products', 51, 50],
    ['orders', 100, 10],
    ['uploads', 101, 100],
  ] as const)('lowers a %s limit of %i to %i', async (resource, limit, sent) => {
    expect(PAGE_LIMITS[resource]).toBe(sent);
    const { client, request } = clientReturning({ current_page: 1, data: [] });
    await fetchPage(client, resource, PRODUCTS, { limit });
    expect(request.mock.calls[0]?.[2]?.query).toEqual({ page: undefined, limit: sent });
  });

  it('merges page and limit over the query and passes the signal', async () => {
    const { client, request } = clientReturning({ current_page: 1, data: [] });
    const signal = new AbortController().signal;
    await fetchPage(client, 'orders', ORDERS, {
      page: 3,
      query: { status: 'on-hold', page: 9, limit: 9 },
      signal,
    });
    expect(request).toHaveBeenCalledWith('GET', '/v1/shops/12/orders.json', {
      query: { status: 'on-hold', page: 3, limit: undefined },
      signal,
    });
  });

  it.each([
    ['page', { page: 0 }],
    ['page', { page: 1.5 }],
    ['limit', { limit: 0 }],
    ['limit', { limit: Number.NaN }],
  ])('rejects an invalid %s before sending anything', async (name, options) => {
    const { client, request } = clientReturning({ current_page: 1, data: [] });
    await expect(fetchPage(client, 'products', PRODUCTS, options)).rejects.toThrow(
      new RangeError(
        `${name} must be an integer of at least 1, got ${String(Object.values(options)[0])}`,
      ),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ['no data', { current_page: 1 }],
    ['data that is not an array', { current_page: 1, data: {} }],
    ['no current_page', { data: [] }],
    ['a plain array', []],
    ['an empty body', undefined],
  ])('rejects an envelope with %s', async (_, body) => {
    const { client } = clientReturning(body);
    const error = await fetchPage(client, 'products', PRODUCTS).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(PrintifyApiError);
    expect(error).toMatchObject({ kind: 'invalid_response', status: 200 });
    expect((error as PrintifyApiError).message).toBe(
      'GET /v1/shops/12/products.json returned HTTP 200 with an unexpected pagination envelope',
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/printify/pagination.test.ts`
Expected: FAIL with `Error: Cannot find module '../../src/printify/pagination.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/printify/pagination.ts`:

```ts
import { z } from 'zod';
import type { PrintifyClient, Query } from './client.js';
import { invalidResponseError } from './errors.js';
import type { ApiPath } from './path.js';

/** The largest `limit` each paginated endpoint accepts. Tool schemas use these as `.max()`. */
export const PAGE_LIMITS = { products: 50, orders: 10, uploads: 100 } as const;

export type PagedResource = keyof typeof PAGE_LIMITS;

/** Printify's `limit` when none is sent. */
const DEFAULT_LIMIT = 10;

export interface Page {
  items: unknown[];
  page: number;
  lastPage: number | undefined;
  total: number | undefined;
  hasMore: boolean;
}

export interface PageOptions {
  page?: number;
  limit?: number;
  query?: Query;
  signal?: AbortSignal;
}

// Loose on purpose: the documented orders examples show only current_page and data.
const envelopeSchema = z.object({
  current_page: z.number().int(),
  data: z.array(z.unknown()),
  last_page: z.number().int().optional(),
  total: z.number().int().optional(),
  next_page_url: z.string().nullable().optional(),
});

type Envelope = z.infer<typeof envelopeSchema>;

/**
 * Fetches one page of a Laravel-style paginated list. A `limit` above the endpoint's maximum is
 * lowered to it, so the request never fails on it.
 */
export async function fetchPage(
  client: PrintifyClient,
  resource: PagedResource,
  path: ApiPath,
  { page, limit, query, signal }: PageOptions = {},
): Promise<Page> {
  checkPositiveInteger('page', page);
  checkPositiveInteger('limit', limit);
  const sentLimit = limit === undefined ? undefined : Math.min(limit, PAGE_LIMITS[resource]);
  const body = await client.request('GET', path, {
    query: { ...query, page, limit: sentLimit },
    signal,
  });
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidResponseError({ method: 'GET', path }, 200, 'an unexpected pagination envelope');
  }
  const envelope = parsed.data;
  return {
    items: envelope.data,
    page: envelope.current_page,
    lastPage: envelope.last_page,
    total: envelope.total,
    hasMore: hasMore(envelope, sentLimit ?? DEFAULT_LIMIT),
  };
}

function hasMore(envelope: Envelope, limit: number): boolean {
  if (envelope.last_page !== undefined) return envelope.current_page < envelope.last_page;
  if (envelope.next_page_url !== undefined) return envelope.next_page_url !== null;
  return envelope.data.length >= limit;
}

function checkPositiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined && !(Number.isInteger(value) && value >= 1)) {
    throw new RangeError(`${name} must be an integer of at least 1, got ${String(value)}`);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/printify/pagination.test.ts`
Expected: PASS, `Tests  17 passed (17)`.

- [ ] **Step 5: Run the whole suite and the checks**

Run: `npm test && npx prettier --check . && npx eslint . && npm run typecheck`
Expected: `Test Files  11 passed (11)` and `Tests  196 passed (196)`, then no errors.

- [ ] **Step 6: Commit**

```bash
git add src/printify/pagination.ts test/printify/pagination.test.ts
git commit -F - <<'EOF'
Add fetchPage for Printify's paginated lists

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 8: Clean verification, real-API check, pull request and follow-up comments

**Files:** none.

**Interfaces:**

- Consumes: the finished branch.
- Produces: a PR that closes #3 with green CI on Node 22 and 24, and comments on #4, #5 and #6.

- [ ] **Step 1: Verify from a clean install**

Run: `npm ci && npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass, with `Tests  196 passed (196)`. `git status --short` shows nothing, because
`package-lock.json` did not change. `ls dist/printify` lists `client.js`, `errors.js`,
`hints.js`, `pagination.js`, `path.js` and `types.js`.

- [ ] **Step 2: Check the built client against the real API with a dummy token**

This sends two unauthenticated GET requests to `api.printify.com`. No real token is involved and
nothing is created. Run from the repository root:

```bash
node --input-type=module -e "
import { createPrintifyClient } from './dist/printify/client.js';
import { apiPath } from './dist/printify/path.js';
import { Secret } from './dist/secret.js';

const client = createPrintifyClient({
  token: new Secret('dummy-token-not-real'),
  baseUrl: 'https://api.printify.com',
});
for (const path of [apiPath\`/v1/shops.json\`, apiPath\`/v1/nope.json\`]) {
  const error = await client.request('GET', path).catch((error) => error);
  const { name, kind, status, requestId, hint, message } = error;
  console.log(JSON.stringify({ name, kind, status, requestId, hint, message }, null, 2));
}
"
```

Expected: two objects. The request ids differ on every run:

```json
{
  "name": "PrintifyApiError",
  "kind": "http",
  "status": 401,
  "requestId": "1789739152@d7eea0ca-2d82-4f1d-87d7-d8e73193f196",
  "hint": "Printify rejected the token: it is invalid, expired (Personal Access Tokens last one year) or revoked. The user needs a new token in `PRINTIFY_API_TOKEN` in their MCP client config.",
  "message": "GET /v1/shops.json failed with HTTP 401: Unauthenticated. Request id: 1789739152@d7eea0ca-2d82-4f1d-87d7-d8e73193f196"
}
{
  "name": "PrintifyApiError",
  "kind": "http",
  "status": 404,
  "requestId": "1789739153@e264a321-4896-434a-ad19-ce4826b998c0",
  "hint": "Not found. Check the id, and that it belongs to this shop.",
  "message": "GET /v1/nope.json failed with HTTP 404: Not found. Request id: 1789739153@e264a321-4896-434a-ad19-ce4826b998c0"
}
```

Keep this output for the PR description.

- [ ] **Step 3: Push and open the pull request**

```bash
git push -u origin feat/3-http-client
```

Save the PR body below to a temporary file (`BODY=$(mktemp)`, then write it to `"$BODY"`). In the
real-API section, replace the angle-bracket line with the Step 2 output in a fenced `json` block:

```markdown
Closes #3

## Summary

- `src/printify/client.ts`: `createPrintifyClient({ token, baseUrl, fetch?, timeoutMs? })` with one
  `request(method, path, { query, body, signal, timeoutMs })`. It sends `Authorization`,
  `User-Agent: printify-mcp/<version>` and `Content-Type: application/json;charset=utf-8`, applies
  a 30 s timeout that also covers the body, and re-throws the caller's abort reason unchanged.
  `fetch` is injectable; #4 wraps it and #6 fakes it.
- `src/printify/errors.ts`: every failure is a `PrintifyApiError` with `kind` (`http`, `timeout`,
  `network`, `invalid_response`), status, Printify code, message, reason, request id and a hint.
  It reads both error bodies, `{status, code, message, errors}` and `{error, request_id}`, and
  falls back to the `x-pfy-correlation-id` header for the request id.
- `src/printify/hints.ts`: hints for 8203, 8201, 10300, 8103, 8503 / 409, 401, 403 (with a
  probable scope), 404, 429, 5xx, timeouts and network errors.
- The token, JWT-shaped values and every string under `address_to` in the request body are
  redacted from errors before anything is stored or cut.
- `src/printify/path.ts`: `apiPath` URL-encodes every value, so an id from the model cannot change
  the route (for example `../../connection`).
- `src/printify/pagination.ts`: `fetchPage` reads the Laravel envelope, including the orders shape
  with only `current_page` and `data`, and lowers `limit` to the per-endpoint maximum
  (`PAGE_LIMITS`: products 50, orders 10, uploads 100).
- `PRINTIFY_API_BASE_URL` ending in `/v1` or `/v2` is now a configuration error.

Spec: `docs/superpowers/specs/2026-09-18-printify-http-client-design.md`

## Real-API check

Two unauthenticated requests from the built client with a dummy token:

<paste the Step 2 output here>

## Test plan

- [x] `npm run lint`, `npm run typecheck`, `npm test` (196 tests), `npm run build`
- [x] Built client against the real API with a dummy token: 401 and 404 parsed, with request ids
      and hints
- [ ] CI green on Node 22 and 24

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Then run:

```bash
gh pr create --base main --head feat/3-http-client \
  --title "Printify HTTP client with typed errors and pagination" --body-file "$BODY"
```

- [ ] **Step 4: Watch CI**

Run: `gh pr checks --watch`
Expected: `Node 22` and `Node 24` both pass. If a check fails, read its log with
`gh run view --log-failed`, fix the cause on the branch, and push again. Do not merge.

- [ ] **Step 5: Comment on the issues that build on this**

```bash
gh issue comment 4 --body "Notes from the #3 implementation:
- Wrap the injected \`fetch\` (\`PrintifyClientOptions.fetch\` in \`src/printify/client.ts\`). The client calls it as \`fetch(urlString, { method, headers, body, signal })\`; \`body\` is a JSON string, so a retry can send it again.
- The client's \`signal\` combines the timeout (30 s by default) with the caller's signal and covers every attempt. When it aborts, stop retrying. Never retry after the caller's own signal aborted: the client re-throws that reason unchanged.
- Printify documents no \`Retry-After\` or \`X-RateLimit-*\` headers; the probe on 2026-09-18 saw none on 401 and 404 responses. Treat \`Retry-After\` as optional.
- For the fail-fast rate-limit error, throw \`new PrintifyApiError(message, { kind: 'http', method, path, status: 429 })\` from \`src/printify/errors.ts\`: the constructor is public and derives the 429 hint, so #5 handles it like any other error."

gh issue comment 5 --body "Notes from the #3 implementation:
- Build the client in \`createServer(config)\` with \`createPrintifyClient({ token: config.token, baseUrl: config.apiBaseUrl })\`. Creating it has no side effects, so the \`serveStdio\` probe instance is fine.
- Every failure is a \`PrintifyApiError\` (\`src/printify/errors.ts\`). Map \`kind\`, \`status\`, \`code\`, \`printifyMessage\`, \`reason\`, \`requestId\` and \`hint\` to the \`isError\` result. \`message\` is a one-line summary for logs and does not include the hint. All text fields are already redacted.
- A caller abort is re-thrown unchanged and is not a \`PrintifyApiError\`.
- Use \`PAGE_LIMITS\` from \`src/printify/pagination.ts\` as \`.max()\` in tool schemas, and validate ids with zod before building paths with \`apiPath\`: \`apiPath\` throws a \`TypeError\` for empty, \`.\` and \`..\` values."

gh issue comment 6 --body "Notes from the #3 implementation: pass the fake to \`createPrintifyClient({ token, baseUrl, fetch })\`. The client calls \`fetch(urlString, init)\` with a plain \`init\`, so \`new Request(input, init)\` gives the method, URL, headers and body to match routes on. Keep \`init.signal\` rather than the \`Request\` copy, and reject at once when it has already aborted, as the real \`fetch\` does. Error fixtures: the documented body is \`{status: 'error', code, message, errors: {reason, code}}\`, 401 and 404 return \`{error, request_id}\`, and \`requestId\` falls back to the \`x-pfy-correlation-id\` header. \`test/printify/client.test.ts\` has a small \`fakeFetch\` to start from."
```

Expected: each command prints the comment URL.

## Summary

| Task | Deliverable                                                               |
| ---- | ------------------------------------------------------------------------- |
| 1    | `redactJwts` and `redactValues` in `src/redact.ts`, used by `config.ts`   |
| 2    | `PRINTIFY_API_BASE_URL` ending in `/v1` or `/v2` is a configuration error |
| 3    | `apiPath` builds encoded, branded API paths                               |
| 4    | Hints for the assistant and the probable scope on a 403                   |
| 5    | `PrintifyApiError`, both error bodies, messages, cutting and redaction    |
| 6    | `createPrintifyClient`: headers, URL, timeouts, aborts and error mapping  |
| 7    | `fetchPage` with per-endpoint limits and a loose envelope                 |
| 8    | Clean verification, real-API check, PR, follow-up comments on #4, #5, #6  |
