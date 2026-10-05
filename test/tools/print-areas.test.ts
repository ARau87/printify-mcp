import { describe, expect, it } from 'vitest';
import type { Variant } from '../../src/printify/catalog.js';
import { aspectRatio, summarisePrintAreas } from '../../src/tools/print-areas.js';

type Placeholder = Variant['placeholders'][number];

function variantWith(id: number, placeholders: readonly Placeholder[]): Variant {
  return {
    id,
    title: `Variant ${String(id)}`,
    options: { size: 'M' },
    placeholders: [...placeholders],
  };
}

function at(position: string, width: number, height: number, method?: string): Placeholder {
  return { position, decoration_method: method, width, height };
}

describe('summarisePrintAreas with one size per position', () => {
  it('gives one row per position, counting every variant, with no sizes list', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('front', 3153, 3995, 'dtg'), at('back', 3153, 3995, 'dtg')]),
      variantWith(2, [at('front', 3153, 3995, 'dtg'), at('back', 3153, 3995, 'dtg')]),
    ]);

    expect(rows).toEqual([
      {
        position: 'front',
        decoration_method: 'dtg',
        width_px: 3153,
        height_px: 3995,
        aspect_ratio: 0.789,
        variant_count: 2,
      },
      {
        position: 'back',
        decoration_method: 'dtg',
        width_px: 3153,
        height_px: 3995,
        aspect_ratio: 0.789,
        variant_count: 2,
      },
    ]);
    for (const row of rows) expect(row).not.toHaveProperty('sizes');
  });

  it('keeps the rows in the order Printify first lists the positions', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('back', 10, 10, 'dtg'), at('front', 10, 10, 'dtg')]),
      variantWith(2, [
        at('front', 10, 10, 'dtg'),
        at('back', 10, 10, 'dtg'),
        at('neck', 5, 5, 'dtg'),
      ]),
    ]);

    expect(rows.map((row) => row.position)).toEqual(['back', 'front', 'neck']);
    expect(rows.map((row) => row.variant_count)).toEqual([2, 2, 1]);
  });

  it('gives the same position with two methods two rows', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('front', 3153, 3995, 'dtg')]),
      variantWith(2, [at('front', 3153, 3995, 'embroidery')]),
    ]);

    expect(rows).toMatchObject([
      { position: 'front', decoration_method: 'dtg', variant_count: 1 },
      { position: 'front', decoration_method: 'embroidery', variant_count: 1 },
    ]);
  });

  it('keeps a row for a placeholder without a decoration method', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('front', 100, 200)]),
      variantWith(2, [at('front', 100, 200)]),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ position: 'front', variant_count: 2 });
    expect(rows[0]?.decoration_method).toBeUndefined();
  });

  it('counts a variant that lists a position twice once, with the first placeholder', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('front', 100, 200, 'dtg'), at('front', 999, 999, 'dtg')]),
    ]);

    expect(rows).toEqual([
      {
        position: 'front',
        decoration_method: 'dtg',
        width_px: 100,
        height_px: 200,
        aspect_ratio: 0.5,
        variant_count: 1,
      },
    ]);
  });

  it('joins a variant without placeholders to no row, and summarises nothing as nothing', () => {
    expect(
      summarisePrintAreas([variantWith(1, []), variantWith(2, [at('front', 10, 10, 'dtg')])]),
    ).toMatchObject([{ position: 'front', variant_count: 1 }]);
    expect(summarisePrintAreas([])).toEqual([]);
  });

  it('does not change the variants it is given', () => {
    const variants = [
      variantWith(1, [at('front', 100, 200, 'dtg'), at('front', 300, 400, 'dtg')]),
      variantWith(2, [at('front', 100, 200, 'dtg')]),
    ];
    const before = structuredClone(variants);

    summarisePrintAreas(variants);

    expect(variants).toEqual(before);
  });
});

describe('aspectRatio', () => {
  it('rounds width over height to three decimals', () => {
    expect(aspectRatio(3153, 3995)).toBe(0.789);
    expect(aspectRatio(4500, 5100)).toBe(0.882);
    expect(aspectRatio(1200, 1200)).toBe(1);
  });

  it('is absent for a zero height rather than Infinity', () => {
    expect(aspectRatio(100, 0)).toBeUndefined();
    const [row] = summarisePrintAreas([variantWith(1, [at('front', 100, 0, 'dtg')])]);
    expect(row).toMatchObject({ width_px: 100, height_px: 0 });
    expect(row).not.toHaveProperty('aspect_ratio');
  });
});
