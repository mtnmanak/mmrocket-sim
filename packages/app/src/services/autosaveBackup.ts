import type { MountMotor } from '../App.js';
import { primaryMountOf, motorMounts } from '../tree/treeModel.js';
import { loadExMotors } from './exMotors.js';
import { safeName } from './fileName.js';
import { refToExportMotor } from './motorMatch.js';
import { exportOrk, type OrkExportMotor, type OrkMotorRef } from './orkFile.js';
import { flushSession, heldSession, loadSession, sessionPayload, type SessionState } from './session.js';

/**
 * THE WAY OUT OF A CRASH (audit 2026-09-22).
 *
 * The autosave is the only copy of unsaved work, and when the app throws while
 * rendering there is no Save button left to press: a data-dependent throw with
 * a persisted tab crash-looped every reload, and the only escape anyone had —
 * clearing the site's data — also destroyed the run history and the imported
 * motors. The root error boundary (components/AppBoundary.tsx) offers this
 * download before it offers to start fresh.
 *
 * It builds the .ork from the STORED session (or, while another tab holds the
 * slot, the write this tab is holding back), with none of App's state — App
 * is what just failed. So it repeats, deliberately, the small part of App's
 * `toExportMotor` / `exportConfigs` a file needs to reopen with its motors
 * (designation, manufacturer, type, digest, size, delay, ignition, the weighed
 * pad mass on the primary, and the references a file could not match). What it
 * leaves out: the stored runs' <flightdata> (the runs themselves stay in this
 * browser). If the design cannot be written as an .ork at all — the writer may
 * be what threw — the autosave's own bytes are handed over as JSON instead, so
 * nothing the browser holds is ever withheld.
 */

export interface AutosaveFile {
  /** Suggested file name, extension included. */
  name: string;
  data: string;
  mime: string;
  extension: string;
  description: string;
  /** False when the .ork could not be built and this is the raw autosave. */
  ork: boolean;
}

/** One mounted motor as the .ork writer takes it — App's toExportMotor, minus nothing a reopen needs. */
function motorForOrk(mm: MountMotor): OrkExportMotor {
  const ex = mm.meta?.manufacturer === 'EX';
  // An EX motor's file manufacturer is the one its .eng/.rse named, never the
  // "EX" badge; omitted when unknown, so the designation-only tier matches.
  const exReal = ex
    ? ((mm.meta.exMotorId ? loadExMotors().find((m) => m.motorId === mm.meta.exMotorId) : undefined)
      ?? loadExMotors().find((m) => m.designation === mm.spec.designation))?.realManufacturer
    : undefined;
  const type = mm.meta?.orkType
    ?? (mm.meta?.type === 'SU' ? 'single'
      : mm.meta?.type === 'reload' ? 'reload'
      : mm.meta?.type === 'hybrid' ? 'hybrid'
      : undefined);
  const manufacturer = ex ? (exReal && exReal !== 'EX' ? exReal : undefined)
    : mm.meta?.orkManufacturer ?? mm.meta?.manufacturer;
  return {
    designation: mm.spec.designation,
    ...(manufacturer ? { manufacturer } : {}),
    ...(type ? { type } : {}),
    ...(!ex && mm.meta?.orkDigest ? { digest: mm.meta.orkDigest } : {}),
    diameter: mm.spec.diameter,
    length: mm.spec.length,
    delay: mm.spec.ejectionDelay,
    ignitionEvent: mm.ignition?.event,
    ignitionDelay: mm.ignition?.delay,
    ...(typeof mm.padMassKg === 'number' && mm.padMassKg > 0 ? { padMassKg: mm.padMassKg } : {}),
  };
}

/**
 * One set of motors for the writer: the matched records, the file's own
 * references on mounts that have nothing matched, and the pad mass kept on the
 * primary mount only (the writer takes the first it finds).
 */
function motorSet(
  s: SessionState,
  motors: Record<string, MountMotor> | undefined,
  refs: Record<string, OrkMotorRef> | undefined,
): Record<string, OrkExportMotor> {
  const mountIds = new Set(motorMounts(s.tree).map((m) => m.id));
  const out: Record<string, OrkExportMotor> = {};
  for (const [id, ref] of Object.entries(refs ?? {})) {
    if (mountIds.has(id)) out[id] = refToExportMotor(ref);
  }
  for (const [id, mm] of Object.entries(motors ?? {})) out[id] = motorForOrk(mm);
  const primary = primaryMountOf(s.tree, Object.keys(out));
  for (const [id, m] of Object.entries(out)) {
    if (id !== primary && 'padMassKg' in m) {
      const { padMassKg: _p, ...rest } = m;
      out[id] = rest;
    }
  }
  return out;
}

/** The stored session as an .ork document. Throws whatever the writer throws. */
export function autosaveToOrk(s: SessionState): string {
  const active = s.savedConfigs?.find((c) => c.id === s.activeConfigId);
  return exportOrk({
    name: s.tree.name ?? 'My Rocket',
    tree: s.tree,
    motors: motorSet(s, s.mountMotors, active?.unmatchedRefs),
    launch: s.launch,
    configs: s.savedConfigs?.map((c) => ({
      id: c.id, name: c.name, isDefault: c.isDefault,
      motors: motorSet(s, c.motors, c.unmatchedRefs),
      ...(c.deployments ? { deployments: c.deployments } : {}),
      ...(c.separations ? { separations: c.separations } : {}),
    })),
    activeConfigId: s.activeConfigId ?? null,
    ...(s.measured ? { measured: s.measured } : {}),
  });
}

/**
 * The autosaved design as a file to hand the user: an .ork when it can be
 * written, the raw autosave (.json) when it cannot, null when there is none.
 * Flushes first — the last edit before the crash may still be in the 400 ms
 * debounce.
 */
export function autosavedDesignFile(): AutosaveFile | null {
  flushSession();
  // While another tab holds the slot, this tab's design is the write the
  // conflict is holding back — that is the one to hand over, not the slot's.
  const held = heldSession();
  const raw = held ? JSON.stringify(held) : sessionPayload();
  if (raw === null) return null;
  try {
    const s: SessionState | null = held ? { ...held, savedAt: Date.now() } : loadSession();
    if (s) {
      return {
        name: `${safeName(s.tree.name ?? 'rocket')}-autosave.ork`,
        data: autosaveToOrk(s),
        mime: 'application/octet-stream',
        extension: '.ork',
        description: 'OpenRocket design',
        ork: true,
      };
    }
  } catch {
    // Fall through to the bytes as stored.
  }
  return {
    name: 'rocket-autosave.json',
    data: raw,
    mime: 'application/json',
    extension: '.json',
    description: 'MMRocket Sim autosave',
    ork: false,
  };
}
