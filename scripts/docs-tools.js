// Regenerates the tool reference in README.md from the registry. `--check` only compares.
// Imports from dist/, so run it through `npm run docs:tools`, which builds first.
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { ALL_TOOLS } from '../dist/tools/index.js';
import { describeTools, renderToolReference } from '../dist/tools/reference.js';

const START = '<!-- tools:start -->';
const END = '<!-- tools:end -->';
const README = fileURLToPath(new URL('../README.md', import.meta.url));

function fail(message, code = 1) {
  process.stderr.write(`docs-tools: ${message}\n`);
  process.exit(code);
}

function splice(readme, block) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start === -1 || end === -1)
    fail(`README.md is missing the ${start === -1 ? START : END} marker`);
  if (readme.indexOf(START, start + 1) !== -1 || readme.indexOf(END, end + 1) !== -1) {
    fail('README.md has more than one tools marker pair');
  }
  if (end < start) fail(`README.md has ${END} before ${START}`);
  return `${readme.slice(0, start + START.length)}\n\n${block}\n\n${readme.slice(end)}`;
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check')) fail('usage: node scripts/docs-tools.js [--check]', 2);
const check = args.includes('--check');

const current = await readFile(README, 'utf8');
const spliced = splice(current, renderToolReference(describeTools(ALL_TOOLS)));
const options = (await prettier.resolveConfig(README)) ?? {};
const next = await prettier.format(spliced, { ...options, filepath: README });

if (next === current) {
  process.stdout.write('README.md tool reference is up to date\n');
} else if (check) {
  fail('README.md tool reference is out of date; run npm run docs:tools');
} else {
  await writeFile(README, next);
  process.stdout.write('README.md tool reference updated\n');
}
