import { describe, expect, it } from 'vitest';
import { redactJwts, redactValues } from '../src/redact.js';

describe('redactJwts', () => {
  it('replaces JWT-shaped values', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcmludGlmeS1tY3AifQ.c2lnbmF0dXJl';
    expect(redactJwts(`token ${jwt} leaked`)).toBe('token [redacted] leaked');
  });

  it('leaves other text alone', () => {
    expect(redactJwts('Validation failed.')).toBe('Validation failed.');
  });
});

describe('redactValues', () => {
  it('replaces every occurrence, ignoring letter case', () => {
    expect(redactValues('Jane Doe; JANE DOE; jane doe', ['Jane Doe'])).toBe(
      '[redacted]; [redacted]; [redacted]',
    );
  });

  it('skips values shorter than 3 characters', () => {
    expect(redactValues('US address in USPS', ['US', 'Bob'])).toBe('US address in USPS');
  });

  it('replaces a longer value before a shorter one it contains', () => {
    expect(redactValues('Main Street 1', ['Main', 'Main Street 1'])).toBe('[redacted]');
  });

  it('never matches inside an earlier replacement', () => {
    expect(redactValues('Rosa Red', ['Rosa Red', 'act', 'red'])).toBe('[redacted]');
  });

  it('treats regex characters in values literally', () => {
    expect(redactValues('a+b (c) a.b', ['a+b (c)'])).toBe('[redacted] a.b');
    expect(redactValues('axb', ['a.b'])).toBe('axb');
  });

  it('returns the text unchanged when no value qualifies', () => {
    expect(redactValues('unchanged', [])).toBe('unchanged');
    expect(redactValues('unchanged', ['', 'ab'])).toBe('unchanged');
  });
});
