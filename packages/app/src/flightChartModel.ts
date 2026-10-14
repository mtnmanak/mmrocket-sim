import type { FlightEvent, FlightSeries } from '@online-openrocket/engine';
import type { Preferences } from './prefs/PrefsContext.js';
import { siToUi, uiToSi, type Quantity } from './prefs/units.js';
import { exportColumnCatalog } from './services/flightDataCsv.js';

export interface SeriesDef {
  key: keyof FlightSeries;
  title: string;
  unit: string;
  color: string;
  /** set for unit-preference-driven series: the title unit becomes a click-to-change chip */
  quantity?: Quantity;
  /** display transform (SI -> UI unit) */
  f?: (v: number) => number;
  /** inverse display transform, including compound units without a unit chip */
  toSI?: (v: number) => number;
}

/** Series defs in the user's units — the engine data underneath stays SI. */
export function seriesCatalog(prefs: Pick<Preferences, 'units'>, C: string[]): SeriesDef[] {
  const u = prefs.units;
  const defs: SeriesDef[] = [
    { key: 'altitude', title: 'Altitude', unit: u.altitude, quantity: 'altitude', color: C[0]!, f: (v) => siToUi('altitude', u.altitude, v) },
    { key: 'velocity', title: 'Velocity', unit: u.velocity, quantity: 'velocity', color: C[1]!, f: (v) => siToUi('velocity', u.velocity, v) },
    // Vertical velocity: the kernel's Vz, in every summary run. It goes through
    // zero at apogee and turns negative on the way down — desktop OR's default
    // plot — where Velocity (speed over the ground) never does. Its own chip
    // since v0.172 (@atestani); before that only the comparison preset drew it.
    // Velocity's colour, as the preset always drew it.
    { key: 'Vz', title: 'Vertical velocity', unit: u.velocity, quantity: 'velocity', color: C[1]!, f: (v) => siToUi('velocity', u.velocity, v) },
    { key: 'acceleration', title: 'Acceleration', unit: u.acceleration, quantity: 'acceleration', color: C[2]!, f: (v) => siToUi('acceleration', u.acceleration, v) },
    { key: 'mass', title: 'Mass', unit: u.mass, quantity: 'mass', color: C[3]!, f: (v) => siToUi('mass', u.mass, v) },
    { key: 'thrust', title: 'Thrust', unit: 'N', color: C[4]! },
    { key: 'drag', title: 'Drag force', unit: 'N', color: C[5]! },
    { key: 'mach', title: 'Mach number', unit: '', color: C[6]! },
    { key: 'stability', title: 'Stability margin', unit: 'cal', color: C[7]! },
    { key: 'stabilityPercent', title: 'Stability margin (% of active length)', unit: '%', color: C[7]! },
    { key: 'cpLocation', title: 'CP location', unit: u.length, quantity: 'length', color: C[0]!, f: (v) => siToUi('length', u.length, v) },
    { key: 'cgLocation', title: 'CG location', unit: u.length, quantity: 'length', color: C[1]!, f: (v) => siToUi('length', u.length, v) },
    { key: 'aoa', title: 'Angle of attack', unit: '°', color: C[2]!, f: (v) => (v * 180) / Math.PI, toSI: (v) => v * Math.PI / 180 },
    { key: 'dynamicPressure', title: 'Dynamic pressure', unit: u.pressure, quantity: 'pressure', color: C[3]!, f: (v) => siToUi('pressure', u.pressure, v) },
    { key: 'qAlpha', title: 'q·α', unit: `${u.pressure}·rad`, color: C[4]!, f: (v) => siToUi('pressure', u.pressure, v), toSI: (v) => uiToSi('pressure', u.pressure, v) },
  ];
  return defs.map(d => ({ ...d, toSI: d.quantity ? v => uiToSi(d.quantity!, u[d.quantity!], v) : d.toSI }));
}

export interface ComparisonPreset {
  id: string;
  title: string;
  x: string;
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
  return (['left', 'right'] as const).flatMap((axis) => preset[axis].map((key, i) => ({
    ...(catalog.find((d) => d.key === key) ?? { key, title: key, unit: 'unit unknown', color: catalog[0]?.color ?? '#000' }), axis,
    // Redundant encoding for CVD readers, without changing identity colours.
    dash: axis === 'right' ? (i === 0 ? [6, 4] : [2, 3]) : undefined,
  })));
}

export const finiteSample = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** C-E7: share export metadata; unknown future symbols must not acquire guessed units. */
export function arbitraryCatalog(series: FlightSeries, prefs: Pick<Preferences, 'units'>, colors: string[]): SeriesDef[] {
  const known = seriesCatalog(prefs, colors);
  const columns = new Map(exportColumnCatalog().map(c => [c.key, c]));
  for (const key of Object.keys(series)) {
    if (key === 'tc' || known.some(d => d.key === key)) continue;
    const spec = columns.get(key);
    const quantity = spec?.quantity;
    const unit = quantity ? prefs.units[quantity] : spec?.si ?? 'unit unknown';
    known.push({ key, title: spec?.name ?? key, unit: unit + (spec?.suffix ?? ''),
      quantity, color: colors[known.length % colors.length]!,
      f: quantity ? v => siToUi(quantity, unit, v) : undefined,
      toSI: quantity ? v => uiToSi(quantity, unit, v) : undefined });
  }
  if (!known.some(d => d.key === 'time')) known.unshift({ key: 'time', title: 'Time', unit: 's', color: colors[0]! });
  return known.filter(d => d.key !== 'tc' && usableSeries(series, [String(d.key)]));
}

/** N042: the branch's recorded geometry, never the edited design's length.
 * Recovery/tumble CP no longer describes aerodynamic stability. */
export function withStabilityPercent(series: FlightSeries, events: FlightEvent[] = []): FlightSeries {
  const stop = Math.min(Infinity, ...events.filter(e =>
    ['RECOVERY_DEVICE_DEPLOYMENT', 'TUMBLE'].includes(e.type) && finiteSample(e.time)).map(e => e.time));
  return { ...series, stabilityPercent: series.time.map((t, i) => {
    const length = series.activeLength?.[i], cp = series.cpLocation?.[i], cg = series.cgLocation?.[i];
    if (!finiteSample(t) || t >= stop || !finiteSample(length) || length <= 0
      || !finiteSample(cp) || !finiteSample(cg)) return null;
    const value = (cp - cg) / length * 100;
    return finiteSample(value) ? value : null;
  }) };
}

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
export function phaseRuns(series: FlightSeries, x = 'altitude', y = 'velocity'): PhaseRun[] {
  const runs: PhaseRun[] = [];
  let samples: PhaseSample[] = [];
  let direction = 0;
  const flush = () => {
    if (samples.length) runs.push({ direction: direction > 0 ? 'Rising' : direction < 0 ? 'Falling' : 'Point', samples });
    samples = [];
    direction = 0;
  };
  series.time.forEach((time, index) => {
    const altitude = series[x]?.[index];
    const velocity = series[y]?.[index];
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

/** C-E7: bound storage and legend series by direction, not reversal count.
 * Sorted sample slots retain equal X at different times; chronological segments
 * draw each run separately so grouping cannot bridge a gap or plateau. */
export function phaseData(series: FlightSeries, altitude: SeriesDef, velocity: SeriesDef) {
  const runs = phaseRuns(series, String(altitude.key), String(velocity.key));
  const samples = [...new Map(runs.flatMap(r => r.samples.map(s => [s.index, s] as const))).values()]
    .sort((a, b) => a.altitude - b.altitude || a.index - b.index);
  const positions = new Map(samples.map((s, i) => [s.index, i]));
  const values = [...new Set(runs.map(r => r.direction))].map(direction => {
    const row: (number | null)[] = Array(samples.length).fill(null);
    const times: (number | null)[] = Array(samples.length).fill(null);
    const points = new Set<number>();
    const segments = runs.filter(r => r.direction === direction).map(run => run.samples.map(sample => {
      const i = positions.get(sample.index)!;
      row[i] = velocity.f ? velocity.f(sample.velocity) : sample.velocity;
      times[i] = sample.time;
      if (run.samples.length === 1 || series[altitude.key]?.[sample.index - 1] === sample.altitude
        || series[altitude.key]?.[sample.index + 1] === sample.altitude) points.add(i);
      return i;
    }));
    return { direction, row, times, points: [...points], segments };
  });
  return { runs, xs: samples.map(s => altitude.f ? altitude.f(s.altitude) : s.altitude), values };
}
