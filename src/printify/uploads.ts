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
  { file_name: string; url: string } | { file_name: string; contents: string };

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
