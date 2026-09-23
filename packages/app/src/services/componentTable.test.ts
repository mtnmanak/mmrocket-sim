import { describe, expect, it } from 'vitest';
import type { ComponentInfo, ComponentNode, RocketTree } from '@online-openrocket/engine';
import { componentCsv, componentTable } from './componentTable.js';
import { INITIAL_UNITS } from '../prefs/units.js';

const tree: RocketTree = {
  name: 'Test Rocket',
  components: [{
    type: 'stage', id: 's', name: 'Sustainer',
    children: [
      {
        type: 'nosecone', id: 'n', name: 'Nose', length: 0.07, aftRadius: 0.012,
        thickness: 0.002, shape: 'haack', shapeParameter: 1 / 3, materialName: 'Fiberglass',
      } as ComponentNode,
      {
        type: 'bodytube', id: 'b', name: 'Airframe', length: 0.3, outerRadius: 0.012,
        children: [
          { type: 'parachute', id: 'p', name: 'Main, 30"', diameter: 0.76 } as ComponentNode,
        ],
      } as ComponentNode,
    ],
  } as ComponentNode],
};

const infoFor = (id: string): ComponentInfo | null => (id === 'n' ? {
  length: 0.07, mass: 0.05, sectionMass: 0.05, cgX: 0.045, positionX: 0,
} as ComponentInfo : null);

const prefs = { units: INITIAL_UNITS, radiusMode: 'diameter' as const };

describe('componentTable', () => {
  const t = componentTable(tree, prefs, infoFor);

  it('one row per component (stages excluded), tree order', () => {
    expect(t.rows.map((r) => r[0])).toEqual(['Nose', 'Airframe', 'Main, 30"']);
    expect(t.rows.map((r) => r[3])).toEqual(['Sustainer', 'Sustainer', 'Airframe']);
  });

  it('headers carry the user units and honor the diameter preference', () => {
    expect(t.headers).toContain(`Mass (${INITIAL_UNITS.mass})`);
    // radius fields flip to diameter labels under the diameter preference
    expect(t.headers.some((h) => /diameter/i.test(h))).toBe(true);
    expect(t.headers.some((h) => /Base outer radius/.test(h))).toBe(false);
  });

  it('select fields export their label, params convert to display units', () => {
    const nose = t.rows[0]!;
    const shapeCol = t.headers.indexOf('Shape');
    expect(nose[shapeCol]).toBe('Haack');
    const matCol = t.headers.indexOf('Material');
    expect(nose[matCol]).toBe('Fiberglass');
    // aftRadius 0.012 m as diameter in the length unit (INITIAL_UNITS.length)
    const diaCol = t.headers.findIndex((h) => /Base outer diameter/i.test(h));
    expect(diaCol).toBeGreaterThan(-1);
    expect(typeof nose[diaCol]).toBe('number');
  });

  it('computed engine info lands in the fixed columns when available', () => {
    const nose = t.rows[0]!;
    const massCol = t.headers.indexOf(`Mass (${INITIAL_UNITS.mass})`);
    expect(typeof nose[massCol]).toBe('number');
    // no info for the parachute → blank, not a crash
    const chute = t.rows[2]!;
    expect(chute[massCol]).toBe('');
  });

  it('csv is one line per row with quoted commas', () => {
    const csv = componentCsv(t);
    const lines = csv.trim().split('\n');
    expect(lines.length).toBe(4);
    expect(lines[3]).toContain('"Main, 30""');
  });
});

/**
 * THE KERNEL'S MASS, ALL OF IT (audit 2026-09-22, row 361). `ComponentInfo`
 * reports one component's mass — one pod's worth for a part inside a pod set —
 * while the flight carries every copy. The table counted a pod set once and
 * filed a strap-on's parts under the core stage; here every mass figure is
 * checked against the kernel's own dry mass for the whole rocket.
 */
describe('componentTable — pods, strap-ons and clusters as the kernel flies them', () => {
  const design = (type: 'podset' | 'parallelstage'): RocketTree => ({
    name: 'Ring',
    components: [{
      type: 'stage', id: 's', name: 'Sustainer',
      children: [
        { type: 'nosecone', id: 'n', name: 'Nose', length: 0.1, aftRadius: 0.025, thickness: 0.002 } as ComponentNode,
        {
          type: 'bodytube', id: 'b', name: 'Airframe', length: 0.5, outerRadius: 0.025, thickness: 0.0005, density: 950,
          children: [
            {
              type: 'innertube', id: 'mm', name: 'Cluster mount', length: 0.08, outerRadius: 0.0095,
              thickness: 0.0005, density: 950, motorMount: true, cluster: '4-ring', clusterScale: 1,
              position: { method: 'bottom', offset: 0 },
              children: [{
                type: 'engineblock', id: 'eb', name: 'Block', length: 0.005, outerRadius: 0.009,
                thickness: 0.002, density: 950, position: { method: 'top', offset: 0 },
              } as ComponentNode],
            } as ComponentNode,
            {
              type, id: 'ring', name: type === 'podset' ? 'Pods' : 'Strap-ons', instanceCount: 3,
              radiusMethod: 'relative', radiusOffset: 0, angleOffset: 0,
              ...(type === 'parallelstage' ? { separationEvent: 'never' } : {}),
              position: { method: 'bottom', offset: 0 },
              children: [
                { type: 'nosecone', id: 'pn', name: 'Pod nose', length: 0.05, aftRadius: 0.012, thickness: 0.002 } as ComponentNode,
                {
                  type: 'bodytube', id: 'pb', name: 'Pod tube', length: 0.2, outerRadius: 0.012, thickness: 0.0005,
                  density: 950,
                  children: [{
                    type: 'masscomponent', id: 'pw', name: 'Pod weight', mass: 0.007, length: 0.02, radius: 0.005,
                    position: { method: 'top', offset: 0.02 },
                  } as ComponentNode],
                } as ComponentNode,
              ],
            } as ComponentNode,
          ],
        } as ComponentNode,
      ],
    } as ComponentNode],
  });

  const onKernel = async (t: RocketTree) => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const { engineTree } = await import('../tree/treeModel.js');
    resetEngine();
    const rocket = OrkRocket.buildTree(engineTree(t));
    const table = componentTable(t, prefs, (id) => {
      try { return rocket.componentInfo(id); } catch { return null; }
    });
    const col = (h: string) => table.headers.indexOf(h);
    const row = (name: string) => table.rows.find((r) => r[0] === name)!;
    return { rocket, table, col, row, info: rocket.staticInfo() };
  };
  const massH = `Mass (${INITIAL_UNITS.mass})`;
  const withH = `Mass with children (${INITIAL_UNITS.mass})`;
  const g = (kg: number) => kg * 1000;

  for (const type of ['podset', 'parallelstage'] as const) {
    it(`sums to the kernel's dry mass, every copy counted (${type})`, async () => {
      const { table, col, info } = await onKernel(design(type));
      const total = table.rows.reduce((s, r) => s + (r[col(massH)] as number), 0);
      expect(total).toBeCloseTo(g(info.massEmpty), 3);
    });

    it(`says how many copies fly, and counts them in both mass columns (${type})`, async () => {
      const { rocket, col, row, info } = await onKernel(design(type));
      expect(row('Pod tube')[col('Copies flown')]).toBe(3);
      expect(row('Pod weight')[col('Copies flown')]).toBe(3);
      expect(row('Pod weight')[col(massH)]).toBeCloseTo(3 * 7, 6);
      // The ring's own row: every pod's parts, where the kernel's sectionMass is one pod.
      const onePod = rocket.componentInfo('ring').sectionMass;
      expect(row(type === 'podset' ? 'Pods' : 'Strap-ons')[col(withH)]).toBeCloseTo(g(3 * onePod), 3);
      expect(row(type === 'podset' ? 'Pods' : 'Strap-ons')[col('Copies flown')]).toBe(1);
      // The airframe holding the ring counts every pod too: it is all of the
      // rocket but the nose.
      expect(row('Airframe')[col(withH)]).toBeCloseTo(g(info.massEmpty - rocket.componentInfo('n').mass), 3);
    });
  }

  it('counts what is inside a clustered mount once per tube', async () => {
    const { rocket, col, row } = await onKernel(design('podset'));
    expect(row('Block')[col('Copies flown')]).toBe(4);
    expect(row('Block')[col(massH)]).toBeCloseTo(g(4 * rocket.componentInfo('eb').mass), 3);
    // The mount's own row already carries its four tubes (RingComponent), so it is one copy.
    expect(row('Cluster mount')[col('Copies flown')]).toBe(1);
  });

  it('files a strap-on’s parts under the strap-on, the kernel’s stage for them', async () => {
    const { col, row } = await onKernel(design('parallelstage'));
    expect(row('Pod tube')[col('Stage')]).toBe('Strap-ons');
    expect(row('Strap-ons')[col('Stage')]).toBe('Strap-ons');
    expect(row('Airframe')[col('Stage')]).toBe('Sustainer');
    // A pod set is not a stage: its parts stay with the core.
    const pods = await onKernel(design('podset'));
    expect(pods.row('Pod tube')[pods.col('Stage')]).toBe('Sustainer');
  });
});
