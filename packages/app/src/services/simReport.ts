import type { FlightResult, MotorSpec, StaticInfo } from '@online-openrocket/engine';
import { G0 } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';

/**
 * Post-simulation report: every attribute the owner's flight-day workflow needs,
 * derived from the engine's summary/events/series (all SI). One SimRun is
 * one row in the stored-simulations table and one line in the CSV export.
 */

/** App-side metadata about the loaded motor (engine's MotorSpec has no mfr). */
export interface MotorMeta {
  label: string;
  manufacturer?: string;
  /** Delays the motor is actually sold/drilled with (s). */
  availableDelays?: number[];
  /** User asked for the auto-computed optimal delay. */
  autoDelay?: boolean;
}

/** Safety thresholds (SI). Sources: common HPR/NAR guidance, RockSim's checks. */
export const SAFETY = {
  /** Minimum speed leaving the launch guide (m/s) — ~50 ft/s guidance. */
  minRodExitVelocity: 15,
  /** Minimum thrust:weight at rod departure. */
  minThrustToWeight: 5,
  /** Deployment faster than this risks a zippered tube / torn chute (m/s). */
  maxDeploymentVelocity: 15,
  /** Static margin sanity band (calibers). */
  minStaticMargin: 1.0,
  maxStaticMargin: 3.0,
} as const;

export interface SimRun {
  id: string;
  /** epoch ms */
  when: number;
  rocket: string;
  motor: string;
  manufacturer: string;
  motorDiameterMm: number;
  /** Ejection delay the sim flew with (s). */
  delayS: number;

  // Results (SI)
  maxAltitude: number;
  maxVelocity: number;
  maxMach: number;
  maxAcceleration: number;
  timeToApogee: number;
  timeToBurnout: number | null;
  timeToRodDeparture: number | null;
  rodExitVelocity: number | null;
  thrustToWeightAtRod: number | null;
  launchMass: number | null;
  launchCG: number | null;
  launchCP: number | null;
  launchStaticMarginCal: number | null;
  altitudeAtDeployment: number | null;
  velocityAtDeployment: number | null;
  groundHitVelocity: number;
  totalFlightTime: number;
  optimumDelayS: number | null;
  /** Optimum rounded to the nearest whole second (drill-to-fit rule). */
  recommendedDelayS: number | null;

  // Safety verdicts
  safeLiftoffSpeed: boolean | null;
  safeThrustToWeight: boolean | null;
  safeDeployment: boolean | null;
  staticMarginOk: boolean | null;
  weathercockRisk: 'low' | 'moderate' | 'high' | null;

  windAvg: number;
  execMs: number;
  comments: string;
}

/** Linear interpolation of a series value at time t. */
function at(times: number[], values: number[], t: number): number | null {
  if (times.length === 0 || values.length !== times.length) return null;
  if (t <= times[0]!) return values[0]!;
  for (let i = 1; i < times.length; i++) {
    if (times[i]! >= t) {
      const t0 = times[i - 1]!;
      const t1 = times[i]!;
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      const v0 = values[i - 1]!;
      const v1 = values[i]!;
      if (v0 === null || v1 === null) return null;
      return v0 + f * (v1 - v0);
    }
  }
  return values[values.length - 1]!;
}

function eventTime(result: FlightResult, type: string): number | null {
  const ev = result.events.find((e) => e.type === type);
  return ev ? ev.time : null;
}

/**
 * Recommended delay = the optimum rounded to the nearest WHOLE second.
 * Real-world rule (the owner's): whatever the manufacturer prescribes, flyers
 * drill the delay to the whole second they want — so an optimal 12.7 s
 * recommends 13 s even if the prescribed list is 0/6/8/10/14. The
 * prescribed list stays informational only.
 */
export function recommendDelay(optimum: number | null): number | null {
  if (optimum === null || !Number.isFinite(optimum)) return null;
  return Math.max(0, Math.round(optimum));
}

export function buildSimRun(input: {
  result: FlightResult;
  info: StaticInfo;
  motor: MotorSpec;
  meta?: MotorMeta;
  launch: LaunchConditions;
  rocketName: string;
  execMs: number;
}): SimRun {
  const { result, info, motor, meta, launch, rocketName, execMs } = input;
  const { summary, series } = result;

  const tRod = eventTime(result, 'LAUNCHROD');
  const tBurnout = eventTime(result, 'BURNOUT');
  const tDeploy = eventTime(result, 'RECOVERY_DEVICE_DEPLOYMENT');

  const rodExitVelocity = summary.launchRodVelocity
    ?? (tRod !== null ? at(series.time, series.velocity, tRod) : null);
  const thrustAtRod = tRod !== null ? at(series.time, series.thrust, tRod) : null;
  const massAtRod = tRod !== null ? at(series.time, series.mass, tRod) : null;
  const thrustToWeightAtRod = thrustAtRod !== null && massAtRod !== null && massAtRod > 0
    ? thrustAtRod / (massAtRod * G0)
    : null;

  // CP (and stability) can be null for the first samples (undefined at zero
  // airspeed) — take the first finite sample, else the static-analysis value.
  const firstFinite = (arr: number[]): number | null => {
    for (const v of arr) if (v !== null && Number.isFinite(v)) return v;
    return null;
  };
  const launchMass = series.mass[0] ?? null;
  const launchCG = firstFinite(series.cgLocation) ?? info.cg ?? null;
  const launchCP = firstFinite(series.cpLocation) ?? info.cp ?? null;
  const launchStaticMarginCal = firstFinite(series.stability) ?? info.stabilityCalibers ?? null;

  const altitudeAtDeployment = tDeploy !== null ? at(series.time, series.altitude, tDeploy) : null;
  const velocityAtDeployment = summary.deploymentVelocity
    ?? (tDeploy !== null ? at(series.time, series.velocity, tDeploy) : null);

  const optimumDelayS = summary.optimumDelay ?? null;
  const recommendedDelayS = recommendDelay(optimumDelayS);

  const safeLiftoffSpeed = rodExitVelocity !== null
    ? rodExitVelocity >= SAFETY.minRodExitVelocity : null;
  const safeThrustToWeight = thrustToWeightAtRod !== null
    ? thrustToWeightAtRod >= SAFETY.minThrustToWeight : null;
  const safeDeployment = velocityAtDeployment !== null
    ? Math.abs(velocityAtDeployment) <= SAFETY.maxDeploymentVelocity : null;
  const staticMarginOk = launchStaticMarginCal !== null
    ? launchStaticMarginCal >= SAFETY.minStaticMargin
      && launchStaticMarginCal <= SAFETY.maxStaticMargin
    : null;

  // Weathercocking: how much the wind can rotate the velocity vector while
  // the rocket is slow. Ratio of wind speed to rod-exit speed is the standard
  // rule-of-thumb proxy.
  const weathercockRisk = rodExitVelocity === null || rodExitVelocity <= 0
    ? null
    : launch.windAverage / rodExitVelocity < 0.1 ? 'low'
    : launch.windAverage / rodExitVelocity < 0.25 ? 'moderate'
    : 'high';

  const comments: string[] = [...info.warningTexts];
  if (safeLiftoffSpeed === false) {
    comments.push(`Rod-exit speed ${rodExitVelocity!.toFixed(1)} m/s < ${SAFETY.minRodExitVelocity} m/s guidance.`);
  }
  if (safeThrustToWeight === false) {
    comments.push(`Thrust:weight ${thrustToWeightAtRod!.toFixed(1)}:1 at rod exit < ${SAFETY.minThrustToWeight}:1.`);
  }
  if (safeDeployment === false) {
    comments.push(`Deployment at ${Math.abs(velocityAtDeployment!).toFixed(1)} m/s — expect hard opening (>${SAFETY.maxDeploymentVelocity} m/s).`);
  }
  if (staticMarginOk === false && launchStaticMarginCal !== null) {
    comments.push(launchStaticMarginCal < SAFETY.minStaticMargin
      ? `Static margin ${launchStaticMarginCal.toFixed(2)} cal — under-stable.`
      : `Static margin ${launchStaticMarginCal.toFixed(2)} cal — over-stable (weathercocks readily).`);
  }
  if (optimumDelayS !== null && Number.isFinite(optimumDelayS)
      && Math.abs(motor.ejectionDelay - optimumDelayS) > 1.5) {
    comments.push(`Flown delay ${motor.ejectionDelay}s vs optimal ${optimumDelayS.toFixed(1)}s.`);
  }

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    when: Date.now(),
    rocket: rocketName,
    motor: motor.designation,
    manufacturer: meta?.manufacturer ?? '',
    motorDiameterMm: Math.round(motor.diameter * 1000 * 10) / 10,
    delayS: motor.ejectionDelay,
    maxAltitude: summary.maxAltitude,
    maxVelocity: summary.maxVelocity,
    maxMach: summary.maxMachNumber,
    maxAcceleration: summary.maxAcceleration,
    timeToApogee: summary.timeToApogee,
    timeToBurnout: tBurnout,
    timeToRodDeparture: tRod,
    rodExitVelocity,
    thrustToWeightAtRod,
    launchMass,
    launchCG,
    launchCP,
    launchStaticMarginCal,
    altitudeAtDeployment,
    velocityAtDeployment,
    groundHitVelocity: summary.groundHitVelocity,
    totalFlightTime: summary.flightTime,
    optimumDelayS,
    recommendedDelayS,
    safeLiftoffSpeed,
    safeThrustToWeight,
    safeDeployment,
    staticMarginOk,
    weathercockRisk,
    windAvg: launch.windAverage,
    execMs,
    comments: comments.join(' | '),
  };
}
