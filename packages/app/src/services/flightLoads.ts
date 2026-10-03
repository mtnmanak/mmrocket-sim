import type { FlightEvent, FlightResult, FlightSeries } from '@online-openrocket/engine';

export const LOAD_WINDOW = 'Launch through apogee, stopping before recovery deployment or tumbling';
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface LoadPeak {
  value: number;
  time: number;
  altitude: number | null;
  mach: number | null;
  aoa: number | null;
}
export interface FlightLoads { maxQ: LoadPeak | null; maxQAlpha: LoadPeak | null }

/** Kernel Mach = air-relative speed / local sound speed. Never use ground velocity.
 * Density and sound speed are full-series outputs from the atmosphere actually flown.
 * Keep gaps as null, including the deployment sample: its AoA may already be stale.
 */
export function loadSeries(series: FlightSeries, events: FlightEvent[]): FlightSeries {
  if (!series['ρ'] || !series['Vs']) return series;
  const eventTime = (types: string[]) => Math.min(Infinity,
    ...events.filter(e => types.includes(e.type) && finite(e.time)).map(e => e.time));
  const stop = eventTime(['RECOVERY_DEVICE_DEPLOYMENT', 'TUMBLE']);
  let apogee = eventTime(['APOGEE']);
  if (!finite(apogee)) {
    // Aborted/older recordings may lack an apogee event. End at the highest
    // recorded altitude; a still-rising aborted flight includes its last sample.
    let highest = -Infinity;
    series.altitude.forEach((h, i) => {
      if (finite(h) && h > highest && finite(series.time[i])) { highest = h; apogee = series.time[i]!; }
    });
  }
  const q = series.time.map((t, i) => {
    const rho = series['ρ']?.[i], sound = series['Vs']?.[i], mach = series.mach[i];
    if (!finite(t) || !finite(apogee) || t < 0 || t > apogee || t >= stop) return null;
    if (!finite(rho) || rho <= 0 || !finite(sound) || sound <= 0 || !finite(mach) || mach < 0) return null;
    const value = 0.5 * rho * (mach * sound) ** 2;
    return finite(value) ? value : null;
  });
  const qAlpha = q.map((value, i) => {
    const alpha = series.aoa[i];
    const product = value != null && finite(alpha) && alpha >= 0 ? value * alpha : null;
    return finite(product) ? product : null;
  });
  return { ...series, dynamicPressure: q, qAlpha };
}

export function flightLoads(result: Pick<FlightResult, 'series' | 'events'>): FlightLoads {
  const s = loadSeries(result.series, result.events);
  const peak = (key: string): LoadPeak | null => {
    let found: LoadPeak | null = null;
    s[key]?.forEach((value, i) => {
      if (!finite(value) || (found && value <= found.value)) return;
      found = { value, time: s.time[i]!, altitude: finite(s.altitude[i]) ? s.altitude[i]! : null,
        mach: finite(s.mach[i]) ? s.mach[i]! : null, aoa: finite(s.aoa[i]) ? s.aoa[i]! : null };
    });
    return found;
  };
  return { maxQ: peak('dynamicPressure'), maxQAlpha: peak('qAlpha') };
}

/** One decoration for Launch, replay, and exports; no mutation of kernel arrays. */
export function withLoadSeries(result: FlightResult): FlightResult {
  return { ...result, series: loadSeries(result.series, result.events),
    ...(result.branches ? { branches: result.branches.map(b => ({ ...b, series: loadSeries(b.series, b.events) })) } : {}) };
}
