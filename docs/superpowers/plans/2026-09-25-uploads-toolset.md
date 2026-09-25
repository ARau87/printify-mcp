# Uploads toolset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the four `uploads` tools — upload an image by URL, local file or base64, list them, get one, archive one — with local reads confined to the directories the user allowed.

**Architecture:** Three new modules in a straight line. `src/printify/uploads.ts` owns the API shape: the record schema and the four requests, no filesystem and no MCP. `src/tools/upload-source.ts` is the security boundary: it turns the model's `url`, `file_path` or `base64` into the documented request body, or throws a `ToolError` that tells the model what to do instead. `src/tools/uploads.ts` holds the four tool definitions and does nothing but call those two.

**Tech Stack:** TypeScript ~6.0 (NodeNext, `strict`, `noUncheckedIndexedAccess`), zod 4, MCP TypeScript SDK v2 (`@modelcontextprotocol/server`), vitest 5, Node >= 22.

**Spec:** `docs/superpowers/specs/2026-09-24-uploads-toolset-design.md`

## Global Constraints

- **Test-first.** Write the failing test, run it, watch it fail for the right reason, then implement.
- **Every commit message ends with this trailer, exactly:**
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Verification before any claim of success:** `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`. `npm run lint` is `eslint . && prettier --check .`, so run `npx prettier --write src test docs` before committing.
- **Base branch:** `feat/10-uploads-toolset`, in the worktree `../printify-mcp-worktrees/feat-10-uploads-toolset`. Run every command there. Never `git checkout` in the main checkout: a parallel session works on #9 there.
- **Imports carry the `.js` extension** (`../printify/uploads.js`), and Node built-ins carry the `node:` prefix (`node:fs/promises`). NodeNext resolution requires both.
- **No new dependencies.**
- **Tool input schemas are plain `z.strictObject`s: no `.refine()`, no `.transform()`, no `.superRefine()`.** `toolProblems` in `src/tools/check.ts` runs `z.toJSONSchema(input, { io: 'input' })` over every tool input and fails a schema it cannot convert. Semantic rules — "exactly one source", stripping a `data:` prefix — belong in `resolveUploadSource`, which throws a `ToolError` the registry renders with a hint.
- **Response schemas may use `.transform()`,** and lenient fields use the idiom already in `src/printify/catalog.ts`: `schema.nullable().catch(null).transform((value) => value ?? undefined).optional()`. In zod 4 a key declared without `.optional()` is required, so a field Printify may omit must carry it.
- **Tools return plain objects, never arrays.** The registry drops `null` and `undefined` properties and serialises the rest, so an absent optional field is simply `undefined`.
- **Interfaces declare function-typed properties, never methods** (`get: (key: string) => V | undefined`). A method trips `@typescript-eslint/unbound-method` when a caller destructures it.
- **No `_`-prefixed escape for unused variables.** The ESLint config has no `argsIgnorePattern`; write the code so nothing is unused.
- **Never add a fake-API route key with a query string.** `createFakeApi` matches on the pathname only; a key with `?` is accepted and then never matches. A route that must vary by query is a function reading `request.query`.
- **Routes must not answer 429 or 5xx** unless the test is about retries: the client retries those on real timers.
- **Two existing files change, both by one line.** The spec's Files section says only `src/tools/index.ts` changes; that was written before the implementation details were nailed down and is corrected here. `src/printify/errors.ts` needs a new literal in the `problem` union (Task 1), and `src/config.ts` must export its existing `expandHome` (Task 2). Both are additive.

---

### Task 1: The uploads request layer

**Files:**

- Create: `src/printify/uploads.ts`
- Create: `test/fixtures/uploads.ts`
- Create: `test/printify/uploads.test.ts`
- Modify: `src/printify/errors.ts` (one literal added to the `problem` union in `invalidResponseError`)

**Interfaces:**

- Consumes: `PrintifyClient` from `src/printify/client.js`, `fetchPage` and `PAGE_LIMITS` from `src/printify/pagination.js`, `apiPath` from `src/printify/path.js`, `invalidResponseError` and `Route` from `src/printify/errors.js`.
- Produces, all used by Tasks 4–6:
  - `interface Upload { id: string; file_name: string; width?: number; height?: number; size?: number; mime_type?: string; preview_url?: string; upload_time?: string }`
  - `type UploadBody = { file_name: string; url: string } | { file_name: string; contents: string }` (Task 2 produces values of this type)
  - `interface UploadPage { uploads: Upload[]; page: number; hasMore: boolean; total: number | undefined; lastPage: number | undefined }`
  - `UPLOAD_TIMEOUT_MS: 120_000`
  - `uploadImage(client: PrintifyClient, body: UploadBody, signal: AbortSignal): Promise<Upload>`
  - `listUploads(client: PrintifyClient, options: { page?: number; limit?: number }, signal: AbortSignal): Promise<UploadPage>`
  - `getUpload(client: PrintifyClient, imageId: string, signal: AbortSignal): Promise<Upload>`
  - `archiveUpload(client: PrintifyClient, imageId: string, signal: AbortSignal): Promise<void>`

- [ ] **Step 1: Write the fixtures**

Create `test/fixtures/uploads.ts`. Both records are the documented examples, copied field for field.

<!-- prettier-ignore -->
```ts
/** The documented `POST /v1/uploads/images.json` response. */
export const UPLOAD = {
  id: '5941187eb8e7e37b3f0e62e5',
  file_name: 'image.png',
  height: 200,
  width: 400,
  size: 1021,
  mime_type: 'image/png',
  preview_url: 'https://example.com/image-storage/uuid3',
  upload_time: '2020-01-09 07:29:43',
};

/** The first documented `GET /v1/uploads.json` item. */
export const UPLOAD_LISTED = {
  id: '5e16d66791287a0006e522b2',
  file_name: 'png-images-logo-1.jpg',
  height: 5979,
  width: 17045,
  size: 1138575,
  mime_type: 'image/png',
  preview_url: 'https://example.com/image-storage/uuid1',
  upload_time: '2020-01-09 07:29:43',
};

export function upload(overrides: Partial<typeof UPLOAD> = {}): typeof UPLOAD {
  return { ...UPLOAD, ...overrides };
}

/** The documented paginated envelope, around `items`. */
export function uploadsPage(
  items: readonly object[] = [UPLOAD_LISTED],
  overrides: { current_page?: number; last_page?: number; total?: number } = {},
): object {
  const { current_page = 1, last_page = 1, total = items.length } = overrides;
  return {
    current_page,
    data: items,
    first_page_url: '/?page=1',
    from: 1,
    last_page,
    last_page_url: `/?page=${String(last_page)}`,
    next_page_url: current_page < last_page ? `/?page=${String(current_page + 1)}` : null,
    path: '/',
    per_page: 10,
    prev_page_url: null,
    to: items.length,
    total,
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `test/printify/uploads.test.ts`.

<!-- prettier-ignore -->
```ts
import { describe, expect, it, vi } from 'vitest';
import { createPrintifyClient, type PrintifyClient } from '../../src/printify/client.js';
import {
  archiveUpload,
  getUpload,
  listUploads,
  uploadImage,
  UPLOAD_TIMEOUT_MS,
} from '../../src/printify/uploads.js';
import { Secret } from '../../src/secret.js';
import { UPLOAD, UPLOAD_LISTED, uploadsPage } from '../fixtures/uploads.js';
import { createFakeApi, json, text, type FakeApi, type Routes } from '../support/fake-api.js';
import { apiError } from './helpers.js';

const TOKEN = 'Tok-uploads-2B3c4D5e';
const IMAGE_ID = UPLOAD.id;
const ARCHIVE_PATH = `/v1/uploads/${IMAGE_ID}/archive.json`;
const GET_PATH = `/v1/uploads/${IMAGE_ID}.json`;
const CONTENTS = { file_name: 'image.png', contents: 'aGk=' };

function testClient(routes: Routes = {}): { client: PrintifyClient; api: FakeApi } {
  const api = createFakeApi(routes);
  const client = createPrintifyClient({
    token: new Secret(TOKEN),
    baseUrl: 'https://api.printify.com',
    fetch: api.fetch,
  });
  return { client, api };
}

/** A signal that has not aborted. */
function live(): AbortSignal {
  return new AbortController().signal;
}

describe('uploadImage', () => {
  it('posts the body and returns the record', async () => {
    const { client, api } = testClient({ 'POST /v1/uploads/images.json': UPLOAD });
    expect(await uploadImage(client, CONTENTS, live())).toEqual(UPLOAD);
    api.expectRequest('POST', '/v1/uploads/images.json', CONTENTS);
  });

  it('gives an upload longer than the default timeout, for a large body', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { client } = testClient({ 'POST /v1/uploads/images.json': UPLOAD });
    await uploadImage(client, CONTENTS, live());
    expect(UPLOAD_TIMEOUT_MS).toBe(120_000);
    expect(timeout).toHaveBeenCalledWith(UPLOAD_TIMEOUT_MS);
  });

  it('keeps a record whose optional fields are missing or the wrong type', async () => {
    const { client } = testClient({
      'POST /v1/uploads/images.json': { id: 'abc', file_name: 'a.png', width: 'wide' },
    });
    expect(await uploadImage(client, CONTENTS, live())).toEqual({ id: 'abc', file_name: 'a.png' });
  });

  it('reports a response that is not an upload record', async () => {
    const { client } = testClient({ 'POST /v1/uploads/images.json': { file_name: 'image.png' } });
    const error = await apiError(uploadImage(client, CONTENTS, live()));
    expect(error.kind).toBe('invalid_response');
    expect(error.message).toContain('an unexpected uploads response');
  });
});

describe('getUpload', () => {
  it('gets one record by id', async () => {
    const { client, api } = testClient({ [`GET ${GET_PATH}`]: UPLOAD });
    expect(await getUpload(client, IMAGE_ID, live())).toEqual(UPLOAD);
    api.expectRequest('GET', GET_PATH);
  });
});

describe('archiveUpload', () => {
  it('posts to the archive path and accepts the documented empty object', async () => {
    const { client, api } = testClient({ [`POST ${ARCHIVE_PATH}`]: json({}) });
    await expect(archiveUpload(client, IMAGE_ID, live())).resolves.toBeUndefined();
    api.expectRequest('POST', ARCHIVE_PATH);
  });

  it('accepts a wholly empty body, which openapi.json declares instead', async () => {
    const { client } = testClient({ [`POST ${ARCHIVE_PATH}`]: text('', 200) });
    await expect(archiveUpload(client, IMAGE_ID, live())).resolves.toBeUndefined();
  });
});

describe('listUploads', () => {
  it('returns the page and its records', async () => {
    const { client, api } = testClient({ 'GET /v1/uploads.json': uploadsPage([UPLOAD_LISTED]) });
    expect(await listUploads(client, { page: 1, limit: 10 }, live())).toEqual({
      uploads: [UPLOAD_LISTED],
      page: 1,
      hasMore: false,
      total: 1,
      lastPage: 1,
    });
    expect(api.expectRequest('GET', '/v1/uploads.json').query).toEqual({ page: '1', limit: '10' });
  });

  it('reports more pages to come', async () => {
    const { client } = testClient({
      'GET /v1/uploads.json': uploadsPage([UPLOAD_LISTED], { last_page: 3, total: 21 }),
    });
    const page = await listUploads(client, {}, live());
    expect(page).toMatchObject({ hasMore: true, lastPage: 3, total: 21 });
  });

  it('lowers a limit above the documented maximum of 100', async () => {
    const { client, api } = testClient({ 'GET /v1/uploads.json': uploadsPage() });
    await listUploads(client, { limit: 500 }, live());
    expect(api.expectRequest('GET', '/v1/uploads.json').query).toEqual({ limit: '100' });
  });

  it('reports a record in the page that is not an upload', async () => {
    const { client } = testClient({ 'GET /v1/uploads.json': uploadsPage([{ file_name: 'a.png' }]) });
    const error = await apiError(listUploads(client, {}, live()));
    expect(error.kind).toBe('invalid_response');
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run test/printify/uploads.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/printify/uploads.js"`.

- [ ] **Step 4: Add the new problem literal**

In `src/printify/errors.ts`, add one member to the `problem` union of `invalidResponseError`:

<!-- prettier-ignore -->
```ts
  problem:
    | 'a body that is not JSON'
    | 'an unexpected pagination envelope'
    | 'an unexpected shop list'
    | 'an unexpected catalog response'
    | 'an unexpected uploads response',
```

- [ ] **Step 5: Write the implementation**

Create `src/printify/uploads.ts`.

<!-- prettier-ignore -->
```ts
import { z } from 'zod';
import type { PrintifyClient } from './client.js';
import { invalidResponseError, type Route } from './errors.js';
import { fetchPage } from './pagination.js';
import { apiPath } from './path.js';

/**
 * Uploads get longer than the client's 30 s default: 25 MiB of base64 is ~33 MB of JSON to send,
 * and an upload by URL waits for Printify to download the URL itself.
 */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** A field Printify may send as null, as the wrong type, or not at all. */
function lenient<T>(schema: z.ZodType<T>) {
  return schema
    .nullable()
    .catch(null)
    .transform((value) => value ?? undefined)
    .optional();
}

// openapi.json marks no field as required. `id` and `file_name` are required here anyway: a record
// without them cannot be acted on, and silently returning one would only move the failure later.
const uploadSchema = z.object({
  id: z.string().min(1),
  file_name: z.string(),
  width: lenient(z.number()),
  height: lenient(z.number()),
  size: lenient(z.number()),
  mime_type: lenient(z.string()),
  preview_url: lenient(z.string()),
  upload_time: lenient(z.string()),
});

/** One image in the Printify media library. */
export type Upload = z.infer<typeof uploadSchema>;

/** The documented request body: exactly one of `url` or `contents`, and always a `file_name`. */
export type UploadBody =
  | { file_name: string; url: string }
  | { file_name: string; contents: string };

export interface UploadPage {
  uploads: Upload[];
  page: number;
  hasMore: boolean;
  total: number | undefined;
  lastPage: number | undefined;
}

/** Uploads one image. `body` comes from `resolveUploadSource`, so this never reads a file. */
export async function uploadImage(
  client: PrintifyClient,
  body: UploadBody,
  signal: AbortSignal,
): Promise<Upload> {
  const path = apiPath`/v1/uploads/images.json`;
  const response = await client.request('POST', path, {
    body,
    signal,
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });
  return parseUpload(response, { method: 'POST', path });
}

/** One page of the media library. A `limit` above 100 is lowered by `fetchPage`. */
export async function listUploads(
  client: PrintifyClient,
  options: { page?: number; limit?: number },
  signal: AbortSignal,
): Promise<UploadPage> {
  const path = apiPath`/v1/uploads.json`;
  const page = await fetchPage(client, 'uploads', path, { ...options, signal });
  const route: Route = { method: 'GET', path };
  return {
    uploads: page.items.map((item) => parseUpload(item, route)),
    page: page.page,
    hasMore: page.hasMore,
    total: page.total,
    lastPage: page.lastPage,
  };
}

export async function getUpload(
  client: PrintifyClient,
  imageId: string,
  signal: AbortSignal,
): Promise<Upload> {
  const path = apiPath`/v1/uploads/${imageId}.json`;
  const response = await client.request('GET', path, { signal });
  return parseUpload(response, { method: 'GET', path });
}

/** Archives one image. Printify answers `{}` or nothing, so no response is read. */
export async function archiveUpload(
  client: PrintifyClient,
  imageId: string,
  signal: AbortSignal,
): Promise<void> {
  await client.request('POST', apiPath`/v1/uploads/${imageId}/archive.json`, { signal });
}

function parseUpload(body: unknown, route: Route): Upload {
  const parsed = uploadSchema.safeParse(body);
  if (!parsed.success) throw invalidResponseError(route, 200, 'an unexpected uploads response');
  return parsed.data;
}
```

- [ ] **Step 6: Run the test and watch it pass**

Run: `npx vitest run test/printify/uploads.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 7: Verify the whole suite and the types**

Run: `npx prettier --write src test && npm run lint && npm run typecheck && npm test`
Expected: all green, 478 tests (467 before plus 11).

- [ ] **Step 8: Commit**

<!-- prettier-ignore -->
```bash
git add src/printify/uploads.ts src/printify/errors.ts test/printify/uploads.test.ts test/fixtures/uploads.ts
git commit -F - <<'EOF'
Add the uploads request layer

The record schema and the four requests behind the uploads toolset, with
no filesystem and no MCP: `id` and `file_name` are required, the rest is
lenient, because openapi.json marks nothing required and a missing width
must not fail an upload that succeeded.

Uploads get a 120 s timeout instead of the client's 30 s default, since a
base64 body is large to send and a URL upload waits for Printify to fetch
the URL itself.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: The upload source resolver

The security boundary. It turns what the model asked for into the documented request body, or
refuses with a `ToolError` that says what to do instead. Two red-green cycles, each with its own
commit: the sources and the two remote ones first, then the local file.

**Files:**

- Create: `src/tools/upload-source.ts`
- Create: `test/tools/upload-source.test.ts`
- Modify: `src/config.ts` (export the existing `expandHome`)

**Interfaces:**

- Consumes: `UploadBody` from `src/printify/uploads.js` (Task 1), `ToolError` from `src/tools/define.js`, `expandHome` from `src/config.js`.
- Produces, used by Task 3:
  - `WARN_BYTES: number` (5 MiB), `MAX_BYTES: number` (25 MiB), `ALLOWED_EXTENSIONS: readonly ['.png', '.jpg', '.jpeg']`
  - `interface UploadInput { url?: string; file_path?: string; base64?: string; file_name?: string }`
  - `interface ResolvedSource { body: UploadBody; warning: string | undefined }`
  - `resolveUploadSource(input: UploadInput, uploadDirs: readonly string[]): Promise<ResolvedSource>`

- [ ] **Step 1: Write the failing test for the sources, `url` and `base64`**

Create `test/tools/upload-source.test.ts`.

<!-- prettier-ignore -->
```ts
import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/tools/define.js';
import {
  MAX_BYTES,
  WARN_BYTES,
  resolveUploadSource,
  type UploadInput,
} from '../../src/tools/upload-source.js';

/** "hello" in base64. */
const HELLO = 'aGVsbG8=';

/** A base64 string whose decoded size is just over `bytes`. */
function base64OfSize(bytes: number): string {
  return 'A'.repeat(4 * Math.ceil((bytes + 1) / 3));
}

/** Runs the resolver and returns the `ToolError` it must throw. */
async function refusal(input: UploadInput, dirs: readonly string[] = []): Promise<ToolError> {
  try {
    await resolveUploadSource(input, dirs);
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected the resolver to refuse');
}

describe('resolveUploadSource: choosing a source', () => {
  it('refuses when no source is given', async () => {
    const error = await refusal({});
    expect(error.message).toBe('Give exactly one of url, file_path or base64; none was given.');
  });

  it('refuses when more than one source is given, naming them', async () => {
    const error = await refusal({ url: 'https://example.com/a.png', base64: HELLO });
    expect(error.message).toContain('got url and base64');
  });
});

describe('resolveUploadSource: url', () => {
  it('sends the url and takes the file name from its last segment', async () => {
    expect(await resolveUploadSource({ url: 'https://example.com/art/sunset.png' }, [])).toEqual({
      body: { file_name: 'sunset.png', url: 'https://example.com/art/sunset.png' },
      warning: undefined,
    });
  });

  it('prefers an explicit file_name', async () => {
    const { body } = await resolveUploadSource(
      { url: 'https://example.com/art/sunset.png', file_name: 'poster.png' },
      [],
    );
    expect(body).toEqual({ file_name: 'poster.png', url: 'https://example.com/art/sunset.png' });
  });

  it('decodes a percent-encoded name', async () => {
    const { body } = await resolveUploadSource({ url: 'https://example.com/sun%20set.png' }, []);
    expect(body).toMatchObject({ file_name: 'sun set.png' });
  });

  it('reduces a file_name with a path in it to its last segment', async () => {
    const { body } = await resolveUploadSource(
      { url: 'https://example.com/a.png', file_name: '../../evil.png' },
      [],
    );
    expect(body).toMatchObject({ file_name: 'evil.png' });
  });

  it('refuses a url that is not http or https', async () => {
    const error = await refusal({ url: 'file:///etc/passwd' });
    expect(error.message).toContain('must use http or https');
  });

  it('refuses a url that is not a URL at all', async () => {
    const error = await refusal({ url: 'not a url' });
    expect(error.message).toContain('is not a valid URL');
  });

  it('refuses a url with no file name, unless file_name is given', async () => {
    const error = await refusal({ url: 'https://example.com/' });
    expect(error.message).toContain('pass file_name');
    const { body } = await resolveUploadSource(
      { url: 'https://example.com/', file_name: 'sunset.png' },
      [],
    );
    expect(body).toMatchObject({ file_name: 'sunset.png' });
  });
});

describe('resolveUploadSource: base64', () => {
  it('sends the contents with the file name', async () => {
    expect(
      await resolveUploadSource({ base64: HELLO, file_name: 'sunset.png' }, []),
    ).toEqual({ body: { file_name: 'sunset.png', contents: HELLO }, warning: undefined });
  });

  it('strips a data: prefix and any whitespace', async () => {
    const { body } = await resolveUploadSource(
      { base64: `data:image/png;base64,${HELLO.slice(0, 4)}\n  ${HELLO.slice(4)}`, file_name: 'a.png' },
      [],
    );
    expect(body).toMatchObject({ contents: HELLO });
  });

  it('refuses without a file_name, which Printify requires', async () => {
    const error = await refusal({ base64: HELLO });
    expect(error.message).toContain('file_name');
  });

  it('refuses a string that is not base64', async () => {
    const error = await refusal({ base64: 'not base64!', file_name: 'a.png' });
    expect(error.message).toContain('not a valid base64 string');
  });

  it('warns over 5 MiB and still uploads', async () => {
    const { body, warning } = await resolveUploadSource(
      { base64: base64OfSize(WARN_BYTES), file_name: 'poster.png' },
      [],
    );
    expect(body).toMatchObject({ file_name: 'poster.png' });
    expect(warning).toContain('poster.png is 5.0 MB');
    expect(warning).toContain('url');
  });

  it('refuses over 25 MiB', async () => {
    const error = await refusal({ base64: base64OfSize(MAX_BYTES), file_name: 'huge.png' });
    expect(error.message).toContain('huge.png is 25.0 MB');
    expect(error.hint).toContain('url');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/tools/upload-source.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/tools/upload-source.js"`.

- [ ] **Step 3: Export `expandHome` from the config**

In `src/config.ts`, add `export` to the existing function. Nothing else changes.

<!-- prettier-ignore -->
```ts
/** A leading `~`, alone or before a separator, means the home directory. `~user` is not expanded. */
export function expandHome(entry: string): string {
```

- [ ] **Step 4: Write the resolver, without the local file yet**

Create `src/tools/upload-source.ts`. `resolveFile` is written in Step 7; until then the file does
not compile, which is why Steps 4 and 7 share one test run at Step 8.

<!-- prettier-ignore -->
```ts
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, sep } from 'node:path';
import { expandHome } from '../config.js';
import type { UploadBody } from '../printify/uploads.js';
import { ToolError } from './define.js';

/** Over this, the upload still happens and the result warns. */
export const WARN_BYTES = 5 * 1024 * 1024;

/**
 * Over this, the upload is refused. Printify documents no maximum; this one protects the process.
 * The bytes become a base64 string and `JSON.stringify` copies that again, so a very large file
 * can exhaust the heap and take the stdio server down with it, leaving the model no error to read.
 */
export const MAX_BYTES = 25 * 1024 * 1024;

/** What this server reads off the user's disk. Printify documents no list of formats. */
export const ALLOWED_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

const SOURCES = ['url', 'file_path', 'base64'] as const;

export interface UploadInput {
  url?: string | undefined;
  file_path?: string | undefined;
  base64?: string | undefined;
  file_name?: string | undefined;
}

export interface ResolvedSource {
  body: UploadBody;
  /** Set when the payload is over `WARN_BYTES`; the tool passes it on to the model. */
  warning: string | undefined;
}

const SOURCE_HINT =
  "url is a publicly reachable image URL, file_path a file on the user's machine, base64 the " +
  'image bytes. Use url for anything large.';
const NAME_HINT = 'file_name is the name the image gets in the library, e.g. "sunset.png".';
const URL_HINT = 'Pass a public http or https URL that returns the image file itself.';
const BASE64_HINT =
  "base64 is the image file's bytes, base64-encoded. For a file on disk use file_path, and for " +
  'an image on the web use url.';
const BIG_HINT =
  'Host the image and pass url instead: Printify downloads it itself, with no limit of this kind.';
const LOCAL_OFF =
  'Uploading a local file is turned off, because this server reads only directories the user has ' +
  'allowed.';
const LOCAL_OFF_HINT =
  'The user sets PRINTIFY_UPLOAD_DIRS to those directories in the "env" block of the printify-mcp ' +
  'entry in their MCP client config, then restarts the client. An image with a public URL can be ' +
  'uploaded with url instead, which needs no such setting.';

/**
 * Turns the tool's arguments into the documented request body. Throws a `ToolError` for anything
 * the model can fix: no source or several, an unusable URL, a bad base64 string, or a local path
 * outside the directories the user allowed.
 */
export async function resolveUploadSource(
  input: UploadInput,
  uploadDirs: readonly string[],
): Promise<ResolvedSource> {
  const { url, file_path: filePath, base64, file_name: fileName } = input;
  const given = SOURCES.filter((name) => input[name] !== undefined);
  if (given.length !== 1) {
    throw new ToolError(
      `Give exactly one of url, file_path or base64; ${describeGiven(given)}.`,
      SOURCE_HINT,
    );
  }
  if (url !== undefined) return resolveUrl(url, fileName);
  if (base64 !== undefined) return resolveBase64(base64, fileName);
  // Exactly one source was given and it was neither of those, so file_path is set.
  return resolveFile(filePath ?? '', fileName, uploadDirs);
}

function describeGiven(given: readonly string[]): string {
  return given.length === 0 ? 'none was given' : `got ${given.join(' and ')}`;
}

function resolveUrl(url: string, fileName: string | undefined): ResolvedSource {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ToolError(`url is not a valid URL: ${url}`, URL_HINT);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolError(`url must use http or https, got "${parsed.protocol}"`, URL_HINT);
  }
  const name = safeName(fileName ?? basename(decodePath(parsed.pathname)));
  if (name === '') {
    throw new ToolError(
      `The file name cannot be worked out from ${url}; pass file_name as well.`,
      NAME_HINT,
    );
  }
  // Printify requires file_name in both body variants, so one is always sent.
  return { body: { file_name: name, url }, warning: undefined };
}

// Everything up to the first comma: `data:image/png;base64,`.
const DATA_URL = /^data:[^,]*,/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function resolveBase64(contents: string, fileName: string | undefined): ResolvedSource {
  const name = safeName(fileName ?? '');
  if (name === '') {
    throw new ToolError('base64 needs file_name as well: every upload is named.', NAME_HINT);
  }
  const cleaned = contents.replace(DATA_URL, '').replaceAll(/\s+/gu, '');
  if (cleaned === '' || cleaned.length % 4 !== 0 || !BASE64.test(cleaned)) {
    throw new ToolError('base64 is not a valid base64 string.', BASE64_HINT);
  }
  // Measured before decoding, so an oversized payload is never held twice.
  const bytes = decodedBytes(cleaned);
  if (bytes > MAX_BYTES) throw tooLarge(name, bytes);
  return { body: { file_name: name, contents: cleaned }, warning: warningFor(name, bytes) };
}

/** The byte length a base64 string decodes to, without decoding it. */
function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/** A pathname with %xx decoded, or as it stands when it is not valid percent-encoding. */
function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/** The last segment only, so a name like `../evil.png` cannot travel to Printify. */
function safeName(name: string): string {
  const base = basename(name.trim());
  return base === '.' || base === '..' ? '' : base;
}

function tooLarge(name: string, bytes: number): ToolError {
  return new ToolError(
    `${name} is ${formatSize(bytes)}, over this server's ${formatSize(MAX_BYTES)} limit for ` +
      'uploading file contents.',
    BIG_HINT,
  );
}

function warningFor(name: string, bytes: number): string | undefined {
  if (bytes <= WARN_BYTES) return undefined;
  return (
    `${name} is ${formatSize(bytes)}. Printify recommends uploading files over 5 MB by image URL ` +
    'rather than base64, and plans to stop accepting base64 uploads that large. Pass url instead ' +
    'when the file is reachable on the web.'
  );
}

function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 5: Write the failing test for `file_path`**

Append to `test/tools/upload-source.test.ts`, and add the imports it needs to the top of the file:

<!-- prettier-ignore -->
```ts
import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
```

<!-- prettier-ignore -->
```ts
/**
 * A fresh allowed directory. `realpath` matters: on macOS `tmpdir()` is under `/var`, a symlink to
 * `/private/var`, and `PRINTIFY_UPLOAD_DIRS` holds real paths.
 */
async function allowedDir(): Promise<string> {
  return await realpath(await mkdtemp(join(tmpdir(), 'printify-uploads-')));
}

/** Writes `name` into `dir` with `contents`, and returns its path. */
async function file(dir: string, name: string, contents: Buffer | string = 'png'): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, contents);
  return path;
}

describe('resolveUploadSource: file_path', () => {
  it('reads a file inside an allowed directory as base64', async () => {
    const dir = await allowedDir();
    const path = await file(dir, 'sunset.png', 'hello');
    expect(await resolveUploadSource({ file_path: path }, [dir])).toEqual({
      body: { file_name: 'sunset.png', contents: HELLO },
      warning: undefined,
    });
  });

  it('reads a file in a subdirectory of an allowed directory', async () => {
    const dir = await allowedDir();
    await mkdir(join(dir, 'art'));
    const path = await file(join(dir, 'art'), 'sunset.png', 'hello');
    const { body } = await resolveUploadSource({ file_path: path }, [dir]);
    expect(body).toMatchObject({ file_name: 'sunset.png' });
  });

  it('prefers an explicit file_name over the path', async () => {
    const dir = await allowedDir();
    const path = await file(dir, 'sunset.png', 'hello');
    const { body } = await resolveUploadSource({ file_path: path, file_name: 'poster.png' }, [dir]);
    expect(body).toMatchObject({ file_name: 'poster.png' });
  });

  it('refuses every local path when no directory is allowed', async () => {
    const dir = await allowedDir();
    const path = await file(dir, 'sunset.png');
    const error = await refusal({ file_path: path }, []);
    expect(error.message).toBe(
      'Uploading a local file is turned off, because this server reads only directories the user ' +
        'has allowed.',
    );
    expect(error.hint).toContain('PRINTIFY_UPLOAD_DIRS');
  });

  it('refuses a path outside every allowed directory, naming them', async () => {
    const [allowed, other] = [await allowedDir(), await allowedDir()];
    const path = await file(other, 'secret.png');
    const error = await refusal({ file_path: path }, [allowed]);
    expect(error.message).toContain('outside the directories the user allowed');
    expect(error.message).toContain(allowed);
  });

  it('refuses a symlink that points outside the allowed directory', async () => {
    const [allowed, other] = [await allowedDir(), await allowedDir()];
    const secret = await file(other, 'secret.png');
    const link = join(allowed, 'innocent.png');
    await symlink(secret, link);
    const error = await refusal({ file_path: link }, [allowed]);
    expect(error.message).toContain('outside the directories the user allowed');
  });

  it('checks the extension after resolving the link, not the name given', async () => {
    const dir = await allowedDir();
    const secret = await file(dir, 'notes.txt');
    const link = join(dir, 'art.png');
    await symlink(secret, link);
    const error = await refusal({ file_path: link }, [dir]);
    expect(error.message).toContain('not one of the file types');
  });

  it('does not treat a directory with the same prefix as inside', async () => {
    const dir = await allowedDir();
    const sibling = `${dir}-private`;
    await mkdir(sibling);
    const path = await file(sibling, 'secret.png');
    const error = await refusal({ file_path: path }, [dir]);
    expect(error.message).toContain('outside the directories the user allowed');
  });

  it('accepts an uppercase extension and refuses an unlisted one', async () => {
    const dir = await allowedDir();
    const png = await file(dir, 'SUNSET.PNG', 'hello');
    const { body } = await resolveUploadSource({ file_path: png }, [dir]);
    expect(body).toMatchObject({ file_name: 'SUNSET.PNG' });
    const gif = await file(dir, 'sunset.gif');
    const error = await refusal({ file_path: gif }, [dir]);
    expect(error.message).toContain('.png, .jpg, .jpeg');
  });

  it('refuses a relative path', async () => {
    const dir = await allowedDir();
    const error = await refusal({ file_path: 'sunset.png' }, [dir]);
    expect(error.message).toContain('must be an absolute path');
  });

  it('expands a leading ~ before deciding', async () => {
    const home = await realpath(homedir());
    // Nothing is written to the home directory: reaching "does not exist" already proves the
    // expansion, because an unexpanded "~/…" would have been refused as relative.
    const error = await refusal({ file_path: '~/printify-mcp-missing-fixture.png' }, [home]);
    expect(error.message).toContain('does not exist');
  });

  it('refuses a missing file, a directory and an empty file', async () => {
    const dir = await allowedDir();
    expect((await refusal({ file_path: join(dir, 'gone.png') }, [dir])).message).toContain(
      'does not exist',
    );
    await mkdir(join(dir, 'folder.png'));
    expect((await refusal({ file_path: join(dir, 'folder.png') }, [dir])).message).toContain(
      'is not a file',
    );
    const empty = await file(dir, 'empty.png', '');
    expect((await refusal({ file_path: empty }, [dir])).message).toContain('is empty');
  });

  it('warns over 5 MiB and refuses over 25 MiB', async () => {
    const dir = await allowedDir();
    const big = await file(dir, 'poster.png', Buffer.alloc(WARN_BYTES + 1));
    const { warning } = await resolveUploadSource({ file_path: big }, [dir]);
    expect(warning).toContain('poster.png is 5.0 MB');
    const huge = await file(dir, 'huge.png', Buffer.alloc(MAX_BYTES + 1));
    expect((await refusal({ file_path: huge }, [dir])).message).toContain('huge.png is 25.0 MB');
  });
});
```

- [ ] **Step 6: Run the test and watch it fail**

Run: `npx vitest run test/tools/upload-source.test.ts`
Expected: FAIL — `resolveFile is not defined`.

- [ ] **Step 7: Write the local file branch**

Append to `src/tools/upload-source.ts`:

<!-- prettier-ignore -->
```ts
/**
 * Reads a local file, but only inside the directories the user allowed. Every check is its own
 * refusal, so the model learns what to change. The path is resolved first and every later check
 * uses the real path, so a symlink can neither escape the allowed directories nor disguise the
 * file's type.
 */
async function resolveFile(
  path: string,
  fileName: string | undefined,
  uploadDirs: readonly string[],
): Promise<ResolvedSource> {
  if (uploadDirs.length === 0) throw new ToolError(LOCAL_OFF, LOCAL_OFF_HINT);
  const expanded = expandHome(path);
  if (!isAbsolute(expanded)) {
    throw new ToolError(
      `file_path must be an absolute path, got "${path}".`,
      'Ask the user for the full path, e.g. /Users/name/Designs/sunset.png.',
    );
  }
  let real: string;
  try {
    real = await realpath(expanded);
  } catch (error) {
    throw unreadable(path, error);
  }
  if (!uploadDirs.some((dir) => real === dir || real.startsWith(dir + sep))) {
    throw new ToolError(
      `${path} is outside the directories the user allowed for uploads: ${uploadDirs.join(', ')}.`,
      'Ask the user to move the file into one of them, or to add its directory to ' +
        'PRINTIFY_UPLOAD_DIRS and restart their MCP client.',
    );
  }
  const extension = extname(real).toLowerCase();
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new ToolError(
      `${path} is not one of the file types this server uploads from disk: ` +
        `${ALLOWED_EXTENSIONS.join(', ')}.`,
      'Convert the image first, or pass a public url, which Printify downloads itself.',
    );
  }
  const stats = await stat(real);
  if (!stats.isFile()) {
    throw new ToolError(`${path} is not a file.`, 'Pass the path of an image file.');
  }
  if (stats.size === 0) {
    throw new ToolError(`${path} is empty.`, 'Check the file with the user, then try again.');
  }
  const given = safeName(fileName ?? '');
  const name = given === '' ? basename(expanded) : given;
  // stat before readFile: an oversized file is refused without ever being held in memory.
  if (stats.size > MAX_BYTES) throw tooLarge(name, stats.size);
  const contents = await readFile(real, { encoding: 'base64' });
  return { body: { file_name: name, contents }, warning: warningFor(name, stats.size) };
}

function unreadable(path: string, error: unknown): ToolError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new ToolError(`${path} does not exist.`, 'Check the path with the user.');
  }
  return new ToolError(
    `${path} cannot be read (${code ?? 'unknown error'}).`,
    "Check the file's permissions with the user.",
  );
}
```

- [ ] **Step 8: Run the test and watch it pass**

Run: `npx vitest run test/tools/upload-source.test.ts`
Expected: PASS, 28 tests. The two size tests write a 5 MiB and a 25 MiB file to the temp
directory, so this file takes a second or two longer than the others.

- [ ] **Step 9: Verify and commit**

Run: `npx prettier --write src test && npm run lint && npm run typecheck && npm test`

<!-- prettier-ignore -->
```bash
git add src/tools/upload-source.ts src/config.ts test/tools/upload-source.test.ts
git commit -F - <<'EOF'
Resolve an upload's source, with local reads on an allowlist

Turns the model's url, file_path or base64 into the documented request
body, or refuses with a ToolError naming what to change.

A local path is resolved with realpath first, and every later check uses
the resolved path: containment in PRINTIFY_UPLOAD_DIRS, so a symlink
cannot escape, and the extension, so a symlink cannot disguise a text
file as a png. The refusal lists the allowed directories, because tool
descriptions are built before the configuration is known.

Files over 25 MiB are refused from stat, before anything is read: the
bytes become base64 and JSON.stringify copies that again, which a large
enough file turns into a dead server rather than an error the model can
act on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: The `upload_image` tool

**Files:**

- Create: `src/tools/uploads.ts`
- Create: `test/tools/uploads.test.ts`
- Modify: `src/tools/index.ts` (replace `uploads: []`)

**Interfaces:**

- Consumes: `resolveUploadSource` (Task 2), `uploadImage` and `Upload` (Task 1), `defineTool`/`Tool`/`ToolAnnotations` from `src/tools/define.js`.
- Produces: `uploadImageTool: Tool` and `uploadsTools: readonly Tool[]`, which Tasks 4 and 5 extend.

- [ ] **Step 1: Write the failing test**

Create `test/tools/uploads.test.ts`.

<!-- prettier-ignore -->
```ts
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiErrorBody } from '../fixtures/errors.js';
import { UPLOAD } from '../fixtures/uploads.js';
import { expectToolData, expectToolError } from '../support/expect.js';
import { json } from '../support/fake-api.js';
import { createTestServer } from '../support/harness.js';

const UPLOAD_ROUTE = 'POST /v1/uploads/images.json';
const UPLOAD_PATH = '/v1/uploads/images.json';
const HELLO = 'aGVsbG8=';

/** A real directory the server is allowed to read, with `files` written into it. */
async function allowedDir(files: Readonly<Record<string, Buffer | string>> = {}): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'printify-tools-')));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(dir, name), contents);
  }
  return dir;
}

describe('upload_image', () => {
  it('uploads by url, naming the file after the URL', async () => {
    const { call, api } = await createTestServer({ routes: { [UPLOAD_ROUTE]: UPLOAD } });
    const result = await call('upload_image', { url: 'https://example.com/art/sunset.png' });
    expect(expectToolData(result)).toEqual(UPLOAD);
    expect(api.expectRequest('POST', UPLOAD_PATH).body).toEqual({
      file_name: 'sunset.png',
      url: 'https://example.com/art/sunset.png',
    });
  });

  it('uploads by base64', async () => {
    const { call, api } = await createTestServer({ routes: { [UPLOAD_ROUTE]: UPLOAD } });
    expectToolData(await call('upload_image', { base64: HELLO, file_name: 'sunset.png' }));
    expect(api.expectRequest('POST', UPLOAD_PATH).body).toEqual({
      file_name: 'sunset.png',
      contents: HELLO,
    });
  });

  it('uploads a local file from an allowed directory', async () => {
    const dir = await allowedDir({ 'sunset.png': 'hello' });
    const { call, api } = await createTestServer({
      config: { uploadDirs: [dir] },
      routes: { [UPLOAD_ROUTE]: UPLOAD },
    });
    expectToolData(await call('upload_image', { file_path: join(dir, 'sunset.png') }));
    expect(api.expectRequest('POST', UPLOAD_PATH).body).toEqual({
      file_name: 'sunset.png',
      contents: HELLO,
    });
  });

  it('warns about a local file over 5 MB, and still uploads it', async () => {
    const dir = await allowedDir({ 'poster.png': Buffer.alloc(5 * 1024 * 1024 + 1) });
    const { call } = await createTestServer({
      config: { uploadDirs: [dir] },
      routes: { [UPLOAD_ROUTE]: UPLOAD },
    });
    const data = expectToolData(await call('upload_image', { file_path: join(dir, 'poster.png') }));
    expect(data['warning']).toContain('poster.png is 5.0 MB');
    expect(data['id']).toBe(UPLOAD.id);
  });

  it('leaves out warning for an ordinary upload', async () => {
    const { call } = await createTestServer({ routes: { [UPLOAD_ROUTE]: UPLOAD } });
    const data = expectToolData(await call('upload_image', { url: 'https://example.com/a.png' }));
    expect(data).not.toHaveProperty('warning');
  });

  it('refuses a path outside the allowed directories, without sending a request', async () => {
    const dir = await allowedDir();
    const { call, api } = await createTestServer({ config: { uploadDirs: [dir] } });
    const error = expectToolError(await call('upload_image', { file_path: '/etc/hosts' }), {
      kind: 'tool',
    });
    expect(error.message).toContain('outside the directories the user allowed');
    expect(api.requests).toHaveLength(0);
  });

  it('explains how to switch local uploads on when none is allowed', async () => {
    const { call } = await createTestServer();
    const error = expectToolError(await call('upload_image', { file_path: '/tmp/sunset.png' }), {
      kind: 'tool',
    });
    expect(error.hint).toContain('PRINTIFY_UPLOAD_DIRS');
  });

  it('refuses when no source, or more than one, is given', async () => {
    const { call } = await createTestServer();
    expect(expectToolError(await call('upload_image', {}), { kind: 'tool' }).message).toContain(
      'none was given',
    );
    const both = await call('upload_image', { url: 'https://example.com/a.png', base64: HELLO });
    expect(expectToolError(both, { kind: 'tool' }).message).toContain('got url and base64');
  });

  it('rejects an unknown argument', async () => {
    const { call } = await createTestServer();
    expectToolError(await call('upload_image', { path: '/tmp/a.png' }), { kind: 'validation' });
  });

  it("passes Printify's download failure back with its hint", async () => {
    const body = apiErrorBody({
      code: 10300,
      message: 'Operation failed.',
      reason: 'cURL error 6: Could not resolve host: example.com',
    });
    const { call } = await createTestServer({ routes: { [UPLOAD_ROUTE]: json(body, 400) } });
    const error = expectToolError(await call('upload_image', { url: 'https://example.com/a.png' }), {
      kind: 'http',
      status: 400,
      code: 10300,
    });
    expect(error.hint).toContain('publicly reachable');
  });

  it('passes a rejected file back with its hint', async () => {
    const body = apiErrorBody({
      code: 8201,
      message: 'Validation failed.',
      reason: 'Failed to upload image. Cause: {"code":"error.file.wrong.format"}',
    });
    const { call } = await createTestServer({ routes: { [UPLOAD_ROUTE]: json(body, 400) } });
    const error = expectToolError(await call('upload_image', { base64: HELLO, file_name: 'a.png' }), {
      kind: 'http',
      code: 8201,
    });
    expect(error.hint).toContain('not a supported image format');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/tools/uploads.test.ts`
Expected: FAIL — `Tool upload_image not found`, because `TOOLS_BY_TOOLSET.uploads` is still `[]`.

- [ ] **Step 3: Write the tool**

Create `src/tools/uploads.ts`.

<!-- prettier-ignore -->
```ts
import { z } from 'zod';
import { uploadImage } from '../printify/uploads.js';
import { defineTool, type Tool } from './define.js';
import { resolveUploadSource } from './upload-source.js';

export const uploadImageTool = defineTool({
  name: 'upload_image',
  toolset: 'uploads',
  description:
    'Uploads an image to the Printify image library, so a product can print it. Give exactly ' +
    'one of url (a publicly reachable image URL — the best choice for anything large, since ' +
    'Printify downloads it itself), file_path (a file on the user\'s machine, which works only ' +
    'inside the directories the user allowed; if it is refused, the error names them) or base64 ' +
    '(the image bytes, base64-encoded — only for small images). Returns the image id that ' +
    'products refer to, and the pixel size. The same file uploaded twice becomes two library ' +
    'entries, so prefer an id from list_uploads over uploading again.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: z.strictObject({
    url: z
      .string()
      .optional()
      .describe('A public http or https URL of the image. Printify downloads it itself.'),
    file_path: z
      .string()
      .optional()
      .describe(
        "The absolute path of an image on the user's machine, e.g. /Users/name/art/sunset.png. " +
          'Only .png, .jpg and .jpeg, and only inside the directories the user allowed.',
      ),
    base64: z
      .string()
      .optional()
      .describe('The image bytes, base64-encoded. Only for small images; prefer url or file_path.'),
    file_name: z
      .string()
      .optional()
      .describe(
        'The name the image gets in the library, e.g. "sunset.png". Required with base64; ' +
          'otherwise taken from the path or the URL.',
      ),
  }),
  handler: async (input, ctx) => {
    const { body, warning } = await resolveUploadSource(input, ctx.config.uploadDirs);
    const uploaded = await uploadImage(ctx.client, body, ctx.signal);
    return { ...uploaded, warning };
  },
});

export const uploadsTools: readonly Tool[] = [uploadImageTool];
```

- [ ] **Step 4: Wire the toolset in**

In `src/tools/index.ts`, import the tools and replace the `uploads` entry. The import list is
alphabetical:

<!-- prettier-ignore -->
```ts
import { uploadsTools } from './uploads.js';
```

<!-- prettier-ignore -->
```ts
  uploads: uploadsTools,
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `npx vitest run test/tools/uploads.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Verify and commit**

Run: `npx prettier --write src test && npm run lint && npm run typecheck && npm test`
Expected: all green. `test/tools/catalog.test.ts` now checks `upload_image` against the tool rules
as well, and must still pass.

<!-- prettier-ignore -->
```bash
git add src/tools/uploads.ts src/tools/index.ts test/tools/uploads.test.ts
git commit -F - <<'EOF'
Add the upload_image tool

Takes exactly one of url, file_path or base64, hands it to the resolver
and uploads what comes back. Not idempotent, and the description says so:
the same file uploaded twice becomes two library entries.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: `list_uploads` and `get_upload`

**Files:**

- Modify: `src/tools/uploads.ts`
- Modify: `test/tools/uploads.test.ts`

**Interfaces:**

- Consumes: `listUploads`, `getUpload`, `Upload` (Task 1), `PAGE_LIMITS` from `src/printify/pagination.js`, `omitKeys` from `src/tools/shape.js`.
- Produces: `listUploadsTool`, `getUploadTool`, both appended to `uploadsTools`.

- [ ] **Step 1: Write the failing test**

Append to `test/tools/uploads.test.ts`, and add `UPLOAD_LISTED` and `uploadsPage` to the existing
`../fixtures/uploads.js` import.

<!-- prettier-ignore -->
```ts
describe('list_uploads', () => {
  it('lists the library without preview URLs', async () => {
    const { call, api } = await createTestServer({
      routes: { 'GET /v1/uploads.json': uploadsPage([UPLOAD_LISTED]) },
    });
    const data = expectToolData(await call('list_uploads'));
    expect(data).toMatchObject({ page: 1, has_more: false, total: 1 });
    const [first] = data['uploads'] as Record<string, unknown>[];
    expect(first).toMatchObject({
      id: UPLOAD_LISTED.id,
      file_name: UPLOAD_LISTED.file_name,
      width: UPLOAD_LISTED.width,
      height: UPLOAD_LISTED.height,
    });
    expect(first).not.toHaveProperty('preview_url');
    api.expectRequest('GET', '/v1/uploads.json');
  });

  it('adds the preview URLs when asked', async () => {
    const { call } = await createTestServer({
      routes: { 'GET /v1/uploads.json': uploadsPage([UPLOAD_LISTED]) },
    });
    const data = expectToolData(await call('list_uploads', { include_previews: true }));
    const [first] = data['uploads'] as Record<string, unknown>[];
    expect(first).toMatchObject({ preview_url: UPLOAD_LISTED.preview_url });
  });

  it('passes page and limit on, and reports more pages', async () => {
    const { call, api } = await createTestServer({
      routes: { 'GET /v1/uploads.json': uploadsPage([UPLOAD_LISTED], { last_page: 4, total: 31 }) },
    });
    const data = expectToolData(await call('list_uploads', { page: 1, limit: 10 }));
    expect(data).toMatchObject({ has_more: true, last_page: 4, total: 31 });
    expect(api.expectRequest('GET', '/v1/uploads.json').query).toEqual({ page: '1', limit: '10' });
  });

  it('rejects a limit above the documented maximum', async () => {
    const { call } = await createTestServer();
    expectToolError(await call('list_uploads', { limit: 101 }), { kind: 'validation' });
  });
});

describe('get_upload', () => {
  it('gets one image with its preview URL', async () => {
    const { call, api } = await createTestServer({
      routes: { [`GET /v1/uploads/${UPLOAD.id}.json`]: UPLOAD },
    });
    expect(expectToolData(await call('get_upload', { image_id: UPLOAD.id }))).toEqual(UPLOAD);
    api.expectRequest('GET', `/v1/uploads/${UPLOAD.id}.json`);
  });

  it('rejects an empty image_id before any request', async () => {
    const { call, api } = await createTestServer();
    expectToolError(await call('get_upload', { image_id: '' }), { kind: 'validation' });
    expect(api.requests).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/tools/uploads.test.ts`
Expected: FAIL — `Tool list_uploads not found`.

- [ ] **Step 3: Write the two tools**

Add to `src/tools/uploads.ts`, and extend its imports:

<!-- prettier-ignore -->
```ts
import { PAGE_LIMITS } from '../printify/pagination.js';
import { getUpload, listUploads, uploadImage } from '../printify/uploads.js';
import { defineTool, type Tool, type ToolAnnotations } from './define.js';
import { omitKeys } from './shape.js';
```

<!-- prettier-ignore -->
```ts
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

const imageId = z
  .string()
  .min(1)
  .describe('The image id, e.g. from list_uploads or a previous upload_image.');

export const listUploadsTool = defineTool({
  name: 'list_uploads',
  toolset: 'uploads',
  description:
    'Lists the images already in the Printify image library, with the id, file name, pixel ' +
    'size, byte size and type of each. Use it to find an image the user uploaded earlier ' +
    'instead of uploading it again. include_previews adds each image\'s preview URL; leave it ' +
    'off unless the user wants to see the images, because those URLs are long.',
  annotations: READ_ONLY,
  input: z.strictObject({
    page: z.number().int().positive().optional().describe('The page to fetch, starting at 1.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(PAGE_LIMITS.uploads)
      .optional()
      .describe(`Images per page, at most ${String(PAGE_LIMITS.uploads)}. Printify's default is 10.`),
    include_previews: z
      .boolean()
      .default(false)
      .describe("Also return each image's preview URL, which is long."),
  }),
  handler: async (input, ctx) => {
    const page = await listUploads(
      ctx.client,
      { page: input.page, limit: input.limit },
      ctx.signal,
    );
    return {
      uploads: page.uploads.map((image) =>
        input.include_previews ? image : omitKeys(image, ['preview_url']),
      ),
      page: page.page,
      has_more: page.hasMore,
      total: page.total,
      last_page: page.lastPage,
    };
  },
});

export const getUploadTool = defineTool({
  name: 'get_upload',
  toolset: 'uploads',
  description:
    'Gets one uploaded image by its id: file name, pixel size, byte size, type and preview URL. ' +
    'Use it when you have an image id and need its size — for example to check that the artwork ' +
    'is large enough for a print area.',
  annotations: READ_ONLY,
  input: z.strictObject({ image_id: imageId }),
  handler: async (input, ctx) => await getUpload(ctx.client, input.image_id, ctx.signal),
});
```

Then extend the exported array:

<!-- prettier-ignore -->
```ts
export const uploadsTools: readonly Tool[] = [uploadImageTool, listUploadsTool, getUploadTool];
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/tools/uploads.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx prettier --write src test && npm run lint && npm run typecheck && npm test`

<!-- prettier-ignore -->
```bash
git add src/tools/uploads.ts test/tools/uploads.test.ts
git commit -F - <<'EOF'
Add the list_uploads and get_upload tools

list_uploads is the first caller of fetchPage, which has been tested but
unused since #3. Its rows leave out preview_url unless include_previews
asks for it: every other field is short, and at limit 100 those URLs are
most of the payload for something the model rarely needs. get_upload
returns the full record.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: `archive_upload`, behind the destructive gate

**Files:**

- Modify: `src/tools/uploads.ts`
- Modify: `test/tools/uploads.test.ts`

**Interfaces:**

- Consumes: `archiveUpload` (Task 1).
- Produces: `archiveUploadTool`, appended to `uploadsTools`.

- [ ] **Step 1: Write the failing test**

Append to `test/tools/uploads.test.ts`:

<!-- prettier-ignore -->
```ts
describe('archive_upload', () => {
  const ARCHIVE_PATH = `/v1/uploads/${UPLOAD.id}/archive.json`;

  it('is turned off without PRINTIFY_ENABLE_DESTRUCTIVE, and the instructions say so', async () => {
    const { mcp, selection } = await createTestServer();
    const names = (await mcp.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('list_uploads');
    expect(names).not.toContain('archive_upload');
    expect(selection.skipped.map(({ tool, reason }) => [tool.name, reason])).toContainEqual([
      'archive_upload',
      'destructive',
    ]);
    // disconnect_shop is skipped for the same reason, so the line names both.
    expect(mcp.getInstructions()).toMatch(
      /Irreversible tools \(.*archive_upload.*\): set PRINTIFY_ENABLE_DESTRUCTIVE=true\./,
    );
  });

  it('archives an image when the flag is on', async () => {
    const { call, api } = await createTestServer({
      env: { PRINTIFY_ENABLE_DESTRUCTIVE: 'true' },
      routes: { [`POST ${ARCHIVE_PATH}`]: json({}) },
    });
    expect(expectToolData(await call('archive_upload', { image_id: UPLOAD.id }))).toEqual({
      image_id: UPLOAD.id,
      archived: true,
    });
    api.expectRequest('POST', ARCHIVE_PATH);
  });

  it('is annotated as destructive rather than read-only', async () => {
    const { mcp } = await createTestServer({ env: { PRINTIFY_ENABLE_DESTRUCTIVE: 'true' } });
    const tool = (await mcp.listTools()).tools.find(({ name }) => name === 'archive_upload');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run test/tools/uploads.test.ts`
Expected: FAIL — the first case passes by accident (the tool does not exist yet), the second fails
with `Tool archive_upload not found`.

- [ ] **Step 3: Write the tool**

Add to `src/tools/uploads.ts`, extending the import from `../printify/uploads.js` with
`archiveUpload`:

<!-- prettier-ignore -->
```ts
export const archiveUploadTool = defineTool({
  name: 'archive_upload',
  toolset: 'uploads',
  gate: 'destructive',
  description:
    'Archives an image, removing it from the Printify image library. There is no unarchive ' +
    'endpoint, so this cannot be undone here. Confirm the image with the user first, for ' +
    'example its file name from get_upload. If the call times out, check with get_upload before ' +
    'calling it again rather than assuming nothing happened.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  input: z.strictObject({ image_id: imageId }),
  handler: async (input, ctx) => {
    await archiveUpload(ctx.client, input.image_id, ctx.signal);
    return { image_id: input.image_id, archived: true };
  },
});

export const uploadsTools: readonly Tool[] = [
  uploadImageTool,
  listUploadsTool,
  getUploadTool,
  archiveUploadTool,
];
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run test/tools/uploads.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Verify and commit**

Run: `npx prettier --write src test && npm run lint && npm run typecheck && npm test`

<!-- prettier-ignore -->
```bash
git add src/tools/uploads.ts test/tools/uploads.test.ts
git commit -F - <<'EOF'
Add the archive_upload tool behind the destructive gate

Printify has no unarchive endpoint, so archiving is irreversible and the
tool is registered only with PRINTIFY_ENABLE_DESTRUCTIVE=true. The
description tells the model to confirm the image first, and to re-check
with get_upload after a timeout rather than assume nothing happened.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: Verify the whole issue and open the PR

**Files:** none changed unless a check fails.

- [ ] **Step 1: Run every check, from a clean install**

Run, in the worktree:

<!-- prettier-ignore -->
```bash
npm ci && npm run lint && npm run typecheck && npm test && npm run build
```

Expected: all green. The suite should be at 467 + 11 + 28 + 20 = **526 tests**. If the count
differs, reconcile it before going on — a missing test is a missing acceptance criterion.

- [ ] **Step 2: Check the acceptance criteria against the issue**

Confirm each box in issue #10 is genuinely covered, not just plausibly:

- tests for each source type → `upload_image` has one case per source in `test/tools/uploads.test.ts`
- tests for outside allowed dirs, symlink escape, wrong extension, unset allowlist → the four cases in `test/tools/upload-source.test.ts`
- tests for error hints on 10300 and 8201 → the two cases in `test/tools/uploads.test.ts`

- [ ] **Step 3: Confirm the commit trailers**

Run: `git log origin/main..HEAD --format='%s%n%b' | grep -c 'Co-Authored-By: Claude Opus 5 (1M context)'`
Expected: one per commit (6, including the spec and plan commits). Reviewers regularly miss a
missing trailer; check it here rather than after the PR is open.

- [ ] **Step 4: Push and open the PR**

<!-- prettier-ignore -->
```bash
git push -u origin feat/10-uploads-toolset
```

The PR body starts with `Closes #10` on its own line — `board.sh review` finds the issue only
through that link, and GitHub moves it to Done on merge. End the body with:
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 5: Move the board and watch CI**

Run: `~/.claude/skills/updating-github-project-status/board.sh review`
Then watch the run: `gh pr checks --watch`. CI runs on Node 22 and 24, on `ubuntu-latest`.

- [ ] **Step 6: Leave the hand-off comments**

On #19: `uploadImage()` in `src/printify/uploads.ts` takes a resolved body and returns the record
with `width` and `height`; `resolveUploadSource` already turns a model's `url`, `file_path` or
`base64` into that body, allowlist included, and returns the over-5-MB `warning` with it.

On #11: an uploaded id from `upload_image` is what `print_areas` refers to, and `get_upload` gives
the pixel size to check against a placeholder's.

## Deferred, for the issue's follow-up list

- `src/printify/uploads.ts` carries its own copy of the `lenient` helper that `src/printify/catalog.ts` defines. Unifying them means editing `catalog.ts`, which #9 is rewriting in a parallel worktree, so it waits until #9 lands.
- The resolver's `realpath` → `stat` → `readFile` sequence is not atomic. Someone who can swap files inside an allowed directory between those calls could redirect the read; they already have access to that directory's files, so this is accepted rather than fixed with a held file handle.
- The 25 MiB ceiling is a constant, not configurable. If a user legitimately needs more, the answer is `url`, and a variable can be added when someone asks.
