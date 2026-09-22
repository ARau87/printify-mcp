/**
 * Removes `null` and `undefined` object properties at any depth. Array elements are kept, so
 * indexes do not shift. Only arrays and plain objects are copied; other values pass through.
 */
export function dropNulls<T>(value: T): T {
  return withoutNulls(value) as T;
}

/** A shallow copy of `object` without `keys`, for a toolset's summaries. */
export function omitKeys<T extends object, K extends keyof T>(
  object: T,
  keys: readonly K[],
): Omit<T, K> {
  const omitted = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(object).filter(([key]) => !omitted.has(key))) as Omit<
    T,
    K
  >;
}

function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!isPlainObject(value)) return value;
  // Object.fromEntries, unlike assignment, keeps a "__proto__" key from JSON as a plain property.
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== null && item !== undefined)
      .map(([key, item]) => [key, withoutNulls(item)]),
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
