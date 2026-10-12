// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exportRkt, importRkt } from './rocksimFile.js';
import { motorMounts } from '../tree/treeModel.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(join(here, `__fixtures__/${name}.rkt`), 'utf8');
const reverseElements = (xml: string, tag: string) => {
  const elements = [...xml.matchAll(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'))].map(m => m[0]).reverse();
  return xml.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'g'), () => elements.shift()!);
};

// Three fixtures first: audit 2026-10-11, S1b-6 pins the carried mechanisms.
describe('RockSim mount fidelity', () => {
  it.each([false, true])('keeps twins with different mount settings separate (reverse=%s)', reverse => {
    let xml = fixture('twin-tubes-one-mount');
    if (reverse) xml = xml.replace(/<AttachedParts>([\s\S]*?)<\/AttachedParts>/,
      (_, parts: string) => `<AttachedParts>${reverseElements(parts, 'BodyTube')}</AttachedParts>`);
    const r = importRkt(xml);
    const tubes = r.tree.components[0]!.children![0]!.children!;
    expect(tubes).toHaveLength(2);
    expect(motorMounts(r.tree).map(n => n.name)).toEqual(['Mount']);
    expect(tubes.every(n => !n['cluster'] || n['cluster'] === 'single')).toBe(true);
    expect(r.notes.join('\n')).toMatch(/different mount settings/);
    const reopened = importRkt(exportRkt({ name: r.name, tree: r.tree }));
    expect(motorMounts(reopened.tree).map(n => n.name)).toEqual(['Mount']);
    expect(reopened.tree.components[0]!.children![0]!.children).toHaveLength(2);
  });

  it('preserves a base-extension tube turned into a loaded motor mount', () => {
    const r = importRkt(fixture('nose-base-extension-mount'));
    const extension = r.tree.components[0]!.children!.find(n => n['rktBaseExtension'] === true)!;
    expect(extension).toBeDefined();
    extension['motorMount'] = true;
    const xml = exportRkt({ name: r.name, tree: r.tree, motors: {
      [extension.id!]: { designation: 'C6', manufacturer: 'Estes', diameter: 0.018, length: 0.07, delay: 5 },
    } });
    const reopened = importRkt(xml);
    expect(motorMounts(reopened.tree)).toHaveLength(1);
    expect(Object.values(reopened.motors)).toMatchObject([{ designation: 'C6', delay: 5,
      mountId: motorMounts(reopened.tree)[0]!.id }]);
    expect(xml).not.toContain('<MountSerialNo>-1</MountSerialNo>');
  });

  it.each([false, true])('refuses two sets naming one lone mount (reverse=%s)', reverse => {
    const src = fixture('lone-mount-two-sets');
    const r = importRkt(reverse ? reverseElements(src, 'EngineSet') : src);
    expect(r.configs).toHaveLength(1);
    expect(r.configs[0]!.motorLoadoutRefusal).toMatch(/Launch refused.*Simulation 1.*Conflicting sets.*same mount/);
    expect(r.configs[0]!.motors).toEqual({});
    expect(r.motors).toEqual({});
    expect(r.notes.join('\n')).toMatch(/Launch refused/);
  });

  it('keeps a valid later simulation selectable after duplicate sets are refused', () => {
    const src = fixture('lone-mount-two-sets');
    const sim = src.match(/<SimulationResults>[\s\S]*?<\/SimulationResults>/)![0];
    const valid = sim.replace(/<EngineSet><EngineCount>1<\/EngineCount><EngineCode>C6[\s\S]*?<\/EngineSet>/, '')
      .replace('Conflicting sets', 'Valid D12');
    const r = importRkt(src.replace('</SimulationResultsList>', `${valid}</SimulationResultsList>`));
    expect(r.configs).toHaveLength(2);
    expect(r.configs[0]!.motorLoadoutRefusal).toBeDefined();
    expect(r.configs[1]!.motorLoadoutRefusal).toBeUndefined();
    expect(r.chosenConfigId).toBe(r.configs[1]!.id);
    expect(Object.values(r.motors).map(m => m.designation)).toEqual(['D12']);
  });

  it('refuses duplicate identical motors on a lone inner mount and in loose sets', () => {
    const src = fixture('lone-mount-two-sets').replace('<EngineCode>D12</EngineCode>', '<EngineCode>C6</EngineCode>');
    const mount = src.match(/<BodyTube>[\s\S]*?<\/BodyTube>/)![0];
    const nested = src.replace(mount, `<BodyTube><OD>60</OD><ID>58</ID><Len>400</Len>
      <AttachedParts>${mount}</AttachedParts></BodyTube>`);
    for (const xml of [nested, nested.replace(/<\/?SimulationResults>|<SimulationName>[^<]*<\/SimulationName>/g, '')]) {
      const r = importRkt(xml);
      expect(r.configs[0]!.motorLoadoutRefusal).toMatch(/same mount/);
      expect(r.motors).toEqual({});
    }
  });

  describe('loose engine sets on a merged cluster (audit 2026-10-11, S1b-2)', () => {
    const engineSet = (code = 'C6', maker = 'Estes', ejection = '5', ignition = '0') =>
      `<EngineSet><EngineCount>1</EngineCount><EngineCode>${code}</EngineCode>
      <EngineMfg>${maker}</EngineMfg><MountSerialNo>7</MountSerialNo>
      <EjectionDelay>${ejection}</EjectionDelay><IgnitionDelay>${ignition}</IgnitionDelay></EngineSet>`;
    const clusterXml = (sets: string) => fixture('twin-tubes-one-mount')
      .replace('<IsMotorMount>0</IsMotorMount>', '<IsMotorMount>1</IsMotorMount>')
      .replace('</RockSimDocument>', `<Stage3Engines>${sets}</Stage3Engines></RockSimDocument>`);

    describe.each([false, true])('input order reversed=%s', reverse => {
      it.each([
        ['motor code', engineSet('B6')],
        ['manufacturer', engineSet('C6', 'Other maker')],
        ['ejection delay', engineSet('C6', 'Estes', '3')],
        ['ignition delay', engineSet('C6', 'Estes', '5', '2')],
      ])('refuses conflicting %s without loading either motor', (_, conflicting) => {
        const sets = engineSet() + conflicting;
        const r = importRkt(clusterXml(reverse ? reverseElements(sets, 'EngineSet') : sets));
        expect(motorMounts(r.tree)).toHaveLength(1);
        expect(motorMounts(r.tree)[0]!['cluster']).toBe('double');
        expect(r.configs).toHaveLength(1);
        expect(r.configs[0]!.motorLoadoutRefusal).toMatch(/Launch refused.*Simulation \(outside simulations\).*same mount/);
        expect(r.configs[0]!.motors).toEqual({});
        expect(r.motors).toEqual({});
        expect(r.notes).toContain(r.configs[0]!.motorLoadoutRefusal);
      });
    });

    it.each([
      ['legacy single set', engineSet()],
      ['matching sets', engineSet() + engineSet()],
      ['equivalent numeric delays', engineSet() + engineSet('C6', 'Estes', '5.0', '0.0')],
    ])('keeps the full cluster loaded for %s', (_, sets) => {
      const r = importRkt(clusterXml(sets));
      const mounts = motorMounts(r.tree);
      expect(mounts).toHaveLength(1);
      expect(mounts[0]!['cluster']).toBe('double');
      expect(r.configs).toHaveLength(1);
      expect(r.configs[0]!.motorLoadoutRefusal).toBeUndefined();
      expect(Object.values(r.motors)).toMatchObject([
        { mountId: mounts[0]!.id, designation: 'C6', manufacturer: 'Estes', delay: 5 },
      ]);
      expect(r.notes.join('\n')).not.toMatch(/Launch refused/);
    });
  });
});

describe('RockSim shroud line count (audit 2026-10-11, S1b-5)', () => {
  const chute = (count: string) => `<RockSimDocument><DesignInformation><RocketDesign>
    <StageCount>1</StageCount><Stage3Parts><BodyTube><OD>60</OD><ID>58</ID><Len>400</Len>
    <AttachedParts><Parachute><Name>Chute</Name><Dia>300</Dia>${count}<ShroudLineLen>450</ShroudLineLen>
    </Parachute></AttachedParts></BodyTube></Stage3Parts></RocketDesign></DesignInformation></RockSimDocument>`;
  it('retains an explicit zero and its line length through export and reopen', () => {
    const r = importRkt(chute('<ShroudLineCount>0</ShroudLineCount>'));
    const node = r.tree.components[0]!.children![0]!.children![0]!;
    expect(node['lineCount']).toBe(0);
    expect(node['lineLength']).toBeCloseTo(0.45, 10);
    const reopened = importRkt(exportRkt({ name: r.name, tree: r.tree }));
    expect(reopened.tree.components[0]!.children![0]!.children![0]!['lineCount']).toBe(0);
  });
  it.each(['', '<ShroudLineCount>bad</ShroudLineCount>'])('keeps defaults for absent or unreadable counts: %s', count => {
    const r = importRkt(chute(count));
    expect(r.tree.components[0]!.children![0]!.children![0]!['lineCount']).toBeUndefined();
  });
});
