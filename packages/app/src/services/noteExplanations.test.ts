import { expect, it } from 'vitest';
import { explanationFor, importNoteCode, staticWarningCode } from './noteExplanations.js';
import { WARNING_LABEL } from './simWarnings.js';

it.each(Object.keys(WARNING_LABEL))('explains recognized kernel key %s, including geometry warnings', code => {
  const explanation = explanationFor(code);
  expect(explanation.meaning).toBe(WARNING_LABEL[code]);
  expect(explanation.remedy.length).toBeGreaterThan(20);
  expect(explanation.meaning).not.toContain('No explanation');
});

it('recognizes only explicit static tokens and typed import identities', () => {
  expect(staticWarningCode('[Warning.DISCONTINUITY]: "Tube"')).toBe('DISCONTINUITY');
  expect(staticWarningCode('"[Warning.DISCONTINUITY]": near a fin')).toBeUndefined();
  expect(importNoteCode('I03.left-out')).toBe('I03.left-out');
  expect(importNoteCode('note')).toBeUndefined();
  expect(importNoteCode('config-applied')).toBeUndefined();
  expect(explanationFor('I03.left-out').remedy).toContain('missing parts');
  expect(explanationFor('I03.future').meaning).toContain('No explanation');
});

it.each(['I04.recovery-cd', 'I04.nozzle-dimension'])('explains the RASAero caution %s', code => {
  expect(explanationFor(code).meaning).not.toContain('No explanation');
  expect(explanationFor(code).remedy).toMatch(/check/i);
});
