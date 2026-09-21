import { z } from 'zod';
import type { Tool } from './define.js';

const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;

/**
 * Everything wrong with the tool definitions, one line per problem, each starting with the tool's
 * name. Empty when all is well. The catalog test runs this over `ALL_TOOLS`.
 */
export function toolProblems(tools: readonly Tool[]): string[] {
  const problems = tools.flatMap((tool) =>
    definitionProblems(tool).map((problem) => `${tool.name}: ${problem}`),
  );
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const { name } of tools) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  for (const name of duplicates) problems.push(`${name}: the name is used by more than one tool`);
  return problems;
}

function definitionProblems(tool: Tool): string[] {
  const { readOnlyHint, destructiveHint } = tool.annotations;
  const problems: string[] = [];
  if (!NAME_PATTERN.test(tool.name) || tool.name.length > MAX_NAME_LENGTH) {
    problems.push('the name must be snake_case, at most 64 characters');
  }
  if (tool.description.trim() === '') problems.push('the description is empty');
  if (readOnlyHint && destructiveHint) problems.push('a read-only tool cannot be destructive');
  if (readOnlyHint && tool.gate !== undefined) problems.push('a read-only tool cannot have a gate');
  if (tool.gate === 'destructive' && !destructiveHint) {
    problems.push('gate "destructive" needs destructiveHint: true');
  }
  problems.push(...inputProblems(tool.input));
  return problems;
}

function inputProblems(input: z.ZodObject): string[] {
  let schema: z.core.JSONSchema.BaseSchema;
  try {
    schema = z.toJSONSchema(input, { io: 'input' });
  } catch {
    return ['the input cannot be converted to JSON Schema'];
  }
  return schema.additionalProperties === false ? [] : ['the input must be a z.strictObject'];
}
