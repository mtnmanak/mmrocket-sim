import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkMotorCorrections, main, motorCorrectionVerdicts } from '../../../scripts/check-upstream.mjs';
import {
  auditFix, checkAdvisories, npmAdvisories, runtimeNodes, wranglerAdvisories, wranglerPins,
} from '../../../scripts/upstream-advisories.mjs';
import { MOTOR_CORRECTIONS } from './motor-corrections.mjs';

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
    expect(output).not.toContain('warn');
    expect(run).toHaveBeenNthCalledWith(1, 'npm audit --package-lock-only --json --include=dev --include=optional --include=peer', expect.objectContaining({ shell: true, timeout: 30_000 }));
    expect(run).toHaveBeenNthCalledWith(2, 'gh', ['api', '--paginate', '--slurp', '/advisories?ecosystem=npm&affects=wrangler@4.136.3&per_page=100'], expect.objectContaining({ timeout: 30_000 }));
  });
  it('reports both clean results', () => {
    const { output } = runSection(result({ vulnerabilities: {} }), result([[]]));
    expect(output).toContain('ok   npm audit: no advisories');
    expect(output).toContain('ok   wrangler@4.136.3 (deploy, outside lockfile): no advisories');
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
    expect(output).toContain('ok   wrangler@5.0.0');
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
