import { describe, expect, it } from 'vitest';
import { ALL_TOOLS } from '../../src/tools/index.js';
import { describeTools, firstSentence, renderToolReference } from '../../src/tools/reference.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  createOrder,
  deleteProduct,
  deleteWebhook,
  fixtureTool,
  listShops,
  listWebhooks,
} from './fixtures.js';

describe('describeTools', () => {
  it('orders the tools by toolset, then by definition order', () => {
    const tools = [listWebhooks, deleteWebhook, createOrder, deleteProduct, listShops];
    expect(describeTools(tools).map(({ name }) => name)).toEqual([
      'list_shops',
      'delete_product',
      'create_order',
      'list_webhooks',
      'delete_webhook',
    ]);
  });

  it('gives name, toolset, gate, annotations with openWorldHint, and description', () => {
    expect(describeTools([deleteProduct, listShops])).toEqual([
      {
        name: 'list_shops',
        toolset: 'shops',
        gate: undefined,
        annotations: { ...READ_ONLY, openWorldHint: true },
        description: 'Lists the shops.',
      },
      {
        name: 'delete_product',
        toolset: 'products',
        gate: 'destructive',
        annotations: { ...DESTRUCTIVE, openWorldHint: true },
        description: 'Deletes a product.',
      },
    ]);
  });

  it('gives an empty list for no tools', () => {
    expect(describeTools([])).toEqual([]);
  });
});

describe('firstSentence', () => {
  it('ends at the first sentence-ending punctuation followed by whitespace', () => {
    expect(firstSentence('Lists shops. Use it when the user asks.')).toBe('Lists shops.');
    expect(firstSentence('Really? Yes.')).toBe('Really?');
  });

  it('keeps a closing parenthesis or quote with the sentence', () => {
    expect(firstSentence('Lists shops (all of them). Then more.')).toBe(
      'Lists shops (all of them).',
    );
    expect(firstSentence('Says "done." Then more.')).toBe('Says "done."');
  });

  it('does not end at an abbreviation', () => {
    expect(firstSentence('Lists shops (e.g. an API shop). Call this first.')).toBe(
      'Lists shops (e.g. an API shop).',
    );
    expect(firstSentence('Covers sizes, colors, etc. and more. Then more.')).toBe(
      'Covers sizes, colors, etc. and more.',
    );
  });

  it('does not end at a period inside a number or an identifier', () => {
    expect(firstSentence('Place it at 0.5/0.5 of the area. Then more.')).toBe(
      'Place it at 0.5/0.5 of the area.',
    );
  });

  it('returns a description with no boundary whole, with line breaks as spaces', () => {
    expect(firstSentence('Gets a\n  product by id')).toBe('Gets a product by id');
    expect(firstSentence('  Gets a product.  ')).toBe('Gets a product.');
  });
});

describe('renderToolReference', () => {
  const rows = describeTools([listShops, createOrder, deleteProduct]);

  it('renders a lead line with the counts and one row per tool', () => {
    const lines = renderToolReference(rows).split('\n');
    expect(lines[0]).toBe('_3 tools in 3 toolsets._');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('| Tool | Toolset | Access | Needs | Description |');
    expect(lines[3]).toBe('| --- | --- | --- | --- | --- |');
    expect(lines.slice(4)).toEqual([
      '| `list_shops` | shops | read-only |  | Lists the shops. |',
      '| `delete_product` | products | destructive | `PRINTIFY_ENABLE_DESTRUCTIVE=true` | Deletes a product. |',
      '| `create_order` | orders | destructive | `PRINTIFY_ENABLE_ORDERS=true` | Places an order. |',
    ]);
  });

  it('marks an ungated writing tool as "writes" with nothing in Needs', () => {
    const upload = fixtureTool({ name: 'upload_image', toolset: 'uploads', annotations: WRITE });
    expect(renderToolReference(describeTools([upload]))).toContain(
      '| `upload_image` | uploads | writes |  | Gets a fixture. |',
    );
  });

  it('keeps the order it is given', () => {
    const reversed = [...rows].reverse();
    const names = renderToolReference(reversed)
      .split('\n')
      .slice(4)
      .map((line) => line.split(' | ')[0]);
    expect(names).toEqual(['| `create_order`', '| `delete_product`', '| `list_shops`']);
  });

  it('escapes a pipe in the description and uses only the first sentence', () => {
    const tool = fixtureTool({ description: 'Gets a | b. Then c.' });
    expect(renderToolReference(describeTools([tool]))).toContain('| Gets a \\| b. |');
  });

  it('renders the empty list as a zero lead line and a header-only table', () => {
    expect(renderToolReference([])).toBe(
      '_0 tools in 0 toolsets._\n\n| Tool | Toolset | Access | Needs | Description |\n| --- | --- | --- | --- | --- |',
    );
  });
});

describe('the real registry', () => {
  const rows = describeTools(ALL_TOOLS);

  it('gives every tool a summary that is a sentence of at most 320 characters', () => {
    for (const row of rows) {
      const summary = firstSentence(row.description);
      expect(summary, row.name).toMatch(/^[A-Z].*[.!?]["')]*$/);
      expect(summary.length, row.name).toBeLessThanOrEqual(320);
    }
  });

  it('renders each tool exactly once', () => {
    const table = renderToolReference(rows);
    for (const row of rows) {
      expect(table.split(`\`${row.name}\``), row.name).toHaveLength(2);
    }
  });
});
