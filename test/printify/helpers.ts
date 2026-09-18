import { PrintifyApiError } from '../../src/printify/errors.js';

/** Awaits a promise that must reject, and returns the reason. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

export async function apiError(promise: Promise<unknown>): Promise<PrintifyApiError> {
  const error = await rejection(promise);
  if (error instanceof PrintifyApiError) return error;
  throw new Error(`expected a PrintifyApiError, got ${String(error)}`);
}
