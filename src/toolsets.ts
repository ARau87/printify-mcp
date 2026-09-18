/** Every toolset `PRINTIFY_TOOLSETS` can enable, in the order help text and logs list them. */
export const TOOLSETS = [
  'shops',
  'catalog',
  'uploads',
  'products',
  'publishing',
  'personalization',
  'orders',
  'support',
  'webhooks',
  'workflows',
] as const;

export type Toolset = (typeof TOOLSETS)[number];

export function isToolset(name: string): name is Toolset {
  return (TOOLSETS as readonly string[]).includes(name);
}
