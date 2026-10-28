/**
 * Regenerates src/data/motorCurves.json — every simulator file thrustcurve.org
 * holds for every motor in src/data/motors.json, so the app can FLY any
 * catalogued motor with no network at all.
 *
 * Usage: node packages/app/scripts/fetch-motor-curves.mjs [--allow-partial]
 *        node packages/app/scripts/fetch-motor-curves.mjs --add-digests
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
 * from the bundle as from the wire — and the file's desktop OpenRocket digest
 * (`digests`, motor-digest.mjs), which names the file a desktop .ork was
 * flown with: thrustcurve.ts flies that file when a design's <digest> names
 * it (2026-10-11). The digest reads mN and an .rse's own masses, so it cannot
 * be computed from the rounded samples afterwards; it is computed here, from
 * the raw text, or not at all. `--add-digests` adds it to the bundle on disk
 * without refreshing anything else (see addDigests).
 *
 * A FAILED BATCH WRITES NOTHING (audit 2026-09-22). A batch that failed to
 * download used to be reported AFTER motorCurves.json had been overwritten
 * with the rest, so a run one batch short left a bundle fifty motors short on
 * disk: the refresh workflow's non-zero exit kept it out of a PR, and nothing
 * kept it from being committed by hand. The decision is now made before the
 * write — any failed batch exits 1 with the file as it was, unless
 * `--allow-partial` says a short bundle is wanted. The work is exported and
 * the CLI runs only when this file is the entry point, so
 * fetch-motor-curves.test.mjs drives it against a stubbed API.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digestMotorFile, motorHeaderMasses } from './motor-digest.mjs';
import { sampleListProblem } from './motor-samples.mjs';
import { thrustcurveFetch } from './thrustcurve-client.mjs';

const API = 'https://www.thrustcurve.org/api/v1';
const HERE = dirname(fileURLToPath(import.meta.url));
const DB = join(HERE, '..', 'src', 'data', 'motors.json');
const OUT = join(HERE, '..', 'src', 'data', 'motorCurves.json');

/** thrustcurve.org accepts a list of motorIds per download; keep batches polite. */
export const BATCH = 50;
const PAUSE_MS = 250;

/**
 * The two masses in a RASP or RockSim header, parsed by the same helper as
 * thrustcurve.ts. The file text identifies the format; a pair is kept
 * only if both are finite and positive and the propellant does not outweigh
 * the loaded motor. A bundled curve must yield exactly the masses a live
 * download of the same file would. RockSim states grams and a RASP header
 * kilograms; both come out in grams.
 */
export function headerMasses(file) {
  if (!file.data) return null;
  let text;
  try { text = Buffer.from(file.data, 'base64').toString('utf8'); } catch { return null; }
  return motorHeaderMasses(text);
}

/**
 * One downloaded simulator file as the bundle stores it, or null when its
 * samples are unusable: [t, F] pairs rounded to 4 decimals of a second and 2
 * of a newton, plus the header masses when the file states them.
 */
export function compactFile(f) {
  const s = f?.samples;
  if (!Array.isArray(s) || !s.every(p => p && Number.isFinite(p.time) && Number.isFinite(p.thrust))) return null;
  const samples = s.map((p) => [Number(p.time.toFixed(4)), Number(p.thrust.toFixed(2))]);
  if (sampleListProblem(samples.map(([time, thrust]) => ({ time, thrust }))) !== null) return null;
  const compact = {
    simfileId: f.simfileId,
    source: f.source,
    format: f.format,
    samples,
  };
  const masses = headerMasses(f);
  if (masses) compact.masses = masses;
  const digests = rawDigests(f);
  if (digests.length) compact.digests = digests;
  return compact;
}

/**
 * Desktop OpenRocket's digest(s) of a downloaded file's raw text — what a
 * desktop .ork names the file by — or [] when the file carries no text or
 * desktop's loader would refuse it. Read as ISO-8859-1, desktop's charset
 * for both formats.
 */
export function rawDigests(file) {
  if (!file.data) return [];
  let text;
  try { text = Buffer.from(file.data, 'base64').toString('latin1'); } catch { return []; }
  return digestMotorFile(text, file.format);
}

/**
 * Adds each file's `digests` to a bundle built before the field existed,
 * changing nothing else: a file gets them only when the file downloaded now,
 * compacted, is exactly the one the bundle holds — a file revised upstream
 * since the bundle was built would otherwise name a curve it does not hold.
 * `results` is download.json's answer (data "both") for the bundle's motors.
 * Returns the counts; the bundle is changed in place.
 */
export function addDigests(bundle, results) {
  const fresh = new Map();
  for (const f of results) if (f?.simfileId) fresh.set(f.simfileId, f);
  let added = 0, changed = 0, missing = 0;
  for (const files of Object.values(bundle.curves)) {
    for (const file of files) {
      const { digests: _old, ...held } = file;
      const now = fresh.get(file.simfileId);
      const compact = now ? compactFile(now) : null;
      if (!compact) { missing++; delete file.digests; continue; }
      const { digests, ...rest } = compact;
      if (JSON.stringify(rest) !== JSON.stringify(held)) { changed++; delete file.digests; continue; }
      if (digests) { file.digests = digests; added++; } else delete file.digests;
    }
  }
  return { added, changed, missing };
}

/**
 * Every usable file for every motor, batch by batch. A batch that fails is
 * recorded in `failed`, one line per motor, and the run goes on — the caller
 * decides what a failure costs. HTTP 429 stops the run, recording the remaining
 * motors as failed too. `fetchImpl` and `sleep` are injectable so the
 * test can stand in for the network and the courtesy pause.
 */
export function downloadResults(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.results)
    || !body.results.every(f => f && typeof f === 'object' && !Array.isArray(f)
      && typeof f.motorId === 'string' && f.motorId.length > 0)) {
    throw new Error('download.json: invalid response shape');
  }
  return body.results;
}

/** Raw census downloads stop on failure and always pause before returning. */
export async function downloadRawFiles(ids, {
  fetchImpl = thrustcurveFetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  log = s => process.stdout.write(s),
} = {}) {
  const raw = Object.create(null);
  for (let i = 0; i < ids.length; i += BATCH) {
    try {
      const res = await fetchImpl(`${API}/download.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'mmrocket-sim-upstream-check' },
        body: JSON.stringify({ motorIds: ids.slice(i, i + BATCH), data: 'file' }),
      });
      if (!res.ok) throw new Error(`thrustcurve.org download failed: HTTP ${res.status}`);
      for (const f of downloadResults(await res.json())) {
        if (f.simfileId && f.data) raw[f.simfileId] = { motorId: f.motorId, format: f.format, source: f.source, data: f.data };
      }
      log(`  raw files: ${Math.min(i + BATCH, ids.length)} / ${ids.length} motors\r`);
    } finally {
      await sleep(250);
    }
  }
  return raw;
}

/**
 * `previous` is the bundle on disk before this run, or null. A 200 batch with
 * no usable file for any motor it asked for counts as failed when one of those
 * motors had curves in `previous` (an empty answer, not a withdrawn motor). A
 * batch that drops only SOME motors still passes: one usable file clears it.
 */
export async function fetchCurves(motors, {
  fetchImpl = thrustcurveFetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (s) => process.stdout.write(s),
  previous = null,
} = {}) {
  const curves = Object.create(null);
  let files = 0, points = 0;
  const failed = [];
  for (let i = 0; i < motors.length; i += BATCH) {
    const batch = motors.slice(i, i + BATCH);
    let body;
    let rateLimited = false;
    try {
      const res = await fetchImpl(`${API}/download.json`, {
        method: 'POST',
        // Name ourselves, same string as fetch-motor-db.mjs and
        // scripts/check-upstream.mjs. These are 24 POSTs to a volunteer-run
        // service, run weekly from CI since 2026-09-07.
        headers: { 'content-type': 'application/json', 'user-agent': 'mmrocket-sim-upstream-check' },
        body: JSON.stringify({ motorIds: batch.map((m) => m.motorId), data: 'both' }),
      });
      rateLimited = res.status === 429;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = await res.json();
      downloadResults(body);
    } catch (err) {
      const skipped = rateLimited ? motors.slice(i) : batch;
      failed.push(...skipped.map((m) => `${m.manufacturerAbbrev} ${m.designation}: ${err.message}`));
      if (rateLimited) break;
      continue;
    } finally {
      await sleep(PAUSE_MS);
    }
    const asked = new Set(batch.map((m) => m.motorId));
    if (previous && batch.some((m) => Object.hasOwn(previous.curves, m.motorId) && previous.curves[m.motorId].length)
      && !body.results.some((f) => asked.has(f.motorId) && compactFile(f))) {
      failed.push(...batch.map((m) => `${m.manufacturerAbbrev} ${m.designation}: download.json returned no usable file `
        + 'for a batch whose motors had curves'));
      continue;
    }
    for (const f of body.results ?? []) {
      const compact = compactFile(f);
      if (!compact) continue;
      (curves[f.motorId] ??= []).push(compact);
      files++;
      points += f.samples.length;
    }
    log(`  ${Math.min(i + BATCH, motors.length)} / ${motors.length}\r`);
  }
  log('\n');
  return { curves, files, points, failed };
}

/** motorCurves.json itself; `today` is an ISO date. */
export function curvesDocument({ curves, files, failed = [] }, catalogueGenerated, today) {
  return {
    generated: today,
    source: 'thrustcurve.org API v1 download.json (data: both), every simulator file per motor',
    catalogueGenerated,
    ...(failed.length === 0 ? { complete: true } : {}),
    motors: Object.keys(curves).length,
    files,
    curves,
  };
}

/**
 * Fetch every curve, decide, and only then write. Resolves to the process
 * exit code: 1, with nothing written, if any batch failed and `allowPartial`
 * is not set.
 */
export async function main({
  dbPath = DB, outPath = OUT, fetchImpl, sleep, log,
  allowPartial = process.argv.includes('--allow-partial'),
} = {}) {
  const db = JSON.parse(readFileSync(dbPath, 'utf8'));
  const motors = db.motors ?? [];
  if (!motors.length) throw new Error(`${dbPath} has no motors — run fetch-motor-db.mjs first`);

  // Read before anything can overwrite it: the empty-batch rule compares with it.
  let previous = null;
  try {
    const held = JSON.parse(readFileSync(outPath, 'utf8'));
    if (held?.curves && typeof held.curves === 'object' && !Array.isArray(held.curves)) previous = held;
    else throw new Error('no curves object');
  } catch (error) {
    (log ?? ((s) => process.stdout.write(s)))(`  no readable previous bundle at ${outPath} (${error.message}); `
      + 'an empty download batch cannot be detected this run\n');
  }
  const got = await fetchCurves(motors, { fetchImpl, sleep, log, previous });
  const { curves, files, points, failed } = got;
  if (failed.length) {
    console.log(`  ${failed.length} motors FAILED to fetch:`);
    failed.slice(0, 10).forEach((f) => console.log(`     ${f}`));
    if (failed.length > 10) console.log(`     ...and ${failed.length - 10} more`);
    if (!allowPartial) {
      console.error(`Nothing was written; ${outPath} is as it was. Re-run, or pass --allow-partial `
        + 'to write a bundle without them.');
      return 1;
    }
    console.warn(`--allow-partial: writing a bundle WITHOUT those ${failed.length} motors.`);
  }

  const doc = curvesDocument(got, db.generated, new Date().toISOString().slice(0, 10));
  const json = JSON.stringify(doc);
  writeFileSync(outPath, json);

  const noCurve = motors.filter((m) => !curves[m.motorId]);
  console.log(`Wrote ${outPath}`);
  console.log(`  ${doc.motors} of ${motors.length} motors have at least one usable curve; ${files} files; ${points} sample points`);
  console.log(`  ${(json.length / 1024).toFixed(0)} KB on disk (${(json.length / doc.motors).toFixed(0)} bytes per motor)`);
  if (noCurve.length) {
    console.log(`  ${noCurve.length} motors have NO simulator file on thrustcurve.org and will still need one imported to fly:`);
    for (const m of noCurve.slice(0, 15)) console.log(`     ${m.manufacturerAbbrev} ${m.designation} (${m.availability})`);
    if (noCurve.length > 15) console.log(`     ...and ${noCurve.length - 15} more`);
  }
  return 0;
}

/**
 * `--add-digests`: download every bundled motor's files again and run
 * addDigests over the bundle on disk. Exit 1, writing nothing, if a batch
 * fails (the same rule as a refresh).
 */
export async function addDigestsMain({ outPath = OUT, fetchImpl = thrustcurveFetch, sleep, log } = {}) {
  const bundle = JSON.parse(readFileSync(outPath, 'utf8'));
  const motors = Object.keys(bundle.curves).map((motorId) => ({ motorId, manufacturerAbbrev: '', designation: motorId }));
  const results = [];
  const record = (f) => results.push(f);
  const got = await fetchCurves(motors, {
    fetchImpl: async (url, opts) => {
      const res = await fetchImpl(url, opts);
      if (!res.ok) return res;
      const body = await res.json();
      for (const f of downloadResults(body)) record(f);
      return { ok: true, status: res.status, json: async () => body };
    },
    // Every motor here has curves in this bundle, so an empty batch is a failure.
    sleep, log, previous: bundle,
  });
  if (got.failed.length) {
    console.error(`${got.failed.length} motors failed to download; nothing was written.`);
    return 1;
  }
  const counts = addDigests(bundle, results);
  writeFileSync(outPath, JSON.stringify(bundle));
  console.log(`Wrote ${outPath}: digests on ${counts.added} files; ${counts.changed} revised upstream since the `
    + `bundle was built and ${counts.missing} no longer downloadable, left without one.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = process.argv.includes('--add-digests') ? await addDigestsMain() : await main();
}
