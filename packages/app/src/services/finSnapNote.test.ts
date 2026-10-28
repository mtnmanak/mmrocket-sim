// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { discardSession, loadSession } from './session.js';
import { designStateFromSession } from './sessionRestore.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { exportOrk, importOrk } from './orkFile.js';
import { planImport, type ImportedDesign, type ResolvedImportMotors } from './importApply.js';
import { statedWeightTextFor } from './unitText.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import { tierLines, type ImportNote } from './importNotes.js';
import { defaultTree } from '../tree/treeModel.js';
import { MAX_FIN_POINT_M } from '../tree/finOutline.js';

/**
 * An outline the kernel's setPoints snap does not settle (a point past the
 * limit on BOTH axes keeps its x on the first pass) is kept as stored, with a
 * Caution (sanitize.ts, "original coordinates kept"). The tree passes the
 * sanitizer several times on restore and on open; the line must be said once
 * per fin set, with one record per line (audit S8-1).
 */
const far = MAX_FIN_POINT_M + 0.5;
const finSet = (name: string): ComponentNode => ({ type: 'freeformfinset', name, finCount: 3, thickness: 0.003,
  points: [[0, 0], [far, far], [far + 0.5, 0]] });
const tree = (...names: string[]): RocketTree => {
  const t = defaultTree();
  const tube = t.components[0]!.children!.find(c => c.type === 'bodytube')!;
  tube.children = [...(tube.children ?? []).filter(c => c.type !== 'trapezoidfinset'), ...names.map(finSet)];
  return t;
};
const unsafe = <T extends { text: string }>(lines: readonly T[]): T[] => lines.filter(l => l.text.includes('original coordinates kept'));

/** The note lines, and each line's record as the notice tiers it. */
type Loaded = { lines: string[]; tiered: ImportNote[]; records: ImportNote[] };

const restore = (t: RocketTree): Loaded => {
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: t, launch: DEFAULT_CONDITIONS, savedAt: 1 }));
  const restored = designStateFromSession(loadSession(), { legacyMaxMotorLengthM: null });
  return { lines: restored.restoreNotes, records: restored.restoreNoteTiers,
    tiered: tierLines(restored.restoreNotes, restored.restoreNoteTiers) };
};
const open = (t: RocketTree): Loaded => {
  const xml = exportOrk({ name: 'Far fins', tree: t, launch: DEFAULT_CONDITIONS, notes: [], motors: {} });
  const imported = importOrk(xml) as unknown as ImportedDesign;
  const resolved: ResolvedImportMotors = { working: {}, configs: {} } as unknown as ResolvedImportMotors;
  const plan = planImport(imported, resolved,
    { launch: DEFAULT_CONDITIONS, text: statedWeightTextFor(INITIAL_UNITS), units: INITIAL_UNITS });
  const lines = plan.note.text.split('\n').slice(1);
  return { lines, tiered: plan.note.group.lines, records: plan.note.group.lines.filter(l => l.tier !== 'information') };
};

describe('the unsafe-snap fin caution is said once per fin set', () => {
  beforeEach(() => discardSession());

  it.each([['restored autosave', restore], ['opened .ork', open]] as const)('%s: one line, one Caution record', (_n, load) => {
    const { lines, tiered, records } = load(tree('Far fins'));
    expect(unsafe(lines.map(text => ({ text })))).toHaveLength(1);
    expect(unsafe(tiered).map(n => `${n.tier}:${n.kind}`)).toEqual(['caution:I04.limits']);
    expect(unsafe(records)).toHaveLength(1);
  });

  it.each([['restored autosave', restore], ['opened .ork', open]] as const)('%s: two differently named fin sets give two lines', (_n, load) => {
    const { lines, tiered, records } = load(tree('Fore fins', 'Aft fins'));
    const kept = unsafe(lines.map(text => ({ text })));
    expect(kept).toHaveLength(2);
    expect(kept.filter(l => l.text.includes('Fore fins'))).toHaveLength(1);
    expect(kept.filter(l => l.text.includes('Aft fins'))).toHaveLength(1);
    expect(unsafe(tiered).map(n => n.tier)).toEqual(['caution', 'caution']);
    expect(unsafe(records)).toHaveLength(2);
  });

  // Two sets with one name read the same sentence; each still gets its line.
  it.each([['restored autosave', restore], ['opened .ork', open]] as const)('%s: two same-named fin sets give two lines', (_n, load) => {
    const { lines, tiered, records } = load(tree('Fins', 'Fins'));
    expect(unsafe(lines.map(text => ({ text })))).toHaveLength(2);
    expect(unsafe(tiered).map(n => n.tier)).toEqual(['caution', 'caution']);
    expect(unsafe(records)).toHaveLength(2);
  });
});
