import { describe, expect, it, vi } from 'vitest';
import type { FlightResult, RocketTree } from '@online-openrocket/engine';
import { asymmetricThrustWarnings, longestLoneBurn, thrustImbalance, type ThrustSite } from './asymmetricThrust.js';
import { balanceMotor, balanceTree } from './asymmetricThrust.testSupport.js';
import { aftLayout } from '../tree/aftLayout.js';
import { mountMotorCount } from '../tree/treeModel.js';
import { MOTOR_DB } from './motorDb.js';
import { loadCatalogueMotor } from './motorMatch.js';
import { bundleHasCurve, bundledOnlyFetchSpec } from './thrustcurve.js';

it('r5 lone-burn producer needs no network when the bundled chunk fails', async () => {
  const row = MOTOR_DB[0]!;
  const fetch = vi.fn(() => { throw new Error('network forbidden'); });
  vi.stubGlobal('fetch', fetch);
  vi.resetModules();
  vi.doMock('../data/motorCurves.json', () => { throw new Error('chunk failed'); });
  try {
    const { loadCatalogueMotor: load } = await import('./motorMatch.js');
    const { bundledOnlyFetchSpec: fetchSpec } = await import('./thrustcurve.js');
    await expect(load(row.manufacturerAbbrev, row.designation, 5, { fetchSpec })).rejects.toThrow(/bundled|network/);
    // Exercise the changed producer with already-loaded flight inputs even
    // when the catalogue chunk cannot provide another motor.
    const { asymmetricThrustWarnings: warnings } = await import('./asymmetricThrust.js');
    expect(warnings(balanceTree(2), [['m0', balanceMotor()]])).toContainEqual(
      expect.objectContaining({ key: 'ASYMMETRIC_THRUST_LONE' }));
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock('../data/motorCurves.json'); vi.resetModules(); vi.unstubAllGlobals();
  }
});

const entries = (motors = [balanceMotor(), balanceMotor(), balanceMotor(), balanceMotor()]) =>
  motors.map((m, i) => [`m${i}`, m] as const);
const site = (y: number, peak = 100, burn = 2): ThrustSite => ({
  y, z: 0, spec: balanceMotor(peak, burn).spec, ignition: 0, mountId: String(y), name: String(y),
});

describe('row 127 thrust balance', () => {
  it.each([[1.55, null, [0, 1.2, 2]], [1.49, [1.49, 2], [0, 1, 1.6, 2]], [1.2, [1.2, 2], [0, 1, 1.6, 2]]] as const)(
    'A25:4-2 splits lone-burn intervals at separation %s between samples', (separation, expected, times) => {
      const sites = [site(-0.2), site(0.2)];
      for (const s of sites) { s.spec.times = [...times]; s.spec.thrusts = times.map(() => 100); }
      sites[0]!.separation = separation;
      const lone = longestLoneBurn(sites);
      if (expected === null) expect(lone).toBeNull();
      else {
        expect(lone?.start).toBeCloseTo(expected[0], 10);
        expect(lone?.end).toBeCloseTo(expected[1], 10);
      }
    });
  it('J4 r2 S7b-g4 gives a whitespace-only serial stage warning a readable name', () => {
    const tree = balanceTree(2);
    tree.components[0]!.name = '   ';
    tree.components.push({ type: 'stage', id: 'lower', children: [] });
    const warning = asymmetricThrustWarnings(tree, entries([balanceMotor()]))[0]!;
    expect(warning.message).toMatch(/^Stage Stage:/);
  });

  it('r3 names an asymmetric firing mount with the same number as its card', () => {
    const tree = balanceTree();
    tree.components[0]!.children![0]!.children!.forEach(m => { m.name = 'Inner Tube'; });
    expect(asymmetricThrustWarnings(tree, entries([balanceMotor()]))[0]?.message).toContain('Firing then: Inner Tube 1.');
  });
  it.each([1, 2.45])('A25:4-2 detects lone attached thrust after a strap-on separates at %s s', separation => {
    const tree = balanceTree(1);
    const body = tree.components[0]!.children![0]!;
    body.children = [0, Math.PI].map((angle, i) => ({ type: 'parallelstage', id: `p${i}`, instanceCount: 1,
      radiusMethod: 'free', radiusOffset: 0.2, angleOffset: angle, children: [
        { type: 'bodytube', id: `strap${i}`, name: `Strap ${i}`, motorMount: true, length: 0.3, outerRadius: 0.02 },
      ] }));
    const motors = [['strap0', balanceMotor(100, 3)], ['strap1', balanceMotor(100, 3)]] as const;
    const result = { events: [
      { type: 'IGNITION', motorMountId: 'strap0', time: 0 }, { type: 'IGNITION', motorMountId: 'strap1', time: 0 },
      { type: 'STAGE_SEPARATION', sourceId: 'p0', time: separation },
    ] } as unknown as FlightResult;
    expect(asymmetricThrustWarnings(tree, motors, result)[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
    expect(asymmetricThrustWarnings(tree, motors, result)).toContainEqual(expect.objectContaining({ key: 'ASYMMETRIC_THRUST_LONE' }));
    result.events.pop();
    expect(asymmetricThrustWarnings(tree, motors, result)).toEqual([]);
  });
  it('r6 stops a nested strap-on balancing the core when its carrying strap-on separates', () => {
    const tree = balanceTree(1);
    const body = tree.components[0]!.children![0]!;
    body.children = [0, Math.PI].map((angle, i) => ({ type: 'parallelstage', id: `p${i}`, instanceCount: 1,
      radiusMethod: 'free', radiusOffset: 0.2, angleOffset: angle, children: [
        { type: 'bodytube', id: `strap${i}`, name: `Strap ${i}`, motorMount: i === 1,
          length: 0.3, outerRadius: 0.02, children: i === 0 ? [
            { type: 'parallelstage', id: 'nested', instanceCount: 1, radiusMethod: 'free', radiusOffset: 0,
              children: [{ type: 'bodytube', id: 'nestedMotor', name: 'Nested motor', motorMount: true,
                length: 0.3, outerRadius: 0.02 }] },
          ] : [] },
      ] }));
    const motors = [['nestedMotor', balanceMotor(100, 3)], ['strap1', balanceMotor(100, 3)]] as const;
    const result = { events: [
      { type: 'IGNITION', motorMountId: 'nestedMotor', time: 0 }, { type: 'IGNITION', motorMountId: 'strap1', time: 0 },
      { type: 'STAGE_SEPARATION', sourceId: 'p0', time: 1 },
    ] } as unknown as FlightResult;
    const warning = asymmetricThrustWarnings(tree, motors, result);
    // Ruling 155 (J23): Strap 1 burning alone for 2 s after the separation also earns the lone-burn Caution.
    expect(warning.map(w => w.key)).toEqual(['ASYMMETRIC_THRUST_DANGER', 'ASYMMETRIC_THRUST_LONE']);
    expect(warning[0]?.message).toContain('Firing then: Strap 1.');
    expect(warning[1]?.message).toContain('for 2 s (1–3 s after launch)');
    // A later separation of the nested stage cannot postpone its parent's cutoff.
    result.events.push({ type: 'STAGE_SEPARATION', sourceId: 'nested', time: 3 });
    expect(asymmetricThrustWarnings(tree, motors, result)).toEqual(warning);
    // Without separation the opposite burns still balance, including before flight.
    result.events.splice(2);
    expect(asymmetricThrustWarnings(tree, motors, result)).toEqual([]);
    expect(asymmetricThrustWarnings(tree, motors)).toEqual([]);
  });

  it('r4 a qualifying shipped curve names a lone burn without pinning upstream motors', async () => {
    // The exact owner examples are measurements in the opt-in corpus harness.
    // CI selects from today's bundle; a refresh may change names and curves.
    let checked = false;
    for (const row of MOTOR_DB) {
      if (row.burnTimeS < 0.5 || (await bundleHasCurve(row.motorId)) !== true) continue;
      const motor = (await loadCatalogueMotor(row.manufacturerAbbrev, row.designation, 10,
        { fetchSpec: bundledOnlyFetchSpec }))!;
      const { times, thrusts } = motor.spec;
      const duration = times.at(-1)! - times[0]!;
      const impulse = times.slice(1).reduce((sum, t, i) => sum + (t - times[i]!) * (thrusts[i]! + thrusts[i + 1]!) / 2, 0);
      if (duration < 0.5 || impulse / duration < Math.max(...thrusts) * 0.05) continue;
      const warnings = asymmetricThrustWarnings(balanceTree(2), entries([motor]));
      expect(warnings[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
      expect(warnings.some(w => w.key === 'ASYMMETRIC_THRUST_LONE')).toBe(true);
      checked = true;
      break;
    }
    expect(checked, 'a bundled curve qualifying for the owner lone-burn gate').toBe(true);
  }, 60_000);
  it('J23 names the whole lone burn when only one off-axis motor is loaded', () => {
    const warnings = asymmetricThrustWarnings(balanceTree(2), entries([balanceMotor()]));
    expect(warnings[0]!.key).toBe('ASYMMETRIC_THRUST_DANGER');
    expect(warnings).toContainEqual(expect.objectContaining({ key: 'ASYMMETRIC_THRUST_LONE',
      message: expect.stringContaining('burns alone off-axis for 2 s') }));
  });
  it('J23 adds the longest 2.8 s lone-burn Caution while keeping the peak rating', () => {
    const motors = entries([balanceMotor(100, 4.4), balanceMotor(200, 1.6), balanceMotor(200, 1.6), balanceMotor(200, 1.6)]);
    const warnings = asymmetricThrustWarnings(balanceTree(), motors);
    expect(warnings[0]!.key).toBe('ASYMMETRIC_THRUST_CAUTION');
    expect(warnings[0]!.message).toContain('14.3 %');
    expect(warnings).toContainEqual(expect.objectContaining({ key: 'ASYMMETRIC_THRUST_LONE',
      message: expect.stringContaining('“Mount 1” burns alone off-axis for 2.8 s') }));
    const danger = asymmetricThrustWarnings(balanceTree(), entries([
      balanceMotor(200, 4.4), balanceMotor(100, 1.6), balanceMotor(100, 1.6), balanceMotor(100, 1.6),
    ]));
    expect(danger[0]!.key).toBe('ASYMMETRIC_THRUST_DANGER');
    expect(danger.some(w => w.key === 'ASYMMETRIC_THRUST_LONE')).toBe(true);
  });
  it('r2 gates lone burns by duration and average thrust, including threshold equality', () => {
    const warnings = (burn: number, force: number) => {
      const motors = [balanceMotor(force, burn), balanceMotor(100, 1)];
      for (const m of motors) { m.spec.times = [0, m.spec.times.at(-1)!]; m.spec.thrusts = [m.spec.thrusts[1]!, m.spec.thrusts[1]!]; }
      return asymmetricThrustWarnings(balanceTree(2), entries(motors)).filter(w => w.key === 'ASYMMETRIC_THRUST_LONE');
    };
    expect(warnings(1.49, 100)).toEqual([]);
    expect(warnings(1.5, 100)).toHaveLength(1);
    expect(warnings(4, 1)).toEqual([]);
    expect(warnings(4, 100 / 19)).toHaveLength(1);
    expect(warnings(4, 5)).toEqual([]);
  });
  it('r2 labels upper-stage lone endpoints relative to first ignition', () => {
    const tree = balanceTree(2);
    tree.components.push({ type: 'stage', id: 'booster', children: [] });
    const motors = entries([balanceMotor(100, 4), balanceMotor(100, 1)]);
    for (const [, motor] of motors) motor.ignition = { event: 'burnout', delay: 5 };
    const lone = asymmetricThrustWarnings(tree, motors).find(w => w.key === 'ASYMMETRIC_THRUST_LONE');
    expect(lone?.message).toContain('(1–4 s after ignition)');
  });
  it('r2 averages the whole continuous lone interval rather than a stronger prefix', () => {
    const tail = balanceMotor(100, 20), other = balanceMotor(100, 1);
    tail.spec.times = [0, 1, 1.6, 1.7, 20];
    tail.spec.thrusts = [100, 100, 100, 1, 1];
    const warnings = asymmetricThrustWarnings(balanceTree(2), entries([tail, other]));
    expect(warnings.some(w => w.key === 'ASYMMETRIC_THRUST_LONE')).toBe(false);
  });
  it('gives exact zero for identical symmetric motors and opposite pairs of different motors', () => {
    expect(thrustImbalance([site(1), site(-1)]).fraction).toBe(0);
    expect(asymmetricThrustWarnings(balanceTree(), entries())).toEqual([]);
    expect(asymmetricThrustWarnings(balanceTree(), entries([
      balanceMotor(200, 4), balanceMotor(), balanceMotor(200, 4), balanceMotor(),
    ]))).toEqual([]);
    const ring = balanceTree(1);
    Object.assign(ring.components[0]!.children![0]!.children![0]!, { cluster: '4-ring', radialPosition: 0 });
    expect(asymmetricThrustWarnings(ring, entries([balanceMotor()]))).toEqual([]);
  });
  it('one loaded tube opposite an empty tube gives 100 % and Danger', () => {
    expect(thrustImbalance([site(1)]).fraction).toBeCloseTo(1, 12);
    expect(asymmetricThrustWarnings(balanceTree(2), entries([balanceMotor()]))[0]?.key)
      .toBe('ASYMMETRIC_THRUST_DANGER');
  });
  it('finds the worst moment after three shorter motors burn out', () => {
    const motors = entries([balanceMotor(200, 4), balanceMotor(160, 1), balanceMotor(160, 1), balanceMotor(160, 1)]);
    const warning = asymmetricThrustWarnings(balanceTree(), motors)[0]!;
    expect(warning.key).toBe('ASYMMETRIC_THRUST_DANGER');
    expect(warning.message).toContain('Firing then: Mount 1.');
    expect(warning.message).toContain('cartwheel');
    expect(warning.message).toContain('simulation does not show this turn');
  });
  it.each([[0.049, undefined], [0.05, 'ASYMMETRIC_THRUST_CAUTION'],
    [0.199, 'ASYMMETRIC_THRUST_CAUTION'], [0.20, 'ASYMMETRIC_THRUST_DANGER']] as const)(
    'classifies fraction %s against the owner thresholds', (fraction, key) => {
      const motorA = balanceMotor(100 * (1 + fraction));
      const motorB = balanceMotor(100 * (1 - fraction));
      const got = asymmetricThrustWarnings(balanceTree(2), entries([motorA, motorB]));
      expect(got[0]?.key).toBe(key);
      if (key === 'ASYMMETRIC_THRUST_CAUTION') expect(got[0]?.message).not.toContain('cartwheel');
    });
  it('excludes never-lit motors and ignores an entirely axial loadout', () => {
    const never = { ...balanceMotor(), ignition: { event: 'never' as const, delay: 0 } };
    expect(asymmetricThrustWarnings(balanceTree(2), entries([balanceMotor(), never]))[0]?.key)
      .toBe('ASYMMETRIC_THRUST_DANGER');
    expect(asymmetricThrustWarnings(balanceTree(2), entries([never, never]))).toEqual([]);
    const tree = balanceTree(1);
    tree.components[0]!.children![0]!.children![0]!.radialPosition = 0;
    expect(asymmetricThrustWarnings(tree, entries([balanceMotor()]))).toEqual([]);
  });
  it('counts a centre motor in total thrust without inventing a moment', () => {
    expect(thrustImbalance([site(1), site(-1), site(0, 300, 5)]).fraction).toBe(0);
  });
  it('warns for a single off-axis pod and an off-centre cluster', () => {
    const tree = balanceTree(1);
    Object.assign(tree.components[0]!.children![0]!.children![0]!, { cluster: '4-ring' });
    expect(asymmetricThrustWarnings(tree, entries([balanceMotor()]))[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
    tree.components[0]!.children![0]!.children = [{ type: 'podset', instanceCount: 1,
      radiusMethod: 'free', radiusOffset: 0.3, children: [{ type: 'bodytube', length: 0.3, outerRadius: 0.04,
        id: 'pod-motor', motorMount: true }] }];
    expect(asymmetricThrustWarnings(tree, [['pod-motor', balanceMotor()]])[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
  });
  it('uses peak total thrust so a tiny unmatched tail cannot set off a warning', () => {
    const tail = site(1);
    tail.spec = { ...tail.spec, times: [0, 0.1, 1, 1.1, 2], thrusts: [0, 100, 100, 1, 0] };
    const other = site(-1);
    other.spec = { ...other.spec, times: [0, 0.1, 1, 1.1], thrusts: [0, 100, 100, 0] };
    expect(thrustImbalance([tail, other]).fraction).toBeLessThan(0.05);
  });
  it('counts staggered launch ignition and sanitizes mount names', () => {
    const tree = balanceTree(2);
    tree.components[0]!.children![0]!.children![0]!.name = 'Left\n\u202e';
    const delayed = { ...balanceMotor(), ignition: { event: 'launch' as const, delay: 3 } };
    const warning = asymmetricThrustWarnings(tree, entries([balanceMotor(), delayed]))[0]!;
    expect(warning.key).toBe('ASYMMETRIC_THRUST_DANGER');
    expect(warning.message).toContain('[U+202E]');
    expect(warning.message).not.toMatch(/[\n\u202e]/u);
  });
  it('discloses unknown timing before flight, uses recorded ignition, and excludes motors that never lit', () => {
    const air = { ...balanceMotor(), ignition: { event: 'burnout' as const, delay: 0 } };
    const motors = entries([air, air]);
    const tree = balanceTree(2);
    expect(asymmetricThrustWarnings(tree, motors)).toEqual([]); // One balanced co-ignited set.
    expect(asymmetricThrustWarnings(tree, [['m0', air]])[0]?.message).toContain('checked again on the launch report');
    const result = { events: [], branches: [{ events: [
      { type: 'IGNITION', motorMountId: 'm0', time: 2 },
      { type: 'IGNITION', motorMountId: 'm1', time: 2 },
    ] }] } as unknown as FlightResult;
    expect(asymmetricThrustWarnings(tree, motors, result)).toEqual([]);
    result.branches![0]!.events[1]!.time = 5;
    expect(asymmetricThrustWarnings(tree, motors, result)[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
    result.branches = [];
    expect(asymmetricThrustWarnings(tree, motors, result)).toEqual([]);
  });
  it('round 2 checks both limits of nonzero cutoff and ignition samples', () => {
    const a = site(1), b = site(-1);
    a.spec = { ...a.spec, times: [0, 0.1, 1], thrusts: [0, 100, 100] };
    b.spec = { ...b.spec, times: [0, 0.1, 1, 2], thrusts: [0, 100, 100, 0] };
    const cutoff = thrustImbalance([a, b]);
    expect(cutoff.fraction).toBeCloseTo(0.5, 12);
    expect(cutoff.firing).toEqual([b.name]);
    expect(asymmetricThrustWarnings(balanceTree(2), entries([
      { ...balanceMotor(), spec: a.spec }, { ...balanceMotor(), spec: b.spec },
    ]))[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
    a.spec = { ...a.spec, times: [1, 2], thrusts: [100, 0] };
    b.spec = { ...b.spec, times: [0, 1, 2], thrusts: [0, 100, 0] };
    expect(thrustImbalance([a, b]).fraction).toBeCloseTo(0.5, 12);
  });
  it('round 2 shares overlapping core and parallel burns, including upper-core strap-ons', () => {
    const tree = balanceTree(1);
    const body = tree.components[0]!.children![0]!;
    body.children![0]!.radialPosition = 0;
    for (const [i, angle] of [Math.PI / 2, 3 * Math.PI / 2].entries()) {
      body.children!.push({ type: 'parallelstage', instanceCount: 1, radiusMethod: 'free',
        radiusOffset: 0.2, angleOffset: angle, children: [{ type: 'bodytube', id: `strap${i}`,
          motorMount: true, length: 0.3, outerRadius: 0.02 }] });
    }
    const motors = [...entries([balanceMotor(800)]), ['strap0', balanceMotor()], ['strap1', balanceMotor()]] as const;
    expect(asymmetricThrustWarnings(tree, motors)).toEqual([]);
    const mismatched = [...entries([balanceMotor(800)]), ['strap0', balanceMotor(200)], ['strap1', balanceMotor(100)]] as const;
    const warning = asymmetricThrustWarnings(tree, mismatched);
    expect(warning).toHaveLength(1);
    expect(warning[0]?.key).toBe('ASYMMETRIC_THRUST_CAUTION');
    expect(warning[0]?.message).toContain('9.09 %');
    tree.components.push({ type: 'stage', id: 'lower', children: [] });
    expect(asymmetricThrustWarnings(tree, [['strap0', balanceMotor()], ['strap1', balanceMotor()]])).toEqual([]);
    expect(asymmetricThrustWarnings(tree, [['strap0', balanceMotor()]])[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
  });
  it('round 4 checks recorded serial stages separately even when burns overlap', () => {
    const tree = balanceTree(1), upper = structuredClone(tree.components[0]!);
    upper.children![0]!.children![0]!.id = 'upper';
    upper.children![0]!.children![0]!.radialDirection = Math.PI;
    tree.components.unshift(upper);
    const motors = [...entries([balanceMotor()]), ['upper', balanceMotor()]] as const;
    const flight = { events: [{ type: 'IGNITION', motorMountId: 'm0', time: 0 },
      { type: 'IGNITION', motorMountId: 'upper', time: 0 }], branches: [] } as unknown as FlightResult;
    expect(asymmetricThrustWarnings(tree, motors, flight).map(w => w.key))
      .toEqual(['ASYMMETRIC_THRUST_DANGER', 'ASYMMETRIC_THRUST_LONE', 'ASYMMETRIC_THRUST_DANGER', 'ASYMMETRIC_THRUST_LONE']);
    flight.events[1]!.time = 3;
    flight.events.push({ type: 'STAGE_SEPARATION', sourceId: 'stage', time: 3 });
    expect(asymmetricThrustWarnings(tree, motors, flight).map(w => w.key))
      .toEqual(['ASYMMETRIC_THRUST_DANGER', 'ASYMMETRIC_THRUST_LONE', 'ASYMMETRIC_THRUST_DANGER', 'ASYMMETRIC_THRUST_LONE']);
  });
  it('round 6 retains uncertainty when the combined bound can imbalance thrust', () => {
    const tree = balanceTree(2);
    const mounts = tree.components[0]!.children![0]!.children!;
    mounts[0]!.radialPosition = 0;
    const air = { ...balanceMotor(), ignition: { event: 'burnout' as const, delay: 0 } };
    expect(asymmetricThrustWarnings(tree, entries([air, balanceMotor()]))[0]?.message).not.toContain('unknown');
    expect(asymmetricThrustWarnings(tree, entries([air, balanceMotor()]))[0]?.message).toContain('cannot tell');
    Object.assign(mounts[0]!, { cluster: '3-ring' });
    expect(asymmetricThrustWarnings(tree, entries([air]))).toEqual([]);
    mounts[0]!.radialPosition = 0.06;
    expect(asymmetricThrustWarnings(tree, entries([air]))[0]?.key).toBe('ASYMMETRIC_THRUST_UNKNOWN');
    Object.assign(mounts[0]!, { radialPosition: 0, cluster: '3-ring' });
    tree.components.push({ type: 'stage', children: [] });
    expect(asymmetricThrustWarnings(tree, entries([balanceMotor()]))).toEqual([]);
  });
  it('round 2 uses the display-name fallback for empty mount names', () => {
    const tree = balanceTree(1);
    tree.components[0]!.children![0]!.children![0]!.name = '';
    expect(asymmetricThrustWarnings(tree, entries([balanceMotor()]))[0]?.message)
      .toContain('Firing then: Motor mount.');
  });
  it('round 2 suppresses sub-millimetre thrust offsets and supplies empty mount names', () => {
    const tree = balanceTree(1), mount = tree.components[0]!.children![0]!.children![0]!;
    mount.radialPosition = 0.0005;
    expect(asymmetricThrustWarnings(tree, entries([balanceMotor()]))).toEqual([]);
    mount.radialPosition = 0.005;
    mount.name = '';
    const warning = asymmetricThrustWarnings(tree, entries([balanceMotor()]));
    expect(warning[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
    expect(warning[0]?.message).toContain('Firing then: Motor mount.');
  });
  it('round 2 excludes stale assignments on tubes that are no longer motor mounts', () => {
    const tree = balanceTree();
    tree.components[0]!.children![0]!.children![0]!.motorMount = false;
    expect(asymmetricThrustWarnings(tree, entries())[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
    expect(asymmetricThrustWarnings(tree, entries([balanceMotor()]))).toEqual([]);
    const observed: string[] = [];
    aftLayout(tree, 0, { m0: balanceMotor().spec }, undefined, id => observed.push(id));
    expect(observed).toEqual([]);
  });
  it('evaluates serial stages separately and measures one upper trigger relatively', () => {
    const tree = balanceTree(2);
    const upper = structuredClone(tree.components[0]!);
    upper.id = 'upper';
    upper.children![0]!.children = [
      { ...upper.children![0]!.children![0]!, id: 'up', radialPosition: 0 },
    ];
    tree.components.unshift(upper);
    expect(asymmetricThrustWarnings(tree, [...entries([balanceMotor(), balanceMotor()]), ['up', balanceMotor()]])).toEqual([]);
    upper.children![0]!.children![0]!.radialPosition = 0.06;
    expect(asymmetricThrustWarnings(tree, [['up', balanceMotor()]])[0]?.key).toBe('ASYMMETRIC_THRUST_DANGER');
  });
  it.each(['podset', 'parallelstage'] as const)('reuses all %s and nested cluster positions from the aft view', type => {
    const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [
      { type: 'bodytube', outerRadius: 0.2, length: 1, children: [
        { type, id: 'pods', instanceCount: 3, radiusOffset: 0.3, radiusMethod: 'free', angleOffset: 0.4, children: [
          { type: 'bodytube', length: 0.3, outerRadius: 0.04, motorMount: true, id: 'body-motor', children: [
            { type: 'innertube', id: 'm0', length: 0.2, outerRadius: 0.01, cluster: 'double',
              clusterScale: 1.4, clusterRotation: 0.5, radialPosition: 0.005, radialDirection: 0.6, motorMount: true },
          ] },
        ] },
      ] },
    ] }] };
    const positions: [number, number][] = [];
    aftLayout(tree, 0, { m0: balanceMotor().spec }, undefined, (_, y, z) => positions.push([y, z]));
    expect(positions).toHaveLength(mountMotorCount(tree, 'm0'));
    expect(positions).toHaveLength(6);
    expect(asymmetricThrustWarnings(tree, entries([balanceMotor()]))).toEqual([]);
    expect(asymmetricThrustWarnings(tree, [['body-motor', balanceMotor()]])).toEqual([]);
  });
});
