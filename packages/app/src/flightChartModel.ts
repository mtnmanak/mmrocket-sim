import type { FlightEvent, FlightSeries } from '@online-openrocket/engine';
import type { Preferences } from './prefs/PrefsContext.js';
import { siToUi, uiToSi, type Quantity } from './prefs/units.js';
import { exportColumnCatalog } from './services/flightDataCsv.js';
import { CHART_TOKENS, LIGHT_PALETTE, LINE_STYLES, REFERENCE_DASH, lineStyle, slotOf, type ChartToken } from './chartTheme.js';

export interface SeriesDef {
  key: keyof FlightSeries;
  title: string;
  unit: string;
  color: string;
  /** The series' own line style wherever it is drawn — the legend sample, the
   * panel, the comparison chart (chartTheme LINE_STYLES; undefined = solid).
   * Stability is the brand's REFERENCE series: dashed 6 4. */
  dash?: number[];
  /** The brand chart token its colour comes from (StyleAllocator). */
  token?: ChartToken;
  /** set for unit-preference-driven series: the title unit becomes a click-to-change chip */
  quantity?: Quantity;
  /** display transform (SI -> UI unit) */
  f?: (v: number) => number;
  /** inverse display transform, including compound units without a unit chip */
  toSI?: (v: number) => number;
}

/** A catalog entry before it is given a colour and a line style. */
type Unstyled = Omit<SeriesDef, 'color' | 'dash' | 'token'> & {
  /** The brand token of the QUANTITY it is (null: none of the eight). */
  token: ChartToken | null;
};

const REFERENCE_SLOT = slotOf('reference');

type Look = { color: string; token: ChartToken; dash?: number[] };

/**
 * Colour + line style for every series, fixed per series identity (never
 * re-assigned by selection), and never the same colour + style pair twice:
 *  1. A series that IS one of the brand quantities takes its named token
 *     (SPEC §3.2): altitude; velocity and vertical velocity; acceleration;
 *     pressures; thrust; drag force; Mach; stability (cal and %) → reference.
 *     The first series of a token draws the token's own style (tier 0); a
 *     second of the same quantity the token's tier-1 style: vertical velocity
 *     (velocity) and Stability margin (%) (reference, long-short: one quantity
 *     in two units, but both can be plotted at once, so they must differ).
 *  2. Every other series (mass, CP/CG location, angle of attack, q·α, the
 *     re-flown extras) takes the next free colour + style pair in the brand
 *     slot order, tier by tier. All eight tokens are taken at tier 0 by the
 *     quantities, so these land on tier 1: mass altitude, CP acceleration, CG
 *     pressure, angle of attack thrust, q·α drag — and CP and CG, which share
 *     the stability comparison with the reference series, are off its 6 4 dash
 *     (chartTheme TIER_STYLE).
 *  3. The reference look is the reference series' alone (SPEC §3.2: reference
 *     is the dashed 6 4 series, and its ink is the marker hairline's). No other
 *     series is given the reference colour or the 6 4 dash in any colour —
 *     without this rule the re-flown extras took tier 1's two leftover pairs,
 *     Mach colour in 6 4 and the reference ink in long-short.
 */
export class StyleAllocator {
  private readonly used = new Set<string>();
  private readonly C: readonly string[];
  constructor(C: readonly string[]) { this.C = C; }
  private take(slot: number, tier: number): Look {
    this.used.add(`${slot}:${tier}`);
    const dash = lineStyle(slot, tier);
    return { color: this.C[slot]!, token: CHART_TOKENS[slot]!, ...(dash ? { dash } : {}) };
  }
  /** Whether a series of quantity `token` may take this pair (rule 3). */
  private free(slot: number, tier: number, token: ChartToken | null): boolean {
    if (this.used.has(`${slot}:${tier}`)) return false;
    return token === 'reference' || (slot !== REFERENCE_SLOT && lineStyle(slot, tier) !== REFERENCE_DASH);
  }
  /** The look for a series of quantity `token`; for null, the next free pair in slot order. */
  next(token: ChartToken | null): Look {
    for (let tier = 0; tier < 64; tier++) {
      if (token) {
        if (this.free(slotOf(token), tier, token)) return this.take(slotOf(token), tier);
        continue;
      }
      for (let slot = 0; slot < CHART_TOKENS.length; slot++) {
        if (this.free(slot, tier, null)) return this.take(slot, tier);
      }
    }
    // 512 series: no flight records that many. Reuse rather than fail.
    return this.take(token ? slotOf(token) : 0, 0);
  }
}

function styleCatalog(defs: Unstyled[], styles: StyleAllocator): SeriesDef[] {
  const looks = new Map<keyof FlightSeries, Look>();
  // Quantities first, so a later quantity (dynamic pressure) is never beaten
  // to its own tier-0 pair by an earlier non-quantity (mass).
  for (const d of defs) if (d.token) looks.set(d.key, styles.next(d.token));
  for (const d of defs) if (!d.token) looks.set(d.key, styles.next(null));
  return defs.map(({ token: _token, ...d }) => ({ ...d, ...looks.get(d.key)! }));
}

/** Series defs in the user's units — the engine data underneath stays SI. */
export function seriesCatalog(prefs: Pick<Preferences, 'units'>, C: readonly string[],
  styles = new StyleAllocator(C)): SeriesDef[] {
  const u = prefs.units;
  const defs: Unstyled[] = [
    { key: 'altitude', title: 'Altitude', unit: u.altitude, quantity: 'altitude', token: 'altitude', f: (v) => siToUi('altitude', u.altitude, v) },
    { key: 'velocity', title: 'Velocity', unit: u.velocity, quantity: 'velocity', token: 'velocity', f: (v) => siToUi('velocity', u.velocity, v) },
    // Vertical velocity: the kernel's Vz, in every summary run. It goes through
    // zero at apogee and turns negative on the way down — desktop OR's default
    // plot — where Velocity (speed over the ground) never does. Its own chip
    // since v0.172 (@atestani); before that only the comparison preset drew it.
    // Velocity's colour (it is a velocity), in velocity's tier-1 style.
    { key: 'Vz', title: 'Vertical velocity', unit: u.velocity, quantity: 'velocity', token: 'velocity', f: (v) => siToUi('velocity', u.velocity, v) },
    { key: 'acceleration', title: 'Acceleration', unit: u.acceleration, quantity: 'acceleration', token: 'acceleration', f: (v) => siToUi('acceleration', u.acceleration, v) },
    { key: 'mass', title: 'Mass', unit: u.mass, quantity: 'mass', token: null, f: (v) => siToUi('mass', u.mass, v) },
    { key: 'thrust', title: 'Thrust', unit: 'N', token: 'thrust' },
    { key: 'drag', title: 'Drag force', unit: 'N', token: 'drag' },
    { key: 'mach', title: 'Mach number', unit: '', token: 'mach' },
    { key: 'stability', title: 'Stability margin', unit: 'cal', token: 'reference' },
    // The same quantity as Stability margin, in other units: the reference
    // ink again, in the reference token's tier-1 style (rule 1).
    { key: 'stabilityPercent', title: 'Stability margin (% of active length)', unit: '%', token: 'reference' },
    { key: 'cpLocation', title: 'CP location', unit: u.length, quantity: 'length', token: null, f: (v) => siToUi('length', u.length, v) },
    { key: 'cgLocation', title: 'CG location', unit: u.length, quantity: 'length', token: null, f: (v) => siToUi('length', u.length, v) },
    { key: 'aoa', title: 'Angle of attack', unit: '°', token: null, f: (v) => (v * 180) / Math.PI, toSI: (v) => v * Math.PI / 180 },
    { key: 'dynamicPressure', title: 'Dynamic pressure', unit: u.pressure, quantity: 'pressure', token: 'pressure', f: (v) => siToUi('pressure', u.pressure, v) },
    { key: 'qAlpha', title: 'q·α', unit: `${u.pressure}·rad`, token: null, f: (v) => siToUi('pressure', u.pressure, v), toSI: (v) => uiToSi('pressure', u.pressure, v) },
  ];
  return styleCatalog(defs, styles).map(d => ({ ...d, toSI: d.quantity ? v => uiToSi(d.quantity!, u[d.quantity!], v) : d.toSI }));
}

/** The brand token of a unit-preference quantity, for the re-flown extras. */
const QUANTITY_TOKEN: Partial<Record<Quantity, ChartToken>> = {
  altitude: 'altitude', velocity: 'velocity', windspeed: 'velocity', acceleration: 'acceleration', pressure: 'pressure',
};

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

/**
 * A comparison chart's members, each on its axis. Every member keeps its own
 * colour AND line style — the catalog never repeats a pair, so no two members
 * of one chart look alike, and a series looks the same here as in its own
 * panel, its chip and its legend sample.
 */
export function comparisonMembers(preset: ComparisonPreset, catalog: SeriesDef[]) {
  const def = (key: string): SeriesDef =>
    catalog.find((d) => d.key === key) ?? { key, title: key, unit: 'unit unknown', ...unusedLook(catalog) };
  const left = preset.left.map((key) => ({ ...def(key), axis: 'left' as const }));
  const right = preset.right.map((key) => ({ ...def(key), axis: 'right' as const }));
  return [...left, ...right];
}

const sameDash = (a: readonly number[] | undefined, b: readonly number[] | undefined) =>
  (a ?? []).join(',') === (b ?? []).join(',');

/** The catalog's ink for each slot (its colours came from one palette), else the light brand value. */
function paletteOf(catalog: readonly SeriesDef[]): string[] {
  return CHART_TOKENS.map((t, i) => catalog.find((d) => d.token === t)?.color ?? LIGHT_PALETTE[i]!);
}

/**
 * A colour + style pair no catalog series draws, by the StyleAllocator's rules
 * (slot order, tier by tier, never the reference look): for a key the catalog
 * lacks, which once fell back to black or to altitude's own look.
 */
export function unusedLook(catalog: readonly SeriesDef[]): Pick<SeriesDef, 'color' | 'dash'> {
  const palette = paletteOf(catalog);
  for (let tier = 0; tier < 64; tier++) for (let slot = 0; slot < CHART_TOKENS.length; slot++) {
    const dash = lineStyle(slot, tier);
    if (slot === REFERENCE_SLOT || dash === REFERENCE_DASH) continue;
    if (catalog.some((d) => d.color === palette[slot] && sameDash(d.dash, dash))) continue;
    return dash ? { color: palette[slot]!, dash } : { color: palette[slot]! };
  }
  return { color: palette[0]! };
}

/**
 * A non-time plot draws its one series in two parts, by direction. The rising
 * (increasing-X) part keeps the series' own line style; the falling part takes
 * a SECOND style in the same colour: the first of the series' slot's tier
 * styles that is not its own, is not the reference 6 4 (stability's alone),
 * and is not a pair another catalog series draws (velocity's tier 1, dots, is
 * vertical velocity). It used to be solid rising and 6 4 falling, so velocity
 * appeared here in neither its own long dash nor anything but the reference
 * series' dash.
 */
export function directionDash(member: SeriesDef, catalog: readonly SeriesDef[]):
  { rising: number[] | undefined; falling: number[] | undefined } {
  const slot = member.token ? slotOf(member.token) : null;
  const candidates = slot === null ? LINE_STYLES : CHART_TOKENS.map((_, tier) => lineStyle(slot, tier + 1));
  const ok = (dash: readonly number[] | undefined) => dash !== REFERENCE_DASH && !sameDash(dash, member.dash)
    && !catalog.some((d) => d.key !== member.key && d.color === member.color && sameDash(d.dash, dash));
  // findIndex, not find: a found SOLID style is `undefined` too.
  const at = candidates.findIndex(ok);
  const falling = at >= 0 ? candidates[at]
    : LINE_STYLES[LINE_STYLES.findIndex((dash) => dash !== REFERENCE_DASH && !sameDash(dash, member.dash))];
  return { rising: member.dash, falling: falling ? [...falling] : undefined };
}

export const finiteSample = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** C-E7: share export metadata; unknown future symbols must not acquire guessed units. */
export function arbitraryCatalog(series: FlightSeries, prefs: Pick<Preferences, 'units'>, colors: readonly string[]): SeriesDef[] {
  // One allocator across the named catalog and the extras: an extra never
  // repeats a colour + style pair a named series already draws.
  const styles = new StyleAllocator(colors);
  const known = seriesCatalog(prefs, colors, styles);
  const columns = new Map(exportColumnCatalog().map(c => [c.key, c]));
  for (const key of Object.keys(series)) {
    if (key === 'tc' || known.some(d => d.key === key)) continue;
    const spec = columns.get(key);
    const quantity = spec?.quantity;
    const unit = quantity ? prefs.units[quantity] : spec?.si ?? 'unit unknown';
    known.push({ key, title: spec?.name ?? key, unit: unit + (spec?.suffix ?? ''),
      quantity, ...styles.next((quantity && QUANTITY_TOKEN[quantity]) ?? null),
      f: quantity ? v => siToUi(quantity, unit, v) : undefined,
      toSI: quantity ? v => uiToSi(quantity, unit, v) : undefined });
  }
  if (!known.some(d => d.key === 'time')) known.unshift({ key: 'time', title: 'Time', unit: 's', ...styles.next(null) });
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
