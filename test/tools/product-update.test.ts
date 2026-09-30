import { describe, expect, it } from 'vitest';
import type { Product, ProductVariant } from '../../src/printify/products.js';
import { ToolError } from '../../src/tools/define.js';
import { assertUnlocked, LOCKED_HINT, mergeVariants } from '../../src/tools/product-update.js';

/** A full variant as Printify returns one; a test overrides only what it varies. */
function variant(overrides: Partial<ProductVariant> & { id: number }): ProductVariant {
  return {
    price: 1000,
    is_enabled: true,
    is_default: false,
    sku: `SKU-${String(overrides.id)}`,
    ...overrides,
  };
}

const CURRENT = [
  variant({ id: 1, is_default: true }),
  variant({ id: 2, is_enabled: false }),
  variant({ id: 3 }),
];

function merged(patches: Parameters<typeof mergeVariants>[1]) {
  const result = mergeVariants(CURRENT, patches);
  if (!result.ok)
    throw new Error(`expected a merged list, got unknown ids ${String(result.unknownIds)}`);
  return result.variants;
}

describe('mergeVariants', () => {
  it('changes one price and keeps every other variant, in the original order', () => {
    expect(merged([{ id: 3, price: 2499 }])).toEqual([
      { id: 1, price: 1000, is_enabled: true, is_default: true, sku: 'SKU-1' },
      { id: 2, price: 1000, is_enabled: false, is_default: false, sku: 'SKU-2' },
      { id: 3, price: 2499, is_enabled: true, is_default: false, sku: 'SKU-3' },
    ]);
  });

  it('keeps the current price when the patch has none, and sets a sku', () => {
    const [, , third] = merged([{ id: 3, sku: 'NEW' }]);
    expect(third).toEqual({ id: 3, price: 1000, is_enabled: true, is_default: false, sku: 'NEW' });
  });

  it('unsets the old default when a patch sets a new one', () => {
    expect(merged([{ id: 3, is_default: true }]).map((body) => body.is_default)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('keeps the current defaults when no patch sets one', () => {
    expect(merged([{ id: 2, is_enabled: true }]).map((body) => body.is_default)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('leaves a field out of the body when neither the product nor the patch has it', () => {
    const result = mergeVariants([{ id: 9, price: 500 }], [{ id: 9, price: 600 }]);
    if (!result.ok) throw new Error('expected a merged list');
    const [only] = result.variants;
    expect(only).toEqual({ id: 9, price: 600 });
    expect(only).not.toHaveProperty('is_enabled');
    expect(only).not.toHaveProperty('is_default');
    expect(only).not.toHaveProperty('sku');
  });

  it('returns every unknown id and no list', () => {
    const result = mergeVariants(CURRENT, [{ id: 3, price: 1 }, { id: 7, price: 1 }, { id: 8 }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected unknown ids');
    expect(result.unknownIds).toEqual([7, 8]);
    expect(result).not.toHaveProperty('variants');
  });

  it('returns the current list unchanged for no patches', () => {
    expect(merged([])).toEqual([
      { id: 1, price: 1000, is_enabled: true, is_default: true, sku: 'SKU-1' },
      { id: 2, price: 1000, is_enabled: false, is_default: false, sku: 'SKU-2' },
      { id: 3, price: 1000, is_enabled: true, is_default: false, sku: 'SKU-3' },
    ]);
  });
});

describe('assertUnlocked', () => {
  const base: Product = { id: 'p1', title: 'Mug "11oz"', variants: [] };

  it('throws a ToolError naming the product when it is locked', () => {
    expect(() => {
      assertUnlocked({ ...base, is_locked: true });
    }).toThrow(ToolError);
    try {
      assertUnlocked({ ...base, is_locked: true });
    } catch (error) {
      const toolError = error as ToolError;
      expect(toolError.message).toBe(
        'Product p1 ("Mug \\"11oz\\"") is locked because it is being published, and Printify ' +
          'refuses updates to a locked product.',
      );
      expect(toolError.hint).toBe(LOCKED_HINT);
    }
  });

  it('names the product by id alone when it has no title', () => {
    try {
      assertUnlocked({ id: 'p1', variants: [], is_locked: true });
      throw new Error('expected a ToolError');
    } catch (error) {
      expect((error as Error).message).toMatch(/^Product p1 is locked/);
    }
  });

  it('returns for an unlocked product, and for one that does not say', () => {
    expect(() => {
      assertUnlocked({ ...base, is_locked: false });
    }).not.toThrow();
    expect(() => {
      assertUnlocked(base);
    }).not.toThrow();
  });
});
