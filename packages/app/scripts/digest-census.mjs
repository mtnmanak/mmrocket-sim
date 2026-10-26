/**
 * Digest census — a MEASUREMENT, not part of npm test (board Tier 3, the
 * thrust-curve picker's first step; Eric 2026-10-01).
 *
 * Question: how many desktop .ork designs fly a DIFFERENT thrust-curve file
 * here than the one their stored `<digest>` names? Desktop writes the MD5
 * digest of the data file it loaded (services/motorDigest.ts is the port);
 * this app carries the digest for saving only and picks the file by its own
 * rule (thrustcurve.ts pickSampleFile).
 *
 *   node packages/app/scripts/digest-census.mjs [--out DIR] [--no-dropbox]
 *        [--dropbox DIR] [--list FILE]
 *
 * Read-only over its inputs: every .ork under docs/ (local-only, gitignored)
 * and, unless --no-dropbox, every .ork under the owner's Dropbox
 * (default G:/Documents/Dropbox, or --dropbox; the OpenRocket reference source
 * tree is skipped). --list FILE adds paths from a file, one per line, instead
 * of walking the Dropbox (a walk of a large Dropbox is slow).
 *
 * It downloads the RAW simulator file of every motor in the shipped bundle
 * (src/data/motorCurves.json) from thrustcurve.org once — the bundle keeps
 * samples rounded to 0.01 N and no raw text, and the digest reads mN — and
 * caches it in DIR (default: the OS temp folder, never the repository). Then
 * it runs the census itself as a vitest file
 * (src/services/motorDigest.census.test.ts), which imports each design with
 * the app's own importer and matcher and writes DIR/results.json.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadRawFiles } from './fetch-motor-curves.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const ROOT = join(APP, '..', '..');
const CURVES = join(APP, 'src', 'data', 'motorCurves.json');

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const out = resolve(opt('--out') ?? join(tmpdir(), 'mmrsim-digest-census'));
const dropbox = argv.includes('--no-dropbox') ? null : (opt('--dropbox') ?? 'G:/Documents/Dropbox');
mkdirSync(out, { recursive: true });

/** Every *.ork under `dir`, skipping the reference source and tool folders. */
function walk(dir, found = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (['Open_Rocket_Source_Code', 'node_modules', '.git'].includes(e.name)) continue;
      walk(p, found);
    } else if (/\.ork$/i.test(e.name)) {
      found.push(p);
    }
  }
  return found;
}

const paths = [...walk(join(ROOT, 'docs')).map((p) => ({ path: p, corpus: 'docs' }))];
const list = opt('--list');
if (list) {
  for (const line of readFileSync(list, 'utf8').split(/\r?\n/)) {
    if (line.trim()) paths.push({ path: resolve(dropbox ?? '.', line.trim()), corpus: 'dropbox' });
  }
} else if (dropbox && existsSync(dropbox)) {
  paths.push(...walk(dropbox).map((p) => ({ path: p, corpus: 'dropbox' })));
}
const files = paths.filter((f) => statSync(f.path, { throwIfNoEntry: false })?.isFile())
  .map((f) => ({ ...f, sha256: createHash('sha256').update(readFileSync(f.path)).digest('hex') }));
console.log(`${files.length} .ork files (${new Set(files.map((f) => f.sha256)).size} distinct by content)`);

// The raw files, once per bundle generation.
const bundle = JSON.parse(readFileSync(CURVES, 'utf8'));
const rawPath = join(out, `raw-${bundle.generated}.json`);
if (!existsSync(rawPath)) {
  const ids = Object.keys(bundle.curves);
  const raw = await downloadRawFiles(ids);
  process.stdout.write('\n');
  writeFileSync(rawPath, JSON.stringify(raw));
}

const manifest = join(out, 'manifest.json');
writeFileSync(manifest, JSON.stringify({ files, raw: rawPath, results: join(out, 'results.json') }));
const vitest = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const run = spawnSync(process.execPath, [vitest, 'run', 'src/services/motorDigest.census.test.ts', '--project', 'app'], {
  cwd: APP, stdio: 'inherit', env: { ...process.env, DIGEST_CENSUS: manifest },
});
process.exitCode = run.status ?? 1;
