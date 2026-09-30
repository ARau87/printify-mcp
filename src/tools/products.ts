import { z } from 'zod';
import { PAGE_LIMITS } from '../printify/pagination.js';
import {
  createProduct,
  getProduct,
  getProductGpsr,
  listProducts,
  updateProduct,
} from '../printify/products.js';
import { defineTool, ToolError, type Tool, type ToolAnnotations } from './define.js';
import { assertUnlocked, mergeVariants, type VariantPatch } from './product-update.js';
import { productRow, summarizeProduct } from './product-summary.js';
import { resolveShopId, shopIdInput } from './shop-id.js';

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

// Letters and digits only: Printify ids are hex strings, and anything else would reach apiPath,
// which throws on a path segment it cannot use.
const productId = z
  .string()
  .regex(/^[A-Za-z0-9]+$/, 'product_id must be letters and digits')
  .describe('The product id, e.g. from list_products.');

const titleInput = z.string().min(1).describe('The product name.');
const descriptionInput = z
  .string()
  .describe('The product description. HTML is allowed for compatible sales channels.');

const variantId = z.number().int().positive();
const priceInput = z.number().int().min(0).describe('The price in cents, e.g. 2499 for 24.99.');

/** The writable variant fields besides `price`, whose optionality differs between the tools. */
const variantFields = {
  id: variantId.describe('The variant id, from list_variants.'),
  is_enabled: z.boolean().optional().describe('Whether the variant is offered for sale.'),
  is_default: z
    .boolean()
    .optional()
    .describe('The default variant gives the product its title image. Only one can be default.'),
  sku: z
    .string()
    .optional()
    .describe('A SKU of your own. Printify generates one when it is left out.'),
};

const patternInput = z.strictObject({
  spacing_x: z
    .number()
    .describe(
      'Horizontal spacing relative to the image width: 1 is no gap, 0.5 repeats every half width.',
    ),
  spacing_y: z.number().describe('Vertical spacing relative to the image height, like spacing_x.'),
  angle: z
    .number()
    .optional()
    .describe('The axis the pattern repeats along, in degrees, -45 to 45.'),
  offset: z
    .number()
    .optional()
    .describe('The offset between rows, -1 to 1; 0.5 makes a brick pattern.'),
  scale: z.number().optional().describe('The scale of each repeat.'),
});

const imageInput = z.strictObject({
  id: z.string().min(1).describe('An image id from upload_image or list_uploads.'),
  x: z
    .number()
    .min(0)
    .max(1)
    .describe("The image centre's horizontal position, 0–1 from the left; 0.5 is the middle."),
  y: z
    .number()
    .min(0)
    .max(1)
    .describe("The image centre's vertical position, 0–1 from the top; 0.5 is the middle."),
  scale: z
    .number()
    .positive()
    .describe('The image width divided by the placeholder width; 1 fills the print area.'),
  angle: z.number().int().min(-360).max(360).describe('Rotation in degrees; 0 is upright.'),
  pattern: patternInput.optional().describe('Repeat the image as a pattern.'),
});

const placeholderInput = z.strictObject({
  position: z
    .string()
    .min(1)
    .describe('A position from list_variants, e.g. front. It selects the decoration method.'),
  images: z.array(imageInput).describe('The images to print at this position, in stacking order.'),
});

const printAreaInput = z.strictObject({
  variant_ids: z.array(variantId).min(1).describe('The variants this print area applies to.'),
  placeholders: z.array(placeholderInput).min(1),
  background: z.string().optional().describe('A background colour as a hex code, e.g. #ffffff.'),
});

const printDetailsInput = z.strictObject({
  print_on_side: z
    .enum(['regular', 'mirror', 'off'])
    .optional()
    .describe(
      'For canvases: regular extends the print to the sides, mirror mirrors it, off leaves them blank.',
    ),
  separator_type: z.string().optional().describe('For clocks: Numbers, Lines or None.'),
  separator_color: z.string().optional().describe('For clocks: a hex colour code.'),
});

const externalInput = z
  .array(
    z.strictObject({
      id: z.string().optional(),
      handle: z.string().optional(),
      shipping_template_id: z
        .string()
        .optional()
        .describe('An Etsy or Amazon shipping template id.'),
    }),
  )
  .describe('The sales-channel reference. Only shipping_template_id is normally set by hand.');

/** The product fields both tools accept, all optional. */
const optionalProductFields = {
  tags: z.array(z.string()).optional().describe('Tags, published to the sales channel.'),
  safety_information: z
    .string()
    .optional()
    .describe(
      'GPSR and care information; HTML is allowed. get_product_gpsr shows how Printify splits it.',
    ),
  print_details: printDetailsInput.optional(),
  external: externalInput.optional(),
  is_printify_express_enabled: z
    .boolean()
    .optional()
    .describe('Enable Printify Express delivery. Only an eligible product accepts it.'),
  sales_channel_properties: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Sales-channel specific settings, passed through as given.'),
};

const CREATE_FIELDS = [
  'title',
  'description',
  'blueprint_id',
  'print_provider_id',
  'variants',
  'print_areas',
  'tags',
  'safety_information',
  'print_details',
  'external',
  'is_printify_express_enabled',
  'sales_channel_properties',
] as const;

const UPDATE_FIELDS = [
  'title',
  'description',
  'tags',
  'safety_information',
  'variants',
  'print_areas',
  'print_details',
  'external',
  'is_printify_express_enabled',
  'sales_channel_properties',
] as const;

const REPLACE_HINT =
  'Pass replace_variants: true only with the complete variant list, every entry with its price, ' +
  'and print_areas that cover any new variant ids.';
const UNKNOWN_VARIANT_HINT =
  'Use list_variants for the ids this blueprint and print provider offer. To add or remove ' +
  'variants, pass replace_variants: true with the complete list, and print_areas that cover the ' +
  'new ids.';

/** The refusals that need no request: they are about the input alone. */
function checkVariantPatches(
  variants: readonly VariantPatch[] | undefined,
  replace: boolean,
): void {
  if (variants === undefined) {
    if (replace) {
      throw new ToolError(
        'replace_variants needs variants: the complete list to set.',
        REPLACE_HINT,
      );
    }
    return;
  }
  const ids = variants.map((variant) => variant.id);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicates.length > 0) {
    throw new ToolError(
      `variants lists ${duplicates.map(String).join(', ')} more than once.`,
      'Give each variant id once.',
    );
  }
  if (replace) {
    const unpriced = variants.filter((variant) => variant.price === undefined);
    if (unpriced.length > 0) {
      throw new ToolError(
        'With replace_variants every variant needs a price; ' +
          `${unpriced.map((variant) => String(variant.id)).join(', ')} have none.`,
        REPLACE_HINT,
      );
    }
  }
}

/** The given fields of `input`, as the request body. An absent field is left out, so Printify keeps it. */
function pickFields(
  input: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    if (input[field] !== undefined) body[field] = input[field];
  }
  return body;
}

export const listProductsTool = defineTool({
  name: 'list_products',
  toolset: 'products',
  description:
    "Lists the products in a shop: each one's id, title, blueprint and print provider ids, " +
    'whether it is visible in the sales channel, whether it is locked for publishing, how many ' +
    'variants it has and how many are enabled, and its sales-channel reference. Paginate with ' +
    "page and limit (at most 50; Printify's default is 10). Use get_product for a product's " +
    'variants, print areas and mock-ups.',
  annotations: READ_ONLY,
  input: z.strictObject({
    ...shopIdInput,
    page: z.number().int().positive().optional().describe('The page to fetch, starting at 1.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(PAGE_LIMITS.products)
      .optional()
      .describe(
        `Products per page, at most ${String(PAGE_LIMITS.products)}. Printify's default is 10.`,
      ),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const page = await listProducts(
      ctx.client,
      shopId,
      { page: input.page, limit: input.limit },
      ctx.signal,
    );
    return {
      products: page.products.map(productRow),
      page: page.page,
      has_more: page.hasMore,
      total: page.total,
      last_page: page.lastPage,
    };
  },
});

export const getProductTool = defineTool({
  name: 'get_product',
  toolset: 'products',
  description:
    "Gets one product. The summary (the default) has the product's fields, every variant as a " +
    'compact row (id, title, sku, price and cost in cents, is_enabled, is_default, ' +
    "is_available), its print areas with each image's id and placement, and the default " +
    'mock-up URLs. detail: "full" returns the whole product as Printify sends it, including ' +
    'every mock-up, the blank views and the option tables; it is large. A text layer in a print ' +
    'area is shown but cannot be edited here.',
  annotations: READ_ONLY,
  input: z.strictObject({
    ...shopIdInput,
    product_id: productId,
    detail: z
      .enum(['summary', 'full'])
      .default('summary')
      .describe('summary (the default) is compact; full is the whole product and is large.'),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const found = await getProduct(ctx.client, shopId, input.product_id, ctx.signal);
    return input.detail === 'full' ? { ...found } : { ...summarizeProduct(found) };
  },
});

export const getProductGpsrTool = defineTool({
  name: 'get_product_gpsr',
  toolset: 'products',
  description:
    "Gets a product's General Product Safety Regulation (GPSR) information: the sections " +
    'Printify derives from its safety_information, each with a title and text. Set ' +
    'safety_information with create_product or update_product to change them.',
  annotations: READ_ONLY,
  input: z.strictObject({ ...shopIdInput, product_id: productId }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const sections = await getProductGpsr(ctx.client, shopId, input.product_id, ctx.signal);
    return { product_id: input.product_id, sections };
  },
});

export const createProductTool = defineTool({
  name: 'create_product',
  toolset: 'products',
  description:
    'Creates a product from a catalog blueprint and print provider (from search_blueprints and ' +
    'list_blueprint_providers), with the variants to offer (ids from list_variants, prices in ' +
    'cents) and the artwork to print. print_areas maps variant ids to placeholders: each has a ' +
    'position from list_variants and the images to print there, by image id from upload_image ' +
    "or list_uploads. x and y place the image's centre, 0–1 from the top-left with 0.5/0.5 the " +
    'centre of the print area; scale is the image width divided by the placeholder width, 1 ' +
    'fills it; angle rotates in degrees. Only one variant can be is_default; it gives the ' +
    'product its title image. Printify renders the mock-ups during the call, so it can take a ' +
    "while. Returns the new product's summary, including its id for update_product.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  input: z.strictObject({
    ...shopIdInput,
    title: titleInput,
    description: descriptionInput,
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
    variants: z
      .array(z.strictObject({ ...variantFields, price: priceInput }))
      .min(1)
      .describe('The variants to offer, each with its price. Disabled ones are kept but not sold.'),
    print_areas: z.array(printAreaInput).min(1),
    ...optionalProductFields,
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const body = pickFields(input, CREATE_FIELDS);
    const created = await createProduct(ctx.client, shopId, body, ctx.signal);
    return { ...summarizeProduct(created) };
  },
});

export const updateProductTool = defineTool({
  name: 'update_product',
  toolset: 'products',
  description:
    'Updates a product. Any of title, description, tags, safety_information, variants, ' +
    'print_areas, print_details, external, is_printify_express_enabled and ' +
    'sales_channel_properties can be given; fields left out keep their value. variants are ' +
    "merged by id into the product's current variants: give only the variants to change, with " +
    'only the fields to change (price in cents, is_enabled, is_default, sku). The tool fetches ' +
    'the product and sends the complete list, because Printify removes every variant missing ' +
    'from an update. Setting is_default on one variant unsets it on the others. A variant id ' +
    'the product does not have is refused; to add or remove variants, pass ' +
    'replace_variants: true with the complete list (every entry with a price) and print_areas ' +
    'that cover the new ids. print_areas, when given, replace all print areas, text layers ' +
    'included. A product that is locked for publishing is refused before anything is sent. ' +
    "Returns the updated product's summary.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  input: z.strictObject({
    ...shopIdInput,
    product_id: productId,
    title: titleInput.optional(),
    description: descriptionInput.optional(),
    variants: z
      .array(z.strictObject({ ...variantFields, price: priceInput.optional() }))
      .min(1)
      .optional()
      .describe('The variants to change, by id, with only the fields to change.'),
    print_areas: z
      .array(printAreaInput)
      .min(1)
      .optional()
      .describe('Replaces every print area of the product.'),
    ...optionalProductFields,
    replace_variants: z
      .boolean()
      .default(false)
      .describe(
        'Send variants exactly as given instead of merging them. Needs the complete list, ' +
          'each with a price; every variant not listed is removed.',
      ),
  }),
  handler: async (input, ctx) => {
    const shopId = await resolveShopId(input, ctx);
    const body = pickFields(input, UPDATE_FIELDS);
    const sentFields = Object.keys(body);
    if (sentFields.length === 0) {
      throw new ToolError(
        'Nothing to update: no field was given.',
        `Give at least one of ${UPDATE_FIELDS.join(', ')}.`,
      );
    }
    checkVariantPatches(input.variants, input.replace_variants);

    const current = await getProduct(ctx.client, shopId, input.product_id, ctx.signal);
    assertUnlocked(current);
    if (input.variants !== undefined && !input.replace_variants) {
      const merged = mergeVariants(current.variants, input.variants);
      if (!merged.ok) {
        throw new ToolError(
          `Product ${current.id} has no variant ${merged.unknownIds.map(String).join(', ')}.`,
          UNKNOWN_VARIANT_HINT,
        );
      }
      body['variants'] = merged.variants;
    }

    const updated = await updateProduct(ctx.client, shopId, input.product_id, body, ctx.signal);
    return { ...summarizeProduct(updated), sent_fields: sentFields };
  },
});

/** Every tool of the `products` toolset, in the order a session uses them. */
export const productsTools: readonly Tool[] = [
  listProductsTool,
  getProductTool,
  getProductGpsrTool,
  createProductTool,
  updateProductTool,
];
