# Catalog shipping v2 — shipping methods and per-method costs — design

- **Issue:** [#9 Catalog shipping v2 — shipping methods and per-method costs](https://github.com/ARau87/printify-mcp/issues/9)
- **Date:** 2026-09-24
- **Status:** approved

## Goal

#8's `get_shipping_info` answers "what does this provider charge to ship this blueprint" with a
single blended rate. It cannot answer "how much is _economy_ shipping to Germany", because v1 does
not break costs down by shipping method and does not carry economy rates at all. This issue adds
the two read-only `catalog` tools that do, over Printify's v2 JSON:API endpoints, on top of the
`Catalog` service and TTL cache #8 shipped.

The work is small in surface and awkward in volume: a v2 per-method response is one row per
variant and country, so an unfiltered call on a real t-shirt returns the same handful of rates
repeated hundreds of times. Most of this design is about turning that back into something a model
can read.

## Printify API facts this design relies on

Checked on 2026-09-24 against the HTML docs at https://developers.printify.com/#catalog-v2, which
win over `openapi.json` and Postman where they disagree.

- **Five endpoints**, all `GET`, all under
  `/v2/catalog/blueprints/{blueprint_id}/print_providers/{print_provider_id}/`:
  `shipping.json` and `shipping/{standard,priority,express,economy}.json`. None is paginated and
  none documents a query parameter, so **every filter in this design is applied client-side**.
- **`shipping.json`** returns the methods the provider offers:

  <!-- prettier-ignore -->
  ```json
  {
    "data": [
      { "type": "shipping_method", "id": "1", "attributes": { "name": "standard" } },
      { "type": "shipping_method", "id": "4", "attributes": { "name": "economy" } }
    ],
    "links": { "standard": "https://api.printify.com/v2/.../shipping/standard.json" }
  }
  ```

  The `links` object has a typo in the docs: `priority` appears twice, the second one pointing at
  `express`, and `express` never appears as a key. Nothing may read it.

- **`shipping/{method}.json`** returns one entry per variant and country:

  <!-- prettier-ignore -->
  ```json
  {
    "data": [
      {
        "type": "variant_shipping_standard_us",
        "id": "23494",
        "attributes": {
          "shippingType": "standard",
          "country": { "code": "US" },
          "variantId": 23494,
          "shippingPlanId": "65a7c0825b50fcd56a018e02",
          "handlingTime": { "from": 4, "to": 8 },
          "shippingCost": {
            "firstItem": { "amount": 399, "currency": "USD" },
            "additionalItems": { "amount": 219, "currency": "USD" }
          }
        }
      }
    ]
  }
  ```

  All four methods return the identical shape; only `shippingType` and the `type` string differ.
  `amount` is in cents, as in v1. `country.code` is an ISO code or `REST_OF_THE_WORLD`, which the
  docs define as "all the countries that don't have the costs specified".

- **Economy exists only in v2.** The docs state it outright: "The Economy Shipping costs listing is
  available only in the V2 API."
- **`openapi.json` is wrong here**, as the issue says: it files the four per-method paths under
  `/v1/…` and drops `{print_provider_id}` from them. It lists `shipping.json` correctly under
  `/v2/…`. It documents no parameters for any of them.
- **Rate limit:** `bucketsFor` in `src/printify/rate-limit.ts` already matches `/^\/v[12]\/catalog\//`,
  so these requests take a slot in both the `global` and the `catalog` bucket with no change.
- **`apiPath`** already accepts a `/v2/` prefix, and `src/printify/hints.ts` already maps v2 catalog
  paths to the `catalog.read` scope. Both are covered by existing tests.

### What the docs do not say

How many rows a real response holds. The v1 docs' shipping example shows a single profile carrying
about fifty variant ids, and v2 spells out each country separately rather than grouping them, so
the row count is roughly _variants × countries_. The design therefore assumes the response can be
large and never returns it row by row. No live measurement was possible: the account has no test
shop, and live tests are read-only by design.

## Decisions that differ from the issue

1. **Profiles, not flat rows.** The issue asks `get_shipping_costs` to flatten `data[].attributes`
   into one row per variant and country. That output grows without bound and repeats the same few
   rates. Instead the tool regroups the rows into profiles in the shape v1's `get_shipping_info`
   already uses — `{ countries, variant_ids, first_item, additional_items, handling_days }` — which
   is bounded by the number of distinct rates and reads the same across both shipping tools. The
   regrouping is lossless (see [Grouping](#grouping)).
2. **`method` is optional, and omitting it compares every method.** The issue makes it a required
   enum, so comparing options costs four tool calls. Because profiles keep each response small,
   leaving `method` out fetches the method list and then every method the provider offers,
   concurrently. The output shape does not change: it is always a `methods[]` array, with one
   entry when `method` was given and up to four when it was not.
3. **A country filter falls back to `REST_OF_THE_WORLD`.** Printify lists only the countries it
   charges a specific rate for, so "economy to Germany" often has no `DE` row while Germany is
   still shippable at the catch-all rate. Returning nothing would be wrong. The tool returns exact
   matches when they exist and the catch-all otherwise, and says which it did in `matched`, so a
   catch-all rate is never mistaken for a country-specific one.
4. **Costs keep v1's `{ cost, currency }` shape.** v2 sends `{ amount, currency }` per amount. The
   service renames `amount` to `cost` so a model reading `get_shipping_info` and
   `get_shipping_costs` sees one shape, and so there is no edge case if the two currencies in a row
   ever differ.
5. **`handling_days: { from, to }`.** v2 sends `handlingTime: { from, to }` in days where v1 sends
   `{ value, unit }`. Keeping `from`/`to` and naming the unit in the field avoids inventing a unit
   the API does not send.
6. **`variant_ids` is never truncated.** A four-method comparison on a large blueprint can carry a
   couple of thousand ids, and `get_print_provider` truncates its blueprint list for less. But a
   profile's variant list is the answer to "does this rate apply to my variant", and a truncated
   list cannot answer it — the caller would have to re-call with `variant_ids` to find out what
   was cut. The `country` and `variant_ids` filters are the way to shrink a response, and they
   shrink it far more than a cap would. `variant_count` stays, as `list_variants` has it, so the
   model never has to count the array.
7. **`list_shipping_methods` passes unknown method names through.** The service returns the names
   as strings in the order Printify sends them, so a fifth method would be visible rather than
   silently dropped. `get_shipping_costs`'s `method` input stays the documented four-value enum,
   which is what gives the model a usable schema, and a fan-out requests only names it recognises.
8. **Both tools live in `src/tools/catalog.ts`.** `src/tools/index.ts` documents the convention
   ("Each toolset's tools, from `src/tools/<toolset>.ts`"), and the file is 244 lines. Only the
   grouping function gets a module of its own, next to the existing non-toolset helper
   `src/tools/shop-id.ts`.

## Files

<!-- prettier-ignore -->
```
src/printify/
  catalog.ts                     # + shippingMethods, shippingCosts, their schemas
src/tools/
  catalog.ts                     # + the two tools; one sentence on get_shipping_info
  shipping-profiles.ts           # new: groupShippingProfiles
test/printify/
  catalog.test.ts                # + the two methods: paths, caching, schemas
test/tools/
  shipping-profiles.test.ts      # new: grouping as a pure function
  catalog-shipping.test.ts       # new: both tools through the harness
  catalog.test.ts                # the rule check now sees eight tools
test/fixtures/
  catalog-shipping.ts            # new: the documented v2 examples and builders
```

No new dependencies. `src/tools/catalog-toolset.test.ts` is left alone: the two new tools get their
own file rather than growing a file that already covers six.

## Service layer

`Catalog` gains two methods. They fetch, validate and cache; they do not filter or group, exactly
as `variants()` does not apply `list_variants`'s `colors` and `sizes`.

<!-- prettier-ignore -->
```ts
/** A method name as `shipping.json` lists it. The four documented ones, or something newer. */
export type ShippingMethodName = string;

/** The four methods `get_shipping_costs` can request. */
export const SHIPPING_METHODS = ['standard', 'priority', 'express', 'economy'] as const;
export type ShippingMethod = (typeof SHIPPING_METHODS)[number];

export interface ShippingRow {
  variant_id: number;
  /** An ISO code, or REST_OF_THE_WORLD. */
  country: string;
  first_item: { cost: number; currency: string };
  additional_items: { cost: number; currency: string };
  handling_days: { from: number; to: number } | undefined;
}

export interface Catalog {
  // … #8's seven methods …
  /** The shipping methods a provider offers for a blueprint, in Printify's order. 1 h. */
  shippingMethods: (
    blueprintId: number,
    printProviderId: number,
    signal: AbortSignal,
  ) => Promise<readonly ShippingMethodName[]>;
  /** One method's rows, one per variant and country. 1 h. */
  shippingCosts: (
    blueprintId: number,
    printProviderId: number,
    method: ShippingMethod,
    signal: AbortSignal,
  ) => Promise<readonly ShippingRow[]>;
}
```

Both go through the existing private `fetchCached(schema, path, ttlMs, signal, query?)` with
`VOLATILE_TTL_MS` (1 h), the TTL `shipping()` already uses. They send no query, so the cache key is
the path alone:

- `/v2/catalog/blueprints/6/print_providers/29/shipping.json`
- `/v2/catalog/blueprints/6/print_providers/29/shipping/economy.json`

Each method is therefore its own entry, and the tool-side `country` and `variant_ids` filters never
reach the key — they are applied to the cached rows on every call.

### Schemas

Both schemas parse the JSON:API envelope and `transform` it into the shape above, so what the cache
holds is already `ShippingMethodName[]` or `ShippingRow[]` and no mapping runs on a cache hit. The
plan must check that a transforming schema is still assignable to `fetchCached`'s
`schema: z.ZodType<T>` parameter under Zod 4; if it is not, the schemas stay plain and the mapping
moves into the two methods, above the cache rather than below it.
`z.object` strips unknown keys, so `shippingPlanId` (internal), `shippingType` (it only repeats the
path), the `type` and `id` strings and the `links` object are all dropped at parse time and can
never reach a tool result.

Following #8's split:

- **Strict** — the fields a tool computes on: `attributes.variantId`, `attributes.country.code`, and
  both `shippingCost` amounts and currencies. A row missing any of them fails the response.
- **Lenient** — `attributes.handlingTime`, through #8's `lenient()` helper, so it becomes
  `undefined` rather than failing a response over a handling time.
- The method list's `attributes.name` is strict: an entry without a name is not a method.

A body that fails the strict part throws
`invalidResponseError({ method: 'GET', path }, 200, 'an unexpected catalog response')` — the same
message #8's catalog schemas use, surfacing as kind `invalid_response`. Rows are never dropped
silently.

## Grouping

`groupShippingProfiles(rows)` in `src/tools/shipping-profiles.ts` turns `ShippingRow[]` into the
profile shape. It is a pure function: rows in, profiles out, touching neither the client nor the
cache.

<!-- prettier-ignore -->
```ts
export interface ShippingProfile {
  countries: string[];
  variant_ids: number[];
  variant_count: number;
  first_item: { cost: number; currency: string };
  additional_items: { cost: number; currency: string };
  handling_days?: { from: number; to: number };
}

export function groupShippingProfiles(rows: readonly ShippingRow[]): ShippingProfile[];
```

Two passes, and the result is lossless:

1. Group rows by _(rate, country)_, where a rate is both costs, both currencies and the handling
   time together. This yields `{ country, variant_ids }` entries.
2. Merge entries that share a rate **and** an identical variant-id list into one profile carrying
   both countries.

Requiring the variant lists to be identical before merging is what makes the cross product exact.
A provider that charges one variant differently in one country gets its own profile instead of
being folded into a rate that does not apply to it:

<!-- prettier-ignore -->
```
rows                                   profiles
  v1 US 399/219                          { countries: [US, CA], variant_ids: [v1, v2], 399/219 }
  v2 US 399/219                          { countries: [US],     variant_ids: [v3],     599/219 }
  v3 US 599/219            ->            { countries: [CA],     variant_ids: [v3],     399/219 }
  v1 CA 399/219
  v2 CA 399/219
  v3 CA 399/219
```

Everything keeps Printify's first-appearance order: profiles in the order their first row appeared,
countries and variant ids likewise.

## Tools

Both are in the `catalog` toolset with no gate, both carry `READ_ONLY`
(`{ readOnlyHint: true, destructiveHint: false, idempotentHint: true }`), and both reuse the
`blueprintId` and `printProviderId` field schemas already in `src/tools/catalog.ts`. Every input is
a `z.strictObject`. They are appended to `catalogTools`, so `TOOLS_BY_TOOLSET` does not change.

### `list_shipping_methods`

| Field    | Value                                                                   |
| -------- | ----------------------------------------------------------------------- |
| Input    | `blueprint_id`, `print_provider_id`                                     |
| Requests | `GET /v2/catalog/blueprints/{id}/print_providers/{pp_id}/shipping.json` |
| Output   | `{ blueprint_id, print_provider_id, methods: ["standard", …] }`         |

> Lists the shipping methods a print provider offers for a blueprint: standard, priority, express
> or economy. Economy rates exist only here, not in `get_shipping_info`. Use `get_shipping_costs`
> for what each method costs.

### `get_shipping_costs`

| Field    | Value                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------- |
| Input    | `blueprint_id`, `print_provider_id`; optional `method`, `country`, `variant_ids`                      |
| Requests | with `method`, one GET; without, `shipping.json` and then one GET per recognised method, concurrently |
| Output   | see below                                                                                             |

Inputs:

- **`method`** — `z.enum(SHIPPING_METHODS).optional()`, described as "Leave out to compare every
  method this provider offers."
- **`country`** — a string matched case-insensitively after trimming, constrained to
  `/^([A-Za-z]{2}|REST_OF_THE_WORLD)$/`. The constraint turns `"Germany"` into an input validation
  error rather than a silent fall-back to the catch-all rate. `REST_OF_THE_WORLD` is accepted as a
  value in its own right, and then matches the catch-all profiles directly, with
  `matched: "country"`.
- **`variant_ids`** — 1 to 100 positive integers, described as coming from `list_variants`. An empty
  array is an input validation error, matching the rule `colors` and `sizes` already follow: "no
  filter" means leaving the argument out.

Filters apply in order — `variant_ids` narrows the rows, then the country match runs on what is
left, then grouping. So a variant with no `DE` row falls back to the catch-all even when some other
variant of the same blueprint has one.

<!-- prettier-ignore -->
```json
{
  "blueprint_id": 6,
  "print_provider_id": 29,
  "country": "DE",
  "methods": [
    {
      "method": "economy",
      "matched": "rest_of_the_world",
      "profile_count": 1,
      "profiles": [
        {
          "countries": ["REST_OF_THE_WORLD"],
          "variant_ids": [23494, 23495],
          "variant_count": 2,
          "first_item": { "cost": 1100, "currency": "USD" },
          "additional_items": { "cost": 0, "currency": "USD" },
          "handling_days": { "from": 4, "to": 8 }
        }
      ]
    }
  ]
}
```

- `country` and `matched` appear only when the `country` filter was given. `matched` is `"country"`
  when a profile names it, `"rest_of_the_world"` when the catch-all was used, and `"none"` when
  neither exists — in which case `profiles` is empty.
- `matched` sits on each `methods[]` entry, not at the top level: with `method` omitted, `standard`
  may list `DE` while `economy` does not, so the two entries can resolve differently in one
  response.
- `methods[]` follows the order `shipping.json` returns, and holds exactly one entry when `method`
  was given.
- `profile_count` saves the model counting the array. `handling_days` is left out when Printify
  sent none.

> Gets a print provider's shipping costs and handling time for a blueprint, broken down by shipping
> method. Leave `method` out to compare every method the provider offers. Filter with `country` (an
> ISO code such as DE) and with `variant_ids` from `list_variants`. Costs are in cents of currency
> (399 = 3.99 USD): first_item is charged for the first item of this blueprint and provider in an
> order, additional_items for every further one. A profile's rate applies to every country and
> variant it lists. REST_OF_THE_WORLD covers every country no profile names; matched says when a
> country fell back to it. For a single overall rate in one request, use `get_shipping_info`.

### The v1 tool's description

`get_shipping_info` ends with "The costs are not broken down by shipping method." #9 extends that
sentence: "…; `get_shipping_costs` gives them per method, including economy." Nothing else about
that tool changes.

## Error handling

- **404** propagates as an `http` error with Printify's "Not found" hint — an unknown blueprint or
  provider, and also a method the provider does not serve. With an explicit `method` the tool
  requests it directly rather than checking the method list first, so that case costs one request
  instead of two, and the tool description points at `list_shipping_methods`.
- **An empty `data[]`** is `profile_count: 0`, not an error. A provider that simply does not offer
  express has answered the question.
- **A fan-out fails whole.** If any of its requests fails, the tool fails, as
  `list_blueprint_providers` already does: a partial comparison would hide a rate limit or an
  outage behind a plausible-looking answer.
- **A malformed body** is `invalid_response`.
- **Cancellation:** `ctx.signal` goes into every request, including every leg of a fan-out, and an
  aborted call caches nothing.
- **Rate limiting:** a fan-out takes up to five slots from the 100-per-minute catalog bucket. The
  limiter already fails fast with the wait in its hint when the bucket is used up.
- Neither tool throws a `ToolError` of its own.

## Tests

Test-first. None needs the network or a Printify account.

### `test/tools/shipping-profiles.test.ts`

`groupShippingProfiles` directly:

- two countries sharing a rate and an identical variant list merge into one profile;
- the same rate over different variant lists stays two profiles;
- a variant priced differently in one country is not folded into the others' profile (the worked
  example above);
- rows differing only in handling time do not merge;
- a row with no `handling_days` does not merge with one that has it, and its profile omits the key;
- profiles, countries and variant ids keep first-appearance order;
- `variant_count` matches the length of `variant_ids`, however many there are;
- no rows gives no profiles.

### `test/printify/catalog.test.ts` (extended)

`createCatalog` over a real client on #6's `createFakeApi`, with an injected `now`, as the existing
catalog tests do:

- each method sends a GET to its documented v2 path, with the caller's signal;
- a second call within the hour sends no request; after 1 h it sends one again;
- each method name, and each blueprint/provider pair, is a separate cache entry;
- `amount` becomes `cost` and `handlingTime` becomes `handling_days`;
- a missing `handlingTime` becomes `undefined` without failing the response;
- a row with a non-numeric `variantId`, and a method entry with no `name`, are `invalid_response`;
- a 404, an aborted request and a response that fails its schema are not cached;
- `shippingPlanId`, `shippingType`, `type`, `id` and `links` do not survive parsing.

### `test/tools/catalog-shipping.test.ts`

Through #6's harness, `createTestServer({ routes })` over `ALL_TOOLS`, so a tool that was never
wired in fails its own tests. Each test starts with a cold cache.

- **`tools/list`** shows both tools with `readOnlyHint: true` and `openWorldHint: true`.
- **`list_shipping_methods`** returns the names in Printify's order, passes an undocumented name
  through, and a second call sends no further request.
- **`get_shipping_costs` with `method`** sends exactly one request and returns one `methods[]`
  entry with grouped profiles.
- **`get_shipping_costs` without `method`** sends `shipping.json` plus one request per recognised
  method, returns them in that order, and skips an undocumented name.
- **Country filter:** a country a profile names gives `matched: "country"`; one it does not gives
  `matched: "rest_of_the_world"` and the catch-all profile; a fixture where `standard` lists `DE`
  and `economy` does not gives different `matched` values in one response; neither existing gives
  `matched: "none"` and no profiles; `" de "` matches `DE`; `"Germany"` is
  `expectToolError(result, { kind: 'validation' })` with no request sent.
- **Variant filter:** `variant_ids` narrows the profiles and can split a profile whose variants are
  priced differently; unknown ids give `profile_count: 0`; an empty array is a validation error
  with no request sent.
- **Empty `data[]`** gives `profile_count: 0` and no error.
- **Errors:** a 404 is `expectToolError(result, { kind: 'http', status: 404 })`; a fan-out in which
  one method's request 404s fails the whole call.
- **Compactness:** the result's JSON text contains no `shipping_plan_id`, `shippingType`, `type` or
  `links`.

### Changed tests

`test/tools/catalog.test.ts`: `toolProblems(ALL_TOOLS)` now checks eight catalog tools. No change is
needed to `test/support/harness.ts`, `test/tools/fixtures.ts` or `test/cli.test.ts` — the services
already carry `catalog`.

### Fixtures

`test/fixtures/catalog-shipping.ts`, following the pattern in `CONTRIBUTING.md`: the documented
method list and per-method response as constants, extended to three variants across `US`, `DE` and
`REST_OF_THE_WORLD` so grouping, the country fallback and the differently-priced-variant case all
have real data; a variant priced differently in one country; and builders that take overrides,
including one that generates a method response with any number of variants.

## Acceptance criteria mapping

| Criterion (issue #9)                 | Covered by                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| Harness tests with JSON:API fixtures | `test/tools/catalog-shipping.test.ts` over `test/fixtures/catalog-shipping.ts`   |
| … including filtering                | the country and variant filter tests, and `test/tools/shipping-profiles.test.ts` |

The issue's other requirements:

| Requirement                                                  | Covered by                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Two tools, toolset `catalog`, read-only                      | `src/tools/catalog.ts`, the rule check over `ALL_TOOLS`                  |
| The two v2 endpoints, `/v2/…` and not `/v1/…`                | `catalog.shippingMethods`, `catalog.shippingCosts`, path tests           |
| `method` is the enum standard/priority/express/economy       | `SHIPPING_METHODS`; decision 2 makes it optional                         |
| Optional `country` and `variant_ids[]` filters               | `get_shipping_costs`; decision 3 adds the fallback                       |
| Fields: variant_id, country, first_item, additional_items, … | kept, regrouped into profiles by decision 1                              |
| … `currency`, `handling_days`                                | decision 4 keeps `{ cost, currency }`; decision 5, `from`/`to`           |
| Catalog rate-limit bucket and cache                          | `bucketsFor` already matches `/v2/catalog/`; `VOLATILE_TTL_MS`           |
| Example: "economy shipping to Germany for the black M tee"   | `method: "economy"`, `country: "DE"`, `variant_ids` from `list_variants` |

## Out of scope

| Topic                                                                      | Where                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------- |
| Retiring or demoting `get_shipping_info`                                   | Not planned; the two descriptions cross-reference |
| `shippingPlanId` in any output                                             | Not planned; it is internal to Printify           |
| An order's actual shipping quote (`POST /v1/shops/…/orders/shipping.json`) | The `orders` toolset                              |
| Sharing one in-flight request between concurrent callers                   | #17, as #8 already decided                        |
| Live tests against the real API                                            | #22, read-only                                    |

## Delivery

1. Branch `feat/9-catalog-shipping-v2` from `origin/main` (94e8c6f, which carries #7 and #8), in
   its own worktree at `../printify-mcp-worktrees/feat-9-catalog-shipping-v2`, outside the
   repository so the main checkout's `eslint .` does not lint it. This spec is its first commit.
2. Implementation plan via the writing-plans skill.
3. Test-first implementation.
4. Local verification before any claim of success: `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test` and `npm run build`.
5. PR starting with `Closes #9`, moved to In review on the project board. Watch its CI run on
   Node 22 and 24.
6. Hand-off comment to #17: `search_blueprints` may want to point at `get_shipping_costs` where a
   blueprint's providers are compared.
