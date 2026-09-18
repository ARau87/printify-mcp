#!/usr/bin/env node
import { main } from './cli.js';

try {
  process.exitCode = main(process.argv.slice(2), process.env);
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`printify-mcp: fatal: ${detail}\n`);
  process.exitCode = 1;
}
