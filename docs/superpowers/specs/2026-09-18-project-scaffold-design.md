# Project scaffold — design

- **Issue:** [#1 Project scaffold — TypeScript, build, lint, tests and CI](https://github.com/ARau87/printify-mcp/issues/1)
- **Date:** 2026-09-18
- **Status:** approved in brainstorming, awaiting spec review

## Goal

Turn the empty repository into a TypeScript project that builds an executable npm package, with
lint, type checking, tests and CI that run on every pull request. Every other backlog issue builds
on this.

## Decisions that differ from the issue

1. **MCP SDK v2 instead of v1.** The issue names `@modelcontextprotocol/sdk`. SDK v2.0.0 became the
   stable line on 2026-07-27 and splits the SDK into `@modelcontextprotocol/server`,
   `@modelcontextprotocol/client` and `@modelcontextprotocol/core`. The v1 package is now in
   maintenance. We use `@modelcontextprotocol/server@^2.0.0`. It still negotiates older protocol
   versions (back to `2024-11-05`), so existing MCP clients keep working. `McpServer`,
   `StdioServerTransport` (from `@modelcontextprotocol/server/stdio`), `InMemoryTransport` and
   `registerTool` all exist in v2, so issues #2, #5 and #6 still hold as written.
2. **TypeScript `~6.0.3`, not 7.** npm's `latest` tag is TypeScript 7.0.2 (the native compiler),
   but typescript-eslint supports only `>=4.8.4 <6.1.0`. We pin to `~6.0.3` so type-aware linting
   keeps working. We move to 7 when typescript-eslint supports it.

## Dependencies

| Package                        | Kind | Version  | Why                                                                                |
| ------------------------------ | ---- | -------- | ---------------------------------------------------------------------------------- |
| `@modelcontextprotocol/server` | dep  | `^2.0.0` | MCP server and stdio transport                                                     |
| `zod`                          | dep  | `^4.2.0` | Schemas; same range the SDK depends on. First used in #2                           |
| `typescript`                   | dev  | `~6.0.3` | Compiler; see decision 2                                                           |
| `@types/node`                  | dev  | `^22`    | Typed against the **minimum** supported Node, so Node 24-only APIs fail to compile |
| `eslint`, `@eslint/js`         | dev  | `^10`    | Linting (flat config)                                                              |
| `typescript-eslint`            | dev  | `^8.70`  | Type-aware lint rules                                                              |
| `eslint-config-prettier`       | dev  | `^10.1`  | Turns off lint rules that conflict with Prettier                                   |
| `prettier`                     | dev  | `^3`     | Formatting                                                                         |
| `vitest`                       | dev  | `^5`     | Tests                                                                              |

No Printify SDK: we own the HTTP layer (#3). No bundler: plain `tsc` output keeps stack traces
readable and the server has only two runtime dependencies.

## Files

```
package.json
package-lock.json
tsconfig.json
tsconfig.build.json
eslint.config.js
.prettierrc.json
.prettierignore
vitest.config.ts
src/
  index.ts        # shebang; connects createServer() to stdio
  server.ts       # createServer(): McpServer
test/
  server.test.ts  # smoke test over InMemoryTransport
.github/workflows/ci.yml
```

Only files with content are created. `src/printify/`, `src/tools/` and `src/workflows/` are created
by the issues that fill them, because git cannot track empty directories.

### `package.json`

- `name: "printify-mcp"`, `version: "0.0.0"` (#22 owns real versions), `private` is **not** set.
- `"type": "module"`, `bin: { "printify-mcp": "dist/index.js" }`, `files: ["dist"]`.
- `engines.node: ">=22"`. Vitest and ESLint need `^22.12` / `^22.13` at dev time, which CI satisfies
  by installing the latest Node 22. That does not constrain users of the package.
- `license`, `description`, `keywords`, `repository` and the `LICENSE` file belong to #22.

Scripts:

| Script      | Command                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `build`     | `tsc -p tsconfig.build.json`                                                 |
| `dev`       | `tsc -p tsconfig.build.json --watch`                                         |
| `typecheck` | `tsc --noEmit`                                                               |
| `lint`      | `eslint . && prettier --check .`                                             |
| `format`    | `prettier --write .`                                                         |
| `test`      | `vitest run`                                                                 |
| `test:live` | prints `Live test suite not implemented yet — see #20` to stderr and exits 1 |

`test:live` exits non-zero so nobody mistakes the placeholder for a passing suite.

### TypeScript

`tsconfig.json` type-checks everything and emits nothing:

- `target` and `lib`: `ES2023`
- `module` and `moduleResolution`: `NodeNext`
- `types: ["node"]`. TypeScript 6 no longer includes `@types/*` automatically, and the SDK's `.d.mts`
  files reference `Buffer`.
- `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`,
  `isolatedModules`, `skipLibCheck`
- `noEmit: true`
- `include`: `src`, `test`, `vitest.config.ts`

`tsconfig.build.json` extends it with `noEmit: false`, `rootDir: "src"`, `outDir: "dist"`,
`include: ["src"]`. It emits no source maps and no declarations, because this is a CLI, not a
library.

### Lint and format

- `eslint.config.js` (plain ESM): `@eslint/js` recommended, typescript-eslint `strictTypeChecked`
  with `parserOptions.projectService: true`, then `eslint-config-prettier` last. JavaScript files
  such as the config itself get `tseslint.configs.disableTypeChecked`. `dist/` and `coverage/` are
  ignored.
- `.prettierrc.json`: `{ "singleQuote": true, "printWidth": 100 }`.
- `.prettierignore`: `package-lock.json`. Prettier 3 already skips everything in `.gitignore`.
- `prettier --check .` covers all tracked text files, including the existing
  `.github/ISSUE_TEMPLATE/*.yml`. Those files are reformatted once in this change if needed.

### Vitest

`vitest.config.ts` sets `test.include: ['test/**/*.test.ts']`. The live suite (#20) will get its own
config and stay out of `npm test`.

## Runtime code

`src/server.ts`:

```ts
import { McpServer } from '@modelcontextprotocol/server';

export function createServer(): McpServer {
  return new McpServer({ name: 'printify-mcp', version: '0.0.0' });
}
```

`src/index.ts`:

```ts
#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

await createServer().connect(new StdioServerTransport());
```

- There are two files so tests can build the server without taking over the process's stdin.
- Nothing writes to stdout, which belongs to the MCP protocol.
- If `connect` rejects, the process crashes with a stack trace on stderr and a non-zero exit.
  Friendly startup errors, `--version`/`--help` and reading the version from `package.json` all
  belong to #2.
- A probe on 2026-09-18 confirmed the behaviour. This exact server answers an `initialize` for
  protocol `2025-06-18` with `serverInfo.name: "printify-mcp"` and exits 0 on stdin EOF in about
  70 ms.

## Smoke test

`test/server.test.ts`:

1. It creates the linked pair `[clientSide, serverSide]` with `InMemoryTransport.createLinkedPair()`.
2. It calls `await createServer().connect(serverSide)`.
3. It starts `clientSide`, collects messages in `onmessage`, and sends a raw JSON-RPC `initialize`
   (`protocolVersion: "2025-06-18"`, empty capabilities, `clientInfo: { name: "smoke", version: "0" }`).
4. It asserts that the response for id 1 has `result.serverInfo.name === 'printify-mcp'`.

Sending raw JSON-RPC means no `@modelcontextprotocol/client` dependency. #6's harness adds that
package.

## CI

`.github/workflows/ci.yml`:

- Triggers: `pull_request`, and `push` to `main`.
- `permissions: contents: read`.
- `concurrency`: group by workflow and ref, `cancel-in-progress: true`.
- One job, `ubuntu-latest`, matrix `node: [22, 24]`, `fail-fast: false`.
- Steps:
  1. `actions/checkout@v7`
  2. `actions/setup-node@v7` with `node-version: ${{ matrix.node }}`, `cache: npm`
  3. `npm ci`
  4. `npm run lint`
  5. `npm run typecheck`
  6. `npm test`
  7. `npm run build`
  8. **Smoke-run the built server:** pipe one `initialize` line (protocol `2025-06-18`) into
     `timeout 10 node dist/index.js` and `grep -q '"name":"printify-mcp"'` on the output.

Branch protection (making these checks required) is a repository setting and is out of scope. The
maintainer decides whether to enable it.

## Acceptance criteria mapping

| Criterion (issue #1)                                                                  | Covered by                                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `npm ci && npm run build` produces `dist/index.js` that runs via `node dist/index.js` | Local verification, and CI steps 3, 7 and 8             |
| `npm run lint`, `npm run typecheck` and `npm test` pass on a trivial smoke test       | `test/server.test.ts`, CI steps 4 to 6                  |
| CI runs on pull requests against Node 22 and 24                                       | `ci.yml` matrix. The PR for this issue is the first run |

## Out of scope

| Topic                                                                                 | Issue |
| ------------------------------------------------------------------------------------- | ----- |
| Environment config, `--version`/`--help`, version from `package.json`, startup errors | #2    |
| HTTP client                                                                           | #3    |
| Tool registry and safety gating                                                       | #5    |
| Test harness, `@modelcontextprotocol/client`, fixtures                                | #6    |
| Live test suite                                                                       | #20   |
| README                                                                                | #21   |
| License, package metadata, changelog, release and publish                             | #22   |

## Delivery

1. Branch `feat/1-project-scaffold`. This spec is its first commit.
2. Implementation plan via the writing-plans skill, then test-first implementation.
3. Local verification before any claim of success: `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test`, `npm run build`, and the smoke run against `node dist/index.js`.
4. PR with `Closes #1`. Watch its CI run on Node 22 and 24.
5. Update issue #1's body to name `@modelcontextprotocol/server` and TypeScript `~6.0`.
6. Comment on #6 that the v2 `Client` comes from the separate `@modelcontextprotocol/client` package.
