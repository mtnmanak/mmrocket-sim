import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type MotorSpec, type RocketTree } from './orkEngine.js';

// Requires the rebuilt bridge artifact. Never accept absent telemetry as a skip.
const motor: MotorSpec = {
  designation: 'C6', diameter: 0.018, length: 0.07, cgX: 0.035, ejectionDelay: 0,
  times: [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2], thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
  masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
};
const mount = (id: string): ComponentNode => ({ type: 'innertube', id, name: 'Same mount name',
  length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true,
  position: { method: 'bottom', offset: 0 } });
const fins = (crossSection: 'rounded' | 'airfoil'): ComponentNode => ({ type: 'freeformfinset',
  finCount: 3, thickness: 0.003, crossSection, points: [[0, 0], [0.02, 0.035], [0.05, 0.035], [0.07, 0]],
} as ComponentNode);
function tree(staged: boolean, crossSection: 'rounded' | 'airfoil'): RocketTree {
  return { components: [{ type: 'stage', id: 'upper', name: 'Same branch name', children: [
    { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002 },
    { type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950, children: [
      fins(crossSection), mount('a'), ...(!staged ? [mount('b')] : []),
      { type: 'parachute', id: 'recovery', diameter: 0.3, deployEvent: 'ejection' } as ComponentNode,
    ] },
  ] }, ...(staged ? [{ type: 'stage', id: 'lower', name: 'Same branch name', separationEvent: 'burnout', children: [
    { type: 'bodytube', length: 0.12, outerRadius: 0.012, thickness: 0.0003, density: 950,
      children: [fins(crossSection), mount('b')] },
  ] } as ComponentNode] : [])] };
}

describe('bridge recovery-free per-mount telemetry', () => {
  it.each(['rounded', 'airfoil'] as const)('preserves IDs, charges and absolute air-start burnout with %s freeform fins', (section) => {
    const r = OrkRocket.buildTree(tree(false, section));
    r.setMotorById('a', motor); r.setMotorById('b', motor);
    r.setMotorIgnitionById('b', 'launch', 0.4);
    const p = r.simulate({ delayProbe: true });
    expect(p.delayProbe?.version).toBe(1);
    const b = p.delayProbe!.branches[0]!;
    expect(b.mountIds).toEqual(expect.arrayContaining(['a', 'b']));
    expect(b.events.some((e) => e.type === 'RECOVERY_DEVICE_DEPLOYMENT')).toBe(false);
    for (const id of ['a', 'b']) {
      const ignition = b.events.find((e) => e.type === 'IGNITION' && e.motorMountId === id)!;
      const burnout = b.events.find((e) => e.type === 'BURNOUT' && e.motorMountId === id)!;
      const charge = b.events.find((e) => e.type === 'EJECTION_CHARGE' && e.motorMountId === id)!;
      expect(ignition.sourceId).toBe(id);
      // Event scheduling uses actual ignition + curve duration. One 0.05 s step
      // covers event-time quantization; no hard-coded trajectory expectations.
      expect(Math.abs(burnout.time - ignition.time - motor.times.at(-1)!)).toBeLessThanOrEqual(0.05);
      expect(Math.abs(charge.time - burnout.time)).toBeLessThanOrEqual(0.05);
    }
    expect(b.events.some((e) => e.type === 'GROUND_HIT')).toBe(true);
    const plain = r.simulate();
    expect(plain.delayProbe).toBeUndefined();
    expect(plain.events.some((e) => e.type === 'RECOVERY_DEVICE_DEPLOYMENT')).toBe(true);
  }, 60_000);

  it('tracks a separated booster independently of names and retains its ancestral trace', () => {
    const r = OrkRocket.buildTree(tree(true, 'airfoil'));
    r.setMotorById('a', motor); r.setMotorById('b', motor);
    r.setMotorIgnitionById('a', 'burnout', 1);
    const p = r.simulate({ delayProbe: true });
    expect(p.delayProbe!.branches).toHaveLength(2);
    const carrier = p.delayProbe!.branches.find((b) => b.mountIds.includes('b'))!;
    const upper = p.delayProbe!.branches.find((b) => b.mountIds.includes('a'))!;
    expect(carrier.id).not.toBe(upper.id); expect(carrier.name).toBe(upper.name);
    expect(carrier.parentId).toBe(upper.id);
    expect(carrier.series.time[0]).toBe(upper.series.time[0]);
    expect(carrier.events.some((e) => e.type === 'GROUND_HIT')).toBe(true);
    expect(carrier.series.time.some((t) => t < carrier.separationTime!)).toBe(true);
  }, 60_000);

  it('leaves truncation visible, rather than manufacturing a completed target', () => {
    const r = OrkRocket.buildTree(tree(false, 'rounded'));
    r.setMotorById('a', motor); r.setMotorById('b', motor);
    const p = r.simulate({ delayProbe: true, maxTime: 0.5 });
    expect(p.delayProbe?.version).toBe(1);
    expect(p.delayProbe!.branches[0]!.events.some((e) => e.type === 'GROUND_HIT')).toBe(false);
  });

  it('keeps charge-driven separation and ignition active in the recovery-free probe', () => {
    const t = tree(true, 'rounded');
    Object.assign(t.components[1]!, { separationEvent: 'ejection', separationDelay: 0 });
    const r = OrkRocket.buildTree(t);
    r.setMotorById('a', motor); r.setMotorById('b', { ...motor, ejectionDelay: 0.5 });
    r.setMotorIgnitionById('a', 'ejectioncharge', 0.2);
    const p = r.simulate({ delayProbe: true });
    const events = p.delayProbe!.branches.flatMap((b) => b.events);
    const charge = events.find((e) => e.type === 'EJECTION_CHARGE' && e.motorMountId === 'b')!;
    const ignition = events.find((e) => e.type === 'IGNITION' && e.motorMountId === 'a')!;
    const detached = p.delayProbe!.branches.find((b) => b.mountIds.includes('b'))!;
    expect(charge).toBeDefined(); expect(ignition).toBeDefined();
    expect(Math.abs(ignition.time - charge.time - 0.2)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(detached.separationTime! - charge.time)).toBeLessThanOrEqual(0.05);
    expect(events.some((e) => e.type === 'RECOVERY_DEVICE_DEPLOYMENT')).toBe(false);
  }, 60_000);

  it('attributes a separating parallel-stage ring by membership despite duplicate names', () => {
    const t = tree(false, 'airfoil');
    const body = t.components[0]!.children![1]!;
    body.children = body.children!.filter((c) => c.id !== 'b');
    body.children.push({ type: 'parallelstage', id: 'strap', name: 'Same branch name', instanceCount: 2,
      radiusMethod: 'relative', radiusOffset: 0, angleMethod: 'relative', angleOffset: 0,
      position: { method: 'bottom', offset: 0 }, separationEvent: 'burnout', separationDelay: 0,
      children: [
        { type: 'nosecone', length: 0.04, aftRadius: 0.010, thickness: 0.001 },
        { type: 'bodytube', length: 0.15, outerRadius: 0.010, thickness: 0.0003, density: 950,
          children: [mount('b'), fins('airfoil')] },
      ],
    } as ComponentNode);
    const r = OrkRocket.buildTree(t);
    r.setMotorById('a', motor); r.setMotorById('b', motor);
    const branches = r.simulate({ delayProbe: true }).delayProbe!.branches;
    const core = branches.find((b) => b.mountIds.includes('a'))!;
    const straps = branches.filter((b) => b.mountIds.includes('b'));
    expect(straps).toHaveLength(1);
    expect(straps[0]!.name).toBe(core.name);
    expect(straps[0]!.parentId).toBe(core.id);
    expect(straps[0]!.id).not.toBe(core.id);
    expect(core.mountIds).not.toContain('b');
  }, 60_000);
});
