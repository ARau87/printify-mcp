import { describe, expect, it } from 'vitest';
import { dropNulls, omitKeys } from '../../src/tools/shape.js';

describe('dropNulls', () => {
  it('removes null and undefined properties at any depth', () => {
    const value = { id: 1, sku: null, cost: undefined, print: { back: null, front: { x: 0.5 } } };
    expect(dropNulls(value)).toStrictEqual({ id: 1, print: { front: { x: 0.5 } } });
  });

  it('keeps array elements, null included, and cleans objects inside arrays', () => {
    const value = { tags: ['a', null], variants: [{ id: 2, sku: null }] };
    expect(dropNulls(value)).toStrictEqual({ tags: ['a', null], variants: [{ id: 2 }] });
  });

  it('keeps false, 0, empty strings, empty arrays and empty objects', () => {
    const value = { visible: false, price: 0, sku: '', tags: [], options: {} };
    expect(dropNulls(value)).toStrictEqual(value);
  });

  it('keeps a "__proto__" key from JSON as a plain property', () => {
    const value: unknown = JSON.parse('{"__proto__":{"x":null},"y":null}');
    const result = dropNulls(value);
    expect(JSON.stringify(result)).toBe('{"__proto__":{}}');
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it('does not change its input and passes other values through', () => {
    const value = { sku: null };
    const date = new Date(0);
    dropNulls(value);
    expect(value).toStrictEqual({ sku: null });
    expect(dropNulls(null)).toBeNull();
    expect(dropNulls('text')).toBe('text');
    expect(dropNulls({ date }).date).toBe(date);
  });
});

describe('omitKeys', () => {
  it('returns a shallow copy without the keys', () => {
    const product = { id: '5f3', title: 'Tee', images: [{ src: 'mockup.png' }], views: [] };
    expect(omitKeys(product, ['images', 'views'])).toStrictEqual({ id: '5f3', title: 'Tee' });
    expect(product.images).toHaveLength(1);
  });
});
