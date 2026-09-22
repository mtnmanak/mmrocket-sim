import type { MotorDbEntry } from './motorDb.js';
import { clearCurveCache } from './thrustcurve.js';

/**
 * User-imported (EX / experimental) motors from RASP .eng or RockSim .rse
 * files. Imported motors persist in localStorage and appear in the motor
 * browser under manufacturer "EX" (the original manufacturer string is kept
 * and shown in the designation tooltip). Thrust curves live locally — no
 * network involved.
 */

const KEY = 'online-openrocket.ex-motors.v1';

export interface ExMotor {
  /** "ex:" + slug — namespaced so the loader knows curves are local. */
  motorId: string;
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
  /** Optional per-sample motor mass (kg) — .rse files carry it. */
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
  source: 'eng' | 'rse';
  addedAt: number;
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
  exitDiaMm: number | null, caseDiaMm: number,
): { exitDiameterM: number } | { rejected: string } | null {
  if (exitDiaMm === null || !Number.isFinite(exitDiaMm) || exitDiaMm <= 0) return null;
  if (!Number.isFinite(caseDiaMm) || caseDiaMm <= 0) return null;
  const f = exitDiaMm / caseDiaMm;
  if (f < EXIT_MIN_FRACTION_OF_CASE) {
    return { rejected: `${exitDiaMm} (only ${(f * 100).toFixed(0)}% of the ${caseDiaMm} mm case, which is too small to be an exit plane — if the file means inches, type the value yourself in your own units)` };
  }
  if (f > EXIT_MAX_FRACTION_OF_CASE) {
    return { rejected: `${exitDiaMm} (${(f * 100).toFixed(0)}% of the ${caseDiaMm} mm case — larger than any nozzle in the database, so it reads like a case diameter rather than an exit)` };
  }
  return { exitDiameterM: exitDiaMm / 1000 };
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

export function loadExMotors(): ExMotor[] {
  if (unstored) return unstored;
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as ExMotor[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** A library write: the list as it now stands, and whether it reached storage. */
export interface ExLibraryWrite {
  motors: ExMotor[];
  stored: boolean;
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
function persist(motors: ExMotor[]): ExLibraryWrite {
  const json = JSON.stringify(motors);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      localStorage.setItem(KEY, json);
      unstored = null;
      return { motors, stored: true };
    } catch {
      if (attempt === 0) clearCurveCache();
    }
  }
  unstored = motors;
  return { motors, stored: false };
}

export function addExMotors(added: ExMotor[]): ExLibraryWrite {
  const existing = loadExMotors().filter(
    (m) => !added.some((a) => a.motorId === m.motorId));
  return persist([...existing, ...added]);
}

export function deleteExMotor(motorId: string): ExMotor[] {
  return persist(loadExMotors().filter((m) => m.motorId !== motorId)).motors;
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

/** Shape an EX motor as a browser/database row (manufacturer shows as EX). */
export function exToDbEntry(m: ExMotor): MotorDbEntry {
  const { impulse, maxThrust, burnTime } = totals(m.samples);
  return {
    motorId: m.motorId,
    manufacturerAbbrev: 'EX',
    designation: m.designation,
    commonName: m.designation,
    impulseClass: impulseClassOf(impulse),
    diameter: m.diameter,
    length: m.length,
    avgThrustN: burnTime > 0 ? impulse / burnTime : 0,
    maxThrustN: maxThrust,
    totImpulseNs: impulse,
    burnTimeS: burnTime,
    totalWeightG: m.totalWeightG,
    propWeightG: m.propWeightG,
    delays: m.delays || undefined,
    availability: 'regular',
    type: 'SU',
  };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * RASP .eng parser. Format: ';' comment lines; a header line
 *   name diameter(mm) length(mm) delays(dash-sep|P) propMass(kg) totalMass(kg) mfr
 * followed by "time thrust" pairs, ending when thrust returns to 0.
 * Files may contain several motors back to back.
 */
export function parseEng(text: string): ExMotor[] {
  const motors: ExMotor[] = [];
  const lines = text.split(/\r?\n/);
  let header: string[] | null = null;
  let samples: { time: number; thrust: number }[] = [];

  const finish = () => {
    if (!header || samples.length === 0) { header = null; samples = []; return; }
    const [name, diaMm, lenMm, delays, propKg, totKg, ...mfr] = header;
    if (samples[0]!.time > 0) samples.unshift({ time: 0, thrust: 0 });
    motors.push({
      motorId: `ex:${slug(`${mfr.join(' ') || 'ex'}-${name}`)}`,
      designation: name!,
      realManufacturer: mfr.join(' ') || 'EX',
      diameter: Number(diaMm),
      length: Number(lenMm),
      totalWeightG: Number(totKg) * 1000,
      propWeightG: Number(propKg) * 1000,
      // 'P' in the RASP delay field means PLUGGED — no ejection charge at all
      // — and it must survive into the delays string. Emptying it here (what
      // this line used to do) made exToDbEntry emit `delays: undefined`, and
      // thrustcurve's delayOptions opens with `if (!motor.delays) return [0]`:
      // a plugged EX motor offered exactly one option, 0 s, MotorBrowser
      // defaulted to it, and the kernel fired an ejection charge at burnout on
      // a motor that has none — a deployment at peak velocity on a flight the
      // real motor cannot produce. delayOptions already maps 'P'/'PLUGGED' to
      // Infinity (the app's plugged representation, round-tripped through
      // simStore as the string "Infinity"), so passing the token straight
      // through is the whole fix. A mixed field ('5-10-P') always worked; only
      // the pure-'P' case — the normal one for high-power EX motors — did not.
      delays: (delays ?? '').split('-').filter((s) => s !== '').join(','),
      samples,
      source: 'eng',
      addedAt: Date.now(),
    });
    header = null;
    samples = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith(';')) continue;
    if (!header) {
      const tok = line.split(/\s+/);
      if (tok.length < 7 || !Number.isFinite(Number(tok[1])) || !Number.isFinite(Number(tok[2]))) {
        throw new Error(`Not a RASP header line: "${line.slice(0, 60)}"`);
      }
      // The two MASS columns get the same test as the two dimension columns.
      // They did not, and `Number('notanum')` is NaN, so a malformed header
      // imported a motor with propWeightG: NaN — which survives all the way to
      // fly time and then fails there saying "thrustcurve.org publishes no
      // loaded/propellant weight for <motor>", naming a service that had
      // nothing to do with a file the user loaded off their own disk.
      // parseRse already refuses its equivalent ("initial mass missing or
      // zero"); this is the same refusal, at the same point.
      if (!Number.isFinite(Number(tok[4])) || !Number.isFinite(Number(tok[5]))) {
        throw new Error(
          `Propellant and total mass must be numbers in "${line.slice(0, 60)}" — `
          + `read "${tok[4]}" and "${tok[5]}".`);
      }
      header = tok;
      continue;
    }
    const [t, f] = line.split(/\s+/).map(Number);
    if (!Number.isFinite(t) || !Number.isFinite(f)) {
      throw new Error(`Bad data line: "${line.slice(0, 60)}"`);
    }
    samples.push({ time: t!, thrust: f! });
    if (f === 0 && t! > 0) finish(); // motor block complete
  }
  finish(); // file may omit the trailing zero-thrust point
  if (motors.length === 0) throw new Error('No motors found in .eng file');
  return motors;
}

/** RockSim .rse parser (engine-database XML; attrs in mm/g). */
export function parseRse(text: string): ExMotor[] {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not valid XML (.rse)');
  const engines = Array.from(doc.querySelectorAll('engine'));
  if (engines.length === 0) throw new Error('No <engine> entries in .rse file');

  return engines.map((el) => {
    const attr = (n: string) => el.getAttribute(n) ?? '';
    const numAttr = (n: string, fb = 0) => {
      const v = Number(el.getAttribute(n));
      return Number.isFinite(v) ? v : fb;
    };
    const name = attr('code') || 'EX motor';
    // OpenRocket throws "Initial mass missing" on this; a file without it would
    // otherwise import as a 0 g motor and fly.
    if (!(numAttr('initWt') > 0)) {
      throw new Error(`Motor ${attr('code') || 'EX motor'}: initial mass (initWt) missing or zero`);
    }
    const mfr = attr('mfg') || 'EX';
    const data = Array.from(el.querySelectorAll('data > eng-data'));
    const samples = data.map((d) => ({
      time: Number(d.getAttribute('t')),
      thrust: Number(d.getAttribute('f')),
    })).filter((s) => Number.isFinite(s.time) && Number.isFinite(s.thrust));
    if (samples.length < 2) throw new Error(`Motor ${name}: no thrust data`);
    // getAttribute returns null for an ABSENT attribute, and Number(null) is 0
    // — which is finite, so an .rse whose <eng-data> points carry no m at all
    // used to produce an all-zero mass array that was then preferred over the
    // impulse-proportional fallback. The kernel accepts a zero-mass motor
    // without complaint, so the flight simply came out optimistic with nothing
    // said. Treat absent/blank as NaN and require a positive mass throughout,
    // the way OpenRocket's own RockSimMotorLoader does (it sets
    // calculateMass=true and rebuilds the curve from initWt/propWt).
    const masses = data.map((d) => {
      const raw = d.getAttribute('m');
      return raw === null || raw.trim() === '' ? NaN : Number(raw);
    });
    const haveMasses = masses.length === samples.length
      && masses.every((m) => Number.isFinite(m) && m > 0);
    // The nozzle exit, when the file states a believable one. 1,274 of the
    // 1,275 engine records in the local .rse corpus say exitDia="0."; the one
    // that does not is a real 5 mm exit on an 18 mm Klima B2. throatDia is
    // deliberately NOT read: no line of this app or its kernel uses a throat.
    const exitRaw = el.getAttribute('exitDia');
    const exit = exitDiameterFromRse(
      exitRaw === null || exitRaw.trim() === '' ? null : Number(exitRaw), numAttr('dia'),
    );
    return {
      motorId: `ex:${slug(`${mfr}-${name}`)}`,
      designation: name,
      realManufacturer: mfr,
      diameter: numAttr('dia'),
      length: numAttr('len'),
      totalWeightG: numAttr('initWt'),
      propWeightG: numAttr('propWt'),
      delays: attr('delays').split(',').map((s) => s.trim()).filter(Boolean).join(','),
      samples,
      sampleMassesKg: haveMasses ? masses.map((m) => m / 1000) : undefined,
      ...(exit && 'exitDiameterM' in exit ? { exitDiameterM: exit.exitDiameterM } : {}),
      source: 'rse' as const,
      addedAt: Date.now(),
    };
  });
}

/** Parse by extension/content — returns the motors found in the file. */
export function parseMotorFile(fileName: string, text: string): ExMotor[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.rse') || text.trimStart().startsWith('<')) return parseRse(text);
  return parseEng(text);
}
