/**
 * Printify's documented error envelope: `{status, code, message, errors: {reason, code}}`. Note
 * the `status` key, which is why the harness never detects a response wrapper by shape.
 */
export function apiErrorBody(
  overrides: { code?: number; message?: string; reason?: string } = {},
): { status: string; code: number; message: string; errors: { reason: string; code: number } } {
  const {
    code = 8502,
    message = 'Order failed',
    reason = 'Shipping method is not supported',
  } = overrides;
  return { status: 'error', code, message, errors: { reason, code } };
}

/** The shorter envelope 401 and 404 return. `request_id` is what `error.request_id` reports. */
export function notFoundBody(overrides: { error?: string; request_id?: string } = {}): {
  error: string;
  request_id: string;
} {
  const { error = 'Not found', request_id = 'req-1' } = overrides;
  return { error, request_id };
}
