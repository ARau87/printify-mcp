# Tool registry, safety gating and response shaping — design

- **Issue:** [#5 Tool registry with toolsets, safety gating and response shaping](https://github.com/ARau87/printify-mcp/issues/5)
- **Date:** 2026-09-19
- **Status:** approved

## Goal

The server will have about 50 tools, written across ten toolset issues (#7–#19). Strangers install
it from npm and use it with their real Printify account. Every tool therefore needs one way to be
defined, gated, registered and formatted. Tools that spend money or cannot be undone must not
exist unless the user turned them on. When they are off, the assistant must be able to tell the
user how to turn them on.

## SDK facts this design relies on

Checked on 2026-09-19 against `@modelcontextprotocol/server` 2.0.0 and zod 4, with a throwaway
probe over `InMemoryTransport`.

- **Input validation:** `tools/call` validates the arguments against the registered zod schema
  before the handler runs. A failure becomes an `isError` result with the text
  `Input validation error: Invalid arguments for tool <name>: <issues>`, and the handler is not
  called. Defaults are applied, so `.default('summary')` arrives as `'summary'`.
- **Thrown errors:** anything the handler throws becomes an `isError` result whose only text is
  `error.message`. A `PrintifyApiError` would lose its hint, because the hint is not part of the
  message.
- **Unknown keys:** `z.strictObject` rejects them (`Unrecognized key: "extra"`), and its JSON Schema
  has `additionalProperties: false` in `io: 'input'` mode. A plain `z.object` strips them silently,
  and its input JSON Schema has no `additionalProperties`. `.refine()` on a strict object still
  returns a `ZodObject`.
- **Structured content:** on 2025-era connections the SDK wraps a non-object `structuredContent`
  (an array, for instance) in `{ result: … }`. Object-shaped content is passed through on both eras.
- **Instructions:** `new McpServer(info, { instructions })` puts the text into the `initialize`
  result. Clients such as Claude Code and Claude Desktop add it to the model's context.
- **Cancellation:** the handler's context carries the request's `AbortSignal` as
  `ctx.mcpReq.signal`.
- **Annotations:** MCP assumes `destructiveHint: true` for a tool that is not read-only, unless it
  says otherwise.

## Decisions that differ from the issue and the earlier notes

1. **One Printify client per process, created in `cli.ts`.** The #3 note on #5 suggested building
   the client in `createServer(config)`. `serveStdio` can call `createServer` twice: a
   `server/discover` probe and the real instance. Each client has its own rate limiter, so a
   client per instance would split the limits (the #4 follow-up). `cli.ts` creates the client once
   and passes it into the factory.
2. **Tools are selected once per process.** `selectTools` runs in `cli.ts`, not during
   registration, so the skip log is written once, even when the factory runs twice.
3. **Only nulls are dropped globally.** The issue lists mockup arrays and views among the heavy
   fields that shared helpers drop. A key-based rule cannot tell them apart from the design: on a
   product, `images` holds the mockups, but inside `print_areas[].placeholders[].images` it holds
   the artwork. The registry drops `null` values from every result. Each toolset drops its own
   heavy fields (#11 already specifies the product summary).
4. **Server instructions name the tools that are off.** The issue's example prompt ("Delete this
   product" without `PRINTIFY_ENABLE_DESTRUCTIVE`) needs the assistant to know the tool exists.
   The instructions list the skipped tools and the variable that turns each group on.
5. **Inputs reject unknown keys.** A misspelled optional argument (e.g. `inlcude_address`) would
   otherwise be dropped silently, and an order or delete would run with defaults. The rejected
   call never reaches Printify, so it costs nothing against the 5% error budget.
6. **Input validation errors keep the SDK's format.** They happen before the handler, are clear to
   the model and never reach Printify. Replacing them would mean validating twice.
7. **No `outputSchema`.** The SDK validates `structuredContent` against it on every call. Printify
   marks its response examples "subject to change", so a new or retyped field would turn working
   calls into errors.

## Files

```
src/tools/
  define.ts       # new: defineTool, Tool, ToolServices, ToolContext, Gate, ToolError
  check.ts        # new: toolProblems
  select.ts       # new: selectTools, skipLogLines, serverInstructions
  shape.ts        # new: dropNulls, omitKeys
  run.ts          # new: runTool, registerTools
  reference.ts    # new: describeTools
  index.ts        # new: ALL_TOOLS (empty; toolsets append)
src/server.ts     # createServer({ tools, services, instructions })
src/cli.ts        # selection, client, skip log and instructions, once per process
test/support/
  json-rpc.ts     # new: connect, listTools, callTool over InMemoryTransport
test/tools/
  fixtures.ts     # new: fixture tools and a fixture config
  check.test.ts   # new
  catalog.test.ts # new: ALL_TOOLS has no problems
  select.test.ts  # new
  shape.test.ts   # new
  run.test.ts     # new
  reference.test.ts # new
test/server.test.ts # the new createServer, the acceptance criteria end to end
test/cli.test.ts    # skip lines, tool count, one client
```

No new dependencies. `src/toolsets.ts` does not change.

## Tool definition

```ts
type Gate = 'orders' | 'destructive';

/** Created once per process and shared by every tool call. */
interface ToolServices {
  client: PrintifyClient;
  config: Config;
  log: Logger;
}

/** What a handler gets: the shared services plus the request's cancellation signal. */
interface ToolContext extends ToolServices {
  signal: AbortSignal;
}

interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

/** What a handler returns: a JSON object, never an array. */
type ToolData = Record<string, unknown>;

interface ToolDefinition<Input extends z.ZodObject> {
  /** snake_case, unique across all tools. */
  name: string;
  toolset: Toolset;
  /** Registered only when the flag is on: `orders` → PRINTIFY_ENABLE_ORDERS, and so on. */
  gate?: Gate;
  /** Written for the model: what the tool does, when to use it, what it costs. */
  description: string;
  annotations: ToolAnnotations;
  /** A `z.strictObject`, so unknown keys are rejected. */
  input: Input;
  handler: (input: z.output<Input>, ctx: ToolContext) => Promise<ToolData>;
}

/** A tool with its input type erased, so `ALL_TOOLS` can be a plain `readonly Tool[]`. */
interface Tool {
  readonly name: string;
  readonly toolset: Toolset;
  readonly gate: Gate | undefined;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly input: z.ZodObject;
  readonly handler: (input: unknown, ctx: ToolContext) => Promise<ToolData>;
}

function defineTool<Input extends z.ZodObject>(definition: ToolDefinition<Input>): Tool;

/** A deliberate refusal, e.g. a locked product. Becomes an `isError` result of kind `tool`. */
class ToolError extends Error {
  override readonly name = 'ToolError';
  readonly hint: string | undefined;
  constructor(message: string, hint?: string);
}
```

- All three hints are required, because MCP assumes `destructiveHint: true` otherwise. The registry
  adds `openWorldHint: true` to every tool, so no definition sets it.
- The handler's `input` has its defaults applied and its unknown keys rejected. The SDK validates
  it before the handler runs.
- The erased `handler` casts `unknown` back to `z.output<Input>`. That is safe because only
  `registerTools` calls it, with arguments the SDK has already parsed with the same schema.
- A toolset exports its tools and appends them to `ALL_TOOLS` in `src/tools/index.ts`:

  ```ts
  export const ALL_TOOLS: readonly Tool[] = [];
  ```

  It stays empty in #5. Every test uses fixture tools.

### Rules

`toolProblems(tools: readonly Tool[]): string[]` returns one line per problem, each starting with
the tool's name. The catalog test asserts it is empty for `ALL_TOOLS`, so every toolset issue gets
these checks without writing them.

| Rule                                                                 | Problem text                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------ |
| Name matches `^[a-z][a-z0-9]*(_[a-z0-9]+)*$` and has ≤ 64 characters | `<name>: the name must be snake_case, at most 64 characters` |
| Name is unique                                                       | `<name>: the name is used by more than one tool`             |
| Description is not blank                                             | `<name>: the description is empty`                           |
| `readOnlyHint: true` → `destructiveHint: false`                      | `<name>: a read-only tool cannot be destructive`             |
| `readOnlyHint: true` → no gate                                       | `<name>: a read-only tool cannot have a gate`                |
| `gate: 'destructive'` → `destructiveHint: true`                      | `<name>: gate "destructive" needs destructiveHint: true`     |
| `gate: 'orders'` → `readOnlyHint: false`                             | `<name>: gate "orders" needs readOnlyHint: false`            |
| Input JSON Schema (`io: 'input'`) has `additionalProperties: false`  | `<name>: the input must be a z.strictObject`                 |

A duplicate name is reported once per name. The SDK would also throw on a duplicate at
registration, but only for tools that are enabled, so the test catches it earlier.

## Selection

```ts
type SkipReason = 'toolset' | Gate;

interface Selection {
  enabled: readonly Tool[];
  skipped: readonly { tool: Tool; reason: SkipReason }[];
}

function selectTools(tools: readonly Tool[], config: Config): Selection;
```

1. A tool whose toolset is not in `config.toolsets` is skipped as `'toolset'`.
2. Otherwise, a tool with `gate: 'orders'` is skipped as `'orders'` unless `config.enableOrders`,
   and a tool with `gate: 'destructive'` as `'destructive'` unless `config.enableDestructive`.
3. Every other tool is enabled.

The toolset check comes first: a gated tool in a disabled toolset is reported as `'toolset'`,
because turning on its gate alone would not bring it back. Both lists keep the order of `tools`.

### Skip log

`skipLogLines(skipped): string[]` gives one line per reason that skipped at least one tool, in the
order `orders`, `destructive`, `toolset`. `cli.ts` writes them with `log.info`, which adds the
`printify-mcp: ` prefix:

```text
PRINTIFY_ENABLE_ORDERS is off, skipped: create_order, create_express_order, send_order_to_production, cancel_order
PRINTIFY_ENABLE_DESTRUCTIVE is off, skipped: delete_product, disconnect_shop
not in PRINTIFY_TOOLSETS, skipped: webhooks (list_webhooks, create_webhook), support (create_refund_request)
```

Toolsets follow the order of `TOOLSETS`, and tools the order of `ALL_TOOLS`. The existing summary
line gains `tools: <enabled> of <all>` as its first part:

```text
0.0.0 on stdio (tools: 38 of 50; toolsets: all; orders: off; destructive: off; default shop: none; upload dirs: 0)
```

### Server instructions

`serverInstructions(skipped): string | undefined` returns `undefined` when nothing was skipped, so
the `initialize` result carries no instructions. Otherwise it returns the lead line, one line per
reason in the skip log's order (only for reasons that skipped something), and the closing line:

```text
Some Printify tools are turned off in this server's configuration. When the user asks for something they cover, tell them it is turned off and how to turn it on.
- Order tools that can spend money (create_order, create_express_order, send_order_to_production, cancel_order): set PRINTIFY_ENABLE_ORDERS=true.
- Irreversible tools (delete_product, disconnect_shop): set PRINTIFY_ENABLE_DESTRUCTIVE=true.
- Toolsets not enabled: webhooks (list_webhooks, create_webhook), support (create_refund_request). Add their names to PRINTIFY_TOOLSETS.
The user sets these in the "env" block of the printify-mcp entry in their MCP client config, then restarts the client.
```

- Tool names are listed, not just toolset names: the model maps "request a refund" to
  `create_refund_request` far more reliably than to "support". With every toolset but one off,
  that is about 45 names, much less than the tool definitions it saves.
- There is no rule against workarounds. Tools that remain enabled are allowed by design: offering
  to unpublish when delete is off is legitimate.

## Results

### Success

```ts
{ content: [{ type: 'text', text: JSON.stringify(shaped) }], structuredContent: shaped }
```

`shaped` is `dropNulls(data)`. The text is compact JSON without indentation, and it is what most
clients show the model. Both carry the same object. List tools wrap their items in an object, such
as `{ shops: [...] }` or `{ products, page, has_more }`, so the shape is the same on every
protocol era. Nothing is truncated: toolsets page and summarize, because a cut-off JSON document is
worse than a large one.

### Shaping

```ts
/** Removes null and undefined object properties at any depth. Array elements are kept. */
function dropNulls<T>(value: T): T;

/** A shallow copy of `object` without `keys`, for toolset summaries. */
function omitKeys<T extends object, K extends keyof T>(object: T, keys: readonly K[]): Omit<T, K>;
```

`dropNulls` recurses into arrays and plain objects only. A `null` element in an array is kept, so
indexes do not shift. `detail: "full"` and each resource's heavy fields belong to the toolsets.

### Errors

Every error result is `isError: true` and carries the same `{ error: { … } }` object in its text
(compact JSON) and in `structuredContent`. Fields that are `undefined` are left out.

```json
{
  "error": {
    "kind": "http",
    "request": "POST /v1/shops/12/products.json",
    "status": 400,
    "code": 8203,
    "message": "Validation failed.",
    "reason": "Image has low quality",
    "hint": "The image resolution is too low for the print area at this size. Use a larger image or a smaller `scale`."
  }
}
```

`runTool` checks what the handler threw in this order:

| Thrown                              | `error.kind`                                         | Logged to stderr                                   |
| ----------------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| Anything, once `ctx.signal` aborted | none: re-thrown unchanged, as nobody reads the reply | nothing                                            |
| `PrintifyApiError`                  | `http`, `timeout`, `network` or `invalid_response`   | `log.warn`: `<tool> failed: <error.message>`       |
| `ToolError`                         | `tool`                                               | nothing: it is a deliberate refusal                |
| Anything else                       | `internal`                                           | `log.error`: `<tool> failed unexpectedly: <stack>` |

- **`PrintifyApiError`:** `request` is `<method> <path>`. `status`, `code`, `reason`, `hint`,
  `request_id` (from `requestId`) and `retry_after_seconds` (from `retryAfterSeconds`) are copied.
  `message` is `printifyMessage`, or `error.message` when Printify sent none (timeouts, network
  errors, non-JSON bodies). `error.message` is read explicitly because it is not enumerable. The
  client has already redacted every text field. `retry_after_seconds` is set only on the rate
  limiter's fail-fast 429, which was never sent, and its hint already names the wait.
- **`ToolError`:** `message` and `hint`.
- **Anything else:** `message` is the error's message, or `String(value)` for a non-`Error`,
  passed through `redactJwts`. The hint is `This is a bug in printify-mcp. Please report it at
https://github.com/ARau87/printify-mcp/issues with the tool name and this message.` The logged
  stack, or the message when there is none, also goes through `redactJwts`.
- The warn line uses `error.message`, which is a single line. A network error's `cause` is never
  logged.
- Serialising the success result happens inside the same `try`, so data that cannot be
  JSON-encoded (e.g. a `BigInt`) becomes an `internal` error instead of a crash.

## Registration

```ts
/** Runs one tool call and maps its outcome to a result. Rejects only after an abort. */
function runTool(tool: Tool, input: unknown, ctx: ToolContext): Promise<CallToolResult>;

function registerTools(server: McpServer, tools: readonly Tool[], services: ToolServices): void;
```

`registerTools` calls, for each tool:

```ts
server.registerTool(
  tool.name,
  {
    description: tool.description,
    inputSchema: tool.input,
    annotations: { ...tool.annotations, openWorldHint: true },
  },
  (input, ctx) => runTool(tool, input, { ...services, signal: ctx.mcpReq.signal }),
);
```

## Wiring

`createServer` stays free of side effects: it builds the server and registers the tools, nothing
else.

```ts
interface ServerOptions {
  tools: readonly Tool[];
  services: ToolServices;
  instructions: string | undefined;
}

function createServer(options: ServerOptions): McpServer;
```

The serve path of `main` in `cli.ts`, once the config is valid:

```ts
const selection = selectTools(ALL_TOOLS, config);
const client = createPrintifyClient({ token: config.token, baseUrl: config.apiBaseUrl });
const services: ToolServices = { client, config, log };
const instructions = serverInstructions(selection.skipped);
io.serve(() => createServer({ tools: selection.enabled, services, instructions }), { onerror });
log.info(summary(config, selection));
for (const line of skipLogLines(selection.skipped)) log.info(line);
```

- The probe instance and the real instance share one client and so one rate limiter.
- `createPrintifyClient` throws only for a token that cannot go in an HTTP header, which
  `loadConfig` already rejects. `src/index.ts` still catches it as a fatal error.
- `CliIo` does not change.
- #6's `createTestServer` calls `selectTools` and `createServer` directly, with a client that uses
  a fake `fetch`.

## Tool reference

```ts
interface ToolReference {
  name: string;
  toolset: Toolset;
  gate: Gate | undefined;
  annotations: ToolAnnotations & { openWorldHint: true };
  description: string;
}

function describeTools(tools: readonly Tool[]): ToolReference[];
```

It needs no config and no token. The order is that of `TOOLSETS`, then the order of `tools` within a
toolset. #21 decides how to render it into the README.

## Tests

All tests run under `npm test`. None needs the network or a Printify account. Fixture tools live in
`test/tools/fixtures.ts`: one read-only tool per toolset where a test needs it, an `orders`-gated
tool, a `destructive`-gated tool and a gated tool in a toolset that tests turn off. The fixture
config comes from `loadConfig` with a test token.

### `check.test.ts` and `catalog.test.ts`

- One fixture per rule that breaks exactly that rule, with the expected problem line; a valid tool
  gives no problems; a duplicate name is reported once.
- `toolProblems(ALL_TOOLS)` is empty.

### `select.test.ts`

- Both flags off, only orders on, only destructive on, both on.
- A disabled toolset that holds a gated tool: skipped as `'toolset'` whatever the flag says.
- Order is kept in both lists.
- `skipLogLines`: the three line formats, their order, no line for a reason with nothing skipped,
  no lines when nothing is skipped.
- `serverInstructions`: `undefined` when nothing is skipped; each reason line appears only when it
  applies; the lead and closing lines.

### `shape.test.ts`

`dropNulls` removes null and undefined properties at depth, inside objects in arrays, and keeps
`null` array elements, `false`, `0` and `''`. `omitKeys` leaves the input unchanged.

### `run.test.ts`

`runTool` called directly with fixture tools and a `ToolContext`:

- **Success:** text and `structuredContent` are the same object, with nulls dropped.
- **`PrintifyApiError`:** kind `http` with every field; `retry_after_seconds` from a fail-fast 429;
  `message` falls back to `error.message` for a timeout (the non-enumerable property is read);
  undefined fields are absent; one warn line with the tool name.
- **`ToolError`:** kind `tool` with message and hint; nothing logged.
- **Abort:** with `ctx.signal` aborted, the handler's rejection is re-thrown unchanged.
- **Internal:** a thrown `TypeError` and a thrown string give kind `internal`; a JWT in the message
  is redacted in the result and in the logged stack; a `BigInt` in the data gives kind `internal`.

### `reference.test.ts`

`describeTools` orders by `TOOLSETS`, keeps definition order within a toolset, adds
`openWorldHint: true` and includes the gate.

### `server.test.ts`

Over `InMemoryTransport`, with raw JSON-RPC helpers in `test/support/json-rpc.ts` (`connect`,
`listTools`, `callTool`) until #6 brings the MCP `Client`:

- **Acceptance 1:** a `destructive`-gated fixture tool is absent from `tools/list` when the tools
  come from `selectTools` with `enableDestructive: false`, and present with `true`. The same for
  `orders`.
- **Acceptance 2:** a fixture tool that calls `ctx.client.request` gets a 404 from a fake `fetch`.
  `tools/call` answers with `isError: true`. Its `structuredContent.error` has `kind: 'http'`,
  `status: 404` and the "Not found" hint, and its text is the same object as JSON.
- `initialize` carries the instructions when something is skipped, and no `instructions` key when
  nothing is.
- `tools/list` shows `openWorldHint: true` next to the three hints, and
  `additionalProperties: false` in `inputSchema`.
- An unknown key in the arguments gives the SDK's validation error; the handler and `fetch` are
  not called.
- An empty tool list still answers `tools/list` with `[]` (the existing test, on the new signature).

### `cli.test.ts`

`vi.mock` replaces `src/tools/index.js` with fixture tools and wraps `createPrintifyClient` in a
spy:

- The skip lines and `tools: <n> of <m>` appear on stderr in the default configuration.
- Calling the serve factory twice builds two servers, creates one client and logs nothing more.
- The existing tests keep passing.

## Acceptance criteria mapping

| Criterion (issue #5)                                                                             | Covered by                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Tests prove a gated tool is absent from `tools/list` without its flag and present with it        | `server.test.ts` (acceptance 1), `select.test.ts` |
| Tests prove API errors become `isError` results with hints                                       | `server.test.ts` (acceptance 2), `run.test.ts`    |
| Registry can export the tool list (name, toolset, gate, annotations, description) for the README | `describeTools`, `reference.test.ts`              |

The issue's other requirements:

| Requirement                                                                            | Covered by                                        |
| -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `defineTool` with name, description, zod input, toolset, annotations, gate and handler | `define.ts`, rules in `check.ts`                  |
| Registered only if the toolset is enabled and the gate flag is set                     | `selectTools`                                     |
| Startup logs which tools were skipped and why                                          | `skipLogLines`, `cli.ts`                          |
| `structuredContent` plus a compact JSON text block                                     | `runTool`                                         |
| `PrintifyApiError` → `isError` with status, code, reason and hint, never a throw       | `runTool`                                         |
| Shaping helpers drop heavy fields and nulls                                            | `dropNulls` (every result), `omitKeys` (toolsets) |
| Inputs validated locally before any request                                            | strict zod input, validated by the SDK            |
| Example prompt: no delete tool, the assistant says how to enable it                    | `serverInstructions`                              |

## Out of scope

| Topic                                                           | Where                                 |
| --------------------------------------------------------------- | ------------------------------------- |
| Shared id schemas (`shopId`, `productId`) and `resolveShopId`   | #7, the first toolset that needs them |
| Timeout hint when nothing was in flight                         | #27                                   |
| `Reason: []` for an empty `errors` value                        | #28                                   |
| The MCP `Client` and the fake Printify API for tests            | #6                                    |
| "Adding a tool" guide                                           | #6's `CONTRIBUTING.md`                |
| Rendering the tool reference                                    | #21                                   |
| `outputSchema`, tool `title`, a `--list-tools` flag, truncation | Not planned                           |

## Delivery

1. Branch `feat/5-tool-registry` from `origin/main`. This spec is its first commit.
2. Implementation plan via the writing-plans skill, then test-first implementation.
3. Local verification before any claim of success: `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test` and `npm run build`.
4. PR with `Closes #5`, moved to In review on the project board. Watch its CI run on Node 22 and 24.
5. Comment on the issues that build on this:
   - #6: `createTestServer` calls `selectTools` and `createServer({ tools, services, instructions })`
     with a fake-`fetch` client. `expectToolError` must accept both the registry's
     `structuredContent.error` and the SDK's plain-text input validation error.
   - #7–#19: define tools with `defineTool` and a `z.strictObject` input, append them to
     `ALL_TOOLS`, throw `ToolError` for deliberate refusals, and return objects, never arrays. The
     catalog test checks the rules.
   - #21: `describeTools(ALL_TOOLS)` gives the tool reference.
