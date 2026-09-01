/**
 * Drop preset rows that carry NO information another row does not already have.
 *
 * Asked for 2026-09-01a: "try to smartly clean up duplicate parts, if and where
 * you can." The honest scope of "where you can" turned out to be small, and the
 * measurement is the point:
 *
 *   39 groups share kind + manufacturer + part number
 *   -> 3 of them have a row that SUBSUMES the others (every field equal)
 *   -> 36 do not, and are left alone
 *
 * The 36 are not oversights. Most are genuinely different parts filed under one
 * part number - a SEMROC T-20-34 is a BT-20 in one row and an ST-20 in another -
 * and the rest disagree on something real: a 25 % density difference between a
 * "Fiber" and a "Paper" engine block, an 8 % shroud-line length on a parachute.
 * Picking a winner there is a per-part ruling with a mass consequence, not a
 * cleanup, so it is listed for the owner instead of guessed at.
 *
 * THE RULE, and it is deliberately dull: a row is dropped only when some other
 * row in its group has every field it has, with an equal value. `source` is
 * ignored, because that is provenance rather than data. Nothing is merged, no
 * field is chosen between, and no row is dropped on a heuristic.
 *
 *   node packages/app/scripts/dedupe-presets.mjs          # report only
 *   node packages/app/scripts/dedupe-presets.mjs --write  # apply
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(here, '../src/data/presets.json');

const groupKey = (p) => `${p.kind}|${p.manufacturer}|`
  + String(p.partNo ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Provenance, not data — a row is not "different" for coming from elsewhere. */
const IGNORE = new Set(['source']);

/** True when `a` already holds everything `b` does. */
const subsumes = (a, b) => Object.entries(b)
  .filter(([k]) => !IGNORE.has(k))
  .every(([k, v]) => JSON.stringify(a[k]) === JSON.stringify(v));

export function planDedupe(rows) {
  const groups = new Map();
  rows.forEach((p, i) => {
    const k = groupKey(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ i, p });
  });
  const drop = [];
  const keep = [];
  for (const [k, v] of groups) {
    if (v.length < 2) continue;
    const winner = v.find((x) => v.every((y) => y === x || subsumes(x.p, y.p)));
    if (winner) drop.push(...v.filter((x) => x !== winner).map((x) => ({ key: k, index: x.i })));
    else keep.push({ key: k, rows: v.length });
  }
  return { drop, keep };
}

function main() {
  const raw = readFileSync(DB_PATH, 'utf8');
  const db = JSON.parse(raw);
  if (JSON.stringify(JSON.parse(raw), null, 1) + '\n' !== raw) {
    console.error('presets.json no longer round-trips at indent 1 — fix the serializer guard first.');
    process.exit(1);
  }

  const { drop, keep } = planDedupe(db.presets);
  for (const d of drop) console.log(`  drop  ${d.key}`);
  console.log(`\n${drop.length} row(s) carry nothing a sibling does not already have.`);
  console.log(`${keep.length} group(s) share a part number but hold DIFFERENT data — left alone, `
    + 'each needs its own ruling:');
  for (const k of keep) console.log(`  keep  ${k.key}  (${k.rows} rows)`);

  if (!process.argv.includes('--write')) {
    console.log('\n(report only — pass --write to apply)');
    return;
  }
  if (drop.length === 0) { console.log('\ndatabase unchanged.'); return; }
  const doomed = new Set(drop.map((d) => d.index));
  db.presets = db.presets.filter((_, i) => !doomed.has(i));
  db.count = db.presets.length;
  writeFileSync(DB_PATH, JSON.stringify(db, null, 1) + '\n');
  console.log(`\ndatabase updated — ${drop.length} row(s) removed, ${db.presets.length} remain.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
