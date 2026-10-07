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

describe('summarisePrintAreas with several sizes per position', () => {
  it('headlines the largest size and lists every size with its variant ids', () => {
    const rows = summarisePrintAreas([
      variantWith(1, [at('front', 3600, 4800, 'dtg'), at('back', 4500, 5100, 'dtg')]),
      variantWith(2, [at('front', 4500, 5100, 'dtg'), at('back', 4500, 5100, 'dtg')]),
      variantWith(3, [at('front', 3600, 4800, 'dtg'), at('back', 4500, 5100, 'dtg')]),
    ]);

    expect(rows).toEqual([
      {
        position: 'front',
        decoration_method: 'dtg',
        width_px: 4500,
        height_px: 5100,
        aspect_ratio: 0.882,
        variant_count: 3,
        sizes: [
          {
            width_px: 4500,
            height_px: 5100,
            aspect_ratio: 0.882,
            variant_count: 1,
            variant_ids: [2],
          },
          {
            width_px: 3600,
            height_px: 4800,
            aspect_ratio: 0.75,
            variant_count: 2,
            variant_ids: [1, 3],
          },
        ],
      },
      {
        position: 'back',
        decoration_method: 'dtg',
        width_px: 4500,
        height_px: 5100,
        aspect_ratio: 0.882,
        variant_count: 3,
      },
    ]);
    expect(rows[1]).not.toHaveProperty('sizes');
  });

  it('lets a wider but shorter size win the headline', () => {
    const [row] = summarisePrintAreas([
      variantWith(1, [at('front', 3000, 6000, 'dtg')]),
      variantWith(2, [at('front', 4000, 2000, 'dtg')]),
    ]);

    expect(row).toMatchObject({ width_px: 4000, height_px: 2000, aspect_ratio: 2 });
    expect(row?.sizes?.map((size) => size.width_px)).toEqual([4000, 3000]);
  });

  it('breaks an equal width by the greater height', () => {
    const [row] = summarisePrintAreas([
      variantWith(1, [at('front', 4000, 2000, 'dtg')]),
      variantWith(2, [at('front', 4000, 5000, 'dtg')]),
      variantWith(3, [at('front', 4000, 3000, 'dtg')]),
    ]);

    expect(row).toMatchObject({ width_px: 4000, height_px: 5000 });
    expect(row?.sizes?.map((size) => size.height_px)).toEqual([5000, 3000, 2000]);
  });

  it('keeps variant ids in catalog order within a size, not sorted', () => {
    const [row] = summarisePrintAreas([
      variantWith(30, [at('front', 100, 100, 'dtg')]),
      variantWith(10, [at('front', 200, 200, 'dtg')]),
      variantWith(20, [at('front', 100, 100, 'dtg')]),
    ]);

    expect(row?.sizes).toEqual([
      { width_px: 200, height_px: 200, aspect_ratio: 1, variant_count: 1, variant_ids: [10] },
      { width_px: 100, height_px: 100, aspect_ratio: 1, variant_count: 2, variant_ids: [30, 20] },
    ]);
  });
});
