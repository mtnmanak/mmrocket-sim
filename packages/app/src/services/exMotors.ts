import type { MotorDbEntry } from './motorDb.js';

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
  /** "0,3,5" | "" */
  delays: string;
  samples: { time: number; thrust: number }[];
  /** Optional per-sample motor mass (kg) — .rse files carry it. */
  sampleMassesKg?: number[];
  source: 'eng' | 'rse';
  addedAt: number;
}

export function loadExMotors(): ExMotor[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as ExMotor[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function persist(motors: ExMotor[]): ExMotor[] {
  try { localStorage.setItem(KEY, JSON.stringify(motors)); } catch { /* quota */ }
  return motors;
}

export function addExMotors(added: ExMotor[]): ExMotor[] {
  const existing = loadExMotors().filter(
    (m) => !added.some((a) => a.motorId === m.motorId));
  return persist([...existing, ...added]);
}

export function deleteExMotor(motorId: string): ExMotor[] {
  return persist(loadExMotors().filter((m) => m.motorId !== motorId));
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
      delays: delays === 'P' ? '' : (delays ?? '').split('-').filter((s) => s !== '').join(','),
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
