import { describe, expect, it } from 'vitest';
import {
  ORDER_SHIPPING_METHODS,
  parseShippingQuote,
  shippingMethodCode,
  shippingMethodName,
} from '../../src/tools/shipping-method.js';
import { QUOTE_FINAL, QUOTE_OLD, QUOTE_TRANSITIONAL } from '../fixtures/orders.js';

describe('shippingMethodCode', () => {
  it('maps the four catalog names to the order codes', () => {
    expect(ORDER_SHIPPING_METHODS.map(shippingMethodCode)).toEqual([1, 2, 3, 4]);
    expect(shippingMethodCode('express')).toBe(3);
  });
});

describe('shippingMethodName', () => {
  it('maps the codes back, keeps an unknown code as text and undefined as undefined', () => {
    expect([1, 2, 3, 4].map(shippingMethodName)).toEqual([
      'standard',
      'priority',
      'express',
      'economy',
    ]);
    expect(shippingMethodName(5)).toBe('5');
    expect(shippingMethodName(undefined)).toBeUndefined();
  });
});

describe('parseShippingQuote', () => {
  it('reads the old keys: express is priority, and there is no Printify Express', () => {
    expect(parseShippingQuote(QUOTE_OLD)).toEqual({
      methods: [
        { method: 'standard', code: 1, cost: 1000 },
        { method: 'priority', code: 2, cost: 5000 },
        { method: 'economy', code: 4, cost: 399 },
      ],
    });
  });

  it('reads the transitional keys: printify_express is express', () => {
    expect(parseShippingQuote(QUOTE_TRANSITIONAL)).toEqual({
      methods: [
        { method: 'standard', code: 1, cost: 1000 },
        { method: 'priority', code: 2, cost: 5000 },
        { method: 'express', code: 3, cost: 799 },
        { method: 'economy', code: 4, cost: 399 },
      ],
    });
  });

  it('reads the final keys: express next to priority is Printify Express', () => {
    expect(parseShippingQuote(QUOTE_FINAL)).toEqual({
      methods: [
        { method: 'standard', code: 1, cost: 1000 },
        { method: 'priority', code: 2, cost: 5000 },
        { method: 'express', code: 3, cost: 799 },
        { method: 'economy', code: 4, cost: 399 },
      ],
    });
  });

  it('leaves out a method with no key and reports unknown keys under other', () => {
    expect(parseShippingQuote({ standard: 1000, drone: 1 })).toEqual({
      methods: [{ method: 'standard', code: 1, cost: 1000 }],
      other: { drone: 1 },
    });
    expect(parseShippingQuote({})).toEqual({ methods: [] });
    expect(parseShippingQuote({ standard: 1 })).not.toHaveProperty('other');
  });
});
