// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode } from '@online-openrocket/engine';
import { importOrk } from '../services/orkFile.js';
import { fieldLimit } from './schema.js';
import { limitPatch, sanitizeTree } from './sanitize.js';
import { engineTree } from './treeModel.js';
import { finOutlineProblem } from './finOutline.js';

it('HF2 bounds negative fin coordinates on load and refuses them on edit', () => {
  const points: [number, number][] = [[0, 0], [-1e152, 1], [-1e152, 2.5], [1, 0]];
  const notes: string[] = [];
  const tree = sanitizeTree({ components: [{ type: 'stage', children: [{ type: 'bodytube',
    length: 1, outerRadius: 1, children: [{ type: 'freeformfinset', points,
      finCount: 8, thickness: 1000, density: 30000 }],
  }] }] }, notes);
  expect(finOutlineProblem(points)).toMatch(/1000/);
  expect(notes.join(' ')).toMatch(/fin.*limit/i);
  resetEngine();
  expect(Number.isFinite(OrkRocket.buildTree(engineTree(tree)).staticInfo().rotationalInertia)).toBe(true);
});

it.each([
  '<overridemass>1e20</overridemass>',
  '<material type="bulk" density="30000">Heavy</material>',
])('HF2 keeps clustered rotational inertia finite with %s', material => {
  const loaded = importOrk(`<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents>
    <bodytube><length>1</length><radius>1</radius><subcomponents>
      <innertube><name>Heavy mount</name><length>1000</length><outerradius>1000</outerradius>
        <thickness>1000</thickness>${material}
        <clusterconfiguration>double</clusterconfiguration><clusterscale>1e146</clusterscale>
      </innertube>
    </subcomponents></bodytube>
  </subcomponents></stage></subcomponents></rocket></openrocket>`);
  resetEngine();
  const info = OrkRocket.buildTree(engineTree(loaded.tree)).staticInfo();
  expect(Number.isFinite(info.rotationalInertia)).toBe(true);
  expect(loaded.notes.join(' ')).toMatch(/cluster spacing.*set to/i);
  if (material.startsWith('<overridemass>')) expect(loaded.notes.join(' ')).toMatch(/mass.*over the limit/i);
});

it.each([
  ['masscomponent', 'mass'], ['innertube', 'overrideMass'],
  ['parachute', 'surfaceDensity'], ['parachute', 'lineDensity'],
  ['streamer', 'surfaceDensity'], ['shockcord', 'lineDensity'],
] as const)('HF2 bounds %s %s identically on load and edit', (type, key) => {
  const node: ComponentNode = { type, name: 'Extreme part', [key]: 1e308 };
  const notes: string[] = [];
  const loaded = sanitizeTree({ components: [node] }, notes).components[0]!;
  const ceiling = fieldLimit(type, key)!.hmax!;
  expect(Number.isFinite(ceiling)).toBe(true);
  expect(loaded[key]).toBe(ceiling);
  expect(notes.join(' ')).toMatch(/over the limit.*set to/i);
  expect(limitPatch({ type }, { [key]: 1e308 })[key]).toBe(ceiling);
  const tree = sanitizeTree({ components: [{ type: 'stage', children: [{
    type: 'bodytube', length: 1000, outerRadius: 1000, children: [{
      type: 'innertube', length: 1000, outerRadius: 1000, cluster: 'double',
      clusterScale: fieldLimit('innertube', 'clusterScale')!.hmax,
      children: [{ ...loaded, length: 1000, radius: 1000, diameter: 1000,
        stripLength: 1000, stripWidth: 1000, cordLength: 1000, lineLength: 1000, lineCount: 256 }],
    }],
  }] }] });
  resetEngine();
  expect(Number.isFinite(OrkRocket.buildTree(engineTree(tree)).staticInfo().rotationalInertia)).toBe(true);
});
