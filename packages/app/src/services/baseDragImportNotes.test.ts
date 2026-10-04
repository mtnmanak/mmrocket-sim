// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { BASE_DRAG_DECLARATION, baseDragImportNotes } from './baseDragImportNotes.js';
import { exportOrk, importOrk } from './orkFile.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { parseXml } from './xmlParse.js';

const body: ComponentNode = { id: 'body', type: 'bodytube', name: 'Airframe', length: 0.7, outerRadius: 0.05 };
const cone = (extra: Record<string, unknown> = {}): ComponentNode => ({
  id: 'tail', type: 'transition', name: 'Base Drag Model Transition', length: 0.32,
  foreRadius: 1.27e-6, aftRadius: 0.05, thickness: 2.54e-8, filled: false, ...extra,
});
const tree = (...parts: ComponentNode[]): RocketTree => ({ components: [
  { id: 'stage', type: 'stage', children: parts },
] });
const warnings = (result: { tree: RocketTree; notes: string[] }) => {
  // The live warning strip owns this advisory, never the import banner as well.
  expect(result.notes.filter(n => n.startsWith('Possible base-drag model:'))).toEqual([]);
  return baseDragImportNotes(result.tree);
};
const cdx = (comments: string, tail = '<NoseCone><Length>12</Length><Diameter>4</Diameter><Shape>Conical</Shape></NoseCone>') =>
  importCdx1(`<RASAeroDocument><RocketDesign>
    <Comments>${comments}</Comments><NoseCone><Length>6</Length><Diameter>4</Diameter></NoseCone>
    <BodyTube><Length>12</Length><Diameter>4</Diameter></BodyTube>${tail}
    </RocketDesign></RASAeroDocument>`);
const declarationTag = '<mmrbasedragdeclaration>true</mmrbasedragdeclaration>';
const physicalTree = (design: RocketTree): unknown => JSON.parse(JSON.stringify(design.components,
  (key, value: unknown) => key === 'id' || key === BASE_DRAG_DECLARATION ? undefined : value));

describe('ancestor-subsumed base-drag evidence', () => {
  const design = (part: Record<string, unknown> = {}, stage: Record<string, unknown> = {}): RocketTree => ({
    components: [{ id: 'stage', type: 'stage', overrideMass: 1.72, overrideSubcomponentsMass: true,
      ...stage, children: [body, cone({ name: 'Transition', thickness: 0.05, overrideCD: 0, ...part })] }],
  });

  it('recognizes a pointed zero-CD cone with ancestor-subsumed mass without changing the tree', () => {
    const t = design();
    const before = structuredClone(t);
    expect(baseDragImportNotes(t)).toHaveLength(1);
    expect(baseDragImportNotes(t)[0]).toContain('its mass included in an ancestor\u2019s override of all subcomponents');
    expect(t).toEqual(before);
  });

  it('accepts a matching name instead of zero CD at the pointed-tip boundary', () => {
    expect(baseDragImportNotes(design({ name: 'base cone', overrideCD: undefined,
      foreRadius: (body['outerRadius'] as number) * 0.1 })))
      .toHaveLength(1);
  });

  it.each([
    { foreRadius: 0.00501 }, // Just outside 10% of the preceding body's aft radius.
    { foreRadius: 0.02, name: 'base cone' }, // Name and zero CD cannot waive the point.
    { overrideCD: undefined },
    { overrideCD: 0.01 },
    { overrideCD: NaN },
    { name: 'Real weighed boattail', foreRadius: 0.05, aftRadius: 0.02, overrideCD: undefined },
  ])('rejects subsumed geometry or corroboration near miss %j', part => {
    expect(baseDragImportNotes(design(part))).toEqual([]);
  });

  it.each([
    { overrideSubcomponentsMass: false },
    { overrideSubcomponentsMass: undefined },
    { overrideMass: undefined },
    { overrideMass: NaN },
    { overrideMass: Infinity },
    { overrideMass: undefined, overrideCGX: 0.5, overrideSubcomponentsCG: true },
  ])('requires an active ancestor mass override AND its subcomponent flag %j', stage => {
    expect(baseDragImportNotes(design({}, stage))).toEqual([]);
  });

  it('uses the full ancestor chain but does not borrow an override from another branch', () => {
    const t = design();
    const parts = t.components[0]!.children!;
    t.components[0]!.children = [{ ...body, id: 'main', children: [
      { id: 'pod', type: 'podset', children: parts },
    ] }];
    expect(baseDragImportNotes(t)).toHaveLength(1);
    t.components[0]!['overrideSubcomponentsMass'] = false;
    t.components.push({ id: 'other', type: 'stage', overrideMass: 2, overrideSubcomponentsMass: true });
    expect(baseDragImportNotes(t)).toEqual([]);
  });

  it('distinguishes a cone own override from a covering ancestor and keeps existing alternatives', () => {
    // The cone's massive own override still counts unless an ancestor covers it.
    expect(baseDragImportNotes(design({ overrideMass: 0.2, overrideSubcomponentsMass: true },
      { overrideSubcomponentsMass: false }))).toEqual([]);
    expect(baseDragImportNotes(design({ overrideMass: 0.2 }))).toHaveLength(1);
    // An unflagged ancestor does not invalidate independent, component-local evidence.
    expect(baseDragImportNotes(design({ overrideMass: 0 }, { overrideSubcomponentsMass: false }))).toHaveLength(1);
    expect(baseDragImportNotes(design({ name: 'base cone', thickness: 0 },
      { overrideSubcomponentsMass: false }))).toHaveLength(1);
    expect(baseDragImportNotes(design({ overrideCD: undefined, [BASE_DRAG_DECLARATION]: true },
      { overrideSubcomponentsMass: false }))).toHaveLength(1);
  });

  it('preserves ancestor mass flags and a single live advisory through ORK round trips', () => {
    const reopened = importOrk(exportOrk({ name: 'Synthetic weighed design', tree: design() }));
    expect(warnings(reopened)).toHaveLength(1);
    expect(reopened.tree.components[0]!['overrideSubcomponentsMass']).toBe(true);
    expect(reopened.tree.components[0]!['overrideMass']).toBe(1.72);
  });

  it('matches shipped-kernel mass accounting with and without child replacement', async () => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const mass = (t: RocketTree) => OrkRocket.buildTree(t).staticInfo().massEmpty;
    const unpinned = design({}, { overrideMass: undefined, overrideSubcomponentsMass: false });
    const geometric = mass(unpinned);
    const withoutCone = structuredClone(unpinned);
    withoutCone.components[0]!.children!.pop();
    const bodyMass = mass(withoutCone);
    expect(geometric).toBeGreaterThan(bodyMass);
    // Kilograms, 1e-9 decimal tolerance; comparisons use measured kernel mass.
    expect(mass(design({}, { overrideSubcomponentsMass: false }))).toBeCloseTo(geometric + 1.72, 9);
    expect(mass(design())).toBeCloseTo(1.72, 9);
    expect(mass(design({ overrideMass: 0.2 }))).toBeCloseTo(1.72, 9);
    expect(mass(design({ overrideMass: 0.2 }, { overrideMass: undefined }))).toBeCloseTo(bodyMass + 0.2, 9);
    expect(mass(design({ overrideMass: 0 }, { overrideSubcomponentsMass: false }))).toBeCloseTo(bodyMass + 1.72, 9);
  });
});

describe('conservative base-drag design note', () => {
  it('recognizes the corpus thin-wall form without an active mass override, without changing the tree', () => {
    const design = tree(body, cone());
    const before = structuredClone(design);
    const notes = baseDragImportNotes(design);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('extremely thin shell');
    expect(notes[0]).toContain('can move the center of pressure (CP) aft');
    expect(notes[0]).toContain('can overstate the stability margin');
    expect(notes[0]).toContain('keeps the part as modeled');
    expect(notes[0]).toContain('use Delete');
    expect(design).toEqual(before);
  });

  it.each([
    { name: 'BD', overrideMass: 0, thickness: 0.002 },
    { name: 'Cone', overrideMass: 1e-6, overrideCD: 0, thickness: 0.002 },
    { name: 'Cone', foreRadius: 0.02, overrideMass: 0, overrideCD: 0, thickness: 0.002 },
    { name: 'Cone', overrideMass: 0, thickness: 0.002 },
    { type: 'nosecone', name: 'virtual cone', overrideMass: 0, thickness: 0.002 },
  ])('recognizes corroborated massless tail $name', patch => {
    expect(baseDragImportNotes(tree(body, cone(patch)))).toHaveLength(1);
  });

  it.each([
    { overrideMass: 0.01 }, // A real mass takes precedence over even the ghost wall.
    { thickness: 0.002 }, // Name alone is not evidence.
    { filled: true },
    { name: 'Real shell' }, // Thin wall alone is not evidence.
    { overrideMass: 0, foreRadius: 0.05, aftRadius: 0.025 }, // Ordinary shrinking boattail.
    { type: 'nosecone', flipped: true, overrideMass: 0 },
    { type: 'bodytube', name: 'Fake Body Tube', length: 0.000254, outerRadius: 0.05, overrideMass: 1e-6, motorMount: true },
    { type: 'bodytube', name: 'base drag disk', length: 0.001, outerRadius: 0.05, overrideMass: 0, overrideCD: 0 },
    { type: 'bulkhead', name: 'base drag disk', overrideMass: 0 }, // Internal part has no lifting surface.
    { type: 'bodytube', name: 'BD', length: 0.3, outerRadius: 0.05, overrideMass: 0 },
  ])('does not flag near miss %j', patch => {
    expect(baseDragImportNotes(tree(body, cone(patch)))).toEqual([]);
  });

  it('requires a terminal part after the airframe, not a massless forward or intermediate part', () => {
    expect(baseDragImportNotes(tree(cone(), body))).toEqual([]);
    expect(baseDragImportNotes(tree(body, cone(), { ...body, id: 'after' }))).toEqual([]);
    expect(baseDragImportNotes(tree(cone()))).toEqual([]);
  });

  it('checks pod chains independently, but never internal components', () => {
    const pod: ComponentNode = { id: 'pod', type: 'podset', children: [body, cone()] };
    expect(baseDragImportNotes(tree({ ...body, id: 'main', children: [pod] }))).toHaveLength(1);
    expect(baseDragImportNotes(tree({ ...body, children: [cone()] }))).toEqual([]);
    const nested = { ...body, id: 'outer', children: [body,
      cone({ position: { method: 'top', offset: 0.7 } })] };
    expect(baseDragImportNotes(tree(nested))).toEqual([]);
  });

  it.each(['base cone', 'Base-Cone', 'basecone'])('recognizes a zero-wall %s behind a massless spacer', name => {
    const spacer: ComponentNode = { ...body, id: 'spacer', length: 0.02, overrideMass: 0 };
    const design = tree(body, spacer, cone({ type: 'nosecone', name, thickness: 0, overrideCD: 0 }));
    const before = structuredClone(design);
    expect(baseDragImportNotes(design)).toHaveLength(1);
    expect(baseDragImportNotes(design)[0]).toContain('the app shows more stability margin than the rocket really has');
    expect(design).toEqual(before);
  });

  it('recognizes a base cone name with a near-zero override and no other corroboration', () => {
    expect(baseDragImportNotes(tree(body, cone({ name: 'base cone', thickness: 0.002,
      foreRadius: 0.02, overrideMass: 1e-6 })))).toHaveLength(1);
  });

  it.each([
    { name: 'Real boattail', foreRadius: 0.05, aftRadius: 0.02, overrideMass: 0.03 },
    { type: 'nosecone', name: 'Real tail cone', flipped: true, thickness: 0.002, density: 680 },
    { name: 'base cone', thickness: 0.002, density: 680 },
    { name: 'base cone', overrideMass: 0.03 },
    { name: 'Transition', thickness: 0.05, density: 680, overrideCD: 0 },
    { name: 'base cone', thickness: 0.002, density: 1e-9 }, // Density alone remains ambiguous.
    { name: 'base cone', filled: true, thickness: 0 },
    { name: 'base cone', overrideMass: -1e-6 },
    { name: 'base cone', thickness: -1e-8 },
    { name: 'base cone', thickness: 1.01e-7 },
    { name: 'base cone', thickness: undefined },
    { name: 'base cone', length: 0 },
    { name: 'base cone', aftRadius: 0 },
    { name: 'base cone', foreRadius: -0.01, aftRadius: 0, overrideMass: 0 },
    { name: 'base cone', aftRadius: Infinity },
    { name: 'base cone', aftRadius: undefined },
    { name: 'base cone', foreRadius: undefined },
    { name: 'base cone', overrideMass: 1.01e-6 },
    { name: 'base cone', overrideMass: NaN, thickness: 0.002 },
    { name: 'base cone', overrideMass: Infinity, thickness: 0.002 },
    { name: 'Shell', foreRadius: 0.02, overrideMass: 0, thickness: 0.002 },
  ])('keeps conservative evidence for %j', patch => {
    expect(baseDragImportNotes(tree(body, cone(patch)))).toEqual([]);
  });

  it('does not borrow mass cancellation or a name from another component', () => {
    const cancellation: ComponentNode = { id: 'cancel', type: 'masscomponent', name: 'base cone', mass: 0 };
    expect(baseDragImportNotes(tree(body, cone({ name: 'Transition', thickness: 0.002,
      children: [cancellation] })))).toEqual([]);
    expect(baseDragImportNotes(tree({ ...body, outerRadius: 0 }, cone()))).toEqual([]);
  });

  it('wires the .ork importer and retains the suspicious part and overrides', () => {
    const result = importOrk(`<openrocket version="1.10"><rocket><name>Test</name><subcomponents>
      <stage><subcomponents><bodytube><length>0.7</length><radius>0.05</radius></bodytube>
      <nosecone><name>BD</name><length>0.32</length><aftradius>0.05</aftradius><shape>conical</shape>
      <overridemass>0</overridemass><overriddencd>0</overriddencd></nosecone>
      </subcomponents></stage></subcomponents></rocket></openrocket>`);
    expect(warnings(result)).toHaveLength(1);
    const tail = result.tree.components[0]!.children![1]!;
    expect(tail.name).toBe('BD');
    expect(tail['overrideMass']).toBe(0);
  });

  it('keeps the Gizmo_4-shaped warning through .rkt -> .ork export -> re-import', () => {
    const result = importRkt(`<RockSimDocument><DesignInformation><RocketDesign><Name>Test</Name>
      <Stage3Parts><NoseCone><Name>Nose cone</Name><Len>406.4</Len><BaseDia>102.235</BaseDia>
      <WallThickness>2</WallThickness><ConstructionType>1</ConstructionType></NoseCone>
      <BodyTube><Name>Airframe</Name><Len>304.8</Len><OD>102.235</OD><ID>100</ID></BodyTube>
      <Transition><Name>Base Drag Model Transition</Name><Len>321.183</Len><FrontDia>0.00254</FrontDia>
      <RearDia>102.235</RearDia><WallThickness>0.0000254</WallThickness><ConstructionType>1</ConstructionType>
      <Density>1199.78</Density><KnownMass>0</KnownMass><UseKnownCG>0</UseKnownCG></Transition>
      </Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`);
    expect(warnings(result)).toHaveLength(1);
    const tail = result.tree.components[0]!.children!.at(-1)!;
    expect(tail['overrideMass']).toBeUndefined();
    expect(tail['thickness']).toBeCloseTo(2.54e-8, 14);
    const xml = exportOrk({ name: 'Gizmo_4-shaped', tree: result.tree });
    const reopened = importOrk(xml);
    const reopenedTail = reopened.tree.components[0]!.children!.at(-1)!;
    expect(reopenedTail['filled']).toBeUndefined();
    expect(reopenedTail['overrideMass']).toBeUndefined();
    expect(reopenedTail['thickness']).toBeCloseTo(2.54e-8, 14);
    expect(reopenedTail['foreRadius']).toBeCloseTo(1.27e-6, 12);
    expect(reopenedTail['aftRadius']).toBeCloseTo(0.0511175, 12);
    expect(warnings(reopened)).toHaveLength(1);
  });

  it.each(['rounded', 'airfoil'])('does not flag a zero-mass zero-CD 1 mm unchanged-radius tube (%s fins)', async crossSection => {
    const { OrkRocket, resetEngine } = await import('@online-openrocket/engine');
    resetEngine();
    const nose: ComponentNode = { id: 'nose', type: 'nosecone', length: 0.2, aftRadius: 0.05,
      thickness: 0.002, shape: 'ogive' };
    const airframe: ComponentNode = { ...body, thickness: 0.002, children: [
      { id: 'fins', type: 'freeformfinset', finCount: 4, thickness: 0.003, crossSection,
        points: [[0, 0], [0.08, 0.06], [0.15, 0.06], [0.2, 0]] },
    ] };
    const tube: ComponentNode = { id: 'tail', type: 'bodytube', name: 'base drag disk',
      length: 0.001, outerRadius: 0.05, thickness: 0.002, overrideMass: 0, overrideCD: 0 };
    const original = tree(nose, airframe), extended = tree(nose, airframe, tube);
    expect(baseDragImportNotes(extended)).toEqual([]);
    // staticInfo is Mach 0.3, AoA 0. Check both Classic and the app's default Kbf.
    for (const kbf of [false, true]) {
      const baseline = OrkRocket.buildTree(original), candidate = OrkRocket.buildTree(extended);
      baseline.setRogersModifiedBarrowman(kbf);
      candidate.setRogersModifiedBarrowman(kbf);
      const before = baseline.staticInfo(), after = candidate.staticInfo();
      expect(before.cp).toBeGreaterThan(0);
      expect(before.mass).toBeGreaterThan(0);
      // Differential comparisons, 1e-10 precision: no fixed kernel float literals.
      for (const key of ['cp', 'cpWorst', 'cg', 'mass', 'cna', 'stabilityCalibers', 'stabilityCalibersWorst'] as const) {
        expect(after[key]).toBeCloseTo(before[key]!, 10);
      }
    }
  });

  it('requires both an explicit CDX1 virtual declaration and matching aft geometry', () => {
    const parse = cdx;
    const nose = '<NoseCone><Length>12</Length><Diameter>4</Diameter><Shape>Conical</Shape></NoseCone>';
    const positive = parse('Added a massless base drag cone', nose);
    expect(warnings(positive)).toHaveLength(1);
    expect(positive.tree.components[0]!.children).toHaveLength(3);
    expect(warnings(parse('Ordinary design', nose))).toEqual([]);
    expect(warnings(parse('Added a massless base drag cone', ''))).toEqual([]);
    expect(warnings(parse('Added a massless base drag cone', '<BoatTail><Length>4</Length><RearDiameter>2</RearDiameter></BoatTail>'))).toEqual([]);
  });

  it('keeps the CDX1 declaration through repeated .ork round trips as nonphysical component metadata', () => {
    const positive = cdx('Added a massless base drag cone');
    const ordinary = cdx('Ordinary design');
    expect(physicalTree(positive.tree)).toEqual(physicalTree(ordinary.tree));
    expect(exportOrk({ name: ordinary.name, tree: ordinary.tree })).not.toContain(declarationTag);
    expect(positive.tree.components[0]!.children!.map(n => n[BASE_DRAG_DECLARATION]))
      .toEqual([undefined, undefined, true]);
    let design = positive.tree;
    for (let round = 0; round < 2; round++) {
      const xml = exportOrk({ name: positive.name, tree: design });
      // Like importOrk, strip the single-quoted declaration for happy-dom.
      const doc = parseXml(xml.replace(/^<\?xml[^?]*\?>/, ''), 'Invalid test ORK XML');
      // Desktop ComponentParameterHandler owns this direct child; it is NOT a component.
      expect(doc.querySelectorAll('mmrbasedragdeclaration')).toHaveLength(1);
      expect(Array.from(doc.querySelectorAll('nosecone')).at(-1)!
        .querySelectorAll(':scope > mmrbasedragdeclaration'))
        .toHaveLength(1);
      const reopened = importOrk(xml);
      const without = importOrk(xml.replace(declarationTag, ''));
      expect(warnings(reopened)).toHaveLength(1);
      expect(warnings(without)).toEqual([]);
      expect(physicalTree(reopened.tree)).toEqual(physicalTree(without.tree));
      const tail = reopened.tree.components[0]!.children!.at(-1)!;
      expect(tail[BASE_DRAG_DECLARATION]).toBe(true);
      expect(tail['thickness']).toBe(0.002);
      expect(tail['overrideMass']).toBeUndefined();
      expect(tail['overrideCD']).toBeUndefined();
      design = reopened.tree;
    }
    // Removing the declared part must not transfer its evidence to a replacement cone.
    design.components[0]!.children!.pop();
    design.components[0]!.children!.push(ordinary.tree.components[0]!.children!.at(-1)!);
    const replaced = exportOrk({ name: positive.name, tree: design });
    expect(replaced).not.toContain(declarationTag);
    expect(warnings(importOrk(replaced))).toEqual([]);
  });

  it('accepts only a true declaration directly under the component', () => {
    const positive = cdx('Added a massless base drag cone');
    const xml = exportOrk({ name: positive.name, tree: positive.tree });
    for (const replacement of [
      '<mmrbasedragdeclaration>false</mmrbasedragdeclaration>',
      '<mmrbasedragdeclaration>garbage</mmrbasedragdeclaration>',
      `<metadata>${declarationTag}</metadata>`,
    ]) {
      const reopened = importOrk(xml.replace(declarationTag, replacement));
      expect(warnings(reopened)).toEqual([]);
      expect(reopened.tree.components[0]!.children!.at(-1)![BASE_DRAG_DECLARATION]).toBeUndefined();
    }
  });

  it('still checks geometry and real mass when a declaration is retained', () => {
    const declared = { name: 'Cone', thickness: 0.002, [BASE_DRAG_DECLARATION]: true };
    expect(baseDragImportNotes(tree(body, cone(declared)))).toHaveLength(1);
    expect(baseDragImportNotes(tree(body, cone({ ...declared, overrideMass: 0.01 })))).toEqual([]);
    expect(baseDragImportNotes(tree(body, cone({ ...declared, foreRadius: 0.02 })))).toEqual([]);
    expect(baseDragImportNotes(tree(body, cone({ ...declared, foreRadius: 0.05, aftRadius: 0.025 })))).toEqual([]);
    expect(baseDragImportNotes(tree(body, cone(declared), { ...body, id: 'after' }))).toEqual([]);
  });
});
