/**
 * Per-row curations of the preset database: rows to DROP, part numbers to FIX.
 *
 * WHY THIS EXISTS. `presets.json` is regenerated wholesale by
 * fetch-component-presets.mjs, so a hand edit is silently wiped on the next
 * run. `apply-preset-corrections.mjs` is the sanctioned post-regeneration patch
 * step, but it can only change FIELDS on a UNIQUELY keyed row — it exits with
 * AMBIGUOUS KEY the moment two rows share a key, which is precisely the
 * situation every curation below is about. So the curations needed a home that
 * can address one row *inside* a duplicate group, and this is it.
 *
 * Run it after fetch-component-presets.mjs and apply-preset-corrections.mjs:
 *
 *   node packages/app/scripts/curate-presets.mjs          # report only
 *   node packages/app/scripts/curate-presets.mjs --write  # apply
 *
 * ADDRESSING. `key` selects the kind|manufacturer|partNo group through the
 * shared presetKey, so it is the NORMALISED part number — lowercased,
 * punctuation stripped, `+` kept. `CR-7-18` is addressed as `cr718`. Getting
 * that wrong is caught rather than ignored: the first draft of this table used
 * the raw part numbers and every one of those nine entries failed loudly.
 * `match` narrows
 * within that group by exact field equality, and `descIncludes` by a substring
 * of the description. Together they must select EXACTLY ONE row: zero or two is
 * a hard error, never a silent skip, because "the data moved under us" is the
 * failure this file has to catch rather than paper over.
 *
 * IDEMPOTENT. A drop whose row is already gone, and a rename whose target name
 * is already in place, both count as done. Running twice changes nothing and
 * says so.
 *
 * PROVENANCE. Every entry carries `why` with the measurement behind it. These
 * were ruled by the owner on 2026-09-01 from
 * docs/testing/preset-duplicate-decisions-2026-09-01.md ("change all as
 * recommended"). Groups the sheet said to LEAVE ALONE are deliberately absent —
 * notably the four SEMROC [R] transitions, where the recommendation was to
 * change no data and raise an upstream issue instead, because a rename-and-drop
 * there would trade a catalogue mass for a computed one.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetKey } from './manufacturers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(here, '../src/data/presets.json');

export const CURATIONS = [
  // ---- the same part filed twice: a row goes -----------------------------
  {
    action: 'drop', key: 'BodyTube|balsamachining|t5plus34',
    match: { outsideDiameter: 0.0138176 },
    why: 'Two T5Plus-34 rows. The 0.544 in one is byte-identical to the plain BMS T5-34 '
      + 'row in every field but the part number, so it carries no distinct information; the '
      + '0.585 in one has the bore that clears T5-34 (a BMS "Plus" tube slips OVER its plain '
      + 'tube, the same relationship T4Plus has to T4) and matches SEMROC BT-5+ exactly.',
  },
  {
    action: 'drop', key: 'BulkHead|rocketarium|1638mmbulkplate',
    match: { outsideDiameter: 0.0290576 },
    why: 'Two rows for the 38 mm bulkplate; the dropped one is 29.06 mm across, which is '
      + 'EXACTLY the OD of the 1.1 in (29 mm) plate on the row above it — a copied value. '
      + 'The survivor at 38.0 mm sits just under the matching Rocketarium tube bore, which '
      + 'is how every other plate in that family is dimensioned.',
  },
  ...['tb5', 'tb7', 'tr7'].map((pn) => ({
    action: 'drop', key: `EngineBlock|semroc|${pn}`,
    match: { source: 'rocksim' },
    why: 'Same part from two sources, identical geometry, differing only in material: '
      + 'desktop-24.12 says Fiber (656.76 kg/m³), RockSim says "Paper (office)" (820) — a '
      + '25 % density difference. SEMROC thrust blocks are vulcanised-fibre stock and '
      + '"Paper (office)" is RockSim\'s generic mapping; 27 fibre rows against 3 in the same '
      + 'kind across the SEMROC catalogue.',
  })),
  {
    action: 'drop', key: 'EngineBlock|semroc|ts9',
    match: { source: 'rocksim' },
    why: 'The clearest of the four: the RockSim row carries NO material at all. presetPatch '
      + 'only writes a material when one is present, so applying it left the component on '
      + 'whatever material it already had — silently.',
  },
  {
    action: 'drop', key: 'NoseCone|semroc|bnc80hacs',
    descIncludes: 'BNC-80HACS, 10.6', // the survivor's description says BTH-80
    why: 'Two identical BNC-80HACS rows. The survivor is the only nose cone in the whole '
      + '4,723-row file whose description contains "BTH-80"; drop that one instead and a '
      + 'search for BTH-80 returns no balsa cone at all.',
  },
  ...['pn18', 'pn24'].map((pn) => ({
    action: 'drop', key: `Parachute|semroc|${pn}`,
    match: { source: 'rocksim' },
    why: 'Same chute from two sources with identical canopy geometry. The desktop row keeps '
      + 'the more specific line density; the RockSim row rounds it off. On PN-24 the two '
      + 'genuinely disagree on shroud-line length (24.0 in vs 26.0 in) and the desktop 24.0 '
      + 'is kept — flagged in the response doc rather than settled silently.',
  })),

  // ---- different parts sharing a part number: the NAME is the fix --------
  {
    action: 'rename', key: 'NoseCone|semroc|bnc50sf1', match: { mass: 0.00368543800625 },
    to: 'BNC-50SF2',
    why: 'Two different BNC-50SF1 cones — a plain conical and a cylinder-conical combo. '
      + 'SF2 is the only gap in an otherwise contiguous SF1–SF5 run and 0 rows use it. '
      + 'Direction is domain reasoning, not measurement: the set runs monotonically blunter '
      + 'as the number rises, which puts the plain cone at SF1.',
  },
  {
    action: 'rename', key: 'BodyTube|quest|t303000q9523', match: { length: 0.127 },
    to: 'Q11421',
    why: 'A 30 in and a 5 in tube share one part number. The 5 in row\'s OWN description '
      + 'already reads "PN Q11421", and it is the only 5 in 30 mm Quest tube in the file.',
  },
  {
    action: 'rename', key: 'BodyTube|semroc|t2034', match: { outsideDiameter: 0.051816 },
    to: 'ST-20-34',
    why: 'A BT-20 (0.736 in) and an ST-20 (2.040 in) both filed as T-20-34 — a factor of '
      + '2.77 apart. The file itself sets the convention: ST-7-34, ST-8-34 and ST-10-34 are '
      + 'all present at 34 inches, so no catalogue is needed to name this one.',
  },
  {
    action: 'rename', key: 'CenteringRing|semroc|cr718', descIncludes: 'engine hook slot',
    to: 'CR-7-18EH',
    why: 'A plain ring and a hook-slotted ring, identical in geometry because a slot does '
      + 'not change the blank. The file already carries 8 SEMROC "EH" rings.',
  },
  {
    action: 'rename', key: 'CenteringRing|semroc|cr9175p', descIncludes: '4 fin locks',
    to: 'CR-9-175-4F',
    why: 'A plain ring and one slotted for through-the-wall fin tabs. The exact analogue is '
      + 'already filed that way: five fin-lock rows (CR-115-175-4F, CR-9-225-4F and friends) '
      + 'all drop the trailing P though all five are plywood.',
  },
  {
    action: 'rename', key: 'NoseCone|madcow|fwnc60mc', match: { shape: 'HAACK' },
    to: 'FWNC60M-VK',
    why: 'A 5:1 conical and a 5.5:1 von Karman under one number. No FWNC60M-VK exists in '
      + 'the file, and its 33.0 in length sits exactly where the -VK family expects.',
  },
  {
    action: 'rename', key: 'NoseCone|semroc|bc926', match: { shape: 'OGIVE' },
    to: 'BC-928',
    why: 'A 2.6 in rounded ogive and a 2.8 in ogive share BC-926 — the number encodes the '
      + 'length, so the 2.8 in one is BC-928. 0 rows use it here or in desktop 24.12\'s '
      + 'semroc-legacy.orc.',
  },
  {
    action: 'rename', key: 'NoseCone|semroc|bnc55x', match: { shape: 'OGIVE' },
    to: 'BNC-55Y',
    why: 'The row\'s OWN description reads "BNC-55Y, 5.9\\", ogive, BNC-50Y upscale". '
      + '0 rows use BNC-55Y, and it already sorts between BNC-55X and BNC-55Z.',
  },
  {
    action: 'rename', key: 'NoseCone|semroc|bnc58g4', match: { length: 0.21336 },
    to: 'BNC-58G5',
    why: 'The row\'s OWN description reads "PN BNC-58G5, 5:1 ogive". 0 rows use it.',
  },
  {
    action: 'rename', key: 'Transition|semroc|br5t20r', match: { length: 0.0254 },
    to: 'BR-5-T20A [R]',
    why: 'Two reversed transitions at 0.750 and 1.000 in. The 1.000 in one is the exact '
      + 'reverse of BR-5-T20A (same diameters, same shoulders) with its "A" lost. Nothing '
      + 'exists at the target name and no mass is at stake.',
  },

  // ---- the manufacturer pasted into the part number ----------------------
  // AUDIT THE CLASS: a sweep for partNo === manufacturer finds exactly four
  // rows, and all four are fixed here rather than only the pair that happened
  // to collide. presetPatch builds a component's name as manufacturer + partNo,
  // so these were applying as "AeroTech Aerotech".
  {
    action: 'rename', key: 'TubeCoupler|aerotech|aerotech', descIncludes: 'CP-1.9',
    to: 'CP-1.9',
    why: 'partNo was the manufacturer name; the description already carries the real one.',
  },
  {
    action: 'rename', key: 'TubeCoupler|aerotech|aerotech', descIncludes: 'CP-2.6',
    to: 'CP-2.6',
    why: 'partNo was the manufacturer name; the description already carries the real one.',
  },
  {
    action: 'rename', key: 'BodyTube|estes|estes', descIncludes: 'BT-3',
    to: 'BT-3',
    why: 'Same class as the AeroTech couplers, found by sweeping for partNo === manufacturer.',
  },
  // --- Fruity Chutes: the drag coefficient the app already applies, on the ten
  // rows that arrived without one (owner report, 2026-09-01b).
  //
  // He asked exactly the right question: "does our parts database properly show
  // that the Fruity Chutes IFC-084-S has a Cd of 2.2? - if so, why isn't that
  // updated when I choose that part?" It does, and it IS — `presetPatch` has
  // applied `dragCoefficient` since v0.033, and picking IFC-084-S really does
  // set 2.2. But Fruity Chutes appears TWICE in this catalogue: 42 rows from the
  // OpenRocket database (`desktop-24.12`) that carry a Cd, and 10 from the
  // RockSim source that do not. Pick one of those ten — and they have the
  // friendlier names, "84\" Nylon Toroidal" — and the chute silently falls back
  // to the kernel default of 0.8.
  //
  // Every value below is taken from THIS database's own desktop rows for the
  // same physical product, not from anywhere else: all Iris Ultra (toroidal)
  // rows read 2.2 and all Classic Elliptical rows read 1.55, at every diameter
  // and in every variant, so the mapping is unambiguous.
  //
  // NOT done here: 29161 and 29162, the 15 and 18 inch "Drogue Chute" rows.
  // There is no desktop row of that name to take a number from, and a drogue's
  // Cd is not something to invent. They are [ERIC] in open-items.
  ...[['29181', '48'], ['29182', '60'], ['29183', '72'], ['29184', '84'], ['29185', '96']]
    .map(([pn, inches]) => ({
      action: 'set', key: `Parachute|fruitychutes|${pn}`, field: 'dragCoefficient', value: 2.2,
      why: `The ${inches}" Nylon Toroidal is the Iris Ultra, which every IFC-* row in this same `
        + 'database rates at Cd 2.2. Without it the row applies the kernel default 0.8 and the '
        + 'descent rate comes out 1.66x too fast: measured, 22.72 ft/s against 13.70 on an 84 '
        + "inch canopy at 8.57 kg, which is Fruity Chutes' own published figure.",
    })),
  ...[['29163', '24'], ['29165', '36'], ['29167', '48']].map(([pn, inches]) => ({
    action: 'set', key: `Parachute|fruitychutes|${pn}`, field: 'dragCoefficient', value: 1.55,
    why: `The ${inches}" Nylon Elliptical is the Classic Elliptical, which every CFC-* row in `
      + 'this same database rates at Cd 1.55.',
  })),
  {
    action: 'rename', key: 'NoseCone|quest|quest', descIncludes: 'PNC35N',
    to: 'PNC35N',
    why: 'Same class as the AeroTech couplers, found by sweeping for partNo === manufacturer.',
  },
];

const matches = (p, c) => {
  if (c.descIncludes && !String(p.description ?? '').includes(c.descIncludes)) return false;
  for (const [k, v] of Object.entries(c.match ?? {})) {
    if (JSON.stringify(p[k]) !== JSON.stringify(v)) return false;
  }
  return true;
};

export function planCurations(rows) {
  const plan = [];
  for (const c of CURATIONS) {
    const group = rows
      .map((p, i) => ({ i, p }))
      .filter(({ p }) => presetKey(p) === c.key);
    const hits = group.filter(({ p }) => matches(p, c));

    if (c.action === 'set') {
      // Already applied when every matching row already carries the value, which
      // is what makes a second run a no-op. A row that still needs it is
      // "pending"; exactly one of those is required, same as everywhere else.
      const pending = hits.filter(({ p }) => JSON.stringify(p[c.field]) !== JSON.stringify(c.value));
      if (hits.length > 0 && pending.length === 0) { plan.push({ c, status: 'already' }); continue; }
      if (pending.length !== 1) {
        plan.push({ c, status: 'error', detail: `${pending.length} rows pending (expected 1)` });
        continue;
      }
      plan.push({ c, status: 'todo', index: pending[0].i });
      continue;
    }

    if (c.action === 'rename') {
      // Already applied? The target name is present and the source group no
      // longer holds a matching row under the old key.
      const done = rows.some((p) => String(p.partNo) === c.to
        && presetKey({ ...p, partNo: c.to }) === presetKey(p) && matches(p, c));
      if (done && hits.length === 0) { plan.push({ c, status: 'already' }); continue; }
    } else if (hits.length === 0 && group.length > 0) {
      plan.push({ c, status: 'already' });
      continue;
    }

    if (hits.length !== 1) {
      plan.push({ c, status: 'error', detail: `${hits.length} rows matched (expected 1)` });
      continue;
    }
    plan.push({ c, status: 'todo', index: hits[0].i });
  }
  return plan;
}

function main() {
  const raw = readFileSync(DB_PATH, 'utf8');
  const db = JSON.parse(raw);
  if (JSON.stringify(JSON.parse(raw), null, 1) + '\n' !== raw) {
    console.error('presets.json no longer round-trips at indent 1 — fix the serializer guard first.');
    process.exit(1);
  }

  const plan = planCurations(db.presets);
  const errors = plan.filter((x) => x.status === 'error');
  for (const e of errors) {
    console.error(`CANNOT ADDRESS "${e.c.key}"${e.c.to ? ` -> ${e.c.to}` : ''}: ${e.detail}`);
  }
  if (errors.length) {
    console.error('\nThe data moved under a curation. Re-check before shipping — do NOT delete '
      + 'the entry to make this pass.');
    process.exit(1);
  }

  const todo = plan.filter((x) => x.status === 'todo');
  for (const t of todo) {
    if (t.c.action === 'drop') console.log(`  drop    ${t.c.key}`);
    else if (t.c.action === 'rename') console.log(`  rename  ${t.c.key} -> ${t.c.to}`);
    else console.log(`  set     ${t.c.key}  ${t.c.field} = ${t.c.value}`);
  }
  console.log(`\n${todo.filter((t) => t.c.action === 'drop').length} drop(s), `
    + `${todo.filter((t) => t.c.action === 'rename').length} rename(s), `
    + `${todo.filter((t) => t.c.action === 'set').length} set(s); `
    + `${plan.length - todo.length} already in place.`);

  if (!process.argv.includes('--write')) { console.log('\n(report only — pass --write to apply)'); return; }
  if (!todo.length) { console.log('\ndatabase unchanged.'); return; }

  // In-place edits first, then drops, so no index shifts under us.
  for (const t of todo.filter((x) => x.c.action === 'rename')) {
    db.presets[t.index].partNo = t.c.to;
  }
  for (const t of todo.filter((x) => x.c.action === 'set')) {
    db.presets[t.index][t.c.field] = t.c.value;
  }
  const doomed = new Set(todo.filter((x) => x.c.action === 'drop').map((x) => x.index));
  db.presets = db.presets.filter((_, i) => !doomed.has(i));
  db.presets.sort((a, b) => a.kind.localeCompare(b.kind)
    || a.manufacturer.localeCompare(b.manufacturer)
    || String(a.partNo).localeCompare(String(b.partNo)));
  db.count = db.presets.length;
  writeFileSync(DB_PATH, JSON.stringify(db, null, 1) + '\n');
  console.log(`\ndatabase updated — ${db.presets.length} rows remain.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
