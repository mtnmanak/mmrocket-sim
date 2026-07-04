import type { MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';
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
  motorLabel: string;
  motor: MotorSpec;
  motorMeta?: MotorMeta;
  mountId: string | null;
  /** Rocket-level max motor length (SI m); null/absent = no limit. */
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
    return s;
  } catch {
    return null;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;

export function saveSessionDebounced(state: Omit<SessionState, 'savedAt'>): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...state, savedAt: Date.now() }));
    } catch {
      // Quota/serialization failures must never break editing.
    }
  }, DEBOUNCE_MS);
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}
