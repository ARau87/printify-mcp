# `create_product_from_image` — design

- **Issue:** [#19 create_product_from_image workflow tool](https://github.com/ARau87/printify-mcp/issues/19)
- **Date:** 2026-09-30
- **Status:** approved
- **Depends on:** #11 (products toolset) — the plan is written only after #11 has merged

## Goal

Creating a product by hand takes about seven dependent calls: upload the image, list variants,
filter by colour and size, read placeholder sizes, compute `x`/`y`/`scale`, build `print_areas`,
create the product. It is the most common request and the one an assistant most often gets wrong,
usually in the placement maths.

This issue adds one write tool, `create_product_from_image`, in the `workflows` toolset. It takes
images, a blueprint and provider, colour and size filters, a placement mode and a price, and does
the whole sequence in one call. It creates an unpublished draft and never publishes.

## Printify API facts this design relies on

Checked on 2026-09-30 against https://developers.printify.com/ (sections "Image positioning",
"Create a new product", "Common error cases").

- **Coordinates:** "Printify uses the [0,00; 0,00] .. [1,00; 1,00] cartesian coordinate system,
  with the placeholder center being x=0,5, y=0,5." `x` and `y` are the image centre as a fraction
  of the placeholder's width and height.
- **Scale:** "The scale of the image (width) relative to the print area placeholder (width)."
  `1` fills the placeholder's width; there is no upper bound.
- **Angle:** an integer, in degrees.
- **Variants on create:** "during product creation, only the variant id and price are
  necessary." Only the selected variants are sent.
- **`print_areas[].variant_ids`:** each print area applies to the variants it lists, so different
  variants can carry different placements.
- **Placeholder sizes** come from `GET /v1/catalog/blueprints/{b}/print_providers/{p}/variants.json`
  per variant (`placeholders[{ position, width, height }]`, in pixels) and can differ between
  variants of one blueprint, e.g. between sizes.
- **Mock-ups:** the product response's `images[]` carries `src`, `variant_ids`, `position` and
  `is_default`, one entry per variant group and camera position.
- **Error 8203** ("Image has low quality") is documented only by example. Printify does not
  publish its threshold, so the pre-flight resolution check below is a heuristic that catches the
  obvious cases, not a guarantee.

## Decisions that go beyond the issue

1. **Variants are grouped by placeholder size.** `x`, `y` and `scale` are fractions of the
   placeholder, so one placement does not fit two placeholders with different aspect ratios. Each
   distinct set of placeholder sizes becomes its own `print_areas` entry, with the placement
   computed for that size. The issue assumes a single placement.
2. **No `base64` image source.** It would put megabytes into one workflow call. The issue lists
   only `upload_id`, `url` and `file_path`; `upload_image` stays the way to upload base64.
3. **An unmatched `by_size` key is an error,** not ignored, so a typo or a size outside the filter
   cannot silently drop a price.
4. **Identical image sources are uploaded once,** e.g. the same `url` on `front` and `back`.
5. **Partial failure keeps the original error.** A rejected create keeps its `status`, `code` and
   `reason`, and the uploads that already happened travel next to it as a structured `uploaded`
   field (see Error handling), rather than being flattened into a `ToolError` message.
6. **Uploads are never archived on failure.** Archiving is destructive and would bypass the
   `PRINTIFY_ENABLE_DESTRUCTIVE` gate; the uploads are reusable instead.
7. **The pure modules live in `src/tools/`,** next to `blueprint-search.ts` and
   `shipping-profiles.ts`, not in a new `src/workflows/` directory.

## Files

New:

- `src/tools/placement.ts` — placement maths and the resolution check. Pure.
- `src/tools/variant-selection.ts` — filtering, position checks and grouping by placeholder size.
  Pure. #18 (`get_print_areas`) reuses the grouping.
- `src/tools/product-plan.ts` — builds the `variants[]` and `print_areas[]` payload. Pure.
- `src/tools/workflows.ts` — the tool, exporting `workflowsTools`.
- `test/tools/placement.test.ts`, `test/tools/variant-selection.test.ts`,
  `test/tools/product-plan.test.ts`, `test/tools/workflows.test.ts`.

Changed:

- `src/tools/index.ts` — `workflows: workflowsTools`.
- `src/tools/define.ts` — `PartialFailureError`.
- `src/tools/run.ts` — one branch in `errorFields` for `PartialFailureError`.
- `.github/workflows/ci.yml` — the smoke step asserts `create_product_from_image` by name.

Used unchanged: `resolveShopId` and `shopIdInput` (#7), `catalog.variants` (#8),
`resolveUploadSource`, `uploadImage` and `getUpload` (#10), and #11's `createProduct` with its
product response schema. The tool calls these library functions directly, not other tools, so it
works when only `workflows` is enabled; `file_path` still obeys `PRINTIFY_UPLOAD_DIRS`.

## Tool

### Annotations

`readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`. No gate: it creates a
draft, spends nothing and deletes nothing.

### Input

<!-- prettier-ignore -->
```ts
z.strictObject({
  ...shopIdInput,
  blueprint_id: z.number().int().positive(),
  print_provider_id: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string(),             // HTML allowed
  tags: z.array(z.string()).optional(),
  designs: z.array(design).min(1),     // positions unique, checked in the handler
  variants: z.strictObject({
    colors: z.array(z.string().min(1)).min(1).optional(),
    sizes: z.array(z.string().min(1)).min(1).optional(),
  }).optional(),
  price: z.union([
    cents,
    z.strictObject({ default: cents, by_size: z.record(z.string(), cents).optional() }),
  ]),
  strict: z.boolean().optional(),      // default false
})

cents = z.number().int().positive()   // e.g. 2499 for $24.99

design = z.strictObject({
  position: z.string().min(1),         // "front", "back", …
  image: z.strictObject({
    upload_id: z.string().min(1).optional(),
    url: z.string().optional(),
    file_path: z.string().optional(),
    file_name: z.string().optional(),
  }),                                  // exactly one of upload_id, url, file_path
  placement: placement.optional(),     // default { mode: "contain", align: "center" }
})

placement = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.enum(['contain', 'cover']), ...alignFields }),
  z.strictObject({ mode: z.literal('width'), width_pct: z.number().gt(0).max(100), ...alignFields }),
  z.strictObject({ mode: z.literal('custom'), x: z.number(), y: z.number(),
                   scale: z.number().positive(), angle: angle.optional() }),
])

alignFields = {
  align: z.enum(['center', 'top']).optional(),   // default "center"
  offset_y_pct: z.number().optional(),           // default 0; positive moves down
  angle: angle.optional(),                       // default 0
}

angle = z.number().int()
```

Every field carries a `.describe()` written for the model, as in the other toolsets.
`file_name` is only meaningful with `url` or `file_path`; with `upload_id` it is ignored.

### Semantics of the inputs

- **Colour and size filters** match case-insensitively and after trimming against each variant's
  `options.color` and `options.size`. An omitted filter keeps every value. The server does not
  parse ranges: the model expands "S–XL" into `["S", "M", "L", "XL"]`.
- **In stock only:** variants come from `catalog.variants(b, p, { showOutOfStock: false })`.
- **Price:** a number is the price of every selected variant. With the object form, a variant
  whose size matches a `by_size` key (case-insensitively) gets that price, every other variant
  gets `default`.
- **`offset_y_pct`** moves the artwork down by that percentage of the placeholder's height. It
  works with both alignments and may be negative.
- **`strict`:** when true, a design that fails the resolution check refuses the call instead of
  warning.

## Data flow

Everything the model can get wrong is checked before the first write.

1. **Shop:** `resolveShopId(input, ctx)`.
2. **Variants:** `ctx.catalog.variants(blueprint_id, print_provider_id, { showOutOfStock: false })`
   (cached for 1 h).
3. **Validate** (`variant-selection.ts`), each failure a `ToolError`:
   - a colour or size that matches no variant — the message lists the valid values;
   - a filter combination that selects no variant;
   - a duplicate `position` in `designs`;
   - a design position missing from any selected variant — the message names the positions the
     selected variants have;
   - a `by_size` key that matches none of the selected sizes.
4. **Resolve image sources**, still without writing:
   - `upload_id` → `getUpload` for the pixel size (a read);
   - `url` / `file_path` → `resolveUploadSource(input, ctx.config.uploadDirs)`, which checks
     "exactly one source", the allowlist and the size limits and may return a >5 MB warning;
   - designs with an identical source (same `upload_id`, same `url`, or same `file_path`) share
     one image.
5. **Upload** the not-yet-uploaded images one at a time with `uploadImage`, appending each to an
   `uploaded` list as it succeeds. These are the only side effects before the create.
6. **Group and place:** group the selected variants (below), compute each design's placement for
   each group (below), run the resolution check.
7. **Build** the payload (`product-plan.ts`): `variants` = the selected variants as
   `{ id, price, is_enabled: true }`; `print_areas` = one entry per group.
8. **Create** with #11's `createProduct`, then shape the output.

Steps 5–8 run inside a `try`; anything thrown there once `uploaded` is non-empty is re-thrown as
`PartialFailureError` (see Error handling).

## `src/tools/variant-selection.ts`

- `selectVariants(variants, filters)` returns the selected variants in catalog order or throws a
  `ToolError` as listed in step 3.
- `checkPositions(selected, positions)` throws when a position is missing.
- `groupByPlaceholders(selected, positions)` builds a signature per variant from the requested
  positions' sizes, in the order of `positions`, e.g. `front:3951x4919|back:3951x4919`, and
  returns `{ variantIds, placeholders: Map<position, { width, height }> }[]`. Groups are sorted by
  their lowest variant id; `variantIds` within a group are ascending.

A variant with two placeholders of the same position (not seen in the catalog, but the schema
allows it) uses the first.

## `src/tools/placement.ts`

Inputs: placeholder `pw × ph`, image `W × H`, the placement. Output: `{ x, y, scale, angle }`
rounded to 4 decimal places.

<!-- prettier-ignore -->
```text
fit          = (ph / pw) · (W / H)       // the scale at which image height equals placeholder height
contain:     scale = min(1, fit)
cover:       scale = max(1, fit)
width:       scale = width_pct / 100
custom:      x, y, scale, angle as given; no maths

height_frac  = scale · (pw / ph) · (H / W)   // image height as a fraction of placeholder height
x = 0.5
y = (align == "top" ? height_frac / 2 : 0.5) + offset_y_pct / 100
```

- `contain` never upscales past the placeholder's width and never overflows its height.
- `cover` deliberately overflows one dimension; Printify clips what falls outside.
- `top` puts the artwork's top edge at the top of the print area, before the offset.

**Resolution check** (`checkResolution`): the printed width in placeholder pixels is
`scale · pw`. When `W < scale · pw` it returns a message such as
`sunset.png is 2400 px wide but needs 3951 px on front (61%) for 12 variants`. The
tool collects one per design and group. Rounding happens after the check, so the boundary is
exact.

**Unknown pixel size:** `width` and `height` on an upload record are lenient and may be missing.
Then `contain`, `cover` and `width` throw a `ToolError` with the hint to pass
`placement: { mode: "custom", … }`; `custom` proceeds with the warning
`resolution of <file_name> could not be checked: Printify did not report its size`.

## `src/tools/product-plan.ts`

`buildProductPayload({ title, description, tags, blueprintId, printProviderId, selected, groups,
placements, price })` returns the body #11's `createProduct` expects:

<!-- prettier-ignore -->
```ts
{
  title, description, tags, blueprint_id, print_provider_id,
  variants: [{ id, price, is_enabled: true }],
  print_areas: [{
    variant_ids: [...],
    placeholders: [{ position, images: [{ id, x, y, scale, angle }] }],
  }],
}
```

`tags` is omitted when not given. The exact field names follow #11's input schema; if #11 names
something differently, #11 wins and this module adapts.

## Output

<!-- prettier-ignore -->
```text
{
  product_id, shop_id, title,
  enabled_variants: 20,
  print_area_groups: 2,
  images: [{ upload_id, file_name, width, height, positions: ["front"], reused: false }],
  mockups: [{ src, position, is_default }],   // at most 6
  mockup_count: 48,
  warnings: [...],                            // omitted when empty
  next_step: "…",
}
```

- **`images`** lists each distinct image once. `reused` is true for an `upload_id` input.
- **`mockups`** is capped at 6: the `is_default` images first, then the first image of each
  camera position not yet shown, in response order. `mockup_count` is the full count;
  `get_product` returns them all.
- **`warnings`** collects resolution warnings, the >5 MB upload warning from
  `resolveUploadSource`, and unknown-size warnings.
- **`next_step`** says the product is an unpublished draft whose mockups can be reviewed and
  changed with `update_product`. It does not name `publish_product`: reading `ALL_TOOLS` from
  `workflows.ts` would be an import cycle. A test fails once `publish_product` exists, so the
  publishing toolset (#12) updates this text.

## Error handling

- **Before the first upload:** failures are `ToolError`s (steps 3–4) or the `PrintifyApiError`
  of a failed read, and nothing needs cleaning up.
- **After the first upload:** anything thrown — a strict refusal, an unknown pixel size, a
  rejected create, a network error — is wrapped as
  `new PartialFailureError(cause, uploaded)`, where `uploaded` is
  `{ upload_id, file_name, positions }[]`.
- **`PartialFailureError`** (`src/tools/define.ts`) extends `Error` and holds `cause` and
  `uploaded`. `errorFields` in `run.ts` handles it by computing the fields of `cause` exactly as
  today and adding `uploaded`:

  <!-- prettier-ignore -->
  ```json
  { "error": { "kind": "api", "request": "POST /v1/shops/123/products.json", "status": 400,
               "code": 8203, "message": "Validation failed.", "reason": "Image has low quality",
               "uploaded": [{ "upload_id": "65f…", "file_name": "sunset.png", "positions": ["front"] }] } }
  ```

- **Cancellation:** `runTool` already re-throws when `ctx.signal` has aborted, so no report is
  built. Nothing new is needed.
- **The description** tells the model to retry with `image.upload_id` set from `uploaded`
  instead of uploading again.

## Tests

### `test/tools/placement.test.ts` (new)

- `contain`: portrait artwork on a portrait placeholder gives `scale < 1`, landscape artwork gives
  `scale = 1`; `x = 0.5`, `y = 0.5`.
- `cover`: `scale = max(1, fit)` for both orientations.
- `width`: `width_pct: 80` gives `scale = 0.8`.
- `top`: `y = height_frac / 2`; with `offset_y_pct: 5`, `y = height_frac / 2 + 0.05`; negative
  offset with `center`.
- `custom`: passed through unchanged, including `angle`.
- Rounding to 4 decimal places.
- Resolution boundary with a positive control: `W == scale · pw` gives no warning,
  `W == scale · pw − 1` warns with the exact message.

### `test/tools/variant-selection.test.ts` (new)

- Case-insensitive, trimmed matching of colours and sizes; an omitted filter keeps everything.
- An unknown colour: the error text lists the valid colours (asserted exactly).
- A missing position: the error names the available positions.
- Two placeholder sizes give two groups, sorted by lowest variant id, ids ascending.
- An unmatched `by_size` key is an error; a matching one with different case is not.

### `test/tools/product-plan.test.ts` (new)

- A single price applies to every variant; `by_size` overrides `default` for its size only.
- `print_areas` for two groups and two positions, asserted as the exact object.
- `tags` omitted when not given.

### `test/tools/workflows.test.ts` (new, harness)

Through the fake Printify API and a real MCP client:

- **Full sequence:** requests in order — GET variants, POST upload, POST product — and the exact
  product body, for a front-only design with colour and size filters and `by_size` pricing.
- **Dedup:** the same `url` on `front` and `back` makes exactly one upload request.
- **`upload_id`:** a GET of that upload and no POST upload.
- **Create rejected** (400 with code 8203): the error keeps `kind`, `status`, `code` and `reason`
  and carries `uploaded` with the upload's id.
- **Strict refusal:** carries `uploaded`; no product POST is recorded.
- **Validation before writes:** an unknown colour records zero upload requests. The same test
  first runs a valid call and asserts it recorded one upload, so the zero assertion can fail.
- **Output:** `mockups` capped at 6 from a fixture with more, `mockup_count` the full count,
  `warnings` absent when empty.
- **Filing:** the tool is in the `workflows` toolset and registered when `workflows` is enabled.

### CI smoke

`.github/workflows/ci.yml` asserts `create_product_from_image` in the tool list by name, like the
other toolsets.

## Acceptance criteria mapping

- **Unit tests for placement maths (contain / cover / width / top) and variant filtering:**
  `placement.test.ts`, `variant-selection.test.ts`.
- **Harness test covering the full call sequence:** `workflows.test.ts`, "Full sequence".
- **Failure midway reports which uploads already happened:** `PartialFailureError` and the
  "Create rejected" and "Strict refusal" harness tests.

## Out of scope

- **Publishing.** The tool never publishes; `next_step` points there.
- **A `dry_run` flag** returning the planned payload without writing. Add it if models turn out
  to need a preview.
- **Reading pixel sizes from local files before upload.** It would let `strict` refuse without
  uploading, at the cost of PNG/JPEG header parsing; the uploads are reported for reuse instead.
- **Archiving uploads after a failure** (see decision 6).
- **Size ranges** such as "S–XL" in the filter; the model expands them.
- **Patterns, backgrounds, `print_details`, shipping templates and other product fields.**
  `update_product` (#11) covers them after creation.

## Delivery

- Branch `feat/19-create-product-from-image`, worktree
  `../printify-mcp-worktrees/19-create-product-from-image`.
- The implementation plan is written after #11 has merged, and the branch is rebased onto `main`
  first, so the plan can cite #11's actual `createProduct` signature and product schema.
- Like every toolset branch, this one edits `src/tools/index.ts` and `ci.yml`; if #18 runs in
  parallel, whichever merges second resolves those lines keep-both.
- The PR body starts with `Closes #19`.
