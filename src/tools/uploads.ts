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

export const uploadsTools: readonly Tool[] = [uploadImageTool];
