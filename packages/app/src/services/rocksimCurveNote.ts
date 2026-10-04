import type { MotorSpec } from '@online-openrocket/engine';
import type { OrkMotorRef } from './orkFile.js';
import { bundledSimFiles, fileImpulseNs, flownCurve, type TcMotor, type TcSimFile } from './thrustcurve.js';

/** Inform, never infer a motor revision or replace a curve from a stored flight.
 * 15% is the existing picker's burn-duration agreement band. A candidate must
 * fit the stored duration within 5% (at least 0.1 s for event sampling). These
 * are disclosure thresholds, not certification or flight-validation tolerances.
 */
export async function rocksimCurveNote(
  ref: OrkMotorRef, motor: TcMotor, spec: MotorSpec,
  files: () => Promise<TcSimFile[]> = () => bundledSimFiles(motor.motorId),
): Promise<string | undefined> {
  const stored = ref.rktBurnTimeS;
  const duration = spec.times.at(-1);
  if (ref.matchContext?.source !== 'rocksim' || stored == null || !Number.isFinite(stored) || stored <= 0
    || duration == null || !Number.isFinite(duration) || duration <= 0
    || Math.abs(duration - stored) <= 0.15 * stored) return undefined;
  // A diagnostic must not turn a successfully loaded cached/network motor into
  // a missing motor if the optional bundle cannot be read.
  const candidates = (await files().catch(() => [])).filter(f => {
    if (!f.simfileId || !f.samples?.length) return false;
    const end = flownCurve(f.samples).samples.at(-1)?.time;
    return end != null && Math.abs(end - duration) > 0.15 * stored
      && Math.abs(end - stored) <= Math.max(0.1, 0.05 * stored);
  }).sort((a, b) => a.simfileId!.localeCompare(b.simfileId!));
  if (!candidates.length) return undefined;
  const impulse = spec.times.reduce((sum, t, i) => i === 0 ? sum
    : sum + (t - spec.times[i - 1]!) * (spec.thrusts[i]! + spec.thrusts[i - 1]!) / 2, 0);
  const describe = (f: TcSimFile): string => `${f.source ?? 'unknown source'} ${f.format ?? 'file'} `
    + `(${fileImpulseNs({ samples: flownCurve(f.samples!).samples }).toFixed(1)} N·s, ${flownCurve(f.samples!).samples.at(-1)!.time.toFixed(2)} s to curve end): `
    + `https://www.thrustcurve.org/simfiles/${encodeURIComponent(f.simfileId!)}/`;
  return `Motor “${ref.designation}”: this RockSim record stores ${stored.toFixed(2)} s from ignition to burnout; `
    + `the ${motor.manufacturerAbbrev} ${motor.designation} curve loaded at import ends at ${duration.toFixed(2)} s `
    + `(${impulse.toFixed(1)} N·s). A different published curve may explain part of a flight-result difference. `
    + `Published alternatives with similar duration: ${candidates.map(describe).join('; ')}. `
    + 'Duration alone does not identify the curve or motor revision. Check which motor you own; to use its file, '
    + 'download it and choose “Import .eng/.rse” in “Browse motor database”, then select the imported motor under EX.';
}
