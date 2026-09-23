import {
  OrkRocket, type ComponentNode, type FlightResult, type IgnitionEvent, type MotorSpec, type RocketTree,
  type StaticInfo,
} from '@online-openrocket/engine';
import {
  applyStageNozzles, clearStageNozzles, engineTree, isOnLaunchStage, stageIdByNode, stagesWithNozzle,
  type ClusterSplit,
} from '../tree/treeModel.js';
import { equivalentExitDiameterM } from './nozzleFollow.js';
import { nozzleForMotorId } from './nozzleDb.js';
import { displayDesignation, isHighPower, type MotorDbEntry } from './motorDb.js';
import { defaultDelay, delayOptions, fetchMotorSpec, type TcMotor } from './thrustcurve.js';
import { motorIdentity, shiftMotorMass } from './hardwareMass.js';
import { buildSimRun, recommendDelay, type MotorMeta, type SimRun } from './simReport.js';
import { aeroModelFor, rogersKbfFor, type AeroMode } from './flightPipeline.js';
import { MACH_AUTO_THRESHOLD, machProbeSeconds } from './machProbe.js';
import { kernelSimOptions, type LaunchConditions } from '../components/LaunchPanel.js';

/**
 * THE BATCH SWEEP — every flight Batch Simulate flies, out of the component.
 *
 * It lived as `start()`, a ~407-line closure inside BatchSimulate.tsx whose two
 * flight passes (single motors, then the mixed-cluster combinations) were two
 * hand-kept copies of one procedure. They had drifted by the 22 September 2026
 * audit: the single pass skipped a re-fly the combination pass always paid for,
 * both hand-rolled the aero stamps `flightPipeline` already owns, and every
 * batch fix had to be applied twice. Here there is ONE flight (`flyLegs`), ONE
 * delay rule (`batchDelayRule`) and ONE nozzle rule (`batchStageExit`), and a
 * single motor is simply a combination of one leg.
 *
 * The dialog keeps what is the dialog's: the filters, the criteria and their
 * grading (done in render, so a verdict follows the criteria shown above it),
 * the progress bar, and what goes into the run history.
 */

/** The aero model the batch flies — its own, deliberately independent of the design page's (BatchSimulate says why). */
export type BatchModel = 'eb' | 'kbf' | 'auto' | 'supersonic';

export interface BatchMountOption {
  id: string;
  label: string;
  diameterMm: number;
  /** Cluster count — each candidate fires ×N. */
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

/** A candidate's identity spelled the way MountMotor identities are: EX entries by their ex: id. */
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

/** The spec a candidate flies: shifted by the weighed hardware ONLY when it is the weighed motor on the weighed mount. Delay is not part of the identity. */
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
  candidates: readonly Pick<MotorDbEntry, 'motorId' | 'manufacturerAbbrev' | 'designation'>[],
): Map<string, string> {
  const shown = (e: Pick<MotorDbEntry, 'manufacturerAbbrev' | 'designation'>) =>
    `${e.manufacturerAbbrev} ${displayDesignation(e.designation, e.manufacturerAbbrev)}`;
  const uses = new Map<string, number>();
  for (const e of candidates) uses.set(shown(e), (uses.get(shown(e)) ?? 0) + 1);
  return new Map(candidates.map((e) => [
    e.motorId,
    (uses.get(shown(e)) ?? 0) > 1 ? `${e.manufacturerAbbrev} ${e.designation}` : shown(e),
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
 *    batchDelayRule decides what a flight with no charge then flies.
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
 * THE DELAY RULE, for one flight of one candidate — a single motor or every leg
 * of a combination — after its first flight at `provisionalDelay`.
 *
 * With "optimal delay per motor" ticked every row flies the kernel's optimum,
 * rounded to the whole second a flyer can drill, and re-flies only when some leg
 * is not already sitting at it. The two passes used to disagree on that last
 * clause: the single pass skipped the redundant flight and the combination pass
 * flew it every time. Skipping is right — the kernel is seeded (42 unless the
 * caller says otherwise), so flying the same delays again returns the same
 * flight — and it is now the rule for both.
 *
 * Unticked, each leg keeps its own prescribed delay, and the row records the
 * EARLIEST charge, which is the one that deploys the recovery. The one
 * exception is a flight with no charge at all (every leg plugged-only) on a
 * design whose recovery waits for that charge: flown plugged it would never
 * deploy, and flown at the old `?? 0` it deployed at burnout — the audit
 * measured the F13-RCT at 476.1 m against 706.6 m, 32.6 % low, graded "too
 * low" and ranked last. It flies its optimum instead, and `optimumForPlugged`
 * says so on the row. On a design that deploys at apogee or altitude a plugged
 * motor is flown plugged, which is exactly how it would fly.
 */
export function batchDelayRule(input: {
  /** The delay each leg flew the first flight at; Infinity is plugged. */
  flownDelays: readonly number[];
  /** The kernel's optimum from that flight: a coast probe's if it deployed before apogee, else its own apogee's. */
  optimum: number | null;
  autoDelay: boolean;
  deploysOnCharge: boolean;
}): { delay: number; refly: boolean; optimumForPlugged: boolean } {
  const { flownDelays, optimum, autoDelay, deploysOnCharge } = input;
  const earliest = Math.min(...flownDelays);
  const noCharge = flownDelays.every((d) => !Number.isFinite(d));
  if (!autoDelay && !(noCharge && deploysOnCharge)) {
    return { delay: earliest, refly: false, optimumForPlugged: false };
  }
  const rec = recommendDelay(optimum);
  if (rec === null) return { delay: earliest, refly: false, optimumForPlugged: false };
  return { delay: rec, refly: flownDelays.some((d) => d !== rec), optimumForPlugged: !autoDelay };
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
  const note = `${legs > 1 ? 'Every motor in this combination is' : 'This motor is'} sold plugged `
    + `(no ejection charge), and this design deploys its recovery on the motor’s charge, so the `
    + `batch flew ${them} at the optimum delay of ${run.delayS} s rather than with no deployment at `
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
  /** Their nozzle-database ids — catalogue motorId, or an imported motor's ex: id. */
  assignedMotorIds: Record<string, string | undefined>;
  /** Their ignition settings — a MotorSpec carries none. */
  assignedIgnitions: Record<string, { event: IgnitionEvent; delay: number }>;
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
  const aeroMode: AeroMode = model === 'auto' ? 'auto' : model === 'supersonic' ? 'supersonic' : 'classic';

  // Mounts other than the target keep their assigned motors for every flight.
  const applyOthers = (r: OrkRocket, targetIds: string[]) => {
    for (const [id, spec] of Object.entries(assignedMotors)) {
      if (!targetIds.includes(id)) {
        try {
          r.setMotorById(id, spec);
          // …and put the ignition back, exactly as the Launch path does
          // (App.tsx:1342). The write above installs a fresh
          // MotorConfiguration, so the mount lands on AUTOMATIC whatever the
          // design says. One restore here covers the sweep AND both
          // combination passes, because every per-candidate write below
          // touches only the TARGET mounts, which this loop skips.
          const ig = assignedIgnitions[id];
          if (ig && (ig.event !== 'automatic' || ig.delay !== 0)) {
            r.setMotorIgnitionById(id, ig.event, ig.delay);
          }
        } catch { /* mount absent in variant */ }
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

  /**
   * ONE FLIGHT, for either pass: the model choice, the Mach backstop and the
   * delay rule. `legs` is the target mount's motor for a single-motor row, or
   * one entry per group mount for a combination.
   */
  const flyLegs = (
    rocket: OrkRocket,
    legs: readonly { mountId: string; spec: MotorSpec; noListedDelay?: boolean }[],
    probeTree: RocketTree,
    replacedMountId?: string,
  ) => {
    // execMs must mean ONE flight at this step: the launch panel's
    // time-step caution prices a reload from the newest stored run
    // (storedSimCost), and a span covering the probe plus a re-fly
    // quoted 2-3x the real wait — the same over-billing the single-flight
    // path fixed by timing each full flight alone.
    let execMs = 0;
    const flyTimed = (): FlightResult => {
      const t0 = performance.now();
      const r = rocket.simulate(simOpts);
      execMs = performance.now() - t0;
      return r;
    };
    // Auto: each candidate picks its model from a SHORT probe run and then
    // flies once — per MOTOR, exactly like the single-flight Auto loop.
    // This used to fly the whole classic flight and, on a supersonic
    // candidate, throw it away and fly the whole thing again, per candidate.
    if (model === 'auto') rocket.setSupersonicAero(false);
    for (const l of legs) rocket.setMotorById(l.mountId, l.spec);
    let usedSupersonic = model === 'supersonic';
    if (model === 'auto') {
      const probe = rocket.simulate({
        ...simOpts,
        maxTime: batchProbeCutoff(probeTree, assignedMotors,
          Object.fromEntries(legs.map((l) => [l.mountId, l.spec])), replacedMountId),
      });
      if (probe.summary.maxMachNumber > MACH_AUTO_THRESHOLD) {
        rocket.setSupersonicAero(true);
        usedSupersonic = true;
      }
    }
    let res = flyTimed();
    // Backstop on the probe's verdict: the cutoff over-estimates on purpose,
    // but the full flight now holds the real peak Mach — if Auto flew classic
    // and the flight still crossed the threshold, re-fly supersonic. Near-free
    // on average: it only triggers where the probe under-read.
    if (model === 'auto' && !usedSupersonic && res.summary.maxMachNumber > MACH_AUTO_THRESHOLD) {
      rocket.setSupersonicAero(true);
      usedSupersonic = true;
      res = flyTimed();
    }
    // A candidate whose every motor lists no delay flies its optimum even
    // unticked — the browser's "Auto (optimal)" default for such a motor.
    const legsAuto = autoDelay || (legs.length > 0 && legs.every((l) => l.noListedDelay));
    const plan = batchDelayRule({
      flownDelays: legs.map((l) => l.spec.ejectionDelay),
      optimum: res.summary.optimumDelay,
      autoDelay: legsAuto,
      deploysOnCharge,
    });
    if (plan.refly) {
      for (const l of legs) rocket.setMotorById(l.mountId, { ...l.spec, ejectionDelay: plan.delay });
      res = flyTimed();
    }
    return {
      res,
      execMs,
      flownDelay: plan.delay,
      optimumForPlugged: plan.optimumForPlugged,
      autoDelay: legsAuto,
      // Both stamps are permanent on the stored run, and flightPipeline owns
      // them — these were hand-rolled copies of it, twice over.
      aeroModel: aeroModelFor(aeroMode, usedSupersonic),
      rogersKbf: rogersKbfFor(kbf, usedSupersonic),
    };
  };

  const n = candidates.length;
  const total = n + splits.reduce((sum, s) => sum + mixedComboCount(n, s.mountIds.length), 0);
  const comboActive = splits.length > 0;
  const out: BatchRow[] = [];
  // Motor specs fetched in the single pass, reused by the combination pass.
  const specCache = new Map<string, MotorSpec>();

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
      const f = flyLegs(sweepHandle(exitM),
        [{ mountId: target.id, spec: flown, noListedDelay: listsNoDelay(entry) }], tree);
      const run = buildSimRun({
        result: f.res,
        info,
        motor: { ...flown, ejectionDelay: f.flownDelay },
        meta: {
          label: entry.designation,
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
    for (const idxs of comboAssignments(n, split.mountIds.length)) {
      if (signal.aborted) break;
      const entries = idxs.map((i) => candidates[i]!);
      // Collapse equal groups for the label: [A,A,B] → "4× A + 2× B".
      const counts = new Map<string, { entry: MotorDbEntry; groups: number }>();
      for (const e of entries) {
        const cur = counts.get(e.motorId);
        if (cur) cur.groups++;
        else counts.set(e.motorId, { entry: e, groups: 1 });
      }
      const label = [...counts.values()]
        .map(({ entry: e, groups }) => `${groups * split.groupSize}× ${names.get(e.motorId)!}`)
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
        const comboParts = entries.map(async (e) => ({
          count: split.groupSize,
          exitDiameterM: (await nozzleFor(e.motorId))?.exitDiameterM ?? null,
        }));
        const exitM = equivalentExitDiameterM([...await Promise.all(comboParts), ...otherParts]);
        // The split tree is what this candidate flies — its group mounts do
        // not exist in `tree`, and the replaced cluster mount's motor is not
        // aboard (see batchProbeCutoff).
        const f = flyLegs(comboHandle(exitM),
          split.mountIds.map((id, k) => ({ mountId: id, spec: specs[k]!, noListedDelay: listsNoDelay(entries[k]!) })),
          split.tree, target.id);
        const manuf = [...new Set(entries.map((e) => e.manufacturerAbbrev))].join('+');
        const run = buildSimRun({
          result: f.res,
          info,
          motor: { ...specs[0]!, ejectionDelay: f.flownDelay },
          meta: {
            label,
            manufacturer: manuf,
            autoDelay: f.autoDelay,
            motorCount: split.groupSize * split.mountIds.length,
            highPower: entries.some((e) => isHighPower(e)),
          },
          launch,
          rocketName,
          execMs: f.execMs,
          aeroModel: f.aeroModel,
          rogersKbf: f.rogersKbf,
          ...(exitM !== null ? { nozzleStages: [stageNameOfTarget] } : {}),
          motorConfig: configTag,
        });
        // The stored designation is the combo label so saved runs read right.
        run.motor = label;
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
