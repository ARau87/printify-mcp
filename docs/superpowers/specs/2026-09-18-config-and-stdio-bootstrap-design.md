# Configuration and stdio server bootstrap — design

- **Issue:** [#2 Configuration and stdio server bootstrap](https://github.com/ARau87/printify-mcp/issues/2)
- **Date:** 2026-09-18
- **Status:** approved in brainstorming, awaiting spec review

## Goal

Users configure the server only through environment variables in their MCP client config. Every
mistake there (missing token, typo in a toolset name, a flag set to `yes`) must stop startup with a
message that names the variable, instead of surfacing later as a confusing tool error. The server
then starts on stdio, declares its name and version from `package.json`, and answers `initialize`
and `tools/list`.

## Decisions that differ from the issue

1. **`serveStdio(createServer)` instead of `McpServer` + `StdioServerTransport`.** SDK v2's
   `serveStdio` from `@modelcontextprotocol/server/stdio` serves 2025-era clients exactly like the
   old wiring and also accepts the 2026-07-28 opening. It may call the factory for a probe instance
   it discards, so `createServer()` must stay free of side effects.
2. **The server declares `capabilities: { tools: { listChanged: false } }` up front.** A probe on
   2026-09-18 showed that an `McpServer` with no registered tools answers `tools/list` with
   `-32601 Method not found`. Declaring the capability at construction installs the tool handlers,
   so `tools/list` returns `{"tools":[]}`. `listChanged` is `false` because tools are registered once
   in the factory and never change at runtime. The SDK would otherwise default it to `true`.
3. **The token is a `Secret` object, not a string.** It prints as `[redacted]` everywhere, and only
   the HTTP client (#3) calls `reveal()`.

## Files

```
src/
  index.ts         # rewritten: shebang, calls main(), sets process.exitCode
  cli.ts           # main(argv, env, io): flags, config, error output, serve
  config.ts        # loadConfig(env): ConfigResult
  secret.ts        # Secret: redacting wrapper for the token
  toolsets.ts      # TOOLSETS constant and Toolset type
  package-info.ts  # PACKAGE_NAME, PACKAGE_VERSION from package.json
  log.ts           # createLogger(): stderr-only logger
  suggest.ts       # edit distance and closest-match for "did you mean"
  server.ts        # updated: name/version from package-info, tools capability
test/
  config.test.ts
  cli.test.ts
  secret.test.ts
  suggest.test.ts
  server.test.ts   # updated
eslint.config.js   # adds no-console for src/**
.github/workflows/ci.yml  # extended smoke steps
```

No new dependencies. `zod` is already a dependency from #1, and flags use Node's `util.parseArgs`.

## Configuration

### API

```ts
type ConfigResult =
  | { ok: true; config: Config; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

interface Config {
  token: Secret;
  shopId: number | undefined;
  toolsets: ReadonlySet<Toolset>;
  enableOrders: boolean;
  enableDestructive: boolean;
  uploadDirs: readonly string[];
  apiBaseUrl: string;
}

function loadConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult;
```

- `loadConfig` never reads `process.env` and never throws. The caller passes the environment.
- It returns a result instead of throwing, so warnings are printed even when startup fails.
- It collects every problem across all variables, not just the first.
- Validation is one zod object schema over the environment, parsed with `safeParse`. Each field
  reports its own issues with messages that already name the variable, and the result's issues map
  to `errors`. Zod 4 does not copy input values into issues unless asked, so the token never reaches
  an issue. Zod's default object parsing ignores the other environment variables.
- The only I/O is the synchronous file-system check of `PRINTIFY_UPLOAD_DIRS`.
- `config.ts` also exports `DEFAULT_API_BASE_URL` and the `Env` type, which `cli.ts` uses.

### General rules

- Values are trimmed.
- An optional variable that is empty after trimming counts as unset. MCP client config templates
  often leave `""` in place.
- Messages quote the offending value, except for `PRINTIFY_API_TOKEN` and `PRINTIFY_API_BASE_URL`.
  A URL can contain credentials, so its value is never echoed.
- If the token's value appears in another variable's error, because the user pasted it into the
  wrong variable, it is replaced with `[redacted]`. An empty token is not used for this replacement.

### Variables

| Variable                      | Default                    | Stored as                        |
| ----------------------------- | -------------------------- | -------------------------------- |
| `PRINTIFY_API_TOKEN`          | required                   | `token: Secret`                  |
| `PRINTIFY_SHOP_ID`            | unset                      | `shopId: number \| undefined`    |
| `PRINTIFY_TOOLSETS`           | all toolsets               | `toolsets: ReadonlySet<Toolset>` |
| `PRINTIFY_ENABLE_ORDERS`      | `false`                    | `enableOrders: boolean`          |
| `PRINTIFY_ENABLE_DESTRUCTIVE` | `false`                    | `enableDestructive: boolean`     |
| `PRINTIFY_UPLOAD_DIRS`        | none                       | `uploadDirs: readonly string[]`  |
| `PRINTIFY_API_BASE_URL`       | `https://api.printify.com` | `apiBaseUrl: string`             |

**`PRINTIFY_API_TOKEN`**

- Required and non-empty after trimming.
- Error: `PRINTIFY_API_TOKEN is required. Create a Personal Access Token in Printify and set it in
your MCP client config: https://developers.printify.com/#authentication`

**`PRINTIFY_SHOP_ID`**

- Digits only, stored as a number. Printify shop ids are integers.
- Error: `PRINTIFY_SHOP_ID must be a numeric shop id, got "abc"`

**`PRINTIFY_TOOLSETS`**

- A comma-separated list. Entries are trimmed and lowercased. Empty entries (a trailing comma) are
  skipped, and duplicates are allowed.
- Each unknown entry is its own error, with a suggestion when one is close. The error quotes the
  entry as written, before lower-casing, so token redaction still matches it:
  `PRINTIFY_TOOLSETS: unknown toolset "prodcts" (did you mean "products"?). Valid toolsets: shops,
catalog, uploads, products, publishing, personalization, orders, support, webhooks, workflows`
- A value that names no toolset at all (for example `,`) is an error:
  `PRINTIFY_TOOLSETS names no toolsets. Leave it unset to enable all of them.`

**`PRINTIFY_ENABLE_ORDERS` and `PRINTIFY_ENABLE_DESTRUCTIVE`**

- `true` or `false`, in any letter case. Unset means `false`.
- Anything else is an error, because a safety flag should never be guessed:
  `PRINTIFY_ENABLE_ORDERS must be "true" or "false", got "yes"`

**`PRINTIFY_UPLOAD_DIRS`**

- Split on `path.delimiter` (`:` on macOS and Linux, `;` on Windows). Empty entries are skipped.
- A leading `~` on its own, or followed by a path separator, expands to `os.homedir()`. `~user` is
  not expanded.
- After expansion, each entry must be absolute, must exist and must be a directory. Errors:
  - `PRINTIFY_UPLOAD_DIRS: "pics" is not an absolute path`
  - `PRINTIFY_UPLOAD_DIRS: "/Users/me/pics" does not exist`
  - `PRINTIFY_UPLOAD_DIRS: "/Users/me/pic.png" is not a directory`
  - Any other `stat` failure: `PRINTIFY_UPLOAD_DIRS: "/Users/me/pics" cannot be read (EACCES)`
- `ENOENT` and `ENOTDIR` both count as "does not exist".
- Entries are stored as `fs.realpathSync` results, in order, with duplicates removed. #10 checks that
  a file is inside one of them, and real paths keep symlinks from escaping that check.
- `[]` means local-file uploads are disabled. Uploads by URL or base64 still work.

**`PRINTIFY_API_BASE_URL`**

- Must parse as a URL. Error: `PRINTIFY_API_BASE_URL is not a valid URL`
- Must use `https:`. `http:` is allowed only when the host is `localhost`, `127.0.0.1` or `[::1]`,
  because the token is sent to this URL. Error:
  `PRINTIFY_API_BASE_URL must use https (http is allowed only for localhost)`
- Must not contain a username, password, query or fragment. Error:
  `PRINTIFY_API_BASE_URL must not contain credentials, a query or a fragment`
- A path prefix is allowed, for example a proxy at `https://proxy.example.com/printify`.
- Stored without a trailing slash. #3 appends `/v1/…` and `/v2/…`.

### Unknown variables

- Every environment variable whose name starts with `PRINTIFY_`, in any letter case, and is not one
  of the seven above produces a warning. Unknown variables are never an error, because a user's shell
  may export unrelated `PRINTIFY_*` variables.
- Names are compared case-insensitively. When the closest known name is at most 3 edits away, the
  warning suggests it: `unknown variable PRINTIFY_ENABLE_ORDER (did you mean
PRINTIFY_ENABLE_ORDERS?)`. Otherwise it lists the known variables:
  `unknown variable PRINTIFY_FOO. Known variables: PRINTIFY_API_TOKEN, …`
- A lowercase `printify_api_token` therefore warns and suggests `PRINTIFY_API_TOKEN`. The
  missing-token error appears next to the warning.
- A name that equals a known name case-insensitively produces no warning when looking up the known
  name in `env` finds a value. On Windows, `process.env` lookups ignore case, so `Printify_Api_Token`
  there is a working variable, not a typo.

### Supporting modules

- **`secret.ts`:** `class Secret` keeps the value in a private `#value` field. `reveal()` returns
  it. `toString()`, `toJSON()` and `[util.inspect.custom]()` return `[redacted]`. So
  `console.error(config)`, `JSON.stringify(config)` and template strings never contain the token.
- **`toolsets.ts`:** `TOOLSETS = ['shops', 'catalog', 'uploads', 'products', 'publishing',
'personalization', 'orders', 'support', 'webhooks', 'workflows'] as const` and
  `type Toolset = (typeof TOOLSETS)[number]`, plus the type guard
  `isToolset(name: string): name is Toolset`. #2 needs the list to validate names, and #5 imports it.
- **`suggest.ts`:** `editDistance(a, b)` (Levenshtein) and
  `closest(input, candidates, maxDistance = 3): string | undefined`. Used for toolset names and
  variable names.

## Command line

### Flags

`main` parses `argv` with `util.parseArgs` before it loads the configuration, so both flags work
without a token. It uses `parseArgs` in tokens mode and checks each token itself, so its messages
name the exact option as typed and not Node's generic wording.

| Input                           | Output                                                                             | Exit |
| ------------------------------- | ---------------------------------------------------------------------------------- | ---- |
| `--help`, `-h`                  | Usage on stdout (see below)                                                        | 0    |
| `--version`, `-v`               | The version and a newline on stdout, e.g. `0.1.0`                                  | 0    |
| both                            | Help wins                                                                          | 0    |
| unknown option, or a positional | stderr: `printify-mcp: unknown option '--foo'. Run printify-mcp --help for usage.` | 2    |
| none                            | Load config and serve (see below)                                                  | —    |

For a positional argument the message reads `unexpected argument 'foo'` instead, and for a flag with
a value (`--help=yes`) it reads `option '--help' does not take a value`.

The help text has a one-line description, `Usage: printify-mcp [--help] [--version]`, a table of
the seven variables (name, required or default, meaning), the valid toolset names and a link to
`https://github.com/ARau87/printify-mcp#readme`.

### Configuration errors

Output goes to stderr, stdout stays empty, and there is no stack trace. Warnings come first:

```
printify-mcp: warning: unknown variable PRINTIFY_ENABLE_ORDER (did you mean PRINTIFY_ENABLE_ORDERS?)
printify-mcp: invalid configuration
  - PRINTIFY_API_TOKEN is required. Create a Personal Access Token in Printify and set it in your MCP client config: https://developers.printify.com/#authentication
  - PRINTIFY_TOOLSETS: unknown toolset "prodcts" (did you mean "products"?). Valid toolsets: shops, catalog, …
Set these in the "env" block of the printify-mcp entry in your MCP client config.
```

Warnings go through the logger's `warn`. The error block is written to `io.stderr` as one piece,
exactly as shown, and so is the usage-error line above. Exit code 1, so configuration errors (1)
and usage errors (2) can be told apart.

### Successful start

1. Print the warnings to stderr.
2. Call `serve(createServer, { onerror })`. `onerror` logs `printify-mcp: error: <message>` to stderr.
3. Print one summary line to stderr with the logger's `info`. MCP clients such as Claude Desktop
   save stderr in their log files, so this is what a user sees when debugging:

```
printify-mcp: 0.1.0 on stdio (toolsets: all; orders: off; destructive: off; default shop: none; upload dirs: 0)
```

- `toolsets` is `all` or the enabled names, comma-separated, in `TOOLSETS` order.
- `default shop` is the id or `none`. `upload dirs` is the count.
- `; api: <url>` is appended only when `PRINTIFY_API_BASE_URL` overrides the default.
- The token never appears.

`main` then returns 0. The process keeps running because stdin is open, and it exits with code 0 on
stdin EOF.

### `main` and `io`

```ts
interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  serve: (factory: () => McpServer, options: { onerror: (error: Error) => void }) => unknown;
}

function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io?: CliIo,
): number;
```

- `main` is synchronous. The upload-dir checks use synchronous `fs`, and `serveStdio` returns
  immediately.
- The default `io` is `process.stdout`, `process.stderr` and `serveStdio`. Tests pass string
  collectors and a fake `serve`, so they never take over the process's stdin.
- Importing `cli.ts` runs nothing.

### `index.ts`

```ts
#!/usr/bin/env node
import { main } from './cli.js';

process.exitCode = main(process.argv.slice(2), process.env);
```

wrapped in a `try`/`catch`. An unexpected exception prints `printify-mcp: fatal: <stack>` to stderr
and sets the exit code to 1. Setting `process.exitCode` instead of calling `process.exit()` lets
stderr flush.

### `log.ts`

`createLogger(write = (text) => process.stderr.write(text))` returns `{ info, warn, error }`. Each
writes one line with the prefix `printify-mcp: `, `printify-mcp: warning: ` or
`printify-mcp: error: `. `main` builds its logger from `io.stderr`. #5 uses the same logger to
report skipped tools.

### Keeping stdout clean

- ESLint gets `no-console: 'error'` for `src/**/*.ts`. A stray `console.log` in a later change fails
  lint instead of corrupting the protocol stream. Tests may still use `console`.
- `log.ts` writes through `process.stderr.write`. Help and version use `io.stdout.write`, the only
  intended stdout writes outside the MCP transport.

## Server

### `package-info.ts`

- Reads `package.json` with `readFileSync(new URL('../package.json', import.meta.url), 'utf8')`.
  The path resolves from both `src/` (under vitest) and `dist/` (the built package), which both sit
  one level below the package root. npm always includes `package.json` in the published tarball.
- Parses it with a zod schema `{ name: string, version: string }` and exports `PACKAGE_NAME` and
  `PACKAGE_VERSION`.
- The file is read once, on import.
- A JSON import (`with { type: 'json' }`) is rejected: `rootDir: "src"` makes `tsc` refuse
  `../package.json`, and working around that would change the build layout.

### `server.ts`

```ts
export function createServer(): McpServer {
  return new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { capabilities: { tools: { listChanged: false } } },
  );
}
```

- It still takes no arguments. #5 adds the `config` parameter when it registers tools, and an unused
  parameter now would fail typescript-eslint's `no-unused-vars`.
- A comment above the function records the constraint for #3 and #5: `serveStdio` may call the
  factory for a probe instance and discard it, so the factory must not start timers, open clients or
  have other side effects per instance.
- Server-level `instructions` for the model are out of scope. They depend on the tools that exist.

## Tests

All tests run under `npm test`. None needs the network or a Printify account.

### `test/config.test.ts`

- A token-only environment gives the defaults: all toolsets, both flags `false`, `shopId` undefined,
  `uploadDirs` empty and the default base URL.
- Every rule above has passing and failing cases, including trimming, empty values counting as
  unset, letter case and multiple errors collected in one result.
- Upload dirs use `fs.mkdtempSync` directories: a valid directory, a relative path, a missing path, a
  file, a symlink (stored as its real path), duplicates, and two entries joined by `path.delimiter`.
  `~` on its own expands to the real path of the home directory, and `~/<random name>` reports a
  missing directory.
- Unknown-variable warnings with a suggestion, without one, and for a lowercase name. Variables
  without the `PRINTIFY_` prefix are ignored. An `env` `Proxy` with case-insensitive lookups, which
  behaves like Windows, produces no warning for `Printify_Api_Token`.
- **Token leak:** a distinctive mixed-case token, also pasted into every other variable. It must not
  appear in any error or warning, in its original case or lower-cased. On a valid configuration it must not appear in
  `String(config.token)`, `JSON.stringify(config)` or `util.inspect(config)`.

### `test/secret.test.ts`

`reveal()` returns the value. `String()`, template strings, `JSON.stringify` and `util.inspect`
give `[redacted]`.

### `test/suggest.test.ts`

Edit distance on known pairs. `closest` returns the nearest candidate within the limit, and
`undefined` when none is close enough.

### `test/cli.test.ts`

`main` with string-collecting writers and a fake `serve`:

- `--help` and `-h` with an empty environment: stdout names every variable and every toolset, exit 0,
  `serve` not called.
- `--version` and `-v`: stdout is `PACKAGE_VERSION` and a newline, exit 0.
- An unknown option and a positional argument: the stderr message, exit 2.
- A missing token: exit 1, stderr names `PRINTIFY_API_TOKEN`, stdout empty, `serve` not called.
- An unknown toolset: exit 1, stderr names `PRINTIFY_TOOLSETS`, stdout empty.
- A valid environment: `serve` is called once, its factory returns an `McpServer`, stderr has the
  summary line, the token appears in no output, exit 0.

### `test/server.test.ts` (updated)

Two tests:

- `initialize` returns `serverInfo` with the name and version from `package.json`, which the test
  reads itself, and `capabilities.tools.listChanged: false`.
- After `notifications/initialized`, `tools/list` returns `{ tools: [] }`.

## CI

The smoke steps in `.github/workflows/ci.yml` run against the built `dist/index.js`:

1. **Smoke-run the built server** (updated). The step sets `PRINTIFY_API_TOKEN: smoke-test-token`.
   It pipes `initialize`, `notifications/initialized` and `tools/list` into
   `timeout 10 node dist/index.js` and checks the output for `"name":"printify-mcp"` and
   `"tools":[]`.
2. **Check --version.** The output of `node dist/index.js --version` equals the `version` in
   `package.json`.
3. **Check that a missing token stops startup.** With no token and stdin from `/dev/null`, the
   process exits non-zero and its stderr, captured in `$RUNNER_TEMP/stderr.txt`, contains
   `PRINTIFY_API_TOKEN`.

### MCP Inspector

The acceptance criterion names the MCP Inspector. Its CLI takes the server command first, then the
options. It does not pass its own environment to the server, so the token goes in with `-e`:

```sh
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  -e PRINTIFY_API_TOKEN=inspector-dummy --protocol-era legacy --method tools/list
```

A prototype run on 2026-09-18 with Inspector 2.7.0 printed `{ "tools": [] }` for both
`--protocol-era legacy` and `--protocol-era modern`. That confirms `serveStdio` serves both eras.

## Acceptance criteria mapping

| Criterion (issue #2)                                                                           | Covered by                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Missing token or an unknown toolset name exits non-zero with a message that names the variable | `test/cli.test.ts`, CI step 3                                                                                                        |
| Unit tests cover parsing, defaults and invalid values                                          | `test/config.test.ts`                                                                                                                |
| Server connects over stdio and answers `initialize` / `tools/list` (MCP Inspector)             | `test/server.test.ts`, CI step 1, and a manual MCP Inspector CLI run against `dist/index.js` whose output goes in the PR description |

The issue's other requirements:

| Requirement                                           | Covered by                                                       |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| Logging goes to stderr only                           | `log.ts`, `no-console` lint rule, stdout checks in `cli.test.ts` |
| The token is never logged or echoed in errors         | `Secret`, token-leak tests in `config.test.ts` and `cli.test.ts` |
| `--version` and `--help` print and exit               | `test/cli.test.ts`, CI step 2                                    |
| Name and version from `package.json` in the handshake | `package-info.ts`, `test/server.test.ts`                         |

## Out of scope

| Topic                                                                 | Where                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| Checking the token against the API at startup                         | Not planned: it would make startup depend on the network |
| HTTP client, `User-Agent`, use of `apiBaseUrl` and the token          | #3                                                       |
| Tool registration, toolset and gate filtering, `createServer(config)` | #5                                                       |
| Default shop resolution                                               | #7                                                       |
| Upload path containment checks                                        | #10                                                      |
| Log levels                                                            | Not planned                                              |
| README documentation of the variables                                 | #21                                                      |

## Delivery

1. Branch `feat/2-config-bootstrap` from `origin/main`. This spec is its first commit.
2. Implementation plan via the writing-plans skill, then test-first implementation.
3. Local verification before any claim of success: `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test`, `npm run build`, the three CI smoke steps run by hand, and an MCP Inspector CLI
   `tools/list` call against `node dist/index.js` with a dummy token.
4. PR with `Closes #2`. Watch its CI run on Node 22 and 24.
5. Comment on the issues that consume these interfaces:
   - #3: the token is a `Secret`, so call `reveal()` only when building the `Authorization` header;
     `apiBaseUrl` has no trailing slash; take the `User-Agent` version from `package-info.ts`.
   - #5: import `TOOLSETS` and `Toolset` from `src/toolsets.ts`; `createServer(config)` gets its
     parameter there; the factory must stay free of side effects; use `createLogger` for the
     skipped-tools report.
   - #10: `uploadDirs` holds real paths, and `[]` means local-file uploads are disabled.
