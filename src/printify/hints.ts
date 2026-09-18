import type { HttpMethod, PrintifyErrorKind } from './types.js';

/** What a hint depends on. `PrintifyApiError` has all of these fields. */
export interface HintInput {
  kind: PrintifyErrorKind;
  method: HttpMethod;
  path: string;
  status: number | undefined;
  code: number | undefined;
  /** Set only on the rate limiter's fail-fast error, which was never sent. */
  retryAfterSeconds?: number | undefined;
}

const DUPLICATE_ORDER =
  'An order with this `external_id` already exists. Look it up instead of creating it again.';

const CODE_HINTS: ReadonlyMap<number, string> = new Map([
  [
    8203,
    'The image resolution is too low for the print area at this size. Use a larger image or a ' +
      'smaller `scale`.',
  ],
  [
    8201,
    'Printify rejected the file: it is too large or not a supported image format (the reason ' +
      'says which). Upload files over 5 MB by URL rather than base64.',
  ],
  [
    10300,
    'Printify could not download the image. The URL must be publicly reachable and return the ' +
      'image file itself, not a web page.',
  ],
  [8103, 'The shipping address failed validation. The reason names the fields to fix.'],
  [8503, DUPLICATE_ORDER],
]);

const UNAUTHORIZED =
  'Printify rejected the token: it is invalid, expired (Personal Access Tokens last one year) or ' +
  'revoked. The user needs a new token in `PRINTIFY_API_TOKEN` in their MCP client config.';
const FORBIDDEN =
  'Printify denied access. The token may lack a scope this endpoint needs, or the feature is not ' +
  'enabled for this shop.';
const NOT_FOUND = 'Not found. Check the id, and that it belongs to this shop.';
const RATE_LIMITED = "Printify's rate limit was reached. Wait a minute before trying again.";
const SERVER_ERROR = 'Printify had a server error. Try again in a moment.';
const TIMEOUT = 'Printify did not answer in time. Try again in a moment.';
const NETWORK = 'Printify could not be reached. Check the network connection and try again.';
const MAY_HAVE_GONE_THROUGH = ' The request may still have gone through, so check before retrying.';

// Path pattern, scope for GET, scope for every other method. The docs do not map scopes to
// endpoints, so this is a best guess and the hint says "probably".
const SCOPES: readonly (readonly [RegExp, string, string | undefined])[] = [
  [/^\/v1\/shops\.json$/, 'shops.read', undefined],
  [/^\/v[12]\/catalog\//, 'catalog.read', undefined],
  [/^\/v1\/shops\/[^/]+\/products[/.]/, 'products.read', 'products.write'],
  [/^\/v1\/shops\/[^/]+\/orders[/.]/, 'orders.read', 'orders.write'],
  [/^\/v1\/uploads[/.]/, 'uploads.read', 'uploads.write'],
  [/^\/v1\/shops\/[^/]+\/webhooks[/.]/, 'webhooks.read', 'webhooks.write'],
];

/** A wait of more than 10 seconds, for messages: seconds under 2 minutes, else whole minutes. */
export function formatSeconds(seconds: number): string {
  return seconds < 120
    ? `${String(seconds)} seconds`
    : `${String(Math.ceil(seconds / 60))} minutes`;
}

/** The token scope the endpoint probably needs, or `undefined` when it is not known. */
export function scopeFor(method: HttpMethod, path: string): string | undefined {
  for (const [pattern, readScope, writeScope] of SCOPES) {
    if (pattern.test(path)) return method === 'GET' ? readScope : writeScope;
  }
  return undefined;
}

/** Advice for the AI assistant about an error, or `undefined` when there is none. */
export function hintFor(error: HintInput): string | undefined {
  const codeHint = error.code === undefined ? undefined : CODE_HINTS.get(error.code);
  if (codeHint !== undefined) return codeHint;
  switch (error.kind) {
    case 'http':
      return statusHint(error);
    case 'timeout':
      return error.method === 'GET' ? TIMEOUT : TIMEOUT + MAY_HAVE_GONE_THROUGH;
    case 'network':
      return error.method === 'GET' ? NETWORK : NETWORK + MAY_HAVE_GONE_THROUGH;
    case 'invalid_response':
      return undefined;
  }
}

function statusHint({ status, method, path, retryAfterSeconds }: HintInput): string | undefined {
  if (status === undefined) return undefined;
  if (status === 409) return DUPLICATE_ORDER;
  if (status === 401) return UNAUTHORIZED;
  if (status === 403) {
    const scope = scopeFor(method, path);
    if (scope === undefined) return FORBIDDEN;
    return (
      `Printify denied access. The token probably lacks the \`${scope}\` scope; the user can ` +
      "create a new token that includes it. Printify's message may name another reason."
    );
  }
  if (status === 404) return NOT_FOUND;
  if (status === 429) {
    if (retryAfterSeconds === undefined) return RATE_LIMITED;
    return (
      "Printify's rate limit is used up, so the request was not sent. " +
      `Wait ${formatSeconds(retryAfterSeconds)} before trying again.`
    );
  }
  if (status >= 500 && status <= 599) return SERVER_ERROR;
  return undefined;
}
