import type { MountMotor } from '../model/design.js';
import { loadExMotors } from './exMotors.js';
import { safeName } from './fileName.js';
import { orkMotorSet, type OrkMotorSetInput } from './orkExportMotors.js';
import { exportOrk, type OrkExportMotor, type OrkMotorRef } from './orkFile.js';
import { flushSession, heldSession, peekSession, sessionPayload, type SessionState } from './session.js';

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
 * is what just failed. Its motors go through the mapping App's Save uses
 * (services/orkExportMotors.ts), which imports nothing of App's: it kept a
 * copy of its own until audit 2026-09-30 (item 23), and the copy drifted.
 * What it leaves out: the stored runs' <flightdata> (the runs themselves stay
 * in this browser). If the design cannot be written as an .ork at all — the
 * writer may be what threw — the autosave's own bytes are handed over as JSON
 * instead, so nothing the browser holds is ever withheld.
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

/**
 * One configuration's motors for the writer (orkExportMotors.orkMotorSet): the
 * matched records, the file's own references on mounts that have nothing
 * matched, and the pad mass kept on the primary mount only. Each Auto mount
 * goes out at the delay it flew — what a Save writes — from the copy App keeps
 * with the autosave (SessionState.flownAutoDelays), since the runs that say
 * are judged against a build this path does not have; with none it keeps its
 * provisional delay. `first` is the order a Save builds the same set in, which
 * decides a same-stage tie for the pad mass: the working set's loaded motors
 * first, a stored configuration's references first.
 */
function motorSet(
  s: SessionState,
  configKey: string,
  motors: Record<string, MountMotor> | undefined,
  refs: Record<string, OrkMotorRef> | undefined,
  first: OrkMotorSetInput['first'],
): Record<string, OrkExportMotor> {
  return orkMotorSet({
    records: motors ?? {}, refs, tree: s.tree, flown: s.flownAutoDelays, configKey, exLibrary: loadExMotors, first,
  });
}

/** The stored session as an .ork document. Throws whatever the writer throws. */
export function autosaveToOrk(s: SessionState): string {
  const active = s.savedConfigs?.find((c) => c.id === s.activeConfigId);
  return exportOrk({
    name: s.tree.name ?? 'My Rocket',
    tree: s.tree,
    // The working set's references are the SESSION's own, as a reload reads
    // them (configSync.restoreUnmatchedRefs), and the active configuration's
    // only for a session written before it kept them (seam review of audit
    // 2026-09-22): a design with no configurations keeps them nowhere else,
    // and its recovery file lost the motor. A matched record still wins its
    // mount (orkMotorSet).
    motors: motorSet(s, s.activeConfigId ?? '', s.mountMotors, s.unmatchedRefs ?? active?.unmatchedRefs, 'records'),
    launch: s.launch,
    configs: s.savedConfigs?.map((c) => ({
      id: c.id, name: c.name, isDefault: c.isDefault,
      motors: motorSet(s, c.id, c.motors, c.unmatchedRefs, 'refs'),
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
    // peek, not load: reading the slot for the user must not make another
    // tab's write this tab's own, which "Start fresh" would then delete.
    const s: SessionState | null = held ? { ...held, savedAt: Date.now() } : peekSession();
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
