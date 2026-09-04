import type { IgnitionEvent, MotorSpec } from '@online-openrocket/engine';
import type { MountMotor } from '../App.js';
import { builtInMeta } from '../components/MotorPicker.js';
import { BUILT_IN_MOTORS } from '../motors.js';
import {
  displayDesignation, findDbMotor, isHighPower, type MotorDbEntry,
} from './motorDb.js';
import type { OrkExportMotor, OrkMotorRef } from './orkFile.js';
import type { MotorMeta } from './simReport.js';
import { delayOptions, fetchMotorSpec } from './thrustcurve.js';

/**
 * Resolving ONE motor reference out of a design file to something the kernel
 * can fly. Lifted out of App.tsx because it decides WHICH MOTOR a file flies —
 * the numbers on screen and in the .ork written back out — and inside a
 * component closure it could not be reached by a test at all.
 *
 * The precedence used to be built-ins first, matched on
 * `key.startsWith(ref.designation)` alone. That is a prefix test over three
 * hand-written 18 mm Estes approximations, so `'C6-5'.startsWith('C6')` fired
 * on essentially every Estes-class file and returned before the shipped
 * 1,129-motor database was ever consulted. Measured against the built-ins'
 * own curves (trapezoidal integral) and the shipped catalog:
 *
 *   - Apogee C6 (13 mm, 9.98 Ns) flew the 18 mm built-in at 10.40 Ns, and was
 *     re-exported at 18 mm / 70 mm because the writer takes the substituted
 *     spec's dimensions.
 *   - Estes C6 (8.82 Ns) flew at 10.40 Ns — 18 % high on total impulse.
 *   - Estes A8 (2.50 Ns) flew the built-in A8-3 at 1.89 Ns — 24 % LOW.
 *
 * The database carries the manufacturer's published curve, so it goes first.
 * The built-ins stay as the OFFLINE fallback (they are the only motors that
 * need no network), and are now gated on the file's own diameter and
 * manufacturer so they can only stand in for what they actually approximate.
 */

/** Diameter agreement required of a built-in, in mm — the tolerance findDbMotor uses. */
export const BUILT_IN_DIAMETER_TOLERANCE_MM = 1.5;

/**
 * A designation with any trailing delay suffix removed: "C6-5" → "c6",
 * "H220-P" → "h220", "I224-15A" → "i224-15a" (a delay with a propellant letter
 * is NOT a bare delay and is left alone — the built-ins have no such keys, so
 * leaving it simply means no built-in matches, which is the safe direction).
 */
export function baseDesignation(designation: string): string {
  return designation.trim().replace(/-(\d+(?:\.\d+)?|P)$/i, '').toLowerCase();
}

/**
 * May a built-in stand in for a motor this file attributes to `manufacturer`?
 *
 * The built-ins' own docblock calls them "approximate Estes-class thrust
 * curves" and every one of them is 18 mm black powder, so an Apogee or Klima
 * C6 is a different motor, not a different label for the same one. Absent and
 * sentinel manufacturers ('unknown' from our reader, 'custom' from our old
 * writer) are permitted: the file said nothing, so nothing is contradicted.
 */
export function builtInAllowedFor(manufacturer: string | undefined): boolean {
  const m = (manufacturer ?? '').trim().toLowerCase();
  if (m === '' || m === 'unknown' || m === 'custom') return true;
  return m.replace(/[^a-z0-9]/g, '').startsWith('estes');
}

/**
 * The built-in that really is this reference's motor, or null.
 *
 * Three gates, all of which the old prefix test skipped: the designation must
 * match to the BASE (so "C6" and "C6-7" match 'C6-5', but "C60" does not), the
 * file's diameter must agree within {@link BUILT_IN_DIAMETER_TOLERANCE_MM},
 * and the manufacturer must not name someone else. A .ork with no <diameter>
 * arrives as the reader's 0.018 m default, which passes — that is the Estes
 * case the built-ins exist for.
 */
export function builtInMatch(
  ref: Pick<OrkMotorRef, 'designation' | 'diameter' | 'manufacturer'>,
  builtIns: Record<string, MotorSpec> = BUILT_IN_MOTORS,
): { key: string; spec: MotorSpec } | null {
  const want = baseDesignation(ref.designation);
  if (!want) return null;
  if (!builtInAllowedFor(ref.manufacturer)) return null;
  for (const [key, spec] of Object.entries(builtIns)) {
    if (baseDesignation(key) !== want) continue;
    if (ref.diameter > 0
      && Math.abs(ref.diameter * 1000 - spec.diameter * 1000) > BUILT_IN_DIAMETER_TOLERANCE_MM) {
      continue;
    }
    return { key, spec };
  }
  return null;
}

/**
 * The file's own motor identity, carried on the meta so a later Save writes it
 * back verbatim and the desktop's matcher resolves it silently (digest tier).
 * 'unknown' is our reader's fallback and 'custom' our old writer's — both are
 * sentinels, not manufacturers, and must not be re-exported.
 */
export function fileMotorIdentity(ref: OrkMotorRef): Partial<MotorMeta> {
  return {
    ...(ref.manufacturer && ref.manufacturer !== 'unknown' && ref.manufacturer !== 'custom'
      ? { orkManufacturer: ref.manufacturer } : {}),
    ...(ref.motorType ? { orkType: ref.motorType } : {}),
    ...(ref.digest ? { orkDigest: ref.digest } : {}),
  };
}

/**
 * A motor reference nothing matched, in the shape the .ork writer takes.
 *
 * Written back VERBATIM. Before this the reference was reduced to its
 * designation string at import and the rest — manufacturer, diameter, length,
 * delay, ignition and the `<digest>` that is desktop's silent-match tier —
 * was dropped, so pressing Save .ork emitted that configuration with no motor
 * on the mount at all and the user's only copy of the reference was gone.
 */
export function refToExportMotor(ref: OrkMotorRef): OrkExportMotor {
  return {
    designation: ref.designation,
    ...(ref.manufacturer && ref.manufacturer !== 'unknown' && ref.manufacturer !== 'custom'
      ? { manufacturer: ref.manufacturer } : {}),
    ...(ref.motorType ? { type: ref.motorType } : {}),
    ...(ref.digest ? { digest: ref.digest } : {}),
    diameter: ref.diameter,
    length: ref.length,
    delay: ref.delay,
    ...(ref.ignitionEvent ? { ignitionEvent: ref.ignitionEvent } : {}),
    ...(ref.ignitionDelay !== undefined ? { ignitionDelay: ref.ignitionDelay } : {}),
  };
}

/** The result of resolving one file reference. */
export interface MotorMatchResult {
  motor?: MountMotor;
  /** What happened, for the import note. */
  note: string;
  /**
   * True when `motor` is a built-in APPROXIMATION standing in for a database
   * motor whose published curve could not be fetched. The caller surfaces this
   * one even though a motor was loaded: substituting a hand-written curve for
   * the manufacturer's is a numbers change, and silence about it is the defect
   * this whole module exists to close.
   */
  approximated?: boolean;
}

/** Injection points, so the network and the catalog can be stubbed in tests. */
export interface MotorMatchDeps {
  findDb?: typeof findDbMotor;
  fetchSpec?: (motor: MotorDbEntry, ejectionDelay: number) => Promise<MotorSpec>;
  builtIns?: Record<string, MotorSpec>;
}

/**
 * Matches ONE imported motor reference: the shipped motor database first
 * (published curves, manufacturer-aware), then the built-in approximations as
 * the offline fallback. Returns the loaded motor (absent when nothing matched)
 * and the note describing what happened; the caller decides whether the note
 * surfaces (applied config) or waits (presets).
 */
export async function matchImportedMotor(
  ref: OrkMotorRef,
  deps: MotorMatchDeps = {},
): Promise<MotorMatchResult> {
  const findDb = deps.findDb ?? findDbMotor;
  const fetchSpec = deps.fetchSpec ?? fetchMotorSpec;
  const builtIns = deps.builtIns ?? BUILT_IN_MOTORS;

  const ignition: MountMotor['ignition'] = {
    event: (ref.ignitionEvent as IgnitionEvent | undefined) ?? 'automatic',
    delay: ref.ignitionDelay ?? 0,
  };
  const fileIdentity = fileMotorIdentity(ref);

  // RockSim refs carry no motor diameter (0) — match by designation only.
  const dbMatch = findDb(
    ref.designation,
    ref.diameter > 0 ? ref.diameter * 1000 : undefined,
    undefined,
    ref.manufacturer,
  );
  if (dbMatch) {
    try {
      const spec = await fetchSpec(dbMatch, ref.delay);
      // Plugged motors (Infinity delay) display the standard "-P" suffix.
      const delayTag = Number.isFinite(ref.delay) ? String(ref.delay) : 'P';
      const label = `${dbMatch.commonName}-${delayTag}`;
      return {
        motor: {
          label,
          spec,
          meta: {
            label,
            manufacturer: dbMatch.manufacturerAbbrev,
            availableDelays: delayOptions(dbMatch),
            type: dbMatch.type,
            propellant: dbMatch.propInfo,
            motorCase: dbMatch.caseInfo,
            highPower: isHighPower(dbMatch),
            ...fileIdentity,
          },
          ignition,
        },
        note: `Motor: ${dbMatch.manufacturerAbbrev} ${displayDesignation(dbMatch.designation, dbMatch.manufacturerAbbrev)}-${delayTag} (loaded from the motor database).`,
      };
    } catch {
      // Fall through to the built-in, which needs no network — see below.
    }
  }

  const builtIn = builtInMatch(ref, builtIns);
  if (builtIn) {
    // Keep the FILE's ejection delay — the built-in key's own delay
    // (e.g. C6-5 matching a saved C6-7) would silently change the flight.
    // Infinity is a VALID file delay (plugged, .ork "none") — only fall
    // back to the built-in's delay when the file carried none.
    const fileDelay = ref.delay === Infinity ? Infinity
      : Number.isFinite(ref.delay) ? ref.delay : builtIn.spec.ejectionDelay;
    const label = labelWithDelay(builtIn.key, fileDelay);
    return {
      motor: {
        label,
        spec: { ...builtIn.spec, ejectionDelay: fileDelay },
        meta: { ...builtInMeta(builtIn.key), ...fileIdentity },
        ignition,
      },
      note: dbMatch
        ? `Motor “${ref.designation}”: its published thrust curve couldn't be downloaded, so`
          + ` the built-in ${label} approximation is loaded instead — its total impulse differs`
          + ' from the real motor. Reconnect and re-open the file, or pick it via Browse motor'
          + ' database.'
        : `Motor: ${label} (matched built-in).`,
      ...(dbMatch ? { approximated: true } : {}),
    };
  }

  if (dbMatch) {
    return { note: `Motor “${ref.designation}” is in the motor database but its thrust curve couldn't be downloaded — pick it via Browse motor database.` };
  }
  return { note: `Motor “${ref.designation}” isn't in the motor database — pick one via Browse motor database.` };
}

/**
 * Rewrites a motor label's delay suffix ("H220-14" / "H220-P").
 * Local copy of App's `labelWithDelay` minus its "(auto delay)" branch, which
 * an imported reference can never carry — auto delay is a UI choice, not a
 * file field.
 */
function labelWithDelay(label: string, delay: number): string {
  const base = label.replace(/-(\d+(\.\d+)?|P)$/, '');
  return `${base}-${Number.isFinite(delay) ? delay : 'P'}`;
}
