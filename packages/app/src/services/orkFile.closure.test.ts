// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';
import { extensionXmlBySimulation } from './orkExtensions.js';

const fixture = (parts: string, before = '', after = '') => `<openrocket>${before}<rocket><name>REAL</name><subcomponents><stage><subcomponents>${parts}</subcomponents></stage></subcomponents></rocket>${after}</openrocket>`;
const partsOf = (xml: string) => importOrk(xml).tree.components[0]!.children!;

// Desktop DoubleSetter.set uses equalsIgnoreCase for the special value (24.12:130,160).
it.each(['AUTO', 'AUTO 0.05'])('keeps desktop case-insensitive automatic radius %s and packing', radius => {
  const r = importOrk(fixture(`<nosecone><aftradius>0.02</aftradius></nosecone><bodytube><radius>${radius}</radius><subcomponents><parachute><packedradius>auto</packedradius></parachute></subcomponents></bodytube>`));
  const tube = r.tree.components[0]!.children![1]!;
  const expected = radius === 'AUTO' ? 0.02 : 0.05;
  expect(tube['outerRadius']).toBeCloseTo(expected, 12);
  expect(tube.children![0]!['packedRadius']).toBeCloseTo(expected - 0.002, 12);
  expect(r.notes.join(' ')).not.toContain('invalid <radius> value');
});

it.each(['parachute', 'streamer', 'centeringring', 'bulkhead', 'tubecoupler', 'engineblock'])('keeps desktop uppercase AUTO for %s', type => {
  const tag = ['parachute', 'streamer'].includes(type) ? 'cd' : 'outerradius';
  expect(importOrk(fixture(`<${type}><${tag}>AUTO</${tag}></${type}>`)).notes.join(' ')).not.toContain(`invalid <${tag}> value`);
});

it.each(['auto junk', 'auto 0.2'])('reports malformed automatic recovery Cd: %s', cd => {
  const r = importOrk(fixture(`<bodytube><subcomponents><parachute><cd>${cd}</cd></parachute></subcomponents></bodytube>`));
  expect(r.notes.join(' ')).toContain('invalid <cd> value');
});

it.each([
  ['trapezoidfinset', '<filletradius>0.006</filletradius><filletmaterial type="bulk" density="1200junk">Epoxy</filletmaterial>', 'filletmaterial density'],
  ['podset', '<radiusoffset method="free">0.05junk</radiusoffset>', 'radiusoffset'],
  ['parallelstage', '<angleoffset>45junk</angleoffset>', 'angleoffset'],
  ['boosterset', '<angleoffset>45junk</angleoffset>', 'angleoffset'],
  ['freeformfinset', '<tabheight>0.01</tabheight><tablength>0.02</tablength><tabposition relativeto="front">0.01junk</tabposition>', 'tabposition'],
])('reports malformed sibling numbers: %s %s', (type, values, tag) => {
  expect(importOrk(fixture(`<${type}>${values}</${type}>`)).notes.join('\n')).toContain(`invalid <${tag}> value`);
});

it.each(['bodytube', 'innertube'])('packed radius uses the same malformed %s dimensions as its node', type => {
  const sizes = type === 'bodytube' ? '<radius>0.05</radius><thickness>junk 0.01</thickness>'
    : '<outerradius>junk 0.02</outerradius><thickness>0.0005</thickness>';
  const node = partsOf(fixture(`<${type}>${sizes}<subcomponents><parachute><packedradius>auto</packedradius></parachute></subcomponents></${type}>`))[0]!;
  expect(node.children![0]!['packedRadius']).toBeCloseTo((node['outerRadius'] as number) - (node['thickness'] as number), 12);
});

it.each(['junk 0.02', '0.03 0.02'])('keeps desktop two-token radius and packing: %s', radius => {
  const r = importOrk(fixture(`<bodytube><radius>${radius}</radius><subcomponents><parachute><packedradius>auto</packedradius></parachute></subcomponents></bodytube>`));
  const tube = r.tree.components[0]!.children![0]!;
  expect(tube['outerRadius']).toBeCloseTo(0.02, 12);
  expect(tube.children![0]!['packedRadius']).toBeCloseTo(0.018, 12);
  expect(r.notes.join('\n')).not.toContain('invalid <radius>');
});

it.each(['auto junk'])('reports a malformed automatic radius: %s', radius => {
  const r = importOrk(fixture(`<bodytube><radius>0.05</radius></bodytube><bodytube><radius>${radius}</radius></bodytube>`));
  expect(r.tree.components[0]!.children![1]!['outerRadius']).toBeCloseTo(0.05, 12);
  expect(r.notes.join('\n')).toContain('invalid <radius>');
});

it.each(['auto 0.02', 'AUTO'])('uses desktop tube-fin radius grammar: %s', radius => {
  const r = importOrk(fixture(`<tubefinset><radius>${radius}</radius></tubefinset>`));
  expect(r.tree.components[0]!.children![0]!['outerRadius']).toBeUndefined();
  expect(r.notes.some(note => note.includes('invalid <radius>'))).toBe(radius !== 'AUTO');
});

it('keeps desktop constructor dimensions when native tags are absent', () => {
  const nodes = partsOf(fixture('<bodytube/><launchlug/><tubecoupler/><engineblock/>'));
  expect(nodes[0]).toMatchObject({ length: 0.2, thickness: 0.002 });
  expect(nodes[1]).toMatchObject({ length: 0.03, outerRadius: 0.005, thickness: 0.001 });
  expect(nodes[2]).toMatchObject({ length: 0.06, thickness: 0 });
  expect(nodes[3]).toMatchObject({ thickness: 0 });
});

it.each(['<winddirection>junk</winddirection>', '<wind model="average"><direction>junk</direction></wind>'])('discloses malformed wind direction: %s', direction => {
  const r = importOrk(fixture('<bodytube/>', '', `<simulations><simulation><conditions><launchintowind>false</launchintowind><launchroddirection>90</launchroddirection>${direction}</conditions></simulation></simulations>`));
  expect(r.notes.join('\n')).toMatch(/invalid <(winddirection|direction)>/);
  expect(r.launch?.launchRodAimDeg).toBeCloseTo(0, 12);
});

it.each(['centeringring', 'bulkhead', 'tubecoupler', 'engineblock'])('refuses auto-number ring grammar for %s', type => {
  for (const tag of ['outerradius', 'innerradius']) {
    const r = importOrk(fixture(`<${type}><${tag}>auto 0.02</${tag}></${type}>`));
    expect(r.tree.components[0]!.children![0]![tag === 'outerradius' ? 'outerRadius' : 'innerRadius']).toBeUndefined();
    expect(r.notes.join('\n')).toContain(`invalid <${tag}> value`);
  }
});

it.each(['unknownblock', 'simulations'])('ignores nested rocket payload under %s', wrapper => {
  const payload = `<${wrapper}><openrocket><rocket><name>EVIL</name></rocket></openrocket></${wrapper}>`;
  expect(importOrk(fixture('<bodytube/>', payload)).name).toBe('REAL');
  expect(() => importOrk(`<openrocket>${payload}</openrocket>`)).toThrow(/missing <rocket>/);
});

it('reads only the first root simulations block in both readers', () => {
  const block = (id: string) => `<simulations><simulation><conditions><configid>${id}</configid></conditions><extension extensionid="${id}"/></simulation></simulations>`;
  const xml = fixture('<bodytube/>', '', block('A') + block('B'));
  expect(extensionXmlBySimulation(xml)).toEqual([['<extension extensionid="A"/>']]);
  const r = importOrk(xml);
  expect(r.tree).toMatchObject({ orkSimulationExtensions: [{ configId: 'A', xml: ['<extension extensionid="A"/>'] }] });
});

it('uses the desktop 2 mm body-tube wall when the tag is absent', () => {
  const node = partsOf(fixture('<bodytube><radius>0.05</radius></bodytube>'))[0]!;
  expect(node['thickness']).toBe(0.002);
});

it.each(['tubefinset', 'engineblock'])('saves the inherited/default %s wall unchanged', type => {
  const r = importOrk(fixture('<bodytube><radius>0.05</radius><thickness>0.002</thickness><subcomponents><tubefinset/><engineblock/></subcomponents></bodytube>'));
  delete r.tree.components[0]!.children![0]!.children![1]!['thickness'];
  const reopened = importOrk(exportOrk({ name: r.name, tree: r.tree }));
  const [fin, block] = reopened.tree.components[0]!.children![0]!.children!;
  expect((type === 'tubefinset' ? fin : block)!['thickness']).toBe(type === 'tubefinset' ? 0.002 : 0.00095);
});

it('names the consequence of a zero bulk density that the protected bridge cannot fly', () => {
  const r = importOrk(fixture('<bodytube><material type="bulk" density="0">Zero</material></bodytube>'));
  expect(r.notes.join('\n')).toMatch(/zero bulk density.*680.*mass/i);
});

it.each(['podset', 'parallelstage', 'boosterset', 'parachute', 'streamer', 'shockcord', 'masscomponent', 'fairing', 'protuberance'])('does not claim bulk mass substitution on %s', type => {
  const r = importOrk(fixture(`<${type}><material type="bulk" density="0">Unused</material></${type}>`));
  expect(r.noteTiers?.filter(note => note.kind === 'I21.zero-bulk-density')).toEqual([]);
});

it('discloses zero-density fillets as an engine limit rather than malformed XML', () => {
  const r = importOrk(fixture('<trapezoidfinset><filletradius>0.006</filletradius><filletmaterial type="bulk" density="0">Zero</filletmaterial></trapezoidfinset>'));
  expect(r.notes.join('\n')).toMatch(/zero bulk density.*680.*mass/i);
  expect(r.notes.join('\n')).not.toMatch(/invalid.*density/);
});

it.each([['bodytube', 0], ['bodytube', 0.1], ['trapezoidfinset', 0], ['trapezoidfinset', 0.1]])('does not warn about zero density when %s mass is overridden to %s kg', (type, mass) => {
  const r = importOrk(fixture(`<${type}><overridemass>${mass}</overridemass><material type="bulk" density="0">Zero</material><filletradius>0.006</filletradius><filletmaterial type="bulk" density="0">Zero</filletmaterial></${type}>`));
  expect(r.noteTiers?.filter(note => note.kind === 'I21.zero-bulk-density')).toEqual([]);
});

it('does not warn about a zero-density fillet with zero radius', () => {
  const r = importOrk(fixture('<trapezoidfinset><filletradius>0</filletradius><filletmaterial type="bulk" density="0">Zero</filletmaterial></trapezoidfinset>'));
  expect(r.noteTiers?.filter(note => note.kind === 'I21.zero-bulk-density')).toEqual([]);
  expect(r.notes.join('\n')).not.toContain('invalid <filletmaterial density>');
});
