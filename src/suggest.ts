/** Levenshtein distance: the number of single-character insertions, deletions and substitutions. */
export function editDistance(a: string, b: string): number {
  // previous[j] is the distance between the first i - 1 characters of a and the first j of b.
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * Returns the candidate closest to `input`, or `undefined` when none is within `maxDistance`
 * edits. On a tie the earlier candidate wins. Callers normalise letter case first.
 */
export function closest(
  input: string,
  candidates: readonly string[],
  maxDistance = 3,
): string | undefined {
  let best: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}
