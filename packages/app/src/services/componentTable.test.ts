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
