import { z } from 'zod';
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

/** Every tool of the `catalog` toolset, in the order the drill-down uses them. */
export const catalogTools: readonly Tool[] = [getBlueprintTool];
