# `get_print_areas` — design

- **Issue:** [#18 get_print_areas workflow tool](https://github.com/ARau87/printify-mcp/issues/18)
- **Date:** 2026-10-05
- **Status:** approved

## Goal

Placing artwork needs the printable positions and their pixel sizes. `list_variants` (#8) returns
them, but per variant: a blueprint with 120 variants repeats the same two or three placeholders
120 times, and where a size differs between variants nothing says so. A model asked "what print
areas does this tee have and how big should my artwork be?" has to scan the whole list and work
out the answer itself.

This issue adds one read-only tool, `get_print_areas`, that aggregates the variant placeholders of
one blueprint at one print provider into unique positions with their pixel sizes, lists every
distinct size where variants differ, and summarises the option values a model picks variants
from. It adds no endpoint, no `Catalog` method and no dependency: the whole feature is grouping
over data `catalog.variants()` already fetches and caches.

## Printify API facts this design relies on

Checked on 2026-09-25 and 2026-09-30 against https://developers.printify.com/#catalog and
https://developers.printify.com/#image-positioning (the #11 and #19 specs record the same facts).

- **`GET /v1/catalog/blueprints/{b}/print_providers/{p}/variants.json`** returns
  `{ id, title, variants }`, where `id` and `title` are the **print provider's**. Each variant has
  `placeholders: [{ position, decoration_method, width, height }]`, in pixels. Without
  `show-out-of-stock=1` only the variants in stock are listed.
- **Sizes can differ between variants** of one blueprint and provider, by size or by colour.
  Printify does not say which; the aggregation has to discover it.
- **Positioning:** "[0,00; 0,00] .. [1,00; 1,00] cartesian coordinate system, with the placeholder
  center being x=0,5, y=0,5"; `scale` is "the image (width) relative to the print area placeholder
  (width)", "from 0,00 to infinity", so `1` fills the width. "By selecting a position for your
  images, you also select the decoration method."
- **Error 8203** "Validation failed." with reason "Image has low quality" is the documented
  create/update failure for artwork with too few pixels; `src/printify/hints.ts` already explains
  it.
- **Rate limit and freshness:** unchanged from #8. `variants()` is cached for `VOLATILE_TTL_MS`
  (1 h), per stock setting, so a `list_variants` call and a `get_print_areas` call for the same
  blueprint and provider share one upstream request.

## Decisions that differ from the issue and the earlier notes

1. **The tool joins the `catalog` toolset, not `workflows`.** Same reasoning as #17's decision 1:
   it reads only catalog data and orchestrates nothing across resources, so `PRINTIFY_TOOLSETS=catalog`
   should answer the sizing question on its own. `workflows` holds `create_product_from_image`
   (#19), the tool the name was coined for.
2. **The positioning guide lives in the tool description, not the payload.** The issue asks for a
   short guide in the output. Its three rules are constants, and every payload is emitted twice
   (text and `structuredContent`), so they go in the description, as #17's decision 3 did with
   next-step pointers. What the payload carries is what is specific to this blueprint and
   provider: per position, the pixel size artwork needs at `scale: 1` across every variant.
3. **Only the variants in stock are aggregated, and there is no stock flag.** `variant_count` and
   `option_values` then describe what can be ordered today, and the call shares its cache entry
   with a plain `list_variants`. Placeholder geometry rarely differs for out-of-stock variants,
   and `list_variants` with `show_out_of_stock` already covers them when a model needs them.
4. **The strict variant schema is inherited unchanged.** #8's hand-off suggested this tool might
   tolerate what `list_variants`' filters cannot. It cannot honestly: it summarises `options` too.
   The failure (one variant with an unexpected option type fails the whole response) stays
   hypothetical and stays recorded in #8's follow-ups.
5. **The grouping is its own pure module, not #19's `groupByPlaceholders`.** #19's spec expected
   this issue to reuse that function. It answers a different question: it groups _selected_
   variants by their combined size signature across _requested_ positions, keys by position alone,
   and throws for a variant lacking a position. This tool groups every variant per position and
   decoration method, with no positions requested. The two share a convention (a variant listing
   a position twice uses the first placeholder) and nothing else worth a shared helper.
6. **Sizes are nested only when they differ.** One row per position and method carries the
   largest size as its headline; a `sizes` list appears only when more than one distinct size
   exists, each entry with the `variant_ids` that have it. That is exactly what a `print_areas`
   entry in `create_product` takes when a product needs separate placement per size group, and
   the common single-size case stays flat.

## Files

<!-- prettier-ignore -->
```
src/tools/print-areas.ts           # new: summarisePrintAreas(variants) — pure, no ctx, no I/O
src/tools/catalog.ts               # + getPrintAreasTool, + catalogTools entry, export optionValues,
                                   #   list_variants description points at get_print_areas
src/tools/workflows.ts             # create_product_from_image description points at get_print_areas
test/tools/print-areas.test.ts     # new: unit tests over the pure module, no harness
test/tools/catalog-toolset.test.ts # + get_print_areas through the harness
test/fixtures/catalog.ts           # + PRINT_AREA_VARIANTS: three positions, two sizes, two methods
.github/workflows/ci.yml           # + get_print_areas in the smoke-test name loop
```

No new dependencies. `src/printify/catalog.ts` and its schemas do not change.

The grouping lives in its own module for the same two reasons as #17's search: the acceptance
criterion is unit tests over a fixture with several positions and sizes, which are cheap against a
pure function, and `src/tools/catalog.ts` is already about 450 lines. `optionValues` stays in
`catalog.ts` and gains an `export` rather than moving, so no file moves.

## `src/tools/print-areas.ts`

<!-- prettier-ignore -->
```ts
export interface PrintAreaSize {
  width_px: number;
  height_px: number;
  /** width / height, to three decimals; undefined when height is 0. */
  aspect_ratio: number | undefined;
  variant_count: number;
  /** The variants with this size at this position, in catalog order. */
  variant_ids: readonly number[];
}

export interface PrintArea {
  position: string;
  decoration_method: string | undefined;
  /** The largest size's: artwork this wide at scale 1 fits every variant. */
  width_px: number;
  height_px: number;
  aspect_ratio: number | undefined;
  /** Variants that have this position and method at all. */
  variant_count: number;
  /** Every distinct size, largest first; undefined when there is only one. */
  sizes: readonly PrintAreaSize[] | undefined;
}

/** Aggregates variant placeholders into one row per position and decoration method. */
export function summarisePrintAreas(variants: readonly Variant[]): readonly PrintArea[];
```

**Algorithm.** Walk the variants in catalog order. For each placeholder the row key is
`position` plus `decoration_method`; an undefined method gets its own key. A row is created the
first time its key appears, so rows keep Printify's order. Within a row, sizes are keyed by
`width × height`, also in first-seen order, each collecting the ids of the variants that have it. A
variant that lists the same position twice counts once, using the first placeholder, matching
#19's rule.

**Largest size.** The headline is the size with the greatest width, ties broken by the greater
height, so artwork that wide at `scale: 1` is never narrower than any variant's placeholder. When
only one size exists it is the headline and `sizes` is `undefined`. When sizes differ, `sizes`
lists every size, largest first by the same rule, then by first appearance.

**Numbers.** `aspect_ratio` is `Math.round((width / height) * 1000) / 1000`. A zero height, which
the schema allows, gives `undefined` rather than `Infinity`, so the JSON stays valid. Width and
height pass through as Printify sends them.

**Edge cases.** No variants gives `[]`. A variant with no placeholders contributes nothing and is
counted in no row. `variant_ids` stay in catalog order, the order `list_variants` shows, so the
two tools agree. The function never changes `variants`.

## `src/tools/catalog.ts`

### `get_print_areas`

- **Toolset** `catalog`, annotations `READ_ONLY`, no gate.
- **Input** `z.strictObject({ blueprint_id: blueprintId, print_provider_id: printProviderId })`,
  the two existing schemas. No filters, no stock flag, no paging: the response is already the
  compact form.
- **Handler** calls `ctx.catalog.variants(blueprint, provider, { showOutOfStock: false }, ctx.signal)`
  and returns:

<!-- prettier-ignore -->
```json
{
  "print_provider": { "id": 3, "title": "DJ" },
  "variant_count": 120,
  "option_values": { "color": ["Heather Grey", "Solid Black"], "size": ["XS", "S"] },
  "print_areas": [
    {
      "position": "front",
      "decoration_method": "dtg",
      "width_px": 4500, "height_px": 5100, "aspect_ratio": 0.882,
      "variant_count": 120,
      "sizes": [
        { "width_px": 4500, "height_px": 5100, "aspect_ratio": 0.882, "variant_count": 96, "variant_ids": [17390, 17391] },
        { "width_px": 3600, "height_px": 4800, "aspect_ratio": 0.75, "variant_count": 24, "variant_ids": [17426] }
      ]
    },
    { "position": "back", "decoration_method": "dtg", "width_px": 4500, "height_px": 5100, "aspect_ratio": 0.882, "variant_count": 120 }
  ]
}
```

`variant_count` at the top is the whole in-stock list, `option_values` is the exported helper,
`print_areas` is `summarisePrintAreas(list.variants)`. The registry's `dropNulls` removes the
undefined `sizes`, `decoration_method` and `aspect_ratio` keys, as it does for every tool. A
blueprint with nothing in stock returns `variant_count: 0`, `option_values: {}` and
`print_areas: []`.

- **Description:**

> Summarises where artwork can go on a blueprint from one print provider and how big it must be:
> each print position (front, back, sleeve …) with its decoration method, its printable size in
> pixels and its aspect ratio, aggregated over every variant in stock, plus the colors and sizes
> to choose variants from. Use it before create_product or create_product_from_image to size and
> place artwork; list_variants gives the same placeholders per variant. Placement: x and y run
> from 0 to 1 across the print area with 0.5/0.5 the centre; scale is the image width divided by
> the placeholder width, so 1 fills the width. Artwork at least width_px wide at scale 1 avoids
> the low-resolution error (code 8203). When a position's size differs between variants,
> width_px and height_px are the largest and sizes lists each size with its variant_ids, so
> print_areas can give each group its own placement.

- **Registration:** appended to `catalogTools` after `listVariantsTool`, so the drill-down order
  reads search, blueprint, providers, variants, print areas, shipping.
- **Errors:** nothing new. A Printify failure or an unparsable response propagates from
  `variants()` exactly as it does for `list_variants`, and the registry adds the hint.

### Cross-references

- `list_variants`'s description gains one sentence: "get_print_areas summarises the print
  positions and their sizes across all variants."
- `create_product_from_image`'s description (in `src/tools/workflows.ts`) gains one sentence after
  the blueprint and provider sentence: "get_print_areas shows the positions and their pixel sizes
  first." #11's `create_product` description already explains x, y and scale on the writing side
  and does not change.

## Testing

### `test/tools/print-areas.test.ts` (new)

Over the pure function, with variants built by a small local helper, no harness:

- Two variants with identical placeholders give one row per position, `variant_count: 2`, and no
  `sizes` property (`not.toHaveProperty('sizes')`, which gates on existence).
- Front `embroidery` and back `dtf` on the same variants give two rows in Printify's order, each
  with its method.
- The same position with two methods gives two rows.
- Two sizes for `front` give a headline of the larger width and a `sizes` list, largest first,
  each with its own `variant_count` and `variant_ids` in catalog order.
- A wider but shorter size wins the headline over a narrower, taller one; equal widths tie-break on
  height.
- `aspect_ratio` rounds to three decimals and is absent for a zero height.
- A variant listing `front` twice counts once, with the first placeholder.
- A variant without placeholders joins no row; an empty list gives an empty array.
- The input array and its variants are not mutated (deep-equal against a structured clone taken
  before the call).

### `test/tools/catalog-toolset.test.ts` (changed)

Through the harness, with the default `ALL_TOOLS`:

- Returns the provider, `variant_count`, `option_values` and the rows for `PRINT_AREA_VARIANTS` in
  the documented shape: `sizes` present on `front`, absent on `back`, and `left_sleeve` with a
  `variant_count` of 1.
- A `list_variants` call followed by `get_print_areas` for the same blueprint and provider sends
  exactly one upstream request (`api.expectRequest` on the variants path, once).
- A 404 from Printify propagates as an `http` error.
- An unknown input key is a `validation` error with no request sent.

The "offers six read-only tools" test filters by a fixed name list and needs no edit. The registry
lint over `ALL_TOOLS` passes a read-only, ungated, snake_case tool with a `strictObject` input as
written.

### `test/fixtures/catalog.ts` (changed)

Adds `PRINT_AREA_VARIANTS`, a provider response (`id: 3`, `title: 'DJ'`) of four variants:
`front` (`dtg`) is 4500 × 5100 on two and 3600 × 4800 on two, `back` (`dtg`) is 4500 × 5100 on all
four, and one variant adds `left_sleeve` (`dtg`) 1200 × 1200. The existing `VARIANTS` fixture and
its `variant()` helper stay as they are for the current tests.

### `.github/workflows/ci.yml` (changed)

`get_print_areas` joins the smoke-test name loop, after `list_variants`.

## Acceptance criteria mapping

| Criterion                                                         | Where                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Unit tests on a variants fixture with several positions and sizes | `test/tools/print-areas.test.ts` over the pure module; `PRINT_AREA_VARIANTS` through the harness |
| Aggregates placeholders into unique positions with size and ratio | `summarisePrintAreas`, one row per position and decoration method                                |
| Lists every distinct size per position where they differ          | The `sizes` list with `variant_ids` per size (decision 6)                                        |
| Summarises option values for variant selection                    | `option_values`, the exported helper from `list_variants`                                        |
| Short guide to x, y, scale and resolution                         | The tool description (decision 2) plus the per-position `width_px` the artwork needs at scale 1  |

## Out of scope

| Topic                                                         | Where                                                                                               |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A `show_out_of_stock` flag                                    | Not planned (decision 3); `list_variants` covers out-of-stock variants                              |
| Loosening the strict variant schema                           | Not planned here (decision 4); recorded in #8's follow-ups                                          |
| Sharing a grouping helper with `create_product_from_image`    | Not planned (decision 5); revisit if a third consumer appears                                       |
| Checking an uploaded image's pixel size against a placeholder | `create_product_from_image`'s resolution warning (#19)                                              |
| Stock per variant                                             | Not surfaced; `list_variants` with `show_out_of_stock` is the path                                  |
| Printify's actual minimum-resolution threshold                | Undocumented; the description's "at least width_px wide at scale 1" is the safe rule, not the limit |

## Delivery

Branch `feat/18-print-areas` off `origin/main` (a6106cb, which carries #11 and #19), in a worktree
at `../printify-mcp-worktrees/18-print-areas`, outside the repository because `eslint .` lints
`.claude/worktrees/`. Baseline 741 tests in 44 files. Test-driven, following the implementation
plan written next. PR closing #18.
