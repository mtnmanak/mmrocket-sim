/**
 * Fruity Chutes: make the manufacturer's own published data canonical.
 *
 * OWNER RULING, 2026-09-03 (`docs/testing/issues-2026-09-03b.md`):
 *   "For Fruity Chutes, the standing rule should be to take the information
 *    they have on their website as canonical and it should supercede anything
 *    from other sources."
 * and, in the same batch: fix the IFC-096-S mass slip, drop the ten RockSim
 * rows and size-prefix the names, add spill holes, add the missing canopies,
 * and use Cd 1.5 for Classic Elliptical.
 *
 * WHY A SEPARATE STEP. `presets.json` is regenerated wholesale by
 * fetch-component-presets.mjs from OpenRocket's `.orc` files, so this data has
 * to be re-applied every time. It is a DATA SOURCE, like merge-cw-tubes.mjs —
 * not a per-row curation (those live in curate-presets.mjs).
 *
 * WHAT IT DOES
 *   1. Every existing Fruity Chutes row is matched to a model by part number
 *      and takes the manufacturer's Cd, spill hole, mass and gore count, and a
 *      size-first description.
 *   2. Models we do not carry are ADDED.
 *   3. Rows that match no model are left untouched (the ten RockSim duplicates
 *      are dropped by curate-presets.mjs, which runs after this).
 *
 * THE Cd AND THE SPILL HOLE ARE ONE FACT, NOT TWO. Their Cd is referenced to
 * the canopy area MINUS the spill hole; our kernel uses the nominal diameter
 * and scales by (1 - (d/D)^2), which is the same area. Apply one without the
 * other and the descent rate is wrong by 1.5-2%. That is why this script
 * refuses to write a Cd without a spill hole.
 *
 * PART NUMBERS. The site writes them unpadded (`IFC-84-S`) and OpenRocket's
 * rows pad them (`IFC-084-S`); a trailing `-N` in our rows means "nylon lines",
 * which is the site's BASE sku with no suffix (no site sku ends in N).
 *
 *   node packages/app/scripts/merge-fruity-chutes.mjs          # report only
 *   node packages/app/scripts/merge-fruity-chutes.mjs --write  # apply
 *
 * Run it after merge-cw-tubes.mjs and before apply-preset-corrections.mjs.
 * IDEMPOTENT: a second run reports 0 changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mfrKey } from './manufacturers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(here, '../src/data/presets.json');
const DATA_PATH = join(here, 'fruity-chutes-models.json');

/** Site sku ⇄ our part number, reduced to a comparison token. */
export const fcKey = (partNo) => String(partNo ?? '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '')
  .replace(/N$/, '')              // our "-N" (nylon lines) is the site's base sku
  .replace(/^([A-Z]+)0*(\d)/, '$1$2'); // IFC084S -> IFC84S

/** Size-first, the way the RockSim names people actually picked were written. */
export const fcDescription = (m) => {
  const inches = Number.isInteger(m.diameterIn) ? String(m.diameterIn) : m.diameterIn.toFixed(1);
  const oz = m.weightOz >= 10 ? m.weightOz.toFixed(0) : m.weightOz.toFixed(1);
  return `${inches}" ${m.family} — Cd ${m.dragCoefficient}, ${oz} oz, ${m.gores} gores`;
};

/**
 * The canopy and shroud-line materials for a NEW row.
 *
 * Fruity Chutes publish a fabric weight in prose but no areal density, so a
 * new row inherits the materials of the nearest existing catalogue row of the
 * same model prefix — real data from the OpenRocket database rather than a
 * number invented here. Same for line length, which they publish only for TARC.
 */
const nearestSibling = (rows, m) => {
  const prefix = m.sku.split('-')[0];
  const kin = rows.filter((r) => r.kind === 'Parachute'
    && mfrKey(r.manufacturer) === 'fruitychutes'
    && fcKey(r.partNo).startsWith(prefix)
    && r.material);
  if (!kin.length) {
    // TARC has no catalogue row of its own: it is a small elliptical nylon
    // canopy, so the Classic Elliptical rows are the right kin.
    const alt = rows.filter((r) => r.kind === 'Parachute'
      && mfrKey(r.manufacturer) === 'fruitychutes' && fcKey(r.partNo).startsWith('CFC') && r.material);
    if (!alt.length) return null;
    kin.push(...alt);
  }
  let best = kin[0];
  let bestGap = Infinity;
  for (const r of kin) {
    const gap = Math.abs((r.diameter ?? 0) - m.diameterM);
    if (gap < bestGap) { bestGap = gap; best = r; }
  }
  return best;
};

export function mergeFruityChutes(db, data) {
  const rows = db.presets;
  const byKey = new Map(data.models.map((m) => [fcKey(m.sku), m]));
  const changes = [];
  const seen = new Set();

  for (const row of rows) {
    if (row.kind !== 'Parachute' || mfrKey(row.manufacturer) !== 'fruitychutes') continue;
    const m = byKey.get(fcKey(row.partNo));
    if (!m) continue;             // e.g. the ten RockSim rows — curate-presets drops them
    seen.add(fcKey(m.sku));
    const before = { ...row };
    row.dragCoefficient = m.dragCoefficient;
    row.spillHoleDiameter = m.spillHoleM;
    row.mass = m.massKg;
    row.lineCount = m.gores;
    row.diameter = m.diameterM;
    row.description = fcDescription(m);
    if (m.lineLengthM !== undefined) row.lineLength = m.lineLengthM;
    const diff = Object.keys(row).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(row[k]));
    if (diff.length) changes.push({ action: 'update', partNo: row.partNo, sku: m.sku, fields: diff, before, after: { ...row } });
  }

  // The ten dropped RockSim part numbers ride on the row they duplicate, so a
  // `.rkt` that names 29185 still finds its canopy. Dropping a row must never
  // cost a file its catalogue link.
  const aliasTargets = new Map();
  for (const [rockSimPartNo, sku] of Object.entries(data.rocksimAliases ?? {})) {
    const key = fcKey(sku);
    if (!aliasTargets.has(key)) aliasTargets.set(key, []);
    aliasTargets.get(key).push(rockSimPartNo);
  }
  for (const row of rows) {
    if (row.kind !== 'Parachute' || mfrKey(row.manufacturer) !== 'fruitychutes') continue;
    const alts = aliasTargets.get(fcKey(row.partNo));
    if (!alts) continue;
    const before = JSON.stringify(row.altPartNos);
    row.altPartNos = [...alts].sort();
    if (before !== JSON.stringify(row.altPartNos)) {
      changes.push({ action: 'update', partNo: row.partNo, sku: row.partNo, fields: ['altPartNos'], before: { altPartNos: JSON.parse(before ?? 'null') }, after: { ...row } });
    }
  }

  const added = [];
  for (const m of data.models) {
    if (seen.has(fcKey(m.sku))) continue;
    const kin = nearestSibling(rows, m);
    if (!kin) throw new Error(`No sibling row to take materials from for ${m.sku}`);
    const row = {
      kind: 'Parachute',
      manufacturer: 'Fruity Chutes',
      partNo: m.sku,
      description: fcDescription(m),
      material: kin.material,
      ...(kin.lineMaterial ? { lineMaterial: kin.lineMaterial } : {}),
      mass: m.massKg,
      diameter: m.diameterM,
      spillHoleDiameter: m.spillHoleM,
      dragCoefficient: m.dragCoefficient,
      lineCount: m.gores,
      // Their published length for TARC; otherwise the nearest sibling's
      // length scaled by diameter — a convention, not Fruity Chutes data.
      lineLength: m.lineLengthM ?? (kin.lineLength && kin.diameter
        ? +(kin.lineLength * (m.diameterM / kin.diameter)).toFixed(6)
        : +(m.diameterM * 1.15).toFixed(6)),
      source: 'fruitychutes.com',
    };
    rows.push(row);
    added.push({ action: 'add', partNo: m.sku, sku: m.sku, after: row, kin: kin.partNo });
  }

  // A Cd without its spill hole is wrong by 1.5-2% — never let one ship.
  for (const row of rows) {
    if (row.kind !== 'Parachute' || mfrKey(row.manufacturer) !== 'fruitychutes') continue;
    if (!byKey.has(fcKey(row.partNo))) continue;
    if (typeof row.dragCoefficient === 'number' && typeof row.spillHoleDiameter !== 'number') {
      throw new Error(`${row.partNo}: Cd without a spill hole — they are one fact, see this file's header`);
    }
  }
  return { changes, added, models: data.models.length };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const write = process.argv.includes('--write');
  const db = JSON.parse(readFileSync(DB_PATH, 'utf8'));
  const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  const { changes, added, models } = mergeFruityChutes(db, data);
  console.log(`Fruity Chutes: ${models} published models; ${changes.length} row(s) updated, ${added.length} added.`);
  for (const c of changes) {
    const parts = c.fields.map((f) => `${f}: ${JSON.stringify(c.before[f])} -> ${JSON.stringify(c.after[f])}`);
    console.log(`  update ${c.partNo.padEnd(12)} (${c.sku})  ${parts.join(' | ')}`);
  }
  for (const a of added) console.log(`  add    ${a.partNo.padEnd(12)}  ${a.after.description}  [materials from ${a.kin}]`);
  if (!write) { console.log('\nReport only. Re-run with --write to apply.'); process.exit(0); }
  db.count = db.presets.length;
  writeFileSync(DB_PATH, `${JSON.stringify(db, null, 1)}\n`);
  console.log(`\nWrote ${DB_PATH} (${db.count} rows)`);
}
