// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode } from '@online-openrocket/engine';
import { importRkt } from './rocksimFile.js';
import { engineTree } from '../tree/treeModel.js';

/**
 * PARTS THE FILE ATTACHES WHERE NOTHING CAN BUILD THEM (batch 6). RockSim lets a
 * part hang off almost anything; the kernel, like desktop OR 24.12, does not:
 * a body tube carries no nose cone or transition (BodyTube.isCompatible), a
 * transition carries only internal parts and freeform fins
 * (Transition.isCompatible), an inner tube carries only internal parts
 * (InnerTube.isCompatible), and a stage carries only nose cones, body tubes and
 * transitions (AxialStage.isCompatible). Until now the reader kept such a part,
 * and the build threw on it — "Transition not currently compatible with
 * BodyTube" — so six corpus files opened with no mass, CG, CP or flight.
 * Desktop's RockSim reader drops each one with "… can not be attached to …,
 * ignoring component" (BaseHandler.isCompatible, FinSetHandler:297-313) and
 * opens the rest; so does this one, naming every part it left out.
 */
const rkt = (stage: string): string => `<RockSimDocument><DesignInformation><RocketDesign>
  <Name>Attach</Name><StageCount>1</StageCount>
  <Stage3Parts>
    <NoseCone><Name>Nose</Name><Len>100</Len><BaseDia>40</BaseDia><ShapeCode>1</ShapeCode></NoseCone>
    ${stage}
  </Stage3Parts><Stage2Parts/><Stage1Parts/>
</RocketDesign></DesignInformation></RockSimDocument>`;

const tube = (name: string, attached = '', extra = ''): string =>
  `<BodyTube><Name>${name}</Name><OD>40</OD><ID>38</ID><Len>300</Len>${extra}<AttachedParts>${attached}</AttachedParts></BodyTube>`;
const mount = `<BodyTube><Name>Mount</Name><OD>24.8</OD><ID>24</ID><Len>70</Len><IsMotorMount>1</IsMotorMount>
  <IsInsideTube>1</IsInsideTube><LocationMode>2</LocationMode><Xb>0</Xb></BodyTube>`;
const fins = `<FinSet><Name>Fins</Name><FinCount>3</FinCount><RootChord>60</RootChord><TipChord>30</TipChord>
  <SemiSpan>40</SemiSpan><SweepDistance>20</SweepDistance><Thickness>3</Thickness><LocationMode>2</LocationMode><Xb>0</Xb></FinSet>`;
const transition = (name: string, attached = ''): string => `<Transition><Name>${name}</Name><FrontDia>40</FrontDia>
  <RearDia>30</RearDia><Len>50</Len><AttachedParts>${attached}</AttachedParts></Transition>`;

const flatten = (ns: ComponentNode[]): ComponentNode[] => ns.flatMap((n) => [n, ...flatten(n.children ?? [])]);
const named = (tree: { components: ComponentNode[] }, name: string) => flatten(tree.components).filter((n) => n.name === name);
const leftOut = (notes: string[]) => notes.find((n) => /^Left out /.test(n));
const builds = (tree: Parameters<typeof engineTree>[0]): number => {
  resetEngine();
  const info = OrkRocket.buildTree(engineTree(tree)).staticInfo();
  return info.mass;
};

describe('.rkt parts attached where the kernel cannot build them', () => {
  it('leaves out a transition inside a body tube (Semroc-Taurus.rkt) and builds the rest', () => {
    const r = importRkt(rkt(tube('Main Body tube', `${transition('Pod Nose')}${fins}${mount}`)));
    expect(named(r.tree, 'Pod Nose')).toHaveLength(0);
    expect(named(r.tree, 'Fins')).toHaveLength(1);
    expect(named(r.tree, 'Mount')).toHaveLength(1);
    expect(leftOut(r.notes)).toBe('Left out the transition “Pod Nose” on the body tube “Main Body tube”: the app, '
      + 'like desktop OR, cannot attach that kind of part there, so the design could not be built with it.');
    expect(builds(r.tree)).toBeGreaterThan(0);
  }, 30_000);

  it('leaves out a tube fin set and a pod on a transition (LexxJet.rkt, Centuri_Jayhawk.rkt)', () => {
    const pod = `<ExternalPod><Name>Side pod</Name><Detachable>1</Detachable><AttachedParts>
      <NoseCone><Name>Pod nose</Name><Len>40</Len><BaseDia>18</BaseDia></NoseCone>
      ${tube('Pod tube')}</AttachedParts></ExternalPod>`;
    // A pod holding its chain directly, outside AttachedParts, carries it too.
    const barePod = `<ExternalPod><Name>Bare pod</Name>${tube('Bare pod tube')}</ExternalPod>`;
    const tubeFins = '<TubeFinSet><Name>Jet tubes</Name><OD>30</OD><ID>28</ID><Len>50</Len><TubeCount>2</TubeCount></TubeFinSet>';
    const r = importRkt(rkt(`${tube('Body', mount)}${transition('Tail', `${tubeFins}${pod}${barePod}${fins}`)}`));
    expect(named(r.tree, 'Jet tubes')).toHaveLength(0);
    expect(named(r.tree, 'Side pod')).toHaveLength(0);
    expect(named(r.tree, 'Pod tube')).toHaveLength(0);
    // Fins on a transition still come in, as freeform (the existing rule).
    expect(named(r.tree, 'Fins')[0]?.type).toBe('freeformfinset');
    const note = leftOut(r.notes)!;
    expect(note).toBe('Left out 3 parts the file attaches where the app, like desktop OR, cannot attach that kind '
      + 'of part, so the design could not be built with them: the tube fin set “Jet tubes” on the transition “Tail”; '
      + 'the pod “Side pod” on the transition “Tail”, with the parts attached to it; '
      + 'the pod “Bare pod” on the transition “Tail”, with the parts attached to it.');
    // A pod that was left out is not also announced as imported.
    expect(r.notes.some((n) => /Side pod/.test(n) && /imported as/.test(n))).toBe(false);
    expect(builds(r.tree)).toBeGreaterThan(0);
  }, 30_000);

  it('leaves out fins and a launch lug on an inner tube, keeps its rings (USS-Andromeda.rkt)', () => {
    const inner = `<BodyTube><Name>Thin tube</Name><OD>18.8</OD><ID>18</ID><Len>200</Len><IsMotorMount>1</IsMotorMount>
      <AttachedParts>${fins}<LaunchLug><Name>Lug</Name><OD>3.2</OD><ID>3</ID><Len>15</Len></LaunchLug>
      <Ring><Name>Ring</Name><OD>38</OD><ID>18.8</ID><Len>3</Len></Ring></AttachedParts></BodyTube>`;
    const r = importRkt(rkt(tube('Body', inner)));
    expect(named(r.tree, 'Thin tube')[0]?.type).toBe('innertube');
    expect(named(r.tree, 'Fins')).toHaveLength(0);
    expect(named(r.tree, 'Lug')).toHaveLength(0);
    expect(named(r.tree, 'Ring')).toHaveLength(1);
    expect(leftOut(r.notes)).toContain('the fin set “Fins” on the inner tube “Thin tube”; the launch lug “Lug” on the inner tube “Thin tube”');
    expect(builds(r.tree)).toBeGreaterThan(0);
  }, 30_000);

  it('leaves out a part a stage-level sub-assembly puts in the stage itself', () => {
    const r = importRkt(rkt(`${tube('Body', mount)}<SubAssembly><Name>Sub</Name><AttachedParts>${fins}</AttachedParts></SubAssembly>`));
    expect(named(r.tree, 'Fins')).toHaveLength(0);
    expect(leftOut(r.notes)).toContain('the fin set “Fins” on the stage “Sustainer”');
    expect(builds(r.tree)).toBeGreaterThan(0);
  }, 30_000);

  it('converts a trapezoid fin set on a nose cone to freeform, as on a transition, and builds', () => {
    const r = importRkt(`<RockSimDocument><DesignInformation><RocketDesign><Name>A</Name><StageCount>1</StageCount>
      <Stage3Parts><NoseCone><Name>Nose</Name><Len>100</Len><BaseDia>40</BaseDia><AttachedParts>${fins}</AttachedParts>
      </NoseCone>${tube('Body', mount)}</Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`);
    expect(named(r.tree, 'Fins')[0]?.type).toBe('freeformfinset');
    expect(r.notes).toContain('Fins on a nose cone were converted to a freeform outline (same planform) — OpenRocket '
      + 'only allows freeform fins on a nose cone.');
    expect(leftOut(r.notes)).toBeUndefined();
    expect(builds(r.tree)).toBeGreaterThan(0);
  }, 30_000);

  it('says nothing when every part can be built', () => {
    const r = importRkt(rkt(tube('Body', `${fins}${mount}`)));
    expect(leftOut(r.notes)).toBeUndefined();
  });

  it('puts a stage-level tube marked inside a tube into the body tube in front of it (semroc_sls_lil_hustler.rkt)', () => {
    // The file lists the motor mount in a stage-level sub-assembly, flagged
    // <IsInsideTube>, at an absolute station inside the aft body tube.
    const loose = `<SubAssembly><Name>Sub</Name><AttachedParts><BodyTube><Name>Loose mount</Name><OD>25.3</OD><ID>24.1</ID>
      <Len>127</Len><IsMotorMount>1</IsMotorMount><IsInsideTube>1</IsInsideTube><LocationMode>1</LocationMode>
      <Xb>273</Xb></BodyTube></AttachedParts></SubAssembly>`;
    const r = importRkt(rkt(`${tube('Aft tube')}${loose}`));
    const stage = r.tree.components[0]!;
    expect(stage.children!.map((c) => c.name)).toEqual(['Nose', 'Aft tube']);
    const moved = named(r.tree, 'Loose mount')[0]!;
    expect(moved.type).toBe('innertube');
    expect(named(r.tree, 'Aft tube')[0]!.children).toContain(moved);
    expect(moved.position).toEqual({ method: 'absolute', offset: 0.273 });
    expect(r.notes).toContain('The file marks the tube “Loose mount” as inside the rocket but lists it among the stage’s '
      + 'outer parts, which cannot hold it; the app put it inside the body tube in front of it, “Aft tube”, at the '
      + 'position the file gives it. Desktop OR adds it to the outside of the rocket as another body tube.');
    expect(builds(r.tree)).toBeGreaterThan(0);
  }, 30_000);

  it('with no body tube in front of it, such a tube is a body tube, as desktop OR reads it', () => {
    const r = importRkt(`<RockSimDocument><DesignInformation><RocketDesign><Name>A</Name><StageCount>1</StageCount>
      <Stage3Parts>${tube('Only tube', '', '<IsInsideTube>1</IsInsideTube><IsMotorMount>1</IsMotorMount>')}</Stage3Parts>
      </RocketDesign></DesignInformation></RockSimDocument>`);
    expect(named(r.tree, 'Only tube')[0]?.type).toBe('bodytube');
    expect(builds(r.tree)).toBeGreaterThan(0);
  }, 30_000);
});
