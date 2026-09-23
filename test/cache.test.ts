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
    cache.set('keeper', 'kept', 10_000);
    cache.set('stale', 'gone', 1_000);
    tick(1000);

    // Stale has expired but keeper has not. The sweep removes stale before checking size,
    // so the newcomer can join without evicting keeper.
    cache.set('newcomer', 'new', 10_000);

    expect(cache.get('keeper')).toBe('kept');
    expect(cache.get('stale')).toBeUndefined();
    expect(cache.get('newcomer')).toBe('new');
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
