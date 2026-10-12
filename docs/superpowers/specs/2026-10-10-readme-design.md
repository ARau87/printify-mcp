# README — installation, configuration, safety model and tool reference — design

- **Issue:** [#21 README](https://github.com/ARau87/printify-mcp/issues/21)
- **Date:** 2026-10-10
- **Status:** approved
- **Depends on:** #5 (tool registry, merged). The branch is cut from `origin/main` at 885c8f6,
  which has six toolsets with tools: shops, catalog, uploads, products, publishing, workflows.
- **Depended on by:** #22 (npm release), which ships this README in the package.

## Goal

Someone who finds `printify-mcp` on npm can, without reading the source: get a Personal Access
Token with the right scopes, wire the server into Claude Desktop, Claude Code, Cursor or VS Code,
understand what the three safety flags protect against and why orders cost money even without
`send_to_production`, and look up any tool the server offers.

Two things make this more than prose. The tool reference is **generated** from the registry by
`npm run docs:tools`, and CI fails when it is out of date, so it cannot drift as #13–#16 add
toolsets. And the README is the public face the release in #22 ships, so every fact in it is
sourced, and the ones the server also states (hints, `--help`) use the same wording.

## Decisions made in brainstorming

1. **Document only what exists.** The README covers the six toolsets that have tools. The
   `orders` gate and the 24 h warning are explained because `PRINTIFY_ENABLE_ORDERS` exists and a
   user will see it in `--help`, but there are no order prompts, no order scopes beyond a mention,
   and no webhook signature snippet. The HMAC snippet the issue asks for (item 9) moves to #16,
   which owns webhooks. `personalization`, `orders`, `support` and `webhooks` appear in the README
   only in the `PRINTIFY_TOOLSETS` description as "reserved for later releases; no tools yet".
2. **The tool table lives inline in README.md** between `<!-- tools:start -->` and
   `<!-- tools:end -->`, so npm's package page shows it. `npm run docs:tools` rewrites the block;
   `npm run docs:tools -- --check` exits non-zero when it differs; CI runs the check after
   `npm run build`.
3. **Written as published.** The quick start and client configs use `npx -y printify-mcp`. #22
   depends on this issue, so the README is true by the time anyone installs. Running from a
   checkout stays in CONTRIBUTING.md.
4. **Render in `src`, splice in a script.** `renderToolReference` is a pure, unit-tested function
   in `src/tools/reference.ts`. `scripts/docs-tools.js` is a thin shell: read, splice, format
   with Prettier, write or compare.
5. **Hand-written tables stay hand-written.** The environment-variable table and the scope table
   are not generated. The variables exist only as zod transforms, and seven rows do not justify
   exporting metadata for them. A comment in the README names `src/config.ts` and the `--help`
   text in `src/cli.ts` as the places to keep in step.

## Facts the README states, and their sources

Every statement below was checked on 2026-10-08/09. The README cites the Printify page where
one exists.

| Fact                                                                                                                                                                                                                                       | Source                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tokens are created under My Profile → Connections, where the scopes are set                                                                                                                                                                | [API docs, Authentication](https://developers.printify.com/#authentication)                                                                                                                                                                                                                                  |
| Tokens are valid for one year and shown only once, right after generation                                                                                                                                                                  | same                                                                                                                                                                                                                                                                                                         |
| The eleven scopes: `shops.read`, `catalog.read`, `products.read`, `products.write`, `orders.read`, `orders.write`, `webhooks.read`, `webhooks.write`, `uploads.read`, `uploads.write`, `print_providers.read`                              | same                                                                                                                                                                                                                                                                                                         |
| Printify does not say which scope each endpoint needs                                                                                                                                                                                      | same; `src/printify/hints.ts` already says "probably" for this reason                                                                                                                                                                                                                                        |
| Rate limits: 600 requests/min overall, 100/min on catalog endpoints, 200 per 30 min on publish                                                                                                                                             | [API usage guidelines](https://developers.printify.com/#api-usage-guidelines); `src/printify/rate-limit.ts`                                                                                                                                                                                                  |
| Orders are approved and sent to production automatically 24 hours after they are placed, by default; you are charged when they go to production; the setting is under Store settings → Order settings (Manual, 1 h, 24 h, or a fixed time) | [Help centre: store details and order approval settings](https://help.printify.com/hc/en-us/articles/4483625253265-How-do-I-set-up-store-details-and-order-approval-settings), [When does Printify charge](https://help.printify.com/hc/en-us/articles/4483630446865-When-does-Printify-charge-for-an-order) |
| Error 8203 means the artwork is too small for the print area at that scale                                                                                                                                                                 | `src/printify/hints.ts` (`CODE_HINTS`), from the product docs; the README uses the hint's wording                                                                                                                                                                                                            |
| Printify recommends uploading files over 5 MB by URL rather than base64; this server refuses anything over 25 MB                                                                                                                           | `src/tools/upload-source.ts` (`WARN_BYTES`, `MAX_BYTES`), from the uploads docs; same wording as the warning                                                                                                                                                                                                 |
| A product is locked while publishing; on an API shop it stays locked until `publishing_succeeded` or `publishing_failed`                                                                                                                   | [API docs, Publish a product](https://developers.printify.com/#publish-a-product); `docs/superpowers/specs/2026-10-05-publishing-toolset-design.md`                                                                                                                                                          |
| Client config file locations and shapes                                                                                                                                                                                                    | Each client's own documentation, linked from the README                                                                                                                                                                                                                                                      |

## README structure

The order follows the reader's path: install, understand the risks, look things up.

### 1. Title and introduction

One paragraph: an MCP server for the Printify print-on-demand API, over stdio, configured with
environment variables. Then a short "Why this one" list:

- One tool per Printify endpoint, grouped into toolsets you can switch on and off.
- Workflow tools for the hard parts: `search_blueprints` (full-text search over the whole
  catalog), `get_print_areas` (where artwork goes and how big it must be),
  `create_product_from_image` (upload, place, price and create in one call).
- Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`), so
  a client can show what a call will do.
- Tools that spend money or cannot be undone are not registered unless you opt in.
- Compact responses, a catalog cache, and rate limiting that waits or refuses before Printify
  answers 429.

### 2. Quick start

Numbered:

1. Create a Personal Access Token in Printify: My Profile → Connections. Pick the scopes (link to
   the scopes section; the one-line answer is "the four `.read` scopes plus `uploads.write` and
   `products.write` for everything this release offers"). Copy it now; it is shown once and lasts
   one year.
2. Add the server to your client. The Claude Code one-liner, verbatim from the issue:

   ```bash
   claude mcp add printify -e PRINTIFY_API_TOKEN=your-token -- npx -y printify-mcp
   ```

   Other clients: link to section 3.

3. Ask: "List my Printify shops." If the account has one shop, every shop-scoped tool uses it;
   otherwise set `PRINTIFY_SHOP_ID` or name the shop in the prompt.

### 3. Configure your client

One fenced block per client, all running `npx -y printify-mcp` with `PRINTIFY_API_TOKEN` in
`env`:

- **Claude Desktop**: `claude_desktop_config.json`, `mcpServers.printify` with `command: "npx"`,
  `args: ["-y", "printify-mcp"]`, `env`.
- **Claude Code**: the `claude mcp add` line, plus the `-s user` variant to make it available in
  every project.
- **Cursor**: `.cursor/mcp.json`, same `mcpServers` shape.
- **VS Code**: `.vscode/mcp.json` with `servers.printify` and an `inputs` entry of type
  `promptString` with `password: true`, referenced as `${input:printify-token}`, so the token is
  not written into a file that may be committed.

A closing note: the server reads nothing but its environment; it never writes config files.

### 4. Safety model

Prose first, then one subsection per control.

- **Toolsets** (`PRINTIFY_TOOLSETS`): comma-separated, default all. A setup that cannot upload
  would set it to `shops,catalog,products`. The four reserved names are listed as having no tools
  yet.
- **Orders** (`PRINTIFY_ENABLE_ORDERS=true`): registers tools that place orders. Today no tool is
  behind this gate (the orders toolset is #14), but the flag exists and the warning belongs
  here. A blockquote warning, the one prominent box in the README:

  > **Orders cost money.** By default Printify approves an order and sends it to production
  > 24 hours after it is placed, and charges your payment method then. You do not have to call
  > "send to production" for that to happen. Before enabling order tools, set order approval to
  > Manual in Printify under Store settings → Order settings, or make sure you want automatic
  > approval.

- **Destructive** (`PRINTIFY_ENABLE_DESTRUCTIVE=true`): registers `disconnect_shop`,
  `archive_upload` and `delete_product`, none of which can be undone. The three names are
  hand-written here; the generated table is the authoritative list and the Needs column shows
  the same gate, so a reader can cross-check.
- **Local files** (`PRINTIFY_UPLOAD_DIRS`): `upload_image` and `create_product_from_image` accept
  a `file_path` only inside these directories; unset, local reads are off and uploads use a URL
  or base64. Entries are absolute paths separated by the platform's path separator (`:` on
  macOS and Linux, `;` on Windows); `~` is expanded.
- **What the assistant sees when something is off**: the server's MCP `instructions` name the
  tools that were not registered and the variable that enables them, and one stderr line per
  reason is logged at startup. So "the assistant says it has no delete tool" is by design, and
  the fix is in the client config.

### 5. Environment variables

One table, every variable `loadConfig` reads, in the order `--help` lists them:

| Variable                      | Required | Default                    | Notes                                                                                        |
| ----------------------------- | -------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `PRINTIFY_API_TOKEN`          | yes      |                            | Personal Access Token. Visible ASCII only; a token with a line break or space is rejected.   |
| `PRINTIFY_SHOP_ID`            | no       | the account's only shop    | Numeric id. Shop-scoped tools use it when a call gives no `shop_id`.                         |
| `PRINTIFY_TOOLSETS`           | no       | all                        | Comma-separated. Unknown names are rejected with a suggestion.                               |
| `PRINTIFY_ENABLE_ORDERS`      | no       | `false`                    | `true` or `false` only.                                                                      |
| `PRINTIFY_ENABLE_DESTRUCTIVE` | no       | `false`                    | `true` or `false` only.                                                                      |
| `PRINTIFY_UPLOAD_DIRS`        | no       | none (local files off)     | Absolute, existing directories; `~` allowed; separated by `:` (`;` on Windows).              |
| `PRINTIFY_API_BASE_URL`       | no       | `https://api.printify.com` | For proxies. Must be `https` (`http` only for localhost), no credentials, no `/v1` or `/v2`. |

Followed by: an empty value counts as unset; an unknown `PRINTIFY_*` variable produces a startup
warning with a suggestion; invalid configuration stops startup with every problem listed.

### 6. Token scopes by toolset

Lead with the simple answer, then the table. The table is derived from the endpoints each
toolset calls (listed from `apiPath` uses in `src/tools/`), and says so: "Printify does not
publish which scope each endpoint needs. This is the mapping this project has worked out; a 403
from the server names the scope it believes is missing."

| Toolset      | Scopes                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------ |
| `shops`      | `shops.read`                                                                               |
| `catalog`    | `catalog.read`, `print_providers.read`                                                     |
| `uploads`    | `uploads.read`; `uploads.write` for `upload_image` and `archive_upload`                    |
| `products`   | `products.read`; `products.write` for `create_product`, `update_product`, `delete_product` |
| `publishing` | `products.write`                                                                           |
| `workflows`  | `catalog.read`, `uploads.write`, `products.write`                                          |

Two notes under the table. `shops.read` is needed by every setup: shop-scoped tools resolve the
default shop from the shop list, and the publishing tools read it to tell connected shops from API
shops. `orders.*` and `webhooks.*` are not used by any tool in this release.

### 7. Tools

A sentence introducing the table, then the generated block. Nothing hand-written goes between the
markers.

### 8. Example prompts

Six, one per workflow, each one or two lines:

1. "Find t-shirt blueprints with a Bella+Canvas model and show me who prints them in Europe."
2. "Where can artwork go on blueprint 6 from provider 99, and how large must it be?"
3. "Create a product on my shop from ~/designs/sunset.png: a Gildan 5000, all sizes in black and
   white, front print, 35 % margin." (noting this needs `PRINTIFY_UPLOAD_DIRS=~/designs`, or a URL
   instead of the path)
4. "Raise the price of every variant of product 65b… by 2 dollars."
5. "Publish product 65b… to my Shopify store."
6. "Archive the upload named old-logo.png." (noting this needs `PRINTIFY_ENABLE_DESTRUCTIVE=true`)

### 9. Troubleshooting

A definition list, one entry per symptom, each ending in the action:

- **401 Unauthorized**: the token is invalid, expired (one year) or revoked. Create a new one and
  update the client config.
- **403 Forbidden**: usually a missing scope. The error names the scope the server thinks is
  needed, with a "probably", because Printify does not publish the mapping. Create a new token
  with that scope; tokens cannot be edited.
- **429 / "rate limit is used up"**: the three limits, and that the server waits for short gaps
  and refuses without sending when the wait would be long, so a refusal is not a Printify error.
  Catalog-heavy prompts hit the 100/min catalog limit first; `search_blueprints` and the catalog
  cache exist to avoid that.
- **"The product is locked" after publishing**: on a shop with no connected channel, publishing
  only locks the product and fires an event for your own integration. Call
  `set_publishing_succeeded` or `set_publishing_failed` to unlock it. On a connected shop, wait
  for the channel; `get_product` shows `is_locked`.
- **Error 8203, low resolution**: the artwork is too small for the print area at that scale. Ask
  for `get_print_areas`, then use a larger image or a smaller `scale`.
- **Large uploads**: files over 5 MB should be uploaded by `url`; base64 and local files over
  25 MB are refused by this server.
- **A tool is missing**: it is behind a flag or its toolset is off. The assistant was told which
  one at startup; set the variable in the client config and restart the client.
- **Startup fails**: the server prints every configuration problem to stderr and exits. Client
  logs show it (Claude Desktop: the MCP log files; Claude Code: `claude mcp list`).

### 10. Contributing and license

One paragraph linking CONTRIBUTING.md (dev setup, harness, how to add a tool, live tests) and the
issue templates (bug, feature, documentation). No license line: #22 chooses the license and adds
the `LICENSE` file and the line here.

## The generator

### `renderToolReference(rows)` in `src/tools/reference.ts`

Pure. Takes `ToolReference[]` (what `describeTools` returns) and returns Markdown:

1. A lead line: `_N tools in M toolsets._`, where N is `rows.length` and M the number of distinct
   toolsets in the rows. Both come from the rows, so no count in the README can drift.
2. One table with the columns **Tool**, **Toolset**, **Access**, **Needs**, **Description**.
   - Tool: the name in backticks.
   - Toolset: the name.
   - Access: from the annotations. `readOnlyHint` → `read-only`; else `destructiveHint` →
     `destructive`; else `writes`.
   - Needs: `PRINTIFY_ENABLE_ORDERS=true` for gate `orders`, `PRINTIFY_ENABLE_DESTRUCTIVE=true`
     for gate `destructive`, in backticks; empty otherwise.
   - Description: the first sentence of the tool description, with `|` escaped as `\|`.

**First sentence**: the text up to and including the first `.`, `!` or `?` (optionally followed by
a closing quote or parenthesis) that is followed by whitespace and then a capital letter or a
backtick. Abbreviations such as "e.g." are followed by lowercase and so do not end the sentence;
`list_shops`'s description, which contains "e.g. an API shop)." mid-sentence, is the case this
rule exists for. When nothing matches, the whole description is the summary. Internal newlines
become spaces.

The rows are rendered in the order given; `describeTools` already orders them by `TOOLSETS` and
then definition order, so the table groups by toolset without a second sort. The output is **not**
padded to column widths; Prettier does that in the script.

### `scripts/docs-tools.js`

Plain ESM JavaScript, so ESLint's existing untyped `**/*.js` override lints it and Prettier formats
it. Not in any tsconfig and not in `dist/`.

1. Imports `ALL_TOOLS` from `../dist/tools/index.js`, `describeTools` and `renderToolReference`
   from `../dist/tools/reference.js`, and `prettier`.
2. Reads `README.md` (path resolved from the script's own location, so the cwd does not matter).
3. Finds `<!-- tools:start -->` and `<!-- tools:end -->`. Exactly one of each, start before end;
   otherwise exit 1 with a message naming the problem.
4. Replaces what lies between them with a blank line, the rendered Markdown, and a blank line.
5. Formats the whole file with Prettier's API: `resolveConfig` for the repo's options, then
   `format` with `filepath` set to the README's path. This keeps the generated block identical to
   what `prettier --check .` expects, without `prettier-ignore` markers in the README.
6. Without `--check`: when the result equals the file, print `README.md tool reference is up to
date`; otherwise write it and print `README.md tool reference updated`. Exit 0 either way.
7. With `--check`: write nothing. When the result differs, print
   `README.md tool reference is out of date; run npm run docs:tools` to stderr and exit 1.
   Otherwise print the up-to-date line and exit 0.
8. Any other argument is a usage error, exit 2.

`package.json`: `"docs:tools": "npm run build && node scripts/docs-tools.js"`. npm appends
`-- --check` after the whole script string, so the flag reaches node.

### CI

One new step after `npm run build`:

```yaml
- run: npm run docs:tools -- --check
```

It rebuilds (a few seconds), which is simpler than teaching the script to skip the build. From
then on a PR that adds a tool without regenerating the README fails here, with the message that
names the command.

## Changes to existing files

| File                           | Change                                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                    | New, as structured above                                                                                                                                  |
| `src/tools/reference.ts`       | Adds `renderToolReference` and the exported helper `firstSentence` (exported for its own tests)                                                           |
| `test/tools/reference.test.ts` | New cases, see Tests                                                                                                                                      |
| `scripts/docs-tools.js`        | New                                                                                                                                                       |
| `package.json`                 | `docs:tools` script                                                                                                                                       |
| `.github/workflows/ci.yml`     | The `--check` step after build                                                                                                                            |
| `CONTRIBUTING.md`              | A "Docs" paragraph under "Adding a tool": run `npm run docs:tools` after adding or renaming a tool; the variable and scope tables are hand-kept and where |

`src/cli.ts` does not change: `--help` already links `https://github.com/ARau87/printify-mcp#readme`.

## Error handling

The script is the only runtime code. Its failures are: markers missing or duplicated (exit 1,
message names which), `dist/` missing (Node's own import error, which the `npm run build` prefix
prevents), unknown argument (exit 2). `--check` never writes. The renderer has no failure modes:
an empty row list renders `_0 tools in 0 toolsets._` and a header-only table, and a description
with no sentence boundary is used whole.

## Tests

### `test/tools/reference.test.ts`

`firstSentence`:

- Ends at the first period followed by a space and a capital: `'Lists shops. Use it when…'` →
  `'Lists shops.'`.
- Does not end at an abbreviation: `'Lists shops (e.g. an API shop). Call this…'` →
  `'Lists shops (e.g. an API shop).'`.
- Ends before a backtick-opened sentence: `'Gets a product. \`summary\` is the default.'` → the
  first sentence.
- A description with no boundary is returned whole; internal newlines become spaces.

`renderToolReference`:

- A read-only ungated tool, a writing ungated tool and a destructive gated tool render the Access
  and Needs columns as `read-only`/blank, `writes`/blank, `destructive`/`PRINTIFY_ENABLE_DESTRUCTIVE=true`;
  an `orders`-gated row renders `PRINTIFY_ENABLE_ORDERS=true`.
- The lead line counts rows and distinct toolsets.
- A `|` in a description is escaped.
- The empty list renders the zero lead line and a header-only table.
- Rows render in the order given (two toolsets, interleaved input, output order preserved), so
  the test pins that ordering is `describeTools`'s job.

Guard over the real registry, `describeTools(ALL_TOOLS)`:

- Every summary is non-empty, ends in `.`, `!`, `?` or a closing quote or parenthesis after one,
  and is at most 220 characters, so a new tool whose description opens with a fragment or a very
  long sentence fails the suite rather than producing a bad row.
- The rendered output contains each tool name in backticks exactly once.

### The script

Exercised by CI itself: a fresh checkout must pass `--check`, and the smoke of writing is the
first generation of the README during implementation. No unit test for the script; it is marker
splicing plus Prettier.

### Manual review in the plan

After the first generation, the plan has a step to read the generated table and check each
summary reads as a sentence. The guard catches shape, not sense.

## Acceptance criteria mapping

| Issue item                                | Where                                                            |
| ----------------------------------------- | ---------------------------------------------------------------- |
| 1 What it is, how it differs              | README §1                                                        |
| 2 Quick start, token, scopes              | README §2, §6                                                    |
| 3 Client configuration, four clients      | README §3                                                        |
| 4 Every variable from `src/config.ts`     | README §5, seven rows                                            |
| 5 Safety model, 24 h warning              | README §4, the blockquote                                        |
| 6 Generated tool table, CI check          | `renderToolReference`, `scripts/docs-tools.js`, the CI step      |
| 7 Example prompts                         | README §8                                                        |
| 8 Troubleshooting                         | README §9                                                        |
| 9 Webhook signature snippet               | Moved to #16 (decision 1); a comment on #16 records the hand-off |
| 10 Link to CONTRIBUTING and the templates | README §10                                                       |

## Out of scope

- Order prompts, order scopes beyond a mention, the webhook HMAC snippet (#14, #16).
- Generating the variable or scope tables.
- A license line and the `LICENSE` file (#22).
- Changing any tool description to improve its summary. If the guard or the manual review finds a
  poor first sentence, the fix is a one-line follow-up in that toolset, noted in the PR, not part
  of this issue.
- Per-toolset tables or anchors; one table with a Toolset column.
- Screenshots or a logo.

## Delivery

1. Branch `docs/21-readme` from `origin/main` at 885c8f6, in the worktree
   `../printify-mcp-worktrees/21-readme`, outside the repository so the main checkout's `eslint .`
   does not lint it. This spec is its first commit. The board shows #21 In progress.
2. Implementation plan via the writing-plans skill, with the renderer, the script and the CI step
   prototyped and lint/typecheck/test-verified before the plan is written.
3. Test-first for the renderer. The README prose is written against this spec's structure; the
   generated block is produced by the script, never by hand.
4. Local verification before any claim of success: `npm run lint`, `npm run typecheck`,
   `npm test`, `npm run build`, `npm run docs:tools -- --check`, plus the CI smoke step's commands
   against `dist/`.
5. PR starting with `Closes #21`, moved to In review on the project board. Watch its CI run on
   Node 22 and 24.
6. Hand-offs: a comment on #16 for the webhook snippet; a comment on #14 (in progress in another
   worktree) that the README table is generated and its PR must run `npm run docs:tools` after
   this merges, and that the orders section of README §4 then gets its prompts and scopes; a
   note on #22 that the README exists and the license line is its job.
