import { describe, expect, it } from 'vitest';
import type { ShippingRow } from '../../src/printify/catalog.js';
import { groupShippingProfiles } from '../../src/tools/shipping-profiles.js';

/** A row with the usual rate, so a test only states what it varies. */
function row(overrides: Partial<ShippingRow> = {}): ShippingRow {
  return {
    variant_id: 1,
    country: 'US',
    first_item: { cost: 399, currency: 'USD' },
    additional_items: { cost: 219, currency: 'USD' },
    handling_days: { from: 4, to: 8 },
    ...overrides,
  };
}

describe('groupShippingProfiles', () => {
  it('returns no profiles for no rows', () => {
    expect(groupShippingProfiles([])).toEqual([]);
  });

  it('collapses one rate over many variants into one profile', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1 }),
      row({ variant_id: 2 }),
      row({ variant_id: 3 }),
    ]);

    expect(profiles).toEqual([
      {
        countries: ['US'],
        variant_ids: [1, 2, 3],
        variant_count: 3,
        first_item: { cost: 399, currency: 'USD' },
        additional_items: { cost: 219, currency: 'USD' },
        handling_days: { from: 4, to: 8 },
      },
    ]);
  });

  it('merges countries that share a rate and the same variants', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1, country: 'US' }),
      row({ variant_id: 2, country: 'US' }),
      row({ variant_id: 1, country: 'CA' }),
      row({ variant_id: 2, country: 'CA' }),
    ]);

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.countries).toEqual(['US', 'CA']);
    expect(profiles[0]?.variant_ids).toEqual([1, 2]);
  });

  it('keeps countries apart when the same rate covers different variants', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1, country: 'US' }),
      row({ variant_id: 1, country: 'CA' }),
      row({ variant_id: 2, country: 'CA' }),
    ]);

    expect(profiles.map((profile) => profile.countries)).toEqual([['US'], ['CA']]);
    expect(profiles.map((profile) => profile.variant_ids)).toEqual([[1], [1, 2]]);
  });

  it('does not fold a variant priced differently in one country into the others', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1, country: 'US' }),
      row({ variant_id: 2, country: 'US' }),
      row({ variant_id: 3, country: 'US', first_item: { cost: 599, currency: 'USD' } }),
      row({ variant_id: 1, country: 'CA' }),
      row({ variant_id: 2, country: 'CA' }),
      row({ variant_id: 3, country: 'CA' }),
    ]);

    expect(profiles).toEqual([
      expect.objectContaining({ countries: ['US'], variant_ids: [1, 2] }),
      expect.objectContaining({
        countries: ['US'],
        variant_ids: [3],
        first_item: { cost: 599, currency: 'USD' },
      }),
      expect.objectContaining({ countries: ['CA'], variant_ids: [1, 2, 3] }),
    ]);
  });

  it('does not merge rows that differ only in handling time', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1, handling_days: { from: 4, to: 8 } }),
      row({ variant_id: 2, handling_days: { from: 1, to: 3 } }),
    ]);

    expect(profiles).toHaveLength(2);
  });

  it('does not merge rows that differ only in currency', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1 }),
      row({ variant_id: 2, first_item: { cost: 399, currency: 'EUR' } }),
    ]);

    expect(profiles).toHaveLength(2);
  });

  it('does not merge rows that differ only in the additional-item cost', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1 }),
      row({ variant_id: 2, additional_items: { cost: 299, currency: 'USD' } }),
    ]);

    expect(profiles).toHaveLength(2);
  });

  it('does not merge rows that differ only in the additional-item currency', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1 }),
      row({ variant_id: 2, additional_items: { cost: 219, currency: 'EUR' } }),
    ]);

    expect(profiles).toHaveLength(2);
  });

  it('omits handling_days entirely when the rows have none', () => {
    const profiles = groupShippingProfiles([row({ handling_days: undefined })]);

    expect(profiles[0]).not.toHaveProperty('handling_days');
  });

  it('does not merge a row with a handling time into one without', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 1, handling_days: undefined }),
      row({ variant_id: 2 }),
    ]);

    expect(profiles).toHaveLength(2);
  });

  it('keeps Printify order for profiles, countries and variant ids', () => {
    const profiles = groupShippingProfiles([
      row({ variant_id: 9, country: 'GB', first_item: { cost: 700, currency: 'USD' } }),
      row({ variant_id: 3, country: 'US' }),
      row({ variant_id: 1, country: 'US' }),
      row({ variant_id: 3, country: 'CA' }),
      row({ variant_id: 1, country: 'CA' }),
    ]);

    expect(profiles[0]?.countries).toEqual(['GB']);
    expect(profiles[1]?.countries).toEqual(['US', 'CA']);
    expect(profiles[1]?.variant_ids).toEqual([3, 1]);
  });

  it('counts every variant it lists, however many there are', () => {
    const rows = Array.from({ length: 120 }, (_unused, index) => row({ variant_id: index + 1 }));

    const profiles = groupShippingProfiles(rows);

    expect(profiles[0]?.variant_ids).toHaveLength(120);
    expect(profiles[0]?.variant_count).toBe(120);
  });

  it('ignores a repeated variant id in one country', () => {
    const profiles = groupShippingProfiles([row({ variant_id: 1 }), row({ variant_id: 1 })]);

    expect(profiles[0]?.variant_ids).toEqual([1]);
    expect(profiles[0]?.variant_count).toBe(1);
  });
});
