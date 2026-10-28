#!/usr/bin/env node
/* global process, console -- a Node script outside the config's Node-globals directories */
/**
 * Import-memory measurement for the API's stored-flight omission
 * (xmlParseJs.ts `omitOrkSamples`): generates deterministic stored-flight .ork
 * files from the committed reference.ork, then runs the SAME bytes through a
 * baseline source tree and this one, each request in a fresh Node process.
 *
 *   node packages/api/scripts/import-memory.mjs gen <points> [columns] [out.ork]
 *       Writes one design and prints its exact size and structure.
 *   node packages/api/scripts/import-memory.mjs measure --baseline <tree> [--changed <tree>]
 *       [--points 1000,4000,16000,40000] [--columns 52] [--reps 3] [--mode import|fly]
 *
 * A <tree> is a checkout root (for the baseline, `git worktree add <dir> <sha>`).
 * Each tree's packages/api/src/index.ts is bundled with esbuild (ESM, minified,
 * the Worker's browser/workerd conditions) and imported by a probe, so the
 * Worker's module-scope parser install is the one measured. `import` runs
 * importOrk with the API's 16 MiB inflated cap; `fly` posts the file to the
 * Worker's fetch handler (import, motors, flight and report).
 *
 * Per design and tree it reports:
 *  - the smallest --max-old-space-size (MiB, 1 MiB resolution) at which the
 *    request still succeeds, found by binary search; the boundary is rerun
 *    `reps` times and must pass every time. Old space only: young generation,
 *    code space and ArrayBuffer backing stores are outside the cap.
 *  - peak RSS (process.resourceUsage().maxRSS) of uncapped runs, and the
 *    largest heap-used figure V8 reports before any GC (--trace-gc): the
 *    import peak, not what is retained after it. RSS includes the Node binary,
 *    code and every buffer, so the three are different populations; never add
 *    them.
 * A refusal (HTTP 413, a thrown budget error) is reported as a refusal, with
 * no memory figure: there is no "before" success to compare.
 *
 * Node figures are a proxy. They are not a Cloudflare 128 MB certificate.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
/** The CLI's scratch directory, made when the CLI runs: importing this module has no side effects. */
let work;

async function bundle(entry, outfile, root) {
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', minify: true,
    conditions: ['workerd', 'worker', 'browser'], mainFields: ['browser', 'module', 'main'],
    nodePaths: [join(repo, 'node_modules'), join(root, 'node_modules')], logLevel: 'error', charset: 'ascii',
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  return outfile;
}

let generator;
async function storedFlight() {
  if (!generator) {
    const out = await bundle(join(repo, 'packages/api/src/storedFlight.testSupport.ts'), join(work, 'generator.mjs'), repo);
    // The bundle reads reference.ork relative to its source; point it back at the repository.
    writeFileSync(out, readFileSync(out, 'utf8').replace(/new URL\("\.\.\/\.\.\/app\/src\/services\/__fixtures__\/reference\.ork",import\.meta\.url\)/,
      JSON.stringify(join(repo, 'packages/app/src/services/__fixtures__/reference.ork'))));
    generator = await import(out);
  }
  return generator;
}

async function generate(points, columns) {
  const { storedFlightXml, xmlStats } = await storedFlight();
  const { zipSync, strToU8 } = await import('fflate');
  const xml = storedFlightXml({ simulations: [{ points }] }, columns);
  const zip = zipSync({ 'rocket.ork': strToU8(xml) });
  return { xml, zip, stats: { ...xmlStats(xml), zipBytes: zip.byteLength } };
}

const PROBE = `
import { readFileSync } from 'node:fs';
import worker from '@tree/packages/api/src/index.ts';
import { importOrk } from '@tree/packages/app/src/services/orkFile.ts';
const [mode, file] = process.argv.slice(2);
const bytes = new Uint8Array(readFileSync(file));
let outcome;
if (mode === 'import') {
  try {
    const out = importOrk(bytes.buffer, { maxInflatedBytes: 16 * 1024 * 1024 });
    outcome = { ok: true, status: 200, components: out.tree.components.length };
  } catch (e) { outcome = { ok: false, status: e?.name === 'XmlBudgetExceededError' || e?.name === 'InflatedFileTooLargeError' ? 413 : 400, error: String(e?.message ?? e) }; }
} else {
  const response = await worker.fetch(new Request('http://local/experimental/fly?filename=stored.ork', { method: 'POST', body: bytes }),
    undefined, { waitUntil() {} });
  const json = await response.json();
  outcome = { ok: response.status === 200, status: response.status, apogeeM: json.apogeeM, error: json.error?.message };
}
const usage = process.memoryUsage();
console.log(JSON.stringify({ ...outcome, maxRssKiB: process.resourceUsage().maxRSS,
  after: { heapUsed: usage.heapUsed, external: usage.external, arrayBuffers: usage.arrayBuffers } }));
`;

async function probeFor(root, name) {
  const entry = join(work, `${name}-probe.ts`);
  writeFileSync(entry, PROBE.replaceAll('@tree/', root.replaceAll('\\', '/') + '/'));
  return bundle(entry, join(work, `${name}-probe.mjs`), root);
}

function run(probe, mode, file, oldSpaceMiB) {
  const args = ['--trace-gc', ...(oldSpaceMiB ? [`--max-old-space-size=${oldSpaceMiB}`] : []), probe, mode, file];
  const child = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28, timeout: 600_000 });
  const line = child.stdout.split('\n').reverse().find(l => l.startsWith('{'));
  // "[pid:addr] 123 ms: Mark-Compact 45.2 (60.1) -> 30.0 (50.1) MB": heap used before each GC.
  const beforeGc = [...child.stdout.matchAll(/: (?:Scavenge|Mark-Compact|Mark-sweep|Minor Mark-Sweep)[^\d]*([\d.]+) \(/g)].map(m => Number(m[1]));
  return { ...classifyRun(child, line), peakHeapBeforeGcMB: beforeGc.length ? Math.max(...beforeGc) : null };
}

/**
 * One probe run, classified: `ok`; `oom` when V8 ran out of old space (its
 * fatal message, or the abort it ends with); `refused` when the probe answered
 * 413 or 400; `failed` for anything else (a timeout, another crash, another
 * status). Only `oom` says the cap was too small.
 */
export function classifyRun(child, line) {
  const result = line ? JSON.parse(line) : { ok: false, status: 'crashed', signal: child.signal, code: child.status };
  if (result.ok) return { ...result, kind: 'ok' };
  if (child.error?.code === 'ETIMEDOUT') return { ...result, kind: 'failed', error: 'timed out after 600 s' };
  if (/heap out of memory|Reached heap limit/.test(child.stderr ?? '') || (!line && child.signal === 'SIGABRT')) {
    return { ...result, kind: 'oom' };
  }
  if (result.status === 413 || result.status === 400) return { ...result, kind: 'refused' };
  return { ...result, kind: 'failed', error: result.error ?? `exited with ${child.signal ?? `code ${child.status}`}` };
}

/** The largest old space the bisection tries, in MiB. */
export const MAX_OLD_SPACE_MIB = 1024;

/**
 * The bisection, with the runner passed in (`run` above for the CLI; a stub for
 * its tests). Only an out-of-memory run moves it; a refusal or another failure
 * stops it with the reason, and nothing above MAX_OLD_SPACE_MIB is tried.
 */
export async function smallestOldSpace(run, probe, mode, file, reps) {
  const noCap = { mib: null, stopped: `no passing cap up to ${MAX_OLD_SPACE_MIB.toLocaleString('en-US')} MiB` };
  /** true: passed; false: out of memory; otherwise the result that stops the search. */
  const passes = (mib) => {
    const r = run(probe, mode, file, mib);
    if (r.ok) return true;
    if (r.kind === 'oom') return false;
    return { mib: null, stopped: r.kind === 'refused' ? `refused: ${r.status} ${r.error}` : `failed: ${r.error ?? r.status}` };
  };
  let low = 4, high = 512; // high must pass; low must fail.
  let top = passes(high);
  if (top === false) { low = high; high = MAX_OLD_SPACE_MIB; top = passes(high); }
  if (top === false) return noCap;
  if (top !== true) return top;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    const at = passes(mid);
    if (at === true) high = mid; else if (at === false) low = mid; else return at;
  }
  // Repeat the boundary: a flaky pass at `high` would understate the cap.
  for (let r = 0; r < reps; r++) {
    for (;;) {
      const at = passes(high);
      if (at === true) break;
      if (at !== false) return at;
      if (++high > MAX_OLD_SPACE_MIB) return noCap;
    }
  }
  return { mib: high, failedAt: high - 1 >= low ? low : null };
}

async function measure(argv) {
  const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
  const trees = { baseline: resolve(opt('baseline')), changed: resolve(opt('changed', repo)) };
  const points = opt('points', '1000,4000,16000,40000').split(',').map(Number);
  const columns = Number(opt('columns', '52'));
  const reps = Number(opt('reps', '3'));
  const mode = opt('mode', 'import');
  const probes = { baseline: await probeFor(trees.baseline, 'baseline'), changed: await probeFor(trees.changed, 'changed') };
  const git = root => spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const rows = [];
  for (const n of points) {
    const { zip, stats } = await generate(n, columns);
    const file = join(work, `stored-${n}.ork`);
    writeFileSync(file, zip);
    for (const which of ['baseline', 'changed']) {
      const uncapped = Array.from({ length: reps }, () => run(probes[which], mode, file));
      const ok = uncapped.every(r => r.ok);
      const cap = ok ? await smallestOldSpace(run, probes[which], mode, file, reps) : null;
      rows.push({ points: n, ...stats, tree: which, sha: git(trees[which]), mode, outcome: ok ? 'ok' : uncapped[0].status,
        refusal: ok ? undefined : uncapped[0].error, minOldSpaceMiB: cap?.mib ?? null, bisection: cap?.stopped,
        maxRssMiB: ok ? uncapped.map(r => +(r.maxRssKiB / 1024).toFixed(1)) : null,
        peakHeapBeforeGcMB: ok ? uncapped.map(r => r.peakHeapBeforeGcMB) : null,
        afterMiB: ok ? Object.fromEntries(Object.entries(uncapped[0].after).map(([k, v]) => [k, +(v / 2 ** 20).toFixed(1)])) : null });
      console.error(JSON.stringify(rows.at(-1)));
    }
  }
  console.log(JSON.stringify({ node: process.version, reps, columns, mode, trees, rows }, null, 2));
}

async function main() {
  work = mkdtempSync(join(tmpdir(), 'import-memory-'));
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command === 'gen') {
      const { zip, stats } = await generate(Number(rest[0]), Number(rest[1] ?? 52));
      if (rest[2]) writeFileSync(rest[2], zip);
      console.log(JSON.stringify(stats));
    } else if (command === 'measure') await measure(rest);
    else throw new Error('Usage: import-memory.mjs gen <points> [columns] [out.ork] | measure --baseline <tree> [...]');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
