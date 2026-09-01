/**
 * Rewrite the committed presets.json so every manufacturer uses ONE spelling.
 *
 * Reported 2026-09-01a: "We have a number of manufacturers that are double
 * counted due to naming conventions that are slightly off." Measured: 33
 * distinct strings over 4,726 rows, five of them a second spelling of a company
 * already present — SEMROC / SEMROC Astronautics, LOC Precision / LOC/Precision,
 * BalsaMachining / BalsaMachining.com, Quest / Quest Aerospace, MPC / MRC.
 *
 * The generator now emits canonical names on its own (fetch-component-presets
 * canonicalises before its sort and fails loudly on a conflict), so this script
 * exists for the committed file, which cannot be regenerated without the
 * network and the reference checkout. Run it once; it is idempotent and says so.
 *
 *   node packages/app/scripts/canonicalize-manufacturers.mjs
 *
 * It changes ONLY the `manufacturer` field. No row is added, dropped, merged or
 * re-dimensioned here — deduplicating rows is a separate decision with its own
 * per-part evidence, and bundling the two would hide it inside a 177-row diff.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mfrDisplay, spellingConflicts } from './manufacturers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(here, '../src/data/presets.json');

function main() {
  const raw = readFileSync(DB_PATH, 'utf8');
  const db = JSON.parse(raw);

  // Same serializer guard apply-preset-corrections.mjs uses: the file is byte
  // stable at indent 1, and a formatting drift must fail loudly rather than
  // bury a 177-row rename in a whole-file diff.
  if (JSON.stringify(JSON.parse(raw), null, 1) + '\n' !== raw) {
    console.error('presets.json no longer round-trips at indent 1 — fix the serializer guard first.');
    process.exit(1);
  }

  const before = new Set(db.presets.map((p) => p.manufacturer));
  const moved = new Map();
  let changed = 0;
  for (const p of db.presets) {
    const canon = mfrDisplay(p.manufacturer);
    if (canon !== p.manufacturer) {
      moved.set(`${p.manufacturer} -> ${canon}`, (moved.get(`${p.manufacturer} -> ${canon}`) ?? 0) + 1);
      p.manufacturer = canon;
      changed++;
    }
  }

  // Re-sort: the file is ordered kind, manufacturer, partNo, and a rename that
  // leaves rows in their old slots makes the ordering contradict the contents.
  db.presets.sort((a, b) => a.kind.localeCompare(b.kind)
    || a.manufacturer.localeCompare(b.manufacturer)
    || String(a.partNo).localeCompare(String(b.partNo)));

  const conflicts = spellingConflicts(db.presets);
  if (conflicts.length) {
    for (const c of conflicts) {
      console.error(`STILL CONFLICTING "${c.key}": ${c.spellings.join(' / ')}`);
    }
    console.error('Add the spelling to ALIASES/DISPLAY in scripts/manufacturers.mjs.');
    process.exit(1);
  }

  for (const [what, n] of [...moved].sort()) console.log(`  ${what}  (${n} rows)`);
  const after = new Set(db.presets.map((p) => p.manufacturer));
  console.log(`manufacturers: ${before.size} -> ${after.size}; ${changed} row(s) renamed — `
    + `database ${changed > 0 ? 'updated' : 'unchanged'}.`);

  if (changed > 0) writeFileSync(DB_PATH, JSON.stringify(db, null, 1) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
