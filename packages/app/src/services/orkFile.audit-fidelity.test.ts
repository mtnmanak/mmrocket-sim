// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';
import { preservedSimulationExtensions, preserveSimulationExtensions } from './orkExtensions.js';
import { currentXmlParser, parseXml, setXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import * as xmlUtil from './xmlUtil.js';

const tube = '<bodytube><name>Tube</name><length>0.3</length><radius>0.05</radius><thickness>0.001</thickness></bodytube>';
const stage = (parts = tube, extra = '') => `<stage>${extra}<subcomponents>${parts}</subcomponents></stage>`;
const fixture = (parts = tube, extra = '', sims = '') => `<openrocket version="1.10"><rocket><name>Audit</name>${extra}<subcomponents>${stage(parts)}</subcomponents></rocket><simulations>${sims}</simulations></openrocket>`;
const config = (id: string, contents = '') => `<motorconfiguration configid="${id}">${contents}</motorconfiguration>`;
const sim = (id: string, contents: string) => `<simulation><conditions><configid>${id}</configid></conditions>${contents}</simulation>`;
const save = (r: ReturnType<typeof importOrk>) => exportOrk({ ...r, launch: { ...DEFAULT_CONDITIONS, ...r.launch }, configs: r.configs, activeConfigId: r.chosenConfigId });
afterEach(() => vi.restoreAllMocks());

describe('audit 2026-10-11 .ork fidelity and bounds', () => {
  it.each(['stage', 'parallelstage'])('S1a-1 layers a partial separation block for %s and preserves other configurations on save', (kind) => {
    const separation = '<separationevent>never</separationevent><separationdelay>4</separationdelay><separationaltitude>350</separationaltitude>'
      + '<separationconfiguration configid="B"><separationdelay>1</separationdelay></separationconfiguration>';
    const second = `<${kind}>${separation}<subcomponents>${tube}</subcomponents></${kind}>`;
    const xml = kind === 'stage'
      ? fixture(tube, config('A') + config('B')).replace('</stage></subcomponents>', `</stage>${second}</subcomponents>`)
      : fixture(tube + second, config('A') + config('B'));
    const r = importOrk(xml, { configId: 'B' });
    const node = kind === 'stage' ? r.tree.components[1]! : r.tree.components[0]!.children![1]!;
    expect(node).toMatchObject({ separationEvent: 'never', separationDelay: 1, separationAltitude: 350 });
    expect(r.configs[1]!.separations[node.id!]).toEqual({ separationEvent: 'never', separationDelay: 1, separationAltitude: 350 });
    const a = importOrk(save(r), { configId: 'A' });
    const again = kind === 'stage' ? a.tree.components[1]! : a.tree.components[0]!.children![1]!;
    expect(again).toMatchObject({ separationEvent: 'never', separationDelay: 4, separationAltitude: 350 });
  });
  it('S1a-1 snapshots implicit separation defaults before another configuration becomes live', () => {
    const xml = fixture(tube, config('A') + config('B')).replace('</stage></subcomponents>', `</stage>${stage(tube,
      '<separationconfiguration configid="B"><separationevent>never</separationevent><separationdelay>2</separationdelay></separationconfiguration>')}</subcomponents>`);
    const r = importOrk(xml, { configId: 'B' });
    const again = importOrk(save(r), { configId: 'A' });
    expect(again.tree.components[1]!['separationEvent']).toBeUndefined();
    expect(again.tree.components[1]!['separationDelay']).toBeUndefined();
  });

  it.each(['measuredmass', 'measuredcg', 'measuredpadmass'])('S1a-3 reports dropped %s', tag => {
    for (const value of ['0,512', '0', '-1']) {
      const r = importOrk(fixture(tube, config('A') + `<${tag} configid="A">${value}</${tag}>`));
      expect(r.notes.join('\n')).toContain(`invalid <${tag}> value`);
      expect(r.measured).toBeUndefined();
      expect(r.configs[0]?.padMassKg).toBeUndefined();
    }
  });
  it.each(['cd', 'outerradius', 'innerradius'])('S1a-3 reports dropped %s without changing automatic values', tag => {
    const part = tag === 'cd' ? 'parachute' : 'centeringring';
    const r = importOrk(fixture(`<${part}><${tag}>bad</${tag}></${part}>`));
    expect(r.notes.join('\n')).toContain(`invalid <${tag}> value`);
    expect(importOrk(fixture(`<${part}><${tag}>auto</${tag}></${part}>`)).notes.join('\n')).not.toContain(`invalid <${tag}>`);
  });
  it.each(['outerradius', 'innerradius'])('S1a-3 reports an empty %s', tag => {
    expect(importOrk(fixture(`<centeringring><${tag}/></centeringring>`)).notes.join('\n')).toContain(`invalid <${tag}> value`);
  });

  it.each([
    ['bodytube', 'radius', 'outerRadius'], ['nosecone', 'aftradius', 'aftRadius'],
    ['transition', 'foreradius', 'foreRadius'], ['transition', 'aftradius', 'aftRadius'],
  ])('S1a-4 resolves malformed %s %s from a neighbour with a note', (part, tag, prop) => {
    const r = importOrk(fixture(tube + `<${part}><length>0.1</length><${tag}>50.8mm</${tag}></${part}>` + tube));
    expect(r.notes.join('\n')).toContain(`invalid <${tag}> value`);
    expect(r.tree.components[0]!.children![1]![prop]).toBeCloseTo(0.05);
  });
  it('S1a-4 reports malformed packed radius and retains the packed default', () => {
    const r = importOrk(fixture('<parachute><packedradius>bad</packedradius></parachute>'));
    expect(r.notes.join('\n')).toContain('invalid <packedradius> value');
    expect(r.tree.components[0]!.children![0]!['packedRadius']).toBe(0.0125);
  });

  it('S1a-5 refuses a wrapped openrocket root', () => {
    expect(() => importOrk(`<wrapper>${fixture(tube, config('A'), sim('A', '<extension extensionid="x"/>'))}</wrapper>`)).toThrow(/root.*openrocket/i);
  });
  it('S1a-5 refuses mismatched lexical extension ownership before promising retention', () => {
    const sims = Array.from(parseXml(`<simulations>${sim('A', '<extension extensionid="a"/>')}${sim('B', '<extension extensionid="b"/>')}</simulations>`, 'bad fixture').querySelectorAll('simulation'));
    const notes: string[] = [];
    expect(() => preserveSimulationExtensions({ name: 'Audit', components: [] }, [['<extension extensionid="b"/>'], ['<extension extensionid="a"/>']], sims, 'A', true, notes)).toThrow(/extension.*match/i);
    expect(notes.join('\n')).not.toContain('keeps them');
  });
  it('S1a-2 drops an ancestor-dependent namespace at import so saving remains possible', () => {
    const previous = currentXmlParser();
    setXmlParser(jsXmlParser); // happy-dom does not enforce XML namespace bindings.
    try {
      const dependent = '<extension extensionid="dependent"><p:flag/></extension>';
      const independent = '<extension extensionid="independent" xmlns:p="urn:test"><p:flag/></extension>';
      const r = importOrk(fixture(tube, config('A'), sim('A', dependent + independent)).replace('<openrocket ', '<openrocket xmlns:p="urn:test" '));
      expect(r.notes.join('\n')).toMatch(/extension.*not preserved/i);
      expect(preservedSimulationExtensions(r.tree)[0]!.xml).toEqual([independent]);
      expect(save(r)).toContain(independent);
      expect(save(r)).not.toContain(dependent);
    } finally { setXmlParser(previous); }
  });

  it.each([false, true])('S1a-8 merges duplicate ids in input order (reverse=%s)', reverse => {
    const blocks = [config('A', '<name>First</name><stage number="0" active="false"/>'), config('A', '<name>Last</name><stage number="0" active="true"/>')];
    if (reverse) blocks.reverse();
    const r = importOrk(fixture(tube, blocks.join('')));
    expect(r.configs).toHaveLength(1);
    expect(r.configs[0]!.name).toBe(reverse ? 'First' : 'Last');
    expect(Object.values(r.configs[0]!.stageActiveness!)).toEqual([!reverse]);
    expect(r.notes.join('\n')).toMatch(/duplicate.*configuration/i);
    expect(importOrk(save(r)).configs).toHaveLength(1);
  });
  it('S1a-8 retains earlier fields when a duplicate omits them', () => {
    const r = importOrk(fixture(tube, config('A', '<name>First</name><stage number="0" active="false"/>') + config('A')));
    expect(r.configs).toHaveLength(1);
    expect(r.configs[0]!.name).toBe('First');
    expect(Object.values(r.configs[0]!.stageActiveness!)).toEqual([false]);
  });
  it.each([500, 501])('S1a-6 bounds a %s-row wind profile before retaining launch data', count => {
    const rows = Array.from({ length: count }, (_, i) => `<windlevel altitude="${i}" speed="2" direction="0"/>`).join('');
    const r = importOrk(fixture(tube, config('A'), `<simulation><conditions><configid>A</configid><wind model="multilevel" altituderef="agl">${rows}</wind><windmodeltype>multilevel</windmodeltype></conditions></simulation>`));
    if (count === 500) expect(r.launch?.windLevels).toHaveLength(500);
    else {
      expect(r.launch?.windLevels).toBeUndefined();
      expect(r.notes.join('\n')).toMatch(/wind.*500.*not used/i);
    }
  });
  it('S1a-7 refuses excessive XML parts before converting any design numbers', () => {
    const numericReads = vi.spyOn(xmlUtil, 'parseDecimal');
    expect(() => importOrk(fixture(tube.repeat(2000)))).toThrow(/2,001 parts/);
    expect(numericReads.mock.calls.length).toBe(0);
  });
});
