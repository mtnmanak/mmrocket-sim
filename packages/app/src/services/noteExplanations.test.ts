import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { explanationFor, importNoteCode, NOTE_EXPLANATIONS, staticWarningCode } from './noteExplanations.js';
import { WARNING_LABEL } from './simWarnings.js';

it('explains missing landing evidence for an incomplete flight', () => {
  const explanation = explanationFor('INCOMPLETE_FLIGHT');
  expect(explanation.meaning).toContain('incomplete');
  expect(explanation.remedy).toContain('landing');
  expect(explanation.remedy).toContain('rely');
});

it('scopes INCOMPLETE_FLIGHT to the stage it names: a booster cut off airborne leaves the main flight’s landing figures', () => {
  const { remedy } = explanationFor('INCOMPLETE_FLIGHT');
  expect(remedy).toContain('the flight or stage the note names');
  expect(remedy).not.toContain('so landing rate and landing drift are unavailable');
});

it('explains every import note code emitted by services', () => {
  const codes = new Set<string>();
  for (const file of readdirSync(new URL('.', import.meta.url), { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file) || file === 'noteExplanations.ts') continue;
    const source = readFileSync(new URL(file.replace(/\\/g, '/'), import.meta.url), 'utf8');
    for (const [code] of source.matchAll(/\bI\d{2}\.[a-z-]+\b/g)) codes.add(code);
  }
  expect(codes.has('I03.ignored-components')).toBe(true);
  expect([...codes].filter(code => !NOTE_EXPLANATIONS.has(code))).toEqual([]);
  for (const code of codes) {
    expect(explanationFor(code).meaning.length, code).toBeGreaterThan(20);
    expect(explanationFor(code).remedy.length, code).toBeGreaterThan(20);
  }
});

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
