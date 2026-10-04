import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { legacyStageLimits, migrateMotorLengths } from '../tree/motorLength.js';
import { defaultTree, motorMounts, normalizeTree, padMassOntoRankedPrimary } from '../tree/treeModel.js';
import { migrateLegacyPadMass, restoreUnmatchedRefs } from './configSync.js';
import type { DesignState } from './designDerivation.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import type { MeasuredFigures } from './orkFile.js';
import type { SessionState } from './session.js';

/**
 * A STORED SESSION, TURNED INTO THE DESIGN THE APP RESTORES (2026-10-01).
 *
 * App's state initializers did this inline, one `useState` at a time: the tree
 * normalized and its motor-length limits migrated, a v0.116/v0.117 pad mass
 * moved onto the primary's record, a weighing moved onto the core's record
 * when the core-first ranking names another primary, the same ranking for every
 * saved configuration, the unmatched references restored (or, from a session
 * written before they were stored, taken from the active configuration), and a
 * v0.116/v0.117 third `measured` key stripped. Every one of those changes what
 * flies — a migrated pad mass is hardware the kernel carries, a migrated motor
 * length moves `physicsKey` — so a headless run fed a raw autosave would fly
 * different numbers from the Launch button. ONE function now, called by App's
 * initializers and by anything that flies a stored session
 * (services/simulateDesign.ts; App.simulate.test.tsx's session cases).
 *
 * Pure apart from the id counter `normalizeTree` reseeds, which every caller
 * that builds a tree already shares.
 */

/** Where a restore moved a weighed pad mass when the core-first ranking named another primary. */
export interface RankedPadMass { from?: string; to?: string; kg?: number }

/** What a session restored to, and the bookkeeping App's notices and saved mark read once. */
export interface RestoredDesign {
  /** The design as App's state initializers hold it before the first render. */
  state: Required<DesignState>;
  /** The repairs `normalizeTree` made — the restore's info note. */
  restoreNotes: string[];
  /** The tree and limits before the motor-length migration, for the saved mark's one re-take. */
  preLengthRestore: { tree: RocketTree; maxMotorLengthByStage: Record<string, number | null> };
  /** What became of a v0.116/v0.117 `measured.padMassKg`; null when the session carried no motor set. */
  legacyPadMass: ReturnType<typeof migrateLegacyPadMass> | null;
  /** Where the core-first ranking moved the working set's pad mass; null when the session carried no motor set. */
  rankedPadMass: RankedPadMass | null;
  /** The working set and configurations as stored, kept only when the ranking moved a pad mass in either. */
  preRankRestore: { motors: Record<string, MountMotor>; configs: SavedConfig[] } | null;
  /** The mount a pre-per-mount session's one motor applied to, else the first mount. */
  defaultMountId: string | undefined;
}

export function designStateFromSession(
  session: SessionState | null,
  /** The pre-v0.005 motor-browser filter's limit (App reads it from localStorage); null when none. */
  opts: { legacyMaxMotorLengthM: number | null },
): RestoredDesign {
  // Normalize ONCE and derive every dependent value from the SAME tree: each
  // normalizeTree/defaultTree call mints fresh ids for nodes it creates, so a
  // second call yields ids that don't exist in the tree — the default-motor
  // assignment and legacy migrations would key onto ghosts. Autosave repairs
  // are named just like file imports (open-items, 22–23 September: "A
  // restored session is repaired without a note").
  const restoreNotes: string[] = [...(session?.treeRestoreNotes ?? [])];
  const before = normalizeTree(session?.tree ?? defaultTree(), restoreNotes);
  const limits = legacyStageLimits(before, session, opts.legacyMaxMotorLengthM);
  const tree = migrateMotorLengths(before, limits);
  const defaultMountId = session?.mountId ?? motorMounts(tree)[0]?.id;

  // Per-mount motors (Release C). Legacy sessions carried ONE motor + the
  // mount it applied to — migrated onto that mount.
  let legacyPadMass: RestoredDesign['legacyPadMass'] = null;
  let rankedPadMass: RankedPadMass | null = null;
  let preRankRestore: RestoredDesign['preRankRestore'] = null;
  let mountMotors: Record<string, MountMotor> = {};
  if (session?.mountMotors) {
    // The pad mass moved from the measured box onto the motor's record in
    // v0.118. A session written before that carries it as a third measured
    // key; migrate it onto the restored set (identity when there is none).
    const m = migrateLegacyPadMass(
      session.mountMotors,
      (session.measured as (MeasuredFigures & { padMassKg?: unknown }) | undefined)?.padMassKg,
      tree,
    );
    legacyPadMass = m;
    // And a session saved with a pod or strap-on motor picked before the
    // core's carries it on the record that has just stopped being primary.
    const ranked = padMassOntoRankedPrimary(tree, m.motors);
    rankedPadMass = ranked;
    if (ranked.motors !== m.motors) preRankRestore = { motors: m.motors, configs: session.savedConfigs ?? [] };
    mountMotors = ranked.motors;
  } else if (defaultMountId && session?.motor) {
    // A legacy (pre-per-mount) session carried its one motor's spec inline.
    const label = session.motorLabel ?? 'C6-5';
    // Those sessions predate the catalogue and only ever held the three
    // Estes-class starters, so a missing meta can be named honestly.
    // The invented `propellant` now feeds an ignition decision as well as a
    // label — harmless here because such a session is single-stage by
    // construction (one inline motor, one mount), so nothing above a launch
    // stage can read it. If that ever stops being true, drop the field
    // rather than guessing it: an unknown propellant defaults to
    // electronics-timed on purpose, and this would quietly override that.
    const meta = session.motorMeta
      ?? { label, manufacturer: 'Estes', type: 'SU', propellant: 'black powder' };
    mountMotors = { [defaultMountId]: { label, spec: session.motor, meta, ignition: { event: 'automatic', delay: 0 } } };
  }
  // (A fresh design starts EMPTY and App's starter-motor effect lands the
  // catalogue's Estes C6 after one await.)

  // Each stored configuration's pad mass follows the core-first ranking the
  // same way the working set's does (audit 2026-09-22, row 356), or applying
  // one saved with a pod motor picked first would orphan it again. A row
  // nothing moves in is kept by identity.
  const stored = session?.savedConfigs ?? [];
  const savedConfigs = stored.map((c) => {
    const ranked = padMassOntoRankedPrimary(tree, c.motors);
    return ranked.motors === c.motors ? c : { ...c, motors: ranked.motors };
  });
  // Recorded for the saved-mark re-take, with the working set as it was
  // restored (moved or not).
  if (savedConfigs.some((c, i) => c !== stored[i])) {
    preRankRestore = { motors: preRankRestore?.motors ?? mountMotors, configs: stored };
  }

  // A session written by v0.116/v0.117 carries the pad mass as a third
  // measured key — migrated above, and stripped here ONLY when present, so
  // every other session's object is returned by identity and fingerprints
  // exactly as it did (dirtyState hashes keys).
  let measured: MeasuredFigures = session?.measured ?? { massKg: null, cgM: null };
  if (session?.measured && 'padMassKg' in session.measured) {
    const { padMassKg: _x, ...rest } = session.measured as MeasuredFigures & { padMassKg?: unknown };
    measured = rest;
  }

  return {
    state: {
      tree,
      mountMotors,
      launch: session?.launch ?? DEFAULT_CONDITIONS,
      measured,
      savedConfigs,
      activeConfigId: session?.activeConfigId ?? null,
      // The session's copy minus any mount that has a record; a session written
      // before they were stored falls back to the ACTIVE configuration's refs.
      unmatchedRefs: restoreUnmatchedRefs(session?.savedConfigs, session?.activeConfigId, session?.mountMotors ?? {},
        session?.unmatchedRefs),
    },
    restoreNotes,
    preLengthRestore: { tree: before, maxMotorLengthByStage: limits },
    legacyPadMass,
    rankedPadMass,
    preRankRestore,
    defaultMountId,
  };
}
