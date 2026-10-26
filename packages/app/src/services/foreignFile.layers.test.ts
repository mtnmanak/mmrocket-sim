// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { FlightOverrides } from '../model/design.js';
import { exportRkt, importRkt } from './rocksimFile.js';
import { exportCdx1, importCdx1 } from './rasaeroFile.js';
import { resolveFlightState } from './flightState.js';
import { checkFormatLoss } from './formatLoss.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

const fixture = (name: string) => readFileSync(join(process.cwd(), 'src/services/__fixtures__', name), 'utf8');
const all = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...all(n.children ?? [])]);
const chute = (tree: RocketTree) => all(tree.components).find(n => n.type === 'parachute')!;
const event = (type: number, altitude = 0) => `<SimulationEvent><PartSerialNo>12</PartSerialNo><Type>${type}</Type><DeployAltitude>${altitude}</DeployAltitude><DeplyTime>0</DeplyTime></SimulationEvent>`;
const sim = (events: string, ignition = 0) => `<SimulationResults><SimulationEvents>${events}</SimulationEvents><Stage3Engines><EngineSet><MountSerialNo>1</MountSerialNo><EngineCode>E15</EngineCode><EngineMfg>AeroTech</EngineMfg><EjectionDelay>4</EjectionDelay><IgnitionDelay>${ignition}</IgnitionDelay></EngineSet></Stage3Engines></SimulationResults>`;
const rkt = (sims: string) => `<RockSimDocument><DesignInformation><RocketDesign><Name>Layers</Name><StageCount>1</StageCount>
  <SimulationEventList>${event(5, 121.92)}</SimulationEventList><Stage3Parts><BodyTube><SerialNo>1</SerialNo><Len>500</Len><OD>50</OD><ID>48</ID><IsMotorMount>1</IsMotorMount><AttachedParts>
  <Parachute><Name>Main</Name><SerialNo>12</SerialNo><Dia>450</Dia></Parachute>
  <Streamer><Name>Streamer</Name><SerialNo>13</SerialNo><Len>300</Len><Width>40</Width></Streamer>
  </AttachedParts></BodyTube></Stage3Parts></RocketDesign></DesignInformation><SimulationResultsList>${sims}</SimulationResultsList></RockSimDocument>`;
const altitude = { deployEvent: 'altitude', deployAltitude: 121.92, deployDelay: 0 };
const ejection = { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 };
const doc = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');

describe('FC-3 foreign configuration layers', () => {
  it('keeps RockSim design defaults, sparse simulation overrides and effective deduplication', () => {
    const r = importRkt(rkt(sim(event(1)) + sim('') + sim(event(5, 121.92))));
    const id = chute(r.tree).id!;
    expect(chute(r.tree)).toMatchObject(altitude);
    expect(r.configs).toHaveLength(2);
    expect(r.configs[0]!.deployments).toEqual({ [id]: ejection });
    expect(r.configs[1]!.deployments).toEqual({});
    expect(r.configSources![r.configs[1]!.id]).toContain('Simulation 3');
    const layers = r.configs.map(c => ({ ...c, motors: {} }));
    expect(chute(resolveFlightState(r.tree, layers, r.configs[0]!.id, {}, {}).tree)).toMatchObject(ejection);
    expect(chute(resolveFlightState(r.tree, layers, r.configs[1]!.id, {}, {}).tree)).toMatchObject(altitude);
    expect(r.configNotes![r.configs[1]!.id]!.join(' ')).toContain('121.92 m (400 ft) descending');
    const legacy = { tree: resolveFlightState(r.tree, layers, r.chosenConfigId, {}, {}).tree, configs: r.configs };
    expect(chute(legacy.tree)).toMatchObject(ejection);
    expect(legacy.configs[1]!.deployments[id]).toBeUndefined();
    expect(chute(r.tree)).toMatchObject(altitude);
  });

  it('writes RockSim defaults separately from the active override and reimports both', () => {
    const r = importRkt(rkt(sim(event(1))));
    const overrides: FlightOverrides = { deployments: { [chute(r.tree).id!]: ejection } };
    const xml = exportRkt({ name: r.name, tree: r.tree, motors: r.motors, overrides });
    const d = doc(xml);
    expect(d.querySelector('RocketDesign > SimulationEventList > SimulationEvent > Type')?.textContent).toBe('5');
    expect(d.querySelector('RocketDesign > SimulationEventList DeployAltitude')?.textContent).toBe('121.92');
    expect(d.querySelectorAll('SimulationResults > SimulationEvents > SimulationEvent')).toHaveLength(1);
    expect(d.querySelector('SimulationResults > SimulationEvents > SimulationEvent > Type')?.textContent).toBe('1');
    const back = importRkt(xml);
    expect(chute(back.tree)).toMatchObject(altitude);
    expect(back.configs[0]!.deployments[chute(back.tree).id!]).toEqual(ejection);
  });

  it('stores RockSim ignition per EngineSet sparsely over deterministic mount defaults', () => {
    const r = importRkt(rkt(sim('', 2) + sim('')));
    const id = Object.keys(r.motors)[0]!;
    expect(r.tree.ignitionDefaults?.[id]).toEqual({ event: 'automatic', delay: 0 });
    expect(r.configs[0]!.ignitions).toEqual({ [id]: { event: 'launch', delay: 2 } });
    expect(r.configs[1]!.ignitions ?? {}).toEqual({});
    expect(r.configs.every(c => Object.keys(c.separations).length === 0)).toBe(true);
    const xml = exportRkt({ name: r.name, tree: r.tree, motors: r.configs[1]!.motors, overrides: r.configs[0] });
    expect(doc(xml).querySelector('IgnitionDelay')?.textContent).toBe('2');
  });

  it('keeps CDX1 global recovery and separates simulation timers from deterministic defaults', () => {
    const r = importCdx1(fixture('Complex.Two-Stage.CDX1'));
    const booster = r.tree.components[1]!;
    expect(booster['separationEvent'] ?? 'ejection').toBe('ejection');
    expect(booster['separationDelay'] ?? 0).toBe(0);
    expect(r.configs[0]!.separations[booster.id!]).toEqual({ separationEvent: 'burnout', separationDelay: 2, separationAltitude: 200 });
    for (const config of r.configs) for (const [id, ref] of Object.entries(config.motors)) {
      const own = r.tree.ignitionDefaults![id]!;
      const resolved = { event: ref.ignitionEvent ?? 'automatic', delay: ref.ignitionDelay ?? 0 };
      expect(config.ignitions?.[id] ?? own).toEqual(resolved);
      if (resolved.event === own.event && resolved.delay === own.delay) expect(config.ignitions?.[id]).toBeUndefined();
    }
    const sus = Object.values(r.configs[0]!.motors).find(m => m.ignitionEvent === 'burnout')!;
    expect(r.tree.ignitionDefaults?.[sus.mountId!]).toEqual({ event: 'burnout', delay: 0 });
    expect(r.configs.every(c => Object.keys(c.deployments).length === 0)).toBe(true);
    expect(resolveFlightState(r.tree, r.configs.map(c => ({ ...c, motors: {} })), r.chosenConfigId, {}, {}).tree.components[1]).toMatchObject({ separationEvent: 'burnout', separationDelay: 2 });
    // This imported fixture has booster transitions the writer cannot represent.
    // Keep its actual timing/motors but restrict this export check to plain tubes.
    booster.children = booster.children?.filter(n => n.type === 'bodytube');
    const xml = exportCdx1({ name: r.name, tree: r.tree, motors: r.motors, overrides: r.configs[0] });
    expect(doc(xml).querySelector('Booster1SeparationDelay')?.textContent).toBe('2');
  });

  it('keeps CDX1 lowest-loaded-stage ignition rekeying and discards its excluded-stage timer', () => {
    const xml = fixture('Complex.Two-Stage.CDX1').replace(/<IncludeBooster1>True<\/IncludeBooster1>/g, '<IncludeBooster1>False</IncludeBooster1>')
      .replace(/<SustainerIgnitionDelay>[^<]*<\/SustainerIgnitionDelay>/g, '<SustainerIgnitionDelay>8</SustainerIgnitionDelay>');
    const r = importCdx1(xml);
    const id = Object.keys(r.motors)[0]!;
    expect(r.tree.ignitionDefaults?.[id]).toEqual({ event: 'burnout', delay: 0 });
    expect(r.configs[0]!.ignitions?.[id]).toEqual({ event: 'launch', delay: 0 });
    expect(r.motors[id]).toMatchObject({ ignitionEvent: 'launch', ignitionDelay: 0 });
  });

  it('exports CDX1 effective recovery with a component-default loss line, also in format preview', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const c: ComponentNode = { type: 'parachute', id: 'chute', name: 'Main', diameter: 0.5,
      deployEvent: 'apogee', deployAltitude: 200, deployDelay: 0 };
    all(r.tree.components).find(n => n.type === 'bodytube')!.children = [c];
    const overrides: FlightOverrides = { deployments: { [c.id!]: altitude } };
    const notes: string[] = [];
    const xml = exportCdx1({ name: r.name, tree: r.tree, overrides, notes });
    const recovery = doc(xml).querySelector('Recovery')!;
    expect(recovery.textContent).toContain('Altitude');
    expect([1, 2].some(i => recovery.querySelector(`EventType${i}`)?.textContent === 'Altitude'
      && Math.abs(Number(recovery.querySelector(`Altitude${i}`)?.textContent) / 3.28084 - 121.92) < 0.001)).toBe(true);
    const loss = "the parachute's own setting is not kept; the file carries the configuration's";
    expect(notes.join(' ')).toContain(loss);
    const preview = checkFormatLoss('cdx1', { tree: r.tree, overrides, motors: {}, configs: [], activeConfigId: null,
      launch: DEFAULT_CONDITIONS, measured: { massKg: null, cgM: null }, flightData: {} });
    expect(preview.losses.join(' ')).toContain(loss);
    expect(c['deployEvent']).toBe('apogee');
    const equalNotes: string[] = [];
    exportCdx1({ name: r.name, tree: r.tree, overrides: { deployments: { [c.id!]: { deployEvent: 'apogee', deployAltitude: 200, deployDelay: 0 } } }, notes: equalNotes });
    expect(equalNotes.join(' ')).not.toContain(loss);
  });

  it('preserves pre-FC-3 no-override RockSim exported text', () => {
    const r = importRkt(fixture('rocksimTestRocket1.rkt'));
    const input = { name: r.name, tree: r.tree, motors: r.motors };
    const xml = exportRkt(input);
    expect(xml).toMatchSnapshot();
    expect(exportRkt({ ...input, overrides: {} })).toBe(xml);
    const recovery = importRkt(rkt(sim('')));
    expect(exportRkt({ name: recovery.name, tree: recovery.tree, motors: recovery.motors })).toMatchSnapshot('inherited recovery');
  });

  it('preserves pre-FC-3 no-override CDX1 exported text', () => {
    const r = importCdx1(fixture('ARCAS-Long - 2.CDX1'));
    const input = { name: r.name, tree: r.tree, motors: r.motors };
    const xml = exportCdx1(input);
    expect(xml).toMatchSnapshot();
    expect(exportCdx1({ ...input, overrides: {} })).toBe(xml);
    all(r.tree.components).find(n => n.type === 'bodytube')!.children = [
      { type: 'parachute', id: 'chute', diameter: 0.5, ...altitude },
    ];
    expect(exportCdx1(input)).toMatchSnapshot('global recovery');
  });
});
