# Catalog toolset — blueprints, print providers, variants, shipping (v1) — design

- **Issue:** [#8 Catalog toolset — blueprints, print providers, variants, shipping (v1) with caching](https://github.com/ARau87/printify-mcp/issues/8)
- **Date:** 2026-09-22
- **Status:** approved

## Goal

Choosing what to make means drilling down: blueprint → print provider → variants → shipping. This
issue adds the six read-only `catalog` tools for that path and the per-process catalog cache under
them. Catalog requests have their own limit of 100 per minute, the data rarely changes, and variant
lists are large, so the cache and compact outputs matter as much as the tools. #9 (v2 shipping),
#17 (`search_blueprints`) and #18 (`get_print_areas`) build on the same cache.

## Printify API facts this design relies on

Checked on 2026-09-22 against the HTML docs at https://developers.printify.com/#catalog, which win
over `openapi.json` and Postman where they disagree. No catalog endpoint documents a query
parameter other than `show-out-of-stock`, and none is paginated: each returns a bare JSON array or
object.

- **`GET /v1/catalog/blueprints.json`** returns every blueprint as
  `{ id, title, description, brand, model, images }`. `images` is an array of URLs.
- **`GET /v1/catalog/blueprints/{blueprint_id}.json`** returns the same fields plus `tags`, which
  the list leaves out.
- **`GET /v1/catalog/blueprints/{blueprint_id}/print_providers.json`** returns
  `[{ id, title, decoration_methods }]`, e.g. `["dtg", "embroidery"]`. There is no location.
- **`GET /v1/catalog/blueprints/{blueprint_id}/print_providers/{print_provider_id}/variants.json`**
  returns `{ id, title, variants }`, where `id` and `title` are the print provider's. Each variant
  has:
  - `id` and `title`;
  - `options`, an object keyed by option name, e.g. `{ "color": "Solid Black", "size": "XS" }`. The
    docs allow up to three options per blueprint, so the keys are not fixed;
  - `placeholders`, each `{ position, decoration_method, height, width }` with the size in pixels;
  - `decoration_methods`, which the placeholders already carry.
- **`show-out-of-stock`:** left out or `0` lists only the variants in stock; `1` lists all of them.
  Catalog variants have no stock field, so the full list does not say which ones are out of stock.
- **`GET /v1/catalog/blueprints/{blueprint_id}/print_providers/{print_provider_id}/shipping.json`**
  includes `{print_provider_id}`; `openapi.json` and Postman drop it. It returns
  `{ handling_time: { value, unit }, profiles }`, and each profile is
  `{ variant_ids, first_item: { cost, currency }, additional_items: { cost, currency }, countries }`.
  `countries` holds ISO codes or `REST_OF_THE_WORLD`. The v1 section does not name the unit; the v2
  section says costs are in cents, and the v1 examples (450, 650, 1100 USD) fit that.
- **`GET /v1/catalog/print_providers.json`** returns `[{ id, title, location }]`, where `location`
  is `{ address1, address2, city, country, region, zip }` and `address2` is `null` or `""`. The docs
  call it the provider's return address.
- **`GET /v1/catalog/print_providers/{print_provider_id}.json`** returns
  `{ id, title, location, blueprints }`. Each blueprint is `{ id, title, brand, model, images }`;
  the example has 44 of them. There are no `decoration_methods` here.
- **Rate limit:** all catalog endpoints share 100 requests per minute per account, on top of the
  global 600. `bucketsFor` in `src/printify/rate-limit.ts` already puts `/v1/catalog/` and
  `/v2/catalog/` paths in the `catalog` bucket.
- **Freshness:** the docs say nothing about how often the catalog changes or how to cache it. The
  TTLs come from the issue.

## Decisions that differ from the issue and the earlier notes

1. **`list_blueprint_providers` adds each provider's location.** The endpoint has none, but the
   issue's example prompt asks where the providers of a blueprint are located. The tool joins the
   cached `print_providers.json` list, which costs one extra request per 24 hours instead of one
   `get_print_provider` call per provider.
2. **`show_out_of_stock` marks every variant's `in_stock`.** The issue maps the flag to
   `show-out-of-stock=1`, but the full list alone does not say which variants are out of stock. With
   the flag set, the tool fetches the in-stock list too and marks each variant `in_stock: true` or
   `false`. That is one extra catalog request, and only when the flag is set.
3. **`list_variants` returns `option_values`.** The filters match exact option names, ignoring case,
   so `"black"` does not match `"Solid Black"`. Substring matching would make the size `"L"` match
   `"XL"` and `"2XL"`. Instead, every result lists the option names that exist, so a filter that
   matched nothing can be corrected without fetching the whole list.
4. **No in-flight request sharing.** Two concurrent misses on the same key each send a request. One
   extra catalog request is harmless, and sharing one in-flight promise would tie one caller's
   cancellation to another's. #7's shop directory makes the same choice.
5. **Tests run through `runTool`, not the harness.** The acceptance criteria ask for harness tests,
   but #6 has not landed. The toolset tests use `runTool` with a stand-in for #6's fake API that has
   the same route keys and the same answer to an unmatched request, so moving onto
   `createFakeApi` is an import swap. If #6 has merged when implementation starts, the tests use it
   and the stand-in is not written.
6. **#7's conventions, whichever branch lands first.** #7's spec settles that each toolset lives in
   `src/tools/<toolset>.ts`, exports `<toolset>Tools`, and is wired in through `TOOLS_BY_TOOLSET`
   in `src/tools/index.ts`; toolset tests take their tools from `ALL_TOOLS`. If #7 has merged when
   implementation starts, #8 changes one line (`catalog: []` → `catalog: catalogTools`). If not, #8
   introduces `TOOLS_BY_TOOLSET`, `ALL_TOOLS` and the per-key toolset check exactly as #7's spec
   defines them, with `shops: []`, so the two branches conflict only on neighbouring lines.
7. **The toolset tests go in `test/tools/catalog-toolset.test.ts`.** `test/tools/catalog.test.ts`
   already holds the rule check over `ALL_TOOLS`, and #7 edits it. Renaming it here would turn #7's
   edit into a modify/delete conflict on a nine-line file.
8. **`get_blueprint` calls its own endpoint.** Only the single-blueprint response has `tags`, so it
   does not read from the cached full list.

## Files

<!-- prettier-ignore -->
```
src/
  cache.ts                  # new: createTtlCache
src/printify/
  catalog.ts                # new: Catalog, createCatalog, the response schemas and TTLs
  errors.ts                 # invalidResponseError gains 'an unexpected catalog response'
src/tools/
  catalog.ts                # new: the six tools and catalogTools
  index.ts                  # catalog: catalogTools (or TOOLS_BY_TOOLSET, see decision 6)
  define.ts                 # ToolServices gains catalog
src/cli.ts                  # creates the catalog once per process
test/
  cache.test.ts             # new
  cli.test.ts               # one catalog per process
test/printify/
  catalog.test.ts           # new: requests, parsing and caching
test/tools/
  catalog-toolset.test.ts   # new: the six tools through runTool
  catalog.test.ts           # the rule check now sees six tools; the per-key check if #7 has not merged
  fixtures.ts               # services gain catalog
test/fixtures/
  catalog.ts                # new: the documented examples and builders
```

No new dependencies.

`src/printify/catalog.ts` sits next to `pagination.ts` and #7's `shops.ts`: it fetches, validates
and caches, and knows nothing about tools. `src/cache.ts` knows nothing about Printify.

## TTL cache

```ts
export interface TtlCache<V> {
  /** The value, or `undefined` when there is none or it has expired. */
  get(key: string): V | undefined;
  set(key: string, value: V, ttlMs: number): void;
}

export function createTtlCache<V>(options?: {
  /** Defaults to 200. */
  maxEntries?: number;
  /** Milliseconds from a monotonic clock. Defaults to `performance.now`. */
  now?: () => number;
}): TtlCache<V>;
```

- An entry is fresh while `now() < storedAt + ttlMs`, so it has expired at exactly `ttlMs`.
- `get` deletes an expired entry it finds. `set` first sweeps every expired entry, so keys that are
  never read again do not pile up.
- The entries live in a `Map` in insertion order. `set` deletes the key before inserting it, so a
  re-set entry becomes the newest. When the map then holds more than `maxEntries`, the oldest
  entries go.
- It starts no timers. 200 entries is far more than a session drills into; the bound only keeps a
  long-running process from growing without limit.

## Catalog service

```ts
export interface Catalog {
  /** Every blueprint, for #17. 24 h. */
  allBlueprints(signal: AbortSignal): Promise<readonly Blueprint[]>;
  /** 24 h. */
  blueprint(blueprintId: number, signal: AbortSignal): Promise<Blueprint>;
  /** 24 h. */
  blueprintProviders(
    blueprintId: number,
    signal: AbortSignal,
  ): Promise<readonly BlueprintProvider[]>;
  /** 1 h, cached separately with and without out-of-stock variants. */
  variants(
    blueprintId: number,
    printProviderId: number,
    options: { showOutOfStock: boolean },
    signal: AbortSignal,
  ): Promise<VariantList>;
  /** 1 h. */
  shipping(blueprintId: number, printProviderId: number, signal: AbortSignal): Promise<Shipping>;
  /** 24 h. */
  printProviders(signal: AbortSignal): Promise<readonly PrintProvider[]>;
  /** 24 h. */
  printProvider(printProviderId: number, signal: AbortSignal): Promise<PrintProviderDetail>;
}

export function createCatalog(client: PrintifyClient, options?: { now?: () => number }): Catalog;
```

`ToolServices` gains `catalog: Catalog`. `cli.ts` creates it once, right after the client, so every
server instance of the process shares one cache, as they share one rate limiter:

```ts
const services: ToolServices = { client, config, log, catalog: createCatalog(client) };
```

(With #7 merged, `shops: createShopDirectory(client)` sits next to it.)

### Requests and keys

Every method builds its path with `apiPath` and sends a GET with the caller's `signal`. `variants`
sends the query `{ 'show-out-of-stock': 1 }` when `showOutOfStock` is true and no query otherwise,
because leaving it out already means in stock only.

The cache key is the path plus the query as sent, e.g.
`/v1/catalog/blueprints/6/print_providers/29/variants.json?show-out-of-stock=1`. Tool-side filters
(`colors`, `sizes`, the truncation of a provider's blueprints) never reach the key: they are applied
to the cached value on every call.

### Types and response schemas

<!-- prettier-ignore -->
```ts
interface Blueprint {
  id: number;
  title: string | undefined;
  brand: string | undefined;
  model: string | undefined;
  description: string | undefined;
  images: readonly string[] | undefined;
  /** Only from `blueprint()`. */
  tags: readonly string[] | undefined;
}

interface BlueprintProvider {
  id: number;
  title: string | undefined;
  decoration_methods: readonly string[] | undefined;
}

interface Location {
  address1: string | undefined;
  address2: string | undefined;
  city: string | undefined;
  region: string | undefined;
  country: string | undefined;
  zip: string | undefined;
}

interface PrintProvider {
  id: number;
  title: string | undefined;
  location: Location | undefined;
}

interface PrintProviderDetail extends PrintProvider {
  blueprints: readonly {
    id: number;
    title: string | undefined;
    brand: string | undefined;
    model: string | undefined;
  }[];
}

interface VariantList {
  /** The print provider's id and title. */
  id: number | undefined;
  title: string | undefined;
  variants: readonly Variant[];
}

interface Variant {
  id: number;
  title: string | undefined;
  options: Readonly<Record<string, string>>;
  placeholders: readonly {
    position: string;
    decoration_method: string | undefined;
    width: number;
    height: number;
  }[];
}

interface Shipping {
  handling_time: { value: number; unit: string } | undefined;
  profiles: readonly {
    variant_ids: readonly number[];
    countries: readonly string[];
    first_item: { cost: number; currency: string };
    additional_items: { cost: number; currency: string };
  }[];
}
```

Each schema is a `z.object`, so unknown keys are stripped, and the fields that are not modelled
(variants' `decoration_methods`, the images of a provider's blueprints) are dropped at parse time.
Two kinds of field:

- **Strict:** the ids, the arrays that hold the items, and everything a tool computes on: variant
  `options` (a `z.record(z.string(), z.string())`), placeholder `position`, `width` and `height`,
  and each shipping profile's `variant_ids`, `countries` and costs.
- **Lenient:** titles, `brand`, `model`, `description`, `tags`, `images`, `decoration_methods`,
  `handling_time` and every `location` part are `.nullable().optional().catch(undefined)`, turned
  into `undefined`. One odd title among hundreds of blueprints must not break the full list.

A body that fails the strict part throws
`invalidResponseError({ method: 'GET', path }, 200, 'an unexpected catalog response')`, which the
model sees as kind `invalid_response`. The whole call fails; items are never dropped silently.

### Caching rules

- Only a successful, parsed response is cached. A rejection, an abort included, and a response
  that fails its schema leave the cache as it was.
- Cached values are shared by every later call, so the types are `readonly` and tools build new
  objects rather than changing them.
- There is no `invalidate`: nothing in this server changes the catalog.

## Tools

`src/tools/catalog.ts` exports the six tools and
`catalogTools = [getBlueprint, listBlueprintProviders, listVariants, getShippingInfo, listPrintProviders, getPrintProvider]`.

All six are in the `catalog` toolset with no gate, and all have the annotations
`{ readOnlyHint: true, destructiveHint: false, idempotentHint: true }`. Every input is a
`z.strictObject`. The shared id fields:

```ts
const blueprintId = z.number().int().positive().describe('The catalog blueprint id.');
const printProviderId = z.number().int().positive().describe('The print provider id.');
```

### `get_blueprint`

| Field    | Value                                                                    |
| -------- | ------------------------------------------------------------------------ |
| Input    | `blueprint_id`; `include_images`, a boolean that defaults to `false`     |
| Requests | `GET /v1/catalog/blueprints/{blueprint_id}.json`                         |
| Output   | `{ id, title, brand, model, description, tags }`, plus `images` if asked |

`include_images` is described as "Also return the blueprint's catalog photos as URLs."

> Gets one catalog blueprint (a product template such as a t-shirt or a mug) by id: its title,
> brand, model, description and tags. Next, `list_blueprint_providers` shows who can print it.

### `list_blueprint_providers`

| Field    | Value                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------- |
| Input    | `blueprint_id`                                                                                                            |
| Requests | `GET /v1/catalog/blueprints/{blueprint_id}/print_providers.json` and `GET /v1/catalog/print_providers.json`, both at once |
| Output   | `{ blueprint_id, print_providers: [{ id, title, decoration_methods, location: { city, region, country } }] }`             |

`location` comes from `printProviders()` by id and is left out for a provider that list does not
have. If either request fails, the tool fails: a transient error is retried by the client, and a
partial answer would hide it.

> Lists the print providers that can make a blueprint, with each one's decoration methods (such as
> dtg or embroidery) and location. Pick a provider, then use `list_variants` for its sizes and
> colors and `get_shipping_info` for its shipping costs.

### `list_variants`

| Field    | Value                                                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input    | `blueprint_id`, `print_provider_id`; optional `colors` and `sizes`; `show_out_of_stock`, defaulting to false                                                    |
| Requests | `GET /v1/catalog/blueprints/{blueprint_id}/print_providers/{print_provider_id}/variants.json`; with the flag set, also the same path with `show-out-of-stock=1` |
| Output   | see below                                                                                                                                                       |

```json
{
  "print_provider": { "id": 3, "title": "DJ" },
  "total_variants": 98,
  "variant_count": 1,
  "option_values": { "color": ["Heather Grey", "Solid Black"], "size": ["XS", "S", "M"] },
  "variants": [
    {
      "id": 17426,
      "title": "Solid Black / XS",
      "options": { "color": "Solid Black", "size": "XS" },
      "placeholders": [
        { "position": "front", "decoration_method": "embroidery", "width": 3153, "height": 3995 }
      ]
    }
  ]
}
```

- **Inputs.** `colors` and `sizes` are arrays of 1 to 50 strings that are not blank. An empty array is an
  input validation error, so "no filter" means leaving the argument out. They are described as
  "Only variants whose color (size) is one of these. Exact names, ignoring case; `option_values`
  lists them."
- **Filters.** A value matches `options.color` or `options.size` after both are trimmed and
  lowercased. Values in one list are ORed, and the two lists are ANDed. A variant without that
  option does not match a filter on it.
- **`total_variants`** counts the variants fetched, before filtering. **`variant_count`** counts the
  ones returned. The model should not have to count a long array.
- **`option_values`** lists, for every option key, its distinct values across the variants fetched,
  before filtering, in the order Printify sends them.
- **`variants`** keep Printify's order and carry `id`, `title`, `options` and `placeholders` with
  `position`, `decoration_method`, `width` and `height`.
- **Stock.** With `show_out_of_stock: true` the tool fetches the full list and the in-stock list at
  once, each cached for its hour, and every variant carries `in_stock: true` or `false` by whether
  its id is in the in-stock list. An explicit `true` is harder to misread than a missing key.
  Without the flag, only variants in stock are fetched and none carries `in_stock`.

> Lists the variants (the size and color combinations) a print provider offers for a blueprint.
> Each has the variant id that products and orders use, its options, and its print positions with
> their size in pixels. Filter with `colors` and `sizes`: exact names, ignoring case, and
> `option_values` lists every name. Only variants in stock are listed unless `show_out_of_stock` is
> set; then every variant says whether it is `in_stock`.

### `get_shipping_info`

| Field    | Value                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| Input    | `blueprint_id`, `print_provider_id`                                                                        |
| Requests | `GET /v1/catalog/blueprints/{blueprint_id}/print_providers/{print_provider_id}/shipping.json`              |
| Output   | `{ handling_time: { value, unit }, profiles: [{ countries, first_item, additional_items, variant_ids }] }` |

The output keeps Printify's shape and field names; nothing in it is heavy.

> Gets a print provider's shipping costs and handling time for a blueprint. Each profile covers a
> set of countries and variant ids; `REST_OF_THE_WORLD` covers every country no profile lists.
> Costs are in cents of `currency` (450 = 4.50 USD): `first_item` is charged for the first item of
> this blueprint and provider in an order, `additional_items` for every further one. The costs are
> not broken down by shipping method.

### `list_print_providers`

| Field    | Value                                                                       |
| -------- | --------------------------------------------------------------------------- |
| Input    | `z.strictObject({})`                                                        |
| Requests | `GET /v1/catalog/print_providers.json`                                      |
| Output   | `{ print_providers: [{ id, title, location: { city, region, country } }] }` |

> Lists every Printify print provider with its id, name and location. To find the providers that
> can make a particular product, use `list_blueprint_providers` instead.

### `get_print_provider`

| Field    | Value                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------ |
| Input    | `print_provider_id`                                                                                          |
| Requests | `GET /v1/catalog/print_providers/{print_provider_id}.json`                                                   |
| Output   | `{ id, title, location, blueprint_count, blueprints: [{ id, title, brand, model }], blueprints_truncated? }` |

- `location` keeps all six parts; the docs describe it as the provider's return address. The
  registry drops a `null` `address2`.
- `blueprints` holds the first 50 in Printify's order, without images. `blueprint_count` is the full
  number, and `blueprints_truncated: true` is present only when some were left out.

> Gets one print provider: its name, its address, and the blueprints it offers (id, title, brand
> and model). Only the first 50 blueprints are listed; `blueprint_count` gives the total.

### What the descriptions leave out

They name no tool that does not exist yet. #17 adds a pointer to `search_blueprints` where it helps,
e.g. in `get_print_provider` once a provider's blueprints are cut off.

## Error handling

- A `PrintifyApiError` propagates unchanged; the registry turns it into an `isError` result with
  its hint. An unknown blueprint id, for example, is Printify's 404 with the "Not found" hint, and a
  used-up catalog bucket is the rate limiter's fail-fast 429 with the wait in its hint.
- A malformed response is an `invalid_response` error (see the schemas).
- The catalog toolset throws no `ToolError` of its own.
- `ctx.signal` goes into every catalog call, so a cancelled tool call aborts its requests and
  caches nothing.

## Tests

Test-first. None needs the network or a Printify account.

### `test/cache.test.ts`

With an injected `now`:

- a value is returned before its TTL, and not at exactly its TTL or after it;
- `set` sweeps expired entries (checked by filling past `maxEntries` with expired ones, which must
  not evict a fresh entry);
- past `maxEntries` the oldest entry goes;
- re-setting a key makes it the newest, so it survives the next eviction.

### `test/printify/catalog.test.ts`

`createCatalog` with a fake `PrintifyClient` whose `request` is a `vi.fn`, and an injected `now`:

- each method sends a GET to its documented path, with the signal; the shipping path includes
  `{print_provider_id}`;
- `variants` sends `show-out-of-stock: 1` only when `showOutOfStock` is true;
- a second call within the TTL sends no request; after 24 h (blueprints and providers) or 1 h
  (variants and shipping) it sends one again; different ids, and the two stock settings, are
  separate entries;
- a rejected request, an aborted one and a response that fails its schema are not cached, and the
  last is an `invalid_response` error;
- lenient fields become `undefined` without failing the response; a variant with a non-string
  option value fails it.

### `test/tools/catalog-toolset.test.ts`

Through `runTool`, with `fixtureContext({ fetch: api.fetch })`. Each tool is taken from `ALL_TOOLS`
by name, so a tool that was never wired in fails its own tests. Input is passed through
`tool.input.parse(args)` first, as the SDK would, so the defaults apply.

The fake API is a stand-in for #6's `createFakeApi` with the same rules: route keys are
`METHOD /path` without the query, a value is sent as a 200 JSON body, a `Response` is sent as is,
a function gets the recorded request (with its `query`) and returns either. Every request is
recorded in `api.requests`. An unmatched request is recorded in `api.unmatched` and answered with a
418 naming the missing route; `afterEach` asserts `api.unmatched` is empty. If #6 has merged, the
real `createFakeApi` is used instead.

- **Every tool:** the requests it sends, its output from the documented fixtures, a second call
  that sends no further request, and a JSON text with no `images` key.
- **`get_blueprint`:** `include_images: true` adds `images`.
- **`list_blueprint_providers`:** locations are joined by id; a provider missing from the provider
  list has no `location`.
- **`list_variants`:**
  - `colors` alone, `sizes` alone, both, and a value with different case and surrounding spaces;
  - a filter that matches nothing returns `variant_count: 0`, no variants and the full
    `option_values`;
  - `show_out_of_stock: true` sends both requests and marks `in_stock` on every variant;
  - without the flag, one request and no `in_stock`;
  - `tool.input.safeParse` rejects an empty `colors` array.
- **`get_print_provider`:** a provider with 60 blueprints returns 50, `blueprint_count: 60` and
  `blueprints_truncated: true`; one with 50 has no `blueprints_truncated`.
- **Errors:** a 404 from the fake API gives an `http` error result with status 404.

### Changed tests

- `test/tools/fixtures.ts`: `fixtureServices` and `fixtureContext` add a real
  `createCatalog(client)` on the same fake `fetch`.
- `test/cli.test.ts`: one catalog however many servers the factory builds, checked with a spy the
  way the one-client test does it.
- `test/tools/catalog.test.ts`: `toolProblems(ALL_TOOLS)` now checks six real tools. If #7 has not
  merged, it also gains #7's check that every tool under a `TOOLS_BY_TOOLSET` key has that toolset.

### Fixtures

`test/fixtures/catalog.ts` follows #6's pattern: constants built from the documented response
examples, trimmed to a few items, and builders that take overrides. It holds a blueprint, the
blueprint list, a blueprint's providers, the provider list, a provider with its blueprints,
variants in two colors and several sizes (including one that only the out-of-stock list has), and a
shipping response with a `REST_OF_THE_WORLD` profile. A builder generates a provider with any
number of blueprints for the truncation test.

## Acceptance criteria mapping

| Criterion (issue #8)                                 | Covered by                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Tests per tool, including filters and cache hits     | `test/tools/catalog-toolset.test.ts`, through `runTool` (decision 5)                            |
| Outputs stay compact: no `images[]` unless requested | `include_images` on `get_blueprint`, image-free provider blueprints, the no-`images` assertions |

The issue's other requirements:

| Requirement                                                                             | Covered by                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| The six tools, toolset `catalog`, all read-only                                         | `src/tools/catalog.ts`, the rule check over `ALL_TOOLS` |
| No raw `list_blueprints` tool; a shared `getAllBlueprints()` feeds the cache            | `catalog.allBlueprints()`, used by #17                  |
| `show_out_of_stock` maps to `show-out-of-stock=1`                                       | `catalog.variants()`; decision 2 adds `in_stock`        |
| Optional `colors[]` and `sizes[]`, case-insensitive                                     | `list_variants`; decision 3 adds `option_values`        |
| Compact variants: id, title, options, placeholder positions with px sizes               | `list_variants`                                         |
| `get_print_provider` truncates its `blueprints[]` with a count                          | `blueprint_count`, `blueprints_truncated`               |
| Cache: blueprints and providers 24 h, variants and shipping 1 h; key has the query      | `createCatalog`, `createTtlCache`                       |
| The v1 shipping path includes `{print_provider_id}`                                     | `catalog.shipping()`, asserted on the request path      |
| Example: "Which print providers make the Bella+Canvas 3001 and where are they located?" | `list_blueprint_providers` with locations (decision 1)  |

## Out of scope

| Topic                                                    | Where                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------- |
| `search_blueprints` over `allBlueprints()`               | #17                                                             |
| `get_print_areas` over `variants()`                      | #18                                                             |
| Shipping methods and per-method costs (v2)               | #9, as two more `Catalog` methods                               |
| Sharing one in-flight request between concurrent callers | #17, if cold full-list downloads in parallel turn out to matter |
| Moving the toolset tests onto `createTestServer`         | #6, or whichever issue lands after it                           |
| Stripping HTML from `description`                        | Not planned                                                     |
| Filters on a third option, a country filter on shipping  | Not planned                                                     |
| Renaming `test/tools/catalog.test.ts`                    | Not planned while #7 edits it                                   |

## Delivery

1. Branch `feat/8-catalog-toolset` from `origin/main` (57869ad), in its own worktree at
   `../printify-mcp-worktrees/feat-8-catalog-toolset`, outside the repository so the main
   checkout's `eslint .` does not lint it. This spec is its first commit.
2. Implementation plan via the writing-plans skill. Before implementing, check whether #6 and #7
   have merged; rebase onto `main` if they have, and apply decisions 5 and 6 accordingly.
3. Test-first implementation.
4. Local verification before any claim of success: `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test` and `npm run build`.
5. PR starting with `Closes #8`, moved to In review on the project board. Watch its CI run on
   Node 22 and 24.
6. Hand-off comments:
   - #6: the catalog toolset tests are ready to move onto `createTestServer`; the stand-in fake API
     follows its rules; the catalog fixtures are in `test/fixtures/catalog.ts`.
   - #9: add `shippingMethods` and `shippingCosts` to `Catalog` with a 1 h TTL; the `catalog` rate
     bucket already covers `/v2/catalog/`.
   - #17: use `catalog.allBlueprints()` (24 h, no in-flight sharing), and add a `search_blueprints`
     pointer to the catalog descriptions.
   - #18: use `catalog.variants()`; placeholders keep `decoration_method`, and `option_values` in
     `list_variants` already summarises the options.
