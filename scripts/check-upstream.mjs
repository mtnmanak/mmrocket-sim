#!/usr/bin/env node
/**
 * Vigilance check on the third-party data this app ships.
 *
 * Eric, 2026-08-31, on the openrocket-database centering-ring issue he had
 * just reported upstream: *"i have no way of knowing whether they will fix the
 * issue on their end, so maintain vigilance on anything we rely on from third
 * party sources."*
 *
 * This is that check. It is READ-ONLY and network-bound: it fetches nothing
 * into the repo and writes no file. Run it before a release, or any time the
 * preset/motor pipelines are about to be re-run:
 *
 *     node scripts/check-upstream.mjs
 *
 * WHAT IT WATCHES, and why each one can hurt us
 *
 *  1. openrocket-database `orc/*.ORC` — the component-preset source. We ship
 *     four hand-keyed corrections to it (packages/app/scripts/apply-preset-
 *     corrections.mjs). If upstream FIXES a row, our correction becomes a
 *     no-op that should be retired; if upstream MOVES a row to a third value,
 *     the correction's known-bad guard will abort the next regeneration, and
 *     it is much better to learn that here than mid-pipeline.
 *     The correction table is IMPORTED, not restated — one list, not two.
 *  2. openrocket-database HEAD — the commit our snapshot is understood
 *     against. A new commit is not a problem; not knowing about it is.
 *  3. OpenRocket 24.12 `Databases.java` — the built-in material table, which
 *     packages/app/src/data/materials.ts transcribes verbatim so .ork files
 *     exchange materials by name with the desktop. Two of its five elastic
 *     shock-cord line densities are ~10x too light UPSTREAM (19 mm flat at
 *     0.0012 kg/m is lighter than the 2 mm round above it, which is not
 *     physically possible), and this repo deliberately does NOT diverge —
 *     diverging would make our files disagree with desktop's on the same
 *     material name. So we watch: if upstream ever corrects them, materials.ts
 *     must be re-transcribed in the same sitting. Skipped with a note when the
 *     reference checkout is not on this machine.
 *  4. ThrustCurve — the motor database source. `packages/app/src/data/
 *     motors.json` is a committed snapshot and thrust curves are fetched
 *     live in-app, so an API shape change breaks the running app, not just
 *     the build.
 *
 * EXIT CODES
 *   0  everything as expected (upstream still broken where we say it is)
 *   1  something MOVED — read the report; a correction may be retirable, or
 *      a row may have drifted to a value neither we nor the table know
 *   2  the check could not run (network/parse). Not a data verdict.
 *
 * A note on scope, so nobody widens this by accident: the point is to DETECT,
 * never to auto-apply. Nothing here edits presets.json — that is
 * apply-preset-corrections.mjs's job, and it runs only inside the regeneration
 * pipeline in its documented order.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORRECTIONS, UPSTREAM_WATCH } from '../packages/app/scripts/apply-preset-corrections.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const RAW = 'https://raw.githubusercontent.com/openrocket/openrocket-database/master/orc';
const GH_API = 'https://api.github.com/repos/openrocket/openrocket-database';
const TC_API = 'https://www.thrustcurve.org/api/v1';
const UA = { 'User-Agent': 'mmrocket-sim-upstream-check' };

let moved = 0;
let checked = 0;
const notes = [];

const say = (s = '') => console.log(s);
const flag = (s) => { moved++; console.log('  ** ' + s); };

async function text(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}
async function json(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/**
 * Every `<element>` block in an .orc, indexed by its PartNumber. Deliberately
 * a dumb scan and not an XML parse: this file is watched, not consumed, and a
 * parser would add a dependency to a script whose whole job is to be runnable.
 */
function rowsByPart(xml, element) {
  const out = new Map();
  const re = new RegExp(`<${element}>([\\s\\S]*?)</${element}>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const field = (tag) => (block.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`)) || [])[1];
    const pn = field('PartNumber');
    if (pn === undefined) continue;
    out.set(pn, field);
  }
  return out;
}

/**
 * The <Density> declared for a named <Material> in an .orc file, as the raw
 * string upstream wrote, or null when no such material is declared. Parsed by
 * hand: the names carry quotes, commas and inch marks, and building a regex
 * from them is one more thing to get wrong.
 */
function materialDensityIn(xml, name) {
  const needle = `<Name>${name}</Name>`;
  let from = 0;
  for (;;) {
    const at = xml.indexOf(needle, from);
    if (at < 0) return null;
    // The <Material ...> block this Name belongs to must open before it and
    // close after it; a part row also has a <Name>, so check the container.
    const open = xml.lastIndexOf('<Material', at);
    const close = xml.indexOf('</Material>', at);
    if (open >= 0 && close >= 0 && xml.lastIndexOf('</Material>', at) < open) {
      const block = xml.slice(open, close);
      const d = block.indexOf('<Density>');
      if (d >= 0) return block.slice(d + 9, block.indexOf('</Density>', d)).trim();
      return null;
    }
    from = at + needle.length;
  }
}

const fileCache = new Map();
async function orc(file) {
  if (!fileCache.has(file)) fileCache.set(file, await text(`${RAW}/${file}`));
  return fileCache.get(file);
}

async function checkCorrections() {
  say('1. openrocket-database rows this app corrects');
  for (const c of CORRECTIONS) {
    // A material-density correction watches a <Material> block, not a part row.
    if (c.upstreamMaterial) {
      const um = c.upstreamMaterial;
      checked++;
      const cur = materialDensityIn(await orc(um.file), um.name);
      if (cur === null) { flag(`${um.file}: material "${um.name}" is GONE from upstream. Our correction keys off it — re-check before the next regeneration.`); continue; }
      if (cur === um.bad) say(`  ok   ${um.file} material "${um.name}" density = ${cur} (still the known-bad value; our correction is still needed)`);
      else { flag(`${um.file} material "${um.name}" density = ${cur}, was ${um.bad} — upstream changed it. Re-examine ${c.key}: the correction may be retirable.`); notes.push(`upstream moved material ${um.name} in ${um.file}`); }
      continue;
    }
    if (c.unwatched) {
      say(`  --   ${c.key}: not watched — ${c.unwatched}`);
      continue;
    }
    const u = c.upstream;
    if (!u) { flag(`${c.key}: correction carries no \`upstream\` descriptor — it cannot be watched. Add one.`); continue; }
    const rows = rowsByPart(await orc(u.file), u.element);
    const row = rows.get(u.partNo);
    if (!row) { flag(`${u.file} ${u.partNo}: row is GONE from upstream. Our correction keys off it — re-check before the next regeneration.`); continue; }
    for (const [tag, { bad, good }] of Object.entries(u.fields)) {
      checked++;
      const cur = row(tag);
      if (cur === bad) {
        say(`  ok   ${u.file} ${u.partNo} ${tag} = ${cur} (still the known-bad value; our correction is still needed)`);
      } else if (cur === good) {
        flag(`${u.file} ${u.partNo} ${tag} = ${cur} — UPSTREAM HAS FIXED THIS. Our correction is now a no-op and should be RETIRED from apply-preset-corrections.mjs (it will still pass: the contract accepts the corrected value).`);
        notes.push(`retire correction ${c.key} ${tag}`);
      } else {
        flag(`${u.file} ${u.partNo} ${tag} = ${cur} — expected the known-bad ${bad} or the corrected ${good}. A regeneration WILL abort here.`);
        notes.push(`investigate ${c.key} ${tag}`);
      }
    }
  }
}

async function checkWatch() {
  say('');
  say('2. openrocket-database rows we watch but do NOT correct');
  for (const w of UPSTREAM_WATCH) {
    const rows = rowsByPart(await orc(w.file), w.element);
    for (const pn of w.partNos) {
      checked++;
      const row = rows.get(pn);
      if (!row) { flag(`${w.file} ${pn}: row is GONE from upstream.`); continue; }
      const cur = row(w.field);
      if (cur === w.expect) say(`  ok   ${w.file} ${pn} ${w.field} = ${cur} (unchanged; ${w.why})`);
      else { flag(`${w.file} ${pn} ${w.field} = ${cur}, was ${w.expect} — upstream moved a row we watch. Re-read the corrected rows in the same file.`); notes.push(`upstream moved ${w.file} ${pn}`); }
    }
  }
}

async function checkHead() {
  say('');
  say('3. openrocket-database HEAD');
  const [c] = await json(`${GH_API}/commits?per_page=1`);
  say(`  head ${c.sha.slice(0, 10)}  ${c.commit.author.date}  ${c.commit.message.split('\n')[0]}`);
  const open = await json(`${GH_API}/issues?state=open&per_page=100`);
  const issues = open.filter((i) => !i.pull_request);
  say(`  ${issues.length} open issue(s), ${open.length - issues.length} open PR(s)`);
  for (const i of issues.slice(0, 10)) say(`       #${i.number} ${i.title}`);
}

/**
 * The five LINE elastic-cord densities in OpenRocket 24.12's Databases.java,
 * as materials.ts transcribes them. Two are wrong upstream and we keep them
 * wrong ON PURPOSE — see the header. This is the tripwire for the day that
 * changes.
 */
const ELASTIC_CORD = [
  ['Elastic cord (round 2 mm, 1/16 in)', 0.0018],
  ['Elastic cord (flat 6 mm, 1/4 in)', 0.0043],
  ['Elastic cord (flat 12 mm, 1/2 in)', 0.008],
  ['Elastic cord (flat 19 mm, 3/4 in)', 0.0012],  // ~10x light upstream
  ['Elastic cord (flat 25 mm, 1 in)', 0.0016],    // ~10x light upstream
];

async function checkMaterials() {
  say('');
  say('3. OpenRocket 24.12 built-in materials (local reference checkout)');
  let src;
  try {
    const { openrocketSrcRoot } = await import('./openrocket-src.mjs');
    src = openrocketSrcRoot();
    if (!src) throw new Error('unset');
  } catch {
    say('  skip  no reference checkout configured on this machine (.openrocket-src) — not a verdict');
    return;
  }
  const file = `${src}/core/src/main/java/info/openrocket/core/database/Databases.java`;
  let java;
  try {
    java = readFileSync(file, 'utf8');
  } catch {
    say(`  skip  ${file} not readable — not a verdict`);
    return;
  }
  for (const [name, expect] of ELASTIC_CORD) {
    checked++;
    // newMaterial(Material.Type.LINE, "<name>", <density>, MaterialGroup...)
    // Parsed by hand rather than by a built regex: the material names carry
    // parentheses and slashes, and escaping them into a pattern is one more
    // thing to get wrong for no gain.
    const at = java.indexOf(`"${name}"`);
    if (at < 0) {
      flag(`Databases.java: "${name}" is GONE from upstream.`);
      notes.push(`material row gone: ${name}`);
      continue;
    }
    const after = java.slice(at + name.length + 2);
    const cur = Number(after.split(",")[1]);
    if (cur === expect) say(`  ok   ${name} = ${cur} (unchanged)`);
    else {
      flag(`Databases.java "${name}" = ${cur}, was ${expect} — upstream changed a material this app transcribes verbatim. Re-transcribe packages/app/src/data/materials.ts and update its test in the same sitting.`);
      notes.push(`material density moved: ${name} ${expect} -> ${cur}`);
    }
  }
}

/**
 * How old the bundled motor catalogue may be before this check flags it. 30
 * days: thrustcurve.org adds and corrects motors continuously (26 new motors,
 * one certified-impulse correction and 17 availability changes accumulated in
 * the 63 days the catalogue sat unrefreshed before 2026-09-05), and this check
 * runs before every release, so a month is the longest a release should ship
 * a catalogue without someone having refreshed it.
 */
const CATALOGUE_MAX_AGE_DAYS = 30;

async function checkThrustCurve() {
  say('');
  say('4. ThrustCurve API and the bundled motor catalogue');
  const dataDir = join(here, '..', 'packages', 'app', 'src', 'data');
  const snapshot = JSON.parse(readFileSync(join(dataDir, 'motors.json'), 'utf8'));
  const bundled = Array.isArray(snapshot) ? snapshot.length : (snapshot.motors?.length ?? 0);

  // AGE. motors.json was generated 2026-07-04 and not touched again until the
  // 2026-09-05 audit noticed; nothing in the repo would have said so. Now
  // something does. `npm run motors:refresh` regenerates the catalogue AND the
  // curve bundle together.
  checked++;
  const generated = snapshot.generated;
  const ageDays = generated ? Math.floor((Date.now() - Date.parse(generated)) / 86_400_000) : NaN;
  if (!Number.isFinite(ageDays)) {
    flag('motors.json carries no readable `generated` date — cannot judge its age. Run `npm run motors:refresh`.');
  } else if (ageDays > CATALOGUE_MAX_AGE_DAYS) {
    flag(`motors.json was generated ${generated} — ${ageDays} days ago, over the ${CATALOGUE_MAX_AGE_DAYS}-day limit. Run \`npm run motors:refresh\` before this release.`);
    notes.push(`motor catalogue ${ageDays} days old`);
  } else {
    say(`  ok   motors.json generated ${generated} (${ageDays} days ago; limit ${CATALOGUE_MAX_AGE_DAYS}); ${bundled} motors`);
  }

  // The curve bundle is keyed by motorId FROM motors.json, so it must have been
  // built from this exact catalogue — a refresh of one without the other leaves
  // new motors with no curve and stale ids nobody can look up.
  checked++;
  let curves = null;
  try { curves = JSON.parse(readFileSync(join(dataDir, 'motorCurves.json'), 'utf8')); } catch { /* reported below */ }
  if (!curves) {
    flag('motorCurves.json is missing or unreadable — every catalogued motor would need the network to fly. Run `npm run motors:refresh`.');
  } else if (curves.catalogueGenerated !== generated) {
    flag(`motorCurves.json was built from the catalogue generated ${curves.catalogueGenerated}, but motors.json is generated ${generated} — a half refresh. Run \`npm run motors:refresh\` (both scripts) to realign them.`);
    notes.push('curve bundle out of step with the catalogue');
  } else {
    say(`  ok   motorCurves.json built from this catalogue: ${curves.motors} of ${bundled} motors carry a curve (${curves.files} files)`);
  }

  // API SHAPE, as before: the in-app browser and both refresh scripts read it.
  const meta = await json(`${TC_API}/metadata.json`);
  const mfrs = meta.manufacturers?.length ?? 0;
  checked++;
  if (!mfrs) flag('metadata.json returned no manufacturers — the API shape may have changed. The in-app motor browser reads this shape.');
  else say(`  ok   metadata.json: ${mfrs} manufacturers live`);
}

try {
  say('Upstream vigilance check — READ ONLY, nothing here is written to the repo.');
  say('');
  await checkCorrections();
  await checkWatch();
  await checkHead();
  await checkMaterials();
  await checkThrustCurve();
  say('');
  if (moved === 0) {
    say(`All ${checked} watched value(s) are where this repo expects them. Nothing to do.`);
    process.exit(0);
  }
  say(`${moved} of ${checked} watched value(s) MOVED:`);
  for (const n of notes) say(`  - ${n}`);
  say('');
  say('None of this is applied automatically. Decide, then edit apply-preset-corrections.mjs.');
  process.exit(1);
} catch (err) {
  console.error('');
  console.error(`check could not run: ${err.message}`);
  console.error('(network, or an upstream URL moved — this is NOT a verdict on the data)');
  process.exit(2);
}
