import { TOOLSETS, type Toolset } from '../toolsets.js';
import { mcpAnnotations, type Gate, type Tool, type ToolAnnotations } from './define.js';

/** One row of the README's tool reference. */
export interface ToolReference {
  name: string;
  toolset: Toolset;
  gate: Gate | undefined;
  annotations: ToolAnnotations & { openWorldHint: true };
  description: string;
}

/** Every tool, in `TOOLSETS` order and then in the order of `tools`. Needs no configuration. */
export function describeTools(tools: readonly Tool[]): ToolReference[] {
  return TOOLSETS.flatMap((toolset) =>
    tools
      .filter((tool) => tool.toolset === toolset)
      .map((tool) => ({
        name: tool.name,
        toolset: tool.toolset,
        gate: tool.gate,
        annotations: mcpAnnotations(tool),
        description: tool.description,
      })),
  );
}

/**
 * The first sentence of a tool description: up to the first `.`, `!` or `?` (plus any closing
 * quote or parenthesis) that is followed by whitespace, unless it ends an abbreviation such as
 * "e.g.". When nothing matches, the whole text is the sentence. Line breaks become spaces.
 */
export function firstSentence(description: string): string {
  const text = description.replace(/\s+/g, ' ').trim();
  const match = /(?<!\b(?:e\.g|i\.e|etc|vs))[.!?]["')]*(?=\s)/.exec(text);
  return match === null ? text : text.slice(0, match.index + match[0].length);
}

const GATE_FLAGS = {
  orders: 'PRINTIFY_ENABLE_ORDERS=true',
  destructive: 'PRINTIFY_ENABLE_DESTRUCTIVE=true',
} as const;

function access(annotations: ToolAnnotations): string {
  if (annotations.readOnlyHint) return 'read-only';
  return annotations.destructiveHint ? 'destructive' : 'writes';
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|');
}

/**
 * The README's tool reference as Markdown: a lead line with the counts, then one table in the
 * order of `rows`. Columns are not padded; `scripts/docs-tools.js` runs Prettier over the result.
 */
export function renderToolReference(rows: readonly ToolReference[]): string {
  const toolsets = new Set(rows.map((row) => row.toolset)).size;
  const lines = [
    `_${String(rows.length)} tools in ${String(toolsets)} toolsets._`,
    '',
    '| Tool | Toolset | Access | Needs | Description |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((row) => {
      const needs = row.gate === undefined ? '' : `\`${GATE_FLAGS[row.gate]}\``;
      const summary = cell(firstSentence(row.description));
      return `| \`${row.name}\` | ${row.toolset} | ${access(row.annotations)} | ${needs} | ${summary} |`;
    }),
  ];
  return lines.join('\n');
}
