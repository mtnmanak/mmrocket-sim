// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { importOrk, exportOrk } from './orkFile.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { noteField, noteText } from './noteField.js';
import { parseDesignFile, designFileOpenFailure } from './designFile.js';
import { importRkt } from './rocksimFile.js';
import { MAX_STORED_WARNINGS } from './storedWarnings.js';
import { currentXmlParser, setXmlParser, XmlBudgetExceededError } from './xmlParse.js';
import { createJsXmlParser } from './xmlParseJs.js';
import { openHeadlessDesign } from './simulateFile.js';
import { InflatedFileTooLargeError } from './zipMember.js';

const file = (parts: string, stageTags = '', creator = 'OpenRocket') => `<openrocket version="1.10" creator="${creator}"><rocket><motorconfiguration configid="a" default="true"><name>Flight</name></motorconfiguration><subcomponents><stage>${stageTags}<subcomponents>${parts}</subcomponents></stage></subcomponents></rocket></openrocket>`;
const part = (r: ReturnType<typeof importOrk>) => r.tree.components[0]!.children![0]!;
const save = (r: ReturnType<typeof importOrk>, notes: string[] = []) => exportOrk({ ...r, launch: DEFAULT_CONDITIONS, activeConfigId: r.chosenConfigId, notes });

it.each(['freeformfinset', 'trapezoidfinset', 'ellipticalfinset'])('r4 S1a-b2 trims relative methods in %s', tag => {
  const geometry = tag === 'freeformfinset' ? '<finpoints><point x="0" y="0"/><point x="0.02" y="0.03"/><point x="0.05" y="0"/></finpoints>' : '<rootchord>0.05</rootchord>';
  for (const method of ['top', 'middle', 'bottom', 'front', 'center', 'end']) {
    const r = importOrk(file(`<${tag}>${geometry}<tabheight>0.01</tabheight><tablength>0.02</tablength><tabposition relativeto=" ${method} ">0.01</tabposition></${tag}>`));
    expect(part(r)['tabOffset']).toBeCloseTo(0.01, 10);
    const expectedMethod = ['top', 'front'].includes(method) ? 'top' : ['bottom', 'end'].includes(method) ? 'bottom' : 'middle';
    expect(part(r)['tabOffsetMethod']).toBe(expectedMethod);
    expect(part(importOrk(save(r)))['tabOffsetMethod']).toBe(expectedMethod);
    expect(part(importOrk(save(r)))['tabOffset']).toBeCloseTo(0.01, 10);
    expect(r.notes.join('\n')).not.toContain('unsupported relative method');
  }
});

it('r5 S1a-b2 names each fin set whose relative-method setter was ignored', () => {
  const r = importOrk(file(['First&#10;fin', 'Second&#x202e;fin'].map(name => `<freeformfinset><name>${name}</name><tabheight>0.01</tabheight><tablength>0.02</tablength><tabposition relativeto="unknown">0.01</tabposition></freeformfinset>`).join('')));
  const notes = r.notes.filter(n => n.includes('unsupported relative method'));
  expect(notes).toHaveLength(2);
  expect(notes[0]).toContain(noteField('First\nfin'));
  expect(notes[1]).toContain(noteField('Second\u202efin'));
});

it.each([new XmlBudgetExceededError('XML element limit exceeded'), new InflatedFileTooLargeError(16, 'XML too large')])('r5 S1d-2 labels a misnamed RockSim budget refusal for browser Open (%s)', async refusal => {
  const previous = currentXmlParser();
  setXmlParser(() => { throw refusal; });
  try {
    const data = new TextEncoder().encode('<RockSimDocument><x/></RockSimDocument>');
    const err = await parseDesignFile(data.buffer, 'broken.ork', { presets: [] }).catch((e: unknown) => e);
    expect(err).toBe(refusal);
    expect(designFileOpenFailure('broken.ork', err)).toContain('.rkt file');
    await expect(openHeadlessDesign(data, 'broken.ork', { presets: [], network: 'forbid', maxInflatedBytes: 16 })).rejects.toBe(refusal);
  } finally { setXmlParser(previous); }
});

it.each(['freeformfinset', 'trapezoidfinset', 'ellipticalfinset'])('r3 S1a-b2 keeps the centered default for unreadable first setters in %s', tag => {
  for (const setters of ['<tabposition relativeto="middle">x</tabposition>', '<tabposition relativeto="top">x</tabposition>', '<tabposition relativeto="front">x</tabposition><tabposition relativeto="top">x</tabposition>']) {
    const geometry = tag === 'freeformfinset' ? '<finpoints><point x="0" y="0"/><point x="0.02" y="0.03"/><point x="0.05" y="0"/></finpoints>' : '<rootchord>0.05</rootchord>';
    const r = importOrk(file(`<${tag}>${geometry}<tabheight>0.01</tabheight><tablength>0.02</tablength>${setters}</${tag}>`));
    const expected = setters.includes('middle') ? 0 : 0.015;
    expect(part(r)['tabOffset']).toBeCloseTo(expected, 10);
    expect(part(importOrk(save(r)))['tabOffset']).toBeCloseTo(expected, 10);
  }
});

it.each([['openrocket', 'rkt'], ['RockSimDocument', 'cdx1'], ['RASAeroDocument', 'ork']])('r3 S1d-2 preserves structural budget errors for misnamed %s content', async (root, extension) => {
  const previous = currentXmlParser();
  setXmlParser(createJsXmlParser({ maxElements: 2, maxDepth: 2 }));
  try {
    const data = new TextEncoder().encode(`<${root}><x><x/></x></${root}>`);
    await expect(parseDesignFile(data.buffer, `structure.${extension}`, { presets: [] })).rejects.toBeInstanceOf(XmlBudgetExceededError);
    const err = await parseDesignFile(data.buffer, `structure.${extension}`, { presets: [] }).catch((e: unknown) => e);
    expect(designFileOpenFailure(`structure.${extension}`, err)).toContain(`.${root === 'openrocket' ? 'ork' : root === 'RockSimDocument' ? 'rkt' : 'CDX1'} file`);
    await expect(openHeadlessDesign(data, `structure.${extension}`, { presets: [], network: 'forbid' })).rejects.toBeInstanceOf(XmlBudgetExceededError);
  } finally { setXmlParser(previous); }
});

it('r3 S1a-b1 describes retained inherited deployment, separation and ignition numbers accurately', () => {
  const r = importOrk(file('<parachute><deployaltitude>500</deployaltitude><deploydelay>3</deploydelay><deploymentconfiguration configid="a"><deployaltitude>x</deployaltitude><deploydelay>x</deploydelay></deploymentconfiguration></parachute><bodytube><motormount><ignitiondelay>2</ignitiondelay><motor configid="a"><delay>4</delay></motor><ignitionconfiguration configid="a"><ignitiondelay>x</ignitiondelay></ignitionconfiguration></motormount></bodytube>')
    .replace('</subcomponents></rocket>', '<stage><separationdelay>2</separationdelay><separationaltitude>600</separationaltitude><separationconfiguration configid="a"><separationdelay>x</separationdelay><separationaltitude>x</separationaltitude></separationconfiguration><subcomponents><bodytube/></subcomponents></stage></subcomponents></rocket>'));
  for (const tag of ['deployaltitude', 'deploydelay', 'separationdelay', 'separationaltitude', 'ignitiondelay']) {
    const notes = r.notes.filter(n => n.includes(`invalid <${tag}>`));
    expect(notes.length).toBeGreaterThan(0);
    for (const note of notes) {
      expect(note).toContain('keeping the previous or default value');
      expect(note).not.toContain('using the default');
    }
  }
  expect(r.notes.find(n => n.includes('invalid <deployaltitude>'))).toContain('500 m');
});

it.each(['surface', 'line'])('S1a-1 rejects %s fillet materials including freeform fins', type => {
  for (const tag of ['freeformfinset', 'trapezoidfinset', 'ellipticalfinset']) {
    const r = importOrk(file(`<${tag}><filletmaterial type="${type}" density="0.05">Fabric</filletmaterial></${tag}>`));
    expect(part(r)['filletDensity']).toBeUndefined();
    expect(part(r)['filletMaterialName']).toBeUndefined();
    expect(r.notes.join(' ')).toContain('fillet material type');
  }
});
it('S1a-2 treats historical creators consistently for launch defaults', () => {
  const xml = file('<bodytube/>', '', 'Online OpenRocket').replace('</openrocket>', '<simulations><simulation><conditions><configid>a</configid><timestep>0.02</timestep></conditions></simulation></simulations></openrocket>');
  const r = importOrk(xml);
  expect(r.launch?.timeStepS).toBe(0.02);
  expect(r.launch?.geodeticMethod).toBe('spherical');
});
it('S1a-3 sanitizes hostile extension identifiers in cautions', () => {
  const xml = file('<bodytube/>').replace('</openrocket>', '<simulations><simulation><extension extensionid="x&#10;FORGED&#x202e;"/></simulation></simulations></openrocket>');
  const note = importOrk(xml).notes.find(n => n.includes('FORGED'))!;
  expect(note).toBeDefined();
  expect(note).not.toMatch(/[\n\u202e]/u);
  expect(note).toContain('[U+202E]');
});
it('S1a-4 describes malformed motor dimensions as unconstrained', () => {
  const r = importOrk(file('<bodytube><motormount><motor configid="a"><diameter>x</diameter><length>x</length><delay>4</delay></motor></motormount></bodytube>'));
  expect(r.notes.join(' ')).toContain('does not restrict the motor match');
  expect(r.notes.join(' ')).toContain('Check the matched motor before flying');
  expect(r.notes.join(' ')).not.toContain('default (0 mm');
});
it('S1a-5 does not claim desktop parity for unsupported AFTER positioning', () => {
  const r = importOrk(file('<freeformfinset><axialoffset method="after">0.1</axialoffset></freeformfinset>'));
  expect(r.notes.join(' ')).not.toContain('as in desktop OR');
  expect(r.notes.join(' ')).toContain('unsupported');
});
it('S1a-6 reports repeated unknown bare/block separation events once', () => {
  const r = importOrk(file('<bodytube/>').replace('</subcomponents></rocket>', '<stage><separationevent>foo</separationevent><separationconfiguration configid="a"><separationevent>foo</separationevent></separationconfiguration><subcomponents><bodytube/></subcomponents></stage></subcomponents></rocket>'));
  expect(r.notes.filter(n => n.includes('unknown separation event'))).toHaveLength(1);
});
it.each([1, MAX_STORED_WARNINGS + 1])('S1a-7 does not claim any warning was kept for a marker-only array (%i)', count => {
  const xml = file('<bodytube/>').replace('</openrocket>', '<simulations><simulation><conditions><configid>a</configid></conditions><aeromodel>classic</aeromodel><flightdata maxaltitude="123"/><simwarnings version="1">[null]</simwarnings></simulation></simulations></openrocket>');
  expect(importOrk(xml.replace('[null]', JSON.stringify(Array.from({ length: count }, () => null)))).notes.join(' ')).toContain('No warnings could be read.');
});
it('S1a-b1 preserves nondefault inherited numeric settings on malformed overrides', () => {
  const r = importOrk(file('<parachute><deployevent>altitude</deployevent><deployaltitude>500</deployaltitude><deploydelay>3</deploydelay><deploymentconfiguration configid="a"><deployaltitude>x</deployaltitude><deploydelay>x</deploydelay></deploymentconfiguration></parachute>', '<separationdelay>2</separationdelay><separationaltitude>600</separationaltitude><separationconfiguration configid="a"><separationdelay>x</separationdelay><separationaltitude>x</separationaltitude></separationconfiguration>'));
  expect(r.configs[0]!.deployments).toEqual({});
  expect(r.configs[0]!.separations).toEqual({});
  expect(r.notes.join(' ')).not.toContain('overrides the deployment');
  const stages = importOrk(file('<bodytube/>').replace('</subcomponents></rocket>', '<stage><separationdelay>2</separationdelay><separationaltitude>600</separationaltitude><separationconfiguration configid="a"><separationdelay>x</separationdelay><separationaltitude>x</separationaltitude></separationconfiguration><subcomponents><bodytube/></subcomponents></stage></subcomponents></rocket>'));
  expect(stages.tree.components[1]).toMatchObject({ separationDelay: 2, separationAltitude: 600 });
  expect(stages.configs[0]!.separations).toEqual({});
  expect(importOrk(save(stages)).tree.components[1]).toMatchObject({ separationDelay: 2, separationAltitude: 600 });
});
it.each(['top', 'front'])('S1a-b2 retains earlier valid tab offsets (%s)', rel => {
  const r = importOrk(file(`<freeformfinset><tabheight>0.01</tabheight><tablength>0.02</tablength><tabposition relativeto="${rel}">0.01</tabposition><tabposition relativeto="top">x</tabposition></freeformfinset>`));
  expect(part(r)['tabOffset']).toBeCloseTo(0.01);
  expect(part(importOrk(save(r)))['tabOffset']).toBeCloseTo(0.01);
});
it('S1a-b1 sibling: malformed ignition delay keeps the inherited mount delay', () => {
  const r = importOrk(file('<bodytube><motormount><ignitiondelay>2</ignitiondelay><motor configid="a"><delay>4</delay></motor><ignitionconfiguration configid="a"><ignitiondelay>x</ignitiondelay></ignitionconfiguration></motormount></bodytube>'));
  expect(Object.values(r.motors)[0]!.ignitionDelay).toBe(2);
  expect(r.configs[0]!.ignitions).toBeUndefined();
});
it.each(['constructor', '__proto__'])('S1a-g1 does not export inherited ignition keys (%s)', id => {
  const r = importOrk(file('<bodytube><motormount/></bodytube>'));
  part(r).id = id;
  part(r).motorMount = true;
  r.configs[0]!.ignitions = {};
  expect(save(r)).not.toContain('mmrignitions');
});
it('S1a-3 sanitizes RockSim recovery and Pro-condition summaries', () => {
  const raw = '<RockSimDocument><DesignInformation><RocketDesign><StageCount>1</StageCount><Stage3Parts><Parachute><Name>C&#10;FORGED&#x202e;</Name><SerialNo>7</SerialNo><Dia>500</Dia></Parachute></Stage3Parts><SimulationEventList><SimulationEvent><PartSerialNo>7</PartSerialNo><Type>4</Type><ProEvent>1</ProEvent></SimulationEvent></SimulationEventList></RocketDesign></DesignInformation><SimulationResultsList><SimulationResults><SimulationName>Flight</SimulationName></SimulationResults></SimulationResultsList></RockSimDocument>';
  const r = importRkt(raw.replace('<Stage3Parts>', '<Stage3Parts><BodyTube><OD>50</OD><Len>300</Len><AttachedParts>').replace('</Stage3Parts>', '</AttachedParts></BodyTube></Stage3Parts>'));
  const pro = r.notes.find(n => n.includes('RockSim Pro conditions'))!;
  expect(pro).toBeDefined();
  expect(pro).not.toMatch(/[\n\u202e]/u);
  const flown = importRkt(raw.replace('<Stage3Parts>', '<Stage3Parts><BodyTube><SerialNo>8</SerialNo><IsMotorMount>1</IsMotorMount><OD>50</OD><Len>300</Len><AttachedParts>').replace('</Stage3Parts>', '</AttachedParts></BodyTube></Stage3Parts>')
    .replace('</SimulationName>', '</SimulationName><Stage3Engines><EngineSet><EngineCode>Missing-H5a</EngineCode><MountSerialNo>8</MountSerialNo><EjectionDelay>4</EjectionDelay></EngineSet></Stage3Engines>'));
  const summary = Object.values(flown.configNotes!).flat().find(n => n.includes(' recovery:'))!;
  expect(summary).toBeDefined();
  expect(summary).not.toMatch(/[\n\u202e]/u);
});
it('S1a-g3 reports a total for materials emptied by pipe replacement', () => {
  const r = importOrk(file('<bodytube/>'));
  r.tree.documentMaterials = ['|', '||'].map(name => ({ kind: 'bulk', name, density: 900 }));
  const notes: string[] = [];
  save(r, notes);
  expect(notes.filter(n => n.includes('Document materials:'))).toHaveLength(1);
  expect(notes.join(' ')).toContain('2 entries removed because replacing pipes with spaces emptied their names');
});
it.each(['\u034f', '\ufe0f', '\u{e0100}', '\u180b', '\u180f', '\u115f', '\u1160', '\u3164', '\uffa0'])('S1d-1 marks ASCII camouflage %s', ch => {
  expect(noteText(`C${ch}6`)).toContain('[U+');
  expect(noteText('❤\ufe0f')).toBe('❤\ufe0f');
  expect(noteText('👩\u200d🚀')).toBe('👩\u200d🚀');
});
it('S1d-1 marks mixed invisible runs while preserving emoji selectors and joiners', () => {
  expect(noteText('C\u200d\u034f6')).toBe('C[U+200D][U+034F]6');
  expect(noteText('C\u034f\u200d6')).toBe('C[U+034F][U+200D]6');
  expect(noteText('👩\ufe0f\u200d🚀')).toBe('👩\ufe0f\u200d🚀');
});
it.each(['\u034f', '\ufe0f', '\u{e0100}'])('S1d-1 marks field edges and quoted ASCII camouflage %s', ch => {
  const shown = `[U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`;
  expect(noteField(`C6${ch}`)).toBe(`C6${shown}`);
  expect(noteField(`${ch}C6`)).toBe(`${shown}C6`);
  expect(noteText(`\u201cC6${ch}\u201d`)).toBe(`\u201cC6${shown}\u201d`);
  expect(noteText(`\u201c${ch}C6\u201d`)).toBe(`\u201c${shown}C6\u201d`);
  expect(noteField('\u2764\ufe0f')).toBe('\u2764\ufe0f');
});
it.each(['top', 'bottom'])('S1a-b2 converts retained center offsets to %s on an invalid number', method => {
  const r = importOrk(file(`<freeformfinset><finpoints><point x="0" y="0"/><point x="0.02" y="0.03"/><point x="0.05" y="0"/></finpoints><tabheight>0.01</tabheight><tablength>0.02</tablength><tabposition relativeto="center">0.01</tabposition><tabposition relativeto="${method}">x</tabposition></freeformfinset>`));
  expect(part(r)['tabOffsetMethod']).toBe(method);
  expect(part(r)['tabOffset']).toBeCloseTo(method === 'top' ? 0.025 : -0.005);
  expect(part(importOrk(save(r)))['tabOffset']).toBeCloseTo(method === 'top' ? 0.025 : -0.005);
});
it.each(['', ' relativeto="bogus"'])('S1a-b2 ignores tab setters without a recognized method (%s)', attr => {
  const r = importOrk(file(`<freeformfinset><tabheight>0.01</tabheight><tablength>0.02</tablength><tabposition relativeto="top">0.01</tabposition><tabposition${attr}>0.03</tabposition></freeformfinset>`));
  expect(part(r)['tabOffsetMethod']).toBe('top');
  expect(part(r)['tabOffset']).toBeCloseTo(0.01);
});
it('S1d-2 labels failures by content when it disagrees with the extension', async () => {
  try {
    await parseDesignFile(new TextEncoder().encode('<RockSimDocument/>').buffer, 'broken.ork', { presets: [] });
    expect.fail('reader should refuse this document');
  } catch (err) {
    expect(designFileOpenFailure('broken.ork', err)).toMatch(/^Could not open that \.rkt file:/);
  }
});
