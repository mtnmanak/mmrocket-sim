import { expect, it } from 'vitest';
import { linkResultCurrent, pendingLinkCurrent, startedLinkResult, takeMotorLinkOpen } from './motorLinkFlight.js';

it('consumes an open before starting work that can render again', () => {
  const value = { openId: 1 };
  const ref = { current: value as typeof value | null };
  expect(takeMotorLinkOpen(ref)).toBe(value);
  expect(takeMotorLinkOpen(ref)).toBeNull();
});

const result = { gen: 1, physicsKey: 'geometry', motorFlightKey: 'motor', activeConfigId: 'A' };
it('keeps only the result of a flight that actually started', () => {
  expect(startedLinkResult(false, result)).toBeNull();
  expect(startedLinkResult(true, result)).toBe(result);
  expect(linkResultCurrent(result, { ...result })).toBe(true);
});
it.each([
  { gen: 2 }, { physicsKey: 'edited' }, { motorFlightKey: 'different motor' }, { activeConfigId: 'B' },
])('hides the result banner after %j changes', change => {
  expect(linkResultCurrent(result, { ...result, ...change })).toBe(false);
});
const pending = { gen: 1, seq: 2, tree: { components: [] }, launch: {}, motorFlightKey: 'motor', activeConfigId: 'A' };
it('arms the pending motor key only after the assignment commits', () => {
  expect(pendingLinkCurrent(pending, { ...pending })).toBe(true);
  expect(pendingLinkCurrent({ ...pending, motorFlightKey: null }, pending)).toBe(true);
});
it.each([
  { gen: 2 }, { seq: 3 }, { tree: { components: [] } }, { launch: {} },
  { motorFlightKey: 'edited motor' }, { activeConfigId: 'B' },
])('cancels the pending flight after %j changes', change => {
  expect(pendingLinkCurrent(pending, { ...pending, ...change })).toBe(false);
});
