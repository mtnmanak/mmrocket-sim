// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  applyDesignNameFallback, designFileOpenFailure, designFileTooLarge, designFormatOf, GENERIC_ROCKET_NAMES,
  MAX_DESIGN_FILE_BYTES, openDesignFile, parseDesignFile,
} from './designFile.js';
import type { ImportedDesign } from './importApply.js';
import { exportCdx1 } from './rasaeroFile.js';
import { exportOrk } from './orkFile.js';
import { resolveFlightState } from './flightState.js';
import { gzipSync, zipSync } from 'fflate';

/**
 * THE FILE DOOR (2026-10-01): the size refusal, the format dispatch, the name
 * fallback and the open-failure sentence App's Open… used inline, moved here
 * so the headless open (simulateFile.ts) refuses, parses, names and words
 * exactly what the app does. Their sentences moved verbatim.
 */

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'version.json'))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}
const fixture = (name: string): ArrayBuffer => {
  const buf = readFileSync(join(repoRoot(), 'packages', 'app', 'src', 'services', '__fixtures__', name));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

describe('designFileTooLarge', () => {
  it('refuses one byte over 64 MiB with App’s sentence, and lets 64 MiB itself through', () => {
    expect(MAX_DESIGN_FILE_BYTES).toBe(64 * 1024 * 1024);
    expect(designFileTooLarge(MAX_DESIGN_FILE_BYTES + 1, 'huge.ork'))
      .toBe('huge.ork is 64 MB — that is not a rocket design. Nothing was opened.');
    expect(designFileTooLarge(MAX_DESIGN_FILE_BYTES, 'big.ork')).toBeNull();
    expect(designFileTooLarge(0, 'empty.ork')).toBeNull();
  });
});

describe('designFormatOf', () => {
  it('reads the extension, any case, and takes anything else for a .ork', () => {
    expect(designFormatOf('a.rkt')).toBe('rkt');
    expect(designFormatOf('a.RKT')).toBe('rkt');
    expect(designFormatOf('a.CDX1')).toBe('cdx1');
    expect(designFormatOf('a.cdx1')).toBe('cdx1');
    expect(designFormatOf('a.ork')).toBe('ork');
    expect(designFormatOf('a.zip')).toBe('ork');
    expect(designFormatOf('rkt.ork')).toBe('ork');
  });
});

describe('applyDesignNameFallback', () => {
  const named = (name: string | undefined): ImportedDesign =>
    ({ name: name ?? '', tree: { name, components: [] }, motors: {}, notes: [] }) as unknown as ImportedDesign;

  it('names a generic or unnamed design after its file: extension off, underscores to spaces', () => {
    for (const generic of ['Rocket', 'new rocket', ' Imported RASAero rocket ', 'IMPORTED ROCKSIM ROCKET', 'My Rocket']) {
      const d = named(generic);
      applyDesignNameFallback(d, 'Big_Bertha_v2.CDX1');
      expect(d.tree.name, generic).toBe('Big Bertha v2');
      expect(d.name).toBe('Big Bertha v2');
    }
    const blank = named(undefined);
    applyDesignNameFallback(blank, 'x.rkt');
    expect(blank.tree.name).toBe('x');
    expect(GENERIC_ROCKET_NAMES.has('imported rasaero rocket')).toBe(true);
  });

  it('keeps a real name, and a file name that is all extension changes nothing', () => {
    const d = named('Wildman');
    applyDesignNameFallback(d, 'other.ork');
    expect(d.tree.name).toBe('Wildman');
    const e = named('Rocket');
    applyDesignNameFallback(e, '.ork');
    expect(e.tree.name).toBe('Rocket');
  });
});

describe('designFileOpenFailure', () => {
  it('names the format the user picked, and the importer’s own words', () => {
    expect(designFileOpenFailure('a.rkt', new Error('This is an older BINARY RockSim file')))
      .toBe('Could not open that .rkt file: This is an older BINARY RockSim file');
    expect(designFileOpenFailure('a.cdx1', new Error('x'))).toBe('Could not open that .CDX1 file: x');
    expect(designFileOpenFailure('a.ORK', 'plain')).toBe('Could not open that .ork file: plain');
    expect(designFileOpenFailure('a.txt', new Error('y'))).toBe('Could not open that file: y');
  });
});

describe('parseDesignFile and openDesignFile', () => {
  const siteFile = (format: string, altitude: number, sibling = false): ArrayBuffer => {
    const sites = [[26.380273, 80.126879], ...(sibling ? [[28.1, -80.63]] : [])];
    const xml = format === 'ork'
      ? `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket><name>Site</name>
        ${sites.map((_, i) => `<motorconfiguration configid="c${i}" default="${i === 0}"/>`).join('')}
        <subcomponents><stage><subcomponents><bodytube><length>0.5</length><radius>0.03</radius>
        </bodytube></subcomponents></stage></subcomponents></rocket><simulations>
        ${sites.map(([lat, lon], i) => `<simulation><name>Site ${i}</name><conditions><configid>c${i}</configid>
        <launchlatitude>${lat}</launchlatitude><launchlongitude>${lon}</launchlongitude>
        <launchaltitude>${altitude}</launchaltitude></conditions></simulation>`).join('')}</simulations></openrocket>`
      : format === 'rkt'
        ? `<RockSimDocument><DesignInformation><RocketDesign><Name>Site</Name><StageCount>1</StageCount>
          <Stage3Parts><BodyTube><Name>Body</Name><OD>54</OD><ID>52</ID><Len>300</Len>
          <IsMotorMount>1</IsMotorMount><SerialNo>1</SerialNo></BodyTube></Stage3Parts></RocketDesign></DesignInformation>
          <SimulationResultsList>${sites.map(([lat, lon], i) => `<SimulationResults>
          <LaunchLatitude>${lat}</LaunchLatitude><LaunchLongitude>${lon}</LaunchLongitude><LaunchAltitude>${altitude}</LaunchAltitude>
          <Stage3Engines><EngineSet><EngineCode>F${20 + i}W</EngineCode><MountSerialNo>1</MountSerialNo>
          <EjectionDelay>6</EjectionDelay></EngineSet></Stage3Engines></SimulationResults>`).join('')}</SimulationResultsList></RockSimDocument>`
        : `<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube>
          </RocketDesign><LaunchSite><Altitude>${altitude}</Altitude></LaunchSite></RASAeroDocument>`;
    return new TextEncoder().encode(xml).buffer;
  };

  it.each(['ork', 'rkt', 'CDX1'])('N032 clamped %s site notes quote file evidence but read field bounds in Altitude', async format => {
    for (const [altitude, upper] of [['km', '10 km'], ['ft', '32808.399 ft']]) {
      for (const high of [true, false]) {
        const source = format === 'CDX1' ? (high ? 150000 : -1000) : (high ? 20000 : -100);
        const data = siteFile(format, source);
        const baseline = await parseDesignFile(data, `site.${format}`, { presets: [] });
        const imported = await parseDesignFile(data, `site.${format}`, { presets: [], distanceUnit: altitude,
          horizontalDistanceUnit: altitude === 'km' ? 'ft' : 'km' });
        const note = imported.notes.find(n => n.includes('Site altitude field'));
        expect.soft(note).toContain(`altitude is ${source} ${format === 'CDX1' ? 'ft' : 'm'}`);
        expect.soft(note).toContain(`accepts 0 ${altitude} to ${upper}`);
        expect.soft(note).toContain(`imported as ${high ? upper : `0 ${altitude}`}`);
        expect(imported.launch).toEqual(baseline.launch);
        expect(imported.launch!.launchAltitudeM).toBe(high ? 10000 : 0);
        expect(imported.noteTiers?.filter(n => n.kind === 'I25.clamped').map(n => n.tier)).toEqual(['caution']);
        expect(data).toEqual(siteFile(format, source));
      }
    }
  });

  it.each(['ork', 'rkt'])('N032 new %s longitude distances follow Horizontal distance independently of Altitude', async format => {
    const data = siteFile(format, 100, true);
    const baseline = await parseDesignFile(data, `site.${format}`, { presets: [] });
    for (const [altitude, horizontalDistanceUnit, away, nearby] of [
      ['ft', 'mi', '8,500 mi', '100 mi'], ['km', 'yd', '8,500 mi', '100 mi'],
      ['mi', 'm', '13,600 km', '200 km'], ['ft', 'km', '13,600 km', '200 km'],
    ]) {
      const imported = await parseDesignFile(data, `site.${format}`, { presets: [], distanceUnit: altitude, horizontalDistanceUnit });
      const note = imported.notes.find(n => n.includes('sign flipped'));
      expect.soft(note).toContain(`${away} away. With the sign flipped it is ${nearby} from them.`);
      expect(note).toContain('26.380273, 80.126879 (east)');
      expect(note).toContain('28.1, -80.63 (west)');
      expect(imported.launch).toEqual(baseline.launch);
      expect(imported.longitudeCheck).toEqual(baseline.longitudeCheck);
      expect(imported.launch).toMatchObject({ latitudeDeg: 26.380273, longitudeDeg: 80.126879 });
      // Synthetic coordinate evidence, unchanged by display units; not a flown trajectory.
      expect(imported.longitudeCheck!.distanceKm).toBeCloseTo(13618, 0);
      expect(imported.longitudeCheck!.flippedDistanceKm).toBeCloseTo(198, 0);
    }
  });

  it.each([
    ['m', '152.4 m', '91.44 m'], ['km', '0.152 km', '0.0914 km'],
    ['ft', '500 ft', '300 ft'], ['yd', '166.667 yd', '100 yd'], ['mi', '0.0947 mi', '0.0568 mi'],
  ])('N032 new .ork override heights follow Altitude %s without changing SI or the file', async (altitude, flown, own) => {
    const recovery = (kind: string) => `<${kind}><name>${kind}</name>
      <deployevent>altitude</deployevent><deployaltitude>91.44</deployaltitude><deploydelay>0</deploydelay>
      <deploymentconfiguration configid="cfg-a"><deployevent>altitude</deployevent>
        <deployaltitude>152.4</deployaltitude><deploydelay>0</deploydelay></deploymentconfiguration></${kind}>`;
    const booster = (event: string) => `<stage><name>${event}</name>
      <separationevent>${event}</separationevent><separationaltitude>91.44</separationaltitude><separationdelay>0</separationdelay>
      <separationconfiguration configid="cfg-a"><separationevent>${event}</separationevent>
        <separationaltitude>152.4</separationaltitude><separationdelay>0</separationdelay></separationconfiguration>
      <subcomponents><bodytube><length>0.2</length><radius>0.02</radius></bodytube></subcomponents></stage>`;
    const xml = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket><name>Heights</name>
      <motorconfiguration configid="cfg-a" default="true"><name>Height overrides</name>
        <stage number="0" active="true"/><stage number="1" active="true"/><stage number="2" active="true"/></motorconfiguration>
      <subcomponents><stage><name>Sustainer</name><subcomponents><bodytube><length>0.4</length><radius>0.02</radius>
        <subcomponents>${recovery('parachute')}${recovery('streamer')}</subcomponents></bodytube></subcomponents></stage>
        ${booster('altitudeascending')}${booster('altitudedescending')}</subcomponents></rocket></openrocket>`;
    const data = new TextEncoder().encode(xml).buffer;
    const units = { altitude, distance: altitude === 'km' ? 'ft' : 'km' };
    const baseline = await parseDesignFile(data, 'heights.ork', { presets: [] });
    const imported = await parseDesignFile(data, 'heights.ork', { presets: [], distanceUnit: units.altitude });
    const note = imported.notes.find(n => n.startsWith('Recovery:'));
    for (const kind of ['parachute', 'streamer']) {
      expect.soft(note).toContain(`${kind} flies at Altitude (descending), ${flown}, not at its own setting (Altitude (descending), ${own})`);
    }
    for (const direction of ['ascending', 'descending']) {
      const separation = imported.notes.find(n => n.includes(`overrides separation for altitude${direction}:`));
      expect.soft(separation).toContain(`it uses Altitude (${direction}), ${flown}, not the stage's own setting (Altitude (${direction}), ${own})`);
    }
    expect(imported.noteTiers?.filter(n => n.kind === 'I10.config-override').map(n => n.tier))
      .toEqual(['caution', 'caution', 'caution']);
    expect(imported.configLabelNotes?.map(n => n.text))
      .toEqual(imported.notes.filter(n => n.startsWith('Recovery:') || n.includes('overrides separation for')));
    const settings = (d: ImportedDesign) => {
      const devices = d.tree.components[0]!.children![0]!.children!;
      return { ownDeployments: devices.map(n => [n['deployEvent'], n['deployAltitude'], n['deployDelay']]),
        ownSeparations: d.tree.components.slice(1).map(n => [n['separationEvent'], n['separationAltitude'], n['separationDelay'] ?? 0]),
        deployments: Object.values(d.configs![0]!.deployments), separations: Object.values(d.configs![0]!.separations) };
    };
    expect(settings(imported)).toEqual(settings(baseline));
    expect(settings(imported).ownDeployments).toEqual([['altitude', 91.44, 0], ['altitude', 91.44, 0]]);
    expect(settings(imported).ownSeparations).toEqual([['altitudeascending', 91.44, 0], ['altitudedescending', 91.44, 0]]);
    expect(settings(imported).deployments).toEqual([
      { deployEvent: 'altitude', deployAltitude: 152.4, deployDelay: 0 },
      { deployEvent: 'altitude', deployAltitude: 152.4, deployDelay: 0 },
    ]);
    expect(settings(imported).separations).toEqual([
      { separationEvent: 'altitudeascending', separationAltitude: 152.4, separationDelay: 0 },
      { separationEvent: 'altitudedescending', separationAltitude: 152.4, separationDelay: 0 },
    ]);
    const effective = (d: ImportedDesign) => resolveFlightState(d.tree,
      d.configs!.map(c => ({ ...c, motors: {} })), d.chosenConfigId!, {}, {}).tree;
    expect(effective(imported).components[0]!.children![0]!.children!.map(n => n['deployAltitude'])).toEqual([152.4, 152.4]);
    expect(effective(imported).components.slice(1).map(n => n['separationAltitude'])).toEqual([152.4, 152.4]);
    // The writer mints component UUIDs on each save; only those identities differ.
    const written = (d: ImportedDesign) => exportOrk({ name: d.name, tree: d.tree, motors: d.motors,
      configs: d.configs, activeConfigId: d.chosenConfigId }).replace(/<id>[^<]*<\/id>/g, '<id/>');
    expect(written(imported)).toBe(written(baseline));
  });

  it.each([
    ['m', '305 m', '1189 m'], ['km', '0.3 km', '1.19 km'],
    ['ft', '1000 ft', '3900 ft'], ['yd', '333 yd', '1300 yd'], ['mi', '0.19 mi', '0.74 mi'],
  ])('N032 new RASAero height notes follow Altitude %s without changing SI or the file', async (distanceUnit, top, pad) => {
    const xml = '<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube>'
      + '</RocketDesign><MachAlt><Item>0, 0</Item><Item>1, 1000</Item><Item>2, 500</Item></MachAlt>'
      + '<LaunchSite><Altitude>3900</Altitude><Pressure>30</Pressure><Temperature>90</Temperature></LaunchSite>'
      + '</RASAeroDocument>';
    const data = new TextEncoder().encode(xml).buffer;
    const baseline = await parseDesignFile(data, 'heights.CDX1', { presets: [] });
    const imported = await parseDesignFile(data, 'heights.CDX1', { presets: [], distanceUnit });
    expect(imported.notes.find(note => note.includes('Mach-Alt conditions table'))).toContain(`3 points, to ${top})`);
    expect(imported.notes.find(note => note.startsWith('Launch site:'))).toContain(`the pad is at ${pad} where`);
    expect(baseline.notes.find(note => note.includes('Mach-Alt conditions table'))).toContain('to 1000 ft)');
    expect(baseline.notes.find(note => note.startsWith('Launch site:'))).toContain('at 3900 ft where');
    expect(imported.machAlt).toEqual(baseline.machAlt);
    expect(imported.launch).toEqual(baseline.launch);
    // RASAero's existing approximate feet conversion differs by under 0.1 mm.
    expect(imported.machAlt![1]![1]).toBeCloseTo(304.8, 4);
    expect(imported.launch!.launchAltitudeM).toBeCloseTo(1188.72, 3);
    const written = (d: ImportedDesign) => exportCdx1({ name: d.name, tree: d.tree, motors: d.motors,
      launch: d.launch, machAlt: d.machAlt });
    expect(written(imported)).toBe(written(baseline));
  });

  it.each([
    ['m', '1326 m'], ['km', '1.33 km'], ['ft', '4352 ft'], ['yd', '1451 yd'], ['mi', '0.82 mi'],
  ])('N032 stored RASAero apogee follows Altitude %s independently of Horizontal distance', async (distanceUnit, apogee) => {
    const data = fixture('Complex.Two-Stage.CDX1');
    const original = data.slice(0);
    const baseline = await parseDesignFile(data, 'Complex.Two-Stage.CDX1', { presets: [] });
    const prediction = (d: ImportedDesign) => d.notes.find(n => n.startsWith('RASAero\u2019s stored prediction'));
    const legacy = prediction(baseline);
    expect(legacy).toContain('simulation 1, as last run in RASAero');
    expect(legacy).toContain('apogee 4,352 ft, maximum velocity 578 ft/s');
    expect(legacy).toContain('prediction, not a measurement');
    expect(legacy).not.toContain('(file:');
    const flightInputs = (d: ImportedDesign) => {
      // Each import mints fresh c<number> identities; retain their reference relationships.
      const ids = new Map<string, string>();
      return JSON.stringify({ tree: d.tree, motors: d.motors, configs: d.configs,
        chosenConfigId: d.chosenConfigId, launch: d.launch, machAlt: d.machAlt }).replace(/"c\d+"/g, id => {
        if (!ids.has(id)) ids.set(id, `"part${ids.size}"`);
        return ids.get(id)!;
      });
    };
    for (const horizontalDistanceUnit of ['m', 'mi']) {
      const imported = await parseDesignFile(data, 'Complex.Two-Stage.CDX1', { presets: [], distanceUnit, horizontalDistanceUnit });
      // MaxAltitude is 4351.988 ft in the fixture; display expectations are hand-converted.
      // Only the apogee readout changes: attribution, motors, velocity and caveat stay intact.
      expect(prediction(imported)).toBe(legacy!.replace('apogee 4,352 ft', `apogee ${apogee} (file: 4351.988 ft)`));
      expect(imported.launch).toEqual(baseline.launch);
      expect(imported.machAlt).toEqual(baseline.machAlt);
      expect(flightInputs(imported)).toBe(flightInputs(baseline));
      expect(data).toEqual(original);
    }
  });

  it('passes the selected aero model to the RASAero import note', async () => {
    const xml = '<RASAeroDocument><RocketDesign><BodyTube><Length>20</Length><Diameter>3</Diameter></BodyTube>'
      + '<ModifiedBarrowman>False</ModifiedBarrowman></RocketDesign></RASAeroDocument>';
    const data = new TextEncoder().encode(xml).buffer;
    const imported = await openDesignFile(data, 'test.CDX1', { presets: [], aeroChoice: 'hybrid' });
    expect(imported.notes.filter((n) => n.includes('Modified Barrowman'))).toHaveLength(1);
    expect(imported.notes.join(' ')).toContain('model was Hybrid (experimental)');
    expect((await openDesignFile(data, 'test.CDX1', { presets: [], aeroChoice: 'eb' })).notes.join(' '))
      .not.toContain('Modified Barrowman');
  });
  it('dispatch by format: a RASAero file through the .CDX1 reader, named only by openDesignFile', async () => {
    // A RASAero file with no <Comments> has no name of its own.
    const parsed = await parseDesignFile(fixture('Complex.Two-Stage.CDX1'), 'My_Test_Rocket.CDX1', { presets: [] });
    expect(parsed.tree.name).toBe('Imported RASAero rocket');
    expect(parsed.sourceFormat).toBe('cdx1');
    const opened = await openDesignFile(fixture('Complex.Two-Stage.CDX1'), 'My_Test_Rocket.CDX1', { presets: [] });
    expect(opened.tree.name).toBe('My Test Rocket');
    expect(opened.name).toBe('My Test Rocket');
  });

  it('a .ork through the .ork reader, a .rkt through the RockSim reader', async () => {
    expect((await parseDesignFile(fixture('reference.ork'), 'unusual.backup', { presets: [] })).sourceFormat).toBe('ork');
    expect((await parseDesignFile(fixture('rocksimTestRocket1.rkt'), 'test.RKT', { presets: [] })).sourceFormat).toBe('rkt');
    expect((await parseDesignFile(fixture('reference.ork'), 'reference.ork', { presets: [] })).tree.components.length)
      .toBeGreaterThan(0);
    expect((await parseDesignFile(fixture('rocksimTestRocket1.rkt'), 'rocksimTestRocket1.rkt', { presets: [] })).tree.name)
      .toBe('FooBar Test');
    // The wrong reader for the bytes refuses them: the dispatch is by name.
    await expect(parseDesignFile(fixture('reference.ork'), 'reference.rkt', { presets: [] })).rejects.toThrow();
  });
});

/**
 * GZIP (board, 2026-10-11). Desktop's GeneralRocketLoader sniffs the gzip
 * magic (1f 8b) before it looks at the format, so it opens a gzip-compressed
 * .rkt or .CDX1 as it opens a gzip .ork. The app inflated only a .ork, and
 * handed the other two compressed bytes to the XML parser: "XML parse error".
 */
describe('a gzip-compressed .rkt or .CDX1 opens as desktop opens it', () => {
  const gz = (b: ArrayBuffer): ArrayBuffer => {
    const out = gzipSync(new Uint8Array(b));
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  };
  /** An import with every minted id blanked, so two reads of one design compare equal. */
  const withoutIds = (r: ImportedDesign): unknown => JSON.parse(JSON.stringify(
    { name: r.name, tree: r.tree, motors: Object.values(r.motors), notes: r.notes },
    (k, v: unknown) => (k === 'ignitionDefaults' ? Object.values(v as object) : k === 'id' || k === 'mountId' || k.endsWith('Id') ? '' : v)));

  it.each([
    ['rocksimTestRocket1.rkt', 'rkt'], ['FinsOnTransitions.rkt', 'rkt'],
    ['Complex.Two-Stage.CDX1', 'cdx1'], ['Three-stage rocket.CDX1', 'cdx1'],
  ] as const)('%s reads the same compressed as plain', async (name, format) => {
    const plain = await parseDesignFile(fixture(name), name, { presets: [] });
    const compressed = await parseDesignFile(gz(fixture(name)), name, { presets: [] });
    expect(compressed.sourceFormat).toBe(format);
    expect(compressed.tree.components.length).toBeGreaterThan(0);
    expect(withoutIds(compressed)).toEqual(withoutIds(plain));
  });

  it.each(['rocksimTestRocket1.rkt', 'Complex.Two-Stage.CDX1'])(
    'a damaged %s is refused as damaged, not as XML, and says so through the open failure', async (name) => {
      const bytes = new Uint8Array(gz(fixture(name)));
      const cut = bytes.slice(0, bytes.length - 20).buffer;
      const kind = name.endsWith('.rkt') ? '.rkt' : '.CDX1';
      let err: unknown;
      try { await parseDesignFile(cut, name, { presets: [] }); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message.startsWith(`Not a readable compressed ${kind} file — it is damaged`)).toBe(true);
      expect(designFileOpenFailure(name, err).startsWith(`Could not open that ${kind} file: Not a readable compressed`)).toBe(true);
    });

  it('a file that is only the two magic bytes is refused as damaged, not a crash', async () => {
    const magic = new Uint8Array([0x1f, 0x8b]).buffer;
    await expect(parseDesignFile(magic, 'x.rkt', { presets: [] })).rejects.toThrow(/compressed \.rkt file — it is damaged/);
    await expect(parseDesignFile(magic, 'x.CDX1', { presets: [] })).rejects.toThrow(/compressed \.CDX1 file — it is damaged/);
  });
});

/**
 * ZIP (board Tier 2, 2026-10-11, the residue of the gzip fix above). Desktop's
 * GeneralRocketLoader.loadStep1 opens a zip too: it reads the archive's FIRST
 * entry when that entry's name ends in .ork, .rkt or .CDX1. The .rkt reader
 * already took its member from a zip (zipMember.ts unzipMember); the .CDX1
 * reader handed the zip's bytes to the XML parser.
 */
describe('a zipped .CDX1 opens as desktop opens it', () => {
  const zipped = (entries: Record<string, Uint8Array>): ArrayBuffer => {
    const out = zipSync(entries);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  };
  const withoutIds = (r: ImportedDesign): unknown => JSON.parse(JSON.stringify(
    { name: r.name, tree: r.tree, motors: Object.values(r.motors), notes: r.notes },
    (k, v: unknown) => (k === 'ignitionDefaults' ? Object.values(v as object) : k === 'id' || k === 'mountId' || k.endsWith('Id') ? '' : v)));

  it.each(['Complex.Two-Stage.CDX1', 'Three-stage rocket.CDX1'])('%s reads the same zipped as plain', async (name) => {
    const plain = await parseDesignFile(fixture(name), name, { presets: [] });
    const fromZip = await parseDesignFile(zipped({ [name]: new Uint8Array(fixture(name)) }), name, { presets: [] });
    expect(fromZip.sourceFormat).toBe('cdx1');
    expect(fromZip.tree.components.length).toBeGreaterThan(0);
    expect(withoutIds(fromZip)).toEqual(withoutIds(plain));
  });

  it('takes the .CDX1 member, not a macOS sidecar that sorts ahead of it', async () => {
    const name = 'Complex.Two-Stage.CDX1';
    const data = zipped({
      [`__MACOSX/._${name}`]: new Uint8Array([0, 5, 22, 7, 0, 2, 0, 0]),
      'readme.txt': new TextEncoder().encode('not a design'),
      [`designs/${name.toLowerCase()}`]: new Uint8Array(fixture(name)),
    });
    expect(withoutIds(await parseDesignFile(data, name, { presets: [] })))
      .toEqual(withoutIds(await parseDesignFile(fixture(name), name, { presets: [] })));
  });

  it('an empty archive is refused by name, not as XML', async () => {
    await expect(parseDesignFile(zipped({}), 'x.CDX1', { presets: [] })).rejects.toThrow(/Empty \.CDX1 archive/);
  });
});
