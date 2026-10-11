import type { OrkMotorRef } from './orkFile.js';
import {
  bundledSimFiles, fileImpulseNs, flownCurve, fliesTheSame, pickDigestFile, pickSampleFile,
  type TcMotor, type TcSimFile,
} from './thrustcurve.js';

/**
 * The open's sentence when a desktop design's motor `<digest>` chose its
 * thrust curve (thrustcurve.ts pickDigestFile): the file desktop flew, where
 * the app's own pick for the motor is another one that flies differently.
 * Said so the user knows why the motor flies another curve than the same
 * motor picked fresh, and how to get the app's pick back. Silent when the two
 * files fly the same here (an .rse and the RASP file it was made from) or the
 * digest names no bundled file.
 */
export async function digestCurveNote(
  ref: OrkMotorRef, motor: TcMotor,
  files: () => Promise<TcSimFile[]> = () => bundledSimFiles(motor.motorId),
): Promise<string | undefined> {
  if (!ref.digest) return undefined;
  const all = await files().catch(() => []);
  const named = pickDigestFile(all, ref.digest, motor);
  const usual = pickSampleFile(all, motor);
  if (!named || !usual || named === usual || fliesTheSame(named, usual)) return undefined;
  const describe = (f: TcSimFile): string => `${f.source ?? 'unknown source'} ${f.format ?? 'file'}, `
    + `${fileImpulseNs({ samples: flownCurve(f.samples!).samples }).toFixed(1)} N·s`
    + (f.simfileId ? `, https://www.thrustcurve.org/simfiles/${encodeURIComponent(f.simfileId)}/` : '');
  return `Motor “${ref.designation}”: flown with the thrust curve this design was saved with in desktop OR `
    + `(${describe(named)}), not the curve the app picks for the ${motor.manufacturerAbbrev} ${motor.designation} `
    + `(${describe(usual)}). Picking the motor again in “Browse motor database” flies the app’s pick.`;
}
