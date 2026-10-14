// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { FlightResult } from '@online-openrocket/engine';
import { defaultTree } from '../tree/treeModel.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import type { SimRun } from './simReport.js';
import { buildFlightDataBundle } from './flightDataBundle.js';
import { runExportContext } from './runExportContext.js';
import type { WeatherSnapshot } from './weatherSnapshot.js';
import { exportOrk, importOrk } from './orkFile.js';
import type { WindProfileSource } from './windProfile.js';

const run = { id: 'selected', when: 1000, rocket: 'Test', motor: 'C6', manufacturer: 'Estes',
  maxAltitude: 123, maxVelocity: 45, maxAcceleration: 20, maxMach: 0.2, timeToApogee: 4,
  comments: '', conditionsKey: 'latitudeDeg=61.234567|windAverage=3',
  aeroModel: 'classic', windAvg: 3,
} as SimRun;
const input = () => ({ design: { name: 'Test', tree: defaultTree(),
  launch: { ...DEFAULT_CONDITIONS, latitudeDeg: 61.234567, longitudeDeg: -149.765432 } },
  run, changedSince: ['the design'], includeCoordinates: false,
  measurements: { altimeterType: '', apogeeM: null, maxVelocityMs: null, liftoffMassKg: null, notes: '' },
});
const filesOf = (x = input()) => unzipSync(buildFlightDataBundle(x).bytes);

describe('flight-data bundle', () => {
  it.each([
    { recorded: -149.765432, current: 10, expected: 'different' },
    { recorded: -149.765432, current: -149.765432, expected: 'same' },
    { recorded: null, current: 10, expected: 'different' },
    { recorded: null, current: -80.6, expected: 'same' },
    { recorded: undefined, current: -80.6, expected: 'same' },
  ])('separates site longitude from the physics comparison ($recorded / $current)', ({ recorded, current, expected }) => {
    const x = input();
    const files = unzipSync(buildFlightDataBundle({ ...x, changedSince: [],
      design: { ...x.design, launch: { ...x.design.launch, longitudeDeg: current } },
      run: { ...run, exportContext: runExportContext({ ...x.design.launch, longitudeDeg: recorded }) },
    }).bytes);
    expect(JSON.parse(strFromU8(files['manifest.json']!))).toMatchObject({ changedSince: [],
      changedSinceScope: 'simulation-relevant inputs; excludes site longitude and design presentation',
      siteLongitudeComparison: expected, coordinatesIncluded: false });
    const all = Object.values(files).map(f => strFromU8(f)).join('\n');
    expect(all).not.toContain('-149.765432');
    expect(all).not.toContain('61.234567');
  });

  it('marks the site longitude comparison unknown without recorded launch context', () => {
    expect(JSON.parse(strFromU8(filesOf()['manifest.json']!)).siteLongitudeComparison).toBe('unknown');
  });

  it('documents mixed JSON units and CSV column units without converting saved values', () => {
    const x = input();
    const selected = { ...run, motorDiameterMm: 18, execMs: 411.25, when: 1700000000123,
      launchStaticMarginCal: 1.5, launchStaticMarginPct: 12, maxMach: 0.2,
      delayResolution: { policy: 'carrier-ballistic-v1' as const, mounts: [{ mountId: 'mount', mountName: 'Motor mount',
        motorIdentity: 'Estes C6', mode: 'manual' as const, flownDelay: 5, rawOptimum: null, recommendedDelay: null,
        burnoutTime: null, apogeeTime: null, branchId: null, branchName: null, status: 'fixed' as const }], probes: 0, elapsedMs: 25.5 },
      exportContext: runExportContext({ ...x.design.launch, temperatureC: 12, pressureHPa: 1000 }) };
    const result = { summary: {}, events: [], series: { time: [0], altitude: [123], velocity: [45],
      'φ': [61.234567], 'λ': [-149.765432] } } as unknown as FlightResult;
    const files = unzipSync(buildFlightDataBundle({ ...x, run: selected, result, includeCoordinates: true }).bytes);
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(manifest).toHaveProperty('jsonUnits');
    expect(manifest.jsonUnits.fields).toMatchObject({ motorDiameterMm: 'mm', execMs: 'ms', elapsedMs: 'ms',
      when: 'Unix epoch ms', runTimeUnixMs: 'Unix epoch ms', validUnix: 'Unix epoch s',
      temperatureC: 'degrees Celsius', pressureHPa: 'hPa',
      launchStaticMarginCal: 'calibers (body diameters)', launchStaticMarginPct: '%', maxMach: 'dimensionless' });
    expect(manifest.jsonUnits.suffixes).toMatchObject({ Mm: 'mm', Deg: 'degrees', Pct: '%', Cal: 'calibers (body diameters)' });
    expect(manifest.units).toContain('CSV headers govern each column');
    expect(manifest.units).toContain('coordinate degrees');
    expect(JSON.parse(strFromU8(files['run.json']!))).toMatchObject({ motorDiameterMm: 18, execMs: 411.25,
      when: 1700000000123, launchStaticMarginCal: 1.5, launchStaticMarginPct: 12, maxMach: 0.2,
      delayResolution: { elapsedMs: 25.5 } });
    expect(manifest.runTimeUnixMs).toBe(1700000000123);
    expect(JSON.parse(strFromU8(files['launch-and-weather.json']!)).launch).toMatchObject({ temperatureC: 12, pressureHPa: 1000 });
    expect(strFromU8(files['flight-data.csv']!)).toContain('Longitude (°)');
  });

  it.each([
    { includeCoordinates: false, imported: false }, { includeCoordinates: true, imported: false },
    { includeCoordinates: false, imported: true }, { includeCoordinates: true, imported: true },
  ])('retains profile-only forecast provenance with coordinate consent $includeCoordinates (imported $imported)', ({ includeCoordinates, imported }) => {
    const windProfileSource: WindProfileSource = { kind: 'open-meteo', place: '61.234567, -149.765432',
      method: 'search', validUnix: 1700000000, surfaceFromDeg: 20 };
    const appliedLaunch = { ...input().design.launch, windAverage: 4,
      windLevels: [{ altitude: 0, speed: 4, direction: 0, standardDeviation: 0 }], windProfileSource };
    const launch = imported
      ? { ...DEFAULT_CONDITIONS, ...importOrk(exportOrk({ ...input().design, launch: appliedLaunch })).launch }
      : appliedLaunch;
    const context = runExportContext(launch);
    const x = { ...input(), includeCoordinates, design: { ...input().design, launch }, run: { ...run, exportContext: context } };
    const before = structuredClone(x);
    const files = unzipSync(buildFlightDataBundle(x).bytes);
    const expectedSource = { ...windProfileSource, place: includeCoordinates ? windProfileSource.place : '' };
    expect(JSON.parse(strFromU8(files['launch-and-weather.json']!)).launch.windProfileSource).toEqual(expectedSource);
    expect(JSON.parse(strFromU8(files['run.json']!)).exportContext.launch.windProfileSource).toEqual(expectedSource);
    // Round-trip the ordinary writer's metadata, as an imported profile will be.
    expect(importOrk(strFromU8(files['design.ork']!)).launch?.windProfileSource).toEqual(expectedSource);
    expect(JSON.parse(strFromU8(files['manifest.json']!)).weatherCredit.source.href).toBe('https://open-meteo.com/');
    if (!includeCoordinates) {
      const all = Object.values(files).map(f => strFromU8(f)).join('\n');
      expect(all).not.toContain('61.234567');
      expect(all).not.toContain('-149.765432');
    }
    expect(x).toEqual(before);
  });

  it('credits an Open-Meteo profile retained only in the current design', () => {
    const x = input();
    const files = unzipSync(buildFlightDataBundle({ ...x, design: { ...x.design,
      launch: { ...x.design.launch, windLevels: [{ altitude: 0, speed: 3, direction: 0 }],
        windProfileSource: { kind: 'open-meteo', place: 'Test site', validUnix: 1700000000, surfaceFromDeg: 20 } } } }).bytes);
    expect(JSON.parse(strFromU8(files['manifest.json']!)).weatherCredit.source.href).toBe('https://open-meteo.com/');
  });

  it.each([false, true])('credits a saved run profile without recorded launch context (coordinates %s)', includeCoordinates => {
    const windProfileSource: WindProfileSource = { kind: 'open-meteo', place: 'Test site', method: 'search',
      validUnix: 1700000000, surfaceFromDeg: 20 };
    const files = unzipSync(buildFlightDataBundle({ ...input(), includeCoordinates,
      run: { ...run, windLevels: [{ altitude: 0, speed: 3, direction: 0 }], windProfileSource } }).bytes);
    expect(JSON.parse(strFromU8(files['run.json']!)).windProfileSource)
      .toEqual({ ...windProfileSource, place: includeCoordinates ? 'Test site' : '' });
    expect(JSON.parse(strFromU8(files['manifest.json']!)).weatherCredit.source.href).toBe('https://open-meteo.com/');
    expect(JSON.parse(strFromU8(files['launch-and-weather.json']!))).toBeNull();
  });

  it('exports only the selected summary and marks a current design with stale/unknown inputs honestly', () => {
    const files = filesOf();
    expect(Object.keys(files).sort()).toEqual(['design.ork', 'launch-and-weather.json', 'manifest.json', 'measurements.json', 'run.csv', 'run.json']);
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(manifest).toMatchObject({ selectedRunId: 'selected', design: 'current design at export',
      changedSince: ['the design'], series: 'not available', launchAndWeather: 'not recorded', coordinatesIncluded: false });
    expect(manifest.files.map((f: { path: string }) => f.path).sort()).toEqual(Object.keys(files).sort());
    expect(JSON.parse(strFromU8(files['run.json']!)).maxAltitude).toBe(123);
    expect(strFromU8(files['run.csv']!)).toContain('123');
    expect(strFromU8(files['run.csv']!)).toContain('Guide (mph)');
    expect(strFromU8(files['run.csv']!)).toContain('Max altitude (m)');
    expect(JSON.parse(strFromU8(files['measurements.json']!))).toMatchObject({ apogeeM: null, liftoffMassKg: null });
    expect(JSON.parse(strFromU8(files['launch-and-weather.json']!))).toBeNull();
  });

  it('omits structured coordinates from the design, provenance keys, series and booster branches', () => {
    const series = { time: [0], altitude: [123], velocity: [45], 'φ': [61.234567], 'λ': [-149.765432] };
    const result = { summary: {}, events: [], series, branches: [{ name: 'Sustainer', series, events: [] }, { name: 'Booster', series, events: [] }] } as unknown as FlightResult;
    const x = { ...input(), result };
    const before = structuredClone(x);
    const files = unzipSync(buildFlightDataBundle(x).bytes);
    const all = Object.values(files).map(f => strFromU8(f)).join('\n');
    expect(all).not.toContain('61.234567');
    expect(all).not.toContain('-149.765432');
    expect(strFromU8(files['design.ork']!)).not.toMatch(/<launch(?:latitude|longitude)/);
    expect(strFromU8(files['flight-data.csv']!)).not.toMatch(/Latitude|Longitude/);
    expect(strFromU8(files['flight-data.csv']!)).toContain('Booster');
    expect(x).toEqual(before);
    const included = unzipSync(buildFlightDataBundle({ ...x, includeCoordinates: true }).bytes);
    expect(strFromU8(included['design.ork']!)).toContain('<launchlatitude>61.234567</launchlatitude>');
    expect(strFromU8(included['flight-data.csv']!)).toContain('Longitude');
  });

  it('keeps the selected run weather receipt and model separate from current conditions, with weather attribution and coordinate consent', () => {
    const weather: WeatherSnapshot = {
      v: 1, provider: 'open-meteo', endpoint: 'forecast', model: 'best_match',
      place: { label: '61.234567, -149.765432', latitudeDeg: 61.234567, longitudeDeg: -149.765432, method: 'coordinates' },
      grid: { latitudeDeg: 61.234567, longitudeDeg: -149.765432 }, demElevationM: 100, forAltitudeM: 100,
      timezone: 'America/Anchorage', validUnix: 1700000000, retrievedAt: '2026-10-13T00:00:00Z',
      fetched: { temperatureC: 12, pressureHPa: 1000, windSpeedMs: 4, windGustMs: 7, windFromDeg: 20 },
      applied: { latitudeDeg: 61.234567, longitudeDeg: -149.765432, temperatureC: 12 },
      before: { latitudeDeg: 61.234567, longitudeDeg: -149.765432, temperatureC: null },
    };
    const context = runExportContext({ ...input().design.launch, temperatureC: 12 }, weather);
    weather.fetched.windSpeedMs = 99; // later weather edits cannot rewrite the run's receipt
    const x = { ...input(), run: { ...run, exportContext: context }, measurements: {
      altimeterType: 'Baro model', apogeeM: 121.5, maxVelocityMs: 44, liftoffMassKg: 0.125, notes: 'Calm at pad',
    } };
    const files = unzipSync(buildFlightDataBundle(x).bytes);
    const receipt = JSON.parse(strFromU8(files['launch-and-weather.json']!));
    expect(receipt.launch.temperatureC).toBe(12);
    expect(receipt.weather.fetched.windSpeedMs).toBe(4);
    expect(receipt.weather.place).toBeUndefined();
    expect(receipt.weather.grid).toBeUndefined();
    expect(Object.values(files).map(f => strFromU8(f)).join('\n')).not.toContain('61.234567');
    expect(strFromU8(files['manifest.json']!)).toContain('https://open-meteo.com/');
    expect(JSON.parse(strFromU8(files['measurements.json']!)).liftoffMassKg).toBe(0.125);
    expect(JSON.parse(strFromU8(files['run.json']!)).aeroModel).toBe('classic');
    const included = unzipSync(buildFlightDataBundle({ ...x, includeCoordinates: true }).bytes);
    expect(JSON.parse(strFromU8(included['launch-and-weather.json']!))).toEqual(context);
  });

  it('marks imported summaries and unknown matches without inventing launch metadata or raw series', () => {
    const files = unzipSync(buildFlightDataBundle({ ...input(), run: { ...run, importedSummary: true }, changedSince: null }).bytes);
    expect(JSON.parse(strFromU8(files['manifest.json']!))).toMatchObject({ runSource: 'imported summary', changedSince: null, appVersionAtRun: null });
    expect(files['flight-data.csv']).toBeUndefined();
  });

  it('rejects invalid measurements instead of turning them into unknown or zero', () => {
    const x = input();
    expect(() => buildFlightDataBundle({ ...x, measurements: { ...x.measurements, apogeeM: -1 } })).toThrow(/zero or greater/);
    expect(() => buildFlightDataBundle({ ...x, measurements: { ...x.measurements, apogeeM: NaN } })).toThrow(/zero or greater/);
  });

  it('previews ordinary .ork export notices without mutating or accumulating the caller notices', () => {
    const x = { ...input(), includeCoordinates: true, design: { ...input().design, notes: ['Caller notice'],
      configs: [{ id: 'config', name: 'Config', isDefault: true, motors: {}, stageMassOverrides: {} }] } };
    const first = unzipSync(buildFlightDataBundle(x).bytes);
    const second = unzipSync(buildFlightDataBundle(x).bytes);
    const notices = JSON.parse(strFromU8(first['manifest.json']!)).designExportNotes;
    expect(notices).toContain('Caller notice');
    expect(notices.some((n: string) => n.includes('stage mass'))).toBe(true);
    expect(JSON.parse(strFromU8(second['manifest.json']!)).designExportNotes).toEqual(notices);
    expect(x.design.notes).toEqual(['Caller notice']);
  });

  it('keeps a user attachment byte-for-byte under a safe, separate archive path', () => {
    const attachment = { name: '../../manifest.json', bytes: new Uint8Array([0, 255, 42, 13, 10]) };
    const files = unzipSync(buildFlightDataBundle({ ...input(), attachment }).bytes);
    expect(files['attachment/manifest.json']).toEqual(attachment.bytes);
    expect(JSON.parse(strFromU8(files['manifest.json']!)).attachment).toEqual({ path: 'attachment/manifest.json', originalName: '../../manifest.json', bytes: 5 });
    expect(Object.keys(files).some(p => p.includes('..'))).toBe(false);
  });
});
