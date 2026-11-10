// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { applyStageMass, captureStageMass } from './stageMassOverrides.js';
import { MAX_STATED_MASS_KG } from '../tree/schema.js';
import { OrkRocket, resetEngine } from '@online-openrocket/engine';
import { engineTree } from '../tree/treeModel.js';

it('HF2 snapshots repair only override fields, leaving child repairs to the importer', () => {
  const notes: string[] = [];
  const snapshot = captureStageMass({ name: 'Stage', overrideMass: 1e308,
    children: [{ type: 'bodytube', name: 'Tube', length: 1e100 }] }, notes);
  expect(snapshot.overrideMass).toBe(MAX_STATED_MASS_KG);
  expect(notes).toHaveLength(1);
  expect(notes.join(' ')).not.toContain('Tube');
});

it('HF2 bounds captured and applied inactive stage masses', () => {
  const snapshot = { overrideMass: 1e308, overrideSubcomponentsMass: true };
  expect(captureStageMass(snapshot).overrideMass).toBe(MAX_STATED_MASS_KG);
  const tree = { components: [{ type: 'stage' as const, id: 's' }] };
  expect(applyStageMass(tree, { s: snapshot }).components[0]!.overrideMass).toBe(MAX_STATED_MASS_KG);
});

it('HF2 bounds raw snapshots on application before summing two stage masses', () => {
  const tree = { components: ['a', 'b'].map(id => ({ type: 'stage' as const, id,
    children: [{ type: 'bodytube' as const, length: 1, outerRadius: 0.03 }],
  })) };
  const snapshot = { overrideMass: 1e308, overrideSubcomponentsMass: true };
  const applied = applyStageMass(tree, { a: snapshot, b: snapshot });
  expect(applied.components.every(s => s.overrideMass === MAX_STATED_MASS_KG)).toBe(true);
  resetEngine();
  const info = OrkRocket.buildTree(engineTree(applied)).staticInfo();
  expect(Number.isFinite(info.massEmpty)).toBe(true);
  expect(Number.isFinite(info.rotationalInertia)).toBe(true);
});
