import { z } from 'zod';
import { Secret } from './secret.js';
import { closest } from './suggest.js';
import { TOOLSETS, isToolset, type Toolset } from './toolsets.js';

export const DEFAULT_API_BASE_URL = 'https://api.printify.com';

/** The environment as `process.env` provides it. */
export type Env = Readonly<Record<string, string | undefined>>;

export interface Config {
  token: Secret;
  shopId: number | undefined;
  toolsets: ReadonlySet<Toolset>;
  enableOrders: boolean;
  enableDestructive: boolean;
  /** Real paths of the directories local-file uploads may read from. Empty disables them. */
  uploadDirs: readonly string[];
  /** Base URL without a trailing slash. */
  apiBaseUrl: string;
}

export type ConfigResult =
  | { ok: true; config: Config; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A trimmed variable; an empty value counts as unset. */
const variable = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === '' ? undefined : trimmed;
  });

function flag(name: string) {
  return variable.transform((value, ctx) => {
    const normalised = value?.toLowerCase();
    if (normalised === undefined || normalised === 'false') return false;
    if (normalised === 'true') return true;
    ctx.addIssue(`${name} must be "true" or "false", got "${value ?? ''}"`);
    return z.NEVER;
  });
}

const envSchema = z.object({
  PRINTIFY_API_TOKEN: variable.transform((value, ctx) => {
    if (value !== undefined) return new Secret(value);
    ctx.addIssue(
      'PRINTIFY_API_TOKEN is required. Create a Personal Access Token in Printify and set it in ' +
        'your MCP client config: https://developers.printify.com/#authentication',
    );
    return z.NEVER;
  }),

  PRINTIFY_SHOP_ID: variable.transform((value, ctx) => {
    if (value === undefined) return undefined;
    const id = Number(value);
    if (/^\d+$/.test(value) && Number.isSafeInteger(id)) return id;
    ctx.addIssue(`PRINTIFY_SHOP_ID must be a numeric shop id, got "${value}"`);
    return z.NEVER;
  }),

  PRINTIFY_TOOLSETS: variable.transform((value, ctx): ReadonlySet<Toolset> => {
    if (value === undefined) return new Set(TOOLSETS);
    const entries = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    if (entries.length === 0) {
      ctx.addIssue('PRINTIFY_TOOLSETS names no toolsets. Leave it unset to enable all of them.');
      return z.NEVER;
    }
    const names = entries.map((entry) => entry.toLowerCase());
    const unknown = entries.filter((_, index) => !isToolset(names[index] ?? ''));
    for (const entry of unknown) {
      const suggestion = closest(entry.toLowerCase(), TOOLSETS);
      const hint = suggestion === undefined ? '' : ` (did you mean "${suggestion}"?)`;
      ctx.addIssue(
        `PRINTIFY_TOOLSETS: unknown toolset "${entry}"${hint}. Valid toolsets: ${TOOLSETS.join(', ')}`,
      );
    }
    if (unknown.length > 0) return z.NEVER;
    return new Set(TOOLSETS.filter((toolset) => names.includes(toolset)));
  }),

  PRINTIFY_ENABLE_ORDERS: flag('PRINTIFY_ENABLE_ORDERS'),
  PRINTIFY_ENABLE_DESTRUCTIVE: flag('PRINTIFY_ENABLE_DESTRUCTIVE'),

  PRINTIFY_API_BASE_URL: variable.transform((value, ctx) => {
    if (value === undefined) return DEFAULT_API_BASE_URL;
    // The value is never echoed: a URL can carry credentials.
    if (!URL.canParse(value)) {
      ctx.addIssue('PRINTIFY_API_BASE_URL is not a valid URL');
      return z.NEVER;
    }
    const url = new URL(value);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname))
    ) {
      ctx.addIssue('PRINTIFY_API_BASE_URL must use https (http is allowed only for localhost)');
      return z.NEVER;
    }
    if (url.username !== '' || url.password !== '' || value.includes('?') || value.includes('#')) {
      ctx.addIssue('PRINTIFY_API_BASE_URL must not contain credentials, a query or a fragment');
      return z.NEVER;
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
  }),
});

/**
 * Reads and validates the configuration from `env`. Never throws and never reads `process.env`
 * itself. All problems are collected; warnings are returned whether or not the config is valid.
 */
export function loadConfig(env: Env): ConfigResult {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((issue) => issue.message), warnings: [] };
  }
  const data = parsed.data;
  return {
    ok: true,
    warnings: [],
    config: {
      token: data.PRINTIFY_API_TOKEN,
      shopId: data.PRINTIFY_SHOP_ID,
      toolsets: data.PRINTIFY_TOOLSETS,
      enableOrders: data.PRINTIFY_ENABLE_ORDERS,
      enableDestructive: data.PRINTIFY_ENABLE_DESTRUCTIVE,
      uploadDirs: [],
      apiBaseUrl: data.PRINTIFY_API_BASE_URL,
    },
  };
}
