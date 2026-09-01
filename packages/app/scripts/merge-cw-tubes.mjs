/**
 * Composite Warehouse G12 fiberglass tubes → component-preset database.
 *
 * PIPELINE ORDER (see apply-preset-corrections.mjs for the whole ritual):
 *   1. fetch-component-presets.mjs  — OVERWRITES presets.json wholesale
 *   2. merge-rocksim-parts.mjs      — APPENDS the RockSim-only rows
 *   2b. merge-cw-tubes.mjs          — APPENDS these rows  ← THIS SCRIPT
 *   3. apply-preset-corrections.mjs — PATCHES rows by key, runs LAST
 *
 * SOURCE OF TRUTH: the table below, committed in this script the way the
 * corrections table is — because the spreadsheet it was transcribed from
 * (`docs/CW Tube Diameters.xlsx`, Eric, 2026-08-31) lives in docs/, which is
 * gitignored and LOCAL-ONLY. A regeneration on the other machine must not
 * depend on a file that does not sync. Transcribed 2026-08-31; the inch values
 * are the sheet's own, the mm columns were derived and are not restated here.
 *
 * WEIGHTS, AND THE PROBLEM WITH THEM — read before touching the density code.
 * The sheet carries manufacturer-claimed weight-per-foot for FOUR tubes only
 * (4.5", 8", 9", 11.67"). Eric asked to "interpolate what the other tubes
 * would weigh if they had the same density." They do not have the same
 * density. The four claims imply four DIFFERENT densities, and NOT ONE OF
 * THEM IS A POSSIBLE G12 LAMINATE:
 *
 *     4.5"  → 2283 kg/m³        9"     → 1092 kg/m³
 *     8"    → 1209 kg/m³        11.67" →  965 kg/m³
 *
 * Handbook G12 is ~1850–1940 kg/m³ (E-glass ~2540, epoxy ~1200, so a real
 * laminate cannot leave that band by much). 2283 is above the all-glass
 * limit; 965 is lighter than water. Whatever those four figures measure, it
 * is not (density × wall volume per foot).
 *
 * ERIC'S RULING, 2026-08-31c: "anchor them at handbook G12 (~1900 kg/m³), for
 * now" — and, shown the four-cliff catalogue that anchoring only the 22
 * unclaimed rows produces (the 8" tube coming out LIGHTER per foot than the
 * smaller 7.5" on an identical wall), he ruled the anchor applies to ALL 26.
 * So every row now carries G12_HANDBOOK and mass follows geometry × the user's
 * cut length.
 *
 * BE PRECISE ABOUT WHAT THAT FIXED. It removes the four cliffs the claimed
 * weights created — the 8" no longer comes out lighter than the 7.5" on the
 * same wall. It does NOT make the catalogue monotonic in outside diameter, and
 * saying so would be wrong: 7 of the 25 adjacent pairs still step down, every
 * one of them where a "Thin" or thinner-walled larger tube follows a thicker
 * smaller one (29 mm → 38 mm Thin, 4" Thick → 4.5", 8.25" → 9"). That is real
 * — a thinner tube weighs less — and it is what one density per row is
 * supposed to produce.
 *
 * The four claims are NOT discarded — each claimed row's description still
 * states the manufacturer's oz/ft figure and the density it implies, so a
 * reader can see both numbers and judge. `impliedDensity` stays for exactly
 * that. Eric owns at least one of every tube in this line and intends to
 * weigh them to the nearest gram; when he does, real densities replace this
 * anchor row by row, which is what "for now" means here.
 *
 * Deliberately NOT set on any row:
 *   - `length`: CW cuts to order and the sheet lists no lengths; presetPatch
 *     skips absent fields, so applying a preset keeps the user's tube length.
 *   - `mass`: a mass on a preset row becomes an overrideMass (presets.ts:84),
 *     which would freeze one arbitrary length's weight onto every tube.
 *
 * MOTOR-MOUNT rows: the sheet stars eleven tubes as "can be used as motor
 * mount tubes for standard motor case sizes". Those are appended a SECOND time
 * as TubeCoupler..? No — there is no InnerTube preset kind anywhere in the
 * .orc format; desktop gives inner tubes the BodyTube list (InnerTube.java
 * getPresetType() == BODY_TUBE), and as of v0.089 our picker does the same
 * (KIND_FOR_TYPE innertube → BodyTube). One row per tube, the star recorded in
 * the description.
 *
 * CONTRACT: idempotent and loud. Re-running APPENDS missing rows, REFRESHES
 * the density and description of rows already present (so a density-policy
 * change lands on re-run instead of being silently skipped — it was skipped,
 * before 2026-08-31c), and aborts non-zero on a key whose DIMENSIONS differ
 * (someone changed the table, or upstream grew a conflicting row). Running it
 * twice in a row is a no-op the second time.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(here, '..', 'src', 'data', 'presets.json');

const IN = 0.0254;
const FT = 0.3048;
const OZ = 0.0283495;

/**
 * Handbook G12 laminate, kg/m³ — the anchor EVERY row uses until Eric weighs
 * his own tubes. Mid-band of the 1850–1940 handbook range.
 */
const G12_HANDBOOK = 1900;

/**
 * The sheet, verbatim: [name, ID inches, OD inches, motorMount, ozPerFt|null].
 * "Thin"/"Thick" are CW's own wall designations. The trailing * on the sheet
 * marked the motor-mount-capable rows.
 */
const TUBES = [
  ['24mm Airframe',           0.945,  1.045,  true,  null],
  ['29mm Airframe',           1.145,  1.255,  true,  null],
  ['38mm Airframe Thin',      1.52,   1.6,    true,  null],
  ['38mm Airframe',           1.52,   1.645,  true,  null],
  ['54mm Airframe Thin',      2.152,  2.232,  true,  null],
  ['54mm Airframe',           2.152,  2.277,  true,  null],
  ['2.5 Inch Airframe Thin',  2.56,   2.64,   false, null],
  ['2.5 Inch Airframe',       2.56,   2.685,  false, null],
  ['3 Inch Airframe Thin',    3.0,    3.08,   true,  null],
  ['3 Inch Airframe',         3.0,    3.125,  true,  null],
  ['3.5 Inch Airframe',       3.4,    3.525,  false, null],
  ['4 Inch Airframe Thin',    3.9,    3.98,   true,  null],
  ['4 Inch Airframe',         3.9,    4.025,  true,  null],
  ['4 Inch Airframe Thick',   3.9,    4.15,   false, null],
  ['4.1 Inch Airframe',       4.0,    4.125,  false, null],
  ['4.5 Inch Airframe',       4.375,  4.5,    false, 13.80],
  ['5 Inch Airframe',         5.0,    5.15,   false, null],
  ['5.5 Inch Airframe',       5.375,  5.525,  false, null],
  ['6 Inch Airframe',         6.0,    6.17,   false, null],
  ['6 Inch MotorMount',       6.04,   6.21,   true,  null],
  ['7 Inch Airframe',         6.81,   7.0,    false, null],
  ['7.5 Inch Airframe',       7.518,  7.708,  false, null],
  ['8 Inch Airframe',         7.815,  8.005,  false, 19.8],
  ['8.25 Inch Airframe',      8.0,    8.25,   false, null],
  ['9 Inch Airframe',         8.78,   9.005,  false, 23.8],
  ['11.67 Inch Airframe',     11.41,  11.67,  false, 31.56],
];

/** Implied density of a claimed row, kg/m³ — mass/ft over wall volume/ft. */
function impliedDensity(idIn, odIn, ozPerFt) {
  const ri = (idIn * IN) / 2;
  const ro = (odIn * IN) / 2;
  const volPerFt = Math.PI * (ro * ro - ri * ri) * FT;
  return (ozPerFt * OZ) / volPerFt;
}


// Same normalization pair as fetch-component-presets/apply-preset-corrections
// (duplicated for the same reason the corrections script documents: importing
// the fetch module runs its network main).
const presetKey = (p) => {
  const pn = String(p.partNo ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const mfr = String(p.manufacturer ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return `${p.kind}|${mfr}|${pn}`;
};

function buildRows() {
  return TUBES.map(([name, idIn, odIn, mmt, ozPerFt]) => {
    // Every row: the handbook anchor. See the header block — the four claimed
    // weights each imply an impossible laminate density, so none of them is
    // used as mass; the claim is reported in the description instead.
    const rho = G12_HANDBOOK;
    // Both strings finish the sentence "G12 fiberglass, A" ID x B" OD (...)",
    // so neither repeats "G12" and neither restates the material.
    const claimed = ozPerFt !== null
      ? `density 1900 kg/m3, the handbook figure. Composite Warehouse states ${ozPerFt} oz/ft `
        + `for this size, which would need ${impliedDensity(idIn, odIn, ozPerFt).toFixed(0)} kg/m3 `
        + `- outside the range a fiberglass laminate can be, so it is not used here`
      : 'density 1900 kg/m3, the handbook figure; no published weight for this size';
    return {
      kind: 'BodyTube',
      manufacturer: 'Composite Warehouse',
      partNo: name,
      description: `G12 fiberglass, ${idIn}" ID x ${odIn}" OD`
        + (mmt ? ', usable as a motor-mount tube for standard motor cases' : '')
        + ` (${claimed})`,
      material: {
        name: 'Fiberglass, G12 (Composite Warehouse)',
        type: 'BULK',
        density: Number(rho.toFixed(1)),
      },
      insideDiameter: Number((idIn * IN).toFixed(7)),
      outsideDiameter: Number((odIn * IN).toFixed(7)),
      source: 'cw-tubes',
    };
  });
}

function main() {
  const raw = readFileSync(DB_PATH, 'utf8');
  const db = JSON.parse(raw);
  if (JSON.stringify(JSON.parse(raw), null, 1) + '\n' !== raw) {
    console.error('presets.json no longer round-trips at indent 1 — fix the serializer guard first.');
    process.exit(1);
  }

  const byKey = new Map(db.presets.map((p) => [presetKey(p), p]));
  const rows = buildRows();
  let added = 0;
  let already = 0;
  let refreshed = 0;
  for (const row of rows) {
    const key = presetKey(row);
    const existing = byKey.get(key);
    if (existing) {
      const same = Math.abs((existing.insideDiameter ?? 0) - row.insideDiameter) < 1e-9
        && Math.abs((existing.outsideDiameter ?? 0) - row.outsideDiameter) < 1e-9;
      if (!same) {
        console.error(`CONFLICT at "${key}": existing dims differ from the table. Resolve by hand.`);
        process.exit(1);
      }
      // Dimensions match, so this IS our row — but the DENSITY POLICY can
      // change without any dimension moving (it did on 2026-08-31c), and a
      // dims-only idempotence test would then leave the shipped catalogue on
      // the superseded policy while this script reported success. Refresh the
      // two fields the script owns, in place, and count it.
      if (existing.material?.density !== row.material.density
        || existing.description !== row.description) {
        existing.material = row.material;
        existing.description = row.description;
        refreshed++;
      } else {
        already++;
      }
      continue;
    }
    db.presets.push(row);
    byKey.set(key, row);
    added++;
  }
  if (added > 0 || refreshed > 0) {
    db.count = db.presets.length;
    writeFileSync(DB_PATH, JSON.stringify(db, null, 1) + '\n');
  }
  console.log(`cw-tubes: ${added} appended, ${refreshed} refreshed, ${already} already current`
    + ` — database ${added > 0 || refreshed > 0 ? 'updated' : 'unchanged'}.`);
  const anchors = TUBES.filter((t) => t[4] !== null);
  for (const t of anchors) {
    console.log(`  claimed: ${t[0]} → ${impliedDensity(t[1], t[2], t[4]).toFixed(1)} kg/m³`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
