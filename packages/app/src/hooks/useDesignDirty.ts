import { useCallback, useEffect, useMemo, useReducer, useRef, type MutableRefObject } from 'react';
import type { MountMotor } from '../model/design.js';
import { designFingerprint, isDirty, type DesignSnapshot } from '../services/dirtyState.js';

/**
 * "IS THERE WORK A FILE ON DISK DOES NOT HAVE?" — the guard behind the Open
 * prompt and ✕ New's question (2026-09-01a). The autosave is ONE localStorage
 * slot, so opening a design really does discard whatever was in it; desktop
 * OR and RockSim both ask first.
 *
 * Extracted from App.tsx in the 2026-09-22 audit (row 501, extraction #6 of
 * 8 September), where its only coverage was a regex over App's text counting
 * `markSaved(` sites (savedMarkSites.test.ts). useDesignDirty.test.tsx drives
 * it by behaviour — the seeding rule, the starter motor's re-mark, a save, a
 * flight — and App.session.test.tsx mounts App around it.
 *
 * What stays in App is what App alone decides: WHICH actions may call
 * `markSaved` (a full-fidelity save, an import, ✕ New — never a lossy export
 * or a share link), and the autosave, which stores the mark and the flown flag
 * with the design so a reload keeps them.
 */

/** What a restored session carried; null on a first visit (no session at all). */
export interface DirtySeed {
  /** The mark it stored. ABSENT MEANS DIRTY: a session that cannot prove it was saved. */
  savedMark?: string;
  flownSinceSave?: boolean;
}

export interface DesignDirty {
  /** The design on screen differs from the last save, or has flown since. */
  dirty: boolean;
  /** Records that what is in the app right now is also what is on disk. */
  markSaved: (mark: string) => void;
  /**
   * A flight was recorded. It does not touch the design, so no fingerprint can
   * see it — but the owner asked for it to count, and desktop OR and RockSim
   * both treat a flown sim as work worth keeping.
   */
  markFlown: () => void;
  /** The mark as it stands, for the autosave to store beside the design. */
  savedMark: { readonly current: string | null };
  /** The flown-since-save flag as it stands, for the autosave. */
  flownSinceSave: { readonly current: boolean };
  /**
   * Bumped whenever the mark or the flag moves. They are REFS — marking a save
   * must not re-render the app for its own sake — so this is how an effect
   * that stores them (the autosave) learns they changed.
   */
  dirtyTick: number;
}

/**
 * @param snapshot the design as the user would save it (App's `designSnapshot`,
 *   memoized — the fingerprint walks every thrust curve, so it must not be
 *   rebuilt per render).
 * @param seed the restored session, or null on a first visit.
 * @param starter the starter motor as it arrives (App's loader writes the ref)
 *   and the mount it lands on.
 */
export function useDesignDirty(
  snapshot: DesignSnapshot,
  seed: DirtySeed | null,
  starter: { landing: MutableRefObject<MountMotor | null>; mountId: string | undefined },
): DesignDirty {
  /**
   * The design fingerprint as of the last save or import — what is on disk.
   *
   * SEEDING RULE, and it is load-bearing. A FIRST visit (no session, tree =
   * the starter rocket) is seeded CLEAN below, so a brand-new visitor is never
   * asked to save a rocket they have not touched. A RESTORED session takes the
   * mark it stored, and a session written before this field existed has none
   * — which counts as dirty, because it cannot prove it was saved.
   */
  const savedMark = useRef<string | null>(seed ? (seed.savedMark ?? null) : null);
  const flownSinceSave = useRef<boolean>(seed?.flownSinceSave ?? false);
  const [dirtyTick, bumpDirty] = useReducer((x: number) => x + 1, 0);

  // A first visit starts on the starter rocket, which is not work anybody
  // would mind losing — seed the mark so a share link or an Open does not ask
  // permission to replace a design the visitor has never touched. Runs once;
  // a restored session already carries its own mark (or deliberately lacks one).
  useEffect(() => {
    if (seed === null && savedMark.current === null) {
      savedMark.current = designFingerprint(snapshot);
      bumpDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // ...and when the starter motor lands (one await after that seed), take the
  // mark again over the rocket WITH it — but only if the mark still describes
  // everything else on screen. An edit, a pick or an open that got in first
  // has already moved the design off the seed, and that work keeps its prompt
  // (audit 2026-09-22). No motor ever landing (no bundle, no network) leaves
  // the seed standing, which is the design on screen.
  useEffect(() => {
    const m = starter.landing.current;
    if (m === null) return;
    if (snapshot.mountMotors[starter.mountId ?? ''] !== m) {
      // Not in state yet — or beaten, in which case it never will be.
      if (Object.keys(snapshot.mountMotors).length > 0) starter.landing.current = null;
      return;
    }
    starter.landing.current = null;
    if (savedMark.current !== null
      && designFingerprint({ ...snapshot, mountMotors: {} }) === savedMark.current) {
      savedMark.current = designFingerprint(snapshot);
      bumpDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the starter's mount is fixed at mount
  }, [snapshot]);

  const dirty = useMemo(
    () => isDirty(designFingerprint(snapshot), savedMark.current, flownSinceSave.current),
    // dirtyTick is how the two REFS above announce a change — markSaved and
    // the flown-since-save flag do not re-render on their own.
    [snapshot, dirtyTick],
  );

  const markSaved = useCallback((mark: string) => {
    savedMark.current = mark;
    flownSinceSave.current = false;
    bumpDirty();
  }, []);
  const markFlown = useCallback(() => {
    flownSinceSave.current = true;
    bumpDirty();
  }, []);

  return { dirty, markSaved, markFlown, savedMark, flownSinceSave, dirtyTick };
}
