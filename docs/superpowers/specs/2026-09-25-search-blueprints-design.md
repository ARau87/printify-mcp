# `search_blueprints` — design

- **Issue:** [#17 search_blueprints workflow tool](https://github.com/ARau87/printify-mcp/issues/17)
- **Date:** 2026-09-25
- **Status:** approved

## Goal

After #8 there is no way for a model to discover a `blueprint_id`. The only in-branch path is
`list_print_providers` → `get_print_provider` → a blueprint list that truncates at 50, so #8's own
example prompt ("which print providers make the Bella+Canvas 3001") is not answerable unless the
user supplies the id. #8's spec accepted that gap on the condition that this issue closes it.

This issue adds one read-only tool, `search_blueprints`, that ranks the cached full blueprint list
by a text query. It adds no new endpoint, no new `Catalog` method and no new dependency: the whole
feature is matching and ranking over data `catalog.allBlueprints()` already fetches and caches.

## Printify API facts this design relies on

Checked on 2026-09-25 against https://developers.printify.com/#catalog. Nothing here is new since
#8; it is restated because the ranking depends on it.

- **`GET /v1/catalog/blueprints.json`** returns every blueprint as
  `{ id, title, description, brand, model, images }` in one un-paginated array. There is no search
  parameter, no `limit` and no `offset`: filtering is entirely ours to do.
- **`tags` is not on the list response**, only on the single-blueprint endpoint. It is therefore
  not searchable here. `blueprintSchema` is shared between the two, so `tags` is simply absent on
  list items rather than an error.
- **`description` is HTML.** The documented examples are prose, but real descriptions carry markup.
- **`title`, `brand` and `model` are free text.** Titles carry trademark signs and hyphens
  ("Unisex Heavy Blend™ Hooded Sweatshirt", "Unisex Jersey Short Sleeve Tee"); `model` is often
  numeric as a string ("18500", "3001").
- **Rate limit and freshness:** unchanged from #8. `allBlueprints()` is cached for `STABLE_TTL_MS`
  (24 h), which is what gives this tool "one upstream request per cache period" for free.

## Decisions that differ from the issue and the earlier notes

1. **The tool joins the `catalog` toolset, not `workflows`.** The issue and the architecture note
   repeated in every issue list `search_blueprints` among the three workflow tools. But it is the
   only way to discover a `blueprint_id`, so leaving it in `workflows` means `PRINTIFY_TOOLSETS=catalog`
   yields the entire catalog drill-down with no entry point — the exact gap this issue exists to
   close. It also reads only catalog data and orchestrates nothing across resources, unlike
   `create_product_from_image`, which is what "workflow tool" was coined for. `workflows` stays
   empty until #18.
2. **HTML is stripped from `description` before matching.** #8's spec records "Stripping HTML from
   `description` — Not planned", which was about output. Matching is different: against raw markup,
   `p`, `br`, `li`, `span`, `class` and `https` are query tokens that hit nearly every blueprint.
   Descriptions are never returned by this tool, so the stripping stays internal to the search.
3. **The next-step pointer lives in the tool description, not the payload.** The issue asks for
   "a hint to call `list_blueprint_providers` next" in the output. Every other catalog tool puts
   next steps in its description, which costs nothing per call instead of repeating a constant
   string in every response.
4. **A query that matches nothing relaxes instead of returning empty.** The issue specifies token
   matching and a ranking order but not what happens when no blueprint matches every token — which
   is what its own example prompt ("a unisex heavyweight hoodie") does against real titles like
   "Unisex Heavy Blend™ Hooded Sweatshirt". See "Relaxation" below.
5. **`brand` is a single name, not an array.** The issue writes it singular. #8's `optionFilter`
   takes arrays, but that filter exists to select many variants at once; a blueprint has one brand
   and the model is choosing, not accumulating.

## Files

<!-- prettier-ignore -->
```
src/tools/blueprint-search.ts        # new: tokenise, match, rank — pure, no ctx, no I/O
src/tools/catalog.ts                 # + searchBlueprintsTool, + catalogTools entry, description edits
test/tools/blueprint-search.test.ts  # new: unit tests over the pure module, no harness
test/tools/catalog-toolset.test.ts   # + search_blueprints through the harness
test/fixtures/catalog.ts             # + SEARCH_BLUEPRINTS, a catalogue wide enough to rank
.github/workflows/ci.yml             # + search_blueprints in the smoke-test name loop
```

No new dependencies.

Matching lives in its own module rather than in `src/tools/catalog.ts` for two reasons: the issue
asks for unit tests of ranking, filters and paging, which are far cheaper against pure functions
than through the MCP harness; and `src/tools/catalog.ts` is already 245 lines, which inlining the
ranking would push past 300.

## `src/tools/blueprint-search.ts`

Pure functions over a `readonly Blueprint[]`. No `ToolContext`, no client, no cache — everything it
needs is passed in.

```ts
export interface BlueprintMatch {
  blueprint: Blueprint;
  /** The query tokens this blueprint matched. */
  matchedTerms: readonly string[];
  score: number;
}

export interface SearchResult {
  /** `undefined` when there is no query: the catalogue is being browsed, not searched. */
  matched: 'all' | 'partial' | undefined;
  /** Tokens that matched no blueprint at all. Empty unless `matched` is `'partial'`. */
  unmatchedTerms: readonly string[];
  /** Every match, ranked. The caller pages it. */
  matches: readonly BlueprintMatch[];
}

export function searchBlueprints(
  blueprints: readonly Blueprint[],
  options: { query?: string | undefined; brand?: string | undefined },
): SearchResult;
```

Paging is deliberately not in here. The module returns the whole ranked list and the tool handler
slices it, so `offset`/`limit` stay a concern of the tool and the module stays about ranking.

### Tokenising

Lowercase, then split on every character that is not a letter or a digit. "Unisex Heavy Blend™
Hooded Sweatshirt" becomes `unisex heavy blend hooded sweatshirt`; "11oz" stays one token;
"T-Shirt" becomes `t` and `shirt`. Empty tokens are dropped, and so are repeats: a word said twice
must not score twice, nor eat the budget below. Only the first 12 distinct tokens of a query are
used, so a pasted paragraph cannot turn into hundreds of comparisons per blueprint; tokens beyond
the cap are dropped before matching and so never appear in `unmatchedTerms`.

`description` has its HTML tags replaced by a space (`<[^>]*>` → `" "`) before tokenising, per
decision 2.

### Matching

A token matches a field when **some word in that field starts with it**. `hood` hits both _Hooded_
and _Hoodie_; `tee` does not hit _Steel_ or _Canteen_.

This is a prefix rule, not a stem: `hoodie` does not match _Hooded_, because neither is a prefix of
the other. That is a real limitation and the reason relaxation exists. The tool description tells
the model to prefer short stems.

### Ranking

Per matched token, the best field it landed in scores:

| Field         | Weight |
| ------------- | ------ |
| `title`       | 3      |
| `brand`       | 2      |
| `model`       | 2      |
| `description` | 1      |

A blueprint's score is the sum over its matched tokens. Results rank by matched-token count
descending, then score descending, then `title` ascending, then `id` ascending. The last two exist
only to make the order deterministic — Printify's list order is not.

### Relaxation

First pass keeps only blueprints that matched **every** token; if any survive, `matched` is
`'all'`. If none do, the second pass keeps every blueprint that matched at least one token and
`matched` is `'partial'`. Because the primary sort key is matched-token count, the relaxed order
puts the blueprints covering the most of the query first.

`unmatchedTerms` is the set of tokens that matched no blueprint in the filtered set. It is computed
over the whole set, not the returned page, so it does not shift as the caller pages.

A query where **no** token matches anything is the extreme of the same case, not a separate one:
`matched` is `'partial'`, `matches` is empty and `unmatchedTerms` holds every token. That is the
honest report — the search ran and these words found nothing — and it is distinct from the empty
`brand` filter below, where the filter, not the query, is why there is nothing.

### Filtering

`brand` is applied before matching: it keeps blueprints whose `brand`, trimmed and lowercased,
equals the filter trimmed and lowercased — the same rule as `matchesOption` in
`src/tools/catalog.ts`. Relaxation runs inside the filtered set. If the filter leaves nothing,
`matches` is empty and `matched` is `undefined`: there was nothing to match against, so reporting a
partial match would be misleading.

### Browsing

With no query, or a query that tokenises to nothing (blank, or only punctuation), every blueprint in
the filtered set is returned sorted by `title` ascending then `id` ascending, `matched` is
`undefined` and `matchedTerms` is empty. A blank query is a browse, not a validation error.

### Lenient fields

`title`, `brand`, `model` and `description` are all `lenientString` in `src/printify/catalog.ts`,
so every one of them can be `undefined`. An undefined field contributes no words and matches
nothing; an undefined `title` sorts after every present one. This is the likeliest crash site in
the module and has its own test.

## Tools

### `search_blueprints`

- **Toolset:** `catalog` (decision 1). **Gate:** none. **Annotations:** `READ_ONLY`, the constant
  the other six catalog tools already share.
- **Input** (`z.strictObject`):

| Field    | Schema                                        | Notes                                             |
| -------- | --------------------------------------------- | ------------------------------------------------- |
| `query`  | `z.string().optional()`                       | No `.min(1)`: blank browses. Matched as above.    |
| `brand`  | `z.string().min(1).optional()`                | Exact name, ignoring case and surrounding spaces. |
| `limit`  | `z.number().int().min(1).max(50).default(20)` | Rows per page.                                    |
| `offset` | `z.number().int().min(0).default(0)`          | Rows to skip.                                     |

- **Handler:** `await ctx.catalog.allBlueprints(ctx.signal)`, then `searchBlueprints(...)`, then
  slice by `offset`/`limit`.
- **Output:**

```json
{
  "total_matches": 37,
  "offset": 0,
  "has_more": true,
  "matched": "partial",
  "unmatched_terms": ["heavyweight", "hoodie"],
  "blueprints": [
    {
      "id": 49,
      "title": "Unisex Heavy Blend Hooded Sweatshirt",
      "brand": "Gildan",
      "model": "18500",
      "matched_terms": ["unisex"]
    }
  ]
}
```

`total_matches` counts the whole ranked set, not the page. `has_more` is `true` when
`offset + blueprints.length < total_matches` and `undefined` otherwise, so `dropNulls` removes it —
counting the rows actually returned rather than `limit`, so an offset past the end does not claim
there is more. `matched`
and `unmatched_terms` are absent when browsing. `matched_terms` appears on a row only when
`matched` is `"partial"` — on a full match it is just the query echoed back on every row.

- **Description** names `list_blueprint_providers` as the next step, says the brand filter needs an
  exact name, and tells the model to prefer short stems (`hood`, not `hoodie`) because matching is
  by word prefix.

### Description edits to existing tools

Per #17's hand-off note, the catalog tool descriptions name no tool that did not exist yet, so none
of them mentions searching:

- **`get_print_provider`** today says its blueprint list is cut off at 50 without saying what to do
  about it. It gains a pointer to `search_blueprints`.
- **The shared `blueprintId` schema** says "The catalog blueprint id, e.g. from
  `get_print_provider`." It gains `search_blueprints` as the primary route, since it is now the one
  that always works.

## Error handling

No new error kinds, no new member of `invalidResponseError`'s `problem` union, and no `ToolError`
cases. `allBlueprints()` validates and caches the response already; a `PrintifyApiError` from it
propagates and the registry maps it as it does for the other catalog tools.

Everything a caller could get wrong is either a schema rejection (`limit: 51`, `offset: -1`) or a
legitimate empty result (an unknown brand, an offset past the end).

## Tests

### `test/tools/blueprint-search.test.ts` (new)

Unit tests against the module; no harness, no fake API.

- Tokenising: punctuation and `™` split; `11oz` stays one token; `T-Shirt` yields `t` and `shirt`.
- The word-prefix rule both ways: `hood` matches _Hooded_ and _Hoodie_; `tee` matches neither
  _Steel_ nor _Canteen_.
- Field weighting: a title hit outranks a description hit for the same token.
- A query whose tokens all match sets `matched: 'all'` and leaves `unmatchedTerms` empty.
- Relaxation: when no blueprint matches every token, `matched` is `'partial'`, `unmatchedTerms`
  holds exactly the tokens nothing matched, and rows are ordered by how many tokens they cover.
- `brand` filters exactly, ignoring case and surrounding spaces; an unknown brand gives no matches
  and `matched: undefined`.
- Ties break by `title` then `id`, so two runs over a shuffled input agree.
- A blank query, and a query of only punctuation, both browse alphabetically.
- A blueprint with `title`, `brand` and `model` undefined neither crashes nor matches, and sorts
  last.

### `test/tools/catalog-toolset.test.ts` (changed)

Through the harness, with the default `ALL_TOOLS`:

- A query returns ranked matches in the documented shape.
- Two calls make **one** upstream request (`api.expectRequest` asserts exactly one
  `GET /v1/catalog/blueprints.json`), covering the cache-period criterion.
- `limit` and `offset` slice the rows while `total_matches` stays the full count, and `has_more`
  appears only while rows remain.
- `limit: 51`, `limit: 0` and `offset: -1` come back as `kind: 'validation'` with no request sent.
- A Printify failure on the blueprint list propagates as an `http` error.

### `test/fixtures/catalog.ts` (changed)

Adds `SEARCH_BLUEPRINTS`, about eight records built from the documented response shape, chosen to
exercise the ranking: two hoodie-like Gildan records, a tee, an `11oz` mug, one whose only hit is
inside an HTML description, one with `™` in the title, and one with `brand` and `model` missing.
The existing `BLUEPRINT`, `BLUEPRINTS` and `blueprint()` stay as they are for the current tests.

### Unchanged

`test/tools/catalog.test.ts`, the registry lint over `ALL_TOOLS`, needs no edit: a read-only tool
with no gate, a snake_case name and a `strictObject` input passes its rules as written.

## Acceptance criteria mapping

| Criterion                                                       | Where                                                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Unit tests for ranking, filters and paging on a fixture catalog | `test/tools/blueprint-search.test.ts` for ranking and filters; the paging cases in `test/tools/catalog-toolset.test.ts` |
| One upstream request per cache period                           | The two-calls-one-request harness test, on top of `allBlueprints()`'s 24 h TTL                                          |

## Out of scope

| Topic                                                         | Where                                                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sharing one in-flight request between concurrent cold callers | Deferred here by #8's spec; still not worth tying one caller's cancellation to another's. Revisit if parallel cold full-list downloads are measured to hurt |
| Stemming or fuzzy matching beyond the word-prefix rule        | Not planned; relaxation plus `unmatched_terms` is the recovery path                                                                                         |
| Caching a normalised search index                             | Not planned. Re-tokenising ~1000 blueprints per call is well under 10 ms; revisit only if measured                                                          |
| Searching `tags`                                              | Not possible: the list response omits them                                                                                                                  |
| Brand discovery (listing the brands that exist)               | Not planned                                                                                                                                                 |
| `get_print_areas` over `variants()`                           | #18                                                                                                                                                         |

## Delivery

Branch `feat/17-search-blueprints` off `main`, in a worktree at
`../printify-mcp-worktrees/17-search-blueprints` — outside the repo, because `eslint .` lints
`.claude/worktrees/`. Test-driven, following `docs/superpowers/plans/2026-09-25-search-blueprints.md`.
PR closing #17.
