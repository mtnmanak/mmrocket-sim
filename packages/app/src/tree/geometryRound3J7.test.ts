import { expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { sanitizeTree, treeProblems, explainBuildFailure } from './sanitize.js';
import { scaledFinProblems } from './scaleRocket.js';
import { buildPieces } from './pieces.js';
import { componentLoop } from './solidMesh.js';
import { solidContextFor } from './solidContext.js';
import { exportRkt } from '../services/rocksimFile.js';
import { isFinSet } from './mountAngle.js';
import { splitComponent } from './splitSolid.js';
import { finOutlineProblem, type FinOutlinePoint } from './finOutline.js';

const largeFin = (): ComponentNode => ({ type: 'freeformfinset', id: 'large', name: 'Retained fin',
  thickness: 0.004, crossSection: 'rounded',
  points: Array.from({ length: 12000 }, (_, i) => [i / 11999, i === 11999 ? 0 : Math.sin(Math.PI * i / 11999) * 0.1]),
});
const treeOf = (...children: ComponentNode[]): RocketTree => ({ components: [{ type: 'stage', children }] });

it('r3 S4b-3 suppresses duplicate rounded lengths after a shoulder moves a cut', () => {
  const nose: ComponentNode = { type: 'nosecone', length: 0.1269999, aftRadius: 0.02,
    shape: 'conical', thickness: 0.002, shoulderLength: 0.1230001,
    shoulderRadius: 0.018, shoulderThickness: 0.002 };
  const result = splitComponent(nose, {}, { x: 0.2, y: 0.2, z: 0.15, margin: 0, lean: false })!;
  expect(result.plan.reason).toContain('spaced to keep every cut');
  expect(result.plan.reason).not.toContain('125 mm (4.921 in)-125 mm (4.921 in)');
});

it('r3 S4a-g1 does not call a valid exact 95% vent a repair', () => {
  const notes: string[] = [];
  const tree = sanitizeTree(treeOf({ type: 'parachute', diameter: 0.7, spillHoleDiameter: 0.665 }), notes);
  expect(notes).toEqual([]);
  expect(tree.components[0]!.children![0]!.spillHoleDiameter).toBeCloseTo(0.665, 14);
  sanitizeTree(treeOf({ type: 'parachute', diameter: 0.7, spillHoleDiameter: 0.666 }), notes);
  expect(notes).toHaveLength(1);
});

it('r3 S4b-b2 checks large fin scaling coordinates without treating budget refusal as an existing defect', () => {
  const tree = treeOf(largeFin());
  expect(finOutlineProblem(tree.components[0]!.children![0]!.points as FinOutlinePoint[])).toContain('too many points');
  expect(scaledFinProblems(tree, 1)).toEqual([]);
  expect(scaledFinProblems(tree, 2)).toEqual([]);
  expect(scaledFinProblems(tree, 3).join(' ')).toContain('2500 mm');
  expect(scaledFinProblems(tree, 1001).join(' ')).toContain('1000');
});

it('r3 S4b-b2 diagnoses the actual blocking part beside a retained large fin', () => {
  const tree = treeOf(largeFin(), { type: 'widget', name: 'Broken widget' } as unknown as ComponentNode);
  expect(finOutlineProblem(tree.components[0]!.children![0]!.points as FinOutlinePoint[])).toContain('too many points');
  expect(treeProblems(tree)).toEqual([]);
  const message = explainBuildFailure(tree, 'Unknown component type', t =>
    !t.components[0]!.children!.some(n => (n.type as string) === 'widget'));
  expect(message).toContain('Broken widget');
  expect(message).not.toContain('Retained fin');
  const invalid = largeFin();
  (invalid.points as number[][])[6000] = [1001, 0];
  expect(treeProblems(treeOf(invalid)).join(' ')).toContain('coordinate limit');
});

it('r3 S4b-g4 includes negative free pod offsets in mesh extents, including nested pods', () => {
  const fin: ComponentNode = { type: 'trapezoidfinset', rootChord: 0.1, tipChord: 0.05,
    height: 0.05, thickness: 0.004, crossSection: 'rounded', finCount: 2 };
  const pod: ComponentNode = { type: 'podset', radiusMethod: 'free', radiusOffset: -0.02,
    children: [{ type: 'bodytube', length: 0.2, outerRadius: 0.01, children: [fin] }] };
  const tree = treeOf({ type: 'bodytube', length: 0.5, outerRadius: 0.03, children: [pod] });
  expect(buildPieces(tree).maxR).toBeCloseTo(0.08, 12);
  pod.children![0]!.children = [{ ...pod, radiusOffset: -0.03, children: [{ ...pod.children![0]!, children: [fin] }] }];
  expect(buildPieces(tree).maxR).toBeCloseTo(0.11, 12);
});

it('r3 S4b-g5 recognizes a flush strake exposed by the unresolved boat-tail placeholder', () => {
  const fin: ComponentNode = { type: 'freeformfinset', thickness: 0.004, crossSection: 'rounded',
    points: [[0, 0], [0.05, 0], [0.1, 0]] };
  expect(isFinSet(fin, { type: 'transition', length: 0.1, foreRadius: 0.03 })).toBe(true);
});

const unresolvedTransitions = (): { a: ComponentNode; tree: RocketTree } => {
  const a: ComponentNode = { type: 'transition', id: 'a', length: 0.1, foreRadius: 0.03, thickness: 0.001 };
  const tree = treeOf(a, { type: 'transition', id: 'b', length: 0.1, aftRadius: 0.01 });
  return { a, tree };
};

it('r3 S4b-g5 prints the same unresolved transition ends as its seated fin', () => {
  const { a, tree } = unresolvedTransitions();
  const ctx = solidContextFor(tree, a);
  const printed = componentLoop(a, ctx)!;
  const aft = printed.loop.filter(([x]) => Math.abs(x - 0.1) < 1e-12).map(([, r]) => r);
  expect(Math.max(...aft)).toBeCloseTo(0.025, 12);
});

it('r3 S4b-g5 exports the same unresolved transition ends to RockSim', () => {
  const { tree } = unresolvedTransitions();
  const text = exportRkt({ name: 'Unresolved', tree });
  expect(text).toContain('<FrontDia>60</FrontDia>');
  expect(text).toContain('<RearDia>50</RearDia>');
});
