import { TOOLSETS, type Toolset } from '../toolsets.js';
import { catalogTools } from './catalog.js';
import type { Tool } from './define.js';
import { shopsTools } from './shops.js';

/**
 * Each toolset's tools, from `src/tools/<toolset>.ts`. A toolset's issue replaces its `[]` with
 * its own array, so toolsets never edit the same line.
 */
export const TOOLS_BY_TOOLSET: Readonly<Record<Toolset, readonly Tool[]>> = {
  shops: shopsTools,
  catalog: catalogTools,
  uploads: [],
  products: [],
  publishing: [],
  personalization: [],
  orders: [],
  support: [],
  webhooks: [],
  workflows: [],
};

/** Every tool the server can offer, in `TOOLSETS` order. */
export const ALL_TOOLS: readonly Tool[] = TOOLSETS.flatMap((toolset) => TOOLS_BY_TOOLSET[toolset]);
