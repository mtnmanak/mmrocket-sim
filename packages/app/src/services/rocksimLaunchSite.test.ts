// @vitest-environment happy-dom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importRkt } from './rocksimFile.js';
import { importedLaunch, planImport, retainedLaunchNote } from './importApply.js';
import { DEFAULT_PREFS } from '../prefs/preferences.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A .rkt's launch site (board Tier 0 row 80, ruled by Eric 2026-10-11).
 * Each RockSim simulation states <LaunchLatitude>, <LaunchLongitude> and
 * <LaunchAltitude> (metres). Of the ten .rkt files under docs/ that carry
 * them, nine state longitude 0 — a site on the prime meridian, which the
 * weather fetch for "This design's site" would then look up. So the site is
 * taken only when latitude and longitude are both non-zero and in range, and
 * otherwise the panel keeps the site it had and the import note says so.
 */
const rkt = (sims: { lat?: string; lon?: string; alt?: string; motor?: string }[]): string =>
  `<RockSimDocument><DesignInformation><RocketDesign><Name>Site</Name><StageCount>1</StageCount>
    <Stage3Parts><BodyTube><Name>Body</Name><OD>54</OD><ID>52</ID><Len>300</Len>
      <IsMotorMount>1</IsMotorMount><SerialNo>1</SerialNo></BodyTube></Stage3Parts>
  </RocketDesign></DesignInformation>
  <SimulationResultsList>${sims.map((s, i) => `<SimulationResults>
    ${s.lat === undefined ? '' : `<LaunchLatitude>${s.lat}</LaunchLatitude>`}
    ${s.lon === undefined ? '' : `<LaunchLongitude>${s.lon}</LaunchLongitude>`}
    ${s.alt === undefined ? '' : `<LaunchAltitude>${s.alt}</LaunchAltitude>`}
    <Stage3Engines><EngineSet><EngineCode>${s.motor ?? `F${20 + i}W`}</EngineCode>
      <MountSerialNo>1</MountSerialNo><EjectionDelay>6.</EjectionDelay></EngineSet></Stage3Engines>
  </SimulationResults>`).join('')}</SimulationResultsList></RockSimDocument>`;

const siteNote = (notes: string[]) => notes.find((n) => /launch site/.test(n) && /keeps the settings you had/.test(n));

describe('.rkt launch site (board row 80)', () => {
  it('imports a real site — latitude, longitude and the site altitude', () => {
    const r = importRkt(rkt([{ lat: '40.845', lon: '-119.112', alt: '1189.94' }]));
    expect(r.launch).toEqual({ latitudeDeg: 40.845, longitudeDeg: -119.112, launchAltitudeM: 1189.94 });
    expect(siteNote(r.notes)).toBeUndefined();
    // The open merges it over the panel's site exactly as a .ork's does.
    const next = importedLaunch({ ...DEFAULT_CONDITIONS, latitudeDeg: 61.2, longitudeDeg: -149.9, launchAltitudeM: 40 }, r.launch);
    expect(next.latitudeDeg).toBe(40.845);
    expect(next.longitudeDeg).toBe(-119.112);
    expect(next.launchAltitudeM).toBe(1189.94);
  });

  it('takes the site of the simulation it opens, not the first one', () => {
    // Simulation 1 carries no motor, so it is no configuration and the
    // reader opens simulation 2 — whose site is the one taken.
    const a = importRkt(rkt([{ lat: '40.845', lon: '-119.112', alt: '1189.94', motor: '' },
      { lat: '32.99', lon: '-106.97', alt: '1401' }]));
    expect(a.chosenConfigId).toBe('rocksim-sim-2');
    expect(a.launch).toEqual({ latitudeDeg: 32.99, longitudeDeg: -106.97, launchAltitudeM: 1401 });
  });

  it('keeps the site and says so when the longitude is 0 (9 of the 10 corpus files)', () => {
    const r = importRkt(rkt([{ lat: '37.', lon: '0.', alt: '213.36' }]));
    expect(r.launch).toBeUndefined();
    const note = siteNote(r.notes)!;
    expect(note).toContain('latitude 37°');
    expect(note).toContain('longitude 0°');
    expect(note).toContain('213.4 m (700 ft)');
    expect(note).toContain('Simulation 1');
    expect(r.launchSiteRefused).toBe(true);
  });

  it('the open says it once: the importer’s sentence, and no second "none was taken" line', () => {
    const TEXT = { mass: (kg: number) => `${kg} kg`, length: (m: number) => `${m} m` };
    const opened = (xml: string) => {
      const r = importRkt(xml);
      return planImport(r, { working: {}, configs: {} }, { launch: DEFAULT_CONDITIONS, text: TEXT })
        .note.text.split('\n').filter((l) => /launch site/.test(l));
    };
    const refused = opened(rkt([{ lat: '37.', lon: '0.', alt: '213.36' }]));
    expect(refused).toHaveLength(1);
    const unset = opened(rkt([{ lat: '1.571', lon: '-101.593', alt: '0.' }]));
    expect(unset).toHaveLength(1);
    expect(unset[0]).toMatch(/latitude 1\.571°, longitude -101\.593°, site altitude 0 m \(0 ft\); that latitude looks unset .* so the Launch panel keeps the settings you had\.$/);
    expect(refused[0]).toMatch(/states its launch site as latitude 37°, longitude 0°, site altitude 213\.4 m \(700 ft\); .* reads no other launch condition from a \.rkt, so the Launch panel keeps the settings you had\.$/);
    // A file that states no site at all still hears the open's own line.
    expect(opened(rkt([{}]))).toEqual([
      'From a .rkt the app reads only the launch site, and none was taken from this one — the Launch panel keeps the settings you had.',
    ]);
  });

  it('keeps the site for a 0/0 file', () => {
    const r = importRkt(rkt([{ lat: '0.', lon: '0.', alt: '152.4' }]));
    expect(r.launch).toBeUndefined();
    expect(siteNote(r.notes)).toContain('latitude 0°, longitude 0°');
  });

  it('keeps the site when latitude 0 meets a real longitude', () => {
    const r = importRkt(rkt([{ lat: '0', lon: '-80.6', alt: '3' }]));
    expect(r.launch).toBeUndefined();
    expect(siteNote(r.notes)).toBeDefined();
  });

  it('reads a latitude within 0.001 of π/2 as unset, like a 0 (board row 82)', () => {
    // estes_alpha.rkt: RockSim's 1.571 — 90° written in radians — beside a
    // real longitude. v0.178 opened it at 1.571° N.
    const r = importRkt(rkt([{ lat: '1.571', lon: '-101.593', alt: '0.' }]));
    expect(r.launch).toBeUndefined();
    expect(r.launchSiteRefused).toBe(true);
    const note = siteNote(r.notes)!;
    expect(note).toContain('latitude 1.571°, longitude -101.593°, site altitude 0 m');
    expect(note).toContain('that latitude looks unset — it is π/2, 90° written in radians');
    // Every spelling RockSim writes, and the edges of the 0.001 band.
    for (const lat of ['1.5708', '1.570796', '1.571000000000000', '1.5698', '1.5717']) {
      expect(importRkt(rkt([{ lat, lon: '-101.593' }])).launch, lat).toBeUndefined();
    }
    for (const lat of ['1.5697', '1.5718', '-1.571']) {
      expect(importRkt(rkt([{ lat, lon: '-101.593' }])).launch?.latitudeDeg, lat).toBe(Number(lat));
    }
  });

  it('reads a latitude within 0.001 of 90 — the degree form of the same figure — as unset (batch 6)', () => {
    // 1,486 corpus simulations in 155 files carry 89.999980470084,
    // 90.0000016695222 or 90. — the pole. The first and the last are in range,
    // so beside a real longitude they would have put the pad at the pole.
    const r = importRkt(rkt([{ lat: '89.999980470084', lon: '-101.593', alt: '0.' }]));
    expect(r.launch).toBeUndefined();
    expect(r.launchSiteRefused).toBe(true);
    const note = siteNote(r.notes)!;
    expect(note).toContain('latitude 89.999980470084°, longitude -101.593°, site altitude 0 m');
    expect(note).toContain('that latitude looks unset — it is 90°, the North Pole');
    for (const lat of ['90.', '90.000000000000000', '90.0000016695222', '89.9991', '90.0009']) {
      const s = importRkt(rkt([{ lat, lon: '-101.593' }]));
      expect(s.launch, lat).toBeUndefined();
      expect(siteNote(s.notes), lat).toContain('looks unset — it is 90°');
    }
    // Just outside the band a latitude is read as written.
    expect(importRkt(rkt([{ lat: '89.998', lon: '-101.593' }])).launch?.latitudeDeg).toBe(89.998);
    // Out of range and unset at once: the note names the unset reading.
    expect(siteNote(importRkt(rkt([{ lat: '90.0000016695222', lon: '0.' }])).notes)).toContain('looks unset — it is 90°');
  });

  it('says the latitude looks unset when the longitude is 0 too, and only then', () => {
    expect(siteNote(importRkt(rkt([{ lat: '1.571', lon: '0.' }])).notes)).toContain('looks unset');
    expect(siteNote(importRkt(rkt([{ lat: '37.', lon: '0.' }])).notes)).not.toContain('looks unset');
  });

  it('keeps the site when a coordinate is out of range — never clamped onto a pole', () => {
    for (const [lat, lon] of [['91', '-100'], ['45', '181'], ['-90.5', '10'], ['45', '-200']] as const) {
      const r = importRkt(rkt([{ lat, lon, alt: '100' }]));
      expect(r.launch).toBeUndefined();
      expect(siteNote(r.notes)).toContain(`latitude ${Number(lat)}°, longitude ${Number(lon)}°`);
    }
  });

  it('keeps the site when a coordinate is unreadable or missing', () => {
    const bad = importRkt(rkt([{ lat: '4O.8', lon: '-119.1', alt: '100' }]));
    expect(bad.launch).toBeUndefined();
    expect(siteNote(bad.notes)).toContain('latitude “4O.8”');
    const half = importRkt(rkt([{ lat: '40.8', alt: '100' }]));
    expect(half.launch).toBeUndefined();
    expect(siteNote(half.notes)).toContain('no longitude');
  });

  it('says nothing about a site the file does not state', () => {
    const r = importRkt(rkt([{}]));
    expect(r.launch).toBeUndefined();
    expect(r.launchSiteRefused).toBeUndefined();
    expect(r.notes.some((n) => /launch site/.test(n))).toBe(false);
  });

  it('takes the coordinates without an altitude when the file states none, and clamps one out of range', () => {
    const none = importRkt(rkt([{ lat: '40.845', lon: '-119.112' }]));
    expect(none.launch).toEqual({ latitudeDeg: 40.845, longitudeDeg: -119.112 });
    const high = importRkt(rkt([{ lat: '40.845', lon: '-119.112', alt: '12000' }]));
    expect(high.launch?.launchAltitudeM).toBe(10000);
    expect(high.notes.some((n) => /site altitude is 12000 m/.test(n))).toBe(true);
  });

  it('runs the .ork open check for a flipped longitude between simulations', () => {
    // Same site with the sign flipped in a second simulation (row 44 A).
    const r = importRkt(rkt([{ lat: '40.845', lon: '-119.112', alt: '1189.94', motor: 'F20W' },
      { lat: '40.845', lon: '119.112', alt: '1189.94', motor: 'G40W' }]));
    expect(r.longitudeCheck?.opened.longitudeDeg).toBe(-119.112);
    expect(r.notes.some((n) => /longitude’s sign flipped/.test(n))).toBe(true);
  });

  it('the Launch panel note says what a .rkt open kept', () => {
    expect(retainedLaunchNote('rkt', DEFAULT_CONDITIONS, undefined))
      .toBe('From a .rkt the app reads only the launch site, and none was taken from this one — the Launch panel keeps the settings you had.');
    expect(retainedLaunchNote('rkt', DEFAULT_CONDITIONS, { latitudeDeg: 40.8, longitudeDeg: -119.1, launchAltitudeM: 1190 }))
      .toBe('From a .rkt the app reads only the launch site (latitude, longitude and site altitude) — the Launch panel keeps the settings you had for the rest.');
    expect(retainedLaunchNote('rkt', DEFAULT_CONDITIONS, undefined, true)).toBeNull();
  });

  // Tester files are gitignored; this runs locally and skips on CI.
  const corpus = join(here, '../../../../docs/User files');
  const WILD = join(corpus, 'TRF RASAero Files/SS Wild Bash 20260623v0.rkt');
  const WM = join(corpus, '4in WM Extreme.rkt');
  it.skipIf(!existsSync(WILD) || !existsSync(WM))('the corpus: Black Rock imports, a longitude-0 file keeps the site', () => {
    const wild = importRkt(readFileSync(WILD, 'utf8'));
    expect(wild.launch?.latitudeDeg).toBe(40.845);
    expect(wild.launch?.longitudeDeg).toBe(-119.112);
    expect(wild.launch?.launchAltitudeM).toBe(1189.94);
    const wm = importRkt(readFileSync(WM, 'utf8'));
    expect(wm.launch).toBeUndefined();
    expect(siteNote(wm.notes)).toContain('longitude 0°');
  }, 30_000);
});

it('uses the units-only preference for longitude evidence', () => {
  const result = importRkt(rkt([{ lat: '26.380273', lon: '80.126879' }, { lat: '28.1', lon: '-80.63' }]),
    { units: { ...DEFAULT_PREFS.units, distance: 'mi' } });
  expect(result.notes.join(' ')).toContain('8,500 mi (13,679 km) away. With the sign flipped it is 100 mi (161 km) from them.');
});
