import { z } from 'zod';
import type { PrintifyClient } from './client.js';
import { invalidResponseError, type Route } from './errors.js';
import { fetchPage } from './pagination.js';
import { apiPath, type ApiPath } from './path.js';
import { lenient } from './schema.js';

// Every object is loose, so `detail: "full"` can return what Printify sent, keys this server does
// not know included. Only `id` and each variant's `id` and `price` are required: an update is
// built on the fetched variant list, and a variant that cannot be resent would be removed by it.
const variantSchema = z.looseObject({
  id: z.number().int(),
  price: z.number(),
  title: lenient(z.string()),
  sku: lenient(z.string()),
  cost: lenient(z.number()),
  grams: lenient(z.number()),
  is_enabled: lenient(z.boolean()),
  is_default: lenient(z.boolean()),
  is_available: lenient(z.boolean()),
  is_printify_express_eligible: lenient(z.boolean()),
  options: lenient(z.array(z.number())),
});

const mockupSchema = z.looseObject({
  src: lenient(z.string()),
  variant_ids: lenient(z.array(z.number())),
  position: lenient(z.string()),
  is_default: lenient(z.boolean()),
});

const placeholderSchema = z.looseObject({
  position: lenient(z.string()),
  images: lenient(z.array(z.looseObject({}))),
});

const printAreaSchema = z.looseObject({
  variant_ids: lenient(z.array(z.number())),
  placeholders: lenient(z.array(placeholderSchema)),
});

const externalSchema = z.looseObject({
  id: lenient(z.string()),
  handle: lenient(z.string()),
  shipping_template_id: lenient(z.string()),
});

const productSchema = z.looseObject({
  id: z.string().min(1),
  title: lenient(z.string()),
  description: lenient(z.string()),
  safety_information: lenient(z.string()),
  tags: lenient(z.array(z.string())),
  blueprint_id: lenient(z.number().int()),
  print_provider_id: lenient(z.number().int()),
  shop_id: lenient(z.number().int()),
  visible: lenient(z.boolean()),
  is_locked: lenient(z.boolean()),
  is_printify_express_eligible: lenient(z.boolean()),
  is_printify_express_enabled: lenient(z.boolean()),
  is_economy_shipping_eligible: lenient(z.boolean()),
  is_economy_shipping_enabled: lenient(z.boolean()),
  external: lenient(z.array(externalSchema)),
  variants: z.array(variantSchema),
  images: lenient(z.array(mockupSchema)),
  print_areas: lenient(z.array(printAreaSchema)),
  created_at: lenient(z.string()),
  updated_at: lenient(z.string()),
});

const gpsrSchema = z.array(z.object({ title: z.string(), text: z.string() }));

/** A product as Printify returns it, with every key it sent. */
export type Product = z.infer<typeof productSchema>;
export type ProductVariant = z.infer<typeof variantSchema>;
export type Mockup = z.infer<typeof mockupSchema>;
export type PrintArea = z.infer<typeof printAreaSchema>;
export type ExternalRef = z.infer<typeof externalSchema>;
/** One section of a product's GPSR information. */
export type GpsrSection = z.infer<typeof gpsrSchema>[number];

export interface ProductPage {
  products: Product[];
  page: number;
  hasMore: boolean;
  total: number | undefined;
  lastPage: number | undefined;
}

function productsPath(shopId: number): ApiPath {
  return apiPath`/v1/shops/${shopId}/products.json`;
}

function productPath(shopId: number, productId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/products/${productId}.json`;
}

/** One page of a shop's products. A `limit` above 50 is lowered by `fetchPage`. */
export async function listProducts(
  client: PrintifyClient,
  shopId: number,
  options: { page?: number; limit?: number },
  signal: AbortSignal,
): Promise<ProductPage> {
  const path = productsPath(shopId);
  const page = await fetchPage(client, 'products', path, { ...options, signal });
  const route: Route = { method: 'GET', path };
  return {
    products: page.items.map((item) => parseProduct(item, route)),
    page: page.page,
    hasMore: page.hasMore,
    total: page.total,
    lastPage: page.lastPage,
  };
}

export async function getProduct(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  signal: AbortSignal,
): Promise<Product> {
  const path = productPath(shopId, productId);
  const body = await client.request('GET', path, { signal });
  return parseProduct(body, { method: 'GET', path });
}

export async function getProductGpsr(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  signal: AbortSignal,
): Promise<GpsrSection[]> {
  const path = apiPath`/v1/shops/${shopId}/products/${productId}/gpsr.json`;
  const body = await client.request('GET', path, { signal });
  const parsed = gpsrSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidResponseError({ method: 'GET', path }, 200, 'an unexpected product response');
  }
  return parsed.data;
}

/** Creates a product. `body` is the tool's validated input, sent as is. */
export async function createProduct(
  client: PrintifyClient,
  shopId: number,
  body: unknown,
  signal: AbortSignal,
): Promise<Product> {
  const path = productsPath(shopId);
  const response = await client.request('POST', path, { body, signal });
  return parseProduct(response, { method: 'POST', path });
}

/** Updates a product. `body` carries only the fields to change; `variants`, if present, complete. */
export async function updateProduct(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Product> {
  const path = productPath(shopId, productId);
  const response = await client.request('PUT', path, { body, signal });
  return parseProduct(response, { method: 'PUT', path });
}

/** Deletes a product. Printify answers `{}`, so no response is read. */
export async function deleteProduct(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  signal: AbortSignal,
): Promise<void> {
  await client.request('DELETE', productPath(shopId, productId), { signal });
}

function parseProduct(body: unknown, route: Route): Product {
  const parsed = productSchema.safeParse(body);
  if (!parsed.success) throw invalidResponseError(route, 200, 'an unexpected product response');
  return parsed.data;
}
