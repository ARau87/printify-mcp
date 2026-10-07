import type { Product, ProductVariant } from '../printify/products.js';
import { ToolError } from './define.js';

/** What `update_product` accepts per variant. Only `id` is required. */
export interface VariantPatch {
  id: number;
  price?: number | undefined;
  is_enabled?: boolean | undefined;
  is_default?: boolean | undefined;
  sku?: string | undefined;
}

/** What the PUT carries per variant: the writable fields only, and no key for an unknown value. */
export interface VariantBody {
  id: number;
  price: number;
  is_enabled?: boolean;
  is_default?: boolean;
  sku?: string;
}

export type MergeResult =
  { ok: true; variants: VariantBody[] } | { ok: false; unknownIds: number[] };

export const LOCKED_HINT =
  'Printify unlocks it when the sales channel reports the publishing result. On a connected ' +
  'shop, wait and try again. On an API shop, call set_publishing_succeeded or ' +
  'set_publishing_failed, then retry.';

/**
 * The complete variant list an update must send: every current variant in its order, with the
 * patched fields replaced. A patch that sets `is_default` makes every other variant not default,
 * since Printify allows one. An id that is not on the product makes the whole merge fail, so a
 * partial list can never be sent by mistake.
 */
export function mergeVariants(
  current: readonly ProductVariant[],
  patches: readonly VariantPatch[],
): MergeResult {
  const known = new Set(current.map((variant) => variant.id));
  const unknownIds = patches.filter((patch) => !known.has(patch.id)).map((patch) => patch.id);
  if (unknownIds.length > 0) return { ok: false, unknownIds };

  const patchById = new Map(patches.map((patch) => [patch.id, patch]));
  const newDefault = patches.some((patch) => patch.is_default === true);
  const variants = current.map((variant) => {
    const patch = patchById.get(variant.id);
    const body: VariantBody = { id: variant.id, price: patch?.price ?? variant.price };
    const isEnabled = patch?.is_enabled ?? variant.is_enabled;
    if (isEnabled !== undefined) body.is_enabled = isEnabled;
    const isDefault = newDefault
      ? patch?.is_default === true
      : (patch?.is_default ?? variant.is_default);
    if (isDefault !== undefined) body.is_default = isDefault;
    const sku = patch?.sku ?? variant.sku;
    if (sku !== undefined) body.sku = sku;
    return body;
  });
  return { ok: true, variants };
}

/** Refuses a product that is locked for publishing, before anything is sent. */
export function assertUnlocked(product: Product): void {
  if (product.is_locked !== true) return;
  // JSON-quoted, so a quote or line break in the title cannot garble the message.
  const title = product.title === undefined ? '' : ` (${JSON.stringify(product.title)})`;
  throw new ToolError(
    `Product ${product.id}${title} is locked because it is being published, and Printify ` +
      'refuses updates to a locked product.',
    LOCKED_HINT,
  );
}
