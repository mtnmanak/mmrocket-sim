import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { OrkRocket } from '@online-openrocket/engine';
import { resolveAssemblyRadius } from './assembly.js';
import { anchorStarts } from './position.js';
import { engineTree, findNode, normalizeTree } from './treeModel.js';
import { limitPatch, sanitizeTree } from './sanitize.js';
import { autoAlignFinSets } from './finAlign.js';
import { buildPieces } from './pieces.js';
import { layoutSchematic, schematicFrame } from './schematicLayout.js';
import { componentLoop, isWatertight, revolveProfile, solidVolume } from './solidMesh.js';
import { planAxialSplit, splitComponent, usableBox } from './splitSolid.js';
import { finOutlineProblem } from './finOutline.js';
import { airfoilFinMassEstimate } from './finMassEstimate.js';
import { finOnMount, profileMount } from './finRoot.js';
import { signedArea } from './polygon.js';
import { solidContextFor } from './solidContext.js';
import { tubeFinRadius } from './tubefins.js';
import { aftLayout } from './aftLayout.js';
import { isFinSet } from './mountAngle.js';

const body = (children: ComponentNode[], radius = 0.012): ComponentNode =>
  ({ type: 'bodytube', id: 'body', length: 0.5, outerRadius: radius, children });
const rocket = (children: ComponentNode[]): RocketTree => ({ components: [{ type: 'stage', id: 'stage', children }] });
const fin = (id = 'fin'): ComponentNode => ({ type: 'trapezoidfinset', id, rootChord: 0.1,
  tipChord: 0.05, height: 0.04, thickness: 0.004, rotation: 0, position: { method: 'top', offset: 0.2 } });
const frameOptions = { cw: 640, chPx: 480, maxHeight: 480, rulers: true, rollW: 26, rollBar: 0, lanes: true, topReserve: 0 };

describe('J7 geometry regressions', () => {
  it.each([[-0.01, 0.2, 0.21], [0.12, null, null]])('S4a-1 bounds tab anchors and drawings at offset %s', (offset, front, aft) => {
    const f = { ...fin(), tabLength: 0.02, tabHeight: 0.005, tabOffsetMethod: 'top', tabOffset: offset };
    const ring: ComponentNode = { type: 'centeringring', id: 'ring', length: 0.003 };
    const parent = body([f, ring]);
    const anchors = anchorStarts(parent, ring);
    const layout = layoutSchematic(rocket([parent]), { scale: 1000, cy: 100, x0: 0, roll: 0, idPrefix: 't' });
    const tabs = layout.shapes.filter(s => s.key.includes(':tab'));
    if (front === null || aft === null) {
      expect(anchors.some(a => Math.abs(a - 0.317) < 1e-9)).toBe(false);
      expect(tabs).toHaveLength(0);
    } else {
      expect(anchors.some(a => Math.abs(a - (front - 0.003)) < 1e-9)).toBe(true);
      expect(tabs.length).toBeGreaterThan(0);
      expect(tabs[0]!.attrs.x).toBeCloseTo(front * 1000, 8);
      expect(tabs[0]!.attrs.width).toBeCloseTo((aft - front) * 1000, 8);
    }
  });

  it.each([['FREE', 0.09], ['SURFACE', 0.065], ['COAXIAL', 0], ['RELATIVE', 0.155]])(
    'S4a-b3 restores %s assembly radii', (radiusMethod, radius) => {
      const pod: ComponentNode = { type: 'podset', id: 'pod', radiusMethod, radiusOffset: 0.09,
        children: [{ type: 'bodytube', outerRadius: 0.015, length: 0.1 }] };
      const restored = findNode(normalizeTree(rocket([body([pod], 0.05)])), 'pod')!;
      expect(restored.radiusMethod).toBe(radiusMethod.toLowerCase());
      expect(resolveAssemblyRadius(restored, 0.05)).toBeCloseTo(radius, 12);
      expect(resolveAssemblyRadius(pod, 0.05)).toBeCloseTo(radius, 12);
    });

  it('S4a-1 measures tab depth only over the bounded cut span', () => {
    const f = { ...fin(), tabLength: 0.08, tabHeight: 0.1, tabOffsetMethod: 'top', tabOffset: 0.07,
      position: { method: 'top' as const, offset: 0 } };
    const mount: ComponentNode = { type: 'transition', id: 't', length: 0.2, foreRadius: 0.03, aftRadius: 0.01,
      shape: 'conical', children: [f] };
    expect(solidContextFor(rocket([mount]), f).tabMaxDepth).toBeCloseTo(0.02, 12);
  });

  it('S4a-g1 reports the actual flown vent and repairs an oversized loaded vent', () => {
    const chute: ComponentNode = { type: 'parachute', id: 'chute', diameter: 0.3, cd: 1.5, spillHoleDiameter: 0.4 };
    expect(findNode(engineTree(rocket([body([chute])])), 'chute')!.spillHoleDiameter).toBeCloseTo(0.285, 12);
    const notes: string[] = [];
    expect(findNode(sanitizeTree(rocket([body([chute])]), notes), 'chute')!.spillHoleDiameter).toBeCloseTo(0.285, 12);
    expect(notes.join(' ')).toMatch(/spill hole/i);
    expect(limitPatch(chute, { diameter: 0.2 }).spillHoleDiameter).toBeCloseTo(0.19, 12);
  });

  it.each([-25, 25])('S4a-g2 bounds typed and loaded cant %s degrees', degrees => {
    const value = Math.sign(degrees) * Math.PI / 12;
    expect(limitPatch(fin(), { cant: degrees * Math.PI / 180 }).cant).toBeCloseTo(value, 12);
    const notes: string[] = [];
    expect(findNode(sanitizeTree(rocket([body([{ ...fin(), cant: degrees * Math.PI / 180 }])]), notes), 'fin')!.cant).toBeCloseTo(value, 12);
    expect(notes.join(' ')).toMatch(/cant angle/i);
  });

  it.each(['launchlug', 'railbutton', 'protuberance'])('S4a-g4 wraps flown %s mounting angle', type => {
    const part = { type, id: 'part', angleOffset: 5 * Math.PI / 3, cdFrontal: 1 } as ComponentNode;
    expect(findNode(engineTree(rocket([body([part])])), 'part')!.angleOffset).toBeCloseTo(-Math.PI / 3, 12);
    expect(part.angleOffset).toBe(5 * Math.PI / 3);
  });

  it('S4a-g6 bounds plate angles and loaded Haack parameters', () => {
    expect(limitPatch({ type: 'protuberance' } as unknown as ComponentNode, { plateAngle: 2 * Math.PI / 3 }).plateAngle).toBeCloseTo(Math.PI / 2, 12);
    for (const shapeParameter of [-0.5, 1]) {
      const notes: string[] = [];
      const cone: ComponentNode = { type: 'nosecone', id: 'cone', shape: 'haack', shapeParameter };
      expect(findNode(sanitizeTree(rocket([cone]), notes), 'cone')!.shapeParameter).toBeCloseTo(shapeParameter < 0 ? 0 : 1 / 3, 12);
      expect(notes.join(' ')).toMatch(/shape parameter/i);
    }
  });

  it('S4a-g8 aligns only the selected tube', () => {
    const first = body([fin('a'), fin('b')]);
    const second = { ...body([fin('c'), fin('d')]), id: 'other' };
    // The third argument scopes the action from the selected fin's panel.
    const aligned = autoAlignFinSets(rocket([first, second]), undefined, 'body');
    expect(findNode(aligned.tree, 'b')!.rotation).not.toBe(0);
    expect(findNode(aligned.tree, 'd')!.rotation).toBe(0);
    expect(aligned.changes).toHaveLength(1);
  });

  it.each([3, 9])('S4a-g9 discloses the simulator shroud limit for %s m', length => {
    const notes: string[] = [];
    const shroud: ComponentNode = { type: 'fairing', id: 'shroud', length, height: 3 };
    const fixed = findNode(sanitizeTree(rocket([body([shroud])]), notes), 'shroud')!;
    expect(fixed.length).toBe(2.5);
    expect(fixed.height).toBe(2.5);
    expect(notes.join(' ')).toMatch(/simulator.*strake/i);
    expect(() => OrkRocket.buildTree(engineTree(rocket([body([fixed])])))).not.toThrow();
  }, 20_000);

  it.each([0.02, 0.025])('S4b-1 refuses an explicit invalid ring bore %s m', innerRadius => {
    expect(componentLoop({ type: 'centeringring', outerRadius: 0.02, innerRadius, length: 0.003 }, { mountOuterRadius: 0.0095 })).toBeNull();
  });

  it('S4b-3 reserves no spigot on the last print', () => {
    const printer = { x: 0.256, y: 0.256, z: 0.256, margin: 0.008, lean: false };
    const split = splitComponent({ type: 'bodytube', length: 0.47, outerRadius: 0.04, thickness: 0.002 }, {}, printer)!;
    expect(split.plan.segments).toBe(2);
    expect(split.loops).toHaveLength(2);
    for (const part of split.loops) {
      const xs = part.map(p => p[0]);
      expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(usableBox(printer).z + 1e-9);
      const mesh = revolveProfile(part);
      expect(isWatertight(mesh)).toBe(true);
      expect(solidVolume(mesh)).toBeGreaterThan(0);
    }
  });

  it('S4b-4 certifies a diagonal bed placement', () => {
    const plan = planAxialSplit(0.4, 0.02, { x: 0.236, y: 0.236, z: 0.378, margin: 0.008 });
    expect(plan.segments).toBe(1);
    expect(plan.leanUsed).toBe(true);
    expect(plan.tallestPrint).toBeLessThanOrEqual(0.370 + 1e-9);
  });

  it('S4b-b2 bounds validation while preserving a restored outline', () => {
    const points = Array.from({ length: 12000 }, (_, i) => [i / 120000, Math.sin(Math.PI * i / 11999) * 0.02]);
    const f = { type: 'freeformfinset', id: 'large', points } as ComponentNode;
    expect(findNode(normalizeTree(rocket([body([f])])), 'large')!.points).toEqual(points);
    expect(finOutlineProblem(points as [number, number][])).toMatch(/too many|5,?000|budget/i);
    const oversizedCoordinates = points.map(([x, y]) => [x! * 20000, y]);
    const notes: string[] = [];
    const bounded = findNode(sanitizeTree(rocket([body([{ ...f, points: oversizedCoordinates }])]), notes), 'large')!.points as [number, number][];
    expect(bounded).toHaveLength(12000);
    expect(bounded.every(([x, y]) => Math.abs(x) <= 1000 && Math.abs(y) <= 1000)).toBe(true);
    expect(notes.join(' ')).toMatch(/fin coordinates exceed/);
  });

  it('S4b-g1 estimates airfoil mass on the actual mount', () => {
    const points: [number, number][] = [[0, 0], [0, 0.021], [0.1, 0.021], [0.1, 0]];
    const f: ComponentNode = { type: 'freeformfinset', points, thickness: 0.004, finCount: 3, density: 500 };
    const mount = profileMount('ogive', 1, 0.1, 0.01, 0.03);
    const area = finOnMount(points, 0, mount, 100).lobes.reduce((sum, lobe) => sum + Math.abs(signedArea(lobe)), 0);
    expect(airfoilFinMassEstimate(f, mount, 0)).toBeCloseTo(3 * area * 0.004 * 500 * 0.85, 12);
  });

  it('S4b-g4 frames automatic tube fins on a wider pod', () => {
    const tubes: ComponentNode = { type: 'tubefinset', length: 0.05, finCount: 3 };
    const pod: ComponentNode = { type: 'podset', radiusOffset: 0, children: [{ type: 'bodytube', length: 0.2, outerRadius: 0.03, children: [tubes] }] };
    const frame = schematicFrame(rocket([body([pod], 0.01)]), frameOptions);
    expect(frame.vHalf).toBeGreaterThanOrEqual(0.04 + 0.03 + 2 * tubeFinRadius(tubes, 0.03) - 1e-9);
  });

  it.each([{ type: 'launchlug', outerRadius: 0.03, length: 0.03 }, { type: 'railbutton', totalHeight: 0.08, outerDiameter: 0.01 }])(
    'S4b-g4 frames tall core surface parts: $type', part => {
      const frame = schematicFrame(rocket([body([part as ComponentNode])]), frameOptions);
      expect(frame.vHalf).toBeGreaterThanOrEqual(0.012 + (part.type === 'launchlug' ? 0.06 : 0.08));
    });

  it('S4b-g5 uses one unresolved transition fallback for display and cutting', () => {
    const f: ComponentNode = { type: 'freeformfinset', id: 'strake', thickness: 0.004, points: [[0, 0], [0.05, 0], [0.1, 0]] };
    const a: ComponentNode = { type: 'transition', id: 'a', length: 0.1, foreRadius: 0.03, shape: 'conical', children: [f] };
    const b: ComponentNode = { type: 'transition', id: 'b', length: 0.1, aftRadius: 0.02, shape: 'conical' };
    const tree = rocket([a, b]);
    const mount = solidContextFor(tree, f).finMount!;
    expect(mount.radiusAt(0.1)).toBeCloseTo(0.025, 12);
    const pieces = buildPieces(tree).pieces;
    const transition = pieces.find(p => p.key.startsWith('tr'))!;
    const positions = transition.geometry.getAttribute('position');
    let aft = 0;
    // Lathe geometry is local: +Y becomes axial +X in the piece placement.
    for (let i = 0; i < positions.count; i++) if (Math.abs(positions.getY(i) - 0.1) < 1e-7) aft = Math.max(aft, Math.hypot(positions.getX(i), positions.getZ(i)));
    expect(aft).toBeCloseTo(mount.radiusAt(0.1), 7);
    const explicit = rocket([{ ...a, aftRadius: 0.025 }, { ...b, foreRadius: 0.025 }]);
    expect(layoutSchematic(tree, { scale: 1000, cy: 100, x0: 0, roll: 0, idPrefix: 't' }).shapes)
      .toEqual(layoutSchematic(explicit, { scale: 1000, cy: 100, x0: 0, roll: 0, idPrefix: 't' }).shapes);
    expect(aftLayout(tree, 0)).toEqual(aftLayout(explicit, 0));
    expect(isFinSet(f, a)).toBe(isFinSet(f, { ...a, aftRadius: 0.025 }));
  });

  it('S4b-g6 measures lug reach from the core axis', () => {
    const result = buildPieces(rocket([body([{ type: 'launchlug', length: 0.03, outerRadius: 0.003 }])]));
    expect(result.maxR).toBeCloseTo(0.018, 12);
    result.pieces.forEach(p => p.geometry.dispose());
  });
});
