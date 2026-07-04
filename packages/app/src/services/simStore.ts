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

// Flight-day unit conversions for the leading columns (the owner's spec: the
// numbers he compares at the field are ft / mph / Gs / grams).
const FT = 3.28084;
const MPH = 2.23694;
const G_MS2 = 9.80665;

/**
 * CSV columns: label + SimRun key + formatter. The first 14 columns are
 * the owner's flight-day comparison set, in his order and units; everything after
 * follows in SI (order free per his spec).
 */
const COLUMNS: [string, (r: SimRun) => string | number][] = [
  ['Designation', (r) => r.motor],
  ['Apogee (ft)', (r) => round(r.maxAltitude * FT, 0)],
  ['Velocity (mph)', (r) => round(r.maxVelocity * MPH, 1)],
  ['Manufacturer', (r) => r.manufacturer],
  ['Diameter (mm)', (r) => r.motorDiameterMm],
  ['Type', (r) => r.motorType ?? ''],
  ['Propellant', (r) => r.propellant ?? ''],
  ['Case', (r) => r.motorCase ?? ''],
  ['T:W', (r) => round(r.thrustToWeightAtRod, 1)],
  ['Guide (mph)', (r) => round(r.rodExitVelocity === null ? null : r.rodExitVelocity * MPH, 1)],
  ['Accel (Gs)', (r) => round(r.maxAcceleration / G_MS2, 1)],
  ['Delay (s)', (r) => r.delayS],
  ['Pad Weight (g)', (r) => round(r.launchMass === null ? null : r.launchMass * 1000, 1)],
  ['Recovery Weight (g)', (r) => round(r.burnoutMass == null ? null : r.burnoutMass * 1000, 1)],
  ['Date', (r) => new Date(r.when).toISOString()],
  ['Rocket', (r) => r.rocket],
  ['Max altitude (m)', (r) => round(r.maxAltitude)],
  ['Max velocity (m/s)', (r) => round(r.maxVelocity)],
  ['Max Mach', (r) => round(r.maxMach, 3)],
  ['Max acceleration (m/s2)', (r) => round(r.maxAcceleration)],
  ['Time to apogee (s)', (r) => round(r.timeToApogee)],
  ['Time to burnout (s)', (r) => round(r.timeToBurnout)],
  ['Time to launch guide departure (s)', (r) => round(r.timeToRodDeparture, 3)],
  ['Velocity at launch guide departure (m/s)', (r) => round(r.rodExitVelocity)],
  ['Launch mass (kg)', (r) => round(r.launchMass, 4)],
  ['Burnout mass (kg)', (r) => round(r.burnoutMass ?? null, 4)],
  ['Launch CG (m)', (r) => round(r.launchCG, 4)],
  ['Launch CP (m)', (r) => round(r.launchCP, 4)],
  ['Launch static margin (cal)', (r) => round(r.launchStaticMarginCal)],
  ['Altitude at deployment (m)', (r) => round(r.altitudeAtDeployment)],
  ['Velocity at deployment (m/s)', (r) => round(r.velocityAtDeployment)],
  ['Deployments', (r) => (r.deployments ?? [])
    .map((d) => `${d.device}@${d.time.toFixed(1)}s opens ${d.velocityAtDeployment?.toFixed(1) ?? '?'}m/s descent ${d.descentRate?.toFixed(1) ?? '?'}m/s${d.openingOk === false || d.descentOk === false ? ' (!)' : ''}`)
    .join('; ')],
  ['Drogue descent rate (m/s)', (r) => {
    const drogue = (r.deployments ?? []).find((d) => !d.isLanding);
    return round(drogue?.descentRate ?? null);
  }],
  ['Landing rate (m/s)', (r) => round(r.landingRate ?? r.groundHitVelocity)],
  ['Landing rate OK', (r) => flag(r.safeLandingRate ?? null)],
  ['Ground hit velocity (m/s)', (r) => round(r.groundHitVelocity)],
  ['Total flight time (s)', (r) => round(r.totalFlightTime)],
  ['Optimal delay (s)', (r) => round(r.optimumDelayS)],
  ['Recommended delay (s)', (r) => round(r.recommendedDelayS)],
  ['Lift-off speed OK', (r) => flag(r.safeLiftoffSpeed)],
  ['Thrust:weight OK', (r) => flag(r.safeThrustToWeight)],
  ['Safe deployment', (r) => flag(r.safeDeployment)],
  ['Static margin OK', (r) => flag(r.staticMarginOk)],
  ['Weathercock risk', (r) => r.weathercockRisk ?? ''],
  ['Motors (cluster)', (r) => r.motorCount ?? 1],
  ['Booster motors', (r) => (r.boosterMotors ?? []).join('; ')],
  ['Booster apogee (m)', (r) => round(r.branches?.[0]?.apogee ?? null)],
  ['Booster landing rate (m/s)', (r) => round(r.branches?.[0]?.landingRate ?? null)],
  ['Booster landing OK', (r) => flag(r.branches?.[0]?.safeLandingRate ?? null)],
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
