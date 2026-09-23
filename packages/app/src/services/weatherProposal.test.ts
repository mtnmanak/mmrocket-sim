import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONDITIONS, type LaunchConditions } from '../components/LaunchPanel.js';
import { densityAltitudeM, isaPressurePa } from './atmosphere.js';
import { parseForecast, placeFromGeo, parseGeocode, type ForecastVariant, type WeatherAnswer } from './openMeteo.js';
import {
  applicable, buildProposal, defaultAltitudeChoice, densityAfter, patchOf, snapshotOf, type ProposalRow,
} from './weatherProposal.js';
import { validWeatherSnapshot } from './weatherSnapshot.js';

/**
 * The review, against the answer captured for Gerlach, NV on 2026-09-22
 * (terrain 1,202 m; asked at 0 m and 1,202 m). The hour is 2 PM PDT on
 * Saturday 26 September: 31.1 °C / 1005.7 hPa at 0 m, 23.3 °C / 877.2 hPa at
 * 1,202 m, wind 1.75 m/s gusting 4.6 from 294°.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(here, '__fixtures__', 'open-meteo', name), 'utf8'));
const SAT_2PM = Date.UTC(2026, 8, 26, 21) / 1000;
const gerlach = placeFromGeo(parseGeocode(fixture('geocode-gerlach.json'))[0]!);

function answer(elevationsM: number[], demM: number | null, variants?: ForecastVariant[]): WeatherAnswer {
  return {
    endpoint: 'forecast', date: '2026-09-26', demM, elevationsM,
    variants: variants ?? parseForecast(fixture('forecast-gerlach-0-1202m.json'), elevationsM),
    timezone: 'America/Los_Angeles',
  };
}
const TWO = () => answer([0, 1202], 1202);
const row = (rows: ProposalRow[], key: ProposalRow['key']) => rows.find((r) => r.key === key)!;
const all = new Set<ProposalRow['key']>(['temperatureC', 'pressureHPa', 'windAverage', 'latitudeDeg', 'longitudeDeg']);

describe('the review of one fetched hour', () => {
  it('at the default Site altitude of 0, offers the ground height and flies ITS air', () => {
    const a = TWO();
    expect(defaultAltitudeChoice(DEFAULT_CONDITIONS, a)).toBe('ground');
    const p = buildProposal({ launch: DEFAULT_CONDITIONS, answer: a, place: gerlach, unix: SAT_2PM, choice: 'ground' });
    expect(p.altitude).toMatchObject({ siteM: 0, demM: 1202, canChoose: true, choice: 'ground', groundAltitudeM: 1202 });
    // The 1,202 m variant's air, not sea level's 1005.7 hPa / 31.1 °C.
    expect(row(p.rows, 'pressureHPa')).toMatchObject({ value: 877.2, refusal: null });
    expect(row(p.rows, 'temperatureC')).toMatchObject({ value: 23.3, refusal: null });
    expect(p.forAltitudeM).toBe(1202);
    const patch = patchOf(p, all);
    expect(patch).toMatchObject({ temperatureC: 23.3, pressureHPa: 877.2, windAverage: 1.75, launchAltitudeM: 1202 });
  });

  it('keeping your own altitude flies the air fetched for it — never the ground’s', () => {
    const launch = { ...DEFAULT_CONDITIONS, launchAltitudeM: 0 };
    const p = buildProposal({ launch, answer: TWO(), place: gerlach, unix: SAT_2PM, choice: 'site' });
    expect(row(p.rows, 'pressureHPa').value).toBe(1005.7);
    expect(p.forAltitudeM).toBe(0);
    expect(patchOf(p, all)).not.toHaveProperty('launchAltitudeM');
  });

  it('with the site and the terrain agreeing, asks for one elevation and offers no choice', () => {
    const launch = { ...DEFAULT_CONDITIONS, launchAltitudeM: 1190 };
    const one = answer([1190], 1191, parseForecast(fixture('forecast-blackrock-1190m.json'), [1190]));
    expect(defaultAltitudeChoice(launch, one)).toBe('site');
    const p = buildProposal({ launch, answer: one, place: gerlach, unix: SAT_2PM, choice: 'ground' });
    expect(p.altitude).toMatchObject({ agree: true, canChoose: false, choice: 'site' });
    expect(patchOf(p, all)).not.toHaveProperty('launchAltitudeM');
    expect(row(p.rows, 'pressureHPa').value).toBe(879.6);
  });

  it('refuses a pressure fetched for one elevation and flown at another (the backstop)', () => {
    // A wiring bug's shape: the 0 m variant's 1005.7 hPa paired with a 1,190 m
    // pad — sea-level air at a high pad, 14.5 % too dense.
    const launch = { ...DEFAULT_CONDITIONS, launchAltitudeM: 1190 };
    const p = buildProposal({ launch, answer: TWO(), place: gerlach, unix: SAT_2PM, choice: 'site' });
    expect(row(p.rows, 'pressureHPa')).toMatchObject({ value: 1005.7, refusal: { why: 'sea-level', altitudeM: 1190 } });
    expect(patchOf(p, all)).not.toHaveProperty('pressureHPa');
    expect(1005.7 * 100).toBeGreaterThan(isaPressurePa(1190) * 1.05);
  });

  it('refuses a value outside the field’s own bounds, and a missing one — never reads it as 0', () => {
    const v = parseForecast(fixture('forecast-blackrock-1190m.json'), [1190]);
    const s = v[0]!.samples.find((x) => x.unix === SAT_2PM)!;
    s.temperatureC = 71;
    s.pressureHPa = null;
    s.windSpeedMs = 0; // calm is a value
    const p = buildProposal({
      launch: { ...DEFAULT_CONDITIONS, launchAltitudeM: 1190 }, answer: answer([1190], 1191, v), place: gerlach,
      unix: SAT_2PM, choice: 'site',
    });
    expect(row(p.rows, 'temperatureC').refusal).toEqual({ why: 'range', range: [-60, 60] });
    expect(row(p.rows, 'pressureHPa')).toMatchObject({ value: null, refusal: { why: 'missing' } });
    expect(row(p.rows, 'windAverage')).toMatchObject({ value: 0, refusal: null });
    expect(patchOf(p, all)).toEqual({ windAverage: 0, latitudeDeg: 40.65157, longitudeDeg: -119.35519 });
  });

  it('puts a below-sea-level pad at 0 with the air measured at the ground', () => {
    // Badwater's shape: the same captured hours, the second asked at −86 m.
    const body = fixture('forecast-gerlach-0-1202m.json') as Record<string, unknown>[];
    body[1] = { ...body[1], elevation: -86 };
    const a = answer([0, -86], -86, parseForecast(body, [0, -86]));
    const p = buildProposal({ launch: DEFAULT_CONDITIONS, answer: a, place: gerlach, unix: SAT_2PM, choice: 'ground' });
    expect(p.altitude).toMatchObject({ belowSeaLevel: true, groundAltitudeM: 0, choice: 'ground' });
    expect(p.forAltitudeM).toBe(0);
    expect(patchOf(p, all).launchAltitudeM).toBe(0);
  });

  it('offers the PLACE’s coordinates, never the grid point that answered', () => {
    const p = buildProposal({ launch: DEFAULT_CONDITIONS, answer: TWO(), place: gerlach, unix: SAT_2PM, choice: 'ground' });
    expect(row(p.rows, 'latitudeDeg').value).toBe(40.65157);
    expect(row(p.rows, 'longitudeDeg').value).toBe(-119.35519);
    expect(p.grid).toEqual({ latitudeDeg: 40.66386, longitudeDeg: -119.35593 });
    expect(p.gridDistanceM! / 1000).toBeCloseTo(1.37, 2);
    // Now: latitude 28.61 and a BLANK longitude.
    expect(row(p.rows, 'longitudeDeg').now).toBeNull();
  });

  it('marks a now-value the site filled in, so it reads as the app’s, not the user’s', () => {
    const launch = { ...DEFAULT_CONDITIONS, launchAltitudeM: 1190, temperatureC: 20 };
    const p = buildProposal({ launch, answer: TWO(), place: gerlach, unix: SAT_2PM, choice: 'ground' });
    expect(row(p.rows, 'temperatureC')).toMatchObject({ now: 20, nowFromSite: false });
    expect(row(p.rows, 'pressureHPa').nowFromSite).toBe(true);
    expect(row(p.rows, 'pressureHPa').now).toBeCloseTo(isaPressurePa(1190) / 100, 9);
  });

  it('writes only the ticked rows, never σ, and says what the density altitude becomes', () => {
    const p = buildProposal({ launch: DEFAULT_CONDITIONS, answer: TWO(), place: gerlach, unix: SAT_2PM, choice: 'ground' });
    expect(applicable(p).map((r) => r.key)).toEqual([...all]);
    const patch = patchOf(p, new Set(['windAverage']));
    expect(patch).toEqual({ windAverage: 1.75, launchAltitudeM: 1202 });
    expect(Object.keys(patchOf(p, all))).not.toContain('windStdDev');
    // Hot afternoon at a 1,202 m pad: thinner than the standard day there.
    const after = densityAfter(DEFAULT_CONDITIONS, patchOf(p, all));
    expect(after).toBeGreaterThan(1202);
    expect(after).toBeCloseTo(densityAltitudeM({ launchAltitudeM: 1202, temperatureC: 23.3, pressureHPa: 877.2 }), 9);
  });
});

describe('the provenance an Apply stores', () => {
  it('keeps what was fetched, what was applied, and what each field held — and survives the session', () => {
    const launch: LaunchConditions = { ...DEFAULT_CONDITIONS, windStdDev: 0.7 };
    const p = buildProposal({ launch, answer: TWO(), place: gerlach, unix: SAT_2PM, choice: 'ground' });
    const patch = patchOf(p, all);
    const snap = snapshotOf({ launch, answer: TWO(), place: gerlach, proposal: p, patch, retrievedAt: new Date(Date.UTC(2026, 8, 22, 18)) });
    expect(snap).toMatchObject({
      endpoint: 'forecast', forAltitudeM: 1202, validUnix: SAT_2PM, timezone: 'America/Los_Angeles',
      retrievedAt: '2026-09-22T18:00:00.000Z', demElevationM: 1202,
      place: { label: 'Gerlach, Nevada, US', method: 'search', townCentre: true, countryCode: 'US' },
      fetched: { temperatureC: 23.3, pressureHPa: 877.2, windSpeedMs: 1.75, windGustMs: 4.6, windFromDeg: 294 },
    });
    expect(snap.applied).toEqual(patch);
    expect(snap.applied).not.toHaveProperty('windStdDev');
    // A design from before the Longitude field had no key: `before` keeps that absence.
    expect(snap.before).toEqual({
      temperatureC: null, pressureHPa: null, windAverage: 0, launchAltitudeM: 0, latitudeDeg: 28.61,
    });
    expect(validWeatherSnapshot(JSON.parse(JSON.stringify(snap)))).toEqual(snap);
  });
});
