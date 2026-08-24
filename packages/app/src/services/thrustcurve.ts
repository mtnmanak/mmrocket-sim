import type { MotorSpec } from '@online-openrocket/engine';

/**
 * thrustcurve.org API v1 client (CORS-enabled; verified reflective
 * Access-Control-Allow-Origin). API units: mm, grams — converted to the
 * engine's SI here at the boundary.
 */
const API = 'https://www.thrustcurve.org/api/v1';

export interface TcMotor {
  motorId: string;
  manufacturerAbbrev: string;
  designation: string;
  commonName: string;
  impulseClass: string;
  /** mm */
  diameter: number;
  /** mm */
  length: number;
  avgThrustN: number;
  maxThrustN: number;
  totImpulseNs: number;
  burnTimeS: number;
  totalWeightG: number;
  propWeightG: number;
  /** e.g. "0,3,5" */
  delays?: string;
  availability: string;
  /** Propellant name (e.g. "Classic", "White Lightning"). */
  propInfo?: string;
  /** Reload case (e.g. "Pro29-6GXL"); absent for single-use. */
  caseInfo?: string;
}

export interface TcSample {
  time: number;
  thrust: number;
}

/** One simulator file as thrustcurve.org's download.json returns it. */
export interface TcSimFile {
  format?: string;
  source?: string;
  samples?: TcSample[];
  /** The raw .eng/.rse, base64, as download.json returns it for data:"both". */
  data?: string;
}

/** Loaded and propellant mass as a motor's own data file states them. */
export interface TcHeaderMasses {
  totalWeightG: number;
  propWeightG: number;
}

/**
 * The masses out of the DATA FILE's own header, which is what desktop
 * OpenRocket reads. thrustcurve.org publishes two different claims about the
 * same motor — the catalog metadata and the file the curve came from — and
 * taking the curve from one document while taking the masses from the other is
 * not defensible: on the AeroTech K480W it is 2078/1292 g against the file's
 * 2059/1232 g, and it put a tester's apogee 0.84 % under desktop's on his own
 * design. Returns null when the file is absent or unparseable, and the caller
 * falls back to the catalog rather than refusing the motor.
 */
export function headerMasses(file: TcSimFile): TcHeaderMasses | null {
  if (!file.data) return null;
  let text: string;
  try {
    text = atob(file.data);
  } catch {
    return null;
  }
  // RockSim .rse: grams, as attributes on <engine>.
  const init = /initWt\s*=\s*"([\d.eE+-]+)"/.exec(text);
  const prop = /propWt\s*=\s*"([\d.eE+-]+)"/.exec(text);
  if (init && prop) {
    const t = Number(init[1]);
    const p = Number(prop[1]);
    if (Number.isFinite(t) && Number.isFinite(p) && t > 0 && p > 0 && p <= t) {
      return { totalWeightG: t, propWeightG: p };
    }
  }
  // RASP .eng: the first non-comment, non-blank line is
  //   designation diameter(mm) length(mm) delays propWeight(kg) totalWeight(kg) mfr
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    const f = line.split(/\s+/);
    if (f.length < 7) return null;
    const p = Number(f[4]);
    const t = Number(f[5]);
    if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0 || p <= 0 || p > t) return null;
    return { totalWeightG: t * 1000, propWeightG: p * 1000 };
  }
  return null;
}

/** The kernel's MathUtil.EPSILON — what counts as "the same instant". */
const TIME_EPSILON = 1e-8;

/**
 * How far apart coincident samples are pushed. A microsecond is four orders
 * below the finest real sampling interval on thrustcurve.org (10 ms), so the
 * curve keeps its shape, and the impulse it adds is epsilon x delta-thrust —
 * unmeasurable.
 */
const COINCIDENT_NUDGE = 1e-6;

const sameTime = (a: number, b: number): boolean => Math.abs(a - b) < TIME_EPSILON;

export interface RepairedCurve {
  samples: TcSample[];
  /** Plain-English repairs applied; empty when the curve was already sound. */
  repairs: string[];
  /**
   * Index into the INPUT array for each surviving sample, so a caller holding
   * a parallel array (.rse files carry a measured mass per sample) can realign
   * it without re-deriving anything.
   */
  keptIndices: number[];
}

/**
 * Makes a thrust curve satisfy the kernel's requirement that time points
 * strictly increase, WITHOUT discarding measurements.
 *
 * thrustcurve.org is a volunteer archive of manufacturer-supplied files and a
 * measurable fraction of them are malformed: in a 200-motor sample (2026-08-23)
 * 1.1% carried at least one non-increasing time point, which the carved
 * ThrustCurveMotor.Builder rejects outright ("Two thrust values for single time
 * point"). Cesaroni L1115-P is the reported case — three samples all stamped
 * 0.01 s.
 *
 * Desktop OpenRocket repairs three of these shapes in
 * AbstractMotorLoader.finalizeThrustCurve, and we do the same; but its
 * duplicate rule requires the thrust to match as well, so it does NOT fix
 * L1115-P. The last step here is ours: samples that share an instant but
 * disagree on thrust are separated by a microsecond, keeping every reading and
 * the file's own impulse. Dropping one of them instead would silently change
 * the motor.
 */
export function repairSamples(samples: readonly TcSample[]): RepairedCurve {
  const repairs: string[] = [];
  if (samples.length === 0) return { samples: [], repairs, keptIndices: [] };

  // Carry the source index alongside each point so parallel arrays survive.
  let pts = samples.map((s, i) => ({ ...s, i }));

  // 1. Time order. Nearly always already sorted; a few files are not.
  if (!pts.every((p, i) => i === 0 || p.time >= pts[i - 1]!.time)) {
    pts.sort((a, b) => a.time - b.time);
    repairs.push('put samples back into time order');
  }

  // 2. Genuine duplicates — same instant AND same thrust. Desktop's rule, for
  //    files like the KBA K1750 its own comment names.
  const deduped: typeof pts = [];
  let duplicates = 0;
  for (const p of pts) {
    const last = deduped[deduped.length - 1];
    if (last && sameTime(last.time, p.time) && Math.abs(last.thrust - p.thrust) < TIME_EPSILON) {
      duplicates++;
      continue;
    }
    deduped.push(p);
  }
  if (duplicates > 0) {
    repairs.push(`dropped ${duplicates} duplicate data point${duplicates === 1 ? '' : 's'}`);
  }
  pts = deduped;

  // 3. Two points at t=0, one of them zero thrust — keep the real one.
  if (pts.length > 2 && sameTime(pts[0]!.time, pts[1]!.time)) {
    const zeroFirst = Math.abs(pts[0]!.thrust) < TIME_EPSILON;
    const zeroSecond = Math.abs(pts[1]!.thrust) < TIME_EPSILON;
    if (zeroFirst || zeroSecond) {
      pts.splice(zeroFirst ? 0 : 1, 1);
      repairs.push(`dropped a zero-thrust sample sharing t=${pts[0]!.time} s`);
    }
  }

  // 4. Two FINAL points at the same time, one of them zero — drop the zero.
  const n = pts.length - 1;
  if (pts.length > 2 && sameTime(pts[n - 1]!.time, pts[n]!.time)) {
    const zeroAt = Math.abs(pts[n - 1]!.thrust) < TIME_EPSILON ? n - 1
      : Math.abs(pts[n]!.thrust) < TIME_EPSILON ? n : -1;
    if (zeroAt >= 0) {
      const t = pts[n]!.time;
      pts.splice(zeroAt, 1);
      repairs.push(`dropped a zero-thrust sample sharing the final time t=${t} s`);
    }
  }

  // 5. Whatever coincident points remain disagree on thrust, so neither
  //    reading can be called wrong. Separate them instead of choosing.
  const collisions = new Map<string, number>();
  for (let i = 1; i < pts.length; i++) {
    if (pts[i]!.time > pts[i - 1]!.time) continue;
    const at = pts[i]!.time;
    pts[i] = { ...pts[i]!, time: pts[i - 1]!.time + COINCIDENT_NUDGE };
    const key = String(at);
    collisions.set(key, (collisions.get(key) ?? 0) + 1);
  }
  for (const [at, count] of collisions) {
    repairs.push(
      `separated ${count} sample${count === 1 ? '' : 's'} sharing t=${at} s`,
    );
  }

  return {
    samples: pts.map(({ time, thrust }) => ({ time, thrust })),
    repairs,
    keptIndices: pts.map((p) => p.i),
  };
}

/**
 * Chooses which of thrustcurve.org's simulator files to fly.
 *
 * The app used to take the first RASP file unconditionally. For L1115-P that
 * picked a manufacturer RASP file with three samples stamped 0.01 s over the
 * clean 26-point RockSim file returned in the SAME response — and the damaged
 * file was not merely unusable, its whole early time base was wrong (peak
 * thrust at 0.08 s against 0.18 s in the good file). Desktop OpenRocket does
 * the equivalent when it builds its bundled database: SerializeThrustcurveMotors
 * catches the builder's exception per file and moves on to the next one.
 *
 * Order of preference: a curve whose times already increase, then the richer
 * curve, then RASP — the original tie-break, which still decides between files
 * of equal quality.
 */
export function pickSampleFile(files: readonly TcSimFile[]): TcSimFile | null {
  const usable = files
    .map((file, index) => ({ file, index }))
    .filter(({ file }) => (file.samples?.length ?? 0) >= 2);
  if (usable.length === 0) return null;

  const sound = ({ file }: { file: TcSimFile }): number => {
    const s = file.samples!;
    return s.every((p, i) => i === 0 || p.time > s[i - 1]!.time) ? 1 : 0;
  };

  usable.sort((a, b) =>
    sound(b) - sound(a)
    || b.file.samples!.length - a.file.samples!.length
    || (b.file.format === 'RASP' ? 1 : 0) - (a.file.format === 'RASP' ? 1 : 0)
    || a.index - b.index);

  return usable[0]!.file;
}

/**
 * Delay options parsed from the motor's delays string ("0,3,5" → [0,3,5]).
 * "P" (plugged — no ejection charge) becomes Infinity, always listed last;
 * 623 motors in the bundled DB carry it and it used to be silently dropped
 * (a "P"-only motor even showed a bogus 0 s delay).
 */
export function delayOptions(motor: TcMotor): number[] {
  if (!motor.delays) return [0];
  const opts: number[] = [];
  let plugged = false;
  for (const raw of motor.delays.split(',')) {
    const s = raw.trim().toUpperCase();
    if (s === 'P' || s === 'PLUGGED') { plugged = true; continue; }
    const n = Number(s);
    if (Number.isFinite(n)) opts.push(n);
  }
  if (plugged) opts.push(Infinity);
  return opts.length ? opts : [0];
}

/** Display tag for a delay value: "5" / "P" (plugged). */
export function delayTag(delay: number): string {
  return Number.isFinite(delay) ? String(delay) : 'P';
}

/**
 * Pure transform: thrust samples + catalog metadata → engine MotorSpec.
 * Mass at each sample time interpolates from total weight down to burnout
 * weight proportionally to CUMULATIVE IMPULSE (trapezoidal), matching how
 * OpenRocket treats .eng files. CG is fixed at half the motor length (the
 * same approximation OpenRocket applies to RASP data without CG info).
 */
export type RepairedMotorSpec = MotorSpec & {
  /**
   * Plain-English repairs applied to the published curve before it could be
   * simulated. Present only when the file needed them; the UI shows it so a
   * silent data fix never changes someone's numbers without saying so.
   */
  curveRepairs?: string[];
};

export function samplesToMotorSpec(
  motor: TcMotor,
  samples: TcSample[],
  ejectionDelay: number,
  /** The data file's own masses; they win over the catalog (see headerMasses). */
  fromFile?: TcHeaderMasses | null,
): RepairedMotorSpec {
  // Normalize: repaired (strictly increasing times), starting at t=0.
  if (samples.length === 0) {
    throw new Error(`No thrust samples for ${motor.designation}`);
  }
  const repaired = repairSamples(samples);
  const pts = repaired.samples;
  if (pts[0]!.time > 0) {
    pts.unshift({ time: 0, thrust: 0 });
  }

  // thrustcurve.org's catalog is not uniformly populated: 146 of the 1129
  // bundled entries publish no loaded weight and 14 no propellant weight, and
  // one (Cesaroni 25E75-17A) lists more propellant than loaded mass. Without
  // this guard those became NaN / negative masses that went straight into the
  // kernel, where TeaVM threw a raw "cannot be converted to a BigInt" and the
  // whole design blanked. Refuse with something a rocketeer can act on — never
  // substitute a made-up mass, which would trade a visible error for silently
  // wrong altitudes.
  if (!Number.isFinite(motor.totalWeightG) || !Number.isFinite(motor.propWeightG)) {
    throw new Error(
      `thrustcurve.org publishes no loaded/propellant weight for ${motor.designation}, ` +
        'so it cannot be simulated. Pick another motor, or import its .rse/.eng file.',
    );
  }
  if (motor.propWeightG > motor.totalWeightG) {
    throw new Error(
      `${motor.designation} is catalogued with more propellant (${motor.propWeightG} g) than ` +
        `loaded mass (${motor.totalWeightG} g), so its burn would end at a negative mass. ` +
        'Pick another motor, or import a corrected .rse/.eng file.',
    );
  }

  const totalMass = (fromFile?.totalWeightG ?? motor.totalWeightG) / 1000;
  const propMass = (fromFile?.propWeightG ?? motor.propWeightG) / 1000;

  // Cumulative impulse via trapezoid rule.
  const cumImpulse: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i]!.time - pts[i - 1]!.time;
    const area = (dt * (pts[i]!.thrust + pts[i - 1]!.thrust)) / 2;
    cumImpulse.push(cumImpulse[i - 1]! + area);
  }
  const totImpulse = cumImpulse[cumImpulse.length - 1]!;

  const times = pts.map((p) => p.time);
  const thrusts = pts.map((p) => p.thrust);
  const masses = cumImpulse.map((impulse) =>
    totImpulse > 0 ? totalMass - propMass * (impulse / totImpulse) : totalMass,
  );

  return {
    designation: motor.designation,
    diameter: motor.diameter / 1000,
    length: motor.length / 1000,
    times,
    thrusts,
    masses,
    cgX: motor.length / 2000,
    ejectionDelay,
    ...(repaired.repairs.length ? { curveRepairs: repaired.repairs } : {}),
  };
}

/**
 * v2: the v1 cache stored raw API samples, including the damaged curves that
 * used to crash the build. Bumping the prefix retires those entries rather
 * than leaving a poisoned cache no code path ever invalidates.
 */
const CACHE_PREFIX = 'tc:samples:v3:';

/**
 * Fetches thrust samples (localStorage-cached) and builds the MotorSpec.
 * Imported EX motors ("ex:" ids) build entirely from local data — .rse files
 * carry measured per-sample masses, which beat the impulse-proportional
 * approximation.
 */
export async function fetchMotorSpec(
  motor: TcMotor,
  ejectionDelay: number,
): Promise<RepairedMotorSpec> {
  if (motor.motorId.startsWith('ex:')) {
    const { getExMotor } = await import('./exMotors.js');
    const ex = getExMotor(motor.motorId);
    if (!ex) throw new Error(`Imported motor ${motor.designation} is no longer stored`);
    if (ex.sampleMassesKg && ex.sampleMassesKg.length === ex.samples.length) {
      // An imported .eng/.rse can carry the same damage as a downloaded curve,
      // and this branch never reaches samplesToMotorSpec. keptIndices realigns
      // the measured masses onto the repaired curve.
      const repaired = repairSamples(ex.samples);
      const samples = [...repaired.samples];
      const masses = repaired.keptIndices.map((i) => ex.sampleMassesKg![i]!);
      if (samples[0]!.time > 0) {
        samples.unshift({ time: 0, thrust: 0 });
        masses.unshift(ex.totalWeightG / 1000);
      }
      return {
        designation: ex.designation,
        diameter: ex.diameter / 1000,
        length: ex.length / 1000,
        times: samples.map((s) => s.time),
        thrusts: samples.map((s) => s.thrust),
        masses,
        cgX: ex.length / 2000,
        ejectionDelay,
        ...(repaired.repairs.length ? { curveRepairs: repaired.repairs } : {}),
      };
    }
    return samplesToMotorSpec(motor, ex.samples, ejectionDelay);
  }

  const cacheKey = CACHE_PREFIX + motor.motorId;
  let samples: TcSample[] | null = null;
  let fromFile: TcHeaderMasses | null = null;

  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as unknown;
      // Validate the shape — a corrupt entry parses fine but would break
      // samplesToMotorSpec forever (the cache is never invalidated otherwise).
      const entry = parsed as { samples?: unknown; masses?: TcHeaderMasses | null };
      const arr = entry?.samples;
      if (Array.isArray(arr) && arr.length > 0
          && arr.every((s) => typeof (s as TcSample)?.time === 'number'
            && typeof (s as TcSample)?.thrust === 'number')) {
        samples = arr as TcSample[];
        fromFile = entry.masses ?? null;
      } else {
        localStorage.removeItem(cacheKey);
      }
    }
  } catch {
    // storage unavailable (private mode etc.) — just fetch
  }

  if (!samples) {
    const res = await fetch(`${API}/download.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // "both" carries the raw .eng/.rse alongside the samples, so the masses
      // can come from the same document as the curve (see headerMasses).
      body: JSON.stringify({ motorIds: [motor.motorId], data: 'both' }),
    });
    if (!res.ok) {
      throw new Error(`thrustcurve.org download failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { results?: TcSimFile[] };
    const file = pickSampleFile(body.results ?? []);
    if (!file?.samples) {
      throw new Error(`No sample data available for ${motor.designation}`);
    }
    samples = file.samples;
    fromFile = headerMasses(file);
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ samples, masses: fromFile }));
    } catch {
      // cache is best-effort
    }
  }

  return samplesToMotorSpec(motor, samples, ejectionDelay, fromFile);
}
