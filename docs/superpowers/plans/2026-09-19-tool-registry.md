# Tool Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tool is one `defineTool()` call, is registered only when its toolset is enabled and
its gate flag (`PRINTIFY_ENABLE_ORDERS` / `PRINTIFY_ENABLE_DESTRUCTIVE`) is set, returns compact
JSON as text and `structuredContent`, and turns every Printify error into an `isError` result with
a hint. When tools are skipped, the server tells the model through MCP `instructions` how the user
turns them on.

**Architecture:** Tools are data. `define.ts` holds the types, `defineTool` and `ToolError`;
`check.ts` lints definitions; `select.ts` splits `ALL_TOOLS` into enabled and skipped tools and
writes the skip log and the server instructions; `reference.ts` lists tools for the README;
`shape.ts` drops nulls; `run.ts` runs a call and maps its outcome, and registers tools on an
`McpServer`. `cli.ts` does the selection, the one Printify client and the logging once per
process, and passes the enabled tools into the side-effect-free `createServer` factory.

**Tech Stack:** Node >= 22, TypeScript ~6.0.3, `@modelcontextprotocol/server` 2.0.0, zod 4.6.5,
Vitest 5, ESLint 10 with typescript-eslint 8 `strictTypeChecked`, Prettier 3.

**Spec:** `docs/superpowers/specs/2026-09-19-tool-registry-design.md`. Read it before starting.
This plan implements it exactly.

## Global Constraints

- Branch: `feat/5-tool-registry` (already exists, with the spec and this plan committed on it).
  Never commit to `main`. The branch has no upstream yet; Task 5 pushes it with `-u`.
- No new dependencies. `package.json` and `package-lock.json` do not change.
- `"type": "module"` and NodeNext: relative imports use the `.js` suffix, including in tests.
- Nothing in `src/` may use `console.*` (ESLint `no-console`). Runtime output goes through the
  `Logger` from `src/log.ts`, which writes to stderr.
- `createServer` must stay free of side effects. The Printify client and the tool selection are
  created once per process in `cli.ts`, never inside `createServer`: `serveStdio` can call the
  factory twice, and a second client would split the rate limiter.
- `ALL_TOOLS` in `src/tools/index.ts` stays empty in this issue. Every test uses the fixture tools
  from `test/tools/fixtures.ts`.
- Every tool input is a `z.strictObject`. In zod 4 a `z.unknown()` key is required unless it is
  marked `.optional()`.
- Log lines, instructions, error fields and hints are part of the interface. Tests assert them
  exactly, so copy them verbatim from this plan.
- Lint is typescript-eslint `strictTypeChecked` plus ESLint's `preserve-caught-error`. No non-null
  assertions (`!`). Numbers in template literals must be wrapped in `String(…)`. Reuse the
  `rejection` helper in `test/printify/helpers.ts` for promises that must reject.
- Prettier: `singleQuote: true`, `printWidth: 100`. Every file must pass `prettier --check`. The
  code in this plan is already Prettier-formatted.
- Commit messages use this repo's style: a short imperative sentence with no conventional-commit
  prefix, a blank line, then exactly this trailer, whatever model writes the commit:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- Everything below was prototyped on 2026-09-19 with Node 24.13.1, Vitest 5.0.1, TypeScript 6.0.3,
  `@modelcontextprotocol/server` 2.0.0 and zod 4.6.5, then replayed task by task in a fresh
  worktree: every task ends with lint, typecheck and Prettier clean. The expected outputs come from
  those runs. The suite has 287 tests in 14 files before Task 1.

## File Map

| File                           | Responsibility                                                   | Task |
| ------------------------------ | ---------------------------------------------------------------- | ---- |
| `src/tools/define.ts`          | `defineTool`, `Tool`, `ToolServices`, `ToolContext`, `ToolError` | 1    |
| `src/tools/check.ts`           | `toolProblems`: the rules every tool definition must follow      | 1    |
| `src/tools/index.ts`           | `ALL_TOOLS`, empty until the first toolset                       | 1    |
| `test/tools/fixtures.ts`       | Fixture tools, config, services and context for every tools test | 1    |
| `test/tools/check.test.ts`     | Each rule, rule order, duplicates                                | 1    |
| `test/tools/catalog.test.ts`   | `ALL_TOOLS` follows the rules                                    | 1    |
| `src/tools/select.ts`          | `selectTools`, `skipLogLines`, `serverInstructions`              | 2    |
| `src/tools/reference.ts`       | `describeTools` for the README tool reference                    | 2    |
| `test/tools/select.test.ts`    | Selection matrix, skip log lines, instructions                   | 2    |
| `test/tools/reference.test.ts` | Order and fields of the tool reference                           | 2    |
| `src/tools/shape.ts`           | `dropNulls`, `omitKeys`                                          | 3    |
| `src/tools/run.ts`             | `runTool` (Task 3), `registerTools` (Task 4)                     | 3, 4 |
| `test/tools/shape.test.ts`     | Nulls at depth, array elements kept, `__proto__`, `omitKeys`     | 3    |
| `test/tools/run.test.ts`       | Success, every error kind, abort, internal errors, logging       | 3    |
| `src/server.ts`                | `createServer({ tools, services, instructions })`                | 4    |
| `src/cli.ts`                   | Selection, client, skip log and instructions, once per process   | 4    |
| `test/support/json-rpc.ts`     | Raw JSON-RPC `connect`, `listTools`, `callTool` until #6         | 4    |
| `test/server.test.ts`          | Rewritten: gating and error results end to end (acceptance)      | 4    |
| `test/cli.test.ts`             | Summary gains the tool count; skip lines; one client             | 4    |

---

### Task 1: Tool definitions and the rules they must follow

**Files:**

- Create: `src/tools/define.ts`, `src/tools/check.ts`, `src/tools/index.ts`
- Create: `test/tools/fixtures.ts`
- Test: `test/tools/check.test.ts`, `test/tools/catalog.test.ts`

**Interfaces:**

- Consumes: `Config` from `src/config.ts`, `Logger` from `src/log.ts`, `PrintifyClient` from
  `src/printify/client.ts`, `Toolset` from `src/toolsets.ts`.
- Produces, in `src/tools/define.ts`:
  - `type Gate = 'orders' | 'destructive'`
  - `interface ToolServices { client: PrintifyClient; config: Config; log: Logger }`
  - `interface ToolContext extends ToolServices { signal: AbortSignal }`
  - `interface ToolAnnotations { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }`
  - `type ToolData = Record<string, unknown>`
  - `interface ToolDefinition<Input extends z.ZodObject>` and the type-erased `interface Tool`
    (`name`, `toolset`, `gate: Gate | undefined`, `description`, `annotations`,
    `input: z.ZodObject`, `handler: (input: unknown, ctx: ToolContext) => Promise<ToolData>`)
  - `defineTool<Input extends z.ZodObject>(definition: ToolDefinition<Input>): Tool`
  - `mcpAnnotations(tool: Tool): ToolAnnotations & { openWorldHint: true }`
  - `class ToolError extends Error { readonly hint: string | undefined; constructor(message: string, hint?: string) }`
- Produces `toolProblems(tools: readonly Tool[]): string[]` in `src/tools/check.ts` and
  `ALL_TOOLS: readonly Tool[]` in `src/tools/index.ts`.
- Produces, in `test/tools/fixtures.ts`: `TOKEN`, `READ_ONLY`, `WRITE`, `DESTRUCTIVE`,
  `fixtureTool(overrides?)`, the fixtures `listShops`, `createOrder` (gate `orders`),
  `deleteProduct` (gate `destructive`), `listWebhooks`, `deleteWebhook` (gate `destructive`),
  `FIXTURE_TOOLS` (those five, in that order), `fixtureConfig(overrides?)`,
  `fixtureServices(fetch?) → { services, logged }` and
  `fixtureContext({ fetch?, signal? }?) → { ctx, logged }`. Tasks 2–4 use them.

- [ ] **Step 1: Write the fixtures and the failing tests**

Create `test/tools/fixtures.ts`:

```ts
import { z } from 'zod';
import { loadConfig, type Config } from '../../src/config.js';
import { createLogger } from '../../src/log.js';
import { createPrintifyClient } from '../../src/printify/client.js';
import {
  defineTool,
  type Tool,
  type ToolAnnotations,
  type ToolContext,
  type ToolDefinition,
  type ToolServices,
} from '../../src/tools/define.js';

export const TOKEN = 'Tok-tools-4D3c2B1a';

export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};
export const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
};
export const DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
};

/** A valid read-only tool in the `shops` toolset, with `overrides` applied. */
export function fixtureTool(overrides: Partial<ToolDefinition<z.ZodObject>> = {}): Tool {
  return defineTool({
    name: 'get_fixture',
    toolset: 'shops',
    description: 'Gets a fixture.',
    annotations: READ_ONLY,
    input: z.strictObject({}),
    handler: () => Promise.resolve({ ok: true }),
    ...overrides,
  });
}

export const listShops = fixtureTool({ name: 'list_shops', description: 'Lists the shops.' });
export const createOrder = fixtureTool({
  name: 'create_order',
  toolset: 'orders',
  gate: 'orders',
  description: 'Places an order.',
  annotations: DESTRUCTIVE,
});
export const deleteProduct = fixtureTool({
  name: 'delete_product',
  toolset: 'products',
  gate: 'destructive',
  description: 'Deletes a product.',
  annotations: DESTRUCTIVE,
});
export const listWebhooks = fixtureTool({
  name: 'list_webhooks',
  toolset: 'webhooks',
  description: 'Lists the webhooks.',
});
export const deleteWebhook = fixtureTool({
  name: 'delete_webhook',
  toolset: 'webhooks',
  gate: 'destructive',
  description: 'Deletes a webhook.',
  annotations: DESTRUCTIVE,
});

/** One read-only tool, both gates, and a toolset (webhooks) with a gated and an ungated tool. */
export const FIXTURE_TOOLS: readonly Tool[] = [
  listShops,
  createOrder,
  deleteProduct,
  listWebhooks,
  deleteWebhook,
];

/** The configuration `loadConfig` gives for just a token, with `overrides` applied. */
export function fixtureConfig(overrides: Partial<Config> = {}): Config {
  const result = loadConfig({ PRINTIFY_API_TOKEN: TOKEN });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return { ...result.config, ...overrides };
}

/** Fails any test that sends a request it did not expect. */
function unexpectedFetch(): Promise<Response> {
  throw new Error('the test did not expect a Printify request');
}

/** Services whose client uses `fetch` and whose log lines land in `logged`. */
export function fixtureServices(fetch: typeof globalThis.fetch = unexpectedFetch) {
  const logged: string[] = [];
  const config = fixtureConfig();
  const services: ToolServices = {
    client: createPrintifyClient({ token: config.token, baseUrl: config.apiBaseUrl, fetch }),
    config,
    log: createLogger((text) => {
      logged.push(text);
    }),
  };
  return { services, logged };
}

/** A tool call's context: `fixtureServices` plus a signal that has not aborted, by default. */
export function fixtureContext(
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
) {
  const { services, logged } = fixtureServices(options.fetch);
  const ctx: ToolContext = { ...services, signal: options.signal ?? new AbortController().signal };
  return { ctx, logged };
}
```

Create `test/tools/check.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolProblems } from '../../src/tools/check.js';
import type { ToolDefinition } from '../../src/tools/define.js';
import { READ_ONLY, WRITE, fixtureTool, listShops } from './fixtures.js';

const LONG_NAME = 'a'.repeat(65);

describe('toolProblems', () => {
  it('finds nothing wrong with valid tools', () => {
    expect(toolProblems([fixtureTool(), listShops])).toEqual([]);
  });

  it.each(['list_shops', 'get_product_gpsr', 'a', 'x2', 'a'.repeat(64)])(
    'accepts the name %s',
    (name) => {
      expect(toolProblems([fixtureTool({ name })])).toEqual([]);
    },
  );

  it('accepts a strict input with a refinement', () => {
    const input = z.strictObject({ a: z.string() }).refine((value) => value.a !== '', 'empty');
    expect(toolProblems([fixtureTool({ input })])).toEqual([]);
  });

  it.each<[string, Partial<ToolDefinition<z.ZodObject>>, string]>([
    [
      'a camelCase name',
      { name: 'getFixture' },
      'getFixture: the name must be snake_case, at most 64 characters',
    ],
    [
      'a double underscore',
      { name: 'get__fixture' },
      'get__fixture: the name must be snake_case, at most 64 characters',
    ],
    [
      'a leading digit',
      { name: '2get' },
      '2get: the name must be snake_case, at most 64 characters',
    ],
    [
      'a name over 64 characters',
      { name: LONG_NAME },
      `${LONG_NAME}: the name must be snake_case, at most 64 characters`,
    ],
    ['a blank description', { description: ' \n' }, 'get_fixture: the description is empty'],
    [
      'a destructive read-only tool',
      { annotations: { ...READ_ONLY, destructiveHint: true } },
      'get_fixture: a read-only tool cannot be destructive',
    ],
    [
      'a gated read-only tool',
      { gate: 'orders' },
      'get_fixture: a read-only tool cannot have a gate',
    ],
    [
      'gate "destructive" without destructiveHint',
      { gate: 'destructive', annotations: WRITE },
      'get_fixture: gate "destructive" needs destructiveHint: true',
    ],
    [
      'an input that strips unknown keys',
      { input: z.object({ id: z.string() }) },
      'get_fixture: the input must be a z.strictObject',
    ],
    [
      'an input that JSON Schema cannot express',
      { input: z.strictObject({ at: z.date() }) },
      'get_fixture: the input cannot be converted to JSON Schema',
    ],
  ])('reports %s', (_, overrides, problem) => {
    expect(toolProblems([fixtureTool(overrides)])).toEqual([problem]);
  });

  it('reports every problem of a tool, in rule order', () => {
    const tool = fixtureTool({ name: 'Bad', description: '', input: z.object({}) });
    expect(toolProblems([tool])).toEqual([
      'Bad: the name must be snake_case, at most 64 characters',
      'Bad: the description is empty',
      'Bad: the input must be a z.strictObject',
    ]);
  });

  it('reports a duplicate name once, after the definition problems', () => {
    const again = fixtureTool({ name: 'list_shops', description: '' });
    expect(toolProblems([listShops, again, listShops])).toEqual([
      'list_shops: the description is empty',
      'list_shops: the name is used by more than one tool',
    ]);
  });
});
```

Create `test/tools/catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { toolProblems } from '../../src/tools/check.js';
import { ALL_TOOLS } from '../../src/tools/index.js';

describe('ALL_TOOLS', () => {
  it('follows every rule for tool definitions', () => {
    expect(toolProblems(ALL_TOOLS)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tools`

Expected: FAIL, `Test Files  2 failed (2)`, with
`Error: Cannot find module '../../src/tools/check.js' imported from …/test/tools/check.test.ts`
(and the same for `catalog.test.ts`).

- [ ] **Step 3: Write the definitions, the rules and the empty tool list**

Create `src/tools/define.ts`:

```ts
import type { z } from 'zod';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';
import type { PrintifyClient } from '../printify/client.js';
import type { Toolset } from '../toolsets.js';

/**
 * The flag a tool needs besides its toolset: `orders` needs PRINTIFY_ENABLE_ORDERS, `destructive`
 * needs PRINTIFY_ENABLE_DESTRUCTIVE.
 */
export type Gate = 'orders' | 'destructive';

/** Created once per process and shared by every tool call. */
export interface ToolServices {
  client: PrintifyClient;
  config: Config;
  log: Logger;
}

/** What a handler gets: the shared services plus the request's cancellation signal. */
export interface ToolContext extends ToolServices {
  signal: AbortSignal;
}

/** All three are required: MCP assumes `destructiveHint: true` for a tool that is not read-only. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

/** What a handler returns: a JSON object, never an array. */
export type ToolData = Record<string, unknown>;

export interface ToolDefinition<Input extends z.ZodObject> {
  /** snake_case, unique across all tools. */
  name: string;
  toolset: Toolset;
  /** Registered only when the gate's flag is on. */
  gate?: Gate;
  /** Written for the model: what the tool does, when to use it, what it costs. */
  description: string;
  annotations: ToolAnnotations;
  /** A `z.strictObject`, so unknown keys are rejected before the handler runs. */
  input: Input;
  handler: (input: z.output<Input>, ctx: ToolContext) => Promise<ToolData>;
}

/** A tool with its input type erased, so `ALL_TOOLS` can be a plain `readonly Tool[]`. */
export interface Tool {
  readonly name: string;
  readonly toolset: Toolset;
  readonly gate: Gate | undefined;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly input: z.ZodObject;
  readonly handler: (input: unknown, ctx: ToolContext) => Promise<ToolData>;
}

/**
 * Defines a tool. The handler returns plain data; the registry turns it into the MCP result and
 * turns a thrown `PrintifyApiError` or `ToolError` into an `isError` result.
 */
export function defineTool<Input extends z.ZodObject>(definition: ToolDefinition<Input>): Tool {
  const { handler } = definition;
  return {
    name: definition.name,
    toolset: definition.toolset,
    gate: definition.gate,
    description: definition.description,
    annotations: definition.annotations,
    input: definition.input,
    // Only registerTools calls this, with arguments the SDK has already parsed with `input`.
    handler: (input, ctx) => handler(input as z.output<Input>, ctx),
  };
}

/** The annotations sent to clients: the tool's hints, plus `openWorldHint` for every tool. */
export function mcpAnnotations(tool: Tool): ToolAnnotations & { openWorldHint: true } {
  return { ...tool.annotations, openWorldHint: true };
}

/**
 * A deliberate refusal, e.g. a locked product or a missing shop id. It becomes an `isError` result
 * of kind `tool` with this message and hint.
 */
export class ToolError extends Error {
  override readonly name = 'ToolError';
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}
```

Create `src/tools/check.ts`:

```ts
import { z } from 'zod';
import type { Tool } from './define.js';

const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;

/**
 * Everything wrong with the tool definitions, one line per problem, each starting with the tool's
 * name. Empty when all is well. The catalog test runs this over `ALL_TOOLS`.
 */
export function toolProblems(tools: readonly Tool[]): string[] {
  const problems = tools.flatMap((tool) =>
    definitionProblems(tool).map((problem) => `${tool.name}: ${problem}`),
  );
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { name } of tools) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  for (const name of duplicates) problems.push(`${name}: the name is used by more than one tool`);
  return problems;
}

function definitionProblems(tool: Tool): string[] {
  const { readOnlyHint, destructiveHint } = tool.annotations;
  const problems: string[] = [];
  if (!NAME_PATTERN.test(tool.name) || tool.name.length > MAX_NAME_LENGTH) {
    problems.push('the name must be snake_case, at most 64 characters');
  }
  if (tool.description.trim() === '') problems.push('the description is empty');
  if (readOnlyHint && destructiveHint) problems.push('a read-only tool cannot be destructive');
  if (readOnlyHint && tool.gate !== undefined) problems.push('a read-only tool cannot have a gate');
  if (tool.gate === 'destructive' && !destructiveHint) {
    problems.push('gate "destructive" needs destructiveHint: true');
  }
  problems.push(...inputProblems(tool.input));
  return problems;
}

function inputProblems(input: z.ZodObject): string[] {
  let schema: z.core.JSONSchema.BaseSchema;
  try {
    schema = z.toJSONSchema(input, { io: 'input' });
  } catch {
    return ['the input cannot be converted to JSON Schema'];
  }
  return schema.additionalProperties === false ? [] : ['the input must be a z.strictObject'];
}
```

Create `src/tools/index.ts`:

```ts
import type { Tool } from './define.js';

/** Every tool the server can offer. Each toolset appends its tools here. */
export const ALL_TOOLS: readonly Tool[] = [];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools`

Expected: PASS, `Test Files  2 passed (2)`, `Tests  20 passed (20)`.

Then run: `npm test && npm run typecheck && npm run lint`

Expected: every command exits 0; `Test Files  16 passed (16)`, `Tests  307 passed (307)`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/define.ts src/tools/check.ts src/tools/index.ts test/tools/fixtures.ts test/tools/check.test.ts test/tools/catalog.test.ts
git commit -F - <<'EOF'
Add tool definitions and the rules they must follow

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: Select tools by toolset and gate, and list them for the README

**Files:**

- Create: `src/tools/select.ts`, `src/tools/reference.ts`
- Test: `test/tools/select.test.ts`, `test/tools/reference.test.ts`

**Interfaces:**

- Consumes: `Tool`, `Gate`, `ToolAnnotations`, `mcpAnnotations` from `src/tools/define.ts`;
  `TOOLSETS`, `Toolset` from `src/toolsets.ts`; `Config` from `src/config.ts`; the fixtures from
  Task 1.
- Produces, in `src/tools/select.ts`:
  - `type SkipReason = 'toolset' | Gate`
  - `interface SkippedTool { tool: Tool; reason: SkipReason }`
  - `interface Selection { enabled: readonly Tool[]; skipped: readonly SkippedTool[] }`
  - `type SelectionConfig = Pick<Config, 'toolsets' | 'enableOrders' | 'enableDestructive'>`
  - `selectTools(tools: readonly Tool[], config: SelectionConfig): Selection`
  - `skipLogLines(skipped: readonly SkippedTool[]): string[]`
  - `serverInstructions(skipped: readonly SkippedTool[]): string | undefined`
- Produces, in `src/tools/reference.ts`: `interface ToolReference` and
  `describeTools(tools: readonly Tool[]): ToolReference[]`.
- Task 4 uses `selectTools`, `skipLogLines`, `serverInstructions`, `Selection` and
  `SelectionConfig`.

- [ ] **Step 1: Write the failing tests**

Create `test/tools/select.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Tool } from '../../src/tools/define.js';
import {
  selectTools,
  serverInstructions,
  skipLogLines,
  type Selection,
  type SelectionConfig,
} from '../../src/tools/select.js';
import { TOOLSETS, type Toolset } from '../../src/toolsets.js';
import { FIXTURE_TOOLS, deleteProduct, listShops, listWebhooks } from './fixtures.js';

const LEAD =
  "Some Printify tools are turned off in this server's configuration. When the user asks for " +
  'something they cover, tell them it is turned off and how to turn it on.';
const END =
  'The user sets these in the "env" block of the printify-mcp entry in their MCP client config, ' +
  'then restarts the client.';

function select(overrides: Partial<SelectionConfig> = {}): Selection {
  return selectTools(FIXTURE_TOOLS, {
    toolsets: new Set(TOOLSETS),
    enableOrders: false,
    enableDestructive: false,
    ...overrides,
  });
}

function toolsets(...names: Toolset[]): ReadonlySet<Toolset> {
  return new Set(names);
}

function names(tools: readonly Tool[]): string[] {
  return tools.map(({ name }) => name);
}

function skipped(selection: Selection): string[] {
  return selection.skipped.map(({ tool, reason }) => `${tool.name}: ${reason}`);
}

describe('selectTools', () => {
  it('skips every gated tool when both flags are off', () => {
    const selection = select();
    expect(names(selection.enabled)).toEqual(['list_shops', 'list_webhooks']);
    expect(skipped(selection)).toEqual([
      'create_order: orders',
      'delete_product: destructive',
      'delete_webhook: destructive',
    ]);
  });

  it('enables the order tools when only PRINTIFY_ENABLE_ORDERS is on', () => {
    const selection = select({ enableOrders: true });
    expect(names(selection.enabled)).toEqual(['list_shops', 'create_order', 'list_webhooks']);
    expect(skipped(selection)).toEqual([
      'delete_product: destructive',
      'delete_webhook: destructive',
    ]);
  });

  it('enables the irreversible tools when only PRINTIFY_ENABLE_DESTRUCTIVE is on', () => {
    const selection = select({ enableDestructive: true });
    expect(names(selection.enabled)).toEqual([
      'list_shops',
      'delete_product',
      'list_webhooks',
      'delete_webhook',
    ]);
    expect(skipped(selection)).toEqual(['create_order: orders']);
  });

  it('enables every tool when both flags are on', () => {
    const selection = select({ enableOrders: true, enableDestructive: true });
    expect(selection.enabled).toEqual(FIXTURE_TOOLS);
    expect(selection.skipped).toEqual([]);
  });

  it('skips a tool of a disabled toolset as "toolset", even when its gate is on', () => {
    const selection = select({
      toolsets: toolsets('shops', 'orders', 'products'),
      enableDestructive: true,
    });
    expect(names(selection.enabled)).toEqual(['list_shops', 'delete_product']);
    expect(skipped(selection)).toEqual([
      'create_order: orders',
      'list_webhooks: toolset',
      'delete_webhook: toolset',
    ]);
  });
});

describe('skipLogLines', () => {
  it('gives one line per reason: orders, destructive, then toolsets', () => {
    const selection = select({ toolsets: toolsets('shops', 'orders', 'products') });
    expect(skipLogLines(selection.skipped)).toEqual([
      'PRINTIFY_ENABLE_ORDERS is off, skipped: create_order',
      'PRINTIFY_ENABLE_DESTRUCTIVE is off, skipped: delete_product',
      'not in PRINTIFY_TOOLSETS, skipped: webhooks (list_webhooks, delete_webhook)',
    ]);
  });

  it('groups skipped toolsets in TOOLSETS order', () => {
    const selection = selectTools([listWebhooks, deleteProduct, listShops], {
      toolsets: toolsets('catalog'),
      enableOrders: true,
      enableDestructive: true,
    });
    expect(skipLogLines(selection.skipped)).toEqual([
      'not in PRINTIFY_TOOLSETS, skipped: shops (list_shops), products (delete_product), ' +
        'webhooks (list_webhooks)',
    ]);
  });

  it('leaves out a reason that skipped nothing', () => {
    expect(skipLogLines(select({ enableOrders: true }).skipped)).toEqual([
      'PRINTIFY_ENABLE_DESTRUCTIVE is off, skipped: delete_product, delete_webhook',
    ]);
  });

  it('gives no lines when nothing is skipped', () => {
    expect(skipLogLines([])).toEqual([]);
  });
});

describe('serverInstructions', () => {
  it('is undefined when nothing is skipped', () => {
    expect(serverInstructions([])).toBeUndefined();
  });

  it('names each group of turned-off tools and how the user turns it on', () => {
    const selection = select({ toolsets: toolsets('shops', 'orders', 'products') });
    expect(serverInstructions(selection.skipped)).toBe(
      `${LEAD}\n` +
        '- Order tools that can spend money (create_order): set PRINTIFY_ENABLE_ORDERS=true.\n' +
        '- Irreversible tools (delete_product): set PRINTIFY_ENABLE_DESTRUCTIVE=true.\n' +
        '- Toolsets not enabled: webhooks (list_webhooks, delete_webhook). Add their names to ' +
        'PRINTIFY_TOOLSETS.\n' +
        END,
    );
  });

  it('lists only the groups that skipped something', () => {
    const instructions = serverInstructions(select({ enableOrders: true }).skipped);
    expect(instructions?.split('\n')).toEqual([
      LEAD,
      '- Irreversible tools (delete_product, delete_webhook): set PRINTIFY_ENABLE_DESTRUCTIVE=true.',
      END,
    ]);
  });
});
```

Create `test/tools/reference.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { describeTools } from '../../src/tools/reference.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  createOrder,
  deleteProduct,
  deleteWebhook,
  listShops,
  listWebhooks,
} from './fixtures.js';

describe('describeTools', () => {
  it('orders the tools by toolset, then by definition order', () => {
    const tools = [listWebhooks, deleteWebhook, createOrder, deleteProduct, listShops];
    expect(describeTools(tools).map(({ name }) => name)).toEqual([
      'list_shops',
      'delete_product',
      'create_order',
      'list_webhooks',
      'delete_webhook',
    ]);
  });

  it('gives name, toolset, gate, annotations with openWorldHint, and description', () => {
    expect(describeTools([deleteProduct, listShops])).toEqual([
      {
        name: 'list_shops',
        toolset: 'shops',
        gate: undefined,
        annotations: { ...READ_ONLY, openWorldHint: true },
        description: 'Lists the shops.',
      },
      {
        name: 'delete_product',
        toolset: 'products',
        gate: 'destructive',
        annotations: { ...DESTRUCTIVE, openWorldHint: true },
        description: 'Deletes a product.',
      },
    ]);
  });

  it('gives an empty list for no tools', () => {
    expect(describeTools([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tools/select.test.ts test/tools/reference.test.ts`

Expected: FAIL, `Test Files  2 failed (2)`, with
`Error: Cannot find module '../../src/tools/select.js'` and
`Error: Cannot find module '../../src/tools/reference.js'`.

- [ ] **Step 3: Write the selection and the reference**

Create `src/tools/select.ts`:

```ts
import type { Config } from '../config.js';
import { TOOLSETS } from '../toolsets.js';
import type { Gate, Tool } from './define.js';

export type SkipReason = 'toolset' | Gate;

export interface SkippedTool {
  tool: Tool;
  reason: SkipReason;
}

export interface Selection {
  enabled: readonly Tool[];
  skipped: readonly SkippedTool[];
}

/** The part of the configuration that decides which tools are registered. */
export type SelectionConfig = Pick<Config, 'toolsets' | 'enableOrders' | 'enableDestructive'>;

const GATES: readonly Gate[] = ['orders', 'destructive'];

const GATE_VARIABLES: Readonly<Record<Gate, string>> = {
  orders: 'PRINTIFY_ENABLE_ORDERS',
  destructive: 'PRINTIFY_ENABLE_DESTRUCTIVE',
};

const GATE_DESCRIPTIONS: Readonly<Record<Gate, string>> = {
  orders: 'Order tools that can spend money',
  destructive: 'Irreversible tools',
};

const INSTRUCTIONS_LEAD =
  "Some Printify tools are turned off in this server's configuration. When the user asks for " +
  'something they cover, tell them it is turned off and how to turn it on.';
const INSTRUCTIONS_END =
  'The user sets these in the "env" block of the printify-mcp entry in their MCP client config, ' +
  'then restarts the client.';

/**
 * Splits `tools` into the ones to register and the ones to skip. A tool is skipped when its
 * toolset is not enabled, or else when its gate's flag is off. Both lists keep the order of
 * `tools`.
 */
export function selectTools(tools: readonly Tool[], config: SelectionConfig): Selection {
  const enabled: Tool[] = [];
  const skipped: SkippedTool[] = [];
  for (const tool of tools) {
    const reason = skipReason(tool, config);
    if (reason === undefined) enabled.push(tool);
    else skipped.push({ tool, reason });
  }
  return { enabled, skipped };
}

/** One stderr line per reason that skipped a tool: the gates first, then the toolsets. */
export function skipLogLines(skipped: readonly SkippedTool[]): string[] {
  const lines = GATES.flatMap((gate) => {
    const names = namesSkippedFor(skipped, gate);
    return names === undefined ? [] : [`${GATE_VARIABLES[gate]} is off, skipped: ${names}`];
  });
  const toolsets = toolsetsSkipped(skipped);
  if (toolsets !== undefined) lines.push(`not in PRINTIFY_TOOLSETS, skipped: ${toolsets}`);
  return lines;
}

/**
 * Tells the model which tools are turned off and how the user turns them on, or `undefined` when
 * nothing was skipped.
 */
export function serverInstructions(skipped: readonly SkippedTool[]): string | undefined {
  if (skipped.length === 0) return undefined;
  const lines = [INSTRUCTIONS_LEAD];
  for (const gate of GATES) {
    const names = namesSkippedFor(skipped, gate);
    if (names !== undefined) {
      lines.push(`- ${GATE_DESCRIPTIONS[gate]} (${names}): set ${GATE_VARIABLES[gate]}=true.`);
    }
  }
  const toolsets = toolsetsSkipped(skipped);
  if (toolsets !== undefined) {
    lines.push(`- Toolsets not enabled: ${toolsets}. Add their names to PRINTIFY_TOOLSETS.`);
  }
  lines.push(INSTRUCTIONS_END);
  return lines.join('\n');
}

function skipReason(tool: Tool, config: SelectionConfig): SkipReason | undefined {
  if (!config.toolsets.has(tool.toolset)) return 'toolset';
  if (tool.gate === 'orders' && !config.enableOrders) return 'orders';
  if (tool.gate === 'destructive' && !config.enableDestructive) return 'destructive';
  return undefined;
}

/** `create_order, cancel_order`, or `undefined` when the gate skipped nothing. */
function namesSkippedFor(skipped: readonly SkippedTool[], gate: Gate): string | undefined {
  const names = skipped.filter(({ reason }) => reason === gate).map(({ tool }) => tool.name);
  return names.length === 0 ? undefined : names.join(', ');
}

/** `webhooks (list_webhooks, create_webhook), support (…)` in `TOOLSETS` order, or `undefined`. */
function toolsetsSkipped(skipped: readonly SkippedTool[]): string | undefined {
  const groups = TOOLSETS.flatMap((toolset) => {
    const names = skipped
      .filter(({ tool, reason }) => reason === 'toolset' && tool.toolset === toolset)
      .map(({ tool }) => tool.name);
    return names.length === 0 ? [] : [`${toolset} (${names.join(', ')})`];
  });
  return groups.length === 0 ? undefined : groups.join(', ');
}
```

Create `src/tools/reference.ts`:

```ts
import { TOOLSETS, type Toolset } from '../toolsets.js';
import { mcpAnnotations, type Gate, type Tool, type ToolAnnotations } from './define.js';

/** One row of the README's tool reference. */
export interface ToolReference {
  name: string;
  toolset: Toolset;
  gate: Gate | undefined;
  annotations: ToolAnnotations & { openWorldHint: true };
  description: string;
}

/** Every tool, in `TOOLSETS` order and then in the order of `tools`. Needs no configuration. */
export function describeTools(tools: readonly Tool[]): ToolReference[] {
  return TOOLSETS.flatMap((toolset) =>
    tools
      .filter((tool) => tool.toolset === toolset)
      .map((tool) => ({
        name: tool.name,
        toolset: tool.toolset,
        gate: tool.gate,
        annotations: mcpAnnotations(tool),
        description: tool.description,
      })),
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/select.test.ts test/tools/reference.test.ts`

Expected: PASS, `Test Files  2 passed (2)`, `Tests  15 passed (15)`.

Then run: `npm test && npm run typecheck && npm run lint`

Expected: every command exits 0; `Test Files  18 passed (18)`, `Tests  322 passed (322)`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/select.ts src/tools/reference.ts test/tools/select.test.ts test/tools/reference.test.ts
git commit -F - <<'EOF'
Select tools by toolset and gate, and list them for the README

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: Turn tool results and errors into MCP results

**Files:**

- Create: `src/tools/shape.ts`, `src/tools/run.ts`
- Test: `test/tools/shape.test.ts`, `test/tools/run.test.ts`

**Interfaces:**

- Consumes: `Tool`, `ToolContext`, `ToolError` from `src/tools/define.ts`; `PrintifyApiError`,
  `httpError`, `timeoutError` from `src/printify/errors.ts`; `redactJwts` from `src/redact.ts`;
  `Logger` from `src/log.ts`; `rejection` from `test/printify/helpers.ts`; the fixtures from Task 1.
- Produces:
  - `dropNulls<T>(value: T): T` and
    `omitKeys<T extends object, K extends keyof T>(object: T, keys: readonly K[]): Omit<T, K>` in
    `src/tools/shape.ts`.
  - `runTool(tool: Tool, input: unknown, ctx: ToolContext): Promise<CallToolResult>` in
    `src/tools/run.ts`. Task 4 adds `registerTools` to the same file.

The error mapping, in the order `runTool` checks it:

| Thrown                              | `error.kind`                                       | Logged                                             |
| ----------------------------------- | -------------------------------------------------- | -------------------------------------------------- |
| Anything, once `ctx.signal` aborted | none: re-thrown unchanged                          | nothing                                            |
| `PrintifyApiError`                  | `http`, `timeout`, `network` or `invalid_response` | `log.warn`: `<tool> failed: <error.message>`       |
| `ToolError`                         | `tool`                                             | nothing                                            |
| Anything else                       | `internal`                                         | `log.error`: `<tool> failed unexpectedly: <stack>` |

- [ ] **Step 1: Write the failing tests**

Create `test/tools/shape.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dropNulls, omitKeys } from '../../src/tools/shape.js';

describe('dropNulls', () => {
  it('removes null and undefined properties at any depth', () => {
    const value = { id: 1, sku: null, cost: undefined, print: { back: null, front: { x: 0.5 } } };
    expect(dropNulls(value)).toStrictEqual({ id: 1, print: { front: { x: 0.5 } } });
  });

  it('keeps array elements, null included, and cleans objects inside arrays', () => {
    const value = { tags: ['a', null], variants: [{ id: 2, sku: null }] };
    expect(dropNulls(value)).toStrictEqual({ tags: ['a', null], variants: [{ id: 2 }] });
  });

  it('keeps false, 0, empty strings, empty arrays and empty objects', () => {
    const value = { visible: false, price: 0, sku: '', tags: [], options: {} };
    expect(dropNulls(value)).toStrictEqual(value);
  });

  it('keeps a "__proto__" key from JSON as a plain property', () => {
    const value: unknown = JSON.parse('{"__proto__":{"x":null},"y":null}');
    const result = dropNulls(value);
    expect(JSON.stringify(result)).toBe('{"__proto__":{}}');
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it('does not change its input and passes other values through', () => {
    const value = { sku: null };
    const date = new Date(0);
    dropNulls(value);
    expect(value).toStrictEqual({ sku: null });
    expect(dropNulls(null)).toBeNull();
    expect(dropNulls('text')).toBe('text');
    expect(dropNulls({ date }).date).toBe(date);
  });
});

describe('omitKeys', () => {
  it('returns a shallow copy without the keys', () => {
    const product = { id: '5f3', title: 'Tee', images: [{ src: 'mockup.png' }], views: [] };
    expect(omitKeys(product, ['images', 'views'])).toStrictEqual({ id: '5f3', title: 'Tee' });
    expect(product.images).toHaveLength(1);
  });
});
```

Create `test/tools/run.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/tools/shape.test.ts test/tools/run.test.ts`

Expected: FAIL, `Test Files  2 failed (2)`, with
`Error: Cannot find module '../../src/tools/shape.js'` and
`Error: Cannot find module '../../src/tools/run.js'`.

- [ ] **Step 3: Write the shaping helpers and `runTool`**

Create `src/tools/shape.ts`:

```ts
/**
 * Removes `null` and `undefined` object properties at any depth. Array elements are kept, so
 * indexes do not shift. Only arrays and plain objects are copied; other values pass through.
 */
export function dropNulls<T>(value: T): T {
  return withoutNulls(value) as T;
}

/** A shallow copy of `object` without `keys`, for a toolset's summaries. */
export function omitKeys<T extends object, K extends keyof T>(
  object: T,
  keys: readonly K[],
): Omit<T, K> {
  const omitted = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(object).filter(([key]) => !omitted.has(key))) as Omit<
    T,
    K
  >;
}

function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!isPlainObject(value)) return value;
  // Object.fromEntries, unlike assignment, keeps a "__proto__" key from JSON as a plain property.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null && item !== undefined)
      .map(([key, item]) => [key, withoutNulls(item)]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
```

Create `src/tools/run.ts`:

```ts
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Logger } from '../log.js';
import { PrintifyApiError } from '../printify/errors.js';
import { redactJwts } from '../redact.js';
import { ToolError, type Tool, type ToolContext } from './define.js';
import { dropNulls } from './shape.js';

const BUG_HINT =
  'This is a bug in printify-mcp. Please report it at ' +
  'https://github.com/ARau87/printify-mcp/issues with the tool name and this message.';

type ErrorFields = Record<string, string | number | undefined>;

/**
 * Runs one tool call. The handler's data becomes `structuredContent` and a compact JSON text
 * block, without nulls. Whatever the handler throws becomes an `isError` result, except after
 * `ctx.signal` aborted: then the error is re-thrown, because nobody reads the reply.
 */
export async function runTool(
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
): Promise<CallToolResult> {
  try {
    const data = dropNulls(await tool.handler(input, ctx));
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    const body = { error: dropNulls(errorFields(tool, error, ctx.log)) };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(body) }],
      structuredContent: body,
    };
  }
}

function errorFields(tool: Tool, error: unknown, log: Logger): ErrorFields {
  if (error instanceof PrintifyApiError) {
    // message is one redacted line; a network error's cause is never logged.
    log.warn(`${tool.name} failed: ${error.message}`);
    return {
      kind: error.kind,
      request: `${error.method} ${error.path}`,
      status: error.status,
      code: error.code,
      // Read explicitly: Error's message is not enumerable.
      message: error.printifyMessage ?? error.message,
      reason: error.reason,
      request_id: error.requestId,
      retry_after_seconds: error.retryAfterSeconds,
      hint: error.hint,
    };
  }
  if (error instanceof ToolError) {
    return { kind: 'tool', message: error.message, hint: error.hint };
  }
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log.error(`${tool.name} failed unexpectedly: ${redactJwts(detail)}`);
  return { kind: 'internal', message: redactJwts(message), hint: BUG_HINT };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools/shape.test.ts test/tools/run.test.ts`

Expected: PASS, `Test Files  2 passed (2)`, `Tests  18 passed (18)`.

Then run: `npm test && npm run typecheck && npm run lint`

Expected: every command exits 0; `Test Files  20 passed (20)`, `Tests  340 passed (340)`.

- [ ] **Step 5: Commit**

```bash
git add src/tools/shape.ts src/tools/run.ts test/tools/shape.test.ts test/tools/run.test.ts
git commit -F - <<'EOF'
Turn tool results and errors into MCP results

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: Register the selected tools on every server, once per process

**Files:**

- Modify: `src/tools/run.ts` (add `registerTools`)
- Modify: `src/server.ts` (new `createServer` signature)
- Modify: `src/cli.ts` (selection, client, skip log and instructions)
- Create: `test/support/json-rpc.ts`
- Test: `test/server.test.ts` (rewritten), `test/cli.test.ts` (extended)

**Interfaces:**

- Consumes: everything from Tasks 1–3; `createPrintifyClient` from `src/printify/client.ts`;
  `apiPath` from `src/printify/path.ts`; `McpServer`, `InMemoryTransport`, `JSONRPCMessage` from
  `@modelcontextprotocol/server`.
- Produces:
  - `registerTools(server: McpServer, tools: readonly Tool[], services: ToolServices): void` in
    `src/tools/run.ts`.
  - `interface CreateServerOptions { tools: readonly Tool[]; services: ToolServices; instructions: string | undefined }`
    and `createServer(options: CreateServerOptions): McpServer` in `src/server.ts`. #6's test
    harness calls these directly.
  - `connect(server: McpServer): Promise<RawMcpClient>` in `test/support/json-rpc.ts`, where
    `RawMcpClient` has `initialized`, `listTools()`, `callTool(name, args)` and `close()`.

`createServer`'s new signature breaks `cli.ts` until it is rewired, so both change in this task.

- [ ] **Step 1: Write the JSON-RPC helper and the failing tests**

Create `test/support/json-rpc.ts`:

```ts
import {
  InMemoryTransport,
  type JSONRPCMessage,
  type McpServer,
} from '@modelcontextprotocol/server';

type Result = Record<string, unknown>;

export interface RawMcpClient {
  /** The result of `initialize`. */
  initialized: Result;
  listTools(): Promise<Result[]>;
  callTool(name: string, args: Result): Promise<Result>;
  close(): Promise<void>;
}

/**
 * Connects to `server` over an in-memory transport and completes the initialize handshake. It
 * speaks raw JSON-RPC until #6 brings the MCP `Client`.
 */
export async function connect(server: McpServer): Promise<RawMcpClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<string | number, (message: JSONRPCMessage) => void>();
  clientSide.onmessage = (message) => {
    if ('id' in message && message.id !== undefined) waiting.get(message.id)?.(message);
  };
  await server.connect(serverSide);
  await clientSide.start();

  let nextId = 1;
  async function request(method: string, params: Result): Promise<Result> {
    const id = nextId;
    nextId += 1;
    const reply = new Promise<JSONRPCMessage>((resolve) => {
      waiting.set(id, resolve);
    });
    await clientSide.send({ jsonrpc: '2.0', id, method, params });
    const message = await reply;
    if (!('result' in message)) throw new Error(`${method} failed: ${JSON.stringify(message)}`);
    return message.result;
  }

  const initialized = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    initialized,
    listTools: async () => (await request('tools/list', {})).tools as Result[],
    callTool: (name, args) => request('tools/call', { name, arguments: args }),
    close: () => clientSide.close(),
  };
}
```

Replace the whole of `test/server.test.ts` with:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { apiPath } from '../src/printify/path.js';
import { createServer } from '../src/server.js';
import { defineTool, type Tool } from '../src/tools/define.js';
import { selectTools, serverInstructions, type SelectionConfig } from '../src/tools/select.js';
import { TOOLSETS } from '../src/toolsets.js';
import { connect } from './support/json-rpc.js';
import { FIXTURE_TOOLS, READ_ONLY, deleteProduct, fixtureServices } from './tools/fixtures.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };

const PRODUCT_ID = '5f3a1b2c3d4e5f6a7b8c9d0e';

const getProduct = defineTool({
  name: 'get_product',
  toolset: 'products',
  description: 'Gets a product.',
  annotations: READ_ONLY,
  input: z.strictObject({ product_id: z.string().regex(/^[0-9a-f]{24}$/) }),
  handler: async ({ product_id }, ctx) => ({
    product: await ctx.client.request('GET', apiPath`/v1/shops/12/products/${product_id}.json`, {
      signal: ctx.signal,
    }),
  }),
});

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function serve(
  tools: readonly Tool[],
  options: { fetch?: typeof globalThis.fetch; instructions?: string } = {},
) {
  const { services } = fixtureServices(options.fetch);
  return connect(createServer({ tools, services, instructions: options.instructions }));
}

describe('createServer', () => {
  it('answers initialize with the name and version from package.json', async () => {
    const mcp = await serve([]);
    expect(mcp.initialized).toMatchObject({
      serverInfo: { name: packageJson.name, version: packageJson.version },
      capabilities: { tools: { listChanged: false } },
    });
    expect(mcp.initialized).not.toHaveProperty('instructions');
    await mcp.close();
  });

  it('sends the instructions in the initialize result', async () => {
    const mcp = await serve([], { instructions: 'Some Printify tools are turned off.' });
    expect(mcp.initialized).toHaveProperty('instructions', 'Some Printify tools are turned off.');
    await mcp.close();
  });

  it('answers tools/list with an empty list when there are no tools', async () => {
    const mcp = await serve([]);
    expect(await mcp.listTools()).toEqual([]);
    await mcp.close();
  });

  it('lists a tool with its hints, openWorldHint and a strict input schema', async () => {
    const mcp = await serve([deleteProduct]);
    expect(await mcp.listTools()).toEqual([
      {
        name: 'delete_product',
        description: 'Deletes a product.',
        inputSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ]);
    await mcp.close();
  });

  describe.each([
    ['destructive', 'delete_product', { enableDestructive: true }],
    ['orders', 'create_order', { enableOrders: true }],
  ] as const)('a tool gated as %s', (_, name, flagOn) => {
    const flagsOff: SelectionConfig = {
      toolsets: new Set(TOOLSETS),
      enableOrders: false,
      enableDestructive: false,
    };

    async function listedNames(config: SelectionConfig) {
      const { enabled, skipped } = selectTools(FIXTURE_TOOLS, config);
      const mcp = await serve(enabled, { instructions: serverInstructions(skipped) });
      const listed = (await mcp.listTools()).map((tool) => tool.name);
      await mcp.close();
      return { listed, instructions: mcp.initialized.instructions };
    }

    it('is absent from tools/list without its flag, and the instructions name it', async () => {
      const { listed, instructions } = await listedNames(flagsOff);
      expect(listed).not.toContain(name);
      expect(instructions).toContain(name);
    });

    it('is present in tools/list with its flag', async () => {
      const { listed } = await listedNames({ ...flagsOff, ...flagOn });
      expect(listed).toContain(name);
    });
  });

  it('returns a successful call as structured content and JSON text', async () => {
    const fetch = fakeFetch(200, { id: PRODUCT_ID, title: 'Tee', sku: null });
    const mcp = await serve([getProduct], { fetch });
    const product = { id: PRODUCT_ID, title: 'Tee' };
    expect(await mcp.callTool('get_product', { product_id: PRODUCT_ID })).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ product }) }],
      structuredContent: { product },
    });
    await mcp.close();
  });

  it('returns a Printify 404 as an isError result with the hint', async () => {
    const fetch = fakeFetch(404, { error: 'Not found', request_id: 'req-1' });
    const mcp = await serve([getProduct], { fetch });
    const error = {
      kind: 'http',
      request: `GET /v1/shops/12/products/${PRODUCT_ID}.json`,
      status: 404,
      message: 'Not found',
      request_id: 'req-1',
      hint: 'Not found. Check the id, and that it belongs to this shop.',
    };
    expect(await mcp.callTool('get_product', { product_id: PRODUCT_ID })).toEqual({
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ error }) }],
      structuredContent: { error },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await mcp.close();
  });

  it('rejects an unknown argument before the handler runs', async () => {
    const fetch = fakeFetch(200, {});
    const mcp = await serve([getProduct], { fetch });
    const result = await mcp.callTool('get_product', { product_id: PRODUCT_ID, detial: 'full' });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result.content)).toContain(
      'Input validation error: Invalid arguments for tool get_product: Unrecognized key: \\"detial\\"',
    );
    expect(fetch).not.toHaveBeenCalled();
    await mcp.close();
  });
});
```

In `test/cli.test.ts`, replace the first five lines (the imports) with:

```ts
import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main, type CliIo } from '../src/cli.js';
import { PACKAGE_VERSION } from '../src/package-info.js';
import { createPrintifyClient } from '../src/printify/client.js';
import type { Tool } from '../src/tools/define.js';
import { connect } from './support/json-rpc.js';
import { FIXTURE_TOOLS } from './tools/fixtures.js';

// ALL_TOOLS is empty until the first toolset lands. The tests below fill this stand-in.
const allTools = vi.hoisted((): Tool[] => []);
vi.mock('../src/tools/index.js', () => ({ ALL_TOOLS: allTools }));
// Spies on createPrintifyClient while keeping the real implementation.
vi.mock('../src/printify/client.js', { spy: true });
```

In `test/cli.test.ts`, in `it('serves on stdio and logs a summary', …)`, replace the expected
summary with:

<!-- prettier-ignore -->
```ts
      expect(output.stderr).toBe(
        `printify-mcp: ${PACKAGE_VERSION} on stdio (tools: 0 of 0; toolsets: all; orders: off; ` +
          'destructive: off; default shop: none; upload dirs: 0)\n',
      );
```

In `it('summarises a customised configuration without the token', …)`, replace the expected
summary with:

<!-- prettier-ignore -->
```ts
      expect(output.stderr).toBe(
        `printify-mcp: ${PACKAGE_VERSION} on stdio (tools: 0 of 0; toolsets: catalog, products; ` +
          'orders: on; destructive: off; default shop: 12345; upload dirs: 1; ' +
          'api: http://localhost:8080)\n',
      );
```

At the end of `test/cli.test.ts`, inside `describe('main', …)` and directly after the closing
`});` of `describe('successful start', …)`, add:

<!-- prettier-ignore -->
```ts
  describe('tools', () => {
    const env = { PRINTIFY_API_TOKEN: TOKEN, PRINTIFY_TOOLSETS: 'shops,orders,products' };

    afterEach(() => {
      allTools.length = 0;
    });

    it('logs the tool count and the skipped tools once', () => {
      allTools.push(...FIXTURE_TOOLS);
      const { io, output, served } = fakeIo();
      expect(main([], env, io)).toBe(0);
      const call = served[0];
      if (call === undefined) throw new Error('serve was not called');
      const [factory] = call;
      factory();
      factory();
      expect(output.stderr).toBe(
        `printify-mcp: ${PACKAGE_VERSION} on stdio (tools: 1 of 5; toolsets: shops, products, ` +
          'orders; orders: off; destructive: off; default shop: none; upload dirs: 0)\n' +
          'printify-mcp: PRINTIFY_ENABLE_ORDERS is off, skipped: create_order\n' +
          'printify-mcp: PRINTIFY_ENABLE_DESTRUCTIVE is off, skipped: delete_product\n' +
          'printify-mcp: not in PRINTIFY_TOOLSETS, skipped: webhooks (list_webhooks, ' +
          'delete_webhook)\n',
      );
    });

    it('creates one client for every server the factory builds', () => {
      vi.mocked(createPrintifyClient).mockClear();
      const { io, served } = fakeIo();
      main([], env, io);
      const call = served[0];
      if (call === undefined) throw new Error('serve was not called');
      const [factory] = call;
      expect(factory()).not.toBe(factory());
      expect(createPrintifyClient).toHaveBeenCalledTimes(1);
    });

    it('serves the enabled tools with instructions for the skipped ones', async () => {
      allTools.push(...FIXTURE_TOOLS);
      const { io, served } = fakeIo();
      main([], env, io);
      const call = served[0];
      if (call === undefined) throw new Error('serve was not called');
      const [factory] = call;
      const mcp = await connect(factory());
      expect((await mcp.listTools()).map((tool) => tool.name)).toEqual(['list_shops']);
      expect(mcp.initialized.instructions).toContain('(create_order)');
      await mcp.close();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server.test.ts test/cli.test.ts`

Expected: FAIL, `Test Files  2 failed (2)`, `Failed Tests 14`. The old `createServer` ignores its
argument, so the server lists no tools and sends no instructions, and the CLI's summary has no
tool count and creates no client. The two `it('answers initialize …')` and
`it('answers tools/list with an empty list …')` tests and the other existing CLI tests still pass.

- [ ] **Step 3: Add `registerTools`**

Replace the whole of `src/tools/run.ts` with:

```ts
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import type { Logger } from '../log.js';
import { PrintifyApiError } from '../printify/errors.js';
import { redactJwts } from '../redact.js';
import {
  ToolError,
  mcpAnnotations,
  type Tool,
  type ToolContext,
  type ToolServices,
} from './define.js';
import { dropNulls } from './shape.js';

const BUG_HINT =
  'This is a bug in printify-mcp. Please report it at ' +
  'https://github.com/ARau87/printify-mcp/issues with the tool name and this message.';

type ErrorFields = Record<string, string | number | undefined>;

/** Registers every tool on `server`. Each call runs through `runTool`. */
export function registerTools(
  server: McpServer,
  tools: readonly Tool[],
  services: ToolServices,
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, annotations: mcpAnnotations(tool) },
      (input, ctx) => runTool(tool, input, { ...services, signal: ctx.mcpReq.signal }),
    );
  }
}

/**
 * Runs one tool call. The handler's data becomes `structuredContent` and a compact JSON text
 * block, without nulls. Whatever the handler throws becomes an `isError` result, except after
 * `ctx.signal` aborted: then the error is re-thrown, because nobody reads the reply.
 */
export async function runTool(
  tool: Tool,
  input: unknown,
  ctx: ToolContext,
): Promise<CallToolResult> {
  try {
    const data = dropNulls(await tool.handler(input, ctx));
    return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    const body = { error: dropNulls(errorFields(tool, error, ctx.log)) };
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(body) }],
      structuredContent: body,
    };
  }
}

function errorFields(tool: Tool, error: unknown, log: Logger): ErrorFields {
  if (error instanceof PrintifyApiError) {
    // message is one redacted line; a network error's cause is never logged.
    log.warn(`${tool.name} failed: ${error.message}`);
    return {
      kind: error.kind,
      request: `${error.method} ${error.path}`,
      status: error.status,
      code: error.code,
      // Read explicitly: Error's message is not enumerable.
      message: error.printifyMessage ?? error.message,
      reason: error.reason,
      request_id: error.requestId,
      retry_after_seconds: error.retryAfterSeconds,
      hint: error.hint,
    };
  }
  if (error instanceof ToolError) {
    return { kind: 'tool', message: error.message, hint: error.hint };
  }
  const message = error instanceof Error ? error.message : String(error);
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  log.error(`${tool.name} failed unexpectedly: ${redactJwts(detail)}`);
  return { kind: 'internal', message: redactJwts(message), hint: BUG_HINT };
}
```

- [ ] **Step 4: Change `createServer`**

Replace the whole of `src/server.ts` with:

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';
import type { Tool, ToolServices } from './tools/define.js';
import { registerTools } from './tools/run.js';

export interface CreateServerOptions {
  /** The tools to register: `selectTools(...).enabled`. */
  tools: readonly Tool[];
  /** Shared by every server instance of the process, so the rate limiter is too. */
  services: ToolServices;
  /** `serverInstructions(...)`: what is turned off, or `undefined` when nothing is. */
  instructions: string | undefined;
}

/**
 * Builds a fresh MCP server. `serveStdio` may call this for a `server/discover` probe and discard
 * the instance, so it must stay free of side effects: no timers, clients or open handles.
 */
export function createServer({ tools, services, instructions }: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    // Declaring tools up front installs the tools/list handler before any tool is registered.
    // Tools are registered once per instance, so the list never changes at runtime.
    { capabilities: { tools: { listChanged: false } }, instructions },
  );
  registerTools(server, tools, services);
  return server;
}
```

- [ ] **Step 5: Wire the tools into `cli.ts`**

In `src/cli.ts`, replace the import lines from `import { PACKAGE_VERSION } …` through
`import { TOOLSETS } …` with:

```ts
import { PACKAGE_VERSION } from './package-info.js';
import { createPrintifyClient } from './printify/client.js';
import { createServer } from './server.js';
import type { ToolServices } from './tools/define.js';
import { ALL_TOOLS } from './tools/index.js';
import { selectTools, serverInstructions, skipLogLines, type Selection } from './tools/select.js';
import { TOOLSETS } from './toolsets.js';
```

Replace the start of `summary` up to and including the first entry of `parts`:

<!-- prettier-ignore -->
```ts
function summary(config: Config, selection: Selection): string {
  const total = selection.enabled.length + selection.skipped.length;
  const toolsets =
    config.toolsets.size === TOOLSETS.length
      ? 'all'
      : TOOLSETS.filter((toolset) => config.toolsets.has(toolset)).join(', ');
  const parts = [
    `tools: ${String(selection.enabled.length)} of ${String(total)}`,
    `toolsets: ${toolsets}`,
```

At the end of `main`, replace everything from `io.serve(createServer, {` up to and including
`return 0;` with:

<!-- prettier-ignore -->
```ts
  // Everything below happens once per process, however often serve calls the factory: one
  // client, and so one rate limiter, for every server instance.
  const { config } = result;
  const selection = selectTools(ALL_TOOLS, config);
  const client = createPrintifyClient({ token: config.token, baseUrl: config.apiBaseUrl });
  const services: ToolServices = { client, config, log };
  const instructions = serverInstructions(selection.skipped);
  io.serve(() => createServer({ tools: selection.enabled, services, instructions }), {
    onerror: (error) => {
      log.error(error.message);
    },
  });
  log.info(summary(config, selection));
  for (const line of skipLogLines(selection.skipped)) log.info(line);
  return 0;
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/server.test.ts test/cli.test.ts`

Expected: PASS, `Test Files  2 passed (2)`, `Tests  33 passed (33)`.

Then run: `npm test && npm run typecheck && npm run lint && npm run build`

Expected: every command exits 0; `Test Files  20 passed (20)`, `Tests  352 passed (352)`;
`dist/tools/` holds `check.js`, `define.js`, `index.js`, `reference.js`, `run.js`, `select.js` and
`shape.js`.

- [ ] **Step 7: Smoke-run the built server over stdio**

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | PRINTIFY_API_TOKEN=Tok-smoke-1 node dist/index.js
```

Expected: stderr shows
`printify-mcp: 0.0.0 on stdio (tools: 0 of 0; toolsets: all; orders: off; destructive: off; default shop: none; upload dirs: 0)`;
stdout has two JSON lines, the `initialize` result (with no `instructions` key) and
`{"result":{"tools":[]},"jsonrpc":"2.0","id":2}`. This is what the CI smoke step checks.

- [ ] **Step 8: Commit**

```bash
git add src/tools/run.ts src/server.ts src/cli.ts test/support/json-rpc.ts test/server.test.ts test/cli.test.ts
git commit -F - <<'EOF'
Register the selected tools on every server, once per process

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Clean verification, pull request and hand-off comments

**Files:** none.

- [ ] **Step 1: Verify from a clean install**

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: every command exits 0; `Test Files  20 passed (20)` and `Tests  352 passed (352)`;
`dist/tools/run.js` and `dist/tools/select.js` exist.

- [ ] **Step 2: Check the commit trailers**

Run: `git log --format='%h %s | %(trailers:only,unfold)' origin/main..HEAD`

Expected: every commit ends with
`Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` and no other
`Co-Authored-By` line. Fix any other trailer before pushing.

- [ ] **Step 3: Push and open the pull request**

```bash
git push -u origin feat/5-tool-registry
gh pr create --base main --title "Tool registry with toolsets, safety gating and response shaping" --body-file - <<'EOF'
Closes #5

## Summary

- **Definitions:** a tool is one `defineTool()` call with a snake_case name, a toolset, an optional
  gate (`orders` or `destructive`), a description for the model, all three annotation hints, a
  `z.strictObject` input and a handler. `openWorldHint: true` is added to every tool. A catalog
  test runs `toolProblems` over `ALL_TOOLS`, so every toolset gets the rules checked: snake_case
  and unique names, no gate or destructive hint on read-only tools, `destructiveHint` on
  `destructive`-gated tools, strict inputs that convert to JSON Schema.
- **Gating:** `selectTools` registers a tool only if its toolset is enabled and its gate flag
  (`PRINTIFY_ENABLE_ORDERS` / `PRINTIFY_ENABLE_DESTRUCTIVE`) is set. Startup logs one stderr line
  per reason, and the summary gains `tools: N of M`. When something is skipped, the server sends
  MCP `instructions` that name the skipped tools and the variable that turns each group on, so
  "Delete this product" without the flag gets a useful answer.
- **Results:** handler data is sent as `structuredContent` and as compact JSON text, with nulls
  dropped at every depth (array elements are kept).
- **Errors:** a `PrintifyApiError` becomes `isError: true` with `kind`, `request`, `status`,
  `code`, `message`, `reason`, `request_id`, `retry_after_seconds` and `hint`, never a thrown
  exception. `ToolError` covers deliberate refusals; anything else is a redacted `internal` error
  that asks for a bug report and is logged with its stack. A cancelled call re-throws.
- **Wiring:** `cli.ts` selects the tools and creates the one Printify client once per process;
  `createServer({ tools, services, instructions })` stays side-effect free, so the `serveStdio`
  probe instance shares the client and its rate limiter.
- **README:** `describeTools(ALL_TOOLS)` gives name, toolset, gate, annotations and description
  for the tool reference (#21).

`ALL_TOOLS` is still empty; the toolsets (#7–#19) fill it.

Spec: `docs/superpowers/specs/2026-09-19-tool-registry-design.md`
Plan: `docs/superpowers/plans/2026-09-19-tool-registry.md`

## Test plan

- [x] `npm run lint`, `npm run typecheck`, `npm test` (352 tests), `npm run build`
- [x] A gated tool is absent from `tools/list` without its flag and present with it, for both gates
- [x] A Printify 404 comes back as an `isError` result with the hint, end to end over MCP
- [x] Smoke run of the built server over stdio
- [ ] CI green on Node 22 and 24

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 4: Move the issue to In review and watch CI**

```bash
~/.claude/skills/updating-github-project-status/board.sh review
gh pr checks --watch
```

Expected: the board script prints a line moving #5 to In review; every check passes. If a check
fails, read its log with `gh run view --log-failed`, fix the cause, commit and push again.

- [ ] **Step 5: Hand-off comments on #6, #7 and #21**

```bash
gh issue comment 6 --body-file - <<'EOF'
Notes from the #5 implementation (tool registry):
- Build the server under test the way `cli.ts` does: `const { enabled, skipped } = selectTools(tools, config)`, then `createServer({ tools: enabled, services, instructions: serverInstructions(skipped) })` with `services = { client: createPrintifyClient({ token, baseUrl, fetch }), config, log }`. `selectTools` only reads `toolsets`, `enableOrders` and `enableDestructive`.
- `test/tools/fixtures.ts` has `FIXTURE_TOOLS`, `fixtureConfig`, `fixtureServices(fetch)` and `fixtureContext`. `test/support/json-rpc.ts` is a raw JSON-RPC stand-in for the MCP `Client` (`connect`, `listTools`, `callTool`); replace it when the harness lands.
- Tool errors come in two shapes. The registry's: `isError: true` and `structuredContent.error` with `kind` (`http`, `timeout`, `network`, `invalid_response`, `tool` or `internal`), `status`, `code`, `message`, `reason`, `request_id`, `retry_after_seconds` and `hint`, plus the same object as JSON text. The SDK's input validation errors: `isError: true` and only a text block starting `Input validation error: Invalid arguments for tool <name>:`. `expectToolError` should accept both.
- `test/cli.test.ts` replaces `ALL_TOOLS` with a hoisted array through `vi.mock('../src/tools/index.js', …)`; reuse that for CLI-level tests.
- For the "adding a tool" section of `CONTRIBUTING.md`, see the notes on #7.
EOF
gh issue comment 7 --body-file - <<'EOF'
Notes from the #5 implementation (tool registry). They apply to every toolset issue (#7–#19):
- Define each tool with `defineTool` from `src/tools/define.ts`: a snake_case `name`, the `toolset`, an optional `gate` (`'orders'` or `'destructive'`), a `description` written for the model, all three `annotations` hints (`openWorldHint` is added for you), a `z.strictObject` input and `handler(input, ctx)`. Append the tools to `ALL_TOOLS` in `src/tools/index.ts`. The catalog test then checks the rules: for example, a read-only tool cannot have a gate, and `gate: 'destructive'` needs `destructiveHint: true`.
- `ctx` holds `client`, `config`, `log` and the request's `signal`. Pass `{ signal: ctx.signal }` to `client.request`. Per-process state such as the shop cache belongs in `ToolServices`, which `cli.ts` creates once, not in module scope.
- Return a plain object, never an array: `{ shops: [...] }`. The registry drops nulls and sends it as `structuredContent` and compact JSON text. Drop heavy fields yourself; `omitKeys` in `src/tools/shape.ts` helps.
- Let a `PrintifyApiError` propagate: the registry turns it into an `isError` result with its hint. Throw `new ToolError(message, hint)` for deliberate refusals, such as a missing default shop.
- Until #6's harness lands, test tools with `runTool` from `src/tools/run.ts` and the helpers in `test/tools/fixtures.ts`.
EOF
gh issue comment 21 --body-file - <<'EOF'
Notes from the #5 implementation (tool registry):
- `describeTools(ALL_TOOLS)` from `src/tools/reference.ts` returns `{ name, toolset, gate, annotations, description }` for every tool, in `TOOLSETS` order and then definition order. `annotations` includes `openWorldHint: true`. It needs no token or config, so a script can import it from `dist/tools/reference.js` after `npm run build`.
- `gate: 'orders'` tools are registered only with `PRINTIFY_ENABLE_ORDERS=true`, and `gate: 'destructive'` tools only with `PRINTIFY_ENABLE_DESTRUCTIVE=true`. When tools are skipped, the server sends MCP `instructions` that name them and the variable to set, and logs one stderr line per reason at startup.
EOF
```

---

## Summary

| Task | Commit                                                         | Tests after |
| ---- | -------------------------------------------------------------- | ----------- |
| 1    | Add tool definitions and the rules they must follow            | 307         |
| 2    | Select tools by toolset and gate, and list them for the README | 322         |
| 3    | Turn tool results and errors into MCP results                  | 340         |
| 4    | Register the selected tools on every server, once per process  | 352         |
| 5    | (no commit) verification, PR, board, hand-off comments         | 352         |

Tasks 2 and 3 are independent of each other; both need Task 1. Task 4 needs Tasks 1–3.
