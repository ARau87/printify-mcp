import { describe, expect, it } from 'vitest';
import { toolProblems } from '../../src/tools/check.js';
import { ALL_TOOLS, TOOLS_BY_TOOLSET } from '../../src/tools/index.js';

describe('ALL_TOOLS', () => {
  it('follows every rule for tool definitions', () => {
    expect(toolProblems(ALL_TOOLS)).toEqual([]);
  });

  it('files every tool under its own toolset', () => {
    const misfiled = Object.entries(TOOLS_BY_TOOLSET).flatMap(([toolset, tools]) =>
      tools
        .filter((tool) => tool.toolset !== toolset)
        .map((tool) => `${tool.name} (toolset ${tool.toolset}) is filed under ${toolset}`),
    );
    expect(misfiled).toEqual([]);
  });
});
