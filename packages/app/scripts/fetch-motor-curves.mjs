/**
 * Regenerates src/data/motorCurves.json — every simulator file thrustcurve.org
 * holds for every motor in src/data/motors.json, so the app can FLY any
 * catalogued motor with no network at all.
 *
 * Usage: node packages/app/scripts/fetch-motor-curves.mjs
 *        (run AFTER fetch-motor-db.mjs — this file is keyed by that one's ids)
 *
 * WHY THIS EXISTS (2026-09-05). From the repo's first day the app shipped three
 * thrust curves written BY HAND as MVP placeholders — an A8-3, B6-4 and C6-5 —
 * and they were the only motors that flew offline. Their masses were the real
 * published figures; their curves were invented approximations, and the C6-5
 * integrated to 10.40 Ns against a certified 8.85. A matching bug then made the
 * importer prefer them over the database for two months. The owner's ruling
 * was to remove the whole "built-in motor" concept rather than patch it: there
 * is to be ONE source of motor truth, and offline is served by shipping the
 * real curves, not a parallel hand-written set.
 *
 * Measured 2026-09-05 before writing this: 23.4 sample points per motor on
 * average, ~305 bytes per curve stored as [t, F] pairs, so the ENTIRE catalogue
 * is about a third of a megabyte — smaller than motors.json itself, and gzip
 * takes it to roughly 80 KB over the wire. Cheap enough to just ship.
 *
 * WHAT IS STORED, AND WHY ALL OF IT
 *
 * Every usable simulator file per motor, not a pre-chosen one. Choosing the
 * right file is the runtime's job (thrustcurve.ts pickSampleFile), and it must
 * be the SAME choice whether the files came from this bundle or from a live
 * download — otherwise a motor would fly one curve offline and another online.
 * Storing all files and letting the runtime pick keeps one rule in one place.
 * The cost is about 1.7x the single-file size. Still under a megabyte.
 *
 * Samples are rounded to 4 decimals of a second and 2 of a newton. A RASP
 * file carries three significant figures anyway, so nothing real is lost.
 *
 * The raw .eng/.rse text is NOT stored — only the two header masses the
 * runtime reads out of it (thrustcurve.ts headerMasses), because those masses
 * win over the catalogue's when present and the runtime must behave the same
 * from the bundle as from the wire.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://www.thrustcurve.org/api/v1';
const HERE = dirname(fileURLToPath(import.meta.url));
const DB = join(HERE, '..', 'src', 'data', 'motors.json');
const OUT = join(HERE, '..', 'src', 'data', 'motorCurves.json');

/** thrustcurve.org accepts a list of motorIds per download; keep batches polite. */
const BATCH = 50;
const PAUSE_MS = 250;

const db = JSON.parse(readFileSync(DB, 'utf8'));
const motors = db.motors ?? [];
if (!motors.length) throw new Error(`${DB} has no motors — run fetch-motor-db.mjs first`);

/**
 * The two masses in a RASP or RockSim header — a MIRROR of thrustcurve.ts
 * headerMasses, and it has to stay one: RockSim attributes are tried first
 * whatever the declared format, then the RASP header line, and a pair is kept
 * only if both are finite and positive and the propellant does not outweigh
 * the loaded motor. A bundled curve must yield exactly the masses a live
 * download of the same file would.
 */
function headerMasses(file) {
  if (!file.data) return null;
  let text;
  try { text = Buffer.from(file.data, 'base64').toString('utf8'); } catch { return null; }
  const ok = (m) => Number.isFinite(m.totalWeightG) && Number.isFinite(m.propWeightG)
    && m.totalWeightG > 0 && m.propWeightG > 0 && m.propWeightG <= m.totalWeightG;
  const init = /initWt\s*=\s*"([\d.eE+-]+)"/.exec(text);
  const prop = /propWt\s*=\s*"([\d.eE+-]+)"/.exec(text);
  if (init && prop) {
    const m = { totalWeightG: Number(init[1]), propWeightG: Number(prop[1]) };
    if (ok(m)) return m;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const f = line.split(/\s+/);
    if (f.length < 7) return null;
    const m = { totalWeightG: Number(f[5]) * 1000, propWeightG: Number(f[4]) * 1000 };
    return ok(m) ? m : null;
  }
  return null;
}

const out = {};
let files = 0, motorsWith = 0, points = 0;
const failed = [];

for (let i = 0; i < motors.length; i += BATCH) {
  const batch = motors.slice(i, i + BATCH);
  let body;
  try {
    const res = await fetch(`${API}/download.json`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ motorIds: batch.map((m) => m.motorId), data: 'both' }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    failed.push(...batch.map((m) => `${m.manufacturerAbbrev} ${m.designation}: ${err.message}`));
    continue;
  }
  for (const f of body.results ?? []) {
    const s = f.samples;
    if (!Array.isArray(s) || s.length < 2) continue;
    if (!s.every((p) => Number.isFinite(p?.time) && Number.isFinite(p?.thrust))) continue;
    const compact = {
      simfileId: f.simfileId,
      source: f.source,
      format: f.format,
      samples: s.map((p) => [Number(p.time.toFixed(4)), Number(p.thrust.toFixed(2))]),
    };
    const masses = headerMasses(f);
    if (masses) compact.masses = masses;
    (out[f.motorId] ??= []).push(compact);
    files++;
    points += s.length;
  }
  process.stdout.write(`  ${Math.min(i + BATCH, motors.length)} / ${motors.length}\r`);
  await new Promise((r) => setTimeout(r, PAUSE_MS));
}
process.stdout.write('\n');

motorsWith = Object.keys(out).length;
const noCurve = motors.filter((m) => !out[m.motorId]);

const doc = {
  generated: new Date().toISOString().slice(0, 10),
  source: 'thrustcurve.org API v1 download.json (data: both), every simulator file per motor',
  catalogueGenerated: db.generated,
  motors: motorsWith,
  files,
  curves: out,
};
const json = JSON.stringify(doc);
writeFileSync(OUT, json);

console.log(`Wrote ${OUT}`);
console.log(`  ${motorsWith} of ${motors.length} motors have at least one usable curve; ${files} files; ${points} sample points`);
console.log(`  ${(json.length / 1024).toFixed(0)} KB on disk (${(json.length / motorsWith).toFixed(0)} bytes per motor)`);
if (noCurve.length) {
  console.log(`  ${noCurve.length} motors have NO simulator file on thrustcurve.org and will still need one imported to fly:`);
  for (const m of noCurve.slice(0, 15)) console.log(`     ${m.manufacturerAbbrev} ${m.designation} (${m.availability})`);
  if (noCurve.length > 15) console.log(`     ...and ${noCurve.length - 15} more`);
}
if (failed.length) {
  console.log(`  ${failed.length} motors FAILED to fetch — re-run:`);
  failed.slice(0, 10).forEach((f) => console.log(`     ${f}`));
  process.exitCode = 1;
}
