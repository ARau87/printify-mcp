# Shops toolset and default shop resolution — design

- **Issue:** [#7 Shops toolset and default shop resolution](https://github.com/ARau87/printify-mcp/issues/7)
- **Date:** 2026-09-22
- **Status:** approved; tests moved onto #6's harness after #6 merged (same day)

## Goal

Nearly every Printify endpoint needs a `shop_id`, and most users have one shop. The assistant
should not have to look the shop up before each call. This issue adds the `shops` toolset
(`list_shops`, `disconnect_shop`) and the shared `resolveShopId` that every shop-scoped tool in
#8–#19 uses. It also settles two conventions those issues will copy: one file per toolset, and how
`ALL_TOOLS` is composed.

## Printify API facts this design relies on

Checked on 2026-09-22 against the HTML docs at https://developers.printify.com/#shops.

- **`GET /v1/shops.json`** returns a plain JSON array, not a pagination envelope:
  `[{ "id": 5432, "title": "My new store", "sales_channel": "My Sales Channel" }, …]`.
- **`sales_channel`** is "the name of the associated sales channel. If none are connected it
  defaults to 'disconnected'." So an API-only shop reads `disconnected`, and a disconnected shop
  can stay in the list.
- **`DELETE /v1/shops/{shop_id}/connection.json`** returns `{}`. The docs say only "Disconnect a
  shop"; they do not say what happens to the shop's products or sales channel. The Postman
  collection uses GET, which is wrong.

## Decisions that differ from the issue and the earlier notes

1. **`disconnect_shop` requires an explicit `shop_id`.** The issue says `resolveShopId` is used by
   every shop-scoped tool. An irreversible action must never target a shop the model did not name,
   so this one tool opts out. "Disconnect my shop" costs a `list_shops` call first, and the model
   states the id it is about to disconnect.
2. **`list_shops` always fetches, then refreshes the cache.** The issue caches the shop list for
   the process lifetime. That cache serves `resolveShopId`. `list_shops` answers "which shops do I
   have?" from Printify, and it is how a shop connected mid-session reaches the cache; otherwise a
   stale single-shop cache would keep resolving to the old shop.
3. **`list_shops` also returns `default_shop_id`.** The issue lists id, title and sales channel.
   Without the default, a model looking at three shops cannot know which one an omitted `shop_id`
   will hit.
4. **`ALL_TOOLS` is derived from a record keyed by toolset.** It was a flat array literal that
   every toolset issue appended to (the #5 follow-up). See [Composing `ALL_TOOLS`](#composing-all_tools).
5. **Resolution is tested through the harness with a fixture tool.** `resolveShopId` is not a tool,
   so `test/tools/fixtures.ts` gains `getShopId`: a shop-scoped tool named `get_shop_id` that
   returns the id `resolveShopId` gives it. The resolution tests call it through
   `createTestServer`, with `PRINTIFY_SHOP_ID` set through `env` and the real `loadConfig`, as the
   acceptance criteria ask.
6. **No shared id schemas besides `shop_id`.** #5's out-of-scope table put `shopId` and
   `productId` here. `productId` and the other ids move to the first toolset that uses them.
7. **#7 writes the "Adding a tool" section of `CONTRIBUTING.md`.** #6's spec left it to #7, the
   first toolset. It documents the conventions this issue sets.
8. **The tool exports are named `listShopsTool` and `disconnectShopTool`.** #6's worked example in
   `CONTRIBUTING.md` already imports `listShopsTool` from `src/tools/shops.ts`. The suffix also
   keeps them apart from `test/tools/fixtures.ts`'s fixture tool `listShops`.

## Files

```
src/printify/
  shops.ts          # new: Shop, ShopDirectory, createShopDirectory
  errors.ts         # invalidResponseError gains the problem 'an unexpected shop list'
src/tools/
  shop-id.ts        # new: shopIdInput, resolveShopId
  shops.ts          # new: listShopsTool, disconnectShopTool, shopsTools
  index.ts          # TOOLS_BY_TOOLSET; ALL_TOOLS derived from it
  define.ts         # ToolServices gains shops
src/cli.ts          # creates the shop directory once per process
test/support/
  harness.ts        # createTestServer's services gain shops
test/printify/
  shops.test.ts     # new: the directory and its cache
test/tools/
  shop-id.test.ts   # new: the resolution branches, through the harness
  shops.test.ts     # new: both tools, gating, through the harness
  catalog.test.ts   # every tool sits under its own toolset's key
  fixtures.ts       # services gain shops; the getShopId fixture tool
test/cli.test.ts    # one shop directory per process
CONTRIBUTING.md     # new section: Adding a tool
```

No new dependencies.

`src/printify/shops.ts` sits next to `pagination.ts` because it is API-level plumbing: fetch,
validate, cache. It knows nothing about tools. `src/tools/shop-id.ts` is tool-level: it reads
`ctx.config.shopId` and throws a `ToolError`.

## Shop directory

```ts
/** `{ id: number; title?: string | undefined; sales_channel?: string | undefined }` */
export type Shop = z.output<typeof shopSchema>;

export interface ShopDirectory {
  /** The account's shops: fetched on first use, then cached until `invalidate`. */
  list(signal: AbortSignal): Promise<readonly Shop[]>;
  /** Fetches the shops again and replaces the cache. */
  refresh(signal: AbortSignal): Promise<readonly Shop[]>;
  /** Drops the cache, e.g. after a shop is disconnected. */
  invalidate(): void;
}

export function createShopDirectory(client: PrintifyClient): ShopDirectory;
```

`ToolServices` gains `shops: ShopDirectory`. `cli.ts` creates it once, right after the client, so
every server instance of the process shares one cache, as they share one rate limiter:

```ts
const services: ToolServices = { client, config, log, shops: createShopDirectory(client) };
```

**Response schema.** A `z.object` per shop, so unknown keys are stripped:

```ts
const shopSchema = z.object({
  id: z.number().int(),
  title: z.string().optional().catch(undefined),
  sales_channel: z.string().optional().catch(undefined),
});
const shopListSchema = z.array(shopSchema);
```

`title` and `sales_channel` are lenient, so one odd shop cannot break resolution for all of them.
A body that is not an array, or a shop without an integer `id`, throws
`invalidResponseError({ method: 'GET', path }, 200, 'an unexpected shop list')`. The model sees it
as kind `invalid_response`.

**Caching rules.**

- Only a successful fetch is cached. A failure, an abort included, leaves the cache as it was.
- Two concurrent misses each send a request. One extra GET is harmless; sharing one in-flight
  promise would tie one caller's cancellation to another's.
- `invalidate()` clears the cache and bumps a generation counter. A fetch that started before the
  invalidation does not write its stale result into the cache, but still returns it to its own
  caller. This covers `list_shops` racing `disconnect_shop`.

```ts
async function fetchShops(signal: AbortSignal): Promise<readonly Shop[]> {
  const started = generation;
  const body = await client.request('GET', SHOPS_PATH, { signal });
  const parsed = shopListSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidResponseError({ method: 'GET', path: SHOPS_PATH }, 200, 'an unexpected shop list');
  }
  if (generation === started) cached = parsed.data;
  return parsed.data;
}
```

## Resolving the shop id

`src/tools/shop-id.ts` exports the input field that every shop-scoped tool spreads into its
`z.strictObject`, and the resolver its handler calls first:

```ts
export const shopIdInput = {
  shop_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The shop to use. Leave it out to use the default: PRINTIFY_SHOP_ID, or the only shop in ' +
        'the account.',
    ),
};

export async function resolveShopId(
  input: { shop_id?: number | undefined },
  ctx: ToolContext,
): Promise<number>;
```

A tool in #8–#19 uses them like this:

```ts
input: z.strictObject({ ...shopIdInput, product_id: productIdSchema }),
handler: async (input, ctx) => {
  const shopId = await resolveShopId(input, ctx);
  // apiPath`/v1/shops/${shopId}/products/${input.product_id}.json`
},
```

`resolveShopId` tries, in order:

1. **`input.shop_id`**, when set. No request.
2. **`ctx.config.shopId`** (`PRINTIFY_SHOP_ID`), when set. No request.
3. **`ctx.shops.list(ctx.signal)`**: one `GET /v1/shops.json` on the first call, then the cache
   until something invalidates it:
   - **Exactly one shop:** its id.
   - **No shops:** a `ToolError`:
     - Message: `This Printify account has no shops.`
     - Hint: `Add a shop in Printify first, then try again.`
   - **Several shops:** a `ToolError` that lists them:
     - Message:
       `This Printify account has 2 shops, so shop_id is needed: 5432 "My new store" (My Sales Channel), 9876 "My other new store" (disconnected).`
       Each shop is `id "title" (sales channel)`, and a missing title or sales channel is left
       out. Titles are quoted with `JSON.stringify`, so a quote or line break in a title cannot
       garble the message.
     - Hint:
       `Ask the user which shop to use and pass its id as shop_id. To make one the default, set PRINTIFY_SHOP_ID in the "env" block of the printify-mcp entry in the MCP client config.`

An explicit or configured id is not checked against the list. That would cost a request per call,
and a wrong id already comes back as Printify's 404 with the "check the id" hint.

## Tools

`src/tools/shops.ts` exports both tools and `shopsTools = [listShopsTool, disconnectShopTool]`.

### `list_shops`

| Field       | Value                                             |
| ----------- | ------------------------------------------------- |
| Toolset     | `shops`, no gate                                  |
| Annotations | read-only, not destructive, idempotent            |
| Input       | `z.strictObject({})`                              |
| Request     | `GET /v1/shops.json`, through `ctx.shops.refresh` |

The handler calls `ctx.shops.refresh(ctx.signal)` and returns `{ shops, default_shop_id }`.
`default_shop_id` is `config.shopId`, or else the only shop's id when there is exactly one, or
else left out (the registry drops `undefined`). Example, with `PRINTIFY_SHOP_ID=5432`:

```json
{
  "shops": [
    { "id": 5432, "title": "My new store", "sales_channel": "My Sales Channel" },
    { "id": 9876, "title": "My other new store", "sales_channel": "disconnected" }
  ],
  "default_shop_id": 5432
}
```

Description:

> Lists the shops in the Printify account with their id, title and sales channel ("disconnected"
> when no sales channel is connected, e.g. an API shop). `default_shop_id` is the shop that
> shop-scoped tools use when `shop_id` is left out; it is missing when there is no default. Call
> this when the user asks about their shops or when a tool needs a `shop_id`.

### `disconnect_shop`

| Field       | Value                                                                |
| ----------- | -------------------------------------------------------------------- |
| Toolset     | `shops`, gate `destructive`                                          |
| Annotations | not read-only, destructive, idempotent                               |
| Input       | `z.strictObject({ shop_id: z.number().int().positive() })`, required |
| Request     | `DELETE /v1/shops/{shop_id}/connection.json`                         |

The gate registers it only with `PRINTIFY_ENABLE_DESTRUCTIVE=true`. It is idempotent because
repeating it has no further effect, which is also what makes the client's retries of DELETE on
502, 503 and network errors safe.

The `shop_id` field is described as "The shop to disconnect. Required: this tool never uses the
default shop."

The handler sends the DELETE with `ctx.signal` and calls `ctx.shops.invalidate()` in a `finally`.
The cache is dropped after a failure or timeout too, because then nobody knows whether the shop
was disconnected. It returns `{ shop_id, disconnected: true }` and ignores the response body.

Description:

> Disconnects a shop from Printify. This cannot be undone with this server; reconnecting happens in
> the Printify app. Needs an explicit `shop_id` and never uses the default shop. Before calling it,
> confirm the shop's id and title with the user, e.g. from `list_shops`.

It claims no more than the docs say about what disconnecting does.

## Composing `ALL_TOOLS`

Each toolset lives in one file, `src/tools/<toolset>.ts`, that exports its tools as
`<toolset>Tools`. `src/tools/index.ts` keys them by toolset:

```ts
export const TOOLS_BY_TOOLSET: Readonly<Record<Toolset, readonly Tool[]>> = {
  shops: shopsTools,
  catalog: [],
  uploads: [],
  products: [],
  publishing: [],
  personalization: [],
  orders: [],
  support: [],
  webhooks: [],
  workflows: [],
};

/** Every tool the server can offer, in `TOOLSETS` order. */
export const ALL_TOOLS: readonly Tool[] = TOOLSETS.flatMap((toolset) => TOOLS_BY_TOOLSET[toolset]);
```

- Each toolset issue changes its own line (`catalog: []` → `catalog: catalogTools`), so parallel
  branches do not conflict, and TypeScript requires an entry for every toolset.
- `ALL_TOOLS` follows `TOOLSETS` order without anyone maintaining it.
- A catalog test checks that every tool under a key has that `toolset`.

Neither this nor a flat spread catches "defined the tool but never wired it in": an unused export
is not an error. The guard is a test convention. Each toolset's tests call `createTestServer`
with its default tools, which are `ALL_TOOLS`, so a tool that is not wired in fails its own tests.
A test that needs a fixture tool as well passes `tools: [...ALL_TOOLS, getShopId]`.

## Error handling

- A `PrintifyApiError` propagates unchanged. The registry turns it into an `isError` result with
  its hint.
- The deliberate refusals (no shops, several shops) are `ToolError`s.
- A malformed shop list is an `invalid_response` error.
- `ctx.signal` goes into `list`, `refresh` and the DELETE, so a cancelled call aborts its request.

## Tests

Test-first. The directory has plain unit tests against a fake `PrintifyClient`. Everything that
goes through a tool uses #6's harness: `createTestServer` with the fake Printify API, the shop
fixtures in `test/fixtures/shops.ts` (`SHOP`, `DISCONNECTED_SHOP`, `SHOPS`), and `expectToolData`
and `expectToolError`. "No request" is asserted as `expect(api.requests).toEqual([])`.

**`test/printify/shops.test.ts`: the directory.**

- `list` sends `GET /v1/shops.json` with the signal; a second `list` comes from the cache.
- `refresh` always fetches and replaces the cache.
- `invalidate` makes the next `list` fetch again.
- A failed fetch is not cached.
- A fetch that resolves after `invalidate` is returned but not cached (a deferred fake response).
- A body that is not an array, or a shop without an integer `id`, is an `invalid_response` error.
- An odd `title` or `sales_channel` becomes `undefined` without dropping the shop.

**`test/tools/shop-id.test.ts`: `resolveShopId`, through `get_shop_id`.**

- An explicit `shop_id` wins over `PRINTIFY_SHOP_ID`, with no request.
- `PRINTIFY_SHOP_ID` is used, with no request.
- The only shop costs one request; a second call uses the cache.
- No shops: the `ToolError` (kind `tool`) and its hint.
- Several shops: the `ToolError` listing them, with titles JSON-quoted and a missing title or
  sales channel left out.
- A cancelled call aborts the shop list request, and the next call fetches again.
- A `shop_id` that is zero, a string or a fraction is a validation error, with no request.

**`test/tools/shops.test.ts`: both tools, through `ALL_TOOLS`.**

- `list_shops`: the request, the output, the three `default_shop_id` cases (configured, only
  shop, none), and that it refreshes the cache that `get_shop_id` then uses.
- `disconnect_shop`:
  - Without `PRINTIFY_ENABLE_DESTRUCTIVE` it is not listed, `selection.skipped` gives the reason
    `destructive`, and the instructions tell the model how to turn it on.
  - With the flag it is listed after the read-only `list_shops`, destructive, with `shop_id`
    required.
  - It sends **DELETE** (not GET) to `/v1/shops/{shop_id}/connection.json`, and nothing else, and
    returns `{ shop_id, disconnected: true }`.
  - Without `shop_id` it is a validation error even when `PRINTIFY_SHOP_ID` is set, with no
    request.
  - It drops the shop cache after both success and a 404.

**Changed tests.**

- `test/tools/catalog.test.ts`: the rule check now runs over real tools. New: every tool in
  `TOOLS_BY_TOOLSET[key]` has `toolset === key`.
- `test/tools/fixtures.ts`: `fixtureServices` adds `createShopDirectory(client)`, and the file
  gains the `getShopId` fixture tool.
- `test/support/harness.ts`: `createTestServer`'s services add `createShopDirectory(client)`, as
  `cli.ts` does.
- `test/cli.test.ts`: one shop directory however many servers the factory builds, checked with a
  spy the way the one-client test does it. The comment that says `ALL_TOOLS` is empty goes.

## Acceptance criteria mapping

| Criterion or requirement                                                  | Where                                                                               |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Harness tests for all four resolution branches                            | `test/tools/shop-id.test.ts`, through `get_shop_id` (decision 5)                    |
| Harness tests for both tools                                              | `test/tools/shops.test.ts`                                                          |
| `disconnect_shop` only registered with `PRINTIFY_ENABLE_DESTRUCTIVE=true` | gate `destructive`; `tools/list`, `selection` and instructions, through `ALL_TOOLS` |
| Disconnect uses DELETE, not Postman's GET                                 | `disconnect_shop`; asserted on the request method                                   |
| Shop list cached for the process lifetime                                 | `ShopDirectory`, created once in `cli.ts`                                           |
| Cache invalidated after `disconnect_shop`                                 | `invalidate()` in a `finally`; tested after success and failure                     |
| Example: "Which Printify shops do I have?"                                | `list_shops` returns id, title, sales channel and `default_shop_id`                 |

## Out of scope

| Topic                                              | Where                                           |
| -------------------------------------------------- | ----------------------------------------------- |
| Checking `PRINTIFY_SHOP_ID` against the shop list  | Not planned: it would cost a request at startup |
| A TTL or other automatic refresh of the shop cache | Not planned: `list_shops` refreshes it          |
| Id schemas other than `shop_id` (`productId`, …)   | The first toolset that uses each                |
| Rendering the tool reference                       | #21                                             |

## Delivery

1. Branch `feat/7-shops` from `origin/main`, rebased onto it after #6 merged. This spec is its
   first commit.
2. Implementation plan via the writing-plans skill, then test-first implementation, in a worktree
   of its own.
3. Local verification before any claim of success: `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test` and `npm run build`.
4. PR starting with `Closes #7`, moved to In review on the project board. Watch its CI run on
   Node 22 and 24.
5. A hand-off comment on #8, noting that it applies to #8–#19: the conventions from "Adding a
   tool", briefly, with a pointer to that section.
