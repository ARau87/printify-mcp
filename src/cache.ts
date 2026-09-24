// Function-typed properties, not methods: destructuring a method trips unbound-method.
export interface TtlCache<V> {
  /** The value, or `undefined` when there is none or it has expired. */
  get: (key: string) => V | undefined;
  set: (key: string, value: V, ttlMs: number) => void;
}

export interface TtlCacheOptions {
  /** The most entries to keep. The oldest go first. Defaults to 200. */
  maxEntries?: number;
  /** Milliseconds from a monotonic clock. Defaults to `performance.now`. */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 200;

interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * A cache whose entries expire. It starts no timers: an entry is dropped when it is read after
 * its time, and `set` sweeps the expired ones, so keys nobody reads again do not pile up.
 */
export function createTtlCache<V>(options: TtlCacheOptions = {}): TtlCache<V> {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
  const now = options.now ?? (() => performance.now());
  const entries = new Map<string, Entry<V>>();

  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (now() >= entry.expiresAt) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },

    set(key, value, ttlMs) {
      const time = now();
      for (const [other, entry] of entries) {
        if (time >= entry.expiresAt) entries.delete(other);
      }
      // Deleted first, so a re-set entry moves to the end and is evicted last.
      entries.delete(key);
      entries.set(key, { value, expiresAt: time + ttlMs });
      for (const oldest of entries.keys()) {
        if (entries.size <= maxEntries) break;
        entries.delete(oldest);
      }
    },
  };
}
