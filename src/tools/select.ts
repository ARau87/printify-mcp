import type { Config } from '../config.js';
import { TOOLSETS } from '../toolsets.js';
import type { Gate, Tool } from './define.js';

export type SkipReason = 'toolset' | Gate;

export interface SkippedTool {
  tool: Tool;
  reason: SkipReason;
}

export interface Selection {
  enabled: readonly Tool[];
  skipped: readonly SkippedTool[];
}

/** The part of the configuration that decides which tools are registered. */
export type SelectionConfig = Pick<Config, 'toolsets' | 'enableOrders' | 'enableDestructive'>;

const GATES: readonly Gate[] = ['orders', 'destructive'];

const GATE_VARIABLES: Readonly<Record<Gate, string>> = {
  orders: 'PRINTIFY_ENABLE_ORDERS',
  destructive: 'PRINTIFY_ENABLE_DESTRUCTIVE',
};

const GATE_DESCRIPTIONS: Readonly<Record<Gate, string>> = {
  orders: 'Order tools that can spend money',
  destructive: 'Irreversible tools',
};

const INSTRUCTIONS_LEAD =
  "Some Printify tools are turned off in this server's configuration. When the user asks for " +
  'something they cover, tell them it is turned off and how to turn it on.';
const INSTRUCTIONS_END =
  'The user sets these in the "env" block of the printify-mcp entry in their MCP client config, ' +
  'then restarts the client.';

/**
 * Splits `tools` into the ones to register and the ones to skip. A tool is skipped when its
 * toolset is not enabled, or else when its gate's flag is off. Both lists keep the order of
 * `tools`.
 */
export function selectTools(tools: readonly Tool[], config: SelectionConfig): Selection {
  const enabled: Tool[] = [];
  const skipped: SkippedTool[] = [];
  for (const tool of tools) {
    const reason = skipReason(tool, config);
    if (reason === undefined) enabled.push(tool);
    else skipped.push({ tool, reason });
  }
  return { enabled, skipped };
}

/** One stderr line per reason that skipped a tool: the gates first, then the toolsets. */
export function skipLogLines(skipped: readonly SkippedTool[]): string[] {
  const lines = GATES.flatMap((gate) => {
    const names = namesSkippedFor(skipped, gate);
    return names === undefined ? [] : [`${GATE_VARIABLES[gate]} is off, skipped: ${names}`];
  });
  const toolsets = toolsetsSkipped(skipped);
  if (toolsets !== undefined) lines.push(`not in PRINTIFY_TOOLSETS, skipped: ${toolsets}`);
  return lines;
}

/**
 * Tells the model which tools are turned off and how the user turns them on, or `undefined` when
 * nothing was skipped.
 */
export function serverInstructions(skipped: readonly SkippedTool[]): string | undefined {
  if (skipped.length === 0) return undefined;
  const lines = [INSTRUCTIONS_LEAD];
  for (const gate of GATES) {
    const names = namesSkippedFor(skipped, gate);
    if (names !== undefined) {
      lines.push(`- ${GATE_DESCRIPTIONS[gate]} (${names}): set ${GATE_VARIABLES[gate]}=true.`);
    }
  }
  const toolsets = toolsetsSkipped(skipped);
  if (toolsets !== undefined) {
    lines.push(`- Toolsets not enabled: ${toolsets}. Add their names to PRINTIFY_TOOLSETS.`);
  }
  lines.push(INSTRUCTIONS_END);
  return lines.join('\n');
}

function skipReason(tool: Tool, config: SelectionConfig): SkipReason | undefined {
  if (!config.toolsets.has(tool.toolset)) return 'toolset';
  if (tool.gate === 'orders' && !config.enableOrders) return 'orders';
  if (tool.gate === 'destructive' && !config.enableDestructive) return 'destructive';
  return undefined;
}

/** `create_order, cancel_order`, or `undefined` when the gate skipped nothing. */
function namesSkippedFor(skipped: readonly SkippedTool[], gate: Gate): string | undefined {
  const names = skipped.filter(({ reason }) => reason === gate).map(({ tool }) => tool.name);
  return names.length === 0 ? undefined : names.join(', ');
}

/** `webhooks (list_webhooks, create_webhook), support (…)` in `TOOLSETS` order, or `undefined`. */
function toolsetsSkipped(skipped: readonly SkippedTool[]): string | undefined {
  const groups = TOOLSETS.flatMap((toolset) => {
    const names = skipped
      .filter(({ tool, reason }) => reason === 'toolset' && tool.toolset === toolset)
      .map(({ tool }) => tool.name);
    return names.length === 0 ? [] : [`${toolset} (${names.join(', ')})`];
  });
  return groups.length === 0 ? undefined : groups.join(', ');
}
