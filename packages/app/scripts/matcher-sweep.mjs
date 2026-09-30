// Usage (repository root): node packages/app/scripts/matcher-sweep.mjs --manifest FILE
// Optional: --baseline 01d6bee --out .matcher-sweep --batch 6 --limit 12
// Local corpus required; deliberately not part of npm test. One bounded child
// at a time, JSONL flushed after each file, explicit per-batch completion.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { freemem } from 'node:os';
const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => i % 2 ? a : [...a, [v.slice(2), all[i + 1]]], []));
if (!args.manifest) throw new Error('--manifest required');
const root = process.cwd().replaceAll('\\', '/');
const out = resolve(args.out ?? '.matcher-sweep');
if (!out.startsWith(resolve(root) + '\\') && !out.startsWith(resolve(root) + '/')) throw new Error('Output must be inside worktree');
if (freemem() < 18 * 2 ** 30) throw new Error('Need 18 GiB free (2 GiB child, 16 GiB reserve)');
mkdirSync(out, { recursive: true });
const baseline = execFileSync('git', ['rev-parse', args.baseline ?? '01d6bee'], { encoding: 'utf8' }).trim();
const sha = data => createHash('sha256').update(data).digest('hex');
const sourceHash = () => sha(readdirSync('packages/app/src', { recursive: true }).filter(p => /\.(tsx?|json)$/.test(p)).sort()
  .map(p => `${p}:${sha(readFileSync(`packages/app/src/${p}`))}`).join('\n'));
const manifest = readFileSync(args.manifest, 'utf8');
const files = manifest.trim().split(/\r?\n/).map(line => { const [key, path] = line.split('\t'); return { key, path: path.replace('{ROOT}', root) }; });
if (!files.some(f => f.key === 'fx:first-sim-unloadable.rkt')) files.push({ key: 'fx:first-sim-unloadable.rkt', path: `${root}/packages/app/src/services/__fixtures__/first-sim-unloadable.rkt` });
for (const name of readdirSync('packages/app/src/services/__fixtures__').filter(p => /\.(rkt|ork|cdx1)$/i.test(p))) {
  if (!files.some(f => f.key === `fx:${name}`)) throw new Error(`Manifest omits fixture ${name}`);
}
const selected = args.limit ? files.slice(0, Number(args.limit)) : files;
// Read every input before starting: a missing file cannot silently shrink the denominator.
for (const f of selected) f.sha256 = sha(readFileSync(f.path));
const meta = { baseline, node: process.version, currentSourcesSha256: sourceHash(), manifest: args.manifest, manifestSha256: sha(manifest), expectedFiles: files.length,
  selectedFiles: selected.length, uniqueFileHashes: new Set(selected.map(f => f.sha256)).size,
  catalogueSha256: sha(readFileSync('packages/app/src/data/motors.json')), curvesSha256: sha(readFileSync('packages/app/src/data/motorCurves.json')) };
writeFileSync(`${out}/meta.json`, JSON.stringify(meta, null, 2));
writeFileSync(`${out}/results.jsonl`, '');
const batch = Number(args.batch ?? 6);
if (!Number.isInteger(batch) || batch < 1 || batch > 12) throw new Error('batch must be 1..12');
for (let start = 0; start < selected.length; start += batch) {
  const list = `${out}/batch.json`;
  writeFileSync(list, JSON.stringify(selected.slice(start, start + batch)));
  const p = spawnSync(process.execPath, ['--max-old-space-size=1536', '--no-warnings', '--experimental-loader', './packages/app/scripts/matcher-sweep.loader.mjs', './packages/app/scripts/matcher-sweep.worker.mjs'], {
    env: { ...process.env, MATCHER_BASELINE: baseline, MATCHER_LIST: list, MATCHER_OUT: `${out}/results.jsonl`, MATCHER_CACHE: `${out}/cache` }, encoding: 'utf8', timeout: 180000,
  });
  if (p.status !== 0) { process.stderr.write(p.stderr ?? ''); throw new Error(`batch ${start}: exit ${p.status}, ${p.error ?? ''}`); }
  appendFileSync(`${out}/batches.jsonl`, JSON.stringify({ start, count: Math.min(batch, selected.length - start), exit: p.status }) + '\n');
  console.log(`${Math.min(start + batch, selected.length)}/${selected.length}`);
}
if (sourceHash() !== meta.currentSourcesSha256) throw new Error('Working sources changed during sweep; rerun against stable sources');
console.log(`Complete: ${out}/results.jsonl (classify separately with reviewed oracle).`);
