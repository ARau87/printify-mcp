import { z } from 'zod';
import { PAGE_LIMITS } from '../printify/pagination.js';
import { getUpload, listUploads, uploadImage } from '../printify/uploads.js';
import { defineTool, type Tool, type ToolAnnotations } from './define.js';
import { omitKeys } from './shape.js';
import { resolveUploadSource } from './upload-source.js';

export const uploadImageTool = defineTool({
  name: 'upload_image',
  toolset: 'uploads',
  description:
    'Uploads an image to the Printify image library, so a product can print it. Give exactly ' +
    'one of url (a publicly reachable image URL — the best choice for anything large, since ' +
    "Printify downloads it itself), file_path (a file on the user's machine, which works only " +
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
    "instead of uploading it again. include_previews adds each image's preview URL; leave it " +
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
      .describe(
        `Images per page, at most ${String(PAGE_LIMITS.uploads)}. Printify's default is 10.`,
      ),
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

export const uploadsTools: readonly Tool[] = [uploadImageTool, listUploadsTool, getUploadTool];
