import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, sep } from 'node:path';
import { z } from 'zod';
import { redactJwts } from './redact.js';
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
    if (value === undefined) {
      ctx.addIssue(
        'PRINTIFY_API_TOKEN is required. Create a Personal Access Token in Printify and set it in ' +
          'your MCP client config: https://developers.printify.com/#authentication',
      );
      return z.NEVER;
    }
    // Never echo the value: a header-breaking character is still part of the token.
    if (/[^\x21-\x7e]/.test(value)) {
      ctx.addIssue(
        'PRINTIFY_API_TOKEN must contain only visible ASCII characters, with no spaces or line breaks',
      );
      return z.NEVER;
    }
    return new Secret(value);
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

  PRINTIFY_UPLOAD_DIRS: variable.transform((value, ctx): readonly string[] => {
    if (value === undefined) return [];
    const dirs: string[] = [];
    const errors: string[] = [];
    for (const entry of value.split(delimiter).map((part) => part.trim())) {
      if (entry === '') continue;
      const result = resolveUploadDir(entry);
      if (result.ok) dirs.push(result.dir);
      else errors.push(result.error);
    }
    for (const error of errors) ctx.addIssue(error);
    return errors.length > 0 ? z.NEVER : [...new Set(dirs)];
  }),

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
    const pathname = url.pathname.replace(/\/+$/, '');
    if (/\/v[12]$/i.test(pathname)) {
      ctx.addIssue(
        'PRINTIFY_API_BASE_URL must not end in /v1 or /v2; the server adds the API version itself',
      );
      return z.NEVER;
    }
    return `${url.origin}${pathname}`;
  }),
});

const KNOWN_VARIABLES = Object.keys(envSchema.shape);

function resolveUploadDir(entry: string): { ok: true; dir: string } | { ok: false; error: string } {
  const path = expandHome(entry);
  if (!isAbsolute(path)) {
    return { ok: false, error: `PRINTIFY_UPLOAD_DIRS: "${entry}" is not an absolute path` };
  }
  try {
    if (!statSync(path).isDirectory()) {
      return { ok: false, error: `PRINTIFY_UPLOAD_DIRS: "${entry}" is not a directory` };
    }
    return { ok: true, dir: realpathSync(path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const problem =
      code === 'ENOENT' || code === 'ENOTDIR'
        ? 'does not exist'
        : `cannot be read (${code ?? 'unknown error'})`;
    return { ok: false, error: `PRINTIFY_UPLOAD_DIRS: "${entry}" ${problem}` };
  }
}

function expandHome(entry: string): string {
  if (entry === '~') return homedir();
  if (entry.startsWith('~/') || entry.startsWith(`~${sep}`)) return join(homedir(), entry.slice(2));
  return entry;
}

function unknownVariableWarnings(env: Env): string[] {
  const warnings: string[] = [];
  for (const name of Object.keys(env)) {
    const upper = name.toUpperCase();
    if (!upper.startsWith('PRINTIFY_') || KNOWN_VARIABLES.includes(name)) continue;
    // On Windows, env lookups ignore case, so a differently cased known name is not a typo.
    if (KNOWN_VARIABLES.includes(upper) && env[upper] !== undefined) continue;
    const suggestion = closest(upper, KNOWN_VARIABLES);
    warnings.push(
      suggestion === undefined
        ? `unknown variable ${name}. Known variables: ${KNOWN_VARIABLES.join(', ')}`
        : `unknown variable ${name} (did you mean ${suggestion}?)`,
    );
  }
  return warnings;
}

/**
 * Reads and validates the configuration from `env`. Never throws and never reads `process.env`
 * itself. All problems are collected; warnings are returned whether or not the config is valid.
 */
export function loadConfig(env: Env): ConfigResult {
  const warnings = unknownVariableWarnings(env);
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    // A token pasted into the wrong variable would otherwise be echoed in that variable's error.
    // The truthiness check matters: replaceAll('', …) would insert between every character.
    // redactJwts covers a token pasted into another variable while PRINTIFY_API_TOKEN is empty.
    const token = env.PRINTIFY_API_TOKEN?.trim();
    const errors = parsed.error.issues.map((issue) => {
      const message = token ? issue.message.replaceAll(token, '[redacted]') : issue.message;
      return redactJwts(message);
    });
    return { ok: false, errors, warnings };
  }
  const data = parsed.data;
  return {
    ok: true,
    warnings,
    config: {
      token: data.PRINTIFY_API_TOKEN,
      shopId: data.PRINTIFY_SHOP_ID,
      toolsets: data.PRINTIFY_TOOLSETS,
      enableOrders: data.PRINTIFY_ENABLE_ORDERS,
      enableDestructive: data.PRINTIFY_ENABLE_DESTRUCTIVE,
      uploadDirs: data.PRINTIFY_UPLOAD_DIRS,
      apiBaseUrl: data.PRINTIFY_API_BASE_URL,
    },
  };
}
