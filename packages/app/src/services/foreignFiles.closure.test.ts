// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { exportRkt, importRkt, rktComponentInfo } from './rocksimFile.js';
import { exportCdx1, importCdx1 } from './rasaeroFile.js';
import { finOutlineProblem } from '../tree/finOutline.js';
import { checkFormatLoss } from './formatLoss.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { currentXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';

const rkt = (parts: string) => `<RockSimDocument><DesignInformation><RocketDesign><Name>Closure</Name><StageCount>1</StageCount><Stage3Parts><BodyTube><Name>Tube</Name><OD>100</OD><ID>96</ID><Len>400</Len><AttachedParts>${parts}</AttachedParts></BodyTube></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
const withoutIds = (value: unknown): unknown => {
  const keys = new Map<string, string>();
  return JSON.parse(JSON.stringify(value, (key, child: unknown) => key === 'id' || key === 'mountId' ? undefined : child)
    .replace(/"c\d+"/g, key => {
      if (!keys.has(key)) keys.set(key, `"part${keys.size}"`);
      return keys.get(key)!;
    })) as unknown;
};

it('cautions about a second RockSim design while retaining parser selection', () => {
  const xml = rkt('').replace('<DesignInformation>', `<Unknown>${rkt('').replace('Closure', 'EVIL')}</Unknown><DesignInformation>`);
  const result = importRkt(xml);
  expect(result.name).toBe(currentXmlParser() === jsXmlParser ? 'EVIL' : 'Closure');
  expect(result.notes.join(' ')).toMatch(/multiple.*design.*check.*flying/i);
});

it('cautions about a second RASAero design while retaining parser selection', () => {
  const design = (length: number) => `<RocketDesign><BodyTube><Length>${length}</Length><Diameter>4</Diameter></BodyTube></RocketDesign>`;
  const nested = `<Unknown><RASAeroDocument>${design(300)}<LaunchSite><Altitude>9999</Altitude></LaunchSite></RASAeroDocument></Unknown>`;
  const clean = `<RASAeroDocument>${design(20)}</RASAeroDocument>`;
  const result = importCdx1(clean.replace('<RASAeroDocument>', `<RASAeroDocument>${nested}`));
  expect(result.tree.components[0]!.children![0]!.length).toBeCloseTo((currentXmlParser() === jsXmlParser ? 300 : 20) * 0.0254);
  expect(result.notes.join(' ')).toMatch(/multiple.*design.*check.*flying/i);
});

it.each([
  '<LaunchSite><Altitude>9999</Altitude></LaunchSite>',
  '<Recovery><Event1>True</Event1><EventType1>Apogee</EventType1><Size1>36</Size1><CD1>0.8</CD1></Recovery>',
  '<MachAlt><Item>0.1,1000</Item></MachAlt>',
  '<SimulationList><Simulation><SustainerEngine>H128W  (AT)</SustainerEngine><SustainerNozzleDiameter>1</SustainerNozzleDiameter></Simulation></SimulationList>',
])('retains document-wide RASAero auxiliary selection: %s', payload => {
  const xml = '<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>4</Diameter></BodyTube></RocketDesign></RASAeroDocument>';
  const result = importCdx1(xml.replace('<RocketDesign>', `<Unknown><RASAeroDocument>${payload}</RASAeroDocument></Unknown><RocketDesign>`));
  expect(withoutIds(result)).toEqual(withoutIds(importCdx1(xml.replace('<RocketDesign>', `${payload}<RocketDesign>`))));
});

it.each(['simulation', 'loadout'])('ignores RockSim %s inside an unknown accepted-container child', kind => {
  const set = '<EngineSet><EngineCode>H128W</EngineCode><EngineMfg>AeroTech</EngineMfg></EngineSet>';
  const sim = `<SimulationResults><Stage3Engines>${kind === 'loadout' ? `<Unknown>${set}</Unknown>` : set}</Stage3Engines></SimulationResults>`;
  const records = `<SimulationResultsList>${kind === 'simulation' ? `<Unknown>${sim}</Unknown>` : sim}</SimulationResultsList>`;
  const mount = rkt('').replace('<Name>Tube</Name>', '<Name>Tube</Name><IsMotorMount>1</IsMotorMount>');
  const result = importRkt(mount.replace('</RockSimDocument>', `${records}</RockSimDocument>`));
  expect(Object.values(result.motors)).toEqual([]);
  expect(result.configs.every(config => Object.values(config.motors).length === 0)).toBe(true);
});

it('ignores RockSim simulation payload inside an unknown root wrapper', () => {
  const payload = '<Unknown><RockSimDocument><SimulationResultsList><SimulationResults><Stage3Engines><EngineSet><EngineCode>H128W</EngineCode><EngineMfg>AeroTech</EngineMfg></EngineSet></Stage3Engines></SimulationResults></SimulationResultsList></RockSimDocument></Unknown>';
  expect(withoutIds(importRkt(rkt('').replace('<DesignInformation>', `${payload}<DesignInformation>`))))
    .toEqual(withoutIds(importRkt(rkt(''))));
});

it.each(['constructor', 'toString', '__proto__'])('CDX1 export and losses ignore inherited motor %s', id => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [
    { type: 'bodytube', id: 'mount', motorMount: true, length: 1, outerRadius: 0.05 },
    { type: 'parachute', id, deployEvent: 'apogee' },
  ] }] };
  const motors = { mount: { manufacturer: 'AeroTech', designation: 'H128W', diameter: 0.029, length: 0.1, delay: 5 } };
  expect(() => exportCdx1({ tree, name: 'One motor', motors })).not.toThrow();
  const normal = structuredClone(tree);
  normal.components[0]!.children![1]!.id = 'ordinary';
  const settings = { motors, launch: DEFAULT_CONDITIONS, configs: [], activeConfigId: null, measured: { massKg: null, cgM: null }, flightData: {} };
  expect(checkFormatLoss('cdx1', { tree, ...settings })).toEqual(checkFormatLoss('cdx1', { tree: normal, ...settings }));
});

it.each(['constructor', 'toString', '__proto__'])('RockSim keeps owned component info for %s and ignores inherited info', id => {
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', id, length: 1, outerRadius: 0.05 }] }] };
  const info = rktComponentInfo(tree, () => ({ mass: 0.1, cgX: 0.5, positionX: 0 }));
  expect(Object.hasOwn(info, id)).toBe(true);
  const xml = exportRkt({ tree, name: 'Info', compInfo: {} });
  expect(xml).not.toContain('NaN');
  expect(xml).not.toContain('<CalcMass>');
});

it.each(['constructor', 'toString', '__proto__'])('format-loss preview keeps the real booster motor before inherited %s', id => {
  const tree: RocketTree = { components: [
    { type: 'stage', children: [{ type: 'bodytube', id: 'upper', motorMount: true, length: 1, outerRadius: 0.05 }] },
    { type: 'stage', name: 'Booster', nozzleExitDiameter: 0.01, children: [
      { type: 'parachute', id, deployEvent: 'apogee' },
      { type: 'bodytube', id: 'lower', motorMount: true, length: 1, outerRadius: 0.05 },
    ] },
  ] };
  const motor = { manufacturer: 'AeroTech', designation: 'H128W', diameter: 0.029, length: 0.1, ignitionEvent: 'automatic', delay: Infinity };
  const report = checkFormatLoss('cdx1', { tree, motors: { upper: motor, lower: motor }, launch: DEFAULT_CONDITIONS,
    configs: [], activeConfigId: null, measured: { massKg: null, cgM: null }, flightData: {} });
  expect(report.losses.join(' ')).not.toContain('Booster nozzle');
  expect(report.losses.join(' ')).toContain('The lower motor is plugged, so it would not light in the app at all.');
});

it('keeps zero-density parachute lines', () => {
  const r = importRkt(rkt('<Parachute><Name>Lines</Name><ShroudLineMassPerMM>0</ShroudLineMassPerMM><ShroudLineMaterial>Zero</ShroudLineMaterial></Parachute>'));
  expect(r.tree.components[0]!.children![0]!.children![0]).toMatchObject({ lineDensity: 0, lineMaterialName: 'Zero' });
  const xml = exportRkt({ name: r.name, tree: r.tree });
  expect(xml).toContain('<ShroudLineMassPerMM>0</ShroudLineMassPerMM>');
  expect(importRkt(xml).tree.components[0]!.children![0]!.children![0])
    .toMatchObject({ lineDensity: 0, lineMaterialName: 'Zero' });
});

it.each(['podset', 'parallelstage'] as const)('does not label a material-free %s as a zero-density solid', type => {
  const tree: RocketTree = { components: [{ type: 'stage', children: [{ type: 'bodytube', length: 1,
    outerRadius: 0.05, children: [{ type, name: 'Assembly', children: [{ type: 'bodytube', length: 0.1, outerRadius: 0.01 }] }] }] }] };
  expect(importRkt(exportRkt({ name: 'Assembly', tree })).noteTiers?.filter(n => n.kind === 'I21.zero-bulk-density')).toEqual([]);
});

it('discloses the protected bulk-density limit on the RockSim sibling', () => {
  const r = importRkt(rkt('<Ring><Name>Weightless ring</Name><Density>0</Density><DensityType>0</DensityType></Ring>'));
  expect(r.notes.join('\n')).toMatch(/Weightless ring.*zero bulk density.*680.*mass/i);
});

it.each(['junk', ''])('does not call malformed RockSim density an explicit zero: %s', density => {
  const r = importRkt(rkt(`<Ring><Density>${density}</Density><DensityType>0</DensityType></Ring>`));
  expect(r.noteTiers?.filter(note => note.kind === 'I21.zero-bulk-density')).toEqual([]);
});

it.each(['<UseKnownMass>1</UseKnownMass><KnownMass>100</KnownMass>', '<UseKnownMass>1</UseKnownMass><KnownMass>0</KnownMass>', '<UseKnownCG>1</UseKnownCG><KnownMass>100</KnownMass>'])('does not warn about zero RockSim density with a pinned mass: %s', override => {
  const r = importRkt(rkt(`<Ring><Density>0</Density><DensityType>0</DensityType>${override}</Ring>`));
  expect(r.noteTiers?.filter(note => note.kind === 'I21.zero-bulk-density')).toEqual([]);
});

it.each(['Parachute', 'Streamer', 'ShockCord'])('keeps an explicit zero RockSim %s density', type => {
  const tag = type === 'ShockCord' ? 'MassObject' : type;
  const r = importRkt(rkt(`<${tag}><Name>Zero</Name>${type === 'ShockCord' ? '<TypeCode>1</TypeCode>' : ''}<DensityType>${type === 'ShockCord' ? 2 : 1}</DensityType><Density>0</Density><Material>Zero</Material></${tag}>`));
  const node = r.tree.components[0]!.children![0]!.children![0]!;
  const key = type === 'ShockCord' ? 'lineDensity' : 'surfaceDensity';
  expect(node[key]).toBe(0);
  const again = importRkt(exportRkt({ name: r.name, tree: r.tree }));
  expect(again.tree.components[0]!.children![0]!.children![0]![key]).toBe(0);
});

it.each(['constructor', 'toString', '__proto__'])('exporters ignore inherited deployment %s', id => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 'stage', children: [{ type: 'bodytube', id: 'body', length: 1, outerRadius: 0.05, children: [{ type: 'parachute', id, name: 'Chute', deployEvent: 'apogee' }] }] }] };
  for (const writer of [exportRkt, exportCdx1]) {
    const notes: string[] = [];
    expect(() => writer({ name: 'Closure', tree, overrides: { deployments: {} }, notes })).not.toThrow();
    expect(notes.join('\n')).not.toMatch(/own setting|Recovery overrides/);
  }
});

it.each(['Transition', 'BoatTail'])('replaces an invalid synthesized %s fin with a flyable outline', type => {
  const r = importCdx1(`<RASAeroDocument><RocketDesign><NoseCone><Length>5</Length><Diameter>4</Diameter><Shape>Conical</Shape></NoseCone><BodyTube><Length>20</Length><Diameter>4</Diameter></BodyTube><${type}><Length>3</Length><Diameter>4</Diameter><RearDiameter>2</RearDiameter><Fin><Chord>-2</Chord><Span>1.2</Span><SweepDistance>0</SweepDistance><TipChord>1.2</TipChord></Fin></${type}></RocketDesign></RASAeroDocument>`);
  const fin = r.tree.components[0]!.children!.find(n => n.type === 'transition')!.children![0]!;
  expect(finOutlineProblem(fin['points'] as [number, number][])).toBeNull();
  expect(r.notes.join('\n')).toMatch(/outline was not used/);
});
