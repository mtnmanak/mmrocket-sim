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

export interface MotorSearchQuery {
  commonName?: string;
  impulseClass?: string;
  /** mm — filter to what fits the mount. */
  diameter?: number;
  maxResults?: number;
}

interface TcSample {
  time: number;
  thrust: number;
}

export async function searchMotors(query: MotorSearchQuery): Promise<TcMotor[]> {
  const params = new URLSearchParams();
  if (query.commonName) params.set('commonName', query.commonName);
  if (query.impulseClass) params.set('impulseClass', query.impulseClass);
  if (query.diameter) params.set('diameter', String(query.diameter));
  params.set('availability', 'available');
  params.set('maxResults', String(query.maxResults ?? 25));

  const res = await fetch(`${API}/search.json?${params}`);
  if (!res.ok) {
    throw new Error(`thrustcurve.org search failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { results?: TcMotor[] };
  return body.results ?? [];
}

/** Delay options parsed from the motor's delays string ("0,3,5" → [0,3,5]). */
export function delayOptions(motor: TcMotor): number[] {
  if (!motor.delays) return [0];
  const opts = motor.delays
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return opts.length ? opts : [0];
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
    if (cached) samples = JSON.parse(cached) as TcSample[];
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
