import { describe, expect, it } from 'vitest';
import type { Blueprint } from '../../src/printify/catalog.js';
import { searchBlueprints } from '../../src/tools/blueprint-search.js';
import { SEARCH_BLUEPRINTS } from '../fixtures/catalog.js';

const CATALOGUE: readonly Blueprint[] = SEARCH_BLUEPRINTS;

const ids = (result: { matches: readonly { blueprint: Blueprint }[] }) =>
  result.matches.map((match) => match.blueprint.id);

describe('searchBlueprints browsing', () => {
  it('returns every blueprint sorted by title when there is no query', () => {
    const result = searchBlueprints(CATALOGUE, {});

    expect(result.matched).toBeUndefined();
    expect(result.unmatchedTerms).toEqual([]);
    // adult… < canteen… < classic… < unisex heavy… < unisex hooded… < unisex jersey… < white…
    expect(ids(result)).toEqual([2, 88, 31, 49, 77, 6, 12, 64]);
  });

  it('treats a blank query and a punctuation-only query as browsing', () => {
    for (const query of ['', '   ', '-- //']) {
      const result = searchBlueprints(CATALOGUE, { query });
      expect(result.matched).toBeUndefined();
      expect(result.matches).toHaveLength(CATALOGUE.length);
    }
  });

  it('sorts a blueprint with no title last', () => {
    expect(ids(searchBlueprints(CATALOGUE, {})).at(-1)).toBe(64);
  });

  it('filters by brand, ignoring case and surrounding spaces', () => {
    expect(ids(searchBlueprints(CATALOGUE, { brand: '  gILDAn ' }))).toEqual([49, 77]);
  });

  it('reports nothing to match against when the brand filter leaves no blueprints', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'hooded', brand: 'Nobody' });

    expect(result.matches).toEqual([]);
    expect(result.matched).toBeUndefined();
    expect(result.unmatchedTerms).toEqual([]);
  });

  it("does not reorder the caller's array", () => {
    const input = [...CATALOGUE];
    searchBlueprints(input, {});
    expect(input).toEqual(SEARCH_BLUEPRINTS);
  });
});
