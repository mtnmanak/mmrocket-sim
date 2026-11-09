// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { importRkt } from './rocksimFile.js';
import { exportCdx1, importCdx1 } from './rasaeroFile.js';
import { retainedLaunchNote } from './importApply.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

const rkt = (parts: string, sims = '') => `<RockSimDocument><DesignInformation><RocketDesign><StageCount>1</StageCount><Stage3Parts>${parts}</Stage3Parts></RocketDesign></DesignInformation>${sims}</RockSimDocument>`;
const tube = '<BodyTube><SerialNo>1</SerialNo><OD>50</OD><Len>300</Len><IsMotorMount>1</IsMotorMount></BodyTube>';
const cdx = (parts: string, extra = '') => `<RASAeroDocument><RocketDesign>${parts}</RocketDesign>${extra}</RASAeroDocument>`;
const body = '<BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube>';
const all = (ns: ComponentNode[]): ComponentNode[] => ns.flatMap(n => [n, ...all(n.children ?? [])]);

describe('H5b import fidelity', () => {
  const recoverySlot = (slot: number) => `<Event${slot}>true</Event${slot}><EventType${slot}>Apogee</EventType${slot}><DeviceType${slot}>Parachute</DeviceType${slot}><Altitude${slot}>500</Altitude${slot}><Size${slot}>36</Size${slot}><CD${slot}>0.8</CD${slot}>`;
  it.each(['DeviceType', 'Event'])('HF4 r3 allows absent unused altitude with untrimmed %s', field => {
    for (const slot of [1, 2]) {
      const value = field === 'DeviceType' ? 'Parachute' : 'true';
      for (const replacement of [`<${field}${slot}/>`, `<${field}${slot}> ${value}</${field}${slot}>`, `<${field}${slot}>${value} </${field}${slot}>`]) {
        let fields = (recoverySlot(1) + recoverySlot(2)).replace(`<${field}${slot}>${value}</${field}${slot}>`, replacement);
        // Unknown devices do not unbox their own altitude; a disabled first
        // slot also disables the second.
        fields = fields.replace(`<Altitude${slot}>500</Altitude${slot}>`, '');
        if (slot === 1 && field === 'Event') fields = fields.replace('<Altitude2>500</Altitude2>', '');
        const r = importCdx1(cdx(body, `<Recovery>${fields}</Recovery>`));
        const notes = r.noteTiers?.filter(n => n.kind === 'I04.recovery-event').map(n => n.text).join(' ');
        expect(notes).not.toContain('desktop OpenRocket cannot import');
        expect(notes).not.toContain('use an Altitude event');
        const expectedCount = field !== 'DeviceType' && replacement.endsWith('/>') ? (slot === 1 ? 0 : 1) : 2;
        expect(all(r.tree.components).filter(n => n.type === 'parachute').map(n => n['deployEvent'])).toEqual(Array(expectedCount).fill('apogee'));
      }
    }
  });
  it.each([1, 2])('HF4 r3 still names missing required Altitude%s', slot => {
    const fields = (recoverySlot(1) + recoverySlot(2)).replace(`<Altitude${slot}>500</Altitude${slot}>`, '');
    const r = importCdx1(cdx(body, `<Recovery>${fields}</Recovery>`));
    const notes = r.noteTiers?.filter(n => n.kind === 'I04.recovery-event').map(n => n.text).join(' ');
    expect(notes).toContain(`Altitude${slot}`);
    expect(notes).toContain('desktop OpenRocket cannot import');
    expect(notes).not.toContain('use an Altitude event');
  });
  it('HF4 r2 sibling parity notes require exact desktop strings and successful file import', () => {
    const fields = recoverySlot(1).replace('<EventType1>Apogee</EventType1>', '<EventType1> None</EventType1>') + recoverySlot(2);
    const disabled = importCdx1(cdx(body, `<Recovery>${fields}</Recovery>`));
    expect(disabled.noteTiers?.find(n => n.kind === 'I04.recovery-disabled')?.text).toContain('untrimmed Event1 is false or EventType1 is exactly None, if the file opens there');
    const none = importCdx1(cdx(body, `<Recovery>${recoverySlot(1)}${recoverySlot(2).replace('Parachute', ' None')}</Recovery>`));
    expect(none.noteTiers?.find(n => n.kind === 'I04.recovery-none')?.text).toContain('untrimmed DeviceType is exactly None, if the file opens there');
    expect(all(none.tree.components).filter(n => n.type === 'parachute').map(n => n['diameter'])).toEqual([36 / 39.37, 0]);
  });
  it.each(['<SustainerLaunchWt>&#160;10</SustainerLaunchWt>', '<SustainerCG>&#160;15</SustainerCG>'])('HF4 r2 qualifies paired recovery for non-recovery numbers: %s', field => {
    const r = importCdx1(cdx(body, `<Recovery>${recoverySlot(1)}${recoverySlot(2)}</Recovery><SimulationList><Simulation>${field}</Simulation></SimulationList>`));
    const note = r.noteTiers?.find(n => n.kind === 'I04.recovery-event')?.text;
    expect(note).toContain('when it can import the file');
    expect(note).toContain('hand-edited numeric fields can prevent that');
    expect(all(r.tree.components).filter(n => n.type === 'parachute').map(n => n['deployEvent'])).toEqual(['apogee', 'apogee']);
  });
  it.each(['DeviceType', 'EventType', 'Event'])('HF4 r2 checks untrimmed %s strings in either slot', field => {
    for (const slot of [1, 2]) {
      const value = field === 'DeviceType' ? 'Parachute' : field === 'EventType' ? 'Apogee' : 'true';
      for (const replacement of [`<${field}${slot}/>`, `<${field}${slot}> ${value}</${field}${slot}>`, `<${field}${slot}>${value} </${field}${slot}>`]) {
        const fields = (recoverySlot(1) + recoverySlot(2)).replace(`<${field}${slot}>${value}</${field}${slot}>`, replacement);
        const r = importCdx1(cdx(body, `<Recovery>${fields}</Recovery>`));
        const notes = r.noteTiers?.filter(n => n.kind === 'I04.recovery-event').map(n => n.text).join(' ');
        expect(notes).not.toContain('RASAero itself and desktop OR use an Altitude event');
        expect(notes).not.toContain('desktop OpenRocket cannot import');
        const expectedCount = field !== 'DeviceType' && replacement.endsWith('/>') ? (slot === 1 ? 0 : 1) : 2;
        expect(all(r.tree.components).filter(n => n.type === 'parachute')).toHaveLength(expectedCount);
      }
    }
  });
  it('HF4 r2 qualifies paired recovery for a Java-incompatible body length', () => {
    const r = importCdx1(cdx(body.replace('<Length>20', '<Length>&#160;20'), `<Recovery>${recoverySlot(1)}${recoverySlot(2)}</Recovery>`));
    expect(r.noteTiers?.find(n => n.kind === 'I04.recovery-event')?.text).toContain('when it can import the file');
    expect(all(r.tree.components).filter(n => n.type === 'parachute').map(n => n['deployEvent'])).toEqual(['apogee', 'apogee']);
  });
  it('HF4 qualifies desktop stage override claims for permissively parsed weights', () => {
    const r = importCdx1(cdx(body, '<SimulationList><Simulation><SustainerEngine>M787  (KIP)</SustainerEngine><SustainerLaunchWt>&#160;10</SustainerLaunchWt><SustainerCG>15</SustainerCG></Simulation></SimulationList>'));
    expect(r.noteTiers?.find(n => n.kind === 'I17.stage-overrides')?.text).toContain('when it can import the file');
  });
  it.each([1, 2])('HF4 discloses missing DeviceType%s in paired Apogee', slot => {
    const fields = (recoverySlot(1) + recoverySlot(2)).replace(`<DeviceType${slot}>Parachute</DeviceType${slot}>`, '');
    const r = importCdx1(cdx(body, `<Recovery>${fields}</Recovery>`));
    const notes = r.noteTiers?.filter(n => n.kind === 'I04.recovery-event').map(n => n.text).join(' ');
    expect(notes).toContain(`DeviceType${slot}`);
    expect(notes).toContain('desktop OpenRocket cannot import');
    expect(notes).not.toContain('use an Altitude event');
    expect(all(r.tree.components).filter(n => n.type === 'parachute').map(n => n['deployEvent'])).toEqual(['apogee', 'apogee']);
  });
  it.each(['Size', 'CD', 'Altitude'])('HF4 discloses empty %s2 in a disabled slot', field => {
    const r = importCdx1(cdx(body, `<Recovery>${recoverySlot(1)}<Event2>false</Event2><${field}2/></Recovery>`));
    expect(r.noteTiers?.find(n => n.kind === 'I04.recovery-event')?.text).toContain(`${field}2`);
    expect(r.noteTiers?.find(n => n.kind === 'I04.recovery-event')?.text).toContain('desktop OpenRocket cannot import');
    expect(all(r.tree.components).filter(n => n.type === 'parachute')).toHaveLength(1);
  });
  it.each(['Altitude', 'Size', 'CD'])('HF4 checks raw %s in either slot for Java-incompatible whitespace', field => {
    for (const slot of [1, 2]) {
      for (const space of ['&#160;', '&#8195;', '&#65279;']) {
        const fields = (recoverySlot(1) + recoverySlot(2)).replace(`<${field}${slot}>`, `<${field}${slot}>${space}`);
        const r = importCdx1(cdx(body, `<Recovery>${fields}</Recovery>`));
        const notes = r.noteTiers?.filter(n => n.kind === 'I04.recovery-event').map(n => n.text).join(' ');
        expect(notes).toContain(`${field}${slot}`);
        expect(notes).toContain('desktop OpenRocket cannot import');
        expect(notes).not.toContain('use an Altitude event');
        expect(all(r.tree.components).filter(n => n.type === 'parachute').map(n => n['deployEvent'])).toEqual(['apogee', 'apogee']);
      }
    }
  });
  it.each([[1, 1.019, 1], [1, 1.021, 2], [3, 3.059, 1], [3, 3.062, 2]])('folds burns %s / %s into %s configurations', (a, b, count) => {
    for (const burns of [[a, b], [b, a]]) {
      const sims = burns.map(burn => `<SimulationResults><TimeToBurnout>${burn}</TimeToBurnout><Stage3Engines><EngineSet><EngineCode>E15</EngineCode><EngineMfg>AeroTech</EngineMfg><MountSerialNo>1</MountSerialNo><EngineCount>1</EngineCount><IgnitionDelay>0</IgnitionDelay><EjectionDelay>7</EjectionDelay></EngineSet></Stage3Engines></SimulationResults>`).join('');
      expect(importRkt(rkt(tube, sims)).configs).toHaveLength(count);
    }
  });
  it('retains parentheses in a designation with an unparenthesized maker', () => {
    const r = importCdx1(cdx(body, '<SimulationList><Simulation><SustainerEngine>G80(test)  AT</SustainerEngine></Simulation></SimulationList>'));
    expect(Object.values(r.motors)[0]?.designation).toBe('G80(test)');
    expect(Object.values(r.motors)[0]?.manufacturer).toBe('AT');
    expect(r.noteTiers?.some(n => n.kind === 'I12.unattached-motors')).not.toBe(true);
  });
  it.each([['G80 (T)  AT', 'G80 (T)', 'AT'], ['X (y)  Estes', 'X (y)', 'Estes']])(
    'still loads %j as v0.197 and desktop OR do (a parenthesized word after the first)', (engine, designation, maker) => {
      const r = importCdx1(cdx(body, `<SimulationList><Simulation><SustainerEngine>${engine}</SustainerEngine></Simulation></SimulationList>`));
      expect(Object.values(r.motors)[0]?.designation).toBe(designation);
      expect(Object.values(r.motors)[0]?.manufacturer).toBe(maker);
      expect(r.noteTiers?.some(n => n.kind === 'I12.unattached-motors')).not.toBe(true);
    });
  it('tells browser users which conditions survive a refused site', () => {
    expect(retainedLaunchNote('rkt', DEFAULT_CONDITIONS, undefined, true)).toContain('settings you had');
  });
  it.each([[undefined, 2.6], [2.6, undefined]])('folds missing burn evidence with available evidence: %j', (...burns) => {
    const sims = burns.map(burn => `<SimulationResults>${burn === undefined ? '' : `<TimeToBurnout>${burn}</TimeToBurnout>`}<Stage3Engines><EngineSet><EngineCode>H123W</EngineCode><EngineMfg>AeroTech</EngineMfg><MountSerialNo>1</MountSerialNo><EngineCount>1</EngineCount><IgnitionDelay>0</IgnitionDelay><EjectionDelay>14</EjectionDelay></EngineSet></Stage3Engines></SimulationResults>`).join('');
    const r = importRkt(rkt(tube, sims));
    expect(r.configs).toHaveLength(1);
    expect(Object.values(r.configs![0]!.motors)[0]?.rktBurnTimeS).toBeCloseTo(2.6);
  });
  it.each(['G80  Aero Tech', 'A' + ' '.repeat(25600) + 'Aero Tech'])('keeps unparenthesized multi-word makers', engine => {
    const r = importCdx1(cdx(body, `<SimulationList><Simulation><SustainerEngine>${engine}</SustainerEngine></Simulation></SimulationList>`));
    expect(Object.values(r.motors)[0]?.manufacturer).toBe('Aero Tech');
  });
  it('rejects a suffix after a parenthesized maker', () => {
    const r = importCdx1(cdx(body, '<SimulationList><Simulation><SustainerEngine>K550  (AT)  x</SustainerEngine></Simulation></SimulationList>'));
    expect(Object.values(r.motors)).toHaveLength(0);
  });
  it.each(['', '0x10', 'bad'])('discloses unreadable single-slot altitude %j', value => {
    const r = importCdx1(cdx(body, `<Recovery><Event1>true</Event1><EventType1>Altitude</EventType1><Altitude1>${value}</Altitude1></Recovery>`));
    expect(r.noteTiers?.find(n => n.kind === 'I04.recovery-event')?.text).toContain('desktop OpenRocket cannot import');
  });
  it.each(['Infinity', '1d', '1f', '0x1.0p4'])('recognizes Java altitude spelling %s', value => {
    const r = importCdx1(cdx(body, `<Recovery>${recoverySlot(1)}${recoverySlot(2).replace('<Altitude2>500</Altitude2>', `<Altitude2>${value}</Altitude2>`)}</Recovery>`));
    expect(r.noteTiers?.find(n => n.kind === 'I04.recovery-event')?.text).toContain('use an Altitude event');
  });
  it('trims an altitude with a long inner run of spaces in linear time', () => {
    // The old regex trim (/^[\x00-\x20]+|[\x00-\x20]+$/g) took ~20 s here: quadratic in the run.
    const value = `1${' '.repeat(300_000)}x`;
    const r = importCdx1(cdx(body, `<Recovery><Event1>true</Event1><EventType1>Apogee</EventType1><Altitude1>500</Altitude1><Size1>36</Size1><CD1>0.8</CD1><Event2>true</Event2><EventType2>Apogee</EventType2><Size2>36</Size2><CD2>0.8</CD2><Altitude2>${value}</Altitude2></Recovery>`));
    expect(r.noteTiers?.find(n => n.kind === 'I04.recovery-event')?.text).toContain('desktop OpenRocket cannot import');
  });
  it.each(['NoseCone', 'Transition', 'FinSet'])('discloses unsupported %s geometry', tag => {
    const part = `<${tag}><ShapeCode>9</ShapeCode></${tag}>`;
    const r = importRkt(rkt(tag === 'FinSet' ? tube.replace('</BodyTube>', `<AttachedParts>${part}</AttachedParts></BodyTube>`) : part));
    expect(r.noteTiers?.some(n => n.tier === 'caution' && /Unknown RockSim.*shape code 9/i.test(n.text))).toBe(true);
  });
  it('keeps the refused-site caution host neutral', () => {
    const r = importRkt(rkt(tube, '<SimulationResults><LaunchLatitude>0</LaunchLatitude><LaunchLongitude>0</LaunchLongitude></SimulationResults>'));
    const note = r.noteTiers?.find(n => n.kind === 'I24.site-retained')?.text;
    expect(note).toContain('Check the launch conditions');
    expect(note).not.toContain('Launch panel');
  });
  it('qualifies the density caution for an overridden cord', () => {
    const r = importRkt(rkt(tube.replace('</BodyTube>', '<AttachedParts><MassObject><TypeCode>1</TypeCode><DensityType>0</DensityType><Density>0.02</Density><UseKnownCG>1</UseKnownCG><KnownMass>25</KnownMass></MassObject></AttachedParts></BodyTube>')));
    expect(all(r.tree.components).find(n => n.type === 'shockcord')?.['overrideMass']).toBeCloseTo(0.025);
    expect(r.noteTiers?.find(n => n.kind === 'I04.cord-density')?.text).toContain('mass override');
  });
  it.each([[1.76, 2.72], [2.72, 1.76]])('preserves differing burn evidence in order %j', (...burns) => {
    const sims = burns.map(burn => `<SimulationResults><TimeToBurnout>${burn}</TimeToBurnout><Stage3Engines><EngineSet><EngineCode>E15</EngineCode><EngineMfg>AeroTech</EngineMfg><MountSerialNo>1</MountSerialNo><EngineCount>1</EngineCount><IgnitionDelay>0</IgnitionDelay><EjectionDelay>7</EjectionDelay></EngineSet></Stage3Engines></SimulationResults>`).join('');
    const r = importRkt(rkt(tube, sims));
    expect(r.configs).toHaveLength(2);
    expect(r.configs?.map(c => Object.values(c.motors)[0]?.rktBurnTimeS)).toEqual(burns);
  });
  it.each(['', '<Altitude2>bad</Altitude2>'])('explains invalid paired-apogee altitude: %s', altitude => {
    const slots = [1, 2].map(i => `<Event${i}>true</Event${i}><EventType${i}>Apogee</EventType${i}><DeviceType${i}>Parachute</DeviceType${i}><Size${i}>36</Size${i}>`).join('');
    const r = importCdx1(cdx(body, `<Recovery>${slots}${altitude}</Recovery>`));
    expect(r.noteTiers?.find(n => n.kind === 'I04.recovery-event')?.text).toContain('desktop OpenRocket cannot import');
  });
  it.each(['0.5', '5e-324'])('derives a finite lug angle from repaired negative tube dimensions (lug %s)', diameter => {
    const r = importCdx1(cdx(body.replace('<Diameter>3', '<Diameter>-2').replace('</BodyTube>', `<LaunchLugDiameter>${diameter}</LaunchLugDiameter><LaunchLugLength>1</LaunchLugLength></BodyTube>`)));
    expect(all(r.tree.components).find(n => n.type === 'launchlug')?.['angleOffset']).toBeCloseTo(-Math.PI);
  });
  it('retains internal spaces in a motor designation', () => {
    const r = importCdx1(cdx(body, '<SimulationList><Simulation><SustainerEngine>A  B  (AT)</SustainerEngine></Simulation></SimulationList>'));
    expect(Object.values(r.motors)[0]?.designation).toBe('A  B');
    const xml = exportCdx1({ name: 'Spaced motor', tree: r.tree, motors: r.motors });
    expect(Object.values(importCdx1(xml).motors)[0]?.designation).toBe('A  B');
  });
  it.each([20, 23])('round trips a boat tail at station %s inches', station => {
    const r = importCdx1(cdx(body + '<Transition><Length>3</Length><RearDiameter>2</RearDiameter></Transition><BoatTail><Length>2</Length><RearDiameter>1</RearDiameter></BoatTail><Booster><Length>10</Length><Diameter>2</Diameter></Booster>'));
    const pod = all(r.tree.components).find(n => n.name === 'Boat tail pod')!;
    pod.position = { method: 'top', offset: station / 39.37 };
    const xml = exportCdx1({ name: 'Tail', tree: r.tree, motors: {} });
    const back = all(importCdx1(xml).tree.components).find(n => n.name === 'Boat tail pod')!;
    expect(back.position?.offset).toBeCloseTo(station / 39.37, 8);
  });
});
