import { expect, it } from 'vitest';
import { planCurations } from './curate-presets.mjs';

it.each([
  { kind: 'BodyTube', manufacturer: 'Other' },
  { kind: 'NoseCone', manufacturer: 'SEMROC' },
])('does not accept a rename target with another identity: %j', identity => {
  const c = { key: 'BodyTube|semroc|old', action: 'rename', to: 'new' };
  expect(planCurations([{ ...identity, partNo: 'new' }], [c])[0].status).toBe('error');
  expect(planCurations([{ kind: 'BodyTube', manufacturer: 'SEMROC', partNo: 'new' }], [c])[0].status).toBe('already');
});
