// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import { exportOrk, importOrk } from './orkFile.js';
import { exportRkt } from './rocksimFile.js';
import { applyPresetLinks, presetPatch, type Preset } from './presets.js';
import { engineTree } from '../tree/treeModel.js';
import { FIELDS } from '../tree/schema.js';
import { componentLoop } from '../tree/solidMesh.js';
import { solidContextFor } from '../tree/solidContext.js';

/**
 * A FILLED BODY TUBE (format audit 2026-09-03 row 27; board Tier 1 row 5).
 * Desktop writes a solid tube — a dowel, a spike, a solid pine rod — as
 * `<thickness>filled</thickness>`, as it does a solid nose cone or transition.
 * The body tube reader put that word through num(), got NaN and kept the
 * 0.5 mm fallback: a solid rod flew as a thin shell, and a save wrote the
 * 0.5 mm back, so desktop reopened it hollow. The bridge had no setFilled for
 * a body tube and the schema no field.
 */

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

const R = 0.0125;
const LEN = 0.2;
const RHO = 530;
const ORK = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
  <name>Dowel</name><subcomponents><stage><name>S</name><subcomponents>
    <nosecone><name>Nose</name><length>0.06</length><thickness>0.002</thickness>
      <shape>ogive</shape><aftradius>${R}</aftradius></nosecone>
    <bodytube><name>Rod</name><material type="bulk" density="${RHO}">Pine</material>
      <length>${LEN}</length><thickness>filled</thickness><radius>${R}</radius></bodytube>
  </subcomponents></stage></subcomponents></rocket></openrocket>`;

describe('.ork reads, flies and writes a filled body tube', () => {
  it('reads <thickness>filled</thickness> as solid, not as a 0.5 mm wall', () => {
    const rod = find(importOrk(ORK).tree.components, 'Rod');
    expect(rod['filled']).toBe(true);
    expect(rod['thickness']).toBeUndefined();
  });

  it('writes it back as filled, and a round trip keeps it solid', () => {
    const xml = exportOrk({ name: 'Dowel', tree: importOrk(ORK).tree });
    expect(xml).toMatch(/<bodytube>[\s\S]*?<thickness>filled<\/thickness>[\s\S]*?<\/bodytube>/);
    expect(find(importOrk(xml).tree.components, 'Rod')['filled']).toBe(true);
  });

  it('flies solid: the rod weighs its whole volume', () => {
    resetEngine();
    const tree = importOrk(ORK).tree;
    const mass = OrkRocket.buildTree(engineTree(tree)).componentInfo(find(tree.components, 'Rod').id!).mass;
    expect(Math.abs(mass - Math.PI * R * R * LEN * RHO) / mass).toBeLessThan(1e-9);
  });
});

describe('a solid tube is solid everywhere the app reads a tube wall', () => {
  const rod = (extra: Record<string, unknown> = {}): ComponentNode =>
    ({ type: 'bodytube', id: 'rod', name: 'Rod', length: LEN, outerRadius: R, ...extra } as ComponentNode);

  it('the panel offers Solid (filled) on a body tube', () => {
    const f = (FIELDS['bodytube'] ?? []).find((x) => x.key === 'filled');
    expect(f?.bool).toBe(true);
    expect(f?.label).toBe('Solid (filled)');
  });

  it('a hollow catalogue tube makes it hollow again, as desktop does', () => {
    const row: Preset = {
      kind: 'BodyTube', manufacturer: 'Test', partNo: 'BT-1', description: '',
      outsideDiameter: 0.025, insideDiameter: 0.024, length: 0.3,
    };
    expect(presetPatch('bodytube', row)['filled']).toBe(false);
    expect(presetPatch('bodytube', { ...row, filled: true })['filled']).toBe(true);
  });

  it('a catalogue row marked solid never makes a tube the file gave a wall solid, and the note says so', () => {
    // No shipped body-tube row is solid; a CSV a user imports can be. A stated
    // wall is a statement that the part is hollow, as for a nose cone.
    const row: Preset = {
      kind: 'BodyTube', manufacturer: 'Mine', partNo: 'DOWEL', description: '',
      outsideDiameter: 0.025, length: 0.3, filled: true,
    };
    const node = { type: 'bodytube', id: 'b', name: 'Tube', outerRadius: 0.0125, thickness: 0.0005 } as ComponentNode;
    const notes: string[] = [];
    expect(applyPresetLinks([{ node, manufacturer: 'Mine', partNo: 'DOWEL' }], [row], notes)).toBe(1);
    expect(node['filled']).toBeUndefined();
    expect(notes.some((n) => /disagrees/.test(n) && /Tube: [^;]*solid/.test(n))).toBe(true);
  });

  it('prints as a solid rod', () => {
    const loop = componentLoop(rod({ filled: true, thickness: 0.0005 }), {})!.loop;
    expect(Math.min(...loop.map(([, r]) => r))).toBe(0);
    expect(Math.min(...componentLoop(rod({ thickness: 0.0005 }), {})!.loop.map(([, r]) => r)))
      .toBeCloseTo(R - 0.0005, 12);
  });

  it('.rkt writes a solid tube the way RockSim does, an ID of 0', () => {
    const tree = { name: 'R', components: [{ type: 'stage', id: 's', name: 'S', children: [rod({ filled: true })] }] };
    expect(exportRkt({ name: 'R', tree: tree as unknown as RocketTree })).toMatch(/<ID>0<\/ID>/);
  });

  it('.rkt gives a solid motor mount the bore it has: none', () => {
    // <MotorDia> is mountBore, the app's one reading of a mount's bore (the
    // motor browser's fit, the Scale dialog, the recovery bay). Through the
    // 0.5 mm wall this solid 25 mm rod states, it wrote 24 mm.
    const motorDia = (extra: Record<string, unknown>) => {
      const tree = { name: 'R', components: [{ type: 'stage', id: 's', name: 'S', children: [
        rod({ thickness: 0.0005, motorMount: true, ...extra }),
      ] }] };
      const xml = exportRkt({ name: 'R', tree: tree as unknown as RocketTree });
      return Number(/<MotorDia>([^<]*)<\/MotorDia>/.exec(xml)![1]);
    };
    expect(motorDia({ filled: true })).toBe(0);
    expect(motorDia({})).toBeCloseTo(24, 9);
  });

  it('.rkt writes an automatic ring inside it at the size the kernel flies: none', () => {
    // RadiusRingComponent's automatic radius is the parent's inner radius, 0 in
    // a filled tube; desktop's RingDTO writes that 0 too. solidContextFor gives
    // no bore here, and the writer took that as "unresolved" and fell back to
    // the stated wall: a 23 mm plug in a solid 25 mm rod.
    const odOf = (tube: ComponentNode) => {
      const bh = { type: 'bulkhead', id: 'bh', name: 'Plug', length: 0.003, position: { method: 'top', offset: 0 } };
      const tree = { name: 'R', components: [{ type: 'stage', id: 's', name: 'S', children: [{ ...tube, children: [bh] }] }] };
      const ring = /<Ring>[\s\S]*?<\/Ring>/.exec(exportRkt({ name: 'R', tree: tree as unknown as RocketTree }))![0];
      return Number(/<OD>([^<]*)<\/OD>/.exec(ring)![1]);
    };
    expect(odOf(rod({ filled: true, thickness: 0.001 }))).toBe(0);
    expect(odOf(rod({ filled: true }))).toBe(0); // the .ork reader's form: no wall stated
    expect(odOf(rod({ thickness: 0.001 }))).toBeCloseTo(23, 9); // hollow: the bore
  });

  it('.rkt never folds a base extension made solid into a hollow cone', () => {
    // A .rkt cone's <BaseExtensionLen> opens as a tube marked rktBaseExtension,
    // folded back on export when unchanged. Ticked Solid behind a hollow cone it
    // is changed: folded, it went out as the hollow cone's extension, and the
    // file reopened it hollow.
    const cone = { type: 'nosecone', id: 'n', name: 'Nose', length: 0.06, aftRadius: R, thickness: 0.002, shape: 'ogive' };
    const ext = rod({ id: 'x', name: 'Nose base extension', length: 0.05, thickness: 0.002, rktBaseExtension: true });
    const save = (tube: ComponentNode) => exportRkt({ name: 'R', tree: { name: 'R', components: [
      { type: 'stage', id: 's', name: 'S', children: [cone, tube] },
    ] } as unknown as RocketTree });
    const extLen = (xml: string) => Number(/<BaseExtensionLen>([^<]*)<\/BaseExtensionLen>/.exec(xml)![1]);
    const tubeOf = (xml: string) => (xml.match(/<BodyTube>[\s\S]*?<\/BodyTube>/g) ?? [])
      .find((b) => b.includes('<Name>Nose base extension</Name>'));
    // Unchanged, it folds: 50 mm on the cone, no tube of its own.
    expect(extLen(save(ext))).toBeCloseTo(50, 9);
    expect(tubeOf(save(ext))).toBeUndefined();
    // Solid, it stays the solid tube it is.
    const solid = save({ ...ext, filled: true } as ComponentNode);
    expect(extLen(solid)).toBe(0);
    expect(tubeOf(solid)).toMatch(/<ID>0<\/ID>/);
  });

  it('.ork: a bare automatic packed radius inside it takes the device’s own size, and says so', () => {
    // OpenRocket 15.03 wrote a bare `auto`, resolved here as desktop's
    // MassObject.getAutoRadius does: from the parent's inner radius, which is 0
    // in a filled tube — and 0 is no answer there, so the device keeps its own
    // radius, the kernel's 12.5 mm. Read through the word `filled` as a wall of
    // none, the chute took the rod's full 30 mm radius.
    const ork = (thickness: string) => `<openrocket version="1.5" creator="OpenRocket 15.03"><rocket>
      <name>Rod</name><subcomponents><stage><name>S</name><subcomponents>
        <nosecone><name>Nose</name><length>0.1</length><thickness>0.002</thickness>
          <shape>ogive</shape><aftradius>0.03</aftradius></nosecone>
        <bodytube><name>Bay</name><length>0.4</length><thickness>${thickness}</thickness><radius>0.03</radius>
          <subcomponents><parachute><name>Main</name><packedlength>0.05</packedlength>
            <packedradius>auto</packedradius><diameter>0.6</diameter></parachute></subcomponents></bodytube>
      </subcomponents></stage></subcomponents></rocket></openrocket>`;
    const unresolved = (notes: string[]) => notes.some((n) => /no neighbour to take one from/.test(n) && /Main/.test(n));
    const solid = importOrk(ork('filled'));
    expect(find(solid.tree.components, 'Main')['packedRadius']).toBeCloseTo(0.0125, 12);
    expect(unresolved(solid.notes)).toBe(true);
    // Hollow, the cavity is the bore, as before.
    const hollow = importOrk(ork('0.001'));
    expect(find(hollow.tree.components, 'Main')['packedRadius']).toBeCloseTo(0.029, 12);
    expect(unresolved(hollow.notes)).toBe(false);
  });

  it('leaves a part inside it no bore to size itself to, as the kernel does (BodyTube.getInnerRadius)', () => {
    const bh = { type: 'bulkhead', id: 'bh', length: 0.003, position: { method: 'top', offset: 0 } } as ComponentNode;
    const tree = (t: ComponentNode) => ({ name: 'R', components: [{ type: 'stage', id: 's', children: [{ ...t, children: [bh] }] }] });
    expect(solidContextFor(tree(rod({ thickness: 0.001 })) as unknown as RocketTree, bh).parentInnerRadius)
      .toBeCloseTo(R - 0.001, 12);
    expect(solidContextFor(tree(rod({ filled: true, thickness: 0.001 })) as unknown as RocketTree, bh).parentInnerRadius)
      .toBeUndefined();
  });
});
