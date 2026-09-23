import { z } from 'zod';
import { redactJwts } from '../redact.js';
import { hintFor } from './hints.js';
import type { HttpMethod, PrintifyErrorKind } from './types.js';

/** The request an error belongs to. `path` is the `ApiPath`, without base URL or query. */
export interface Route {
  method: HttpMethod;
  path: string;
}

export interface PrintifyErrorFields extends Route {
  kind: PrintifyErrorKind;
  status?: number | undefined;
  code?: number | undefined;
  printifyMessage?: string | undefined;
  reason?: string | undefined;
  requestId?: string | undefined;
  /** Set only by the rate limiter's fail-fast error: the request was not sent. */
  retryAfterSeconds?: number | undefined;
}

/** Every failure of a Printify request. `kind` says which. The hint is advice for the assistant. */
export class PrintifyApiError extends Error {
  override readonly name = 'PrintifyApiError';
  readonly kind: PrintifyErrorKind;
  readonly method: HttpMethod;
  readonly path: string;
  readonly status: number | undefined;
  readonly code: number | undefined;
  readonly printifyMessage: string | undefined;
  readonly reason: string | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly hint: string | undefined;

  constructor(message: string, fields: PrintifyErrorFields, options?: ErrorOptions) {
    super(message, options);
    this.kind = fields.kind;
    this.method = fields.method;
    this.path = fields.path;
    this.status = fields.status;
    this.code = fields.code;
    this.printifyMessage = fields.printifyMessage;
    this.reason = fields.reason;
    this.requestId = fields.requestId;
    this.retryAfterSeconds = fields.retryAfterSeconds;
    this.hint = hintFor(this);
  }
}

/** Extra redaction for text from Printify, e.g. the token and the customer's address. */
export type Redact = (text: string) => string;

const MAX_TEXT_LENGTH = 1000;

// A field with an unexpected type is ignored rather than failing the whole body. Blank text
// (empty or only whitespace) counts as missing, so the field-source table's fallback applies.
const optionalString = z
  .string()
  .optional()
  .catch(undefined)
  .transform((value) => (value === undefined || value.trim() === '' ? undefined : value));
const optionalNumber = z.number().optional().catch(undefined);

// Reads both envelopes, {status, code, message, errors} and {error, request_id}, and any mix.
// In zod 4 a z.unknown() key is required unless marked optional.
const errorBodySchema = z.object({
  code: optionalNumber,
  message: optionalString,
  error: optionalString,
  errors: z.unknown().optional(),
  request_id: optionalString,
});
const errorsSchema = z.object({ reason: optionalString, code: optionalNumber });

/** `{ value }` when `text` is JSON, `undefined` when it is not. */
export function parseJson(text: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * The error for a non-2xx response. `body` is the parsed body, or `undefined` when it was not
 * JSON. `correlationId` is the `x-pfy-correlation-id` header.
 */
export function httpError(
  route: Route,
  status: number,
  body: { value: unknown } | undefined,
  correlationId: string | null,
  redact: Redact = (text) => text,
): PrintifyApiError {
  const parsed = errorBodySchema.safeParse(body?.value);
  const fields = parsed.success ? parsed.data : undefined;
  const errors = errorsSchema.safeParse(fields?.errors);
  const detail = errors.success ? errors.data : undefined;
  const rawReason =
    detail?.reason ??
    (fields?.errors === undefined || fields.errors === null
      ? undefined
      : JSON.stringify(fields.errors));

  const code = fields?.code ?? detail?.code;
  const printifyMessage = clean(fields?.message ?? fields?.error, redact);
  const reason = clean(rawReason, redact);
  const requestId = clean(fields?.request_id ?? correlationId ?? undefined, redact);

  let message = `${route.method} ${route.path} failed with HTTP ${String(status)}`;
  if (code !== undefined) message += ` (code ${String(code)})`;
  if (body === undefined) message += ' (non-JSON response)';
  if (printifyMessage !== undefined) message += `: ${withoutPeriod(printifyMessage)}`;
  if (reason !== undefined) message += `. Reason: ${withoutPeriod(reason)}`;
  if (requestId !== undefined) message += `. Request id: ${requestId}`;
  return new PrintifyApiError(message, {
    kind: 'http',
    ...route,
    status,
    code,
    printifyMessage,
    reason,
    requestId,
  });
}

export function timeoutError(route: Route, timeoutMs: number): PrintifyApiError {
  return new PrintifyApiError(
    `${route.method} ${route.path} timed out after ${String(timeoutMs)} ms`,
    { kind: 'timeout', ...route },
  );
}

/** The error for a request that failed before any response, e.g. DNS or a reset connection. */
export function networkError(route: Route, cause: unknown): PrintifyApiError {
  const code = systemCode(cause);
  const suffix = code === undefined ? '' : ` (${code})`;
  return new PrintifyApiError(
    `${route.method} ${route.path} failed: could not reach Printify${suffix}`,
    { kind: 'network', ...route },
    { cause },
  );
}

export function invalidResponseError(
  route: Route,
  status: number,
  problem:
    | 'a body that is not JSON'
    | 'an unexpected pagination envelope'
    | 'an unexpected catalog response',
): PrintifyApiError {
  return new PrintifyApiError(
    `${route.method} ${route.path} returned HTTP ${String(status)} with ${problem}`,
    { kind: 'invalid_response', ...route, status },
  );
}

/** Redacts first, then cuts: cutting first could leave half a token that no longer matches. */
function clean(text: string | undefined, redact: Redact): string | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  const redacted = redactJwts(redact(text));
  return redacted.length > MAX_TEXT_LENGTH
    ? `${redacted.slice(0, MAX_TEXT_LENGTH - 1)}…`
    : redacted;
}

function withoutPeriod(text: string): string {
  return text.endsWith('.') ? text.slice(0, -1) : text;
}

/** The `code` of the innermost error in the `cause` chain that has one, e.g. `ENOTFOUND`. */
function systemCode(error: unknown): string | undefined {
  let code: string | undefined;
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && typeof current.code === 'string') code = current.code;
    current = current.cause;
  }
  return code;
}
