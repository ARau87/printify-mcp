import type { Mockup, PrintArea, Product, ProductVariant } from '../printify/products.js';
import { omitKeys } from './shape.js';

/** A variant as the summary lists it: the fields a price change or a stock question needs. */
export interface VariantRow {
  id: number;
  title: string | undefined;
  sku: string | undefined;
  price: number;
  cost: number | undefined;
  is_enabled: boolean | undefined;
  is_default: boolean | undefined;
  is_available: boolean | undefined;
}

/** One row of `list_products`. */
export interface ProductRow {
  id: string;
  title: string | undefined;
  blueprint_id: number | undefined;
  print_provider_id: number | undefined;
  visible: boolean | undefined;
  is_locked: boolean | undefined;
  variant_count: number;
  enabled_variant_count: number;
  external: { id: string | undefined; handle: string | undefined }[] | undefined;
  updated_at: string | undefined;
}

/** `get_product`'s default view, and what `create_product` and `update_product` return. */
export interface ProductSummary extends ProductRow {
  description: string | undefined;
  safety_information: string | undefined;
  tags: string[] | undefined;
  is_printify_express_eligible: boolean | undefined;
  is_printify_express_enabled: boolean | undefined;
  is_economy_shipping_eligible: boolean | undefined;
  is_economy_shipping_enabled: boolean | undefined;
  created_at: string | undefined;
  variants: VariantRow[];
  /** As Printify sent them, minus each image's `src` and `type`. */
  print_areas: PrintArea[] | undefined;
  /** The `is_default` mock-ups: the title images. */
  mockups: Mockup[] | undefined;
  mockup_count: number | undefined;
}

export function productRow(product: Product): ProductRow {
  return {
    id: product.id,
    title: product.title,
    blueprint_id: product.blueprint_id,
    print_provider_id: product.print_provider_id,
    visible: product.visible,
    is_locked: product.is_locked,
    variant_count: product.variants.length,
    enabled_variant_count: product.variants.filter((variant) => variant.is_enabled === true).length,
    external: product.external?.map(({ id, handle }) => ({ id, handle })),
    updated_at: product.updated_at,
  };
}

export function summarizeProduct(product: Product): ProductSummary {
  return {
    ...productRow(product),
    description: product.description,
    safety_information: product.safety_information,
    tags: product.tags,
    is_printify_express_eligible: product.is_printify_express_eligible,
    is_printify_express_enabled: product.is_printify_express_enabled,
    is_economy_shipping_eligible: product.is_economy_shipping_eligible,
    is_economy_shipping_enabled: product.is_economy_shipping_enabled,
    created_at: product.created_at,
    variants: product.variants.map(variantRow),
    print_areas: product.print_areas?.map(trimPrintArea),
    mockups: product.images?.filter((mockup) => mockup.is_default === true),
    mockup_count: product.images?.length,
  };
}

function variantRow(variant: ProductVariant): VariantRow {
  return {
    id: variant.id,
    title: variant.title,
    sku: variant.sku,
    price: variant.price,
    cost: variant.cost,
    is_enabled: variant.is_enabled,
    is_default: variant.is_default,
    is_available: variant.is_available,
  };
}

/** The print area as sent, with each image's `src` and `type` removed; a text layer keeps its fields. */
function trimPrintArea(area: PrintArea): PrintArea {
  return {
    ...area,
    placeholders: area.placeholders?.map((placeholder) => ({
      ...placeholder,
      images: placeholder.images?.map((image) => omitKeys(image, ['src', 'type'])),
    })),
  };
}
