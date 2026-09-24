import type { ShippingRow } from '../printify/catalog.js';

/** One rate, and every country and variant it applies to. The shape v1 shipping already uses. */
export interface ShippingProfile {
  countries: string[];
  variant_ids: number[];
  /** The length of `variant_ids`, so the model never has to count the array. */
  variant_count: number;
  first_item: { cost: number; currency: string };
  additional_items: { cost: number; currency: string };
  handling_days?: { from: number; to: number };
}

/**
 * Regroups per-variant, per-country rows into profiles. Two passes: by rate and country first,
 * then merging only the countries whose variant list is identical, so the cross product a profile
 * implies is exactly what Printify sent — a variant priced differently in one country keeps its
 * own profile. Profiles, countries and variant ids all stay in first-appearance order.
 */
export function groupShippingProfiles(rows: readonly ShippingRow[]): ShippingProfile[] {
  const byCountry = new Map<string, { row: ShippingRow; variantIds: number[] }>();
  for (const row of rows) {
    const key = `${row.country}\u0000${rateKey(row)}`;
    const entry = byCountry.get(key);
    if (entry === undefined) {
      byCountry.set(key, { row, variantIds: [row.variant_id] });
    } else if (!entry.variantIds.includes(row.variant_id)) {
      entry.variantIds.push(row.variant_id);
    }
  }

  const profiles = new Map<string, ShippingProfile>();
  for (const { row, variantIds } of byCountry.values()) {
    const key = `${rateKey(row)}\u0000${variantIds.join(',')}`;
    const profile = profiles.get(key);
    if (profile !== undefined) {
      if (!profile.countries.includes(row.country)) profile.countries.push(row.country);
      continue;
    }
    const created: ShippingProfile = {
      countries: [row.country],
      variant_ids: variantIds,
      variant_count: variantIds.length,
      first_item: row.first_item,
      additional_items: row.additional_items,
    };
    // Set conditionally, so a provider that sends no handling time has no such key at all.
    if (row.handling_days !== undefined) created.handling_days = row.handling_days;
    profiles.set(key, created);
  }
  return [...profiles.values()];
}

/** Everything two rows must agree on to belong to the same profile. */
function rateKey(row: ShippingRow): string {
  const handling = row.handling_days;
  return JSON.stringify([
    row.first_item.cost,
    row.first_item.currency,
    row.additional_items.cost,
    row.additional_items.currency,
    handling === undefined ? null : [handling.from, handling.to],
  ]);
}
