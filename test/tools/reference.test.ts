import { describe, expect, it } from 'vitest';
import { describeTools } from '../../src/tools/reference.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  createOrder,
  deleteProduct,
  deleteWebhook,
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
