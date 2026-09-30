import { editProfileSurface, kernelWindProfile } from './windProfile.js';
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
  it('retains calm speed ratios through scalar Apply/Undo, profile replacement, gust receipts and receipt restore', () => {
    const start: LaunchConditions = { ...HOT_PAD, windAverage: 4, windStdDev: 0.4, windLevels: [
      { altitude: 10, speed: 4, direction: 0, standardDeviation: 0.4 },
      { altitude: 1000, speed: 20, direction: 0.7, standardDeviation: 2 },
    ], windProfileSource: { kind: 'ork' } };
    const zero = applyProposal(start, { windAverage: 0 });
    expect(undoApply(zero, { before: beforeOf(start, { windAverage: 0 }), applied: { windAverage: 0 } }).windLevels).toEqual(start.windLevels);
    const receipt = snap({ before: beforeOf(zero, { windLevels: [] }), applied: { windLevels: [] } });
    const restoredReceipt = validWeatherSnapshot(JSON.parse(JSON.stringify(receipt)))!;
    const restored = undoApply(applyProposal(zero, receipt.applied), restoredReceipt);
    expect(restored.windLevels).toEqual(zero.windLevels);
    expect(editProfileSurface(restored, { ...restored, windAverage: 0.5 }).windLevels!.map((l) => l.speed)).toEqual([0.5, 2.5]);
    const zeroPatch = { windAverage: 0, windLevels: zero.windLevels, windProfileSource: zero.windProfileSource };
    const applied = applyProposal({ ...HOT_PAD, windStdDev: 0.4 }, zeroPatch);
    const gustReceipt = withSigmaEstimate(snap({ applied: zeroPatch }), 1, 0.4, applied);
    const gust = editProfileSurface(applied, { ...applied, windStdDev: 1 });
    expect(gustReceipt.applied.windLevels).toEqual(gust.windLevels);
    const round = validWeatherSnapshot(JSON.parse(JSON.stringify(gustReceipt)))!;
    expect(round.applied.windLevels).toEqual(gust.windLevels);
    expect(editProfileSurface(gust, { ...gust, windAverage: 0.5 }).windLevels!.map((l) => l.speed)).toEqual([0.5, 2.5]);
    const replacement = applyProposal(zero, { windAverage: 2, windLevels: [
      { altitude: 10, speed: 2, direction: 0 }, { altitude: 100, speed: 6, direction: 1 },
    ] });
    expect(editProfileSurface(replacement, { ...replacement, windAverage: 1 }).windLevels!.map((l) => l.speed)).toEqual([1, 3]);
  });

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


describe('profile weather receipts', () => {
  const source = { kind: 'open-meteo' as const, place: 'Pad', validUnix: 1, surfaceFromDeg: 350 };
  const windLevels = [{ altitude: 10, speed: 5, direction: 0, standardDeviation: 0.7 }, { altitude: 80, speed: 10, direction: 0.2, standardDeviation: 1.4 }];
  const patch = { windAverage: 5, windLevels, windProfileSource: source };
  const surfaceMatches = (launch: LaunchConditions) => {
    const surface = kernelWindProfile(launch).windLevels?.[0];
    expect(surface).toBeDefined();
    expect(launch.windAverage).toBeCloseTo(surface!.speed, 12);
    expect(launch.windStdDev).toBeCloseTo(surface!.standardDeviation ?? 0, 12);
  };

  it.each(['sigma', 'average'] as const)('keeps the coupled surface after Apply, manual %s edit, Undo', (field) => {
    const receipt = snap({ applied: patch, before: beforeOf(HOT_PAD, patch) });
    const applied = applyProposal(HOT_PAD, patch);
    const edited = editProfileSurface(applied, { ...applied, ...(field === 'sigma' ? { windStdDev: 2 } : { windAverage: 8 }) });
    const back = undoApply(edited, receipt);
    expect(back.windLevels).toEqual(edited.windLevels);
    expect(back.windAverage).toBe(edited.windAverage);
    expect(back.windStdDev).toBe(edited.windStdDev);
    surfaceMatches(back);
  });

  it('keeps the coupled surface after a gust chip, manual mean edit, Undo', () => {
    const applied = applyProposal(HOT_PAD, patch);
    const receipt = withSigmaEstimate(snap({ applied: patch, before: beforeOf(HOT_PAD, patch) }), 2, 0.7, applied);
    const gust = editProfileSurface(applied, { ...applied, windStdDev: 2 });
    const edited = editProfileSurface(gust, { ...gust, windAverage: 8 });
    const back = undoApply(edited, receipt);
    expect(back).toEqual(edited);
    surfaceMatches(back);
  });

  it('restores a previous profile using the surviving surface edits after surface-only Apply', () => {
    const start = applyProposal(HOT_PAD, patch);
    const clear = { windAverage: 3, windLevels: [] };
    const receipt = snap({ applied: clear, before: beforeOf(start, clear) });
    const edited = { ...applyProposal(start, clear), windAverage: 7, windStdDev: 2 };
    const back = undoApply(edited, receipt);
    expect(back.windAverage).toBe(7);
    expect(back.windStdDev).toBe(2);
    expect(back.windLevels![1]!.speed).toBe(14);
    surfaceMatches(back);
  });

  it('reconciles the restored profile after gust chip, second Apply, Undo', () => {
    const first = applyProposal(HOT_PAD, patch);
    const receipt = withSigmaEstimate(snap({ applied: patch, before: beforeOf(HOT_PAD, patch) }), 2, 0.7, first);
    const gust = editProfileSurface(first, { ...first, windStdDev: 2 });
    const secondPatch = { windAverage: 3, windLevels: [] };
    const second = carrySigmaEstimate(receipt, snap({ applied: secondPatch, before: beforeOf(gust, secondPatch) }), gust);
    const back = undoApply(applyProposal(gust, secondPatch), second);
    expect(back.windAverage).toBe(5);
    expect(back.windStdDev).toBe(0.7);
    surfaceMatches(back);
  });

  it('Clear then weather Undo keeps the profile cleared', () => {
    const applied = applyProposal(HOT_PAD, patch);
    const receipt = snap({ applied: patch, before: beforeOf(HOT_PAD, patch) });
    const cleared = { ...applied, windLevels: undefined, windProfileSource: undefined };
    const back = undoApply(cleared, receipt);
    expect(back.windAverage).toBe(HOT_PAD.windAverage);
    expect(kernelWindProfile(back)).toEqual({});
  });

  it('scalar-only Apply and Undo scale an existing profile with its surface fields', () => {
    const start = applyProposal(HOT_PAD, patch);
    const scalarPatch = { windAverage: 7 };
    const receipt = snap({ applied: scalarPatch, before: beforeOf(start, scalarPatch) });
    const applied = applyProposal(start, scalarPatch);
    surfaceMatches(applied);
    const back = undoApply(applied, receipt);
    surfaceMatches(back);
    expect(back.windLevels![1]!.speed).toBeCloseTo(10, 12);
  });

  it('keeps surface and kernel consistent through all four-step Apply/edit/Undo sequences', () => {
    type State = { launch: LaunchConditions; receipt: WeatherSnapshot | null;
      clear?: { before: LaunchConditions; after: LaunchConditions } };
    const actions = ['apply', 'surface apply', 'mean', 'calm', 'sigma', 'gust', 'clear', 'undo clear', 'undo'] as const;
    const visit = (state: State, steps: readonly string[]) => {
      const { launch, receipt } = state;
      const surface = kernelWindProfile(launch).windLevels?.[0];
      if (surface) {
        expect(launch.windAverage, steps.join(' -> ')).toBeCloseTo(surface.speed, 12);
        expect(launch.windStdDev, steps.join(' -> ')).toBeCloseTo(surface.standardDeviation ?? 0, 12);
      }
      if (steps.length === 4) return;
      for (const action of actions) {
        let next: State = state;
        if (action === 'apply' || action === 'surface apply') {
          const proposed = action === 'apply' ? { ...patch, windLevels: windLevels.map((l) => ({
            ...l, standardDeviation: launch.windStdDev * l.speed / 5,
          })) } : { windAverage: 3, windLevels: [] };
          next = { launch: applyProposal(launch, proposed), receipt: carrySigmaEstimate(receipt,
            snap({ applied: proposed, before: beforeOf(launch, proposed) }), launch) };
        } else if (action === 'mean' || action === 'calm' || action === 'sigma' || action === 'gust') {
          const edited = { ...launch, ...(action === 'mean' ? { windAverage: 8 } : action === 'calm'
            ? { windAverage: 0 } : { windStdDev: action === 'gust' ? 2 : 1 }) };
          next = { launch: editProfileSurface(launch, edited), receipt: action === 'gust' && receipt
            ? withSigmaEstimate(receipt, edited.windStdDev, launch.windStdDev, launch) : receipt };
        } else if (action === 'clear' && launch.windLevels?.length) {
          const cleared = { ...launch, windLevels: undefined, windProfileSource: undefined };
          next = { launch: cleared, receipt, clear: { before: launch, after: cleared } };
        } else if (action === 'undo clear' && state.clear?.after === launch) {
          next = { launch: state.clear.before, receipt };
        } else if (action === 'undo' && receipt) {
          next = { launch: undoApply(launch, receipt), receipt: null };
        }
        visit(next, [...steps, action]);
      }
    };
    visit({ launch: HOT_PAD, receipt: null }, []);
    visit({ launch: applyProposal(HOT_PAD, patch), receipt: null }, []);
  });
  it('validates and restores profile receipts from autosave', () => {
    const receipt = snap({ applied: { windLevels, windProfileSource: source }, before: { windLevels, windProfileSource: { kind: 'ork' } } });
    expect(validWeatherSnapshot(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    expect(undoApply({ ...HOT_PAD, windLevels, windProfileSource: source }, receipt).windProfileSource).toEqual({ kind: 'ork' });
    for (const key of ['applied', 'before'] as const) {
      expect(validWeatherSnapshot({ ...receipt, [key]: { windLevels: [{ speed: 1 }] } })).toBeNull();
      expect(validWeatherSnapshot({ ...receipt, [key]: { windProfileSource: { kind: 'bad' } } })).toBeNull();
    }
  });
  it('Undo removes the profile even after the forecast gust chip scales it, while preserving edited profiles', () => {
    const patch = { windAverage: 5, windLevels, windProfileSource: source };
    const receipt = snap({ applied: patch, before: beforeOf(HOT_PAD, patch) });
    const applied = applyProposal(HOT_PAD, patch);
    const withSigma = editProfileSurface(applied, { ...applied, windStdDev: 1.5 });
    const updated = withSigmaEstimate(receipt, 1.5, 0.7, applied);
    expect(updated.applied.windLevels![1]!.standardDeviation).toBe(3);
    expect(undoApply(withSigma, updated)).toEqual(HOT_PAD);
    const edited = { ...applied, windLevels: [{ ...windLevels[0]!, speed: 7 }] };
    expect(withSigmaEstimate(receipt, 1.5, 0.7, edited).applied.windLevels).toEqual(windLevels);
  });
});
