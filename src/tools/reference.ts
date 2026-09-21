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
