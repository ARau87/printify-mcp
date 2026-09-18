import { describe, expect, it } from 'vitest';
import { closest, editDistance } from '../src/suggest.js';

describe('editDistance', () => {
  it.each([
    ['', '', 0],
    ['abc', '', 3],
    ['', 'abc', 3],
    ['orders', 'orders', 0],
    ['prodcts', 'products', 1],
    ['kitten', 'sitting', 3],
  ])('%j to %j is %i', (a, b, expected) => {
    expect(editDistance(a, b)).toBe(expected);
  });
});

describe('closest', () => {
  const candidates = ['shops', 'catalog', 'products', 'orders'];

  it('returns the nearest candidate within the limit', () => {
    expect(closest('prodcts', candidates)).toBe('products');
  });

  it('returns undefined when no candidate is close enough', () => {
    expect(closest('zzzzzzzz', candidates)).toBeUndefined();
  });

  it('respects a custom limit', () => {
    expect(closest('prodcts', candidates, 0)).toBeUndefined();
  });

  it('prefers the earlier candidate on a tie', () => {
    expect(closest('ab', ['ax', 'ay'])).toBe('ax');
  });
});
