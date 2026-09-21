import { describe, expect, it } from 'vitest';
import { toolProblems } from '../../src/tools/check.js';
import { ALL_TOOLS } from '../../src/tools/index.js';

describe('ALL_TOOLS', () => {
  it('follows every rule for tool definitions', () => {
    expect(toolProblems(ALL_TOOLS)).toEqual([]);
  });
});
