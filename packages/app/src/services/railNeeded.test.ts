import { describe, expect, it } from 'vitest';
import type { FlightResult } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { railNeeded, railNeededCell, railNeededHeader, railNeededLine, railProfileFromFlight } from './railNeeded.js';

const launch = { ...DEFAULT_CONDITIONS, launchRodLengthM: 1 };
const flight = (): FlightResult => ({
  effectiveLaunchRodLength: 0.8,
  launchGuideReason: 'buttons',
  events: [{ type: 'LAUNCHROD', time: 0.03 }],
  series: {
    time: [0, 0.01, 0.02, 0.03, 0.04], altitude: [0, 0.1, 0.3, 0.8, 1.5],
    velocity: [0, 10, 20, 25, 40], thrust: [0, 20, 20, 20, 20],
  },
} as FlightResult);
const extract = (f = flight()) => railProfileFromFlight(f, launch);

describe('rail travel from the existing flight', () => {
  it('inverts the first upward crossing exactly, including an endpoint', () => {
    const crossing = railNeeded(extract(), 15);
    expect(crossing?.status).toBe('reached');
    if (crossing?.status === 'reached') {
      expect(crossing.travelM).toBeCloseTo(0.2, 12);
      expect(crossing.railM).toBeCloseTo(0.4, 12);
    }
    expect(railNeeded(extract(), 20)?.status).toBe('reached');
    const f = flight();
    f.series.velocity = [0, 20, 10, 20, 40];
    const first = railNeeded(extract(f), 15);
    if (first?.status !== 'reached') throw new Error('No crossing');
    expect(first.travelM).toBeCloseTo(0.075, 12);
  });

  it('uses pad-relative lateral distance for a tilted guide', () => {
    const f = flight();
    f.series['Pl'] = [0, 0.1, 0.3, 0.8, 1.5];
    const r = railNeeded(extract(f), 15);
    expect(r?.status).toBe('reached');
    if (r?.status === 'reached') expect(r.travelM).toBeCloseTo(Math.SQRT2 * 0.2, 12);
  });

  it('never uses the speed after guide clearance', () => {
    const f = flight();
    f.events = [{ type: 'LAUNCHROD', time: 0.01 }];
    expect(railNeeded(extract(f), 15)).toEqual({ status: 'not-reached', railM: 1 });
    expect(railNeeded(extract(), 30)).toEqual({ status: 'not-reached', railM: 1 });
  });

  it('clips the clearance step to the actual effective guide length', () => {
    const f = flight();
    f.effectiveLaunchRodLength = 0.2;
    f.events = [{ type: 'LAUNCHROD', time: 0.02 }];
    expect(railNeeded(extract(f), 18)).toEqual({ status: 'not-reached', railM: 1 });
  });

  it('excludes downward and post-apogee crossings', () => {
    const f = flight();
    f.series.altitude = [0, -0.1, -0.3, -0.8, -1.5];
    expect(railNeeded(extract(f), 15)?.status).toBe('not-reached');
    f.series.altitude = flight().series.altitude;
    f.events.unshift({ type: 'APOGEE', time: 0.01 });
    expect(railNeeded(extract(f), 15)?.status).toBe('not-reached');
  });

  it('distinguishes final thrust ending while guided from a short rail or first cluster burnout', () => {
    const f = flight();
    f.events = [{ type: 'BURNOUT', time: 0.02 }];
    f.series.thrust = [0, 20, 0, 0, 0];
    f.series.velocity = [0, 10, 12, 11, 10];
    expect(railNeeded(extract(f), 15)?.status).toBe('thrust-ended');
    f.series.thrust[3] = 20;
    expect(railNeeded(extract(f), 15)?.status).toBe('not-reached');
    f.series.thrust[3] = 0;
    f.events.push({ type: 'BURNOUT', time: 0.05 });
    expect(railNeeded(extract(f), 15)?.status).toBe('not-reached');
  });

  it('reports cannot reach when burnout follows apogee while still confined to a 4 m guide', () => {
    const f = flight();
    f.effectiveLaunchRodLength = 4;
    f.events = [{ type: 'APOGEE', time: 1.01 }, { type: 'BURNOUT', time: 1.6 }];
    const time = Array.from({ length: 171 }, (_, i) => i / 100);
    // Synthetic telemetry: a weak motor never clears the guide or reaches
    // 15 m/s, but continues thrusting after the 1.01 s apogee until 1.60 s.
    f.series = { ...f.series, time,
      altitude: time.map((t) => 2 * (1.01 ** 2 - (t - 1.01) ** 2)),
      velocity: time.map((t) => Math.abs(4 * (1.01 - t))),
      thrust: time.map((t) => t < 1.6 ? 0.1 : 0),
    };
    const profile = railProfileFromFlight(f, { ...launch, launchRodLengthM: 4.2 });
    expect(railNeeded(profile, 15)).toEqual({ status: 'thrust-ended', railM: 4.2 });
    expect(railNeededLine(profile, 15, 'm', 'm/s')).toContain(
      'Cannot reach 15.0 m/s: thrust ended before reaching that speed while still guided.');
    expect(railNeededLine(profile, 15, 'm', 'm/s')).toContain('The simulated limit was 4 m of travel');
    expect(railNeededLine(profile, 15, 'm', 'm/s')).toContain('(4.2 m of rail if the tail sits at the bottom of the rail)');
  });

  it('keeps a delayed cluster ignition indeterminate without a later burnout or positive thrust sample', () => {
    const f = flight();
    f.events = [
      { type: 'IGNITION', time: 0 },
      { type: 'BURNOUT', time: 0.02 },
      { type: 'IGNITION', time: 0.03 },
    ];
    f.series.altitude = [0, 0.1, 0.2, 0.3, 0.4];
    f.series.velocity = [0, 10, 12, 11, 10];
    f.series.thrust = [0, 20, 0, 0, 0];
    expect(railNeeded(extract(f), 15)).toEqual({ status: 'not-reached', railM: 1 });
    // The later IGNITION is the only evidence that the first burnout is not final.
    f.events.pop();
    expect(railNeeded(extract(f), 15)).toEqual({ status: 'thrust-ended', railM: 1 });
  });

  it('fails closed for failed flights, missing data, gaps, and unknown offsets', () => {
    const f = flight();
    f.events.push({ type: 'SIM_ABORT', time: 1 });
    expect(extract(f)).toBeUndefined();
    f.events = [];
    f.series.velocity[1] = NaN;
    expect(extract(f)).toBeUndefined();
    const gap = flight(); gap.series.time[1] = 0.1;
    expect(extract(gap)).toBeUndefined();
    const old = flight(); delete old.effectiveLaunchRodLength;
    expect(extract(old)).toBeUndefined();
    expect(railNeeded(undefined, 15)).toBeUndefined();
    const branchFailure = flight();
    branchFailure.branches = [{ events: [{ type: 'SIM_ABORT', time: 1 }] }] as FlightResult['branches'];
    expect(extract(branchFailure)).toBeUndefined();
    const zero = flight(); zero.effectiveLaunchRodLength = 0;
    expect(railNeeded(extract(zero), 15)).toEqual({ status: 'undetermined', railM: 1 });
  });

  it.each(['buttons', 'mixed-buttons'] as const)('qualifies the measuring button by rail line for %s', (guideKind) => {
    const profile = { ...extract()!, guideKind };
    for (const candidate of [profile, { ...profile, thrustEnded: true }, { ...profile, offsetM: null }]) {
      for (const threshold of [15, 30]) {
        expect(railNeededLine(candidate, threshold, 'm', 'm/s')).toContain(
          'second rail button up from the tail on the line the rail runs through');
      }
    }
  });

  it('adds the design offset only with allowance on and says which in the report', () => {
    const on = extract();
    expect(railNeededLine(on, 15, 'ft', 'm/s')).toBe(
      'Reaches 15.0 m/s after 0.7 ft of travel, measured from the bottom edge of the second rail button up from the tail on the line the rail runs through (the upper button on a two-button rocket) '
      + '(1.3 ft of rail if the tail sits at the bottom of the rail). At the pad, measure the usable rail from that button edge to the end of the rail.');
    const f = flight(); f.effectiveLaunchRodLength = 1;
    const off = railProfileFromFlight(f, { ...launch, launchGuideAllowance: false });
    expect(railNeeded(off, 15)).toEqual({ status: 'reached', travelM: 0.2, railM: 0.2 });
    expect(railNeededLine(off, 15, 'ft', 'm/s')).toContain('Guide-position allowance is off.');
    expect(railNeededLine(on, 30, 'ft', 'm/s')).toContain('within 2.6 ft of travel');
    expect(railNeededLine(on, 30, 'ft', 'm/s')).toContain('3.3 ft of rail if the tail sits at the bottom of the rail');
  });

  it.each(['buttons', 'lug', 'mixed-buttons', 'mixed-lug', 'none', 'off', 'single-button'] as const)(
    'retains %s and words every outcome by the flown guide kind', (guideKind) => {
      const f = flight(); f.launchGuideReason = guideKind;
      f.effectiveLaunchRodLength = guideKind === 'single-button' ? 0 : guideKind === 'none' || guideKind === 'off' ? 1 : 0.8;
      const profile = extract(f)!;
      expect(profile.guideKind).toBe(guideKind);
      const point = guideKind.includes('buttons') ? 'bottom edge of the second rail button up from the tail on the line the rail runs through (the upper button on a two-button rocket)'
        : guideKind.includes('lug') ? 'bottom of the lowest launch lug' : 'travel of the rocket itself';
      const lines = guideKind === 'single-button' ? [railNeededLine(profile, 15, 'm', 'm/s')!]
        : [railNeededLine(profile, 15, 'm', 'm/s')!, railNeededLine(profile, 30, 'm', 'm/s')!,
          railNeededLine({ ...profile, thrustEnded: true }, 30, 'm', 'm/s')!];
      for (const line of lines) {
        if (guideKind !== 'single-button') expect(line).toContain(point);
        if (guideKind.startsWith('mixed-')) expect(line).toContain(`the app used the shorter travel (${guideKind.slice(6) === 'lug' ? 'lug' : 'buttons'})`);
        if (guideKind === 'single-button') {
          expect(line).not.toContain('The rail figure');
        } else if (guideKind === 'none' || guideKind === 'off') {
          expect(line).toContain('The rail figure equals the travel of the rocket itself.');
        } else {
          expect(line).toContain(guideKind.includes('lug') ? 'from that lug edge to the end of the rod' : 'from that button edge to the end of the rail');
        }
      }
      if (guideKind === 'single-button') {
        expect(lines[0]).toContain('cannot hold the rocket straight');
        expect(lines[0]).toContain('No required travel or rail length can be determined');
      } else {
        const launcher = guideKind.includes('lug') ? 'rod' : 'rail';
        const requiredM = guideKind === 'none' || guideKind === 'off' ? '0.2' : '0.4';
        expect(lines[0]).toMatch(/^Reaches/);
        expect(lines[0]).toContain(`(${requiredM} m of ${launcher} if the tail sits at the bottom of the ${launcher})`);
        expect(lines[1]).toMatch(/^Did not reach/);
        expect(lines[1]).toContain(`a longer ${launcher} has not been simulated`);
        expect(lines[2]).toMatch(/^Cannot reach/);
        expect(lines[2]).toContain(`The simulated limit was ${guideKind === 'none' || guideKind === 'off' ? '1' : '0.8'} m of travel`);
        expect(lines[2]).toContain(`(1 m of ${launcher} if the tail sits at the bottom of the ${launcher})`);
      }
    });

  it.each([
    ['buttons', 'the bottom edge of the second rail button up from the tail on the line the rail runs through (the upper button on a two-button rocket)', 'rail', 'button'],
    ['lug', 'the bottom of the lowest launch lug', 'rod', 'lug'],
    ['mixed-buttons', 'the bottom edge of the second rail button up from the tail on the line the rail runs through (the upper button on a two-button rocket)', 'rail', 'button'],
    ['mixed-lug', 'the bottom of the lowest launch lug', 'rod', 'lug'],
  ] as const)('names the guide point when %s travel clamps to zero', (guideKind, point, launcher, edge) => {
    const f = flight();
    f.launchGuideReason = guideKind;
    f.effectiveLaunchRodLength = 0;
    const profile = railProfileFromFlight(f, { ...launch, launchRodLengthM: 0.4 })!;
    expect(profile.offsetM).toBeNull();
    expect(railNeeded(profile, 15)).toEqual({ status: 'undetermined', railM: 0.4 });
    expect(railNeededLine(profile, 15, 'm', 'm/s')).toBe(
      `Did not reach 15.0 m/s: the simulation provided no guided travel (measured from ${point}) on the entered 0.4 m ${launcher}. `
      + `No required travel or ${launcher} length can be determined. `
      + `At the pad, measure the usable ${launcher} from that ${edge} edge to the end of the ${launcher}.`
      + (guideKind.startsWith('mixed-') ? ` With both lugs and buttons fitted, the app used the shorter travel (${guideKind === 'mixed-lug' ? 'lug' : 'buttons'}).` : ''));
  });

  it.each(['off', 'none'] as const)('omits the rail figure for %s with a zero-length rail', (guideKind) => {
    const f = flight();
    f.launchGuideReason = guideKind;
    f.effectiveLaunchRodLength = 0;
    const profile = railProfileFromFlight(f, {
      ...launch, launchRodLengthM: 0, launchGuideAllowance: guideKind !== 'off',
    })!;
    expect(profile.offsetM).toBeNull();
    for (const [threshold, speed] of [[0, '0.000'], [15, '15.0']] as const) {
      expect(railNeeded(profile, threshold)).toEqual({ status: 'undetermined', railM: 0 });
      expect(railNeededLine(profile, threshold, 'm', 'm/s')).toBe(
        `Did not reach ${speed} m/s: the simulation provided no guided travel on the entered 0 m rail. `
        + 'No required travel or rail length can be determined. '
        + (guideKind === 'off' ? 'Guide-position allowance is off.' : 'No launch guide is fitted.'));
    }
  });

  it('does not invent a guide kind for an older saved profile', () => {
    const profile = extract()!; delete profile.guideKind;
    expect(railNeededLine(profile, 15, 'm', 'm/s')).toContain('re-launch to identify the measuring point');
    expect(railNeededLine(profile, 15, 'm', 'm/s')).not.toContain('upper rail button');
    expect(railNeededLine(undefined, 15, 'm', 'm/s')).toBeNull();
  });

  it.each(['single-button', 'buttons', 'lug', 'mixed-buttons', 'mixed-lug'] as const)(
    'cannot determine either length without guided travel for %s', (guideKind) => {
      const f = flight();
      f.launchGuideReason = guideKind;
      f.effectiveLaunchRodLength = 0;
      const profile = extract(f)!;
      for (const threshold of [0, 15]) {
        expect(railNeeded(profile, threshold)).toEqual({ status: 'undetermined', railM: 1 });
        for (const measure of ['travel', 'rail'] as const) {
          expect(railNeededCell(profile, threshold, 'ft', measure)).toBe('Cannot be determined: no guided travel');
        }
      }
    });

  it('formats both lengths, limits, statuses and units without extrapolating', () => {
    const profile = extract()!;
    expect(railNeededCell(profile, 15, 'ft', 'travel')).toBe('0.7');
    expect(railNeededCell(profile, 15, 'ft')).toBe('1.3');
    expect(railNeededCell(profile, 15, 'm', 'travel')).toBe('0.2');
    expect(railNeededCell(profile, 15, 'm')).toBe('0.4');
    expect(railNeededCell(profile, 30, 'm', 'travel')).toBe('Not reached within 0.8 m');
    expect(railNeededCell(profile, 30, 'm')).toBe('Not reached within 1 m');
    for (const measure of ['travel', 'rail'] as const) {
      expect(railNeededCell({ ...profile, thrustEnded: true }, 30, 'm', measure)).toBe('Cannot reach: thrust ended');
      expect(railNeededCell(undefined, 15, 'm', measure)).toBe('');
      expect(railNeededHeader(15, 'ft/s', 'ft', measure)).toBe(`${measure === 'travel' ? 'Travel' : 'Rail'} for 49.2 ft/s (ft)`);
    }
    expect(railNeededLine(profile, 15, 'm', 'ft/s')).toContain('Reaches 49.2 ft/s after 0.2 m');
  });
});
