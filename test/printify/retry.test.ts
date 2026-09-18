import { describe, expect, it } from 'vitest';
import {
  MAX_ATTEMPTS,
  parseRetryAfter,
  retryDelayMs,
  shouldRetry,
} from '../../src/printify/retry.js';

describe('shouldRetry', () => {
  it.each([
    ['GET', 429, true],
    ['PUT', 429, true],
    ['DELETE', 429, true],
    ['POST', 429, true],
    ['GET', 502, true],
    ['PUT', 502, true],
    ['DELETE', 503, true],
    ['GET', 503, true],
    ['POST', 502, false],
    ['POST', 503, false],
    ['GET', 500, false],
    ['GET', 504, false],
    ['GET', 400, false],
    ['DELETE', 404, false],
    ['POST', 409, false],
    ['GET', 200, false],
    ['GET', 304, false],
  ] as const)('%s with HTTP %i: %s', (method, status, expected) => {
    expect(shouldRetry(method, { status })).toBe(expected);
  });

  it.each([
    ['GET', true],
    ['PUT', true],
    ['DELETE', true],
    ['POST', false],
  ] as const)('%s after a network error: %s', (method, expected) => {
    expect(shouldRetry(method, 'network')).toBe(expected);
  });

  it('allows three attempts in total', () => {
    expect(MAX_ATTEMPTS).toBe(3);
  });
});

describe('parseRetryAfter', () => {
  const NOW = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');

  it.each([
    ['5', 5_000],
    [' 0 ', 0],
    ['120', 120_000],
  ])('reads %j as seconds', (header, expected) => {
    expect(parseRetryAfter(header, NOW)).toBe(expected);
  });

  it('reads an HTTP date as the time until it', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:30 GMT', NOW)).toBe(30_000);
  });

  it('reads an HTTP date in the past as 0', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:27:00 GMT', NOW)).toBe(0);
  });

  it.each([null, '', '-5', '1.5', 'soon', 'Sunday, maybe'])('ignores %j', (header) => {
    expect(parseRetryAfter(header, NOW)).toBeUndefined();
  });
});

describe('retryDelayMs', () => {
  it.each([
    [1, 0, 500],
    [1, 0.999, 999.5],
    [2, 0, 1_000],
    [2, 0.999, 1_999],
  ])('backs off retry %i with random() at %d', (retry, random, expected) => {
    expect(retryDelayMs(retry, null, () => random)).toBeCloseTo(expected);
  });

  it('prefers a valid Retry-After to backoff', () => {
    expect(retryDelayMs(1, '7', () => 0)).toBe(7_000);
  });

  it('falls back to backoff for an invalid Retry-After', () => {
    expect(retryDelayMs(2, 'soon', () => 0)).toBe(1_000);
  });
});
