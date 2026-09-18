import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sleep } from '../../src/printify/sleep.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('resolves after the delay and not before', async () => {
  let done = false;
  void sleep(1000, new AbortController().signal).then(() => {
    done = true;
  });
  await vi.advanceTimersByTimeAsync(999);
  expect(done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(done).toBe(true);
});

it('rejects with the reason when the signal aborts during the wait, and clears its timer', async () => {
  const controller = new AbortController();
  const reason = new Error('tool call cancelled');
  const pending = sleep(1000, controller.signal);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(vi.getTimerCount()).toBe(0);
});

it('rejects at once for a signal that has already aborted', async () => {
  const reason = new Error('already cancelled');
  await expect(sleep(1000, AbortSignal.abort(reason))).rejects.toBe(reason);
  expect(vi.getTimerCount()).toBe(0);
});
