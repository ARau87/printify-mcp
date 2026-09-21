import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolProblems } from '../../src/tools/check.js';
import type { ToolDefinition } from '../../src/tools/define.js';
import { READ_ONLY, WRITE, fixtureTool, listShops } from './fixtures.js';

const LONG_NAME = 'a'.repeat(65);

describe('toolProblems', () => {
  it('finds nothing wrong with valid tools', () => {
    expect(toolProblems([fixtureTool(), listShops])).toEqual([]);
  });

  it.each(['list_shops', 'get_product_gpsr', 'a', 'x2', 'a'.repeat(64)])(
    'accepts the name %s',
    (name) => {
      expect(toolProblems([fixtureTool({ name })])).toEqual([]);
    },
  );

  it('accepts a strict input with a refinement', () => {
    const input = z.strictObject({ a: z.string() }).refine((value) => value.a !== '', 'empty');
    expect(toolProblems([fixtureTool({ input })])).toEqual([]);
  });

  it.each<[string, Partial<ToolDefinition<z.ZodObject>>, string]>([
    [
      'a camelCase name',
      { name: 'getFixture' },
      'getFixture: the name must be snake_case, at most 64 characters',
    ],
    [
      'a double underscore',
      { name: 'get__fixture' },
      'get__fixture: the name must be snake_case, at most 64 characters',
    ],
    [
      'a leading digit',
      { name: '2get' },
      '2get: the name must be snake_case, at most 64 characters',
    ],
    [
      'a name over 64 characters',
      { name: LONG_NAME },
      `${LONG_NAME}: the name must be snake_case, at most 64 characters`,
    ],
    ['a blank description', { description: ' \n' }, 'get_fixture: the description is empty'],
    [
      'a destructive read-only tool',
      { annotations: { ...READ_ONLY, destructiveHint: true } },
      'get_fixture: a read-only tool cannot be destructive',
    ],
    [
      'a gated read-only tool',
      { gate: 'orders' },
      'get_fixture: a read-only tool cannot have a gate',
    ],
    [
      'gate "destructive" without destructiveHint',
      { gate: 'destructive', annotations: WRITE },
      'get_fixture: gate "destructive" needs destructiveHint: true',
    ],
    [
      'an input that strips unknown keys',
      { input: z.object({ id: z.string() }) },
      'get_fixture: the input must be a z.strictObject',
    ],
    [
      'an input that JSON Schema cannot express',
      { input: z.strictObject({ at: z.date() }) },
      'get_fixture: the input cannot be converted to JSON Schema',
    ],
  ])('reports %s', (_, overrides, problem) => {
    expect(toolProblems([fixtureTool(overrides)])).toEqual([problem]);
  });

  it('reports every problem of a tool, in rule order', () => {
    const tool = fixtureTool({ name: 'Bad', description: '', input: z.object({}) });
    expect(toolProblems([tool])).toEqual([
      'Bad: the name must be snake_case, at most 64 characters',
      'Bad: the description is empty',
      'Bad: the input must be a z.strictObject',
    ]);
  });

  it('reports a duplicate name once, after the definition problems', () => {
    const again = fixtureTool({ name: 'list_shops', description: '' });
    expect(toolProblems([listShops, again, listShops])).toEqual([
      'list_shops: the description is empty',
      'list_shops: the name is used by more than one tool',
    ]);
  });
});
