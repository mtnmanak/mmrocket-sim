import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor, SavedConfig } from '../App.js';
import { DEFAULT_TIME_STEP_S, type LaunchConditions } from '../components/LaunchPanel.js';
import type { NoticeSeverity } from '../components/NoticeBar.js';
import { designFingerprint, type DesignSnapshot } from './dirtyState.js';
import { LEGACY_PAD_MASS_KEY } from './hardwareMass.js';
import type { Sequencer } from './latestWins.js';
import { matchImportedMotor, type MotorMatchResult } from './motorMatch.js';
import {
  fmtStepS, type MeasuredFigures, type OrkImportResult, type OrkMotorRef, type OrkTreeImportResult,
} from './orkFile.js';
import { padMassSetKey, syncActiveConfig } from './configSync.js';
import {
  reconcileAllIncludedMotors, type AttachedMotor, type StatedWeightText,
} from './statedLaunchWeight.js';
import { stageMotors, type StageMotors } from './nozzleFollow.js';
import type { TreeHistory } from '../hooks/useTreeHistory.js';
import { findShroudCandidates, type ShroudCandidate } from '../tree/shroudConvert.js';
import { separationEventOrDefault } from '../tree/sanitize.js';
import {
  applyStageNozzles, emptyTree, findNode, motorMounts, normalizeTree, primaryMountOf, updateNode,
} from '../tree/treeModel.js';

/**
 * WHAT AN OPEN, A CONFIGURATION SWITCH AND ✕ NEW PUT ON SCREEN — decided here,
 * written by App (audit 2026-09-22, extraction #3).
 *
 * These were ~370 lines inside App.tsx that decided motors, pad-mass keys and
 * nozzles, and two rules were written twice there: the launch merge (once in
 * the `setLaunch` updater, once again for the saved mark) and the pad-mass key
 * (once at import, once for the set on screen). Drift between either pair makes
 * a freshly opened file read as unsaved, or its weighed pad mass read as
 * weighed with a different motor set. Each function below returns a PLAN, and
 * App both applies it and takes the saved mark from that same object — so what
 * is on screen and what is marked as on disk cannot be assembled apart.
 *
 * WHAT IS PURE AND WHAT IS NOT. The planners — `planImport`, `planConfigSwitch`,
 * `planOrkSave`, `importMark`, `starterMotorMayLand` — are pure, and so is
 * `planNewDesign` but for one deliberate effect: it claims the open sequence
 * it is handed, so an Open still in flight cannot land over the new design.
 * The effectful edges are named for what they touch: `resolveImportMotors` is
 * where every await of a file open lives (one catalogue lookup, and possibly a
 * thrustcurve.org fetch, per motor the file names); `openShareLink` runs the
 * share-link path's awaits, claiming its sequence before the first; and
 * `applyImportPlan` / `applyConfigSwitchPlan` write a plan through the setters
 * App hands them.
 */

/**
 * What the design importers hand the shared apply path (file open AND share
 * link). Structural subset of OrkTreeImportResult so importRkt/importCdx1
 * results — same shape minus `launch` — fit too; only .ork parses carry the
 * flight-configuration fields.
 */
export type ImportedDesign = Pick<OrkTreeImportResult, 'name' | 'tree' | 'motors' | 'notes' | 'launch' | 'measured'>
  & Partial<Pick<OrkImportResult, 'configs' | 'chosenConfigId'>>
  // RASAero files carry a Mach-Alt table; the drag panel offers it as a
  // sweep condition so a user can reproduce tunnel-matched Reynolds.
  & { machAlt?: [number, number][] };

/** One mount's motor in the shape the stated-launch-weight reconcile takes. */
export function attachedOf(spec: MountMotor['spec']): AttachedMotor {
  return {
    designation: spec.designation,
    launchMassKg: spec.masses[0] ?? 0,
    lengthM: spec.length,
    cgXFromFrontM: spec.cgX,
  };
}

/** A whole mount set in that shape — every path that mounts more than one. */
export function attachedSet(motors: Record<string, MountMotor>): Record<string, AttachedMotor> {
  return Object.fromEntries(Object.entries(motors).map(([id, m]) => [id, attachedOf(m.spec)]));
}

/**
 * THE launch-conditions merge for an opened design — ONE rule, where App had
 * two copies (the `setLaunch` updater and the saved mark) that had to be kept in
 * step by hand.
 *
 * Every field the file carried is applied, explicit nulls included (an ISA file
 * sets temperature/pressure to null deliberately), and the panel's fields the
 * file did not mention are kept. timeStepS is the exception to "keep what the
 * file didn't mention": it is a FIDELITY setting belonging to the file, not a
 * site condition the user set. Merging it made it sticky — open a .ork carrying
 * 0.01 and every later design, including .rkt and .CDX1 imports that carry no
 * step at all, silently inherited it and ran several times slower forever. So
 * it is always assigned, and a file without one goes back to the engine default.
 */
export function importedLaunch(
  prev: LaunchConditions, fromFile: Partial<LaunchConditions> | undefined,
): LaunchConditions {
  return fromFile
    ? { ...prev, ...fromFile, timeStepS: fromFile.timeStepS }
    : { ...prev, timeStepS: undefined };
}

/** Every motor an opened design names, resolved. */
export interface ResolvedImportMotors {
  /** The applied set's references, by mount id. */
  working: Record<string, MotorMatchResult>;
  /**
   * Every OTHER configuration's matches, by configuration id then mount id —
   * `undefined` where nothing matched. The applied configuration is not here:
   * its motors are `working`, reused rather than re-fetched.
   */
  configs: Record<string, Record<string, MountMotor | undefined>>;
}

/**
 * The awaits of an open, and nothing else: every reference the file names,
 * matched in the order the file lists them (the applied set first, then each
 * other configuration). `match` is injectable for tests.
 */
export async function resolveImportMotors(
  imported: ImportedDesign,
  match: (ref: OrkMotorRef) => Promise<MotorMatchResult> = matchImportedMotor,
): Promise<ResolvedImportMotors> {
  const working: Record<string, MotorMatchResult> = {};
  for (const [nodeId, ref] of Object.entries(imported.motors)) {
    working[nodeId] = await match(ref);
  }
  const chosenId = imported.chosenConfigId ?? null;
  const configs: Record<string, Record<string, MountMotor | undefined>> = {};
  for (const cfg of imported.configs ?? []) {
    if (cfg.id === chosenId) continue;
    const matched: Record<string, MountMotor | undefined> = {};
    for (const [nodeId, ref] of Object.entries(cfg.motors)) {
      matched[nodeId] = (await match(ref)).motor;
    }
    configs[cfg.id] = matched;
  }
  return { working, configs };
}

/** What App writes for an opened design, and the mark it takes over it. */
export interface ImportPlan {
  /**
   * Exactly the state App writes, in the shape the saved mark hashes — the
   * mark is `designFingerprint(snapshot)` and nothing else.
   */
  snapshot: DesignSnapshot;
  /** The working set's unresolved references (see SavedConfig.unmatchedRefs). */
  unmatchedRefs: Record<string, OrkMotorRef>;
  machAlt: [number, number][] | undefined;
  /** The import note, and whether it reads as a warning. */
  note: { text: string; severity: NoticeSeverity };
  /** Hand-rolled camera shrouds to offer the native fairing for. */
  shrouds: ShroudCandidate[];
}

/**
 * Everything an open decides once its motors are resolved. `launch` is the
 * panel's conditions as they stand AFTER the last await (App's launch mirror),
 * so a wind typed while the file was opening is kept and the mark agrees with
 * it (audit 2026-09-22).
 */
export function planImport(
  imported: ImportedDesign,
  resolved: ResolvedImportMotors,
  ctx: { launch: LaunchConditions; text: StatedWeightText },
): ImportPlan {
  const massText = ctx.text.mass;
  const notes: string[] = [`Loaded “${imported.name}”.`, ...imported.notes];
  // Load EVERY mount's motor (staged/multi-mount files included).
  //
  // Only motor PROBLEMS go in the note. The successful "Motor: C6-5 (matched
  // built-in)." sentences used to go here too, and they were the note's worst
  // habit: nothing in the motor path rewrites this note, so after the user
  // loaded a different motor the box still named the old one — reported from
  // the beta by Big Dog, and true of every motor change, not just his. The
  // vitals strip and the Motors tab both show the loaded motor live, so the
  // note has no business restating it. What it IS still the only source of is
  // a motor that could not be matched or downloaded.
  const nextMotors: Record<string, MountMotor> = {};
  // The refs nothing resolved, kept whole so Save writes them back verbatim
  // instead of dropping the mount — see SavedConfig.unmatchedRefs.
  const nextUnmatchedRefs: Record<string, OrkMotorRef> = {};
  for (const [nodeId, ref] of Object.entries(imported.motors)) {
    const { motor: mm, note } = resolved.working[nodeId] ?? { note: '' };
    if (mm) nextMotors[nodeId] = mm;
    else nextUnmatchedRefs[nodeId] = ref;
    if (!mm) notes.push(note);
  }
  // Stage B: every configuration in the file becomes a ready-to-apply
  // preset, matched in the same pass. Only the APPLIED config's notes
  // surface — a preset's failures are reported if/when it is applied.
  const chosenId = imported.chosenConfigId ?? null;
  // Normalised BEFORE the configuration loop (it keeps ids): the pad-mass
  // attach below needs the tree's stage order and cluster counts.
  // `let`, because the stated-launch-weight reconcile below may rewrite a
  // stage's overrides once the applied configuration's motors are known.
  let importedTree = normalizeTree(imported.tree);
  const nextConfigs: SavedConfig[] = [];
  for (const cfg of imported.configs ?? []) {
    const cfgMotors: Record<string, MountMotor> = {};
    const unmatched: string[] = [];
    const cfgUnmatchedRefs: Record<string, OrkMotorRef> = {};
    for (const [nodeId, ref] of Object.entries(cfg.motors)) {
      // The applied config's motors were matched (and reported) above —
      // reused rather than re-fetching the same thrust curves.
      const mm = cfg.id === chosenId ? nextMotors[nodeId] : resolved.configs[cfg.id]?.[nodeId];
      if (mm) cfgMotors[nodeId] = mm;
      else { unmatched.push(ref.designation); cfgUnmatchedRefs[nodeId] = ref; }
    }
    // The configuration's weighed pad mass (<measuredpadmass configid>)
    // attached to its PRIMARY mount — the topmost-stage mount among ALL of
    // the file's references for it, matched or not, so a configuration whose
    // sustainer could not be loaded keeps the value on that reference (Save
    // writes it back unchanged) rather than applying it under the booster.
    // The key is the configuration's own set, an unmatched reference
    // contributing the `unmatched:<designation>` sentinel and every mount its
    // motor count, so a set the file only half-loaded is never applied
    // against a partial catalogue sum. The v0.116 attribute-less form is
    // keyed 'legacy' and checked by the reconcile effect. Immutable spreads:
    // the chosen configuration shares its records with `nextMotors`, so the
    // object is replaced in both places, never mutated. A non-chosen
    // configuration with no primary loses the value silently — a stated limit.
    if (typeof cfg.padMassKg === 'number') {
      const padMassKg = cfg.padMassKg;
      const primary = primaryMountOf(importedTree, Object.keys(cfg.motors));
      if (!primary) {
        if (cfg.id === chosenId) {
          notes.push(`This file's weighed pad mass (${massText(padMassKg)}) has no motor to attach to in configuration`
            + ` “${cfg.name ?? cfg.id}” and was not kept — re-enter it under the motor you weigh with.`);
        }
      } else {
        // THE key rule (configSync.padMassSetKey) — the one the set on screen
        // is keyed by too, or an imported pad mass would read 'stale-set' the
        // moment it is opened (on any design whose mount sits inside a pod
        // set, before the two copies were made one).
        const key = cfg.padMassLegacy ? LEGACY_PAD_MASS_KEY : padMassSetKey(importedTree, cfgMotors, cfgUnmatchedRefs);
        if (cfgMotors[primary]) {
          cfgMotors[primary] = { ...cfgMotors[primary], padMassKg, padMassWeighedWith: key };
        } else if (cfgUnmatchedRefs[primary]) {
          const ref = cfgUnmatchedRefs[primary];
          cfgUnmatchedRefs[primary] = { ...ref, padMassKg };
          if (cfg.id === chosenId) {
            const mountName = findNode(importedTree, primary)?.name ?? 'Motor mount';
            notes.push(`The file's weighed pad mass (${massText(padMassKg)}) belongs to the motor on “${mountName}”`
              + ` (${ref.designation}), which could not be loaded. It is kept so the file saves unchanged,`
              + ' and nothing is carried until that motor is loaded — or re-weigh with the motors you have in.');
          }
        }
        if (cfg.id === chosenId) {
          if (cfgMotors[primary]) nextMotors[primary] = cfgMotors[primary];
          if (cfgUnmatchedRefs[primary]) nextUnmatchedRefs[primary] = cfgUnmatchedRefs[primary];
        }
      }
    }
    nextConfigs.push({
      id: cfg.id, name: cfg.name, isDefault: cfg.isDefault, motors: cfgMotors,
      ...(unmatched.length > 0 ? { unmatched } : {}),
      ...(Object.keys(cfgUnmatchedRefs).length > 0 ? { unmatchedRefs: cfgUnmatchedRefs } : {}),
      ...(cfg.deployments && Object.keys(cfg.deployments).length > 0
        ? { deployments: cfg.deployments } : {}),
      ...(cfg.separations && Object.keys(cfg.separations).length > 0
        ? { separations: cfg.separations } : {}),
      ...(cfg.nozzles && Object.keys(cfg.nozzles).length > 0
        ? { nozzles: cfg.nozzles } : {}),
    });
  }
  // A stage whose stated launch weight still holds an unidentified motor's
  // weight, opened from a .ork saved BEFORE that motor could be loaded and
  // now matching a catalogue row (a weekly motors refresh is enough). The
  // mark rides the file for exactly this case — without it the motor lands
  // on top of its own weight, silently, at open. Same function as the
  // assignment path; returns null for every stage with no mark, which is
  // every design that never came from a RASAero file naming an unknown
  // motor.
  //
  // COUNTED FIRST, and that is not incidental. `motorTrouble` below is
  // "did anything push a note beyond the load line and the importer's own?",
  // and it decides whether the whole box reads as a warning. A stage that
  // reconciled EXACTLY AS DESIGNED is not a motor needing attention, so
  // counting after this loop would have made a clean correction paint the
  // import note orange — the same signal pollution the time-step note is
  // deliberately counted after (see its comment below). The reconcile's own
  // severity is ORed in separately, so a reconcile that had to CLEAR an
  // override still warns.
  const motorTrouble = notes.length > 1 + imported.notes.length;
  const spent = reconcileAllIncludedMotors(importedTree, attachedSet(nextMotors), ctx.text);
  importedTree = spent.tree;
  notes.push(...spent.notes);
  // Launch conditions from the file (.ork's first <simulation>) — see
  // importedLaunch for the merge, and why the time step is not merged.
  //
  // Deliberate, but not silent: the importer's notes only speak up when a
  // FILE carries a sub-default step, so a step typed into the panel was
  // being replaced with nothing on screen to say so. Compared as effective
  // values — blank and 0.05 both fly the default, and that non-change is
  // not worth a sentence. Counted AFTER motorTrouble, which is computed up at
  // the reconcile loop and must keep meaning "a motor needs the user's
  // attention", not this.
  //
  // Says what will be FLOWN, never "the file sets" — imported.launch.timeStepS
  // is already past the importer's clamp, so a file asking for 0.005 arrives
  // here as 0.05 and attributing that to the file contradicted the importer's
  // own note directly above it in the same box. What the file asked for, and
  // why it was refused, is that note's job.
  const prevStepS = ctx.launch.timeStepS ?? DEFAULT_TIME_STEP_S;
  const nextStepS = imported.launch?.timeStepS ?? DEFAULT_TIME_STEP_S;
  if (prevStepS !== nextStepS) {
    notes.push(imported.launch?.timeStepS != null
      ? `Flights here now use a ${fmtStepS(nextStepS)} s simulation time step, replacing `
        + `the ${fmtStepS(prevStepS)} s they were using.`
      : `The simulation time step is back to the ${fmtStepS(DEFAULT_TIME_STEP_S)} s default `
        + `— this file carries none, and the ${fmtStepS(prevStepS)} s in the Launch panel `
        + 'belonged to the design it was set for.');
  }
  // What the builder weighed, if the file carried it. Always assigned — a file
  // WITHOUT the numbers must clear the previous rocket's, or the box would
  // report the new design's gap against someone else's scale.
  const measured: MeasuredFigures = imported.measured ?? { massKg: null, cgM: null };
  return {
    snapshot: {
      tree: importedTree,
      mountMotors: nextMotors,
      launch: importedLaunch(ctx.launch, imported.launch),
      // Imported stages have fresh ids, so the previous design's per-stage
      // motor-length limits do not apply to any of them.
      maxMotorLengthByStage: {},
      savedConfigs: nextConfigs,
      activeConfigId: chosenId,
      measured,
    },
    unmatchedRefs: nextUnmatchedRefs,
    machAlt: imported.machAlt,
    // A file whose motors all matched is routine information; one that lost a
    // motor is a warning the user has to act on (motorTrouble was counted
    // before the time-step note, which is information either way).
    note: { text: notes.join('\n'), severity: motorTrouble || spent.severity === 'warn' ? 'warn' : 'info' },
    // Hand-rolled shrouds (1-fin freeform sets named like "Camera Shroud")
    // get an offer to become the native fairing component (2026-08-05e).
    shrouds: findShroudCandidates(importedTree),
  };
}

/** The mark an open takes: the fingerprint of exactly what the plan writes. */
export function importMark(plan: ImportPlan): string {
  return designFingerprint(plan.snapshot);
}

/** App's writers an open goes through: its state setters, and the tree's history. */
export interface ImportSinks {
  history: Pick<TreeHistory, 'reset'>;
  setMountMotors: (m: Record<string, MountMotor>) => void;
  setUnmatchedRefs: (r: Record<string, OrkMotorRef>) => void;
  setSavedConfigs: (c: SavedConfig[]) => void;
  setActiveConfigId: (id: string | null) => void;
  setMaxMotorLen: (m: Record<string, number | null>) => void;
  setLaunch: (l: LaunchConditions) => void;
  setMeasured: (m: MeasuredFigures) => void;
  setMachAlt: (t: [number, number][] | undefined) => void;
  setNote: (text: string, severity: NoticeSeverity) => void;
  setShroudPrompt: (s: ShroudCandidate[] | null) => void;
  markSaved: (mark: string) => void;
}

/**
 * An open, written: every field of the plan, and the mark over that same plan.
 *
 * THE HISTORY STARTS OVER (audit 2026-09-22). The undo stack holds the tree
 * alone, so an Open pushed as an ordinary edit let Ctrl+Z put the previous
 * rocket back under this file's launch conditions, measured mass and flight
 * configurations — and Save then wrote that hybrid, and the Measured box sized
 * ballast for one rocket from another's scale reading. The Open prompt already
 * told the user "Ctrl+Z does not reach across a file open"; now it does not.
 */
export function applyImportPlan(plan: ImportPlan, sinks: ImportSinks): void {
  const { snapshot } = plan;
  sinks.history.reset(snapshot.tree);
  sinks.setMountMotors(snapshot.mountMotors);
  sinks.setUnmatchedRefs(plan.unmatchedRefs);
  sinks.setSavedConfigs(snapshot.savedConfigs);
  sinks.setActiveConfigId(snapshot.activeConfigId);
  sinks.setMachAlt(plan.machAlt);
  sinks.setMaxMotorLen(snapshot.maxMotorLengthByStage);
  // A VALUE, merged once from the launch as it stood after the open's last
  // await — the same object the mark is taken over, so a wind typed while the
  // file was opening is kept AND the design reads clean (audit 2026-09-22).
  // The mark used to merge the launch captured when the open started, so that
  // edit left the just-opened design reading as unsaved.
  sinks.setLaunch(snapshot.launch);
  sinks.setMeasured(snapshot.measured);
  sinks.setNote(plan.note.text, plan.note.severity);
  sinks.setShroudPrompt(plan.shrouds.length ? plan.shrouds : null);
  // The design now IS the file on disk, so the baseline moves with it — taken
  // over the plan, NOT from React state, which has not re-rendered yet: reading
  // state here would mark the PREVIOUS design as saved and leave the imported
  // one looking dirty forever.
  sinks.markSaved(importMark(plan));
}

/** What App writes for a configuration switch. */
export interface ConfigSwitchPlan {
  /** Every configuration, the one being left written back first. */
  savedConfigs: SavedConfig[];
  /** The configuration now live, read from `savedConfigs`. */
  config: SavedConfig;
  mountMotors: Record<string, MountMotor>;
  unmatchedRefs: Record<string, OrkMotorRef>;
  activeConfigId: string;
  /** The design with the configuration's nozzles, deployments and separations on it, reconciled. */
  tree: RocketTree;
  /**
   * The stages whose nozzle this configuration STATES, under the loadout it
   * brings — for the nozzle-follow record, so the switch is not taken for a
   * motor change there (hooks/useNozzleFollow's `seed`).
   */
  nozzleStated: StageMotors[];
  note: { text: string; severity: NoticeSeverity };
}

/**
 * Loads a flight-configuration preset into the working set (Stage B).
 *
 * The working set is written BACK into the configuration it came from first
 * (configSync.syncActiveConfig — identity when nothing changed), and the
 * target is read from the synced set: a delay, an ignition change or a weighed
 * pad mass made on A survives A→B→A, and pressing Apply on the configuration
 * already on screen KEEPS the edits rather than reverting them to the file's —
 * the three `setSavedConfigs` sites were init / New / import only, unchanged
 * since v0.050, so every in-app motor edit used to live in the working set alone.
 * Since the 2026-09-22 audit the same holds for what the configuration puts on
 * the TREE — its recovery deployments, separations and nozzle: until then only
 * the motors went back, so A→B→A reverted a deployment edited on A to the
 * file's, and the next Launch on A flew the file's chute.
 */
export function planConfigSwitch(
  state: {
    savedConfigs: SavedConfig[];
    activeConfigId: string | null;
    mountMotors: Record<string, MountMotor>;
    unmatchedRefs: Record<string, OrkMotorRef>;
    tree: RocketTree;
  },
  requested: SavedConfig,
  text: StatedWeightText,
): ConfigSwitchPlan {
  const synced = syncActiveConfig(state.savedConfigs, state.activeConfigId,
    { motors: state.mountMotors, unmatchedRefs: state.unmatchedRefs, tree: state.tree });
  const cfg = synced.find((c) => c.id === requested.id) ?? requested;
  // A configuration is its motors AND its recovery deployment. These were
  // carried for export only, so applying one here switched the motors and
  // left the chute set the way the previously-opened configuration wanted
  // it — the one thing picking a configuration at file-open used to do that
  // this panel could not. Applying them makes the panel a complete switch,
  // which is what lets the open-time picker go away.
  // Folded into one tree, so the switch is written once.
  const hasDeploy = cfg.deployments && Object.keys(cfg.deployments).length > 0;
  const hasSep = cfg.separations && Object.keys(cfg.separations).length > 0;
  const hasNozzles = cfg.nozzles && Object.keys(cfg.nozzles).length > 0;
  let next = state.tree;
  if (hasDeploy || hasSep || hasNozzles) {
    // The nozzle is the flown motor's, so it switches with the motors: a
    // RASAero file's simulations can each state a different one (0 removes
    // it — the previous configuration's must not linger, same rule as the
    // separation write below).
    if (hasNozzles) next = applyStageNozzles(next, cfg.nozzles!);
    for (const [nodeId, d] of Object.entries(cfg.deployments ?? {})) {
      if (!findNode(next, nodeId)) continue;
      next = updateNode(next, nodeId, {
        ...(d.deployEvent !== undefined ? { deployEvent: d.deployEvent } : {}),
        ...(d.deployAltitude !== undefined ? { deployAltitude: d.deployAltitude } : {}),
        ...(d.deployDelay !== undefined ? { deployDelay: d.deployDelay } : {}),
      });
    }
    // Separation must be written even when it is the kernel default
    // ("ejection"): the point is to REPLACE whatever the previously applied
    // configuration left behind, so skipping the default would strand a
    // "never" from the last one.
    //
    // The event in the kernel's spelling, or desktop's default: a saved
    // configuration lives outside the tree, so the load boundary's sanitize
    // pass never sees it, and OrkEngine THROWS on a value it does not know —
    // which failed the whole build the moment the configuration was applied
    // (audit 2026-09-22). The .ork reader repairs one with a note; this
    // guards a configuration a session saved before it did.
    for (const [nodeId, sep] of Object.entries(cfg.separations ?? {})) {
      if (!findNode(next, nodeId)) continue;
      next = updateNode(next, nodeId, {
        ...(sep.separationEvent !== undefined ? { separationEvent: separationEventOrDefault(sep.separationEvent) } : {}),
        ...(sep.separationDelay !== undefined ? { separationDelay: sep.separationDelay } : {}),
        ...(sep.separationAltitude !== undefined ? { separationAltitude: sep.separationAltitude } : {}),
      });
    }
  }
  // Applying a configuration is the THIRD way a motor lands on a mount, and
  // until 2026-09-08 it was the one that ran no reconcile at all — so a
  // RASAero stage still holding an unidentified motor's weight got the new
  // configuration's motor stacked on top of it in one click. Measured on
  // `PePe2.CDX1`: simulation 1 names N5800-CS (not in the catalogue) over a
  // stated 47 lb, so the stage imports marked; switching to simulation 6
  // (M1297W, catalogued, 10.22 lb) weighed the stage 57.2 lb against that
  // simulation's own 24.2 lb, +136 %, with nothing on screen. Same call as
  // the open path, folded into the same tree.
  const spent = reconcileAllIncludedMotors(next, attachedSet(cfg.motors), text);
  next = spent.tree;
  // Always rewrite the note, never only on failure. Writing it solely when
  // `unmatched` was non-empty meant a clean switch left the PREVIOUS file's
  // note standing — the staleness Big Dog reported reads as arbitrary
  // precisely because some actions refresh the box and others don't.
  // The reconcile's own sentences ride whichever note is written, rather than
  // a second note that would overwrite the first: the mass that just
  // changed by tens of pounds belongs in the box the switch already writes.
  const withSpent = (lines: string[], sev: NoticeSeverity) => ({
    text: [...lines, ...spent.notes].join('\n'),
    severity: spent.severity === 'warn' && sev === 'info' ? 'warn' as const : sev,
  });
  let note: ConfigSwitchPlan['note'];
  if (cfg.unmatched?.length) {
    // Quiet at import time (only the applied config reports) — the debt
    // comes due when the user actually loads this preset.
    note = withSpent(cfg.unmatched.map((d) =>
      `Motor “${d}” couldn't be matched when the file was opened — pick one via Browse motor database.`), 'warn');
  } else {
    // "… and weighed pad mass" only when this configuration's primary record
    // carries one — the field under that motor shows it.
    const primary = primaryMountOf(state.tree, Object.keys(cfg.motors));
    const pad = primary ? cfg.motors[primary]?.padMassKg : undefined;
    const hasPad = typeof pad === 'number' && Number.isFinite(pad) && pad > 0;
    note = withSpent([`Flight configuration “${cfg.name || cfg.id}” applied — its motors and recovery settings`
      + `${hasPad ? ' and weighed pad mass' : ''} are now live.`], 'info');
  }
  // The loadout exactly as App will compute it once this is written: the
  // configuration's motors on the mounts this tree has.
  const mountIds = new Set(motorMounts(next).map((m) => m.id));
  const nozzleStated = hasNozzles
    ? stageMotors(next, Object.entries(cfg.motors).filter(([id]) => mountIds.has(id)))
      .filter((s) => s.stageId in cfg.nozzles!)
    : [];
  return {
    savedConfigs: synced,
    config: cfg,
    mountMotors: cfg.motors,
    // The working set's unresolved references are this configuration's, so
    // they switch with it — otherwise a save would write the PREVIOUS
    // configuration's lost motors onto this one's mounts.
    unmatchedRefs: cfg.unmatchedRefs ?? {},
    activeConfigId: cfg.id,
    tree: next,
    nozzleStated,
    note,
  };
}

/**
 * Opens a share link (`#d=` in the URL), sequenced like every other open.
 *
 * THE SEQUENCE IS CLAIMED BEFORE THE FIRST AWAIT (audit 2026-09-22). This path
 * used to claim it only inside applyImported, after the decode and the preset
 * catalogue had been awaited, so an Open started while a long link was still
 * decoding (a first visit's chunk loads are the slow case) was overwritten by
 * the link when it landed. A superseded link neither offers, applies nor
 * reports an error about a design nobody is waiting for.
 */
export async function openShareLink(hash: string, deps: {
  openSeq: Sequencer;
  /** Decode and parse the fragment (every await of this path). Throws on a bad link. */
  read: (hash: string) => Promise<ImportedDesign>;
  /** Ask first (a restored design the user worked on) rather than apply. */
  offer: boolean;
  onOffer: (imported: ImportedDesign) => void;
  apply: (imported: ImportedDesign, openId: number) => Promise<void>;
  onError: (e: unknown) => void;
}): Promise<void> {
  const openId = deps.openSeq.begin();
  try {
    const imported = await deps.read(hash);
    if (!deps.openSeq.isCurrent(openId)) return;
    if (deps.offer) deps.onOffer(imported);
    else await deps.apply(imported, openId);
  } catch (e) {
    if (!deps.openSeq.isCurrent(openId)) return;
    deps.onError(e);
  }
}

/**
 * May the starter rocket's C6 land now that its curve has arrived? Only on the
 * mount it was chosen for, while that mount is still in the design on screen
 * and nothing is loaded yet (audit 2026-09-22). The curve is one await (a
 * chunk on a first visit), and the old check — "no motor loaded yet" alone —
 * let it land on a design that had REPLACED the starter: a ✕ New or an Open
 * with no motors in that window got the C6 record under a mount id their tree
 * does not have, which reads the new design as unsaved. Every replacement
 * mints fresh ids, so the mount's presence is the precise test; a share link
 * that fails to decode leaves the starter, and its C6 still lands.
 */
export function starterMotorMayLand(
  live: RocketTree, mountId: string, motors: Record<string, MountMotor>,
): boolean {
  return Object.keys(motors).length === 0 && findNode(live, mountId) !== null;
}

/** App's writers a configuration switch goes through. */
export interface ConfigSwitchSinks {
  /** The nozzle-follow record's seed (hooks/useNozzleFollow). */
  seedNozzleFollow: (stages: readonly StageMotors[]) => void;
  history: Pick<TreeHistory, 'reset'>;
  setSavedConfigs: (c: SavedConfig[]) => void;
  setMountMotors: (m: Record<string, MountMotor>) => void;
  setUnmatchedRefs: (r: Record<string, OrkMotorRef>) => void;
  setActiveConfigId: (id: string | null) => void;
  setNote: (text: string, severity: NoticeSeverity) => void;
}

/**
 * A configuration switch, written.
 *
 * THE HISTORY STARTS OVER (audit 2026-09-22). The switch writes the new
 * configuration's nozzle, separations and deployments into the tree, and the
 * stack holds the tree alone — so one Ctrl+Z put the PREVIOUS configuration's
 * back under the new motors. Measured on `38-54 2-stage.CDX1`: a K627 flying
 * the M1350's 31.75 mm exit, +2.2 % apogee on the supersonic model; on
 * `ThreeCarbYen-2018.CDX1` sim-1's 0.9 s separation delays under sim-2's
 * motors. `savedConfigs` is written only when the write-back changed it, so an
 * unchanged set keeps its identity (the dirty-state contract).
 */
export function applyConfigSwitchPlan(
  plan: ConfigSwitchPlan, current: SavedConfig[], sinks: ConfigSwitchSinks,
): void {
  // FIRST, before anything the nozzle-follow effect can see: the stages whose
  // nozzle this configuration states are recorded under their new loadout, so
  // the switch does not read as a motor change there (audit 2026-09-22).
  sinks.seedNozzleFollow(plan.nozzleStated);
  if (plan.savedConfigs !== current) sinks.setSavedConfigs(plan.savedConfigs);
  sinks.setMountMotors(plan.mountMotors);
  sinks.setUnmatchedRefs(plan.unmatchedRefs);
  sinks.setActiveConfigId(plan.activeConfigId);
  sinks.history.reset(plan.tree);
  sinks.setNote(plan.note.text, plan.note.severity);
}

/**
 * A .ork save's configurations and its mark. Everything live is written back
 * into the active configuration FIRST (configSync.syncActiveConfig) and the
 * mark taken over the synced set: the writer swaps the live motors and tree
 * values into the active configuration anyway, so the file already has them —
 * but the stored configuration did not, and a switch away and back after the
 * save read as unsaved work. Identity when nothing changed.
 */
export function planOrkSave(
  snapshot: DesignSnapshot, unmatchedRefs: Record<string, OrkMotorRef>,
): { savedConfigs: SavedConfig[]; mark: string } {
  const savedConfigs = syncActiveConfig(snapshot.savedConfigs, snapshot.activeConfigId,
    { motors: snapshot.mountMotors, unmatchedRefs, tree: snapshot.tree });
  return { savedConfigs, mark: designFingerprint({ ...snapshot, savedConfigs }) };
}

/**
 * ✕ New's design and its mark, from ONE `emptyTree()`. It used to be called
 * twice, and emptyTree() -> makeStage() -> freshId() mints a new `c<N>` id every
 * call while designFingerprint hashes the tree WITH its ids — so the mark
 * described a stage id one greater than the tree in state, and a design with
 * nothing in it was dirty the instant ✕ New was pressed. Launch and measured
 * are deliberately not reset by New, so they carry their current values.
 *
 * NEW SUPERSEDES ANY OPEN IN FLIGHT (audit 2026-09-22). It never claimed the
 * open sequence, so an Open still waiting on a thrustcurve.org fetch landed on
 * top of the new design when it finished — and marked it saved, so the next
 * Open discarded the user's new work without asking. Passing the sequencer
 * claims it; that open then stops at its check.
 */
export function planNewDesign(
  keep: { launch: LaunchConditions; measured: MeasuredFigures },
  openSeq?: Sequencer,
): { snapshot: DesignSnapshot; mark: string } {
  openSeq?.begin();
  const snapshot: DesignSnapshot = {
    tree: emptyTree(),
    mountMotors: {},
    launch: keep.launch,
    maxMotorLengthByStage: {},
    savedConfigs: [],
    activeConfigId: null,
    measured: keep.measured,
  };
  return { snapshot, mark: designFingerprint(snapshot) };
}
