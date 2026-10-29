import { noteField } from './noteField.js';
import type { OrkMotorRef } from './orkFile.js';
import {
  bundledSimFiles, fileImpulseNs, flownCurve, fliesTheSame, pickDigestFile, pickSampleFile,
  type TcMotor, type TcSimFile,
} from './thrustcurve.js';

/** Desktop's digest: the MD5 of the file it loaded, lowercase hex (scripts/motor-digest.mjs md5Hex). */
const DESKTOP_DIGEST = /^[0-9a-f]{32}$/;

/** A data file as the open's sentences name it: source, format, impulse as flown, thrustcurve.org page. */
const describe = (f: TcSimFile): string => `${f.source ?? 'unknown source'} ${f.format ?? 'file'}, `
  + `${fileImpulseNs({ samples: flownCurve(f.samples!).samples }).toFixed(1)} N·s`
  + (f.simfileId ? `, https://www.thrustcurve.org/simfiles/${encodeURIComponent(f.simfileId)}/` : '');

/**
 * The open's sentence on a desktop design's motor `<digest>`, which names the
 * thrust-curve data file desktop loaded (thrustcurve.ts pickDigestFile).
 * - The digest names a bundled file that flies differently from the app's own
 *   pick: the design flies the named file, said so the user knows why the
 *   motor flies another curve than the same motor picked fresh, and how to get
 *   the app's pick back.
 * - The digest names none of the motor's bundled files: the design flies the
 *   app's pick (fetchMotorSpec falls through to it), said so rather than
 *   falling back silently. Only the fact, never a reason: the app stores the
 *   digest alone, not the curve behind it.
 * Silent when the two files fly the same here (an .rse and the RASP file it
 * was made from), when the motor has no bundled file to fly, and on a digest
 * desktop does not write (32 lowercase hex, its MD5) — a test fixture's or
 * another program's label, not a file desktop loaded.
 */
export async function digestCurveNote(
  ref: OrkMotorRef, motor: TcMotor,
  files: () => Promise<TcSimFile[]> = () => bundledSimFiles(motor.motorId),
): Promise<string | undefined> {
  if (!ref.digest) return undefined;
  const all = await files().catch(() => []);
  const named = pickDigestFile(all, ref.digest, motor);
  const usual = pickSampleFile(all, motor);
  if (!named && usual && DESKTOP_DIGEST.test(ref.digest)) {
    return `Motor “${noteField(ref.designation)}”: the thrust curve this design was saved with in desktop OR is not among `
      + `the app’s bundled curves for the ${motor.manufacturerAbbrev} ${motor.designation}, so it flies the app’s pick `
      + `(${describe(usual)}).`;
  }
  if (!named || !usual || named === usual || fliesTheSame(named, usual)) return undefined;
  return `Motor “${noteField(ref.designation)}”: flown with the thrust curve this design was saved with in desktop OR `
    + `(${describe(named)}), not the curve the app picks for the ${motor.manufacturerAbbrev} ${motor.designation} `
    + `(${describe(usual)}). Picking the motor again in “Browse motor database” flies the app’s pick.`;
}
