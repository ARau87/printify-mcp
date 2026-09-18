const REDACTED = '[redacted]';

// Printify Personal Access Tokens are JWTs.
const JWT_PATTERN = /eyJ[\w-]*\.[\w-]*\.[\w-]*/g;

/** Shorter values are skipped, so a country code such as "US" does not wipe out other text. */
const MIN_VALUE_LENGTH = 3;

/** Replaces everything JWT-shaped, such as a Printify token, with `[redacted]`. */
export function redactJwts(text: string): string {
  return text.replace(JWT_PATTERN, REDACTED);
}

/**
 * Replaces every occurrence of each value, ignoring letter case, with `[redacted]`. One pass with
 * the longest values first, so a value inside another, or inside `[redacted]`, is never matched.
 */
export function redactValues(text: string, values: Iterable<string>): string {
  const patterns = [...new Set(values)]
    .filter((value) => value.length >= MIN_VALUE_LENGTH)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (patterns.length === 0) return text;
  return text.replace(new RegExp(patterns.join('|'), 'gi'), REDACTED);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
