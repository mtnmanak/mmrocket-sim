import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { engineTree, findNode, normalizeTree, referenceArea } from './treeModel.js';
import { absoluteStations, axialLength } from './position.js';
import { finRootChord, finTabFront } from './finTab.js';

const shifted: ComponentNode = { id: 'f', type: 'freeformfinset',
  points: [[0.01, 0], [0.03, 0.04], [0.08, 0.04], [0.06, 0]],
  finCount: 3, thickness: 0.002, crossSection: 'rounded',
  tabLength: 0.02, tabHeight: 0.003, position: { method: 'top', offset: 0.2 },
};
const fixture = (f = shifted): RocketTree => ({ name: 'Audit', components: [{
  id: 's', type: 'stage', children: [
    { id: 'n', type: 'nosecone', length: 0.1, aftRadius: 0.0145, thickness: 0.001 },
    { id: 'b', type: 'bodytube', length: 0.35, outerRadius: 0.0145, thickness: 0.0005,
      motorMount: true, children: [f] },
  ],
}] });

describe('audit 2026-10-11 geometry inputs', () => {
  it.each(['rounded', 'airfoil'])('S4a-2 normalizes shifted %s fins before positioning and cutting', (crossSection) => {
    const source = fixture({ ...shifted, crossSection });
    const before = structuredClone(source);
    const notes: string[] = [];
    const tree = normalizeTree(source, notes);
    const f = findNode(tree, 'f')!;
    expect(f['points']).toEqual([[0, 0], [expect.closeTo(0.02, 12), 0.04], [0.07, 0.04], [expect.closeTo(0.05, 12), 0]]);
    expect(axialLength(f)).toBeCloseTo(0.05, 12);
    expect(finRootChord(f)).toBeCloseTo(0.05, 12);
    expect(finTabFront(f, finRootChord(f))).toBeCloseTo(0.015, 12);
    expect(notes.join(' ')).toContain('origin');
    expect(source).toEqual(before);
    expect(normalizeTree(tree)).toBe(tree);
  });

  it.each(['top', 'middle', 'bottom'] as const)('S4a-2 %s station agrees with the real kernel', async (method) => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const tree = normalizeTree(fixture({ ...shifted, position: { method, offset: 0.02 } }));
    resetEngine();
    const rocket = OrkRocket.buildTree(engineTree(tree));
    expect(absoluteStations(tree).get('f')!.start).toBeCloseTo(rocket.componentInfo('f').positionX, 10);
  }, 30_000);

  it.each(['podset', 'parallelstage'] as const)('S4a-3 resolves automatic radii inside each %s chain', async (type) => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    const tree = fixture();
    findNode(tree, 'b')!.children!.unshift({ id: 'pod', type, radiusMethod: 'free', radiusOffset: 0.04,
      instanceCount: 2, children: [
        { id: 'pn', type: 'nosecone', length: 0.04, aftRadius: 0.01 },
        { id: 'pt', type: 'transition', length: 0.05, foreRadius: 0.01 },
      ] });
    tree.components[0]!.children!.push({ id: 'tail', type: 'bodytube', length: 0.05, outerRadius: 0.0145 });
    resetEngine();
    const info = OrkRocket.buildTree(engineTree(tree)).staticInfo();
    expect(info.refDiameter).toBeCloseTo(0.05, 10);
    expect(referenceArea(tree)).toBeCloseTo(Math.PI * (info.refDiameter / 2) ** 2, 12);
  }, 30_000);
});
