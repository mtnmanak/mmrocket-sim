import type { FlightSeries } from '@online-openrocket/engine';
import type { Preferences } from './prefs/PrefsContext.js';
import { siToUi, type Quantity } from './prefs/units.js';

export interface SeriesDef {
  key: keyof FlightSeries;
  title: string;
  unit: string;
  color: string;
  /** set for unit-preference-driven series: the title unit becomes a click-to-change chip */
  quantity?: Quantity;
  /** display transform (SI -> UI unit) */
  f?: (v: number) => number;
}

/** Series defs in the user's units — the engine data underneath stays SI. */
export function seriesCatalog(prefs: Preferences, C: string[]): SeriesDef[] {
  const u = prefs.units;
  return [
    { key: 'altitude', title: 'Altitude', unit: u.distance, quantity: 'distance', color: C[0]!, f: (v) => siToUi('distance', u.distance, v) },
    { key: 'velocity', title: 'Velocity', unit: u.velocity, quantity: 'velocity', color: C[1]!, f: (v) => siToUi('velocity', u.velocity, v) },
    { key: 'acceleration', title: 'Acceleration', unit: u.acceleration, quantity: 'acceleration', color: C[2]!, f: (v) => siToUi('acceleration', u.acceleration, v) },
    { key: 'mass', title: 'Mass', unit: u.mass, quantity: 'mass', color: C[3]!, f: (v) => siToUi('mass', u.mass, v) },
    { key: 'thrust', title: 'Thrust', unit: 'N', color: C[4]! },
    { key: 'drag', title: 'Drag force', unit: 'N', color: C[5]! },
    { key: 'mach', title: 'Mach number', unit: '', color: C[6]! },
    { key: 'stability', title: 'Stability margin', unit: 'cal', color: C[7]! },
    { key: 'cpLocation', title: 'CP location', unit: u.length, quantity: 'length', color: C[0]!, f: (v) => siToUi('length', u.length, v) },
    { key: 'cgLocation', title: 'CG location', unit: u.length, quantity: 'length', color: C[1]!, f: (v) => siToUi('length', u.length, v) },
    { key: 'aoa', title: 'Angle of attack', unit: '°', color: C[2]!, f: (v) => (v * 180) / Math.PI },
    { key: 'dynamicPressure', title: 'Dynamic pressure', unit: u.pressure, quantity: 'pressure', color: C[3]!, f: (v) => siToUi('pressure', u.pressure, v) },
    { key: 'qAlpha', title: 'q·α', unit: `${u.pressure}·rad`, color: C[4]!, f: (v) => siToUi('pressure', u.pressure, v) },
  ];
}

export interface ComparisonPreset {
  id: string;
  title: string;
  x: 'time' | 'altitude';
  left: string[];
  right: string[];
}

export const PRESETS: ComparisonPreset[] = [
  { id: 'altitude-velocity', title: 'Altitude + velocity', x: 'time', left: ['altitude'], right: ['velocity'] },
  { id: 'altitude-vertical', title: 'Altitude + vertical velocity', x: 'time', left: ['altitude'], right: ['Vz'] },
  { id: 'velocity-acceleration', title: 'Velocity + acceleration', x: 'time', left: ['velocity'], right: ['acceleration'] },
  { id: 'stability', title: 'Stability + CP + CG', x: 'time', left: ['stability'], right: ['cpLocation', 'cgLocation'] },
  { id: 'phase', title: 'Velocity vs altitude', x: 'altitude', left: ['velocity'], right: [] },
];

export function comparisonMembers(preset: ComparisonPreset, catalog: SeriesDef[]) {
  const velocity = catalog.find((d) => d.key === 'velocity')!;
  const defs = [...catalog, { ...velocity, key: 'Vz', title: 'Vertical velocity' }];
  return (['left', 'right'] as const).flatMap((axis) => preset[axis].map((key, i) => ({
    ...defs.find((d) => d.key === key)!, axis,
    // Redundant encoding for CVD readers, without changing identity colours.
    dash: axis === 'right' ? (i === 0 ? [6, 4] : [2, 3]) : undefined,
  })));
}

export const finiteSample = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function usableSeries(series: FlightSeries, keys: string[], x = 'time'): boolean {
  return series.time.some((t, i) => finiteSample(t) && finiteSample(series[x]?.[i])
    && keys.every((key) => finiteSample(series[key]?.[i])));
}

/** Copy and align to time; never convert or pad the engine's SI arrays in place. */
export function convertedValues(series: FlightSeries, def: SeriesDef): (number | null)[] {
  return series.time.map((_, i) => {
    const v = series[def.key]?.[i];
    return finiteSample(v) ? (def.f ? def.f(v) : v) : null;
  });
}

export interface PhaseSample { index: number; time: number; altitude: number; velocity: number }
export interface PhaseRun {
  direction: 'Rising' | 'Falling' | 'Point';
  /** Chronological order, including a shared turning point at reversals. */
  samples: PhaseSample[];
}

/** Strictly monotonic runs. Equal x starts a new run, preserving every sample.
 * Real gaps terminate a run; only alignment holes may later be spanned. */
export function phaseRuns(series: FlightSeries): PhaseRun[] {
  const runs: PhaseRun[] = [];
  let samples: PhaseSample[] = [];
  let direction = 0;
  const flush = () => {
    if (samples.length) runs.push({ direction: direction > 0 ? 'Rising' : direction < 0 ? 'Falling' : 'Point', samples });
    samples = [];
    direction = 0;
  };
  series.time.forEach((time, index) => {
    const altitude = series.altitude[index];
    const velocity = series.velocity[index];
    if (!finiteSample(time) || !finiteSample(altitude) || !finiteSample(velocity)) { flush(); return; }
    const next = { index, time, altitude, velocity };
    const prev = samples[samples.length - 1];
    if (prev) {
      const sign = Math.sign(altitude - prev.altitude);
      if (sign === 0) flush();
      else if (direction && direction !== sign) { flush(); samples = [prev]; direction = sign; }
      else direction = sign;
    }
    samples.push(next);
  });
  flush();
  return runs;
}

/** No uPlot.join: it overwrites repeated x-values within a member. Runs have
 * unique x; separate members preserve collisions and their original times. */
export function phaseData(series: FlightSeries, altitude: SeriesDef, velocity: SeriesDef) {
  const runs = phaseRuns(series);
  const xs = [...new Set(runs.flatMap((r) => r.samples.map((s) => s.altitude)))].sort((a, b) => a - b);
  const positions = new Map(xs.map((x, i) => [x, i]));
  const values = runs.map((run) => {
    const row: (number | null)[] = Array(xs.length).fill(null);
    const times: (number | null)[] = Array(xs.length).fill(null);
    const points: number[] = [];
    for (const sample of run.samples) {
      const i = positions.get(sample.altitude)!;
      row[i] = velocity.f ? velocity.f(sample.velocity) : sample.velocity;
      times[i] = sample.time;
      // Equal-altitude boundaries can be ends of two nontrivial runs. Mark
      // both samples explicitly rather than relying on an unmarked line end.
      if (run.samples.length === 1 || series.altitude[sample.index - 1] === sample.altitude
        || series.altitude[sample.index + 1] === sample.altitude) points.push(i);
    }
    return { row, times, points };
  });
  return { runs, xs: xs.map((v) => altitude.f ? altitude.f(v) : v), values };
}
