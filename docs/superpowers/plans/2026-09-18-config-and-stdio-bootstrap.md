# Configuration and stdio Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the `PRINTIFY_*` environment at startup with messages that name the variable,
add `--help` and `--version`, and serve MCP over stdio with `serveStdio` so the server answers
`initialize` and `tools/list`.

**Architecture:** `src/config.ts` turns the environment into a typed `Config` with one zod schema
and returns a result (never throws). `src/cli.ts` has a synchronous `main(argv, env, io)` that
handles flags, prints warnings and errors to stderr, and calls `serveStdio(createServer)`.
`src/index.ts` only calls `main` and sets the exit code. Small single-purpose modules support it:
`secret.ts` (redacting token wrapper), `suggest.ts` (did-you-mean), `toolsets.ts`, `log.ts`
(stderr-only) and `package-info.ts` (name and version from `package.json`).

**Tech Stack:** Node >= 22, TypeScript ~6.0.3, MCP TypeScript SDK v2
(`@modelcontextprotocol/server` 2.0.0, `serveStdio` from `@modelcontextprotocol/server/stdio`),
zod 4 (4.6.5 installed), Vitest 5, ESLint 10 with typescript-eslint 8 `strictTypeChecked`,
Prettier 3, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-18-config-and-stdio-bootstrap-design.md`. Read it before
starting. This plan implements it exactly.

## Global Constraints

- Branch: `feat/2-config-bootstrap` (already exists, and the spec is committed on it). Never commit
  to `main`. The branch has no upstream yet; Task 9 pushes it with `-u`.
- No new dependencies. Runtime dependencies stay `@modelcontextprotocol/server` `^2.0.0` and `zod`
  `^4.2.0`. `package.json` and `package-lock.json` do not change.
- zod 4 API: inside `.transform((value, ctx) => …)` report problems with `ctx.addIssue(message)`
  and return `z.NEVER`.
- `"type": "module"` and NodeNext: relative imports use the `.js` suffix, including in tests.
- Nothing in `src/` may use `console.*`. Runtime output goes to stderr through `src/log.ts`. The
  only intended stdout writes outside the MCP transport are `--help` and `--version` via
  `io.stdout.write`. Task 8 enforces this with ESLint `no-console`.
- `createServer()` must stay free of side effects (no timers, clients or open handles), because
  `serveStdio` may call it for a probe instance and discard it.
- The token must never appear in any output: errors, warnings, logs, help, or serialised config.
- Error, warning and log message strings are part of the interface. Tests assert them exactly, so
  copy them verbatim from this plan.
- Lint is typescript-eslint `strictTypeChecked`. No non-null assertions (`!`). Numbers in template
  literals must be wrapped in `String(…)`. The one intentional object-in-template in
  `test/secret.test.ts` carries an `eslint-disable-next-line` with a reason.
- Prettier: `singleQuote: true`, `printWidth: 100`. Every file must pass `prettier --check`. The
  code in this plan is already Prettier-formatted.
- Commit messages use this repo's style: a short imperative sentence with no conventional-commit
  prefix, a blank line, then the trailer
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Everything below was prototyped on 2026-09-18 with Node 24.13.1, zod 4.6.5, Vitest 5.0.1 and MCP
  Inspector 2.7.0. The expected outputs come from that run.

## File Map

| File                       | Responsibility                                                     | Task    |
| -------------------------- | ------------------------------------------------------------------ | ------- |
| `src/secret.ts`            | `Secret`: holds the token, prints as `[redacted]`                  | 1       |
| `test/secret.test.ts`      | Redaction in `String`, templates, JSON and `util.inspect`          | 1       |
| `src/suggest.ts`           | `editDistance`, `closest` for did-you-mean suggestions             | 2       |
| `test/suggest.test.ts`     | Edit distance and closest-match cases                              | 2       |
| `src/toolsets.ts`          | `TOOLSETS`, `Toolset`, `isToolset`                                 | 3       |
| `src/config.ts`            | `loadConfig(env): ConfigResult`, `Config`, `Env`, defaults         | 3, 4, 5 |
| `test/config.test.ts`      | Every variable rule, warnings, token redaction                     | 3, 4, 5 |
| `src/package-info.ts`      | `PACKAGE_NAME`, `PACKAGE_VERSION` read from `package.json`         | 6       |
| `src/server.ts`            | `createServer()`: name/version from package-info, tools capability | 6       |
| `test/server.test.ts`      | Handshake values and `tools/list` over `InMemoryTransport`         | 6       |
| `src/log.ts`               | `createLogger()`: prefixed lines on stderr                         | 7       |
| `src/cli.ts`               | `main(argv, env, io)`: flags, config output, serve, summary        | 7       |
| `test/cli.test.ts`         | Flags, exit codes, stderr/stdout content, summary, `onerror`       | 7       |
| `src/index.ts`             | Shebang entry point: calls `main`, sets `process.exitCode`         | 8       |
| `eslint.config.js`         | Adds `no-console: 'error'` for `src/**/*.ts`                       | 8       |
| `.github/workflows/ci.yml` | Smoke steps: `tools/list`, `--version`, missing-token exit         | 8       |

---

### Task 1: `Secret` wrapper for the token

**Files:**

- Create: `src/secret.ts`
- Test: `test/secret.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `src/secret.ts` exports `class Secret` with `constructor(value: string)`,
  `reveal(): string`, and `toString()`, `toJSON()`, `[inspect.custom]()` that all return the string
  `'[redacted]'`. Task 3 stores the token as a `Secret`; issue #3 will call `reveal()`.

- [ ] **Step 1: Write the failing test**

Create `test/secret.test.ts`:

```ts
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Secret } from '../src/secret.js';

describe('Secret', () => {
  const secret = new Secret('Tok-secret-7Q2w');

  it('returns the value from reveal()', () => {
    expect(secret.reveal()).toBe('Tok-secret-7Q2w');
  });

  it('redacts the value when converted to a string', () => {
    expect(String(secret)).toBe('[redacted]');
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- the case under test
    expect(`token=${secret}`).toBe('token=[redacted]');
  });

  it('redacts the value in JSON', () => {
    expect(JSON.stringify({ token: secret })).toBe('{"token":"[redacted]"}');
  });

  it('redacts the value in util.inspect, which console.log uses', () => {
    expect(inspect({ token: secret })).toBe('{ token: [redacted] }');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/secret.test.ts`
Expected: FAIL with `Error: Cannot find module '../src/secret.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/secret.ts`:

```ts
import { inspect } from 'node:util';

const REDACTED = '[redacted]';

/**
 * Holds a credential so that printing, logging or serialising it never shows the value.
 * Only the code that sends the credential (the HTTP client) should call `reveal()`.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/secret.test.ts`
Expected: PASS, `Tests  4 passed (4)`.

- [ ] **Step 5: Check formatting, lint and types**

Run: `npx prettier --check src/secret.ts test/secret.test.ts && npx eslint src/secret.ts test/secret.test.ts && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/secret.ts test/secret.test.ts
git commit -F - <<'EOF'
Add Secret wrapper that redacts the API token

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Did-you-mean helper

**Files:**

- Create: `src/suggest.ts`
- Test: `test/suggest.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `src/suggest.ts` exports `editDistance(a: string, b: string): number` (Levenshtein)
  and `closest(input: string, candidates: readonly string[], maxDistance = 3): string | undefined`.
  `closest` returns the nearest candidate within `maxDistance` edits, the earlier one on a tie, or
  `undefined`. It is case-sensitive; callers normalise case first. Tasks 3 and 5 use `closest`.

- [ ] **Step 1: Write the failing test**

Create `test/suggest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { closest, editDistance } from '../src/suggest.js';

describe('editDistance', () => {
  it.each([
    ['', '', 0],
    ['abc', '', 3],
    ['', 'abc', 3],
    ['orders', 'orders', 0],
    ['prodcts', 'products', 1],
    ['kitten', 'sitting', 3],
  ])('%j to %j is %i', (a, b, expected) => {
    expect(editDistance(a, b)).toBe(expected);
  });
});

describe('closest', () => {
  const candidates = ['shops', 'catalog', 'products', 'orders'];

  it('returns the nearest candidate within the limit', () => {
    expect(closest('prodcts', candidates)).toBe('products');
  });

  it('returns undefined when no candidate is close enough', () => {
    expect(closest('zzzzzzzz', candidates)).toBeUndefined();
  });

  it('respects a custom limit', () => {
    expect(closest('prodcts', candidates, 0)).toBeUndefined();
  });

  it('prefers the earlier candidate on a tie', () => {
    expect(closest('ab', ['ax', 'ay'])).toBe('ax');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/suggest.test.ts`
Expected: FAIL with `Error: Cannot find module '../src/suggest.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/suggest.ts`. The `?? 0` fallbacks satisfy `noUncheckedIndexedAccess` without non-null
assertions, which lint forbids:

```ts
/** Levenshtein distance: the number of single-character insertions, deletions and substitutions. */
export function editDistance(a: string, b: string): number {
  // previous[j] is the distance between the first i - 1 characters of a and the first j of b.
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Returns the candidate closest to `input`, or `undefined` when none is within `maxDistance`
 * edits. On a tie the earlier candidate wins. Callers normalise letter case first.
 */
export function closest(
  input: string,
  candidates: readonly string[],
  maxDistance = 3,
): string | undefined {
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/suggest.test.ts`
Expected: PASS, `Tests  10 passed (10)`.

- [ ] **Step 5: Check formatting, lint and types**

Run: `npx prettier --check src/suggest.ts test/suggest.test.ts && npx eslint src/suggest.ts test/suggest.test.ts && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/suggest.ts test/suggest.test.ts
git commit -F - <<'EOF'
Add edit-distance helper for did-you-mean suggestions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: `loadConfig` for token, shop, toolsets, flags and base URL

This task builds `config.ts` without `PRINTIFY_UPLOAD_DIRS` (Task 4) and without unknown-variable
warnings or token redaction in errors (Task 5). `uploadDirs` is always `[]` and `warnings` is always
`[]` for now.

**Files:**

- Create: `src/toolsets.ts`
- Create: `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**

- Consumes: `Secret` from `src/secret.ts` (Task 1), `closest` from `src/suggest.ts` (Task 2).
- Produces:
  - `src/toolsets.ts`: `TOOLSETS` (readonly tuple of the 10 names, in this order: `shops`,
    `catalog`, `uploads`, `products`, `publishing`, `personalization`, `orders`, `support`,
    `webhooks`, `workflows`), `type Toolset`, `isToolset(name: string): name is Toolset`.
  - `src/config.ts`: `DEFAULT_API_BASE_URL = 'https://api.printify.com'`,
    `type Env = Readonly<Record<string, string | undefined>>`, `interface Config` (`token: Secret`,
    `shopId: number | undefined`, `toolsets: ReadonlySet<Toolset>`, `enableOrders: boolean`,
    `enableDestructive: boolean`, `uploadDirs: readonly string[]`, `apiBaseUrl: string`),
    `type ConfigResult` (`{ ok: true; config; warnings }` or `{ ok: false; errors; warnings }`),
    and `loadConfig(env: Env): ConfigResult`. Task 7 uses all of these.

- [ ] **Step 1: Write the failing test**

Create `test/config.test.ts`:

```ts
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig, type Config, type ConfigResult, type Env } from '../src/config.js';

// Mixed case on purpose: some values are lower-cased, and the token must not leak through them.
const TOKEN = 'Tok-9F8e7D6c5B4a';
const VALID_TOOLSETS =
  'shops, catalog, uploads, products, publishing, personalization, orders, support, webhooks, workflows';

function load(extra: Env = {}): ConfigResult {
  return loadConfig({ PRINTIFY_API_TOKEN: TOKEN, ...extra });
}

function configOf(result: ConfigResult): Config {
  if (!result.ok) throw new Error(`expected a valid config, got: ${result.errors.join('; ')}`);
  return result.config;
}

function errorsOf(result: ConfigResult): string[] {
  if (result.ok) throw new Error('expected configuration errors');
  return result.errors;
}

describe('loadConfig', () => {
  it('applies the defaults when only the token is set', () => {
    const result = load();
    const config = configOf(result);
    expect(config.token.reveal()).toBe(TOKEN);
    expect(config.shopId).toBeUndefined();
    expect([...config.toolsets].join(', ')).toBe(VALID_TOOLSETS);
    expect(config.enableOrders).toBe(false);
    expect(config.enableDestructive).toBe(false);
    expect(config.uploadDirs).toEqual([]);
    expect(config.apiBaseUrl).toBe('https://api.printify.com');
    expect(result.warnings).toEqual([]);
  });

  it('treats empty optional variables as unset', () => {
    const config = configOf(
      load({
        PRINTIFY_SHOP_ID: '',
        PRINTIFY_TOOLSETS: '  ',
        PRINTIFY_ENABLE_ORDERS: '',
        PRINTIFY_ENABLE_DESTRUCTIVE: ' ',
        PRINTIFY_UPLOAD_DIRS: '',
        PRINTIFY_API_BASE_URL: ' ',
      }),
    );
    expect(config.shopId).toBeUndefined();
    expect(config.toolsets.size).toBe(10);
    expect(config.enableOrders).toBe(false);
    expect(config.enableDestructive).toBe(false);
    expect(config.uploadDirs).toEqual([]);
    expect(config.apiBaseUrl).toBe('https://api.printify.com');
  });

  it('collects every problem in one result', () => {
    const errors = errorsOf(
      loadConfig({
        PRINTIFY_SHOP_ID: 'abc',
        PRINTIFY_TOOLSETS: 'nope',
        PRINTIFY_API_BASE_URL: 'http://api.printify.com',
      }),
    );
    expect(errors).toHaveLength(4);
    expect(errors.map((error) => error.split(/[ :]/)[0])).toEqual([
      'PRINTIFY_API_TOKEN',
      'PRINTIFY_SHOP_ID',
      'PRINTIFY_TOOLSETS',
      'PRINTIFY_API_BASE_URL',
    ]);
  });

  describe('PRINTIFY_API_TOKEN', () => {
    it.each([undefined, '', '   '])('is required (%j)', (value) => {
      expect(errorsOf(loadConfig({ PRINTIFY_API_TOKEN: value }))).toEqual([
        'PRINTIFY_API_TOKEN is required. Create a Personal Access Token in Printify and set it in ' +
          'your MCP client config: https://developers.printify.com/#authentication',
      ]);
    });

    it('is trimmed', () => {
      const config = configOf(loadConfig({ PRINTIFY_API_TOKEN: `  ${TOKEN}\n` }));
      expect(config.token.reveal()).toBe(TOKEN);
    });

    it('is redacted when the config is printed or serialised', () => {
      const config = configOf(load());
      expect(String(config.token)).toBe('[redacted]');
      expect(JSON.stringify(config)).not.toContain(TOKEN);
      expect(inspect(config)).not.toContain(TOKEN);
    });
  });

  describe('PRINTIFY_SHOP_ID', () => {
    it('is parsed as a number', () => {
      expect(configOf(load({ PRINTIFY_SHOP_ID: ' 12345 ' })).shopId).toBe(12345);
    });

    it.each(['abc', '12.5', '-1', '1e3', '99999999999999999999'])('rejects %j', (value) => {
      expect(errorsOf(load({ PRINTIFY_SHOP_ID: value }))).toEqual([
        `PRINTIFY_SHOP_ID must be a numeric shop id, got "${value}"`,
      ]);
    });
  });

  describe('PRINTIFY_TOOLSETS', () => {
    it('trims, lower-cases, skips empty entries and keeps the canonical order', () => {
      const config = configOf(load({ PRINTIFY_TOOLSETS: ' Products, catalog,,CATALOG, ' }));
      expect([...config.toolsets]).toEqual(['catalog', 'products']);
    });

    it('reports each unknown toolset with a suggestion when one is close', () => {
      expect(errorsOf(load({ PRINTIFY_TOOLSETS: 'Prodcts,catalog,zzzzzz' }))).toEqual([
        `PRINTIFY_TOOLSETS: unknown toolset "Prodcts" (did you mean "products"?). Valid toolsets: ${VALID_TOOLSETS}`,
        `PRINTIFY_TOOLSETS: unknown toolset "zzzzzz". Valid toolsets: ${VALID_TOOLSETS}`,
      ]);
    });

    it('rejects a value that names no toolsets', () => {
      expect(errorsOf(load({ PRINTIFY_TOOLSETS: ' , ,' }))).toEqual([
        'PRINTIFY_TOOLSETS names no toolsets. Leave it unset to enable all of them.',
      ]);
    });
  });

  describe('PRINTIFY_ENABLE_ORDERS and PRINTIFY_ENABLE_DESTRUCTIVE', () => {
    it.each([
      ['true', true],
      ['TRUE', true],
      [' True ', true],
      ['false', false],
      ['FALSE', false],
    ])('read %j as %s', (value, expected) => {
      const config = configOf(
        load({ PRINTIFY_ENABLE_ORDERS: value, PRINTIFY_ENABLE_DESTRUCTIVE: value }),
      );
      expect(config.enableOrders).toBe(expected);
      expect(config.enableDestructive).toBe(expected);
    });

    it.each(['1', '0', 'yes', 'on'])('reject %j', (value) => {
      expect(
        errorsOf(load({ PRINTIFY_ENABLE_ORDERS: value, PRINTIFY_ENABLE_DESTRUCTIVE: value })),
      ).toEqual([
        `PRINTIFY_ENABLE_ORDERS must be "true" or "false", got "${value}"`,
        `PRINTIFY_ENABLE_DESTRUCTIVE must be "true" or "false", got "${value}"`,
      ]);
    });
  });

  describe('PRINTIFY_API_BASE_URL', () => {
    it.each([
      ['https://api.printify.com/', 'https://api.printify.com'],
      ['https://proxy.example.com/printify/', 'https://proxy.example.com/printify'],
      ['http://localhost:8080', 'http://localhost:8080'],
      ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
      ['http://[::1]:8080', 'http://[::1]:8080'],
    ])('accepts %s', (value, expected) => {
      expect(configOf(load({ PRINTIFY_API_BASE_URL: value })).apiBaseUrl).toBe(expected);
    });

    it('rejects a value that is not a URL', () => {
      expect(errorsOf(load({ PRINTIFY_API_BASE_URL: 'api.printify.com' }))).toEqual([
        'PRINTIFY_API_BASE_URL is not a valid URL',
      ]);
    });

    it.each(['http://api.printify.com', 'ftp://api.printify.com'])('rejects %s', (value) => {
      expect(errorsOf(load({ PRINTIFY_API_BASE_URL: value }))).toEqual([
        'PRINTIFY_API_BASE_URL must use https (http is allowed only for localhost)',
      ]);
    });

    it.each([
      'https://user:hunter2@api.printify.com',
      'https://api.printify.com/?page=1',
      'https://api.printify.com/?',
      'https://api.printify.com/#top',
    ])('rejects %s', (value) => {
      expect(errorsOf(load({ PRINTIFY_API_BASE_URL: value }))).toEqual([
        'PRINTIFY_API_BASE_URL must not contain credentials, a query or a fragment',
      ]);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL with `Error: Cannot find module '../src/config.js'`.

- [ ] **Step 3: Write `src/toolsets.ts`**

```ts
/** Every toolset `PRINTIFY_TOOLSETS` can enable, in the order help text and logs list them. */
export const TOOLSETS = [
  'shops',
  'catalog',
  'uploads',
  'products',
  'publishing',
  'personalization',
  'orders',
  'support',
  'webhooks',
  'workflows',
] as const;

export type Toolset = (typeof TOOLSETS)[number];

export function isToolset(name: string): name is Toolset {
  return (TOOLSETS as readonly string[]).includes(name);
}
```

- [ ] **Step 4: Write `src/config.ts`**

Notes on choices the tests depend on:

- Every field goes through `variable`, which trims and turns `''` into `undefined`.
- Issue order follows the schema's key order, so keep the keys in this order.
- Toolset errors quote the entry as the user wrote it, not lower-cased (Task 5's redaction relies
  on this).
- `PRINTIFY_API_BASE_URL` errors never quote the value, because a URL can carry credentials. The
  query and fragment check looks at the raw value, so an empty `?` or `#` is rejected too.

```ts
import { z } from 'zod';
import { Secret } from './secret.js';
import { closest } from './suggest.js';
import { TOOLSETS, isToolset, type Toolset } from './toolsets.js';

export const DEFAULT_API_BASE_URL = 'https://api.printify.com';

/** The environment as `process.env` provides it. */
export type Env = Readonly<Record<string, string | undefined>>;

export interface Config {
  token: Secret;
  shopId: number | undefined;
  toolsets: ReadonlySet<Toolset>;
  enableOrders: boolean;
  enableDestructive: boolean;
  /** Real paths of the directories local-file uploads may read from. Empty disables them. */
  uploadDirs: readonly string[];
  /** Base URL without a trailing slash. */
  apiBaseUrl: string;
}

export type ConfigResult =
  | { ok: true; config: Config; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A trimmed variable; an empty value counts as unset. */
const variable = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === '' ? undefined : trimmed;
  });

function flag(name: string) {
  return variable.transform((value, ctx) => {
    const normalised = value?.toLowerCase();
    if (normalised === undefined || normalised === 'false') return false;
    if (normalised === 'true') return true;
    ctx.addIssue(`${name} must be "true" or "false", got "${value ?? ''}"`);
    return z.NEVER;
  });
}

const envSchema = z.object({
  PRINTIFY_API_TOKEN: variable.transform((value, ctx) => {
    if (value !== undefined) return new Secret(value);
    ctx.addIssue(
      'PRINTIFY_API_TOKEN is required. Create a Personal Access Token in Printify and set it in ' +
        'your MCP client config: https://developers.printify.com/#authentication',
    );
    return z.NEVER;
  }),

  PRINTIFY_SHOP_ID: variable.transform((value, ctx) => {
    if (value === undefined) return undefined;
    const id = Number(value);
    if (/^\d+$/.test(value) && Number.isSafeInteger(id)) return id;
    ctx.addIssue(`PRINTIFY_SHOP_ID must be a numeric shop id, got "${value}"`);
    return z.NEVER;
  }),

  PRINTIFY_TOOLSETS: variable.transform((value, ctx): ReadonlySet<Toolset> => {
    if (value === undefined) return new Set(TOOLSETS);
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    if (entries.length === 0) {
      ctx.addIssue('PRINTIFY_TOOLSETS names no toolsets. Leave it unset to enable all of them.');
      return z.NEVER;
    }
    const names = entries.map((entry) => entry.toLowerCase());
    const unknown = entries.filter((_, index) => !isToolset(names[index] ?? ''));
    for (const entry of unknown) {
      const suggestion = closest(entry.toLowerCase(), TOOLSETS);
      const hint = suggestion === undefined ? '' : ` (did you mean "${suggestion}"?)`;
      ctx.addIssue(
        `PRINTIFY_TOOLSETS: unknown toolset "${entry}"${hint}. Valid toolsets: ${TOOLSETS.join(', ')}`,
      );
    }
    if (unknown.length > 0) return z.NEVER;
    return new Set(TOOLSETS.filter((toolset) => names.includes(toolset)));
  }),

  PRINTIFY_ENABLE_ORDERS: flag('PRINTIFY_ENABLE_ORDERS'),
  PRINTIFY_ENABLE_DESTRUCTIVE: flag('PRINTIFY_ENABLE_DESTRUCTIVE'),

  PRINTIFY_API_BASE_URL: variable.transform((value, ctx) => {
    if (value === undefined) return DEFAULT_API_BASE_URL;
    // The value is never echoed: a URL can carry credentials.
    if (!URL.canParse(value)) {
      ctx.addIssue('PRINTIFY_API_BASE_URL is not a valid URL');
      return z.NEVER;
    }
    const url = new URL(value);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
    ) {
      ctx.addIssue('PRINTIFY_API_BASE_URL must use https (http is allowed only for localhost)');
      return z.NEVER;
    }
    if (url.username !== '' || url.password !== '' || value.includes('?') || value.includes('#')) {
      ctx.addIssue('PRINTIFY_API_BASE_URL must not contain credentials, a query or a fragment');
      return z.NEVER;
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  }),
});

/**
 * Reads and validates the configuration from `env`. Never throws and never reads `process.env`
 * itself. All problems are collected; warnings are returned whether or not the config is valid.
 */
export function loadConfig(env: Env): ConfigResult {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => issue.message), warnings: [] };
  }
  const data = parsed.data;
  return {
    ok: true,
    warnings: [],
    config: {
      token: data.PRINTIFY_API_TOKEN,
      shopId: data.PRINTIFY_SHOP_ID,
      toolsets: data.PRINTIFY_TOOLSETS,
      enableOrders: data.PRINTIFY_ENABLE_ORDERS,
      enableDestructive: data.PRINTIFY_ENABLE_DESTRUCTIVE,
      uploadDirs: [],
      apiBaseUrl: data.PRINTIFY_API_BASE_URL,
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS, `Tests  38 passed (38)`.

- [ ] **Step 6: Check formatting, lint and types**

Run: `npx prettier --check src test && npx eslint src test && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/toolsets.ts src/config.ts test/config.test.ts
git commit -F - <<'EOF'
Parse and validate the Printify environment variables

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: `PRINTIFY_UPLOAD_DIRS`

**Files:**

- Modify: `src/config.ts` (imports, one schema field, two helpers, one `loadConfig` line)
- Test: `test/config.test.ts` (imports, one new `describe` block)

**Interfaces:**

- Consumes: `src/config.ts` from Task 3.
- Produces: `Config.uploadDirs` holds the real paths (`fs.realpathSync`) of the configured
  directories, in order, without duplicates. `[]` means local-file uploads are disabled. Issue #10
  relies on the real paths for its containment check.

- [ ] **Step 1: Write the failing test**

In `test/config.test.ts`, replace the first two import lines:

```ts
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
```

with:

```ts
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
```

Then add this block as the last child of `describe('loadConfig', …)`, after the
`describe('PRINTIFY_API_BASE_URL', …)` block:

<!-- prettier-ignore -->
```ts
  describe('PRINTIFY_UPLOAD_DIRS', () => {
    let root: string;

    beforeEach(() => {
      // realpath: on macOS the temp dir is itself behind a symlink (/var -> /private/var).
      root = realpathSync(mkdtempSync(join(tmpdir(), 'printify-mcp-config-')));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('splits on the path delimiter, trims entries, skips empty ones and keeps the order', () => {
      const first = join(root, 'first');
      const second = join(root, 'second');
      mkdirSync(first);
      mkdirSync(second);
      const value = `${second}${delimiter}${delimiter} ${first} `;
      expect(configOf(load({ PRINTIFY_UPLOAD_DIRS: value })).uploadDirs).toEqual([second, first]);
    });

    it('stores real paths and removes duplicates', () => {
      const real = join(root, 'real');
      const link = join(root, 'link');
      mkdirSync(real);
      symlinkSync(real, link);
      const value = `${link}${delimiter}${real}`;
      expect(configOf(load({ PRINTIFY_UPLOAD_DIRS: value })).uploadDirs).toEqual([real]);
    });

    it('expands ~ to the home directory', () => {
      expect(configOf(load({ PRINTIFY_UPLOAD_DIRS: '~' })).uploadDirs).toEqual([
        realpathSync(homedir()),
      ]);
    });

    it('reports a missing directory under ~', () => {
      const value = `~/printify-mcp-missing-${randomUUID()}`;
      expect(errorsOf(load({ PRINTIFY_UPLOAD_DIRS: value }))).toEqual([
        `PRINTIFY_UPLOAD_DIRS: "${value}" does not exist`,
      ]);
    });

    it('reports every bad entry', () => {
      const missing = join(root, 'missing');
      const file = join(root, 'pic.png');
      writeFileSync(file, '');
      const value = ['pics', missing, file, root].join(delimiter);
      expect(errorsOf(load({ PRINTIFY_UPLOAD_DIRS: value }))).toEqual([
        'PRINTIFY_UPLOAD_DIRS: "pics" is not an absolute path',
        `PRINTIFY_UPLOAD_DIRS: "${missing}" does not exist`,
        `PRINTIFY_UPLOAD_DIRS: "${file}" is not a directory`,
      ]);
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, `Tests  5 failed | 38 passed (43)`. The five `PRINTIFY_UPLOAD_DIRS` tests fail
because the variable is still ignored.

- [ ] **Step 3: Implement**

In `src/config.ts`, add these imports above `import { z } from 'zod';`:

```ts
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, sep } from 'node:path';
```

Add this field to `envSchema` between `PRINTIFY_ENABLE_DESTRUCTIVE` and `PRINTIFY_API_BASE_URL`,
with a blank line on each side like the other fields:

```ts
  PRINTIFY_UPLOAD_DIRS: variable.transform((value, ctx): readonly string[] => {
    if (value === undefined) return [];
    const dirs: string[] = [];
    const errors: string[] = [];
    for (const entry of value.split(delimiter).map((part) => part.trim())) {
      if (entry === '') continue;
      const result = resolveUploadDir(entry);
      if (result.ok) dirs.push(result.dir);
      else errors.push(result.error);
    }
    for (const error of errors) ctx.addIssue(error);
    return errors.length > 0 ? z.NEVER : [...new Set(dirs)];
  }),
```

Add these two functions after the closing `});` of `envSchema` and before the `loadConfig` doc
comment. Function declarations are hoisted, so the schema can call `resolveUploadDir` even though
it is defined below:

```ts
function resolveUploadDir(entry: string): { ok: true; dir: string } | { ok: false; error: string } {
  const path = expandHome(entry);
  if (!isAbsolute(path)) {
    return { ok: false, error: `PRINTIFY_UPLOAD_DIRS: "${entry}" is not an absolute path` };
  }
  try {
    if (!statSync(path).isDirectory()) {
      return { ok: false, error: `PRINTIFY_UPLOAD_DIRS: "${entry}" is not a directory` };
    }
    return { ok: true, dir: realpathSync(path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const problem =
      code === 'ENOENT' || code === 'ENOTDIR'
        ? 'does not exist'
        : `cannot be read (${code ?? 'unknown error'})`;
    return { ok: false, error: `PRINTIFY_UPLOAD_DIRS: "${entry}" ${problem}` };
  }
}

function expandHome(entry: string): string {
  if (entry === '~') return homedir();
  if (entry.startsWith('~/') || entry.startsWith(`~${sep}`)) return join(homedir(), entry.slice(2));
  return entry;
}
```

In `loadConfig`, replace `uploadDirs: [],` with:

```ts
      uploadDirs: data.PRINTIFY_UPLOAD_DIRS,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS, `Tests  43 passed (43)`.

- [ ] **Step 5: Check formatting, lint and types**

Run: `npx prettier --check src test && npx eslint src test && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -F - <<'EOF'
Validate PRINTIFY_UPLOAD_DIRS and store real paths

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Unknown-variable warnings and token redaction in errors

**Files:**

- Modify: `src/config.ts` (one constant, one helper, `loadConfig`)
- Test: `test/config.test.ts` (one constant, two new `describe` blocks)

**Interfaces:**

- Consumes: `src/config.ts` from Task 4, `closest` from Task 2.
- Produces: `ConfigResult.warnings` now lists one `unknown variable …` message per unrecognised
  `PRINTIFY_*` variable (any letter case), on both success and failure. Error messages have the
  token's value replaced with `[redacted]`. Task 7 prints the warnings.

- [ ] **Step 1: Write the failing test**

In `test/config.test.ts`, add this constant directly after `VALID_TOOLSETS`, before the blank line
that precedes `function load`:

```ts
const KNOWN_VARIABLES =
  'PRINTIFY_API_TOKEN, PRINTIFY_SHOP_ID, PRINTIFY_TOOLSETS, PRINTIFY_ENABLE_ORDERS, ' +
  'PRINTIFY_ENABLE_DESTRUCTIVE, PRINTIFY_UPLOAD_DIRS, PRINTIFY_API_BASE_URL';
```

Then add these two blocks as the last children of `describe('loadConfig', …)`, after the
`describe('PRINTIFY_UPLOAD_DIRS', …)` block:

<!-- prettier-ignore -->
```ts
  describe('unknown PRINTIFY_ variables', () => {
    it('warns and suggests the closest known variable', () => {
      const result = load({ PRINTIFY_ENABLE_ORDER: 'true' });
      expect(result.warnings).toEqual([
        'unknown variable PRINTIFY_ENABLE_ORDER (did you mean PRINTIFY_ENABLE_ORDERS?)',
      ]);
      expect(result.ok).toBe(true);
    });

    it('lists the known variables when no name is close', () => {
      const result = loadConfig({ PRINTIFY_TOKEN: TOKEN });
      expect(result.warnings).toEqual([
        `unknown variable PRINTIFY_TOKEN. Known variables: ${KNOWN_VARIABLES}`,
      ]);
      expect(errorsOf(result)).toEqual([expect.stringContaining('PRINTIFY_API_TOKEN is required')]);
    });

    it('suggests the upper-case name for a lower-case variable', () => {
      const result = loadConfig({ printify_api_token: TOKEN });
      expect(result.warnings).toEqual([
        'unknown variable printify_api_token (did you mean PRINTIFY_API_TOKEN?)',
      ]);
      expect(result.ok).toBe(false);
    });

    it('does not warn when env lookups ignore case, as on Windows', () => {
      const stored: Record<string, string> = { Printify_Api_Token: TOKEN };
      const env = new Proxy(stored, {
        get: (target, key) =>
          typeof key === 'string'
            ? Object.entries(target).find(([name]) => name.toUpperCase() === key.toUpperCase())?.[1]
            : undefined,
      });
      const result = loadConfig(env);
      expect(result.warnings).toEqual([]);
      expect(configOf(result).token.reveal()).toBe(TOKEN);
    });

    it('ignores variables without the PRINTIFY_ prefix', () => {
      expect(load({ PATH: '/usr/bin', MY_PRINTIFY_TOKEN: 'x' }).warnings).toEqual([]);
    });
  });

  describe('token redaction', () => {
    it('never echoes the token, even when it was pasted into other variables', () => {
      const result = loadConfig({
        PRINTIFY_API_TOKEN: TOKEN,
        PRINTIFY_SHOP_ID: TOKEN,
        PRINTIFY_TOOLSETS: TOKEN,
        PRINTIFY_ENABLE_ORDERS: TOKEN,
        PRINTIFY_UPLOAD_DIRS: TOKEN,
        PRINTIFY_API_BASE_URL: TOKEN,
        PRINTIFY_TOKEN: TOKEN,
      });
      const output = [...errorsOf(result), ...result.warnings].join('\n');
      expect(output).not.toContain(TOKEN);
      expect(output.toLowerCase()).not.toContain(TOKEN.toLowerCase());
      expect(output).toContain('[redacted]');
    });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, `Tests  4 failed | 45 passed (49)`. The failing tests are "warns and suggests the
closest known variable", "lists the known variables when no name is close", "suggests the
upper-case name for a lower-case variable" and "never echoes the token, even when it was pasted
into other variables". The Windows and no-prefix tests already pass, because nothing warns yet.

- [ ] **Step 3: Implement**

In `src/config.ts`, add this constant directly after the closing `});` of `envSchema`, before
`function resolveUploadDir`:

```ts
const KNOWN_VARIABLES = Object.keys(envSchema.shape);
```

Add this function after `expandHome` and before the `loadConfig` doc comment:

```ts
function unknownVariableWarnings(env: Env): string[] {
  const warnings: string[] = [];
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (!upper.startsWith('PRINTIFY_') || KNOWN_VARIABLES.includes(name)) continue;
    // On Windows, env lookups ignore case, so a differently cased known name is not a typo.
    if (KNOWN_VARIABLES.includes(upper) && env[upper] !== undefined) continue;
    const suggestion = closest(upper, KNOWN_VARIABLES);
    warnings.push(
      suggestion === undefined
        ? `unknown variable ${name}. Known variables: ${KNOWN_VARIABLES.join(', ')}`
        : `unknown variable ${name} (did you mean ${suggestion}?)`,
    );
  }
  return warnings;
}
```

Replace the body of `loadConfig` (keep its doc comment) so the whole function reads:

```ts
export function loadConfig(env: Env): ConfigResult {
  const warnings = unknownVariableWarnings(env);
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // A token pasted into the wrong variable would otherwise be echoed in that variable's error.
    // The truthiness check matters: replaceAll('', …) would insert between every character.
    const token = env.PRINTIFY_API_TOKEN?.trim();
    const errors = parsed.error.issues.map((issue) =>
      token ? issue.message.replaceAll(token, '[redacted]') : issue.message,
    );
    return { ok: false, errors, warnings };
  }
  const data = parsed.data;
  return {
    ok: true,
    warnings,
    config: {
      token: data.PRINTIFY_API_TOKEN,
      shopId: data.PRINTIFY_SHOP_ID,
      toolsets: data.PRINTIFY_TOOLSETS,
      enableOrders: data.PRINTIFY_ENABLE_ORDERS,
      enableDestructive: data.PRINTIFY_ENABLE_DESTRUCTIVE,
      uploadDirs: data.PRINTIFY_UPLOAD_DIRS,
      apiBaseUrl: data.PRINTIFY_API_BASE_URL,
    },
  };
}
```

Do not change `token ?` to `token !== undefined`. An empty token would then insert `[redacted]`
between every character. The Task 3 tests for `''` and `'   '` would catch that.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/config.test.ts`
Expected: PASS, `Tests  49 passed (49)`.

- [ ] **Step 5: Check formatting, lint and types**

Run: `npx prettier --check src test && npx eslint src test && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -F - <<'EOF'
Warn about unknown PRINTIFY_ variables and redact the token in errors

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: Package info and the tools capability

**Files:**

- Create: `src/package-info.ts`
- Modify: `src/server.ts` (whole file)
- Test: `test/server.test.ts` (whole file)

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `src/package-info.ts` exports `PACKAGE_NAME: string` and `PACKAGE_VERSION: string`,
  read from `package.json`. Task 7 prints `PACKAGE_VERSION`; issue #3 will use it for
  `User-Agent`. `createServer(): McpServer` keeps its signature and now reports those values and
  declares `capabilities.tools.listChanged: false`.

- [ ] **Step 1: Write the failing test**

Replace `test/server.test.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { createServer } from '../src/server.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

async function connect() {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const received: JSONRPCMessage[] = [];
  clientSide.onmessage = (message) => {
    received.push(message);
  };
  await createServer().connect(serverSide);
  await clientSide.start();
  await clientSide.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '0' },
    },
  });
  await vi.waitFor(() => {
    expect(received).toHaveLength(1);
  });
  return { clientSide, received };
}

describe('createServer', () => {
  it('answers initialize with the name and version from package.json', async () => {
    const { clientSide, received } = await connect();
    expect(received[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        serverInfo: { name: packageJson.name, version: packageJson.version },
        capabilities: { tools: { listChanged: false } },
      },
    });
    await clientSide.close();
  });

  it('answers tools/list with an empty list', async () => {
    const { clientSide, received } = await connect();
    await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await clientSide.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await vi.waitFor(() => {
      expect(received).toHaveLength(2);
    });
    expect(received[1]).toEqual({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    await clientSide.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/server.test.ts`
Expected: FAIL, `Tests  2 failed (2)`. The first test fails because the handshake has no `tools`
capability. The second fails because the server answers `tools/list` with
`-32601 Method not found`.

- [ ] **Step 3: Write `src/package-info.ts`**

```ts
import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Resolves from both src/ (tests) and dist/ (the built package): each sits one level below the root.
const packageJson = z
  .object({ name: z.string(), version: z.string() })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

export const PACKAGE_NAME = packageJson.name;
export const PACKAGE_VERSION = packageJson.version;
```

- [ ] **Step 4: Replace `src/server.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';

/**
 * Builds a fresh MCP server. `serveStdio` may call this for a `server/discover` probe and discard
 * the instance, so it must stay free of side effects: no timers, clients or open handles.
 */
export function createServer(): McpServer {
  return new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    // Declaring tools up front installs the tools/list handler before any tool is registered.
    // Tools are registered once per instance, so the list never changes at runtime.
    { capabilities: { tools: { listChanged: false } } },
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS, `Tests  2 passed (2)`.

- [ ] **Step 6: Check formatting, lint and types**

Run: `npx prettier --check src test && npx eslint src test && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/package-info.ts src/server.ts test/server.test.ts
git commit -F - <<'EOF'
Read name and version from package.json and declare the tools capability

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7: Command line: flags, config output and serving

**Files:**

- Create: `src/log.ts`
- Create: `src/cli.ts`
- Test: `test/cli.test.ts`

**Interfaces:**

- Consumes: `loadConfig`, `Config`, `Env`, `DEFAULT_API_BASE_URL` from `src/config.ts` (Tasks 3–5);
  `TOOLSETS` from `src/toolsets.ts` (Task 3); `PACKAGE_VERSION` from `src/package-info.ts` and
  `createServer` from `src/server.ts` (Task 6); `serveStdio` from
  `@modelcontextprotocol/server/stdio`.
- Produces:
  - `src/log.ts`: `interface Logger { info; warn; error }` (each `(message: string) => void`) and
    `createLogger(write?: (text: string) => unknown): Logger`. Lines are prefixed `printify-mcp: `,
    `printify-mcp: warning: ` and `printify-mcp: error: `. The default `write` is stderr. Issue #5
    will use it to report skipped tools.
  - `src/cli.ts`: `interface CliIo { stdout; stderr; serve }` and
    `main(argv: readonly string[], env: Env, io?: CliIo): number`. Exit codes: 0 (help, version,
    started), 1 (invalid configuration), 2 (usage error). Task 8's `index.ts` calls `main`.

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.ts`:

```ts
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { main, type CliIo } from '../src/cli.js';
import { PACKAGE_VERSION } from '../src/package-info.js';

const TOKEN = 'Tok-cli-5E4d3C2b1A';
const VARIABLES = [
  'PRINTIFY_API_TOKEN',
  'PRINTIFY_SHOP_ID',
  'PRINTIFY_TOOLSETS',
  'PRINTIFY_ENABLE_ORDERS',
  'PRINTIFY_ENABLE_DESTRUCTIVE',
  'PRINTIFY_UPLOAD_DIRS',
  'PRINTIFY_API_BASE_URL',
];
const TOOLSETS = [
  'shops',
  'catalog',
  'uploads',
  'products',
  'publishing',
  'personalization',
  'orders',
  'support',
  'webhooks',
  'workflows',
];

function fakeIo() {
  const output = { stdout: '', stderr: '' };
  const served: Parameters<CliIo['serve']>[] = [];
  const io: CliIo = {
    stdout: {
      write: (text) => {
        output.stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        output.stderr += text;
      },
    },
    serve: (...args) => {
      served.push(args);
    },
  };
  return { io, output, served };
}

describe('main', () => {
  describe('flags', () => {
    it.each([['--help'], ['-h'], ['--version', '--help']])(
      '%j prints help without needing a token',
      (...argv) => {
        const { io, output, served } = fakeIo();
        expect(main(argv, {}, io)).toBe(0);
        expect(output.stdout).toContain('Usage: printify-mcp [--help] [--version]');
        for (const name of [...VARIABLES, ...TOOLSETS]) expect(output.stdout).toContain(name);
        expect(output.stderr).toBe('');
        expect(served).toEqual([]);
      },
    );

    it.each(['--version', '-v'])('%s prints the version without needing a token', (flag) => {
      const { io, output, served } = fakeIo();
      expect(main([flag], {}, io)).toBe(0);
      expect(output.stdout).toBe(`${PACKAGE_VERSION}\n`);
      expect(output.stderr).toBe('');
      expect(served).toEqual([]);
    });

    it.each([
      [['--foo'], "unknown option '--foo'"],
      [['-x'], "unknown option '-x'"],
      [['serve'], "unexpected argument 'serve'"],
      [['--help=yes'], "option '--help' does not take a value"],
    ])('%j is a usage error', (argv, message) => {
      const { io, output, served } = fakeIo();
      expect(main(argv, { PRINTIFY_API_TOKEN: TOKEN }, io)).toBe(2);
      expect(output.stderr).toBe(`printify-mcp: ${message}. Run printify-mcp --help for usage.\n`);
      expect(output.stdout).toBe('');
      expect(served).toEqual([]);
    });
  });

  describe('configuration errors', () => {
    it('exits 1 and names PRINTIFY_API_TOKEN when the token is missing', () => {
      const { io, output, served } = fakeIo();
      expect(main([], {}, io)).toBe(1);
      expect(output.stderr).toBe(
        'printify-mcp: invalid configuration\n' +
          '  - PRINTIFY_API_TOKEN is required. Create a Personal Access Token in Printify and set ' +
          'it in your MCP client config: https://developers.printify.com/#authentication\n' +
          'Set these in the "env" block of the printify-mcp entry in your MCP client config.\n',
      );
      expect(output.stdout).toBe('');
      expect(served).toEqual([]);
    });

    it('exits 1 and names PRINTIFY_TOOLSETS for an unknown toolset', () => {
      const { io, output, served } = fakeIo();
      expect(main([], { PRINTIFY_API_TOKEN: TOKEN, PRINTIFY_TOOLSETS: 'prodcts' }, io)).toBe(1);
      expect(output.stderr).toContain(
        '  - PRINTIFY_TOOLSETS: unknown toolset "prodcts" (did you mean "products"?)',
      );
      expect(output.stdout).toBe('');
      expect(served).toEqual([]);
    });

    it('prints warnings before the errors', () => {
      const { io, output } = fakeIo();
      expect(main([], { PRINTIFY_TOKEN: TOKEN }, io)).toBe(1);
      expect(output.stderr).toMatch(
        /^printify-mcp: warning: unknown variable PRINTIFY_TOKEN\. .*\nprintify-mcp: invalid configuration\n/,
      );
      expect(output.stderr).not.toContain(TOKEN);
    });
  });

  describe('successful start', () => {
    it('serves on stdio and logs a summary', () => {
      const { io, output, served } = fakeIo();
      expect(main([], { PRINTIFY_API_TOKEN: TOKEN }, io)).toBe(0);
      expect(served).toHaveLength(1);
      const call = served[0];
      if (call === undefined) throw new Error('serve was not called');
      const [factory] = call;
      expect(factory()).toBeInstanceOf(McpServer);
      expect(output.stdout).toBe('');
      expect(output.stderr).toBe(
        `printify-mcp: ${PACKAGE_VERSION} on stdio (toolsets: all; orders: off; destructive: off; ` +
          'default shop: none; upload dirs: 0)\n',
      );
    });

    it('summarises a customised configuration without the token', () => {
      const { io, output } = fakeIo();
      const env = {
        PRINTIFY_API_TOKEN: TOKEN,
        PRINTIFY_SHOP_ID: '12345',
        PRINTIFY_TOOLSETS: 'products,catalog',
        PRINTIFY_ENABLE_ORDERS: 'true',
        PRINTIFY_UPLOAD_DIRS: tmpdir(),
        PRINTIFY_API_BASE_URL: 'http://localhost:8080/',
      };
      expect(main([], env, io)).toBe(0);
      expect(output.stderr).toBe(
        `printify-mcp: ${PACKAGE_VERSION} on stdio (toolsets: catalog, products; orders: on; ` +
          'destructive: off; default shop: 12345; upload dirs: 1; api: http://localhost:8080)\n',
      );
      expect(output.stderr).not.toContain(TOKEN);
    });

    it('prints warnings before the summary', () => {
      const { io, output } = fakeIo();
      expect(main([], { PRINTIFY_API_TOKEN: TOKEN, PRINTIFY_ENABLE_ORDER: 'true' }, io)).toBe(0);
      expect(output.stderr.split('\n')[0]).toBe(
        'printify-mcp: warning: unknown variable PRINTIFY_ENABLE_ORDER (did you mean PRINTIFY_ENABLE_ORDERS?)',
      );
      expect(output.stderr.split('\n')[1]).toMatch(/^printify-mcp: .* on stdio \(/);
    });

    it('logs out-of-band server errors to stderr', () => {
      const { io, output, served } = fakeIo();
      main([], { PRINTIFY_API_TOKEN: TOKEN }, io);
      const call = served[0];
      if (call === undefined) throw new Error('serve was not called');
      const [, options] = call;
      options.onerror(new Error('stdout closed'));
      expect(output.stderr).toContain('printify-mcp: error: stdout closed\n');
      expect(output.stdout).toBe('');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL with `Error: Cannot find module '../src/cli.js'`.

- [ ] **Step 3: Write `src/log.ts`**

```ts
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Writes prefixed lines to stderr. Never stdout: stdout carries the MCP protocol. */
export function createLogger(
  write: (text: string) => unknown = (text) => process.stderr.write(text),
): Logger {
  const writer = (prefix: string) => (message: string) => {
    write(`printify-mcp: ${prefix}${message}\n`);
  };
  return { info: writer(''), warn: writer('warning: '), error: writer('error: ') };
}
```

- [ ] **Step 4: Write `src/cli.ts`**

Notes:

- `parseArgs` runs with `strict: false` and `tokens: true`, and the loop validates each token.
  That way usage errors name the option exactly as typed (`rawName`) and don't use Node's generic
  wording.
- `main` is synchronous. `loadConfig` uses sync `fs`, and `serveStdio` returns immediately.
- Importing this module must not run anything, because tests import it.

```ts
import { delimiter } from 'node:path';
import { parseArgs } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DEFAULT_API_BASE_URL, loadConfig, type Config, type Env } from './config.js';
import { createLogger } from './log.js';
import { PACKAGE_VERSION } from './package-info.js';
import { createServer } from './server.js';
import { TOOLSETS } from './toolsets.js';

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  serve: (factory: () => McpServer, options: { onerror: (error: Error) => void }) => unknown;
}

const defaultIo: CliIo = { stdout: process.stdout, stderr: process.stderr, serve: serveStdio };

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type Command = { kind: 'help' | 'version' | 'serve' } | { kind: 'usage-error'; message: string };

function parseCommand(argv: readonly string[]): Command {
  const { tokens } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const names = new Set<string>();
  for (const token of tokens) {
    if (token.kind === 'positional') {
      return { kind: 'usage-error', message: `unexpected argument '${token.value}'` };
    }
    if (token.kind !== 'option') continue;
    if (!(token.name in OPTIONS)) {
      return { kind: 'usage-error', message: `unknown option '${token.rawName}'` };
    }
    if (token.value !== undefined) {
      return { kind: 'usage-error', message: `option '${token.rawName}' does not take a value` };
    }
    names.add(token.name);
  }
  if (names.has('help')) return { kind: 'help' };
  if (names.has('version')) return { kind: 'version' };
  return { kind: 'serve' };
}

function helpText(): string {
  return `printify-mcp ${PACKAGE_VERSION}: MCP server for the Printify print-on-demand API.

Usage: printify-mcp [--help] [--version]

Speaks MCP over stdio. Configure it with environment variables in your MCP client config:

  PRINTIFY_API_TOKEN           required  Printify Personal Access Token
  PRINTIFY_SHOP_ID             optional  Default shop for shop-scoped tools
  PRINTIFY_TOOLSETS            optional  Comma-separated toolsets to enable (default: all)
  PRINTIFY_ENABLE_ORDERS       optional  "true" enables tools that place orders and spend money
  PRINTIFY_ENABLE_DESTRUCTIVE  optional  "true" enables irreversible tools (delete, disconnect, archive)
  PRINTIFY_UPLOAD_DIRS         optional  Directories local-file uploads may read from, separated by "${delimiter}"
  PRINTIFY_API_BASE_URL        optional  API base URL (default: ${DEFAULT_API_BASE_URL})

Toolsets: ${TOOLSETS.join(', ')}

Options:
  -h, --help     Show this help
  -v, --version  Show the version

Documentation: https://github.com/ARau87/printify-mcp#readme
`;
}

function configErrorText(errors: readonly string[]): string {
  const lines = errors.map((error) => `  - ${error}\n`).join('');
  return (
    `printify-mcp: invalid configuration\n${lines}` +
    'Set these in the "env" block of the printify-mcp entry in your MCP client config.\n'
  );
}

function summary(config: Config): string {
  const toolsets =
    config.toolsets.size === TOOLSETS.length
      ? 'all'
      : TOOLSETS.filter((toolset) => config.toolsets.has(toolset)).join(', ');
  const parts = [
    `toolsets: ${toolsets}`,
    `orders: ${config.enableOrders ? 'on' : 'off'}`,
    `destructive: ${config.enableDestructive ? 'on' : 'off'}`,
    `default shop: ${config.shopId === undefined ? 'none' : String(config.shopId)}`,
    `upload dirs: ${String(config.uploadDirs.length)}`,
  ];
  if (config.apiBaseUrl !== DEFAULT_API_BASE_URL) parts.push(`api: ${config.apiBaseUrl}`);
  return `${PACKAGE_VERSION} on stdio (${parts.join('; ')})`;
}

/**
 * Runs the command line and returns the exit code. When it starts the server it returns 0 and the
 * process keeps running until stdin closes.
 */
export function main(argv: readonly string[], env: Env, io: CliIo = defaultIo): number {
  const command = parseCommand(argv);
  switch (command.kind) {
    case 'usage-error':
      io.stderr.write(`printify-mcp: ${command.message}. Run printify-mcp --help for usage.\n`);
      return 2;
    case 'help':
      io.stdout.write(helpText());
      return 0;
    case 'version':
      io.stdout.write(`${PACKAGE_VERSION}\n`);
      return 0;
    case 'serve':
      break;
  }

  const log = createLogger((text) => io.stderr.write(text));
  const result = loadConfig(env);
  for (const warning of result.warnings) log.warn(warning);
  if (!result.ok) {
    io.stderr.write(configErrorText(result.errors));
    return 1;
  }

  io.serve(createServer, {
    onerror: (error) => {
      log.error(error.message);
    },
  });
  log.info(summary(result.config));
  return 0;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/cli.test.ts`
Expected: PASS, `Tests  16 passed (16)`.

- [ ] **Step 6: Run the whole suite, formatting, lint and types**

Run: `npm test && npx prettier --check src test && npx eslint src test && npm run typecheck`
Expected: `Test Files  5 passed (5)` and `Tests  81 passed (81)`, then no errors.

- [ ] **Step 7: Commit**

```bash
git add src/log.ts src/cli.ts test/cli.test.ts
git commit -F - <<'EOF'
Add command line with --help, --version and config error output

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 8: Entry point, `no-console` guard and CI smoke steps

**Files:**

- Modify: `src/index.ts` (whole file)
- Modify: `eslint.config.js` (one config object)
- Modify: `.github/workflows/ci.yml` (the smoke step and two new steps)

**Interfaces:**

- Consumes: `main` from `src/cli.ts` (Task 7).
- Produces: the built `dist/index.js` binary that behaves as the spec describes: exit codes 0, 1 and
  2, `--help`, `--version`, and serving on stdio until stdin reaches EOF.

These three smoke checks are this task's tests. Run them in bash with `-eo pipefail`, which is how
GitHub Actions runs `shell: bash` steps. On macOS, `timeout` comes from GNU coreutils
(`brew install coreutils`). Without it, drop `timeout 10` when running locally.

- [ ] **Step 1: Watch the missing-token check fail against the old entry point**

Run:

```bash
npm run build && RUNNER_TEMP=$(mktemp -d) bash --noprofile --norc -eo pipefail <<'EOF'
unset PRINTIFY_API_TOKEN
if node dist/index.js </dev/null 2>"$RUNNER_TEMP/stderr.txt"; then
  echo "expected a non-zero exit without PRINTIFY_API_TOKEN" >&2
  exit 1
fi
cat "$RUNNER_TEMP/stderr.txt"
grep -q PRINTIFY_API_TOKEN "$RUNNER_TEMP/stderr.txt"
EOF
```

Expected: FAIL. It prints `expected a non-zero exit without PRINTIFY_API_TOKEN` and exits 1,
because the old `index.ts` starts without checking the config.

- [ ] **Step 2: Replace `src/index.ts`**

```ts
#!/usr/bin/env node
import { main } from './cli.js';

try {
  process.exitCode = main(process.argv.slice(2), process.env);
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`printify-mcp: fatal: ${detail}\n`);
  process.exitCode = 1;
}
```

`process.exitCode` is set instead of calling `process.exit()`, so stderr always flushes.

- [ ] **Step 3: Add the `no-console` rule**

In `eslint.config.js`, add this object between the `files: ['**/*.js']` object and `prettier,`:

```js
  {
    // stdout carries the MCP protocol; runtime output goes through src/log.ts (stderr).
    files: ['src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
```

Check that it fires, then undo the probe:

```bash
printf 'console.log("x");\n' >> src/log.ts && npx eslint src/log.ts; git checkout -- src/log.ts
```

Expected: `error  Unexpected console statement  no-console`, and `src/log.ts` is back to its
committed content.

- [ ] **Step 4: Update the CI smoke steps**

In `.github/workflows/ci.yml`, replace the whole `Smoke-run the built server` step (the last step
of the job) with these three steps:

<!-- prettier-ignore -->
```yaml
      - name: Smoke-run the built server
        env:
          PRINTIFY_API_TOKEN: smoke-test-token
        run: |
          output=$(printf '%s\n' \
            '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}' \
            '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
            '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
            | timeout 10 node dist/index.js)
          echo "$output"
          grep -q '"name":"printify-mcp"' <<<"$output"
          grep -q '"tools":\[\]' <<<"$output"
      - name: Check --version
        run: test "$(node dist/index.js --version)" = "$(node -p 'require("./package.json").version')"
      - name: Check that a missing token stops startup
        run: |
          if node dist/index.js </dev/null 2>"$RUNNER_TEMP/stderr.txt"; then
            echo "expected a non-zero exit without PRINTIFY_API_TOKEN" >&2
            exit 1
          fi
          cat "$RUNNER_TEMP/stderr.txt"
          grep -q PRINTIFY_API_TOKEN "$RUNNER_TEMP/stderr.txt"
```

- [ ] **Step 5: Build and run all three smoke checks locally**

Run:

```bash
npm run build && bash --noprofile --norc -eo pipefail <<'EOF'
export PRINTIFY_API_TOKEN=smoke-test-token
output=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | timeout 10 node dist/index.js)
echo "$output"
grep -q '"name":"printify-mcp"' <<<"$output"
grep -q '"tools":\[\]' <<<"$output"
echo SMOKE1-OK
EOF
bash --noprofile --norc -eo pipefail -c 'test "$(node dist/index.js --version)" = "$(node -p "require(\"./package.json\").version")" && echo SMOKE2-OK'
RUNNER_TEMP=$(mktemp -d) bash --noprofile --norc -eo pipefail <<'EOF'
unset PRINTIFY_API_TOKEN
if node dist/index.js </dev/null 2>"$RUNNER_TEMP/stderr.txt"; then
  echo "expected a non-zero exit without PRINTIFY_API_TOKEN" >&2
  exit 1
fi
cat "$RUNNER_TEMP/stderr.txt"
grep -q PRINTIFY_API_TOKEN "$RUNNER_TEMP/stderr.txt"
echo SMOKE3-OK
EOF
```

Expected output:

```
printify-mcp: 0.0.0 on stdio (toolsets: all; orders: off; destructive: off; default shop: none; upload dirs: 0)
{"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"printify-mcp","version":"0.0.0"}},"jsonrpc":"2.0","id":1}
{"result":{"tools":[]},"jsonrpc":"2.0","id":2}
SMOKE1-OK
SMOKE2-OK
printify-mcp: invalid configuration
  - PRINTIFY_API_TOKEN is required. Create a Personal Access Token in Printify and set it in your MCP client config: https://developers.printify.com/#authentication
Set these in the "env" block of the printify-mcp entry in your MCP client config.
SMOKE3-OK
```

The first line is the stderr summary. It shows up in the terminal because only stdout is captured.

- [ ] **Step 6: Run the full check**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass, with `Tests  81 passed (81)`.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts eslint.config.js .github/workflows/ci.yml
git commit -F - <<'EOF'
Start the server through the CLI and extend the CI smoke checks

Forbid console output in src so nothing but the MCP transport writes to stdout.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 9: Clean verification, pull request and follow-up comments

**Files:** none.

**Interfaces:**

- Consumes: the finished branch.
- Produces: a PR that closes #2 with green CI on Node 22 and 24, and comments on #3, #5 and #10.

- [ ] **Step 1: Verify from a clean install**

Run: `npm ci && npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass, with `Tests  81 passed (81)`. `git status --short` shows nothing, because
`package-lock.json` did not change.

- [ ] **Step 2: Verify with the MCP Inspector in both protocol eras**

Run:

```bash
for era in legacy modern; do
  npx -y @modelcontextprotocol/inspector --cli node dist/index.js \
    -e PRINTIFY_API_TOKEN=inspector-dummy --protocol-era "$era" --method tools/list
done
```

Expected, twice, apart from npm deprecation warnings:

```
printify-mcp: 0.0.0 on stdio (toolsets: all; orders: off; destructive: off; default shop: none; upload dirs: 0)
{
  "tools": []
}
```

The server command must come right after `--cli`, followed by the options. The Inspector does not
pass its own environment to the server, so the token must go in with `-e`. Keep this output for
the PR description.

- [ ] **Step 3: Push and open the pull request**

```bash
git push -u origin feat/2-config-bootstrap
```

Save the PR body below to a temporary file (`BODY=$(mktemp)`, then write it to `"$BODY"`). In the
MCP Inspector section, replace the angle-bracket line with the two outputs from Step 2, each in a
fenced code block labelled with its era:

```markdown
Closes #2

## Summary

- `src/config.ts` validates all `PRINTIFY_*` variables with one zod schema and reports every problem
  at once, naming the variable. Unknown `PRINTIFY_*` names produce a did-you-mean warning.
- The token is a `Secret` that prints as `[redacted]`. It is also redacted from errors when it was
  pasted into the wrong variable.
- `printify-mcp --help` and `--version` work without a token. Usage errors exit 2 and config
  errors exit 1. Nothing but the MCP transport writes to stdout, and ESLint `no-console` enforces
  this in `src/`.
- The server starts through `serveStdio(createServer)`, which serves 2025-era and 2026-07-28
  clients. It declares the tools capability, so `tools/list` answers `[]` before any tool exists.
- Name and version come from `package.json`.
- CI smoke steps now cover `tools/list`, `--version` and the missing-token exit.

Spec: `docs/superpowers/specs/2026-09-18-config-and-stdio-bootstrap-design.md`

## MCP Inspector

<paste the Step 2 output for both eras here>

## Test plan

- [x] `npm run lint`, `npm run typecheck`, `npm test` (81 tests), `npm run build`
- [x] The three CI smoke checks, run locally against `dist/index.js`
- [x] MCP Inspector `tools/list` in the legacy and modern protocol eras
- [ ] CI green on Node 22 and 24

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Then run:

```bash
gh pr create --base main --head feat/2-config-bootstrap \
  --title "Configuration and stdio server bootstrap" --body-file "$BODY"
```

- [ ] **Step 4: Watch CI**

Run: `gh pr checks --watch`
Expected: `Node 22` and `Node 24` both pass. If a check fails, read its log with
`gh run view --log-failed`, fix the cause on the branch, and push again. Do not merge.

- [ ] **Step 5: Comment on the issues that consume these interfaces**

```bash
gh issue comment 3 --body "Notes from the #2 implementation:
- The token is \`config.token\`, a \`Secret\` from \`src/secret.ts\`. Call \`reveal()\` only when building the \`Authorization\` header; everywhere else it prints as \`[redacted]\`.
- \`config.apiBaseUrl\` has no trailing slash, so append \`/v1/…\` and \`/v2/…\` directly.
- Take the \`User-Agent\` version from \`PACKAGE_VERSION\` in \`src/package-info.ts\`."

gh issue comment 5 --body "Notes from the #2 implementation:
- Import \`TOOLSETS\`, \`Toolset\` and \`isToolset\` from \`src/toolsets.ts\`; \`config.toolsets\` is a \`ReadonlySet<Toolset>\`.
- \`createServer()\` takes no arguments yet. Add the \`config\` parameter here and pass it from \`main\` in \`src/cli.ts\` (\`io.serve(() => createServer(config), …)\`).
- \`serveStdio\` may call the factory for a probe instance and discard it, so registration must stay free of side effects (no timers or clients per instance).
- The server already declares \`capabilities: { tools: { listChanged: false } }\`.
- Report skipped tools with \`createLogger()\` from \`src/log.ts\` (stderr only; ESLint forbids \`console\` in \`src/\`)."

gh issue comment 10 --body "Notes from the #2 implementation: \`config.uploadDirs\` holds real paths (\`fs.realpathSync\`) of existing directories, validated at startup. An empty array means local-file uploads are disabled; URL and base64 uploads still work. Resolve the requested file with \`realpath\` too before checking it is inside one of the directories."
```

Expected: each command prints the comment URL.

## Summary

| Task | Deliverable                                                      |
| ---- | ---------------------------------------------------------------- |
| 1    | `Secret` redacts the token everywhere it could be printed        |
| 2    | `editDistance` and `closest` for suggestions                     |
| 3    | `loadConfig` for token, shop id, toolsets, flags and base URL    |
| 4    | `PRINTIFY_UPLOAD_DIRS` checked on disk and stored as real paths  |
| 5    | Unknown-variable warnings and token redaction in errors          |
| 6    | Handshake name and version from `package.json`, tools capability |
| 7    | `main`: flags, exit codes, error output, serve and summary       |
| 8    | Entry point, `no-console` guard, CI smoke steps                  |
| 9    | Clean verification, Inspector run, PR, follow-up issue comments  |
