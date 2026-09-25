# search_blueprints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `search_blueprints` tool that ranks the cached Printify blueprint list by a text query, so a model can discover a `blueprint_id` — which nothing in the server can do today.

**Architecture:** One pure module (`src/tools/blueprint-search.ts`) does tokenising, matching and ranking over a `readonly Blueprint[]` with no I/O, so ranking is unit-testable without the MCP harness. One tool in the existing `catalog` toolset calls `ctx.catalog.allBlueprints()` — already cached for 24 h — hands the list to that module, and pages the ranked result. No new endpoint, no new `Catalog` method, no new dependency.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), zod 4, `@modelcontextprotocol/sdk`, vitest, eslint + prettier.

**Spec:** `docs/superpowers/specs/2026-09-25-search-blueprints-design.md`

## Global Constraints

- **Worktree:** work in `../printify-mcp-worktrees/17-search-blueprints` on branch `feat/17-search-blueprints`. Another session may switch branches in the main checkout — never `cd` into it. Run `npm ci` once before Task 1 if `node_modules` is absent.
- **Commit trailer:** every commit message ends with exactly `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **ESM:** every relative import carries a `.js` extension, including in tests.
- **Determinism:** never sort with `localeCompare` — it is locale-dependent. Compare lowercased strings with `<` / `>`.
- **Injected services:** interfaces use function-typed properties, not methods (destructuring a method trips `unbound-method`).
- **Verify before claiming:** `npm run lint && npm run typecheck && npm test` must pass before any task's commit. Paste real output; never assert a pass you did not see.
- **No new dependencies.**

---

### Task 1: The search module — browsing and the brand filter

The simplest complete behaviour: no query. This lands the module, its exported types, the deterministic sort and the `brand` filter, plus the fixture catalogue every later task ranks against.

**Files:**

- Create: `src/tools/blueprint-search.ts`
- Create: `test/tools/blueprint-search.test.ts`
- Modify: `test/fixtures/catalog.ts` (append; leave `BLUEPRINT`, `BLUEPRINTS` and `blueprint()` untouched — existing tests use them)

**Interfaces:**

- Consumes: `Blueprint` from `src/printify/catalog.js` — `{ id: number; title?: string; brand?: string; model?: string; description?: string; images?: string[]; tags?: string[] }`. Every string field is `lenientString`, so every one can be `undefined`.
- Produces: `searchBlueprints(blueprints, options)`, `BlueprintMatch`, `SearchResult`, `SearchOptions`, and the `SEARCH_BLUEPRINTS` fixture.

- [ ] **Step 1: Add the fixture catalogue**

Append to `test/fixtures/catalog.ts`. These records are also valid raw API responses, so Task 4's harness test serves the same constant over the fake API.

```ts
/**
 * A catalogue wide enough to rank against: two hoodie-like Gildan records, a tee, a mug, one whose
 * only hit is inside its HTML description, one with a trademark sign, and one missing brand and
 * model. Deliberately not in id or title order, so a test that passes proves the sort ran.
 */
export const SEARCH_BLUEPRINTS = [
  {
    id: 49,
    title: 'Unisex Heavy Blend™ Hooded Sweatshirt',
    description: '<p>A <strong>classic</strong> pullover hoodie.</p>',
    brand: 'Gildan',
    model: '18500',
    images: [],
  },
  {
    id: 77,
    title: 'Unisex Hooded Zip Sweatshirt',
    description: '<p>Full-zip, fleece lined.</p>',
    brand: 'Gildan',
    model: '18600',
    images: [],
  },
  {
    id: 6,
    title: 'Unisex Jersey Short Sleeve Tee',
    description: '<p>Soft cotton, retail fit.</p>',
    brand: 'Bella+Canvas',
    model: '3001',
    images: [],
  },
  {
    id: 12,
    title: 'White Ceramic Mug',
    description: '<p>Dishwasher safe. 11oz.</p>',
    brand: 'Generic',
    model: 'MUG11',
    images: [],
  },
  {
    id: 31,
    title: 'Classic Tote Bag',
    description: '<p>Made from recycled <em>polyester</em> canvas.</p>',
    brand: 'Liberty Bags',
    model: '8870',
    images: [],
  },
  {
    id: 88,
    title: 'Canteen Steel Bottle',
    description: '<p>Vacuum insulated.</p>',
    brand: 'Generic',
    model: 'BTL20',
    images: [],
  },
  {
    id: 2,
    title: 'Adult Fleece Hoodie',
    description: '<p>Midweight.</p>',
    brand: 'Delta',
    model: '97300',
    images: [],
  },
  {
    id: 64,
    images: [],
  },
];
```

- [ ] **Step 2: Write the failing tests**

Create `test/tools/blueprint-search.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Blueprint } from '../../src/printify/catalog.js';
import { searchBlueprints } from '../../src/tools/blueprint-search.js';
import { SEARCH_BLUEPRINTS } from '../fixtures/catalog.js';

const CATALOGUE: readonly Blueprint[] = SEARCH_BLUEPRINTS;

const ids = (result: { matches: readonly { blueprint: Blueprint }[] }) =>
  result.matches.map((match) => match.blueprint.id);

describe('searchBlueprints browsing', () => {
  it('returns every blueprint sorted by title when there is no query', () => {
    const result = searchBlueprints(CATALOGUE, {});

    expect(result.matched).toBeUndefined();
    expect(result.unmatchedTerms).toEqual([]);
    // adult… < canteen… < classic… < unisex heavy… < unisex hooded… < unisex jersey… < white…
    expect(ids(result)).toEqual([2, 88, 31, 49, 77, 6, 12, 64]);
  });

  it('treats a blank query and a punctuation-only query as browsing', () => {
    for (const query of ['', '   ', '-- //']) {
      const result = searchBlueprints(CATALOGUE, { query });
      expect(result.matched).toBeUndefined();
      expect(result.matches).toHaveLength(CATALOGUE.length);
    }
  });

  it('sorts a blueprint with no title last', () => {
    expect(ids(searchBlueprints(CATALOGUE, {})).at(-1)).toBe(64);
  });

  it('filters by brand, ignoring case and surrounding spaces', () => {
    expect(ids(searchBlueprints(CATALOGUE, { brand: '  gILDAn ' }))).toEqual([49, 77]);
  });

  it('reports nothing to match against when the brand filter leaves no blueprints', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'hooded', brand: 'Nobody' });

    expect(result.matches).toEqual([]);
    expect(result.matched).toBeUndefined();
    expect(result.unmatchedTerms).toEqual([]);
  });

  it('does not reorder the caller’s array', () => {
    const input = [...CATALOGUE];
    searchBlueprints(input, {});
    expect(input).toEqual(SEARCH_BLUEPRINTS);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -- test/tools/blueprint-search.test.ts`
Expected: FAIL — cannot resolve `../../src/tools/blueprint-search.js`.

- [ ] **Step 4: Write the module**

Create `src/tools/blueprint-search.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- test/tools/blueprint-search.test.ts`
Expected: PASS, 6 tests.

Then `npm run lint && npm run typecheck`. Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/blueprint-search.ts test/tools/blueprint-search.test.ts test/fixtures/catalog.ts
git commit -m "$(cat <<'EOF'
Rank the blueprint catalogue without a query

The browse path first: a brand filter and a deterministic sort, so the
order of results never depends on the order Printify happened to send.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Matching and ranking a query that fully matches

**Files:**

- Modify: `test/tools/blueprint-search.test.ts` (append a `describe`)
- Modify: `src/tools/blueprint-search.ts` only if a test fails — Task 1's module already implements this path, so these tests are expected to pass on the first run. That is intentional: they pin behaviour Task 1 could not observe.

**Interfaces:**

- Consumes: `searchBlueprints`, `SEARCH_BLUEPRINTS` from Task 1.
- Produces: nothing new.

- [ ] **Step 1: Write the tests**

Append to `test/tools/blueprint-search.test.ts`:

```ts
describe('searchBlueprints matching', () => {
  it('matches a word by prefix, so one stem finds Hoodie and Hooded', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'hood' });

    expect(result.matched).toBe('all');
    expect(ids(result)).toEqual([2, 49, 77]);
  });

  it('does not match a word that merely contains the token', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'tee' });

    expect(result.matched).toBe('all');
    // "Tee" in blueprint 6, not "Canteen" (88) or "Steel" (88).
    expect(ids(result)).toEqual([6]);
  });

  it('keeps a number glued to its unit as one token', () => {
    expect(ids(searchBlueprints(CATALOGUE, { query: '11oz' }))).toEqual([12]);
  });

  it('ignores HTML tags when matching the description', () => {
    // "strong" and "p" are markup in blueprint 49, not words.
    expect(searchBlueprints(CATALOGUE, { query: 'strong' }).matches).toEqual([]);
    expect(ids(searchBlueprints(CATALOGUE, { query: 'polyester' }))).toEqual([31]);
  });

  it('ranks a title hit above a description hit for the same token', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'hoodie' });

    expect(result.matched).toBe('all');
    // 2 has "Hoodie" in its title (3), 49 has "hoodie" in its description (1).
    expect(ids(result)).toEqual([2, 49]);
  });

  it('requires every token before it calls a match complete', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'gildan hooded' });

    expect(result.matched).toBe('all');
    expect(result.unmatchedTerms).toEqual([]);
    expect(ids(result)).toEqual([49, 77]);
    expect(result.matches[0]?.matchedTerms).toEqual(['gildan', 'hooded']);
  });

  it('applies the brand filter before matching', () => {
    expect(ids(searchBlueprints(CATALOGUE, { query: 'hood', brand: 'Delta' }))).toEqual([2]);
  });

  it('breaks a tie by title then id', () => {
    const shuffled = [...CATALOGUE].reverse();

    expect(ids(searchBlueprints(shuffled, { query: 'unisex' }))).toEqual(
      ids(searchBlueprints(CATALOGUE, { query: 'unisex' })),
    );
  });

  it('scores a repeated word once', () => {
    const once = searchBlueprints(CATALOGUE, { query: 'hood' });
    const thrice = searchBlueprints(CATALOGUE, { query: 'hood hood hood' });

    expect(thrice.matches.map((match) => match.score)).toEqual(
      once.matches.map((match) => match.score),
    );
    expect(thrice.matches[0]?.matchedTerms).toEqual(['hood']);
  });

  it('uses only the first 12 distinct tokens of a query', () => {
    const junk = Array.from({ length: 12 }, (_, index) => `q${String(index)}`).join(' ');

    // "hood" is the 13th distinct token, so it is dropped before matching: neither matched nor
    // reported as unmatched.
    const result = searchBlueprints(CATALOGUE, { query: `${junk} hood` });

    expect(result.unmatchedTerms).toHaveLength(12);
    expect(result.unmatchedTerms).not.toContain('hood');
    expect(result.matches).toEqual([]);
  });

  it('never matches a blueprint with no searchable fields', () => {
    for (const query of ['hood', 'unisex', 'gildan', '18500']) {
      expect(ids(searchBlueprints(CATALOGUE, { query }))).not.toContain(64);
    }
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- test/tools/blueprint-search.test.ts`
Expected: PASS. If any fails, the bug is in Task 1's module or in an expected value you worked out by hand — fix whichever is actually wrong, and say which.

- [ ] **Step 3: Commit**

```bash
git add test/tools/blueprint-search.test.ts
git commit -m "$(cat <<'EOF'
Pin the prefix rule, field weights and the token cap

These paths existed after the browse commit but nothing observed them.
The prefix rule is the one most likely to be "improved" into a substring
match later, which would make "tee" match Canteen and Steel.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Relaxation

**Files:**

- Modify: `test/tools/blueprint-search.test.ts` (append a `describe`)

**Interfaces:**

- Consumes: `searchBlueprints`, `SEARCH_BLUEPRINTS`.
- Produces: nothing new.

- [ ] **Step 1: Write the tests**

Append to `test/tools/blueprint-search.test.ts`:

```ts
describe('searchBlueprints relaxation', () => {
  it('falls back to coverage ranking when no blueprint matches every token', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'unisex heavyweight hoodie' });

    expect(result.matched).toBe('partial');
    expect(result.unmatchedTerms).toEqual(['heavyweight']);
    // 49 covers "unisex" (title) and "hoodie" (description) = 2 tokens, score 4. 2, 77 and 6 each
    // cover one token at score 3, so they follow in title order.
    expect(ids(result)).toEqual([49, 2, 77, 6]);
    expect(result.matches[0]?.matchedTerms).toEqual(['unisex', 'hoodie']);
  });

  it('reports every token when nothing matches at all', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'galvanised flange' });

    expect(result.matched).toBe('partial');
    expect(result.unmatchedTerms).toEqual(['galvanised', 'flange']);
    expect(result.matches).toEqual([]);
  });

  it('lists only the tokens no blueprint matched, not the ones a row missed', () => {
    const result = searchBlueprints(CATALOGUE, { query: 'unisex mug' });

    // Both tokens exist in the catalogue, just never together.
    expect(result.matched).toBe('partial');
    expect(result.unmatchedTerms).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `npm test -- test/tools/blueprint-search.test.ts`
Expected: PASS, and `npm run lint && npm run typecheck` clean.

- [ ] **Step 3: Commit**

```bash
git add test/tools/blueprint-search.test.ts
git commit -m "$(cat <<'EOF'
Pin relaxation and what counts as an unmatched term

The issue's own example prompt has no exact match against real Printify
titles, so relaxation is the path most queries take. unmatched_terms is
global on purpose: per-row it would shift as the caller pages.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: The `search_blueprints` tool

**Files:**

- Modify: `src/tools/catalog.ts` (add `SEARCH_LIMIT`, `searchBlueprintsTool`, and the `catalogTools` entry)
- Modify: `test/tools/catalog-toolset.test.ts` (append a `describe`)
- Modify: `.github/workflows/ci.yml:58-60` (the smoke-test tool-name loop)

**Interfaces:**

- Consumes: `searchBlueprints`, `SearchResult` from Task 1; `ctx.catalog.allBlueprints(signal)`; `defineTool`, `READ_ONLY` and the existing `blueprintId` constant in `src/tools/catalog.ts`.
- Produces: `searchBlueprintsTool` and `export const SEARCH_LIMIT = 50` (exported so the test asserts the same number the schema enforces, as `PROVIDER_BLUEPRINT_LIMIT` already does).

- [ ] **Step 1: Write the failing tests**

Append to `test/tools/catalog-toolset.test.ts`. Add `SEARCH_BLUEPRINTS` to the existing `../fixtures/catalog.js` import and `SEARCH_LIMIT` to the existing `../../src/tools/catalog.js` import — do not add a second import statement for either.

```ts
const BLUEPRINTS_PATH = '/v1/catalog/blueprints.json';
const SEARCH_ROUTES: Routes = { [`GET ${BLUEPRINTS_PATH}`]: SEARCH_BLUEPRINTS };

describe('search_blueprints', () => {
  it('returns ranked matches with the ids the other catalog tools need', async () => {
    const { call } = await createTestServer({ routes: SEARCH_ROUTES });

    const data = expectToolData(await call('search_blueprints', { query: 'gildan hooded' }));

    expect(data).toEqual({
      total_matches: 2,
      offset: 0,
      matched: 'all',
      blueprints: [
        { id: 49, title: 'Unisex Heavy Blend™ Hooded Sweatshirt', brand: 'Gildan', model: '18500' },
        { id: 77, title: 'Unisex Hooded Zip Sweatshirt', brand: 'Gildan', model: '18600' },
      ],
    });
  });

  it('names the terms that missed when it relaxes, per row and overall', async () => {
    const { call } = await createTestServer({ routes: SEARCH_ROUTES });

    const data = expectToolData(
      await call('search_blueprints', { query: 'unisex heavyweight hoodie', limit: 1 }),
    );

    expect(data).toMatchObject({
      matched: 'partial',
      unmatched_terms: ['heavyweight'],
      blueprints: [{ id: 49, matched_terms: ['unisex', 'hoodie'] }],
    });
  });

  it('pages without changing the total, and stops claiming more at the end', async () => {
    const { call } = await createTestServer({ routes: SEARCH_ROUTES });

    const first = expectToolData(await call('search_blueprints', { limit: 3 }));
    const last = expectToolData(await call('search_blueprints', { limit: 3, offset: 6 }));
    const past = expectToolData(await call('search_blueprints', { limit: 3, offset: 99 }));

    expect(first).toMatchObject({ total_matches: 8, offset: 0, has_more: true });
    expect(first.blueprints).toHaveLength(3);
    expect(last).toMatchObject({ total_matches: 8, offset: 6 });
    expect(last).not.toHaveProperty('has_more');
    expect(past.blueprints).toEqual([]);
    expect(past).not.toHaveProperty('has_more');
  });

  it('lists the catalogue once per cache period however often it is searched', async () => {
    const { call, api } = await createTestServer({ routes: SEARCH_ROUTES });

    await call('search_blueprints', { query: 'hood' });
    await call('search_blueprints', { query: 'mug' });

    api.expectRequest('GET', BLUEPRINTS_PATH);
  });

  it('rejects a limit or offset outside the schema before any request', async () => {
    const { call, api } = await createTestServer({ routes: SEARCH_ROUTES });

    for (const args of [{ limit: SEARCH_LIMIT + 1 }, { limit: 0 }, { offset: -1 }]) {
      expect(expectToolError(await call('search_blueprints', args))).toMatchObject({
        kind: 'validation',
      });
    }
    expect(api.requests).toEqual([]);
  });

  it('propagates a failure to list the catalogue', async () => {
    const { call } = await createTestServer({
      routes: { [`GET ${BLUEPRINTS_PATH}`]: json(notFoundBody(), 404) },
    });

    expect(expectToolError(await call('search_blueprints', { query: 'hood' }))).toMatchObject({
      kind: 'http',
      status: 404,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/tools/catalog-toolset.test.ts`
Expected: FAIL — every case reports an unknown tool `search_blueprints`.

- [ ] **Step 3: Add the tool**

In `src/tools/catalog.ts`, add the import beside the existing ones:

```ts
import { searchBlueprints } from './blueprint-search.js';
```

Beside `PROVIDER_BLUEPRINT_LIMIT` near the top:

```ts
/** The most blueprints `search_blueprints` returns in one page. */
export const SEARCH_LIMIT = 50;
```

Add the tool **above** `getBlueprintTool`, since it is where the drill-down now starts:

```ts
export const searchBlueprintsTool = defineTool({
  name: 'search_blueprints',
  toolset: 'catalog',
  description:
    'Searches the whole Printify catalog for blueprints (product templates such as t-shirts, ' +
    'hoodies or mugs) and returns their ids. Start here: every other catalog tool needs a ' +
    'blueprint_id and this is the only tool that finds one. Words match a title, brand, model or ' +
    'description word by prefix, so prefer short stems: "hood" finds both Hoodie and Hooded, ' +
    '"hoodie" finds neither. When no blueprint matches every word the closest ones come back ' +
    'with matched "partial" and unmatched_terms, which say what to drop or shorten. Next, ' +
    'list_blueprint_providers shows who can print the blueprint you picked.',
  annotations: READ_ONLY,
  input: z.strictObject({
    query: z
      .string()
      .optional()
      .describe('Words to look for. Leave it out to browse the catalog by title.'),
    brand: z
      .string()
      .min(1)
      .optional()
      .describe('Only blueprints of this brand. An exact name, ignoring case and spaces.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SEARCH_LIMIT)
      .default(20)
      .describe('How many blueprints to return.'),
    offset: z.number().int().min(0).default(0).describe('How many blueprints to skip.'),
  }),
  handler: async (input, ctx) => {
    const blueprints = await ctx.catalog.allBlueprints(ctx.signal);
    const result = searchBlueprints(blueprints, { query: input.query, brand: input.brand });
    const page = result.matches.slice(input.offset, input.offset + input.limit);
    return {
      total_matches: result.matches.length,
      offset: input.offset,
      has_more: input.offset + page.length < result.matches.length ? true : undefined,
      matched: result.matched,
      unmatched_terms: result.unmatchedTerms.length > 0 ? [...result.unmatchedTerms] : undefined,
      blueprints: page.map((match) => ({
        id: match.blueprint.id,
        title: match.blueprint.title,
        brand: match.blueprint.brand,
        model: match.blueprint.model,
        // On a full match this is the query echoed onto every row.
        matched_terms: result.matched === 'partial' ? [...match.matchedTerms] : undefined,
      })),
    };
  },
});
```

Add it first in `catalogTools`:

```ts
export const catalogTools: readonly Tool[] = [
  searchBlueprintsTool,
  getBlueprintTool,
  listBlueprintProvidersTool,
  listVariantsTool,
  getShippingInfoTool,
  listPrintProvidersTool,
  getPrintProviderTool,
];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- test/tools/catalog-toolset.test.ts`
Expected: PASS.

Then the whole suite, because `test/tools/catalog.test.ts` lints every tool in `ALL_TOOLS` and will catch a bad name, a missing annotation or a non-strict input:

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass.

- [ ] **Step 5: Add the tool to the CI smoke test**

In `.github/workflows/ci.yml`, put `search_blueprints` first in the existing loop so the built artifact is checked to expose it:

```yaml
for tool in search_blueprints get_blueprint list_blueprint_providers list_variants \
get_shipping_info list_print_providers get_print_provider; do
grep -q "\"name\":\"$tool\"" <<<"$output"
done
```

- [ ] **Step 6: Verify the built artifact really lists it**

Run the smoke test locally rather than trusting CI:

```bash
npm run build
PRINTIFY_API_TOKEN=smoke-test-token printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ci","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | PRINTIFY_API_TOKEN=smoke-test-token timeout 10 node dist/index.js | grep -c '"name":"search_blueprints"'
```

Expected: `1`.

- [ ] **Step 7: Commit**

```bash
git add src/tools/catalog.ts test/tools/catalog-toolset.test.ts .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
Add search_blueprints to the catalog toolset

The issue files this under workflows. It goes in catalog instead: it is
the only way to discover a blueprint_id, so in workflows a user running
PRINTIFY_TOOLSETS=catalog would get the whole drill-down with no way in.

The next-step pointer is in the description rather than the payload,
where the other six catalog tools keep theirs, so it costs nothing per
call.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Point the existing catalog descriptions at the new tool

#17's hand-off note asks for this: the catalog descriptions name no tool that did not exist yet, so none of them mentions searching. `get_print_provider` is the clearest case — it says its blueprint list is cut off at 50 without saying what to do about it.

**Files:**

- Modify: `src/tools/catalog.ts` (the `blueprintId` schema description, and `getPrintProviderTool`'s description)

**Interfaces:**

- Consumes: `searchBlueprintsTool` from Task 4.
- Produces: nothing new.

- [ ] **Step 1: Update the two descriptions**

Replace the `blueprintId` constant's description:

```ts
const blueprintId = z
  .number()
  .int()
  .positive()
  .describe('The catalog blueprint id, from search_blueprints.');
```

In `getPrintProviderTool`, replace the last sentence of the description so the truncation names its remedy:

```ts
  description:
    'Gets one print provider: its name, its address, and the blueprints it offers (id, title, ' +
    `brand and model). Only the first ${String(PROVIDER_BLUEPRINT_LIMIT)} blueprints are ` +
    'listed and blueprint_count gives the total, so use search_blueprints to find a blueprint ' +
    'by name rather than paging this list.',
```

- [ ] **Step 2: Run the suite**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all pass. `test/tools/catalog-toolset.test.ts` asserts tool _output_, not descriptions, so nothing should need updating — if a test does fail on a description string, fix the test to match the new copy.

- [ ] **Step 3: Commit**

```bash
git add src/tools/catalog.ts
git commit -m "$(cat <<'EOF'
Point the catalog descriptions at search_blueprints

get_print_provider told the model its blueprint list stops at 50 and
left it there. Both it and the shared blueprint_id description now name
the tool that finds an id.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Open the pull request

**Files:** none.

- [ ] **Step 1: Verify the whole branch once more**

Run: `npm run lint && npm run typecheck && npm test && npm run build`
Expected: all pass. Paste the test count in the PR body.

- [ ] **Step 2: Check the trailer on every commit**

```bash
git log origin/main..HEAD --format='%h %s%n%(trailers:key=Co-Authored-By)'
```

Expected: every commit carries `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. Fix any that do not with `git rebase` before pushing.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/17-search-blueprints
```

The PR body **must** start with `Closes #17` on its own line, and end with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Cover in the body: the discovery gap this closes, the three departures (catalog toolset not workflows, description-not-payload pointer, HTML stripped before matching), and the relaxation behaviour.

- [ ] **Step 4: Move the board**

```bash
~/.claude/skills/updating-github-project-status/board.sh review
```

Expected: `#17: 'In progress' -> 'In review' ✓`.

---

## Notes for the executor

- **The fixture is shared.** `SEARCH_BLUEPRINTS` is consumed both as parsed `Blueprint` objects (unit tests) and as a raw API body (harness test). It has no `null`s and no `tags`, so both readings are valid. Do not add a `null` to it.
- **Expected id arrays are the fragile part of this plan.** Every one was worked out by hand against the fixture. If a test fails on an ordering, re-derive it from the fixture before changing the implementation — the sort is specified in the spec and the test is likelier to be wrong than `byRank`.
- **`test/tools/catalog.test.ts` is the registry lint**, not the catalog toolset's tests despite the name. It needs no edit, but it is what fails if the tool name, annotations or input schema are wrong.
