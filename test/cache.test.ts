import { describe, expect, it } from 'vitest';
import { createTtlCache } from '../src/cache.js';

/** A cache whose clock the test moves with `tick`. */
function testCache(maxEntries?: number) {
  let time = 0;
  const cache = createTtlCache<string>({ maxEntries, now: () => time });
  return {
    cache,
    // An arrow property, not a method: destructuring a method trips unbound-method.
    tick: (ms: number): void => {
      time += ms;
    },
  };
}

describe('createTtlCache', () => {
  it('returns a value before its time is up', () => {
    const { cache, tick } = testCache();
    cache.set('a', 'value', 1000);
    tick(999);
    expect(cache.get('a')).toBe('value');
  });

  it('forgets a value at exactly its ttl and after it', () => {
    const { cache, tick } = testCache();
    cache.set('a', 'value', 1000);
    tick(1000);
    expect(cache.get('a')).toBeUndefined();

    cache.set('b', 'value', 1000);
    tick(5000);
    expect(cache.get('b')).toBeUndefined();
  });

  it('has nothing for an unknown key', () => {
    const { cache } = testCache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('sweeps expired entries on set, so they do not evict fresh ones', () => {
    const { cache, tick } = testCache(2);
    cache.set('old-1', 'one', 1000);
    cache.set('old-2', 'two', 1000);
    tick(1000);

    // Both are expired: the sweep drops them, so neither counts towards the limit.
    cache.set('fresh-1', 'three', 1000);
    cache.set('fresh-2', 'four', 1000);

    expect(cache.get('fresh-1')).toBe('three');
    expect(cache.get('fresh-2')).toBe('four');
  });

  it('evicts the oldest entry past maxEntries', () => {
    const { cache } = testCache(2);
    cache.set('a', 'one', 1000);
    cache.set('b', 'two', 1000);
    cache.set('c', 'three', 1000);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe('two');
    expect(cache.get('c')).toBe('three');
  });

  it('makes a re-set key the newest, so it survives the next eviction', () => {
    const { cache } = testCache(2);
    cache.set('a', 'one', 1000);
    cache.set('b', 'two', 1000);
    cache.set('a', 'again', 1000);
    cache.set('c', 'three', 1000);

    expect(cache.get('a')).toBe('again');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('three');
  });
});
