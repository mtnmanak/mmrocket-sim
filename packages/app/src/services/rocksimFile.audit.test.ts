// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode } from '@online-openrocket/engine';
import { exportRkt, importRkt } from './rocksimFile.js';
import { KERNEL_DEFAULT_FIN_POINTS } from '../tree/kernelDefaults.js';
import { engineTree } from '../tree/treeModel.js';
import { parseXml, type XmlElement } from './xmlParse.js';
import { refuseOversizedForeignXml } from './foreignPartPrecount.js';
import { MAX_DESIGN_PARTS } from '../tree/sanitize.js';

const xml = (parts: string) => `<RockSimDocument><DesignInformation><RocketDesign>
  <Name>Audit</Name><StageCount>1</StageCount><Stage3Parts><BodyTube><Name>Tube</Name>
  <OD>100</OD><ID>98</ID><Len>400</Len><AttachedParts>${parts}</AttachedParts></BodyTube>
  </Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
const all = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...all(n.children ?? [])]);
const named = (r: ReturnType<typeof importRkt>, name: string) => all(r.tree.components).find(n => n.name === name)!;

describe('RockSim audit regressions', () => {
  it.each(['FinSet', 'CustomFinSet', 'TubeFinSet'])('includes the retained host in the lexical %s refusal count', tag => {
    const file = xml(`<${tag}/>`
      .repeat(MAX_DESIGN_PARTS + 1));
    expect(() => refuseOversizedForeignXml(file, 'rkt')).toThrow(/2,003 parts, past the 2,000/);
  });
  it('refuses 100k stage-level fins before DOM parsing even though attachment rules drop them', () => {
    const fins = '<FinSet><AttachedParts><Ring/></AttachedParts></FinSet>'.repeat(100_000);
    const file = xml('').replace('<Stage3Parts>', `<Stage3Parts>${fins}`);
    const start = performance.now();
    expect(() => refuseOversizedForeignXml(file, 'rkt')).toThrow(/parts.*limit|limit.*parts|2,000/i);
    expect(() => importRkt(file)).toThrow(/2,000/);
    expect(performance.now() - start).toBeLessThan(5_000);
  }, 10_000);
  it.each(['', '<Unknown>'])('counts dropped fins through the DOM fallback: %s', wrapper => {
    const fins = '<FinSet extra="x"/>'.repeat(MAX_DESIGN_PARTS + 1);
    const file = xml('').replace('<Stage3Parts>', `<Stage3Parts>${wrapper}${fins}${wrapper ? '</Unknown>' : ''}`);
    expect(() => importRkt(file)).toThrow(/parts.*limit|limit.*parts|2,000/i);
  }, 30_000);
  it('collapses fin attachment cautions to one count with the first few names', () => {
    const fins = Array.from({ length: 6 }, (_, i) => `<FinSet><Name>Wing${i}</Name><AttachedParts><Ring><Name>Ring${i}</Name></Ring></AttachedParts></FinSet>`).join('');
    const result = importRkt(xml(fins));
    const notes = result.noteTiers?.filter(n => n.kind === 'I03.fin-attached') ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]!.tier).toBe('caution');
    expect(notes[0]!.text).toContain('6 fin sets');
    for (const name of ['Wing0', 'Wing1', 'Wing2']) expect(notes[0]!.text).toContain(name);
    expect(notes[0]!.text).not.toContain('Wing5');
  });
  it('includes dropped fins in the combined retained-part limit', () => {
    const file = xml('').replace('<Stage3Parts>', '<Stage3Parts>' + '<FinSet/>'.repeat(MAX_DESIGN_PARTS - 1));
    expect(() => importRkt(file)).toThrow(/2,000/);
  });
  it('uses one attachment summary across active stage slots', () => {
    const fin = '<FinSet><AttachedParts><Ring/></AttachedParts></FinSet>';
    const file = xml(fin).replace('<StageCount>1', '<StageCount>2')
      .replace('</Stage3Parts>', `</Stage3Parts><Stage2Parts>${fin}</Stage2Parts>`);
    const notes = importRkt(file).noteTiers?.filter(n => n.kind === 'I03.fin-attached') ?? [];
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain('2 fin sets');
  });
  it('does not walk ancestors for each fin under unsupported deep subtrees', () => {
    const sample = parseXml('<Unknown><FinSet/></Unknown>', 'fixture').documentElement;
    const closest = vi.spyOn(Object.getPrototypeOf(sample) as XmlElement, 'closest');
    try {
      expect(sample.children[0]!.closest('Unknown')).not.toBeNull();
      expect(closest).toHaveBeenCalledOnce();
      closest.mockClear();
      const nested = '<Unknown>'.repeat(40) + '<FinSet/>'.repeat(100) + '</Unknown>'.repeat(40);
      importRkt(xml(nested));
      expect(closest).not.toHaveBeenCalled();
    } finally { closest.mockRestore(); }
  });
  it('F5 bore keeps an unreadable ring ID automatic beside a motor tube', () => {
    const r = importRkt(xml(`<Ring><Name>Automatic ring</Name><UsageCode>0</UsageCode><OD>98</OD><ID>29,0</ID><Len>2</Len></Ring>
      <BodyTube><Name>Motor tube</Name><OD>30</OD><ID>28</ID><Len>100</Len><IsInsideTube>1</IsInsideTube></BodyTube>`));
    expect(named(r, 'Automatic ring')['innerRadius']).toBeUndefined();
    expect(r.notes.join('\n')).toMatch(/ID.*29,0|29,0.*ID/);
  });

  it('F5 bore keeps the default lug wall when its ID is unreadable', () => {
    const r = importRkt(xml('<LaunchLug><Name>Lug</Name><OD>5</OD><ID>29,0</ID></LaunchLug>'));
    expect(named(r, 'Lug')['thickness']).toBeCloseTo(0.0004, 12);
    expect(r.notes.join('\n')).toMatch(/ID.*29,0|29,0.*ID/);
  });

  it('F5 bore calculates a lug wall from the same default OD as its radius', () => {
    const r = importRkt(xml('<LaunchLug><Name>Lug</Name><ID>3.5</ID></LaunchLug>'));
    expect(named(r, 'Lug')['outerRadius']).toBeCloseTo(0.0025, 12);
    expect(named(r, 'Lug')['thickness']).toBeCloseTo(0.00075, 12);
    expect(named(importRkt(exportRkt({ name: r.name, tree: r.tree })), 'Lug')['thickness']).toBeCloseTo(0.00075, 12);
  });

  it('S1b-7 bounds configuration-key text amplified across simulations', () => {
    const recovery = '<Parachute><Name>Recovery</Name></Parachute>'.repeat(128);
    const sim = `<SimulationResults><Stage3Engines><EngineSet><EngineCode>Audit</EngineCode>
      <EngineMfg>Home</EngineMfg><MountSerialNo>7</MountSerialNo><EngineCount>1</EngineCount>
      </EngineSet></Stage3Engines></SimulationResults>`;
    const file = xml(recovery).replace('<Len>400</Len>', '<Len>400</Len><IsMotorMount>1</IsMotorMount><SerialNo>7</SerialNo>')
      .replace('</RocketDesign>', `<SimulationResultsList>${sim.repeat(1500)}</SimulationResultsList></RocketDesign>`);
    expect(() => importRkt(file)).toThrow(/comparison.*limit|limit.*comparison/i);
  }, 30_000);

  it.each(['Parachute', 'Streamer'])('S1b-2 round trips explicit zero Cd on %s', tag => {
    const first = importRkt(xml(`<${tag}><Name>Recovery</Name><DragCoefficient>0</DragCoefficient></${tag}>`));
    expect(named(first, 'Recovery')['cd']).toBe(0);
    const saved = exportRkt({ name: first.name, tree: first.tree });
    expect(named(importRkt(saved), 'Recovery')['cd']).toBe(0);
    expect(named(importRkt(xml(`<${tag}><Name>Recovery</Name></${tag}>`)), 'Recovery')['cd']).toBeUndefined();
  });

  it('S1b-3 imports ID 0 as an automatic hole beside an overlapping motor tube', () => {
    const first = importRkt(xml(`<Ring><Name>Automatic ring</Name><UsageCode>0</UsageCode><OD>98</OD><ID>0</ID><Len>2</Len></Ring>
      <BodyTube><Name>Motor tube</Name><OD>30</OD><ID>28</ID><Len>100</Len><IsInsideTube>1</IsInsideTube></BodyTube>`));
    const ring = named(first, 'Automatic ring');
    expect(ring['innerRadius']).toBeUndefined();
    resetEngine();
    expect(OrkRocket.buildTree(engineTree(first.tree)).componentInfo(ring.id!).mass)
      .toBeCloseTo(Math.PI * (0.049 ** 2 - 0.015 ** 2) * 0.002 * 680, 12);
    const saved = exportRkt({ name: first.name, tree: first.tree });
    expect(named(importRkt(saved), 'Automatic ring')['innerRadius']).toBeCloseTo(0.015, 12);
    const absent = importRkt(xml('<Ring><Name>Automatic ring</Name><OD>98</OD></Ring>'));
    expect(named(absent, 'Automatic ring')['innerRadius']).toBeUndefined();
  });

  it('S1b-3 discloses that an explicitly solid centering ring reopens automatic', () => {
    const first = importRkt(xml(`<Ring><Name>Solid ring</Name><UsageCode>0</UsageCode><OD>98</OD><ID>30</ID><Len>2</Len></Ring>
      <BodyTube><Name>Motor tube</Name><OD>30</OD><ID>28</ID><Len>100</Len><IsInsideTube>1</IsInsideTube></BodyTube>`));
    named(first, 'Solid ring')['innerRadius'] = 0;
    const notes: string[] = [];
    const saved = exportRkt({ name: first.name, tree: first.tree, notes });
    expect(notes.join('\n')).toMatch(/Solid ring.*solid centering ring.*inside diameter 0.*automatic hole/);
    expect(notes.join('\n')).toContain('reopens with a hole sized to the motor tube. Save as .ork to keep it solid.');
    const reopened = importRkt(saved);
    const ring = named(reopened, 'Solid ring');
    expect(ring['innerRadius']).toBeUndefined();
    resetEngine();
    expect(OrkRocket.buildTree(engineTree(reopened.tree)).componentInfo(ring.id!).mass)
      .toBeCloseTo(Math.PI * (0.049 ** 2 - 0.015 ** 2) * 0.002 * 680, 12);
  });

  it.each(['<!-- example <![CDATA[ -->', '<!--> <![CDATA[ -->', '<!---> <![CDATA[ -->',
    '<?example <![CDATA[ ?>'])('S1b-5 skips a CDATA opener in %s', prefix => {
    const r = importRkt(xml(`${prefix}<Parachute><Name><![CDATA[Fabric & thread]]></Name></Parachute>`));
    expect(named(r, 'Fabric & thread').type).toBe('parachute');
  });

  it.each(['Streamer', 'Parachute'])('S1b-b1 treats type-2 %s fabric as surface density', tag => {
    const r = importRkt(xml(`<${tag}><Name>Fabric</Name><Len>1000</Len><Width>100</Width><Dia>1000</Dia>
      <Density>0.01</Density><DensityType>2</DensityType><Material>Named fabric</Material></${tag}>
      <MassObject><Name>Cord</Name><TypeCode>1</TypeCode><Len>1000</Len><Density>0.01</Density><DensityType>2</DensityType></MassObject>`));
    expect(named(r, 'Fabric')['surfaceDensity']).toBeCloseTo(0.1, 12);
    expect(named(r, 'Cord')['lineDensity']).toBeCloseTo(0.01, 12);
  });

  it.each([0, 1])('S1b-b2 refuses an invalid synthesized outline (shape %s)', shape => {
    const r = importRkt(xml(`<Transition><Name>Transition</Name><Len>100</Len><FrontDia>80</FrontDia><RearDia>100</RearDia>
      <AttachedParts><FinSet><Name>Bad fins</Name><ShapeCode>${shape}</ShapeCode><RootChord>-50</RootChord>
      <TipChord>30</TipChord><SweepDistance>0</SweepDistance><SemiSpan>30</SemiSpan></FinSet></AttachedParts></Transition>`)
      .replace('<BodyTube><Name>Tube</Name>\n  <OD>100</OD><ID>98</ID><Len>400</Len><AttachedParts>', '')
      .replace('</AttachedParts></BodyTube>', ''));
    expect(named(r, 'Bad fins')['points']).toEqual(KERNEL_DEFAULT_FIN_POINTS);
    expect(r.notes.join('\n')).toMatch(/Bad fins.*outline was not used/);
  });

  it.each(['10,30,garbage', '10,30,', '10,30,1,2'])('S1b-7 keeps the first two point fields like desktop OR: %s', point => {
    const r = importRkt(xml(`<CustomFinSet><Name>Points</Name>
      <PointList>0,0|${point}|40,30|60,0</PointList></CustomFinSet>`));
    expect(named(r, 'Points')['points']).toEqual([[0, 0], [0.01, 0.03], [0.04, 0.03], [0.06, 0]]);
    expect(r.notes.join('\n')).not.toMatch(/Points.*one point/i);
  });

  it.each([2, 4])('S1b-7 round trips a zero-wall ring (usage %s)', usage => {
    const first = importRkt(xml(`<Ring><Name>Zero wall</Name><UsageCode>${usage}</UsageCode><OD>98</OD><ID>98</ID><Len>10</Len></Ring>`));
    expect(named(first, 'Zero wall')['thickness']).toBe(0);
    expect(named(importRkt(exportRkt({ name: first.name, tree: first.tree })), 'Zero wall')['thickness']).toBe(0);
  });
  it('S1b-7 round trips a zero-wall launch lug', () => {
    const first = importRkt(xml('<LaunchLug><Name>Lug</Name><Len>30</Len><OD>5</OD><ID>5</ID></LaunchLug>'));
    expect(named(first, 'Lug')['thickness']).toBe(0);
    expect(named(importRkt(exportRkt({ name: first.name, tree: first.tree })), 'Lug')['thickness']).toBe(0);
  });
});
