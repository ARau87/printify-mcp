import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Resolves from both src/ (tests) and dist/ (the built package): each sits one level below the root.
const packageJson = z
  .object({ name: z.string(), version: z.string() })
  .parse(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));

export const PACKAGE_NAME = packageJson.name;
export const PACKAGE_VERSION = packageJson.version;
