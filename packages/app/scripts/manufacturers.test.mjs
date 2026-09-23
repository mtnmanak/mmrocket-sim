import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALIASES, DISPLAY, mfrDisplay, mfrKey, partKey, spellingConflicts } from './manufacturers.mjs';

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

  it('reads a name that is also a prototype key as a name', () => {
    // Audit 2026-09-22: a <PartMfg>Constructor</PartMfg> made mfrKey return
    // Object itself, and mfrDisplay a function, because the plain-object maps
    // inherit `constructor`.
    expect(mfrKey('Constructor')).toBe('constructor');
    expect(mfrDisplay('Constructor')).toBe('Constructor');
    expect(mfrKey('hasOwnProperty')).toBe('hasownproperty');
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

describe('the part-number key', () => {
  it('keeps the "+" that a manufacturer uses to mean a different part', () => {
    // SEMROC's BT-2+ is a sleeve that slips OVER a BT-2; BalsaMachining's
    // CR2+3-F is a different ring from CR23-F. Stripping the + fused them.
    expect(partKey('T-2+-34')).not.toBe(partKey('T2-34'));
    expect(partKey('CR2+3-F')).not.toBe(partKey('CR23-F'));
    expect(partKey('T-4+-34')).not.toBe(partKey('T-4-34'));
    // Everything else still normalises: case, spaces, dashes, dots.
    expect(partKey('BT-55')).toBe(partKey('bt 55'));
    expect(partKey('CR50-60.W')).toBe(partKey('cr5060w'));
  });

  it('no duplicate group is a mere artefact of the key any more', () => {
    // 10 of 36 "duplicates" were rows whose LITERAL part numbers differ and
    // which the key fused. A group may still legitimately hold two rows — but
    // only when the part numbers really are the same string.
    const groups = new Map();
    for (const p of db.presets) {
      const k = `${p.kind}|${p.manufacturer}|${partKey(p.partNo)}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    const artefacts = [...groups.entries()]
      .filter(([, v]) => v.length > 1 && new Set(v.map((p) => String(p.partNo))).size > 1)
      .map(([k, v]) => `${k}: ${[...new Set(v.map((p) => p.partNo))].join(' vs ')}`);
    expect(artefacts, artefacts.join('; ')).toEqual([]);
  });
});

describe('the curations ruled on 2026-09-01', () => {
  it('are all still applied to the shipped data', async () => {
    // curate-presets.mjs holds the drops and part-number fixes the owner ruled
    // from the decision sheet. They live in a script because the generator
    // rewrites presets.json wholesale, so the real risk is a regeneration
    // silently reverting them — this is what notices.
    const { planCurations } = await import('./curate-presets.mjs');
    const plan = planCurations(db.presets);
    const errors = plan.filter((x) => x.status === 'error');
    expect(errors.map((e) => `${e.c.key}: ${e.detail}`)).toEqual([]);
    const outstanding = plan.filter((x) => x.status === 'todo')
      .map((t) => `${t.c.action} ${t.c.key}${t.c.to ? ' -> ' + t.c.to : ''}`);
    expect(outstanding, 'run: node packages/app/scripts/curate-presets.mjs --write')
      .toEqual([]);
  });

  it('left no row whose part number is just the manufacturer name', () => {
    // The class behind the "AeroTech Aerotech" couplers: presetPatch builds a
    // component's name as manufacturer + partNo, so these applied as a stutter.
    const stutter = db.presets
      .filter((p) => partKey(p.partNo) === partKey(p.manufacturer))
      .map((p) => `${p.kind} ${p.manufacturer} ${p.partNo}`);
    expect(stutter).toEqual([]);
  });

  it('kept the survivor that carries the better data', () => {
    // Spot-checks with a consequence, not a row count: the SEMROC thrust blocks
    // keep Fiber (656.76) rather than RockSim's generic "Paper (office)" (820),
    // a 25 % density difference; and PN-24 keeps the 24 in shroud lines.
    const tb5 = db.presets.filter((p) => p.kind === 'EngineBlock'
      && p.manufacturer === 'SEMROC' && p.partNo === 'TB-5');
    expect(tb5).toHaveLength(1);
    expect(tb5[0].material.name).toBe('Fiber');
    const pn24 = db.presets.filter((p) => p.kind === 'Parachute'
      && p.manufacturer === 'SEMROC' && p.partNo === 'PN-24');
    expect(pn24).toHaveLength(1);
    expect(pn24[0].lineLength).toBeCloseTo(0.6096, 6);
  });
});

/**
 * A curation RENAME must never land on a part number that is already taken
 * (audit 2026-09-22). `'Quest' → PNC35N` did: it fixed the stutter on a RockSim
 * row and filed it on top of the desktop-24.12 PNC35N, leaving two conflicting
 * "Quest PNC35N" nose cones at 25.5 g and 13.3 g — and presetPatch writes the
 * row's mass as overrideMass, so picking the RockSim one put 13.3 g on a nose
 * two sources weigh at 23.5–25.5 g (1.9×). Settled by the owner's standing
 * "keep desktop, drop RockSim" rule (open-items.md, 2026-09-03b).
 */
describe('curation renames never collide', () => {
  it('planCurations refuses a rename whose target part number is occupied', async () => {
    const { planCurations } = await import('./curate-presets.mjs');
    const rows = [
      // The source row the BNC-50SF1 → BNC-50SF2 curation addresses…
      { kind: 'NoseCone', manufacturer: 'SEMROC', partNo: 'BNC-50SF1', description: 'cone', mass: 0.00368543800625 },
      // …and a DIFFERENT part already sitting on the target number.
      { kind: 'NoseCone', manufacturer: 'SEMROC', partNo: 'BNC-50SF2', description: 'occupant' },
    ];
    const entry = planCurations(rows).find((x) => x.c.to === 'BNC-50SF2');
    expect(entry.status).toBe('error');
    expect(entry.detail).toMatch(/already/);
  });

  it('still plans the same rename onto a free number', async () => {
    const { planCurations } = await import('./curate-presets.mjs');
    const rows = [
      { kind: 'NoseCone', manufacturer: 'SEMROC', partNo: 'BNC-50SF1', description: 'cone', mass: 0.00368543800625 },
    ];
    expect(planCurations(rows).find((x) => x.c.to === 'BNC-50SF2').status).toBe('todo');
  });

  it('refuses it after the fact too — a collision already in the data is not "done"', async () => {
    // The shape the shipped file was in until 2026-09-22: the rename had run,
    // and its row sat on the same number as a different part.
    const { planCurations } = await import('./curate-presets.mjs');
    const renamed = { kind: 'NoseCone', manufacturer: 'SEMROC', partNo: 'BNC-50SF2', description: 'cone', mass: 0.00368543800625 };
    const occupant = { kind: 'NoseCone', manufacturer: 'SEMROC', partNo: 'BNC-50SF2', description: 'occupant' };
    const entry = planCurations([renamed, occupant]).find((x) => x.c.to === 'BNC-50SF2');
    expect(entry.status).toBe('error');
    expect(entry.detail).toMatch(/already taken/);
    // …and the same rename, alone on its number, is still simply done.
    expect(planCurations([renamed]).find((x) => x.c.to === 'BNC-50SF2').status).toBe('already');
  });

  it('the shipped data holds ONE Quest PNC35N, the desktop row', () => {
    const pnc = db.presets.filter((p) => p.kind === 'NoseCone' && mfrKey(p.manufacturer) === 'quest'
      && partKey(p.partNo) === partKey('PNC35N'));
    expect(pnc.map((p) => `${p.partNo} ${p.source} ${p.mass}`)).toHaveLength(1);
    expect(pnc[0].source).toBe('desktop-24.12');
    expect(pnc[0].mass).toBeCloseTo(0.0255, 3);
  });

  it('a fresh regeneration — RockSim row still filed as "Quest" — drops it cleanly', async () => {
    // What fetch → merge-rocksim-parts produces before this script runs: the
    // RockSim cone carries the manufacturer in its part number. The plan must
    // drop it, not rename it onto the desktop row.
    const { planCurations } = await import('./curate-presets.mjs');
    const rows = [
      ...db.presets,
      { kind: 'NoseCone', manufacturer: 'Quest', partNo: 'Quest', description: 'PNC35N', mass: 0.0133243, source: 'rocksim' },
    ];
    const plan = planCurations(rows);
    expect(plan.filter((x) => x.status === 'error').map((e) => `${e.c.key}: ${e.detail}`)).toEqual([]);
    const todo = plan.filter((x) => x.status === 'todo');
    expect(todo).toHaveLength(1);
    expect(todo[0].c.action).toBe('drop');
    expect(rows[todo[0].index].description).toBe('PNC35N');
  });

  it('no rename in the table collides on a regeneration either', async () => {
    // Un-apply every rename on a copy of the shipped data (the part number
    // back to its source key) and re-plan: every rename must come back as
    // `todo`, never as a collision.
    const { CURATIONS, planCurations } = await import('./curate-presets.mjs');
    const rows = db.presets.map((p) => ({ ...p }));
    for (const c of CURATIONS.filter((x) => x.action === 'rename')) {
      const [kind, mfr] = c.key.split('|');
      const i = rows.findIndex((p) => p.kind === kind && mfrKey(p.manufacturer) === mfr
        && String(p.partNo) === c.to);
      expect(i, `renamed row ${c.to} not found`).toBeGreaterThanOrEqual(0);
      rows[i].partNo = c.key.split('|')[2];
    }
    const plan = planCurations(rows);
    expect(plan.filter((x) => x.status === 'error').map((e) => `${e.c.key}: ${e.detail}`)).toEqual([]);
    expect(plan.filter((x) => x.c.action === 'rename' && x.status !== 'todo')).toEqual([]);
  });
});
