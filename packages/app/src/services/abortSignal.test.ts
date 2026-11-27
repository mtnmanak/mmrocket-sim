import { expect, it } from 'vitest';
import { throwIfAborted } from './abortSignal.js';

it('accepts an absent or active floor-browser signal', () => {
  expect(() => throwIfAborted()).not.toThrow();
  expect(() => throwIfAborted({ aborted: false } as AbortSignal)).not.toThrow();
});

it.each([new Error('Cancelled'), 'cancelled', 0, false])('preserves an explicit abort reason: %s', reason => {
  let caught: unknown;
  try { throwIfAborted({ aborted: true, reason } as AbortSignal); } catch (error) { caught = error; }
  expect(caught).toBe(reason);
});

it('supplies AbortError when a floor-browser signal has no reason property', () => {
  expect(() => throwIfAborted({ aborted: true } as AbortSignal)).toThrow(expect.objectContaining({ name: 'AbortError' }));
});
