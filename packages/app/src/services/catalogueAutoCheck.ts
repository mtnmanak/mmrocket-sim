import { checkedRecently, checkForCatalogueUpdates, loadStoredOverlay } from './catalogueOverlay.js';
import { isCatalogueOverlayInitialized, subscribeCatalogue, type CatalogueOverlay } from './motorDb.js';

/**
 * THE CATALOGUE CHECK ON LOAD (row 110, owner 2026-10-27).
 *
 * main.tsx starts this once per page, after the first render, and never awaits
 * it. It waits for App's restore of the stored overlay (App.tsx's mount effect
 * — otherwise, when storage fails, this check's install and that restore would
 * race), then checks the curated catalogue by itself unless:
 *
 * - the browser says it is offline;
 * - storage cannot be written (probed). The six-hour throttle lives in the
 *   stored overlay, so without storage every load would download the motors
 *   file again; the motor browser's button still works;
 * - the stored overlay was checked within six hours (RECHECK_MIN_MS), a
 *   check date in the future counting as expired (checkedRecently).
 *
 * A skip installs nothing: App's restore already installed the stored
 * overlay, and a reinstall would rebuild the catalogue and re-run App's
 * relabel subscriber for nothing. A failure writes one console.debug line,
 * shows nothing and never rejects; the next load tries again. React-free, and
 * nothing happens at import time: App imports it for the result subscription.
 */

/** The browser the check runs in, injectable so every skip can be tested. */
export interface CatalogueAutoCheckEnv {
  online: () => boolean;
  now: () => number;
  /** localStorage. Reading the property itself throws where storage is blocked. */
  storage: () => Pick<Storage, 'setItem' | 'removeItem'>;
  fetchImpl?: typeof fetch;
  /** App's restore has run (motorDb.isCatalogueOverlayInitialized). */
  restored: () => boolean;
  /** Calls `fn` after the next install (motorDb.subscribeCatalogue). */
  onInstall: (fn: () => void) => () => void;
}

const browser: CatalogueAutoCheckEnv = {
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  now: () => Date.now(),
  storage: () => window.localStorage,
  restored: isCatalogueOverlayInitialized,
  onInstall: subscribeCatalogue,
};

export type CatalogueAutoCheckOutcome = 'already-started' | 'offline' | 'no-storage' | 'recent' | 'checked' | 'failed';

/** The storage probe's key: written and removed at once. */
const PROBE_KEY = 'online-openrocket.storage-probe.v1';

let started = false;
const listeners = new Set<(overlay: CatalogueOverlay) => void>();

/**
 * App's message strip learns of an automatic result here; the button's own results never arrive.
 * A listener gets the installed overlay with `changed` cut to what THIS check newly brought: a
 * change already in the overlay stored before it, with the same new figures, is left out. The
 * overlay diffs against the shipped catalogue, so every check after the first carries the earlier
 * changes again; without the cut, a same-snapshot recheck six hours later told the user to pick a
 * motor again that they already had (review of 28 Oct).
 */
export function subscribeAutomaticCatalogueResult(fn: (overlay: CatalogueOverlay) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** `after`'s changes that `before` did not already hold with the same new figures. */
export function newlyChanged(after: CatalogueOverlay, before: CatalogueOverlay | null): CatalogueOverlay {
  const seen = new Set((before?.changed ?? []).map((c) => `${c.motorId}\u0000${JSON.stringify(c.after)}`));
  return { ...after, changed: after.changed.filter((c) => !seen.has(`${c.motorId}\u0000${JSON.stringify(c.after)}`)) };
}

/** @internal Test isolation only: the check starts once per page. */
export function resetCatalogueAutoCheckForTests(): void {
  started = false;
}

function storageWritable(env: CatalogueAutoCheckEnv): boolean {
  try {
    const store = env.storage();
    store.setItem(PROBE_KEY, '1');
    store.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
}

const whenRestored = (env: CatalogueAutoCheckEnv): Promise<void> => env.restored() ? Promise.resolve()
  : new Promise((resolve) => {
    const stop = env.onInstall(() => { stop(); resolve(); });
  });

/** Once per page; never throws, never rejects. */
export async function startCatalogueAutoCheck(env: CatalogueAutoCheckEnv = browser): Promise<CatalogueAutoCheckOutcome> {
  if (started) return 'already-started';
  started = true;
  try {
    await whenRestored(env);
    if (!env.online()) return 'offline';
    if (!storageWritable(env)) return 'no-storage';
    const before = loadStoredOverlay();
    if (checkedRecently(before, env.now())) return 'recent';
    // Forced: the throttle was just checked, with the future-date rule.
    const { overlay } = await checkForCatalogueUpdates({ force: true, fetchImpl: env.fetchImpl, now: env.now });
    const fresh = newlyChanged(overlay, before);
    for (const fn of listeners) fn(fresh);
    return 'checked';
  } catch (err) {
    console.debug(`MMRocket Sim: the automatic motor catalogue check did not complete: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
}
