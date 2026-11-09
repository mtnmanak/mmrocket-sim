// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { exportCdx1, importCdx1 } from './rasaeroFile.js';
import { checkFormatLoss } from './formatLoss.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { explanationFor } from './noteExplanations.js';

const tube = '<BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube>';
const design = (parts: string, extra = '') => `<RASAeroDocument><RocketDesign>${parts}</RocketDesign>${extra}</RASAeroDocument>`;
const nodes = (ns: ComponentNode[]): ComponentNode[] => ns.flatMap(n => [n, ...nodes(n.children ?? [])]);
const fin = (section: string) => `<Fin><Chord>4</Chord><TipChord>2</TipChord><Span>2</Span><AirfoilSection>${section}</AirfoilSection></Fin>`;

describe('N6 RASAero import regressions', () => {
  it('C-F4-3 already applies finish to every generated exterior part', () => {
    const r = importCdx1(design(tube
      + '<FinCan><Length>4</Length><Diameter>3.2</Diameter><ShoulderLength>1</ShoulderLength><InsideDiameter>3</InsideDiameter></FinCan>'
      + '<Booster><Length>10</Length><Diameter>4</Diameter><ShoulderLength>2</ShoulderLength><InsideDiameter>3.2</InsideDiameter><BoattailLength>2</BoattailLength><BoattailRearDiameter>3</BoattailRearDiameter></Booster>'
      + '<Surface>Polished</Surface>'));
    const shoulders = nodes(r.tree.components).filter(n => /shoulder|boat tail/.test(n.name ?? ''));
    expect(shoulders).toHaveLength(3);
    expect(shoulders.every(n => n['finish'] === 'finishpolished')).toBe(true);
  });

  it.each(['rounded', 'ROUNDED', 'subsonic naca', 'SUBSONIC NACA', 'square', 'DOUBLE WEDGE'])(
  'C-F4-5 matches section %s without case sensitivity', section => {
    const r = importCdx1(design(tube.replace('</BodyTube>', fin(section) + '</BodyTube>')));
    const f = nodes(r.tree.components).find(n => n.type === 'trapezoidfinset')!;
    const expected = section.toLowerCase() === 'rounded' ? 'rounded' : section.toLowerCase() === 'square' ? 'square' : 'airfoil';
    expect(f['crossSection'] ?? 'square').toBe(expected);
    expect(r.notes.join(' ')).not.toContain('Unknown RASAero fin section');
  });

  it.each(['Odd &amp; custom&#10;section&#x202e;', '__proto__'])('C-F4-5 names an unknown section safely and uses airfoil: %s', section => {
    const r = importCdx1(design(tube.replace('</BodyTube>', fin(section) + '</BodyTube>')));
    expect(nodes(r.tree.components).find(n => n.type === 'trapezoidfinset')!['crossSection']).toBe('airfoil');
    const note = r.noteTiers?.find(n => n.kind === 'I04.fin-section');
    expect(note?.tier).toBe('caution');
    expect(note?.text).toContain('Unknown RASAero fin section');
    expect(note?.text).not.toMatch(/[\n\u202e]/u);
    expect(note?.text).toContain('check the fin cross-section');
    expect(note?.text).toContain('imported as Airfoil (pointed)');
    expect(explanationFor('I04.fin-section').meaning).toContain('section named in the note');
  });

  it.each(['', '<AirfoilSection></AirfoilSection>'])('keeps the square default without a section: %s', section => {
    const r = importCdx1(design(tube.replace('</BodyTube>', fin('').replace('<AirfoilSection></AirfoilSection>', section) + '</BodyTube>')));
    expect(nodes(r.tree.components).find(n => n.type === 'trapezoidfinset')!['crossSection'] ?? 'square').toBe('square');
    expect(r.notes.join(' ')).not.toContain('Unknown RASAero fin section');
  });

  it('matches nose shapes and global finishes without case sensitivity', () => {
    const r = importCdx1(design('<NoseCone><Length>6</Length><Diameter>3</Diameter><Shape>eLLIPTICAL</Shape></NoseCone>' + tube + '<Surface>pOLISHED</Surface>'));
    expect(nodes(r.tree.components).find(n => n.type === 'nosecone')!['shape']).toBe('ellipsoid');
    expect(nodes(r.tree.components).filter(n => n.type === 'bodytube' || n.type === 'nosecone').every(n => n['finish'] === 'finishpolished')).toBe(true);
    expect(r.notes.join(' ')).not.toMatch(/Unknown.*(nose shape|surface finish)/);
  });

  it.each(['', '<BoattailRearDiameter>0</BoattailRearDiameter>'])('warns when a booster boat tail cannot be built: %s', rear => {
    const r = importCdx1(design(tube + `<Booster><Length>10</Length><Diameter>4</Diameter><BoattailLength>2</BoattailLength>${rear}</Booster>`));
    expect(r.noteTiers?.some(n => n.tier === 'caution' && /boat tail.*omitted.*drag/.test(n.text))).toBe(true);
    expect(nodes(r.tree.components).some(n => /boat tail/.test(n.name ?? ''))).toBe(false);
  });

  it.each(['', '<InsideDiameter>0</InsideDiameter>'])('C-F4-6 retains booster shoulders with missing/zero bore: %s', bore => {
    const r = importCdx1(design(tube
      + `<Booster><Length>10</Length><Diameter>4</Diameter><ShoulderLength>2</ShoulderLength>${bore}</Booster>`
      + `<Booster><Length>10</Length><Diameter>5</Diameter><ShoulderLength>1</ShoulderLength>${bore}</Booster>`));
    const first = r.tree.components[1]!.children![0]!;
    const second = r.tree.components[2]!.children![0]!;
    expect(first.name).toBe('Booster shoulder');
    expect(first['length']).toBeCloseTo(2 / 39.37, 10);
    expect(first['foreRadius']).toBeCloseTo(3 / 39.37 / 2, 10);
    expect(second['foreRadius']).toBeCloseTo(4 / 39.37 / 2, 10);
  });

  it('C-F4-7 does not attach a fin can to a tube before a transition', () => {
    const r = importCdx1(design(tube + '<Transition><Length>3</Length><RearDiameter>2</RearDiameter></Transition>'
      + '<FinCan><Length>4</Length><Diameter>2.2</Diameter><Location>23</Location><Offset>-4</Offset></FinCan>'));
    expect(r.tree.components[0]!.children!.map(n => n.type)).toEqual(['bodytube', 'transition', 'bodytube']);
    expect(r.notes.join(' ')).toContain('imported as a plain body tube');
    expect(r.notes.join(' ')).not.toContain('flush with that tube');
  });

  it.each([0, 3])('C-F4-6 sibling: retains a fin-can shoulder without an InsideDiameter on a %s-inch tube', diameter => {
    const r = importCdx1(design(tube.replace('<Diameter>3', `<Diameter>${diameter}`)
      + '<FinCan><Length>4</Length><Diameter>3.2</Diameter><ShoulderLength>1</ShoulderLength></FinCan>'));
    const shoulder = nodes(r.tree.components).find(n => n.name === 'Fin can shoulder')!;
    expect(shoulder).toBeDefined();
    expect(shoulder['foreRadius']).toBeCloseTo(diameter / 39.37 / 2, 10);
    expect(shoulder['length']).toBeCloseTo(1 / 39.37, 10);
  });

  it('C-F4-7 sibling: a recessed boat tail starts after an intervening transition', () => {
    const r = importCdx1(design(tube + '<Transition><Length>3</Length><RearDiameter>2</RearDiameter></Transition>'
      + '<BoatTail><Length>2</Length><RearDiameter>1</RearDiameter></BoatTail>'
      + '<Booster><Length>10</Length><Diameter>2</Diameter><Location>23</Location></Booster>'));
    const pod = nodes(r.tree.components).find(n => n.name === 'Boat tail pod')!;
    expect(pod.position?.method).toBe('top');
    expect(pod.position?.offset).toBeCloseTo(23 / 39.37, 10);
  });

  it('C-F4-7 sibling: a non-flush fin can is not described as flush', () => {
    const r = importCdx1(design(tube + '<FinCan><Length>4</Length><Diameter>3.2</Diameter><Location>22</Location><Offset>-4</Offset></FinCan>'));
    expect(r.notes.join(' ')).toContain('is not flush');
    expect(r.notes.join(' ')).not.toContain('flush with that tube');
    const pod = nodes(r.tree.components).find(n => n.name === 'Fin can')!;
    expect(pod.position).toEqual({ method: 'bottom', offset: 2 / 39.37 });
  });

  it('C-F4-5 also preserves rounded sections on freeform transition fins', () => {
    const r = importCdx1(design(tube + `<Transition><Length>4</Length><RearDiameter>2</RearDiameter>${fin('rounded')}</Transition>`));
    expect(nodes(r.tree.components).find(n => n.type === 'freeformfinset')!['crossSection']).toBe('rounded');
  });

  const recovery = (first: string, second = '') => `<Recovery>${first}${second}</Recovery>`;
  const slot = (i: number, event = 'Apogee', device = 'Parachute', enabled = true) =>
    `<Event${i}>${enabled}</Event${i}><EventType${i}>${event}</EventType${i}><DeviceType${i}>${device}</DeviceType${i}>`
    + `<Size${i}>36</Size${i}><CD${i}>0.8</CD${i}><Altitude${i}>500</Altitude${i}>`;
  const chutes = (first: string, second = '') => nodes(importCdx1(design(tube, recovery(first, second))).tree.components)
    .filter(n => n.type === 'parachute');

  it.each([1, 2])('C-F4-4 DeviceType None has zero canopy diameter in slot %s', i => {
    const cs = chutes(slot(1, 'Apogee', i === 1 ? 'None' : 'Parachute'), i === 2 ? slot(2, 'Altitude', 'None') : '');
    expect(cs[i - 1]!['diameter']).toBe(0);
  });
  it.each(['0', '500', '750&#10;&#x202e;'])('C-F4-4 quotes Altitude2 %s for paired apogee slots', altitude => {
    const second = slot(2).replace('<Altitude2>500', `<Altitude2>${altitude}`);
    const cs = chutes(slot(1), second);
    expect(cs.map(c => c['deployEvent'])).toEqual(['apogee', 'apogee']);
    const r = importCdx1(design(tube, recovery(slot(1), second)));
    const note = r.noteTiers?.find(n => n.kind === 'I04.recovery-event')?.text;
    // Hostile text: the line break is dropped and the bidi control shown as a visible marker (lane N2's note rules).
    if (altitude.includes('&')) {
      expect(note).toContain('desktop OpenRocket cannot import');
      expect(note).toContain('750[U+202E]');
    } else expect(note).toContain(`Altitude2 value “${altitude}” ft`);
    expect(note).not.toMatch(/[\n\u202e]/u);
    expect(explanationFor('I04.recovery-event').meaning).toContain('Altitude2');
    expect(explanationFor('I04.recovery-event').meaning).not.toContain('Altitude 0 ft');
  });
  it.each(['apogee', undefined])('round trips two %s chutes and discloses external format loss', event => {
    const tree = importCdx1(design(tube, recovery(slot(1), slot(2)))).tree;
    for (const c of nodes(tree.components).filter(n => n.type === 'parachute')) c['deployEvent'] = event;
    const notes: string[] = [];
    const xml = exportCdx1({ name: 'Pair', tree, motors: {}, notes });
    expect(xml).toContain('<Altitude2>0</Altitude2>');
    const back = importCdx1(xml);
    expect(nodes(back.tree.components).filter(n => n.type === 'parachute').map(c => c['deployEvent'])).toEqual(['apogee', 'apogee']);
    expect(notes.filter(n => n.includes('two apogee'))).toHaveLength(1);
    expect(notes.find(n => n.includes('two apogee'))).toContain('Altitude2 is written as “0” ft');
  });
  it.each([1, 2])('discloses every missing or invalid numeric recovery field in slot %s', i => {
    for (const field of ['Altitude', 'Size', 'CD']) for (const value of [undefined, 'bad', '0x10']) {
      for (const paired of [false, true]) {
        if (i === 2 && !paired) continue;
        const original = slot(i);
        const changed = original.replace(new RegExp(`<${field}${i}>[^<]*</${field}${i}>`),
          value === undefined ? '' : `<${field}${i}>${value}</${field}${i}>`);
        const r = importCdx1(design(tube, recovery(i === 1 ? changed : slot(1), paired ? (i === 2 ? changed : slot(2)) : '')));
        const notes = r.noteTiers?.filter(n => n.kind === 'I04.recovery-event').map(n => n.text).join(' ') ?? '';
        expect(notes).toContain('desktop OpenRocket cannot import this file');
        expect(notes).toContain(`${field}${i}`);
        expect(notes).toContain('app');
        expect(notes).toContain('apogee');
        expect(notes).not.toContain('use an Altitude event');
      }
    }
  });
  it.each(['Altitude', 'Size', 'CD'])('discloses invalid %s even in a disabled slot', field => {
    const second = slot(2, 'Apogee', 'Parachute', false).replace(new RegExp(`<${field}2>[^<]*</${field}2>`), `<${field}2>bad</${field}2>`);
    const r = importCdx1(design(tube, recovery(slot(1), second)));
    const notes = r.noteTiers?.filter(n => n.kind === 'I04.recovery-event').map(n => n.text).join(' ');
    expect(notes).toContain('desktop OpenRocket cannot import this file');
    expect(notes).toContain('ignored');
  });
  it.each([slot(1, 'Apogee', 'Parachute', false), slot(1, 'None'), ''])(
  'C-F4-4 ignores slot 2 when slot 1 is disabled: %s', first => {
    expect(chutes(first, slot(2, 'Altitude'))).toHaveLength(0);
  });
  it.each([1, 2])('C-F4-4 ignores an unknown device type in slot %s', i => {
    const cs = chutes(slot(1, 'Apogee', i === 1 ? 'Unknown' : 'Parachute'), i === 2 ? slot(2, 'Altitude', 'Unknown') : '');
    expect(cs).toHaveLength(i - 1);
  });
});

describe('L-M3-1 RASAero launch ignition delay note', () => {
  it.each([1, 2, 3])('discloses loss on a %s-stage rocket, including active overrides', count => {
    const tree = { components: Array.from({ length: count }, (_, i) => ({
      type: 'stage' as const, id: `s${i}`, name: `Stage ${i}`,
      children: [{ type: 'bodytube' as const, id: `b${i}`, length: 0.5, outerRadius: 0.04 }],
    })) };
    const motors = Object.fromEntries(tree.components.map((_, i) => [`b${i}`, {
      designation: 'Motor\n\u202e', manufacturer: 'AeroTech', diameter: 0.029, length: 0.1, delay: 5,
      ignitionEvent: i === count - 1 ? 'automatic' : 'burnout', ignitionDelay: 0,
    }]));
    const notes: string[] = [];
    const xml = exportCdx1({ name: 'Test', tree, motors, notes,
      overrides: { ignitions: { [`b${count - 1}`]: { event: 'automatic', delay: 12 } } } });
    const note = notes.find(n => n.includes('launch-stage ignition delay'));
    expect(note).toContain('12 s');
    expect(note).toContain('ignites at launch with no delay');
    expect(note).toContain('Save .ork');
    expect(note).not.toMatch(/[\n\u202e]/u);
    const report = checkFormatLoss('cdx1', { tree, motors, measured: { massKg: null, cgM: null },
      overrides: { ignitions: { [`b${count - 1}`]: { event: 'automatic', delay: 12 } } },
      launch: DEFAULT_CONDITIONS, configs: [], activeConfigId: '', flightData: {} });
    expect(report.losses.filter(n => /launch-stage ignition delay|ignition trigger\/timing|Bottom-stage ignition delay/.test(n))).toHaveLength(1);
    const back = importCdx1(xml);
    const launchMotor = Object.values(back.configs[0]!.motors).at(-1)!;
    expect(launchMotor.ignitionDelay ?? 0).toBe(0);
  });
});
