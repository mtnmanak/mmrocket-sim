import { expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { sanitizeTree, limitPatch } from './sanitize.js';
import { convertShrouds, shroudToFairing } from './shroudConvert.js';
import { schematicFrame } from './schematicLayout.js';
import { solidContextFor } from './solidContext.js';
import { finCutContours } from './solidMesh.js';
import { shroudWidthNotice } from '../services/meshExportNotes.js';
import { finOutlineProblem } from './finOutline.js';
import { INITIAL_UNITS } from '../prefs/units.js';

const treeOf = (...children: ComponentNode[]): RocketTree => ({ components: [{ type: 'stage', children }] });

it('r4 S4a-g6 suppresses binary32 boundary noise while still reporting a real Haack clamp', () => {
  for (const type of ['nosecone', 'transition'] as const) {
    const node: ComponentNode = { type, shape: 'haack', shapeParameter: 0.33333334 };
    const notes: string[] = [];
    sanitizeTree(treeOf(node), notes);
    limitPatch(node, { shapeParameter: 0.33333334 }, notes);
    limitPatch(node, { shape: 'haack' }, notes);
    expect(notes).toEqual([]);
    sanitizeTree(treeOf({ ...node, shapeParameter: 0.333334 }), notes);
    expect(notes).toHaveLength(1);
    expect(notes[0]).not.toContain('0.333333 is over the limit of 0.333333');
  }
});

it.each([
  { type: 'freeformfinset', name: 'Fins', cant: 15.04 * Math.PI / 180 },
  { type: 'protuberance', name: 'Plate', plateAngle: -0.0001 * Math.PI / 180 },
] as ComponentNode[])('r4 P4 distinguishes rounded angle comparisons for $name', node => {
  for (const angle of ['°', 'rad']) {
    const notes: string[] = [];
    sanitizeTree(treeOf(node), notes, { ...INITIAL_UNITS, angle });
    expect(notes.join(' ')).toMatch(/just (over|under) the/);
  }
});

it('r4 P4 preserves the whole-number explanation for a fractional count', () => {
  const notes: string[] = [];
  sanitizeTree(treeOf({ type: 'freeformfinset', finCount: 3.00000001 }), notes);
  expect(notes.join(' ')).toContain('not a whole number');
});

it.each([
  [[0, 0], [-9, 0.02], [-4, 0.02], [-3, 0]],
  [[0, 0], [0, -3], [-0.08, -3], [-0.08, 0]],
  [[0, 0], [0.04, 0], [0.08, 0]],
].map(points => ({ points })))('r4 S4a-g9 retains a shroud outline that cannot become a valid native envelope ($points)', ({ points }) => {
  const fin: ComponentNode = { id: 'camera', type: 'freeformfinset', name: 'Camera shroud', finCount: 1, points };
  expect(() => shroudToFairing(fin)).toThrow(/dimensions/);
  const converted = convertShrouds(treeOf(fin), ['camera']);
  expect(converted.tree.components[0]!.children![0]).toEqual(fin);
  expect(converted.notes.join(' ')).toMatch(/kept.*dimensions/);
});

it('r4 P4 never reports an effective mesh width for an omitted zero-length shroud', () => {
  expect(shroudWidthNotice({ type: 'fairing', length: 0, width: 0.025 }, 0.012)).toBeNull();
});

it('r4 S4b-g4 frames unresolved pod transitions at their drawn radius', () => {
  const pod: ComponentNode = { type: 'podset', radiusMethod: 'free', radiusOffset: 0.05, children: [
    { type: 'transition', length: 0.1, foreRadius: 0.01 },
    { type: 'transition', length: 0.1, aftRadius: 0.01 },
  ] };
  const tree = treeOf({ type: 'bodytube', length: 0.3, outerRadius: 0.01, children: [pod] });
  const options = { cw: 640, chPx: 480, maxHeight: 480, rulers: true, rollW: 26, rollBar: 0, lanes: true, topReserve: 0 };
  expect(schematicFrame(tree, options).vHalf).toBeGreaterThanOrEqual(0.075 - 1e-12);
});

it('r4 S4b-g5 caps fabricated tabs at the shared unresolved transition radius', () => {
  const fin: ComponentNode = { id: 'fin', type: 'freeformfinset', thickness: 0.004,
    points: [[0, 0], [0.02, 0.05], [0.08, 0.05], [0.1, 0]],
    tabLength: 0.02, tabHeight: 0.04, tabOffsetMethod: 'top', tabOffset: 0.07,
    position: { method: 'top', offset: 0 } };
  const a: ComponentNode = { type: 'transition', length: 0.1, foreRadius: 0.03, children: [fin] };
  const tree = treeOf(a, { type: 'transition', length: 0.1, aftRadius: 0.01 });
  const ctx = solidContextFor(tree, fin);
  expect(ctx.tabMaxDepth).toBeCloseTo(0.0255, 10);
  const contours = finCutContours(fin, ctx)!;
  expect(Math.min(...contours.flat().map(([, y]) => y))).toBeGreaterThan(-0.031);
});

it('r4 S4b-g5 keeps unresolved bores unknown for fitting internal stock', () => {
  const ring: ComponentNode = { id: 'ring', type: 'centeringring', length: 0.003 };
  const a: ComponentNode = { type: 'transition', length: 0.1, foreRadius: 0.03, children: [ring] };
  const tree = treeOf(a, { type: 'transition', length: 0.1, aftRadius: 0.01 });
  expect(solidContextFor(tree, ring).parentInnerRadius).toBeUndefined();
});

it('r4 S4b-b2 bounds validator work before reading any oversized outline coordinates', () => {
  let reads = 0;
  const points = new Proxy(Array.from({ length: 12000 }, (_, i): [number, number] => [i / 11999, Math.sin(Math.PI * i / 11999) * 0.1]), {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads++;
        if (reads > 10) throw new Error('Unbounded coordinate scan');
      }
      return Reflect.get(target, key, receiver);
    },
  });
  expect(finOutlineProblem(points)).toContain('too many points');
  expect(reads).toBe(0);
});

it('r4 S4b-b2 discloses the kernel coordinate adjustment on retained oversized outlines', () => {
  const points = Array.from({ length: 6000 }, (_, i) => [3 * i / 5999, Math.sin(Math.PI * i / 5999) * 0.1]);
  const notes: string[] = [];
  sanitizeTree(treeOf({ type: 'freeformfinset', points }), notes);
  expect(notes.join(' ')).toMatch(/2500 mm.*drawing and simulator differ/);
});
