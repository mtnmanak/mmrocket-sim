// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { importOrk } from '../services/orkFile.js';
import { designStateFromSession } from '../services/sessionRestore.js';
import type { SessionState } from '../services/session.js';
import { DEFAULT_CONDITIONS } from '../services/launchConditions.js';
import { makeNode, normalizeTree } from './treeModel.js';
import { countExpandedInstances, countParts, MAX_EXPANDED_INSTANCES, refuseTooManyInstances } from './sanitize.js';

/** Stage + body + four pod/body pairs: ten stored nodes, 32^4 deepest bodies. */
function nested(count = 32): RocketTree {
  let body: ComponentNode = { type: 'bodytube', id: 'deep' };
  for (let i = 0; i < 4; i++) body = { type: 'bodytube', children: [
    { type: 'podset', instanceCount: count, children: [body] },
  ] };
  return { components: [{ type: 'stage', children: [body] }] };
}

describe('S4a-1 total expanded instance limit', () => {
  it('counts multiplied descendants without expanding them, and refuses at normalization', () => {
    const tree = nested();
    expect(countParts(tree.components)).toBe(10);
    expect(countExpandedInstances(tree.components)).toBe(2 + 2 * (32 + 32 ** 2 + 32 ** 3 + 32 ** 4));
    expect(() => normalizeTree(tree)).toThrow(/10,000.*Each fin, clustered tube, hole mark and repeated part counts.*pods and boosters/);
  });
  it('counts all hole marks within nested pods before accepting a tree', () => {
    let body: ComponentNode = { type: 'bodytube', children: Array.from({ length: 7 }, () => ({
      ...makeNode('tubehole'), holeCount: 64,
    })) };
    for (let i = 0; i < 2; i++) body = { type: 'bodytube', children: [
      { type: 'podset', instanceCount: 32, children: [body] },
    ] };
    const tree: RocketTree = { components: [{ type: 'stage', children: [body] }] };
    expect(countParts(tree.components)).toBe(13);
    expect(() => normalizeTree(tree)).toThrow(/expanded component instances.*10,000/);
    expect(countExpandedInstances(tree.components)).toBe(2 + 2 * (32 + 32 ** 2) + 7 * 64 * 32 ** 2);
  });
  it('explains a refusal caused by repeated fins without pods or boosters', () => {
    const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', children:
      Array.from({ length: 1300 }, () => ({ type: 'trapezoidfinset', finCount: 8 })),
    }] }] };
    expect(countParts(tree.components)).toBe(1302);
    expect(() => normalizeTree(tree)).toThrow(/10,000.*Each fin, clustered tube, hole mark and repeated part counts/);
  });
  it('preserves launch conditions but discards identity when an autosave is refused', () => {
    const launch = { ...DEFAULT_CONDITIONS, launchAltitudeM: 1234, launchRodLengthM: 2.4,
      launchRodAngleDeg: 8, windAverage: 7, windStdDev: 1.5, latitudeDeg: 45, longitudeDeg: -120 };
    const restored = designStateFromSession({ tree: nested(), launch, savedAt: 123,
      designFile: { name: 'Oversized.ork', via: 'opened', format: 'ork' },
    }, { legacyMaxMotorLengthM: null });
    expect(restored.refused).toBe(true);
    expect(restored.session).toBeNull();
    expect(restored.state.launch).toEqual(launch);
    expect(restored.state.mountMotors).toEqual({});
    expect(countExpandedInstances(restored.state.tree.components)).toBeLessThan(MAX_EXPANDED_INSTANCES);
  });
  it('accepts the boundary and real-sized nested assemblies, and refuses one copy over', () => {
    const parts: ComponentNode[] = Array.from({ length: MAX_EXPANDED_INSTANCES }, () => ({ type: 'bodytube' }));
    expect(() => refuseTooManyInstances(parts)).not.toThrow();
    expect(() => refuseTooManyInstances([...parts, { type: 'bodytube' }])).toThrow(/10,000/);
    expect(() => normalizeTree(nested(3))).not.toThrow();
  });
  it('refuses the counted nested .ork fixture before a renderer or kernel sees it', () => {
    let xml = '<bodytube><length>0.1</length><radius>0.01</radius></bodytube>';
    for (let i = 0; i < 4; i++) xml = `<bodytube><length>0.1</length><radius>0.01</radius><subcomponents><podset><instancecount>32</instancecount><subcomponents>${xml}</subcomponents></podset></subcomponents></bodytube>`;
    const fixture = `<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents>${xml}</subcomponents></stage></subcomponents></rocket></openrocket>`;
    expect(() => importOrk(fixture)).toThrow(/expanded component instances.*10,000/);
  });
  it('refuses an oversized autosave with a caution and clears its old flight state', () => {
    const session = { tree: nested(), mountMotors: { old: {} }, measured: { mass: 10 }, savedConfigs: [] } as unknown as SessionState;
    const restored = designStateFromSession(session, { legacyMaxMotorLengthM: null });
    expect(restored.restoreNotes.join(' ')).toMatch(/not restored.*10,000.*starter design/);
    expect(restored.restoreNoteTiers.some(n => n.tier === 'caution')).toBe(true);
    expect(restored.state.mountMotors).toEqual({});
    expect(countExpandedInstances(restored.state.tree.components)).toBeLessThan(MAX_EXPANDED_INSTANCES);
  });
});
