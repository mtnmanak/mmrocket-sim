/**
 * Regenerates src/data/motors.json — the bundled ThrustCurve motor summary
 * database (metadata only; thrust curves are fetched on demand in-app).
 *
 * Usage: node packages/app/scripts/fetch-motor-db.mjs
 *
 * Iterates manufacturers from the metadata endpoint and pages each one via
 * impulse-class subdivision if a query hits the request cap, so the bundle
 * is complete regardless of API result limits.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://www.thrustcurve.org/api/v1';
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'motors.json');
const CAP = 500;

/** The fields the app bundles (TcMotor shape + type; keep this list tight). */
const FIELDS = [
  'motorId', 'manufacturerAbbrev', 'designation', 'commonName', 'impulseClass',
  'diameter', 'length', 'type', 'avgThrustN', 'maxThrustN', 'totImpulseNs',
  'burnTimeS', 'totalWeightG', 'propWeightG', 'delays', 'availability',
];

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function search(params) {
  const qs = new URLSearchParams({ ...params, maxResults: String(CAP) });
  const body = await getJson(`${API}/search.json?${qs}`);
  return body.results ?? [];
}

const meta = await getJson(`${API}/metadata.json?availability=all`);
const manufacturers = (meta.manufacturers ?? []).map((m) => m.abbrev);
const classes = meta.impulseClasses ?? [];
if (manufacturers.length === 0) throw new Error('metadata returned no manufacturers');

const byId = new Map();
for (const mfr of manufacturers) {
  let results = await search({ manufacturer: mfr, availability: 'all' });
  if (results.length >= CAP) {
    // Hit the cap — subdivide by impulse class to page the full set.
    results = [];
    for (const ic of classes) {
      results.push(...await search({ manufacturer: mfr, impulseClass: ic, availability: 'all' }));
    }
  }
  for (const m of results) byId.set(m.motorId, m);
  process.stdout.write(`${mfr}: ${results.length} motors (total ${byId.size})\n`);
}

const motors = [...byId.values()]
  .map((m) => Object.fromEntries(FIELDS.map((f) => [f, m[f]])))
  .sort((a, b) => String(a.manufacturerAbbrev).localeCompare(String(b.manufacturerAbbrev))
    || String(a.designation).localeCompare(String(b.designation)));

writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString().slice(0, 10),
  source: 'thrustcurve.org API v1',
  count: motors.length,
  motors,
}));
console.log(`\nWrote ${motors.length} motors to ${OUT}`);
