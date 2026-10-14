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
