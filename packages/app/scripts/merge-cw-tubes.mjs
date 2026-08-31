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
 * density. The four claims imply four DIFFERENT densities:
 *
 *     4.5"  → 2283 kg/m³        9"     → 1092 kg/m³
 *     8"    → 1209 kg/m³        11.67" →  965 kg/m³
 *
 * Handbook G12 is ~1850–1940 kg/m³; the 11.67" claim is lighter than water,
 * which no solid fiberglass is. The claims are what the manufacturer states,
 * so this script (a) reproduces each CLAIMED weight exactly by deriving that
 * row's density from it, and (b) for the unclaimed rows interpolates the
 * implied density PIECEWISE-LINEARLY IN OD between the claimed points,
 * clamped flat at both ends — following the manufacturer's own trend rather
 * than inventing a fifth number. Every derived density is written into the
 * row's material so mass follows geometry × the user's cut length.
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
 * CONTRACT: idempotent and loud. Re-running skips rows whose key already
 * exists with matching dims; a key that exists with DIFFERENT dims aborts
 * non-zero (someone changed the table or upstream grew a conflicting row).
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

/** Piecewise-linear in OD between the claimed points, clamped at the ends. */
function densityFor(odIn, anchors) {
  if (odIn <= anchors[0][0]) return anchors[0][1];
  const last = anchors[anchors.length - 1];
  if (odIn >= last[0]) return last[1];
  for (let i = 1; i < anchors.length; i++) {
    const [x0, y0] = anchors[i - 1];
    const [x1, y1] = anchors[i];
    if (odIn <= x1) return y0 + ((odIn - x0) / (x1 - x0)) * (y1 - y0);
  }
  return last[1];
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
  const anchors = TUBES.filter((t) => t[4] !== null)
    .map((t) => [t[2], impliedDensity(t[1], t[2], t[4])])
    .sort((a, b) => a[0] - b[0]);
  return TUBES.map(([name, idIn, odIn, mmt, ozPerFt]) => {
    const rho = ozPerFt !== null
      ? impliedDensity(idIn, odIn, ozPerFt)
      : densityFor(odIn, anchors);
    const claimed = ozPerFt !== null
      ? `${ozPerFt} oz/ft per the manufacturer`
      : 'density interpolated from the four manufacturer-claimed weights';
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
  for (const row of rows) {
    const key = presetKey(row);
    const existing = byKey.get(key);
    if (existing) {
      const same = Math.abs((existing.insideDiameter ?? 0) - row.insideDiameter) < 1e-9
        && Math.abs((existing.outsideDiameter ?? 0) - row.outsideDiameter) < 1e-9;
      if (same) { already++; continue; }
      console.error(`CONFLICT at "${key}": existing dims differ from the table. Resolve by hand.`);
      process.exit(1);
    }
    db.presets.push(row);
    byKey.set(key, row);
    added++;
  }
  if (added > 0) {
    db.count = db.presets.length;
    writeFileSync(DB_PATH, JSON.stringify(db, null, 1) + '\n');
  }
  console.log(`cw-tubes: ${added} row(s) appended, ${already} already present — database ${added > 0 ? 'updated' : 'unchanged'}.`);
  const anchors = TUBES.filter((t) => t[4] !== null);
  for (const t of anchors) {
    console.log(`  claimed: ${t[0]} → ${impliedDensity(t[1], t[2], t[4]).toFixed(1)} kg/m³`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
