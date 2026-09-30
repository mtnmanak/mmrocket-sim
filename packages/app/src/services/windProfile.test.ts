// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONDITIONS, kernelSimOptions, type LaunchConditions } from '../components/LaunchPanel.js';
import { ALOFT_VARS, forecastUrl, readWindsAloft, type HourSample } from './openMeteo.js';
import { buildProposal, buildWindProfile } from './weatherProposal.js';
import { editProfileSurface, kernelWindProfile, profileSurface, reconcileProfileSurface, relativeWindDirection, scaleWindSigma, validWindLevels, validWindProfileSource, windProfileSaveNotes } from './windProfile.js';
import { buildSimRun, conditionsKeyOf, runMatchesDesign } from './simReport.js';
import { addRun, loadRuns } from './simStore.js';
import { exportOrk, importOrk } from './orkFile.js';
import { decodeShareFragment, encodeShareFragment } from './shareLink.js';
import { flushSession, loadSession, saveSessionDebounced } from './session.js';
import { importedLaunch } from './importApply.js';
import { applyProposal, beforeOf, undoApply } from './weatherSnapshot.js';

const sample: HourSample = { unix: 1, temperatureC: 20, pressureHPa: 900, windSpeedMs: 4,
  windGustMs: 6, windFromDeg: 350, windsAloft: [
    { altitude: 80, speed: 8, fromDeg: 10 }, { altitude: 200, speed: 12, fromDeg: 330 },
  ] };
const profile: LaunchConditions = { ...DEFAULT_CONDITIONS, timeStepS: 0.05, windAverage: 4, windStdDev: 0.4,
  windLevels: buildWindProfile(sample, 0.4), windProfileSource: { kind: 'open-meteo', place: 'Pad & field', validUnix: 1, surfaceFromDeg: 350 } };
afterEach(() => localStorage.clear());

describe('weather wind profile', () => {
  it.each([0, Number.MIN_VALUE, 5e-10])('restores speed ratios after repeated edits through %s and sigma changes', (speed) => {
    const fixtures: LaunchConditions[] = [profile, { ...profile, windAverage: Math.sqrt(8), windLevels: [
      { altitude: 100, speed: 4, direction: Math.PI / 4 },
      { altitude: -100, speed: 4, direction: -Math.PI / 4 },
    ] }, { ...profile, windLevels: [{ altitude: -100, speed: 4, direction: 0 }] }];
    for (const start of fixtures) {
      const original = JSON.stringify(start);
      let next = start;
      for (const windAverage of [speed, 0.5, 0, 0, 2, speed, 4]) {
        next = editProfileSurface(next, { ...next, windAverage });
        next = editProfileSurface(next, { ...next, windStdDev: 0 });
        next = editProfileSurface(next, { ...next, windStdDev: 0.7 });
        const direct = editProfileSurface(start, { ...start, windAverage, windStdDev: 0.7 });
        expect(next.windLevels!.map((l) => l.altitude)).toEqual(direct.windLevels!.map((l) => l.altitude));
        next.windLevels!.forEach((l, i) => {
          expect(l.speed).toBeCloseTo(direct.windLevels![i]!.speed, 12);
          expect(l.standardDeviation).toBeCloseTo(direct.windLevels![i]!.standardDeviation!, 12);
          expect(l.direction).toBe(direct.windLevels![i]!.direction);
        });
      }
      expect(JSON.stringify(start)).toBe(original);
    }
  });

  it('never offers archive levels, even if a response unexpectedly contains them', () => {
    const q = { launch: profile, place: { latitudeDeg: 40, longitudeDeg: -119 }, unix: 1, choice: 'site' as const,
      answer: { endpoint: 'archive' as const, date: '2021-03-01', demM: 0, elevationsM: [0], timezone: 'UTC',
        variants: [{ elevationM: 0, gridLatitudeDeg: 40, gridLongitudeDeg: -119, timezone: 'UTC', samples: [sample] }] } };
    expect(buildProposal(q).windLevels).toEqual([]);
    expect(buildProposal({ ...q, answer: { ...q.answer, endpoint: 'forecast' } }).windLevels).toEqual(profile.windLevels);
  });

  it('names the profile loss in both unsupported save formats only when a profile exists', () => {
    for (const format of ['.rkt', '.CDX1'] as const) {
      expect(windProfileSaveNotes(profile, format)).toEqual([`Winds aloft are not kept in ${format} files.`]);
      expect(windProfileSaveNotes({}, format)).toEqual([]);
      expect(windProfileSaveNotes({ windLevels: [] }, format)).toEqual([]);
    }
  });
  it('adds exactly the documented levels only to the forecast request', () => {
    expect(ALOFT_VARS).toHaveLength(63);
    const q = { latitudeDeg: 40, longitudeDeg: -119, elevationsM: [1000], startDate: '2026-09-30', endDate: '2026-09-30' };
    const forecast = new URL(forecastUrl({ ...q, endpoint: 'forecast' }));
    expect(forecast.searchParams.get('hourly')).toContain('geopotential_height_30hPa');
    expect(forecast.searchParams.get('hourly')).toContain('wind_direction_180m');
    expect(forecast.searchParams.get('wind_speed_unit')).toBe('ms');
    expect(new URL(forecastUrl({ ...q, endpoint: 'archive' })).searchParams.get('hourly')).not.toMatch(/hPa|80m/);
  });

  it('subtracts response elevation, excludes levels through the highest fixed height, drops nulls and bad units, sorts and dedupes', () => {
    const h: Record<string, unknown> = {};
    const units: Record<string, unknown> = {};
    const put = (suffix: string, speed: unknown, direction: unknown, height?: unknown) => {
      h[`wind_speed_${suffix}`] = [99, speed]; units[`wind_speed_${suffix}`] = 'm/s';
      h[`wind_direction_${suffix}`] = [180, direction]; units[`wind_direction_${suffix}`] = '°';
      h[`geopotential_height_${suffix}`] = [0, height]; units[`geopotential_height_${suffix}`] = 'm';
    };
    put('80m', 6, 30); put('120m', null, 40); put('180m', 8, 50);
    put('1000hPa', 20, 60, 900); // below ground
    put('975hPa', 20, 60, 1180); // equal to the highest fixed level
    put('950hPa', 20, 60, 1150); // inside the fixed-height span
    put('925hPa', 11, 70, 1500); put('900hPa', 9, 80, 1300);
    put('850hPa', 22, 60, 1500); // duplicate, first wins
    put('800hPa', null, 60, 2000); put('700hPa', 20, Infinity, 3000);
    put('600hPa', 20, 60, NaN); put('500hPa', -1, 60, 5000);
    put('400hPa', 20, 60, null); put('300hPa', 20, 60, 9000);
    units['wind_speed_300hPa'] = 'km/h';
    expect(readWindsAloft(h, units, 1, 1000)).toEqual([
      { altitude: 80, speed: 6, fromDeg: 30 }, { altitude: 180, speed: 8, fromDeg: 50 },
      { altitude: 300, speed: 9, fromDeg: 80 }, { altitude: 500, speed: 11, fromDeg: 70 },
    ]);
    h['wind_speed_180m'] = [99, null];
    expect(readWindsAloft(h, units, 1, 1000).map((l) => l.altitude)).toContain(150);
    expect(readWindsAloft({}, {}, 0, 1000)).toEqual([]);
    expect(readWindsAloft(h, units, 1, Infinity).map((l) => l.altitude)).toEqual([80]);
    expect(readWindsAloft(h, units, 1, -Infinity).map((l) => l.altitude)).toEqual([80]);
    expect(readWindsAloft(h, units, 1, -1000).map((l) => l.altitude)).not.toContain(1000);
    expect(readWindsAloft({ ...h, wind_speed_80m: undefined }, units, 1, 1000).map((l) => l.altitude)).not.toContain(80);
  });

  it('rotates through north, retains signed turns and scales sigma including calm and zero turbulence', () => {
    const levels = buildWindProfile(sample, 0.4);
    expect(levels.map((l) => l.altitude)).toEqual([10, 80, 200]);
    expect(levels[0]!.direction).toBe(0);
    expect(levels[1]!.direction * 180 / Math.PI).toBeCloseTo(20, 12);
    expect(levels[2]!.direction * 180 / Math.PI).toBeCloseTo(-20, 12);
    expect(levels.map((l) => l.standardDeviation)).toEqual([0.4, 0.8, 1.2000000000000002]);
    expect(buildWindProfile({ ...sample, windFromDeg: 10, windsAloft: [{ altitude: 80, speed: 8, fromDeg: 350 }] }, 0)[1]!.direction * 180 / Math.PI).toBeCloseTo(-20, 12);
    expect(buildWindProfile(sample, 0).every((l) => l.standardDeviation === 0)).toBe(true);
    expect(buildWindProfile({ ...sample, windSpeedMs: 0 }, 0.7).map((l) => l.standardDeviation)).toEqual([0.7, 0.7, 0.7]);
    expect(scaleWindSigma(0.5, 0, 4)).toBe(0);
    expect(scaleWindSigma(0, Number.MAX_VALUE, Number.MIN_VALUE)).toBe(0);
    expect(relativeWindDirection(-Math.PI)).toBe(Math.PI);
    expect(relativeWindDirection(3 * Math.PI)).toBe(Math.PI);
    for (const patch of [{ windSpeedMs: null }, { windSpeedMs: NaN }, { windSpeedMs: -1 }, { windFromDeg: null }, { windFromDeg: Infinity }, { windsAloft: [] }, { windsAloft: undefined }]) {
      expect(buildWindProfile({ ...sample, ...patch }, 0.4)).toEqual([]);
    }
  });

  it('keeps absent and empty options identical, and sends the rotated AGL profile', () => {
    expect(kernelSimOptions({ ...DEFAULT_CONDITIONS, windLevels: [] })).toEqual(kernelSimOptions(DEFAULT_CONDITIONS));
    expect(kernelWindProfile({})).toEqual({});
    expect(kernelSimOptions(DEFAULT_CONDITIONS)).not.toHaveProperty('windLevels');
    const opts = kernelSimOptions(profile);
    expect(opts.windAltitudeReference).toBe('AGL');
    expect(opts.windLevels?.[0]).toEqual({ altitude: 10, speed: 4, direction: Math.PI / 2, standardDeviation: 0.4 });
    expect(opts.windLevels?.[1]?.direction).toBeCloseTo(Math.PI / 2 + Math.PI / 9, 12);
  });

  it('rekeys a changed height, speed, direction or sigma, but never provenance or an empty profile', () => {
    expect(conditionsKeyOf({ ...DEFAULT_CONDITIONS, windLevels: [] })).toBe(conditionsKeyOf(DEFAULT_CONDITIONS));
    expect(conditionsKeyOf({ ...profile, windProfileSource: { kind: 'ork' } })).toBe(conditionsKeyOf(profile));
    expect(conditionsKeyOf({ ...profile, windProfileSource: undefined })).toBe(conditionsKeyOf(profile));
    for (const field of ['altitude', 'speed', 'direction', 'standardDeviation'] as const) {
      const levels = profile.windLevels!.map((l) => ({ ...l, [field]: (l[field] ?? 0) + 1 }));
      expect(conditionsKeyOf({ ...profile, windLevels: levels })).not.toBe(conditionsKeyOf(profile));
    }
    expect(conditionsKeyOf({ ...profile, windLevels: [{ altitude: 10, speed: 4, direction: 0 }] }))
      .toBe(conditionsKeyOf({ ...profile, windLevels: [{ altitude: 10, speed: 4, direction: 0, standardDeviation: 0 }] }));
  });

  it.each(['windAverage', 'windStdDev'] as const)('keys %s only when the kernel uses the single-level wind', (field) => {
    expect(conditionsKeyOf({ ...profile, [field]: 17 })).toBe(conditionsKeyOf(profile));
    for (const windLevels of [undefined, []]) {
      const single = { ...DEFAULT_CONDITIONS, windLevels };
      expect(conditionsKeyOf({ ...single, [field]: 17 })).not.toBe(conditionsKeyOf(single));
    }
  });

  it.each([0, Number.MIN_VALUE, 5e-10, 1e-9, 2e-9])('uses one calm boundary for mean and turbulence scaling at %s m/s', (speed) => {
    const calm = speed < 1e-9;
    const start = { ...profile, windAverage: speed, windLevels: [
      { altitude: 80, speed: 4, direction: 0 }, { altitude: 10, speed, direction: 0 },
    ] };
    const edited = editProfileSurface(start, { ...start, windAverage: 2 });
    expect(edited.windLevels!.find((l) => l.altitude === 10)!.speed).toBeCloseTo(2, 12);
    expect(edited.windLevels!.find((l) => l.altitude === 80)!.speed).toBe(calm ? 4 : 4 * (2 / speed));
    expect(scaleWindSigma(0.5, 4, speed)).toBe(calm ? 0.5 : 0.5 * (4 / speed));
    const weather = buildWindProfile({ ...sample, windSpeedMs: speed }, 0.5);
    expect(weather[1]!.standardDeviation).toBe(calm ? 0.5 : 0.5 * (8 / speed));
  });

  it.each([-100, 0, 10])('samples a single oblique endpoint at %s without rounding speed or direction', (altitude) => {
    const level = { altitude, speed: 6.45, direction: Math.PI / 180, standardDeviation: 0.2 };
    expect(profileSurface([level])).toEqual({ windAverage: level.speed, windStdDev: 0.2, direction: level.direction });
  });

  it('scales speed and sigma when surface fields change; leaves other edits and absent profiles alone', () => {
    expect(editProfileSurface(profile, profile)).toBe(profile);
    const single = { ...DEFAULT_CONDITIONS, windAverage: 4 };
    expect(editProfileSurface(DEFAULT_CONDITIONS, single)).toBe(single);
    const edited = editProfileSurface(profile, { ...profile, windAverage: 8, windStdDev: 1 });
    expect(edited.windLevels!.map((l) => l.speed)).toEqual([8, 16, 24]);
    expect(edited.windLevels!.map((l) => l.standardDeviation)).toEqual([1, 2, 3]);
    const calm = { ...profile, windAverage: 0, windLevels: buildWindProfile({ ...sample, windSpeedMs: 0 }, 0) };
    expect(editProfileSurface(calm, { ...calm, windAverage: 2 }).windLevels!.map((l) => l.speed)).toEqual([2, 8, 12]);
    const straddling = { ...calm, windLevels: [
      { altitude: -100, speed: 4, direction: 0, standardDeviation: 0 },
      { altitude: 0, speed: 0, direction: 0, standardDeviation: 0 },
      { altitude: 100, speed: 4, direction: Math.PI, standardDeviation: 0 },
    ] };
    expect(editProfileSurface(straddling, { ...straddling, windStdDev: 1 }).windLevels!.map((l) => l.speed)).toEqual([4, 0, 4]);
    const noPad = { ...straddling, windLevels: [straddling.windLevels[0]!, straddling.windLevels[2]!] };
    expect(editProfileSurface(noPad, { ...noPad, windStdDev: 1 }).windLevels).toHaveLength(2);
    expect(editProfileSurface(noPad, { ...noPad, windAverage: 2 }).windLevels!.map((l) => l.altitude)).toEqual([-100, 0, 100]);
    expect(editProfileSurface(straddling, { ...straddling, windAverage: 2 }).windLevels).toEqual([
      { altitude: -100, speed: 4, direction: 0, standardDeviation: 0.8 },
      { altitude: 0, speed: 2, direction: 0, standardDeviation: 0.4 },
      { altitude: 100, speed: 4, direction: Math.PI, standardDeviation: 0.8 },
    ]);
  });

  it('rejects malformed levels and provenance before a weather patch can write them', () => {
    const good = { altitude: 10, speed: 4, direction: 0 };
    expect(validWindLevels([])).toBe(true);
    expect(validWindLevels([good])).toBe(true);
    for (const v of [null, {}, [null], [5], [good, good], [{ ...good, speed: -1 }], [{ ...good, altitude: NaN }],
      [{ ...good, direction: Infinity }], [{ ...good, speed: '4' }], [{ ...good, standardDeviation: null }],
      [{ ...good, standardDeviation: -1 }], [{ ...good, standardDeviation: NaN }],
      ...[-1, NaN, Infinity, null, '2'].map((calmSpeedRatio) => [{ ...good, calmSpeedRatio }])]) {
      expect(validWindLevels(v), JSON.stringify(v)).toBe(false);
      expect(applyProposal(DEFAULT_CONDITIONS, { windLevels: v as never })).toBe(DEFAULT_CONDITIONS);
    }
    expect(validWindProfileSource({ kind: 'ork' })).toBe(true);
    expect(validWindProfileSource(profile.windProfileSource)).toBe(true);
    for (const v of [null, {}, { kind: 'x' }, { ...profile.windProfileSource, kind: 'unknown' }, { kind: 'open-meteo', place: 1, validUnix: 1, surfaceFromDeg: 0 },
      { ...profile.windProfileSource, validUnix: NaN }, { ...profile.windProfileSource, surfaceFromDeg: Infinity }]) expect(validWindProfileSource(v)).toBe(false);
  });

  it('does not revive incomplete or invalid ratios from unvalidated autosave data', () => {
    const zero = editProfileSurface(profile, { ...profile, windAverage: 0 });
    for (const calmSpeedRatio of [undefined, -1, Infinity, NaN, '5']) {
      const corrupt = { ...zero, windLevels: zero.windLevels!.map((l, i) => i === 1 ? { ...l, calmSpeedRatio } : l) } as LaunchConditions;
      const next = editProfileSurface(corrupt, { ...corrupt, windAverage: 2 });
      expect(next.windLevels!.map((l) => l.speed)).toEqual([2, 0, 0]);
      expect(next.windLevels!.every((l) => l.calmSpeedRatio === undefined)).toBe(true);
    }
  });

  it.each(['windAverage', 'windStdDev'] as const)('preserves levels through %s roundoff but reconciles a surviving edit', (field) => {
    const desktop = { ...profile, windAverage: 4, windStdDev: 0.2, windLevels: [
      { altitude: 10, speed: 4, direction: 0, standardDeviation: 0.2 },
      { altitude: 1000, speed: 20, direction: 0.7, standardDeviation: 0.2 },
    ] };
    const roundoff = { ...desktop, [field]: desktop[field] + Number.EPSILON * 4 };
    expect(reconcileProfileSurface(roundoff)).toBe(roundoff);
    expect(reconcileProfileSurface(roundoff).windLevels).toBe(desktop.windLevels);
    const edited = { ...desktop, [field]: desktop[field] + 1e-6 };
    const reconciled = reconcileProfileSurface(edited);
    expect(reconciled.windLevels).not.toBe(desktop.windLevels);
    expect(reconciled.windLevels[0]!.speed).toBeCloseTo(edited.windAverage, 12);
    expect(reconciled.windLevels[0]!.standardDeviation).toBeCloseTo(edited.windStdDev, 12);
  });

  it('reconciles replaced profiles and below-pad vector interpolation with the surface controls', () => {
    expect(reconcileProfileSurface(DEFAULT_CONDITIONS)).toBe(DEFAULT_CONDITIONS);
    expect(reconcileProfileSurface({ ...DEFAULT_CONDITIONS, windLevels: [] }).windLevels).toEqual([]);
    const stale = { ...profile, windAverage: 7, windStdDev: 2 };
    const replaced = applyProposal({ ...DEFAULT_CONDITIONS, windStdDev: 2 }, {
      windAverage: 7, windLevels: profile.windLevels,
    });
    expect(replaced.windLevels![0]).toMatchObject({ speed: 7, standardDeviation: 2 });
    expect(reconcileProfileSurface(stale).windLevels).toEqual(replaced.windLevels);
    for (const sigma of [0, 1, 2]) {
      const desktop = { ...profile, windAverage: Math.sqrt(8), windStdDev: 0.75, windLevels: [
        { altitude: -100, speed: 4, direction: -Math.PI / 4, standardDeviation: 0.5 },
        { altitude: 100, speed: 4, direction: Math.PI / 4, standardDeviation: 1 },
      ] };
      const edited = editProfileSurface(desktop, { ...desktop, windAverage: 6, windStdDev: sigma });
      const levels = kernelWindProfile(edited).windLevels!;
      const x = levels.reduce((sum, l) => sum + l.speed * Math.sin(l.direction) / 2, 0);
      const y = levels.reduce((sum, l) => sum + l.speed * Math.cos(l.direction) / 2, 0);
      expect(Math.hypot(x, y)).toBeCloseTo(edited.windAverage, 12);
      expect(levels.reduce((sum, l) => sum + (l.standardDeviation ?? 0) / 2, 0)).toBeCloseTo(edited.windStdDev, 12);
      // Undo can restore these same desktop levels after surface-only Apply.
      const patch = { windAverage: 3, windLevels: [] };
      const back = undoApply({ ...applyProposal(desktop, patch), windStdDev: sigma },
        { applied: patch, before: beforeOf(desktop, patch) });
      expect(back.windAverage).toBeCloseTo(desktop.windAverage, 12);
      expect(back.windLevels!.reduce((sum, l) => sum + (l.standardDeviation ?? 0) / 2, 0)).toBeCloseTo(sigma, 12);
      const restored = kernelWindProfile(back).windLevels!;
      expect(Math.hypot(
        restored.reduce((sum, l) => sum + l.speed * Math.sin(l.direction) / 2, 0),
        restored.reduce((sum, l) => sum + l.speed * Math.cos(l.direction) / 2, 0),
      )).toBeCloseTo(back.windAverage, 12);
    }
    for (const altitude of [-100, 10]) {
      const single = reconcileProfileSurface({ ...profile, windAverage: 3, windStdDev: 1,
        windLevels: [{ altitude, speed: 4, direction: 0 }] });
      expect(single.windLevels).toEqual([{ altitude, speed: 3, direction: 0, standardDeviation: 1 }]);
    }
    const steady = { ...DEFAULT_CONDITIONS, windAverage: 4, windLevels: [{ altitude: 10, speed: 4, direction: 0 }] };
    expect(reconcileProfileSurface(steady)).toBe(steady);
    const unsorted = { ...profile, windAverage: 6, windStdDev: 1, windLevels: [
      { altitude: 80, speed: 8, direction: 0 }, { altitude: 10, speed: 4, direction: 0 },
    ] };
    expect(reconcileProfileSurface(unsorted).windLevels.find((l) => l.altitude === 10))
      .toMatchObject({ speed: 6, standardDeviation: 1 });
  });
});

describe('profile persistence', () => {
  const tree = { name: 'Wind test', components: [{ type: 'bodytube' as const, length: 0.3, outerRadius: 0.012, thickness: 0.001 }] };
  const xml = () => exportOrk({ tree, name: tree.name, launch: profile });

  it.each([
    { name: 'calm pad', heights: [0, 1000], speeds: [0, 10] },
    { name: 'calm above-pad endpoint', heights: [10, 1000], speeds: [0, 10] },
    { name: 'calm below-pad endpoint', heights: [-1000, -10], speeds: [10, 0] },
    { name: 'subnormal pad', heights: [0, 1000], speeds: [Number.MIN_VALUE, 10] },
    { name: 'near-zero pad', heights: [0, 1000], speeds: [5e-10, 10] },
    { name: 'calm threshold', heights: [0, 1000], speeds: [1e-9, 10] },
    { name: 'opposing winds', heights: [-100, 100], speeds: [4, -4] },
  ])('preserves manual rod-to-level angles for $name regardless of the inactive average bearing', async ({ heights, speeds }) => {
    for (const bearing of [180, 17, 350]) {
      const rod = bearing === 180 ? 90 : 10;
      const directions = speeds.map((speed) => bearing * Math.PI / 180 + (speed < 0 ? Math.PI : 0));
      let firstAim: number | undefined;
      for (const average of [90, 43, 275]) {
        const desktop = xml()
          .replace(/<wind model="multilevel"[\s\S]*?<\/wind>/, `<wind model="multilevel" altituderef="msl">${heights.map((height, i) =>
            `<windlevel altitude="${height + 1000}" speed="${speeds[i]}" direction="${bearing * Math.PI / 180}"/>`).reverse().join('')}</wind>`)
          .replace('<launchaltitude>0</launchaltitude>', '<launchaltitude>1000</launchaltitude>')
          .replace(/<wind model="average">[\s\S]*?<\/wind>/, `<wind model="average"><speed>7</speed><direction>${average * Math.PI / 180}</direction></wind>`)
          .replace('<launchintowind>true</launchintowind>', '<launchintowind>false</launchintowind>')
          .replace(/<launchrodangle>[^<]*</, '<launchrodangle>5<')
          .replace(/<launchroddirection>[^<]*</, `<launchroddirection>${rod}<`);
        const launch = { ...DEFAULT_CONDITIONS, ...importOrk(desktop).launch };
        expect(launch.launchRodAngleDeg).toBe(5);
        firstAim ??= launch.launchRodAimDeg;
        expect(launch.launchRodAimDeg).toBe(firstAim);
        const written = exportOrk({ tree, name: tree.name, launch });
        for (const input of [launch, { ...DEFAULT_CONDITIONS, ...importOrk(written).launch },
          { ...DEFAULT_CONDITIONS, ...importOrk(await decodeShareFragment(await encodeShareFragment(written))).launch }]) {
          const options = kernelSimOptions(input);
          const rodRad = options.launchRodDirection ?? Math.PI / 2;
          for (const [i, level] of options.windLevels!.entries()) {
            // Independent circular-angle oracle: rotating the frame must preserve
            // the signed angle from every original desktop wind to the tilted rod.
            const expected = rod * Math.PI / 180 - directions[i]!;
            expect(Math.sin(rodRad - level.direction)).toBeCloseTo(Math.sin(expected), 12);
            expect(Math.cos(rodRad - level.direction)).toBeCloseTo(Math.cos(expected), 12);
          }
        }
      }
    }
  });

  it.each([0, 5e-10])('uses the retained profile frame for a manual rod at edited speed %s', (speed) => {
    const start = { ...profile, windAverage: Math.sqrt(8), launchRodAngleDeg: 5, launchRodAimDeg: -35, windLevels: [
      { altitude: -100, speed: 4, direction: -Math.PI / 4 },
      { altitude: 100, speed: 4, direction: Math.PI / 4 },
    ] };
    const calm = editProfileSurface(start, { ...start, windAverage: speed });
    const written = exportOrk({ tree, name: tree.name, launch: calm });
    for (const average of [0, 0.7, Math.PI]) {
      const input = written.replace(/<wind model="average">[\s\S]*?<\/wind>/,
        `<wind model="average"><speed>7</speed><direction>${average}</direction></wind>`);
      const read = { ...DEFAULT_CONDITIONS, ...importOrk(input).launch };
      expect(read.launchRodAimDeg).toBe(calm.launchRodAimDeg);
      expect(read.windLevels).toEqual(calm.windLevels);
      expect(kernelSimOptions(read).launchRodDirection).toBe(kernelSimOptions(calm).launchRodDirection);
      expect(kernelSimOptions(read).windLevels).toEqual(kernelSimOptions(calm).windLevels);
    }
  });

  it.each(['missing', 'empty', 'invalid', 'inactive'])('uses the average reference for a %s profile', (kind) => {
    const block = kind === 'missing' ? '' : `<wind model="multilevel" altituderef="agl">${kind === 'empty' ? ''
      : `<windlevel altitude="0" speed="${kind === 'invalid' ? 'broken' : '0'}" direction="${Math.PI}"/>`}</wind>`;
    const input = xml().replace(/<wind model="multilevel"[\s\S]*?<\/wind>/, block)
      .replace('>MultiLevel<', kind === 'inactive' ? '>Average<' : '>MultiLevel<')
      .replace(/<wind model="average">[\s\S]*?<\/wind>/, `<wind model="average"><speed>7</speed><direction>${Math.PI / 4}</direction></wind>`)
      .replace('<launchintowind>true</launchintowind>', '<launchintowind>false</launchintowind>')
      .replace(/<launchrodangle>[^<]*</, '<launchrodangle>5<');
    const launch = { ...DEFAULT_CONDITIONS, ...importOrk(input).launch };
    expect(launch.windLevels).toBeUndefined();
    expect(launch.windAverage).toBe(7);
    expect(launch.launchRodAimDeg).toBe(45);
    expect(kernelSimOptions(launch).launchRodDirection).toBeCloseTo(3 * Math.PI / 4, 12);
  });

  it.each(['forecast', 'straddling', 'originally calm'].flatMap((kind) =>
    [0, Number.MIN_VALUE, 5e-10].map((speed) => ({ kind, speed }))))('preserves $kind recovery at $speed through autosave, ork and share links', async ({ kind, speed }) => {
    let start = profile;
    if (kind === 'straddling') start = { ...profile, windAverage: Math.sqrt(8), windLevels: [
      { altitude: -100, speed: 4, direction: -Math.PI / 4 },
      { altitude: 100, speed: 4, direction: Math.PI / 4 },
    ] };
    if (kind === 'originally calm') {
      const calm = { ...profile, windAverage: 0, windLevels: buildWindProfile({ ...sample, windSpeedMs: 0 }, 0.4) };
      start = editProfileSurface(calm, { ...calm, windAverage: 4 });
    }
    const zero = editProfileSurface(start, { ...start, windAverage: speed });
    expect(zero.windLevels!.every((l) => l.calmSpeedRatio !== undefined)).toBe(true);
    if (speed === 0) expect(zero.windLevels!.every((l) => l.speed === 0)).toBe(true);
    const withoutRatios = { ...zero, windLevels: zero.windLevels!.map(({ altitude, speed, direction, standardDeviation }) =>
      ({ altitude, speed, direction, standardDeviation })) };
    expect(kernelSimOptions(zero)).toEqual(kernelSimOptions(withoutRatios));
    expect(conditionsKeyOf(zero)).toBe(conditionsKeyOf(withoutRatios));
    loadSession(); saveSessionDebounced({ tree, launch: zero }); flushSession();
    const written = exportOrk({ tree, name: tree.name, launch: zero });
    const restored = [loadSession()!.launch,
      importedLaunch(DEFAULT_CONDITIONS, importOrk(written).launch),
      importedLaunch(DEFAULT_CONDITIONS, importOrk(await decodeShareFragment(await encodeShareFragment(written))).launch)];
    for (const stored of restored) {
      expect(stored.windLevels).toEqual(zero.windLevels);
      expect(stored.windProfileSource).toEqual(zero.windProfileSource);
      const next = editProfileSurface(stored, { ...stored, windAverage: 0.5 });
      const direct = editProfileSurface(start, { ...start, windAverage: 0.5 });
      expect(next.windLevels).toEqual(direct.windLevels);
      expect(next.windLevels!.every((l) => !Object.hasOwn(l, 'calmSpeedRatio'))).toBe(true);
    }
    const replacement = importedLaunch(zero, { windAverage: 2 });
    expect(editProfileSurface(replacement, { ...replacement, windAverage: 4 }).windLevels).toBeUndefined();
  });

  it('ignores incomplete, invalid or desktop-edited calm ratios without losing valid wind rows', () => {
    const zero = editProfileSurface(profile, { ...profile, windAverage: 0 });
    const written = exportOrk({ tree, name: tree.name, launch: zero });
    for (const bad of ['-1', 'NaN', 'Infinity', '1e999', 'broken']) {
      const read = importOrk(written.replace(/mmrcalmspeedratio="[^"]*"/, `mmrcalmspeedratio="${bad}"`));
      expect(read.launch!.windLevels).toHaveLength(3);
      expect(read.launch!.windLevels!.every((l) => l.calmSpeedRatio === undefined)).toBe(true);
    }
    for (const edited of [written.replace(/ mmrcalmspeedratio="[^"]*"/, ''),
      written.replace('altitude="80" speed="0"', 'altitude="80" speed="7"'),
      written.replace('altitude="10" speed="0"', 'altitude="10" speed="3"'),
      written.replace(/(<windlevel[^>]*speed=")0("[^>]*mmrcalmspeedratio=")([^"]*)/g,
        (_match, prefix: string, middle: string, ratio: string) => `${prefix}${4 * Number(ratio)}${middle}${ratio}`),
      exportOrk({ tree, name: tree.name, launch: editProfileSurface(profile, { ...profile, windAverage: 5e-10 }) })
        .replace(/mmrcalmspeedratio="[^"]*"/g, 'mmrcalmspeedratio="1e999"')]) {
      const read = importOrk(edited);
      expect(read.launch!.windLevels).toHaveLength(3);
      expect(read.launch!.windLevels!.every((l) => l.calmSpeedRatio === undefined)).toBe(true);
    }
  });
  it.each([0, 0.7, Math.PI / 2])('imports opposing desktop winds at bearing %s and safely edits/reconciles a calm pad', (bearing) => {
    const desktop = xml().replace(/<wind model="multilevel"[\s\S]*?<\/wind>/, `<wind model="multilevel" altituderef="agl">
      <windlevel altitude="-100" speed="4" direction="${bearing}" standarddeviation="0.2"/>
      <windlevel altitude="100" speed="4" direction="${bearing + Math.PI}" standarddeviation="0.2"/>
    </wind>`);
    const start = { ...DEFAULT_CONDITIONS, ...importOrk(desktop).launch };
    expect(start.windAverage).toBeLessThan(1e-9);
    expect(start.windLevels![0]!.direction).toBe(0);
    expect(start.windLevels![1]!.direction).toBeCloseTo(Math.PI, 12);
    expect(importOrk(desktop.replace('<launchintowind>true</launchintowind>', '<launchintowind>false</launchintowind>'))
      .launch!.launchRodAimDeg).toBeCloseTo(90 - bearing * 180 / Math.PI, 8);
    for (const edit of [{ windAverage: 2 }, { windStdDev: 0.7 }, { windAverage: 2, windStdDev: 0.7 }]) {
      for (const result of [editProfileSurface(start, { ...start, ...edit }), reconcileProfileSurface({ ...start, ...edit })]) {
        const levels = result.windLevels!;
        expect(levels.filter((l) => l.altitude !== 0).map((l) => l.speed)).toEqual([4, 4]);
        expect(levels.every((l) => Number.isFinite(l.speed) && l.speed <= 4
          && Number.isFinite(l.standardDeviation) && l.standardDeviation! <= 1.4)).toBe(true);
        expect(levels.find((l) => l.altitude === 0)?.speed).toBe(edit.windAverage);
        expect(kernelWindProfile(result).windLevels!.map((l) => l.speed)).toEqual(levels.map((l) => l.speed));
        const reopened = importOrk(exportOrk({ tree, name: tree.name, launch: result }));
        expect(reopened.launch!.windLevels).toEqual(levels);
      }
    }
  });

  it.each([[-200, -100], [0, 100], [10, 100], [-100, 0]])('preserves exact endpoint speed for desktop heights %s to %s', (low, high) => {
    for (const degrees of [1, 17, 91, 179, 271]) {
      const desktop = xml().replace(/<wind model="multilevel"[\s\S]*?<\/wind>/, `<wind model="multilevel" altituderef="agl">
        <windlevel altitude="${low}" speed="6.45" direction="${degrees * Math.PI / 180}"/>
        <windlevel altitude="${high}" speed="6.45" direction="${degrees * Math.PI / 180}"/>
      </wind>`);
      const start = { ...DEFAULT_CONDITIONS, ...importOrk(desktop).launch };
      expect(start.windAverage).toBe(6.45);
      const reopened = importOrk(exportOrk({ tree, name: tree.name, launch: start }));
      expect(reopened.launch!.windAverage).toBe(start.windAverage);
      expect(reopened.launch!.windLevels).toEqual(start.windLevels);
    }
  });
  it.each(['surface', 'aloft'] as const)('restores every imported desktop level bit-for-bit after %s Apply and immediate Undo', (mode) => {
    const desktop = xml().replace(/<wind model="multilevel"[\s\S]*?<\/wind>/, `<wind model="multilevel" altituderef="agl">
      <windlevel altitude="10" speed="4" direction="0.7" standarddeviation="0.2"/>
      <windlevel altitude="1000" speed="20" direction="0.7" standarddeviation="0.2"/>
    </wind>`);
    const start = { ...DEFAULT_CONDITIONS, ...importOrk(desktop).launch };
    expect(start.windLevels!.map((l) => l.speed)).toEqual([4, 20]);
    expect(start.windLevels!.map((l) => l.standardDeviation)).toEqual([0.2, 0.2]);
    const patch = { windAverage: 3, windLevels: mode === 'surface' ? [] : [
      { altitude: 10, speed: 3, direction: 0, standardDeviation: start.windStdDev },
      { altitude: 80, speed: 6, direction: 0.3, standardDeviation: start.windStdDev * 2 },
    ] };
    const receipt = { applied: patch, before: beforeOf(start, patch) };
    const back = undoApply(applyProposal(start, patch), receipt);
    expect(back).toStrictEqual(start);
    for (const [i, level] of start.windLevels!.entries()) {
      for (const key of ['altitude', 'speed', 'direction', 'standardDeviation'] as const) {
        expect(Object.is(back.windLevels![i]![key], level[key]), `level ${i} ${key}`).toBe(true);
      }
    }
    expect(kernelSimOptions(back)).toStrictEqual(kernelSimOptions(start));
  });

  it.each(['fixture', 'oblique endpoint', 'oblique interpolation'])('imports, flies, saves and matches a desktop %s profile', async (kind) => {
    const block = kind === 'fixture' ? readFileSync(join(dirname(fileURLToPath(import.meta.url)), '__fixtures__/wind-lem-iv.xml'), 'utf8')
      : `<wind model="multilevel" altituderef="agl">
        <windlevel altitude="${kind === 'oblique endpoint' ? 10 : -100}" speed="6.45" direction="${Math.PI / 180}" standarddeviation="0.2"/>
        <windlevel altitude="100" speed="8" direction="0.7" standarddeviation="0.4"/>
      </wind>`;
    const flightTree: RocketTree = { name: 'Small wind test', components: [
      { type: 'nosecone', length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
      { type: 'bodytube', length: 0.3, outerRadius: 0.012, thickness: 0.0003, density: 950, children: [
        { type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
        { type: 'innertube', id: 'mount', length: 0.07, outerRadius: 0.0095, thickness: 0.0005, motorMount: true },
        { type: 'parachute', diameter: 0.3 },
      ] },
    ] };
    const input = exportOrk({ tree: flightTree, name: 'Small wind test', launch: profile })
      .replace(/<wind model="multilevel"[\s\S]*?<\/wind>/, block);
    const read = importOrk(input);
    expect(read.launch!.windLevels).toHaveLength(kind === 'fixture' ? 23 : 2);
    expect(read.launch!.windProfileSource).toEqual({ kind: 'ork' });
    const { OrkRocket } = await import('@online-openrocket/engine');
    const rocket = OrkRocket.buildTree(read.tree);
    const flatten = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
    const mount = flatten(read.tree.components).find((n) => n['motorMount'] === true)!;
    const motor = {
      designation: 'C6', diameter: 0.018, length: 0.07, cgX: 0.035, ejectionDelay: 5,
      times: [0, 0.1, 0.3, 0.5, 1, 1.5, 1.85, 2], thrusts: [0, 12, 6, 5.1, 4.9, 4.8, 4.5, 0],
      masses: [0.024, 0.0231, 0.0215, 0.0202, 0.0174, 0.0147, 0.0133, 0.0132],
    };
    rocket.setMotorById(mount.id!, motor);
    const launch = { ...DEFAULT_CONDITIONS, ...read.launch };
    const opts = { ...kernelSimOptions(launch), series: 'full' as const, maxTime: 3, randomSeed: 7 };
    const flown = rocket.simulate(opts);
    expect(flown.summary.maxAltitude).toBeGreaterThan(0);
    expect(flown.series).not.toEqual(rocket.simulate({ ...opts, windLevels: undefined }).series);
    expect(rocket.simulate(opts).series).toEqual(flown.series);
    const run = buildSimRun({ result: flown, info: rocket.staticInfo(), motor, launch,
      rocketName: read.tree.name!, execMs: 1, designKey: 'same rocket', motorSetKey: 'same motor', aeroModel: 'classic', rogersKbf: false });
    const reopened = { ...DEFAULT_CONDITIONS, ...importOrk(exportOrk({ tree: read.tree, name: 'Small wind test', launch })).launch };
    const current = { designKey: run.designKey!, motorSetKey: run.motorSetKey!, conditionsKey: conditionsKeyOf(reopened),
      aeroMode: 'classic' as const, effectiveKbf: false, autoSupersonic: false };
    expect(reopened.windLevels).toEqual(launch.windLevels);
    addRun(run);
    const stored = loadRuns()[0]!;
    expect(stored.windLevels).toEqual(launch.windLevels);
    expect(runMatchesDesign(stored, current)).toBe(true);
    expect(runMatchesDesign(stored, { ...current, conditionsKey: conditionsKeyOf({ ...reopened,
      windLevels: reopened.windLevels!.map((l, i) => i === 0 ? { ...l, speed: l.speed + 1 } : l),
    }) })).toBe(false);
    expect(rocket.simulate({ ...opts, ...kernelSimOptions(reopened) }).series).toEqual(flown.series);
    const ignoredScalars = { ...launch, windAverage: 17, windStdDev: 5 };
    expect(rocket.simulate({ ...opts, ...kernelSimOptions(ignoredScalars) }).series).toEqual(flown.series);
    expect(conditionsKeyOf(ignoredScalars)).toBe(run.conditionsKey);
  }, 30000);
  it('round trips full precision and source through .ork and a share link', async () => {
    const written = xml();
    expect(written).toContain('model="multilevel" altituderef="agl"');
    expect(written).toContain(`direction="${Math.PI / 2}"`);
    for (const input of [written, await decodeShareFragment(await encodeShareFragment(written))]) {
      const read = importOrk(input);
      expect(read.launch!.windLevels).toEqual(profile.windLevels);
      expect(read.launch!.windProfileSource).toEqual(profile.windProfileSource);
      expect(conditionsKeyOf({ ...DEFAULT_CONDITIONS, ...read.launch })).toBe(conditionsKeyOf(profile));
      expect(kernelSimOptions({ ...DEFAULT_CONDITIONS, ...read.launch })).toEqual(kernelSimOptions(profile));
    }
  });

  it('flies desktop MSL profiles as AGL, ignores inactive blocks, and keeps below-pad interpolation', () => {
    const desktop = xml().replace(/<wind model="multilevel"[\s\S]*?<\/wind>/, `<wind model="multilevel" altituderef="msl">
      <windlevel altitude="2000" speed="12" direction="${Math.PI}" standarddeviation="2"/>
      <windlevel altitude="900" speed="4" direction="0" standarddeviation="0.5"/>
      <windlevel altitude="1100" speed="4" direction="${Math.PI / 2}" standarddeviation="1"/>
    </wind>`).replace('<launchaltitude>0</launchaltitude>', '<launchaltitude>1000</launchaltitude>');
    const r = importOrk(desktop);
    expect(r.launch!.windLevels!.map((l) => l.altitude)).toEqual([-100, 100, 1000]);
    expect(r.launch!.windLevels![0]!.direction).toBeCloseTo(-Math.PI / 4, 12);
    expect(r.launch!.windAverage).toBeCloseTo(Math.sqrt(8), 12);
    expect(r.launch!.windStdDev).toBe(0.75);
    expect(r.launch!.windProfileSource).toEqual({ kind: 'ork' });
    expect(kernelSimOptions({ ...DEFAULT_CONDITIONS, ...r.launch }).windLevels).toHaveLength(3);
    expect(r.notes.join(' ')).not.toMatch(/doesn.t model|imported instead/);
    expect(importOrk(desktop.replace('>MultiLevel<', '>Average<')).launch!.windLevels).toBeUndefined();
    const round = importOrk(exportOrk({ tree, name: tree.name, launch: { ...DEFAULT_CONDITIONS, ...r.launch } }));
    expect(round.launch!.windLevels).toEqual(r.launch!.windLevels);
  });

  it('uses absolute directions when desktop edits our attributes, handles negative speed and invalid rows, and defaults to MSL', () => {
    const input = xml().replace(/<wind model="multilevel"[\s\S]*?<\/wind>/, `<wind model="multilevel" mmrsource="broken">
      <windlevel altitude="20" speed="-4" direction="0"/>
      <windlevel altitude="20" speed="4" direction="0"/>
      <windlevel altitude="80" speed="8" direction="0" mmrrelativedirection="0.1"/>
      <windlevel altitude="oops" speed="3" direction="0"/>
    </wind>`);
    const r = importOrk(input);
    expect(r.launch!.windLevels).toHaveLength(2);
    expect(r.launch!.windLevels![0]!.speed).toBe(4);
    expect(r.launch!.windLevels![1]!.direction).toBe(Math.PI);
    expect(r.launch!.windLevels![0]!.standardDeviation).toBe(0);
    expect(r.launch!.windProfileSource).toEqual({ kind: 'ork' });
    expect(r.notes.join(' ')).toContain('Invalid or duplicate wind levels');
    const calm = importOrk(input.replace('speed="-4"', 'speed="0"'));
    expect(calm.launch!.windLevels![0]!.direction).toBe(0);
  });

  it('persists the profile in autosave and clears it when the next file carries none', () => {
    loadSession();
    saveSessionDebounced({ tree, launch: profile }); flushSession();
    expect(loadSession()!.launch).toEqual(profile);
    expect(importedLaunch(profile, undefined).windLevels).toBeUndefined();
    expect(importedLaunch(profile, { windAverage: 1 }).windProfileSource).toBeUndefined();
    expect(importedLaunch(DEFAULT_CONDITIONS, profile).windLevels).toEqual(profile.windLevels);
  });

  it('Apply and Undo restore the preceding profile and preserve later manual edits', () => {
    const start = { ...DEFAULT_CONDITIONS, windStdDev: profile.windStdDev };
    const patch = { windAverage: profile.windAverage, windLevels: profile.windLevels, windProfileSource: profile.windProfileSource };
    const before = beforeOf(start, patch);
    const after = applyProposal(start, patch);
    expect(after.windLevels).toEqual(profile.windLevels);
    expect(after.windLevels).not.toBe(profile.windLevels);
    expect(undoApply(after, { before, applied: patch })).toEqual(start);
    const receipt = { before: beforeOf(profile, { windLevels: [] }), applied: { windLevels: [] } };
    expect(undoApply(applyProposal(profile, receipt.applied), receipt)).toEqual(profile);
    const edited = { ...after, windLevels: [{ altitude: 10, speed: 17, direction: 0 }] };
    expect(undoApply(edited, { before, applied: patch }).windLevels).toEqual(edited.windLevels);
  });
});
