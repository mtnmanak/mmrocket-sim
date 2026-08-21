import type { MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';
import type { MountMotor } from '../App.js';
import type { MotorMeta } from './simReport.js';

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
  /** Per-STAGE max motor length keyed by stage node id (SI m); null/absent = no limit. */
  maxMotorLengthByStage?: Record<string, number | null>;
  /** Legacy universal max motor length (pre-v0.015) — migrated onto every stage on load. */
  maxMotorLengthM?: number | null;
  launch: LaunchConditions;
  /** Last-save timestamp (ms epoch) — shown on restore. */
  savedAt: number;
}

export function loadSession(): SessionState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SessionState;
    if (!s || typeof s !== 'object' || !s.tree || !Array.isArray(s.tree.components)) return null;
    // Revive plugged ejection delays (persisted as "Infinity" — JSON has no
    // Infinity literal; a plain stringify would have stored null).
    for (const mm of Object.values(s.mountMotors ?? {})) {
      const d = mm?.spec?.ejectionDelay as unknown;
      if (d === 'Infinity' || d === null) mm.spec.ejectionDelay = Infinity;
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
      localStorage.setItem(KEY, JSON.stringify({ ...state, savedAt: Date.now() }, (_k, v) =>
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
