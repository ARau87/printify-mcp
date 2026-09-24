import { z } from 'zod';
import {
  SHIPPING_METHODS,
  type Location,
  type ShippingRow,
  type Variant,
  type VariantList,
} from '../printify/catalog.js';
import { defineTool, type Tool, type ToolAnnotations } from './define.js';
import { omitKeys } from './shape.js';
import { groupShippingProfiles } from './shipping-profiles.js';

/** The blueprints `get_print_provider` lists before it truncates. */
export const PROVIDER_BLUEPRINT_LIMIT = 50;

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

const blueprintId = z
  .number()
  .int()
  .positive()
  .describe('The catalog blueprint id, e.g. from get_print_provider.');

const printProviderId = z
  .number()
  .int()
  .positive()
  .describe('The print provider id, e.g. from list_blueprint_providers.');

const optionFilter = (option: string) =>
  z
    .array(z.string().min(1))
    .min(1)
    .max(50)
    .optional()
    .describe(
      `Only variants whose ${option} is one of these. Exact names, ignoring case and surrounding ` +
        `spaces; option_values lists every name.`,
    );

const shippingCountry = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    /^([A-Z]{2}|REST_OF_THE_WORLD)$/,
    'country must be a two-letter ISO code such as DE, or REST_OF_THE_WORLD',
  )
  .optional()
  .describe(
    'Only the costs that apply to this country, as an ISO 3166-1 alpha-2 code such as DE. When ' +
      'no rate names it, the REST_OF_THE_WORLD rate is returned and matched says so.',
  );

const shippingVariantIds = z
  .array(z.number().int().positive())
  .min(1)
  .max(100)
  .optional()
  .describe(
    'Only the costs for these variant ids, e.g. from list_variants. Leave it out for every ' +
      'variant; an empty list is an error.',
  );

export const getBlueprintTool = defineTool({
  name: 'get_blueprint',
  toolset: 'catalog',
  description:
    'Gets one catalog blueprint (a product template such as a t-shirt or a mug) by id: its ' +
    'title, brand, model, description and tags. Next, list_blueprint_providers shows who can ' +
    'print it.',
  annotations: READ_ONLY,
  input: z.strictObject({
    blueprint_id: blueprintId,
    include_images: z
      .boolean()
      .default(false)
      .describe("Also return the blueprint's catalog photos as URLs."),
  }),
  handler: async (input, ctx) => {
    const blueprint = await ctx.catalog.blueprint(input.blueprint_id, ctx.signal);
    return input.include_images ? { ...blueprint } : omitKeys(blueprint, ['images']);
  },
});

export const listBlueprintProvidersTool = defineTool({
  name: 'list_blueprint_providers',
  toolset: 'catalog',
  description:
    "Lists the print providers that can make a blueprint, with each one's decoration methods " +
    '(such as dtg or embroidery) and location. Pick a provider, then use list_variants for its ' +
    'sizes and colors and get_shipping_info for its shipping costs.',
  annotations: READ_ONLY,
  input: z.strictObject({ blueprint_id: blueprintId }),
  handler: async (input, ctx) => {
    // The blueprint's providers carry no location, so they are joined with the provider list.
    const [providers, directory] = await Promise.all([
      ctx.catalog.blueprintProviders(input.blueprint_id, ctx.signal),
      ctx.catalog.printProviders(ctx.signal),
    ]);
    const locations = new Map(directory.map((provider) => [provider.id, provider.location]));
    return {
      blueprint_id: input.blueprint_id,
      print_providers: providers.map((provider) => ({
        ...provider,
        location: shortLocation(locations.get(provider.id)),
      })),
    };
  },
});

export const listVariantsTool = defineTool({
  name: 'list_variants',
  toolset: 'catalog',
  description:
    'Lists the variants (the size and color combinations) a print provider offers for a ' +
    'blueprint. Each has the variant id that products and orders use, its options, and its ' +
    'print positions with their size in pixels. Filter with colors and sizes: exact names, ' +
    'ignoring case, and option_values lists every name. Only variants in stock are listed ' +
    'unless show_out_of_stock is set; then every variant says whether it is in_stock.',
  annotations: READ_ONLY,
  input: z.strictObject({
    blueprint_id: blueprintId,
    print_provider_id: printProviderId,
    colors: optionFilter('color'),
    sizes: optionFilter('size'),
    show_out_of_stock: z
      .boolean()
      .default(false)
      .describe('Also list the variants that are out of stock, marked in_stock: false.'),
  }),
  handler: async (input, ctx) => {
    const { blueprint_id: blueprint, print_provider_id: provider } = input;
    let list: VariantList;
    let inStockIds: Set<number> | undefined;
    if (input.show_out_of_stock) {
      const [all, inStock] = await Promise.all([
        ctx.catalog.variants(blueprint, provider, { showOutOfStock: true }, ctx.signal),
        ctx.catalog.variants(blueprint, provider, { showOutOfStock: false }, ctx.signal),
      ]);
      list = all;
      inStockIds = new Set(inStock.variants.map((variant) => variant.id));
    } else {
      list = await ctx.catalog.variants(blueprint, provider, { showOutOfStock: false }, ctx.signal);
    }

    const matched = list.variants.filter(
      (variant) =>
        matchesOption(variant, 'color', input.colors) &&
        matchesOption(variant, 'size', input.sizes),
    );
    return {
      print_provider: { id: list.id, title: list.title },
      total_variants: list.variants.length,
      variant_count: matched.length,
      option_values: optionValues(list.variants),
      variants: matched.map((variant) => ({
        id: variant.id,
        title: variant.title,
        options: variant.options,
        placeholders: variant.placeholders,
        in_stock: inStockIds === undefined ? undefined : inStockIds.has(variant.id),
      })),
    };
  },
});

export const listPrintProvidersTool = defineTool({
  name: 'list_print_providers',
  toolset: 'catalog',
  description:
    'Lists every Printify print provider with its id, name and location. To find the providers ' +
    'that can make a particular product, use list_blueprint_providers instead.',
  annotations: READ_ONLY,
  input: z.strictObject({}),
  handler: async (_input, ctx) => {
    const providers = await ctx.catalog.printProviders(ctx.signal);
    return {
      print_providers: providers.map((provider) => ({
        id: provider.id,
        title: provider.title,
        location: shortLocation(provider.location),
      })),
    };
  },
});

export const getShippingInfoTool = defineTool({
  name: 'get_shipping_info',
  toolset: 'catalog',
  description:
    "Gets a print provider's shipping costs and handling time for a blueprint. Each profile " +
    'covers a set of countries and variant ids; REST_OF_THE_WORLD covers every country no ' +
    'profile lists. Costs are in cents of currency (450 = 4.50 USD): first_item is charged for ' +
    'the first item of this blueprint and provider in an order, additional_items for every ' +
    'further one. The costs are not broken down by shipping method.',
  annotations: READ_ONLY,
  input: z.strictObject({ blueprint_id: blueprintId, print_provider_id: printProviderId }),
  handler: async (input, ctx) => {
    const shipping = await ctx.catalog.shipping(
      input.blueprint_id,
      input.print_provider_id,
      ctx.signal,
    );
    return { ...shipping };
  },
});

export const getPrintProviderTool = defineTool({
  name: 'get_print_provider',
  toolset: 'catalog',
  description:
    'Gets one print provider: its name, its address, and the blueprints it offers (id, title, ' +
    `brand and model). Only the first ${String(PROVIDER_BLUEPRINT_LIMIT)} blueprints are ` +
    'listed; blueprint_count gives the total.',
  annotations: READ_ONLY,
  input: z.strictObject({ print_provider_id: printProviderId }),
  handler: async (input, ctx) => {
    const provider = await ctx.catalog.printProvider(input.print_provider_id, ctx.signal);
    const truncated = provider.blueprints.length > PROVIDER_BLUEPRINT_LIMIT;
    return {
      id: provider.id,
      title: provider.title,
      location: provider.location,
      blueprint_count: provider.blueprints.length,
      blueprints: provider.blueprints.slice(0, PROVIDER_BLUEPRINT_LIMIT),
      blueprints_truncated: truncated ? true : undefined,
    };
  },
});

export const listShippingMethodsTool = defineTool({
  name: 'list_shipping_methods',
  toolset: 'catalog',
  description:
    'Lists the shipping methods a print provider offers for a blueprint: standard, priority, ' +
    'express or economy. Economy rates exist only here, not in get_shipping_info. Use ' +
    'get_shipping_costs for what each method costs.',
  annotations: READ_ONLY,
  input: z.strictObject({ blueprint_id: blueprintId, print_provider_id: printProviderId }),
  handler: async (input, ctx) => {
    const methods = await ctx.catalog.shippingMethods(
      input.blueprint_id,
      input.print_provider_id,
      ctx.signal,
    );
    return {
      blueprint_id: input.blueprint_id,
      print_provider_id: input.print_provider_id,
      methods,
    };
  },
});

export const getShippingCostsTool = defineTool({
  name: 'get_shipping_costs',
  toolset: 'catalog',
  description:
    "Gets a print provider's shipping costs and handling time for a blueprint, broken down by " +
    'shipping method. Filter with country (an ISO code such as DE) and with variant_ids from ' +
    'list_variants. Costs are in cents of ' +
    'currency (399 = 3.99 USD): first_item is charged for the first item of this blueprint and ' +
    "provider in an order, additional_items for every further one. A profile's rate applies to " +
    'every country and variant it lists. REST_OF_THE_WORLD covers every country no profile ' +
    'names; matched says when a country fell back to it. For a single overall rate in one ' +
    'request, use get_shipping_info.',
  annotations: READ_ONLY,
  input: z.strictObject({
    blueprint_id: blueprintId,
    print_provider_id: printProviderId,
    method: z.enum(SHIPPING_METHODS).describe('The shipping method to price.'),
    country: shippingCountry,
    variant_ids: shippingVariantIds,
  }),
  handler: async (input, ctx) => {
    const all = await ctx.catalog.shippingCosts(
      input.blueprint_id,
      input.print_provider_id,
      input.method,
      ctx.signal,
    );
    const wanted = input.variant_ids === undefined ? undefined : new Set(input.variant_ids);
    const forVariants =
      wanted === undefined ? all : all.filter((row) => wanted.has(row.variant_id));
    const { rows, matched } = matchCountry(forVariants, input.country);
    const profiles = groupShippingProfiles(rows);
    return {
      blueprint_id: input.blueprint_id,
      print_provider_id: input.print_provider_id,
      country: input.country,
      methods: [{ method: input.method, matched, profile_count: profiles.length, profiles }],
    };
  },
});

/** Every tool of the `catalog` toolset, in the order the drill-down uses them. */
export const catalogTools: readonly Tool[] = [
  getBlueprintTool,
  listBlueprintProvidersTool,
  listVariantsTool,
  getShippingInfoTool,
  listPrintProvidersTool,
  getPrintProviderTool,
  listShippingMethodsTool,
  getShippingCostsTool,
];

/** Where the provider is, without the street address the model has no use for. */
function shortLocation(location: Location | undefined) {
  if (location === undefined) return undefined;
  return { city: location.city, region: location.region, country: location.country };
}

/** True when no filter is set, or one of its values is the variant's option, ignoring case. */
function matchesOption(
  variant: Variant,
  option: string,
  wanted: readonly string[] | undefined,
): boolean {
  if (wanted === undefined) return true;
  const value = variant.options[option];
  if (value === undefined) return false;
  const normalised = value.trim().toLowerCase();
  return wanted.some((name) => name.trim().toLowerCase() === normalised);
}

/** Each option's distinct values, in the order Printify sends them. */
function optionValues(variants: readonly Variant[]): Record<string, string[]> {
  const values: Record<string, string[]> = {};
  for (const variant of variants) {
    for (const [option, value] of Object.entries(variant.options)) {
      const seen = (values[option] ??= []);
      if (!seen.includes(value)) seen.push(value);
    }
  }
  return values;
}

const REST_OF_THE_WORLD = 'REST_OF_THE_WORLD';

/** How a country filter matched: not at all, by name, or through the catch-all rate. */
type CountryMatch = 'country' | 'rest_of_the_world' | 'none';

/**
 * The rows that apply to `country`. Printify lists only the countries it charges a specific rate
 * for, so a country with no row of its own is shipped at the REST_OF_THE_WORLD rate — returned
 * here, but never silently: `matched` says which rate this is.
 */
function matchCountry(
  rows: readonly ShippingRow[],
  country: string | undefined,
): { rows: readonly ShippingRow[]; matched: CountryMatch | undefined } {
  if (country === undefined) return { rows, matched: undefined };
  const named = rows.filter((row) => row.country.toUpperCase() === country);
  if (named.length > 0) return { rows: named, matched: 'country' };
  const rest = rows.filter((row) => row.country.toUpperCase() === REST_OF_THE_WORLD);
  if (rest.length > 0) return { rows: rest, matched: 'rest_of_the_world' };
  return { rows: [], matched: 'none' };
}
