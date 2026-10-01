import { describe, expect, it } from 'vitest';
import type { Variant } from '../../src/printify/catalog.js';
import { ToolError } from '../../src/tools/define.js';
import {
  checkPositions,
  checkPriceSizes,
  groupByPlaceholders,
  selectVariants,
} from '../../src/tools/variant-selection.js';

const REGULAR = { width: 4000, height: 5000 };
const LARGE = { width: 4800, height: 5000 };

function tee(id: number, color: string, size: string, front = REGULAR): Variant {
  return {
    id,
    title: `${color} / ${size}`,
    options: { color, size },
    placeholders: [
      { position: 'front', decoration_method: 'dtg', ...front },
      { position: 'back', decoration_method: 'dtg', ...REGULAR },
    ],
  };
}

const TEES = [tee(1, 'Black', 'S'), tee(2, 'Black', 'M'), tee(3, 'White', 'S'), tee(4, 'Red', 'M')];

/** Runs `run`, expecting a ToolError, and returns it. */
function toolError(run: () => unknown): ToolError {
  try {
    run();
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error('expected a ToolError, nothing was thrown');
}

describe('selectVariants', () => {
  it('keeps every variant when no filter is given', () => {
    expect(selectVariants(TEES, {}).map((variant) => variant.id)).toEqual([1, 2, 3, 4]);
  });

  it('matches colors and sizes ignoring case and surrounding spaces', () => {
    const selected = selectVariants(TEES, { colors: [' black', 'WHITE '], sizes: ['s'] });
    expect(selected.map((variant) => variant.id)).toEqual([1, 3]);
  });

  it('names an unknown color and lists the colors in stock', () => {
    const error = toolError(() => selectVariants(TEES, { colors: ['Black', 'Neon', 'Pink'] }));
    expect(error.message).toBe(
      'Unknown colors: "Neon", "Pink". The colors in stock are: Black, White, Red.',
    );
  });

  it('names an unknown size and lists the sizes in stock', () => {
    const error = toolError(() => selectVariants(TEES, { sizes: ['XXL'] }));
    expect(error.message).toBe('Unknown sizes: "XXL". The sizes in stock are: S, M.');
  });

  it('refuses a combination no variant has', () => {
    const error = toolError(() => selectVariants(TEES, { colors: ['White'], sizes: ['M'] }));
    expect(error.message).toBe(
      'No variant in stock has one of the colors White in one of the sizes M.',
    );
  });

  it('refuses when nothing is in stock', () => {
    expect(toolError(() => selectVariants([], {})).message).toBe(
      'No variant of this blueprint is in stock at this print provider.',
    );
  });

  it('says so when the variants have no size option at all', () => {
    const poster: Variant = {
      id: 9,
      title: 'Matte',
      options: { paper: 'Matte' },
      placeholders: [{ position: 'front', decoration_method: undefined, ...REGULAR }],
    };
    const error = toolError(() => selectVariants([poster], { sizes: ['M'] }));
    expect(error.message).toBe('These variants have no size option, so sizes cannot filter them.');
  });
});

describe('checkPositions', () => {
  it('accepts positions every selected variant has', () => {
    expect(() => {
      checkPositions(TEES, ['front', 'back']);
    }).not.toThrow();
  });

  it('names the positions the selected variants have', () => {
    const error = toolError(() => {
      checkPositions(TEES, ['sleeve']);
    });
    expect(error.message).toBe(
      '"sleeve" is not a print position of 4 of the 4 selected variants. Every selected ' +
        'variant has: front, back.',
    );
  });

  it('counts only the variants that lack the position', () => {
    const frontOnly: Variant = {
      ...tee(5, 'Blue', 'S'),
      placeholders: [{ position: 'front', decoration_method: 'dtg', ...REGULAR }],
    };
    const error = toolError(() => {
      checkPositions([...TEES, frontOnly], ['back']);
    });
    expect(error.message).toBe(
      '"back" is not a print position of 1 of the 5 selected variants. Every selected ' +
        'variant has: front.',
    );
  });

  it('refuses a position given twice', () => {
    const error = toolError(() => {
      checkPositions(TEES, ['front', 'front']);
    });
    expect(error.message).toBe('Two designs use the position "front".');
  });
});

describe('checkPriceSizes', () => {
  it('accepts by_size keys that match a selected size in any case', () => {
    expect(() => {
      checkPriceSizes(TEES, { m: 2799, ' S ': 2499 });
    }).not.toThrow();
  });

  it('accepts no by_size at all', () => {
    expect(() => {
      checkPriceSizes(TEES, undefined);
    }).not.toThrow();
  });

  it('refuses a by_size key that matches no selected size', () => {
    const error = toolError(() => {
      checkPriceSizes(TEES, { M: 2799, '2XL': 2999 });
    });
    expect(error.message).toBe(
      'price.by_size names sizes no selected variant has: "2XL". The selected sizes are: S, M.',
    );
  });

  it('says "none" when the selected variants have no size', () => {
    const poster: Variant = { ...tee(9, 'White', 'S'), options: { paper: 'Matte' } };
    const error = toolError(() => {
      checkPriceSizes([poster], { S: 999 });
    });
    expect(error.message).toBe(
      'price.by_size names sizes no selected variant has: "S". The selected sizes are: none.',
    );
  });
});

describe('groupByPlaceholders', () => {
  it('puts variants with the same placeholder sizes in one group', () => {
    expect(groupByPlaceholders(TEES, ['front'])).toEqual([
      { variantIds: [1, 2, 3, 4], placeholders: new Map([['front', REGULAR]]) },
    ]);
  });

  it('splits by placeholder size, sorts groups by lowest id and ids ascending', () => {
    const variants = [
      tee(203, 'Black', '2XL', LARGE),
      tee(201, 'Black', 'M'),
      tee(202, 'White', '2XL', LARGE),
      tee(200, 'Black', 'S'),
    ];
    expect(groupByPlaceholders(variants, ['front', 'back'])).toEqual([
      {
        variantIds: [200, 201],
        placeholders: new Map([
          ['front', REGULAR],
          ['back', REGULAR],
        ]),
      },
      {
        variantIds: [202, 203],
        placeholders: new Map([
          ['front', LARGE],
          ['back', REGULAR],
        ]),
      },
    ]);
  });

  it('ignores the sizes of positions that were not requested', () => {
    const variants = [tee(1, 'Black', 'S'), tee(2, 'Black', '2XL', LARGE)];
    expect(groupByPlaceholders(variants, ['back'])).toHaveLength(1);
  });
});
