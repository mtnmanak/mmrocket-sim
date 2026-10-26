// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { exportCdx1, importCdx1 } from './rasaeroFile.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import { applyStageNozzles } from '../tree/treeModel.js';
import { MAX_DIMENSION_M } from '../tree/schema.js';
import { checkFormatLoss } from './formatLoss.js';
import { kernelRecoveryCd } from '../tree/kernelDefaults.js';

const xml = (more: string) => `<RASAeroDocument><RocketDesign><BodyTube><PartType>BodyTube</PartType>
  <Length>20</Length><Diameter>3</Diameter></BodyTube></RocketDesign>${more}</RASAeroDocument>`;
const all = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...all(n.children ?? [])]);
describe('RASAero audit regressions', () => {
  it.each([[0.00004, 0], [0.0001, 0.8]])('F5 save discloses Cd %s rounded to zero with vent %s', (cd, hole) => {
    const first = importCdx1(xml(`<Recovery><Event1>True</Event1><EventType1>Apogee</EventType1>
      <Size1>36</Size1><CD1>0.8</CD1></Recovery>`));
    const chute = all(first.tree.components).find(n => n.type === 'parachute')!;
    chute['cd'] = cd;
    chute['diameter'] = 1;
    chute['spillHoleDiameter'] = hole;
    const notes: string[] = [];
    const saved = exportCdx1({ name: first.name, tree: first.tree, launch: DEFAULT_CONDITIONS, notes });
    expect(saved).toContain('<CD1>0</CD1>');
    expect(notes.join('\n')).toMatch(/Drogue.*Cd.*0.*automatic.*0\.8.*drag/i);
    expect(checkFormatLoss('cdx1', { tree: first.tree, motors: {}, launch: DEFAULT_CONDITIONS,
      configs: [], activeConfigId: null, flightData: {}, measured: { massKg: null, cgM: null } }).losses.join('\n'))
      .toMatch(/Drogue.*Cd.*0.*automatic.*0\.8.*drag/i);
    expect(kernelRecoveryCd(all(importCdx1(saved).tree.components).find(n => n.type === 'parachute')!)).toBe(0.8);
  });

  it('F5 nozzle names a Design-tab fallback once across two simulations', () => {
    const r = importCdx1(xml(`<SimulationList>
      <Simulation><SustainerEngine>J350W  (AT)</SustainerEngine><SustainerNozzleDiameter>0</SustainerNozzleDiameter></Simulation>
      <Simulation><SustainerEngine>J350W  (AT)</SustainerEngine><SustainerNozzleDiameter>0</SustainerNozzleDiameter></Simulation>
      </SimulationList>`).replace('</RocketDesign>', '<SustainerNozzle>100000</SustainerNozzle></RocketDesign>'));
    const cautions = r.notes.filter(n => n.includes('nozzle exit diameter'));
    expect(cautions).toHaveLength(1);
    expect(cautions[0]).toMatch(/SustainerNozzle.*Design tab.*100000.*in/);
    expect(cautions[0]).not.toMatch(/simulation/);
    expect(r.configs).toHaveLength(2);
    for (const cfg of r.configs) expect(Object.values(cfg.nozzles!)).toEqual([MAX_DIMENSION_M]);
  });

  it.each([['39370.1', /39370\.10 in/], ['39370.000001', /39370\.000001 in/]])(
    'F5 nozzle distinguishes source %s from the cap near the boundary', (value, shown) => {
      const r = importCdx1(xml(`<SimulationList><Simulation><SustainerEngine>J350W  (AT)</SustainerEngine>
        <SustainerNozzleDiameter>${value}</SustainerNozzleDiameter></Simulation></SimulationList>`));
      const caution = r.notes.find(n => n.includes('nozzle exit diameter'))!;
      expect(caution).toMatch(/simulation 1/);
      expect(caution).toMatch(shown);
      expect(caution).toContain('39370.00 in');
      expect(caution).not.toContain('1000.00 m exceeds');
    });

  it('S1c-3 treats RASAero zero recovery Cd as unset and cautions about automatic drag', () => {
    const first = importCdx1(xml(`<Recovery><Event1>True</Event1><EventType1>Apogee</EventType1>
      <Size1>36</Size1><CD1>0</CD1></Recovery>`));
    const chute = all(first.tree.components).find(n => n.type === 'parachute')!;
    expect(chute['cd']).toBeUndefined();
    expect(kernelRecoveryCd(chute)).toBe(0.8);
    expect(first.noteTiers).toContainEqual(expect.objectContaining({ tier: 'caution',
      text: expect.stringMatching(/Drogue.*drag coefficient of 0.*unset.*automatic Cd of 0\.8.*enter.*Cd/i) }));
  });

  it('S1c-3 discloses that an explicit app zero Cd reopens as automatic', () => {
    const first = importCdx1(xml(`<Recovery><Event1>True</Event1><EventType1>Apogee</EventType1>
      <Size1>36</Size1><CD1>0.8</CD1></Recovery>`));
    const chute = all(first.tree.components).find(n => n.type === 'parachute')!;
    chute['cd'] = 0;
    const notes: string[] = [];
    const saved = exportCdx1({ name: first.name, tree: first.tree, launch: DEFAULT_CONDITIONS, notes });
    const loss = /Drogue.*explicit.*0.*automatic.*0\.8.*drag/i;
    expect(notes.join('\n')).toMatch(loss);
    expect(checkFormatLoss('cdx1', { tree: first.tree, motors: {}, launch: DEFAULT_CONDITIONS,
      configs: [], activeConfigId: null, flightData: {}, measured: { massKg: null, cgM: null } }).losses.join('\n')).toMatch(loss);
    expect(saved).toContain('<CD1>0</CD1>');
    const reopened = all(importCdx1(saved).tree.components).find(n => n.type === 'parachute')!;
    expect(reopened['cd']).toBeUndefined();
    expect(kernelRecoveryCd(reopened)).toBe(0.8);
  });

  it('S1c-3 keeps the LEM-M2B Main automatic with its original canopy and deployment', () => {
    const file = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'LEM-M2B Scratch.CDX1'), 'utf8');
    const result = importCdx1(file);
    const main = all(result.tree.components).find(n => n.name === 'Main')!;
    expect(main['cd']).toBeUndefined();
    expect(kernelRecoveryCd(main)).toBe(0.8);
    expect(main['diameter']).toBeCloseTo(24 / 39.37, 12);
    expect(main['deployEvent']).toBe('altitude');
    expect(main['deployAltitude']).toBeCloseTo(400 / 3.28084, 12);
    expect(result.notes.join('\n')).toMatch(/Main.*drag coefficient of 0.*unset/);
  });

  it('S1c-b2 bounds nozzle diameters before switching to an inactive configuration', () => {
    const r = importCdx1(xml(`<SimulationList>
      <Simulation><SustainerEngine>J350W  (AT)</SustainerEngine><SustainerNozzleDiameter>1</SustainerNozzleDiameter></Simulation>
      <Simulation><SustainerEngine>J350W  (AT)</SustainerEngine><SustainerNozzleDiameter>100000</SustainerNozzleDiameter></Simulation>
      </SimulationList>`));
    const second = r.configs[1]!;
    const switched = applyStageNozzles(r.tree, second.nozzles!);
    expect(switched.components[0]!['nozzleExitDiameter']).toBe(MAX_DIMENSION_M);
    expect(r.notes.join('\n')).toMatch(/SustainerNozzleDiameter.*1000|1000.*SustainerNozzleDiameter/);
    const caution = r.notes.find(n => n.includes('nozzle exit diameter'))!;
    expect(caution).toMatch(/simulation 2.*100000\.00 in.*39370\.00 in/);
    expect(caution).not.toMatch(/rasaero-sim-|2540\.00508/);
  });

  it('D2 describes a design-only oversized nozzle in plain words and rounded units', () => {
    const r = importCdx1(xml('').replace('</RocketDesign>', '<SustainerNozzle>100000</SustainerNozzle></RocketDesign>'));
    const caution = r.notes.find(n => n.includes('nozzle exit diameter'))!;
    expect(caution).toMatch(/Design tab.*100000\.00 in.*39370\.00 in/);
    expect(caution).not.toMatch(/in design:|2540\.00508/);
  });
});
