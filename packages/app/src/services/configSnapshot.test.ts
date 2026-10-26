// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { snapshotLoadedConfig } from './configSnapshot.js';
import { exportRkt, rktComponentInfo } from './rocksimFile.js';
import { exportCdx1 } from './rasaeroFile.js';
import { createLoadedConfig, stripPadMass, stripRefPadMass, restoreUnmatchedRefs, withActiveConfigTreeSynced } from './configSync.js';
import { mountBore, previewMounts, scaleRocket } from '../tree/scaleRocket.js';
import { motorMounts } from '../tree/treeModel.js';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { resolveImportMotors } from './importApply.js';
import type { ImportedDesign } from './importApply.js';
import { buildPieces } from '../tree/pieces.js';
import { aftLayout } from '../tree/aftLayout.js';
import { layoutSchematic } from '../tree/schematicLayout.js';

const fixture = (id: string): RocketTree => ({ components: [{ type: 'stage', id: 's', name: 'Sustainer', children: [
  { type: 'nosecone', length: 0.1, aftRadius: 0.025, shape: 'conical' },
  { type: 'bodytube', id: 'body', length: 0.5, outerRadius: 0.025, motorMount: true, children: [
    { type: 'parachute', id, diameter: 0.4, deployEvent: 'apogee' },
  ] },
] }] });

it('snapshots prototype-key ids as own serializable entries in all families', () => {
  const tree: RocketTree = { components: [{ type: 'stage', id: '__proto__', nozzleExitDiameter: 0.01, children: [
    { type: 'parachute', id: '__proto__', deployEvent: 'apogee' },
  ] }] };
  const snap = snapshotLoadedConfig(tree, {});
  for (const map of [snap.deployments, snap.separations, snap.nozzles]) {
    expect(Object.keys(map)).toEqual(['__proto__']);
    expect(Object.hasOwn(JSON.parse(JSON.stringify(map)), '__proto__')).toBe(true);
  }
});

it('keeps prototype-key computed component info in the RockSim map', () => {
  const info = rktComponentInfo(fixture('__proto__'), () => ({ mass: 0.01, cgX: 0.03, positionX: 0.2 }));
  expect(Object.hasOwn(info, '__proto__')).toBe(true);
});

it.each(['constructor', 'toString', '__proto__'])('exports recovery id %s without inherited overrides or motors', id => {
  const tree = fixture(id);
  for (const loaded of [false, true]) {
    const notes: string[] = [];
    expect(() => exportRkt({ name: 'R', tree, notes, overrides: { deployments: {} },
      ...(loaded ? { motors: { body: { designation: 'D12', manufacturer: 'Estes', diameter: 0.024, length: 0.07,
        delay: 5 } } } : {}) })).not.toThrow();
    expect(notes.join(' ')).not.toMatch(/Recovery overrides/);
  }
  const notes: string[] = [];
  expect(() => exportCdx1({ name: 'R', tree, motors: { body: { designation: 'D12', manufacturer: 'Estes' } },
    overrides: { deployments: {} }, notes })).not.toThrow();
  expect(notes.join(' ')).not.toMatch(/own setting/);
});

it.each(['constructor', 'toString', '__proto__'])('retains %s entries in sibling configuration transformations', async id => {
  const motor = { padMassKg: 1 } as MountMotor;
  const ref = { designation: 'Missing', manufacturer: 'Unknown', diameter: 0.024, length: 0.07, delay: 5, padMassKg: 1 };
  expect(Object.hasOwn(stripPadMass(Object.fromEntries([[id, motor]])), id)).toBe(true);
  expect(Object.hasOwn(stripRefPadMass(Object.fromEntries([[id, ref]])), id)).toBe(true);
  expect(Object.hasOwn(restoreUnmatchedRefs([], null, {}, Object.fromEntries([[id, ref]])), id)).toBe(true);
  const tree: RocketTree = { components: [{ type: 'stage', id, overrideMass: 2 }] };
  const config: SavedConfig = { id: 'A', name: null, isDefault: false, motors: {},
    stageMassOverrides: Object.fromEntries([[id, { overrideMass: 1 }]]) };
  expect(Object.hasOwn(withActiveConfigTreeSynced([config], 'A', tree)[0]!.stageMassOverrides!, id)).toBe(true);
  const imported = { tree, motors: Object.fromEntries([[id, ref]]), configs: [{ id, motors: Object.fromEntries([[id, ref]]) }] } as ImportedDesign;
  const resolved = await resolveImportMotors(imported, async () => ({ note: 'Unmatched' }));
  expect(Object.hasOwn(resolved.working, id)).toBe(true);
  expect(Object.hasOwn(resolved.configs, id)).toBe(true);
  expect(Object.hasOwn(resolved.configs[id]!, id)).toBe(true);
});

it.each(['constructor', 'toString', '__proto__'])('does not draw an inherited motor for %s', id => {
  const tree = fixture('chute');
  tree.components[0]!.children![1]!.children!.push({ type: 'innertube', id, length: 0.1, outerRadius: 0.01 });
  const result = buildPieces(tree, {});
  expect(result.pieces.filter(p => p.key.startsWith('motor'))).toHaveLength(0);
  result.pieces.forEach(p => p.geometry.dispose());
  expect(aftLayout(tree, 0, {}).inner).toHaveLength(aftLayout(tree, 0).inner.length);
  const options = { scale: 100, x0: 0, cy: 100, roll: 0, idPrefix: 'test' };
  expect(layoutSchematic(tree, { ...options, motors: {} }).shapes).toHaveLength(layoutSchematic(tree, options).shapes.length);
});

it.each(['constructor', 'toString', '__proto__'])('does not treat inherited config input as a loaded motor or mount choice for %s', id => {
  const tree: RocketTree = { components: [{ type: 'bodytube', id, length: 0.3, outerRadius: 0.025, motorMount: true }] };
  expect(createLoadedConfig({ tree, mountMotors: {}, unmatchedRefs: {}, savedConfigs: [], activeConfigId: null })).toBeNull();
  const tube: ComponentNode = { type: 'innertube', id, length: 0.1, outerRadius: 0.01, motorMount: true };
  const mountTree: RocketTree = { components: [{ type: 'bodytube', outerRadius: 0.03, children: [tube] }] };
  expect(previewMounts(mountTree, 2, { mountChoices: {} })[0]).toMatchObject({
    finalBoreMm: 38, targetBoreMm: null, verdict: 'on-class',
  });
  tube['outerRadius'] = 0.0105;
  const opts = { mountChoices: {}, snapMounts: true };
  const preview = previewMounts(mountTree, 2, opts)[0]!;
  expect(preview.verdict).toBe('snapped');
  const scaled = scaleRocket(mountTree, 2, opts);
  expect(mountBore(motorMounts(scaled.tree)[0]!) * 1000).toBeCloseTo(preview.finalBoreMm, 9);
});

it('clamps a nozzle snapshot to the shared dimension limit', async () => {
  const { MAX_DIMENSION_M } = await import('../tree/schema.js');
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', nozzleExitDiameter: MAX_DIMENSION_M * 2 } as ComponentNode] };
  expect(snapshotLoadedConfig(tree, {}).nozzles.s).toBe(MAX_DIMENSION_M);
});
