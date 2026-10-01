// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import { exportOrk, importOrk } from './orkFile.js';
import { engineTree } from '../tree/treeModel.js';
import { blankValue, FIELDS } from '../tree/schema.js';

/**
 * A RECOVERY DEVICE'S PACKED SIZE (format audit 2026-09-03 row 13; board
 * Tier 1 row 2). A parachute, streamer or shock cord is a kernel MassObject: a
 * cylinder of its packed length and radius whose CG sits at half the packed
 * length behind its front. The .ork reader never looked at <packedlength> or
 * <packedradius>, the writer emitted a literal 0.025 / 0.0125 for all three,
 * and the bridge never set either — so a 254 mm packed main (LEM-IV.ork) flew
 * as 25 mm, its CG 114.5 mm from where desktop puts it, and the user's own file
 * came back from a save with the packing erased.
 */

/** Import mints fresh ids, so parts are matched by NAME. */
const lookup = (nodes: ComponentNode[], name: string): ComponentNode | undefined => {
  for (const n of nodes) {
    if (n.name === name) return n;
    const hit = lookup(n.children ?? [], name);
    if (hit) return hit;
  }
  return undefined;
};
const find = (nodes: ComponentNode[], name: string): ComponentNode => {
  const hit = lookup(nodes, name);
  if (!hit) throw new Error(`no part named ${name}`);
  return hit;
};

const ORK = (bay: string) => `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
  <name>Packed</name><subcomponents><stage><name>S</name><subcomponents>
    <nosecone><name>N</name><length>0.2</length><thickness>0.002</thickness>
      <shape>ogive</shape><aftradius>0.0508</aftradius></nosecone>
    <bodytube><name>Bay</name><length>0.6</length><thickness>0.0015</thickness><radius>0.0508</radius>
      <subcomponents>${bay}</subcomponents></bodytube>
  </subcomponents></stage></subcomponents></rocket></openrocket>`;

const BAY = `
  <parachute><name>Main</name><axialoffset method="top">0.02</axialoffset>
    <packedlength>0.254</packedlength><packedradius>0.03175</packedradius>
    <cd>auto</cd><diameter>1.2</diameter><linecount>8</linecount><linelength>1.0</linelength></parachute>
  <streamer><name>Tape</name><axialoffset method="top">0.3</axialoffset>
    <packedlength>0.1028</packedlength><packedradius>0.0175</packedradius>
    <striplength>1.0</striplength><stripwidth>0.05</stripwidth></streamer>
  <shockcord><name>Cord</name><axialoffset method="top">0.45</axialoffset>
    <packedlength>0.06096</packedlength><packedradius>auto 0.04953</packedradius>
    <cordlength>3.0</cordlength></shockcord>`;

describe('.ork recovery devices keep their packed size', () => {
  const parts = importOrk(ORK(BAY)).tree.components;

  it('reads <packedlength> and <packedradius> on a parachute, a streamer and a shock cord', () => {
    expect(find(parts, 'Main')['packedLength']).toBeCloseTo(0.254, 12);
    expect(find(parts, 'Main')['packedRadius']).toBeCloseTo(0.03175, 12);
    expect(find(parts, 'Tape')['packedLength']).toBeCloseTo(0.1028, 12);
    expect(find(parts, 'Tape')['packedRadius']).toBeCloseTo(0.0175, 12);
    expect(find(parts, 'Cord')['packedLength']).toBeCloseTo(0.06096, 12);
  });

  it('reads an automatic packed radius as the value desktop resolved and wrote beside it', () => {
    // MassObjectSaver writes `auto <getRadius()>` and getLength() — the pair
    // desktop itself flies — so the number beside `auto` is the radius.
    expect(find(parts, 'Cord')['packedRadius']).toBeCloseTo(0.04953, 12);
  });

  it('leaves both keys off a device whose file states neither, so it flies the kernel default', () => {
    const bare = importOrk(ORK('<parachute><name>Bare</name><diameter>0.6</diameter></parachute>'));
    const chute = find(bare.tree.components, 'Bare');
    expect(chute['packedLength']).toBeUndefined();
    expect(chute['packedRadius']).toBeUndefined();
  });

  it('writes what the design carries, not a literal 0.025 / 0.0125', () => {
    const xml = exportOrk({ name: 'Packed', tree: importOrk(ORK(BAY)).tree });
    expect(xml).toContain('<packedlength>0.254</packedlength>');
    expect(xml).toContain('<packedradius>0.03175</packedradius>');
    expect(xml).toContain('<packedlength>0.1028</packedlength>');
    expect(xml).toContain('<packedlength>0.06096</packedlength>');
    expect(xml).toContain('<packedradius>0.04953</packedradius>');
  });

  it('survives a round trip on all three', () => {
    const back = importOrk(exportOrk({ name: 'Packed', tree: importOrk(ORK(BAY)).tree })).tree.components;
    for (const [name, len, rad] of [['Main', 0.254, 0.03175], ['Tape', 0.1028, 0.0175], ['Cord', 0.06096, 0.04953]] as const) {
      expect(find(back, name)['packedLength'], name).toBeCloseTo(len, 12);
      expect(find(back, name)['packedRadius'], name).toBeCloseTo(rad, 12);
    }
  });

  it('writes the kernel default for a device that states no packed size', () => {
    const tree = {
      name: 'Bare',
      components: [{
        type: 'bodytube', id: 'b', name: 'b', length: 0.4, outerRadius: 0.02, thickness: 0.001,
        children: [{ type: 'shockcord', id: 'c', name: 'c', cordLength: 1 }],
      }],
    } as unknown as RocketTree;
    const xml = exportOrk({ name: 'Bare', tree });
    expect(xml).toContain('<packedlength>0.025</packedlength>');
    expect(xml).toContain('<packedradius>0.0125</packedradius>');
  });

  it('flies the packed length: the imported chute is 254 mm to the kernel, its CG at 127 mm', () => {
    resetEngine();
    const tree = importOrk(ORK(BAY)).tree;
    const rocket = OrkRocket.buildTree(engineTree(tree));
    const info = rocket.componentInfo(find(tree.components, 'Main').id!);
    expect(info.length).toBeCloseTo(0.254, 9);
    expect(info.cgX).toBeCloseTo(0.127, 9);
  });
});

describe('the panel edits the packed size of all three recovery types', () => {
  for (const type of ['parachute', 'streamer', 'shockcord'] as const) {
    it(`${type}: Packed length and a radius-or-diameter Packed radius, blank flying the kernel's 25 x 12.5 mm`, () => {
      const fields = FIELDS[type] ?? [];
      const len = fields.find((f) => f.key === 'packedLength');
      const rad = fields.find((f) => f.key === 'packedRadius');
      expect(len?.label).toBe('Packed length');
      expect(rad?.radius).toBe(true); // shown as "Packed diameter" under the diameter preference
      expect(len?.optional && rad?.optional).toBe(true);
      expect(blankValue(type, 'packedLength')).toBe(0.025);
      expect(blankValue(type, 'packedRadius')).toBe(0.0125);
    });
  }
});
