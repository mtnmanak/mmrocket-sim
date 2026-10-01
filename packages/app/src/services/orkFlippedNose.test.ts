// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import { exportOrk, importOrk } from './orkFile.js';
import { exportRkt } from './rocksimFile.js';
import { exportCdx1 } from './rasaeroFile.js';
import { engineTree } from '../tree/treeModel.js';

/**
 * A FLIPPED NOSE CONE — A TAIL CONE (format audit 2026-09-03 row 30; board
 * Tier 1 row 5). Desktop writes `<isflipped>true</isflipped>` and keeps the
 * BASE radius in `<aftradius>` and the base's shoulder in `<aftshoulder*>`
 * (NoseConeSaver); its loader then calls NoseCone.setFlipped, which moves both
 * to the fore side. The reader never read the tag and the writer wrote a
 * literal `false`, so a tail cone imported point-FORWARD — reversed geometry,
 * wrong CP and drag, a diameter step against the tube ahead — and a save turned
 * it back into a nose cone in the user's own file.
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

const ORK = (chain: string) => `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket>
  <name>Tail</name><subcomponents><stage><name>S</name><subcomponents>${chain}</subcomponents></stage>
  </subcomponents></rocket></openrocket>`;

const NOSE = `<nosecone><name>Nose</name><length>0.2</length><thickness>0.002</thickness>
  <shape>ogive</shape><aftradius>0.03</aftradius></nosecone>`;
const TUBE = `<bodytube><name>Tube</name><length>0.8</length><thickness>0.001</thickness><radius>0.03</radius>
  <subcomponents><trapezoidfinset><name>Fins</name><fincount>3</fincount><rootchord>0.1</rootchord>
  <tipchord>0.05</tipchord><sweeplength>0.05</sweeplength><height>0.06</height><thickness>0.003</thickness>
  <axialoffset method="bottom">0.0</axialoffset></trapezoidfinset></subcomponents></bodytube>`;
/** Desktop's own example's tail ("Pods--airframes and winglets.ork"), scaled to this airframe. */
const TAIL = (flipped: string, aftradius = '0.03') => `<nosecone><name>Tail</name>
  <material type="bulk" density="112.0">Balsa</material><length>0.12</length><thickness>filled</thickness>
  <shape>conical</shape><aftradius>${aftradius}</aftradius>
  <aftshoulderradius>0.0285</aftshoulderradius><aftshoulderlength>0.03</aftshoulderlength>
  <aftshoulderthickness>0.0285</aftshoulderthickness><aftshouldercapped>false</aftshouldercapped>
  <isflipped>${flipped}</isflipped></nosecone>`;

describe('.ork reads, flies and writes a flipped nose cone as a tail cone', () => {
  it('reads <isflipped>true</isflipped>, keeping the base radius and its shoulder', () => {
    const tail = find(importOrk(ORK(NOSE + TUBE + TAIL('true'))).tree.components, 'Tail');
    expect(tail['flipped']).toBe(true);
    expect(tail['aftRadius']).toBeCloseTo(0.03, 12);
    expect(tail['shoulderLength']).toBeCloseTo(0.03, 12);
  });

  it('leaves an unflipped nose cone without the key', () => {
    const tail = find(importOrk(ORK(NOSE + TUBE + TAIL('false'))).tree.components, 'Tail');
    expect(tail['flipped']).toBeUndefined();
  });

  it('writes <isflipped> from the design, and a round trip keeps it', () => {
    const tree = importOrk(ORK(NOSE + TUBE + TAIL('true'))).tree;
    const xml = exportOrk({ name: 'Tail', tree });
    expect(xml).toContain('<isflipped>true</isflipped>');
    expect(xml).toContain('<isflipped>false</isflipped>'); // the real nose stays a nose
    expect(find(importOrk(xml).tree.components, 'Tail')['flipped']).toBe(true);
  });

  it("resolves a bare automatic base on a tail cone from the part AHEAD of it, where its base is", () => {
    const tail = find(importOrk(ORK(NOSE + TUBE + TAIL('true', 'auto'))).tree.components, 'Tail');
    expect(tail['aftRadius']).toBeCloseTo(0.03, 12);
  });

  it('sizes a bare automatic packed radius inside such a tail cone from the part AHEAD too', () => {
    // A recovery device in the cone whose <packedradius> is a bare `auto` takes
    // the cavity it sits in: the cone's base, found forward, at the tube — not
    // behind the point, where there is nothing (makeAutoRadii `packed`).
    const tail = (flipped: string) => `<nosecone><name>Tail</name><length>0.12</length>
      <thickness>0.002</thickness><shape>conical</shape><aftradius>auto</aftradius>
      <isflipped>${flipped}</isflipped><subcomponents>
      <streamer><name>Tape</name><packedlength>0.05</packedlength><packedradius>auto</packedradius>
      <striplength>1.0</striplength><stripwidth>0.05</stripwidth></streamer></subcomponents></nosecone>`;
    const packed = (flipped: string) =>
      find(importOrk(ORK(NOSE + TUBE + tail(flipped))).tree.components, 'Tape')['packedRadius'];
    expect(packed('true')).toBeCloseTo(0.03, 12);
    // Unflipped, the same cone's base faces aft, at nothing: the reader's own
    // 12.5 mm for a mass object it cannot size.
    expect(packed('false')).toBeCloseTo(0.0125, 12);
  });

  it('hands its base to an automatic transition ahead of it, and only its point to one behind', () => {
    const transition = (name: string, fore: string, aft: string) => `<transition><name>${name}</name>
      <length>0.05</length><thickness>0.002</thickness><shape>conical</shape>
      <foreradius>${fore}</foreradius><aftradius>${aft}</aftradius></transition>`;
    const parts = importOrk(ORK(NOSE + TUBE + transition('Ahead', '0.03', 'auto')
      + TAIL('true', '0.02') + transition('Behind', 'auto', '0.01'))).tree.components;
    expect(find(parts, 'Ahead')['aftRadius']).toBeCloseTo(0.02, 12);
    // A point is no face to take a radius from: the reader's own 25 mm, as for
    // a transition ahead of an ordinary nose cone (makeAutoRadii rearFace).
    expect(find(parts, 'Behind')['foreRadius']).toBeCloseTo(0.025, 12);
  });

  it('flies as a tail cone: no diameter step, its solid mass at the wide fore end', () => {
    resetEngine();
    const tree = importOrk(ORK(NOSE + TUBE + TAIL('true'))).tree;
    const rocket = OrkRocket.buildTree(engineTree(tree));
    expect(rocket.staticInfo().warningTexts.some((w) => /discontinu/i.test(w))).toBe(false);
    const tail = rocket.componentInfo(find(tree.components, 'Tail').id!);
    // The cone's own centroid is a quarter of its length behind its (forward)
    // base, and the shoulder forward of it pulls the part's CG further forward.
    expect(tail.cgX).toBeLessThan(0.25 * 0.12);
  });
});

describe('exporters with no flipped nose cone', () => {
  const tree = (): RocketTree => ({
    name: 'Tail',
    components: [{
      type: 'stage', id: 's', name: 'S',
      children: [
        { type: 'nosecone', id: 'n', name: 'Nose', length: 0.2, aftRadius: 0.03, thickness: 0.002, shape: 'ogive' },
        { type: 'bodytube', id: 'b', name: 'Tube', length: 0.8, outerRadius: 0.03, thickness: 0.001 },
        {
          type: 'nosecone', id: 't', name: 'Tail', length: 0.12, aftRadius: 0.03, filled: true, shape: 'conical',
          shoulderRadius: 0.0285, shoulderLength: 0.03, flipped: true,
        },
      ],
    } as ComponentNode],
  });

  it('RockSim: writes the tail cone as the transition it is, as desktop does', () => {
    const xml = exportRkt({ name: 'Tail', tree: tree() });
    expect(xml.match(/<NoseCone>/g)?.length).toBe(1); // the real nose only
    const transition = /<Transition>[\s\S]*?<\/Transition>/.exec(xml)?.[0] ?? '';
    expect(transition).toContain('<Name>Tail</Name>');
    expect(transition).toMatch(/<FrontDia>60(\.0+)?<\/FrontDia>/);
    expect(transition).toMatch(/<RearDia>0<\/RearDia>/);
    expect(transition).toMatch(/<FrontShoulderLen>30(\.0+)?<\/FrontShoulderLen>/);
    expect(transition).toMatch(/<ConstructionType>0<\/ConstructionType>/); // still solid
  });

  it('RockSim: keeps a base-extension tube behind a tail cone as a tube, not folded into the cone', () => {
    // A .rkt nose cone's <BaseExtensionLen> opens as a body tube marked
    // rktBaseExtension, and the exporter folds that tube back into its cone.
    // Flip the cone to a tail cone and it goes out as a <Transition>, which has
    // no <BaseExtensionLen>: folded, the tube would vanish from the file.
    const t = tree();
    t.components[0]!.children!.push({
      type: 'bodytube', id: 'x', name: 'Tail base extension', length: 0.05, outerRadius: 0.03,
      thickness: 0.03, // the solid form the importer gives a filled cone's extension
      rktBaseExtension: true,
    } as ComponentNode);
    const xml = exportRkt({ name: 'Tail', tree: t });
    const tube = (xml.match(/<BodyTube>[\s\S]*?<\/BodyTube>/g) ?? [])
      .find((b) => b.includes('<Name>Tail base extension</Name>'));
    expect(tube).toBeDefined();
    expect(tube).toMatch(/<Len>50(\.0+)?<\/Len>/);
  });

  it('RASAero: refuses, naming the part, as desktop does', () => {
    expect(() => exportCdx1({ name: 'Tail', tree: tree() })).toThrow(/Tail.*tail cone|tail cone.*Tail/i);
  });

  it('RASAero: refuses a tail cone at the back of a booster too, where a nose cone is otherwise dropped', () => {
    const t = tree();
    const sustainer = t.components[0]!;
    sustainer.children = sustainer.children!.filter((c) => c.id !== 't');
    expect(() => exportCdx1({ name: 'Plain', tree: t })).not.toThrow();
    t.components.push({
      type: 'stage', id: 's2', name: 'Booster',
      children: [
        { type: 'bodytube', id: 'bb', name: 'Booster tube', length: 0.4, outerRadius: 0.03, thickness: 0.001 },
        { type: 'nosecone', id: 'bt', name: 'Booster tail', length: 0.1, aftRadius: 0.03, shape: 'conical', flipped: true },
      ],
    } as ComponentNode);
    expect(() => exportCdx1({ name: 'Two', tree: t })).toThrow(/Booster tail/);
  });

  it('RASAero: refuses a tail cone in a pod set too, which the pod writer dropped without a word', () => {
    // The pod writer keeps only a pod's body tubes and transitions, as RASAero's
    // fin can or recessed boat tail. A tube with a tail cone behind it went out
    // as a fin can, the cone left out of the file; a pod on a booster's tube
    // was never written at all. desktop ignores a whole pod set with a warning
    // ("Unsupported component ..., ignoring"); the guide promises a .CDX1
    // export refuses a tail cone "for the back of a rocket or pod".
    const podded = (tail: Record<string, unknown>): RocketTree => {
      const t = tree();
      const sustainer = t.components[0]!;
      sustainer.children = sustainer.children!.filter((c) => c.id !== 't');
      sustainer.children.find((c) => c.id === 'b')!.children = [{
        type: 'podset', id: 'p', name: 'Side pods', instanceCount: 2, children: [
          { type: 'bodytube', id: 'pb', name: 'Pod tube', length: 0.2, outerRadius: 0.012, thickness: 0.0005 },
          { type: 'nosecone', id: 'pt', name: 'Pod tail', length: 0.05, aftRadius: 0.012, shape: 'conical', ...tail },
        ],
      } as unknown as ComponentNode];
      return t;
    };
    expect(() => exportCdx1({ name: 'Pods', tree: podded({ flipped: true }) }))
      .toThrow(/RASAero has no tail cone — “Pod tail” in pod set “Side pods” is flipped to point aft/);
    // An unflipped nose cone in a pod is not written either, and is not refused:
    // only a tail cone, as in a booster.
    expect(() => exportCdx1({ name: 'Pods', tree: podded({}) })).not.toThrow();
    // A pod on a BOOSTER's tube, which the writer never visits.
    const t = tree();
    const sustainer = t.components[0]!;
    sustainer.children = sustainer.children!.filter((c) => c.id !== 't');
    const booster = podded({ flipped: true }).components[0]!.children!.find((c) => c.id === 'b')!;
    t.components.push({ type: 'stage', id: 's2', name: 'Booster', children: [{ ...booster, id: 'bb' }] } as ComponentNode);
    expect(() => exportCdx1({ name: 'Two', tree: t })).toThrow(/“Pod tail” in pod set “Side pods”/);
  });
});
