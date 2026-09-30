// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrkRocket, type ComponentNode, type RocketTree } from '@online-openrocket/engine';
import { exportRkt, importRkt } from './rocksimFile.js';
import { exportOrk, importOrk, type OrkDeployOverride } from './orkFile.js';
import { configOntoTree, planImport, resolveImportMotors } from './importApply.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { engineTree } from '../tree/treeModel.js';

const all = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap((n) => [n, ...all(n.children ?? [])]);
const chute = (tree: RocketTree) => all(tree.components).find((n) => n.type === 'parachute')!;
const event = (serial: string | number, type: number, altitude = 0, delay = 0) =>
  `<SimulationEvent><PartSerialNo>${serial}</PartSerialNo><Type>${type}</Type><DeployAltitude>${altitude}</DeployAltitude><DeplyTime>${delay}</DeplyTime></SimulationEvent>`;
const sim = (events: string, delay = 4, code = 'E15', wrapper = 'SimulationEvents') =>
  `<SimulationResults><SimulationName>Run</SimulationName><${wrapper}>${events}</${wrapper}><Stage3Engines><EngineSet><MountSerialNo>1</MountSerialNo><EngineCode>${code}</EngineCode><EngineMfg>AeroTech</EngineMfg><EjectionDelay>${delay}</EjectionDelay></EngineSet></Stage3Engines></SimulationResults>`;
const fixture = (defaults: string, sims: string) => `<RockSimDocument><DesignInformation><RocketDesign><Name>Recovery</Name><StageCount>1</StageCount>
  <SimulationEventList>${defaults}</SimulationEventList><Stage3Parts><BodyTube><Name>Body</Name><SerialNo>1</SerialNo><Len>500</Len><OD>50</OD><ID>48</ID><IsMotorMount>1</IsMotorMount><AttachedParts>
  <Parachute><Name>Main</Name><SerialNo>12</SerialNo><Dia>450</Dia></Parachute>
  <Streamer><Name>Streamer</Name><SerialNo>13</SerialNo><Len>300</Len><Width>40</Width></Streamer>
  </AttachedParts></BodyTube></Stage3Parts></RocketDesign></DesignInformation><SimulationResultsList>${sims}</SimulationResultsList></RockSimDocument>`;
const state = (d: Partial<OrkDeployOverride>) => ({ deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0, ...d });

describe('resolved RockSim recovery configurations', () => {
  it('keeps same-motor recovery variants, folds true duplicates, and switches A→B→A completely', () => {
    const r = importRkt(fixture(event(12, 5, 121.92),
      sim(event(12, 2, 0, 2)) + sim(event(12, 1)) + sim(event(12, 5, 121.92), -2)
      + sim(event(12, 1))));
    expect(r.configs).toHaveLength(3);
    expect(r.configSources![r.configs[1]!.id]).toContain('Simulation 4');
    expect(chute(r.tree)).toMatchObject(state({ deployDelay: 2 }));
    expect(r.configs.map((c) => c.deployments[chute(r.tree).id!])).toEqual([
      state({ deployDelay: 2 }), state({}), state({ deployEvent: 'altitude', deployAltitude: 121.92 }),
    ]);
    expect(Object.values(r.configs[2]!.motors)[0]!.delay).toBe(Infinity);
    let tree = configOntoTree(r.tree, r.configs[1]!);
    expect(chute(tree)).toMatchObject(state({}));
    tree = configOntoTree(tree, r.configs[2]!);
    expect(chute(tree)).toMatchObject(state({ deployEvent: 'altitude', deployAltitude: 121.92 }));
    expect(chute(configOntoTree(tree, r.configs[0]!))).toMatchObject(state({ deployDelay: 2 }));
    expect(r.configNotes?.[r.configs[1]!.id]?.join(' ')).toContain('Main at the ejection charge');
    expect(r.configNotes?.[r.configs[2]!.id]?.join(' ')).toContain('121.92 m descending');
  });

  it('inherits only design defaults, handles the legacy wrapper, and diagnoses unknown/Pro conditions', () => {
    const r = importRkt(fixture(event(12, 4), sim(event(12, 2, 0, 2)) + sim(event(13, 5, 50), 4, 'E15', 'SimulationEventList')
      + sim(event(12, 28).replace('</SimulationEvent>', '<ProEvent>1</ProEvent></SimulationEvent>'))));
    const id = chute(r.tree).id!;
    expect(r.configs[1]!.deployments[id]).toEqual(state({ deployEvent: 'apogee' }));
    expect(r.configs[2]!.deployments[id]).toEqual(state({ deployEvent: 'apogee' }));
    expect(r.configNotes?.[r.configs[2]!.id]?.join(' ')).toMatch(/does not recognise \(28\)/);
    expect(r.configNotes?.[r.configs[2]!.id]?.join(' ')).toMatch(/Pro conditions/);
    const bare = importRkt(fixture('', sim(event(12, 2, 0, 3)) + sim('')).replace('<SimulationEventList></SimulationEventList>', ''));
    expect(bare.configs[1]!.deployments[chute(bare.tree).id!]).toEqual(state({}));
  });

  it('keeps diagnostics and source identity when an unsupported entry falls back to an equivalent configuration', () => {
    const r = importRkt(fixture(event(12, 4), sim('') + sim(event(12, 28)
      .replace('</SimulationEvent>', '<TestCondition>1,0,0</TestCondition></SimulationEvent>'))));
    expect(r.configs).toHaveLength(1);
    expect(r.notes.join(' ')).toMatch(/Simulation 2.*does not recognise \(28\)/);
    expect(r.notes.join(' ')).toContain('Pro conditions');
  });

  it('retains the explanation when a source altitude without a positive height falls back to apogee', () => {
    const r = importRkt(fixture('', sim(event(12, 5))));
    expect(chute(r.tree)['deployEvent']).toBe('apogee');
    expect(r.notes.join(' ')).toContain('Main at apogee (the file asks for an altitude but names none).');
  });

  it('materializes defaults for recovery devices without source serial numbers', () => {
    const r = importRkt(fixture('', sim('') + sim('', 6)).replace('<SerialNo>12</SerialNo>', ''));
    const id = chute(r.tree).id!;
    expect(r.configs).toHaveLength(2);
    expect(r.configs.map((c) => c.deployments[id])).toEqual([state({}), state({})]);
    Object.assign(chute(r.tree), { deployEvent: 'altitude', deployAltitude: 42, deployDelay: 2 });
    expect(chute(configOntoTree(r.tree, r.configs[1]!))).toMatchObject(state({}));
  });

  it('motor-match re-pick applies the matching recovery and notes', async () => {
    const r = importRkt(fixture(event(12, 5, 121.92), sim(event(12, 1), 4, 'NoSuchMotor') + sim(event(12, 4), 4, 'E15')));
    const resolved = await resolveImportMotors(r, async (ref) => ({
      motor: ref.designation === 'NoSuchMotor' ? undefined : {
        label: 'E15-4', spec: { designation: 'E15', diameter: 0.024, length: 0.07,
          cgX: 0.035, times: [0, 1], thrusts: [0, 0], masses: [0.05, 0.03], ejectionDelay: 4 },
        meta: { label: 'E15-4' }, ignition: { event: 'automatic', delay: 0 },
      }, note: '',
    }));
    const planned = planImport(r, resolved, { launch: DEFAULT_CONDITIONS,
      text: { mass: String, length: String } });
    expect(planned.snapshot.activeConfigId).toBe('rocksim-sim-2');
    expect(chute(planned.snapshot.tree)).toMatchObject(state({ deployEvent: 'apogee' }));
    expect(planned.note.text).toContain('Main at apogee');
    expect(planned.note.text).not.toContain('Main at the ejection charge');
  });
});

function clusterTree(): RocketTree {
  return { name: 'Cluster', components: [{ type: 'stage', id: 'stage', children: [
    { type: 'nosecone', id: 'nose', length: 0.15, aftRadius: 0.04, thickness: 0.002, shape: 'ogive' },
    { type: 'bodytube', id: 'body', length: 0.5, outerRadius: 0.04, thickness: 0.001, children: [
      { type: 'innertube', id: 'mount', name: 'Mount', length: 0.1, outerRadius: 0.01, thickness: 0.001,
        motorMount: true, cluster: '4-ring', position: { method: 'bottom', offset: 0 }, children: [
          { type: 'engineblock', id: 'block', name: 'Block', length: 0.005, outerRadius: 0.009,
            innerRadius: 0.006, overrideMass: 0.003, overrideCGX: 0.0025, position: { method: 'top', offset: 0.01 } },
          { type: 'parachute', id: 'chute', name: 'Main', diameter: 0.2, deployEvent: 'altitude', deployAltitude: 121.92 },
        ] },
    ] },
  ] }] } as RocketTree;
}
const motor = { designation: 'C6', manufacturer: 'Estes', diameter: 0.018, length: 0.07, delay: 3 };
const docOf = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
const tubes = (doc: Document) => [...doc.querySelectorAll('BodyTube')].filter((el) => el.querySelector(':scope > IsInsideTube')?.textContent === '1');
const xmlOf = (doc: Document) => new XMLSerializer().serializeToString(doc);

describe('RockSim recovery and cluster export', () => {
  it('emits every child and event serial, with correct units and no invented flight results; two cycles preserve kernel mass/CG', () => {
    let tree = clusterTree();
    const initial = OrkRocket.buildTree(engineTree(tree)).staticInfo();
    for (let cycle = 0; cycle < 2; cycle++) {
      const mount = all(tree.components).find((n) => n.type === 'innertube')!;
      const xml = exportRkt({ name: 'Cluster', tree, motors: { [mount.id!]: motor } });
      const doc = docOf(xml);
      expect(tubes(doc)).toHaveLength(4);
      expect(doc.querySelectorAll('Ring')).toHaveLength(4);
      expect([...doc.querySelectorAll('Ring > KnownMass')].map((e) => Number(e.textContent))).toEqual([3, 3, 3, 3]);
      const serials = [...doc.querySelectorAll('SerialNo')].map((e) => e.textContent);
      expect(new Set(serials).size).toBe(serials.length);
      const recoverySerials = [...doc.querySelectorAll('Parachute > SerialNo')].map((e) => e.textContent);
      for (const wrapper of ['RocketDesign > SimulationEventList', 'SimulationResults > SimulationEvents']) {
        expect([...doc.querySelectorAll(`${wrapper} > SimulationEvent > PartSerialNo`)].map((e) => e.textContent)).toEqual(recoverySerials);
        expect([...doc.querySelectorAll(`${wrapper} DeployAltitude`)].map((e) => Number(e.textContent))).toEqual([121.92, 121.92, 121.92, 121.92]);
      }
      expect(xml).not.toMatch(/HasDeployed|DeployedAt_/);
      tree = importRkt(xml).tree;
      expect(all(tree.components).filter((n) => n.type === 'engineblock')).toHaveLength(1);
      expect(all(tree.components).find((n) => n.type === 'innertube')?.['cluster']).toBe('4-ring');
      const info = OrkRocket.buildTree(engineTree(tree)).staticInfo();
      // Same geometry serialized in SI/mm; 1 microgram and 1 micrometre allow floating serialization noise.
      expect(Math.abs(info.massEmpty - initial.massEmpty)).toBeLessThan(1e-9);
      expect(Math.abs(info.cgEmpty - initial.cgEmpty)).toBeLessThan(1e-6);
    }
  });

  it.each([
    ['ejection', 0, 200, 1], ['ejection', 2, 200, 2], ['apogee', 0, 200, 4], ['altitude', 0, 121.92, 5],
  ])('writes %s/%s/%s without motors as design defaults', (deployEvent, deployDelay, deployAltitude, type) => {
    const tree = clusterTree(); Object.assign(chute(tree), { deployEvent, deployDelay, deployAltitude });
    const xml = exportRkt({ name: 'T', tree });
    expect(docOf(xml).querySelector('SimulationEvent > Type')?.textContent).toBe(String(type));
    expect(xml).not.toContain('<SimulationResults>');
    expect(chute(importRkt(xml).tree)).toMatchObject({ deployEvent, deployDelay,
      deployAltitude: deployEvent === 'altitude' ? deployAltitude : 200 });
  });

  it.each([
    ['launch', 0, 200], ['never', 0, 200], ['apogee', 1, 200], ['altitude', 1, 100], ['altitude', 0, 0],
  ])('refuses unsupported %s/%s/%s with device and .ork advice', (deployEvent, deployDelay, deployAltitude) => {
    const tree = clusterTree(); Object.assign(chute(tree), { deployEvent, deployDelay, deployAltitude });
    expect(() => exportRkt({ name: 'T', tree })).toThrow(/Main.*cannot faithfully save.*Save as \.ork/);
  });

  it.each(['missing child', 'mass', 'position', 'recovery', 'overhang', 'preset'])('preserves separate tubes with differing %s', (difference) => {
    const doc = docOf(exportRkt({ name: 'T', tree: clusterTree(), motors: { mount: motor } }));
    const t = tubes(doc)[1]!;
    if (difference === 'missing child') t.querySelector('Ring')!.remove();
    if (difference === 'mass') t.querySelector('Ring > KnownMass')!.textContent = '4';
    if (difference === 'position') t.querySelector('Ring > Xb')!.textContent = '12';
    if (difference === 'overhang') t.querySelector(':scope > EngineOverhang')!.textContent = '8';
    if (difference === 'preset') {
      for (const [tag, value] of [['PartMfg', 'Example'], ['PartNo', 'Different block']]) {
        const el = doc.createElement(tag!); el.textContent = value!; t.querySelector('Ring')!.append(el);
      }
    }
    if (difference === 'recovery') {
      const serial = t.querySelector('Parachute > SerialNo')!.textContent;
      for (const e of doc.querySelectorAll('SimulationEvents > SimulationEvent')) {
        if (e.querySelector('PartSerialNo')!.textContent === serial) e.querySelector('Type')!.textContent = '1';
      }
    }
    const r = importRkt(xmlOf(doc));
    expect(all(r.tree.components).filter((n) => n.type === 'innertube')).toHaveLength(4);
    expect(r.notes.join(' ')).toContain(difference === 'overhang' ? 'different motor overhangs' : 'different child parts');
    expect(Object.keys(r.motors)).toHaveLength(4);
  });

  it('repairs stale motor serials before refusing a merge for different overhangs', () => {
    const tree = clusterTree(); all(tree.components).find((n) => n.id === 'mount')!['cluster'] = 'double';
    const doc = docOf(exportRkt({ name: 'T', tree, motors: { mount: motor } }));
    const ts = tubes(doc); ts[1]!.querySelector('EngineOverhang')!.textContent = '8';
    const sets = [...doc.querySelectorAll('EngineSet > MountSerialNo')]; sets[1]!.textContent = sets[0]!.textContent;
    const r = importRkt(xmlOf(doc));
    expect(Object.keys(r.motors)).toHaveLength(2);
    expect(all(r.tree.components).filter((n) => n.type === 'innertube').map((n) => n['motorOverhang'] ?? 0)).toEqual([0, 0.008]);
  });

  it('remaps nested child motor and recovery references when equivalent parents merge', () => {
    const tree = clusterTree();
    const outer = all(tree.components).find((n) => n.id === 'mount')!;
    outer.children = [{ type: 'innertube', id: 'nested', name: 'Nested', motorMount: true,
      length: 0.08, outerRadius: 0.008, thickness: 0.001, children: outer.children } as ComponentNode];
    const r = importRkt(exportRkt({ name: 'Nested', tree, motors: { nested: motor } }));
    const nested = all(r.tree.components).find((n) => n.name === 'Nested')!;
    expect(Object.keys(r.motors)).toEqual([nested.id]);
    expect(Object.keys(r.configs[0]!.deployments)).toEqual([chute(r.tree).id]);
    expect(chute(r.tree)).toMatchObject({ deployEvent: 'altitude', deployAltitude: 121.92 });
  });

  it('reconstructs nested clusters without treating remapped copies as stale motor serials', () => {
    const tree = clusterTree();
    const outer = all(tree.components).find((n) => n.id === 'mount')!;
    outer['cluster'] = 'double'; outer['motorMount'] = false;
    outer.children = [{ type: 'innertube', id: 'nested', name: 'Nested', motorMount: true,
      cluster: 'double', length: 0.08, outerRadius: 0.004, thickness: 0.001, children: outer.children } as ComponentNode];
    const r = importRkt(exportRkt({ name: 'Nested', tree, motors: { nested: motor } }));
    const inner = all(r.tree.components).filter((n) => n.type === 'innertube');
    expect(inner).toHaveLength(2);
    expect(inner.map((n) => n['cluster'])).toEqual(['double', 'double']);
    expect(Object.keys(r.motors)).toEqual([inner[1]!.id]);
    const again = exportRkt({ name: 'Nested', tree: r.tree, motors: r.motors });
    expect(docOf(again).querySelectorAll('EngineSet')).toHaveLength(4);
    expect(docOf(again).querySelectorAll('Parachute')).toHaveLength(4);
  });

  it('keeps parents separate when their child mounts have different simulation motors', () => {
    const tree = clusterTree();
    const outer = all(tree.components).find((n) => n.id === 'mount')!;
    outer['motorMount'] = false;
    outer.children = [{ type: 'innertube', id: 'nested', name: 'Nested', motorMount: true,
      length: 0.08, outerRadius: 0.008, thickness: 0.001, children: outer.children } as ComponentNode];
    const doc = docOf(exportRkt({ name: 'Nested', tree, motors: { nested: motor } }));
    doc.querySelector('EngineSet > EngineCode')!.textContent = 'B6';
    const r = importRkt(xmlOf(doc));
    expect(all(r.tree.components).filter((n) => n.type === 'innertube')).toHaveLength(8);
    expect(Object.values(r.motors).map((m) => m.designation).sort()).toEqual(['B6', 'C6', 'C6', 'C6']);
    expect(r.notes.join(' ')).toContain('different child parts or child motor/recovery settings');
  });

  it.each([false, true])('repairs nested stale motor serials before collapsing equivalent parent copies (both stale: %s)', (bothStale) => {
    const tree = clusterTree();
    const outer = all(tree.components).find((n) => n.id === 'mount')!;
    outer['cluster'] = 'double'; outer['motorMount'] = false;
    outer.children = [{ type: 'innertube', id: 'nested', name: 'Nested', motorMount: true,
      cluster: 'double', length: 0.08, outerRadius: 0.004, thickness: 0.001, children: outer.children } as ComponentNode];
    const doc = docOf(exportRkt({ name: 'Nested', tree, motors: { nested: motor } }));
    const refs = [...doc.querySelectorAll('EngineSet > MountSerialNo')];
    refs[1]!.textContent = refs[0]!.textContent;
    if (bothStale) refs[3]!.textContent = refs[2]!.textContent;
    const r = importRkt(xmlOf(doc));
    const inner = all(r.tree.components).filter((n) => n.type === 'innertube');
    expect(inner).toHaveLength(2);
    expect(inner.map((n) => n['cluster'])).toEqual(['double', 'double']);
    expect(Object.keys(r.motors)).toEqual([inner[1]!.id]);
  });
});

describe('.ork resolved deployment inheritance', () => {
  it('resolves kernel → bare → partial block and preserves inactive values when saving either config', () => {
    const xml = `<openrocket version="1.10"><rocket><name>T</name>
      <motorconfiguration configid="a" default="true"/><motorconfiguration configid="b"/>
      <subcomponents><stage><subcomponents><bodytube><length>0.5</length><radius>0.025</radius><thickness>0.001</thickness><subcomponents>
      <parachute><name>Main</name><diameter>0.45</diameter><deployevent>altitude</deployevent><deployaltitude>123</deployaltitude><deploydelay>2</deploydelay>
      <deploymentconfiguration configid="b"><deploydelay>0</deploydelay></deploymentconfiguration></parachute>
      <streamer><name>Default</name><deploymentconfiguration configid="b"><deploydelay>3</deploydelay></deploymentconfiguration></streamer>
      </subcomponents></bodytube></subcomponents></stage></subcomponents></rocket></openrocket>`;
    for (const configId of ['a', 'b']) {
      const r = importOrk(xml, { configId });
      expect(r.configs.map((c) => c.deployments[chute(r.tree).id!])).toEqual([
        state({ deployEvent: 'altitude', deployAltitude: 123, deployDelay: 2 }),
        state({ deployEvent: 'altitude', deployAltitude: 123 }),
      ]);
      const streamer = all(r.tree.components).find((n) => n.type === 'streamer')!;
      expect(r.configs.map((c) => c.deployments[streamer.id!])).toEqual([state({}), state({ deployDelay: 3 })]);
      const saved = exportOrk({ name: 'T', tree: r.tree, configs: r.configs.map((c) => ({ ...c, motors: {} })), activeConfigId: configId });
      for (const id of ['a', 'b']) {
        const back = importOrk(saved, { configId: id });
        expect(chute(back.tree)).toMatchObject(state({ deployEvent: 'altitude', deployAltitude: 123, deployDelay: id === 'a' ? 2 : 0 }));
      }
    }
  });
});

// Opt-in local evidence; no private design content is shipped with the tests.
describe.skipIf(!process.env.ROCKSIM_DESIGNS)('named local RockSim acceptance files', () => {
  const read = (name: string) => readFileSync(join(process.env.ROCKSIM_DESIGNS!, name), 'utf8');
  it('Warthog: source simulations 1–11 use ejection, 12–15 use 121.92 m, 14–15 stay plugged', () => {
    const r = importRkt(read('AeroTech/aerotech_warthog.rkt'));
    for (let number = 1; number <= 15; number++) {
      const c = r.configs.find((c) => new RegExp(`Simulation ${number}(?:\\D|$)`).test(r.configSources![c.id]!))!;
      expect(c, `source simulation ${number}`).toBeDefined();
      const d = Object.values(c.deployments)[0]!;
      expect(d).toEqual(state(number <= 11 ? {} : { deployEvent: 'altitude', deployAltitude: 121.92 }));
      if (number >= 14) expect(Object.values(c.motors).every((m) => m.delay === Infinity)).toBe(true);
    }
    console.log(`Warthog: 15 source simulations, ${r.configs.length} retained configurations; triggers verified.`);
  });
  it.each(['Public Missiles/EclipseB_38mmRedlineEllis.rkt', 'Public Missiles/EclipseB_38mmRedlineEllisMAC-8.rkt'])(
    '%s retains different overhangs and both repaired motor positions', (file) => {
      const r = importRkt(read(file));
      const mounts = all(r.tree.components).filter((n) => n['motorMount'] === true);
      expect(mounts).toHaveLength(2);
      expect(new Set(mounts.map((n) => n['motorOverhang'] ?? 0)).size).toBe(2);
      expect(Object.keys(r.motors)).toHaveLength(2);
      const initial = OrkRocket.buildTree(engineTree(r.tree)).staticInfo();
      const reopened = importRkt(exportRkt({ name: r.name, tree: r.tree, motors: r.motors }));
      const after = OrkRocket.buildTree(engineTree(reopened.tree)).staticInfo();
      expect(Math.abs(after.cgEmpty - initial.cgEmpty)).toBeLessThan(1e-6);
      console.log(`${file}: dry CG ${initial.cgEmpty} → ${after.cgEmpty} m; overhangs ${mounts.map((n) => n['motorOverhang'] ?? 0).join(', ')} m.`);
    });
  it('Quest Quad Runner exports one engine block inside each of four tubes', () => {
    const r = importRkt(read('Quest/Quest_Quad_Runner.rkt'));
    const doc = docOf(exportRkt({ name: r.name, tree: r.tree, motors: r.motors }));
    expect(tubes(doc)).toHaveLength(4);
    expect(tubes(doc).every((t) => t.querySelector('Ring > UsageCode')?.textContent === '2')).toBe(true);
  });
});
