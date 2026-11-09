import { expect, it } from 'vitest';
import * as storedWarnings from './storedWarnings.js';
import * as sanitize from '../tree/sanitize.js';

it('keeps obsolete validation and import-note implementations off the public surface', () => {
  expect.soft(storedWarnings).not.toHaveProperty('wideStoredWarning');
  expect.soft(sanitize).not.toHaveProperty('configSeparationNote');
  expect(storedWarnings.boundedWarningEvidence([Object.fromEntries(
    Array.from({ length: storedWarnings.MAX_WARNING_FIELDS + 1 }, (_, i) => [String(i), i]),
  )])).toBe(false);
});
