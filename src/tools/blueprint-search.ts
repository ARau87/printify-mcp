import type { Blueprint } from '../printify/catalog.js';

/** A match in one blueprint, before paging. */
export interface BlueprintMatch {
  blueprint: Blueprint;
  /** The query tokens this blueprint matched, in query order. */
  matchedTerms: readonly string[];
  score: number;
}

export interface SearchResult {
  /** `undefined` when nothing was searched for: the catalogue is being browsed. */
  matched: 'all' | 'partial' | undefined;
  /** Tokens that matched no blueprint at all. Empty unless `matched` is `'partial'`. */
  unmatchedTerms: readonly string[];
  /** Every match, ranked. The caller pages it. */
  matches: readonly BlueprintMatch[];
}

export interface SearchOptions {
  query?: string | undefined;
  brand?: string | undefined;
}

/** A query longer than this is truncated: a pasted paragraph is not a search. */
const MAX_QUERY_TOKENS = 12;

/** Fields a token is matched against, best-scoring first, so the first hit wins. */
const FIELDS = [
  ['title', 3],
  ['brand', 2],
  ['model', 2],
  ['description', 1],
] as const;

type Field = (typeof FIELDS)[number][0];

/**
 * Ranks `blueprints` against a text query. Tokens match a field when a word in it starts with the
 * token, so `hood` finds both Hoodie and Hooded. When no blueprint matches every token the result
 * relaxes to the blueprints covering the most of the query. Never changes `blueprints`.
 */
export function searchBlueprints(
  blueprints: readonly Blueprint[],
  { query, brand }: SearchOptions = {},
): SearchResult {
  const pool =
    brand === undefined ? blueprints : blueprints.filter((item) => sameBrand(item, brand));
  // Deduplicated: repeating a word must not score it twice, and must not eat the token budget.
  const tokens = [...new Set(tokenise(query ?? ''))].slice(0, MAX_QUERY_TOKENS);

  if (tokens.length === 0 || pool.length === 0) {
    return {
      matched: undefined,
      unmatchedTerms: [],
      matches: pool.map((item) => ({ blueprint: item, matchedTerms: [], score: 0 })).sort(byRank),
    };
  }

  const scored = pool
    .map((item) => scoreBlueprint(item, tokens))
    .filter((match) => match.matchedTerms.length > 0);
  const complete = scored.filter((match) => match.matchedTerms.length === tokens.length);

  if (complete.length > 0) {
    return { matched: 'all', unmatchedTerms: [], matches: complete.sort(byRank) };
  }

  const found = new Set(scored.flatMap((match) => match.matchedTerms));
  return {
    matched: 'partial',
    unmatchedTerms: tokens.filter((token) => !found.has(token)),
    matches: scored.sort(byRank),
  };
}

function scoreBlueprint(blueprint: Blueprint, tokens: readonly string[]): BlueprintMatch {
  const words = fieldWords(blueprint);
  const matchedTerms: string[] = [];
  let score = 0;
  for (const token of tokens) {
    const weight = FIELDS.find(([field]) => startsAnyWord(words[field], token))?.[1];
    if (weight !== undefined) {
      matchedTerms.push(token);
      score += weight;
    }
  }
  return { blueprint, matchedTerms, score };
}

function fieldWords(blueprint: Blueprint): Record<Field, readonly string[]> {
  return {
    title: tokenise(blueprint.title ?? ''),
    brand: tokenise(blueprint.brand ?? ''),
    model: tokenise(blueprint.model ?? ''),
    // Descriptions are HTML: without this, `p`, `br` and `span` are query vocabulary.
    description: tokenise(stripTags(blueprint.description ?? '')),
  };
}

/** Lowercase words, split on everything that is not a letter or a digit, so `11oz` stays whole. */
function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token !== '');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, ' ');
}

function startsAnyWord(words: readonly string[], token: string): boolean {
  return words.some((word) => word.startsWith(token));
}

function sameBrand(blueprint: Blueprint, brand: string): boolean {
  return blueprint.brand?.trim().toLowerCase() === brand.trim().toLowerCase();
}

/** Coverage, then score, then title and id so two runs over the same catalogue agree. */
function byRank(a: BlueprintMatch, b: BlueprintMatch): number {
  return (
    b.matchedTerms.length - a.matchedTerms.length ||
    b.score - a.score ||
    compareTitles(a.blueprint.title, b.blueprint.title) ||
    a.blueprint.id - b.blueprint.id
  );
}

/** A blueprint with no title sorts after every blueprint that has one. */
function compareTitles(a: string | undefined, b: string | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : 0;
}
