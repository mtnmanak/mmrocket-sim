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
  const batch = new Map<string, ExMotor>();
  const duplicates: string[] = [];
  const sameMotor = (a: ExMotor, b: ExMotor) =>
    JSON.stringify({ ...a, motorId: '', addedAt: 0 }) === JSON.stringify({ ...b, motorId: '', addedAt: 0 });
  for (const m of added) {
    let id: string | null = m.motorId;
    for (let n = 2; id !== null && batch.has(id); n++) {
      id = sameMotor(batch.get(id)!, m) ? null : `${m.motorId}~${n}`;
    }
    if (id === null) continue; // an exact repeat of a motor already in this batch
    if (id !== m.motorId) duplicates.push(m.designation);
    batch.set(id, id === m.motorId ? m : { ...m, motorId: id });
  }
  const library = loadExMotors();
  const replaced = library.filter((m) => batch.has(m.motorId)).map((m) => m.designation);
  const kept = library.filter((m) => !batch.has(m.motorId));
  return { ...persist([...kept, ...batch.values()]), replaced, duplicates };
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
 * Why a motor's loaded/propellant pair cannot describe a real motor, or null
 * when it can (grams). The same test isHeaderMasses applies to a downloaded
 * curve's header, applied per MOTOR at import (audit 2026-09-22): an EX motor
 * with more propellant than loaded mass used to import and then fail at fly
 * time, naming thrustcurve.org for a file off the user's own disk — and a
 * tester's 891-motor rasp.eng carries two (K700RT 901 g of propellant in a
 * 175 g motor; L1000S 1,301 in 1,248).
 */
function massProblem(propG: number, totG: number): string | null {
  if (!(totG > 0)) return `loaded mass ${totG} g is not a mass`;
  if (!(propG > 0)) return `propellant mass ${propG} g is not a mass`;
  if (propG > totG) return `more propellant (${propG} g) than loaded mass (${totG} g)`;
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
export function parseEng(text: string, notes?: string[]): ExMotor[] {
  const motors: ExMotor[] = [];
  const skipped: string[] = [];
  const lines = text.split(/\r?\n/);
  let header: string[] | null = null;
  /** Why the current header's motor is being skipped; its data lines are read past. */
  let refused: string | null = null;
  let samples: { time: number; thrust: number }[] = [];

  const isHeader = (tok: string[]) =>
    tok.length >= 7 && Number.isFinite(Number(tok[1])) && Number.isFinite(Number(tok[2]));

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
    const [name, diaMm, lenMm, delays, propKg, totKg, ...mfr] = h;
    // Trailing zeros after the last burning sample go, bar the first.
    let last = pts.length - 1;
    while (last > 0 && pts[last]!.thrust === 0 && pts[last - 1]!.thrust === 0) last--;
    pts.length = last + 1;
    if (pts[0]!.time > 0) pts.unshift({ time: 0, thrust: 0 });
    const problem = massProblem(Number(propKg) * 1000, Number(totKg) * 1000);
    if (problem) { skipped.push(`${name}: ${problem}`); return; }
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
    if (line === '' || line.startsWith(';')) continue;
    const tok = line.split(/\s+/);
    if (isHeader(tok)) {
      finish();
      header = tok;
      // The two MASS columns get the same test as the two dimension columns.
      // They did not, and `Number('notanum')` is NaN, so a malformed header
      // imported a motor with propWeightG: NaN — which survives all the way to
      // fly time and then fails there saying "thrustcurve.org publishes no
      // loaded/propellant weight for <motor>", naming a service that had
      // nothing to do with a file the user loaded off their own disk.
      // parseRse refuses its equivalent ("initial mass missing or zero").
      if (!Number.isFinite(Number(tok[4])) || !Number.isFinite(Number(tok[5]))) {
        refused = `Propellant and total mass must be numbers in "${line.slice(0, 60)}" — `
          + `read "${tok[4]}" and "${tok[5]}".`;
      }
      continue;
    }
    if (!header) throw new Error(`Not a RASP header line: "${line.slice(0, 60)}"`);
    if (refused) continue; // a skipped motor's data lines are read past to the next header
    const [t, f] = tok.map(Number);
    if (!Number.isFinite(t) || !Number.isFinite(f)) {
      throw new Error(`Bad data line: "${line.slice(0, 60)}"`);
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
    notes?.push(`skipped ${skipped.length} motor${skipped.length === 1 ? '' : 's'} with impossible `
      + `masses — ${skipped.join(' · ')}`);
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
 * and not at all when they start at neither — a file that contradicts itself
 * is named in `notes` and flies the model.
 */
function rseSampleMassesKg(
  el: Element, name: string, masses: number[], initG: number, propG: number, n: number, notes?: string[],
): number[] | undefined {
  const autoCalc = !/^(0|false)$/i.test((el.getAttribute('auto-calc-mass') ?? '').trim());
  if (autoCalc) return undefined;
  if (masses.length !== n || !masses.every((m) => Number.isFinite(m) && m >= 0)) return undefined;
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.01 * b;
  if (near(masses[0]!, propG)) return masses.map((m) => (m + initG - propG) / 1000);
  if (near(masses[0]!, initG) && masses.every((m) => m > 0)) return masses.map((m) => m / 1000);
  notes?.push(`${name}: its per-point masses start at ${masses[0]} g, which is neither its loaded mass `
    + `(${initG} g) nor its propellant (${propG} g), so burn-off is spread in proportion to impulse instead.`);
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
export function parseRse(text: string, notes?: string[]): ExMotor[] {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not valid XML (.rse)');
  const engines = Array.from(doc.querySelectorAll('engine'));
  if (engines.length === 0) throw new Error('No <engine> entries in .rse file');

  const motors: ExMotor[] = [];
  const skipped: string[] = [];
  for (const el of engines) {
    const attr = (n: string) => el.getAttribute(n) ?? '';
    const numAttr = (n: string, fb = 0) => {
      const v = Number(el.getAttribute(n));
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
    const massWrong = massProblem(numAttr('propWt', NaN), numAttr('initWt'));
    if (massWrong) {
      skipped.push(`Motor ${name}: ${massWrong}`);
      continue;
    }
    const mfr = attr('mfg') || 'EX';
    const data = Array.from(el.querySelectorAll('data > eng-data'));
    const samples = data.map((d) => ({
      time: Number(d.getAttribute('t')),
      thrust: Number(d.getAttribute('f')),
    })).filter((s) => Number.isFinite(s.time) && Number.isFinite(s.thrust));
    if (samples.length < 2) {
      skipped.push(`Motor ${name}: no thrust data`);
      continue;
    }
    // getAttribute returns null for an ABSENT attribute, and Number(null) is 0
    // — which is finite, so an .rse whose <eng-data> points carry no m at all
    // used to produce an all-zero mass array that was then preferred over the
    // impulse-proportional fallback. The kernel accepts a zero-mass motor
    // without complaint, so the flight simply came out optimistic with nothing
    // said. Absent/blank reads as NaN, which rseSampleMassesKg never flies.
    const masses = data.map((d) => {
      const raw = d.getAttribute('m');
      return raw === null || raw.trim() === '' ? NaN : Number(raw);
    });
    // The nozzle exit, when the file states a believable one. 1,274 of the
    // 1,275 engine records in the local .rse corpus say exitDia="0."; the one
    // that does not is a real 5 mm exit on an 18 mm Klima B2. throatDia is
    // deliberately NOT read: no line of this app or its kernel uses a throat.
    const exitRaw = el.getAttribute('exitDia');
    const exit = exitDiameterFromRse(
      exitRaw === null || exitRaw.trim() === '' ? null : Number(exitRaw), numAttr('dia'),
    );
    // Said, not just dropped (audit 2026-09-22): the v0.137 notes and the guide
    // promise an out-of-band exit "is ignored with a note", and without one an
    // inches-denominated file lost its exit with nothing to say why.
    if (exit && 'rejected' in exit) {
      notes?.push(`${name}: its nozzle exit, exitDia ${exit.rejected}, was not used.`);
    }
    motors.push({
      motorId: `ex:${slug(`${mfr}-${name}`)}`,
      designation: name,
      realManufacturer: mfr,
      diameter: numAttr('dia'),
      length: numAttr('len'),
      totalWeightG: numAttr('initWt'),
      propWeightG: numAttr('propWt'),
      delays: attr('delays').split(',').map((s) => s.trim()).filter(Boolean).join(','),
      samples,
      sampleMassesKg: rseSampleMassesKg(
        el, name, masses, numAttr('initWt'), numAttr('propWt'), samples.length, notes),
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
export function parseMotorFile(fileName: string, text: string, notes?: string[]): ExMotor[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.rse') || text.trimStart().startsWith('<')) return parseRse(text, notes);
  return parseEng(text, notes);
}
