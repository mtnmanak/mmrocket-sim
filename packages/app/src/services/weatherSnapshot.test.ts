import { describe, expect, it } from 'vitest';
import { DEFAULT_CONDITIONS, type LaunchConditions } from '../components/LaunchPanel.js';
import {
  applyProposal, beforeOf, carrySigmaEstimate, fieldProvenance, staleness, undoApply, validWeatherSnapshot,
  withSigmaEstimate,
  type WeatherSnapshot,
} from './weatherSnapshot.js';

/**
 * The provenance kept beside applied weather (weather build, step 3): pure
 * functions, so each rule the panel shows — "forecast", "edited", Undo, the
 * stale-altitude note — is pinned here without a render.
 */

const HOT_PAD: LaunchConditions = { ...DEFAULT_CONDITIONS, launchAltitudeM: 1190, windStdDev: 0.7 };

function snap(over: Partial<WeatherSnapshot> = {}): WeatherSnapshot {
  return {
    v: 1, provider: 'open-meteo', endpoint: 'forecast', model: 'best_match',
    place: { label: 'Gerlach, Nevada, US', latitudeDeg: 40.65157, longitudeDeg: -119.35519, method: 'search', townCentre: true },
    grid: { latitudeDeg: 40.66386, longitudeDeg: -119.35593 },
    demElevationM: 1202,
    forAltitudeM: 1190,
    timezone: 'America/Los_Angeles',
    validUnix: Date.UTC(2026, 8, 26, 21) / 1000,
    retrievedAt: '2026-09-22T18:00:00.000Z',
    fetched: { temperatureC: 23.3, pressureHPa: 879.6, windSpeedMs: 5, windGustMs: 11, windFromDeg: 294 },
    applied: { temperatureC: 23.3, pressureHPa: 879.6, windAverage: 5 },
    before: { temperatureC: null, pressureHPa: null, windAverage: 0 },
    ...over,
  };
}

describe('applyProposal', () => {
  it('writes only the patch’s fields, and leaves every other one the same value', () => {
    const next = applyProposal(HOT_PAD, { windAverage: 5 });
    expect(next.windAverage).toBe(5);
    for (const k of Object.keys(HOT_PAD) as (keyof LaunchConditions)[]) {
      if (k !== 'windAverage') expect(Object.is(next[k], HOT_PAD[k]), k).toBe(true);
    }
  });

  it('never writes σ, an undefined, or a non-number — whatever it is handed', () => {
    const next = applyProposal(HOT_PAD, { windStdDev: 3, longitudeDeg: undefined, latitudeDeg: NaN } as never);
    expect(next).toBe(HOT_PAD);
    expect(next.windStdDev).toBe(0.7);
    expect(Object.hasOwn(next, 'longitudeDeg')).toBe(false);
  });
});

describe('undoApply', () => {
  const applied = () => applyProposal(HOT_PAD, snap().applied);

  it('puts back what each applied field held', () => {
    const back = undoApply(applied(), snap());
    expect(back).toEqual(HOT_PAD);
  });

  it('leaves a field edited since alone — it is the user’s newer decision', () => {
    const edited = { ...applied(), windAverage: 3 };
    const back = undoApply(edited, snap());
    expect(back.windAverage).toBe(3);
    expect(back.temperatureC).toBeNull();
    expect(back.pressureHPa).toBeNull();
  });

  it('restores a field that did not exist as absent, not as null', () => {
    const s = snap({ applied: { longitudeDeg: -119.35519 }, before: beforeOf(HOT_PAD, { longitudeDeg: -119.35519 }) });
    expect(s.before).toEqual({});
    const back = undoApply(applyProposal(HOT_PAD, s.applied), s);
    expect(Object.hasOwn(back, 'longitudeDeg')).toBe(false);
    expect(back).toEqual(HOT_PAD);
  });

  // Review of 2026-09-23: Undo took the chip's explanation away and left the
  // σ it had written from this forecast. The chip's click leaves a receipt on
  // the record, and Undo reads it like any applied field's.
  it('puts back a σ the gust chip wrote from this weather, unless it was edited since', () => {
    const s = withSigmaEstimate(snap(), 2, 0.7);
    expect(s.sigmaEstimate).toEqual({ applied: 2, before: 0.7 });
    const withSigma = { ...applied(), windStdDev: 2 };
    expect(undoApply(withSigma, s)).toEqual(HOT_PAD);
    // Edited since: the user's newer decision stays, as for any field.
    expect(undoApply({ ...withSigma, windStdDev: 1.2 }, s).windStdDev).toBe(1.2);
    // No receipt, no σ change: Apply never wrote σ.
    expect(undoApply(withSigma, snap()).windStdDev).toBe(2);
    // A σ-only receipt still undoes, with nothing else to put back.
    const onlySigma = snap({ applied: {}, before: {}, sigmaEstimate: { applied: 2, before: 0 } });
    expect(undoApply({ ...HOT_PAD, windStdDev: 2 }, onlySigma)).toEqual({ ...HOT_PAD, windStdDev: 0 });
  });
});

describe('carrySigmaEstimate', () => {
  // Claim check of the v0.140 notes: a second Apply replaced the record, the
  // receipt went with it, and Undo left σ at the chip's estimate unexplained.
  it('keeps the gust chip\'s receipt through a second Apply while σ still holds the estimate', () => {
    const first = withSigmaEstimate(snap(), 2, 0.7);
    const second = snap({ retrievedAt: '2026-09-23T09:00:00.000Z' });
    const carried = carrySigmaEstimate(first, second, { windStdDev: 2 });
    expect(carried.sigmaEstimate).toEqual({ applied: 2, before: 0.7 });
    // And Undo on the second record then puts σ back to what it held before the chip.
    expect(undoApply({ ...HOT_PAD, windStdDev: 2 }, carried).windStdDev).toBe(0.7);
  });

  it('carries nothing once σ was changed, when there was no receipt, or when the new record has its own', () => {
    const first = withSigmaEstimate(snap(), 2, 0.7);
    expect(carrySigmaEstimate(first, snap(), { windStdDev: 1.2 }).sigmaEstimate).toBeUndefined();
    expect(carrySigmaEstimate(snap(), snap(), { windStdDev: 2 }).sigmaEstimate).toBeUndefined();
    expect(carrySigmaEstimate(null, snap(), { windStdDev: 2 }).sigmaEstimate).toBeUndefined();
    const own = withSigmaEstimate(snap(), 3, 2);
    expect(carrySigmaEstimate(first, own, { windStdDev: 2 }).sigmaEstimate).toEqual({ applied: 3, before: 2 });
  });
});

describe('staleness', () => {
  it('says nothing while the Site altitude is the one the air was fetched for', () => {
    expect(staleness(applyProposal(HOT_PAD, snap().applied), snap())).toBeNull();
  });

  it('speaks up when the Site altitude moves under an applied temperature or pressure', () => {
    const moved = { ...applyProposal(HOT_PAD, snap().applied), launchAltitudeM: 1524 };
    expect(staleness(moved, snap())).toEqual({ forAltitudeM: 1190, nowAltitudeM: 1524 });
  });

  it('goes quiet once neither holds its applied value any more', () => {
    const cleared = { ...applyProposal(HOT_PAD, snap().applied), launchAltitudeM: 1524, temperatureC: null, pressureHPa: null };
    expect(staleness(cleared, snap())).toBeNull();
    const windOnly = snap({ applied: { windAverage: 5 }, before: { windAverage: 0 } });
    expect(staleness({ ...HOT_PAD, launchAltitudeM: 1524, windAverage: 5 }, windOnly)).toBeNull();
  });
});

describe('fieldProvenance', () => {
  it('says forecast, or what the forecast said once the field is edited', () => {
    const l = applyProposal(HOT_PAD, snap().applied);
    expect(fieldProvenance(l, snap(), 'temperatureC')).toEqual({ kind: 'forecast' });
    expect(fieldProvenance({ ...l, temperatureC: 25 }, snap(), 'temperatureC')).toEqual({ kind: 'edited', said: 23.3 });
    // Float noise from a unit round trip is not an edit.
    expect(fieldProvenance({ ...l, temperatureC: 23.300000000000004 }, snap(), 'temperatureC')).toEqual({ kind: 'forecast' });
    expect(fieldProvenance(l, snap(), 'latitudeDeg')).toBeNull();
    expect(fieldProvenance(l, null, 'temperatureC')).toBeNull();
  });
});

describe('validWeatherSnapshot', () => {
  it('keeps a well-formed record through JSON', () => {
    expect(validWeatherSnapshot(JSON.parse(JSON.stringify(snap())))).toEqual(snap());
    const s = withSigmaEstimate(snap(), 2, 0.7);
    expect(validWeatherSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('drops a malformed one rather than put a wrong "forecast said" beside a field', () => {
    const bad: unknown[] = [
      null, 'x', { ...snap(), v: 2 }, { ...snap(), provider: 'other' },
      { ...snap(), applied: { windStdDev: 2 } },
      { ...snap(), applied: { temperatureC: 'hot' } },
      { ...snap(), before: { windAverage: 'x' } },
      { ...snap(), fetched: { ...snap().fetched, windGustMs: 'NaN' } },
      { ...snap(), place: { ...snap().place, latitudeDeg: null } },
      { ...snap(), forAltitudeM: null },
      // Finite, but past what a Date can hold: the strip could not show it.
      { ...snap(), validUnix: 1e16 }, { ...snap(), validUnix: -1e16 },
      // A σ receipt Undo could write a σ nobody had from.
      { ...snap(), sigmaEstimate: null }, { ...snap(), sigmaEstimate: { applied: 2 } },
      { ...snap(), sigmaEstimate: { applied: 2, before: 'x' } }, { ...snap(), sigmaEstimate: { applied: -1, before: 0 } },
    ];
    for (const b of bad) expect(validWeatherSnapshot(b), JSON.stringify(b)).toBeNull();
  });
});
