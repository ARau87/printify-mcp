import { describe, expect, it } from 'vitest';
import type { Tool } from '../../src/tools/define.js';
import {
  selectTools,
  serverInstructions,
  skipLogLines,
  type Selection,
  type SelectionConfig,
} from '../../src/tools/select.js';
import { TOOLSETS, type Toolset } from '../../src/toolsets.js';
import { FIXTURE_TOOLS, deleteProduct, listShops, listWebhooks } from './fixtures.js';

const LEAD =
  "Some Printify tools are turned off in this server's configuration. When the user asks for " +
  'something they cover, tell them it is turned off and how to turn it on.';
const END =
  'The user sets these in the "env" block of the printify-mcp entry in their MCP client config, ' +
  'then restarts the client.';

function select(overrides: Partial<SelectionConfig> = {}): Selection {
  return selectTools(FIXTURE_TOOLS, {
    toolsets: new Set(TOOLSETS),
    enableOrders: false,
    enableDestructive: false,
    ...overrides,
  });
}

function toolsets(...names: Toolset[]): ReadonlySet<Toolset> {
  return new Set(names);
}

function names(tools: readonly Tool[]): string[] {
  return tools.map(({ name }) => name);
}

function skipped(selection: Selection): string[] {
  return selection.skipped.map(({ tool, reason }) => `${tool.name}: ${reason}`);
}

describe('selectTools', () => {
  it('skips every gated tool when both flags are off', () => {
    const selection = select();
    expect(names(selection.enabled)).toEqual(['list_shops', 'list_webhooks']);
    expect(skipped(selection)).toEqual([
      'create_order: orders',
      'delete_product: destructive',
      'delete_webhook: destructive',
    ]);
  });

  it('enables the order tools when only PRINTIFY_ENABLE_ORDERS is on', () => {
    const selection = select({ enableOrders: true });
    expect(names(selection.enabled)).toEqual(['list_shops', 'create_order', 'list_webhooks']);
    expect(skipped(selection)).toEqual([
      'delete_product: destructive',
      'delete_webhook: destructive',
    ]);
  });

  it('enables the irreversible tools when only PRINTIFY_ENABLE_DESTRUCTIVE is on', () => {
    const selection = select({ enableDestructive: true });
    expect(names(selection.enabled)).toEqual([
      'list_shops',
      'delete_product',
      'list_webhooks',
      'delete_webhook',
    ]);
    expect(skipped(selection)).toEqual(['create_order: orders']);
  });

  it('enables every tool when both flags are on', () => {
    const selection = select({ enableOrders: true, enableDestructive: true });
    expect(selection.enabled).toEqual(FIXTURE_TOOLS);
    expect(selection.skipped).toEqual([]);
  });

  it('skips a tool of a disabled toolset as "toolset", even when its gate is on', () => {
    const selection = select({
      toolsets: toolsets('shops', 'orders', 'products'),
      enableDestructive: true,
    });
    expect(names(selection.enabled)).toEqual(['list_shops', 'delete_product']);
    expect(skipped(selection)).toEqual([
      'create_order: orders',
      'list_webhooks: toolset',
      'delete_webhook: toolset',
    ]);
  });
});

describe('skipLogLines', () => {
  it('gives one line per reason: orders, destructive, then toolsets', () => {
    const selection = select({ toolsets: toolsets('shops', 'orders', 'products') });
    expect(skipLogLines(selection.skipped)).toEqual([
      'PRINTIFY_ENABLE_ORDERS is off, skipped: create_order',
      'PRINTIFY_ENABLE_DESTRUCTIVE is off, skipped: delete_product',
      'not in PRINTIFY_TOOLSETS, skipped: webhooks (list_webhooks, delete_webhook)',
    ]);
  });

  it('groups skipped toolsets in TOOLSETS order', () => {
    const selection = selectTools([listWebhooks, deleteProduct, listShops], {
      toolsets: toolsets('catalog'),
      enableOrders: true,
      enableDestructive: true,
    });
    expect(skipLogLines(selection.skipped)).toEqual([
      'not in PRINTIFY_TOOLSETS, skipped: shops (list_shops), products (delete_product), ' +
        'webhooks (list_webhooks)',
    ]);
  });

  it('leaves out a reason that skipped nothing', () => {
    expect(skipLogLines(select({ enableOrders: true }).skipped)).toEqual([
      'PRINTIFY_ENABLE_DESTRUCTIVE is off, skipped: delete_product, delete_webhook',
    ]);
  });

  it('gives no lines when nothing is skipped', () => {
    expect(skipLogLines([])).toEqual([]);
  });
});

describe('serverInstructions', () => {
  it('is undefined when nothing is skipped', () => {
    expect(serverInstructions([])).toBeUndefined();
  });

  it('names each group of turned-off tools and how the user turns it on', () => {
    const selection = select({ toolsets: toolsets('shops', 'orders', 'products') });
    expect(serverInstructions(selection.skipped)).toBe(
      `${LEAD}\n` +
        '- Order tools that can spend money (create_order): set PRINTIFY_ENABLE_ORDERS=true.\n' +
        '- Irreversible tools (delete_product): set PRINTIFY_ENABLE_DESTRUCTIVE=true.\n' +
        '- Toolsets not enabled: webhooks (list_webhooks, delete_webhook). Add their names to ' +
        'PRINTIFY_TOOLSETS.\n' +
        END,
    );
  });

  it('lists only the groups that skipped something', () => {
    const instructions = serverInstructions(select({ enableOrders: true }).skipped);
    expect(instructions?.split('\n')).toEqual([
      LEAD,
      '- Irreversible tools (delete_product, delete_webhook): set PRINTIFY_ENABLE_DESTRUCTIVE=true.',
      END,
    ]);
  });
});
