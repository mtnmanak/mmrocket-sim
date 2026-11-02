// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import { cdx1SurfaceFinish, exportCdx1, importCdx1, importCdx1Flown, rasaeroManufacturerAbbrev } from './rasaeroFile.js';
import { cdx1StageFigures } from './cdx1StageFigures.js';
import { engineTree } from '../tree/treeModel.js';
import { MOTOR_DB, hasMassData } from './motorDb.js';
import { bundledOnlyFetchSpec } from './thrustcurve.js';
import { checkFormatLoss } from './formatLoss.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

const all = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...all(n.children ?? [])]);
const tree = (): RocketTree => ({ components: [{ type: 'stage', id: 's', children: [
  { type: 'nosecone', id: 'n', name: 'Nose', length: 0.2, aftRadius: 0.03, shape: 'conical' },
  { type: 'bodytube', id: 't', name: 'Tube', length: 0.8, outerRadius: 0.03, children: [
    { type: 'trapezoidfinset', id: 'f', name: 'Polished fins', finCount: 3, rootChord: 0.15,
      tipChord: 0.07, height: 0.08, sweep: 0.05, finish: 'finishpolished' },
  ] },
] }] });

describe('M3 RASAero regressions', () => {
  it('keeps intact automatic transition radii when measuring three stage prefixes', async () => {
    const t: RocketTree = { components: [0.03, 0.06, 0.02].map((radius, i) => ({
      type: 'stage', id: `s${i}`, children: [
        { type: 'bodytube', id: `t${i}`, length: 0.2, outerRadius: radius, thickness: 0.001, motorMount: true },
        ...(i < 2 ? [{ type: 'transition' as const, id: `x${i}`, length: 0.1,
          foreRadius: radius, thickness: 0.001, shape: 'conical' }] : []),
      ],
    })) };
    const before = structuredClone(t);
    const motor = MOTOR_DB.find(m => hasMassData(m) && m.diameter <= 29 && m.length < 180
      && rasaeroManufacturerAbbrev(m.manufacturerAbbrev) !== null)!;
    const spec = await bundledOnlyFetchSpec(motor, Infinity);
    const specs = Object.fromEntries([0, 1, 2].map(i => [`t${i}`, spec]));
    const rocket = OrkRocket.buildTree(engineTree(t));
    const expectedMasses = t.components.map(s => rocket.componentInfo(s.id!).sectionMass);
    for (const id of Object.keys(specs)) rocket.setMotorById(id, spec);
    const figures = cdx1StageFigures(t, specs, rocket.staticInfo());
    for (let i = 0; i < 3; i++) {
      expect(figures[i]!.mass - (figures[i - 1]?.mass ?? 0)).toBeCloseTo(expectedMasses[i]! + spec.masses[0]!, 10);
    }
    expect(t).toEqual(before);
    const xml = exportCdx1({ name: 'Auto radii', tree: t, launchStages: figures,
      motors: Object.fromEntries(Object.keys(specs).map(id => [id,
        { designation: motor.designation, manufacturer: motor.manufacturerAbbrev }])) });
    const back = await importCdx1Flown(xml, { catalogue: MOTOR_DB, flownSpec: bundledOnlyFetchSpec });
    for (let i = 0; i < 3; i++) expect(Math.abs((back.tree.components[i]!.overrideMass as number)
      - expectedMasses[i]!)).toBeLessThan(0.0001);
    const restored = OrkRocket.buildTree(engineTree(back.tree));
    for (const id of Object.keys(back.motors)) restored.setMotorById(id, spec);
    expect(Math.abs(restored.staticInfo().mass - rocket.staticInfo().mass)).toBeLessThan(0.0001);
    expect(Math.abs(restored.staticInfo().cg - rocket.staticInfo().cg)).toBeLessThan(0.0001);
  });

  it('applies the file surface to every constructed exterior part', () => {
    const body = '<BodyTube><Length>30</Length><Diameter>3</Diameter><LaunchLugDiameter>0.3</LaunchLugDiameter><LaunchLugLength>1</LaunchLugLength></BodyTube>';
    const r = importCdx1(`<RASAeroDocument><RocketDesign><Surface>Polished</Surface>${body}
      <FinCan><Length>5</Length><Diameter>3.2</Diameter><InsideDiameter>3</InsideDiameter><ShoulderLength>1</ShoulderLength></FinCan>
      <Booster><Length>20</Length><Diameter>3</Diameter><InsideDiameter>2.8</InsideDiameter><ShoulderLength>1</ShoulderLength>
      <BoattailLength>2</BoattailLength><BoattailRearDiameter>2</BoattailRearDiameter></Booster>
      </RocketDesign></RASAeroDocument>`);
    const exterior = all(r.tree.components).filter(n => ['bodytube', 'transition', 'launchlug'].includes(n.type));
    expect(exterior.length).toBeGreaterThan(5);
    for (const n of exterior) expect(n.finish, n.name).toBe('finishpolished');
    expect(cdx1SurfaceFinish(r.tree).surface).toBe('Polished');
  });

  it('chooses finish by summed exterior wetted area, so a small rough lug cannot win', () => {
    const t = tree();
    for (const n of all(t.components)) if (n.type !== 'stage') n.finish = 'mirror';
    t.components[0]!.children![1]!.children!.push({ type: 'launchlug', name: 'Rough lug',
      length: 0.01, outerRadius: 0.002, finish: 'rough' });
    expect(cdx1SurfaceFinish(t).surface).toBe('Smooth (Zero Roughness)');
    expect(cdx1SurfaceFinish(t).note).toContain('Rough lug');
  });

  it('keeps RASAero Smooth Paint unchanged instead of mapping its 5 µm finish to 2 µm Sheet Metal', () => {
    const imported = importCdx1('<RASAeroDocument><RocketDesign><Surface>Smooth Paint</Surface><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube></RocketDesign></RASAeroDocument>');
    expect(exportCdx1({ name: 'Paint', tree: imported.tree })).toContain('<Surface>Smooth Paint</Surface>');
  });

  it.each(['NoThrust', 'real engine'])('ignores excluded booster figures with %s, even without a chosen configuration', shape => {
    const motor = MOTOR_DB.find(m => hasMassData(m) && rasaeroManufacturerAbbrev(m.manufacturerAbbrev) !== null)!;
    const realEngine = `${motor.designation}  (${rasaeroManufacturerAbbrev(motor.manufacturerAbbrev)!})`;
    const engine = shape === 'NoThrust' ? shape : realEngine;
    const xml = (sustainer: string) => `<RASAeroDocument><RocketDesign>
      <BodyTube><Length>30</Length><Diameter>3</Diameter></BodyTube>
      <Booster><Length>20</Length><Diameter>3</Diameter></Booster></RocketDesign><SimulationList><Simulation>
      ${sustainer}<SustainerLaunchWt>4</SustainerLaunchWt><SustainerCG>15</SustainerCG>
      <Booster1Engine>${engine}</Booster1Engine><IncludeBooster1>False</IncludeBooster1>
      <Booster1LaunchWt>6</Booster1LaunchWt><Booster1CG>25</Booster1CG></Simulation></SimulationList></RASAeroDocument>`;
    for (const sustainer of ['', `<SustainerEngine>${realEngine}</SustainerEngine>`]) {
      const r = importCdx1(xml(sustainer));
      expect(r.chosenConfigId === null).toBe(sustainer === '');
      expect(r.tree.components[1]!.overrideMass).toBeUndefined();
      expect(r.tree.components[1]!.overrideCGX).toBeUndefined();
      for (const c of r.configs) expect(c.stageMassOverrides?.[r.tree.components[1]!.id!]?.overrideMass).toBeUndefined();
    }
  });
  it.each([2, 3].flatMap(count => ['all', 'sustainer', 'none'].map(power => [count, power] as const)))(
    'measures and restores %i stage stacks with %s motors, including overrides', async (count, power) => {
    const motor = MOTOR_DB.find(m => hasMassData(m) && m.diameter <= 54 && m.length < 300
      && m.totalWeightG < 500 && rasaeroManufacturerAbbrev(m.manufacturerAbbrev) !== null)!;
    const spec = await bundledOnlyFetchSpec(motor, Infinity);
    const t = tree();
    t.components[0]!.overrideMass = 1;
    t.components[0]!.overrideSubcomponentsMass = true;
    t.components[0]!.overrideCGX = 0.6;
    t.components[0]!.overrideSubcomponentsCG = true;
    t.components[0]!.children![1]!.motorMount = true;
    for (let i = 1; i < count; i++) t.components.push({ type: 'stage', id: `s${i}`,
      overrideMass: 0.5, overrideSubcomponentsMass: true, overrideCGX: 0.2, overrideSubcomponentsCG: true,
      children: [{ type: 'bodytube', id: `t${i}`, length: 0.4, outerRadius: 0.03, motorMount: true }] });
    const ids = ['t', ...Array.from({ length: count - 1 }, (_, i) => `t${i + 1}`)];
    const activeIds = power === 'all' ? ids : power === 'sustainer' ? ids.slice(0, 1) : [];
    const specs = Object.fromEntries(activeIds.map(id => [id, spec]));
    const rocket = OrkRocket.buildTree(engineTree(t));
    for (const id of activeIds) rocket.setMotorById(id, spec);
    const info = rocket.staticInfo();
    const figures = cdx1StageFigures(t, specs, info);
    expect(figures).toHaveLength(count);
    expect(figures[0]!.mass).toBeCloseTo(1 + (power === 'none' ? 0 : spec.masses[0]!), 10);
    const saved = exportCdx1({ name: 'Loaded stacks', tree: t, launchMassKg: info.mass, launchCgM: info.cg,
      launchStages: figures, motors: Object.fromEntries(activeIds.map(id => [id,
        { designation: motor.designation, manufacturer: motor.manufacturerAbbrev }])) });
    const r = await importCdx1Flown(saved, { catalogue: MOTOR_DB, flownSpec: bundledOnlyFetchSpec });
    const back = OrkRocket.buildTree(engineTree(r.tree));
    for (const id of Object.keys(r.motors)) back.setMotorById(id, spec);
    // .CDX1 rounds pounds/inches to four decimals: 0.1 g and 0.1 mm cover that quantization.
    if (power === 'all') {
      expect(Math.abs(back.staticInfo().mass - info.mass)).toBeLessThan(0.0001);
      expect(Math.abs(back.staticInfo().cg - info.cg)).toBeLessThan(0.0001);
    }
    for (let i = 0; i < count; i++) {
      if (i > 0 && power !== 'all') {
        // Desktop ignores excluded booster cells, including motorless app saves.
        expect(r.tree.components[i]!.overrideMass).toBeUndefined();
        expect(r.tree.components[i]!.overrideCGX).toBeUndefined();
        continue;
      }
      expect(Math.abs((r.tree.components[i]!.overrideMass as number) - (i === 0 ? 1 : 0.5))).toBeLessThan(0.0001);
      expect(Math.abs((r.tree.components[i]!.overrideCGX as number) - (i === 0 ? 0.6 : 0.2))).toBeLessThan(0.0001);
    }
    // Reading export figures must not reset or mutate the Design page's existing handle.
    expect(rocket.staticInfo().mass).toBe(info.mass);
  });

  it('writes and restores real cumulative weights and nose-referenced CGs for all stages', () => {
    const t = tree();
    t.components.push({ type: 'stage', id: 'b', children: [
      { type: 'bodytube', length: 0.4, outerRadius: 0.03 },
    ] });
    const figures = { launchStages: [{ mass: 1, cg: 0.6 }, { mass: 1.5, cg: 0.8 }] };
    const saved = exportCdx1({ name: 'Two stages', tree: t, launchMassKg: 1.5, launchCgM: 0.8, ...figures });
    expect(saved).toContain('<SustainerLaunchWt>2.2046</SustainerLaunchWt>');
    const r = importCdx1(saved.replace('<IncludeBooster1>False</IncludeBooster1>', '<IncludeBooster1>True</IncludeBooster1>'));
    expect(r.tree.components[0]!.overrideMass).toBeCloseTo(1, 4);
    expect(r.tree.components[1]!.overrideMass).toBeCloseTo(0.5, 4);
    expect(r.tree.components[0]!.overrideCGX).toBeCloseTo(0.6, 4);
    expect(r.tree.components[1]!.overrideCGX).toBeCloseTo(0.2, 4);
    const notes: string[] = [];
    exportCdx1({ name: 'Excluded', tree: t, notes });
    expect(notes.join('\n')).toMatch(/weight and CG cells are ignored.*computed construction/);
  });

  it('includes implicit normal exterior finish and names the choice and differing parts', () => {
    const t = tree();
    const saved = exportCdx1({ name: 'Mixed finish', tree: t });
    expect(saved).toContain('<Surface>Rough Camouflage Paint</Surface>');
    const report = checkFormatLoss('cdx1', { tree: t, motors: {}, launch: DEFAULT_CONDITIONS,
      configs: [], activeConfigId: null, measured: { massKg: null, cgM: null }, flightData: {} });
    expect(report.losses.join('\n')).toMatch(/Surface finish.*Rough Camouflage Paint.*Polished fins/);
    expect(report.losses.filter(n => n.includes('Surface finish'))).toHaveLength(1);
    expect(all(importCdx1(saved).tree.components).find(n => n.type === 'trapezoidfinset')!.finish ?? 'normal').toBe('normal');
  });

  it('ignores inner and omitted finishes and consistently reports nearest-choice changes', () => {
    const t = tree();
    t.components[0]!.children![1]!.children!.push({ type: 'masscomponent', finish: 'rough' });
    t.components[0]!.children![0]!.finish = 'polished';
    t.components[0]!.children![1]!.finish = 'polished';
    t.components[0]!.children![1]!.children![0]!.finish = 'polished';
    const notes: string[] = [];
    expect(exportCdx1({ name: 'Inner finish', tree: t, notes })).toContain('<Surface>Sheet Metal</Surface>');
    expect(notes.join('\n')).toMatch(/Surface finish.*Sheet Metal/);
  });

  it.each(['BodyTube', 'Booster', 'FinCan'])('builds desktop lugs on %s', tag => {
    const r = importCdx1(`<RASAeroDocument><RocketDesign><${tag}><PartType>${tag}</PartType>
      <Length>20</Length><Diameter>3</Diameter><LaunchLugDiameter>0.375</LaunchLugDiameter>
      <LaunchLugLength>1</LaunchLugLength></${tag}></RocketDesign></RASAeroDocument>`);
    const lug = all(r.tree.components).find(n => n.type === 'launchlug')!;
    expect(lug.instanceCount).toBe(2);
    expect(lug.thickness).toBeCloseTo(0.001, 10);
    expect(lug.length).toBeCloseTo(1 / 39.37, 10);
    expect(lug.position).toEqual({ method: 'top', offset: 0.0254 });
    expect(lug.instanceSeparation).toBeCloseTo(20 / 39.37 - 0.0508 - 1 / 39.37, 10);
    expect(lug.angleOffset).toBeCloseTo(-Math.acos((0.6616 * 1.5 - 0.1875) / (1.5 + 0.1875)), 10);
  });

  it('keeps the excluded-booster caution with every affected configuration', () => {
    const sim = (include: boolean) => `<Simulation><SustainerEngine>J350W  (AT)</SustainerEngine>
      <Booster1Engine>K550W  (AT)</Booster1Engine><IncludeBooster1>${include}</IncludeBooster1></Simulation>`;
    const r = importCdx1(`<RASAeroDocument><RocketDesign>
      <BodyTube><PartType>BodyTube</PartType><Length>40</Length><Diameter>3</Diameter></BodyTube>
      <Booster><PartType>Booster</PartType><Length>20</Length><Diameter>3</Diameter></Booster>
      </RocketDesign><SimulationList>${sim(false)}${sim(true)}${sim(false)}</SimulationList></RASAeroDocument>`);
    expect(r.notes.join('\n')).not.toContain('would not leave the pad');
    for (const i of [0, 2]) {
      expect(r.configs[i]!.stageMassNotes!.join('\n')).toMatch(/Booster.*unpowered.*drag and mass/);
      expect(r.configNotes![r.configs[i]!.id]).toEqual(r.configs[i]!.stageMassNotes);
      const caution = r.configs[i]!.stageMassNotes!.find(n => n.includes('excluded'))!;
      expect(r.noteTiers?.find(n => n.text === caution)?.kind).toBe('I12.booster-excluded');
    }
    expect(r.configs[1]!.stageMassNotes!.join('\n')).not.toContain('flies along unpowered');
  });

  it('shows the caution for an excluded middle booster even when the bottom stage is powered', () => {
    const body = (tag: string) => `<${tag}><PartType>${tag}</PartType><Length>20</Length><Diameter>3</Diameter></${tag}>`;
    const r = importCdx1(`<RASAeroDocument><RocketDesign>${body('BodyTube')}${body('Booster')}${body('Booster')}
      </RocketDesign><SimulationList><Simulation><SustainerEngine>J350W  (AT)</SustainerEngine>
      <IncludeBooster1>False</IncludeBooster1><IncludeBooster2>True</IncludeBooster2>
      <Booster2Engine>K550W  (AT)</Booster2Engine></Simulation></SimulationList></RASAeroDocument>`);
    expect(r.notes.join('\n')).toContain('Booster is excluded in RASAero simulation 1');
    expect(r.configs[0]!.stageMassNotes!.filter(n => n.includes('excluded'))).toHaveLength(1);
  });
});
