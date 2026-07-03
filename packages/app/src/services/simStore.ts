import type { SimRun } from './simReport.js';

/**
 * Persisted simulation-run history (localStorage). the owner's flight-day flow:
 * simulate many motors, compare, download the table as CSV. Runs survive
 * reloads; capped to the newest MAX_RUNS.
 */

const KEY = 'online-openrocket.sim-runs.v1';
const MAX_RUNS = 500;

export function loadRuns(): SimRun[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as SimRun[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persist(runs: SimRun[]): SimRun[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(runs.slice(0, MAX_RUNS)));
  } catch { /* quota — history is best-effort */ }
  return runs;
}

/** Newest first. */
export function addRun(run: SimRun): SimRun[] {
  return persist([run, ...loadRuns()]);
}

export function addRuns(newRuns: SimRun[]): SimRun[] {
  return persist([...newRuns, ...loadRuns()]);
}

export function deleteRun(id: string): SimRun[] {
  return persist(loadRuns().filter((r) => r.id !== id));
}

export function clearRuns(): SimRun[] {
  return persist([]);
}

/** CSV columns: label + SimRun key + formatter (SI values as plain numbers). */
const COLUMNS: [string, (r: SimRun) => string | number][] = [
  ['Date', (r) => new Date(r.when).toISOString()],
  ['Rocket', (r) => r.rocket],
  ['Motor', (r) => r.motor],
  ['Manufacturer', (r) => r.manufacturer],
  ['Motor diameter (mm)', (r) => r.motorDiameterMm],
  ['Delay flown (s)', (r) => r.delayS],
  ['Max altitude (m)', (r) => round(r.maxAltitude)],
  ['Max velocity (m/s)', (r) => round(r.maxVelocity)],
  ['Max Mach', (r) => round(r.maxMach, 3)],
  ['Max acceleration (m/s2)', (r) => round(r.maxAcceleration)],
  ['Time to apogee (s)', (r) => round(r.timeToApogee)],
  ['Time to burnout (s)', (r) => round(r.timeToBurnout)],
  ['Time to launch guide departure (s)', (r) => round(r.timeToRodDeparture, 3)],
  ['Velocity at launch guide departure (m/s)', (r) => round(r.rodExitVelocity)],
  ['Thrust:weight at launch guide departure', (r) => round(r.thrustToWeightAtRod)],
  ['Launch mass (kg)', (r) => round(r.launchMass, 4)],
  ['Launch CG (m)', (r) => round(r.launchCG, 4)],
  ['Launch CP (m)', (r) => round(r.launchCP, 4)],
  ['Launch static margin (cal)', (r) => round(r.launchStaticMarginCal)],
  ['Altitude at deployment (m)', (r) => round(r.altitudeAtDeployment)],
  ['Velocity at deployment (m/s)', (r) => round(r.velocityAtDeployment)],
  ['Ground hit velocity (m/s)', (r) => round(r.groundHitVelocity)],
  ['Total flight time (s)', (r) => round(r.totalFlightTime)],
  ['Optimal delay (s)', (r) => round(r.optimumDelayS)],
  ['Recommended delay (s)', (r) => round(r.recommendedDelayS)],
  ['Lift-off speed OK', (r) => flag(r.safeLiftoffSpeed)],
  ['Thrust:weight OK', (r) => flag(r.safeThrustToWeight)],
  ['Safe deployment', (r) => flag(r.safeDeployment)],
  ['Static margin OK', (r) => flag(r.staticMarginOk)],
  ['Weathercock risk', (r) => r.weathercockRisk ?? ''],
  ['Wind avg (m/s)', (r) => round(r.windAvg, 1)],
  ['Execution time (ms)', (r) => Math.round(r.execMs)],
  ['Comments', (r) => r.comments],
];

function round(v: number | null, digits = 2): string | number {
  return v === null || !Number.isFinite(v) ? '' : Number(v.toFixed(digits));
}

function flag(v: boolean | null): string {
  return v === null ? '' : v ? 'yes' : 'NO';
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function runsToCsv(runs: SimRun[]): string {
  const header = COLUMNS.map(([label]) => csvCell(label)).join(',');
  const rows = runs.map((r) => COLUMNS.map(([, f]) => csvCell(f(r))).join(','));
  return [header, ...rows].join('\n');
}
