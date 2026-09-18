import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig, type Config, type ConfigResult, type Env } from '../src/config.js';

// Mixed case on purpose: some values are lower-cased, and the token must not leak through them.
const TOKEN = 'Tok-9F8e7D6c5B4a';
const VALID_TOOLSETS =
  'shops, catalog, uploads, products, publishing, personalization, orders, support, webhooks, workflows';

function load(extra: Env = {}): ConfigResult {
  return loadConfig({ PRINTIFY_API_TOKEN: TOKEN, ...extra });
}

function configOf(result: ConfigResult): Config {
  if (!result.ok) throw new Error(`expected a valid config, got: ${result.errors.join('; ')}`);
  return result.config;
}

function errorsOf(result: ConfigResult): string[] {
  if (result.ok) throw new Error('expected configuration errors');
  return result.errors;
}

describe('loadConfig', () => {
  it('applies the defaults when only the token is set', () => {
    const result = load();
    const config = configOf(result);
    expect(config.token.reveal()).toBe(TOKEN);
    expect(config.shopId).toBeUndefined();
    expect([...config.toolsets].join(', ')).toBe(VALID_TOOLSETS);
    expect(config.enableOrders).toBe(false);
    expect(config.enableDestructive).toBe(false);
    expect(config.uploadDirs).toEqual([]);
    expect(config.apiBaseUrl).toBe('https://api.printify.com');
    expect(result.warnings).toEqual([]);
  });

  it('treats empty optional variables as unset', () => {
    const config = configOf(
      load({
        PRINTIFY_SHOP_ID: '',
        PRINTIFY_TOOLSETS: '  ',
        PRINTIFY_ENABLE_ORDERS: '',
        PRINTIFY_ENABLE_DESTRUCTIVE: ' ',
        PRINTIFY_UPLOAD_DIRS: '',
        PRINTIFY_API_BASE_URL: ' ',
      }),
    );
    expect(config.shopId).toBeUndefined();
    expect(config.toolsets.size).toBe(10);
    expect(config.enableOrders).toBe(false);
    expect(config.enableDestructive).toBe(false);
    expect(config.uploadDirs).toEqual([]);
    expect(config.apiBaseUrl).toBe('https://api.printify.com');
  });

  it('collects every problem in one result', () => {
    const errors = errorsOf(
      loadConfig({
        PRINTIFY_SHOP_ID: 'abc',
        PRINTIFY_TOOLSETS: 'nope',
        PRINTIFY_API_BASE_URL: 'http://api.printify.com',
      }),
    );
    expect(errors).toHaveLength(4);
    expect(errors.map((error) => error.split(/[ :]/)[0])).toEqual([
      'PRINTIFY_API_TOKEN',
      'PRINTIFY_SHOP_ID',
      'PRINTIFY_TOOLSETS',
      'PRINTIFY_API_BASE_URL',
    ]);
  });

  describe('PRINTIFY_API_TOKEN', () => {
    it.each([undefined, '', '   '])('is required (%j)', (value) => {
      expect(errorsOf(loadConfig({ PRINTIFY_API_TOKEN: value }))).toEqual([
        'PRINTIFY_API_TOKEN is required. Create a Personal Access Token in Printify and set it in ' +
          'your MCP client config: https://developers.printify.com/#authentication',
      ]);
    });

    it('is trimmed', () => {
      const config = configOf(loadConfig({ PRINTIFY_API_TOKEN: `  ${TOKEN}\n` }));
      expect(config.token.reveal()).toBe(TOKEN);
    });

    it('is redacted when the config is printed or serialised', () => {
      const config = configOf(load());
      expect(String(config.token)).toBe('[redacted]');
      expect(JSON.stringify(config)).not.toContain(TOKEN);
      expect(inspect(config)).not.toContain(TOKEN);
    });
  });

  describe('PRINTIFY_SHOP_ID', () => {
    it('is parsed as a number', () => {
      expect(configOf(load({ PRINTIFY_SHOP_ID: ' 12345 ' })).shopId).toBe(12345);
    });

    it.each(['abc', '12.5', '-1', '1e3', '99999999999999999999'])('rejects %j', (value) => {
      expect(errorsOf(load({ PRINTIFY_SHOP_ID: value }))).toEqual([
        `PRINTIFY_SHOP_ID must be a numeric shop id, got "${value}"`,
      ]);
    });
  });

  describe('PRINTIFY_TOOLSETS', () => {
    it('trims, lower-cases, skips empty entries and keeps the canonical order', () => {
      const config = configOf(load({ PRINTIFY_TOOLSETS: ' Products, catalog,,CATALOG, ' }));
      expect([...config.toolsets]).toEqual(['catalog', 'products']);
    });

    it('reports each unknown toolset with a suggestion when one is close', () => {
      expect(errorsOf(load({ PRINTIFY_TOOLSETS: 'Prodcts,catalog,zzzzzz' }))).toEqual([
        `PRINTIFY_TOOLSETS: unknown toolset "Prodcts" (did you mean "products"?). Valid toolsets: ${VALID_TOOLSETS}`,
        `PRINTIFY_TOOLSETS: unknown toolset "zzzzzz". Valid toolsets: ${VALID_TOOLSETS}`,
      ]);
    });

    it('rejects a value that names no toolsets', () => {
      expect(errorsOf(load({ PRINTIFY_TOOLSETS: ' , ,' }))).toEqual([
        'PRINTIFY_TOOLSETS names no toolsets. Leave it unset to enable all of them.',
      ]);
    });
  });

  describe('PRINTIFY_ENABLE_ORDERS and PRINTIFY_ENABLE_DESTRUCTIVE', () => {
    it.each([
      ['true', true],
      ['TRUE', true],
      [' True ', true],
      ['false', false],
      ['FALSE', false],
    ])('read %j as %s', (value, expected) => {
      const config = configOf(
        load({ PRINTIFY_ENABLE_ORDERS: value, PRINTIFY_ENABLE_DESTRUCTIVE: value }),
      );
      expect(config.enableOrders).toBe(expected);
      expect(config.enableDestructive).toBe(expected);
    });

    it.each(['1', '0', 'yes', 'on'])('reject %j', (value) => {
      expect(
        errorsOf(load({ PRINTIFY_ENABLE_ORDERS: value, PRINTIFY_ENABLE_DESTRUCTIVE: value })),
      ).toEqual([
        `PRINTIFY_ENABLE_ORDERS must be "true" or "false", got "${value}"`,
        `PRINTIFY_ENABLE_DESTRUCTIVE must be "true" or "false", got "${value}"`,
      ]);
    });
  });

  describe('PRINTIFY_API_BASE_URL', () => {
    it.each([
      ['https://api.printify.com/', 'https://api.printify.com'],
      ['https://proxy.example.com/printify/', 'https://proxy.example.com/printify'],
      ['http://localhost:8080', 'http://localhost:8080'],
      ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
      ['http://[::1]:8080', 'http://[::1]:8080'],
    ])('accepts %s', (value, expected) => {
      expect(configOf(load({ PRINTIFY_API_BASE_URL: value })).apiBaseUrl).toBe(expected);
    });

    it('rejects a value that is not a URL', () => {
      expect(errorsOf(load({ PRINTIFY_API_BASE_URL: 'api.printify.com' }))).toEqual([
        'PRINTIFY_API_BASE_URL is not a valid URL',
      ]);
    });

    it.each(['http://api.printify.com', 'ftp://api.printify.com'])('rejects %s', (value) => {
      expect(errorsOf(load({ PRINTIFY_API_BASE_URL: value }))).toEqual([
        'PRINTIFY_API_BASE_URL must use https (http is allowed only for localhost)',
      ]);
    });

    it.each([
      'https://user:hunter2@api.printify.com',
      'https://api.printify.com/?page=1',
      'https://api.printify.com/?',
      'https://api.printify.com/#top',
    ])('rejects %s', (value) => {
      expect(errorsOf(load({ PRINTIFY_API_BASE_URL: value }))).toEqual([
        'PRINTIFY_API_BASE_URL must not contain credentials, a query or a fragment',
      ]);
    });
  });
});
