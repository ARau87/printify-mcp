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
    try {
      const { client } = testClient({ 'POST /v1/uploads/images.json': UPLOAD });
      await uploadImage(client, CONTENTS, live());
      expect(UPLOAD_TIMEOUT_MS).toBe(120_000);
      expect(timeout).toHaveBeenCalledWith(UPLOAD_TIMEOUT_MS);
    } finally {
      timeout.mockRestore();
    }
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
    const { client } = testClient({
      'GET /v1/uploads.json': uploadsPage([{ file_name: 'a.png' }]),
    });
    const error = await apiError(listUploads(client, {}, live()));
    expect(error.kind).toBe('invalid_response');
  });
});
