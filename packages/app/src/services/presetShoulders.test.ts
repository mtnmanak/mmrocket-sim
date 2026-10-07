import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import presetsJson from '../data/presets.json';
import { engineTree, findNode, makeNode, updateNode } from '../tree/treeModel.js';
import { limitPatch } from '../tree/sanitize.js';
import { applyPresetLinks, catalogueDifferences, presetPatch, type Preset } from './presets.js';

const db = (presetsJson as { presets: Preset[] }).presets;
const row = (manufacturer: string, partNo: string) => {
  const matches = db.filter((p) => p.manufacturer === manufacturer && p.partNo === partNo);
  expect(matches).toHaveLength(1);
  return matches[0]!;
};
const treeFor = (node: ComponentNode): RocketTree => ({
  name: 'Preset shoulders', components: [{ type: 'stage', id: 'stage', children: [node] }],
});
const pick = (node: ComponentNode, p: Preset) => findNode(updateNode(treeFor(node), node.id!,
  limitPatch(node, presetPatch(node.type, p, { node, presets: db }))), node.id!)!;
const info = (node: ComponentNode) => OrkRocket.buildTree(engineTree(treeFor(node))).staticInfo();

describe('solid preset shoulders', () => {
  const sides = [
    ['nosecone', 'shoulderDiameter', 'shoulderThickness', 'shoulder thickness'],
    ['transition', 'foreShoulderDiameter', 'foreShoulderThickness', 'fore shoulder thickness'],
    ['transition', 'aftShoulderDiameter', 'aftShoulderThickness', 'aft shoulder thickness'],
  ] as const;
  for (const [type, diameter, thickness, words] of sides) {
    const solid: Preset = {
      kind: type === 'nosecone' ? 'NoseCone' : 'Transition', manufacturer: 'Test',
      partNo: 'Solid', description: '', filled: true, [diameter]: 0.02,
    };
    it(`${type} ${thickness}: a solid pick replaces an edited thickness and a re-pick restores it`, () => {
      const before = { ...makeNode(type), [thickness]: 0.001 };
      const after = pick(before, solid);
      expect(after[thickness]).toBe(0.01);
      expect(before[thickness]).toBe(0.001); // The previous tree remains available to undo.
      const edited = { ...after, [thickness]: 0.002 };
      const difference = catalogueDifferences(edited, solid).find((d) => d.key === thickness);
      expect(difference).toMatchObject({ words, have: 0.002, want: 0.01, patch: { [thickness]: 0.01 } });
      expect(pick(edited, solid)[thickness]).toBe(0.01);
    });

    it.each([false, undefined])(`${type} ${thickness}: a non-filled row (%s) leaves the existing wall alone`, (filled) => {
      const hollow = { ...solid, filled };
      expect(presetPatch(type, hollow)).not.toHaveProperty(thickness);
      const afterSolid = pick(makeNode(type), solid);
      expect(pick(afterSolid, hollow)[thickness]).toBe(0.01);
      expect(pick({ ...afterSolid, [thickness]: 0.003 }, hollow)[thickness]).toBe(0.003);
    });

    it(`${type} ${thickness}: missing diameter leaves the wall alone, but zero clears it`, () => {
      expect(presetPatch(type, { ...solid, [diameter]: undefined })).not.toHaveProperty(thickness);
      expect(presetPatch(type, { ...solid, [diameter]: 0 })[thickness]).toBe(0);
    });
  }

  it('a transition takes each shoulder from its own diameter', () => {
    const patch = presetPatch('transition', {
      kind: 'Transition', manufacturer: 'Test', partNo: 'Reducer', description: '',
      filled: true, foreShoulderDiameter: 0.02, aftShoulderDiameter: 0.04,
    });
    expect(patch).toMatchObject({ foreShoulderThickness: 0.01, aftShoulderThickness: 0.02 });
  });

  it('opening an app-owned design does not migrate an absent or edited shoulder wall', () => {
    const p = row('Estes', 'BNC-50K, 70262');
    for (const thickness of [undefined, 0, 0.001]) {
      const node: ComponentNode = { type: 'nosecone', id: 'n', shoulderThickness: thickness };
      applyPresetLinks([{ node, manufacturer: p.manufacturer, partNo: p.partNo }], db, [], { ownFile: true });
      expect(node['shoulderThickness']).toBe(thickness);
    }
  });
});

describe('preset pick through the app and shipped kernel', () => {
  it.each([
    ['Estes', 'BNC-50K, 70262', 'nosecone'],
    ['SEMROC', 'TA-2050', 'transition'],
  ] as const)('%s %s gains the analytical solid shoulder mass', (manufacturer, partNo, type) => {
    const p = row(manufacturer, partNo);
    expect(p.mass).toBeUndefined();
    expect(p['filled']).toBe(true);
    const node = pick(makeNode(type), p);
    // Reproduce the old fresh pick: the body is solid, but shoulder walls are unset.
    const old = { ...node, shoulderThickness: undefined, foreShoulderThickness: undefined,
      aftShoulderThickness: undefined };
    const before = info(old);
    const after = info(node);
    const pairs = type === 'nosecone'
      ? [['shoulderDiameter', 'shoulderLength']]
      : [['foreShoulderDiameter', 'foreShoulderLength'], ['aftShoulderDiameter', 'aftShoulderLength']];
    const volume = pairs.reduce((sum, [d, l]) =>
      sum + Math.PI * ((p[d!] as number) / 2) ** 2 * (p[l!] as number), 0);
    const expected = volume * p.material!.density;
    expect(after.mass).toBeGreaterThan(before.mass);
    // Analytic cylinders versus the same kernel body on both sides: 1 ppm allows
    // runtime rounding, while omitting either shoulder misses by orders of magnitude.
    expect(Math.abs(after.mass - before.mass - expected)).toBeLessThan(expected * 1e-6);
    if (type === 'nosecone') expect(after.cg - before.cg).toBeGreaterThan(0.001);
  });

  it('a catalogue mass keeps the weight fixed but still uses the shoulder geometry for CG', () => {
    const p = row('Estes', 'BNC-20AM');
    const node = pick(makeNode('nosecone'), p);
    const before = info({ ...node, shoulderThickness: undefined });
    const after = info(node);
    expect(Math.abs(before.mass - p.mass!)).toBeLessThan(1e-10);
    expect(Math.abs(after.mass - p.mass!)).toBeLessThan(1e-10);
    expect(after.cg - before.cg).toBeGreaterThan(0.001);
  });
});
