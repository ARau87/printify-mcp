import { delimiter } from 'node:path';
import { parseArgs } from 'node:util';
import type { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { DEFAULT_API_BASE_URL, loadConfig, type Config, type Env } from './config.js';
import { createLogger } from './log.js';
import { PACKAGE_VERSION } from './package-info.js';
import { createCatalog } from './printify/catalog.js';
import { createPrintifyClient } from './printify/client.js';
import { createShopDirectory } from './printify/shops.js';
import { createServer } from './server.js';
import type { ToolServices } from './tools/define.js';
import { ALL_TOOLS } from './tools/index.js';
import { selectTools, serverInstructions, skipLogLines, type Selection } from './tools/select.js';
import { TOOLSETS } from './toolsets.js';

export interface CliIo {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  serve: (factory: () => McpServer, options: { onerror: (error: Error) => void }) => unknown;
}

const defaultIo: CliIo = { stdout: process.stdout, stderr: process.stderr, serve: serveStdio };

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type Command = { kind: 'help' | 'version' | 'serve' } | { kind: 'usage-error'; message: string };

function parseCommand(argv: readonly string[]): Command {
  const { tokens } = parseArgs({
    args: [...argv],
    options: OPTIONS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });
  const names = new Set<string>();
  for (const token of tokens) {
    if (token.kind === 'positional') {
      return { kind: 'usage-error', message: `unexpected argument '${token.value}'` };
    }
    if (token.kind !== 'option') continue;
    if (!Object.hasOwn(OPTIONS, token.name)) {
      return { kind: 'usage-error', message: `unknown option '${token.rawName}'` };
    }
    if (token.value !== undefined) {
      return { kind: 'usage-error', message: `option '${token.rawName}' does not take a value` };
    }
    names.add(token.name);
  }
  if (names.has('help')) return { kind: 'help' };
  if (names.has('version')) return { kind: 'version' };
  return { kind: 'serve' };
}

function helpText(): string {
  return `printify-mcp ${PACKAGE_VERSION}: MCP server for the Printify print-on-demand API.

Usage: printify-mcp [--help] [--version]

Speaks MCP over stdio. Configure it with environment variables in your MCP client config:

  PRINTIFY_API_TOKEN           required  Printify Personal Access Token
  PRINTIFY_SHOP_ID             optional  Default shop for shop-scoped tools
  PRINTIFY_TOOLSETS            optional  Comma-separated toolsets to enable (default: all)
  PRINTIFY_ENABLE_ORDERS       optional  "true" enables tools that place orders and spend money
  PRINTIFY_ENABLE_DESTRUCTIVE  optional  "true" enables irreversible tools (delete, disconnect, archive)
  PRINTIFY_UPLOAD_DIRS         optional  Directories local-file uploads may read from, separated by "${delimiter}"
  PRINTIFY_API_BASE_URL        optional  API base URL (default: ${DEFAULT_API_BASE_URL})

Toolsets: ${TOOLSETS.join(', ')}

Options:
  -h, --help     Show this help
  -v, --version  Show the version

Documentation: https://github.com/ARau87/printify-mcp#readme
`;
}

function configErrorText(errors: readonly string[]): string {
  const lines = errors.map((error) => `  - ${error}\n`).join('');
  return (
    `printify-mcp: invalid configuration\n${lines}` +
    'Set these in the "env" block of the printify-mcp entry in your MCP client config.\n'
  );
}

function summary(config: Config, selection: Selection): string {
  const total = selection.enabled.length + selection.skipped.length;
  const toolsets =
    config.toolsets.size === TOOLSETS.length
      ? 'all'
      : TOOLSETS.filter((toolset) => config.toolsets.has(toolset)).join(', ');
  const parts = [
    `tools: ${String(selection.enabled.length)} of ${String(total)}`,
    `toolsets: ${toolsets}`,
    `orders: ${config.enableOrders ? 'on' : 'off'}`,
    `destructive: ${config.enableDestructive ? 'on' : 'off'}`,
    `default shop: ${config.shopId === undefined ? 'none' : String(config.shopId)}`,
    `upload dirs: ${String(config.uploadDirs.length)}`,
  ];
  // Only the origin is printed: the path can carry credentials, e.g. a proxy token in the URL.
  if (config.apiBaseUrl !== DEFAULT_API_BASE_URL) {
    parts.push(`api: ${new URL(config.apiBaseUrl).origin}`);
  }
  return `${PACKAGE_VERSION} on stdio (${parts.join('; ')})`;
}

/**
 * Runs the command line and returns the exit code. When it starts the server it returns 0 and the
 * process keeps running until stdin closes.
 */
export function main(argv: readonly string[], env: Env, io: CliIo = defaultIo): number {
  const command = parseCommand(argv);
  switch (command.kind) {
    case 'usage-error':
      io.stderr.write(`printify-mcp: ${command.message}. Run printify-mcp --help for usage.\n`);
      return 2;
    case 'help':
      io.stdout.write(helpText());
      return 0;
    case 'version':
      io.stdout.write(`${PACKAGE_VERSION}\n`);
      return 0;
    case 'serve':
      break;
  }

  const log = createLogger((text) => io.stderr.write(text));
  const result = loadConfig(env);
  for (const warning of result.warnings) log.warn(warning);
  if (!result.ok) {
    io.stderr.write(configErrorText(result.errors));
    return 1;
  }

  // Everything below happens once per process, however often serve calls the factory: one
  // client (and so one rate limiter) and one shop cache for every server instance.
  const { config } = result;
  const selection = selectTools(ALL_TOOLS, config);
  const client = createPrintifyClient({ token: config.token, baseUrl: config.apiBaseUrl });
  const services: ToolServices = {
    client,
    config,
    log,
    shops: createShopDirectory(client),
    catalog: createCatalog(client),
  };
  const instructions = serverInstructions(selection.skipped);
  io.serve(() => createServer({ tools: selection.enabled, services, instructions }), {
    onerror: (error) => {
      log.error(error.message);
    },
  });
  log.info(summary(config, selection));
  for (const line of skipLogLines(selection.skipped)) log.info(line);
  return 0;
}
