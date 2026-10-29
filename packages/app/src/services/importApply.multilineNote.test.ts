import { parseEng } from './exMotors.js';
import { describe, expect, it, vi } from 'vitest';
import { matchImportedMotor, type fetchSpecByDigest } from './motorMatch.js';
import { planImport, resolveImportMotors, type ImportedDesign } from './importApply.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { acceptedOtherMakerNotes } from './openMotorChoices.js';
import { groupOf, withoutLines, zeroBulkDensityNote } from './importNotes.js';
import { statedWeightTextFor } from './unitText.js';
import { INITIAL_UNITS } from '../prefs/units.js';

/**
 * A desktop OR .ork motor matched under another maker (Enerjet F67 loads as AeroTech F67C)
 * carries desktop's 32-hex curve digest, which never names the other maker's files, so its
 * open note is two sentences: the unconfirmed match and the unmatched digest (cloud lane 16).
 * Each must be its own note line, or App's line-by-line removal of an answered question
 * (acceptedLines, split on '\n') leaves the whole caution behind (Gemini review, 28 Oct).
 */
const fetchSpec = vi.fn<typeof fetchSpecByDigest>(async (row, delay) => ({
  designation: row.designation, diameter: row.diameter / 1000, length: row.length / 1000,
  times: [0, 1], thrusts: [0, 1], masses: [0.1, 0.05], cgX: 0.05, ejectionDelay: delay,
}));

describe('a two-sentence open note', () => {
  it('becomes one note line per sentence, each counted, and all of it goes once answered', async () => {
    const ref = { manufacturer: 'Enerjet', designation: 'F67', diameter: 0.0286, length: 0.127,
      delay: 6, digest: '0123456789abcdef0123456789abcdef', motorType: 'single', ignitionEvent: 'burnout', ignitionDelay: 1.5 };
    const imported = {
      name: 'Two mounts', tree: { components: [] }, notes: ['Keep this unrelated warning.'],
      chosenConfigId: 'a', motors: { m: ref, n: ref },
      configs: [{ id: 'a', name: 'First', isDefault: true, deployments: {}, separations: {}, motors: { m: ref, n: ref } }],
    } as unknown as ImportedDesign;
    const resolved = await resolveImportMotors(imported, r => matchImportedMotor(r, { fetchSpec, exMotors: [] }));
    expect(resolved.working.m!.openNote?.split('\n')).toHaveLength(2);
    const ctx = { launch: DEFAULT_CONDITIONS, text: statedWeightTextFor(INITIAL_UNITS), units: INITIAL_UNITS };
    const plan = planImport(imported, resolved, ctx);
    const lines = groupOf(plan.note).lines.map(l => l.text);
    const f67 = lines.filter(l => l.includes('F67'));
    expect(f67).toHaveLength(2);
    expect(f67.every(l => !l.includes('\n'))).toBe(true);
    expect(f67.filter(l => l.startsWith('Motor “')).every(l => l.includes('(2 mounts)'))).toBe(true);
    // App's removal once the question is answered, as App.tsx does it.
    const quiet = new Set(planImport(imported, acceptedOtherMakerNotes(resolved), ctx).note.text.split('\n'));
    const accepted = plan.note.text.split('\n').filter(l => !quiet.has(l));
    const after = withoutLines(groupOf(plan.note), new Set(accepted)).lines.map(l => l.text);
    expect(after.filter(l => l.includes('F67'))).toEqual([]);
    expect(after).toContain('Keep this unrelated warning.');
  });
});

it('cleans manufacturer and designation spans before splitting motor notes, and part names before joining', async () => {
  const ref = { manufacturer: 'OTHER\nFAKE\r\tTAB\u202e', designation: 'F67\n', diameter: 0.0286, length: 0.127,
    delay: 6, digest: '0123456789abcdef0123456789abcdef' };
  const notes: string[] = [];
  zeroBulkDensityNote(notes, 'PART\nFAKE\r\tTAB\u202e', INITIAL_UNITS);
  const imported = { name: 'ROCKET\nFAKE\r\tTAB\u202e', tree: { components: [] }, notes, motors: { m: ref } } as unknown as ImportedDesign;
  const resolved = await resolveImportMotors(imported, r => matchImportedMotor(r, { fetchSpec, exMotors: [] }));
  const plan = planImport(imported, resolved, { launch: DEFAULT_CONDITIONS, text: statedWeightTextFor(INITIAL_UNITS) });
  expect(plan.note.text).toContain('ROCKETFAKE TAB');
  expect(plan.note.text).toContain('OTHERFAKE TAB');
  expect(plan.note.text).toContain('PARTFAKE TAB');
  expect(plan.note.text).not.toContain('F67\n');
  expect(plan.note.text).not.toMatch(/[\r\t\u202e]/u);
  expect(plan.note.group!.lines.filter(l => l.kind === 'I12.motor-unconfirmed')).toHaveLength(2);
});

it('cleans the named maker in EX info notes before they are split', async () => {
  const [parsed] = parseEng('F67 29 100 6 0.05 0.1 Test\n0 0\n0.1 10\n1 0\n');
  const maker = 'OTHER\nFAKE\r\tTAB';
  const ex = { ...parsed!, realManufacturer: maker };
  const ref = { manufacturer: maker, designation: 'F67', diameter: 0.029, length: 0.1, delay: 6 };
  const imported = { name: 'EX', tree: { components: [] }, notes: [], motors: { m: ref } } as unknown as ImportedDesign;
  const resolved = await resolveImportMotors(imported, r => matchImportedMotor(r, { catalogue: [], exMotors: [ex] }));
  const plan = planImport(imported, resolved, { launch: DEFAULT_CONDITIONS, text: statedWeightTextFor(INITIAL_UNITS) });
  expect(plan.note.text).toContain('motor database has no OTHERFAKE TAB F67');
  expect(plan.note.group!.lines).toHaveLength(1);
  expect(plan.note.group!.lines[0]!.text).not.toMatch(/[\r\n\t]/);
});
