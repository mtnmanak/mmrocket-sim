import type { MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';
import type { MountMotor, SavedConfig } from '../App.js';
import type { MotorMeta } from './simReport.js';
import { APP_VERSION } from '../version.js';

/**
 * Session autosave: the whole working state (design tree, selected motor,
 * mount, launch conditions) persists to localStorage so closing the tab or a
 * browser crash never loses work. Restored on startup; "New" overwrites it
 * (that's the user's explicit intent, and it warns first).
 */

const KEY = 'online-openrocket.session.v1';
const DEBOUNCE_MS = 400;

export interface SessionState {
  tree: RocketTree;
  /** Per-mount motors (v0.009+). */
  mountMotors?: Record<string, MountMotor>;
  /** Legacy single-motor fields (pre-v0.009 sessions) — migrated on load. */
  motorLabel?: string;
  motor?: MotorSpec;
  motorMeta?: MotorMeta;
  mountId?: string | null;
  /** The file's flight configurations as ready-to-apply presets (Stage B, v0.050+). */
  savedConfigs?: SavedConfig[];
  /** Which preset the working motor set came from; null/absent = custom/none. */
  activeConfigId?: string | null;
  /** Per-STAGE max motor length keyed by stage node id (SI m); null/absent = no limit. */
  maxMotorLengthByStage?: Record<string, number | null>;
  /** Legacy universal max motor length (pre-v0.015) — migrated onto every stage on load. */
  maxMotorLengthM?: number | null;
  launch: LaunchConditions;
  /**
   * What the user weighed and balanced (SI, airframe only — motor out), for
   * the Design tab's "Measured mass & CG" box (v0.061). Kept here rather than
   * in the .ork so the file format is untouched; the ballast it produces IS in
   * the file, as an ordinary mass component.
   */
  measured?: { massKg: number | null; cgM: number | null };
  /**
   * APP_VERSION of the build that wrote this session (v0.063+). What is stored
   * here is the PARSED design, not the .ork bytes, so a fix to the importer
   * never reaches a design that is already open: it is re-read from
   * localStorage, not re-imported. A tester hit exactly that — his build read
   * the stage override his file states, and he still saw the pre-fix numbers,
   * 8.9 % heavy with the CG 31 mm aft, because his autosave predated the fix.
   * Absent on sessions written before stamping existed, which is itself the
   * signal that they are old.
   */
  appVersion?: string;
  /** Last-save timestamp (ms epoch) — shown on restore. */
  savedAt: number;
}

/**
 * Was this session written by some build other than the running one? If so the
 * design in it was parsed by a different importer, and any import fix since
 * then has not been applied to it. The cure is to re-open the original file;
 * the caller says so rather than silently trusting the stored tree.
 */
export function sessionPredatesThisBuild(s: SessionState): boolean {
  return s.appVersion !== APP_VERSION;
}

export function loadSession(): SessionState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SessionState;
    if (!s || typeof s !== 'object' || !s.tree || !Array.isArray(s.tree.components)) {
      // Unusable payload: drop it rather than re-parsing the same wreck on
      // every load, and so a corrupted autosave cannot follow the user around.
      clearSession();
      return null;
    }
    // Revive plugged ejection delays (persisted as "Infinity" — JSON has no
    // Infinity literal; a plain stringify would have stored null). The
    // Stage B config presets carry the same MountMotor shape.
    const motorSets = [
      s.mountMotors ?? {},
      ...(s.savedConfigs ?? []).map((c) => c.motors ?? {}),
    ];
    for (const set of motorSets) {
      for (const mm of Object.values(set)) {
        const d = mm?.spec?.ejectionDelay as unknown;
        if (d === 'Infinity' || d === null) mm.spec.ejectionDelay = Infinity;
      }
    }
    return s;
  } catch {
    return null;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

// Autosave health. Saves happen inside a debounced timeout — no caller sees a
// return value — so unlike simStore's after-each-mutation getter, the UI needs
// a push. The debounce fires ~2.5x/s while editing; listeners hear only the
// TRANSITION between working and failing, not every refused write.
let saveFailing = false;
const saveListeners = new Set<(failing: boolean) => void>();

/** True while autosave is failing — edits will NOT survive a reload. */
export function sessionSaveFailing(): boolean {
  return saveFailing;
}

/** Notified on each working<->failing transition. Returns an unsubscribe. */
export function onSessionSaveStateChange(fn: (failing: boolean) => void): () => void {
  saveListeners.add(fn);
  return () => { saveListeners.delete(fn); };
}

function setSaveFailing(failing: boolean): void {
  if (failing === saveFailing) return; // dedupe: signal the edge, not the level
  saveFailing = failing;
  for (const fn of saveListeners) fn(failing);
}

export function saveSessionDebounced(state: Omit<SessionState, 'savedAt'>): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      // Plugged motors carry ejectionDelay = Infinity; JSON.stringify would
      // silently turn that into null, so round-trip it as a string.
      localStorage.setItem(KEY, JSON.stringify(
        { ...state, appVersion: APP_VERSION, savedAt: Date.now() }, (_k, v) =>
        typeof v === 'number' && v === Infinity ? 'Infinity' : v));
      setSaveFailing(false);
    } catch {
      // Quota/serialization failures must never break editing — but "your
      // work saves itself" failing silently forever was the defect: flag it.
      setSaveFailing(true);
    }
  }, DEBOUNCE_MS);
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}
