/**
 * Post-merge corrections to the bundled component-preset database.
 *
 * PIPELINE ORDER (all three steps, in this order, or data is lost):
 *   1. fetch-component-presets.mjs  — OVERWRITES presets.json wholesale
 *   2. merge-rocksim-parts.mjs      — APPENDS the RockSim-only rows
 *   3. apply-preset-corrections.mjs — PATCHES rows this table names
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(here, '..', 'src', 'data', 'presets.json');

// Keep in lockstep with fetch-component-presets.mjs presetKey()/normMfr() —
// duplicated here because importing that module runs its network main.
const MFR_ALIASES = {
  semrocastronautics: 'semroc',
  loc: 'locprecision',
  questaerospace: 'quest',
  balsamachiningcom: 'balsamachining',
  publicmissilesltd: 'publicmissiles',
  pml: 'publicmissiles',
  estesindustries: 'estes',
};
const normMfr = (mfr) => {
  const k = String(mfr ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return MFR_ALIASES[k] ?? k;
};
const presetKey = (p) => {
  const pn = String(p.partNo ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${p.kind}|${normMfr(p.manufacturer)}|${pn}`;
};

/**
 * Reference values agreed by three independent sources: desktop 24.12
 * datafiles/components/internal/bms-legacy.orc, RockSim CRDATA.CSV rows
 * 147/151 (docs/materials, local-only), and the same manufacturers' FIBER
 * siblings already shipped correct. 1.593 in = 0.0404622 m (centres BT-60),
 * 2.556 in = 0.0649224 m (centres BT-80), 0.978 in = 0.0248412 m (rides a
 * BT-50 motor tube), 0.125 in = 0.003175 m lite-ply thickness.
 */
const CORRECTIONS = [
  {
    key: 'CenteringRing|balsamachining|cr5060w',
    why: 'upstream BMS.ORC ships OD 1.283 in on a T50-to-T60 ring; 1.593 in per bms-legacy.orc + CRDATA.CSV:147 + the CR5060-F sibling',
    fields: { outsideDiameter: { bad: 0.0325882, good: 0.0404622 } },
  },
  {
    key: 'CenteringRing|balsamachining|cr5080w',
    why: 'upstream BMS.ORC ships OD 2.178 in and ID 1.000 in on a T50-to-T80 ring; 2.556/0.978 in per bms-legacy.orc + CRDATA.CSV:151 + the CR5080-F sibling',
    fields: {
      outsideDiameter: { bad: 0.0553212, good: 0.0649224 },
      insideDiameter: { bad: 0.0254, good: 0.0248412 },
    },
  },
  {
    key: 'CenteringRing|rocketarium|cr5060w',
    why: 'upstream ROCKETARIUM.ORC ships OD 1.238 in against its own description "1.593x.978x.125thk"',
    fields: { outsideDiameter: { bad: 0.0314452, good: 0.0404622 } },
  },
  {
    key: 'CenteringRing|rocketarium|cr5080w',
    why: 'upstream ROCKETARIUM.ORC duplicated the CR50MF70-W row above it (2.178x1.00x.05, description string included) under the CR5080-W part number; corrected to the CR5080 geometry every reference agrees on',
    fields: {
      outsideDiameter: { bad: 0.0553212, good: 0.0649224 },
      insideDiameter: { bad: 0.0254, good: 0.0248412 },
      length: { bad: 0.00127, good: 0.003175 },
    },
  },
];

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
      const cur = row[field];
      if (cur === good) {
        already++;
      } else if (cur === bad) {
        row[field] = good;
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

main();
