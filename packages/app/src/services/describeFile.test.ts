// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import type { ComponentNode } from '@online-openrocket/engine';
import { buildDesign, KERNEL_HANDLES } from './buildDesign.js';
import { designCdOf } from './designCd.js';
import { designBuildInputOf, deriveLaunchInputs } from './designDerivation.js';
import { DESCRIBE_BASIS, describeFile, motorFreeOrk, motorFreeProjection } from './describeFile.js';
import { resolveFlightState } from './flightState.js';
import { exportOrk, importOrk } from './orkFile.js';
import { decodeShareFragment, encodeShareFragment, MAX_FRAGMENT_CHARS, MAX_INFLATED_BYTES, SHARE_TOO_LARGE_ERROR_NAME } from './shareLink.js';
import { shownCp } from './simReport.js';
import { APP_DEFAULT_AERO, resetKernelForTests, SimulateDesignError, withKernel } from './simulateDesign.js';
import { openHeadlessDesign, planHeadlessImport, simulateFile } from './simulateFile.js';

/**
 * THE S3 DRAFT DESCRIBE (describeFile.ts), on the committed fixtures only.
 * Every expected number is computed afresh here — from the flight build, the
 * Design tab's own loaded build or the fixture's own XML — never pinned.
 * The tester corpus is local-only and is not run here.
 */

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'version.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}
const bytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(repoRoot(), 'packages', 'app', 'src', 'services', '__fixtures__', name)));
const referenceXml = () => strFromU8(unzipSync(bytes('reference.ork'))['rocket.ork']!);
const ork = (xml: string) => zipSync({ 'rocket.ork': strToU8(xml) });
/** Same arithmetic, same kernel, same tree: only float-identical paths are compared at this tolerance. */
const close = (actual: number | null, expected: number) => {
  expect(actual).not.toBeNull();
  expect(Math.abs(actual! - expected)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(expected)));
};
const opened = async (data: Uint8Array, name: string) =>
  (await planHeadlessImport(await openHeadlessDesign(data, name, { network: 'forbid' }), { network: 'forbid' })).snapshot;
const FORMATS = [['reference.ork', 'ork'], ['rocksimTestRocket1.rkt', 'rkt'], ['Show-off.CDX1', 'cdx1']] as const;

const fetchSpy = vi.fn(() => { throw new Error('describe must not fetch'); });
beforeEach(() => { fetchSpy.mockClear(); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); expect(fetchSpy).not.toHaveBeenCalled(); });

describe('describeFile: dry statics on the shipped data, no flight', () => {
  it.each(FORMATS)('%s: SI, dry basis and the Design tab conditions, finite JSON only', async (file, format) => {
    const out = await describeFile(bytes(file), file);
    expect(out.sourceFormat).toBe(format);
    const a = out.analysis;
    expect(a.basis).toBe(DESCRIBE_BASIS);
    expect(a.aeroModel).toBe('classic+kbf');
    expect([a.mach, a.angleOfAttackRad, a.cdEstimate.mach, a.cdEstimate.powerState]).toEqual([0.3, 0, 0.3, 'off']);
    close(a.cdEstimate.referenceAreaM2, Math.PI * a.referenceDiameterM ** 2 / 4);
    // One caliber is the reference diameter; the margin is measured from the dry CG.
    expect(Math.abs(a.stabilityCalibers! - (a.cpM! - a.dryCgM!) / a.referenceDiameterM)).toBeLessThan(1e-9);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(out.fragment.startsWith('#d=1.')).toBe(true);
    expect(out.fragment).not.toMatch(/[&?]/);
  }, 60_000);

  it.each(FORMATS)('%s: the dry figures are the flight build\'s own, and Cd is the Design tab\'s loaded figure', async file => {
    const out = await describeFile(bytes(file), file);
    const flown = await simulateFile(bytes(file), file, { reportSeries: 'summary', network: 'forbid' });
    const info = flown.build.info;
    close(out.analysis.dryMassKg, info.massEmpty);
    close(out.analysis.dryCgM, info.cgEmpty);
    close(out.analysis.cpM, shownCp(info));
    close(out.analysis.lengthM, info.length);
    close(out.analysis.referenceDiameterM, info.refDiameter);
    // App's designCd memo reads the build WITH the opened motors; power-off drag does not depend on them.
    const s = await opened(bytes(file), file);
    const state = { ...s, ...resolveFlightState(s.tree, s.savedConfigs, s.activeConfigId, {}, s.mountMotors) };
    const d = deriveLaunchInputs(state, APP_DEFAULT_AERO);
    expect(d.assigned.length).toBeGreaterThan(0);
    const loadedCd = await withKernel(() => {
      const built = buildDesign(designBuildInputOf({ tree: state.tree, assigned: d.assigned, effectiveKbf: true,
        effectiveSupersonic: false, measuredDryMassKg: s.measured.massKg, primaryMountId: d.primaryMountId,
        currentSetKey: d.currentSetKey }), KERNEL_HANDLES);
      if ('error' in built) throw new Error(built.error);
      return designCdOf(built.rocket);
    });
    close(out.analysis.cdEstimate.value, loadedCd!);
  }, 60_000);

  it('gives no CP or margin, with a note, when nothing produces normal force', async () => {
    const xml = referenceXml().replace(/<nosecone>[\s\S]*?<\/nosecone>/, '').replace(/<trapezoidfinset>[\s\S]*?<\/trapezoidfinset>/, '');
    const out = await describeFile(ork(xml), 'bare.ork');
    expect(out.analysis.cpM).toBeNull();
    expect(out.analysis.stabilityCalibers).toBeNull();
    expect(out.notes.analysis.join(' ')).toMatch(/no aerodynamic normal force|produces aerodynamic normal force/);
    expect(Number.isFinite(out.analysis.dryMassKg)).toBe(true);
  }, 60_000);

  it('a motorless and an unmatched-motor design are both described', async () => {
    const motorless = await describeFile(ork(referenceXml().replace(/<motor configid[\s\S]*?<\/motor>/, '')), 'motorless.ork');
    expect(motorless.mounts).toHaveLength(1);
    expect(motorless.notes.export.some(n => /Motor selections were removed/.test(n))).toBe(false);
    const unknown = await describeFile(ork(referenceXml().replace(/<designation>[^<]*<\/designation>/, '<designation>Z99999-NOPE</designation>')), 'unknown.ork');
    expect(unknown.notes.import.text).toMatch(/Z99999-NOPE/);
    expect(unknown.mounts).toEqual(motorless.mounts);
    close(unknown.analysis.dryMassKg, motorless.analysis.dryMassKg);
    expect(unknown.notes.export.join(' ')).toMatch(/unmatched references included/);
    const source = await opened(ork(referenceXml().replace(/<designation>[^<]*<\/designation>/, '<designation>Z99999-NOPE</designation>')), 'unknown.ork');
    expect(source.savedConfigs.some(c => Object.keys(c.unmatchedRefs ?? {}).length > 0)).toBe(true);
    for (const c of motorFreeProjection(source).savedConfigs) {
      expect(['unmatched', 'unmatchedRefs', 'motorLoadoutRefusal'].filter(key => key in c)).toEqual([]);
    }
  }, 60_000);

  it('builds only once it holds the kernel lock (the import before it runs outside)', async () => {
    let release!: () => void;
    const holder = withKernel(() => new Promise<void>(resolve => { release = resolve; }));
    const build = vi.spyOn(KERNEL_HANDLES, 'build');
    const pending = describeFile(bytes('reference.ork'), 'reference.ork');
    // Long enough for the whole import (all of it outside the lock) to finish.
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(build).not.toHaveBeenCalled();
    release();
    await holder;
    await expect(pending).resolves.toMatchObject({ name: 'Reference Rocket' });
    expect(build).toHaveBeenCalled();
  }, 60_000);

  it('refuses a design the kernel will not build, then the lock serves the next one', async () => {
    const build = vi.spyOn(KERNEL_HANDLES, 'build').mockImplementation(() => { throw new Error('test kernel refusal'); });
    const err = await describeFile(bytes('reference.ork'), 'reference.ork').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimulateDesignError);
    expect(err).toMatchObject({ kind: 'build', message: expect.stringContaining('test kernel refusal') });
    build.mockRestore();
    await expect(describeFile(bytes('reference.ork'), 'reference.ork')).resolves.toMatchObject({ name: 'Reference Rocket' });
  }, 60_000);

  it('refuses an essential non-finite figure; a missing CG or Cd is null with a note', async () => {
    const real = KERNEL_HANDLES.build;
    const patch = (info: Record<string, number>, sweepThrows = false) => vi.spyOn(KERNEL_HANDLES, 'build').mockImplementation(engine => {
      const rocket = real(engine);
      const staticInfo = rocket.staticInfo.bind(rocket);
      rocket.staticInfo = () => ({ ...staticInfo(), ...info });
      if (sweepThrows) rocket.dragSweep = () => { throw new Error('test sweep refusal'); };
      return rocket;
    });
    patch({ massEmpty: NaN });
    await expect(describeFile(bytes('reference.ork'), 'reference.ork')).rejects.toMatchObject({ kind: 'build', message: expect.stringMatching(/dry mass/) });
    vi.restoreAllMocks();
    patch({ cgEmpty: NaN }, true);
    const out = await describeFile(bytes('reference.ork'), 'reference.ork');
    expect(out.analysis.dryCgM).toBeNull();
    expect(out.analysis.cdEstimate.value).toBeNull();
    expect(out.notes.analysis.join(' ')).toMatch(/dry CG[\s\S]*test sweep refusal|test sweep refusal[\s\S]*dry CG/);
    expect(JSON.stringify(out)).not.toMatch(/NaN|Infinity/);
  }, 60_000);
});

describe('describeFile: mounts', () => {
  const mountXml = (extra: string) => referenceXml().replace('<clusterconfiguration>single</clusterconfiguration>', extra);
  it('counts a cluster, reads the bore from the tube and the stored length limit (zero is real)', async () => {
    const inner = /<innertube>[\s\S]*?<outerradius>([^<]+)<\/outerradius>\s*<thickness>([^<]+)<\/thickness>/.exec(referenceXml())!;
    const bore = 2 * (Number(inner[1]) - Number(inner[2]));
    for (const [extra, count, limit] of [
      ['<clusterconfiguration>4-ring</clusterconfiguration>', 4, null],
      ['<clusterconfiguration>single</clusterconfiguration><maxmotorlength>0.07</maxmotorlength>', 1, 0.07],
      ['<clusterconfiguration>single</clusterconfiguration><maxmotorlength>0</maxmotorlength>', 1, 0],
    ] as const) {
      const [m] = (await describeFile(ork(mountXml(extra)), 'mount.ork')).mounts;
      expect(m).toMatchObject({ key: 'm1', name: 'Inner Tube', stageIndex: 0, stageName: 'Sustainer', count, maxMotorLengthM: limit });
      close(m!.diameterM, bore);
    }
  }, 60_000);

  it('multiplies by pod instances, keeps stage order, and fits a case airframe to its outside', async () => {
    const tube = (id: string, extra: Record<string, unknown>) => ({ type: 'innertube', id, name: id, length: 0.08, outerRadius: 0.0095,
      thickness: 0.0005, motorMount: true, position: { method: 'bottom', offset: 0 }, ...extra }) as ComponentNode;
    const tree = { name: 'Pods', components: [
      { type: 'stage', id: 's1', name: 'Upper', children: [
        { type: 'nosecone', id: 'n1', length: 0.1, aftRadius: 0.025, thickness: 0.002 },
        { type: 'bodytube', id: 'b1', length: 0.5, outerRadius: 0.025, thickness: 0.0005, children: [
          tube('Core', {}),
          { type: 'podset', id: 'p1', name: 'Pods', instanceCount: 3, radiusMethod: 'relative', radiusOffset: 0, angleOffset: 0,
            position: { method: 'bottom', offset: 0 }, children: [
              { type: 'bodytube', id: 'pb', length: 0.25, outerRadius: 0.012, thickness: 0.0005, children: [tube('Pod mount', { cluster: '4-ring' })] },
            ] },
        ] },
      ] },
      { type: 'stage', id: 's2', name: 'Lower', children: [
        { type: 'bodytube', id: 'b2', name: 'Case', length: 0.3, outerRadius: 0.0145, thickness: 0.001, motorMount: true, caseAirframe: true },
      ] },
    ] as ComponentNode[] };
    const out = await describeFile(ork(exportOrk({ name: 'Pods', tree })), 'pods.ork');
    expect(out.mounts.map(m => [m.key, m.name, m.stageIndex, m.stageName, m.count]))
      .toEqual([['m1', 'Core', 0, 'Upper', 1], ['m2', 'Pod mount', 0, 'Upper', 12], ['m3', 'Case', 1, 'Lower', 1]]);
    close(out.mounts[2]!.diameterM, 0.029);
  }, 60_000);

  it('multiplies by strap-on (parallel stage) instances and the strap-on mount\'s own cluster', async () => {
    const tree = { name: 'Strap-ons', components: [
      { type: 'stage', id: 's1', name: 'Core stage', children: [
        { type: 'nosecone', id: 'n1', length: 0.1, aftRadius: 0.025, thickness: 0.002 },
        { type: 'bodytube', id: 'b1', length: 0.5, outerRadius: 0.025, thickness: 0.0005, children: [
          { type: 'innertube', id: 'core', name: 'Core', length: 0.08, outerRadius: 0.0095, thickness: 0.0005,
            motorMount: true, position: { method: 'bottom', offset: 0 } },
          { type: 'parallelstage', id: 'ps', name: 'Strap-ons', instanceCount: 2, separationEvent: 'never',
            radiusMethod: 'relative', radiusOffset: 0, angleOffset: 0, position: { method: 'bottom', offset: 0 }, children: [
              { type: 'nosecone', id: 'pn', length: 0.05, aftRadius: 0.012, thickness: 0.002 },
              { type: 'bodytube', id: 'pb', length: 0.25, outerRadius: 0.012, thickness: 0.0005, children: [
                { type: 'innertube', id: 'pm', name: 'Strap-on mount', length: 0.08, outerRadius: 0.0095, thickness: 0.0005,
                  motorMount: true, cluster: '4-ring', position: { method: 'bottom', offset: 0 } },
              ] },
            ] },
        ] },
      ] },
    ] as ComponentNode[] };
    const out = await describeFile(ork(exportOrk({ name: 'Strap-ons', tree })), 'strapons.ork');
    // Instance counts and the cluster are this test's own inputs: 2 strap-ons × a 4-motor cluster.
    expect(out.mounts.map(m => [m.name, m.stageIndex, m.stageName, m.count]))
      .toEqual([['Core', 0, 'Core stage', 1], ['Strap-on mount', 0, 'Core stage', 8]]);
  }, 60_000);
});

describe('describeFile: the motor-independent fragment', () => {
  const MOTOR_TAGS = ['<motor ', '<motor>', 'mmrexmotors', '<flightdata', '<databranch', 'motorloadoutrefusal', 'measuredpadmass', 'simwarnings'];

  it.each(['lemiv-motors.ork', 'Show-off.CDX1', 'rocksimTestRocket1.rkt', 'launch-stage-motorless.CDX1'])(
    '%s: no motor survives in any configuration; geometry, overrides and mounts do', async file => {
      const source = await opened(bytes(file), file);
      const out = await describeFile(bytes(file), file);
      const xml = await decodeShareFragment(out.fragment);
      for (const tag of MOTOR_TAGS) expect(xml).not.toContain(tag);
      expect(xml).not.toMatch(/<simulation status="(uptodate|loaded|outdated)"/);
      const back = importOrk(xml);
      expect(back.motors).toEqual({});
      for (const c of back.configs) expect(c.motors).toEqual({});
      // The fragment opens to the same rocket: identical dry statics, Cd and mounts.
      const again = await describeFile(ork(xml), 'again.ork');
      expect(again.analysis).toEqual(out.analysis);
      expect(again.mounts).toEqual(out.mounts);
      // Launch conditions the file carried travel with it.
      for (const [key, value] of Object.entries(source.launch)) {
        if (value === undefined) continue;
        const got = (back.launch as Record<string, unknown> | undefined)?.[key];
        if (typeof value === 'number') expect(Math.abs((got as number) - value)).toBeLessThan(1e-9 * Math.max(1, Math.abs(value)));
        else expect(got ?? null).toEqual(value);
      }
    }, 60_000);

  it('keeps every configuration and its mount ignition layer, with no motors in it', async () => {
    const source = await opened(bytes('lemiv-motors.ork'), 'lemiv-motors.ork');
    const out = await describeFile(bytes('lemiv-motors.ork'), 'lemiv-motors.ork');
    const back = importOrk(await decodeShareFragment(out.fragment));
    expect(back.configs).toHaveLength(source.savedConfigs.length);
    const ignitions = (configs: readonly { ignitions?: Record<string, unknown> }[]) => configs.map(c => Object.values(c.ignitions ?? {}));
    expect(ignitions(back.configs)).toEqual(ignitions(source.savedConfigs));
    expect(ignitions(back.configs).flat().length).toBeGreaterThan(0);
  }, 60_000);

  it('never writes the source state, and empties inactive configurations the exporter would keep', async () => {
    const source = await opened(bytes('lemiv-motors.ork'), 'lemiv-motors.ork');
    const before = structuredClone(source);
    expect(source.savedConfigs.some(c => c.id !== source.activeConfigId && Object.keys(c.motors).length > 0)).toBe(true);
    const p = motorFreeProjection(source);
    expect(source).toEqual(before);
    expect(p.savedConfigs.every(c => Object.keys(c.motors).length === 0 && !('unmatchedRefs' in c))).toBe(true);
    // exportOrk's `motors: {}` replaces only the ACTIVE set: the projection is what clears the rest.
    const plain = exportOrk({ name: 'x', tree: source.tree, motors: {}, configs: source.savedConfigs.map(c => ({ ...c,
      motors: Object.fromEntries(Object.entries(c.motors).map(([id, m]) => [id, { designation: m.spec.designation, diameter: m.spec.diameter, length: m.spec.length, delay: 5 }])) })),
    activeConfigId: source.activeConfigId });
    expect(plain).toContain('<motor ');
    expect(motorFreeOrk(p)).not.toContain('<motor ');
  }, 60_000);

  it('projects the same upload identically although its process ids differ', async () => {
    const a = await opened(bytes('Show-off.CDX1'), 'Show-off.CDX1');
    const b = await opened(bytes('Show-off.CDX1'), 'Show-off.CDX1');
    expect(a.tree.components[0]!.id).not.toBe(b.tree.components[0]!.id);
    expect(motorFreeProjection(b)).toEqual(motorFreeProjection(a));
    expect(motorFreeOrk(motorFreeProjection(b))).toBe(motorFreeOrk(motorFreeProjection(a)));
  }, 60_000);

  it('writes the same bytes for the same upload whatever this isolate opened before', async () => {
    const first = await describeFile(bytes('Show-off.CDX1'), 'Show-off.CDX1');
    await describeFile(bytes('lemiv-motors.ork'), 'lemiv-motors.ork');
    await simulateFile(bytes('reference.ork'), 'reference.ork', { reportSeries: 'summary', network: 'forbid' });
    await describeFile(bytes('rocksimTestRocket1.rkt'), 'rocksimTestRocket1.rkt');
    const second = await describeFile(bytes('Show-off.CDX1'), 'Show-off.CDX1');
    expect(second).toEqual(first);
    const xml = await decodeShareFragment(first.fragment);
    expect(xml).not.toMatch(/\bc\d+\b/);
  }, 120_000);

  it('the app\'s own saves keep random ids; only an injected id source is deterministic', () => {
    const tree = importOrk(referenceXml()).tree;
    const ids = (xml: string) => [...xml.matchAll(/<id>([^<]+)<\/id>/g)].map(m => m[1]);
    const a = ids(exportOrk({ name: 'x', tree })), b = ids(exportOrk({ name: 'x', tree }));
    expect(a.length).toBeGreaterThan(1);
    expect(a.some((id, i) => id !== b[i])).toBe(true);
    let n = 0;
    const counter = () => `id-${++n}`;
    const c = exportOrk({ name: 'x', tree, newId: counter });
    n = 0;
    expect(exportOrk({ name: 'x', tree, newId: counter })).toBe(c);
  });

  it('a share link written by release v0.100 still decodes and describes like the file it came from', async () => {
    // __fixtures__/share-link-v0.100.txt: reference.ork opened, saved and encoded by v0.100's own
    // importOrk, exportOrk and encodeShareFragment (7e41330, 2026-09-03). Never regenerate it with today's code.
    const old = readFileSync(join(repoRoot(), 'packages', 'app', 'src', 'services', '__fixtures__', 'share-link-v0.100.txt'), 'utf8').trim();
    expect(old.startsWith('#d=1.')).toBe(true);
    const xml = await decodeShareFragment(old);
    expect(importOrk(xml).name).toBe('Reference Rocket');
    const fromLink = await describeFile(ork(xml), 'old-link.ork');
    const fromFile = await describeFile(bytes('reference.ork'), 'reference.ork');
    expect(fromLink.mounts).toEqual(fromFile.mounts);
    for (const key of ['lengthM', 'referenceDiameterM', 'dryMassKg', 'dryCgM', 'cpM', 'stabilityCalibers'] as const) {
      close(fromLink.analysis[key], fromFile.analysis[key]!);
    }
    close(fromLink.analysis.cdEstimate.value, fromFile.analysis.cdEstimate.value!);
    expect((await describeFile(ork(xml), 'old-link.ork')).fragment.startsWith('#d=1.')).toBe(true);
  }, 60_000);

  it('existing #d=1. links still decode, and the size refusals are named without changing their words', async () => {
    const appLink = await encodeShareFragment(referenceXml());
    expect(importOrk(await decodeShareFragment(appLink)).name).toBe('Reference Rocket');
    const tooMuchXml = await encodeShareFragment('x'.repeat(MAX_INFLATED_BYTES + 1)).catch((e: unknown) => e);
    let seed = 1;
    const noise = Array.from({ length: MAX_FRAGMENT_CHARS }, () => String.fromCharCode(33 + ((seed = (seed * 48271) % 2147483647) % 90))).join('');
    const tooLong = await encodeShareFragment(noise).catch((e: unknown) => e);
    for (const e of [tooMuchXml, tooLong]) {
      expect(e).toMatchObject({ name: SHARE_TOO_LARGE_ERROR_NAME, message: 'This design is too large for a share link — send the .ork file instead.' });
    }
  }, 60_000);
});

afterEach(() => resetKernelForTests());
