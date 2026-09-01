import type { RocketTree } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';
import type { MountMotor, SavedConfig } from '../App.js';
import { shortHash } from './simReport.js';

/**
 * "Has this design changed since it was last written to a file?"
 *
 * Reported 2026-09-01a: opening a design does not offer to save the current
 * one first, and the owner asked "unless I am missing something?". He is not.
 * The session autosave is a SINGLE localStorage slot: opening a file replaces
 * the working state and the next autosave overwrites the only persistent copy
 * of whatever was there. There is no second slot and no history, so unsaved
 * work is genuinely gone. Desktop OpenRocket and RockSim both guard this.
 *
 * The comparison is a fingerprint rather than a deep equality because the
 * thing being compared has to survive a reload: what is stored is a short
 * string in the session, not a whole second copy of the design.
 */

/**
 * Everything that belongs to "the design as the user would save it" — the same
 * tuple the autosave already assembles, so nothing can be in one and not the
 * other. `tree` carries the rocket's name, so a rename counts as a change.
 */
export interface DesignSnapshot {
  tree: RocketTree;
  mountMotors: Record<string, MountMotor>;
  launch: LaunchConditions;
  maxMotorLengthByStage: Record<string, number | null>;
  savedConfigs: SavedConfig[];
  activeConfigId: string | null;
  measured: { massKg: number | null; cgM: number | null };
}

/**
 * JSON with every object's keys in sorted order.
 *
 * Plain `JSON.stringify` preserves INSERTION order, and the two ways a design
 * arrives build their Records in different orders: an import writes
 * `mountMotors` in file order, while editing writes them in click order. The
 * same design would then fingerprint differently depending on how it got here,
 * and the prompt would fire on a file the user had just saved.
 *
 * Infinity is mapped the way the session does it (a plugged motor's
 * `ejectionDelay` is Infinity, which JSON turns into null) so a plugged motor
 * and a genuinely absent delay cannot collide.
 */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && value === Infinity) return '"Infinity"';
    if (typeof value === 'number' && value === -Infinity) return '"-Infinity"';
    // NaN would stringify as null and swallow a real change; name it.
    if (typeof value === 'number' && Number.isNaN(value)) return '"NaN"';
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
}

/** A short, stable mark for a design. Same design in, same string out. */
export function designFingerprint(s: DesignSnapshot): string {
  return shortHash(stable([
    s.tree,
    s.mountMotors,
    s.launch,
    s.maxMotorLengthByStage,
    s.savedConfigs,
    s.activeConfigId,
    s.measured,
  ]));
}

/**
 * Is there work that a file on disk does not have?
 *
 * `savedMark` is the fingerprint as of the last real save (or the last import,
 * which is equally "what is on disk"). A NULL mark counts as DIRTY: a session
 * restored from a build that predates this field cannot prove it was saved,
 * and the safe reading of "I do not know" is to ask rather than to discard.
 * That matches the convention the session file already documents for an absent
 * version string.
 *
 * `flownSinceSave` is separate because flying does not change the design, and
 * the owner explicitly wants it to count: "detect if the user made any changes
 * (including flying a sim)". Both desktop OR and RockSim treat it that way.
 */
export function isDirty(
  current: string, savedMark: string | null | undefined, flownSinceSave: boolean,
): boolean {
  if (flownSinceSave) return true;
  if (savedMark === null || savedMark === undefined || savedMark === '') return true;
  return current !== savedMark;
}
