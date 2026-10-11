import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, type MutableRefObject } from 'react';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { designFingerprint, isDirty, type DesignSnapshot } from '../services/dirtyState.js';

/**
 * "IS THERE WORK A FILE ON DISK DOES NOT HAVE?" — the guard behind the Open
 * prompt and ✕ New's question (2026-09-01a). The autosave is ONE localStorage
 * slot, so opening a design really does discard whatever was in it; desktop
 * OR and RockSim both ask first.
 *
 * Extracted from App.tsx in the 2026-09-22 audit (row 501, extraction #6 of
 * 8 September). In App it was reachable only through a full render —
 * App.session.test.tsx's ✕ New cases — and a regex over App's text counting
 * `markSaved` sites (savedMarkSites.test.ts). useDesignDirty.test.tsx now
 * drives the rule itself — the seeding rule, the starter motor's re-mark, a
 * save, a flight — and App.session.test.tsx still mounts App around it.
 *
 * What stays in App is what App alone decides: WHICH actions may call
 * `markSaved` (a full-fidelity save, an import, ✕ New — never a lossy export
 * or a share link), and the autosave, which stores the mark and the flown flag
 * with the design so a reload keeps them.
 */

/**
 * The working set and configurations exactly as a restored session stored
 * them, recorded when the restore moves a weighed pad mass or migrates labels.
 */
export interface PreRankRestore {
  motors: Record<string, MountMotor>;
  configs: SavedConfig[];
}

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
  markSaved: (mark: string, flightsAtSnapshot?: number) => void;
  /** Move a matching saved mark across a display migration, retaining flight/dirty flags. */
  migrateSavedMark: (before: DesignSnapshot, after: DesignSnapshot) => void;
  /** Capture beside a file snapshot, before awaiting its writer. */
  flightCount: { readonly current: number };
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
 * @param preRank the design as the session stored it, when the restore moved
 *   a pad mass onto the ranked primary or migrated labels; read
 *   once, on mount.
 * @param preLength the tree and stage limits before the one-time mount migration.
 * @param preConfig the configurations before removing a dry-save placeholder.
 * @param options.onMarkMigrated told the fingerprints before and after EVERY
 *   non-edit rewrite of the design (a catalogue relabel, a restore migration,
 *   the starter motor landing), whether or not the .ork mark matched: another
 *   mark taken over the before-design — App's lossy .rkt/.CDX1 mark — still
 *   describes the design and must move with it. Not called when nothing moved.
 */
export function useDesignDirty(
  snapshot: DesignSnapshot,
  seed: DirtySeed | null,
  starter: { landing: MutableRefObject<MountMotor | null>; mountId: string | undefined },
  preRank?: MutableRefObject<PreRankRestore | null>,
  preLength?: Pick<DesignSnapshot, 'tree' | 'maxMotorLengthByStage'>,
  preConfig?: Pick<DesignSnapshot, 'savedConfigs' | 'activeConfigId'> | null,
  options: { onMarkMigrated?: (before: string, after: string) => void } = {},
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
  const flightCount = useRef(0);
  const [dirtyTick, bumpDirty] = useReducer((x: number) => x + 1, 0);
  // The latest callback, for the mount-time effects and the stable migrateSavedMark.
  const onMarkMigrated = useRef(options.onMarkMigrated);
  useLayoutEffect(() => { onMarkMigrated.current = options.onMarkMigrated; });
  const migrated = (before: string, after: string) => { if (before !== after) onMarkMigrated.current?.(before, after); };

  // A first visit starts on the starter rocket, which is not work anybody
  // would mind losing — seed the mark so a share link or an Open does not ask
  // permission to replace a design the visitor has never touched. Runs once;
  // a restored session already carries its own mark (or deliberately lacks one).
  useEffect(() => {
    if (seed === null && savedMark.current === null) {
      savedMark.current = designFingerprint(snapshot);
      bumpDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, over the design as first drawn
  }, []);
  // A pad mass the restore moved onto the ranked primary (rankedPadMass) is
  // not an edit: the file on disk carries it per configuration, not per mount,
  // so it already IS the moved design. But the stored mark was taken over the
  // design before the move, and the move changes the fingerprinted records —
  // so a design the user had saved read as unsaved, ✕ New and Open asked, and
  // the stale mark was autosaved to ask again on every reload (seam review of
  // audit 2026-09-22). Re-taken over the moved design exactly when it
  // described the design before the move, the same guard as the starter
  // landing's below; a mark that did not (unsaved work) keeps its prompt.
  // Apply the same rule to the motor-length, label and empty-configuration
  // migrations. Compare them together so a session needing several never loses
  // its original clean/dirty state.
  useEffect(() => {
    const pre = preRank?.current ?? null;
    if (preRank) preRank.current = null;
    const before = designFingerprint({ ...snapshot, ...preLength, ...(pre ? { mountMotors: pre.motors, savedConfigs: pre.configs } : {}), ...preConfig });
    const after = designFingerprint(snapshot);
    // Before the .ork mark's own test: a lossy mark can be valid without one.
    migrated(before, after);
    if (savedMark.current === null || before !== savedMark.current) return;
    savedMark.current = after;
    bumpDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, over the design as restored
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
    const before = designFingerprint({ ...snapshot, mountMotors: {} });
    const after = designFingerprint(snapshot);
    migrated(before, after);
    if (savedMark.current !== null && before === savedMark.current) {
      savedMark.current = after;
      bumpDirty();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the starter's mount is fixed at mount
  }, [snapshot]);

  const dirty = useMemo(
    () => isDirty(designFingerprint(snapshot), savedMark.current, flownSinceSave.current),
    // dirtyTick is how the two REFS above announce a change — markSaved and
    // the flown-since-save flag do not re-render on their own. The rule sees a
    // dep the callback never reads and calls it unnecessary; removing it would
    // freeze `dirty` at its last value after a save or a flight, so the Open
    // prompt and the unsaved-work guard would read a stale answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dirtyTick re-keys the memo on a ref write; see above
    [snapshot, dirtyTick],
  );

  const markSaved = useCallback((mark: string, flightsAtSnapshot = flightCount.current) => {
    savedMark.current = mark;
    flownSinceSave.current = flightCount.current !== flightsAtSnapshot;
    bumpDirty();
  }, []);
  const migrateSavedMark = useCallback((before: DesignSnapshot, after: DesignSnapshot) => {
    const from = designFingerprint(before);
    const to = designFingerprint(after);
    if (from !== to) onMarkMigrated.current?.(from, to);
    if (savedMark.current !== from) return;
    savedMark.current = to;
    bumpDirty();
  }, []);
  const markFlown = useCallback(() => {
    flightCount.current++;
    flownSinceSave.current = true;
    bumpDirty();
  }, []);

  return { dirty, markSaved, migrateSavedMark, markFlown, savedMark, flownSinceSave, flightCount, dirtyTick };
}
