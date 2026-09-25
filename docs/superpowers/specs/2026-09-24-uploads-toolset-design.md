# Uploads toolset — upload by URL, local file or base64 — design

- **Issue:** [#10 Uploads toolset — upload by URL, local file or base64](https://github.com/ARau87/printify-mcp/issues/10)
- **Date:** 2026-09-24
- **Status:** approved

## Goal

Artwork has to be in Printify's image library before a product can use it, and the API takes only a
public URL or base64 content. A print file is megabytes of base64, which an assistant cannot push
through a tool call — but this server runs on the user's machine, so it can read the file itself.
That convenience is also the risk: a server that reads whatever path a model names turns a
prompt-injected agent into a file-exfiltration tool. Local reads are therefore confined to
directories the user names in `PRINTIFY_UPLOAD_DIRS`, which #2 already validates.

This issue adds the four `uploads` tools, the resolver that enforces that boundary, and the request
layer that #19 (`create_product_from_image`) reuses without the MCP layer.

## Printify API facts this design relies on

Checked on 2026-09-24 against the HTML docs at https://developers.printify.com/#uploads and the
`openapi.json` linked from them. The two agree except where noted. All four endpoints are
account-scoped: no `shop_id` appears in any path.

- **The upload record** carries `id`, `file_name`, `height`, `width`, `size`, `mime_type`,
  `preview_url` and `upload_time`, every field read-only. `id` is documented as a string ("A unique
  string identifier for the image"), not a number. `height`, `width` and `size` are integers — pixels, pixels and
  bytes. `upload_time` looks like `"2020-01-09 07:29:43"`; the prose calls that "ISO date format",
  which the example contradicts, and `openapi.json` gives it no `format`, so it is treated as an
  opaque string. `openapi.json` marks **no** field as required.
- **`GET /v1/uploads.json`** documents exactly two query parameters, both optional: `limit`
  ("default: 10, maximum: 100") and `page`. It returns the Laravel envelope `fetchPage` already
  parses — `current_page`, `data`, `last_page`, `next_page_url`, `total` and the rest. **List items
  carry `preview_url`**, so trimming it is this server's choice, not the API's.
- **`GET /v1/uploads/{image_id}.json`** returns a bare record, with no envelope.
- **`POST /v1/uploads/images.json`** takes `oneOf` two JSON bodies: `{ file_name, url }` or
  `{ file_name, contents }`, where `contents` is "Base64-encoded image content". The property is
  `contents`, plural. **`file_name` is required in both variants.** No multipart form is
  documented. The response is one record.
- **The 5 MB note** sits in a highlighted box above that endpoint: "We highly recommend using
  upload via image URL for files larger than 5MB. Upload via image URL is the future-proof
  solution, as we plan to drop support for base64-encoded content uploads larger than 5MB in the
  future." That is a recommendation and an announcement of intent — not a limit Printify enforces
  today.
- **`POST /v1/uploads/{image_id}/archive.json`** documents no request body. The HTML example shows
  `{}`; `openapi.json` declares 200 with no content at all. The client returns `undefined` for an
  empty body and `{}` parses to an empty object, so the tool reads neither.
- **Errors.** Code **8201** is "Validation failed." for **both** a file that is too large and one in
  an unsupported format; the cause appears only inside `errors.reason`, as
  `Failed to upload image. Cause: {"code":"error.file.size.limit.exceeded"}` or
  `…{"code":"error.file.wrong.format"}`. Code **10300** is "Operation failed." with a cURL reason
  such as "Could not resolve host". All the documented examples are HTTP 400, and the docs add that
  "Exact error codes and messages are subject to change". The hint for 8201 in `hints.ts` already
  names both causes and points at `reason`, so it needs no change.
- **Scopes** are `uploads.read` ("See uploaded files in a Merchant's account") and `uploads.write`
  ("Upload image files and archive them"), which `scopeFor` already maps. No uploads-specific rate
  limit is documented; only the global 600 per minute applies, and `bucketsFor` already puts these
  paths in the `global` bucket alone.

**Not documented, and therefore not assumed:** any maximum file size (the error
`error.file.size.limit.exceeded` exists, but its threshold is never stated), any list of accepted
image formats, and any statement about how long a URL upload may take. The 25 MiB ceiling and the
`.png`/`.jpg`/`.jpeg` allowlist below are this server's own restrictions, chosen for the reasons in
the next section — not documented API behaviour.

## What this issue does not build

| Piece                                                | Where                        | Landed in |
| ---------------------------------------------------- | ---------------------------- | --------- |
| `PRINTIFY_UPLOAD_DIRS` → real paths, `[]` disables   | `src/config.ts`              | #2        |
| Hints for codes 8201 and 10300                       | `src/printify/hints.ts`      | #3        |
| `uploads.read` / `uploads.write` scope hint on a 403 | `src/printify/hints.ts`      | #3        |
| `fetchPage` and `PAGE_LIMITS.uploads = 100`          | `src/printify/pagination.ts` | #3        |
| `gate: 'destructive'` and its skip messages          | `src/tools/select.ts`        | #5        |
| `ToolError` → `{ kind: 'tool', message, hint }`      | `src/tools/run.ts`           | #5        |

Two consequences worth stating plainly. The HTTP client needs **no change**: it already sends JSON
bodies, and `RequestOptions.timeoutMs` already exists for this ("Overrides the client's default
timeout, e.g. for uploads by URL"). And `list_uploads` is the **first consumer of `fetchPage`**,
which has been tested but unused since #3.

Uploads are not shop-scoped, so no tool here uses `shopIdInput` or `resolveShopId`. Nothing in this
issue holds state, so `ToolServices` does not change and neither do `src/cli.ts`,
`test/support/harness.ts` or `test/tools/fixtures.ts`.

## Decisions that differ from the issue

1. **A hard ceiling of 25 MiB, above the 5 MiB warning.** The issue only warns. Reading a 200 MB
   file gives a ~270 MB base64 string that `JSON.stringify` then copies again, which can exhaust
   the heap and kill the stdio server — the model gets no error, the user loses the session. The
   size is read with `stat` _before_ anything is read into memory, so the refusal costs nothing.
   Between 5 MiB and 25 MiB the upload proceeds and the result carries `warning`, as the issue asks.
   Printify documents no maximum of its own, so this refuses nothing the API is known to accept —
   and a file that large belongs behind a `url` anyway, which is what the refusal says.
2. **`list_uploads` returns compact rows; `preview_url` only on request.** Every field of an upload
   record is short except `preview_url`. At `limit: 100` those URLs are most of the payload and the
   model usually only needs an id, so they sit behind `include_previews`, mirroring
   `include_images` on `get_blueprint`. `get_upload` always returns the full record.
3. **"Exactly one source" is enforced in the handler, not in the schema.** A `.refine()` failure is
   reported by the SDK before the handler runs, bypassing `errorFields` in `src/tools/run.ts`, so
   the model would lose the `{ kind, message, hint }` envelope every other refusal has. It would
   also risk `toolProblems` in `src/tools/check.ts`, which runs `z.toJSONSchema(input)` over every
   tool input and fails a schema it cannot convert. For the same reason the input schema uses no
   `.transform()`: normalising a `data:` prefix or stray whitespace belongs in the resolver.
4. **`upload_image` raises its timeout to 120 s.** The 30 s default is for a JSON request; 25 MiB of
   base64 is ~33 MB of JSON, and a URL upload waits for Printify to fetch the URL itself.
5. **The refusal names the allowed directories; the description does not.** `ALL_TOOLS` is built at
   module load and only _selection_ sees the configuration, so a description cannot list the user's
   directories without making descriptions config-dependent — a change to `defineTool` and the
   registry that #11–#19 would all inherit, for one parameter. A refused path is cheap and
   self-correcting: the error lists the directories, or explains how to switch local uploads on.
6. **The extension is checked on the resolved real path.** Checking the path as written would let
   `art.png`, a symlink to `secret.txt`, through. The issue describes `.png`, `.jpg` and `.jpeg` as
   "the only types the docs list", but the docs in fact list none (see the facts above) — so this
   allowlist is not a guess at what Printify accepts. It is a rule about **what this server reads
   off the user's disk**, which is why it applies only to `file_path`. A `url` or `base64` upload
   is left to Printify, whose 8201 already has a hint naming both possible causes.
7. **An empty file is refused** before the request, rather than spending an upload on a guaranteed 8201.

## Files

<!-- prettier-ignore -->
```
src/printify/
  uploads.ts                # new: the record schema and the four requests
  errors.ts                 # invalidResponseError gains 'an unexpected uploads response'
src/tools/
  upload-source.ts          # new: url | file_path | base64 -> a request body, or a ToolError
  uploads.ts                # new: the four tools and uploadsTools
  index.ts                  # uploads: uploadsTools
src/config.ts               # exports the existing expandHome, for file_path's leading ~
test/printify/
  uploads.test.ts           # new: requests and lenient parsing
test/tools/
  upload-source.test.ts     # new: the security boundary, over real temp dirs and symlinks
  uploads.test.ts           # new: the four tools through the harness
test/fixtures/
  uploads.ts                # new: the documented examples and builders
docs/superpowers/specs/
  2026-09-24-uploads-toolset-design.md
```

No new dependencies. Three existing source files change, by one line each: `src/tools/index.ts`
files the toolset, `src/printify/errors.ts` gains a literal in `invalidResponseError`'s `problem`
union, and `src/config.ts` exports the `expandHome` it already has, so `file_path` expands a
leading `~` by the same rule as `PRINTIFY_UPLOAD_DIRS` rather than a second copy of it. `config.ts`
also switches `resolveUploadDir` to `realpathSync.native`, so the directories it stores carry the
same on-disk case the resolver's native `realpath` also returns; on a case-insensitive macOS volume
the JS `realpathSync` keeps the typed case, and every upload would be refused.

`src/printify/uploads.ts` sits next to `pagination.ts` and `shops.ts`: it requests, validates and
returns typed records, and knows nothing about tools. Unlike `createCatalog` and
`createShopDirectory` it is **not a factory** — those exist to hold a cache, and uploads have none,
so a factory would imply state that is not there.

`src/tools/upload-source.ts` is the security boundary, and follows `src/tools/shop-id.ts`: a
tools-layer helper that throws `ToolError` and has its own unit test, so every refusal can be
proven without the MCP harness.

## `src/printify/uploads.ts`

### The record

<!-- prettier-ignore -->
```ts
export interface Upload {
  id: string;
  file_name: string;
  width: number | undefined;
  height: number | undefined;
  size: number | undefined;
  mime_type: string | undefined;
  preview_url: string | undefined;
  upload_time: string | undefined;
}
```

`openapi.json` marks no field as required, so the schema takes the loosest position that still
leaves a usable answer: `id` and `file_name` are required, everything else is
`.optional().catch(undefined)`. A missing `width` must not turn an upload that actually succeeded
into an error, and the model can still act on the id. A body that is not an object, or that lacks
`id`, is an `invalid_response` error through `invalidResponseError`, the way `fetchPage` and
`catalog.ts` already report a broken shape.

### Requests

| Function                                       | Request                                           |
| ---------------------------------------------- | ------------------------------------------------- |
| `uploadImage(client, body, signal)`            | `POST /v1/uploads/images.json`, `timeoutMs` 120 s |
| `listUploads(client, { page, limit }, signal)` | `fetchPage(client, 'uploads', …)`                 |
| `getUpload(client, imageId, signal)`           | `GET /v1/uploads/{image_id}.json`                 |
| `archiveUpload(client, imageId, signal)`       | `POST /v1/uploads/{image_id}/archive.json`        |

`body` is the resolver's output, so this module never touches the filesystem. Paths are built with
`apiPath`, which URL-encodes the image id and rejects `""`, `"."` and `".."`. `UPLOAD_TIMEOUT_MS`
(120 s) lives here rather than in the resolver, next to the request that passes it.

`listUploads` parses each item with the same schema and returns
`{ uploads, page, has_more, total, last_page }` from the `Page` `fetchPage` returns. `limit` above
100 is lowered by `PAGE_LIMITS`, so a request never fails on it.

## `src/tools/upload-source.ts`

<!-- prettier-ignore -->
```ts
export const WARN_BYTES = 5 * 1024 * 1024;   // 5 MiB: warn, still upload
export const MAX_BYTES = 25 * 1024 * 1024;   // 25 MiB: refuse before reading
export const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

export interface ResolvedSource {
  body: { file_name: string; url: string } | { file_name: string; contents: string };
  warning: string | undefined;
}

export async function resolveUploadSource(
  input: { url?: string; file_path?: string; base64?: string; file_name?: string },
  uploadDirs: readonly string[],
): Promise<ResolvedSource>;
```

First it counts the sources. Zero or more than one is a `ToolError` naming what was given: "Give
exactly one of url, file_path or base64; got url and base64." `file_name`, wherever it comes from,
is reduced to its basename before it is sent, so a name like `../x.png` cannot travel.

### `file_path`

Each step is its own `ToolError`, in this order:

| #   | Check                                                   | Refusal                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `uploadDirs` is not empty                               | local uploads are off, how to switch them on, and that `url` still works                                                                                                                                                                                                |
| 2   | `~` expanded, then absolute                             | "must be an absolute path"                                                                                                                                                                                                                                              |
| 3   | `fs.realpath` succeeds                                  | "does not exist", or "cannot be read (EACCES)"; when `realpath` fails, the path is first resolved lexically, and one that does not fall under an allowed directory gets the step 4 refusal instead, so a model cannot probe whether a file outside the allowlist exists |
| 4   | the real path is, or is under, one of `uploadDirs`      | names the allowed directories                                                                                                                                                                                                                                           |
| 5   | the real path's extension, lowercased, is allowed       | names `.png`, `.jpg`, `.jpeg`                                                                                                                                                                                                                                           |
| 6   | `stat`: a regular file, not empty, `size` ≤ `MAX_BYTES` | the file's size and "pass `url` instead"                                                                                                                                                                                                                                |

Step 2 expands `~` exactly as `PRINTIFY_UPLOAD_DIRS` does, since a model that saw the path in chat
will pass it as the user wrote it. Step 4 compares against the real path, and `uploadDirs` are
themselves real paths from #2, so a symlink cannot escape; the comparison is an exact match or a
match followed by `path.sep`, so `/Users/me/Designs-private` is not inside `/Users/me/Designs`.

Then the file is read and base64-encoded, and `warning` is set when the size is over `WARN_BYTES`.
The same sentence serves a large `base64` argument, so it names the `file_name` and the size rather
than the path:

> `poster.png` is 9.0 MB. Printify recommends uploading files over 5 MB by image URL rather than
> base64, and plans to stop accepting base64 uploads that large. Pass `url` instead when the file is
> reachable on the web.

**Accepted risk:** `realpath` → `stat` → `read` is not atomic, so someone who can swap files inside
an allowed directory between the calls could redirect the read. They already have access to the
files in that directory, and this is a single-user local server, so the added complexity of holding
one file handle across all three checks is not worth it.

### `base64`

`file_name` is required — there is nothing to derive one from — and refused with a `ToolError` that
says so. A `data:image/png;base64,` prefix is stripped, as is whitespace, since both are easy for a
model to include. What remains must be a valid base64 string; anything else is a `ToolError` rather
than a wasted request. The decoded size is computed from the string's length **before** decoding
and follows the same two thresholds, so the 25 MiB ceiling protects the heap here too.

### `url`

Must parse and use `http:` or `https:`; a `file:` or `data:` URL is a `ToolError`. Printify requires
`file_name` in this variant too, so it is the URL's last path segment, decoded, when the model did
not pass one; a URL with no usable last segment is a `ToolError` asking for `file_name`, rather than
a 400 from Printify. There is no size to check, so `warning` stays `undefined` — this is the path
the warning recommends.

## Tools

`src/tools/uploads.ts` exports the four tools and
`uploadsTools = [uploadImageTool, listUploadsTool, getUploadTool, archiveUploadTool]`, and
`src/tools/index.ts` replaces `uploads: []` with `uploads: uploadsTools`.

### `upload_image`

| Field       | Value                                                                               |
| ----------- | ----------------------------------------------------------------------------------- |
| Input       | `url`, `file_path`, `base64`, `file_name`, all optional strings; exactly one source |
| Annotations | `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`            |
| Requests    | `POST /v1/uploads/images.json`                                                      |
| Output      | `{ id, file_name, width, height, size, mime_type, preview_url, warning? }`          |

`idempotentHint: false` is the honest answer: the same file uploaded twice becomes two library
entries. `dropNulls` in the registry removes `warning` when it is `undefined`, so an ordinary
upload's result stays clean.

> Uploads an image to the Printify image library, so a product can print it. Give exactly one of
> `url` (a publicly reachable image URL — the best choice for anything large, since Printify
> downloads it itself), `file_path` (a file on the user's machine, which works only inside the
> directories the user allowed; if it is refused, the error names them) or `base64` (the image
> bytes, base64-encoded — only for small images). Returns the image id that products refer to, and
> the pixel size. The same file uploaded twice becomes two library entries, so prefer an id from
> `list_uploads` over uploading again.

### `list_uploads`

| Field       | Value                                                         |
| ----------- | ------------------------------------------------------------- |
| Input       | `page`, `limit` (1–100), `include_previews` (default `false`) |
| Annotations | read-only                                                     |
| Requests    | `GET /v1/uploads.json`                                        |
| Output      | `{ uploads, page, has_more, total?, last_page? }`             |

> Lists the images already in the Printify image library, with the id, file name, pixel size, byte
> size and type of each. Use it to find an image the user uploaded earlier instead of uploading it
> again. `include_previews` adds each image's preview URL; leave it off unless the user wants to
> see the images, because those URLs are long.

### `get_upload`

| Field       | Value                                   |
| ----------- | --------------------------------------- |
| Input       | `image_id`, a non-empty string          |
| Annotations | read-only                               |
| Requests    | `GET /v1/uploads/{image_id}.json`       |
| Output      | the full record, `preview_url` included |

> Gets one uploaded image by its id: file name, pixel size, byte size, type and preview URL. Use it
> when you have an image id and need its size — for example to check that the artwork is large
> enough for a print area.

### `archive_upload`

| Field       | Value                                                                  |
| ----------- | ---------------------------------------------------------------------- |
| Input       | `image_id`, a non-empty string                                         |
| Gate        | `destructive`                                                          |
| Annotations | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` |
| Requests    | `POST /v1/uploads/{image_id}/archive.json`                             |
| Output      | `{ image_id, archived: true }`                                         |

> Archives an image, removing it from the Printify image library. There is no unarchive endpoint,
> so this cannot be undone here. Confirm the image with the user first, for example its file name
> from `get_upload`. If the call times out, check with `get_upload` before calling it again rather
> than assuming nothing happened.

`image_id` is a string, not a number. The id is the only input, so nothing about the model's
arguments can widen the blast radius beyond the one image.

## Error handling

- A `PrintifyApiError` propagates; the registry turns it into an `isError` result with its hint.
  Code 8201 (rejected file) and 10300 (unfetchable URL) already have hints from #3, as does a 403
  with the `uploads.read`/`uploads.write` scope.
- Every refusal the resolver makes is a `ToolError`, so the model sees
  `{ kind: 'tool', message, hint }` with an action it can take: move the file, ask the user to
  extend `PRINTIFY_UPLOAD_DIRS`, or pass `url`.
- A malformed response is an `invalid_response` error.
- `ctx.signal` goes into every request, so a cancelled tool call aborts its upload.
- A file path appears in refusal messages but is never sent to Printify, and the base64 contents are
  never logged: `run.ts` logs only a `PrintifyApiError`'s one-line message.

## Tests

Test-first. None needs the network or a Printify account. CI runs on `ubuntu-latest` only, so the
symlink tests need no platform guard.

### `test/tools/upload-source.test.ts`

Unit tests over real temporary directories created per test with `fs.mkdtemp`, and real symlinks —
the check is about the filesystem, so faking it would prove nothing.

- accepts a file directly inside an allowed directory, and one in a subdirectory
- refuses a path outside every allowed directory, and names the directories in the message
- refuses a symlink inside an allowed directory that points outside it
- refuses `art.png` when it is a symlink to a `.txt` file (the extension is checked after `realpath`)
- refuses `/Users/me/Designs-private/x.png` when `/Users/me/Designs` is allowed (prefix, not parent)
- refuses every extension but `.png`, `.jpg`, `.jpeg`, and accepts `.PNG`
- refuses when `uploadDirs` is empty, with the message that explains how to switch local uploads on
- refuses a relative path, a missing file, a directory, and an empty file
- expands a leading `~`
- warns between 5 MiB and 25 MiB, refuses above 25 MiB, and is silent below 5 MiB
- `base64`: strips a `data:` prefix and whitespace, refuses a non-base64 string, refuses without
  `file_name`, applies both size thresholds
- `url`: derives `file_name` from the last path segment, refuses `file:` and `data:`, refuses a URL
  with no usable segment and no `file_name`
- refuses zero sources, and two or three, naming what was given
- reduces a `file_name` of `../evil.png` to `evil.png`

### `test/printify/uploads.test.ts`

- each of the four requests uses the documented method and path, and `archiveUpload` succeeds
  against both documented archive responses: `{}` and an empty body
- `uploadImage` sends the resolver's body unchanged and uses the 120 s timeout
- a record missing `width` still parses; one missing `id` is an `invalid_response` error
- `listUploads` maps `fetchPage`'s envelope, and a `limit` over 100 is lowered

### `test/tools/uploads.test.ts`

Through `createTestServer` with the default `ALL_TOOLS`, so a tool that was never wired into
`TOOLS_BY_TOOLSET` fails here.

- `upload_image` by `url`, by `base64`, and by `file_path` with `config: { uploadDirs: [tmp] }`
- the result carries `id`, `width` and `height`, and `warning` only over 5 MiB
- a refused path comes back as `isError` with `kind: 'tool'` and no request sent
- code 10300 on a `url` upload and 8201 on a `base64` upload reach the model with their hints
- `list_uploads` paginates, rejects a `limit` above 100 at the schema (`PAGE_LIMITS.uploads` as
  `.max()`, the convention `pagination.ts` states), and omits `preview_url` unless
  `include_previews`
- `get_upload` returns `preview_url`
- `archive_upload` is absent by default and present with `PRINTIFY_ENABLE_DESTRUCTIVE=true`, and
  the skip line and server instructions name it

### `test/fixtures/uploads.ts`

The documented upload record, a builder for overrides, and a paginated envelope of them.

## Acceptance criteria mapping

| Criterion (issue #10)                                                       | Covered by                                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Tests for each source type                                                  | `test/tools/uploads.test.ts`, one case per source                      |
| Tests for outside allowed dirs, symlink escape, wrong extension, unset list | `test/tools/upload-source.test.ts`, over real directories and symlinks |
| Tests for error hints on codes 10300 and 8201                               | `test/tools/uploads.test.ts`                                           |

The issue's other requirements:

| Requirement                                                      | Covered by                                        |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| Four tools, toolset `uploads`, `archive_upload` gated            | `src/tools/uploads.ts`, the rule check            |
| Exactly one of `url`, `file_path`, `base64`, plus `file_name`    | `resolveUploadSource`, decision 3                 |
| `realpath` inside `PRINTIFY_UPLOAD_DIRS`, symlinks cannot escape | `resolveUploadSource` step 4                      |
| Unset variable refuses local uploads and explains how to enable  | `resolveUploadSource` step 1                      |
| Only `.png`, `.jpg`, `.jpeg`                                     | step 5, on the real path (decision 6)             |
| Over 5 MB is still sent, with a warning                          | `WARN_BYTES` and `warning`, plus decision 1's cap |
| Result carries id, file_name, width, height, size, mime, preview | `upload_image`'s output                           |
| `list_uploads` takes page and limit ≤ 100                        | `PAGE_LIMITS.uploads`                             |

## Out of scope

| Topic                                             | Where                                  |
| ------------------------------------------------- | -------------------------------------- |
| Checking artwork resolution against a print area  | #19, using `width`/`height` from here  |
| Using an uploaded id in `print_areas`             | #11                                    |
| `create_product_from_image` over `uploadImage()`  | #19                                    |
| Unarchiving                                       | Printify has no endpoint               |
| Multipart uploads                                 | Printify takes JSON only               |
| Any change to `PRINTIFY_UPLOAD_DIRS`              | #2 landed it                           |
| Resizing, converting or inspecting image bytes    | Not planned; Printify reports the size |
| Streaming or chunked uploads for very large files | Not planned; `url` is the answer       |

## Delivery

1. Branch `feat/10-uploads-toolset` from `origin/main` (94e8c6f, which carries #8), in its own
   worktree at `../printify-mcp-worktrees/feat-10-uploads-toolset`, outside the repository so the
   main checkout's `eslint .` does not lint it. This spec is its first commit.
2. Implementation plan via the writing-plans skill.
3. Test-first implementation.
4. Local verification before any claim of success: `npm ci`, `npm run lint`, `npm run typecheck`,
   `npm test` and `npm run build`.
5. PR starting with `Closes #10`, moved to In review on the project board. Watch its CI run on
   Node 22 and 24.
6. Hand-off comments:
   - #19: `uploadImage()` in `src/printify/uploads.ts` takes a resolved body and returns the record
     with `width` and `height`; `resolveUploadSource` already turns a model's `url`/`file_path`/
     `base64` into that body, allowlist included.
   - #11: an uploaded id from `upload_image` is what `print_areas` refers to; `get_upload` gives the
     pixel size to check it against a placeholder.
