import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { lenient } from '../../src/printify/schema.js';

describe('lenient', () => {
  const schema = z.object({ width: lenient(z.number()) });

  it('keeps a value of the right type', () => {
    expect(schema.parse({ width: 400 })).toEqual({ width: 400 });
  });

  it('turns null into undefined', () => {
    expect(schema.parse({ width: null })).toEqual({});
  });

  it('turns a value of the wrong type into undefined', () => {
    expect(schema.parse({ width: 'wide' })).toEqual({});
  });

  it('accepts a missing key', () => {
    expect(schema.parse({})).toEqual({});
  });

  it('does not touch the schema around it', () => {
    expect(() => schema.parse('not an object')).toThrow();
  });
});
