import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALIASES, DISPLAY, mfrDisplay, mfrKey, spellingConflicts } from './manufacturers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const db = JSON.parse(readFileSync(join(here, '../src/data/presets.json'), 'utf8'));

/**
 * One company, one spelling.
 *
 * Reported 2026-09-01a: the parts database "double counted" manufacturers whose
 * names differ slightly. The mechanism was three separate alias tables across
 * the pipeline scripts, of which merge-rocksim-parts.mjs was missing
 * `semrocastronautics` — so SEMROC and "SEMROC Astronautics" never met.
 *
 * This runs against the SHIPPED data, not a fixture, because the shipped data
 * is the thing that was wrong.
 */
describe('manufacturer names in the shipped preset database', () => {
  it('has no company spelled two ways', () => {
    const conflicts = spellingConflicts(db.presets);
    expect(conflicts, conflicts.map((c) => `${c.key}: ${c.spellings.join(' / ')}`).join('; '))
      .toEqual([]);
  });

  it('every shipped spelling is already the canonical one', () => {
    // The stronger statement: not merely self-consistent, but consistent with
    // the table the generator will use on its next run. Without this, a
    // hand-edit could settle on a spelling the pipeline would undo.
    const wrong = [...new Set(db.presets.map((p) => p.manufacturer))]
      .filter((m) => mfrDisplay(m) !== m);
    expect(wrong, `not canonical: ${wrong.join(', ')}`).toEqual([]);
  });

  it('the five ruled merges really collapsed', () => {
    // The owner's 2026-09-01a rulings, by name, so a regeneration that loses
    // one is named rather than merely counted.
    const names = new Set(db.presets.map((p) => p.manufacturer));
    for (const gone of ['SEMROC Astronautics', 'LOC/Precision', 'BalsaMachining.com',
      'Quest Aerospace', 'MRC']) {
      expect(names.has(gone), `${gone} is still in the database`).toBe(false);
    }
    for (const kept of ['SEMROC', 'LOC Precision', 'BalsaMachining', 'Quest', 'MPC']) {
      expect(names.has(kept), `${kept} is missing`).toBe(true);
    }
  });

  it('spells AeroTech the way the motor database does', () => {
    // "fix any cosmetic spellings so we are consistent across the app" — the
    // parts database said Aerotech and the motor database says AeroTech, which
    // is the company's own styling. Same company, two screens.
    const motors = JSON.parse(readFileSync(join(here, '../src/data/motors.json'), 'utf8'));
    const motorSpelling = [...new Set(motors.motors.map((m) => m.manufacturerAbbrev))]
      .find((m) => m.toLowerCase() === 'aerotech');
    expect(motorSpelling).toBe('AeroTech');
    const presetSpellings = [...new Set(db.presets.map((p) => p.manufacturer))]
      .filter((m) => m.toLowerCase() === 'aerotech');
    expect(presetSpellings).toEqual(['AeroTech']);
  });

  it('every alias resolves to a key that has a display name', () => {
    // A table entry pointing at a key with no DISPLAY silently leaves the raw
    // string in place, which looks like the alias working until you read the
    // data. This is the failure mode that hides a half-done merge.
    for (const target of new Set(Object.values(ALIASES))) {
      expect(DISPLAY[target], `ALIASES sends "${target}" to a key with no DISPLAY entry`)
        .toBeTruthy();
    }
  });

  it('keys ignore case, spacing and punctuation', () => {
    expect(mfrKey('SEMROC Astronautics')).toBe(mfrKey('semroc'));
    expect(mfrKey('LOC/Precision')).toBe(mfrKey('LOC Precision'));
    expect(mfrKey('BalsaMachining.com')).toBe(mfrKey('BalsaMachining'));
    expect(mfrKey('MRC')).toBe(mfrKey('MPC'));
    // …and does NOT fold two companies that merely look alike.
    expect(mfrKey('Madcow')).not.toBe(mfrKey('MPC'));
    expect(mfrKey('Estes')).not.toBe(mfrKey('Quest'));
  });
});

describe('the duplicate-row cleanup', () => {
  it('leaves no row that carries nothing a sibling already has', async () => {
    // The rule from dedupe-presets.mjs, asserted against the shipped data: a
    // row is only droppable when some other row in its kind|manufacturer|partNo
    // group has every field it has, with an equal value. 36 groups DO share a
    // part number while holding different data - a SEMROC T-20-34 is a BT-20 in
    // one row and an ST-20 in another - and those are deliberately kept.
    const { planDedupe } = await import('./dedupe-presets.mjs');
    const { drop } = planDedupe(db.presets);
    expect(drop.map((d) => d.key)).toEqual([]);
  });

  it('the merge did not silently collapse two different parts into one label', () => {
    // The risk the rename creates: rows that were distinguishable only by their
    // manufacturer spelling now share kind|manufacturer|partNo. That is allowed
    // - they are the same company - but they must still differ in DATA, or one
    // of them is a duplicate the cleanup should have caught.
    const groups = new Map();
    for (const p of db.presets) {
      const k = `${p.kind}|${p.manufacturer}|${String(p.partNo).toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    for (const [k, v] of groups) {
      if (v.length < 2) continue;
      const bodies = new Set(v.map((p) => {
        const { manufacturer, source, ...rest } = p;
        return JSON.stringify(Object.keys(rest).sort().map((x) => [x, rest[x]]));
      }));
      expect(bodies.size, `${k}: ${v.length} rows that are byte-identical apart from source`)
        .toBeGreaterThan(1);
    }
  });
});
