import { z } from 'zod';
import type { PrintifyClient, Query } from './client.js';
import { invalidResponseError } from './errors.js';
import type { ApiPath } from './path.js';

/** The largest `limit` each paginated endpoint accepts. Tool schemas use these as `.max()`. */
export const PAGE_LIMITS = { products: 50, orders: 10, uploads: 100 } as const;

export type PagedResource = keyof typeof PAGE_LIMITS;

/** Printify's `limit` when none is sent. */
const DEFAULT_LIMIT = 10;

export interface Page {
  items: unknown[];
  page: number;
  lastPage: number | undefined;
  total: number | undefined;
  hasMore: boolean;
}

export interface PageOptions {
  page?: number;
  limit?: number;
  query?: Query;
  signal?: AbortSignal;
}

// Loose on purpose: the documented orders examples show only current_page and data.
const envelopeSchema = z.object({
  current_page: z.number().int(),
  data: z.array(z.unknown()),
  last_page: z.number().int().optional(),
  total: z.number().int().optional(),
  next_page_url: z.string().nullable().optional(),
});

type Envelope = z.infer<typeof envelopeSchema>;

/**
 * Fetches one page of a Laravel-style paginated list. A `limit` above the endpoint's maximum is
 * lowered to it, so the request never fails on it.
 */
export async function fetchPage(
  client: PrintifyClient,
  resource: PagedResource,
  path: ApiPath,
  { page, limit, query, signal }: PageOptions = {},
): Promise<Page> {
  checkPositiveInteger('page', page);
  checkPositiveInteger('limit', limit);
  const sentLimit = limit === undefined ? undefined : Math.min(limit, PAGE_LIMITS[resource]);
  const body = await client.request('GET', path, {
    query: { ...query, page, limit: sentLimit },
    signal,
  });
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    throw invalidResponseError({ method: 'GET', path }, 200, 'an unexpected pagination envelope');
  }
  const envelope = parsed.data;
  return {
    items: envelope.data,
    page: envelope.current_page,
    lastPage: envelope.last_page,
    total: envelope.total,
    hasMore: hasMore(envelope, sentLimit ?? DEFAULT_LIMIT),
  };
}

function hasMore(envelope: Envelope, limit: number): boolean {
  if (envelope.last_page !== undefined) return envelope.current_page < envelope.last_page;
  if (envelope.next_page_url !== undefined) return envelope.next_page_url !== null;
  return envelope.data.length >= limit;
}

function checkPositiveInteger(name: string, value: number | undefined): void {
  if (value !== undefined && !(Number.isInteger(value) && value >= 1)) {
    throw new RangeError(`${name} must be an integer of at least 1, got ${String(value)}`);
  }
}
