/**
 * Post-merge corrections to the bundled component-preset database.
 *
 * PIPELINE ORDER (every step, in this order, or data is lost):
 *   1. fetch-component-presets.mjs  — OVERWRITES presets.json wholesale
 *   2. merge-rocksim-parts.mjs      — APPENDS the RockSim-only rows
 *   2b. merge-cw-tubes.mjs          — APPENDS the Composite Warehouse tubes
 *   3. apply-preset-corrections.mjs — PATCHES rows this table names
 *   4. curate-presets.mjs --write — the ruled per-row DROPS and part-number fixes
 *      (added 2026-09-01; this file no longer runs last). CLAUDE.md § Architecture
 *      holds the authoritative order.
 *
 * Why this exists (2026-08-29, owner ruling "fix it"): four centering-ring
 * rows ship an outer diameter that cannot centre the tube their own part
 * number names, because the upstream openrocket-database .orc files carry
 * the errors LIVE on master (checked 2026-08-29) — so a regeneration
 * re-imports them, and the pipeline's documented merge policy ("github
 * wins") discarded the CORRECT figures it saw twice, in desktop 24.12's
 * bms-legacy.orc and in RockSim CRDATA.CSV rows 147/151. Each correction
 * below cites all agreeing references. None of these rows carries a `mass`
 * field, so mass follows geometry (presets.ts writes overrideMass only when
 * a row has `mass`) — fixing the dimensions fixes the mass.
 *
 * CONTRACT: idempotent, and LOUD on surprise. For every keyed field the
 * current value must be either the known-bad value (correction applied) or
 * the corrected value (already applied); anything else exits non-zero so a
 * future regeneration cannot silently strand or double-apply a correction.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetKey } from './manufacturers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(here, '..', 'src', 'data', 'presets.json');

// Keep in lockstep with fetch-component-presets.mjs presetKey()/normMfr() —
// duplicated here because importing that module runs its network main.
// One shared table (scripts/manufacturers.mjs). This file used to carry its own
// copy under a comment reading "keep in lockstep with fetch-component-presets";
// they did stay in lockstep, and the THIRD copy in merge-rocksim-parts.mjs did
// not, which is the whole defect.


/**
 * Reference values agreed by three independent sources: desktop 24.12
 * datafiles/components/internal/bms-legacy.orc, RockSim CRDATA.CSV rows
 * 147/151 (docs/materials, local-only), and the same manufacturers' FIBER
 * siblings already shipped correct. 1.593 in = 0.0404622 m (centres BT-60),
 * 2.556 in = 0.0649224 m (centres BT-80), 0.978 in = 0.0248412 m (rides a
 * BT-50 motor tube), 0.125 in = 0.003175 m lite-ply thickness.
 *
 * EXPORTED, and each entry carries an `upstream` descriptor naming the file,
 * the part number and the raw inch strings the upstream .orc is expected to
 * hold. `scripts/check-upstream.mjs` reads exactly this table over the network,
 * so the corrections and the vigilance check cannot drift apart — there is one
 * list, not two. Eric, 2026-08-31: *"i have no way of knowing whether they will
 * fix the issue on their end, so maintain vigilance on anything we rely on from
 * third party sources."*
 */
export const CORRECTIONS = [
  {
    key: 'CenteringRing|balsamachining|cr5060w',
    why: 'upstream BMS.ORC ships OD 1.283 in on a T50-to-T60 ring; 1.593 in per bms-legacy.orc + CRDATA.CSV:147 + the CR5060-F sibling',
    fields: { outsideDiameter: { bad: 0.0325882, good: 0.0404622 } },
    upstream: {
      file: 'BMS.ORC', element: 'CenteringRing', partNo: 'CR5060-W',
      fields: { OutsideDiameter: { bad: '1.283', good: '1.593' } },
    },
  },
  {
    key: 'CenteringRing|balsamachining|cr5080w',
    why: 'upstream BMS.ORC ships OD 2.178 in and ID 1.000 in on a T50-to-T80 ring; 2.556/0.978 in per bms-legacy.orc + CRDATA.CSV:151 + the CR5080-F sibling',
    fields: {
      outsideDiameter: { bad: 0.0553212, good: 0.0649224 },
      insideDiameter: { bad: 0.0254, good: 0.0248412 },
    },
    upstream: {
      file: 'BMS.ORC', element: 'CenteringRing', partNo: 'CR5080-W',
      fields: {
        OutsideDiameter: { bad: '2.178', good: '2.556' },
        InsideDiameter: { bad: '1.000', good: '0.978' },
      },
    },
  },
  {
    key: 'CenteringRing|rocketarium|cr5060w',
    why: 'upstream ROCKETARIUM.ORC ships OD 1.238 in against its own description "1.593x.978x.125thk"',
    fields: { outsideDiameter: { bad: 0.0314452, good: 0.0404622 } },
    upstream: {
      file: 'ROCKETARIUM.ORC', element: 'CenteringRing', partNo: 'CR5060-W',
      fields: { OutsideDiameter: { bad: '1.238', good: '1.593' } },
    },
  },
  {
    key: 'CenteringRing|rocketarium|cr5080w',
    why: 'upstream ROCKETARIUM.ORC duplicated the CR50MF70-W row above it (2.178x1.00x.05, description string included) under the CR5080-W part number; corrected to the CR5080 geometry every reference agrees on',
    fields: {
      outsideDiameter: { bad: 0.0553212, good: 0.0649224 },
      insideDiameter: { bad: 0.0254, good: 0.0248412 },
      length: { bad: 0.00127, good: 0.003175 },
    },
    upstream: {
      file: 'ROCKETARIUM.ORC', element: 'CenteringRing', partNo: 'CR5080-W',
      fields: {
        OutsideDiameter: { bad: '2.178', good: '2.556' },
        InsideDiameter: { bad: '1.000', good: '0.978' },
        Length: { bad: '0.05', good: '0.125' },
      },
    },
  },
];

/**
 * Issue #5 in the upstream tracker is fixed for the BMS BT-55 rings and NOT for
 * the Rocketarium ones: four rows still ship OD 1.238 in under a description
 * that says 1.283. We do NOT correct these — they are not rows this app has
 * been shown to get wrong for a user, and the fix belongs upstream — but the
 * checker watches them, because the day they move is the day to re-read the
 * BMS rows above (the same commit swept CR5060-W into that fix).
 */
/**
 * MATERIAL-DENSITY CORRECTIONS (2026-09-05). Found by the second engineering
 * audit, which was told to hunt for numbers the app presents as real that are
 * not. Six upstream <Material> definitions are physically impossible, and the
 * 25 rows below that use them carry NO catalogued mass — so the density is the
 * only thing that weighs the part, and presetPatch (presets.ts) writes it
 * straight into the component. Faithfully transcribed, upstream wrong; the
 * standing rule (Eric, 2026-08-31) is to correct and keep watching.
 *
 * Each entry's `fields` uses the dotted path 'material.density'. Upstream is
 * described one of two ways: `upstreamMaterial` names a <Material> block in a
 * github .orc for check-upstream.mjs to keep watching, and `unwatched` states
 * why no watch is possible — the value comes from a desktop-24.12 internal
 * file, a released artifact that will not change.
 */
const PAPER_BULK_BAD = 0.0011;
/**
 * 'Fiber, bulk' — the density BMS.ORC and ROCKETARIUM.ORC give their own
 * FIBER rings (657 kg/m3), which is what a "paper" centering ring physically
 * is; several of these rows' descriptions say "fiber" outright. Not the app's
 * generic Cardboard (680): the siblings are the closer reference.
 */
const PAPER_BULK_GOOD = 657;

const paperRow = (kind, mfrKeyPart, partNo, file) => ({
  key: `${kind}|${mfrKeyPart}`,
  why: `upstream ${file} declares "Paper, bulk" at 0.0011 kg/m3 (six orders of magnitude light — a hundred-thousandth of air); the row has no <Mass>, so it weighed nothing. Pinned to the 657 kg/m3 the same file gives its own fiber rings.`,
  fields: { 'material.density': { bad: PAPER_BULK_BAD, good: PAPER_BULK_GOOD } },
  upstreamMaterial: { file, name: 'Paper, bulk', bad: '.0011' },
  partNo,
});

export const MATERIAL_CORRECTIONS = [
  // --- Paper, bulk at 0.0011 kg/m3 — 18 rows, two makers, one shared upstream error
  ...['cr2050p', 'cr2050p1', 'cr35p', 'cr5052hp', 'cr5052hp1', 'cr5055p', 'cr520p']
    .map((k) => paperRow('CenteringRing', `balsamachining|${k}`, k.toUpperCase().replace(/P(1?)$/, '-P$1'), 'BMS.ORC')),
  ...['cr2050p', 'cr2050p1', 'cr35p', 'cr5052hp', 'cr5052hp1', 'cr5055p', 'cr520p']
    .map((k) => paperRow('CenteringRing', `rocketarium|${k}`, k.toUpperCase().replace(/P(1?)$/, '-P$1'), 'ROCKETARIUM.ORC')),
  ...['eb13p', 'eb18p', 'eb24p', 'eb29p']
    .map((k) => paperRow('EngineBlock', `balsamachining|${k}`, k.toUpperCase().replace(/P$/, '-P'), 'BMS.ORC')),

  // --- Rocketarium kraft motor-mount tubes: two decimal slips in one file
  {
    key: 'BodyTube|rocketarium|bt50x325motortubes',
    why: 'upstream ROCKETARIUM.ORC declares "Paper, spiral kraft, Motor Mount, BT-50, bulk" at 9072 kg/m3 — heavier than steel; its own "Motor Mount, BT-50, long" is 887.12. 907.2 is 9072 with the decimal moved and sits where the siblings do. Row has no <Mass>: at 9072 the 82.55 mm tube weighed 19.0 g against 1.9 g.',
    fields: { 'material.density': { bad: 9072, good: 907.2 } },
    upstreamMaterial: { file: 'ROCKETARIUM.ORC', name: 'Paper, spiral kraft, Motor Mount, BT-50, bulk', bad: '9072' },
  },
  ...[['29mmmotormounttube12tw', '29mm Motor Mount tube 12" (TW)'], ['29mmmotormounttube18tw', '29mm Motor Mount tube 18" (TW)']]
    .map(([k, partNo]) => ({
      key: `BodyTube|rocketarium|${k}`,
      why: 'upstream ROCKETARIUM.ORC declares "Paper, spiral kraft, Motor Mount, 29mm, 12\\", thick, bulk" at 110.62 kg/m3 where its own non-thick "29mm, 12\\"" kraft is 842.4. Density is a property of the paper, not the wall, so the thick tube takes its sibling\'s figure. Row has no <Mass>: at 110.62 the 12 in tube weighed 3.5 g against 26.6 g.',
      fields: { 'material.density': { bad: 110.62, good: 842.4 } },
      upstreamMaterial: { file: 'ROCKETARIUM.ORC', name: 'Paper, spiral kraft, Motor Mount, 29mm, 12", thick, bulk', bad: '110.62' },
      partNo,
    })),

  // --- Public Missiles fiberglass nose cones at balsa density (desktop-24.12 internal file)
  ...['pmlfnc1141', 'pmlfnc114hrpn', 'pmlfnc600', 'pmlfnc751'].map((k) => ({
    key: `NoseCone|publicmissiles|${k}`,
    why: 'desktop 24.12 publicmissiles-legacy.orc declares this maker\'s "Fiberglass" at 128.147704 kg/m3 — exactly 8 lb/ft3, the BALSA figure. Three of the four rows carry a <Mass> that overrides it; FNC-11.4HRPN does not and computed 0.076 kg for a cone its catalogued sibling lists at 2.27 kg. 1900 is what github publicmissiles.orc gives the same maker\'s "Fiberglass, generic, bulk".',
    fields: { 'material.density': { bad: 128.147704, good: 1900 } },
    unwatched: 'value comes from desktop 24.12\'s bundled publicmissiles-legacy.orc, a released artifact that will not change; the github publicmissiles.orc for the same maker already carries 1900',
  })),

  // --- FlisKits engine block: a material declared at exactly zero
  {
    key: 'EngineBlock|fliskits|eb25',
    why: 'desktop 24.12\'s bundled fliskits .orc declares "Light Ply" at 0 kg/m3, so the block weighed exactly nothing. 352.4 is what 148 other rows in this catalogue give "Plywood, light, bulk" and 3 more give "lite ply" — the same material by its own siblings.',
    fields: { 'material.density': { bad: 0, good: 352.4 } },
    unwatched: 'value comes from a desktop 24.12 internal .orc, a released artifact that will not change',
  },

  // --- Rows with NO density at all (found by the density screen the same day).
  // All eleven carry a catalogued <Mass>, so their weight was right — presetPatch
  // writes overrideMass — but the property panel showed a material with no
  // density, and clearing the override would have left the part weightless.
  // LOC's legacy .orc names the material "[material:[material:polystyrene PS]]",
  // a reference wrapped twice, so it matched no <Material> block; the singly
  // wrapped "[material:Polystyrene PS]" in the same file is 1049.2093527.
  ...['locpnc152', 'locpnc214', 'locpnc256', 'locpnc300', 'locpnc390', 'locpnc538', 'locpnc538l', 'locpnc751']
    .map((k) => ({
      key: `NoseCone|locprecision|${k}`,
      why: 'desktop 24.12 loc-legacy .orc references the material as "[material:[material:polystyrene PS]]" — wrapped twice — so no <Material> block matched and the row shipped with no density. 1049.2093527 is the same file\'s "[material:Polystyrene PS]".',
      fields: { 'material.density': { bad: undefined, good: 1049.2093527 } },
      unwatched: 'value comes from a desktop 24.12 internal .orc, a released artifact that will not change; the pipeline now also unwraps a doubly-wrapped reference (fetch-component-presets.mjs)',
    })),
  {
    key: 'Transition|locprecision|ptc390',
    why: 'same doubly-wrapped "[material:[material:Polystyrene PS]]" reference as the LOC nose cones above; no density shipped.',
    fields: { 'material.density': { bad: undefined, good: 1049.2093527 } },
    unwatched: 'value comes from a desktop 24.12 internal .orc, a released artifact that will not change',
  },
  ...['10100', '10104'].map((k) => ({
    key: `TubeCoupler|quest|${k}`,
    why: 'desktop 24.12 quest .orc names "Kraft Phenolic" with no matching <Material> block, so the row shipped with no density. 958.70503449 is what the same catalogue gives "[material:Kraft phenolic]" on two other rows.',
    fields: { 'material.density': { bad: undefined, good: 958.70503449 } },
    unwatched: 'value comes from a desktop 24.12 internal .orc, a released artifact that will not change',
  })),

  // --- Rocketarium launch lugs: three sizes of the same glassine kraft, three
  // densities. 616.44 (the 1/4 in lug) is the only one a paper can have.
  {
    key: 'LaunchLug|rocketarium|18launchlug',
    why: 'upstream ROCKETARIUM.ORC declares the 1/8 in lug\'s kraft at 2525.42 kg/m3 (aluminium is 2700) while its own 1/4 in lug is 616.44. Tiny part, tiny mass, but a density no paper can have.',
    fields: { 'material.density': { bad: 2525.42, good: 616.44 } },
    upstreamMaterial: { file: 'ROCKETARIUM.ORC', name: 'Paper, spiral kraft glassine, 1/8" Lugs, bulk', bad: '2525.42' },
  },
  {
    key: 'LaunchLug|rocketarium|316launchlug',
    why: 'upstream ROCKETARIUM.ORC declares the 3/16 in lug\'s kraft at 1498.77 kg/m3 — denser than solid phenolic — while its own 1/4 in lug is 616.44.',
    fields: { 'material.density': { bad: 1498.77, good: 616.44 } },
    upstreamMaterial: { file: 'ROCKETARIUM.ORC', name: 'Paper, spiral kraft glassine, 3/16" Lugs, bulk', bad: '1498.77' },
  },
];
CORRECTIONS.push(...MATERIAL_CORRECTIONS);

export const UPSTREAM_WATCH = [
  {
    file: 'ROCKETARIUM.ORC', element: 'CenteringRing',
    partNos: ['CR5055-P', 'CR5055-F', 'CR5055-W', 'CR50H55-W'],
    field: 'OutsideDiameter', expect: '1.238',
    why: 'upstream issue #5 is unfixed for Rocketarium BT-55 rings — each row ships OD 1.238 in under a Description that says 1.283 (verified live 2026-08-31)',
  },
];

/** Read/write a dotted path on a row: getAt(row, 'material.density'). */
function getAt(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setAt(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

function main() {
  const raw = readFileSync(DB_PATH, 'utf8');
  const db = JSON.parse(raw);
  // The DB serializes byte-stably at indent 1 (verified 2026-08-29); guard
  // it so a formatting change upstream fails loudly instead of producing a
  // whole-file diff that buries the four-row fix.
  if (JSON.stringify(JSON.parse(raw), null, 1) + '\n' !== raw) {
    console.error('presets.json no longer round-trips at indent 1 — fix the serializer guard before applying corrections.');
    process.exit(1);
  }

  const byKey = new Map();
  for (const p of db.presets) {
    const k = presetKey(p);
    byKey.set(k, byKey.has(k) ? 'DUPLICATE' : p);
  }

  let applied = 0;
  let already = 0;
  for (const c of CORRECTIONS) {
    const row = byKey.get(c.key);
    if (!row) {
      console.error(`MISSING ROW for correction key "${c.key}" — the regeneration dropped or renamed it; re-check before shipping.`);
      process.exit(1);
    }
    if (row === 'DUPLICATE') {
      console.error(`AMBIGUOUS KEY "${c.key}" matches more than one row — the dedupe contract changed; re-check before shipping.`);
      process.exit(1);
    }
    for (const [field, { bad, good }] of Object.entries(c.fields)) {
      // `field` may be a dotted path — 'material.density' — since 2026-09-05,
      // when six upstream MATERIAL definitions turned out to be impossible
      // (paper at 0.0011 kg/m3, fiberglass at balsa density, a kraft tube
      // heavier than steel) and the rows that use them carry no mass of their
      // own, so the density is the only thing that weighs them.
      const cur = getAt(row, field);
      if (cur === good) {
        already++;
      } else if (cur === bad) {
        setAt(row, field, good);
        applied++;
        console.log(`fixed ${c.key} ${field}: ${bad} -> ${good}`);
      } else {
        console.error(`UNEXPECTED VALUE at ${c.key} ${field}: ${cur} (expected the known-bad ${bad} or the corrected ${good}).`);
        console.error(`Context: ${c.why}`);
        process.exit(1);
      }
    }
  }

  if (applied > 0) {
    writeFileSync(DB_PATH, JSON.stringify(db, null, 1) + '\n');
  }
  console.log(`corrections: ${applied} field(s) applied, ${already} already in place — database ${applied > 0 ? 'updated' : 'unchanged'}.`);
}

// Run only when invoked directly. check-upstream.mjs imports CORRECTIONS from
// here, and an unguarded main() would rewrite presets.json as a side effect of
// a read-only network check.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
