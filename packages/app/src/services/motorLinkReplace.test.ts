import { motorLinkMayReplace } from './motorLinkOpen.js';
import { expect, it } from 'vitest';
const base = { motorLinkMark: '1234567', currentMark: '1234567', designFile: null, autosavePaused: false };
it('round12 equal untouched marks allow replacement', () => expect(motorLinkMayReplace(base)).toBe(true));
it.each([
  { motorLinkMark: null }, { currentMark: '7654321' },
  { designFile: { name: 'rocket.ork', format: 'ork' as const, via: 'opened' as const } }, { autosavePaused: true },
])('round12 replacement guard %j', change => expect(motorLinkMayReplace({ ...base, ...change })).toBe(false));
