import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { motorMounts, primaryMountOf } from '../tree/treeModel.js';
import type { ExMotor } from './exMotors.js';
import type { RepairedMotorSpec } from './thrustcurve.js';
import { refToExportMotor } from './motorMatch.js';
import type { OrkExportMotor, OrkMotorRef } from './orkFile.js';

/**
 * A MOUNT'S MOTOR AS THE .ork WRITER TAKES IT — the one copy of the mapping.
 *
 * App's Save (and the .rkt, .CDX1 and share link, which read the same maps)
 * and the crash-recovery download (services/autosaveBackup.ts) both call it.
 * There were two (audit 2026-09-30, item 23): App's render-scope closures,
 * which no test could reach without mounting App, and the crash path's own
 * copy, kept apart because App is what crashed. The copies drifted: the crash
 * path wrote an Auto mount at its provisional delay and left the Auto flags
 * off. Nothing here needs App: no React, no storage — the EX library is
 * handed in.
 */

/**
 * The EX library, asked for only when an EX motor needs it: loadExMotors
 * parses the whole stored library (a tester's runs to 750 KB), and most
 * designs carry no EX motor.
 */
export type ExLibrary = () => readonly Pick<ExMotor, 'motorId' | 'designation' | 'realManufacturer'>[];

/**
 * Each Auto mount's rounded optimum from one complete flight, by configuration
 * id ('' for a design with none active) and mount id — orkFlightData's
 * flownAutoDelays, or the copy of it the session keeps for the crash path.
 */
export type FlownAutoDelays = Readonly<Record<string, Readonly<Record<string, number>>>>;

/**
 * An own entry, read safely: configuration ids are file-sourced free text, so
 * "constructor" must find nothing rather than Object's own.
 */
function own<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The delay `mountId`'s Auto flew in this configuration, when a flight says. */
function flownDelay(flown: FlownAutoDelays | undefined, configKey: string, mountId: string): number | undefined {
  const s = own(own(flown, configKey), mountId);
  return typeof s === 'number' && Number.isFinite(s) && s >= 0 ? s : undefined;
}

/** An EX motor's library id and original manufacturer; omit an unknown manufacturer. */
function exIdentity(mm: MountMotor, exLibrary: ExLibrary): Pick<OrkExportMotor, 'manufacturer' | 'exMotorId'> {
  const lib = exLibrary();
  // The exact library entry (meta.exMotorId, pinned at pick time) wins over
  // the designation-only find: two vendors' same-designation curves coexist
  // (motorId = slug(manufacturer+designation)), and the designation find
  // wrote whichever vendor imported first into the file.
  const entry = (mm.spec as RepairedMotorSpec | undefined)?.exDefinition ?? (
    (mm.meta.exMotorId ? lib.find((m) => m.motorId === mm.meta.exMotorId) : undefined)
    ?? lib.find((m) => m.designation === mm.spec?.designation)
  );
  const raw = entry?.realManufacturer;
  // An .rse with no mfg attribute carries the 'EX' sentinel — a display
  // badge, not a manufacturer. Omit it from the file: no desktop motor is
  // literally named EX (the match would always fail), while omission lets
  // the designation-only description tier still find the motor.
  return { manufacturer: raw && raw !== 'EX' ? raw : undefined,
    exMotorId: mm.meta.exMotorId ?? entry?.motorId ?? 'ex:snapshot' };
}

/**
 * One mounted motor for the writer. `flownS`: the delay its Auto flew, when a
 * flight says. An Auto mount is written at it — what it flies — rather than at
 * its provisional first flight, which a Save used to write and a reopen then
 * flew (seam review of audit 2026-09-22); with no such flight it keeps the
 * provisional delay and the Save says so (orkFile.autoDelaySaveNote).
 *
 * `meta` and `ignition` are read with `?.`: the crash path reads a stored
 * session, which anything can have written.
 */
export function toOrkMotor(mm: MountMotor, flownS: number | undefined, exLibrary: ExLibrary): OrkExportMotor {
  // EX motors: the file gets the REAL manufacturer from the imported
  // .eng/.rse, never the "EX" browser badge (the desktop would hunt for a
  // manufacturer literally named EX and lose the motor), and never a
  // digest — the desktop's digest is over ITS data file, which we lack.
  const ex = mm.meta?.manufacturer === 'EX';
  // <type> per the desktop Motor.Type names: the file's own value verbatim
  // when the motor came from a .ork, else mapped from the thrustcurve
  // catalog type; omitted (never guessed) when neither is known.
  const auto = mm.meta?.autoDelay === true;
  const type = mm.meta?.orkType
    ?? (mm.meta?.type === 'SU' ? 'single'
      : mm.meta?.type === 'reload' ? 'reload'
      : mm.meta?.type === 'hybrid' ? 'hybrid'
      : undefined);
  return {
    designation: mm.spec?.designation ?? mm.label ?? 'Unknown EX motor',
    ...(ex ? { exMotorSpec: mm.spec,
      ...(mm.meta.availableDelays ? { exDelays: mm.meta.availableDelays.map(d => Number.isFinite(d) ? String(d) : 'P').join(',') } : {}),
    } : {}),
    // The file identity wins over the display abbreviation — but the
    // thrustcurve abbrevs (AeroTech/Cesaroni/Estes…) are registered desktop
    // alternate names, so a database-picked motor still matches.
    ...(ex ? exIdentity(mm, exLibrary) : { manufacturer: mm.meta?.orkManufacturer ?? mm.meta?.manufacturer }),
    ...(type ? { type } : {}),
    ...(!ex && mm.meta?.orkDigest ? { digest: mm.meta.orkDigest } : {}),
    diameter: mm.spec?.diameter ?? 0,
    length: mm.spec?.length ?? 0,
    delay: (auto ? flownS : undefined) ?? mm.spec?.ejectionDelay ?? Infinity,
    ...(auto ? { autoDelay: true as const } : {}),
    ...(auto ? { autoDelayFrom: flownS !== undefined ? 'flown' as const : 'provisional' as const } : {}),
    ignitionEvent: mm.ignition?.event,
    ignitionDelay: mm.ignition?.delay,
    // The weighed pad mass rides out with the motor it was weighed with; the
    // writer lifts it to a rocket-level <measuredpadmass configid> and never
    // puts it inside <motor>. The set key is NOT written — it is rebuilt at
    // open from the file's own set.
    ...(typeof mm.padMassKg === 'number' && mm.padMassKg > 0 ? { padMassKg: mm.padMassKg } : {}),
  };
}

/**
 * THE PRIMARY GATE: `padMassKg` deleted from every entry except the primary
 * mount's — in-tree ids only (primaryMountOf), so a record for a mount the
 * tree no longer has can neither win nor lose it. A value orphaned on a
 * record that stopped being primary (a motor loaded on a higher stage) is
 * never applied and must never be written; a configuration whose primary is
 * an unmatched reference writes the reference's value. The writer takes the
 * first value it finds per configuration, so this is what makes it one.
 */
function padMassOnPrimaryOnly(
  motors: Record<string, OrkExportMotor>, tree: RocketTree,
): Record<string, OrkExportMotor> {
  const primary = primaryMountOf(tree, Object.keys(motors));
  const out: Record<string, OrkExportMotor> = {};
  for (const [id, m] of Object.entries(motors)) {
    if (id !== primary && 'padMassKg' in m) {
      const { padMassKg: _p, ...rest } = m;
      out[id] = rest;
    } else {
      out[id] = m;
    }
  }
  return out;
}

export interface OrkMotorSetInput {
  /** The motors loaded, keyed by mount id. */
  records: Readonly<Record<string, MountMotor>>;
  /** The motors the file named that nothing could load, keyed by mount id. */
  refs?: Readonly<Record<string, OrkMotorRef>>;
  tree: RocketTree;
  /** Every configuration's flown Auto delays; this set's are `flown[configKey]`. */
  flown?: FlownAutoDelays;
  /** This set's configuration: its id, or '' for a design with none active. */
  configKey: string;
  exLibrary: ExLibrary;
  /**
   * Which come first in the set, the loaded motors or the references. It
   * decides one thing: which of two mounts in the same stage and rank keeps
   * the weighed pad mass, because primaryMountOf ranks such a tie by the order
   * it is handed. Each caller keeps the order App has always built its set in,
   * so no Save changes (verifier's review of audit 2026-09-30, item 23):
   * - 'records' for the working set, as App.filePrimaryMountId ranks it, so
   *   the value written is the one under the card that shows the field;
   * - 'refs' for a stored configuration, as exportConfigs spread it; a mount
   *   with both writes its loaded motor, in the reference's place.
   * Neither is the file's own order, which importApply attaches a file's pad
   * mass by, so on such a tie either can drop the value the file was opened
   * with: a known limit of both, which this mapping does not change.
   */
  first: 'records' | 'refs';
}

/**
 * One configuration's motors for the writer: its loaded motors, the file's
 * own references on the mounts with nothing loaded, and the weighed pad mass
 * on the primary mount alone.
 */
export function orkMotorSet(input: OrkMotorSetInput): Record<string, OrkExportMotor> {
  const { records, refs, tree, flown, configKey, exLibrary, first } = input;
  const motors: Record<string, OrkExportMotor> = {};
  // Motors the import could not resolve ride back out VERBATIM on any mount
  // that still has nothing on it. Without this the file the user saved came
  // out with that mount empty: opening it again in desktop OpenRocket showed
  // a configuration with no motor, and the original reference — the
  // manufacturer, the diameter and length, and the <digest> that is
  // desktop's silent-match tier — was gone from their only copy. A mount
  // that HAS a matched motor writes that motor: the user's choice wins (with
  // the references first, it replaces its mount's reference, in its place).
  const mountIds = new Set(motorMounts(tree).map((m) => m.id));
  const addRefs = (): void => {
    for (const [id, ref] of Object.entries(refs ?? {})) {
      if (!Object.hasOwn(motors, id) && mountIds.has(id)) motors[id] = refToExportMotor(ref);
    }
  };
  if (first === 'refs') addRefs();
  for (const [id, mm] of Object.entries(records)) {
    motors[id] = toOrkMotor(mm, flownDelay(flown, configKey, id), exLibrary);
  }
  if (first !== 'refs') addRefs();
  return padMassOnPrimaryOnly(motors, tree);
}
