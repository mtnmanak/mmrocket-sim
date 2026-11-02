// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode } from '@online-openrocket/engine';
import { engineTree } from '../tree/treeModel.js';
import { kernelRecoveryCd } from '../tree/kernelDefaults.js';
import { exportRkt, importRkt, rktComponentInfo } from './rocksimFile.js';
import { checkFormatLoss } from './formatLoss.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { IMPERIAL_UNITS } from '../prefs/units.js';

const xml = (part: string) => `<RockSimDocument><DesignInformation><RocketDesign><Name>Counts</Name>
  <StageCount>1</StageCount><Stage3Parts><NoseCone><Name>Nose</Name><Len>100</Len><BaseDia>50</BaseDia>
  <AttachedParts>${part}</AttachedParts></NoseCone></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
const all = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...all(n.children ?? [])]);
const device = (r: ReturnType<typeof importRkt>) => all(r.tree.components).find(n => n.name === 'Recovery')!;
const mass = (r: ReturnType<typeof importRkt>) => {
  resetEngine();
  return OrkRocket.buildTree(engineTree(r.tree)).componentInfo(device(r).id!).mass;
};
const chute = (count: string, known = '') => `<Parachute><Name>Recovery</Name><Dia>300</Dia>
  <ChuteCount>${count}</ChuteCount><SideCount>0</SideCount><SpillHoleDia>30</SpillHoleDia><DragCoefficient>1.1</DragCoefficient>
  <DensityType>1</DensityType><Density>0.0067</Density><ShroudLineCount>6</ShroudLineCount>
  <ShroudLineLen>300</ShroudLineLen><ShroudLineMassPerMM>0.0018</ShroudLineMassPerMM>${known}</Parachute>`;

describe('RockSim recovery counts', () => {
  it.each([2, 3])('C-F3-3 imports %i canopies at equal area and computes all fabric and lines', count => {
    const single = importRkt(xml(chute('1')));
    const r = importRkt(xml(chute(String(count))));
    expect(device(r)['diameter']).toBeCloseTo(0.3 * Math.sqrt(count), 12);
    expect(device(r)['spillHoleDiameter']).toBeCloseTo(0.03 * Math.sqrt(count), 12);
    expect(device(r)['cd']).toBe(1.1);
    expect(device(r)['packedRadius']).toBe(device(single)['packedRadius']);
    expect(device(r)['packedLength']).toBe(device(single)['packedLength']);
    expect(device(r)['overrideMass']).toBeUndefined();
    expect(mass(r)).toBeCloseTo(count * mass(single), 12);
    const edited = structuredClone(r);
    device(edited)['diameter'] = 0.6 * Math.sqrt(count);
    expect(mass(edited) - mass(r)).toBeCloseTo(3 * count * Math.PI * 0.15 ** 2 * (device(single)['surfaceDensity'] as number), 12);
    expect(r.notes.join('\n')).toMatch(new RegExp(`${count} × 300 mm`));
    expect(r.notes.join('\n')).toMatch(/equivalent.*mm/);
    const saved = exportRkt({ name: r.name, tree: r.tree });
    expect(saved).toContain(`<ChuteCount>${count}</ChuteCount>`);
    const reopened = importRkt(saved);
    for (const field of ['diameter', 'spillHoleDiameter', 'packedRadius', 'packedLength', 'cd']) {
      expect(device(reopened)[field]).toBeCloseTo(device(r)[field] as number, 12);
    }
    expect(mass(reopened)).toBeCloseTo(mass(r), 12);
    const preview = checkFormatLoss('rkt', { tree: r.tree, motors: {}, configs: [], activeConfigId: null,
      launch: DEFAULT_CONDITIONS, measured: { massKg: null, cgM: null }, flightData: {} });
    expect(preview.losses.join('\n')).not.toMatch(/Packed recovery dimensions/);
  });

  it.each([0, 24])('retains a stated total known mass %i g without multiplying it by the count', known => {
    const r = importRkt(xml(chute('2', `<CalcMass>25.7</CalcMass><KnownMass>${known}</KnownMass><UseKnownMass>1</UseKnownMass>`)));
    expect(device(r)['diameter']).toBeCloseTo(0.3 * Math.sqrt(2), 12);
    expect(device(r)['overrideMass']).toBeCloseTo(known / 1000, 12);
    expect(mass(r)).toBeCloseTo(known / 1000, 12);
    expect(r.notes.join('\n')).not.toContain("mass override set to RockSim's stated");
  });

  it.each([undefined, IMPERIAL_UNITS])('adds the missing surface-density fabric to CalcMass for multiple canopies (%j)', units => {
    const r = importRkt(xml(chute('2', '<CalcMass>25.7</CalcMass><KnownMass>99</KnownMass><UseKnownCG>0</UseKnownCG>')), { units });
    const total = 0.0257 + Math.PI * (0.15 ** 2 - 0.015 ** 2) * 0.067;
    expect(device(r)['overrideMass']).toBeCloseTo(total, 12);
    expect(mass(r)).toBeCloseTo(total, 12);
    const note = r.notes.find(n => n.includes('equivalent'))!;
    expect(note).toContain('mass override set to');
    expect(note).toContain(units ? '0.907 oz (25.7 g)' : '25.7 g (0.907 oz)');
    expect(note).toContain('for all 2 canopies');
    expect(note).toContain('counts the canopy fabric once');
    const edited = structuredClone(r);
    device(edited)['diameter'] = 0.6 * Math.sqrt(2);
    expect(mass(edited)).toBeCloseTo(mass(r), 12);
    delete device(edited)['overrideMass'];
    expect(mass(edited)).toBeGreaterThan(mass(r));
    const reopened = importRkt(exportRkt({ name: r.name, tree: r.tree }));
    expect(device(reopened)['overrideMass']).toBeCloseTo(total, 12);
    expect(mass(reopened)).toBeCloseTo(mass(r), 12);
  });

  it.each([
    { name: 'Altaira', count: 3, dia: 710.764, hole: 0, type: 1, density: 0.006685, calc: 25.7308, total: 69.60145796576116 },
    { name: 'Defender', count: 2, dia: 304.8, hole: 0, type: 0, density: 924.265, calc: 3.48429, total: 3.48429 },
    { name: 'LifeProof without known mass', count: 2, dia: 609.6, hole: 101.6, type: 1, density: 0.006685, calc: 26.6016, total: 42.19515524211853 },
  ])('uses the file geometry and density for $name', ({ count, dia, hole, type, density, calc, total }) => {
    const r = importRkt(xml(`<Parachute><Name>Recovery</Name><Dia>${dia}</Dia><SpillHoleDia>${hole}</SpillHoleDia>
      <SideCount>6</SideCount><ChuteCount>${count}</ChuteCount><DensityType>${type}</DensityType>
      <Density>${density}</Density><CalcMass>${calc}</CalcMass></Parachute>`));
    // Source decimal precision, not a pinned kernel floating-point result.
    expect((device(r)['overrideMass'] as number) * 1000).toBeCloseTo(total, 8);
    expect(mass(r) * 1000).toBeCloseTo(total, 8);
  });

  it.each(['<DensityType>2</DensityType>', '<DensityType>NaN</DensityType>', '<DensityType>1.5</DensityType>',
    '<Density>NaN</Density>', '<Density>-1</Density>', '<Density>1e999</Density>', 'missing density', 'missing type'])(
    'keeps the N-material fallback unpinned for %s', invalid => {
    let part = chute('2', '<CalcMass>25.7</CalcMass>');
    if (invalid === 'missing density') part = part.replace('<Density>0.0067</Density>', '');
    else if (invalid === 'missing type') part = part.replace('<DensityType>1</DensityType>', '');
    else part = part.replace(invalid.startsWith('<DensityType>') ? /<DensityType>.*?<\/DensityType>/ : /<Density>.*?<\/Density>/, invalid);
    const r = importRkt(xml(part));
    expect(device(r)['overrideMass']).toBeUndefined();
    const single = importRkt(xml(part.replace('<ChuteCount>2', '<ChuteCount>1')));
    expect(mass(r)).toBeCloseTo(2 * mass(single), 12);
  });

  it.each([['parachute', false], ['parachute', true], ['streamer', false], ['streamer', true]] as const)(
    'keeps an unpinned %s unpinned when saved with app component info (known CG: %s)', (type, knownCG) => {
    const r = importRkt(xml(type === 'parachute' ? chute('2') : '<Streamer><Name>Recovery</Name><Len>500</Len><Width>50</Width><StreamerCount>2</StreamerCount></Streamer>'));
    if (knownCG) device(r)['overrideCGX'] = 0.02;
    resetEngine();
    const rocket = OrkRocket.buildTree(engineTree(r.tree));
    const saved = exportRkt({ name: r.name, tree: r.tree, compInfo: rktComponentInfo(r.tree, id => rocket.componentInfo(id)) });
    const reopened = importRkt(saved);
    expect(device(reopened)['overrideMass']).toBeUndefined();
    expect(device(reopened)['overrideCGX']).toBe(knownCG ? 0.02 : undefined);
    expect(mass(reopened)).toBeCloseTo(mass(r), 12);
    expect(reopened.notes.join('\n')).not.toContain("RockSim's");
    device(reopened)[type === 'parachute' ? 'diameter' : 'stripWidth'] = 0.8;
    expect(mass(reopened)).toBeGreaterThan(mass(r));
  });

  it.each(['<SideCount>2</SideCount>', '<SideCount>6.5</SideCount>', '<SideCount>NaN</SideCount>',
    '<Dia>0</Dia>', '<SpillHoleDia>-30</SpillHoleDia>', '<SpillHoleDia>400</SpillHoleDia>'])(
    'does not invent a stated mass from unusable surface geometry: %s', invalid => {
    const tag = invalid.slice(1, invalid.indexOf('>'));
    const part = chute('2', '<CalcMass>25.7</CalcMass>').replace(new RegExp(`<${tag}>.*?</${tag}>`), invalid);
    expect(device(importRkt(xml(part)))['overrideMass']).toBeUndefined();
  });

  it.each(['', '<CalcMass>0</CalcMass>', '<CalcMass>-1</CalcMass>', '<CalcMass>NaN</CalcMass>',
    '<CalcMass>Infinity</CalcMass>', '<CalcMass>1e999</CalcMass>'])('falls back to all fabric and lines with no usable total: %s', calc => {
    const single = importRkt(xml(chute('1')));
    const r = importRkt(xml(chute('2', calc)));
    expect(device(r)['overrideMass']).toBeUndefined();
    expect(mass(r)).toBeCloseTo(2 * mass(single), 12);
    expect(r.notes.join('\n')).not.toContain("mass override set to RockSim's stated");
  });

  it('leaves count-1 computed mass editable even when CalcMass is present', () => {
    const single = importRkt(xml(chute('1')));
    const r = importRkt(xml(chute('1', '<CalcMass>25.7</CalcMass>')));
    expect(device(r)['overrideMass']).toBeUndefined();
    expect(mass(r)).toBeCloseTo(mass(single), 12);
    device(r)['diameter'] = 0.6;
    expect(mass(r)).toBeGreaterThan(mass(single));
    expect(r.notes.join('\n')).not.toContain('equivalent');
  });

  it('uses a stated total for multiple streamers and preserves it on reopen', () => {
    const r = importRkt(xml('<Streamer><Name>Recovery</Name><Len>500</Len><Width>50</Width>'
      + '<StreamerCount>2</StreamerCount><CalcMass>12.3</CalcMass></Streamer>'));
    expect(device(r)['stripWidth']).toBeCloseTo(0.1, 12);
    expect(device(r)['overrideMass']).toBeCloseTo(0.0123, 12);
    expect(mass(r)).toBeCloseTo(0.0123, 12);
    expect(r.notes.join('\n')).toContain("mass override set to RockSim's stated 12.3 g (0.434 oz) for all 2 streamers");
    expect(mass(importRkt(exportRkt({ name: r.name, tree: r.tree })))).toBeCloseTo(mass(r), 12);
  });

  it.each([[10, 20], [20, 10], [10, 10]])('compares total recovery masses before merging cluster tubes %j', (...totals) => {
    const tubes = totals.map((total, i) => `<BodyTube><Name>Tube ${i}</Name><IsInsideTube>1</IsInsideTube>
      <Len>100</Len><OD>24</OD><ID>22</ID><RadialLoc>12</RadialLoc><RadialAngle>${i * Math.PI}</RadialAngle>
      <AttachedParts>${chute('2', `<CalcMass>${total}</CalcMass>`)}</AttachedParts></BodyTube>`).join('');
    const r = importRkt(xml(tubes));
    const survivors = all(r.tree.components).filter(n => n.type === 'parachute');
    expect(survivors).toHaveLength(totals[0] === totals[1] ? 1 : 2);
    survivors.forEach((n, i) => expect(n['overrideMass']).toBeCloseTo(totals[i]! / 1000 + Math.PI * (0.15 ** 2 - 0.015 ** 2) * 0.067, 12));
    expect(r.notes.filter(n => n.includes('mass override set to'))).toHaveLength(survivors.length);
    const reopened = importRkt(exportRkt({ name: r.name, tree: r.tree }));
    expect(all(reopened.tree.components).filter(n => n.type === 'parachute').map(n => n['overrideMass']))
      .toEqual(survivors.map(n => n['overrideMass']));
  });

  it('computes all default-material fabric and lines without adding an override', () => {
    const part = (count: number) => `<Parachute><Name>Recovery</Name><Dia>300</Dia><ChuteCount>${count}</ChuteCount></Parachute>`;
    const single = importRkt(xml(part(1)));
    const r = importRkt(xml(part(2)));
    expect(device(r)['diameter']).toBeCloseTo(0.3 * Math.sqrt(2), 12);
    expect(device(r)['overrideMass']).toBeUndefined();
    expect(mass(r)).toBeCloseTo(2 * mass(single), 12);
  });

  it.each(['0', '-2', '2.5', '9007199254740992'])('names an invalid recovery count %s and keeps one canopy', count => {
    const r = importRkt(xml(chute(count)));
    expect(device(r)['diameter']).toBe(0.3);
    expect(r.noteTiers).toContainEqual(expect.objectContaining({ tier: 'caution', text: expect.stringContaining(`ChuteCount ${count}`) }));
  });

  it('handles the sibling StreamerCount at equal total area with all material mass and unchanged Cd', () => {
    const part = (count: number) => `<Streamer><Name>Recovery</Name><Len>500</Len><Width>50</Width>
      <StreamerCount>${count}</StreamerCount><DensityType>1</DensityType><Density>0.0067</Density></Streamer>`;
    const single = importRkt(xml(part(1)));
    const r = importRkt(xml(part(3)));
    expect(device(r)['stripWidth']).toBeCloseTo(0.15, 12);
    expect(device(r)['stripLength']).toBe(0.5);
    expect(kernelRecoveryCd(device(r))).toBeCloseTo(kernelRecoveryCd(device(single)), 12);
    expect(device(r)['overrideMass']).toBeUndefined();
    expect(mass(r)).toBeCloseTo(3 * mass(single), 12);
    expect(r.notes.join('\n')).toMatch(/3 streamers.*equivalent/);
    const reopened = importRkt(exportRkt({ name: r.name, tree: r.tree }));
    expect(device(reopened)['stripWidth']).toBeCloseTo(0.15, 12);
    expect(mass(reopened)).toBeCloseTo(mass(r), 12);
    expect(kernelRecoveryCd(device(reopened))).toBeCloseTo(kernelRecoveryCd(device(r)), 12);
  });

  it('keeps count conversion from bypassing shroud-line count repairs', () => {
    const source = chute('2').replace('<ShroudLineCount>6', '<ShroudLineCount>1000000');
    const single = importRkt(xml(source.replace('<ChuteCount>2', '<ChuteCount>1')));
    expect(mass(importRkt(xml(source)))).toBeCloseTo(2 * mass(single), 12);
  });

  it.each([[1, 2], [2, 1], [2, 2]])('keeps cluster recovery counts in source order %j', (...counts) => {
    const tubes = counts.map((count, i) => `<BodyTube><Name>Tube ${i}</Name><IsInsideTube>1</IsInsideTube>
      <Len>100</Len><OD>24</OD><ID>22</ID><RadialLoc>12</RadialLoc><RadialAngle>${i * Math.PI}</RadialAngle>
      <AttachedParts>${chute(String(count))}</AttachedParts></BodyTube>`).join('');
    const r = importRkt(xml(tubes));
    const survivors = all(r.tree.components).filter(n => n.type === 'parachute');
    expect(survivors).toHaveLength(counts[0] === counts[1] ? 1 : 2);
    survivors.forEach((n, i) => expect(n['diameter']).toBeCloseTo(0.3 * Math.sqrt(counts[i]!), 12));
    const saved = exportRkt({ name: r.name, tree: r.tree });
    const reopened = importRkt(saved);
    const again = all(reopened.tree.components).filter(n => n.type === 'parachute');
    expect(again.map(n => n['diameter'])).toEqual(survivors.map(n => n['diameter']));
    expect([...saved.matchAll(/<ChuteCount>(\d+)<\/ChuteCount>/g)].map(m => Number(m[1]))).toEqual(counts);
    expect(r.notes.filter(n => n.includes('equivalent'))).toHaveLength(survivors.filter(n => n['rktRecoveryCount']).length);
  });

  it.each([[1, 2], [2, 1]])('keeps asymmetric streamer clusters in source order %j', (...counts) => {
    const tubes = counts.map((count, i) => `<BodyTube><IsInsideTube>1</IsInsideTube><Len>100</Len><OD>24</OD><ID>22</ID>
      <RadialLoc>12</RadialLoc><RadialAngle>${i * Math.PI}</RadialAngle><AttachedParts>
      <Streamer><Len>500</Len><Width>50</Width><StreamerCount>${count}</StreamerCount></Streamer>
      </AttachedParts></BodyTube>`).join('');
    const r = importRkt(xml(tubes));
    const widths = (result: ReturnType<typeof importRkt>) => all(result.tree.components)
      .filter(n => n.type === 'streamer').map(n => n['stripWidth']);
    expect(widths(r)).toEqual(counts.map(count => 0.05 * count));
    expect(widths(importRkt(exportRkt({ name: r.name, tree: r.tree })))).toEqual(widths(r));
  });

  it('rounds recovery notes in the selected units without floating point residue', () => {
    const source = xml(chute('2') + `<Streamer><Name>Strip</Name><Len>914.4</Len><Width>50.00000000000001</Width>
      <StreamerCount>3</StreamerCount></Streamer>`);
    for (const units of [undefined, IMPERIAL_UNITS]) {
      const r = importRkt(source, { units });
      const notes = r.notes.filter(n => n.includes('equivalent'));
      expect(notes).toHaveLength(2);
      notes.forEach(note => {
        expect(note).not.toMatch(/000000000000/);
        expect(note).toContain(units ? 'in (' : 'mm (');
      });
      expect(notes[1]).toContain(units ? '5.906 in (150 mm)' : '150 mm (5.906 in)');
    }
  });

  it('starts the equivalent-device note at count 2 and preserves the count-1 writer shape', () => {
    const single = importRkt(xml(chute('1') + '<Streamer><Len>500</Len><Width>50</Width><StreamerCount>1</StreamerCount></Streamer>'));
    expect(single.notes.join('\n')).not.toContain('equivalent');
    const saved = exportRkt({ name: single.name, tree: single.tree });
    expect(saved).toContain('<ChuteCount>1</ChuteCount>');
    expect(saved).not.toContain('<StreamerCount>');
    expect(importRkt(xml(chute('2'))).notes.join('\n')).toContain('2 × 300 mm (11.811 in)');
  });

  it('refuses a sibling EngineCount loadout it cannot place instead of silently flying one engine', () => {
    const source = xml('').replaceAll('NoseCone', 'BodyTube').replaceAll('BaseDia', 'OD')
      .replace('<Len>100</Len>', '<Len>100</Len><ID>48</ID><SerialNo>7</SerialNo><IsMotorMount>1</IsMotorMount>')
      .replace('</Stage3Parts>', `</Stage3Parts><SimulationResultsList><SimulationResults><Stage3Engines><EngineSet>
        <EngineCode>C6</EngineCode><EngineMfg>Estes</EngineMfg><EngineCount>2</EngineCount><MountSerialNo>7</MountSerialNo>
        </EngineSet></Stage3Engines></SimulationResults></SimulationResultsList>`);
    const r = importRkt(source);
    expect(r.configs[0]!.motorLoadoutRefusal).toMatch(/EngineCount.*2/);
    expect(r.configs[0]!.motors).toEqual({});
    expect(r.noteTiers).toContainEqual(expect.objectContaining({ tier: 'caution', text: expect.stringMatching(/EngineCount.*2/) }));
  });
});
