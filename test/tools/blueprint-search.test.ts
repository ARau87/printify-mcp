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

describe('searchBlueprints matching', () => {
  it('matches a word by prefix, so one stem finds Hoodie and Hooded', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'hood' });

    expect(result.matched).toBe('all');
    expect(ids(result)).toEqual([2, 49, 77]);
  });

  it('does not match a word that merely contains the token', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'tee' });

    expect(result.matched).toBe('all');
    // "Tee" in blueprint 6, not "Canteen" (88) or "Steel" (88).
    expect(ids(result)).toEqual([6]);
  });

  it('keeps a number glued to its unit as one token', () => {
    expect(ids(searchBlueprints(CATALOGUE, { query: '11oz' }))).toEqual([12]);
  });

  it('ignores HTML tags when matching the description', () => {
    // "strong" and "p" are markup in blueprint 49, not words.
    expect(searchBlueprints(CATALOGUE, { query: 'strong' }).matches).toEqual([]);
    expect(ids(searchBlueprints(CATALOGUE, { query: 'polyester' }))).toEqual([31]);
  });

  it('ranks a title hit above a description hit for the same token', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'hoodie' });

    expect(result.matched).toBe('all');
    // 2 has "Hoodie" in its title (3), 49 has "hoodie" in its description (1).
    expect(ids(result)).toEqual([2, 49]);
  });

  it('requires every token before it calls a match complete', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'gildan hooded' });

    expect(result.matched).toBe('all');
    expect(result.unmatchedTerms).toEqual([]);
    expect(ids(result)).toEqual([49, 77]);
    expect(result.matches[0]?.matchedTerms).toEqual(['gildan', 'hooded']);
  });

  it('applies the brand filter before matching', () => {
    expect(ids(searchBlueprints(CATALOGUE, { query: 'hood', brand: 'Delta' }))).toEqual([2]);
  });

  it('breaks a tie by title then id', () => {
    const shuffled = [...CATALOGUE].reverse();

    expect(ids(searchBlueprints(shuffled, { query: 'unisex' }))).toEqual(
      ids(searchBlueprints(CATALOGUE, { query: 'unisex' })),
    );
  });

  it('scores a repeated word once', () => {
    const once = searchBlueprints(CATALOGUE, { query: 'hood' });
    const thrice = searchBlueprints(CATALOGUE, { query: 'hood hood hood' });

    expect(thrice.matches.map((match) => match.score)).toEqual(
      once.matches.map((match) => match.score),
    );
    expect(thrice.matches[0]?.matchedTerms).toEqual(['hood']);
  });

  it('uses only the first 12 distinct tokens of a query', () => {
    const junk = Array.from({ length: 12 }, (_, index) => `q${String(index)}`).join(' ');

    // "hood" is the 13th distinct token, so it is dropped before matching: neither matched nor
    // reported as unmatched.
    const result = searchBlueprints(CATALOGUE, { query: `${junk} hood` });

    expect(result.unmatchedTerms).toHaveLength(12);
    expect(result.unmatchedTerms).not.toContain('hood');
    expect(result.matches).toEqual([]);
  });

  it('never matches a blueprint with no searchable fields', () => {
    for (const query of ['hood', 'unisex', 'gildan', '18500']) {
      expect(ids(searchBlueprints(CATALOGUE, { query }))).not.toContain(64);
    }
  });
});
