// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type ComponentNode } from '@online-openrocket/engine';
import { engineTree } from '../tree/treeModel.js';
import { kernelNum } from '../tree/kernelDefaults.js';
import { exportRkt, importRkt, rktComponentInfo } from './rocksimFile.js';
import { parseXml } from './xmlParse.js';

const xml = (parts: string) => `<RockSimDocument><DesignInformation><RocketDesign><StageCount>1</StageCount>
  <Stage3Parts>${parts}</Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
const tube = (parts: string, extra = '<ID>48</ID>') => `<BodyTube><Name>Host</Name><OD>50</OD><Len>300</Len>${extra}
  <AttachedParts>${parts}</AttachedParts></BodyTube>`;
const all = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...all(n.children ?? [])]);
const named = (r: ReturnType<typeof importRkt>, name: string) => all(r.tree.components).find(n => n.name === name)!;
const save = (r: ReturnType<typeof importRkt>, notes?: string[]) => {
  resetEngine();
  const rocket = OrkRocket.buildTree(engineTree(r.tree));
  return exportRkt({ name: r.name, tree: r.tree, notes, compInfo: rktComponentInfo(r.tree, id => rocket.componentInfo(id)) });
};
const fins = (name: string, count = 2, angle = 0, tag = 'FinSet') => `<${tag}><Name>${name}</Name>
  <FinCount>${count}</FinCount><TubeCount>${count}</TubeCount><RootChord>60</RootChord><TipChord>30</TipChord>
  <SemiSpan>30</SemiSpan><Len>60</Len><OD>10</OD><ID>9</ID><Thickness>3</Thickness>
  <PointList>0,0|30,30|60,0|</PointList><RadialAngle>${angle}</RadialAngle></${tag}>`;

describe('RockSim import and save fidelity', () => {
  it('round 4 sanitizes both names in the unmarked fin de-collision Caution', () => {
    const r = importRkt(xml(tube(fins('First&#10;set') + fins('Second&#x202e;set'))));
    const note = r.noteTiers?.find(n => n.kind === 'I21.fin-rotated')?.text;
    expect(note).toContain('“Firstset”');
    expect(note).toContain('“Secondset”');
    expect(note).toContain('rotated 90°');
  });

  it.each(['', '<Thickness>0</Thickness>', '<Thickness>2</Thickness>'])('round 4 discloses bulk-typed cord density without changing its flown value: %s', thickness => {
    const r = importRkt(xml(tube('<MassObject><Name>Cord&#10;name</Name><TypeCode>1</TypeCode>'
      + `<DensityType>0</DensityType><Density>0.02</Density>${thickness}<Len>1000</Len></MassObject>`)));
    if (thickness === '<Thickness>2</Thickness>') expect(named(r, 'Cord\nname')['lineDensity']).toBeCloseTo(0.02 * 0.002, 12);
    else expect(named(r, 'Cord\nname')['lineDensity']).toBeUndefined();
    expect(r.noteTiers?.find(n => n.kind === 'I04.cord-density')?.text).toMatch(/Cordname.*thickness.*desktop OpenRocket.*without thickness.*mass.*before flying/s);
    const lineCord = importRkt(xml(tube('<MassObject><TypeCode>1</TypeCode><DensityType>2</DensityType><Density>0.02</Density></MassObject>')));
    expect(lineCord.noteTiers?.some(n => n.kind === 'I04.cord-density')).toBe(false);
  });
  it.each([1, 2, 3, -1, 1.5])('C-F3-1 discloses non-bulk density type %i on every structural kind', type => {
    const tags = ['NoseCone', 'Transition', 'BodyTube', 'Ring', 'LaunchLug', 'FinSet', 'CustomFinSet', 'TubeFinSet'];
    for (const tag of tags) {
      const part = `<${tag}><Name>Part&#10;name</Name><DensityType>${type}</DensityType><Density>0.3</Density>
        <Material>G10</Material><PointList>0,0|60,0|30,30|</PointList></${tag}>`;
      const r = importRkt(xml(['NoseCone', 'Transition', 'BodyTube'].includes(tag) ? part : tube(part)));
      const note = r.noteTiers?.find(n => n.kind === 'I03.nonbulk-material');
      expect(note?.tier).toBe('caution');
      expect(note?.text).toMatch(/Partname.*density.*Cardboard.*mass.*CG/);
      expect(named(r, 'Part\nname').density).toBeUndefined();
    }
    const airfoil = importRkt(xml(tube(fins('Ruled').replace('</FinSet>', `<TipShapeCode>2</TipShapeCode>
      <CalcMass>0.00352811</CalcMass><DensityType>${type}</DensityType><Density>0.313745</Density></FinSet>`))));
    expect(named(airfoil, 'Ruled')['overrideMass']).toBeCloseTo(0.00352811 / 1000, 12);
  });

  it.each([false, true])('C-F3-2 retains the default wall for a tube without usable ID (inner: %s)', inner => {
    for (const extra of ['', '<ID>bad</ID>']) {
      const r = importRkt(xml(inner ? tube(tube('', extra)) : tube('', extra)));
      const node = all(r.tree.components).find(n => n.type === (inner ? 'innertube' : 'bodytube'))!;
      expect(node['thickness'] ?? kernelNum(node, 'thickness')).toBeCloseTo(kernelNum({ type: node.type }, 'thickness'), 12);
      const reopened = all(importRkt(save(r)).tree.components).find(n => n.type === node.type)!;
      expect(reopened['thickness']).toBeCloseTo(kernelNum({ type: node.type }, 'thickness'), 12);
      const solid = importRkt(xml(inner ? tube(tube('', '<ID>0</ID>')) : tube('', '<ID>0</ID>')));
      expect(all(solid.tree.components).find(n => n.type === node.type)!['thickness']).toBeCloseTo(0.025, 12);
    }
  });

  it('C-F3-1 describes the catalogue bulk-density fallback when the part is linked', () => {
    const r = importRkt(xml(tube('', '<ID>48</ID><DensityType>1</DensityType><Density>0.3</Density>'
      + '<PartMfg>Example</PartMfg><PartNo>Tube</PartNo>')), { presets: [{
      kind: 'BodyTube', manufacturer: 'Example', partNo: 'Tube', description: 'Tube',
      material: { type: 'BULK', name: 'Bulk material', density: 1234 },
    }] });
    expect(named(r, 'Host').density).toBe(1234);
    expect(r.noteTiers?.find(n => n.kind === 'I03.nonbulk-material')?.text).toMatch(/catalogue bulk density.*otherwise.*Cardboard/);
  });

  it.each([0, 1])('C-F3-4 retains desktop and previous app relative pod angles (detachable %i)', detachable => {
    const children = fins('Fins', 1, 0.6) + fins('Tube fins', 1, 0.9, 'TubeFinSet')
      + '<LaunchLug><Name>Lug</Name><RadialAngle>1.1</RadialAngle></LaunchLug>'
      + '<BodyTube><Name>Offset tube</Name><IsInsideTube>1</IsInsideTube><RadialLoc>10</RadialLoc><RadialAngle>0.8</RadialAngle></BodyTube>'
      + '<ExternalPod><Name>Nested</Name><RadialAngle>1.2</RadialAngle><AttachedParts>'
      + tube(fins('Nested fin', 1, 1.4)) + '</AttachedParts></ExternalPod>';
    const r = importRkt(xml(tube(`<ExternalPod><Name>Pod</Name><Detachable>${detachable}</Detachable>
      <RadialAngle>0.4</RadialAngle><RadialLoc>50</RadialLoc><AttachedParts>${tube(children)}</AttachedParts></ExternalPod>`)));
    for (const [name, field, value] of [['Fins', 'rotation', 0.6], ['Tube fins', 'rotation', 0.9],
      ['Lug', 'angleOffset', 1.1], ['Offset tube', 'radialDirection', 0.8], ['Nested', 'angleOffset', 1.2],
      ['Nested fin', 'rotation', 1.4]] as const) expect(named(r, name)[field]).toBeCloseTo(value, 12);
    const saved = save(r);
    const doc = parseXml(saved, 'saved');
    for (const [name, angle] of [['Fins', 0.6], ['Tube fins', 0.9], ['Lug', 1.1], ['Offset tube', 0.8],
      ['Nested', 1.2], ['Nested fin', 1.4]] as const) {
      const el = Array.from(doc.querySelectorAll('Name')).find(n => n.textContent === name)!.parentElement!;
      expect(Number(el.querySelector(':scope > RadialAngle')?.textContent)).toBeCloseTo(angle, 12);
    }
    const again = importRkt(saved);
    expect(named(again, 'Fins')['rotation']).toBeCloseTo(0.6, 12);
    expect(named(again, 'Nested fin')['rotation']).toBeCloseTo(1.4, 12);
  });

  it('E-E3-1 warns only when measured-box mass is actually written', () => {
    const r = importRkt(xml(tube('')));
    for (const cgM of [null, 0.2]) {
      const notes: string[] = [];
      const input = { name: r.name, tree: r.tree, measured: { massKg: 0.07, cgM }, notes };
      const saved = exportRkt(input);
      expect(saved).toContain('<Stage3Mass>70</Stage3Mass>');
      expect(saved).toContain('<UseKnownMass>1</UseKnownMass>');
      expect(notes.join('\n')).toMatch(/Measured mass & CG.*RockSim and desktop OpenRocket fly.*parts.*app.*parts/);
      expect(notes.join('\n').includes('balance point')).toBe(cgM !== null);
      const preview: string[] = [];
      exportRkt({ ...input, notes: preview, dryRun: true });
      expect(preview).toEqual(notes);
    }
    const notes: string[] = [];
    exportRkt({ name: r.name, tree: r.tree, measured: { massKg: null, cgM: 0.2 }, notes });
    expect(notes.join('\n')).not.toContain('Measured mass & CG figures');
  });

  it('round 2 saves standard elements and preserves a CG-only cone with a zero-mass base extension', () => {
    const r = importRkt(readFileSync(join(process.cwd(), 'src/services/__fixtures__/rocksimTestRocket1.rkt'), 'utf8'));
    const cone = all(r.tree.components).find(n => n.type === 'nosecone')!;
    delete cone['overrideMass'];
    expect(cone['overrideCGX']).toBeGreaterThan(0);
    const extension = all(r.tree.components).find(n => n['rktBaseExtension'] === true)!;
    expect(extension['overrideMass']).toBe(0);
    const info = (tree: typeof r.tree) => OrkRocket.buildTree(engineTree(tree)).staticInfo();
    const before = info(r.tree);
    const saved = save(r);
    const after = info(importRkt(saved).tree);
    expect(after.massEmpty).toBeCloseTo(before.massEmpty, 10);
    expect(after.cgEmpty).toBeCloseTo(before.cgEmpty, 10);
    expect(saved).not.toMatch(/<MMRocketSim/);
  });

  it.each(['FinSet', 'CustomFinSet', 'TubeFinSet'])('E-E3-2 preserves intentionally overlapping %s rotations on save', tag => {
    // A foreign file still interleaves; the user then deliberately restores zero.
    const r = importRkt(xml(tube(fins('First') + fins('Second', 1, 0, tag))));
    expect(named(r, 'Second')['rotation']).toBeCloseTo(Math.PI / 2, 12);
    named(r, 'Second')['rotation'] = 0;
    const reopened = importRkt(save(r));
    expect(named(reopened, 'Second')['rotation'] ?? 0).toBe(0);
    expect(reopened.noteTiers?.find(n => n.kind === 'I21.fin-rotated')?.text).toMatch(/same angle.*kept.*double/s);
  });

  it.each(['Parachute', 'Streamer', 'LaunchLug', 'FinSet', 'BodyTube', 'ExternalPod'])(
    'L-M4-1 warns that mass-only overrides pin CG on %s', tag => {
    const part = `<${tag}><Name>Mass only</Name><KnownMass>25</KnownMass><UseKnownMass>1</UseKnownMass>
      <Dia>300</Dia><Len>100</Len><OD>20</OD><ID>18</ID><ChuteCount>2</ChuteCount><StreamerCount>2</StreamerCount>
      ${tag === 'ExternalPod' ? `<RadialAngle>0.5</RadialAngle><AttachedParts>${tube('')}</AttachedParts>` : ''}</${tag}>`;
    const r = importRkt(xml(tube(part)));
    const notes: string[] = [];
    const saved = save(r, notes);
    expect(saved).not.toMatch(/<MMRocketSim/);
    expect(notes.join('\n')).toMatch(/mass-only override also pins.*computed CG.*clear the CG override/s);
    const preview: string[] = [];
    exportRkt({ name: r.name, tree: r.tree, notes: preview, dryRun: true });
    expect(preview).toEqual(notes);
    const reopened = importRkt(saved);
    expect(named(reopened, 'Mass only')['overrideMass']).toBeCloseTo(0.025, 12);
    expect(named(reopened, 'Mass only')['overrideCGX']).toBeGreaterThan(0);
    named(reopened, 'Mass only')['overrideCGX'] = 0.01;
    expect(named(importRkt(save(reopened)), 'Mass only')['overrideCGX']).toBeCloseTo(0.01, 12);
  });

  it('L-M4-1 keeps the ruled N-canopy mass and discloses the CG pin', () => {
    const r = importRkt(xml(tube('<Parachute><Name>Canopies</Name><Dia>300</Dia><SideCount>0</SideCount>'
      + '<ChuteCount>2</ChuteCount><DensityType>1</DensityType><Density>0.0067</Density><CalcMass>25.7</CalcMass></Parachute>')));
    const saved = save(r);
    const reopened = importRkt(saved);
    const canopy = named(reopened, 'Canopies');
    const totalKg = 0.0257 + Math.PI * 0.15 ** 2 * 0.067;
    expect(canopy['overrideMass']).toBeCloseTo(totalKg, 12);
    expect(canopy['overrideCGX']).toBeGreaterThan(0);
    const info = () => OrkRocket.buildTree(engineTree(reopened.tree)).componentInfo(canopy.id!);
    const before = info();
    canopy['packedLength'] = (canopy['packedLength'] as number) + 0.02;
    const after = info();
    expect(after.mass).toBeCloseTo(totalKg, 12);
    expect(after.cgX).toBeCloseTo(before.cgX, 12);
    delete canopy['overrideCGX'];
    expect(info().cgX - before.cgX).toBeCloseTo(0.01, 12);
    const doc = parseXml(saved, 'saved');
    const part = doc.querySelector('Parachute')!;
    expect(part.querySelector(':scope > UseKnownCG')?.textContent).toBe('1');
    expect(Number(part.querySelector(':scope > KnownCG')?.textContent)).toBeGreaterThan(0);
  });

  it.each(['Parachute', 'Streamer', 'LaunchLug', 'FinSet', 'BodyTube'])(
    'L-M4-1 sibling: discloses CG-only %s mass pin', tag => {
    const part = `<${tag}><Name>CG only</Name><KnownMass>25</KnownMass><KnownCG>10</KnownCG>
      <UseKnownMass>0</UseKnownMass><UseKnownCG>1</UseKnownCG><Dia>300</Dia><Len>100</Len><OD>20</OD><ID>18</ID></${tag}>`;
    const r = importRkt(xml(tube(part)));
    const notes: string[] = [];
    const saved = save(r, notes);
    expect(saved).not.toContain('<UseKnownMass>0</UseKnownMass>');
    expect(notes.join('\n')).toMatch(/CG-only override also pins.*computed mass.*clear the mass override/s);
    const reopened = importRkt(saved);
    expect(named(reopened, 'CG only')['overrideMass']).toBeGreaterThan(0);
    expect(named(reopened, 'CG only')['overrideCGX']).toBeCloseTo(0.01, 12);
  });

  it('round 3 excludes zero mass and shock cords from the mass-only CG warning', () => {
    const r = importRkt(xml(tube('<MassObject><Name>Cord</Name><TypeCode>1</TypeCode><Len>200</Len>'
      + '<KnownMass>25</KnownMass><UseKnownMass>1</UseKnownMass></MassObject>')));
    named(r, 'Host')['overrideMass'] = 0;
    const notes: string[] = [];
    const reopened = importRkt(save(r, notes));
    expect(notes.join('\n')).not.toContain('mass-only override also pins');
    expect(named(reopened, 'Host')['overrideMass']).toBe(0);
    expect(named(reopened, 'Cord')['overrideCGX']).toBeUndefined();
  });

  it('round 3 warns only for a positive computed counterpart when component information is supplied', () => {
    const r = importRkt(xml(tube('')));
    const host = named(r, 'Host');
    for (const massOnly of [false, true]) {
      delete host['overrideMass'];
      delete host['overrideCGX'];
      host[massOnly ? 'overrideMass' : 'overrideCGX'] = 0.02;
      for (const value of [0, 0.01]) {
        const notes: string[] = [];
        exportRkt({ name: r.name, tree: r.tree, notes,
          compInfo: { [host.id!]: { mass: value, cgX: value } } });
        expect(notes.some(n => n.includes('override also pins'))).toBe(value > 0);
      }
    }
  });

  it('round 3 checks newly added overlapping fins in a file retaining the comment', () => {
    const r = importRkt(xml(tube(fins('First') + fins('Second'))));
    named(r, 'Second')['rotation'] = 0;
    const saved = save(r).replace('</AttachedParts>', fins('Later&#10;fin', 1) + '</AttachedParts>');
    const again = importRkt(saved);
    expect(named(again, 'Later\nfin')['rotation'] ?? 0).toBe(0);
    expect(again.noteTiers?.filter(n => n.kind === 'I21.fin-rotated')).toHaveLength(2);
    expect(again.noteTiers?.find(n => n.text.includes('Laterfin'))?.text).toContain('saved angles are kept');
    const separate = importRkt(saved.replace('<Name>Later&#10;fin</Name>', '<Name>Later&#10;fin</Name><Xb>250</Xb>'));
    expect(separate.noteTiers?.filter(n => n.kind === 'I21.fin-rotated')).toHaveLength(1);
  });

  it.each(['TubeFins2.rkt', 'rocksimTestRocket2.rkt'])('round 3 leaves point mass known-mass flags unchanged in %s', file => {
    const r = importRkt(readFileSync(join(process.cwd(), 'src/services/__fixtures__', file), 'utf8'));
    const notes: string[] = [];
    const saved = save(r, notes);
    const doc = parseXml(saved, 'saved');
    for (const part of Array.from(doc.querySelectorAll('MassObject'))) {
      if (part.querySelector(':scope > TypeCode')?.textContent !== '0') continue;
      expect(part.querySelector(':scope > UseKnownMass')).toBeNull();
    }
    expect(notes.join('\n')).not.toMatch(/Engine hook.*CG-only|Clay.*CG-only|Electronics.*CG-only/);
  });

  it.each(['Parachute', 'Streamer', 'MassObject'])('round 3 discloses unknown recovery density on %s', tag => {
    const r = importRkt(xml(tube(`<${tag}><Name>Odd&#10;fabric</Name><TypeCode>1</TypeCode>
      <DensityType>3</DensityType><Density>0.02</Density><Thickness>1</Thickness></${tag}>`)));
    expect(r.noteTiers?.find(n => n.kind === 'I04.enum')?.text).toMatch(/Oddfabric.*density type.*surface.*desktop.*bulk/s);
  });

  it('C-F3-2 siblings keep missing and unreadable bores at the same default', () => {
    for (const tag of ['TubeFinSet', 'LaunchLug', 'Ring']) {
      const part = `<${tag}><Name>Bore</Name><OD>10</OD><UsageCode>4</UsageCode></${tag}>`;
      const missing = named(importRkt(xml(tube(part))), 'Bore');
      const bad = named(importRkt(xml(tube(part.replace(`</${tag}>`, `<ID>bad</ID></${tag}>`)))), 'Bore');
      expect(bad['thickness']).toEqual(missing['thickness']);
    }
  });

  it.each([0, 1])('L-M4-2 uses true N-streamer CalcMass (density type %i)', type => {
    const part = `<Streamer><Name>Strip</Name><Len>500</Len><Width>50</Width><StreamerCount>3</StreamerCount>
      <DensityType>${type}</DensityType><Density>0.0067</Density><Thickness>1</Thickness><CalcMass>12.3</CalcMass></Streamer>`;
    const r = importRkt(xml(tube(part)));
    const expected = 0.0123 + (type === 1 ? 2 * 0.5 * 0.05 * 0.067 : 0);
    expect(named(r, 'Strip')['overrideMass']).toBeCloseTo(expected, 12);
    expect(named(importRkt(save(r)), 'Strip')['overrideMass']).toBeCloseTo(expected, 12);
  });

  it.each(['', '<DensityType>2</DensityType><Density>0.01</Density>', '<DensityType>1</DensityType>',
    '<DensityType>1.5</DensityType><Density>1</Density>', '<DensityType>1</DensityType><Density>-1</Density>'])(
    'L-M4-2 leaves unusable streamer density unpinned: %s', material => {
    const part = `<Streamer><Name>Strip</Name><Len>500</Len><Width>50</Width><StreamerCount>3</StreamerCount>
      ${material}<CalcMass>12.3</CalcMass></Streamer>`;
    expect(named(importRkt(xml(tube(part))), 'Strip')['overrideMass']).toBeUndefined();
  });
});
