import { TOOLSETS, type Toolset } from '../toolsets.js';
import { catalogTools } from './catalog.js';
import type { Tool } from './define.js';

/** Each toolset's tools. A toolset issue fills in its own line. */
export const TOOLS_BY_TOOLSET: Readonly<Record<Toolset, readonly Tool[]>> = {
  shops: [],
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
