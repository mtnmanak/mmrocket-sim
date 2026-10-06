import {
  OrkRocket, type ComponentNode, type IgnitionEvent, type MotorSpec, type RocketTree,
  type StaticInfo,
} from '@online-openrocket/engine';
import {
  applyStageNozzles, clearStageNozzles, engineTree, isOnLaunchStage, mountMotorCount, motorMounts, stageIdByNode, stagesWithNozzle,
  type ClusterSplit,
} from '../tree/treeModel.js';
import { equivalentExitDiameterM } from './nozzleFollow.js';
import { nozzleForMotorId } from './nozzleDb.js';
import { displayDesignation, displayMotorManufacturer, motorLabel, isHighPower, type MotorDbEntry } from './motorDb.js';
import { motorLabelEntry } from './motorLabels.js';
import { defaultDelay, delayOptions, fetchMotorSpec, type TcMotor } from './thrustcurve.js';
import { motorIdentity, shiftMotorMass } from './hardwareMass.js';
import { buildSimRun, type MotorMeta, type SimRun } from './simReport.js';
import { aeroModelFor, rogersKbfFor, type AeroMode } from './flightPipeline.js';
import type { MountMotor } from '../model/design.js';
import { flyLaunch, writeMountMotor } from './flightRunner.js';
import { machProbeSeconds } from './machProbe.js';
import { kernelSimOptions, type LaunchConditions } from './launchConditions.js';
import { physicsKeyOf, provenanceKeyOf } from './designDerivation.js';

/**
 * THE BATCH SWEEP — every flight Batch Simulate flies, out of the component.
 *
 * It lived as `start()`, a ~407-line closure inside BatchSimulate.tsx whose two
 * flight passes (single motors, then the mixed-cluster combinations) were two
 * hand-kept copies of one procedure. They had drifted by the 22 September 2026
 * audit: the single pass skipped a re-fly the combination pass always paid for,
 * both hand-rolled the aero stamps `flightPipeline` already owns, and every
 * batch fix had to be applied twice. Here there is ONE flight (`flyLegs`), ONE
 * per-mount solver (`flyLaunch`) and ONE nozzle rule (`batchStageExit`), and a
 * single motor is simply a combination of one leg.
 *
 * The dialog keeps what is the dialog's: the filters, the criteria and their
 * grading (done in render, so a verdict follows the criteria shown above it),
 * the progress bar, and what goes into the run history.
 */

/** The aero model the batch flies — its own, deliberately independent of the design page's (BatchSimulate says why). */
export type BatchModel = 'eb' | 'kbf' | 'auto' | 'supersonic' | 'hybrid';

export interface BatchMountOption {
  id: string;
  label: string;
  diameterMm: number;
  /** Motors a candidate fires on this mount (`mountMotorCount`: cluster × enclosing pods/strap-ons) — ×N. */
  motorCount: number;
  /** Effective max motor length (override ?? mount design value), SI m. */
  maxMotorLengthM: number | null;
}

/**
 * Probe cutoff for one candidate's auto-aero Mach probe. The cutoff has to
 * see the WHOLE stack, not just the motor under test: a candidate in the
 * sustainer waits on the booster below it, and a cutoff computed from the
 * candidate alone ends before it ever lights.
 *
 * `probeTree` is the tree the candidate actually FLIES. The combination
 * passes fly a SPLIT tree whose group mounts carry freshly minted ids, and
 * resolving those ids against the original tree put every combo candidate
 * "off the launch stage" — so the short probe silently became the full chain
 * bound (every burn plus every ejection delay, 20-40 s on a real cluster),
 * a near-full extra flight per combination. `replacedMountId` is the cluster
 * mount the split removed: its assigned motor is not aboard the split tree,
 * and leaving it in the set double-counted its burn in that same bound.
 * @internal Exported for components/BatchSimulate.test.tsx; no other module imports it.
 */
export function batchProbeCutoff(
  probeTree: RocketTree,
  assigned: Record<string, MotorSpec>,
  targets: Record<string, MotorSpec>,
  replacedMountId?: string,
): number {
  const aboard: Record<string, MotorSpec> = { ...assigned, ...targets };
  if (replacedMountId !== undefined && !(replacedMountId in targets)) delete aboard[replacedMountId];
  return machProbeSeconds(Object.entries(aboard).map(([id, spec]) => ({
    spec,
    onLaunchStage: isOnLaunchStage(probeTree, id),
  })));
}

/**
 * How many mixed combinations a split into `groups` mounts adds for `n`
 * candidates — exactly what the comboAssignments() generator below yields:
 * multisets of group assignments minus the all-same ones, which are the
 * single-motor rows already flown. Two groups: C(n,2). Three groups (the
 * 4+2 / 2+2+2 pair split): C(n+2,3) − n. ONE definition, keyed on the split's
 * own mountIds.length, because the count used to be spelled out in three
 * places — the sweep's progress total, the meta line, and the time-step
 * caution's flight count — and a new split shape would have had to be taught
 * to each of them separately.
 */
export function mixedComboCount(n: number, groups: number): number {
  return groups === 2 ? (n * (n - 1)) / 2 : (n * (n + 1) * (n + 2)) / 6 - n;
}

/**
 * Multisets of `size` candidate indices (non-decreasing), excluding all-same
 * (those are the single-motor rows already flown).
 */
function* comboAssignments(count: number, size: number): Generator<number[]> {
  const idx = new Array<number>(size).fill(0);
  while (true) {
    if (!idx.every((v) => v === idx[0])) yield [...idx];
    // increment odometer with non-decreasing constraint
    let p = size - 1;
    while (p >= 0) {
      idx[p]!++;
      if (idx[p]! < count) {
        for (let q = p + 1; q < size; q++) idx[q] = idx[p]!;
        break;
      }
      p--;
    }
    if (p < 0) break;
  }
}

/**
 * The weighed pad mass the batch carries — on the ONE motor it was weighed
 * with, and only on the mount it was weighed on (v0.118, 2026-09-07).
 *
 * v0.116 flew every candidate at its catalogue weight, so a sweep read a
 * little higher than the design page for the very motor the user had weighed.
 * App builds this from `built.hardware` when the arithmetic accepted the pad
 * mass (state 'ok') and leaves it undefined for a refusal, a stale set or a
 * pending legacy value. Every OTHER candidate is a motor nobody has weighed —
 * there is no honest number for hardware that was never on the scale — so it
 * stays at catalogue weight, and the note under the candidates row says so.
 */
export interface BatchWeighed {
  mountId: string;
  /** motorIdentity(mm.meta, designation) of the weighed motor. */
  identity: string;
  /** True when the identity is a pinned EX id (meta.exMotorId). Unpinned EX records — a session from before
   *  exMotorId existed, or a quick-pick reuse — are spelled 'EX/<designation>', and an EX candidate may then
   *  match on that spelling too. */
  pinned: boolean;
  /** Delay-stripped display name (App's baseLabel). */
  name: string;
  perMotorShiftKg: number;
  deltaKg: number;
}

/**
 * THE STAGE EXIT ONE BATCH CANDIDATE FLIES, as one equivalent nozzle — pure, so
 * the headline behaviour of this dialog has a test that would fail if it broke.
 *
 * Two rules, in order:
 *
 *  1. If the user has TYPED an exit under the stage and this candidate is the
 *     motor still loaded on the mount being swept, that row flies THEIR number.
 *     The field is already the whole stage's equivalent, so it is used as-is.
 *     This is the case the database cannot serve: a nozzle machined out by hand
 *     is not in anyone's drawings.
 *  2. Otherwise the candidate's own published exit is summed with the exits of
 *     every other motor firing on the stage. `equivalentExitDiameterM` returns
 *     null the moment ANY of them is unknown, which is the honest answer — a
 *     sum short by the motors it could not see is worse than no number at all,
 *     because the blank is visible and the short sum is not.
 *
 * The ids are the ones the nozzle database is keyed on: a catalogue motorId,
 * or an imported motor's `ex:` library id (App hands over batchMotorIds, the
 * expression nozzleFollow reads).
 *
 * Null means "fly with no nozzle", which is what every candidate did before.
 * @internal Exported for components/BatchSimulate.test.tsx; no other module imports it.
 */
export function batchStageExit(input: {
  candidateId: string;
  /** Motors firing on the swept mount (a cluster count), not the whole stage. */
  count: number;
  /** This candidate's published exit, or null when the app holds none. */
  ownExitM: number | null;
  /** The other mounts firing alongside it, already resolved. */
  otherParts: readonly { count: number; exitDiameterM: number | null }[];
  /** The exit typed under the stage, or null. */
  typedStageExitM: number | null;
  /** The motor currently loaded on the mount being swept, if any. */
  loadedIdOnTarget: string | undefined;
}): number | null {
  const { candidateId, count, ownExitM, otherParts, typedStageExitM, loadedIdOnTarget } = input;
  if (typedStageExitM !== null && loadedIdOnTarget && candidateId === loadedIdOnTarget) {
    return typedStageExitM;
  }
  return equivalentExitDiameterM([{ count, exitDiameterM: ownExitM }, ...otherParts]);
}

/**
 * The nozzle-database id of each loaded motor, by mount — what App hands the
 * sweep as `assignedMotorIds`. The SAME expression nozzleFollow's stageMotors
 * reads: a catalogue motor by its `motorId`, an imported EX motor by its
 * `exMotorId`, because an EX motor never has a `motorId`. App read `motorId`
 * alone until audit 2026-09-22, which kept every EX motor out of the rule in
 * batchStageExit on both sides. A function rather than App's inline map so a
 * test can hold it to nozzleFollow with a motor that carries only the EX id.
 */
export function batchMotorIds(
  motors: Record<string, { meta: Pick<MotorMeta, 'motorId' | 'exMotorId'> }>,
): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(motors).map(([id, mm]) => [id, mm.meta.motorId ?? mm.meta.exMotorId]));
}

/**
 * A candidate's identity spelled the way MountMotor identities are: EX entries by their ex: id.
 * @internal Exported for components/BatchSimulate.test.tsx; no other module imports it.
 */
export function candidateIdentity(entry: Pick<MotorDbEntry, 'motorId' | 'manufacturerAbbrev' | 'designation'>): string {
  return motorIdentity({ exMotorId: entry.motorId.startsWith('ex:') ? entry.motorId : undefined, manufacturer: entry.manufacturerAbbrev }, entry.designation);
}

/** Is this candidate the weighed motor? Either spelling when the weighed record is not pinned to an EX id. */
export function isWeighedCandidate(
  entry: Pick<MotorDbEntry, 'motorId' | 'manufacturerAbbrev' | 'designation'>, weighed: BatchWeighed,
): boolean {
  return candidateIdentity(entry) === weighed.identity
    || (!weighed.pinned && `${entry.manufacturerAbbrev}/${entry.designation}` === weighed.identity);
}

/**
 * The spec a candidate flies: shifted by the weighed hardware ONLY when it is the weighed motor on the weighed mount. Delay is not part of the identity.
 * @internal Exported for components/BatchSimulate.test.tsx; no other module imports it.
 */
export function batchFlownSpec(
  entry: Pick<MotorDbEntry, 'motorId' | 'manufacturerAbbrev' | 'designation'>, spec: MotorSpec,
  targetMountId: string, weighed: BatchWeighed | undefined,
): MotorSpec {
  return weighed && targetMountId === weighed.mountId && isWeighedCandidate(entry, weighed)
    ? shiftMotorMass(spec, weighed.perMotorShiftKg) : spec;
}

/**
 * WHAT THE BATCH CALLS EACH CANDIDATE — `<manufacturer> <designation>`.
 *
 * The combination labels used to leave the manufacturer out, and a label is
 * what a combination row stores as its motor. The audit (2026-09-22) measured
 * 9,136 of the 26,796 combination rows at 29 mm sharing a label with another
 * row — every pair of its 232 candidates — so a saved run could not be traced
 * to the motors that flew it. Re-measured for this fix, the same day and the
 * same pairs: with the manufacturer alone that falls to 428, every one of them
 * a pair the catalogue itself spells alike once displayDesignation has done
 * its job: Cesaroni's 229H255-14A and 315H255-14A (Pro29-4G and Pro29-6G) are
 * both "H255-14A", and AeroTech's H550ST reload and HP-H550ST DMS are both
 * "H550ST". For exactly those — a name more than one candidate would share —
 * the RAW designation is used instead, which is the catalogue's own identity:
 * no two of the shipped file's 1,156 motors share a name this way (also
 * measured for this fix). Two imported EX files with the same designation
 * still can, and that costs only the label — rows are keyed on motor ids
 * (batchRowKey).
 */
export function batchMotorNames(
  candidates: readonly Pick<MotorDbEntry, 'motorId' | 'manufacturerAbbrev' | 'designation' | 'realManufacturer'>[],
  showImportedMaker = true,
): Map<string, string> {
  const maker = (e: Pick<MotorDbEntry, 'manufacturerAbbrev' | 'realManufacturer'>) =>
    showImportedMaker ? displayMotorManufacturer(e) : e.manufacturerAbbrev;
  const shown = (e: Pick<MotorDbEntry, 'manufacturerAbbrev' | 'designation' | 'realManufacturer'>) =>
    `${maker(e)} ${displayDesignation(e.designation, e.manufacturerAbbrev)}`;
  const uses = new Map<string, number>();
  for (const e of candidates) uses.set(shown(e), (uses.get(shown(e)) ?? 0) + 1);
  return new Map(candidates.map((e) => [
    e.motorId,
    (uses.get(shown(e)) ?? 0) > 1 ? `${maker(e)} ${e.designation}` : shown(e),
  ]));
}

/**
 * A row's identity: its configuration and the MULTISET of motor ids it flew.
 *
 * It is the table's React key. The combination rows used to be keyed on their
 * label, and labels repeat (see batchMotorNames), so a re-sorted list with
 * duplicate keys rendered 6 rows as 8 DOM rows in the audit's measurement; the
 * single-motor rows were keyed on their SORTED POSITION, so every insertion
 * remounted every row below it. Ids with their multiplicity keep 4+2's [A,A,B]
 * and [A,B,B] apart, and the tag keeps a 3+3 pair apart from the same two
 * motors in the 4+2 split.
 */
export function batchRowKey(configTag: string, motorIds: readonly string[]): string {
  return `${configTag}:${[...motorIds].sort().join('+')}`;
}

/**
 * The delay a candidate flies before any optimum is known — the SAME first
 * flight the motor browser gives the design page in the same mode, because a
 * motor must read the same in both places (v0.135, Eric 2026-09-18). Its
 * longest PRESCRIBED delay when it has one; for a motor with none:
 *
 *  - "optimal delay per motor" ticked: 0, as the browser's auto load flies it
 *    (MotorBrowser `load()`, `finite[finite.length - 1] ?? 0`) before App
 *    re-flies it at the rounded optimum. NOT plugged, even for a motor sold
 *    plugged only: the kernel takes its optimum from a coast probe when the
 *    recovery deploys before apogee, and from the flight's own apogee when
 *    nothing has deployed by then (BasicEventSimulationEngine, the APOGEE and
 *    RECOVERY_DEVICE_DEPLOYMENT cases), and the two sit a few hundredths of a
 *    second apart — enough to round to a different whole second. Flown
 *    plugged here, an Ellis I160 in a 50 mm test airframe took 10 s /
 *    1595.2 m against the design page's 9 s / 1594.9 m (measured 2026-09-22,
 *    in review of the row-407 fix below).
 *  - unticked: plugged (Infinity) when plugged is all it is sold as, the
 *    browser's default pick for such a motor. This used to be `?? 0` as well,
 *    so each plugged-only motor (604 of the catalogue's 1,156 as delayOptions
 *    reads them, 374 of those in production — measured 2026-09-22) flew with
 *    a charge at burnout that the motor does not have (audit 2026-09-22);
 *    flyLaunch resolves the explicit per-leg Auto policies.
 *
 * A motor that lists NO delay at all (delayOptions returns [] since the
 * row-363 fix; it used to read as [0]) starts at 0 in both modes. That is
 * what the browser flies too: its default pick for such a motor is "Auto
 * (optimal)" (`defaultDelay(picked) ?? 'auto'`), whose first flight is
 * `finite[finite.length - 1] ?? 0` before App re-flies at the optimum. So
 * the sweep re-flies such a candidate at its optimum even unticked — see
 * `listsNoDelay` and flyLegs.
 */
export function provisionalDelay(entry: TcMotor, autoDelay: boolean): number {
  const finite = delayOptions(entry).filter((d) => Number.isFinite(d));
  return autoDelay ? finite[finite.length - 1] ?? 0 : defaultDelay(entry) ?? 0;
}

/**
 * True when the catalogue lists no delay for this motor, so the browser would
 * default it to "Auto (optimal)". Unticked, the sweep flies such a candidate
 * as the browser would — at its rounded optimum — rather than with a charge
 * at burnout the motor was never sold with.
 */
export function listsNoDelay(entry: TcMotor): boolean {
  return defaultDelay(entry) === null;
}

/**
 * How many of a sweep's flights search for their optimum delay. The search's
 * probe flights make such a flight several times dearer than one at a fixed
 * delay, so the batch dialog's time estimate prices the two apart and needs
 * this count (review of the batch cap, 2026-10-01: it priced every flight of an
 * unticked sweep at a fixed delay). Every flight searches while "optimal delay
 * per motor" is ticked, or while a motor on another mount is on Auto (it is
 * solved on every flight). Unticked, flyLegs' rule: a flight searches when one
 * of its motors lists no delay at all, or when every one of its motors is sold
 * plugged only and the design deploys its recovery on the charge
 * (optimumForPlugged). The flights that do NOT search are the ones drawn
 * entirely from motors that list a delay, less those drawn entirely from the
 * plugged-only ones on such a design, and each count is the sweep's own: every
 * candidate alone, then each split's combinations (mixedComboCount).
 */
export function batchSolverFlights({ candidates, groups, autoDelay, deploysOnCharge, othersAuto }: {
  candidates: readonly TcMotor[];
  /** Each ticked split's group count (split.mountIds.length), as mixedComboCount takes it. */
  groups: readonly number[];
  autoDelay: boolean;
  /** deploysOnEjectionCharge of the design. */
  deploysOnCharge: boolean;
  /** A motor on a mount other than the swept one is on Auto delay. */
  othersAuto: boolean;
}): number {
  /** The flights drawn entirely from `n` of the candidates. */
  const flightsFrom = (n: number) => n + groups.reduce((sum, g) => sum + mixedComboCount(n, g), 0);
  const all = flightsFrom(candidates.length);
  if (autoDelay || othersAuto) return all;
  const listed = candidates.filter((e) => !listsNoDelay(e));
  const pluggedOnly = listed.filter((e) => provisionalDelay(e, false) === Infinity).length;
  return all - flightsFrom(listed.length) + (deploysOnCharge ? flightsFrom(pluggedOnly) : 0);
}

/** The deploy events the kernel does NOT read as the ejection charge (ComponentFactory.deployEventOf). */
const NOT_ON_CHARGE = new Set(['launch', 'apogee', 'altitude', 'never']);

/**
 * Does any recovery device in the design wait for the motor's ejection charge?
 * Read the way the kernel reads it: the event is lower-cased, and anything that
 * is not launch, apogee, altitude or never — a device with no event set
 * included — deploys on the charge.
 */
export function deploysOnEjectionCharge(tree: RocketTree): boolean {
  const walk = (nodes: readonly ComponentNode[]): boolean => nodes.some((n) =>
    ((n.type === 'parachute' || n.type === 'streamer')
      && !NOT_ON_CHARGE.has(String(n['deployEvent'] ?? 'ejection').toLowerCase()))
    || walk(n.children ?? []));
  return walk(tree.components);
}

/**
 * The same exception, said ON THE RUN. The dialog marks such a row "· opt.",
 * but the run is what reaches the history, the CSV and the XLSX, and there its
 * Delay column printed a delay the motor is not sold with and nothing said why
 * (review of the row-407 fix, 2026-09-22). So the run carries it as its last
 * comment — the report's text and the exports' Comments column — at 'info',
 * the level of the report's own plugged-motor and delay comments. No `|` in it:
 * the comments are stored joined on " | " and split back on it.
 */
export function notePluggedAtOptimum(run: SimRun, legs: number): void {
  const them = legs > 1 ? 'them' : 'it';
  const flown = run.delayResolution?.mounts.filter((m) => m.exception === 'plugged-on-charge');
  const delays = legs > 1 && flown?.length
    ? `per-mount optimum delays (${flown.map((m) => `${m.mountName}: ${m.flownDelay} s`).join(', ')})`
    : `the optimum delay of ${run.delayS} s`;
  const note = `${legs > 1 ? 'Every motor in this combination is' : 'This motor is'} sold plugged `
    + `(no ejection charge), and this design deploys its recovery on the motor’s charge, so the `
    + `batch flew ${them} at ${delays} rather than with no deployment at `
    + `all. To fly ${them} as sold, set the recovery to deploy at apogee or altitude.`;
  run.comments = run.comments === '' ? note : `${run.comments} | ${note}`;
  if (run.commentLevels) run.commentLevels = [...run.commentLevels, 'info'];
}

/** One row of the sweep. Its verdict is NOT stored here: the dialog grades in render, against the criteria it shows. */
export interface BatchRow {
  /** Stable identity and React key — see batchRowKey. */
  key: string;
  /** The (first) motor this row flew. */
  entry: MotorDbEntry;
  /** What the row is called: the candidate's name, or "3× A + 3× B" for a combination. */
  label: string;
  /** A mixed-cluster combination row rather than a single-motor one. */
  combo: boolean;
  run?: SimRun;
  error?: string;
  /** The equivalent stage exit this row flew (m), or null for none. */
  exitM?: number | null;
  /** A plugged-only motor flown at its optimum delay — see batchDelayRule. */
  optimumForPlugged?: boolean;
}

export interface BatchSweepInput {
  /** The editing tree — the sweep builds its OWN engine handles from it, so
   *  the design's shared handle is never touched. */
  tree: RocketTree;
  info: StaticInfo;
  /** Every motor mount in the design; the ones other than `target` fire alongside each candidate. */
  mounts: readonly BatchMountOption[];
  /** The mount being swept. */
  target: BatchMountOption;
  candidates: readonly MotorDbEntry[];
  /** The combination splits to fly after the single-motor pass; empty for none. */
  splits: readonly ClusterSplit[];
  /** Flown specs of the motors on the OTHER mounts, by mount id. */
  assignedMotors: Record<string, MotorSpec>;
  /** Catalogue specs and identities, before weighed hardware is applied. */
  assignedMountMotors: Record<string, MountMotor>;
  /** Their nozzle-database ids — catalogue motorId, or an imported motor's ex: id. */
  assignedMotorIds: Record<string, string | undefined>;
  /** Their ignition settings — a MotorSpec carries none. */
  assignedIgnitions: Record<string, { event: IgnitionEvent; delay: number }>;
  assignedAutoDelays?: Record<string, boolean>;
  weighed?: BatchWeighed;
  model: BatchModel;
  autoDelay: boolean;
  launch: LaunchConditions;
  rocketName: string;
}

export interface BatchSweepHooks {
  /**
   * Stop, and the dialog unmounting. Checked between flights and handed to
   * every download: Stop used to take effect only BETWEEN flights, so pressing
   * it during a motor download waited out the whole fetch.
   */
  signal: AbortSignal;
  onProgress?: (p: { done: number; total: number; current: string }) => void;
  /** After every flight, with every row so far (a fresh array). */
  onRows?: (rows: BatchRow[]) => void;
}

/** What a test swaps out: the network, the lazy nozzle table, and the yield to the browser. */
export interface BatchSweepDeps {
  fetchSpec: (motor: TcMotor, ejectionDelay: number, signal?: AbortSignal) => Promise<MotorSpec>;
  nozzleFor: typeof nozzleForMotorId;
  /** Lets the progress bar paint between flights. */
  yieldToUi: () => Promise<void>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Fly the sweep. Resolves with every row, and whether it was stopped; a flight
 * that fails becomes an error row, and a download cut short by Stop becomes
 * nothing at all — it was never flown, so "could not be flown" would be false.
 */
export async function runBatchSweep(
  input: BatchSweepInput,
  hooks: BatchSweepHooks,
  deps: Partial<BatchSweepDeps> = {},
): Promise<{ rows: BatchRow[]; stopped: boolean }> {
  const {
    fetchSpec = fetchMotorSpec,
    nozzleFor = nozzleForMotorId,
    yieldToUi = () => new Promise<void>((r) => { setTimeout(r, 0); }),
  } = deps;
  const {
    tree, info, mounts, target, candidates, splits, assignedMotors, assignedMotorIds, assignedIgnitions,
    weighed, model, autoDelay, launch, rocketName,
  } = input;
  const { signal } = hooks;
  const kbf = model !== 'eb';
  const aeroMode: AeroMode = model === 'eb' || model === 'kbf' ? 'classic' : model;

  // Mounts other than the target keep their assigned motors for every flight.
  const applyOthers = (r: OrkRocket, targetIds: string[]) => {
    for (const [id, spec] of Object.entries(assignedMotors)) {
      if (!targetIds.includes(id)) {
        try {
          // THE DESIGN PAGE'S OWN WRITE (flightRunner.writeMountMotor). It
          // puts the ignition back after the motor — `setMotorById` installs a
          // fresh MotorConfiguration, so the mount would land on AUTOMATIC
          // whatever the design says — and it REFUSES, before the motor goes
          // on, an event the kernel does not know. This loop wrote the motor
          // first and then swallowed the ignition throw, so such a motor flew
          // here on AUTOMATIC while the design page flew without it: 240.34 m
          // against 122.06 m for the same design and motor (the row-283 gap,
          // seam review of audit 2026-09-22). One write here covers the sweep
          // AND both combination passes, because every per-candidate write
          // below touches only the TARGET mounts, which this loop skips.
          writeMountMotor(r, id, spec, assignedIgnitions[id] ?? { event: 'automatic', delay: 0 });
        } catch { /* mount absent in variant, or refused as on the design page (reported there) */ }
      }
    }
  };
  // THE SWEEP FLIES PUBLISHED CURVES (2026-09-08). Since the pressure-thrust
  // term went in, a stage's `nozzleExitDiameter` buys thrust as well as
  // trimming base drag — and this sweep builds ONE rocket from the design
  // and swaps candidates onto it, so the design's own nozzle would be
  // credited to every motor in the list. On a 100 N H at a 10 kPa mean
  // deficit a 1.875 in exit is worth about +18 % of thrust, which is a
  // comparison between motors decided by a number that belongs to none of
  // them. Stripped for the whole sweep — both the single-motor pass and the
  // combination passes below.
  const sweepTree = clearStageNozzles(tree);

  /*
   * EACH CANDIDATE FLIES ITS OWN PUBLISHED NOZZLE EXIT.
   *
   * The design's own nozzle is still stripped first — crediting one motor's
   * exit to every candidate is the bug the strip was written for — but the
   * stage's exit is then re-applied per candidate from the nozzle database,
   * so a motor gives the same answer here as it does on the design page.
   * Eric, 2026-09-18: "if we default the single motor launch to using the
   * nozzle data in our database, but do not use it in batch sims, the user
   * would see two different results for the same motor and lose trust."
   *
   * The nozzle is geometry, so it cannot be set per flight the way a motor
   * can — it needs its own engine handle. Handles are therefore POOLED on the
   * equivalent exit diameter: a 54 mm sweep has a handful of distinct exits
   * across ~180 candidates, so this is a few builds (0.8 ms each) against
   * 600 ms a flight. Never call resetEngine() in here: it frees every handle
   * including the design's.
   */
  const stageIdOfTarget = stageIdByNode(tree).get(target.id) ?? '';
  const stageNameOfTarget = tree.components
    .find((st) => st.id === stageIdOfTarget)?.name ?? 'Sustainer';
  const handlePool = (base: RocketTree, exclude: string[]) => {
    const pool = new Map<string, OrkRocket>();
    return (equivM: number | null): OrkRocket => {
      const usable = equivM !== null && Number.isFinite(equivM) && equivM > 0 && stageIdOfTarget !== '';
      const key = usable ? (equivM as number).toFixed(6) : 'none';
      const hit = pool.get(key);
      if (hit) return hit;
      const t = usable ? applyStageNozzles(base, { [stageIdOfTarget]: equivM as number }) : base;
      const r = OrkRocket.buildTree(engineTree(t));
      r.setRogersModifiedBarrowman(kbf);
      r.setSupersonicAero(model === 'supersonic');
      r.setHybridAero(model === 'hybrid');
      applyOthers(r, exclude);
      pool.set(key, r);
      return r;
    };
  };
  const sweepHandle = handlePool(sweepTree, [target.id]);

  /*
   * The motors firing BESIDE the candidate, on the same stage. A batch refuses
   * a staged rocket, so every mount here is on the one stage and every one of
   * them contributes its exit area to the equivalent nozzle. An imported EX
   * motor is in this list by its ex: id since audit 2026-09-22; before that App
   * handed over `meta.motorId` alone, which an EX motor never has, so its mount
   * silently dropped out of the sum.
   */
  const otherParts = await Promise.all(mounts
    .filter((m) => m.id !== target.id && assignedMotorIds[m.id])
    .map(async (m) => ({
      count: m.motorCount ?? 1,
      exitDiameterM: (await nozzleFor(assignedMotorIds[m.id]))?.exitDiameterM ?? null,
    })));

  /*
   * The one case where the database is not the answer: the user has typed
   * their own exit over the published one, and the candidate IS the motor
   * they typed it for. Then that row flies what they typed — which is what
   * makes "the same motor reads the same in both places" true without
   * exception, including for a machined-out nozzle the app cannot look up.
   * The field is already the whole stage's equivalent, so it is used as-is.
   */
  const typedStageExitM = (() => {
    const st = stagesWithNozzle(tree).find((s) => s.id === stageIdOfTarget);
    return st && st.exitDiameterM > 0 ? st.exitDiameterM : null;
  })();
  const loadedIdOnTarget = assignedMotorIds[target.id];

  /** The equivalent stage exit this candidate should fly, or null for none. */
  const exitForCandidate = async (e: MotorDbEntry, count: number): Promise<number | null> =>
    batchStageExit({
      candidateId: e.motorId,
      count,
      ownExitM: (await nozzleFor(e.motorId))?.exitDiameterM ?? null,
      otherParts,
      typedStageExitM,
      loadedIdOnTarget,
    });
  // The shared construction — this used to be a private copy that omitted
  // `timeStep`, so a design carrying its own step from its .ork gave one set
  // of numbers here and a different set on the Launch button.
  const simOpts = kernelSimOptions(launch);
  const deploysOnCharge = deploysOnEjectionCharge(tree);
  const names = batchMotorNames(candidates);
  // @atestani, TRF #162, 2026-10-06: maker display must not rewrite exported runs.
  const storedNames = batchMotorNames(candidates, false);

  /**
   * ONE FLIGHT, for either pass: the model choice, the Mach backstop and the
   * delay rule. `legs` is the target mount's motor for a single-motor row, or
   * one entry per group mount for a combination.
   */
  const flyLegs = async (
    rocket: OrkRocket,
    legs: readonly {
      mountId: string;
      entry: MotorDbEntry;
      spec: MotorSpec;
      meta?: MotorMeta;
      noListedDelay?: boolean;
    }[],
    probeTree: RocketTree,
    replacedMountId?: string,
  ) => {
    const optimumForPlugged = !autoDelay && deploysOnCharge
      && legs.every((l) => l.spec.ejectionDelay === Infinity && !l.noListedDelay);
    const liveMountIds = new Set(motorMounts(probeTree).map((m) => m.id));
    const assigned: [string, MountMotor][] = Object.entries(assignedMotors)
      .filter(([id]) => liveMountIds.has(id) && id !== replacedMountId && !legs.some((l) => l.mountId === id))
      .map(([id, spec]) => {
        const label = motorLabel(motorLabelEntry({ spec,
          meta: { ...input.assignedMountMotors[id]?.meta, label: '', motorId: assignedMotorIds[id] } }), spec.ejectionDelay,
        { autoDelay: input.assignedAutoDelays?.[id] === true });
        return [id, {
          spec, label,
          meta: {
            label,
            motorId: assignedMotorIds[id],
            ...(assignedMotorIds[id]?.startsWith('ex:') ? { exMotorId: assignedMotorIds[id] } : {}),
            autoDelay: input.assignedAutoDelays?.[id] === true,
          },
          ignition: assignedIgnitions[id] ?? { event: 'automatic', delay: 0 },
        }];
      });
    for (const l of legs) {
      const meta = {
        autoDelay: autoDelay || !!l.noListedDelay || optimumForPlugged,
        ...l.meta,
      };
      const label = motorLabel(l.entry, l.spec.ejectionDelay, meta);
      assigned.push([l.mountId, {
        spec: l.spec, label, meta: { ...meta, label },
        ignition: { event: 'automatic', delay: 0 },
      }]);
    }
    const flight = await flyLaunch(rocket, {
      assigned, hardware: undefined, primaryMountId: legs[0]!.mountId,
      mountNames: Object.fromEntries(mounts.map((m) => [m.id, m.label])),
      simOptions: simOpts, aeroMode, supersonic: model === 'supersonic',
      isOnLaunchStage: (id) => isOnLaunchStage(probeTree, id),
      onSupersonicUpgrade: () => {}, signal, yieldToUi,
    });
    if (optimumForPlugged) {
      for (const m of flight.delayResolution.mounts) {
        if (legs.some((l) => l.mountId === m.mountId)) m.exception = 'plugged-on-charge';
      }
    }
    return {
      res: flight.result, execMs: flight.execMs, flownDelay: flight.flownDelayS,
      delayResolution: flight.delayResolution, primaryMountId: legs[0]!.mountId,
      optimumForPlugged, autoDelay: autoDelay || !!legs[0]?.noListedDelay,
      aeroModel: aeroModelFor(aeroMode, flight.usedSupersonic),
      rogersKbf: rogersKbfFor(kbf, flight.usedSupersonic),
      // Provenance keys catalogue curves; hardware has its own motor-set term.
      assigned: assigned.map(([id, mm]): [string, MountMotor] => [id,
        !legs.some((l) => l.mountId === id) ? { ...mm, ...input.assignedMountMotors[id] } : mm,
      ]),
      otherHardwareDeltaKg: weighed && weighed.mountId !== target.id
        && assigned.some(([id]) => id === weighed.mountId) ? weighed.deltaKg : 0,
    };
  };

  const n = candidates.length;
  const total = n + splits.reduce((sum, s) => sum + mixedComboCount(n, s.mountIds.length), 0);
  const comboActive = splits.length > 0;
  const out: BatchRow[] = [];
  // Motor specs fetched in the single pass, reused by the combination pass.
  const specCache = new Map<string, MotorSpec>();

  const aero = { aeroMode, effectiveKbf: kbf, autoSupersonic: model === 'auto' };

  for (let i = 0; i < n; i++) {
    if (signal.aborted) break;
    const entry = candidates[i]!;
    const label = names.get(entry.motorId)!;
    const key = batchRowKey('single', [entry.motorId]);
    hooks.onProgress?.({ done: i, total, current: label });
    await yieldToUi();
    try {
      const spec = await fetchSpec(entry, provisionalDelay(entry, autoDelay), signal);
      specCache.set(entry.motorId, spec);
      // What this candidate FLIES: the catalogue spec, or — for the one
      // motor the pad mass was weighed with, on the mount it was weighed
      // on — that spec with the hardware on it, exactly as the design page
      // flies it. The cache keeps the catalogue spec on purpose: the
      // combination passes below stay at catalogue weight, because a mixed
      // multiset has no honest single adapter.
      const flown = batchFlownSpec(entry, spec, target.id, weighed);
      // This candidate's own stage nozzle, and the handle carrying it. Null
      // for a motor with no published exit — about two thirds of a 54 mm
      // sweep — which gets the nozzle-free handle and today's numbers.
      const exitM = await exitForCandidate(entry, target.motorCount);
      const keyTree = stageIdOfTarget !== '' && (exitM !== null || typedStageExitM !== null)
        ? applyStageNozzles(tree, { [stageIdOfTarget]: exitM }) : tree;
      const f = await flyLegs(sweepHandle(exitM),
        [{
          mountId: target.id,
          entry,
          spec: flown,
          meta: {
            label: motorLabel(entry, flown.ejectionDelay, { autoDelay }),
            manufacturer: entry.manufacturerAbbrev,
            motorId: entry.motorId,
            ...(entry.motorId.startsWith('ex:') ? { exMotorId: entry.motorId } : {}),
          },
          noListedDelay: listsNoDelay(entry),
        }], tree);
      const provenance = provenanceKeyOf({
        physicsKey: physicsKeyOf(keyTree.components),
        tree: keyTree,
        // The plugged exception flew Auto, whose design-page placeholder is 0.
        assigned: f.assigned.map(([id, mm]) => [id, id === target.id ? {
          ...mm, spec: f.optimumForPlugged ? { ...spec, ejectionDelay: provisionalDelay(entry, true) } : spec,
        } : mm]),
        hardwareDeltaKg: weighed && target.id === weighed.mountId && isWeighedCandidate(entry, weighed) ? weighed.deltaKg : f.otherHardwareDeltaKg,
        launch,
        aero,
      });
      const run = buildSimRun({
        result: f.res,
        delayResolution: f.delayResolution, primaryMountId: f.primaryMountId,
        info,
        motor: { ...flown, ejectionDelay: f.flownDelay },
        meta: {
          label: motorLabel(entry, f.flownDelay, { autoDelay: f.autoDelay }),
          manufacturer: entry.manufacturerAbbrev,
          availableDelays: delayOptions(entry).filter((d) => Number.isFinite(d)),
          autoDelay: f.autoDelay,
          type: entry.type,
          propellant: entry.propInfo,
          motorCase: entry.caseInfo,
          motorCount: target.motorCount,
          highPower: isHighPower(entry),
        },
        launch,
        rocketName,
        execMs: f.execMs,
        aeroModel: f.aeroModel,
        rogersKbf: f.rogersKbf,
        // Stamped only when this row actually flew a nozzle, the same way the
        // design page stamps it — it is what the launch report keys its
        // pressure-thrust note off, and what marks the row in the table.
        ...(exitM !== null ? { nozzleStages: [stageNameOfTarget] } : {}),
        ...(comboActive ? { motorConfig: 'single' } : {}),
        designKey: provenance.designKey,
        motorSetKey: provenance.motorSetKey,
        motorDataKey: provenance.motorDataKey,
        motorDataKeys: provenance.motorDataKeys,
      });
      if (f.optimumForPlugged) notePluggedAtOptimum(run, 1);
      out.push({
        key, entry, label, combo: false, run, exitM,
        ...(f.optimumForPlugged ? { optimumForPlugged: true } : {}),
      });
    } catch (e) {
      // Stop during a download is not a motor that "could not be flown".
      if (signal.aborted) break;
      out.push({ key, entry, label, combo: false, error: errorText(e) });
    }
    hooks.onRows?.([...out]);
  }

  // ---- Combination passes (opt-in): symmetric group splits of the
  // cluster, each on a SEPARATE engine handle (the design handle is
  // untouched). Group mode = 2 halves (2+2 / 3+3, unordered pairs of
  // candidates); pair mode (6-ring) = 3 opposite-tube pairs, flying every
  // MULTISET of candidates except all-same (covers 4+2 and 2+2+2 —
  // the owner's real-world configs, 2026-08-05d).
  let done = n;
  for (const split of splits) {
    if (signal.aborted) break;
    // Same strip and the same per-candidate re-apply as the single-motor
    // pass: `split.tree` is derived from the DESIGN tree, so it carries the
    // design's nozzles too, and its own pool is keyed on the equivalent exit
    // of whatever multiset is flying.
    const comboHandle = handlePool(clearStageNozzles(split.tree), [...split.mountIds, target.id]);
    // What each group mount FIRES: its group times every enclosing pod set or
    // strap-on ring (mountMotorCount on the split tree, the groups sitting
    // where the cluster sat). `split.groupSize` is the group alone, so a 4-ring
    // in a three-pod set was labelled "2× A + 2× B", stored as 4 motors and
    // given four motors' equivalent exit where the kernel burns twelve (audit
    // 2026-09-22, row 351, from review — the single-motor pass above already
    // counted the pods through `target.motorCount`).
    const groupFires = split.mountIds.map((id) => mountMotorCount(split.tree, id));
    for (const idxs of comboAssignments(n, split.mountIds.length)) {
      if (signal.aborted) break;
      const entries = idxs.map((i) => candidates[i]!);
      // Collapse equal groups for the label: [A,A,B] → "4× A + 2× B", each
      // group counted as the motors it fires (pods included).
      const counts = new Map<string, { entry: MotorDbEntry; fires: number }>();
      entries.forEach((e, k) => {
        const cur = counts.get(e.motorId);
        if (cur) cur.fires += groupFires[k]!;
        else counts.set(e.motorId, { entry: e, fires: groupFires[k]! });
      });
      const label = [...counts.values()]
        .map(({ entry: e, fires }) => `${fires}× ${names.get(e.motorId)!}`)
        .join(' + ');
      const configTag = split.mountIds.length === 2
        ? `mixed ${split.groupSize}+${split.groupSize}`
        : counts.size === 2 ? 'mixed 4+2' : 'mixed 2+2+2';
      const key = batchRowKey(configTag, entries.map((e) => e.motorId));
      hooks.onProgress?.({ done, total, current: label });
      done++;
      await yieldToUi();
      try {
        const specs = await Promise.all(entries.map(async (e) => {
          const hit = specCache.get(e.motorId);
          if (hit) return hit;
          // Only a candidate whose single-motor flight failed gets here; it
          // flies the same provisional delay that flight would have.
          const spec = await fetchSpec(e, provisionalDelay(e, autoDelay), signal);
          specCache.set(e.motorId, spec);
          return spec;
        }));
        /*
         * The multiset's own equivalent nozzle. split.tree has already broken
         * the cluster into one mount per group, so each entry contributes its
         * group's worth of exits; equivalentExitDiameterM sums the AREAS and
         * returns null the moment any leg is unknown — which is the honest
         * answer for a mixed combination the database only half covers.
         */
        const comboParts = entries.map(async (e, k) => ({
          count: groupFires[k]!,
          exitDiameterM: (await nozzleFor(e.motorId))?.exitDiameterM ?? null,
        }));
        const exitM = equivalentExitDiameterM([...await Promise.all(comboParts), ...otherParts]);
        // Group mount ids are temporary flight machinery, not a design edit.
        const keyTree = stageIdOfTarget !== '' && (exitM !== null || typedStageExitM !== null)
          ? applyStageNozzles(tree, { [stageIdOfTarget]: exitM }) : tree;
        // The split tree is what this candidate flies — its group mounts do
        // not exist in `tree`, and the replaced cluster mount's motor is not
        // aboard (see batchProbeCutoff).
        const f = await flyLegs(comboHandle(exitM),
          split.mountIds.map((id, k) => ({
            mountId: id,
            entry: entries[k]!,
            spec: specs[k]!,
            meta: {
              label: motorLabel(entries[k]!, specs[k]!.ejectionDelay, { autoDelay }),
              manufacturer: entries[k]!.manufacturerAbbrev,
              motorId: entries[k]!.motorId,
              ...(entries[k]!.motorId.startsWith('ex:') ? { exMotorId: entries[k]!.motorId } : {}),
            },
            noListedDelay: listsNoDelay(entries[k]!),
          })),
          split.tree, target.id);
        const manuf = [...new Set(entries.map((e) => e.manufacturerAbbrev))].join('+');
        const provenance = provenanceKeyOf({
          physicsKey: physicsKeyOf(keyTree.components),
          tree: keyTree,
          assigned: f.assigned.map(([id, mm]) => {
            const leg = split.mountIds.indexOf(id);
            return [id, f.optimumForPlugged && leg >= 0 ? {
              ...mm, spec: { ...mm.spec, ejectionDelay: provisionalDelay(entries[leg]!, true) },
            } : mm];
          }),
          hardwareDeltaKg: f.otherHardwareDeltaKg,
          launch,
          aero,
        });
        const run = buildSimRun({
          result: f.res,
          delayResolution: f.delayResolution, primaryMountId: f.primaryMountId,
          info,
          motor: { ...specs[0]!, ejectionDelay: f.flownDelay },
          meta: {
            label,
            manufacturer: manuf,
            autoDelay: f.autoDelay,
            motorCount: groupFires.reduce((a, b) => a + b, 0),
            highPower: entries.some((e) => isHighPower(e)),
          },
          launch,
          rocketName,
          execMs: f.execMs,
          aeroModel: f.aeroModel,
          rogersKbf: f.rogersKbf,
          ...(exitM !== null ? { nozzleStages: [stageNameOfTarget] } : {}),
          motorConfig: configTag,
          designKey: provenance.designKey,
          motorSetKey: provenance.motorSetKey,
          motorDataKey: provenance.motorDataKey,
          motorDataKeys: provenance.motorDataKeys,
        });
        // The stored designation is the combo label so saved runs read right.
        run.motor = [...counts.values()]
          .map(({ entry: e, fires }) => `${fires}× ${storedNames.get(e.motorId)!}`)
          .join(' + ');
        if (f.optimumForPlugged) notePluggedAtOptimum(run, entries.length);
        out.push({
          key, entry: entries[0]!, label, combo: true, run, exitM,
          ...(f.optimumForPlugged ? { optimumForPlugged: true } : {}),
        });
      } catch (e) {
        if (signal.aborted) break;
        out.push({ key, entry: entries[0]!, label, combo: true, error: errorText(e) });
      }
      hooks.onRows?.([...out]);
    }
  }

  return { rows: out, stopped: signal.aborted };
}
