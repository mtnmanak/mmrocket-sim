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

interface TcSample {
  time: number;
  thrust: number;
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
export function samplesToMotorSpec(
  motor: TcMotor,
  samples: TcSample[],
  ejectionDelay: number,
): MotorSpec {
  // Normalize: sorted, starting at t=0.
  const pts = [...samples].sort((a, b) => a.time - b.time);
  if (pts.length === 0) {
    throw new Error(`No thrust samples for ${motor.designation}`);
  }
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

  const totalMass = motor.totalWeightG / 1000;
  const propMass = motor.propWeightG / 1000;

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
  };
}

const CACHE_PREFIX = 'tc:samples:';

/**
 * Fetches thrust samples (localStorage-cached) and builds the MotorSpec.
 * Imported EX motors ("ex:" ids) build entirely from local data — .rse files
 * carry measured per-sample masses, which beat the impulse-proportional
 * approximation.
 */
export async function fetchMotorSpec(motor: TcMotor, ejectionDelay: number): Promise<MotorSpec> {
  if (motor.motorId.startsWith('ex:')) {
    const { getExMotor } = await import('./exMotors.js');
    const ex = getExMotor(motor.motorId);
    if (!ex) throw new Error(`Imported motor ${motor.designation} is no longer stored`);
    if (ex.sampleMassesKg && ex.sampleMassesKg.length === ex.samples.length) {
      const samples = [...ex.samples];
      const masses = [...ex.sampleMassesKg];
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
      };
    }
    return samplesToMotorSpec(motor, ex.samples, ejectionDelay);
  }

  const cacheKey = CACHE_PREFIX + motor.motorId;
  let samples: TcSample[] | null = null;

  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as unknown;
      // Validate the shape — a corrupt entry parses fine but would break
      // samplesToMotorSpec forever (the cache is never invalidated otherwise).
      if (Array.isArray(parsed) && parsed.length > 0
          && parsed.every((s) => typeof (s as TcSample)?.time === 'number'
            && typeof (s as TcSample)?.thrust === 'number')) {
        samples = parsed as TcSample[];
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
      body: JSON.stringify({ motorIds: [motor.motorId], data: 'samples' }),
    });
    if (!res.ok) {
      throw new Error(`thrustcurve.org download failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { results?: { format: string; samples?: TcSample[] }[] };
    const files = body.results ?? [];
    // Prefer RASP data, fall back to any file with samples.
    const file = files.find((f) => f.format === 'RASP' && f.samples?.length)
      ?? files.find((f) => f.samples?.length);
    if (!file?.samples) {
      throw new Error(`No sample data available for ${motor.designation}`);
    }
    samples = file.samples;
    try {
      localStorage.setItem(cacheKey, JSON.stringify(samples));
    } catch {
      // cache is best-effort
    }
  }

  return samplesToMotorSpec(motor, samples, ejectionDelay);
}
