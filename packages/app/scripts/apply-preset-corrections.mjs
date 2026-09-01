/**
 * Post-merge corrections to the bundled component-preset database.
 *
 * PIPELINE ORDER (all three steps, in this order, or data is lost):
 *   1. fetch-component-presets.mjs  — OVERWRITES presets.json wholesale
 *   2. merge-rocksim-parts.mjs      — APPENDS the RockSim-only rows
 *   2b. merge-cw-tubes.mjs          — APPENDS the Composite Warehouse tubes
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
export const UPSTREAM_WATCH = [
  {
    file: 'ROCKETARIUM.ORC', element: 'CenteringRing',
    partNos: ['CR5055-P', 'CR5055-F', 'CR5055-W', 'CR50H55-W'],
    field: 'OutsideDiameter', expect: '1.238',
    why: 'upstream issue #5 is unfixed for Rocketarium BT-55 rings — each row ships OD 1.238 in under a Description that says 1.283 (verified live 2026-08-31)',
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

// Run only when invoked directly. check-upstream.mjs imports CORRECTIONS from
// here, and an unguarded main() would rewrite presets.json as a side effect of
// a read-only network check.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
