/**
 * Regenerates src/data/motors.json — the bundled ThrustCurve motor summary
 * database (metadata only; the curves are fetch-motor-curves.mjs's job).
 *
 * Usage: node packages/app/scripts/fetch-motor-db.mjs [--full-out <path>]
 * The opt-in publication superset comes from the same checked API rows; the
 * bundled 18-field output is unchanged.
 *
 * Iterates manufacturers from the metadata endpoint and pages each one via
 * impulse-class subdivision if a query hits the request cap, so the bundle
 * is complete regardless of API result limits.
 *
 * COMPLETE, AND SHOWN TO BE BEFORE ANYTHING IS WRITTEN (audit 2026-09-22). The
 * cap subdivision was the only defence against a short answer, and nothing
 * compared what came back with what the API said it held: a truncated page
 * would have shipped as the whole catalogue, and the weekly refresh PR would
 * have described the missing motors as upstream withdrawals. Every search.json
 * answer carries `matches`, the size of the whole result set whatever
 * `maxResults` was (the same field `scripts/check-upstream.mjs` reads for its
 * population note). So every query kept must have returned all of its matches,
 * a subdivided manufacturer's classes must add up to its own count, and the
 * total must equal the API's own population. Any shortfall throws before the
 * write: motors.json is left as it was and the run exits non-zero, which
 * `.github/workflows/motors-refresh.yml` reads as "open no PR".
 *
 * The work is exported and the CLI runs only when this file is the entry point,
 * so fetch-motor-db.test.mjs drives it against a stubbed API and never touches
 * the network.
 *
 * THE SOURCED CORRECTIONS ARE APPLIED BEFORE ANYTHING IS WRITTEN (board Tier 1
 * row 6, 2026-10-01): motor-corrections.mjs holds thrustcurve.org rows whose
 * figures their motors cannot have, each corrected from the manufacturer's or
 * the certifying body's own published data. Writing thrustcurve.org's figures back
 * over them would undo that on every refresh. A corrected row that comes back
 * holding a THIRD figure stops the write, as a short page does, and so does a
 * corrected motor that does not come back at all.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { applyMotorCorrections } from './motor-corrections.mjs';
import { manufacturerAbbreviations } from './thrustcurve-api-shapes.mjs';

const API = 'https://www.thrustcurve.org/api/v1';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'motors.json');
export const CAP = 500;

/** The fields the app bundles (TcMotor shape + type; keep this list tight). */
export const FIELDS = [
  'motorId', 'manufacturerAbbrev', 'designation', 'commonName', 'impulseClass',
  'diameter', 'length', 'type', 'avgThrustN', 'maxThrustN', 'totImpulseNs',
  'burnTimeS', 'totalWeightG', 'propWeightG', 'delays', 'availability',
  'propInfo', 'caseInfo',
];
export const FULL_FIELDS = [...FIELDS,
  'manufacturer', 'certOrg', 'dataFiles', 'infoUrl', 'delayAdjustable', 'sparky', 'updatedOn',
];

const project = (row, fields) => Object.fromEntries(fields.map((f) => [f, row[f]]));

/**
 * thrustcurve.org is volunteer-run, so every request this project makes names
 * itself. The same string as `scripts/check-upstream.mjs`, deliberately —
 * one string to grep for, and one profile for them to recognise if they ever
 * need to ask us to slow down. It matters more since 2026-09-07, because
 * `.github/workflows/motors-refresh.yml` now runs this weekly from a datacentre
 * IP, which is exactly the shape a small service rate-limits when it is
 * anonymous.
 */
const UA = { 'user-agent': 'mmrocket-sim-upstream-check' };

/**
 * The whole catalogue, projected to FIELDS and sorted — or a throw naming the
 * query that came back short. `fetchImpl` is the network, injectable so the
 * test can stand in for thrustcurve.org.
 */
export async function fetchCatalogue({ fetchImpl = fetch, log = (s) => process.stdout.write(s), fields = FIELDS } = {}) {
  async function getJson(url) {
    const res = await fetchImpl(url, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  /** One search: its rows, and how many the API says match it in all. */
  async function search(params, maxResults = CAP) {
    const qs = new URLSearchParams({ ...params, maxResults: String(maxResults) });
    const body = await getJson(`${API}/search.json?${qs}`);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(`search ${qs}: invalid response shape`);
    if (!Array.isArray(body.results) || !body.results.every(m => m && typeof m === 'object'
      && typeof m.motorId === 'string' && m.motorId.length > 0)) throw new Error(`search ${qs}: invalid results shape`);
    const { matches } = body;
    if (!Number.isInteger(matches) || matches < 0) {
      throw new Error(`search ${qs} answered with no usable \`matches\` (${JSON.stringify(matches)}), `
        + 'so it cannot be shown to be complete');
    }
    return { results: body.results ?? [], matches, qs };
  }
  const complete = ({ results, matches, qs }) => {
    if (results.length !== matches) {
      throw new Error(`search ${qs} returned ${results.length} of its ${matches} matches — a short page`);
    }
    return results;
  };

  const meta = await getJson(`${API}/metadata.json?availability=all`);
  const manufacturers = manufacturerAbbreviations(meta);
  if (!Array.isArray(meta.impulseClasses) || !meta.impulseClasses.every(c => typeof c === 'string' && c.trim().length > 0)) {
    throw new Error('metadata: invalid impulseClasses');
  }
  const classes = meta.impulseClasses ?? [];
  if (manufacturers.length === 0) throw new Error('metadata returned no manufacturers');
  // The API's own population, asked for one row so it costs one small request.
  const { matches: population } = await search({ availability: 'all' }, 1);

  const byId = new Map();
  for (const mfr of manufacturers) {
    const whole = await search({ manufacturer: mfr, availability: 'all' });
    let results;
    if (whole.results.length >= CAP) {
      // Hit the cap — subdivide by impulse class to page the full set.
      results = [];
      for (const ic of classes) {
        results.push(...complete(await search({ manufacturer: mfr, impulseClass: ic, availability: 'all' })));
      }
      const got = new Set(results.map((m) => m.motorId)).size;
      if (got !== whole.matches) {
        throw new Error(`${mfr}: its impulse classes add up to ${got} motors, thrustcurve.org lists `
          + `${whole.matches} for it — a class metadata.json does not name`);
      }
    } else {
      results = complete(whole);
    }
    for (const m of results) byId.set(m.motorId, m);
    log(`${mfr}: ${results.length} motors (total ${byId.size})\n`);
  }
  if (byId.size !== population) {
    throw new Error(`the manufacturers add up to ${byId.size} motors, thrustcurve.org lists ${population} — `
      + 'a maker metadata.json does not name, or the catalogue moved mid-run');
  }

  return [...byId.values()]
    .map((m) => project(m, fields))
    .sort((a, b) => String(a.manufacturerAbbrev).localeCompare(String(b.manufacturerAbbrev))
      || String(a.designation).localeCompare(String(b.designation)));
}

/** motors.json itself; `today` is an ISO date. */
export function catalogueDocument(motors, today) {
  return {
    generated: today,
    source: 'thrustcurve.org API v1',
    count: motors.length,
    motors,
  };
}

/** Fetch, check, and only then write. Resolves to the process exit code. */
export async function main({ outPath = OUT, fullOutPath, fetchImpl = fetch, log } = {}) {
  if (fullOutPath && resolve(fullOutPath) === resolve(outPath)) {
    throw new Error('--full-out must differ from the bundled output path');
  }
  let motors;
  try {
    motors = await fetchCatalogue({ fetchImpl, log, fields: fullOutPath ? FULL_FIELDS : FIELDS });
  } catch (err) {
    console.error(`${err.message}\nNothing was written; ${outPath} is as it was.`);
    return 1;
  }
  const corrected = applyMotorCorrections(motors);
  if (corrected.unexpected.length) {
    console.error('A row motor-corrections.mjs corrects came back holding neither its known-bad figure nor the '
      + `corrected one:\n  ${corrected.unexpected.join('\n  ')}\nRe-read the entry's sources and update or retire `
      + `it. Nothing was written; ${outPath} is as it was.`);
    return 1;
  }
  if (corrected.missing.length) {
    // apply-preset-corrections.mjs's MISSING ROW, for the same reason: the entry
    // would go on describing a row nobody ships, and motor-corrections.test.mjs
    // fails the deploy gate on it. Decided here, before the write, like a short
    // page, rather than written and then refused by the gate a step later.
    console.error('A motor motor-corrections.mjs corrects is no longer in thrustcurve.org\'s catalogue:\n  '
      + `${corrected.missing.join('\n  ')}\nIf it was withdrawn, retire its entry from motor-corrections.mjs; if it `
      + `came back under a new motorId, move the entry to that id. Nothing was written; ${outPath} is as it was.`);
    return 1;
  }
  for (const s of corrected.applied) console.log(`corrected ${s} (motor-corrections.mjs)`);
  for (const s of corrected.already) console.log(`thrustcurve.org now gives ${s} itself: retire that entry from motor-corrections.mjs`);
  const today = new Date().toISOString().slice(0, 10);
  const appRows = corrected.motors.map((m) => project(m, FIELDS));
  writeFileSync(outPath, JSON.stringify(catalogueDocument(appRows, today)));
  if (fullOutPath) {
    mkdirSync(dirname(fullOutPath), { recursive: true });
    const { motors: fullRows, ...metadata } = catalogueDocument(corrected.motors, today);
    writeFileSync(fullOutPath, JSON.stringify({
      ...metadata, fields: FULL_FIELDS, motors: fullRows,
    }));
    console.log(`Wrote ${corrected.motors.length} full rows to ${fullOutPath}`);
  }
  console.log(`\nWrote ${corrected.motors.length} motors to ${outPath}`);
  return 0;
}

/** Keep CLI parsing injectable so a flag regression is tested without a fetch. */
export async function cli(argv = process.argv.slice(2), runMain = main) {
  const { values } = parseArgs({ args: argv, options: { 'full-out': { type: 'string' } } });
  return runMain({ fullOutPath: values['full-out'] });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await cli();
