/**
 * The Node this repo runs on, stated once and held to what its toolchain
 * declares (audit 2026-09-30). Nothing in the repo said it: CI runs Node 22,
 * both machines Node 24, and v0.138's first push failed its gate on a kernel
 * float that differs between the two.
 *
 *   - Root package.json's `engines.node` never admits a Node version that a
 *     package in package-lock.json refuses. That makes it the intersection of
 *     the toolchain's own ranges: ESLint 10 and its @eslint/* packages need
 *     ^22.13.0 on the 22 line (Vite alone would allow 22.12), and vitest 5
 *     skips the odd majors 23 and 25.
 *   - It admits the Node running this suite (CI's 22, the machines' 24) and
 *     the line .nvmrc names, and every setup-node step in .github/workflows/
 *     names that same line.
 *
 * npm treats `engines` as advice (no .npmrc here sets engine-strict, and
 * `npm ci` checks only package versions against the lockfile), so this test
 * is what keeps the statement true when a dependency moves its floor.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import semver from 'semver';

const ROOT = new URL('../../../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8');
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const ENGINES = pkg.engines?.node;

describe('test dependencies', () => {
  it.each(['semver', 'workbox-core'])('declares %s in the app workspace at its locked version', (name) => {
    const app = JSON.parse(read('packages/app/package.json'));
    expect(app.devDependencies[name]).toBe(lock.packages[`node_modules/${name}`].version);
  });
});

/** Every package npm installs on every platform (optional ones are per-platform) that states a Node range. */
const RANGES = Object.entries(lock.packages)
  .filter(([path, p]) => path && !p.optional && p.engines?.node)
  .map(([path, p]) => [path.replace(/^.*node_modules\//, ''), p.engines.node]);

/** Each version any range names and the version just below it — where a range's answer can change. */
function probes() {
  const out = new Set([process.versions.node]);
  for (let major = 16; major <= 30; major++) out.add(`${major}.0.0`).add(`${major}.99.99`);
  for (const [, range] of RANGES) {
    for (const m of range.matchAll(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/g)) {
      const [x, y, z] = [m[1], m[2] ?? '0', m[3] ?? '0'].map(Number);
      out.add(`${x}.${y}.${z}`);
      out.add(z > 0 ? `${x}.${y}.${z - 1}` : y > 0 ? `${x}.${y - 1}.99` : `${Math.max(0, x - 1)}.99.99`);
    }
  }
  return [...out];
}

describe('engines.node — the Node versions the repo supports', () => {
  it('admits no Node version that a package in the lockfile refuses', () => {
    expect(ENGINES, 'root package.json engines.node').toBeTypeOf('string');
    expect(RANGES.length).toBeGreaterThan(100);
    const admitted = probes().filter((v) => semver.satisfies(v, ENGINES));
    const refused = admitted.flatMap((v) => RANGES.filter(([, r]) => !semver.satisfies(v, r))
      .map(([name, r]) => `${v}: ${name} needs ${r}`));
    expect(refused).toEqual([]);
  });

  it('admits the Node running this suite, and the line .nvmrc and every CI job name', () => {
    expect(ENGINES, 'root package.json engines.node').toBeTypeOf('string');
    expect(semver.satisfies(process.versions.node, ENGINES), `Node ${process.versions.node}`).toBe(true);
    const nvmrc = read('.nvmrc').trim();
    expect(nvmrc).toMatch(/^\d+$/);
    expect(semver.satisfies(`${nvmrc}.99.99`, ENGINES)).toBe(true);
    const ci = readdirSync(new URL('.github/workflows/', ROOT)).filter((f) => f.endsWith('.yml'))
      .flatMap((f) => [...read(`.github/workflows/${f}`).matchAll(/^\s*node-version:\s*["']?([^"'\s#]+)/gm)]
        .map((m) => m[1]));
    expect(ci.length).toBeGreaterThan(0);
    expect([...new Set(ci)]).toEqual([nvmrc]);
  });

  it('is written into the lockfile as npm writes it', () => {
    // npm copies the root package's engines into packages[""]; without it the
    // next `npm install` rewrites the lockfile in an unrelated commit.
    expect(lock.packages[''].engines).toEqual(pkg.engines);
  });
});
