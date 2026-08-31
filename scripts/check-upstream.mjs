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
 *  3. ThrustCurve — the motor database source. `packages/app/src/data/
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

const fileCache = new Map();
async function orc(file) {
  if (!fileCache.has(file)) fileCache.set(file, await text(`${RAW}/${file}`));
  return fileCache.get(file);
}

async function checkCorrections() {
  say('1. openrocket-database rows this app corrects');
  for (const c of CORRECTIONS) {
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

async function checkThrustCurve() {
  say('');
  say('4. ThrustCurve API (bundled motors.json is a snapshot; thrust curves are fetched live in-app)');
  const snapshot = JSON.parse(readFileSync(join(here, '..', 'packages', 'app', 'src', 'data', 'motors.json'), 'utf8'));
  const bundled = Array.isArray(snapshot) ? snapshot.length : (snapshot.motors?.length ?? 0);
  const meta = await json(`${TC_API}/metadata.json`);
  const mfrs = meta.manufacturers?.length ?? 0;
  checked++;
  if (!mfrs) flag('metadata.json returned no manufacturers — the API shape may have changed. The in-app motor browser reads this shape.');
  else say(`  ok   metadata.json: ${mfrs} manufacturers; bundled snapshot holds ${bundled} motors`);
}

try {
  say('Upstream vigilance check — READ ONLY, nothing here is written to the repo.');
  say('');
  await checkCorrections();
  await checkWatch();
  await checkHead();
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
