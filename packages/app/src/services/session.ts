import type { MotorSpec, RocketTree } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';
import type { MountMotor, SavedConfig } from '../App.js';
import type { MotorMeta } from './simReport.js';
import { APP_VERSION } from '../version.js';
import { MIN_IMPORTED_TIME_STEP_S } from './orkFile.js';

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
   * Set by loadSession when it raised a pre-v0.071 session's inherited time
   * step to the default. Transient — never written back — so the app can say
   * once why the number changed.
   */
  timeStepWasClamped?: boolean;
  /**
   * The step the clamp above replaced. Transient like the flag, and for the
   * same reason: the clamp overwrites `launch.timeStepS` in place, so by the
   * time the notice renders this is the only copy of the number left anywhere
   * — panel, session and autosave all hold the default within ~400 ms. A
   * notice that offers the old step back has to be able to name it.
   */
  timeStepClampedFromS?: number;
  /**
   * What the user weighed and balanced (SI, airframe only — motor out), for
   * the Design tab's "Measured mass & CG" box (v0.061). Kept here rather than
   * in the .ork so the file format is untouched; the ballast it produces IS in
   * the file, as an ordinary mass component.
   */
  measured?: { massKg: number | null; cgM: number | null };
  /**
   * The design fingerprint as of the last save or import (v0.091+) — what is
   * on disk. Compared against the live design to decide whether opening
   * another file would discard work. See services/dirtyState.ts.
   *
   * ABSENT MEANS DIRTY, deliberately: a session written by an older build
   * cannot prove it was ever saved, and the safe reading of "I do not know" is
   * to ask rather than to discard. Same convention as the absent `appVersion`
   * above.
   */
  savedMark?: string;
  /**
   * Has a flight been run since that mark? Flying does not change the design,
   * so no fingerprint can see it — but the owner asked for it to count, and
   * both desktop OR and RockSim treat a flown sim as work worth keeping.
   */
  flownSinceSave?: boolean;
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

/** The release that made the time step a visible Launch-panel field. */
const TIME_STEP_FIELD_VERSION = '0.071';

/**
 * Is version `a` strictly earlier than `b`? Versions here follow the beta
 * scheme in version.ts — '0.NNN', until a production '1.0.0' resets it — so
 * compare numeric dot-segments, not strings: '0.100' vs '0.071' happens to
 * sort right lexically only because NNN is zero-padded today — an unpadded
 * '0.71' vs '0.100' would sort backwards, as would '9.0' vs a future
 * '10.0'. Absent or unparsable counts as earlier than everything: a
 * session that cannot say which build wrote it predates whatever field is
 * being asked about, and migrating is the safe direction for one that old.
 */
export function versionEarlierThan(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string' || a === '') return true;
  const as = a.split('.').map(Number);
  if (as.some((n) => !Number.isFinite(n))) return true;
  const bs = b.split('.').map(Number);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const av = as[i] ?? 0;
    const bv = bs[i] ?? 0;
    if (av !== bv) return av < bv;
  }
  return false;
}

/**
 * Was this session written before the Time step field existed (v0.071)? Only
 * such a session can be carrying a fine step it inherited invisibly from a
 * design file; from v0.071 on the step is on screen and any sub-default value
 * is the user's own entry. Deliberately NOT sessionPredatesThisBuild(): that
 * is true after EVERY release, and this app releases near daily — gating the
 * clamp on it would re-clamp a deliberately chosen step on each upgrade,
 * forever, with a notice blaming a design file that had nothing to do with it.
 */
function sessionPredatesTimeStepField(s: SessionState): boolean {
  return versionEarlierThan(s.appVersion, TIME_STEP_FIELD_VERSION);
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
    // Time-step migration (v0.071). Before this release the app took a design
    // file's own integration time step and MERGED it into the launch conditions
    // — so it stuck, was invisible, and rode along in the autosave. Without this
    // the tester who reported 40-second flights is STILL flying 0.01 s after
    // upgrading: several times slower for no accuracy he can read, with nothing
    // on screen to explain it, because his session predates the field that
    // would have shown it. Sessions written by v0.071 or later are left alone —
    // a sub-default step there is a choice the user made in the panel after
    // being told what it costs, and it must survive every upgrade after that.
    if (sessionPredatesTimeStepField(s) && s.launch
        && s.launch.timeStepS != null && s.launch.timeStepS < MIN_IMPORTED_TIME_STEP_S) {
      s.timeStepClampedFromS = s.launch.timeStepS;
      s.launch = { ...s.launch, timeStepS: MIN_IMPORTED_TIME_STEP_S };
      s.timeStepWasClamped = true;
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

/**
 * The state the pending debounced write will persist.
 *
 * Held at module level, NOT captured in the timer's closure, so `flushSession`
 * has something to write. With the state visible only inside the closure, a
 * flush could cancel the timer but had nothing left to save — which is worse
 * than not flushing at all, because it silently drops the write it was added
 * to guarantee.
 */
let pending: Omit<SessionState, 'savedAt'> | null = null;

/**
 * Key prefixes holding data the app can rebuild for free, in the order they may
 * be sacrificed to keep the user's design.
 *
 * Today that is exactly one family: `tc:samples:v3:<motorId>`, one entry per
 * downloaded thrust curve. Matched on the FAMILY prefix `tc:` rather than the
 * versioned one so a bump to `tc:samples:v4:` is still swept without this file
 * knowing the cache's version — and so this file never has to import from
 * thrustcurve.ts, which owns the cache and its own eviction policy.
 *
 * Nothing else on the origin qualifies. The other ten keys (prefs, session,
 * sim-runs, custom presets, external motors, motor filters, workspace, batch
 * criteria, tour flag, nav cache) are all `online-openrocket.*` or
 * `mmr-chrome:v1`, and every one of them is the only copy of something.
 */
const DISPOSABLE_KEY_PREFIXES = ['tc:'] as const;

/**
 * Free re-downloadable cache. Returns how many keys went, so the caller can
 * tell "there was room to make" from "there was nothing left to give".
 */
function evictDisposableCache(): number {
  let removed = 0;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k !== null && DISPOSABLE_KEY_PREFIXES.some((p) => k.startsWith(p))) doomed.push(k);
    }
    // Collect first, remove after: removeItem re-indexes the store, so removing
    // inside the walk skips every second match.
    for (const k of doomed) { localStorage.removeItem(k); removed++; }
  } catch {
    // Storage refusing reads or removes outright (blocked site data) is not a
    // quota case. Whatever went before it refused still counts: a partial sweep
    // can have made room, and one retry is cheap.
  }
  return removed;
}

function writeNow(): void {
  if (pending === null) return;
  try {
    // Plugged motors carry ejectionDelay = Infinity; JSON.stringify would
    // silently turn that into null, so round-trip it as a string.
    const payload = JSON.stringify(
      { appVersion: APP_VERSION, ...pending, savedAt: Date.now() }, (_k, v) =>
      typeof v === 'number' && v === Infinity ? 'Infinity' : v);
    try {
      localStorage.setItem(KEY, payload);
    } catch (quota) {
      /*
       * THE DESIGN OUTRANKS THE CACHE. This autosave is the only copy of the
       * user's unsaved work; the thrust-curve samples above are one fetch away
       * from being restored. Before this, a user who had browsed a few hundred
       * motors across sessions filled the origin, every debounced save from
       * that point on was refused, and the app's entire remedy was a banner
       * saying so — nothing anywhere could free the space, and the next reload
       * restored the last design that fit.
       *
       * Deliberately ONE retry, and only when the sweep actually freed
       * something: with nothing left to give up, `evictDisposableCache()`
       * returns 0 on every subsequent debounce (~2.5/s while editing) and the
       * original error is re-thrown immediately, so a genuinely full origin
       * costs one enumeration, not a retry loop.
       */
      if (evictDisposableCache() === 0) throw quota;
      localStorage.setItem(KEY, payload);
    }
    setSaveFailing(false);
  } catch {
    // Quota/serialization failures must never break editing — but "your
    // work saves itself" failing silently forever was the defect: flag it.
    setSaveFailing(true);
  }
  pending = null;
}

export function saveSessionDebounced(state: Omit<SessionState, 'savedAt'>): void {
  pending = state;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; writeNow(); }, DEBOUNCE_MS);
}

/**
 * Write any pending autosave immediately.
 *
 * The debounce is 400 ms, so closing the tab inside that window lost the last
 * edit — a small hole, but the same class as the Open defect this shipped with
 * (2026-09-01a): work the user made and the app did not keep. Called from
 * `pagehide`, which fires on close, reload and navigation away, and unlike
 * `beforeunload` also fires when a mobile browser discards the page.
 *
 * Deliberately NOT a beforeunload confirmation dialog: the autosave really
 * does restore the design, so interrupting every tab close to say so would be
 * a nag rather than a guard.
 */
export function flushSession(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  writeNow();
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch { /* ignore */ }
}
