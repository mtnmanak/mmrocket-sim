/**
 * Regenerates src/data/motors.json — the bundled ThrustCurve motor summary
 * database (metadata only; the curves are fetch-motor-curves.mjs's job).
 *
 * Usage: node packages/app/scripts/fetch-motor-db.mjs
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
 */
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
export async function fetchCatalogue({ fetchImpl = fetch, log = (s) => process.stdout.write(s) } = {}) {
  async function getJson(url) {
    const res = await fetchImpl(url, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  /** One search: its rows, and how many the API says match it in all. */
  async function search(params, maxResults = CAP) {
    const qs = new URLSearchParams({ ...params, maxResults: String(maxResults) });
    const body = await getJson(`${API}/search.json?${qs}`);
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
  const manufacturers = (meta.manufacturers ?? []).map((m) => m.abbrev);
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
    .map((m) => Object.fromEntries(FIELDS.map((f) => [f, m[f]])))
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
export async function main({ outPath = OUT, fetchImpl = fetch, log } = {}) {
  let motors;
  try {
    motors = await fetchCatalogue({ fetchImpl, log });
  } catch (err) {
    console.error(`${err.message}\nNothing was written; ${outPath} is as it was.`);
    return 1;
  }
  writeFileSync(outPath, JSON.stringify(catalogueDocument(motors, new Date().toISOString().slice(0, 10))));
  console.log(`\nWrote ${motors.length} motors to ${outPath}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
