import { expect, it } from 'vitest';
import { linkResultCurrent } from './motorLinkFlight.js';

const result = { gen: 1, physicsKey: 'geometry', motorFlightKey: 'motor', activeConfigId: 'A' };
it('keeps only the result of a flight that actually started', () => {
  expect(linkResultCurrent(result, { ...result })).toBe(true);
});
it.each([
  { gen: 2 }, { physicsKey: 'edited' }, { motorFlightKey: 'different motor' }, { activeConfigId: 'B' },
])('hides the result banner after %j changes', change => {
  expect(linkResultCurrent(result, { ...result, ...change })).toBe(false);
});
