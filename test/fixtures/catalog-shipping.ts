/** Catalog v2 shipping fixtures, from https://developers.printify.com/#catalog-v2. */

/** The four documented methods, or whichever names a test needs. */
export function methodList(
  names: readonly string[] = ['standard', 'priority', 'express', 'economy'],
) {
  return {
    data: names.map((name, index) => ({
      type: 'shipping_method',
      id: String(index + 1),
      attributes: { name },
    })),
    // The docs' own links object has a typo (priority twice); nothing may read it.
    links: {
      standard:
        'https://api.printify.com/v2/catalog/blueprints/3/print_providers/29/shipping/standard.json',
    },
  };
}

/** The documented response: all four methods. */
export const SHIPPING_METHOD_LIST = methodList();
