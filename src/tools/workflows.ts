import { z } from 'zod';
import { createProduct } from '../printify/products.js';
import { getUpload, uploadImage, type UploadBody } from '../printify/uploads.js';
import {
  PartialFailureError,
  ToolError,
  defineTool,
  type Tool,
  type ToolContext,
} from './define.js';
import {
  DEFAULT_PLACEMENT,
  placeImage,
  resolutionWarning,
  type Placement,
  type Size,
} from './placement.js';
import {
  buildProductPayload,
  selectMockups,
  type PlannedArea,
  type Price,
} from './product-plan.js';
import { resolveShopId, shopIdInput } from './shop-id.js';
import { resolveUploadSource } from './upload-source.js';
import {
  checkPositions,
  checkPriceSizes,
  groupByPlaceholders,
  selectVariants,
  type PlaceholderGroup,
} from './variant-selection.js';

const cents = z.number().int().positive();

const angle = z.number().int().optional().describe('Rotation in degrees. Default 0.');

const alignFields = {
  align: z
    .enum(['center', 'top'])
    .optional()
    .describe(
      'center (the default) centres the artwork in the print area; top puts its top edge at ' +
        'the top, as for a chest print.',
    ),
  offset_y_pct: z
    .number()
    .optional()
    .describe(
      'Moves the artwork down by this percentage of the print area height; negative moves it ' +
        'up. Default 0.',
    ),
  angle,
};

const placementInput = z
  .discriminatedUnion('mode', [
    z.strictObject({ mode: z.literal('contain'), ...alignFields }),
    z.strictObject({ mode: z.literal('cover'), ...alignFields }),
    z.strictObject({
      mode: z.literal('width'),
      width_pct: z
        .number()
        .gt(0)
        .max(100)
        .describe('The artwork width as a percentage of the print area width, e.g. 80.'),
      ...alignFields,
    }),
    z.strictObject({
      mode: z.literal('custom'),
      x: z.number().describe("The artwork centre's x, 0–1 from the left; 0.5 is the middle."),
      y: z.number().describe("The artwork centre's y, 0–1 from the top; 0.5 is the middle."),
      scale: z
        .number()
        .positive()
        .describe('The artwork width divided by the print area width; 1 fills the width.'),
      angle,
    }),
  ])
  .describe(
    'Where the artwork goes. contain (the default) fits the whole image inside the print area; ' +
      'cover fills it and crops the overflow; width sets the width as a percentage; custom ' +
      'takes x, y and scale as given.',
  );

const imageInput = z
  .strictObject({
    upload_id: z
      .string()
      .min(1)
      .optional()
      .describe('An image already in the library, from upload_image or list_uploads.'),
    url: z
      .string()
      .optional()
      .describe('A public http or https URL of the image. Printify downloads it itself.'),
    file_path: z
      .string()
      .optional()
      .describe(
        "The absolute path of a .png, .jpg or .jpeg on the user's machine, inside the " +
          'directories the user allowed.',
      ),
    file_name: z
      .string()
      .optional()
      .describe('The name an uploaded image gets in the library. Taken from the URL or path.'),
  })
  .describe('Exactly one of upload_id, url or file_path. The same url or path is uploaded once.');

const designInput = z.strictObject({
  position: z
    .string()
    .min(1)
    .describe('The print position, e.g. front or back, as list_variants names it.'),
  image: imageInput,
  placement: placementInput.optional(),
});

type DesignInput = z.output<typeof designInput>;

const SOURCES = ['upload_id', 'url', 'file_path'] as const;

type Source = (typeof SOURCES)[number];

const IMAGE_HINT =
  'upload_id is an image already in the library, url a public image URL, file_path a file on ' +
  "the user's machine.";
const NO_SIZE_HINT =
  'Pass placement: { mode: "custom", x: 0.5, y: 0.5, scale: 1 } for this design to centre it ' +
  'at the full print area width, or adjust scale.';
const STRICT_HINT =
  'Use a larger image or a smaller placement (mode "width" with a lower width_pct), or leave ' +
  'strict out to create the product with a warning.';
const NEXT_STEP =
  'The product is an unpublished draft in the shop. Show the user the mockups and ask whether ' +
  'to change anything with update_product before it is published to the sales channel.';

/** One distinct image of the call. Designs with the same source share one. */
interface ImageSlot {
  positions: string[];
  /** Known for an upload_id input, and once the image is uploaded. */
  uploadId: string | undefined;
  /** The upload request for a url or file_path input. */
  body: UploadBody | undefined;
  fileName: string;
  width: number | undefined;
  height: number | undefined;
  reused: boolean;
  warning: string | undefined;
}

/** What the error of a call that failed after uploading lists, so the uploads can be reused. */
interface UploadedImage {
  upload_id: string;
  file_name: string;
  positions: string[];
}

export const createProductFromImageTool = defineTool({
  name: 'create_product_from_image',
  toolset: 'workflows',
  description:
    'Creates a product from artwork in one call: uploads the images, picks the variants, works ' +
    'out where each image sits on each print area, and creates the product as an unpublished ' +
    'draft. Give the blueprint and print provider (from search_blueprints and ' +
    'list_blueprint_providers), one design per print position with its image and placement, ' +
    'optionally colors and sizes (names as list_variants shows them, any case; by default ' +
    'every variant in stock), and the price in cents, optionally per size. get_print_areas ' +
    'shows the positions and their pixel sizes first. Warns when an image has fewer pixels ' +
    'than it is printed across; strict refuses instead. If the call fails ' +
    'after uploading, the error lists the images under uploaded: retry with image.upload_id ' +
    'set to them rather than uploading again. If the error says the request may still have gone ' +
    'through, the product may exist: check list_products for it before retrying. Does not ' +
    'publish.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: z.strictObject({
    ...shopIdInput,
    blueprint_id: z
      .number()
      .int()
      .positive()
      .describe('The catalog blueprint id, from search_blueprints.'),
    print_provider_id: z
      .number()
      .int()
      .positive()
      .describe('The print provider id, from list_blueprint_providers.'),
    title: z.string().min(1).describe('The product title.'),
    description: z.string().describe('The product description. HTML is allowed.'),
    tags: z.array(z.string()).optional().describe('Tags for the sales channel.'),
    designs: z
      .array(designInput)
      .min(1)
      .describe('One design per print position, each position at most once.'),
    variants: z
      .strictObject({
        colors: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Color names, e.g. ["Black", "White"]. Default: every color in stock.'),
        sizes: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe('Size names, e.g. ["S", "M", "L", "XL"]. Default: every size in stock.'),
      })
      .optional()
      .describe('Which variants to offer. Every matching variant in stock is enabled.'),
    price: z
      .union([
        cents,
        z.strictObject({
          default: cents,
          by_size: z
            .record(z.string(), cents)
            .optional()
            .describe('Prices for particular sizes, e.g. { "2XL": 2799 }.'),
        }),
      ])
      .describe('The price in cents, e.g. 2499 for 24.99, or { default, by_size }.'),
    strict: z
      .boolean()
      .optional()
      .describe('Refuse, rather than warn, when an image is too small for its placement.'),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const list = await ctx.catalog.variants(
      input.blueprint_id,
      input.print_provider_id,
      { showOutOfStock: false },
      ctx.signal,
    );
    const selected = selectVariants(list.variants, input.variants ?? {});
    const positions = input.designs.map((design) => design.position);
    checkPositions(selected, positions);
    const price: Price = input.price;
    checkPriceSizes(selected, typeof price === 'number' ? undefined : price.by_size);

    const slotOf = await resolveImages(input.designs, ctx);
    // An upload_id's size is already known, so a missing one is refused before any upload.
    for (const design of input.designs) {
      const slot = slotOf.get(design.position);
      if (slot?.reused === true) checkSizeKnown(slot, design.placement ?? DEFAULT_PLACEMENT);
    }
    const slots = [...new Set(slotOf.values())];
    const warnings = slots.flatMap((slot) => (slot.warning === undefined ? [] : [slot.warning]));
    const uploaded: UploadedImage[] = [];
    try {
      for (const slot of slots) {
        if (slot.body === undefined) continue;
        const record = await uploadImage(ctx.client, slot.body, ctx.signal);
        slot.uploadId = record.id;
        slot.fileName = record.file_name;
        slot.width = record.width;
        slot.height = record.height;
        uploaded.push({
          upload_id: record.id,
          file_name: record.file_name,
          positions: slot.positions,
        });
      }
      const groups = groupByPlaceholders(selected, positions);
      const areas = placeDesigns(groups, input.designs, slotOf, input.strict ?? false, warnings);
      const payload = buildProductPayload({
        title: input.title,
        description: input.description,
        tags: input.tags,
        blueprintId: input.blueprint_id,
        printProviderId: input.print_provider_id,
        variants: selected,
        price,
        areas,
      });
      const product = await createProduct(ctx.client, shopId, payload, ctx.signal);
      return {
        product_id: product.id,
        shop_id: shopId,
        title: product.title,
        enabled_variants: payload.variants.length,
        print_area_groups: payload.print_areas.length,
        images: slots.map((slot) => ({
          upload_id: slot.uploadId,
          file_name: slot.fileName,
          width: slot.width,
          height: slot.height,
          positions: slot.positions,
          reused: slot.reused,
        })),
        mockups: selectMockups(product.images ?? []),
        mockup_count: product.images?.length ?? 0,
        warnings: warnings.length === 0 ? undefined : warnings,
        next_step: NEXT_STEP,
      };
    } catch (error) {
      if (uploaded.length === 0) throw error;
      throw new PartialFailureError(error, { uploaded });
    }
  },
});

/**
 * Checks each design's image source and reads what it can without writing: an upload_id's pixel
 * size, and a url or file_path's upload request. Returns each position's image.
 */
async function resolveImages(
  designs: readonly DesignInput[],
  ctx: ToolContext,
): Promise<Map<string, ImageSlot>> {
  const bySource = new Map<string, ImageSlot>();
  const byPosition = new Map<string, ImageSlot>();
  for (const [index, design] of designs.entries()) {
    const { image } = design;
    const given = SOURCES.filter((source) => image[source] !== undefined);
    const [source] = given;
    if (given.length !== 1 || source === undefined) {
      throw new ToolError(
        `designs[${String(index)}].image needs exactly one of upload_id, url or file_path; ` +
          `${given.length === 0 ? 'none was given' : `got ${given.join(' and ')}`}.`,
        IMAGE_HINT,
      );
    }
    const value = image[source] ?? '';
    const key = `${source}:${value}`;
    let slot = bySource.get(key);
    if (slot === undefined) {
      slot = await newSlot(source, value, image.file_name, ctx);
      bySource.set(key, slot);
    }
    slot.positions.push(design.position);
    byPosition.set(design.position, slot);
  }
  return byPosition;
}

async function newSlot(
  source: Source,
  value: string,
  fileName: string | undefined,
  ctx: ToolContext,
): Promise<ImageSlot> {
  if (source === 'upload_id') {
    const record = await getUpload(ctx.client, value, ctx.signal);
    return {
      positions: [],
      uploadId: record.id,
      body: undefined,
      fileName: record.file_name,
      width: record.width,
      height: record.height,
      reused: true,
      warning: undefined,
    };
  }
  const { body, warning } = await resolveUploadSource(
    source === 'url'
      ? { url: value, file_name: fileName }
      : { file_path: value, file_name: fileName },
    ctx.config.uploadDirs,
  );
  return {
    positions: [],
    uploadId: undefined,
    body,
    fileName: body.file_name,
    width: undefined,
    height: undefined,
    reused: false,
    warning,
  };
}

/**
 * Places every design in every group. Adds resolution warnings to `warnings`, or throws when
 * `strict` is set and there are any.
 */
function placeDesigns(
  groups: readonly PlaceholderGroup[],
  designs: readonly DesignInput[],
  slotOf: ReadonlyMap<string, ImageSlot>,
  strict: boolean,
  warnings: string[],
): PlannedArea[] {
  const lowResolution: string[] = [];
  const unchecked = new Set<ImageSlot>();
  const areas = groups.map((group) => ({
    variantIds: group.variantIds,
    images: designs.map((design) => {
      const slot = slotOf.get(design.position);
      const placeholder = group.placeholders.get(design.position);
      if (slot?.uploadId === undefined || placeholder === undefined) {
        throw new TypeError(`no image or placeholder for ${design.position}`);
      }
      const placement = design.placement ?? DEFAULT_PLACEMENT;
      checkSizeKnown(slot, placement);
      const size = sizeOf(slot);
      const placed = placeImage(placeholder, size, placement);
      if (size === undefined) {
        unchecked.add(slot);
      } else {
        const warning = resolutionWarning({
          fileName: slot.fileName,
          imageWidth: size.width,
          printedWidth: placed.printedWidth,
          position: design.position,
          variantCount: group.variantIds.length,
        });
        if (warning !== undefined) lowResolution.push(warning);
      }
      return { position: design.position, imageId: slot.uploadId, placement: placed.image };
    }),
  }));
  if (strict && lowResolution.length > 0) {
    throw new ToolError(
      `strict is set and the artwork would print at low resolution: ${lowResolution.join('; ')}.`,
      STRICT_HINT,
    );
  }
  warnings.push(...lowResolution);
  for (const slot of unchecked) {
    warnings.push(
      `resolution of ${slot.fileName} could not be checked: Printify did not report its size`,
    );
  }
  return areas;
}

/** Throws when the placement needs the image's pixel size and Printify did not report it. */
function checkSizeKnown(slot: ImageSlot, placement: Placement): void {
  if (placement.mode === 'custom' || sizeOf(slot) !== undefined) return;
  throw new ToolError(
    `Printify did not report the pixel size of ${slot.fileName}, so placement mode ` +
      `"${placement.mode}" cannot be worked out.`,
    NO_SIZE_HINT,
  );
}

function sizeOf(slot: ImageSlot): Size | undefined {
  if (slot.width === undefined || slot.height === undefined) return undefined;
  return { width: slot.width, height: slot.height };
}

export const workflowsTools: readonly Tool[] = [createProductFromImageTool];
