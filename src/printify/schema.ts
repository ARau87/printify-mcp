import type { z } from 'zod';

/** A field Printify may send as null, as the wrong type, or not at all. */
export function lenient<T>(schema: z.ZodType<T>) {
  return schema
    .nullable()
    .catch(null)
    .transform((value) => value ?? undefined)
    .optional();
}
