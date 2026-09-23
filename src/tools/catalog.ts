import { z } from 'zod';
import type { Location } from '../printify/catalog.js';
import { defineTool, type Tool, type ToolAnnotations } from './define.js';
import { omitKeys } from './shape.js';

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

/** Every tool of the `catalog` toolset, in the order the drill-down uses them. */
export const catalogTools: readonly Tool[] = [
  getBlueprintTool,
  listBlueprintProvidersTool,
  listPrintProvidersTool,
];

/** Where the provider is, without the street address the model has no use for. */
function shortLocation(location: Location | undefined) {
  if (location === undefined) return undefined;
  return { city: location.city, region: location.region, country: location.country };
}
