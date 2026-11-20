// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode } from '@online-openrocket/engine';
import { engineTree } from '../tree/treeModel.js';
import { importOrk, exportOrk } from './orkFile.js';
import { importRkt, exportRkt } from './rocksimFile.js';
import { importCdx1, exportCdx1 } from './rasaeroFile.js';
import { inlineXmlCdata } from './xmlUtil.js';
import { componentTable } from './componentTable.js';
import { componentDxf } from './dxfExport.js';
import { screenEntry } from './catalogueOverlay.js';
import { MOTOR_DB, findDbMotor } from './motorDb.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import { planNewDesign, planImport, resolveImportMotors } from './importApply.js';
import { checkFormatLoss } from './formatLoss.js';
import { MAX_DESIGN_PARTS } from '../tree/sanitize.js';
import { catalogueDifferences, componentToPreset, csvToPresets, holdsCatalogueMass, loadCustomPresets, presetPatch, presetsToCsv, saveCustomPresets, type Preset } from './presets.js';
import { noteFlags } from './importNotes.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { impulseNote } from './thrustcurve.js';
import { currentXmlParser, setXmlParser } from './xmlParse.js';
import retiredPresetMasses from '../data/retiredPresetMasses.json';

const ork = (parts: string, config = '') => `<openrocket version="1.10"><rocket><name>Test</name>${config}<subcomponents><stage><name>Sustainer</name><subcomponents>${parts}</subcomponents></stage></subcomponents></rocket></openrocket>`;
const rkt = (parts: string, extra = '', sims = '') => `<RockSimDocument><DesignInformation><RocketDesign><Name>Test</Name><StageCount>1</StageCount>${extra}<Stage3Parts>${parts}</Stage3Parts></RocketDesign></DesignInformation>${sims}</RockSimDocument>`;
const flat = (ns: ComponentNode[]): ComponentNode[] => ns.flatMap(n => [n, ...flat(n.children ?? [])]);
const cdx = (extra: string, recovery = '') => `<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter>${extra}</BodyTube></RocketDesign>${recovery}</RASAeroDocument>`;

it.each(['centeringring', 'bulkhead', 'tubecoupler', 'engineblock'])('S1a-1 keeps explicit zero %s radius', type => {
  const loaded = importOrk(ork(`<bodytube><radius>0.03</radius><subcomponents><${type}><outerradius>0</outerradius></${type}></subcomponents></bodytube>`));
  expect(flat(loaded.tree.components).find(n => n.type === type)?.['outerRadius']).toBe(0);
  expect(exportOrk({ name: 'Zero', tree: loaded.tree })).toContain('<outerradius>0</outerradius>');
});
it('S1a-2 rejects extra automatic dimension tokens', () => {
  expect(importOrk(ork('<bodytube><radius>auto 0.01 0.02</radius></bodytube>')).notes.join(' ')).toContain('invalid <radius>');
});
it.each([
  ['launchlug', '<radialdirection>90</radialdirection>', 'angleOffset'],
  ['launchlug', '<angleoffset>45</angleoffset><radialdirection>90</radialdirection><angleoffset>x</angleoffset>', 'angleOffset'],
  ['freeformfinset', '<angleoffset method="relative">90</angleoffset>', 'rotation'],
  ['freeformfinset', '<rotation>45</rotation><angleoffset method="relative">90</angleoffset><rotation>x</rotation>', 'rotation'],
])('S1a-b2 replays %s angle setters', (type, values, key) => {
  const node = flat(importOrk(ork(`<bodytube><subcomponents><${type}>${values}</${type}></subcomponents></bodytube>`)).tree.components).find(n => n.type === type)!;
  expect(node[key]).toBeCloseTo(Math.PI / 2, 12);
});
it('S1a-b3 discloses custom reference normalization and save loss', () => {
  const loaded = importOrk(ork('<bodytube/>', '<referencetype>custom</referencetype><customreference>0.1</customreference>'));
  expect(loaded.notes.join(' ')).toMatch(/reference.*maximum.*[Ss]av/);
});
it.each(['parachute', 'streamer', 'shockcord'])('S1a-b4 reports wrong %s material', type => {
  const loaded = importOrk(ork(`<bodytube><subcomponents><${type}><name>Recovery</name><material type="bulk" density="1200">Epoxy</material></${type}></subcomponents></bodytube>`));
  expect(loaded.notes.join(' ')).toMatch(/Recovery.*Epoxy.*ignored/);
});
it('S1a-b4 reports a wrong parachute line material', () => {
  const loaded = importOrk(ork('<bodytube><subcomponents><parachute><name>Main</name><linematerial type="bulk" density="1200">Epoxy</linematerial></parachute></subcomponents></bodytube>'));
  expect(loaded.notes.join(' ')).toMatch(/Main.*Epoxy.*ignored/);
});
it('S1a-g3 names each invalid motor dimension separately', () => {
  const motors = ['H128W', 'J350W'].map((designation, i) => `<bodytube><name>Mount ${i}</name><motormount><motor configid="c"><designation>${designation}</designation><diameter>x</diameter><length>0.1</length><delay>none</delay></motor></motormount></bodytube>`).join('');
  const notes = importOrk(ork(motors, '<motorconfiguration configid="c" default="true"/>')).notes.filter(n => n.includes('invalid <diameter>'));
  expect(notes).toHaveLength(2);
  expect(notes.join(' ')).toContain('H128W');
  expect(notes.join(' ')).toContain('J350W');
});
it.each(['{broken', '{}', '[["c","unknown",0]]', '[["c","automatic",null]]'])('S1a-g4 reports malformed ignition extension %s', value => {
  const loaded = importOrk(ork(`<bodytube><name>Mount</name><motormount mmrignitions='${value}'/></bodytube>`));
  expect(loaded.notes.join(' ')).toMatch(/Mount.*mmrignitions/);
});
it('S1a-g8 preserves tube-hole comment whitespace', () => {
  const comment = '  drill here\n\n';
  const tree = { components: [{ type: 'stage' as const, children: [{ type: 'bodytube' as const, children: [{ type: 'tubehole' as ComponentNode['type'], name: 'Hole', comment }] }] }] };
  const reopened = importOrk(exportOrk({ name: 'Hole', tree }));
  expect(flat(reopened.tree.components).find(n => (n.type as string) === 'tubehole')?.['comment']).toBe(comment);
});
it('S1b-g1 reports discarded tube holes for foreign saves', () => {
  const notes: string[] = [];
  exportRkt({ name: 'Hole', tree: { components: [{ type: 'bodytube', children: [{ type: 'tubehole' as ComponentNode['type'], name: 'Vent' }] }] }, notes });
  expect(notes.join(' ')).toMatch(/Vent.*[.]ork/);
});
it('S1b-g10 uses integer stage count for measured mass', () => {
  const loaded = importRkt(rkt('<BodyTube><Name>Body</Name><Len>500</Len><OD>50</OD></BodyTube>', '<UseKnownMass>1</UseKnownMass><Stage3Mass>100</Stage3Mass>').replace('<StageCount>1</StageCount>', '<StageCount>1.5</StageCount>'));
  expect(loaded.measured?.massKg).toBeCloseTo(0.1, 10);
  expect(loaded.notes.join(' ')).not.toContain('1.5-stage');
});
it.each(['RailGuideDiameter', 'RailGuideHeight', 'LaunchShoeArea'])('S1c-b2 discloses omitted %s', field => {
  expect(importCdx1(cdx(`<${field}>0.2</${field}>`)).notes.join(' ')).toContain(field);
});
it.each(['apogee', 'Unknown'])('S1c-b3 discloses unknown recovery event %s and uses apogee', event => {
  const loaded = importCdx1(cdx('', `<Recovery><Event1>True</Event1><EventType1>${event}</EventType1><DeviceType1>Parachute</DeviceType1><Size1>36</Size1><CD1>0.8</CD1><Altitude1>500</Altitude1></Recovery>`));
  expect(flat(loaded.tree.components).find(n => n.type === 'parachute')?.['deployEvent']).toBe('apogee');
  expect(loaded.notes.join(' ')).toContain(`“${event}”`);
});
it('S1c-b4 makes no unverified claim about available sibling curves', () => {
  expect(impulseNote({ designation: 'Selected curve', totImpulseNs: 100 }, [{ time: 0, thrust: 0 }, { time: 1, thrust: 100 }, { time: 2, thrust: 0 }].map(s => ({ ...s, thrust: s.thrust / 2 }))) ?? '').not.toContain('publishes no closer');
});
it.each([null, undefined])('S7c-b1 refuses missing impulse %s', totImpulseNs => {
  expect(screenEntry({ ...MOTOR_DB[0]!, totImpulseNs } as unknown as Parameters<typeof screenEntry>[0])).toMatch(/impulse/);
});
it('S7c-g5 keeps component-specific headers and distinct entered mass', () => {
  const table = componentTable({ components: [{ type: 'stage', children: [
    { type: 'railbutton', instanceCount: 2 }, { type: 'podset', instanceCount: 3 },
    { type: 'tubehole' as ComponentNode['type'], angleOffset: 0.1 }, { type: 'launchlug', angleOffset: 0.2 }, { type: 'masscomponent', mass: 0.1 },
  ] }] }, { units: INITIAL_UNITS, radiusMode: 'radius' });
  expect(table.headers.filter(h => h === 'Mass (g)')).toHaveLength(1);
  expect(table.rows[1]![table.headers.indexOf('Number of rail buttons')]).toBe('');
  expect(table.rows[3]![table.headers.indexOf('First angle around tube (°)')]).toBe('');
});
it('S7c-g6 New resets file simulation controls and keeps pad weather', () => {
  const launch = { ...DEFAULT_CONDITIONS, timeStepS: 0.005, maxFlightTimeS: 20, launchGuideAllowance: false };
  const next = planNewDesign({ launch, measured: { massKg: null, cgM: null } }).snapshot.launch;
  expect(next.timeStepS).toBeUndefined();
  expect(next.maxFlightTimeS).toBeUndefined();
  expect(next.launchGuideAllowance).toBe(false);
  expect(launch.timeStepS).toBe(0.005);
});
it('S7c-g9 keeps every DXF TEXT value within R12 limits', () => {
  const saved = componentDxf({ type: 'bulkhead', name: 'x'.repeat(300), outerRadius: 0.02 }, {}, 'y'.repeat(300))!;
  const lines = saved.text.split('\r\n');
  const values = lines.filter((_, i) => i > 0 && lines[i - 1] === '1');
  expect(values.length).toBeGreaterThan(0);
  expect(values.every(v => v.length <= 255)).toBe(true);
});
it.each(['"', "'"])('S1a-g6 leaves invalid attribute CDATA untouched (%s)', quote => {
  const xml = `<RockSimDocument x=${quote}<![CDATA[foo]]>${quote}><Name><![CDATA[ok]]></Name></RockSimDocument>`;
  expect(inlineXmlCdata(xml)).toContain(`x=${quote}<![CDATA[foo]]>${quote}`);
  expect(inlineXmlCdata(xml)).toContain('<Name>ok</Name>');
});

const suffixMotors = [
  MOTOR_DB.find(m => m.manufacturerAbbrev === 'AeroTech' && /-P$/i.test(m.designation))!,
  MOTOR_DB.find(m => m.manufacturerAbbrev === 'Quest' && /-\d+$/.test(m.designation))!,
  MOTOR_DB.find(m => m.manufacturerAbbrev === 'AMW' && /-\d+$/.test(m.designation))!,
];
it.each(suffixMotors)('S1c-b1 keeps complete catalogue identity $designation', motor => {
  const { designation } = motor;
  const tree = { components: [{ type: 'stage' as const, children: [{ type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.03 }] }] };
  const reopened = importCdx1(exportCdx1({ name: 'Identity', tree, engineExport: true, motors: { b: { designation, manufacturer: motor.manufacturerAbbrev } } }));
  const ref = Object.values(reopened.motors)[0]!;
  expect(ref.designation).toBe(designation);
  expect(findDbMotor(ref.designation, undefined, undefined, ref.manufacturer)?.motorId).toBe(motor.motorId);
});
it('S1a-g2 numbers only converted stages', () => {
  const xml = ork('<bodytube/><wrapper><parallelstage><name>Ignored</name></parallelstage></wrapper>', '<motorconfiguration configid="c" default="true"><stage number="1" active="false"/></motorconfiguration>')
    .replace('</stage></subcomponents></rocket>', '</stage><stage><name>Booster</name></stage></subcomponents></rocket>');
  const loaded = importOrk(xml);
  const booster = loaded.tree.components[1]!;
  expect(loaded.configs[0]!.stageActiveness?.[booster.id!]).toBe(false);
  expect(loaded.notes.join(' ')).toContain('deactivates');
});
const event = (type: number, altitude = 0) => `<SimulationEvent><PartSerialNo>12</PartSerialNo><Type>${type}</Type><DeployAltitude>${altitude}</DeployAltitude></SimulationEvent>`;
const sim = (events = '', code = 'E15', site = '') => `<SimulationResults><SimulationEvents>${events}</SimulationEvents>${site}<Stage3Engines><EngineSet><EngineCode>${code}</EngineCode><EngineMfg>AeroTech</EngineMfg><MountSerialNo>1</MountSerialNo><EjectionDelay>4</EjectionDelay></EngineSet></Stage3Engines></SimulationResults>`;
const body = '<BodyTube><Name>Body</Name><Len>500</Len><OD>50</OD><ID>48</ID><IsMotorMount>1</IsMotorMount><SerialNo>1</SerialNo><AttachedParts><Parachute><Name>Main</Name><SerialNo>12</SerialNo><Dia>300</Dia></Parachute></AttachedParts></BodyTube>';
it('S1b-1 refuses ambiguous serial motor routing', () => {
  const loaded = importRkt(rkt(body + body.replace('<Name>Body</Name>', '<Name>Other</Name>'), '', `<SimulationResultsList>${sim()}</SimulationResultsList>`));
  expect(Object.keys(loaded.motors)).toHaveLength(0);
  expect(loaded.notes.join(' ')).toMatch(/duplicate.*serial/i);
});
it('S1b-1 also refuses ambiguous serial recovery routing', () => {
  const loaded = importRkt(rkt(body.replace('</AttachedParts>', '<Parachute><Name>Drogue</Name><SerialNo>12</SerialNo><Dia>100</Dia></Parachute></AttachedParts>'), `<SimulationEventList>${event(5, 152.4)}</SimulationEventList>`));
  expect(flat(loaded.tree.components).filter(n => n.type === 'parachute').every(n => n['deployEvent'] === 'ejection')).toBe(true);
  expect(loaded.notes.join(' ')).toContain('Duplicate component serial');
});
it('S1b-2 discloses recovery-only simulations', () => {
  const loaded = importRkt(rkt(body, '', `<SimulationResultsList><SimulationResults><SimulationEvents>${event(5, 152.4)}</SimulationEvents></SimulationResults></SimulationResultsList>`));
  expect(loaded.notes.join(' ')).toMatch(/[Rr]ecovery.*no motors|no motors.*recovery/);
});
it('S1b-2 does not call empty recovery slots discarded settings', () => {
  const loaded = importRkt(rkt(body, '', '<SimulationResultsList><SimulationResults><SimulationEvents><SimulationEvent><PartSerialNo>0</PartSerialNo><Type>0</Type></SimulationEvent></SimulationEvents></SimulationResults></SimulationResultsList>'));
  expect(loaded.notes.join(' ')).not.toContain('recovery settings are not imported');
});
it('S1b-b1 imports pod subassemblies as an external chain with fins', () => {
  const pod = '<ExternalPod><Name>Pod</Name><AttachedParts><SubAssembly><AttachedParts><NoseCone><Len>50</Len><BaseDia>25</BaseDia></NoseCone><BodyTube><Name>Pod tube</Name><Len>200</Len><OD>25</OD><AttachedParts><FinSet><Name>Pod fins</Name><RootChord>40</RootChord><TipChord>20</TipChord><SemiSpan>25</SemiSpan><FinCount>3</FinCount><Thickness>2</Thickness></FinSet><LaunchLug><Len>20</Len><OD>5</OD><ID>3</ID></LaunchLug></AttachedParts></BodyTube></AttachedParts></SubAssembly></AttachedParts></ExternalPod>';
  const loaded = importRkt(rkt(body.replace('</AttachedParts>', `${pod}</AttachedParts>`)));
  const tube = flat(loaded.tree.components).find(n => n.name === 'Pod tube')!;
  expect(tube.type).toBe('bodytube');
  expect(tube.children?.some(n => n.name === 'Pod fins')).toBe(true);
  expect(tube.children?.some(n => n.type === 'launchlug')).toBe(true);
  resetEngine();
  expect(() => OrkRocket.buildTree(engineTree(loaded.tree))).not.toThrow();
}, 30_000);
it('S1b-b2 discloses removed pod becoming active', () => {
  const loaded = importRkt(rkt(body.replace('</AttachedParts>', '<ExternalPod><Name>Removed pod</Name><Removed>1</Removed><AttachedParts><BodyTube><Len>100</Len><OD>20</OD></BodyTube></AttachedParts></ExternalPod></AttachedParts>')));
  expect(loaded.notes.join(' ')).toMatch(/Removed pod.*[Rr]emoved.*active/);
});
it('S1b-b3 previews repacking against emitted parent', () => {
  const tree = { components: [{ type: 'stage' as const, children: [{ type: 'bodytube' as const, outerRadius: 0.05, length: 0.5, children: [{ type: 'tubecoupler' as const, outerRadius: 0.01, length: 0.1, children: [{ type: 'parachute' as const, diameter: 0.3, packedLength: 0.0075, packedRadius: 0.0075 }] }] }] }] };
  const losses = checkFormatLoss('rkt', { tree, motors: {}, launch: DEFAULT_CONDITIONS, configs: [], activeConfigId: null, measured: { massKg: null, cgM: null }, flightData: {} }).losses;
  expect(losses.join(' ')).toContain('Packed recovery dimensions');
});
it.each([-100, 0])('S1b-g4 carries the selected simulation site after motor re-pick (previous longitude %s)', async previousLongitude => {
  const site = (lat: number, lon: number) => `<LaunchLatitude>${lat}</LaunchLatitude><LaunchLongitude>${lon}</LaunchLongitude><LaunchAltitude>100</LaunchAltitude>`;
  const loaded = importRkt(rkt(body, '', `<SimulationResultsList>${sim('', 'UnknownMotor', site(40, previousLongitude))}${sim('', 'E15', site(45, -120))}</SimulationResultsList>`));
  const resolved = await resolveImportMotors(loaded, async ref => ({ motor: ref.designation === 'UnknownMotor' ? undefined : {
    label: 'E15', spec: { designation: 'E15', diameter: 0.024, length: 0.07, cgX: 0.035, times: [0, 1], thrusts: [0, 0], masses: [0.05, 0.03], ejectionDelay: 4 }, meta: { label: 'E15' }, ignition: { event: 'automatic', delay: 0 },
  }, note: '' }));
  const planned = planImport(loaded, resolved, { launch: DEFAULT_CONDITIONS, text: { mass: String, length: String } });
  expect(planned.snapshot.launch.latitudeDeg).toBe(45);
  expect(planned.snapshot.launch.longitudeDeg).toBe(-120);
  expect(planned.note.text).not.toContain('No launch site was taken');
});
it.each([5, 28])('S1b-g6 omits overridden design trigger note %s', type => {
  const loaded = importRkt(rkt(body, `<SimulationEventList>${event(type)}</SimulationEventList>`, `<SimulationResultsList>${sim(event(5, 152.4))}</SimulationResultsList>`));
  expect(loaded.notes.join(' ')).not.toMatch(/names none|does not recognise/);
  expect(loaded.notes.join(' ')).toContain('descending');
});
it('S1b-g6 tiers zero-altitude substitution as caution', () => {
  const loaded = importRkt(rkt(body, `<SimulationEventList>${event(5)}</SimulationEventList>`));
  expect(loaded.noteTiers?.some(n => n.tier === 'caution' && n.text.includes('names none'))).toBe(true);
});
it('S1b-g9 bounds omitted fin attached names', () => {
  const fin = `<FinSet><Name>Fin</Name><AttachedParts>${Array.from({ length: 50 }, (_, i) => `<X><Name>Child ${i}</Name></X>`).join('')}</AttachedParts></FinSet>`;
  const loaded = importRkt(rkt(body.replace('</AttachedParts>', `${fin}</AttachedParts>`)));
  const note = loaded.notes.find(n => n.includes('Child 0'))!;
  expect(note).toContain('and 45 more');
  expect(note).not.toContain('Child 5');
});
it('S1b-g9 stops a large attached-part summary and labels its lower bound', () => {
  const fin = `<FinSet><Name>Fin</Name><AttachedParts>${'<X/>'.repeat(400)}</AttachedParts></FinSet>`;
  const loaded = importRkt(rkt(body.replace('</AttachedParts>', `${fin}</AttachedParts>`)));
  expect(loaded.notes.join(' ')).toContain('and at least 395 more parts');
  expect(loaded.notes.join(' ').length).toBeLessThan(1500);
});
it('S1c-g2 zeros launch-stage burnout delay and discloses ignition loss', () => {
  const tree = { components: [{ type: 'stage' as const, children: [{ type: 'bodytube' as const, id: 'b', length: 0.3, outerRadius: 0.03 }] }] };
  const motors = { b: { designation: 'J350W', manufacturer: 'AeroTech', diameter: 0.038, length: 0.2, delay: Infinity, ignitionEvent: 'burnout', ignitionDelay: 5 } };
  const notes: string[] = [];
  const xml = exportCdx1({ name: 'Timing', tree, motors, notes, engineExport: true });
  expect(xml).toContain('<SustainerIgnitionDelay>0</SustainerIgnitionDelay>');
  expect(notes.join(' ')).toContain('reopens at launch');
  expect(Object.values(importCdx1(xml.replace('<SustainerIgnitionDelay>0<', '<SustainerIgnitionDelay>5<')).motors)[0]!.ignitionDelay).toBe(0);
  expect(checkFormatLoss('cdx1', { tree, motors, launch: DEFAULT_CONDITIONS, configs: [], activeConfigId: null, measured: { massKg: null, cgM: null }, flightData: {} }).losses.join(' ')).toContain('reopens at launch');
});
it.each([undefined, 'Unsupported maker'])('S1c-g2 omits burnout delay above a non-exported lower motor (%s)', manufacturer => {
  const tree = { components: ['upper', 'lower'].map(id => ({ type: 'stage' as const, children: [{ type: 'bodytube' as const, id, length: 0.3, outerRadius: 0.03 }] })) };
  const motors = { upper: { designation: 'J350W', manufacturer: 'AeroTech', diameter: 0.038, length: 0.2, delay: Infinity, ignitionEvent: 'burnout', ignitionDelay: 3 },
    ...(manufacturer ? { lower: { designation: 'Other', manufacturer, diameter: 0.038, length: 0.2, delay: Infinity } } : {}) };
  const notes: string[] = [];
  const xml = exportCdx1({ name: 'Timing', tree, motors, notes, engineExport: true });
  expect(xml).toContain('<SustainerIgnitionDelay>0</SustainerIgnitionDelay>');
  expect(notes.join(' ')).toContain('reopens at launch');
  expect(checkFormatLoss('cdx1', { tree, motors, launch: DEFAULT_CONDITIONS, configs: [], activeConfigId: null, measured: { massKg: null, cgM: null }, flightData: {} }).losses.join(' ')).toContain('reopens at launch');
});
it('S1d-1 warns when saved ork and share payload cannot reopen', () => {
  const notes: string[] = [];
  exportOrk({ name: 'Large', tree: { components: [{ type: 'stage', children: Array.from({ length: MAX_DESIGN_PARTS }, () => ({ type: 'bodytube' as const })) }] }, notes });
  expect(notes.join(' ')).toMatch(/cannot reopen.*desktop OpenRocket/);
  expect(noteFlags(notes).some(n => n.tier === 'caution' && n.text.includes('cannot reopen'))).toBe(true);
});
it('r2 S1d-1 oversized RockSim exports also carry a Caution', () => {
  const notes: string[] = [];
  exportRkt({ name: 'Large', tree: { components: [{ type: 'stage', children: Array.from({ length: MAX_DESIGN_PARTS }, () => ({ type: 'bodytube' as const, length: 0.001, outerRadius: 0.01 })) }] }, notes });
  expect(notes.join(' ')).toContain('opening limit');
  expect(noteFlags(notes).some(n => n.tier === 'caution' && n.text.includes('opening limit'))).toBe(true);
});
it('S1b-g5 prunes merged cluster receipts and single-tube mass comparisons', () => {
  const preset: Preset = { kind: 'BodyTube', manufacturer: 'Test', partNo: 'Tube', description: 'Tube', mass: 0.01, length: 0.1, outsideDiameter: 0.02, insideDiameter: 0.018 };
  const tubes = Array.from({ length: 4 }, (_, i) => `<BodyTube><Name>Motor tube (${i + 1})</Name><PartMfg>Test</PartMfg><PartNo>Tube</PartNo><SerialNo>${i + 2}</SerialNo><IsInsideTube>1</IsInsideTube><Len>100</Len><OD>20</OD><ID>18</ID><RadialLoc>${10 * Math.sqrt(2)}</RadialLoc><RadialAngle>${i * Math.PI / 2}</RadialAngle><KnownMass>10</KnownMass><UseKnownMass>1</UseKnownMass><UseKnownCG>0</UseKnownCG></BodyTube>`).join('');
  const xml = rkt(body.replace('</AttachedParts>', `${tubes}</AttachedParts>`));
  const loaded = importRkt(xml, { presets: [preset] });
  const tube = flat(loaded.tree.components).find(n => n.type === 'innertube')!;
  expect(tube['cluster']).toBe('4-ring');
  expect(tube['overrideMass']).toBeCloseTo(0.04, 12);
  expect(catalogueDifferences(tube, preset).map(d => d.key)).not.toContain('overrideMass');
  expect(loaded.notes.join(' ')).not.toContain('Motor tube (2)');
  expect(loaded.notes.join(' ')).not.toContain('4 parts');
  const zero = importRkt(xml.replace(/<KnownMass>10<\/KnownMass><UseKnownMass>1<\/UseKnownMass>/g, '<Density>0</Density><DensityType>0</DensityType>'));
  expect(zero.notes.filter(n => n.includes('density of 0') || n.includes('zero bulk density'))).toHaveLength(1);
});

it.each(suffixMotors)('r2 S1c-b1 preserves booster identity and suffix delay $designation', motor => {
  const xml = cdx('').replace('</RocketDesign>', '<Booster><Length>10</Length><Diameter>3</Diameter></Booster></RocketDesign>')
    .replace('</RASAeroDocument>', `<SimulationList><Simulation><Booster1Engine>${motor.designation}  (${motor.manufacturerAbbrev})</Booster1Engine><IncludeBooster1>True</IncludeBooster1></Simulation></SimulationList></RASAeroDocument>`);
  const ref = Object.values(importCdx1(xml).motors)[0]!;
  const suffix = motor.designation.split('-').at(-1)!;
  // The AMW case's three-plus-digit impulse is identity, not a delay.
  const stated = suffix.toUpperCase() === 'P' ? 'plugged' : suffix.length <= 2 ? Number(suffix) : undefined;
  const delay = stated === 'plugged' ? Infinity : stated ?? 0;
  expect(ref.designation).toBe(motor.designation);
  expect(ref.delay).toBe(delay);
  expect(ref.statedDelay).toBe(stated);
  expect(ref.matchContext?.explicitDelay).toBe(stated);
});
it('r2 S1c-b1 reads a lowercase plugged suffix without losing the exact identity', () => {
  const motor = suffixMotors[0]!;
  const designation = motor.designation.toLowerCase();
  const xml = cdx('').replace('</RocketDesign>', '<Booster><Length>10</Length><Diameter>3</Diameter></Booster></RocketDesign>')
    .replace('</RASAeroDocument>', `<SimulationList><Simulation><Booster1Engine>${designation}  (${motor.manufacturerAbbrev})</Booster1Engine><IncludeBooster1>True</IncludeBooster1></Simulation></SimulationList></RASAeroDocument>`);
  const ref = Object.values(importCdx1(xml).motors)[0]!;
  expect(ref.designation).toBe(designation);
  expect(ref.delay).toBe(Infinity);
  expect(ref.statedDelay).toBe('plugged');
});
it('r2 S1a-g3 identifies the immediate unnamed component', () => {
  const loaded = importOrk(ork('<bodytube><name>Upper tube</name><subcomponents><parachute><deploymentconfiguration configid="A"><deployaltitude>x</deployaltitude></deploymentconfiguration></parachute></subcomponents></bodytube>', '<motorconfiguration configid="A" default="true"/>'));
  const note = loaded.notes.find(n => n.includes('invalid <deployaltitude>'))!;
  expect(note).toContain('parachute');
  expect(note).not.toContain('Upper tube');
});
it.each(['Unknown', 'apogee'])('r2 S1c-b3 unknown %s never claims literal paired apogee', eventType => {
  const slot = (n: number, value: string, size: string) => `<Event${n}>True</Event${n}><EventType${n}>${value}</EventType${n}><DeviceType${n}>Parachute</DeviceType${n}><Size${n}>${size}</Size${n}><CD${n}>0.8</CD${n}><Altitude${n}>500</Altitude${n}>`;
  const loaded = importCdx1(cdx('', `<Recovery>${slot(1, 'Apogee', '36')}${slot(2, eventType, '36')}</Recovery>`));
  expect(loaded.notes.join(' ')).not.toContain('Both RASAero recovery slots say Apogee');
  const broken = importCdx1(cdx('', `<Recovery>${slot(1, eventType, 'x')}</Recovery>`));
  expect(broken.notes.join(' ')).toContain('The app uses apogee deployment');
  expect(broken.notes.join(' ')).not.toContain('500 ft deployment');
});
it('r2 S7c-g5 retains fairing and protuberance mass labels', () => {
  const table = componentTable({ components: [{ type: 'fairing', mass: 0.1 }, { type: 'protuberance' as ComponentNode['type'], mass: 0.2 }, { type: 'masscomponent', mass: 0.3 }] }, { units: INITIAL_UNITS, radiusMode: 'radius' });
  for (const [i, label] of ['Mass (as built) (g)', 'Mass, all of them (0 = not counted) (g)', 'Mass as entered (g)'].entries()) {
    expect(table.headers).toContain(label);
    expect(table.rows[i]![table.headers.indexOf(label)]).toBe((i + 1) * 100);
    expect(table.rows[(i + 1) % 3]![table.headers.indexOf(label)]).toBe('');
  }
});
it('r2 S1b-g5 catalogue picks weigh every clustered tube and clear catalogue weights', () => {
  const p: Preset = { kind: 'BodyTube', manufacturer: 'Test', partNo: 'Tube', description: 'Tube', mass: 0.01 };
  const prior: ComponentNode = { type: 'innertube', cluster: '4-ring' };
  const patch = presetPatch('innertube', p, { node: prior, presets: [p] });
  expect(patch['overrideMass']).toBeCloseTo(0.04, 12);
  const picked = { ...prior, ...patch };
  expect(holdsCatalogueMass(picked, [p])).toBe(true);
  expect(presetPatch('innertube', { ...p, mass: undefined }, { node: picked, presets: [p] })['overrideMass']).toBeUndefined();
  expect(Object.hasOwn(presetPatch('innertube', { ...p, mass: undefined }, { node: picked, presets: [p] }), 'overrideMass')).toBe(true);
});
it('r2 S1b-g5 saving a clustered My part stores one tube mass', () => {
  const node: ComponentNode = { type: 'innertube', cluster: '4-ring', overrideMass: 0.04 };
  const p = componentToPreset(node);
  expect(p.mass).toBeCloseTo(0.01, 12);
  expect(presetPatch('innertube', p, { node, presets: [p] }, undefined, { saved: true })['overrideMass']).toBeCloseTo(0.04, 12);
});
it.each(['<Size1>x</Size1><CD1>0.8</CD1>', '<Size1>36</Size1>'])('r2 S1c-b3 unreadable recovery inputs describe the effective event (%s)', fields => {
  const loaded = importCdx1(cdx('', `<Recovery><Event1>True</Event1><EventType1>Unknown</EventType1><DeviceType1>Parachute</DeviceType1><Altitude1>500</Altitude1>${fields}</Recovery>`));
  expect(loaded.notes.join(' ')).toContain('The app uses apogee deployment');
  expect(loaded.notes.join(' ')).not.toContain('500 ft deployment');
  expect(flat(loaded.tree.components).find(n => n.type === 'parachute')?.['deployEvent']).toBe('apogee');
});
it('r2 S1b-1 ambiguous motor routing leaves identical off-axis tubes mergeable', () => {
  const tubes = [0, Math.PI].map(angle => `<BodyTube><Name>Mount</Name><SerialNo>7</SerialNo><IsInsideTube>1</IsInsideTube><IsMotorMount>1</IsMotorMount><Len>100</Len><OD>20</OD><ID>18</ID><RadialLoc>10</RadialLoc><RadialAngle>${angle}</RadialAngle></BodyTube>`).join('');
  const xml = rkt(body.replace('</AttachedParts>', `${tubes}</AttachedParts>`), '', `<SimulationResultsList>${sim().replace('<MountSerialNo>1</MountSerialNo>', '<MountSerialNo>7</MountSerialNo>')}</SimulationResultsList>`);
  const loaded = importRkt(xml);
  expect(flat(loaded.tree.components).filter(n => n.type === 'innertube')).toHaveLength(1);
  expect(flat(loaded.tree.components).find(n => n.type === 'innertube')?.['cluster']).toBe('double');
  expect(loaded.notes.join(' ')).not.toContain('carry different motors');
  expect(Object.keys(loaded.motors)).toHaveLength(0);
});
it('r2 S1b-1 empty events on duplicate recovery serials stay quiet', () => {
  const parts = body.replace('</AttachedParts>', '<Parachute><Name>Other</Name><SerialNo>12</SerialNo></Parachute></AttachedParts>');
  const loaded = importRkt(rkt(parts, `<SimulationEventList>${event(0)}</SimulationEventList>`, `<SimulationResultsList><SimulationResults><SimulationEvents>${event(0)}</SimulationEvents></SimulationResults></SimulationResultsList>`));
  expect(loaded.notes.join(' ')).not.toMatch(/ambiguous|recovery settings are not imported/);
});
it('r2 S1b-1 duplicate recovery caution is emitted once across scopes and rows', () => {
  const parts = body.replace('</AttachedParts>', '<Parachute><Name>Other</Name><SerialNo>12</SerialNo></Parachute></AttachedParts>');
  const loaded = importRkt(rkt(parts, `<SimulationEventList>${event(1)}${event(1)}</SimulationEventList>`, `<SimulationResultsList>${sim(event(1) + event(1))}</SimulationResultsList>`));
  expect(loaded.notes.filter(n => n.includes('recovery assignment ambiguous'))).toHaveLength(1);
});
it.each([true, false])('r2 S1b-1 recovery serial shared with a ring stays unambiguous (ring last %s)', last => {
  const ring = '<Ring><Name>Ring</Name><SerialNo>12</SerialNo><OD>48</OD><ID>20</ID></Ring>';
  const parts = last ? body.replace('</AttachedParts>', `${ring}</AttachedParts>`) : body.replace('<Parachute>', `${ring}<Parachute>`);
  const loaded = importRkt(rkt(parts, `<SimulationEventList>${event(5, 152.4)}</SimulationEventList>`));
  expect(flat(loaded.tree.components).find(n => n.type === 'parachute')?.['deployEvent']).toBe('altitude');
  expect(loaded.notes.join(' ')).not.toContain('ambiguous');
});
it.each([0, -100])('r3 S1b-g4 folds identical settings across site differences (longitude %s)', longitude => {
  const site = (alt: string, lat = '40') => `<LaunchLatitude>${lat}</LaunchLatitude><LaunchLongitude>${longitude}</LaunchLongitude><LaunchAltitude>${alt}</LaunchAltitude>`;
  const loaded = importRkt(rkt(body, '', `<SimulationResultsList>${sim('', 'E15', site('100'))}${sim('', 'E15', site('100.0', '40.0'))}${sim('', 'E15', site('200'))}</SimulationResultsList>`));
  expect(loaded.configs).toHaveLength(1);
  if (longitude !== 0) expect(loaded.launch?.launchAltitudeM).toBe(100);
});

it('r3 P3 fin-attached summaries include direct pod subassemblies', () => {
  const pod = '<ExternalPod><Name>Pod</Name><SubAssembly><Name>Pod Sub</Name><AttachedParts><BodyTube><Name>Pod Tube</Name></BodyTube></AttachedParts></SubAssembly></ExternalPod>';
  const loaded = importRkt(rkt(body.replace('</AttachedParts>', `<FinSet><Name>Fin</Name><AttachedParts>${pod}</AttachedParts></FinSet></AttachedParts>`)));
  const receipt = noteFlags(loaded.notes).find(n => n.kind === 'I03.fin-attached')?.text;
  expect(receipt).toContain('Pod Sub');
  expect(receipt).toContain('Pod Tube');
});
it('r3 P3 an omitted pod with a direct subassembly reports its attached parts', () => {
  const parts = '<NoseCone><Name>Nose</Name><AttachedParts><ExternalPod><Name>Pod</Name><SubAssembly><AttachedParts><BodyTube><Name>Pod Tube</Name></BodyTube></AttachedParts></SubAssembly></ExternalPod></AttachedParts></NoseCone>';
  const receipt = noteFlags(importRkt(rkt(parts)).notes).find(n => n.kind === 'I03.left-out')?.text;
  expect(receipt).toContain('the pod “Pod”');
  expect(receipt).toContain('with the parts attached to it');
});
it('r3 P3 fin-attached summaries include direct non-chain and unknown pod children', () => {
  const pod = '<ExternalPod><Name>Pod</Name><Parachute><Name>Pod Chute</Name></Parachute><RingTail><Name>Pod Ring Tail</Name></RingTail></ExternalPod>';
  const loaded = importRkt(rkt(body.replace('</AttachedParts>', `<FinSet><Name>Fin</Name><AttachedParts>${pod}</AttachedParts></FinSet></AttachedParts>`)));
  const receipt = noteFlags(loaded.notes).find(n => n.kind === 'I03.fin-attached')?.text;
  expect(receipt).toContain('Pod Chute');
  expect(receipt).toContain('Pod Ring Tail');
  expect(receipt).not.toContain('unnamed Name');
});
it.each([false, true])('r3 P3 native pod metadata never becomes a component or crowds the summary (fin %s)', onFin => {
  const fields = ['PartDesc', 'WettedSurface', 'PaintedSurface', 'GlueJointLength', 'Texture', 'Opacity',
    'Specular', 'SpecularPower', 'Ambient', 'Diffuse', 'AbientColor', 'DiffuseColor', 'SpecularColor',
    'UseSingleColor', 'DisplayFlags', 'MetricsFlags', 'Color', 'BarrowmanCNa', 'BarrowmanXN',
    'RockSimCNa', 'RockSimXN', 'SimpleColorModel', 'ProduceTemplate', 'TemplateUnits', 'Station',
    'AutoCalcRadialPosition', 'Group'];
  const metadata = fields.map(tag => `<${tag}>0</${tag}>`).join('');
  const pod = `<ExternalPod><Name>Pod</Name>${metadata}<AttachedParts><BodyTube><Name>Pod Tube</Name><Len>100</Len><OD>25</OD></BodyTube></AttachedParts></ExternalPod>`;
  const attached = onFin ? `<FinSet><Name>Fin</Name><AttachedParts>${pod}</AttachedParts></FinSet>` : pod;
  const loaded = importRkt(rkt(body.replace('</AttachedParts>', `${attached}</AttachedParts>`)));
  expect(noteFlags(loaded.notes).some(n => n.kind === 'I03.ignored-components')).toBe(false);
  if (onFin) {
    const receipt = noteFlags(loaded.notes).find(n => n.kind === 'I03.fin-attached')?.text;
    expect(receipt).toContain('Pod Tube');
    expect(receipt).not.toContain('unnamed');
  } else expect(flat(loaded.tree.components).find(n => n.name === 'Pod Tube')?.type).toBe('bodytube');
});
it.each(['direct', 'attached', 'subassembly', 'nested'])('r3 P3/P4 disclose omitted pod children with the pod owner (%s)', path => {
  let children = '<BodyTube><Name>Pod Tube</Name><Len>200</Len><OD>25</OD></BodyTube><Parachute><Name>Pod Chute</Name><Dia>300</Dia></Parachute><MassObject><Name>Pod Mass</Name><KnownMass>5</KnownMass></MassObject><RingTail><Name>Unsupported</Name></RingTail>';
  if (path === 'subassembly' || path === 'nested') children = `<SubAssembly><Name>Pod Sub</Name><AttachedParts>${children}</AttachedParts></SubAssembly>`;
  if (path === 'nested') children = `<SubAssembly><AttachedParts>${children}</AttachedParts></SubAssembly>`;
  if (path !== 'direct') children = `<AttachedParts>${children}</AttachedParts>`;
  const pod = `<ExternalPod><Name>Pod</Name>${children}</ExternalPod>`;
  const loaded = importRkt(rkt(body.replace('</AttachedParts>', `${pod}</AttachedParts>`)));
  expect(flat(loaded.tree.components).find(n => n.name === 'Pod Tube')?.type).toBe('bodytube');
  const receipt = noteFlags(loaded.notes).find(n => n.kind === 'I03.left-out')?.text;
  expect(receipt).toMatch(/Pod Chute.*on the pod set “Pod”/);
  expect(receipt).toContain('Pod Mass');
  expect(receipt).not.toContain('Sustainer');
  expect(noteFlags(loaded.notes).find(n => n.kind === 'I03.ignored-components')?.text).toContain('RingTail');
});
it('r3 S1b-g4 loose sets inherit the first simulation site without duplicating a configuration', () => {
  const site = '<LaunchLatitude>40</LaunchLatitude><LaunchLongitude>-100</LaunchLongitude><LaunchAltitude>100</LaunchAltitude>';
  const loose = '<Stage3Engines><EngineSet><EngineCode>E15</EngineCode><EngineMfg>AeroTech</EngineMfg><MountSerialNo>1</MountSerialNo><EjectionDelay>4</EjectionDelay></EngineSet></Stage3Engines>';
  const loaded = importRkt(rkt(body, loose, `<SimulationResultsList>${sim('', 'E15', site)}</SimulationResultsList>`));
  expect(loaded.configs).toHaveLength(1);
  expect(loaded.launch).toMatchObject({ latitudeDeg: 40, longitudeDeg: -100, launchAltitudeM: 100 });
});
it('r3 S1b-g4 a folded loose duplicate does not exceed the 256 configuration limit', () => {
  const site = '<LaunchLatitude>40</LaunchLatitude><LaunchLongitude>-100</LaunchLongitude><LaunchAltitude>100</LaunchAltitude>';
  const loose = '<Stage3Engines><EngineSet><EngineCode>E15</EngineCode><EngineMfg>AeroTech</EngineMfg><MountSerialNo>1</MountSerialNo><EjectionDelay>4</EjectionDelay></EngineSet></Stage3Engines>';
  const simulations = Array.from({ length: 256 }, (_, i) => sim('', 'E15', site).replace('<EjectionDelay>4</EjectionDelay>', `<EjectionDelay>${i + 4}</EjectionDelay>`)).join('');
  expect(importRkt(rkt(body, loose, `<SimulationResultsList>${simulations}</SimulationResultsList>`)).configs).toHaveLength(256);
});
it.each([false, true])('r3 S1b-g5 legacy My parts retain whole-cluster mass through storage and CSV (csv %s)', csv => {
  const legacy: Preset = { kind: 'BodyTube', manufacturer: 'My parts', partNo: 'Legacy', description: '', savedComponent: true, mass: 0.04 };
  const key = 'online-openrocket.custom-presets.v1';
  const original = localStorage.getItem(key);
  try {
    expect(saveCustomPresets([legacy])).toBe(true);
    const p = (csv ? csvToPresets(presetsToCsv(loadCustomPresets())) : loadCustomPresets())[0]!;
    expect(p['savedComponentVersion']).toBeUndefined();
    const node: ComponentNode = { type: 'innertube', cluster: '4-ring' };
    const picked = { ...node, ...presetPatch('innertube', p, { node, presets: [p] }, undefined, { saved: true }) };
    expect(picked['overrideMass']).toBeCloseTo(0.04, 12);
    expect(holdsCatalogueMass(picked, [p])).toBe(true);
    expect(presetPatch('innertube', { ...p, mass: undefined }, { node: picked, presets: [p] })['overrideMass']).toBeUndefined();
  } finally {
    if (original === null) localStorage.removeItem(key);
    else localStorage.setItem(key, original);
  }
});
it('r3 S1b-g5 new My parts mark per-tube mass and preserve it through storage and CSV', () => {
  const node: ComponentNode = { type: 'innertube', cluster: '4-ring', overrideMass: 0.04 };
  const saved = componentToPreset(node);
  saved.partNo = 'New tube';
  expect(saved['savedComponentVersion']).toBe(2);
  const key = 'online-openrocket.custom-presets.v1';
  const original = localStorage.getItem(key);
  try {
    expect(saveCustomPresets([saved])).toBe(true);
    const p = csvToPresets(presetsToCsv(loadCustomPresets()))[0]!;
    expect(p['savedComponentVersion']).toBe(2);
    expect(p.mass).toBeCloseTo(0.01, 12);
    expect(presetPatch('innertube', p, { node, presets: [p] }, undefined, { saved: true })['overrideMass']).toBeCloseTo(0.04, 12);
    const single: ComponentNode = { type: 'innertube', cluster: 'single' };
    expect(presetPatch('innertube', p, { node: single, presets: [p] }, undefined, { saved: true })['overrideMass']).toBeCloseTo(0.01, 12);
  } finally {
    if (original === null) localStorage.removeItem(key);
    else localStorage.setItem(key, original);
  }
});

it('r4 S1b-g4 parses candidate coordinates once across distinct loadouts', () => {
  const count = 64;
  const site = '<LaunchLatitude>40</LaunchLatitude><LaunchLongitude>-100</LaunchLongitude><LaunchAltitude>100</LaunchAltitude>';
  const simulations = Array.from({ length: count }, (_, i) => sim('', 'E15', site)
    .replace('<EjectionDelay>4</EjectionDelay>', `<EjectionDelay>${i % 16 + 4}</EjectionDelay>`)).join('');
  let queries = 0;
  const parser = currentXmlParser();
  setXmlParser(xml => {
    const doc = parser(xml);
    for (const el of Array.from(doc.querySelectorAll('SimulationResults'))) {
      const query = el.querySelector;
      el.querySelector = selector => {
        if (/^:scope > Launch(?:Latitude|Longitude)$/.test(selector)) queries++;
        return query.call(el, selector);
      };
    }
    return doc;
  });
  try {
    const loaded = importRkt(rkt(body, '', `<SimulationResultsList>${simulations}</SimulationResultsList>`));
    expect(loaded.configs).toHaveLength(16);
    expect(loaded.launch).toMatchObject({ latitudeDeg: 40, longitudeDeg: -100, launchAltitudeM: 100 });
    expect(queries).toBe(2 * count);
  } finally { setXmlParser(parser); }
});

it('r4 S1b-g6 parses design recovery events once across distinct loadouts', () => {
  const count = 128;
  const simulations = Array.from({ length: 16 }, (_, i) => sim(i === 0 ? event(5, 152.4) : '')
    .replace('<EjectionDelay>4</EjectionDelay>', `<EjectionDelay>${i + 4}</EjectionDelay>`)).join('');
  let queries = 0;
  const parser = currentXmlParser();
  setXmlParser(xml => {
    const doc = parser(xml);
    for (const el of Array.from(doc.querySelectorAll('RocketDesign > SimulationEventList > SimulationEvent'))) {
      const query = el.querySelector;
      el.querySelector = selector => {
        if (selector === ':scope > PartSerialNo') queries++;
        return query.call(el, selector);
      };
    }
    return doc;
  });
  try {
    const loaded = importRkt(rkt(body, `<SimulationEventList>${event(28).repeat(count)}</SimulationEventList>`,
      `<SimulationResultsList>${simulations}</SimulationResultsList>`));
    expect(loaded.configs).toHaveLength(16);
    const [overridden, inherited] = loaded.configs!;
    expect(loaded.configNotes![overridden!.id]!.join(' ')).not.toContain('does not recognise');
    expect(loaded.configNotes![inherited!.id]!.join(' ')).toContain('does not recognise (28)');
    expect(queries).toBe(count);
  } finally { setXmlParser(parser); }
});

it('r5 bounds and caches 10,000 unknown recovery codes across 256 configurations', () => {
  const count = 10_000;
  const events = Array.from({ length: count }, (_, i) => event(i + 100)).join('');
  const simulations = Array.from({ length: 256 }, (_, i) => sim('')
    .replace('<EjectionDelay>4</EjectionDelay>', `<EjectionDelay>${i + 4}</EjectionDelay>`)).join('');
  let visits = 0;
  const iterator = Map.prototype[Symbol.iterator];
  const probe = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (this: Map<unknown, unknown>) {
    for (const entry of iterator.call(this)) {
      if (this.size === count && entry[1] instanceof Set) visits++;
      yield entry;
    }
    return undefined;
  });
  try {
    const loaded = importRkt(rkt(body, `<SimulationEventList>${events}</SimulationEventList>`,
      `<SimulationResultsList>${simulations}</SimulationResultsList>`));
    expect(loaded.configs).toHaveLength(256);
    for (const config of loaded.configs!) {
      const notes = loaded.configNotes![config.id]!.filter(n => n.includes('does not recognise'));
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain('(100, 101, 102, 103, 104 and 9995 more codes)');
      expect(notes[0]!.length).toBeLessThan(350);
      expect(loaded.noteTiers).toContainEqual(expect.objectContaining({ kind: 'I11.unknown-trigger', tier: 'caution' }));
    }
    expect(visits).toBe(count);
  } finally { probe.mockRestore(); }
}, 60_000);

it.each([1, 5, 6])('r5 lists at most five of %s unknown recovery codes', count => {
  const events = Array.from({ length: count }, (_, i) => event(i + 100)).join('');
  const loaded = importRkt(rkt(body, `<SimulationEventList>${events}</SimulationEventList>`));
  const note = loaded.notes.find(n => n.includes('does not recognise'))!;
  expect(note).toContain(count === 1 ? '(100)' : count === 5
    ? '(100, 101, 102, 103, 104)' : '(100, 101, 102, 103, 104 and 1 more code)');
});

it('r5 caches by effective overridden serials regardless of trigger values or order', () => {
  const parts = body.replace('</AttachedParts>', '<Parachute><Name>Drogue</Name><SerialNo>13</SerialNo><Dia>300</Dia></Parachute></AttachedParts>');
  const other = (type: number) => event(type).replace('<PartSerialNo>12</PartSerialNo>', '<PartSerialNo>13</PartSerialNo>');
  const events = Array.from({ length: 6 }, (_, i) => i % 2 ? other(i + 100) : event(i + 100)).join('');
  const overrides = ['', event(4), event(1), other(4), event(4) + other(4), other(1) + event(1)];
  let visits = 0;
  const iterator = Map.prototype[Symbol.iterator];
  const probe = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (this: Map<unknown, unknown>) {
    for (const entry of iterator.call(this)) {
      if (this.size === 6 && entry[1] instanceof Set) visits++;
      yield entry;
    }
    return undefined;
  });
  try {
    const loaded = importRkt(rkt(parts, `<SimulationEventList>${events}</SimulationEventList>`,
      `<SimulationResultsList>${overrides.map((o, i) => sim(o)
        .replace('<EjectionDelay>4</EjectionDelay>', `<EjectionDelay>${i + 4}</EjectionDelay>`)).join('')}</SimulationResultsList>`));
    expect(loaded.configs).toHaveLength(6);
    const notes = loaded.configs!.map(c => loaded.configNotes![c.id]!.join(' '));
    expect(notes[0]).toContain('and 1 more code');
    expect(notes[1]).toContain('(101, 103, 105)');
    expect(notes[2]).toContain('(101, 103, 105)');
    expect(notes[3]).toContain('(100, 102, 104)');
    expect(notes[4]).not.toContain('does not recognise');
    expect(notes[5]).not.toContain('does not recognise');
    expect(visits).toBe(6 * 4);
  } finally { probe.mockRestore(); }
});

it.each([false, true])('r4 S1b-g5 clears base-era cluster catalogue mass on a massless pick (My part %s)', saved => {
  const row: Preset = { kind: 'BodyTube', manufacturer: 'Test', partNo: 'Tube', description: '', mass: 0.01 };
  const node: ComponentNode = { type: 'innertube', cluster: '4-ring', overrideMass: 0.01,
    presetManufacturer: row.manufacturer, presetPartNo: row.partNo };
  const massless: Preset = { ...row, partNo: 'Massless', mass: undefined, ...(saved ? { savedComponent: true } : {}) };
  expect(holdsCatalogueMass(node, [row])).toBe(true);
  expect(presetPatch('innertube', massless, { node, presets: [row] })['overrideMass']).toBeUndefined();
  expect(presetPatch('innertube', row, { node, presets: [row] })['overrideMass']).toBeCloseTo(0.04, 12);
  expect(holdsCatalogueMass({ ...node, overrideMass: 0.04 }, [row])).toBe(true);
  const detached = { ...node, name: 'Test Tube', presetManufacturer: undefined, presetPartNo: undefined };
  expect(holdsCatalogueMass(detached, [row])).toBe(true);
  expect(holdsCatalogueMass({ ...detached, name: 'Weighed tube' }, [row])).toBe(false);
  expect(holdsCatalogueMass(node, [{ ...row, savedComponent: true, savedComponentVersion: 2 }])).toBe(false);
  const weighed = { ...node, overrideMass: 0.013 };
  expect(holdsCatalogueMass(weighed, [row])).toBe(false);
  expect(Object.hasOwn(presetPatch('innertube', massless, { node: weighed, presets: [row] }), 'overrideMass')).toBe(false);
});

it('r4 S1b-g6 filters cached aggregate diagnostics by serial and preserves caution tiers', () => {
  const parts = body.replace('</AttachedParts>', '<Parachute><Name>Drogue</Name><SerialNo>13</SerialNo><Dia>200</Dia></Parachute></AttachedParts>');
  const unknown = (serial: number) => event(28).replace('<PartSerialNo>12</PartSerialNo>', `<PartSerialNo>${serial}</PartSerialNo>`)
    .replace('</SimulationEvent>', '<ProEvent>1</ProEvent></SimulationEvent>');
  const design = `<SimulationEventList>${unknown(12)}${unknown(13)}</SimulationEventList>`;
  const simulations = `<SimulationResultsList>${sim(event(4))}${sim(event(4) + event(4).replace('<PartSerialNo>12</PartSerialNo>', '<PartSerialNo>13</PartSerialNo>'))}</SimulationResultsList>`;
  const loaded = importRkt(rkt(parts, design, simulations));
  const [partial, all] = loaded.configs!;
  const partialNotes = loaded.configNotes![partial!.id]!;
  expect(partialNotes.join(' ')).toContain('does not recognise (28)');
  expect(partialNotes.find(n => n.includes('Pro conditions'))).toContain('Drogue');
  expect(partialNotes.find(n => n.includes('Pro conditions'))).not.toContain('Main');
  expect(loaded.configNotes![all!.id]!.join(' ')).not.toMatch(/Pro conditions|does not recognise/);
  for (const text of partialNotes.filter(n => /Pro conditions|does not recognise/.test(n))) {
    expect(loaded.noteTiers?.some(n => n.text === text && n.tier === 'caution')).toBe(true);
  }
  const fallback = importRkt(rkt(body, `<SimulationEventList>${event(5)}</SimulationEventList>`, `<SimulationResultsList>${sim()}</SimulationResultsList>`));
  const note = fallback.notes.find(n => n.includes('names none'))!;
  expect(note).toBeDefined();
  expect(fallback.noteTiers?.some(n => n.text === note && n.tier === 'caution')).toBe(true);
});

it('r4 S1b-g5 recognizes base-era and scaled retired cluster catalogue masses', () => {
  const [key, masses] = Object.entries(retiredPresetMasses).find(([key]) => key.startsWith('BodyTube|'))!;
  const [, manufacturer, partNo] = key.split('|');
  const row: Preset = { kind: 'BodyTube', manufacturer: manufacturer!, partNo: partNo!, description: '' };
  for (const copies of [1, 4]) {
    const node: ComponentNode = { type: 'innertube', cluster: '4-ring', overrideMass: masses[0]! * copies,
      presetManufacturer: row.manufacturer, presetPartNo: row.partNo };
    expect(holdsCatalogueMass(node, [row])).toBe(true);
    expect(presetPatch('innertube', row, { node, presets: [row] })['overrideMass']).toBeUndefined();
  }
});
