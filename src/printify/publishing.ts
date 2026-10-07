import type { PrintifyClient } from './client.js';
import { apiPath, type ApiPath } from './path.js';

/**
 * The publish request body, in Printify's spelling. A flag set to `false` keeps that part of the
 * listing as it is in the sales channel.
 */
export interface PublishFlags {
  title: boolean;
  description: boolean;
  images: boolean;
  variants: boolean;
  tags: boolean;
  keyFeatures: boolean;
  shipping_template: boolean;
}

/** The listing's reference in the sales channel, as `publishing_succeeded` records it. */
export interface ExternalListing {
  id: string;
  handle: string;
}

function publishPath(shopId: number, productId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/products/${productId}/publish.json`;
}

function succeededPath(shopId: number, productId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/products/${productId}/publishing_succeeded.json`;
}

function failedPath(shopId: number, productId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/products/${productId}/publishing_failed.json`;
}

function unpublishPath(shopId: number, productId: string): ApiPath {
  return apiPath`/v1/shops/${shopId}/products/${productId}/unpublish.json`;
}

// Every endpoint here answers `{}`, so none of these reads the response, like `deleteProduct`.

/**
 * Publishes a product: on a connected shop Printify updates the listing, on an API shop it only
 * locks the product and fires `product:publish:started`.
 */
export async function publishProduct(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  flags: PublishFlags,
  signal: AbortSignal,
): Promise<void> {
  await client.request('POST', publishPath(shopId, productId), { body: flags, signal });
}

/** Unlocks a product and records the listing's id and handle. */
export async function setPublishingSucceeded(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  external: ExternalListing,
  signal: AbortSignal,
): Promise<void> {
  await client.request('POST', succeededPath(shopId, productId), {
    body: { external },
    signal,
  });
}

/** Unlocks a product; `reason` is shown in the Printify app. */
export async function setPublishingFailed(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  reason: string,
  signal: AbortSignal,
): Promise<void> {
  await client.request('POST', failedPath(shopId, productId), { body: { reason }, signal });
}

/** Tells Printify the listing was removed from the sales channel. No body is documented. */
export async function setProductUnpublished(
  client: PrintifyClient,
  shopId: number,
  productId: string,
  signal: AbortSignal,
): Promise<void> {
  await client.request('POST', unpublishPath(shopId, productId), { signal });
}
