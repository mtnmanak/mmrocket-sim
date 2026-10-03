import { describe, expect, it } from 'vitest';
import type { FlightResult } from '@online-openrocket/engine';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { railNeeded, railNeededLine, railProfileFromFlight } from './railNeeded.js';

const launch = { ...DEFAULT_CONDITIONS, launchRodLengthM: 1 };
const flight = (): FlightResult => ({
  effectiveLaunchRodLength: 0.8,
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
    const profile = railProfileFromFlight(f, { ...launch, launchRodLengthM: 4 });
    expect(railNeeded(profile, 15)).toEqual({ status: 'thrust-ended', railM: 4 });
    expect(railNeededLine(profile, 15, 'm', 'm/s')).toBe(
      'Cannot reach 15.0 m/s on the guide: thrust ended before reaching that speed. Guide-position allowance on.');
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
    expect(railNeeded(extract(zero), 15)).toEqual({ status: 'not-reached', railM: 1 });
  });

  it('adds the design offset only with allowance on and says which in the report', () => {
    const on = extract();
    expect(railNeededLine(on, 15, 'ft', 'm/s')).toBe(
      'Reaches 15.0 m/s after 0.7 ft of guide travel (1.3 ft of rail, allowing for where the launch lugs/rail buttons sit).');
    const f = flight(); f.effectiveLaunchRodLength = 1;
    const off = railProfileFromFlight(f, { ...launch, launchGuideAllowance: false });
    expect(railNeeded(off, 15)).toEqual({ status: 'reached', travelM: 0.2, railM: 0.2 });
    expect(railNeededLine(off, 15, 'ft', 'm/s')).toContain('guide-position allowance off');
    expect(railNeededLine(on, 30, 'ft', 'm/s')).toContain('within 3.3 ft of rail');
  });
});
