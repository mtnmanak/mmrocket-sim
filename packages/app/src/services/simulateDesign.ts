import { recordFlightOverrides, type RecordedFlightOverride } from './flightOverrideSummary.js';
import { activeFlightOverrides } from './flightState.js';
import type { FlightResult, OrkRocket, RocketTree } from '@online-openrocket/engine';
import { savedConfigLabel, type MountMotor, type SavedConfig } from '../model/design.js';
import { effectiveAero } from '../prefs/aeroChoice.js';
import { DEFAULT_PREFS } from '../prefs/preferences.js';
import { INITIAL_UNITS, type UnitSelection } from '../prefs/units.js';
import { resolveFlightState } from './flightState.js';
import { withActiveConfigSynced } from './configSync.js';
import type { OrkMotorRef } from './orkFile.js';
import { isOnLaunchStage, motorisedStagesWithNozzle, mountMotorCount, stageRecoveryById, stagesWithRecoveryDevice } from '../tree/treeModel.js';
import { APP_VERSION } from '../version.js';
import { buildDesign, KERNEL_HANDLES, type BuildHandle, type BuiltDesign, type HandleFactory } from './buildDesign.js';
import {
  deriveLaunchInputs, designBuildInputOf, hardwareDeltaKgOf, legacyPadMassStepOf, mountNamesOf, provenanceKeyOf,
  refusedMountIdsOf, type AeroState, type Assigned, type DesignState, type LaunchDerivation,
} from './designDerivation.js';
import { aeroModelFor, rogersKbfFor, stageMotorInfo } from './flightPipeline.js';
import { flyLaunch, type LaunchFlight } from './flightRunner.js';
import { DEFAULT_TIME_STEP_S, kernelSimOptions, type LaunchConditions } from './launchConditions.js';
import { applyLegacyPadMassStep } from './padMassReconcile.js';
import type { HeldNote } from './notices.js';
import { buildSimRun, type DesignMatchKey, type FreshSimRun } from './simReport.js';
import { normalizeFlightAdvisories, type FlightAdvisories } from '../prefs/flightAdvisories.js';
import { padMassTextFor } from './unitText.js';
import type { WeatherSnapshot } from './weatherSnapshot.js';

/**
 * THE LAUNCH, WITH NO REACT MOUNTED (2026-10-01; response-2026-10-01b § 3.2).
 *
 * Two entry points, one path:
 *
 *  - `flyBuiltDesign` is what the Launch button runs — onLaunch's flight and
 *    report, moved here as they stood at 78d3015 (App.tsx:1743-1817). App calls
 *    it with its memoised `built`; nothing in it touches React state, so the
 *    caller decides what lands where (App: `stillFlown`).
 *  - `simulateDesign` is the same Launch for a caller with no React: it derives
 *    (designDerivation.ts), builds (buildDesign.ts), settles a legacy pad mass
 *    the way App's reconcile effect does before any Launch can be pressed, and
 *    then calls `flyBuiltDesign`. So a script, a test or a later API flies what
 *    the button flies — and App.simulate.test.tsx holds the two to the same
 *    bytes on every case it has.
 *
 * App NEVER calls `simulateDesign`. It builds with `resetEngine`, which makes
 * every earlier handle throw "stale engine handle" — and App's `built.rocket`
 * is shared by the drag panel, the mass table and both re-fly paths. That is
 * why the shared path starts at the build, and why App keeps its own guarded
 * reset and `flightHoldsHandle` protocol unchanged.
 *
 * WHAT A HEADLESS RUN DOES NOT SEE (stated, not hidden): App's numbers are the
 * same physics PER INPUTS, and on a user's machine some inputs live in that
 * browser — the thrustcurve.org curve cache, a catalogue overlay from "Check
 * thrustcurve.org", custom presets and the EX motor library. `simulateFile`
 * (simulateFile.ts) defaults to shipped curves, presets and catalogue rows
 * (2026-10-01), because an overlay's dimensions change a bundled motor's CG.
 * Its importers and matcher receive the shipped catalogue; App's Open keeps
 * their live defaults. An already-parsed design keeps its imported state.
 *
 * A HANDLE THAT HAS SERVED THE DESIGN PAGE IS NOT A DIFFERENT HANDLE. App flies
 * a handle the drag sweep, component table and static analysis have already
 * read; `simulateDesign` flies a fresh one. The kernel's memoisation is per
 * component (engine-java/patches/LEDGER.md), so the two must agree, and
 * simulateDesign.test.ts pins it. If they ever disagree, App's numbers depend
 * on which panels the user opened — an App defect to fix in the kernel or the
 * bridge, never something to copy into this path.
 */

/** App's state as one Launch reads it, with the design already built. */
export interface BuiltLaunchInput<R extends BuildHandle = OrkRocket> {
  /** Reported series set; see SimulateDesignOptions.reportSeries. App leaves this absent. */
  reportSeries?: 'full' | 'summary';
  weatherSnapshot?: WeatherSnapshot | null;
  units?: UnitSelection;
  advisoryLimits?: FlightAdvisories;
  /** App: `built` (this render's). */
  built: BuiltDesign<R>;
  tree: RocketTree;
  /** What App's memos derived; the caller has already applied the Launch gate. */
  derived: Pick<LaunchDerivation, 'mounts' | 'stageList' | 'effectiveSupersonic'> & {
    assigned: Assigned;
    primaryMountId: string;
  };
  launch: LaunchConditions;
  aero: Pick<AeroState, 'aeroMode' | 'effectiveKbf'>;
  activeConfigId: string | null;
  savedConfigs: SavedConfig[];
  /**
   * The working set as it flies (App: `mountMotors`, `unmatchedRefs`). An
   * unnamed configuration is labelled by its motors, and the active row's
   * stored motors are written back only on a switch, None or a save — so the
   * run's label is taken from the row synced with these, the list App's
   * chooser and Batch read (review of b9-int, finding 1). Absent: as stored.
   */
  working?: { motors: Record<string, MountMotor>; unmatchedRefs: Record<string, OrkMotorRef> };
  /** Captured against the own-settings tree before resolving the flight. */
  flightOverrides?: RecordedFlightOverride[];
  /** App passes its `provenanceKey` memo, the key every comparison uses; never recomputed here. */
  provenance: Pick<DesignMatchKey, 'designKey' | 'motorSetKey' | 'motorDataKey' | 'motorDataKeys'>;
  /** App: `() => { if (stillFlown()) setAutoSupersonic(true); }`. Called after the last await. */
  onSupersonicUpgrade: () => void;
  /** App passes none, and that must not change: a Launch has no Stop. */
  signal?: AbortSignal;
  /**
   * The clock the flight's cost is read from (`performance.now` when absent).
   * It does not reach the auto-delay solver's own clock, whose `elapsedMs` is
   * wall time either way — which is why an agreement check strips it.
   */
  now?: () => number;
  /** Absent in App: retain the browser timer yield between auto-delay probes. */
  yieldToUi?: () => Promise<void>;
}

/**
 * Launch, from a built design: fly it (flightRunner.flyLaunch, which owns the
 * Mach probe, the Auto upgrade, the auto delay and the handle protocol) and
 * build the run the report and Saved simulations read. Everything after the
 * flight is pure — it was after the same await in onLaunch, so its order
 * against the kernel cannot matter.
 */
export async function flyBuiltDesign<R extends BuildHandle>(
  input: BuiltLaunchInput<R>,
): Promise<{ flight: LaunchFlight; run: FreshSimRun }> {
  const { built, tree, derived, launch, aero, activeConfigId, savedConfigs, provenance, signal, now } = input;
  const advisoryLimits = normalizeFlightAdvisories(input.advisoryLimits);
  const weatherSnapshot = structuredClone(input.weatherSnapshot ?? null);
  const launchForReport = structuredClone(launch);
  const units = { ...(input.units ?? INITIAL_UNITS) };
  const refusal = savedConfigs.find(c => c.id === activeConfigId)?.motorLoadoutRefusal;
  if (refusal) throw new Error(refusal);
  const { mounts, stageList, assigned, effectiveSupersonic, primaryMountId } = derived;
  const { aeroMode, effectiveKbf } = aero;
  const flightOverrides = input.flightOverrides === undefined ? undefined : structuredClone(input.flightOverrides);
  const labelled = input.working
    ? withActiveConfigSynced(savedConfigs, activeConfigId, input.working.motors, input.working.unmatchedRefs) : savedConfigs;
  const activeConfig = activeConfigId === null ? undefined : labelled.find(c => c.id === activeConfigId);
  const flightConfig = activeConfig ? savedConfigLabel(activeConfig) : assigned.length ? 'working settings' : 'none';
  const refusedMountIds = refusedMountIdsOf(built.motorFailures);
  // The keys and their order are onLaunch's at 78d3015; optional host signal,
  // clock and yield are spread only when given, so App's runner input is unchanged.
  const flight = await flyLaunch(built.rocket, {
    assigned,
    // What the report's delay table and the Auto-delay refusal call each
    // mount: the card heading's own fallback, never the internal id.
    mountNames: mountNamesOf(mounts),
    refusedMountIds,
    hardware: built.hardware,
    primaryMountId,
    simOptions: kernelSimOptions(launch, { ...aero, autoSupersonic: effectiveSupersonic }),
    supersonicSimOptions: kernelSimOptions(launch, { aeroMode: 'supersonic' }),
    aeroMode,
    supersonic: effectiveSupersonic,
    isOnLaunchStage: (id) => isOnLaunchStage(tree, id),
    // Rebuilds the engine handle with the flag on after this callback
    // finishes, so the design's displayed statics follow the flight. The
    // runner calls it after its last await: on a design opened meanwhile it
    // put "M+" on the strip and flew every later flight supersonic.
    onSupersonicUpgrade: input.onSupersonicUpgrade,
    ...(input.reportSeries ? { reportSeries: input.reportSeries === 'summary' && advisoryLimits?.maxAirspeedMs !== undefined
      ? 'full' : input.reportSeries } : {}),
    ...(signal ? { signal } : {}),
    ...(now ? { now } : {}),
    ...(input.yieldToUi ? { yieldToUi: input.yieldToUi } : {}),
  });
  const { result: res, flownDelayS: flownDelay, usedSupersonic, execMs, delayResolution } = flight;
  // The primary's record is the one `assigned` carries (filtered from the
  // working set, so the same object App's `mountMotors[primaryMountId]` was):
  // ONE source for the motor the report names and the motor that flew. Read
  // after the flight, which has already refused a design with no motor there.
  const primary: MountMotor = assigned.find(([id]) => id === primaryMountId)![1];
  // Per-stage motor info so booster branches can be safety-checked
  // (a chuteless booster above the high-power line must warn). The branch
  // naming rule, and the reason it is not simply the stage's name, lives
  // with the function in services/flightPipeline.ts.
  const branchMotors = stageMotorInfo(tree, assigned, stageList);
  // The configuration identity and override tuples were captured before flight.
  const run = buildSimRun({
    weatherSnapshot,
    ...(input.units ? { units } : {}),
    advisoryLimits,
    advisoryTree: tree,
    advisoryMotors: assigned,
    result: res,
    delayResolution, primaryMountId,
    // Which of the configuration's motors did not fly: once another
    // configuration is active, nothing else can say (orkFlightData).
    refusedMountIds,
    info: built.info,
    motor: { ...primary.spec, ejectionDelay: flownDelay },
    meta: {
      ...primary.meta,
      // What the kernel flew on the primary mount — the cluster times any
      // enclosing pod set or strap-on ring (audit 2026-09-22, row 351: a
      // motor in a three-pod set was recorded as one). The report's
      // Motors row says "firing together"; the CSV column keeps its old
      // 'Motors (cluster)' header so a sheet keyed on it still reads.
      motorCount: mountMotorCount(tree, primaryMountId),
    },
    launch: launchForReport,
    rocketName: tree.name ?? 'Rocket',
    execMs,
    stageMotorInfo: branchMotors,
    boosterMotors: assigned
      .filter(([id]) => id !== primaryMountId)
      .map(([, mm]) => mm.label),
    // Both stamps are permanent on the stored run, so both live in
    // services/flightPipeline.ts with their reasoning and their tests —
    // including why `effectiveKbf` and never the raw preference.
    aeroModel: aeroModelFor(aeroMode, usedSupersonic),
    rogersKbf: rogersKbfFor(effectiveKbf, usedSupersonic),
    flightConfig,
    ...(flightOverrides !== undefined ? { flightOverrides } : {}),
    // Provenance for the .ork <flightdata> guard: what this flight was
    // computed FROM, so a later export can prove the design, motors and
    // conditions have not moved since — and refuse to write the numbers
    // when they have. Stamped from the SAME key every comparison uses
    // (App's `provenanceKey`), so the two cannot be assembled apart.
    ...(activeConfigId !== null ? { flightConfigId: activeConfigId } : {}),
    designKey: provenance.designKey,
    motorSetKey: provenance.motorSetKey,
    motorDataKey: provenance.motorDataKey,
    motorDataKeys: provenance.motorDataKeys,
    // What the kernel was handed for each chute — so the report can state
    // the coefficient the verdict rests on, not just the device's name.
    flownRecovery: built.flownRecovery,
    // Which stages flew a nozzle AND a motor that can burn, so the report
    // can say the flown thrust is not the published curve (2026-09-08).
    // Motorised, not merely nozzle-bearing: the kernel's own gate is
    // `getThrust(t) > 0`, so a nozzle on a stage the flown configuration
    // left empty bought exactly nothing and must not be named as
    // corrected. Names only: whether the term was LIVE is decided from
    // the two model stamps above, which is the rest of that gate.
    nozzleStages: motorisedStagesWithNozzle(tree, assigned).map((s) => s.name),
    recoveryStages: stagesWithRecoveryDevice(tree),
    recoveryByStage: stageRecoveryById(tree),
  });
  return { flight, run };
}

// ---------------------------------------------------------------------------
// The headless Launch.
// ---------------------------------------------------------------------------

/**
 * The aero model a first visit flies: the stored-preference defaults through
 * the same `effectiveAero` the app reads them with (Rogers Kbf on the classic
 * model), with no Auto upgrade yet. simulateDesign.test.ts pins it to
 * `effectiveAero(DEFAULT_PREFS, null)`.
 */
export const APP_DEFAULT_AERO: AeroState = { ...effectiveAero(DEFAULT_PREFS, null), autoSupersonic: false };

export interface SimulateDesignOptions {
  /** API-only dead-holder detection; unsafe with browser macrotask yields. Absent: wait indefinitely. */
  kernelDeadHolderMs?: number;
  /** Optional floor shared by the reported flight, auto-delay probes and Mach probe. */
  minTimeStepS?: number;
  /**
   * Reported flight's series set, default 'full'. 'summary' keeps friendly keys,
   * activeLength, Pl/θl/Px/Py, dΦ and Vz; it omits ρ,
   * Vs, g and all other full-only symbols (atmosphere, forces, coefficients, etc.).
   * The run's load peaks are then null; maxAirspeedMs is unavailable (omitted
   * without advisory limits, null when other limits are active). A finite positive
   * advisoryLimits.maxAirspeedMs activates the airspeed check and overrides
   * 'summary' with 'full', preserving Vs and evaluation of that limit.
   * Rod-exit thrust-to-weight uses the same WGS84 model evaluated at the pad
   * latitude and interpolated height rather than reading the kernel's per-step
   * g (which also follows the rocket's drifting latitude); the difference is
   * at rounding level. The API returns a low
   * thrust-to-weight warning in notes.flight; 129/129 corpus API responses
   * were identical. It returns neither load peaks (maxQ/max q-alpha) nor
   * an airspeed check, and requests summary without advisory limits.
   */
  reportSeries?: 'full' | 'summary';
  /** Optional host yield; the headless barrel supplies a microtask-only default. */
  yieldToUi?: () => Promise<void>;
  advisoryLimits?: FlightAdvisories;
  /** The aero model to fly; default APP_DEFAULT_AERO (what a first visit flies). */
  aero?: AeroState;
  /** Where the build gets its handle; default the kernel's own (`resetEngine` + buildTree). */
  handles?: HandleFactory<OrkRocket>;
  /** Cancels the run: rejects at once while it waits its turn for the kernel, else at the flight's next check. */
  signal?: AbortSignal;
  /** The clock the flight's cost is read from (`performance.now` when absent). */
  now?: () => number;
  /** Display units for pad-mass notes and frozen report advice: default INITIAL_UNITS. */
  units?: UnitSelection;
}

export interface SimulateDesignResult {
  /** The ONE flight the report is built from. */
  result: FlightResult;
  /** The run Saved simulations would store (not stored: nothing is persisted). */
  run: FreshSimRun;
  /** What else the flight said: the delay flown, the model, its cost, the delay solve. */
  flight: Omit<LaunchFlight, 'result'>;
  /**
   * App's `autoSupersonic` after this Launch: true once Auto has crossed
   * Mach 0.9 on this design (the next Launch flies supersonic statics, which
   * this function reproduces only when passed `aero.autoSupersonic: true`).
   */
  autoSupersonic: boolean;
  /** What the build said: statics, refusals, the weighed hardware, the chutes as flown. */
  build: Pick<BuiltDesign, 'info' | 'motorFailures' | 'hardware' | 'flownRecovery'>;
  /** The state flown — after the legacy pad-mass settle. */
  state: DesignState;
  /** The full provenance key App would stamp and compare on. */
  provenance: DesignMatchKey;
  /** The build that flew it (APP_VERSION): every answer says which. */
  appVersion: string;
  /**
   * What the legacy pad-mass settle did and why — the notice App shows for it
   * (padMassReconcile's own sentence) — or null when there was nothing to
   * settle. A dropped value moves the apogee, and this is the only place a
   * headless caller is told why (verify-step1 finding 6, 2026-10-01).
   */
  padMassNote: HeldNote | null;
}

/** Why a headless Launch did not fly, by kind, with the app's own words. */
export type SimulateFailureKind =
  /** The design file is refused before it is read (designFile.designFileTooLarge's sentence). */
  | 'file'
  /** The importer refused the file (designFile.designFileOpenFailure's sentence). */
  | 'parse'
  /** The kernel would not build the design: what App shows as its build error, verbatim. */
  | 'build'
  /** No motor on any mount: App's Launch button is disabled. */
  | 'no-motor'
  /** The flight threw: what App shows as its simulation error, verbatim. */
  | 'flight';

export class SimulateDesignError extends Error {
  readonly kind: SimulateFailureKind;
  /** A file's import note, when the refusal came after the open (simulateFile): often the reason. */
  readonly importNote?: { text: string; severity: 'info' | 'warn' | 'error' };
  constructor(
    kind: SimulateFailureKind, message: string,
    options?: { cause?: unknown; importNote?: SimulateDesignError['importNote'] },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SimulateDesignError';
    this.kind = kind;
    if (options?.importNote) this.importNote = options.importNote;
  }
}

export class KernelUnavailableError extends Error {
  constructor() {
    super('A previous flight on this server instance was stopped part-way; please retry.');
    this.name = 'KernelUnavailableError';
  }
}

/**
 * ONE HEADLESS LAUNCH AT A TIME. A build resets the kernel, which makes every
 * earlier handle throw "stale engine handle" (packages/engine orkEngine.ts),
 * and a flight awaits (the auto-delay solver yields), so two concurrent runs
 * would interleave one's reset into the other's flight. Each run holds the
 * kernel from its build to its return.
 *
 * The chain swallows each run's outcome before the next one waits on it, so a
 * run that rejects (a build error, no motor) never poisons the runs queued
 * behind it. A caller whose signal is already aborted is refused without
 * joining the queue; one aborted while it waits is refused at once, and its
 * turn, when it comes, does nothing.
 *
 * App does not take this lock: it never calls `simulateDesign` (see the header).
 */
let tail: Promise<void> | undefined;
let poisoned = false;

/** @internal Only tests may discard the queue and poisoned state; production must replace the isolate. */
export function resetKernelForTests(): void {
  tail = undefined;
  poisoned = false;
}

export function withKernel<T>(
  fn: () => Promise<T> | T, signal?: AbortSignal, opts?: { deadHolderMs?: number },
): Promise<T> {
  if (poisoned) return Promise.reject(new KernelUnavailableError());
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const waiting = tail !== undefined;
  let started = false;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearTimer = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } };
  const run = (tail ?? Promise.resolve()).then(() => {
    // A timed-out waiter must never touch the static kernel, even if the old
    // holder eventually settles. Poison also refuses already-queued callers.
    if (expired || poisoned) throw new KernelUnavailableError();
    refuseIfAborted(signal);
    started = true;
    clearTimer();
    return fn();
  });
  const next = run.then(() => undefined, () => undefined);
  tail = next;
  void next.then(() => { if (tail === next) tail = undefined; });
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!started) { clearTimer(); reject(abortReason(signal!)); }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (waiting && opts?.deadHolderMs !== undefined) {
      // API-only: a timer can fire only when the event loop is idle. All work
      // inside that lock is microtask-only: yieldToUi returns Promise.resolve(),
      // bypassing autoDelaySolver's setTimeout fallback. A fired timer means
      // no holder is running. Browser yields are macrotasks, so this argument
      // is NOT sound there; the browser must leave this option off.
      timer = setTimeout(() => {
        if (!started) {
          expired = true;
          poisoned = true;
          signal?.removeEventListener('abort', onAbort);
          clearTimer();
          reject(new KernelUnavailableError());
        }
      }, opts.deadHolderMs);
    }
    void run.then(resolve, reject).then(() => {
      clearTimer();
      signal?.removeEventListener('abort', onAbort);
    });
  });
}

/**
 * A cancel, thrown the ONE way every step of a headless run reports it: the
 * caller's abort reason when it is an Error, else an AbortError naming it.
 * `signal.throwIfAborted()` throws a string reason raw, and the flight's own
 * check does exactly that — so a cancel landing mid-flight and one landing in
 * the queue came back as two different things (verify-step1 finding 7).
 */
export function refuseIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

/** The caller's abort reason when it is an Error (what `throwIfAborted` throws), else an AbortError naming it. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(reason === undefined ? 'The operation was aborted.' : String(reason), 'AbortError');
}

/**
 * Fly a design state the way the Launch button flies it, from the build on.
 * Nothing is persisted: `addRun` and every other write stay with App.
 */
export function simulateDesign(state: DesignState, opts: SimulateDesignOptions = {}): Promise<SimulateDesignResult> {
  // The dead-holder watchdog requires microtask-only yields inside the lock.
  if (opts.kernelDeadHolderMs !== undefined && opts.yieldToUi === undefined) {
    opts = { ...opts, yieldToUi: () => Promise.resolve() };
  }
  return withKernel(() => simulateDesignNow(state, opts), opts.signal, { deadHolderMs: opts.kernelDeadHolderMs });
}

function buildOrThrow(
  state: DesignState, aero: AeroState, handles: HandleFactory<OrkRocket>, units?: UnitSelection,
): { derived: LaunchDerivation; built: BuiltDesign } {
  const derived = deriveLaunchInputs(state, aero);
  const built = buildDesign(designBuildInputOf({
    tree: state.tree,
    assigned: derived.assigned,
    effectiveKbf: aero.effectiveKbf,
    effectiveSupersonic: derived.effectiveSupersonic,
    hybrid: aero.aeroMode === 'hybrid',
    measuredDryMassKg: state.measured.massKg,
    primaryMountId: derived.primaryMountId,
    currentSetKey: derived.currentSetKey,
    units,
  }), handles);
  if ('error' in built) throw new SimulateDesignError('build', built.error);
  return { derived, built };
}

async function simulateDesignNow(input: DesignState, opts: SimulateDesignOptions): Promise<SimulateDesignResult> {
  if (opts.minTimeStepS !== undefined && (input.launch.timeStepS ?? DEFAULT_TIME_STEP_S) < opts.minTimeStepS) {
    input = { ...input, launch: { ...input.launch, timeStepS: opts.minTimeStepS } };
  }
  const refusal = input.savedConfigs.find(c => c.id === input.activeConfigId)?.motorLoadoutRefusal;
  if (refusal) throw new SimulateDesignError('flight', refusal);
  const aero = opts.aero ?? APP_DEFAULT_AERO;
  const handles = opts.handles ?? KERNEL_HANDLES;
  // audit 2026-10-11, FC-4: every build and re-flight shares this projection.
  const resolved = resolveFlightState(input.tree, input.savedConfigs, input.activeConfigId, input.detachedOverrides ?? {}, input.mountMotors);
  let state = resolved.tree === input.tree && resolved.mountMotors === input.mountMotors ? input : { ...input, ...resolved };
  let { derived, built } = buildOrThrow(state, aero, handles, opts.units);
  // THE LEGACY PAD-MASS SETTLE. App's reconcile effect runs after the first
  // build, before anyone can press Launch: a value keyed 'legacy' (a
  // v0.116/v0.117 session, a bare-form .ork) is re-keyed to the set now loaded
  // or dropped, and App rebuilds because the motors changed. The same decision
  // and the same writes, then the same rebuild. At most one step: after it the
  // record carries no legacy key.
  const step = legacyPadMassStepOf({
    state, derived, hardware: built.hardware, text: padMassTextFor(opts.units ?? INITIAL_UNITS),
  });
  if (step) {
    state = applyLegacyPadMassStep(state, step);
    ({ derived, built } = buildOrThrow(state, aero, handles, opts.units));
  }
  // The Launch gate (App: the button is disabled with no primary mount).
  const { primaryMountId } = derived;
  if (!primaryMountId) throw new SimulateDesignError('no-motor', 'no motor on the primary mount — assign one first');
  const provenance = provenanceKeyOf({
    refusedMountIds: refusedMountIdsOf(built.motorFailures),
    physicsKey: derived.physicsKey, tree: state.tree, assigned: derived.assigned,
    hardwareDeltaKg: hardwareDeltaKgOf(built), launch: state.launch, aero,
  });
  let upgraded = false;
  let flown: Awaited<ReturnType<typeof flyBuiltDesign>>;
  try {
    flown = await flyBuiltDesign({
      ...(opts.reportSeries ? { reportSeries: opts.reportSeries } : {}),
      units: opts.units,
      advisoryLimits: opts.advisoryLimits,
      built,
      tree: state.tree,
      derived: { ...derived, primaryMountId },
      launch: state.launch,
      aero,
      activeConfigId: state.activeConfigId,
      savedConfigs: state.savedConfigs,
      // The working set as App holds it, for the run's configuration label.
      working: { motors: input.mountMotors, unmatchedRefs: input.unmatchedRefs ?? {} },
      flightOverrides: recordFlightOverrides(input.tree,
        activeFlightOverrides(input.savedConfigs, input.activeConfigId, input.detachedOverrides ?? {}),
        input.mountMotors),
      provenance,
      onSupersonicUpgrade: () => { upgraded = true; },
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.yieldToUi ? { yieldToUi: opts.yieldToUi } : {}),
    });
  } catch (e) {
    // A cancel is the caller's, not a failed flight: the flight's own abort
    // check threw it, and it is reported as withKernel reports a queued one.
    refuseIfAborted(opts.signal);
    throw new SimulateDesignError('flight', e instanceof Error ? e.message : String(e), { cause: e });
  }
  const { result, ...flight } = flown.flight;
  return {
    result,
    run: flown.run,
    flight,
    autoSupersonic: aero.autoSupersonic || upgraded,
    build: { info: built.info, motorFailures: built.motorFailures, hardware: built.hardware, flownRecovery: built.flownRecovery },
    state: step ? applyLegacyPadMassStep(input, step) : input,
    provenance,
    appVersion: APP_VERSION,
    padMassNote: step?.note ?? null,
  };
}
