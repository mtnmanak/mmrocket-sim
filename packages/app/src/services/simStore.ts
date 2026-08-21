import { csvCell } from './csvUtil.js';
import type { SimRun } from './simReport.js';
import { warningKeysCell } from './simWarnings.js';
import { siToUi, type Quantity, type UnitSelection } from '../prefs/units.js';

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
    if (!Array.isArray(list)) return [];
    // Revive plugged delays (persisted as the string "Infinity" — see persist).
    // Runs saved before that fix came back as null; treat those as plugged too
    // when the label says so.
    for (const r of list) {
      const d = r.delayS as unknown;
      if (d === 'Infinity' || (d === null && /-P\b/.test(r.motor ?? ''))) r.delayS = Infinity;
    }
    return list;
  } catch {
    return [];
  }
}

// Set when a write is refused (quota), cleared by the next write that sticks.
// Every mutation goes through addRun/addRuns/deleteRun/clearRuns
// synchronously, so a getter the caller checks after each mutation is enough —
// no subscription machinery in a plain module.
let lastPersistFailed = false;

/**
 * True when the latest mutation could not be written: the returned table is
 * what localStorage still holds, not what the caller asked to save.
 */
export function persistFailed(): boolean {
  return lastPersistFailed;
}

function persist(runs: SimRun[]): SimRun[] {
  const kept = runs.slice(0, MAX_RUNS);
  try {
    // JSON has no Infinity — JSON.stringify(Infinity) is null, which silently
    // corrupted stored plugged runs. Round-trip it as a string instead.
    localStorage.setItem(KEY, JSON.stringify(kept, (_k, v) =>
      typeof v === 'number' && v === Infinity ? 'Infinity' : v));
  } catch {
    // Quota: setItem wrote NOTHING. Returning `kept` here showed runs in the
    // Saved-simulations table that vanished on reload — return the stored
    // truth instead, and flag it so the UI can say so.
    lastPersistFailed = true;
    return loadRuns();
  }
  lastPersistFailed = false;
  // Return what was stored, so the in-memory table matches the next reload.
  return kept;
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
  // removeItem frees space instead of needing it, so clearing works even at
  // quota, where persist([])'s setItem could in principle still be refused.
  // loadRuns() reads a missing key as [] — same result as storing "[]".
  try {
    localStorage.removeItem(KEY);
    lastPersistFailed = false;
  } catch {
    // Storage inaccessible outright (blocked site data) — not a quota case;
    // whatever is stored is still there and will be back on reload.
    lastPersistFailed = true;
  }
  return loadRuns();
}

// Flight-day unit conversions for the leading columns (the owner's spec: the
// numbers he compares at the field are ft / mph / Gs / grams).
const FT = 3.28084;
const MPH = 2.23694;
const G_MS2 = 9.80665;

/**
 * CSV columns: label + SimRun key + formatter. The first 14 columns are
 * the owner's flight-day comparison set, in his order and units — those NEVER
 * follow the unit preferences. The detail columns after them convert to the
 * user's selected units (with the unit in each header) when a UnitSelection
 * is passed; without one they stay SI (tests, back-compat).
 */
function buildColumns(u?: UnitSelection): [string, (r: SimRun) => string | number][] {
  // Convert an SI value to the user's unit for `quantity` (SI when no prefs).
  const cv = (quantity: Quantity, si: number | null | undefined, digits = 2): string | number => {
    if (si == null || !Number.isFinite(si)) return '';
    const v = u ? siToUi(quantity, u[quantity], si) : si;
    return Number(v.toFixed(digits));
  };
  const sym = (quantity: Quantity, siLabel: string) => (u ? u[quantity] : siLabel);
  return [
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
  ['Delay (s)', (r) => (Number.isFinite(r.delayS) ? r.delayS : 'P')],
  ['Pad Weight (g)', (r) => round(r.launchMass === null ? null : r.launchMass * 1000, 1)],
  ['Recovery Weight (g)', (r) => round(r.burnoutMass == null ? null : r.burnoutMass * 1000, 1)],
  ['Date', (r) => new Date(r.when).toISOString()],
  ['Rocket', (r) => r.rocket],
  [`Max altitude (${sym('distance', 'm')})`, (r) => cv('distance', r.maxAltitude)],
  [`Max velocity (${sym('velocity', 'm/s')})`, (r) => cv('velocity', r.maxVelocity)],
  ['Max Mach', (r) => round(r.maxMach, 3)],
  [`Max acceleration (${sym('acceleration', 'm/s2')})`, (r) => cv('acceleration', r.maxAcceleration)],
  // r/s (revolutions/second) matches the desktop's UNITS_ROLL default unit.
  ['Max roll rate (r/s)', (r) => round(r.maxRollRateRadS == null ? null : r.maxRollRateRadS / (2 * Math.PI), 3)],
  ['Time to apogee (s)', (r) => round(r.timeToApogee)],
  ['Time to burnout (s)', (r) => round(r.timeToBurnout)],
  ['Time to launch guide departure (s)', (r) => round(r.timeToRodDeparture, 3)],
  [`Velocity at launch guide departure (${sym('velocity', 'm/s')})`, (r) => cv('velocity', r.rodExitVelocity)],
  [`Launch mass (${sym('mass', 'kg')})`, (r) => cv('mass', r.launchMass, 4)],
  [`Burnout mass (${sym('mass', 'kg')})`, (r) => cv('mass', r.burnoutMass ?? null, 4)],
  [`Launch CG (${sym('length', 'm')})`, (r) => cv('length', r.launchCG, 4)],
  [`Launch CP (${sym('length', 'm')})`, (r) => cv('length', r.launchCP, 4)],
  ['Launch static margin (cal)', (r) => round(r.launchStaticMarginCal)],
  [`Altitude at deployment (${sym('distance', 'm')})`, (r) => cv('distance', r.altitudeAtDeployment)],
  [`Velocity at deployment (${sym('velocity', 'm/s')})`, (r) => cv('velocity', r.velocityAtDeployment)],
  ['Deployments', (r) => (r.deployments ?? [])
    .map((d) => `${d.device}@${d.time.toFixed(1)}s opens ${d.velocityAtDeployment?.toFixed(1) ?? '?'}m/s descent ${d.descentRate?.toFixed(1) ?? '?'}m/s${d.openingOk === false || d.descentOk === false ? ' (!)' : ''}`)
    .join('; ')],
  [`Drogue descent rate (${sym('velocity', 'm/s')})`, (r) => {
    const drogue = (r.deployments ?? []).find((d) => !d.isLanding);
    return cv('velocity', drogue?.descentRate ?? null);
  }],
  [`Landing rate (${sym('velocity', 'm/s')})`, (r) => cv('velocity', r.landingRate ?? r.groundHitVelocity)],
  ['Landing rate OK', (r) => flag(r.safeLandingRate ?? null)],
  [`Landing distance (${sym('distance', 'm')})`, (r) => cv('distance', r.landingDistanceM ?? null, 1)],
  ['Landing bearing (deg from N)', (r) => round(r.landingBearingDeg ?? null, 0)],
  [`Ground hit velocity (${sym('velocity', 'm/s')})`, (r) => cv('velocity', r.groundHitVelocity)],
  ['Total flight time (s)', (r) => round(r.totalFlightTime)],
  ['Optimal delay (s)', (r) => round(r.optimumDelayS)],
  ['Recommended delay (s)', (r) => round(r.recommendedDelayS)],
  ['Lift-off speed OK', (r) => flag(r.safeLiftoffSpeed)],
  ['Thrust:weight OK', (r) => flag(r.safeThrustToWeight)],
  ['Safe deployment', (r) => flag(r.safeDeployment)],
  ['Static margin OK', (r) => flag(r.staticMarginOk)],
  ['Weathercock risk', (r) => r.weathercockRisk ?? ''],
  ['Motors (cluster)', (r) => r.motorCount ?? 1],
  ['Motor config', (r) => r.motorConfig ?? ''],
  ['Booster motors', (r) => (r.boosterMotors ?? []).join('; ')],
  [`Booster apogee (${sym('distance', 'm')})`, (r) => cv('distance', r.branches?.[0]?.apogee ?? null)],
  [`Booster landing rate (${sym('velocity', 'm/s')})`, (r) => cv('velocity', r.branches?.[0]?.landingRate ?? null)],
  ['Booster landing OK', (r) => flag(r.branches?.[0]?.safeLandingRate ?? null)],
  [`Wind avg (${sym('windspeed', 'm/s')})`, (r) => cv('windspeed', r.windAvg, 1)],
  // Under Auto, different rows can have flown different models — without this
  // column the comparison table can't tell them apart.
  ['Aero model', (r) => `${r.aeroModel ?? 'classic'}${r.rogersKbf ? '+kbf' : ''}`],
  ['Execution time (ms)', (r) => Math.round(r.execMs)],
  // Machine keys, not prose — greppable/filterable in a spreadsheet; the
  // report renders the plain-language version (simWarnings.ts).
  ['Sim warnings', (r) => warningKeysCell(r.simWarnings)],
  ['Comments', (r) => r.comments],
  ];
}

function round(v: number | null, digits = 2): string | number {
  return v === null || !Number.isFinite(v) ? '' : Number(v.toFixed(digits));
}

function flag(v: boolean | null): string {
  return v === null ? '' : v ? 'yes' : 'NO';
}

/**
 * Pass the user's UnitSelection so the detail columns come out in their
 * preferred units (headers carry the unit); omitted = SI detail columns.
 * The 14 flight-day lead columns are fixed ft/mph/Gs/g either way.
 */
export function runsToCsv(runs: SimRun[], units?: UnitSelection): string {
  const cols = buildColumns(units);
  const header = cols.map(([label]) => csvCell(label)).join(',');
  const rows = runs.map((r) => cols.map(([, f]) => csvCell(f(r))).join(','));
  return [header, ...rows].join('\n');
}

/**
 * Same catalog as the CSV, but typed: numbers stay numbers so a spreadsheet
 * never reinterprets them (feeds the .xlsx export).
 */
export function runsToTable(runs: SimRun[], units?: UnitSelection): {
  headers: string[]; rows: (string | number)[][];
} {
  const cols = buildColumns(units);
  return {
    headers: cols.map(([label]) => label),
    rows: runs.map((r) => cols.map(([, f]) => f(r))),
  };
}
