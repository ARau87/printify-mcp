import { z } from 'zod';
import { createTtlCache } from '../cache.js';
import type { PrintifyClient, Query } from './client.js';
import { invalidResponseError } from './errors.js';
import { apiPath, type ApiPath } from './path.js';

const HOUR_MS = 3_600_000;

/** Blueprints and print providers change rarely. */
export const STABLE_TTL_MS = 24 * HOUR_MS;
/** Variants carry stock, and shipping carries costs. */
export const VOLATILE_TTL_MS = HOUR_MS;

/** A field Printify may send as null, as the wrong type, or not at all. */
function lenient<T>(schema: z.ZodType<T>) {
  return schema
    .nullable()
    .catch(null)
    .transform((value) => value ?? undefined)
    .optional();
}

const lenientString = lenient(z.string());
const lenientNumber = lenient(z.number());
const lenientStrings = lenient(z.array(z.string()));

const blueprintSchema = z.object({
  id: z.number().int(),
  title: lenientString,
  brand: lenientString,
  model: lenientString,
  description: lenientString,
  images: lenientStrings,
  // Only the single-blueprint response has tags.
  tags: lenientStrings,
});

const blueprintListSchema = z.array(blueprintSchema);

const blueprintProviderSchema = z.object({
  id: z.number().int(),
  title: lenientString,
  decoration_methods: lenientStrings,
});

const blueprintProviderListSchema = z.array(blueprintProviderSchema);

const locationSchema = lenient(
  z.object({
    address1: lenientString,
    address2: lenientString,
    city: lenientString,
    region: lenientString,
    country: lenientString,
    zip: lenientString,
  }),
);

const printProviderSchema = z.object({
  id: z.number().int(),
  title: lenientString,
  location: locationSchema,
});

const printProviderListSchema = z.array(printProviderSchema);

const printProviderDetailSchema = printProviderSchema.extend({
  blueprints: z.array(
    z.object({
      id: z.number().int(),
      title: lenientString,
      brand: lenientString,
      model: lenientString,
    }),
  ),
});

const variantSchema = z.object({
  id: z.number().int(),
  title: lenientString,
  // Strict: the filters read these.
  options: z.record(z.string(), z.string()),
  placeholders: z.array(
    z.object({
      position: z.string(),
      decoration_method: lenientString,
      width: z.number(),
      height: z.number(),
    }),
  ),
});

const variantListSchema = z.object({
  // The print provider's id and title, not the blueprint's.
  id: lenientNumber,
  title: lenientString,
  variants: z.array(variantSchema),
});

const costSchema = z.object({ cost: z.number(), currency: z.string() });

const shippingSchema = z.object({
  handling_time: lenient(z.object({ value: z.number(), unit: z.string() })),
  profiles: z.array(
    z.object({
      variant_ids: z.array(z.number().int()),
      countries: z.array(z.string()),
      first_item: costSchema,
      additional_items: costSchema,
    }),
  ),
});

/** The four shipping methods `get_shipping_costs` can request, in the docs' order. */
export const SHIPPING_METHODS = ['standard', 'priority', 'express', 'economy'] as const;

export type ShippingMethod = (typeof SHIPPING_METHODS)[number];

/** A method name as `shipping.json` lists it: one of the four, or something Printify added. */
export type ShippingMethodName = string;

// The JSON:API envelope is flattened here, so the cache holds names and nothing else. `type`,
// `id` and the `links` object are stripped: the docs' links object has a typo and no use.
const shippingMethodListSchema = z
  .object({ data: z.array(z.object({ attributes: z.object({ name: z.string() }) })) })
  .transform(({ data }): ShippingMethodName[] => data.map((entry) => entry.attributes.name));

export type Blueprint = z.infer<typeof blueprintSchema>;
export type BlueprintProvider = z.infer<typeof blueprintProviderSchema>;
export type PrintProvider = z.infer<typeof printProviderSchema>;
export type PrintProviderDetail = z.infer<typeof printProviderDetailSchema>;
export type VariantList = z.infer<typeof variantListSchema>;
export type Variant = z.infer<typeof variantSchema>;
export type Shipping = z.infer<typeof shippingSchema>;
export type Location = NonNullable<PrintProvider['location']>;

// Function-typed properties, not methods: destructuring a method trips unbound-method.
export interface Catalog {
  /** Every blueprint in the catalog. Cached for 24 h. */
  allBlueprints: (signal: AbortSignal) => Promise<readonly Blueprint[]>;
  /** One blueprint, with its tags. Cached for 24 h. */
  blueprint: (blueprintId: number, signal: AbortSignal) => Promise<Blueprint>;
  /** The print providers that can make a blueprint. Cached for 24 h. */
  blueprintProviders: (
    blueprintId: number,
    signal: AbortSignal,
  ) => Promise<readonly BlueprintProvider[]>;
  /** Every print provider, with locations. Cached for 24 h. */
  printProviders: (signal: AbortSignal) => Promise<readonly PrintProvider[]>;
  /** One print provider with the blueprints it offers. Cached for 24 h. */
  printProvider: (printProviderId: number, signal: AbortSignal) => Promise<PrintProviderDetail>;
  /** A provider's variants for a blueprint. Cached for 1 h, per stock setting. */
  variants: (
    blueprintId: number,
    printProviderId: number,
    options: { showOutOfStock: boolean },
    signal: AbortSignal,
  ) => Promise<VariantList>;
  /** A provider's shipping profiles for a blueprint. Cached for 1 h. */
  shipping: (
    blueprintId: number,
    printProviderId: number,
    signal: AbortSignal,
  ) => Promise<Shipping>;
  /** The shipping methods a provider offers for a blueprint, in Printify's order. 1 h. */
  shippingMethods: (
    blueprintId: number,
    printProviderId: number,
    signal: AbortSignal,
  ) => Promise<readonly ShippingMethodName[]>;
}

export interface CatalogOptions {
  /** Passed to the cache. Defaults to `performance.now`. */
  now?: () => number;
}

/**
 * Reads the Printify catalog through `client` and caches what it parses, per process. Failures,
 * aborts and responses that do not parse are never cached. Cached values are shared by every
 * later caller, so callers must not change them.
 */
export function createCatalog(client: PrintifyClient, options: CatalogOptions = {}): Catalog {
  const cache = createTtlCache<unknown>({ now: options.now });

  async function fetchCached<T>(
    schema: z.ZodType<T>,
    path: ApiPath,
    ttlMs: number,
    signal: AbortSignal,
    query?: Query,
  ): Promise<T> {
    const key = cacheKey(path, query);
    const cached = cache.get(key);
    if (cached !== undefined) return cached as T;
    const body = await client.request('GET', path, { query, signal });
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw invalidResponseError({ method: 'GET', path }, 200, 'an unexpected catalog response');
    }
    cache.set(key, parsed.data, ttlMs);
    return parsed.data;
  }

  return {
    allBlueprints(signal) {
      return fetchCached(
        blueprintListSchema,
        apiPath`/v1/catalog/blueprints.json`,
        STABLE_TTL_MS,
        signal,
      );
    },

    blueprint(blueprintId, signal) {
      return fetchCached(
        blueprintSchema,
        apiPath`/v1/catalog/blueprints/${blueprintId}.json`,
        STABLE_TTL_MS,
        signal,
      );
    },

    blueprintProviders(blueprintId, signal) {
      return fetchCached(
        blueprintProviderListSchema,
        apiPath`/v1/catalog/blueprints/${blueprintId}/print_providers.json`,
        STABLE_TTL_MS,
        signal,
      );
    },

    printProviders(signal) {
      return fetchCached(
        printProviderListSchema,
        apiPath`/v1/catalog/print_providers.json`,
        STABLE_TTL_MS,
        signal,
      );
    },

    printProvider(printProviderId, signal) {
      return fetchCached(
        printProviderDetailSchema,
        apiPath`/v1/catalog/print_providers/${printProviderId}.json`,
        STABLE_TTL_MS,
        signal,
      );
    },

    variants(blueprintId, printProviderId, { showOutOfStock }, signal) {
      return fetchCached(
        variantListSchema,
        apiPath`/v1/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/variants.json`,
        VOLATILE_TTL_MS,
        signal,
        // Left out, the endpoint already lists only the variants in stock.
        showOutOfStock ? { 'show-out-of-stock': 1 } : undefined,
      );
    },

    shipping(blueprintId, printProviderId, signal) {
      return fetchCached(
        shippingSchema,
        apiPath`/v1/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/shipping.json`,
        VOLATILE_TTL_MS,
        signal,
      );
    },

    shippingMethods(blueprintId, printProviderId, signal) {
      return fetchCached(
        shippingMethodListSchema,
        apiPath`/v2/catalog/blueprints/${blueprintId}/print_providers/${printProviderId}/shipping.json`,
        VOLATILE_TTL_MS,
        signal,
      );
    },
  };
}

/** The path with the query as it is sent, so the two stock settings are separate entries. */
function cacheKey(path: ApiPath, query: Query | undefined): string {
  if (query === undefined) return path;
  const params = new URLSearchParams(
    Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]): [string, string] => [name, String(value)]),
  );
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}
