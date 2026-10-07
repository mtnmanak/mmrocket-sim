import { describe, expect, it } from 'vitest';
import { canReplayDelays, delayMountsOf, LATE_BURNOUT_CAUTION, resolutionMatches, resolutionMatchesPolicy, solveAutoDelays, validDelayResolution } from './autoDelaySolver.js';
import { probeFlight, testMotor } from './autoDelay.testSupport.js';

const mounts = () => delayMountsOf([['a', testMotor()], ['b', testMotor()]], { a: 'Core', b: 'Booster MMT' });
const solve = (probe = () => probeFlight()) => solveAutoDelays({ mounts: mounts(), probe, budget: { probes: 0 }, yieldToUi: async () => {} });

describe('per-mount recovery-free fixed point', () => {
  it('uses each absolute burnout and verifies the simultaneously updated vector', async () => {
    const vectors: number[][] = [];
    const r = await solveAutoDelays({ mounts: mounts(), budget: { probes: 0 }, yieldToUi: async () => {}, probe: (v) => {
      vectors.push([...v.values()]); return probeFlight();
    } });
    expect(vectors).toEqual([[0, 0], [10, 7]]);
    expect(r.mounts.map((m) => m.flownDelay)).toEqual([10, 7]);
    expect(r.mounts[1]!.burnoutTime).toBe(5); // air-start timestamp, not its 2 s curve duration
    expect(validDelayResolution(r)).toBe(true);
  });

  it('follows detached parallel/axial carriers with duplicate names and inherited burnouts', async () => {
    const result = probeFlight(['a']);
    const child = probeFlight(['b'], 8).delayProbe!.branches[0]!;
    child.id = 'separated'; child.parentId = 'carrier'; child.separationTime = 3;
    result.delayProbe!.branches[0]!.events.push({ type: 'BURNOUT', time: 2, motorMountId: 'b' });
    result.delayProbe!.branches.push(child);
    const r = await solve(() => result);
    expect(r.mounts.map((m) => [m.branchId, m.flownDelay])).toEqual([['carrier', 10], ['separated', 6]]);
  });

  it('retains an ancestral peak and selects the highest completed peak before landing', async () => {
    const p = probeFlight();
    const b = p.delayProbe!.branches[0]!;
    b.series.time = [0, 9, 11, 15, 19, 21, 40];
    b.series.altitude = [0, 100, 100, 60, 80, 80, 0];
    b.series['Vz'] = [0, 1, -1, 1, 1, -1, -10];
    expect((await solve(() => p)).mounts[0]!.apogeeTime).toBe(10);
  });

  it('iterates charge-controlled targets instead of stopping after one update', async () => {
    const vectors: number[][] = [];
    const r = await solveAutoDelays({ mounts: mounts(), budget: { probes: 0 }, yieldToUi: async () => {}, probe: (v) => {
      vectors.push([...v.values()]); return probeFlight(undefined, v.get('b') === 0 ? 12 : 14);
    } });
    expect(vectors).toEqual([[0, 0], [10, 7], [12, 9]]);
    expect(r.probes).toBe(3);
  });

  it('refuses a two-cycle', async () => {
    let count = 0;
    await expect(solve(() => { count++; return probeFlight(undefined, count % 2 ? 12 : 13); })).rejects.toThrow('repeats');
    expect(count).toBe(3);
  });

  it('caps at eight probes, including a prior model attempt', async () => {
    const budget = { probes: 6 }; let count = 0;
    await expect(solveAutoDelays({ mounts: mounts(), budget, yieldToUi: async () => {}, probe: () => probeFlight(undefined, 12 + count++) }))
      .rejects.toThrow('eight target probes');
    expect(count).toBe(2); expect(budget.probes).toBe(8);
  });

  it.each([
    ['old artifact', (p: ReturnType<typeof probeFlight>) => { delete p.delayProbe; }],
    ['no carrier', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches[0]!.mountIds = []; }],
    ['ambiguous carrier', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches.push(p.delayProbe!.branches[0]!); }],
    ['no ignition/burnout', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches[0]!.events = [{ type: 'GROUND_HIT', time: 40 }]; }],
    ['conflicting burnouts', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches[0]!.events.push({ type: 'BURNOUT', time: 3, motorMountId: 'a' }); }],
    ['truncation', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches[0]!.events.pop(); }],
    ['abort', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches[0]!.events.push({ type: 'SIM_ABORT', time: 20 }); }],
    ['recovery', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches[0]!.events.push({ type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 2 }); }],
    ['missing ancestor', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches[0]!.parentId = 'missing'; }],
    ['child without parent', (p: ReturnType<typeof probeFlight>) => { const child = p.delayProbe!.branches[0]!; p.delayProbe!.branches.unshift({ ...child, id: 'empty', mountIds: [] }); }],
    ['burnout after landing', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches[0]!.events[0]!.time = 41; }],
    ['no peak', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches[0]!.series['Vz'] = [0, 1, 2, 3]; }],
    ['missing trace', (p: ReturnType<typeof probeFlight>) => { delete p.delayProbe!.branches[0]!.series['Vz']; }],
    ['trace length', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches[0]!.series['Vz']!.push(0); }],
    ['missing sample', (p: ReturnType<typeof probeFlight>) => { p.delayProbe!.branches[0]!.series['Vz']![1] = null; }],
  ])('refuses %s and names the mount', async (name, change) => {
    const p = probeFlight(); change(p);
    const reason: Record<string, string> = {
      'old artifact': 'telemetry', 'no carrier': 'carrier branch', 'ambiguous carrier': 'carrier branch',
      'no ignition/burnout': 'actual motor burnout', 'conflicting burnouts': 'actual motor burnout',
      truncation: 'before landing', abort: 'aborted', recovery: 'recovery was active', 'missing ancestor': 'ancestry',
      'burnout after landing': 'after landing', 'no peak': 'completed ballistic apogee',
      'missing trace': 'trace is incomplete', 'trace length': 'trace is incomplete', 'missing sample': 'missing samples',
      'child without parent': 'ancestry',
    };
    await expect(solve(() => p)).rejects.toThrow(new RegExp(`Core.*${reason[name]}.*Choose a fixed delay`));
  });

  it('clamps a negative optimum and retains its caution', async () => {
    const p = probeFlight(); p.delayProbe!.branches[0]!.events[1]!.time = 15;
    const r = await solve(() => p);
    expect(r.mounts[1]).toMatchObject({ rawOptimum: -3, flownDelay: 0, caution: LATE_BURNOUT_CAUTION });
    expect(validDelayResolution(r)).toBe(true);
  });

  it('rounds fractional targets to the nearest whole second', async () => {
    const r = await solve(() => probeFlight(undefined, 12.6));
    expect(r.mounts.map((m) => m.flownDelay)).toEqual([11, 8]);
  });

  it('preserves manual and plugged settings; saves plugged as JSON-safe text', async () => {
    const input = [...mounts(), ...delayMountsOf([['manual', testMotor(false, 3)], ['plugged', testMotor(false, Infinity)]])];
    const r = await solveAutoDelays({ mounts: input, budget: { probes: 0 }, yieldToUi: async () => {}, probe: (v) => {
      expect(v.get('manual')).toBe(3); expect(v.get('plugged')).toBe(Infinity); return probeFlight();
    } });
    expect(r.mounts.slice(2).map((m) => m.flownDelay)).toEqual([3, 'plugged']);
    expect(resolutionMatches(JSON.parse(JSON.stringify(r)), input)).toBe(true);
  });

  it('does no target simulation with fixed-only mounts', async () => {
    const r = await solveAutoDelays({ mounts: delayMountsOf([['a', testMotor(false, 2)]]), budget: { probes: 0 }, probe: () => { throw new Error('unexpected probe'); } });
    expect(r.probes).toBe(0); expect(validDelayResolution(r)).toBe(true);
  });

  it('honors cancellation after a probe without accepting a vector', async () => {
    const controller = new AbortController(); let calls = 0;
    await expect(solveAutoDelays({ mounts: mounts(), budget: { probes: 0 }, signal: controller.signal,
      probe: () => { calls++; return probeFlight(); }, yieldToUi: async () => { controller.abort(); },
    })).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('rejects malformed, partial and policy-mismatched persisted vectors', async () => {
    const r = await solve();
    expect(resolutionMatches(r, mounts())).toBe(true);
    for (const bad of [null, {}, { ...r, policy: 'old' }, { ...r, probes: 9 }, { ...r, mounts: r.mounts.slice(1) },
      { ...r, mounts: [r.mounts[0], r.mounts[0]] }, { ...r, mounts: r.mounts.map((m) => ({ ...m, flownDelay: null })) },
      { ...r, mounts: [...r.mounts, { ...r.mounts[0], mountId: 'extra' }] },
      { ...r, mounts: r.mounts.map((m) => ({ ...m, rawOptimum: 999 })) },
      { ...r, mounts: r.mounts.map((m) => ({ ...m, caution: {} })) }]) {
      expect(resolutionMatches(bad, mounts())).toBe(false);
      expect(resolutionMatchesPolicy(bad, mounts())).toBe(false);
    }
    const differentlyNamed = { ...r, mounts: r.mounts.map(m => ({ ...m, motorIdentity: 'other' })) };
    expect(resolutionMatches(differentlyNamed, mounts())).toBe(false);
    expect(resolutionMatchesPolicy(differentlyNamed, [...mounts()].reverse())).toBe(true);
    const changed = mounts(); changed[1]!.mode = 'manual'; changed[1]!.delay = 7;
    expect(resolutionMatches(r, changed)).toBe(false);
    expect(resolutionMatchesPolicy(r, changed)).toBe(false);
  });

  it('rejects invented branch evidence on fixed records', async () => {
    const r = await solveAutoDelays({ mounts: delayMountsOf([['a', testMotor(false, 2)]]), budget: { probes: 0 }, probe: () => probeFlight() });
    expect(validDelayResolution(r)).toBe(true);
    for (const field of ['burnoutTime', 'apogeeTime', 'branchId', 'branchName']) {
      expect(validDelayResolution({ ...r, mounts: [{ ...r.mounts[0], [field]: 1 }] })).toBe(false);
    }
  });

  it('validates persisted evidence independently of current motor matching', async () => {
    const r = await solve();
    for (const change of [
      { mounts: [] }, { probes: -1 }, { probes: 0.5 }, { probes: 9 }, { probes: 0 },
      { elapsedMs: -1 }, { elapsedMs: NaN }, { mounts: [r.mounts[0], r.mounts[0]] },
    ]) expect(validDelayResolution({ ...r, ...change })).toBe(false);
    for (const change of [
      { mountId: '' }, { mountName: 1 }, { motorIdentity: 1 }, { status: 'fixed' },
      { flownDelay: null }, { rawOptimum: NaN }, { rawOptimum: 999 }, { burnoutTime: -1 },
      { apogeeTime: -1 }, { burnoutTime: 3 }, { recommendedDelay: 11, flownDelay: 11 }, { flownDelay: 11 },
      { branchId: null }, { branchName: null }, { exception: 'unknown' },
    ]) expect(validDelayResolution({ ...r, mounts: [{ ...r.mounts[0], ...change }, r.mounts[1]] })).toBe(false);
    const late = await solve(() => { const p = probeFlight(); p.delayProbe!.branches[0]!.events[0]!.time = 15; return p; });
    delete late.mounts[0]!.caution;
    expect(validDelayResolution(late)).toBe(false);
    const fixed = delayMountsOf([['a', testMotor(false, 2)]]);
    const f = await solveAutoDelays({ mounts: fixed, budget: { probes: 0 }, probe: () => probeFlight() });
    expect(resolutionMatches(f, [{ ...fixed[0]!, delay: 3 }])).toBe(false);
    expect(resolutionMatchesPolicy(f, [{ ...fixed[0]!, delay: 3 }])).toBe(false);
  });

  it('allows unambiguous legacy replay and refuses ambiguous multi-mount scalars', async () => {
    const assigned: [string, ReturnType<typeof testMotor>][] = [['a', testMotor()], ['b', testMotor()]];
    expect(canReplayDelays(undefined, assigned, 'a', 7)).toBe(false);
    expect(canReplayDelays(undefined, assigned.slice(0, 1), 'a', 7)).toBe(true);
    expect(canReplayDelays(undefined, assigned.slice(0, 1), 'a', NaN)).toBe(false);
    expect(canReplayDelays(undefined, assigned.slice(0, 1), 'missing', 7)).toBe(false);
    const fixed: typeof assigned = [['a', testMotor(false, 3)], ['b', testMotor(false, 5)]];
    expect(canReplayDelays(undefined, fixed, 'a', 3)).toBe(true);
    expect(canReplayDelays(undefined, fixed, 'a', 4)).toBe(false);
    const resolution = await solve();
    expect(canReplayDelays(resolution, assigned, 'a', 10)).toBe(true);
    expect(canReplayDelays(resolution, assigned, 'a', 7)).toBe(false);
  });
});
