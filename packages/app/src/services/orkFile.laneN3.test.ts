// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest';
import { gzipSync, zipSync } from 'fflate';
import { importOrk, exportOrk, MAX_ORK_CONFIGURATIONS } from './orkFile.js';
import { resolveFlightState } from './flightState.js';
import { currentXmlParser, setXmlParser } from './xmlParse.js';
import { createJsXmlParser, jsXmlParser } from './xmlParseJs.js';
import { inlineXmlCdata, escapeXml } from './xmlUtil.js';
import { parseDesignFile } from './designFile.js';
import { describeDeployment, sameDeployment } from './deployOverrideNote.js';
import type { Preset } from './presets.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { importRkt } from './rocksimFile.js';
import { findDbMotor, MOTOR_DB } from './motorDb.js';

const original = currentXmlParser();
afterEach(() => setXmlParser(original));
const tube = '<bodytube><length>0.3</length><radius>0.025</radius></bodytube>';
const stage = (parts: string, extra = '') => `<stage>${extra}<subcomponents>${parts}</subcomponents></stage>`;
const file = (parts: string, configs = '', extraStage = '') => `<openrocket version="1.10"><rocket>${configs}<subcomponents>${stage(parts)}${extraStage}</subcomponents></rocket></openrocket>`;
const config = (id: string) => `<motorconfiguration configid="${id}" default="true"/>`;
const part = (r: ReturnType<typeof importOrk>) => r.tree.components[0]!.children![0]!;
const effective = (r: ReturnType<typeof importOrk>) => resolveFlightState(r.tree, r.configs.map(c => ({ ...c, motors: {} })), r.chosenConfigId, {}, {}).tree;
const preset: Preset = { kind: 'BodyTube', manufacturer: 'Test', partNo: 'T', description: 'Tube', material: { type: 'BULK', name: 'Test', density: 1234 } };

it.each(['top', ' bottom '])('C-F1-1 keeps the default on an invalid offset (%s)', method => {
  expect(part(importOrk(file(`<freeformfinset><axialoffset method="${method}">oops</axialoffset></freeformfinset>`))).position).toBeUndefined();
  expect(part(importOrk(file(`<freeformfinset><axialoffset method="${method}">0.1</axialoffset></freeformfinset>`))).position).toEqual({ method: method.trim(), offset: 0.1 });
});
it('C-F2-3 Save omits unknown unmatched motor dimensions', () => {
  const r = importOrk(file('<bodytube><motormount><motor configid="a"><designation>NO-SUCH-MOTOR</designation><delay>4</delay></motor></motormount></bodytube>', config('a')));
  const saved = exportOrk({ ...r, activeConfigId: r.chosenConfigId, launch: DEFAULT_CONDITIONS });
  const motor = jsXmlParser(saved).querySelector('motormount > motor')!;
  expect(motor).not.toBeNull();
  expect(motor.querySelector('diameter, length')).toBeNull();
  expect(Object.values(importOrk(saved).motors)[0]).toMatchObject({ diameter: 0, length: 0 });
  expect(importOrk(saved).notes.join('\n')).not.toContain('missing dimensions do not restrict');
});
it('C-F1-1 applies both position tags in document order, keeping the last valid setter', () => {
  for (const [first, last] of [['axialoffset', 'position'], ['position', 'axialoffset']]) {
    const tags = `<${first} method="top" type="top">0.1</${first}><${last} method="bottom" type="bottom">0.2</${last}>`;
    expect(part(importOrk(file(`<freeformfinset>${tags}</freeformfinset>`))).position).toEqual({ method: 'bottom', offset: 0.2 });
    expect(part(importOrk(file(`<freeformfinset>${tags}<axialoffset method="middle">bad</axialoffset></freeformfinset>`))).position).toEqual({ method: 'bottom', offset: 0.2 });
  }
});
it('C-F2-4 summarizes multiple inferred configurations once', () => {
  const r = importOrk(file('<bodytube><motormount><motor configid="a"/><motor configid="b"/></motormount></bodytube>'));
  expect(r.configs.map(c => c.id)).toEqual(['a', 'b']);
  expect(r.notes.filter(n => n.includes('undeclared'))).toHaveLength(1);
  expect(r.notes.join('\n')).toContain('2 undeclared flight configurations were inferred');
});
it('C-F1-1 cautions once per part for paired invalid axial methods', () => {
  const fins = '<freeformfinset><axialoffset method="bad">0.1</axialoffset><position type="bad">0.1</position></freeformfinset>';
  const r = importOrk(file(fins + fins));
  expect(r.notes.filter(n => n.includes('invalid or missing axial position method'))).toHaveLength(2);
});
it('C-F2-4 uses singular inference copy and omits zero inference copy', () => {
  const one = importOrk(file('<bodytube><motormount><motor configid="a"/></motormount></bodytube>'));
  expect(one.notes.join('\n')).toContain('1 undeclared flight configuration was inferred');
  const declared = Array.from({ length: MAX_ORK_CONFIGURATIONS }, (_, i) => config(`c${i}`)).join('');
  const capped = importOrk(file('<bodytube><motormount><motor configid="excess"/></motormount></bodytube>', declared));
  expect(capped.notes.join('\n')).toContain('excess undeclared motor configurations were ignored');
  expect(capped.notes.join('\n')).not.toContain('were inferred');
});
it.each(['parachute', 'streamer'])('C-F2-2 cautions on bare lower-stage %s defaults, without repeating on reopen', tag => {
  const r = importOrk(file(`<${tag}><deployevent>lowerstageseparation</deployevent><deploymentconfiguration configid="a"><deployevent>lowerstageseparation</deployevent></deploymentconfiguration></${tag}>`, config('a')));
  const bare = importOrk(file(`<${tag}><deployevent>lowerstageseparation</deployevent></${tag}>`));
  for (const imported of [r, bare]) {
    expect(imported.notes.filter(n => n.includes('deployment event lowerstageseparation'))).toHaveLength(1);
    expect(part(imported)['deployEvent']).toBe('lowerstageseparation');
    const reopened = importOrk(exportOrk({ ...imported, launch: DEFAULT_CONDITIONS, activeConfigId: imported.chosenConfigId }));
    expect(reopened.notes.join('\n')).not.toContain('deployment event lowerstageseparation');
  }
});
it.each(['lowerstageseparation', 'unknown'])('C-F2-2 compares flown events for %s', deployEvent => {
  const own = { deployEvent: 'ejection', deployAltitude: 200, deployDelay: 0 };
  expect(sameDeployment(own, { ...own, deployEvent })).toBe(true);
  const r = importOrk(file(`<parachute><deployevent>ejection</deployevent><deploymentconfiguration configid="a"><deployevent>${deployEvent}</deployevent></deploymentconfiguration></parachute>`, config('a')));
  expect(r.notes.join('\n')).not.toContain('overrides the deployment');
  if (deployEvent === 'lowerstageseparation') {
    expect(r.notes.join('\n')).toContain('lowerstageseparation');
    expect(r.notes.join('\n')).toContain('motor ejection charge');
  }
});
it.each(['surface', 'line'])('C-F1-2 discloses rejected structural %s material', type => {
  const r = importOrk(file(`<bodytube><material type="${type}" density="42">Wrong kind</material></bodytube>`));
  expect(r.notes.join('\n')).toContain('material type');
  expect(r.notes.join('\n')).toContain('mass');
});
it.each([{ presets: [] }, { presets: [{ ...preset, kind: 'Parachute', partNo: 'P' }] }])('L-M2-1 omits notes without usable preset Cd or mass', ({ presets }) => {
  const r = importOrk(file('<parachute><preset manufacturer="Test" partno="P"/></parachute>'), { presets });
  expect(r.notes.join('\n')).not.toContain('linked recovery preset');
});
it('L-M2-1 omits preset notes when reopening an app file', () => {
  const r = importOrk(file('<parachute><preset manufacturer="Test" partno="P"/></parachute>'));
  const saved = exportOrk({ ...r, launch: DEFAULT_CONDITIONS });
  expect(importOrk(saved, { presets: [recoveryPreset] }).notes.join('\n')).not.toContain('linked recovery preset');
});
it('C-F2-4 ignores excess inferred motor IDs with one note', () => {
  const motors = Array.from({ length: MAX_ORK_CONFIGURATIONS + 2 }, (_, i) => `<motor configid="stray-${i}"><designation>Missing</designation></motor>`).join('');
  const r = importOrk(file(`<bodytube><motormount>${motors}</motormount></bodytube>`));
  expect(r.notes.filter(n => n.includes('excess undeclared'))).toHaveLength(1);
});
it('C-F2-4 ignores deployment and separation IDs that have no motor declaration', () => {
  const r = importOrk(file('<parachute><deploymentconfiguration configid="stray"><deployevent>apogee</deployevent></deploymentconfiguration></parachute>', '', stage(tube, '<separationconfiguration configid="stray"><separationevent>never</separationevent></separationconfiguration>')));
  expect(r.configs).toEqual([]);
});

it('C-F1-1 ignores an axial offset without a method, as desktop does', () => {
  const r = importOrk(file('<freeformfinset><axialoffset>0.1</axialoffset><finpoints><point x="0" y="0"/><point x="0.03" y="0.02"/><point x="0.05" y="0"/></finpoints></freeformfinset>'));
  expect(part(r).position).toBeUndefined();
  expect(r.notes.join('\n')).toContain('axial position');
});
it.each([['bodytube', 'density', 'bulk'], ['parachute', 'surfaceDensity', 'surface'], ['shockcord', 'lineDensity', 'line']])('C-F1-2 keeps untyped %s material', (tag, key, type) => {
  const r = importOrk(file(`<${tag}><material density="42">Test material</material></${tag}>`));
  expect(part(r)[key]).toBe(42);
  expect(part(importOrk(file(`<${tag}><material type="${type}" density="42">Test material</material></${tag}>`)))[key]).toBe(42);
});
it('C-F1-3 folds booleans and filled, including auto-radius helpers', () => {
  const r = importOrk(file('<bodytube><radius>0.025</radius><thickness>FiLlEd</thickness><overridesubcomponentsmass>TRUE</overridesubcomponentsmass><subcomponents><parachute><packedradius>auto</packedradius></parachute></subcomponents></bodytube>'));
  expect(part(r)).toMatchObject({ filled: true, overrideSubcomponentsMass: true });
  expect(r.notes.join('\n')).not.toContain('invalid <thickness>');
  expect(part(r).children![0]!['packedRadius']).toBeCloseTo(0.0125);
});
it('C-F1-4 reports the actual catalogue replacement for zero density', () => {
  const r = importOrk(file('<bodytube><preset manufacturer="Test" partno="T"/><material type="bulk" density="0">Test</material></bodytube>'), { presets: [preset] });
  expect(part(r).density).toBe(1234);
  const note = r.notes.find(n => n.includes('zero bulk density'))!;
  expect(note).toContain('1234');
  expect(note).not.toContain('680');
});
it('C-F1-4 sibling: RockSim reports its catalogue replacement too', () => {
  const xml = '<RockSimDocument><DesignInformation><RocketDesign><StageCount>1</StageCount><Stage3Parts><BodyTube><Name>Tube</Name><PartMfg>Test</PartMfg><PartNo>T</PartNo><OD>50</OD><ID>48</ID><Len>300</Len><DensityType>0</DensityType><Density>0</Density></BodyTube></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>';
  const r = importRkt(xml, { presets: [preset] });
  expect(part(r).density).toBe(1234);
  expect(r.notes.find(n => n.includes('zero bulk density'))).toContain('1234');
});
it('C-F2-1 ignores an unknown block separation event and inherits the stage event', () => {
  const r = importOrk(file(tube, config('a'), stage(tube, '<separationevent>never</separationevent><separationconfiguration configid="a"><separationevent>foo</separationevent><separationdelay>2</separationdelay></separationconfiguration>')));
  expect(effective(r).components[1]).toMatchObject({ separationEvent: 'never', separationDelay: 2 });
  expect(r.notes.join('\n')).toContain('foo');
  expect(r.notes.join('\n')).toContain('kept');
});
it('C-F2-2 describes the effective recovery fallback while retaining the file value', () => {
  expect(describeDeployment({ deployEvent: 'foo\nFORGED', deployDelay: 2, deployAltitude: 200 })).toContain('Motor ejection');
  expect(describeDeployment({ deployEvent: 'foo\nFORGED', deployDelay: 2, deployAltitude: 200 })).not.toContain('\n');
  expect(part(importOrk(file('<parachute><deployevent>foo</deployevent></parachute>')))['deployEvent']).toBe('foo');
});
it('C-F2-3 does not invent motor dimensions that constrain a match', () => {
  const motor = MOTOR_DB.find(m => m.diameter > 24 && findDbMotor(m.designation, undefined, undefined, m.manufacturerAbbrev)?.motorId === m.motorId)!;
  expect(motor).toBeDefined();
  const r = importOrk(file(`<bodytube><motormount><motor configid="a"><designation>${escapeXml(motor.designation)}</designation><manufacturer>${escapeXml(motor.manufacturerAbbrev)}</manufacturer><delay>4</delay></motor></motormount></bodytube>`, config('a')));
  const ref = Object.values(r.motors)[0]!;
  expect(ref).toMatchObject({ diameter: 0, length: 0 });
  expect(findDbMotor(ref.designation, ref.diameter > 0 ? ref.diameter * 1000 : undefined, undefined, ref.manufacturer)?.motorId).toBe(motor.motorId);
  expect(r.notes.join('\n')).toContain('missing dimensions do not restrict');
  expect(r.notes.filter(n => n.includes('missing dimensions do not restrict'))).toHaveLength(1);
});
it('C-F2-4 selects the last default and retains undeclared motor configurations', () => {
  const r = importOrk(file('<bodytube><motormount><motor configid="stray"><designation>F20</designation><delay>4</delay></motor></motormount></bodytube>', config('a') + config('b')));
  expect(r.chosenConfigId).toBe('b');
  expect(r.configs.find(c => c.id === 'stray')?.motors[part(r).id!]?.designation).toBe('F20');
  expect(r.notes.join('\n')).toContain('undeclared');
});
it('A-S4-2 retains ignition blocks without a configuration declaration', () => {
  const r = importOrk(file('<bodytube><motormount><motor configid="a"><designation>F20</designation><delay>4</delay></motor><ignitionconfiguration configid="a"><ignitionevent>burnout</ignitionevent><ignitiondelay>2</ignitiondelay></ignitionconfiguration></motormount></bodytube>'));
  expect(r.chosenConfigId).toBe('a');
  expect(r.configs[0]?.ignitions?.[part(r).id!]).toEqual({ event: 'burnout', delay: 2 });
  expect(Object.values(r.motors)[0]).toMatchObject({ ignitionEvent: 'burnout', ignitionDelay: 2 });
  const reopened = importOrk(exportOrk({ ...r, launch: { ...DEFAULT_CONDITIONS, ...r.launch }, activeConfigId: r.chosenConfigId }));
  expect(reopened.configs[0]?.ignitions?.[part(reopened).id!]).toEqual({ event: 'burnout', delay: 2 });
});
it('A-S4-2 sibling: parameter-only ignition changes the default without creating a configuration', () => {
  const r = importOrk(file('<bodytube><motormount><ignitionconfiguration configid="a"><ignitionevent>burnout</ignitionevent><ignitiondelay>2</ignitiondelay></ignitionconfiguration></motormount></bodytube>'));
  expect(r.configs).toEqual([]);
  expect(r.tree.ignitionDefaults?.[part(r).id!]).toEqual({ event: 'burnout', delay: 2 });
});
it('A-S4-2 desktop files fold unloaded ignition into the mount default', () => {
  const r = importOrk(file('<bodytube><motormount><ignitionevent>launch</ignitionevent><ignitionconfiguration configid="a"><ignitionevent>never</ignitionevent><ignitiondelay>2</ignitiondelay></ignitionconfiguration></motormount></bodytube>', '<motorconfiguration configid="a"><name>Desktop</name></motorconfiguration>').replace('<openrocket ', '<openrocket creator="OpenRocket 24.12" '));
  expect(r.tree.ignitionDefaults?.[part(r).id!]).toEqual({ event: 'never', delay: 2 });
  expect(r.configs[0]!.ignitions).toBeUndefined();
});
it('A-S4-3 accepts a BOM in limited parser preflight too', () => {
  const parser = createJsXmlParser({ maxElements: 100, maxDepth: 10 });
  expect(() => parser.preflight!('\uFEFF<?xml version="1.0"?><x/>')).not.toThrow();
});
it('C-F5-3 keeps CDATA boundary text legal', () => {
  expect(jsXmlParser(inlineXmlCdata('<x><![CDATA[a]]]]>></x>')).documentElement.textContent).toBe('a]]>');
});
it.each(['plain', 'gzip', 'zip'])('C-F5-1 sniffs swapped .ork and .rkt content (%s)', async compression => {
  const encode = (xml: string, ext: string) => {
    const raw = new TextEncoder().encode(`<?xml version="1.0"?><!-- <WrongRoot/> -->${xml}`);
    const bytes = compression === 'gzip' ? gzipSync(raw) : compression === 'zip' ? zipSync({ 'decal.png': new Uint8Array([1, 2, 3]), [`rocket.${ext}`]: raw }) : raw;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };
  const rkt = '<RockSimDocument><DesignInformation><RocketDesign><Name>Test</Name><StageCount>1</StageCount><Stage3Parts><BodyTube><OD>50</OD><ID>48</ID><Len>300</Len></BodyTube></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>';
  for (const [xml, actual, named] of [[rkt, 'rkt', 'ork'], [file(tube), 'ork', 'rkt']]) {
    const r = await parseDesignFile(encode(xml!, actual!), `wrong.${named}`, { presets: [] });
    expect(r.sourceFormat).toBe(actual);
    expect(r.notes.join('\n')).toContain('content');
  }
});
const recoveryPreset: Preset = { kind: 'Parachute', manufacturer: 'Test', partNo: 'P', description: 'Recovery', mass: 0.1 };
it('L-M2-1 takes linked recovery mass while leaving an unrated Cd automatic', () => {
  const r = importOrk(file('<parachute><preset manufacturer="Test" partno="P"/><cd>auto</cd></parachute>'), { presets: [recoveryPreset] });
  expect(part(r)['cd']).toBeUndefined();
  expect(part(r)['overrideMass']).toBe(0.1);
  expect(r.notes.join('\n')).toContain('took mass from the catalogue');
  expect(r.noteTiers?.some(n => n.kind === 'I19.catalogue-filled')).toBe(true);
});
it.each(['parachute', 'streamer'])('L-M2-1 fills missing preset mass on %s while keeping stated Cd', tag => {
  const r = importOrk(file(`<${tag}><preset manufacturer="Test" partno="P"/><cd>0.9</cd></${tag}>`), { presets: [{ ...recoveryPreset, kind: tag === 'parachute' ? 'Parachute' : 'Streamer' }] });
  expect(part(r)['cd']).toBe(0.9);
  expect(part(r)['overrideMass']).toBe(0.1);
  expect(r.notes.join('\n')).toContain('took mass from the catalogue');
});
it.each(['bodytube', 'nosecone', 'transition'])('C-F1-3 sibling: %s reads uppercase filled', tag => {
  const r = importOrk(file(`<${tag}><thickness>FILLED</thickness></${tag}>`));
  expect(part(r)['filled']).toBe(true);
});
it('C-F1-2 sibling: untyped parachute line and fillet materials keep density', () => {
  const chute = importOrk(file('<parachute><linematerial density="0.003">Cord</linematerial></parachute>'));
  expect(part(chute)['lineDensity']).toBe(0.003);
  const fins = importOrk(file('<trapezoidfinset><filletmaterial density="1000">Epoxy</filletmaterial></trapezoidfinset>'));
  expect(part(fins)['filletDensity']).toBe(1000);
});
