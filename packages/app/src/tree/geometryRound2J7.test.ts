import { expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { finCutContours, finPrintShape, componentLoop, unusableStatedRingBore } from './solidMesh.js';
import { isFinSet } from './mountAngle.js';
import { schematicFrame } from './schematicLayout.js';
import { limitPatch, sanitizeTree } from './sanitize.js';
import { planAxialSplit } from './splitSolid.js';
import { meshExportNotes, shroudWidthNotice } from '../services/meshExportNotes.js';
import { FIELDS } from './schema.js';

it('r2 S4b-g5 keeps the conical default for shape-omitted transitions', () => {
  const fin: ComponentNode = { type: 'freeformfinset', thickness: 0.004,
    points: [[0, 0], [0.05, 0.009], [0.1, 0.015]] };
  // The aft end is unresolved: exercise the shared 25 mm placeholder as well
  // as the conical default (an ogive would bury this small exposed lobe).
  const mount: ComponentNode = { type: 'transition', length: 0.1, foreRadius: 0.01 };
  expect(isFinSet(fin, { ...mount, shape: 'conical' })).toBe(true);
  expect(isFinSet(fin, { ...mount, shape: 'ogive' })).toBe(false);
  expect(isFinSet(fin, mount)).toBe(true);
});

it('r2 S4b-1 distinguishes a placeholder OD and a closed host from an impossible stated bore', () => {
  const ring: ComponentNode = { type: 'centeringring', innerRadius: 0.015, length: 0.003 };
  expect(unusableStatedRingBore(ring, {})).toBe(false);
  expect(componentLoop(ring, {})?.label).toBe('Centering ring (assumed size and bore)');
  expect(unusableStatedRingBore({ ...ring, innerRadius: 0 }, { parentInnerRadius: 0 })).toBe(false);
  expect(componentLoop({ ...ring, innerRadius: 0 }, { parentInnerRadius: 0 })).toBeNull();
  expect(unusableStatedRingBore({ ...ring, outerRadius: 0.015 }, {})).toBe(true);
});

it('r2 S4a-g6 bounds saved Haack patches, including a shape-only pick', () => {
  for (const type of ['nosecone', 'transition'] as const) {
    const node: ComponentNode = { type, shape: 'haack' };
    const notes: string[] = [];
    expect(limitPatch(node, { shapeParameter: 1.5 }, notes).shapeParameter).toBeCloseTo(1 / 3, 12);
    expect(notes).toHaveLength(1);
    expect(limitPatch({ ...node, shape: 'ogive', shapeParameter: 1 }, { shape: 'haack' }).shapeParameter).toBeCloseTo(1 / 3, 12);
  }
});

it('r2 P4 reports each load clamp once, from the original number', () => {
  for (const node of [
    { type: 'nosecone', shape: 'haack', shapeParameter: 1.5 },
    { type: 'transition', shape: 'HAACK', shapeParameter: 1.5 },
    { type: 'parachute', diameter: 0.3, spillHoleDiameter: 2000 },
  ] as ComponentNode[]) {
    const notes: string[] = [];
    sanitizeTree({ components: [node] }, notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(node.type === 'parachute' ? '2000000 mm' : '1.5');
  }
});

it('r2 P4 names the radial reference and unnamed shrouds', () => {
  const notes: string[] = [];
  sanitizeTree({ components: [{ type: 'podset', name: 'Pods', radiusMethod: 'bogus' }] }, notes);
  expect(notes[0]).toContain('radial reference');
  expect(shroudWidthNotice({ type: 'fairing', name: '', width: 0.025 }, 0.012)).toContain('“Camera shroud”');
});

it('r3 S4a-b3 offers only radial methods the .ork writer can round-trip', () => {
  const select = FIELDS.podset!.find(f => f.key === 'radiusMethod')!;
  expect(select.options?.map(([value]) => value)).toEqual(['relative', 'free']);
  const restored = sanitizeTree({ components: [{ type: 'podset', radiusMethod: 'COAXIAL', radiusOffset: 0.09 }] });
  expect(restored.components[0]!.radiusMethod).toBe('coaxial');
});

it('r2 S4b-g4 frames fins at a negative pod radius, including nested pods', () => {
  const fin: ComponentNode = { type: 'trapezoidfinset', rootChord: 0.1, tipChord: 0.05, height: 0.05, thickness: 0.004, finCount: 2 };
  const pod: ComponentNode = { type: 'podset', radiusMethod: 'free', radiusOffset: -0.02,
    children: [{ type: 'bodytube', length: 0.2, outerRadius: 0.01, children: [fin] }] };
  const options = { cw: 640, chPx: 480, maxHeight: 480, rulers: true, rollW: 26, rollBar: 0, lanes: true, topReserve: 0 };
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 0.5, outerRadius: 0.03, children: [pod] }] }] };
  expect(schematicFrame(tree, options).vHalf).toBeGreaterThanOrEqual(0.08 - 1e-12);
  pod.children![0]!.children = [{ ...pod, radiusOffset: -0.03, children: [{ ...pod.children![0]!, children: [fin] }] }];
  expect(schematicFrame(tree, options).vHalf).toBeGreaterThanOrEqual(0.11 - 1e-12);
});

it('r2 S4b-3 never returns a failed one-piece split and suppresses rounded duplicate lengths', () => {
  // Pin the original unnecessary-third-piece defect too, not just the r1
  // near-limit count and duplicate-range regressions.
  const two = planAxialSplit(0.47, 0.04, { x: 0.256, y: 0.256, z: 0.256, margin: 0.008, lean: false });
  expect(two.segments).toBe(2);
  expect(two.tallestPrint).toBeLessThanOrEqual(0.248 + 1e-9);
  const printer = { x: 0.3, y: 0.3, z: 1.208, margin: 0.008, lean: false };
  const plan = planAxialSplit(1.2000000011, 0.04, printer);
  expect(plan.fits).toBe(false);
  expect(plan.segments).toBe(2);
  expect(plan.cuts).toHaveLength(1);
  const reason = planAxialSplit(0.5, 0.04, { ...printer, z: 0.208 }).reason;
  expect(reason).toContain('3 pieces of');
  expect(reason).not.toMatch(/pieces of [\d.,]+ mm(?: \([^)]+\))?-[\d.,]+ mm/);
});

it('r2 S4b-b2 bounds print/cut paths and discloses omitted whole-rocket fins', () => {
  const points: [number, number][] = Array.from({ length: 12000 }, (_, i) => [i / 120000, Math.sin(Math.PI * i / 11999) * 0.02]);
  const fin: ComponentNode = { type: 'freeformfinset', name: 'Huge\nfin', points, thickness: 0.004, crossSection: 'rounded' };
  expect(finCutContours(fin)).toBeNull();
  expect(finPrintShape(fin).kind).toBe('refused');
  const notes = meshExportNotes({ components: [fin] });
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatch(/3D view.*mesh exports/);
  expect(notes[0]).toMatch(/still.*simulat/);
  expect(notes[0]).not.toContain('\n');
});
