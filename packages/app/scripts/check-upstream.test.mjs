import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkMotorCorrections, checkOpenMeteoShape, checkThrustCurve, checkOpenMeteoTerms, main, motorCorrectionVerdicts, OPEN_METEO_HOURLY_UNITS,
  openMeteoHourlyProblems,
} from '../../../scripts/check-upstream.mjs';
import {
  auditFix, checkAdvisories, npmAdvisories, runtimeNodes, wranglerAdvisories, wranglerPins,
} from '../../../scripts/upstream-advisories.mjs';
import { MOTOR_CORRECTIONS } from './motor-corrections.mjs';
import { ThrustcurveChallengeError, ThrustcurveUnavailableError } from './thrustcurve-client.mjs';

const { unexpectedFetch } = vi.hoisted(() => {
  const unexpectedFetch = vi.fn(() => { throw new Error('unexpected network request'); });
  vi.stubGlobal('fetch', unexpectedFetch);
  return { unexpectedFetch };
});
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => { throw new Error('unexpected subprocess'); }),
}));

// npm-error is the verbatim JSON from this sandbox's 2026-09-30 audit attempt.
// npm-audit is a reduced reconstruction of item6-advisories.md §5's recorded
// pre-v0.141 esbuild/vite-node results; the original scratchpad is unavailable.
// wrangler records the fields from github.com/advisories/GHSA-36p8-mvp6-cv38
// (2026-09-30), wrapped as gh --paginate --slurp output. Edge cases below are
// synthetic. None of these tests calls the registry or GitHub.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/advisories/${name}.json`, import.meta.url), 'utf8'));
const audit = fixture('npm-audit');
const github = fixture('wrangler');
const workflow = 'run: npm install --no-save --no-package-lock wrangler@4.136.3\nwranglerVersion: "4.136.3"';
const lock = { packages: {
  'packages/app': { dependencies: { react: '*', '@scope/shared': '*', linked: '*' }, devDependencies: { esbuild: '*' } },
  'packages/engine': { dependencies: { engineDep: '*' } },
  'packages/lib': { dependencies: { react: '*' } },
  'node_modules/linked': { link: true, resolved: 'packages/lib' },
  'node_modules/react': { dependencies: { cycle: '*' } },
  'node_modules/cycle': { dependencies: { react: '*' } },
  'node_modules/@scope/shared': { optionalDependencies: { optional: '*', absent: '*' }, peerDependencies: { peer: '*' } },
  'node_modules/optional': {},
  'node_modules/peer': {},
  'node_modules/engineDep': {},
  'node_modules/esbuild': { dev: true },
  'node_modules/vite-node': { dev: true },
  'node_modules/tool/node_modules/react': { dev: true },
  'node_modules/rootOnly': {},
  '': { dependencies: { rootOnly: '*' } },
} };
const result = (json, status = 0) => ({ stdout: JSON.stringify(json), stderr: '', status });
const reader = (path) => path.endsWith('package-lock.json') ? JSON.stringify(lock) : workflow;
function runSection(npm = result(audit, 1), gh = result(github), read = reader) {
  const say = vi.fn();
  const run = vi.fn().mockReturnValueOnce(npm).mockReturnValue(gh);
  checkAdvisories('.', say, run, read);
  return { output: say.mock.calls.flat().join('\n'), run };
}

afterEach(() => vi.restoreAllMocks());

it.each(['İstanbul<script>hidden</script>', '<p title="x > y">Delay < 5</p>'])('reads Open-Meteo terms after %s', async prefix => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  await checkOpenMeteoTerms(async () => prefix + '<p>We do not share this data with any third party.</p>');
  expect(log.mock.calls.flat().join('\n')).toContain('ok   still says: “We do not share this data with any third party.”');
});

it.each(['<!--', '<script>', '<style>', '<p '])('refuses unclosed Open-Meteo HTML spans (%s)', async opener => {
  await expect(checkOpenMeteoTerms(async () => opener.repeat(10_000))).rejects.toThrow(/unclosed HTML/);
});

describe('lockfile runtime reachability', () => {
  it('walks only app/engine production edges, including workspaces, peers, optionals and cycles', () => {
    expect([...runtimeNodes(lock)].sort()).toEqual([
      'packages/app', 'packages/engine', 'packages/lib', 'node_modules/linked',
      'node_modules/react', 'node_modules/cycle', 'node_modules/@scope/shared',
      'node_modules/optional', 'node_modules/peer', 'node_modules/engineDep',
    ].sort());
  });
  it('resolves nested and workspace-local packages before a hoisted copy', () => {
    const nested = structuredClone(lock);
    nested.packages['packages/app/node_modules/react'] = {};
    nested.packages['node_modules/@scope/shared/node_modules/peer'] = {};
    const nodes = runtimeNodes(nested);
    expect(nodes.has('packages/app/node_modules/react')).toBe(true);
    expect(nodes.has('node_modules/@scope/shared/node_modules/peer')).toBe(true);
    expect(nodes.has('node_modules/peer')).toBe(false);
  });
  it.each(['packages/app', 'packages/engine'])('refuses missing workspace %s', (workspace) => {
    const broken = structuredClone(lock);
    delete broken.packages[workspace];
    expect(() => runtimeNodes(broken)).toThrow('workspace');
  });
});

describe('npm audit records', () => {
  it('reports every own advisory and inherited-only vulnerability with its fix target', () => {
    expect(npmAdvisories(audit, lock)).toEqual([
      expect.stringContaining('esbuild moderate (dev/build-only) https://github.com/advisories/GHSA-67mh-4wv8-2f99 — MAJOR: vite@8.3.1'),
      'vite-node moderate (dev/build-only) only through vite — MAJOR: vitest@5.0.1',
    ]);
  });
  it('keeps distinct advisories, deduplicates repeated records, and uses each advisory severity', () => {
    const report = structuredClone(audit);
    const first = report.vulnerabilities.esbuild.via[0];
    report.vulnerabilities.esbuild.via.push({ ...first }, { ...first, url: 'https://example.test/second', severity: 'high' });
    expect(npmAdvisories(report, lock)).toHaveLength(3);
    expect(npmAdvisories(report, lock)[1]).toContain('esbuild high');
  });
  it.each([
    [['node_modules/tool/node_modules/react', 'node_modules/react'], 'RUNTIME'],
    [['node_modules/tool/node_modules/react'], 'dev/build-only'],
    [['node_modules/rootOnly'], 'dev/build-only'],
    [['missing'], 'scope unknown'],
    [[], 'scope unknown'],
    [undefined, 'scope unknown'],
  ])('classifies installed paths %j as %s', (nodes, scope) => {
    const report = structuredClone(audit);
    report.vulnerabilities.esbuild.nodes = nodes;
    expect(npmAdvisories(report, lock)[0]).toContain(`(${scope})`);
  });
  it.each([
    [true, 'in range: npm audit fix'], [false, 'no fix available'],
    [{ name: 'vite', version: '8.3.1', isSemVerMajor: true }, 'MAJOR: vite@8.3.1'],
    [{ name: 'vite', version: '5.4.22', isSemVerMajor: false }, 'outside declared range (non-major): vite@5.4.22'],
    [undefined, 'fix unknown'], [{}, 'fix unknown'],
  ])('routes fixAvailable %j honestly', (fix, route) => expect(auditFix(fix)).toBe(route));
  it.each([null, {}, { vulnerabilities: [] }, { vulnerabilities: 'bad' }, fixture('npm-error')])('refuses malformed or failed audit %j', (report) => {
    expect(() => npmAdvisories(report, lock)).toThrow();
  });
  it('accepts a clean report', () => expect(npmAdvisories({ vulnerabilities: {} }, lock)).toEqual([]));
  it('does not mistake an error with partial results for a clean audit', () => {
    expect(() => npmAdvisories({ ...fixture('npm-error'), vulnerabilities: {} }, lock)).toThrow('request to');
  });
});

describe('Wrangler outside the lockfile', () => {
  it('reads both active pins and ignores commented examples', () => {
    expect(wranglerPins(`# wrangler@1.0.0\n${workflow} # exact\n# wranglerVersion: '2.0.0'`)).toEqual(['4.136.3']);
    expect(wranglerPins('wranglerVersion: \'4.136.3\'')).toEqual(['4.136.3']);
    expect(wranglerPins(`${workflow}\nrun: npm i wrangler@5.0.0`)).toEqual(['4.136.3', '5.0.0']);
  });
  it.each(['# wrangler@4.0.0', 'wranglerVersion: "4"', 'run: npm i wrangler@4.0.0-beta.1', 'wranglerVersion: "4.0.0-beta.1"'])('refuses an absent/non-exact stable pin: %s', (text) => {
    expect(() => wranglerPins(text)).toThrow('no exact');
  });
  it('reports recorded advisory metadata, exact-pin fixes and all pages', () => {
    const lines = wranglerAdvisories([...github, ...github], '3.0.0');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('wrangler@3.0.0 high (dev/build-only; deploy, outside lockfile) GHSA-36p8-mvp6-cv38');
    expect(lines[0]).toContain('outside exact pin: wrangler@3.114.17');
    expect(lines[0]).toContain('MAJOR: wrangler@4.59.1');
  });
  it('reports missing patches and ignores other packages and ecosystems', () => {
    const pages = structuredClone(github);
    pages[0][0].vulnerabilities = [
      { package: { ecosystem: 'npm', name: 'wrangler' }, first_patched_version: null },
      { package: { ecosystem: 'npm', name: 'other' }, first_patched_version: '99.0.0' },
      { package: { ecosystem: 'pip', name: 'wrangler' }, first_patched_version: '99.0.0' },
    ];
    expect(wranglerAdvisories(pages, '4.0.0')[0]).toContain('no fix published');
  });
  it.each([{}, [null], [{ message: 'API error' }], github[0]])('refuses malformed API pages %j', (pages) => {
    expect(() => wranglerAdvisories(pages, '4.0.0')).toThrow();
  });
});

describe('report-only execution, without network', () => {
  it('does not execute the CLI when imported for testing', () => {
    expect(unexpectedFetch).not.toHaveBeenCalled();
    expect(spawnSync).not.toHaveBeenCalled();
  });
  it('accepts npm exit 1, uses bounded read-only commands and paginates GitHub', () => {
    const { output, run } = runSection();
    expect(output).toContain('esbuild moderate');
    expect(output).toContain('GHSA-36p8-mvp6-cv38');
    expect(output).not.toContain('warn could not check');
    expect(output).toContain('Deploy-path dependencies and bundled undici are not covered');
    expect(run).toHaveBeenNthCalledWith(1, 'npm audit --package-lock-only --json --include=dev --include=optional --include=peer', expect.objectContaining({ shell: true, timeout: 30_000 }));
    expect(run).toHaveBeenNthCalledWith(2, 'gh', ['api', '--paginate', '--slurp', '/advisories?ecosystem=npm&affects=wrangler@4.136.3&per_page=100'], expect.objectContaining({ timeout: 30_000 }));
  });
  it('reports both clean results', () => {
    const { output } = runSection(result({ vulnerabilities: {} }), result([[]]));
    expect(output).toContain('ok   npm audit: no advisories');
    expect(output).toContain('wrangler@4.136.3 (deploy, outside lockfile): no direct package advisories');
    expect(output).toContain('Deploy-path dependencies and bundled undici are not covered');
    expect(output).not.toContain('ok   wrangler@4.136.3');
  });
  it('preserves the spawn error reason', () => {
    const failure = { status: null, error: new Error('ENOENT'), stdout: '' };
    expect(runSection(failure, failure).output.match(/ENOENT/g)).toHaveLength(2);
  });
  it.each([
    result(fixture('npm-error'), 1), { status: 1, stdout: 'not JSON' },
    { status: 2, stdout: '{"vulnerabilities":{}}', stderr: 'offline' },
    { status: null, error: new Error('ETIMEDOUT'), stdout: '{"vulnerabilities":{}}' },
  ])('warns for npm failure and still checks Wrangler: %j', (failure) => {
    const { output, run } = runSection(failure);
    expect(output).toContain('warn could not check npm advisories');
    expect(output).not.toContain('ok   npm audit');
    expect(output).toContain('GHSA-36p8-mvp6-cv38');
    expect(run).toHaveBeenCalledTimes(2);
  });
  it.each([
    { status: null, error: new Error('ENOENT'), stdout: '[[]]' },
    { status: 1, stdout: '[[]]', stderr: 'offline' },
    { status: 0, stdout: 'not JSON' }, result({ message: 'rate limit' }),
  ])('warns for missing/offline/bad gh: %j', (failure) => {
    const { output } = runSection(result(audit, 1), failure);
    expect(output).toContain('esbuild moderate');
    expect(output).toContain('warn could not check wrangler@4.136.3 advisories');
    expect(output).not.toContain('ok   wrangler');
  });
  it('warns when the workflow is unreadable or has no pin', () => {
    for (const read of [() => { throw new Error('ENOENT'); }, () => '']) {
      expect(runSection(result(audit), result(github), read).output).toContain('warn could not check wrangler advisories');
    }
  });
  it('warns about mismatched pins and checks both even if the first request fails', () => {
    const say = vi.fn();
    const run = vi.fn().mockReturnValueOnce(result(audit, 1))
      .mockReturnValueOnce({ status: 1, stderr: 'offline' }).mockReturnValue(result([[]]));
    checkAdvisories('.', say, run, (path) => path.endsWith('.json') ? JSON.stringify(lock) : `${workflow}\nwranglerVersion: '5.0.0'`);
    const output = say.mock.calls.flat().join('\n');
    expect(output).toContain('different wrangler pins');
    expect(output).toContain('could not check wrangler@4.136.3');
    expect(output).toContain('wrangler@5.0.0 (deploy, outside lockfile): no direct package advisories');
  });
  it('keeps exit 0 despite findings, missing commands, and an unexpected reporter error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const run of [vi.fn().mockReturnValueOnce(result(audit, 1)).mockReturnValue(result(github)),
      () => { throw new Error('ENOENT'); }]) {
      expect(await main([], (root, say) => checkAdvisories(root, say, run, reader))).toBe(0);
    }
    expect(await main([], () => { throw new Error('unexpected'); })).toBe(0);
  });
  it('still reports advisories after an earlier failure and preserves exit 2', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const report = vi.fn();
    expect(await main([() => { throw new Error('earlier network failure'); }], report)).toBe(2);
    expect(report).toHaveBeenCalledOnce();
  });
});

/**
 * Section 4b watches the thrustcurve.org rows motor-corrections.mjs corrects
 * (board Tier 1 row 6), the way section 1 watches the parts catalogue's: the
 * day thrustcurve.org fixes one, the correction is a no-op to retire; the day it
 * moves one to a third figure, the next catalogue refresh will refuse to write.
 * The verdicts are a pure function, tested here; the module's own "moved" count
 * is shared by every check in a run, so nothing here makes it move.
 */
describe('thrustcurve.org rows this app corrects', () => {
  it('watches each row 57 field independently, including a partial upstream fix', () => {
    for (const designation of ['F52C', 'H13ST', 'N2700W-PS']) {
      const c = MOTOR_CORRECTIONS.find((c) => c.designation === designation);
      expect(c).toBeDefined();
      const bad = Object.fromEntries(Object.entries(c.fields).map(([f, v]) => [f, v.bad]));
      expect(motorCorrectionVerdicts(c, bad).every((v) => !v.moved)).toBe(true);
      for (const [field, { good }] of Object.entries(c.fields)) {
        const verdicts = motorCorrectionVerdicts(c, { ...bad, [field]: good });
        expect(verdicts.filter((v) => v.moved)).toEqual([
          expect.objectContaining({ note: `retire motor correction AeroTech ${designation} ${field}` }),
        ]);
        expect(motorCorrectionVerdicts(c, { ...bad, [field]: good + 0.123 }).filter((v) => v.moved))
          .toEqual([expect.objectContaining({ note: `investigate motor correction AeroTech ${designation} ${field}` })]);
      }
    }
  });

  const contrail = MOTOR_CORRECTIONS.find((c) => c.designation === 'J234-BG');
  const liveRow = (length) => ({ motorId: contrail.motorId, designation: 'J234-BG', length });

  it('says the correction is still needed while thrustcurve.org serves the known-bad figure', () => {
    expect(motorCorrectionVerdicts(contrail, liveRow(9122))).toEqual([
      expect.objectContaining({ moved: false, line: expect.stringMatching(/length = 9122 \(still the known-bad value/) }),
    ]);
  });

  it('flags a row thrustcurve.org has fixed, for retirement', () => {
    const [v] = motorCorrectionVerdicts(contrail, liveRow(922));
    expect(v.moved).toBe(true);
    expect(v.line).toMatch(/HAS FIXED THIS\. Retire the entry/);
  });

  it('flags a third figure, which the next refresh will refuse to write', () => {
    const [v] = motorCorrectionVerdicts(contrail, liveRow(914));
    expect(v.moved).toBe(true);
    expect(v.line).toMatch(/expected the known-bad 9122 or the corrected 922\. The next catalogue refresh WILL refuse/);
  });

  it('flags a motor thrustcurve.org no longer lists under that name', () => {
    const [v] = motorCorrectionVerdicts(contrail, undefined);
    expect(v.moved).toBe(true);
    expect(v.line).toMatch(/no longer found on thrustcurve\.org/);
  });

  it('asks thrustcurve.org for every corrected motor by maker and designation, and reads its own row', async () => {
    // thrustcurve.org as it stands: every corrected row still carries its known-bad figure.
    const asked = [];
    const getJson = async (url) => {
      asked.push(url);
      const c = MOTOR_CORRECTIONS.find((x) => x.designation === new URL(url).searchParams.get('designation'));
      const bad = Object.fromEntries(Object.entries(c.fields).map(([f, { bad }]) => [f, bad]));
      return { results: [{ motorId: 'someone-else', ...bad }, { motorId: c.motorId, ...bad }] };
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await checkMotorCorrections(getJson);
    const printed = log.mock.calls.flat().join('\n');
    expect(asked).toHaveLength(MOTOR_CORRECTIONS.length);
    for (const c of MOTOR_CORRECTIONS) {
      const u = new URL(asked.find((a) => a.includes(encodeURIComponent(c.designation))));
      expect(u.pathname).toBe('/api/v1/search.json');
      expect(Object.fromEntries(u.searchParams)).toMatchObject({ manufacturer: c.manufacturer, designation: c.designation, availability: 'all' });
      expect(printed).toContain(`ok   ${c.manufacturer} ${c.designation}`);
    }
    expect(printed).not.toContain('**');
  });
});

describe('Open-Meteo answer shape (section 6b)', () => {
  const fx = (name) => JSON.parse(readFileSync(new URL(`../src/services/__fixtures__/open-meteo/${name}.json`, import.meta.url), 'utf8'));

  it('watches the units and variables the weather parser asserts, not a copy that drifted', async () => {
    const { HOURLY_UNITS, HOURLY_VARS } = await import('../src/services/openMeteo.ts');
    expect(OPEN_METEO_HOURLY_UNITS).toEqual(HOURLY_UNITS);
    expect(Object.keys(OPEN_METEO_HOURLY_UNITS).filter((k) => k !== 'time')).toEqual([...HOURLY_VARS]);
  });

  it('reads a recorded answer, and names a changed unit, a ragged series and a missing block', () => {
    const body = fx('archive-blackrock-2025-06-14');
    expect(openMeteoHourlyProblems(body, 1190)).toEqual([]);
    const kmh = structuredClone(body);
    kmh.hourly_units.wind_speed_10m = 'km/h';
    expect(openMeteoHourlyProblems(kmh, 1190)).toEqual(['wind_speed_10m in km/h, not m/s']);
    const ragged = structuredClone(body);
    ragged.hourly.wind_gusts_10m.pop();
    expect(openMeteoHourlyProblems(ragged, 1190)).toEqual(['hourly.wind_gusts_10m does not match hourly.time']);
    expect(openMeteoHourlyProblems({}, 1190)).toEqual(['no hourly / hourly_units']);
    expect(openMeteoHourlyProblems(body, 1500)).toEqual(['elevation 1190 for 1500 m asked']);
  });

  it('asks each endpoint once and reports nothing moved for the recorded answers', async () => {
    const urls = [];
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await checkOpenMeteoShape(async (url) => {
      urls.push(url);
      if (url.includes('/v1/elevation')) return fx('elevation-blackrock');
      if (url.includes('/v1/search')) return fx('geocode-gerlach');
      return fx(url.includes('archive-api') ? 'archive-blackrock-2025-06-14' : 'forecast-blackrock-1190m');
    }, new Date('2026-10-09T12:00:00Z'));
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(urls).toHaveLength(4);
    expect(urls[0]).toContain('start_date=2026-10-09');
    expect(lines.filter((l) => l.startsWith('  ok')).length).toBe(4);
    expect(lines.some((l) => l.startsWith('  **'))).toBe(false);
  });
});

/**
 * Audit S2-1: one service's stop skips only the later checks that need that
 * service. Stand-ins carry the heading (`section`) and services (`needs`)
 * the real checks declare; nothing here reaches the network.
 */
describe('a stop on one service skips only the checks that need it', () => {
  const stand = (section, needs, body = async () => {}) => Object.assign(vi.fn(body), { section, needs });
  const sections = () => ({
    head: stand('3. openrocket-database HEAD', ['GitHub']),
    materials: stand('3. OpenRocket 24.12 built-in materials', []),
    tc: stand('4. ThrustCurve API and the bundled motor catalogue', []),
    tcRows: stand('4b. thrustcurve.org rows this app corrects', ['thrustcurve.org']),
    nozzles: stand('5. The nozzle database against the bundled catalogue', []),
    aerotech: stand('5b. AeroTech published delay documents', []),
    terms: stand('6. Open-Meteo’s terms', ['Open-Meteo']),
    shape: stand('6b. Open-Meteo’s answers', ['Open-Meteo']),
    rows: stand('1. openrocket-database rows this app corrects', ['GitHub']),
  });
  const run = async (checks) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const status = await main(checks, () => {});
    return { status, out: log.mock.calls.flat().join('\n') };
  };
  const summary = (out) => out.slice(out.lastIndexOf('Some checks could not run'));

  it.each([
    ['a challenge', () => new ThrustcurveChallengeError('https://www.thrustcurve.org/api/v1/search.json', 403)],
    ['the unavailable latch on a 503', () => new ThrustcurveUnavailableError('https://www.thrustcurve.org/api/v1/search.json', 503)],
    ['a thrustcurve.org 403', () => Object.assign(new Error('HTTP 403'), { status: 403, url: 'https://www.thrustcurve.org/api/v1/search.json' })],
  ])('%s in section 4 skips 4b without calling it, runs 5, 5b, 6 and 6b, names 4b, and exits 2', async (_what, error) => {
    const c = sections();
    c.tc.mockImplementation(async () => { throw error(); });
    const { status, out } = await run([c.tc, c.tcRows, c.nozzles, c.aerotech, c.terms, c.shape]);
    expect(status).toBe(2);
    expect(c.tcRows).not.toHaveBeenCalled();
    for (const later of [c.nozzles, c.aerotech, c.terms, c.shape]) expect(later).toHaveBeenCalledOnce();
    expect(summary(out)).toContain('4b. thrustcurve.org rows this app corrects — skipped: thrustcurve.org stopped answering in 4. ThrustCurve API');
    expect(summary(out)).toContain('4. ThrustCurve API and the bundled motor catalogue — could not run');
    expect(summary(out)).not.toMatch(/\b5b?\. .*(skipped|could not run)/);
  });

  it('a GitHub 429 skips only the later GitHub sections, names them, and exits 2', async () => {
    const c = sections();
    c.head.mockImplementation(async () => { throw Object.assign(new Error('HTTP 429'), { status: 429, url: 'https://api.github.com/repos/x/y/commits' }); });
    const { status, out } = await run([c.head, c.materials, c.tc, c.tcRows, c.rows, c.terms]);
    expect(status).toBe(2);
    expect(c.rows).not.toHaveBeenCalled();
    for (const later of [c.materials, c.tc, c.tcRows, c.terms]) expect(later).toHaveBeenCalledOnce();
    expect(summary(out)).toContain('1. openrocket-database rows this app corrects — skipped: GitHub stopped answering in 3. openrocket-database HEAD');
    expect(summary(out)).toContain('3. openrocket-database HEAD — could not run');
    expect(summary(out)).not.toContain('built-in materials —');
  });

  it('checkThrustCurve notes a challenge on its probe, runs its local checks, asks nothing more, and 4b is skipped', async () => {
    const c = sections();
    const getJson = vi.fn(async (url) => { throw Object.assign(new ThrustcurveChallengeError(url, 403), { url }); });
    const section4 = Object.assign(() => checkThrustCurve(getJson), { section: '4. ThrustCurve API and the bundled motor catalogue', needs: [] });
    const { status, out } = await run([section4, c.tcRows, c.nozzles]);
    expect(status).toBe(2);
    expect(getJson).toHaveBeenCalledOnce();
    expect(out).toMatch(/motorCurves\.json (built from this catalogue|was built from)/);
    expect(out).toContain('metadata.json not asked');
    expect(c.tcRows).not.toHaveBeenCalled();
    expect(c.nozzles).toHaveBeenCalledOnce();
    expect(summary(out)).toContain('4. ThrustCurve API and the bundled motor catalogue — partly run: thrustcurve.org stopped answering');
    expect(summary(out)).toContain('4b. thrustcurve.org rows this app corrects — skipped');
  });

  it('a 429 from any other host stops nothing else', async () => {
    const c = sections();
    c.aerotech.mockImplementation(async () => { throw Object.assign(new Error('HTTP 429'), { status: 429, url: 'https://www.rocketmotorparts.com/page' }); });
    const { status, out } = await run([c.aerotech, c.terms, c.shape, c.rows, c.tcRows]);
    expect(status).toBe(2);
    for (const later of [c.terms, c.shape, c.rows, c.tcRows]) expect(later).toHaveBeenCalledOnce();
    expect(summary(out)).toContain('5b. AeroTech published delay documents — could not run');
  });

  it('declares a heading the check prints, and its services, on every default check', async () => {
    const source = readFileSync(new URL('../../../scripts/check-upstream.mjs', import.meta.url), 'utf8');
    const module = await import('../../../scripts/check-upstream.mjs');
    const checks = module.DEFAULT_CHECKS;
    expect(checks).toHaveLength(10);
    for (const check of checks) {
      expect(source).toContain(`say('${check.section}`);
      expect(Array.isArray(check.needs)).toBe(true);
    }
    expect(checks.filter((c) => c.needs.includes('thrustcurve.org')).map((c) => c.section.split(' ')[0])).toEqual(['4b.']);
    expect(checks.filter((c) => c.needs.includes('GitHub')).map((c) => c.section.split(' ')[0])).toEqual(['1.', '2.', '3.']);
  });
});
