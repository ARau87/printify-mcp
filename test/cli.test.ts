import { tmpdir } from 'node:os';
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { main, type CliIo } from '../src/cli.js';
import { PACKAGE_VERSION } from '../src/package-info.js';

const TOKEN = 'Tok-cli-5E4d3C2b1A';
const VARIABLES = [
  'PRINTIFY_API_TOKEN',
  'PRINTIFY_SHOP_ID',
  'PRINTIFY_TOOLSETS',
  'PRINTIFY_ENABLE_ORDERS',
  'PRINTIFY_ENABLE_DESTRUCTIVE',
  'PRINTIFY_UPLOAD_DIRS',
  'PRINTIFY_API_BASE_URL',
];
const TOOLSETS = [
  'shops',
  'catalog',
  'uploads',
  'products',
  'publishing',
  'personalization',
  'orders',
  'support',
  'webhooks',
  'workflows',
];

function fakeIo() {
  const output = { stdout: '', stderr: '' };
  const served: Parameters<CliIo['serve']>[] = [];
  const io: CliIo = {
    stdout: {
      write: (text) => {
        output.stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        output.stderr += text;
      },
    },
    serve: (...args) => {
      served.push(args);
    },
  };
  return { io, output, served };
}

describe('main', () => {
  describe('flags', () => {
    it.each([['--help'], ['-h'], ['--version', '--help']])(
      '%j prints help without needing a token',
      (...argv) => {
        const { io, output, served } = fakeIo();
        expect(main(argv, {}, io)).toBe(0);
        expect(output.stdout).toContain('Usage: printify-mcp [--help] [--version]');
        for (const name of [...VARIABLES, ...TOOLSETS]) expect(output.stdout).toContain(name);
        expect(output.stderr).toBe('');
        expect(served).toEqual([]);
      },
    );

    it.each(['--version', '-v'])('%s prints the version without needing a token', (flag) => {
      const { io, output, served } = fakeIo();
      expect(main([flag], {}, io)).toBe(0);
      expect(output.stdout).toBe(`${PACKAGE_VERSION}\n`);
      expect(output.stderr).toBe('');
      expect(served).toEqual([]);
    });

    it.each([
      [['--foo'], "unknown option '--foo'"],
      [['-x'], "unknown option '-x'"],
      [['serve'], "unexpected argument 'serve'"],
      [['--help=yes'], "option '--help' does not take a value"],
      [['--constructor'], "unknown option '--constructor'"],
      [['--toString'], "unknown option '--toString'"],
    ])('%j is a usage error', (argv, message) => {
      const { io, output, served } = fakeIo();
      expect(main(argv, { PRINTIFY_API_TOKEN: TOKEN }, io)).toBe(2);
      expect(output.stderr).toBe(`printify-mcp: ${message}. Run printify-mcp --help for usage.\n`);
      expect(output.stdout).toBe('');
      expect(served).toEqual([]);
    });
  });

  describe('configuration errors', () => {
    it('exits 1 and names PRINTIFY_API_TOKEN when the token is missing', () => {
      const { io, output, served } = fakeIo();
      expect(main([], {}, io)).toBe(1);
      expect(output.stderr).toBe(
        'printify-mcp: invalid configuration\n' +
          '  - PRINTIFY_API_TOKEN is required. Create a Personal Access Token in Printify and set ' +
          'it in your MCP client config: https://developers.printify.com/#authentication\n' +
          'Set these in the "env" block of the printify-mcp entry in your MCP client config.\n',
      );
      expect(output.stdout).toBe('');
      expect(served).toEqual([]);
    });

    it('exits 1 and names PRINTIFY_TOOLSETS for an unknown toolset', () => {
      const { io, output, served } = fakeIo();
      expect(main([], { PRINTIFY_API_TOKEN: TOKEN, PRINTIFY_TOOLSETS: 'prodcts' }, io)).toBe(1);
      expect(output.stderr).toContain(
        '  - PRINTIFY_TOOLSETS: unknown toolset "prodcts" (did you mean "products"?)',
      );
      expect(output.stdout).toBe('');
      expect(served).toEqual([]);
    });

    it('prints warnings before the errors', () => {
      const { io, output } = fakeIo();
      expect(main([], { PRINTIFY_TOKEN: TOKEN }, io)).toBe(1);
      expect(output.stderr).toMatch(
        /^printify-mcp: warning: unknown variable PRINTIFY_TOKEN\. .*\nprintify-mcp: invalid configuration\n/,
      );
      expect(output.stderr).not.toContain(TOKEN);
    });
  });

  describe('successful start', () => {
    it('serves on stdio and logs a summary', () => {
      const { io, output, served } = fakeIo();
      expect(main([], { PRINTIFY_API_TOKEN: TOKEN }, io)).toBe(0);
      expect(served).toHaveLength(1);
      const call = served[0];
      if (call === undefined) throw new Error('serve was not called');
      const [factory] = call;
      expect(factory()).toBeInstanceOf(McpServer);
      expect(output.stdout).toBe('');
      expect(output.stderr).toBe(
        `printify-mcp: ${PACKAGE_VERSION} on stdio (toolsets: all; orders: off; destructive: off; ` +
          'default shop: none; upload dirs: 0)\n',
      );
    });

    it('summarises a customised configuration without the token', () => {
      const { io, output } = fakeIo();
      const env = {
        PRINTIFY_API_TOKEN: TOKEN,
        PRINTIFY_SHOP_ID: '12345',
        PRINTIFY_TOOLSETS: 'products,catalog',
        PRINTIFY_ENABLE_ORDERS: 'true',
        PRINTIFY_UPLOAD_DIRS: tmpdir(),
        PRINTIFY_API_BASE_URL: 'http://localhost:8080/',
      };
      expect(main([], env, io)).toBe(0);
      expect(output.stderr).toBe(
        `printify-mcp: ${PACKAGE_VERSION} on stdio (toolsets: catalog, products; orders: on; ` +
          'destructive: off; default shop: 12345; upload dirs: 1; api: http://localhost:8080)\n',
      );
      expect(output.stderr).not.toContain(TOKEN);
    });

    it('summarises an overridden base URL by its origin only', () => {
      const { io, output } = fakeIo();
      const env = {
        PRINTIFY_API_TOKEN: TOKEN,
        PRINTIFY_API_BASE_URL: 'https://proxy.example.com/Tok-path-secret/printify',
      };
      expect(main([], env, io)).toBe(0);
      expect(output.stderr).toMatch(/; api: https:\/\/proxy\.example\.com\)\n$/);
      expect(output.stderr).not.toContain('Tok-path-secret');
    });

    it('prints warnings before the summary', () => {
      const { io, output } = fakeIo();
      expect(main([], { PRINTIFY_API_TOKEN: TOKEN, PRINTIFY_ENABLE_ORDER: 'true' }, io)).toBe(0);
      expect(output.stderr.split('\n')[0]).toBe(
        'printify-mcp: warning: unknown variable PRINTIFY_ENABLE_ORDER (did you mean PRINTIFY_ENABLE_ORDERS?)',
      );
      expect(output.stderr.split('\n')[1]).toMatch(/^printify-mcp: .* on stdio \(/);
    });

    it('logs out-of-band server errors to stderr', () => {
      const { io, output, served } = fakeIo();
      main([], { PRINTIFY_API_TOKEN: TOKEN }, io);
      const call = served[0];
      if (call === undefined) throw new Error('serve was not called');
      const [, options] = call;
      options.onerror(new Error('stdout closed'));
      expect(output.stderr).toContain('printify-mcp: error: stdout closed\n');
      expect(output.stdout).toBe('');
    });
  });
});
