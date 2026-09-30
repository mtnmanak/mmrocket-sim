import type { MotorDbEntry } from './motorDb.js';

/** File evidence, never populated from the motor the matcher happens to pick. */
export interface MotorMatchContext {
  source: 'rocksim' | 'ork' | 'rasaero';
  /** Explicit mount bore in mm, NOT the diameter of the installed motor. */
  mountBoreMm?: number;
  /** From the designation itself, never a format's default ejection setting. */
  explicitDelay?: number | 'plugged';
  physical?: {
    provenance: 'rocksim-single-stage-single-motor-known-dry-mass';
    loadedMassG: number;
    dryMassG: number;
    motorMassG: number;
    /** TimeToBurnout minus this sole motor's launch-relative IgnitionDelay. */
    burnTimeS: number;
  };
}

/** Reviewed historical identities (CODEX-GO, 2026-09-30).
 * Sources: shipped motors.json rows by ID below; RockSim 11 Data/Animal.rse
 * K700BB entries (1483.1 g Blue Baboon, 2088 g Black Bear), Cesaroni.rse
 * E31WT (26-E31-WT-15A), G69CL (132.997 Ns; replaced by G46-Classic).
 * These are collisions/typos in historical files, NOT global propellant aliases.
 */
export const MOTOR_MATCH_POLICY = {
  estesG80: '5f4294d200023100000003e8',
  aeroTechG80: '5f4294d20002310000000068',
  blackBearK700: '5f4294d2000231000000026f',
  blueBaboonK700: '5f4294d20002310000000159',
  whiteThunderE31: '5f4294d200023100000003cf',
  skidmarkG69: '5f4294d20002310000000063',
} as const;

/** 2% mass allows catalogue rounding; the two K700 masses differ by 40.8%.
 * 5% burn allows event-sampling/end-point versus catalogue burn-time rounding
 * (E31 0.87125 vs 0.85 s; K700 2.38 vs 2.37 s). Neither alone proves identity.
 * These are narrow identity corroboration limits, not flight-validation limits.
 */
export function physicalEvidenceFits(context: MotorMatchContext | undefined, m: MotorDbEntry): boolean {
  const p = context?.physical;
  return context?.source === 'rocksim'
    && p?.provenance === 'rocksim-single-stage-single-motor-known-dry-mass'
    && [p.loadedMassG, p.dryMassG, p.motorMassG, p.burnTimeS, m.totalWeightG, m.burnTimeS].every(v => Number.isFinite(v) && v > 0)
    && Math.abs(p.loadedMassG - p.dryMassG - p.motorMassG) < 1e-6
    && Math.abs(p.motorMassG - m.totalWeightG) <= 0.02 * m.totalWeightG
    && Math.abs(p.burnTimeS - m.burnTimeS) <= 0.05 * m.burnTimeS;
}

export const E31_CONFLICT = "The file names a White (WH) E31; Cesaroni's only 26 N·s E31 is White Thunder. The file does not supply qualifying motor mass and burn-time evidence, so no motor was loaded; check the propellant and designation.";
export const E31_CORROBORATED = "The file names a White (WH) E31; Cesaroni's only 26 N·s E31 is White Thunder, and the file's stored motor mass and burn time fit it, so the app loaded it — check the propellant.";
export const G80_EQUIVALENT = "No maker named; Estes' G80 has no published thrust curve, so the app loaded AeroTech's G80T, which has the same impulse and burn time.";
export const isE31Conflict = (designation: string): boolean => /^26[- _]*e31[- _]+wh[- _]+15a$/i.test(designation.trim());

/** Check the reviewed pair still agrees after a live catalogue overlay. */
export function equivalentG80(from: MotorDbEntry, to: MotorDbEntry): boolean {
  return from.motorId === MOTOR_MATCH_POLICY.estesG80 && to.motorId === MOTOR_MATCH_POLICY.aeroTechG80
    && from.designation === 'G80' && to.designation === 'G80T'
    && from.manufacturerAbbrev === 'Estes' && to.manufacturerAbbrev === 'AeroTech'
    && ['totImpulseNs', 'burnTimeS', 'avgThrustN', 'maxThrustN'].every(key => {
      const k = key as 'totImpulseNs' | 'burnTimeS' | 'avgThrustN' | 'maxThrustN';
      return Number.isFinite(from[k]) && from[k] > 0 && Math.abs(from[k] - to[k]) < 1e-9;
    });
}
