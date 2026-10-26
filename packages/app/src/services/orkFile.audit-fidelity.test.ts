// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportOrk, importOrk } from './orkFile.js';
import { preservedSimulationExtensions, preserveSimulationExtensions } from './orkExtensions.js';
import { currentXmlParser, parseXml, setXmlParser } from './xmlParse.js';
import { jsXmlParser } from './xmlParseJs.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import * as xmlUtil from './xmlUtil.js';
import { importRkt } from './rocksimFile.js';
import { importCdx1 } from './rasaeroFile.js';
import { gzipSync } from 'fflate';

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
    expect(node).toMatchObject({ separationEvent: 'never', separationDelay: 4, separationAltitude: 350 });
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

  describe.each(['self-closing', 'empty', 'whitespace'])('S1a-4 %s radius elements', form => {
    const element = (tag: string) => form === 'self-closing' ? `<${tag}/>`
      : `<${tag}>${form === 'whitespace' ? ' \t\n ' : ''}</${tag}>`;
    it.each([
      ['bodytube', 'radius', 'outerRadius'], ['nosecone', 'aftradius', 'aftRadius'],
      ['transition', 'foreradius', 'foreRadius'], ['transition', 'aftradius', 'aftRadius'],
    ])('resolves %s %s from a neighbour with a note and preserves it on reopen', (part, tag, prop) => {
      const r = importOrk(fixture(tube + `<${part}><length>0.1</length>${element(tag)}</${part}>` + tube));
      expect(r.notes.join('\n')).toContain(`invalid <${tag}> value; using an automatic radius`);
      expect(r.tree.components[0]!.children![1]![prop]).toBeCloseTo(0.05, 12);
      const reopened = importOrk(save(r));
      expect(reopened.tree.components[0]!.children![1]![prop]).toBeCloseTo(0.05, 12);
      expect(reopened.notes.join('\n')).not.toContain(`invalid <${tag}> value`);
    });
    it.each([
      ['parachute', 'packedRadius', 0.0125], ['streamer', 'packedRadius', 0.0125],
      ['shockcord', 'packedRadius', 0.0125], ['masscomponent', 'radius', 0.005],
    ])('keeps the %s packed fallback with a note on import and reopen', (part, prop, fallback) => {
      const packed = `<${part}>${element('packedradius')}</${part}>`;
      const r = importOrk(fixture(tube.replace('</bodytube>', `<subcomponents>${packed}</subcomponents></bodytube>`)));
      expect(r.notes.join('\n')).toContain(`invalid <packedradius> value; using the default (${fallback})`);
      expect(r.tree.components[0]!.children![0]!.children![0]![prop]).toBe(fallback);
      const reopened = importOrk(save(r));
      expect(reopened.tree.components[0]!.children![0]!.children![0]![prop]).toBe(fallback);
      expect(reopened.notes.join('\n')).not.toContain('invalid <packedradius> value');
    });
  });
  it.each([
    ['bodytube', 'radius', 'outerRadius', 0.012], ['nosecone', 'aftradius', 'aftRadius', 0.012],
    ['transition', 'foreradius', 'foreRadius', undefined], ['transition', 'aftradius', 'aftRadius', undefined],
  ])('S1a-4 keeps the absent %s %s fallback without an invalid-value note', (part, tag, prop, fallback) => {
    const r = importOrk(fixture(tube + `<${part}><length>0.1</length></${part}>` + tube));
    expect(r.tree.components[0]!.children![1]![prop]).toBe(fallback);
    expect(r.notes.join('\n')).not.toContain(`invalid <${tag}> value`);
  });
  it.each(['parachute', 'streamer', 'shockcord'])('S1a-4 leaves an absent %s packed radius unset without a note', part => {
    const r = importOrk(fixture(`<${part}/>`));
    expect(r.tree.components[0]!.children![0]!['packedRadius']).toBeUndefined();
    expect(r.notes.join('\n')).not.toContain('invalid <packedradius> value');
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
    try {
      expect(() => importOrk(fixture(tube.repeat(2000)))).toThrow(/more than 2,000 parts/);
      expect(numericReads.mock.calls.length).toBe(0);
    } finally { numericReads.mockRestore(); }
  });
});


describe('lane A audit 2026-10-17 regression guards', () => {
  it.each([['.ork', importOrk], ['.rkt', importRkt], ['.CDX1', importCdx1]] as const)('refuses 1,001 gzip members at the %s importer door', (kind, importer) => {
    const empty = gzipSync(new Uint8Array(0));
    const bytes = new Uint8Array(empty.length * 1001);
    for (let i = 0; i < 1001; i++) bytes.set(empty, i * empty.length);
    expect(() => importer(bytes.buffer)).toThrow(`This compressed ${kind} file has more than 1,000 gzip members`);
  });
  const holes = (count: number) => '<bodytube><radius>0.05</radius><mmrsim-tube-holes>'
    + Array.from({ length: count }, (_, i) => '<hole><name>Hole ' + i + '</name><diameter>bad</diameter></hole>').join('')
    + '</mmrsim-tube-holes></bodytube>';
  it('S1a-1 counts tube holes before any numeric conversion', () => {
    const numericReads = vi.spyOn(xmlUtil, 'parseDecimal');
    try {
      // Stop at the first excess part, before numeric conversion or a full walk.
      expect(() => importOrk(fixture(holes(2001)))).toThrow(/more than 2,000 parts/);
      expect(numericReads).not.toHaveBeenCalled();
    } finally { numericReads.mockRestore(); }
    // One stage + one tube + 1,998 holes is exactly 2,000 design parts.
    expect(importOrk(fixture(holes(1998))).tree.components[0]!.children![0]!.children).toHaveLength(1998);
    expect(() => importOrk(fixture(holes(1999)))).toThrow(/more than 2,000 parts/);
  });
  it('walks direct hole children without descendant queries in counting or conversion', () => {
    const parser = currentXmlParser();
    const queries: string[] = [];
    const spies: { mockRestore(): void }[] = [];
    setXmlParser(xml => {
      const doc = parser(xml);
      const pending = [doc.documentElement];
      while (pending.length) {
        const el = pending.pop()!;
        pending.push(...el.children);
        if (el.tagName !== 'bodytube') continue;
        const query = el.querySelectorAll.bind(el);
        spies.push(vi.spyOn(el, 'querySelectorAll').mockImplementation(selector => {
          if (selector.includes('mmrsim-tube-holes')) queries.push(selector);
          return query(selector);
        }));
      }
      return doc;
    });
    try {
      expect(() => importOrk(fixture(holes(2001)))).toThrow(/more than 2,000 parts/);
      const r = importOrk(fixture(holes(1).replace('</mmrsim-tube-holes>',
        '<junk><hole/></junk></mmrsim-tube-holes>')));
      expect(r.tree.components[0]!.children![0]!.children).toHaveLength(1);
      expect(queries).toEqual([]);
    } finally {
      setXmlParser(parser);
      for (const spy of spies) spy.mockRestore();
    }
  });
  it('S1a-1 and S1a-g2 deduplicate invalid-number notes without linear array scans', () => {
    const scans = [vi.spyOn(Array.prototype, 'includes'), vi.spyOn(Array.prototype, 'indexOf'),
      vi.spyOn(Array.prototype, 'some'), vi.spyOn(Array.prototype, 'find'), vi.spyOn(Array.prototype, 'findIndex')];
    let r: ReturnType<typeof importOrk>;
    let contexts: unknown[][];
    try {
      r = importOrk(fixture('<centeringring><name>Same</name><length>bad</length><outerradius>bad</outerradius></centeringring>'.repeat(40)));
      contexts = scans.map(spy => [...spy.mock.contexts]);
    } finally { for (const spy of scans) spy.mockRestore(); }
    for (const calls of contexts) expect(calls.some(context => context === r.notes)).toBe(false);
    expect(r.notes.filter(note => note.includes('invalid <length>'))).toHaveLength(1);
    expect(r.notes.filter(note => note.includes('invalid <outerradius>'))).toHaveLength(1);
  });
  it.each(['junk 0.02', '0.01 0.02'])('S1a-3 keeps malformed ring radius %s automatic', value => {
    const r = importOrk(fixture('<centeringring><outerradius>' + value + '</outerradius></centeringring>'));
    expect(r.tree.components[0]!.children![0]!['outerRadius']).toBeUndefined();
    expect(r.notes.join('\n')).toContain('invalid <outerradius> value');
    for (const valid of ['0.02']) {
      expect(importOrk(fixture('<centeringring><outerradius>' + valid + '</outerradius></centeringring>'))
        .tree.components[0]!.children![0]!['outerRadius']).toBe(0.02);
    }
  });
  it('S1a-4 round-trips zero surface and line densities without a fallback', () => {
    const parts = '<parachute><material type="surface" density="0">Zero canopy</material>'
      + '<linematerial type="line" density="0">Zero lines</linematerial></parachute>'
      + '<streamer><material type="surface" density="0">Zero streamer</material></streamer>'
      + '<shockcord><material type="line" density="0">Zero cord</material></shockcord>';
    const first = importOrk(fixture(parts));
    for (const r of [first, importOrk(save(first))]) {
      const nodes = r.tree.components[0]!.children!;
      expect(nodes[0]).toMatchObject({ surfaceDensity: 0, lineDensity: 0 });
      expect(nodes[1]).toMatchObject({ surfaceDensity: 0 });
      expect(nodes[2]).toMatchObject({ lineDensity: 0 });
    }
    for (const value of ['-1', 'NaN', 'Infinity']) {
      expect(importOrk(fixture('<shockcord><material type="line" density="' + value + '">Bad</material></shockcord>'))
        .tree.components[0]!.children![0]!['lineDensity']).toBeUndefined();
    }
  });
  it.each(['junk 0.02', '0.01 0.02'])('packs children using the same automatic ring grammar for %s', value => {
    const children = '<subcomponents><parachute><packedradius>auto</packedradius></parachute></subcomponents>';
    for (const tag of ['tubecoupler', 'engineblock', 'centeringring', 'bulkhead']) {
      const ring = (radius: string) => `<${tag}><outerradius>${radius}</outerradius><innerradius>${radius}</innerradius>`
        + `<thickness>0.001</thickness>${children}</${tag}>`;
      const read = (radius: string) => importOrk(fixture(tube.replace('</bodytube>',
        `<subcomponents>${ring(radius)}</subcomponents></bodytube>`))).tree.components[0]!.children![0]!.children![0]!.children![0]!;
      expect(read(value)['packedRadius']).toEqual(read('auto')['packedRadius']);
      expect(read(value)['packedRadius']).not.toEqual(read('0.02')['packedRadius']);
    }
  });
  it('S1a-g2 refuses excessive simulations before conversion and accepts the boundary', () => {
    const numericReads = vi.spyOn(xmlUtil, 'parseDecimal');
    try {
      expect(() => importOrk(fixture(tube, '', '<simulation/>'.repeat(1001)))).toThrow(/1,001 simulations.*1,000/);
      expect(numericReads).not.toHaveBeenCalled();
    } finally { numericReads.mockRestore(); }
    expect(() => importOrk(fixture(tube, '', '<simulation/>'.repeat(1000)))).not.toThrow();
  });
  it('S1a-g3 drops unused stored wind data and its duplicate selector-shaped caution', () => {
    const r = importOrk(fixture(tube, '', '<simulation><conditions><wind><speed>bad</speed></wind></conditions>'
      + '<aeromodel>classic</aeromodel><flightdata maxaltitude="123"/></simulation>'));
    expect(r.storedSimulations).toHaveLength(1);
    expect(r.storedSimulations![0]).not.toHaveProperty('windAverage');
    expect(r.notes.join('\n')).not.toContain('<wind > speed>');
  });
});
