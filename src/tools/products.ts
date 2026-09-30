import { z } from 'zod';
import { PAGE_LIMITS } from '../printify/pagination.js';
import { getProduct, getProductGpsr, listProducts } from '../printify/products.js';
import { defineTool, type Tool, type ToolAnnotations } from './define.js';
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

/** Every tool of the `products` toolset, in the order a session uses them. */
export const productsTools: readonly Tool[] = [
  listProductsTool,
  getProductTool,
  getProductGpsrTool,
];
