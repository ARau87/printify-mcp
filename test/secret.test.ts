import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { Secret } from '../src/secret.js';

describe('Secret', () => {
  const secret = new Secret('Tok-secret-7Q2w');

  it('returns the value from reveal()', () => {
    expect(secret.reveal()).toBe('Tok-secret-7Q2w');
  });

  it('redacts the value when converted to a string', () => {
    expect(String(secret)).toBe('[redacted]');
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- the case under test
    expect(`token=${secret}`).toBe('token=[redacted]');
  });

  it('redacts the value in JSON', () => {
    expect(JSON.stringify({ token: secret })).toBe('{"token":"[redacted]"}');
  });

  it('redacts the value in util.inspect, which console.log uses', () => {
    expect(inspect({ token: secret })).toBe('{ token: [redacted] }');
  });
});
