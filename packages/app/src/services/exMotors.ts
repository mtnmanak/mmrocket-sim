import { cautionNote } from './importNotes.js';
import { INITIAL_UNITS, noticeEqual, noticeComparison, noticeQuantity, type UnitSelection } from '../prefs/units.js';
import type { MotorDbEntry } from './motorDb.js';
import { clearCurveCache, flownCurve, MAX_MOTOR_THRUST_N, repairSamples, samplesToMotorSpec, type RepairedMotorSpec } from './thrustcurve.js';
import { parseDecimal } from './xmlUtil.js';
import { backUpUnreadableStore } from './storeBackup.js';
import { parseXml, type XmlElement } from './xmlParse.js';
import { EX_MOTOR_COUNT_NOTE, EX_SAMPLE_LIMIT_NOTE, MAX_EX_IMPORT_MOTORS, MAX_EX_MOTOR_SAMPLES } from './exMotorLimits.js';
import type { MotorSpec } from '@online-openrocket/engine';

/** Delay belongs to each mount; this is the exact curve the design loaded. */
export type ExFlightSnapshot = Omit<MotorSpec, 'ejectionDelay'>;
const MAX_EX_MOTOR_ID_LENGTH = 1024;

/** Preserve a readable prefix while reserving room for any collision suffix. */
export function boundedExId(id: string, suffix = ''): string {
  return id.slice(0, MAX_EX_MOTOR_ID_LENGTH - suffix.length) + suffix;
}

/**
 * User-imported (EX / experimental) motors from RASP .eng or RockSim .rse
 * files. Imported motors persist in localStorage and appear in the motor
 * browser under the "EX" filter, with the original maker shown in its row.
 * Thrust curves live locally — no
 * network involved.
 */

const KEY = 'online-openrocket.ex-motors.v1';

export interface ExMotor {
  /** "ex:" + slug — namespaced so the loader knows curves are local. */
  motorId: string;
  /** Original library identity, when a file assigns a distinct snapshot id. */
  libraryMotorId?: string;
  designation: string;
  /** Manufacturer string from the file (shown as detail; filter shows "EX"). */
  realManufacturer: string;
  /** mm */
  diameter: number;
  /** mm */
  length: number;
  totalWeightG: number;
  propWeightG: number;
  /** "0,3,5" | "P" (plugged — no ejection charge) | "5,10,P" | "" */
  delays: string;
  samples: { time: number; thrust: number }[];
  /**
   * Optional per-sample TOTAL motor mass (kg), from an .rse that turns RockSim's
   * own mass model off (auto-calc-mass="0") — see rseSampleMassesKg.
   */
  sampleMassesKg?: number[];
  /**
   * The nozzle EXIT diameter the `.rse` states, in METRES, when the file gives
   * a plausible one. Absent for every `.eng` (the RASP format has no such
   * field) and for the overwhelming majority of `.rse` files, which state
   * `exitDia="0."`.
   *
   * This is the only nozzle figure an EX motor will ever have: the app's
   * nozzle database covers AeroTech and Loki catalogue motors, and an `ex:` id
   * matches nothing in it. Without this the number in a builder's own file was
   * thrown away and they had to type it back by hand (Eric, 2026-09-21).
   */
  exitDiameterM?: number;
  source: 'eng' | 'rse' | 'snapshot';
  addedAt: number;
  /** Exact loaded data when it differs from the original source definition. */
  flightSnapshot?: ExFlightSnapshot;
}

/**
 * The plausible band for a stated nozzle exit, as a fraction of the motor’s
 * own case diameter. MEASURED, not invented: across the 279 rows of the
 * shipped nozzle database that carry both figures, exit ÷ casing runs
 * **0.1664** (AeroTech E16-4W, 4.826 mm on 29 mm) to **0.7094** (AeroTech
 * O5500X-PS, 69.52 mm on 98 mm), median 0.4536. The band below is those
 * bounds with a little air either side.
 */
export const EXIT_MIN_FRACTION_OF_CASE = 0.15;
export const EXIT_MAX_FRACTION_OF_CASE = 0.75;

/**
 * A `.rse`’s `exitDia`, in METRES, or null when it is absent, zero or not
 * believable.
 *
 * **THE UNIT IS MILLIMETRES.** Every linear attribute in the format is —
 * desktop OpenRocket’s own RockSim loader divides `dia`, `len` and each
 * point’s `cg` by 1000 and nothing else — and the one real file on this
 * machine carrying a nonzero value settles it: Klima’s B2 states
 * `dia="18." throatDia="3.6" exitDia="5."`, which is a 5 mm exit and an
 * expansion ratio of 1.93 in millimetres, and absurd in any other unit.
 *
 * **WHY A TWO-SIDED GATE AND NOT JUST "SMALLER THAN THE CASE".** A wrong
 * unit fails SAFE on its own: the term is A_exit × Δp, so a file quoting
 * inches and read as millimetres gives 1/645th of the area and the flight
 * comes out conservative. It is the LOW side that therefore needs the check,
 * and a one-sided "exit < dia" bound would pass 1.5 mm on a 29 mm case
 * without blinking. The high side catches the other real mistake — a case
 * diameter typed into the exit field — which is the only way a unit error
 * can over-credit thrust.
 *
 * A rejected value is DROPPED, not clamped: a number we do not believe is
 * worth less than the blank the user can fill in themselves.
 */
export function exitDiameterFromRse(
  exitDiaMm: number | null, caseDiaMm: number, units: UnitSelection = INITIAL_UNITS,
): { exitDiameterM: number } | { rejected: string } | null {
  if (exitDiaMm === null || !Number.isFinite(exitDiaMm) || exitDiaMm <= 0) return null;
  if (!Number.isFinite(caseDiaMm) || caseDiaMm <= 0) return null;
  const f = exitDiaMm / caseDiaMm;
  const [low, high] = exitRangeM(caseDiaMm);
  const exitM = exitDiaMm / 1000;
  if (exitM < low) {
    return { rejected: `${exitDiaMm} (only ${(f * 100).toFixed(0)}% of the ${noticeQuantity('motorDimensions', caseDiaMm / 1000, units, { parenthesized: true })} case, which is too small to be an exit plane — if the file means inches, type the value yourself in your own units)` };
  }
  if (exitM > high) {
    return { rejected: `${exitDiaMm} (${(f * 100).toFixed(0)}% of the ${noticeQuantity('motorDimensions', caseDiaMm / 1000, units, { parenthesized: true })} case — larger than any nozzle in the database, so it reads like a case diameter rather than an exit)` };
  }
  return { exitDiameterM: exitM };
}
const exitRangeM = (caseMm: number) => [caseMm * EXIT_MIN_FRACTION_OF_CASE / 1000, caseMm * EXIT_MAX_FRACTION_OF_CASE / 1000] as const;
const sampleMassInRangeKg = (m: number, totalG: number, propG: number) => Number.isFinite(m)
  && m >= (totalG - propG) * 0.99 / 1000 && m <= totalG / 1000 * 1.01;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Shared archive/library gate: old imports must meet today's checks (audit 2026-10-11, S1c-5). */
export function validExMotor(v: unknown): v is ExMotor {
  return validExMotorFields(v) && hasDistinctThrustPoints(v.samples)
    && (v.flightSnapshot === undefined || validFlightSnapshot(v.flightSnapshot));
}

/** Archive screening before separately naming legacy curves that cannot fly. */
export function validExMotorFields(v: unknown): v is ExMotor {
  if (!record(v)) return false;
  const totalG = v['totalWeightG'];
  const propG = v['propWeightG'];
  return typeof v['motorId'] === 'string' && v['motorId'].startsWith('ex:') && v['motorId'].length <= MAX_EX_MOTOR_ID_LENGTH
    && (v['flightSnapshot'] === undefined || validFlightSnapshotFields(v['flightSnapshot']))
    && typeof v['designation'] === 'string' && v['designation'].length > 0
    && typeof v['realManufacturer'] === 'string' && typeof v['delays'] === 'string'
    && positive(v['diameter']) && positive(v['length'])
    && positive(totalG) && positive(propG) && propG <= totalG
    && finite(v['addedAt']) && (v['source'] === 'eng' || v['source'] === 'rse'
      || (v['source'] === 'snapshot' && v['flightSnapshot'] !== undefined))
    && Array.isArray(v['samples']) && v['samples'].length >= 2 && v['samples'].length <= MAX_EX_MOTOR_SAMPLES
    // Negative samples cannot fly; refuse them before the kernel (audit 2026-10-11, S1c-4).
    && v['samples'].every((s: unknown) => record(s) && finite(s['time']) && s['time'] >= 0
      && finite(s['thrust']) && s['thrust'] >= 0 && s['thrust'] <= MAX_MOTOR_THRUST_N)
    && (v['sampleMassesKg'] === undefined || (Array.isArray(v['sampleMassesKg'])
      && v['sampleMassesKg'].length === v['samples'].length
      && v['sampleMassesKg'].every((m: unknown) => finite(m)
        && sampleMassInRangeKg(m, totalG, propG))))
    && (v['exitDiameterM'] === undefined || (positive(v['exitDiameterM'])
      && v['exitDiameterM'] >= exitRangeM(v['diameter'])[0] && v['exitDiameterM'] <= exitRangeM(v['diameter'])[1]));
}

function hasDistinctThrustPoints(samples: { time: number; thrust: number }[]): boolean {
  const curve = flownCurve(samples).samples;
  return curve.length >= 2 && curve[curve.length - 1]!.time > 0
    && curve.some(p => p.thrust > 0)
    && curve.every((p, i) => Number.isFinite(p.time) && (i === 0 || p.time > curve[i - 1]!.time));
}

/** Exact loaded data is accepted only when every array can fly unchanged. */
export function validFlightSnapshot(v: unknown): v is ExFlightSnapshot {
  return validFlightSnapshotFields(v) && v.cgX >= 0 && v.cgX <= v.length && v.thrusts.some(f => f > 0);
}

function validFlightSnapshotFields(v: unknown): v is ExFlightSnapshot {
  if (!record(v) || typeof v['designation'] !== 'string' || !v['designation']
    || !positive(v['diameter']) || !positive(v['length']) || !finite(v['cgX'])) return false;
  const times = v['times'], thrusts = v['thrusts'], masses = v['masses'];
  return Array.isArray(times) && times.length >= 2 && times.length <= MAX_EX_MOTOR_SAMPLES
    && times[0] === 0
    && times.every((t: unknown, i: number) => finite(t) && t >= 0 && (i === 0 || t > times[i - 1]))
    && Array.isArray(thrusts) && thrusts.length === times.length && thrusts.every((f: unknown) => finite(f) && f >= 0 && f <= MAX_MOTOR_THRUST_N)
    && Array.isArray(masses) && masses.length === times.length && positive(masses[0])
    && masses.every((m: unknown) => finite(m) && m >= 0);
}

/**
 * The library as last CHANGED, while that change is not in storage — null
 * whenever storage holds the current list (audit 2026-09-22).
 *
 * A failed write used to be swallowed, and every reader goes back to
 * localStorage (fetchMotorSpec's `getExMotor` among them), so a motor the
 * notice had just called imported could not fly even in the same session:
 * "Imported motor … is no longer stored". Holding the list here keeps it
 * flying until the page goes away, which is exactly what the notice says.
 */
let unstored: ExMotor[] | null = null;

/** The identity fields a Save writes, checked without today's flight-data refusals. */
export function validExMotorIdentity(v: unknown): v is Pick<ExMotor, 'motorId' | 'designation' | 'realManufacturer'> {
  return record(v) && typeof v['motorId'] === 'string' && v['motorId'].startsWith('ex:')
    && v['motorId'].length <= MAX_EX_MOTOR_ID_LENGTH
    && typeof v['designation'] === 'string' && !!v['designation']
    && typeof v['realManufacturer'] === 'string';
}

/**
 * A stored EX definition (a motor spec's or an unmatched reference's
 * `exDefinition`) that Save can write and compare: the identity a Save writes
 * and the samples exMotorIdentity reads. Deliberately not today's whole
 * validExMotor: a definition an older build captured can fail a later refusal
 * while every reader copes (cloud session 10).
 */
export function validStoredExDefinition(v: unknown): boolean {
  const samples = record(v) ? v['samples'] : undefined;
  return validExMotorIdentity(v) && Array.isArray(samples) && samples.every(record);
}

/** Save can retain a legacy maker even when its curve cannot be loaded (audit 2026-10-11, S1c-5 integration). */
export function loadExMotorIdentities(): Pick<ExMotor, 'motorId' | 'designation' | 'realManufacturer'>[] {
  try {
    const list: unknown = unstored ?? JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(list)) return [];
    return list.flatMap((value: unknown) => {
      if (!validExMotorIdentity(value)) return [];
      // Identity only: never expose rejected flight data to a motor loader.
      return [{ motorId: value['motorId'], designation: value['designation'], realManufacturer: value['realManufacturer'] }];
    });
  } catch {
    return [];
  }
}

export function loadExMotors(notes?: string[], units: UnitSelection = INITIAL_UNITS): ExMotor[] {
  if (unstored) return unstored;
  try {
    const raw = localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    const valid: ExMotor[] = [];
    for (const value of list) {
      if (validExMotor(value)) { valid.push(value); continue; }
      // The browser reports these once on opening; routine library lookups
      // only refuse them, without repeating notices (audit 2026-10-11, S1c-5).
      if (notes) {
        const name = record(value) && typeof value['designation'] === 'string' ? value['designation'].slice(0, 160) : 'unnamed motor';
        const reason = !record(value) ? null
          : !finite(value['totalWeightG']) ? `loaded mass "${String(value['totalWeightG'])}" is not a finite number`
            : !finite(value['propWeightG']) ? `propellant mass "${String(value['propWeightG'])}" is not a finite number`
              : massProblem(value['propWeightG'], value['totalWeightG'], units);
        cautionNote(notes, 'I15.stored-ex-refused', `Stored EX motor ${name} was not loaded: ${reason ?? 'invalid dimensions, curve or motor fields'}. Re-import its original .eng/.rse file.`);
      }
    }
    return valid;
  } catch {
    return [];
  }
}

/** A library write: the list as it now stands, and whether it reached storage. */
export interface ExLibraryWrite {
  motors: ExMotor[];
  stored: boolean;
  /** Not written because the stored library is not a list the app can read and could not be copied aside; it was left unchanged. */
  unreadable?: true;
  /** The stored library was not a list the app can read: it was copied to its side key (storeBackup.ts) and a new one started. */
  backedUp?: true;
}

// A re-import keeps its id; mounted nozzle consumers must still refresh
// even without a parent render (audit 2026-10-11, S3c-2).
let revision = 0;
const listeners = new Set<() => void>();
export const exMotorRevision = () => revision;
export function subscribeExMotors(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function changedLibrary(): void {
  revision++;
  for (const listener of listeners) listener();
}

/**
 * THE STORED ENTRIES A WRITE KEEPS (cloud session 20, the My parts rule of audit
 * S7-3). loadExMotors refuses entries that fail validExMotor (a damaged one, or
 * one a newer build wrote) and reads a non-list as empty; add, delete and
 * restore wrote what it returned, so one write erased them. They are kept
 * verbatim, ahead of the library, unless they carry the id of a motor this
 * write stores or removes: a re-import is the remedy the I15 note gives. A
 * stored value that is not a list the app can read is copied to its side key
 * first and the write starts a new library (`backedUp`; cloud session 20);
 * null, and nothing may be written over it, when that copy cannot be made.
 * Blocked storage reads as empty, so the write fails as it always did.
 */
function refusedStoredEntries(ids: ReadonlySet<string>): { kept: unknown[]; backedUp: boolean } | null {
  let raw: string | null;
  try { raw = localStorage.getItem(KEY); } catch { return { kept: [], backedUp: false }; }
  let list: unknown;
  try { list = raw ? JSON.parse(raw) : []; } catch { list = undefined; }
  if (!Array.isArray(list)) {
    return raw !== null && backUpUnreadableStore(KEY, raw) ? { kept: [], backedUp: true } : null;
  }
  return { kept: list.filter(v => !validExMotor(v) && !(record(v) && typeof v['motorId'] === 'string' && ids.has(v['motorId']))),
    backedUp: false };
}

/**
 * Writes the library, and says whether it stuck (audit 2026-09-22).
 *
 * localStorage is one ~5 MB pool per origin, and an EX library can be most of
 * it: a tester's 891-motor rasp.eng is 753 KB of JSON. On a quota refusal the
 * downloaded-curve cache is emptied — a convenience that refills itself, where
 * this list is the user's own work — and the write tried once more. If that
 * fails too the list lives in memory for the session and `stored` is false, so
 * the caller can say so instead of promising it survives a reload.
 */
function persist(motors: ExMotor[], removed: readonly string[] = []): ExLibraryWrite {
  const stored = refusedStoredEntries(new Set([...motors.map(m => m.motorId), ...removed]));
  if (stored === null) {
    unstored = motors;
    changedLibrary();
    return { motors, stored: false, unreadable: true };
  }
  const { kept, backedUp } = stored;
  const json = JSON.stringify([...kept, ...motors]);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      localStorage.setItem(KEY, json);
      unstored = null;
      changedLibrary();
      return { motors, stored: true, ...(backedUp ? { backedUp: true as const } : {}) };
    } catch {
      if (attempt === 0) clearCurveCache();
    }
  }
  unstored = motors;
  changedLibrary();
  return { motors, stored: false };
}

/** Identity is every named motor/flight field; storage id, import date and source format are metadata. */
export function exMotorIdentity(m: ExMotor): string {
  return JSON.stringify([
    m.designation, m.realManufacturer, m.diameter, m.length, m.totalWeightG, m.propWeightG,
    m.delays, m.samples.map(s => [s.time, s.thrust]), m.sampleMassesKg ?? null, m.exitDiameterM ?? null,
    m.flightSnapshot ? flightIdentity(m.flightSnapshot) : null,
  ]);
}

/** Design archives never replace a library motor, even on an id collision. */
export function restoreExMotors(added: readonly ExMotor[], notes: string[]): Map<string, string> {
  const library = [...loadExMotors()];
  const ids = new Map<string, string>();
  const byIdentity = new Map<string, ExMotor>();
  for (const motor of library) {
    const identity = exMotorIdentity(motor);
    if (!byIdentity.has(identity)) byIdentity.set(identity, motor);
  }
  const usedIds = new Set(library.map(m => m.motorId));
  const designations = new Set(library.map(m => m.designation));
  const nextSuffix = new Map<string, number>();
  let changed = false;
  for (const motor of added) {
    const identity = exMotorIdentity(motor);
    const same = byIdentity.get(identity);
    if (same) { ids.set(motor.motorId, same.motorId); continue; }
    let id = motor.motorId;
    let suffix = nextSuffix.get(id) ?? 2;
    while (usedIds.has(id)) id = boundedExId(motor.motorId, `~${suffix++}`);
    nextSuffix.set(motor.motorId, suffix);
    if (designations.has(motor.designation)) {
      notes.push(`Embedded EX motor ${motor.designation}: a different library motor has the same name; both were kept.`);
    }
    const restored = { ...motor, motorId: id };
    library.push(restored);
    byIdentity.set(identity, restored);
    usedIds.add(id);
    designations.add(motor.designation);
    ids.set(motor.motorId, id);
    changed = true;
  }
  const write = changed ? persist(library) : null;
  if (write && !write.stored) {
    cautionNote(notes, 'I15.ex-session-only', 'Embedded EX motors are available for this session but were not saved in browser storage. Keep the .ork file and reopen it after reloading.');
  }
  if (write?.backedUp) {
    cautionNote(notes, 'I15.ex-library-backed-up', 'The stored motor library could not be read. The app kept a copy of it in this browser and started a new library with these motors.');
  }
  return ids;
}

/** Why addExMotors refuses a motor; importMotorFiles names each refused motor with it. */
export const refusedExMotorNote = (designation: string) =>
  `Motor ${designation}: invalid dimensions, curve or motor fields; it was not stored.`;

/** An import's write, and what it did to motors that share a maker and name. */
export interface ExImport extends ExLibraryWrite {
  /** Designations that replaced a library entry with the same id — a re-import, usually. */
  replaced: string[];
  /** Designations the batch carried more than once with DIFFERENT data, each kept under a numbered id. */
  duplicates: string[];
}

/**
 * Adds one import's motors to the library (audit 2026-09-22 for the dedupe).
 *
 * The id is the maker and name, so two motors can share one. Within a batch
 * they used to both go in, and every lookup (`find`) answered with the first,
 * so the second was unreachable; the tester's 891-motor rasp.eng lists AMW
 * K475WW twice, once with a 0 s delay and once with 100 (no charge). An exact
 * repeat is now dropped, and a different motor under a taken id is kept as
 * `<id>~2`, `~3` … — `~` is a character slug() never writes, and the order is
 * the file's, so re-importing the same file lands on the same ids. A batch
 * motor whose id is already in the library replaces it, as it always did, but
 * the caller is told which.
 */
export function addExMotors(added: ExMotor[]): ExImport {
  for (const motor of added) {
    const name = motor.designation;
    if (!validExMotor(motor)) throw new Error(refusedExMotorNote(name));
  }
  const batch = new Map<string, ExMotor>();
  const duplicates: string[] = [];
  const identities = new Map<string, Set<string>>();
  const nextSuffix = new Map<string, number>();
  for (const m of added) {
    const seen = identities.get(m.motorId) ?? new Set<string>();
    const identity = JSON.stringify({ ...m, motorId: '', addedAt: 0 });
    if (seen.has(identity)) continue;
    seen.add(identity);
    identities.set(m.motorId, seen);
    let id = boundedExId(m.motorId);
    let n = nextSuffix.get(m.motorId) ?? 2;
    while (batch.has(id)) id = boundedExId(m.motorId, `~${n++}`);
    nextSuffix.set(m.motorId, n);
    if (id !== m.motorId) duplicates.push(m.designation);
    batch.set(id, id === m.motorId ? m : { ...m, motorId: id });
  }
  const library = loadExMotors();
  const replaced = library.filter((m) => batch.has(m.motorId)).map((m) => m.designation);
  const kept = library.filter((m) => !batch.has(m.motorId));
  return { ...persist([...kept, ...batch.values()]), replaced, duplicates };
}

export function deleteExMotor(motorId: string): ExMotor[] {
  return persist(loadExMotors().filter((m) => m.motorId !== motorId), [motorId]).motors;
}

export function getExMotor(motorId: string): ExMotor | undefined {
  return loadExMotors().find((m) => m.motorId === motorId);
}

/** NAR impulse class letter for a total impulse (Ns). */
export function impulseClassOf(totImpulseNs: number): string {
  if (totImpulseNs <= 0) return '?';
  // A ends at 2.5 Ns and each class doubles.
  const idx = Math.max(0, Math.ceil(Math.log2(totImpulseNs / 2.5)));
  return String.fromCharCode('A'.charCodeAt(0) + Math.min(idx, 25));
}

function totals(samples: { time: number; thrust: number }[]) {
  let impulse = 0;
  let maxThrust = 0;
  for (let i = 1; i < samples.length; i++) {
    impulse += ((samples[i]!.time - samples[i - 1]!.time)
      * (samples[i]!.thrust + samples[i - 1]!.thrust)) / 2;
  }
  for (const s of samples) maxThrust = Math.max(maxThrust, s.thrust);
  const burnTime = samples.length ? samples[samples.length - 1]!.time : 0;
  return { impulse, maxThrust, burnTime };
}

/** Shape an EX motor as a browser/database row, retaining its EX filter identity. */
export function exToDbEntry(m: ExMotor): MotorDbEntry {
  // The picker must describe what Launch flies, including archived snapshots
  // whose original source definition differs (audit 2026-10-11, S1c-2).
  const snapshot = m.flightSnapshot;
  const samples = snapshot ? snapshot.times.map((time, i) => ({ time, thrust: snapshot.thrusts[i]! }))
    : flownCurve(m.samples).samples;
  const { impulse, maxThrust, burnTime } = totals(samples);
  const totalKg = snapshot?.masses[0];
  const dryKg = snapshot?.masses.at(-1);
  return {
    motorId: m.motorId,
    manufacturerAbbrev: 'EX',
    realManufacturer: m.realManufacturer,
    designation: snapshot?.designation ?? m.designation,
    commonName: snapshot?.designation ?? m.designation,
    impulseClass: impulseClassOf(impulse),
    diameter: snapshot ? snapshot.diameter * 1000 : m.diameter,
    length: snapshot ? snapshot.length * 1000 : m.length,
    avgThrustN: burnTime > 0 ? impulse / burnTime : 0,
    maxThrustN: maxThrust,
    totImpulseNs: impulse,
    burnTimeS: burnTime,
    totalWeightG: totalKg !== undefined ? totalKg * 1000 : m.totalWeightG,
    propWeightG: totalKg !== undefined && dryKg !== undefined ? (totalKg - dryKg) * 1000 : m.propWeightG,
    delays: m.delays || undefined,
    availability: 'regular',
    type: 'SU',
  };
}

/** The same pure EX conversion for loading a motor and checking a design archive. */
export function exToMotorSpec(ex: ExMotor, ejectionDelay: number): RepairedMotorSpec {
  const spec = ex.flightSnapshot ? { ...structuredClone(ex.flightSnapshot), ejectionDelay }
    : sourceMotorSpec(ex, ejectionDelay);
  // Capture at load time, including for MotorBrowser and session recovery.
  return { ...spec, exDefinition: structuredClone(ex) };
}

export function flightIdentity(s: ExFlightSnapshot): string {
  return JSON.stringify([s.designation, s.diameter, s.length, s.times, s.thrusts, s.masses, s.cgX]);
}

function sourceMotorSpec(ex: ExMotor, ejectionDelay: number): RepairedMotorSpec {
  if (ex.sampleMassesKg && ex.sampleMassesKg.length === ex.samples.length) {
    const repaired = repairSamples(ex.samples);
    const samples = [...repaired.samples];
    const masses = repaired.keptIndices.map((i) => ex.sampleMassesKg![i]!);
    if (samples[0]!.time > 0) {
      samples.unshift({ time: 0, thrust: 0 });
      masses.unshift(ex.totalWeightG / 1000);
    }
    return {
      designation: ex.designation, diameter: ex.diameter / 1000, length: ex.length / 1000,
      times: samples.map(s => s.time), thrusts: samples.map(s => s.thrust), masses,
      cgX: ex.length / 2000, ejectionDelay,
      ...(repaired.repairs.length ? { curveRepairs: repaired.repairs } : {}),
    };
  }
  return samplesToMotorSpec(exToDbEntry(ex), ex.samples, ejectionDelay);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Why a motor's loaded/propellant pair cannot describe a real motor, or null
 * when it can (grams). The same test isHeaderMasses applies to a downloaded
 * curve's header, applied per MOTOR at import (audit 2026-09-22): an EX motor
 * with more propellant than loaded mass used to import and then fail at fly
 * time, naming thrustcurve.org for a file off the user's own disk — and a
 * tester's 891-motor rasp.eng carries two (K700RT 901 g of propellant in a
 * 175 g motor; L1000S 1,301 in 1,248).
 */
function massProblem(propG: number, totG: number, units: UnitSelection = INITIAL_UNITS): string | null {
  if (!Number.isFinite(propG) || !Number.isFinite(totG)) return 'propellant and loaded mass must be finite numbers in grams';
  if (!(totG > 0)) return `loaded mass ${noticeQuantity('mass', totG / 1000, units)} is not a mass`;
  if (!(propG > 0)) return `propellant mass ${noticeQuantity('mass', propG / 1000, units)} is not a mass`;
  if (propG > totG && !noticeEqual(propG / 1000, totG / 1000)) {
    const [propellant, loaded] = noticeComparison('mass', propG / 1000, totG / 1000, units, { parenthesized: true });
    return propellant.startsWith('just ') ? `slightly more propellant than loaded mass (${loaded})` : `more propellant (${propellant}) than loaded mass (${loaded})`;
  }
  return null;
}

/**
 * RASP .eng parser. Format: ';' comment lines; a header line
 *   name diameter(mm) length(mm) delays(dash-sep|P) propMass(kg) totalMass(kg) mfr
 * followed by "time thrust" pairs. Files may contain several motors back to
 * back.
 *
 * A motor ends at the next HEADER-SHAPED line or the end of the file — seven
 * or more tokens with a numeric diameter and length, which no "time thrust"
 * line can be — not at its first zero-thrust sample (audit 2026-09-22). Ending
 * there cut a two-pulse motor off at the gap and then refused the whole file,
 * reading its second pulse's first sample as a header. Zeros after the LAST
 * burning sample are still trimmed to the first, so a single-pulse motor's
 * burn time is what it always was.
 *
 * A motor whose header masses are unusable is skipped and named in `notes`;
 * only a file with no usable motor at all is refused.
 */
export function parseEng(text: string, notes?: string[], units: UnitSelection = INITIAL_UNITS): ExMotor[] {
  const motors: ExMotor[] = [];
  const skipped: string[] = [];
  const lines = text.split(/\r?\n/);
  let header: string[] | null = null;
  /** Why the current header's motor is being skipped; its data lines are read past. */
  let refused: string | null = null;
  let samples: { time: number; thrust: number }[] = [];
  let motorCount = 0;

  const isHeader = (tok: string[]) =>
    tok.length >= 7 && Number.isFinite(parseDecimal(tok[1])) && Number.isFinite(parseDecimal(tok[2]));

  const finish = () => {
    const h = header;
    const pts = samples;
    const why = refused;
    header = null;
    refused = null;
    samples = [];
    if (!h) return;
    if (why) { skipped.push(why); return; }
    if (pts.length === 0) return;
    // A header has seven or more tokens (isHeader), so the name is there.
    const name = h[0]!;
    const [, diaMm, lenMm, delays, propKg, totKg, ...mfr] = h;
    if (!(parseDecimal(diaMm) > 0 && parseDecimal(lenMm) > 0)) {
      skipped.push(`${name}: diameter/length missing or not a positive number`);
      return;
    }
    // Trailing zeros after the last burning sample go, bar the first.
    let last = pts.length - 1;
    while (last > 0 && pts[last]!.thrust === 0 && pts[last - 1]!.thrust === 0) last--;
    pts.length = last + 1;
    if (pts[0]!.time > 0) pts.unshift({ time: 0, thrust: 0 });
    if (pts.length > MAX_EX_MOTOR_SAMPLES) { skipped.push(`${name}: ${EX_SAMPLE_LIMIT_NOTE}`); return; }
    const problem = massProblem(parseDecimal(propKg) * 1000, parseDecimal(totKg) * 1000, units);
    if (problem) { skipped.push(`${name}: ${problem}`); return; }
    if (pts.length < 2) { skipped.push(`${name}: no thrust data`); return; }
    if (!pts.some(p => p.thrust > 0)) { skipped.push(`${name}: no positive thrust; this motor cannot launch a rocket`); return; }
    if (!hasDistinctThrustPoints(pts)) { skipped.push(`${name}: fewer than two distinct thrust points`); return; }
    motors.push({
      motorId: boundedExId(`ex:${slug(`${mfr.join(' ') || 'ex'}-${name}`)}`),
      designation: name,
      realManufacturer: mfr.join(' ') || 'EX',
      diameter: parseDecimal(diaMm),
      length: parseDecimal(lenMm),
      totalWeightG: parseDecimal(totKg) * 1000,
      // massProblem accepts equality residue; store the valid boundary once.
      propWeightG: Math.min(parseDecimal(propKg) * 1000, parseDecimal(totKg) * 1000),
      // 'P' in the RASP delay field means PLUGGED — no ejection charge at all
      // — and it must survive into the delays string. Emptying it here (what
      // this line used to do) made exToDbEntry emit `delays: undefined`, and
      // thrustcurve's delayOptions then offered a made-up 0 s: a plugged EX
      // motor defaulted to it, and the kernel fired an ejection charge at
      // burnout on a motor that has none — a deployment at peak velocity on a
      // flight the real motor cannot produce. delayOptions maps 'P'/'PLUGGED'
      // to Infinity (the app's plugged representation, round-tripped through
      // simStore as the string "Infinity"), so passing the token straight
      // through is the whole fix. A mixed field ('5-10-P') always worked; only
      // the pure-'P' case — the normal one for high-power EX motors — did not.
      delays: (delays ?? '').split('-').filter((s) => s !== '').join(','),
      samples: pts,
      source: 'eng',
      addedAt: Date.now(),
    });
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const tok = line.split(/\s+/);
    if (isHeader(tok)) {
      finish();
      if (++motorCount > MAX_EX_IMPORT_MOTORS) throw new Error(EX_MOTOR_COUNT_NOTE);
      header = tok;
      // The two MASS columns get the same test as the two dimension columns.
      // They did not, and `parseDecimal('notanum')` is NaN, so a malformed header
      // imported a motor with propWeightG: NaN — which survives all the way to
      // fly time and then fails there saying "thrustcurve.org publishes no
      // loaded/propellant weight for <motor>", naming a service that had
      // nothing to do with a file the user loaded off their own disk.
      // parseRse refuses its equivalent ("initial mass missing or zero").
      if (!Number.isFinite(parseDecimal(tok[4])) || !Number.isFinite(parseDecimal(tok[5]))) {
        // Both are there: a header has seven or more tokens (isHeader).
        refused = `Propellant and total mass must be numbers in "${line.slice(0, 60)}" — `
          + `read "${tok[4]!}" and "${tok[5]!}".`;
      }
      continue;
    }
    if (!header) throw new Error(`Not a RASP header line: "${line.slice(0, 60)}"`);
    if (refused) continue; // a skipped motor's data lines are read past to the next header
    if (samples.length >= MAX_EX_MOTOR_SAMPLES) { refused = `${header[0]!}: ${EX_SAMPLE_LIMIT_NOTE}`; continue; }
    const [t, f] = tok.map(parseDecimal);
    if (tok.length !== 2 || !Number.isFinite(t) || !Number.isFinite(f)) {
      throw new Error(`Bad data line: "${line.slice(0, 60)}"`);
    }
    // Name the motor and point at import, not an unnamed kernel refusal
    // after a successful import (audit 2026-10-11, S1c-4).
    if (t! < 0 || f! < 0) {
      refused = `${header[0]!}: data point ${samples.length + 1} has negative time or thrust (${t!}, ${f!})`;
      continue;
    }
    if (f! > MAX_MOTOR_THRUST_N) {
      refused = `${header[0]!}: data point ${samples.length + 1} exceeds the maximum thrust of 10,000,000 N`;
      continue;
    }
    samples.push({ time: t!, thrust: f! });
  }
  finish(); // the last motor ends with the file
  if (motors.length === 0) {
    throw new Error(skipped.length
      ? skipped.join(' · ')
      : 'No motors found in .eng file');
  }
  if (skipped.length) {
    notes?.push(`skipped ${skipped.length} motor${skipped.length === 1 ? '' : 's'} — ${skipped.join(' · ')}`);
  }
  return motors;
}

/**
 * The per-sample masses an .rse flies, in kg of TOTAL motor mass, or undefined
 * when the impulse-proportional model should fly instead (audit 2026-09-22).
 *
 * RockSim's `m` is the PROPELLANT still aboard, not the motor's mass: in the
 * 1,275 engine records of the local .rse corpus the first point equals propWt
 * in 1,239 and initWt in none. Read as total mass it put a motor in the air
 * lighter by its whole case. And RockSim's own `auto-calc-mass` — on in all
 * 1,275, and on unless the file says "0"/"false", which is desktop's reading
 * (RockSimMotorLoader) — says the points are NOT the model to fly: desktop
 * rebuilds the curve from initWt/propWt then, and so does this app.
 *
 * With it off, the points fly: as propellant aboard plus the case (initWt −
 * propWt) when they start at propWt, as total mass when they start at initWt,
 * and not at all when they start at neither — a file that contradicts itself,
 * or whose points carry a mass that is missing, blank, negative or not a
 * number, is named in `notes` and flies the model.
 */
function rseSampleMassesKg(
  el: XmlElement, name: string, masses: number[], initG: number, propG: number, notes?: string[], units: UnitSelection = INITIAL_UNITS,
): number[] | undefined {
  const autoCalc = !/^(0|false)$/i.test((el.getAttribute('auto-calc-mass') ?? '').trim());
  if (autoCalc) return undefined;
  // Said, not just dropped: a file that turns the model off but whose points
  // cannot fly fell back to the model with nothing to tell the user why.
  // `masses` is read from the same <eng-data> list as the thrust points, and a
  // point whose t or f cannot be read skips the whole motor, so the two
  // series always line up and there is no count mismatch to report.
  const bad = masses.findIndex((m) => !(Number.isFinite(m) && m >= 0));
  if (bad >= 0) {
    const points = el.querySelectorAll(':scope > data > eng-data');
    const raws = masses.map((_, i) => points[i]?.getAttribute('m') ?? null);
    const raw = raws[bad]!;
    const said = raws.every((r) => r === null) ? 'no point has an m'
      : `point ${bad + 1} of ${masses.length} has `
        + (raw === null ? 'no m' : raw.trim() === '' ? 'a blank m' : `m="${raw.slice(0, 20)}"`);
    notes?.push(`${name}: its per-point masses could not be used (${said}), so burn-off is spread in proportion `
      + 'to impulse instead.');
    return undefined;
  }
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.01 * b;
  const propellant = near(masses[0]!, propG);
  if (propellant || near(masses[0]!, initG)) {
    const low = propellant ? 0 : initG - propG;
    const high = propellant ? propG : initG;
    if (masses.every((m) => m >= low * 0.99 && m <= high * 1.01)) {
      const converted = masses.map((m) => {
        const caseG = propellant ? initG - propG : 0;
        const total = m + caseG;
        return Number.isFinite(total) ? total / 1000 : m / 1000 + caseG / 1000;
      });
      if (converted.every(m => sampleMassInRangeKg(m, initG, propG))) return converted;
    }
    notes?.push(`${name}: its per-point masses fall outside ${noticeQuantity('mass', low / 1000, units)}–${noticeQuantity('mass', high / 1000, units)}, contradicting its `
      + 'loaded/propellant masses, so burn-off is spread in proportion to impulse instead.');
    return undefined;
  }
  notes?.push(`${name}: its per-point masses start at ${noticeQuantity('mass', masses[0]! / 1000, units)}, which is neither its loaded mass `
    + `(${noticeQuantity('mass', initG / 1000, units, { parenthesized: true })}) nor its propellant (${noticeQuantity('mass', propG / 1000, units, { parenthesized: true })}), so burn-off is spread in proportion to impulse instead.`);
  return undefined;
}

/**
 * RockSim .rse parser (engine-database XML; attrs in mm/g).
 *
 * `notes` collects what the import should TELL the user about a motor it did
 * import — a nozzle exit it read and would not believe, per-point masses it
 * could not use — and each motor it skipped. A motor with no usable masses or
 * no thrust data is skipped and named (audit 2026-09-22), not allowed to sink
 * every other motor in the file; only a file with nothing usable is refused.
 */
export function parseRse(text: string, notes?: string[], units: UnitSelection = INITIAL_UNITS): ExMotor[] {
  // Through the parser seam (xmlParse.ts); same message as before it.
  const doc = parseXml(text, 'Not valid XML (.rse)');
  const engines: XmlElement[] = [];
  const pending = doc.documentElement ? [doc.documentElement] : [];
  while (pending.length) {
    const el = pending.pop()!;
    if (el.tagName === 'engine') {
      engines.push(el);
      if (engines.length > MAX_EX_IMPORT_MOTORS) throw new Error(EX_MOTOR_COUNT_NOTE);
    } else if (el.tagName === 'engine-database' || el.tagName === 'engine-list') {
      const children = Array.from(el.children);
      for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]!);
    }
  }
  if (engines.length === 0) throw new Error('No <engine> entries in .rse file');
  if (engines.length > MAX_EX_IMPORT_MOTORS) throw new Error(EX_MOTOR_COUNT_NOTE);

  const motors: ExMotor[] = [];
  const skipped: string[] = [];
  for (const el of engines) {
    const attr = (n: string) => el.getAttribute(n) ?? '';
    // Every number through parseDecimal, as the .ork and .rkt readers take
    // theirs (audit 2026-09-30). `Number()` read an absent or blank attribute
    // as 0 and `0x10` as 16, where desktop's Double.parseDouble refuses both.
    const numAttr = (n: string, fb = 0) => {
      const v = parseDecimal(el.getAttribute(n));
      return Number.isFinite(v) ? v : fb;
    };
    const name = attr('code') || 'EX motor';
    // OpenRocket throws "Initial mass missing" on this; a file without it would
    // otherwise import as a 0 g motor and fly.
    if (!(numAttr('initWt') > 0)) {
      skipped.push(`Motor ${name}: initial mass (initWt) missing or zero`);
      continue;
    }
    // …and "Propellant mass missing" on this one: a motor with no propellant, or
    // more than it weighs loaded, cannot burn down to a real mass.
    const propellant = el.getAttribute('propWt');
    if (!Number.isFinite(parseDecimal(propellant))) {
      skipped.push(`Motor ${name}: propellant mass (propWt) ${propellant === null ? 'missing' : `"${propellant}" is not a finite number`}`);
      continue;
    }
    const massWrong = massProblem(numAttr('propWt'), numAttr('initWt'), units);
    if (massWrong) {
      skipped.push(`Motor ${name}: ${massWrong}`);
      continue;
    }
    const totalWeightG = numAttr('initWt');
    const propWeightG = Math.min(numAttr('propWt'), totalWeightG);
    // …and "Diameter missing" / "Length missing" on these. A zero is refused
    // too: a 0 mm motor was offered for every mount (diameterClass(0) is 0,
    // and 0 fits any bore), and a 0 mm long one put its CG at its top face.
    const dimension = (['dia', 'len'] as const).find((a) => !(numAttr(a, NaN) > 0));
    if (dimension) {
      skipped.push(`Motor ${name}: ${dimension === 'dia' ? 'diameter' : 'length'} (${dimension}) missing or not a positive number`);
      continue;
    }
    const mfr = attr('mfg') || 'EX';
    if (el.querySelectorAll(':scope > data').length > 1) {
      skipped.push(`Motor ${name}: multiple data elements`);
      continue;
    }
    const data = Array.from(el.querySelectorAll(':scope > data > eng-data'));
    if (data.length > MAX_EX_MOTOR_SAMPLES) { skipped.push(`Motor ${name}: ${EX_SAMPLE_LIMIT_NOTE}`); continue; }
    // Every point's time and thrust, or the motor is skipped with the point
    // named. Desktop refuses the file ("Illegal motor data point encountered");
    // a point read as 0 — `Number(null)` — put a zero-thrust dip in the curve,
    // and one dropped joined its neighbours with a straight line, unsaid.
    const unread = (d: XmlElement, a: 't' | 'f'): string | null => {
      const raw = d.getAttribute(a);
      return Number.isFinite(parseDecimal(raw)) ? null : raw === null ? `no ${a}` : `${a}="${raw.slice(0, 20)}"`;
    };
    const bad = data.findIndex((d) => unread(d, 't') !== null || unread(d, 'f') !== null);
    if (bad >= 0) {
      const why = [unread(data[bad]!, 't'), unread(data[bad]!, 'f')].filter((w) => w !== null).join(', ');
      skipped.push(`Motor ${name}: data point ${bad + 1} of ${data.length} cannot be read (${why})`);
      continue;
    }
    const samples = data.map((d) => ({
      time: parseDecimal(d.getAttribute('t')),
      thrust: parseDecimal(d.getAttribute('f')),
    }));
    if (samples.some(s => s.thrust > MAX_MOTOR_THRUST_N)) {
      skipped.push(`Motor ${name}: a data point exceeds the maximum thrust of 10,000,000 N`);
      continue;
    }
    // Match the RASP refusal before storing an unflyable curve (audit 2026-10-11, S1c-4).
    const negative = samples.findIndex(s => s.time < 0 || s.thrust < 0);
    if (negative >= 0) {
      const point = samples[negative]!;
      skipped.push(`Motor ${name}: data point ${negative + 1} has negative time or thrust (${point.time}, ${point.thrust})`);
      continue;
    }
    if (samples.length < 2) {
      skipped.push(`Motor ${name}: no thrust data`);
      continue;
    }
    if (!hasDistinctThrustPoints(samples)) {
      skipped.push(`Motor ${name}: fewer than two distinct thrust points or no positive thrust; this motor cannot launch a rocket`);
      continue;
    }
    // getAttribute returns null for an ABSENT attribute, and Number(null) is 0
    // — which is finite, so an .rse whose <eng-data> points carry no m at all
    // used to produce an all-zero mass array that was then preferred over the
    // impulse-proportional fallback. The kernel accepts a zero-mass motor
    // without complaint, so the flight simply came out optimistic with nothing
    // said. Absent/blank reads as NaN (parseDecimal), which rseSampleMassesKg
    // never flies.
    const masses = data.map((d) => parseDecimal(d.getAttribute('m')));
    // The nozzle exit, when the file states a believable one. 1,274 of the
    // 1,275 engine records in the local .rse corpus say exitDia="0."; the one
    // that does not is a real 5 mm exit on an 18 mm Klima B2. throatDia is
    // deliberately NOT read: no line of this app or its kernel uses a throat.
    // Absent or blank is NaN, which exitDiameterFromRse reads as no exit.
    const exit = exitDiameterFromRse(parseDecimal(el.getAttribute('exitDia')), numAttr('dia'), units);
    // Said, not just dropped (audit 2026-09-22): the v0.137 notes and the guide
    // promise an out-of-band exit "is ignored with a note", and without one an
    // inches-denominated file lost its exit with nothing to say why.
    if (exit && 'rejected' in exit) {
      notes?.push(`${name}: its nozzle exit, exitDia ${exit.rejected}, was not used.`);
    }
    motors.push({
      motorId: boundedExId(`ex:${slug(`${mfr}-${name}`)}`),
      designation: name,
      realManufacturer: mfr,
      diameter: numAttr('dia'),
      length: numAttr('len'),
      totalWeightG,
      propWeightG,
      delays: attr('delays').split(',').map((s) => s.trim()).filter(Boolean).join(','),
      samples,
      sampleMassesKg: rseSampleMassesKg(
        el, name, masses, totalWeightG, propWeightG, notes, units),
      ...(exit && 'exitDiameterM' in exit ? { exitDiameterM: exit.exitDiameterM } : {}),
      source: 'rse' as const,
      addedAt: Date.now(),
    });
  }
  if (motors.length === 0) throw new Error(skipped.join(' · '));
  if (skipped.length) {
    notes?.push(`skipped ${skipped.length} motor${skipped.length === 1 ? '' : 's'} — ${skipped.join(' · ')}`);
  }
  return motors;
}

/** Parse by extension/content — returns the motors found in the file, and `notes` what to say about them. */
export function parseMotorFile(fileName: string, text: string, notes?: string[], units: UnitSelection = INITIAL_UNITS): ExMotor[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.rse') || text.trimStart().startsWith('<')) return parseRse(text, notes, units);
  return parseEng(text, notes, units);
}
