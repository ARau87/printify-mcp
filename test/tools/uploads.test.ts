import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { apiErrorBody } from '../fixtures/errors.js';
import { UPLOAD, UPLOAD_LISTED, uploadsPage } from '../fixtures/uploads.js';
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
    const error = expectToolError(
      await call('upload_image', { url: 'https://example.com/a.png' }),
      {
        kind: 'http',
        status: 400,
        code: 10300,
      },
    );
    expect(error.hint).toContain('publicly reachable');
  });

  it('passes a rejected file back with its hint', async () => {
    const body = apiErrorBody({
      code: 8201,
      message: 'Validation failed.',
      reason: 'Failed to upload image. Cause: {"code":"error.file.wrong.format"}',
    });
    const { call } = await createTestServer({ routes: { [UPLOAD_ROUTE]: json(body, 400) } });
    const error = expectToolError(
      await call('upload_image', { base64: HELLO, file_name: 'a.png' }),
      {
        kind: 'http',
        code: 8201,
      },
    );
    expect(error.hint).toContain('not a supported image format');
  });
});

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
