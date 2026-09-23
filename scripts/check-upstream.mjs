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
 *  5. The nozzle database against that catalogue. `packages/app/src/data/
 *     nozzles.json` is keyed to motorIds and designations that thrustcurve.org
 *     owns, and it can only be rebuilt on the machine holding
 *     `docs/RCS Schematics` — so when upstream renames or retires a motor, the
 *     drift has to be REPORTED somewhere a person reads before a release
 *     rather than failing a test nobody on CI can clear (2026-09-08, from
 *     review; nozzle-db.test.mjs reports the same thing and explains the
 *     split). Local files only — no network in this section.
 *  6. Open-Meteo's terms (https://open-meteo.com/en/terms). The weather
 *     dialog's intro and the guide's "What leaves your browser" tell the user
 *     what Open-Meteo does with a request, and the only source allowed for
 *     that is Open-Meteo's own published text (review of 2026-09-23: the first
 *     build's copy claimed more than the terms said). The free tier the app
 *     uses rests on the same page's definition of non-commercial use — the
 *     owner's 2026-09-21 ruling that mountainmanrockets.com, a non-profit
 *     hobby site with no subscriptions or advertising, fits it. The sentences
 *     those rest on are quoted in OPEN_METEO_TERMS below; if any stops
 *     appearing, the copy (WeatherDialog.tsx WEATHER_DIALOG_COPY.intro,
 *     user-guide.md) or the ruling needs a fresh look before the release.
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
 * How old the bundled motor catalogue may be before this check flags it.
 *
 * EIGHT DAYS, because a cron now refreshes it WEEKLY and opens a PR. The
 * question this check asks is therefore no longer "has anyone refreshed it
 * this month" but "did last week's refresh actually get merged" — and at 30
 * days it could not ask that: it printed `ok` over a 13-day-old catalogue
 * whose refresh PR had been sitting open and unnoticed (the owner, 2026-09-18:
 * "the database is 13 days old. That is too long").
 *
 * Eight and not seven so that an ordinary Monday-to-Monday week, plus the
 * hours the scheduled run waits in GitHub's queue, does not flag every time.
 */
const CATALOGUE_MAX_AGE_DAYS = 8;

/**
 * Compares the shipped catalogue's size against what thrustcurve.org says it
 * holds now. A NOTE, never a failure.
 *
 * Its blind spot is stated rather than hidden: this is a population count, so
 * it nets out simultaneous additions and withdrawals, and it cannot see a
 * motor whose FIGURES were corrected without the count changing. A match here
 * is weak evidence, a mismatch is strong.
 */
export function cataloguePopulationNote(bundled, upstream) {
  if (!Number.isFinite(upstream) || upstream <= 0) return null;
  const d = upstream - bundled;
  if (d === 0) {
    return `catalogue population matches thrustcurve.org (${bundled}) — though a count cannot see a corrected figure.`;
  }
  return d > 0
    ? `thrustcurve.org now lists ${upstream} motors, ${d} more than the bundled ${bundled}. Run \`npm run motors:refresh\`, or merge the open refresh PR.`
    : `thrustcurve.org now lists ${upstream} motors, ${-d} FEWER than the bundled ${bundled} — motors have been withdrawn since this catalogue was built.`;
}

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

  // POPULATION, live. The age check above can only say when we last asked;
  // this says whether the answer would be different now. Deliberately a NOTE
  // and never a failure — it depends on a third-party endpoint being up, and a
  // release must not be blocked by someone else's outage.
  try {
    const probe = await json(`${TC_API}/search.json?availability=all&maxResults=1`);
    const msg = cataloguePopulationNote(bundled, probe?.matches);
    if (msg) say(`  note ${msg}`);
  } catch (e) {
    say(`  note could not reach thrustcurve.org to compare catalogue size (${e.message}) — the age check above still stands.`);
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

/**
 * THE NOZZLE DATABASE, WHICH ONLY ONE MACHINE CAN REBUILD.
 *
 * `packages/app/src/data/nozzles.json` is a committed artifact built from
 * `docs/RCS Schematics` — local-only, gitignored, and read by a Python
 * extractor. So it cannot be regenerated on CI, on the laptop, or by anyone
 * else, and a test that FAILED on upstream drift would have blocked the weekly
 * motor-refresh PR with no way to clear it (2026-09-08, from review). The test
 * reports that drift instead; this reports it again where a release is being
 * prepared, which is the one moment somebody can act on it.
 *
 * Local files only — this section makes no network call. What it watches:
 *   - a motorId this file names that the catalogue no longer has (retired or
 *     re-issued upstream);
 *   - a designation the catalogue has renamed under a row;
 *   - the coverage the file states about itself, recomputed from the catalogue
 *     — because that is the figure release notes quote, and v0.120's said
 *     "every 98 mm motor" while four in-production 98 mm motors had no row.
 */
function checkNozzles() {
  say('');
  say('5. The nozzle database against the bundled catalogue');
  const dataDir = join(here, '..', 'packages', 'app', 'src', 'data');
  let nozzles;
  let snapshot;
  try {
    nozzles = JSON.parse(readFileSync(join(dataDir, 'nozzles.json'), 'utf8'));
    snapshot = JSON.parse(readFileSync(join(dataDir, 'motors.json'), 'utf8'));
  } catch {
    say('  skip  nozzles.json or motors.json is missing or unreadable — not a verdict');
    return;
  }
  const byId = new Map(snapshot.motors.map((m) => [m.motorId, m]));
  const joined = nozzles.motors.filter((r) => r.motorId);
  if (nozzles.catalogueGenerated !== snapshot.generated) {
    say(`  note  nozzles.json was keyed against the ${nozzles.catalogueGenerated} catalogue; `
      + `motors.json is now ${snapshot.generated}. Drift below is expected, not a mistake.`);
  }

  checked++;
  const gone = joined.filter((r) => !byId.has(r.motorId));
  const renamed = joined.filter((r) => byId.has(r.motorId)
    && byId.get(r.motorId).designation !== r.catalogDesignation);
  if (!gone.length && !renamed.length) {
    say(`  ok   all ${joined.length} joined rows still name a motor this catalogue has, under the same name`);
  } else {
    for (const r of gone) flag(`nozzles.json ${r.designation}: motorId ${r.motorId} is GONE from the catalogue.`);
    for (const r of renamed) {
      flag(`nozzles.json ${r.designation}: the catalogue now calls ${r.motorId} `
        + `"${byId.get(r.motorId).designation}", the row says "${r.catalogDesignation}".`);
    }
    notes.push(`${gone.length + renamed.length} nozzle row(s) drifted against the catalogue — regenerate `
      + 'with `node packages/app/scripts/build-nozzle-db.mjs` on the machine holding docs/RCS Schematics');
  }

  // COVERAGE, recomputed. The file states it per MANUFACTURER and then per
  // casing diameter (two of them since 2026-09-13); anything a release note
  // says about "every N mm motor" has to come from here. `withExitDiameter` is
  // recomputed too, because a row is not a number — Loki's N3800 has a row and
  // no exit, and quoting rows as coverage would overstate it.
  checked++;
  const byRow = new Map(joined.map((r) => [r.motorId, r]));
  const stated = nozzles.coverage?.byManufacturer ?? {};
  const off = [];
  for (const maker of Object.keys(stated)) {
    const now = new Map();
    for (const m of snapshot.motors) {
      if (m.manufacturerAbbrev !== maker || m.availability === 'OOP') continue;
      const mm = String(m.diameter);
      if (!now.has(mm)) now.set(mm, { inProduction: 0, withNozzleRow: 0, withExitDiameter: 0 });
      const e = now.get(mm);
      e.inProduction++;
      const row = byRow.get(m.motorId);
      if (row) {
        e.withNozzleRow++;
        if (row.exitDiameterM !== undefined) e.withExitDiameter++;
      }
    }
    const said = stated[maker].byCasingDiameterMm ?? {};
    for (const [mm, e] of now) {
      const s = said[mm];
      if (!s || s.inProduction !== e.inProduction || s.withNozzleRow !== e.withNozzleRow
        || s.withExitDiameter !== e.withExitDiameter) off.push([maker, mm, e, s]);
    }
  }
  if (!off.length) {
    const c98 = stated.AeroTech?.byCasingDiameterMm?.['98'];
    const loki = stated.Loki?.byCasingDiameterMm ?? {};
    const lokiExits = Object.values(loki).reduce((n, e) => n + e.withExitDiameter, 0);
    const lokiPro = Object.values(loki).reduce((n, e) => n + e.inProduction, 0);
    say('  ok   stated coverage matches the catalogue'
      + (c98 ? ` (AeroTech 98 mm: ${c98.withExitDiameter} of ${c98.inProduction} in production${c98.missing?.length ? `, no row for ${c98.missing.join(' ')}` : ''}` : '')
      + (lokiPro ? `; Loki: ${lokiExits} of ${lokiPro}` : '')
      + (c98 ? ')' : ''));
  } else {
    for (const [maker, mm, e, s] of off) {
      flag(`nozzles.json coverage for ${maker} ${mm} mm says `
        + `${s ? `${s.withNozzleRow} rows / ${s.withExitDiameter} exits of ${s.inProduction}` : 'nothing'}, `
        + `the catalogue now gives ${e.withNozzleRow} / ${e.withExitDiameter} of ${e.inProduction}.`);
    }
    notes.push('nozzle coverage figures are stale — regenerate before quoting one in a release note');
  }
}

/**
 * 6. The sentences of Open-Meteo's terms the app's copy and its free-tier use
 * rest on, VERBATIM from https://open-meteo.com/en/terms as read 2026-09-23.
 * `for` says what depends on each. Matched on the page's text with its tags
 * dropped and its whitespace collapsed, so a re-wrap or new markup is not a
 * change; a reworded sentence is.
 */
const OPEN_METEO_TERMS_URL = 'https://open-meteo.com/en/terms';
const OPEN_METEO_TERMS = [
  { for: 'the free tier (owner ruling 2026-09-21: a non-profit hobby site)',
    text: 'Using our service for private or non-profit websites or apps that do not have subscriptions or advertising.' },
  { for: 'the dialog intro and the guide: "may collect IP addresses for technical reasons"',
    text: 'We may collect non-personal information, such as IP addresses, for technical reasons such as server maintenance or prevent misuse' },
  { for: 'the dialog intro and the guide: "server logs, which may contain coordinates"',
    text: 'For troubleshooting purposes, we keep webserver log files that may contain sensitive information such as geographical coordinates.' },
  { for: 'the dialog intro and the guide: "shared with no third party"',
    text: 'We do not share this data with any third party.' },
  { for: 'the dialog intro and the guide: "deleted after 90 days"',
    text: 'All log files will be deleted after a period of 90 days.' },
];

async function checkOpenMeteoTerms() {
  say('');
  say('6. Open-Meteo’s terms, as the weather copy and the free tier quote them');
  const page = (await text(OPEN_METEO_TERMS_URL))
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&#39;|&apos;|&rsquo;/g, '\'').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
  const flat = (s) => s.replace(/\s+/g, ' ');
  for (const t of OPEN_METEO_TERMS) {
    checked++;
    if (page.includes(flat(t.text))) say(`  ok   still says: “${t.text}”`);
    else {
      flag(`no longer says: “${t.text}” — re-read ${OPEN_METEO_TERMS_URL} and re-check ${t.for}`);
      notes.push(`Open-Meteo's terms moved under ${t.for}`);
    }
  }
}

try {
  say('Upstream vigilance check — READ ONLY, nothing here is written to the repo.');
  say('');
  await checkCorrections();
  await checkWatch();
  await checkHead();
  await checkMaterials();
  await checkThrustCurve();
  checkNozzles();
  await checkOpenMeteoTerms();
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
