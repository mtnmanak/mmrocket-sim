import type {
  FlightResult, MotorSpec, OrkRocket, SimulationOptions,
} from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { flownSpec, type HardwareMassResult } from './hardwareMass.js';
import { knownIgnitionEvent } from './ignitionEvent.js';
import { withLoadSeries } from './flightLoads.js';
import { MACH_AUTO_THRESHOLD, machProbeSeconds } from './machProbe.js';
import { canReplayDelays, delayMountsOf, readDelay, solveAutoDelays, type DelayResolution, type DelayIdentityContext } from './autoDelaySolver.js';

/**
 * THE KERNEL-HANDLE PROTOCOL: every flight the app flies on a design's SHARED
 * engine handle — Launch, the "Show charts" re-fly and the flight-data
 * download's full-series re-fly — goes through this module.
 *
 * Extracted from App.tsx on 2026-09-22 (docs/AUDIT.md, extraction #1). The
 * protocol (put the motors on, their ignition, the delay and the aero flags,
 * simulate, hand the handle back) was written inline three times, and every
 * defect it has produced reached users as a wrong number: the v0.105 delay
 * leak, the 8 September ignition loss, and the 22 September re-fly that
 * deployed a stored run's chute at the delay a LATER auto-delay Launch had left
 * behind. Each was found by an audit or a tester and none by a test, because the
 * only test that could see this code read App.tsx as text.
 *
 * The handle is shared by Launch, the drag panel, the mass table and the two
 * re-fly paths, and it has no way to report its motor state back — so no path
 * here may trust what it finds on it.
 */

/** The handle calls a flight makes — `OrkRocket`'s, narrowed so a test can stand in for it. */
export type FlightHandle = Pick<OrkRocket,
  'setHybridAero' | 'setMotorById' | 'setMotorIgnitionById' | 'setSupersonicAero' | 'setRogersModifiedBarrowman' | 'simulate'>;

/** The motors a flight starts from: App's `assigned`, and the build's weighed hardware. */
export interface AssignedMotors {
  assigned: readonly (readonly [string, MountMotor])[];
  /** `buildResult.hardware` — what the weighed pad mass carries, and on which mount. */
  hardware: HardwareMassResult | undefined;
  /** Build refusals: absent motors cannot appear in the flown delay vector. */
  refusedMountIds?: readonly string[];
}

/** Both aerodynamics switches a handle carries. */
export interface AeroFlags {
  hybrid?: boolean;
  supersonic: boolean;
  kbf: boolean;
}

/**
 * Write ONE motor onto a built handle and KEEP its ignition. Every motor write
 * on the design's own handle — App's build and every flight below — goes
 * through here, and so do Batch's writes of the design's OTHER mounts
 * (batchSweep `applyOthers`, since the seam review of audit 2026-09-22). Its
 * hand-kept copy wrote the motor BEFORE the ignition and swallowed the throw,
 * so a mount carrying an event the kernel does not know — reachable only from
 * an autosave or saved configuration made before the .ork reader began mapping
 * one to AUTOMATIC — was left off the design's handle here and flown on
 * AUTOMATIC there: 240.34 m in Batch, 122.06 m on the design page. (Batch's
 * per-candidate writes touch only the swept mount, which carries no design
 * ignition; flownIgnitionSites.test.ts counts them.)
 *
 * The bridge's `setMotorById` (`OrkEngine.java` `applyMotor`) installs a FRESH
 * `MotorConfiguration` on the mount:
 *
 *     MotorConfiguration mc = new MotorConfiguration(mount, ctx.fcid);
 *     mc.setMotor(motor);
 *     mc.setEjectionDelay(ejectionDelay);
 *     mount.setMotorConfig(mc, ctx.fcid);
 *
 * so any write resets the ignition event and its timer to the kernel default
 * (AUTOMATIC). What that cost before the 2026-09-08 audit: `assignMotor` gives a
 * high-power sustainer on a staged design `{ event: 'burnout', delay: 1 }`, and
 * the primary mount IS that mount. Ticking "auto (optimal)" re-flew it on
 * AUTOMATIC — lighting off the booster's ejection charge instead of burnout +
 * 1 s — and it is the RE-FLOWN result that `buildSimRun` stores, the report
 * shows and the `.ork` `<flightdata>` carries.
 *
 * The condition is the build's own: an AUTOMATIC mount with no timer is left
 * exactly as the kernel configured it rather than re-stated in other words.
 *
 * THE EVENT IS CHECKED BEFORE THE MOTOR GOES ON (audit 2026-09-22). The
 * bridge's ignition write can throw for only one reason once `setMotorById`
 * has succeeded — an event name it does not know — and it used to be reached
 * AFTER the motor was installed. The build then reported the mount as refused,
 * so recovery weight and the pad-mass arithmetic left the motor out, while the
 * handle flew it on AUTOMATIC: numbers computed with and without the same
 * motor. There is no bridge call that takes a motor back off, so refusing
 * first is what keeps "refused" and "absent from the handle" one fact. The
 * event is written in the kernel's own spelling (`knownIgnitionEvent`).
 */
export function writeMountMotor(
  rocket: FlightHandle, id: string, spec: MotorSpec, ignition: MountMotor['ignition'],
): void {
  const event = knownIgnitionEvent(ignition.event);
  if (event === null) {
    throw new Error(`${spec.designation}: its ignition event “${ignition.event}” is not one the`
      + ' simulator knows, so the motor was left off the rocket rather than flown on a guess.'
      + ' Pick it again on Motors & Launch.');
  }
  rocket.setMotorById(id, spec);
  if (event !== 'automatic' || ignition.delay !== 0) {
    rocket.setMotorIgnitionById(id, event, ignition.delay);
  }
}

/**
 * Put every assigned mount's motor and ignition onto the engine handle, from
 * the app's own state, RIGHT NOW — so a flight never trusts whatever the
 * handle happened to be carrying.
 *
 * Two of the re-fly paths once wrote a STORED flight's ejection delay onto the
 * shared handle and shipped without restoring it — one for 47 releases
 * (v0.046–v0.104), one for 30 — so the next Launch flew a delay its own report
 * never named. Measured on a real flight: the report said the chute opened at
 * 4.5 ft/s while it actually deployed at 45.9 ft/s. Set what you need before
 * you use it, and inherited state cannot matter. `setMotorById` is 0.057 ms
 * against a 141–285 ms flight.
 *
 * Same loop the build runs, deliberately: a motor the kernel refused at build
 * time was reported then in `motorFailures` and stays absent here.
 *
 * `hardware` is the build's own result: the primary mount flies the catalogue
 * curve shifted by the weighed hardware, through the SAME `flownSpec` the build
 * wrote onto the handle — so a flight carries the design page's mass, not the
 * catalogue's. See services/hardwareMass.ts.
 */
export function applyAssignedMotors(rocket: FlightHandle, { assigned, hardware, refusedMountIds }: AssignedMotors): void {
  for (const [id, mm] of assigned) {
    if (refusedMountIds?.includes(id)) continue;
    try {
      writeMountMotor(rocket, id, flownSpec(id, mm.spec, hardware), mm.ignition);
    } catch {
      // Already reported at build time; a flight must not re-raise it. A
      // refused write leaves the mount as it was — empty on a built handle —
      // because writeMountMotor refuses before it writes.
    }
  }
}

/**
 * The mounts a flight really carries: `assigned` without the build's refusals,
 * and without a mount whose ignition event the kernel does not know —
 * writeMountMotor refuses that one before the motor goes on, so it is absent
 * from the handle whether or not a caller passed its id.
 *
 * ONE filter for flying and replaying (audit 2026-09-30). Launch solves and
 * stores the delay vector for these mounts alone, and a replay used to check
 * that vector against every ASSIGNED mount — a length that could never match.
 * So a two-mount design whose second motor was refused launched and stored its
 * run, but "Show charts" was hidden for every run of it and the flight-data
 * download refused with "Saved mount delays are incomplete", which no Launch
 * could clear. Launch, the re-fly, App's `canShowCharts` and Auto-delay card,
 * and the Auto delays a Save writes (orkFlightData) all read this.
 */
export function installedMounts(
  assigned: AssignedMotors['assigned'], refusedMountIds?: readonly string[],
): AssignedMotors['assigned'] {
  return assigned.filter(([id, mm]) => !refusedMountIds?.includes(id)
    && knownIgnitionEvent(mm.ignition.event) !== null);
}

/** One mount's FLOWN spec (hardware included) at a given ejection delay. */
function writeMountDelay(
  rocket: FlightHandle, motors: AssignedMotors, primaryMountId: string, delayS: number,
): void {
  const mm = motors.assigned.find(([id]) => id === primaryMountId)?.[1];
  if (!mm) return;
  // The FLOWN spec, not the catalogue one: this write replaces the whole motor
  // on the handle, and spreading `mm.spec` put the catalogue mass back — so the
  // reported flight lost the hardware the build had just carried.
  writeMountMotor(rocket, primaryMountId,
    { ...flownSpec(primaryMountId, mm.spec, motors.hardware), ejectionDelay: delayS }, mm.ignition);
}

export interface LaunchInput extends AssignedMotors {
  mountNames?: Record<string, string>;
  signal?: AbortSignal;
  yieldToUi?: () => Promise<void>;
  /** The mount whose motor drives the scalar report columns (App's `primaryMountId`). */
  primaryMountId: string;
  /** `kernelSimOptions(launch)`. */
  simOptions: SimulationOptions;
  aeroMode: 'classic' | 'supersonic' | 'auto' | 'hybrid';
  /** The model the design is on right now (App's `effectiveSupersonic`). */
  supersonic: boolean;
  /** For the Mach probe's cutoff: does this mount sit on the launch stage? */
  isOnLaunchStage: (mountId: string) => boolean;
  /** Called after releasing the handle: the app's callback rebuilds the kernel. */
  onSupersonicUpgrade: () => void;
  /** The clock the per-flight cost is read from; `performance.now` when absent. */
  now?: () => number;
}

export interface LaunchFlight {
  delayResolution: DelayResolution;
  /** The ONE flight the report is built from. */
  result: FlightResult;
  /** The ejection delay the primary FLEW — the rounded optimum under auto delay. */
  flownDelayS: number;
  /** Whether that flight was on the supersonic model. */
  usedSupersonic: boolean;
  /** Wall time of that flight alone (ms) — what the time-step caution quotes. */
  execMs: number;
}

/**
 * Launch: fly the design as it stands, and say what flew.
 */
export async function flyLaunch(rocket: FlightHandle, input: LaunchInput): Promise<LaunchFlight> {
  const installed = installedMounts(input.assigned, input.refusedMountIds);
  const absent = input.assigned.filter(([id]) => !installed.some(([kept]) => kept === id));
  const unresolved = absent.filter(([, mm]) => mm.meta.autoDelay);
  if (unresolved.length) {
    throw new Error(`Auto delay did not settle for ${unresolved.map(([id]) => input.mountNames?.[id] ?? id).join(', ')}: the motor was refused at build time. Choose a fixed delay and Launch again.`);
  }
  const installedInput = { ...input, assigned: installed };
  const primary = installedInput.assigned.find(([id]) => id === input.primaryMountId)?.[1];
  if (!primary) throw new Error('no motor on the primary mount — assign one first');
  const now = input.now ?? (() => performance.now());
  let upgraded = false;
  // Never fly inherited handle state — see applyAssignedMotors.
  applyAssignedMotors(rocket, input);
  try {
    return await flyFromCleanHandle(rocket, { ...installedInput, onSupersonicUpgrade: () => { upgraded = true; } }, now);
  } finally {
    // And never LEAVE any. The auto-delay write below puts the rounded optimum
    // on the primary, and this used to be called "safe to leave unrestored"
    // because Launch starts from applyAssignedMotors — which held only while
    // EVERY path did, and the two re-fly paths did not: "Show charts" on a
    // stored 9 s run, after an auto-delay Launch had left 7 s behind, deployed
    // at 1.76 m/s under a report saying 18.14 (audit 2026-09-22; starter rocket,
    // AeroTech F39, classic aero without Kbf). Every path
    // now starts from the design, and this puts the design back as well.
    //
    // Leave the upgraded aero flag and notify the app only after restoring
    // the motors: the callback may rebuild the design's kernel handle.
    applyAssignedMotors(rocket, input);
    if (upgraded) input.onSupersonicUpgrade();
  }
}

async function flyFromCleanHandle(
  rocket: FlightHandle, input: LaunchInput, now: () => number,
): Promise<LaunchFlight> {
  const { primaryMountId, simOptions, aeroMode } = input;
  let execMs = 0;
  const hybrid = aeroMode === 'hybrid';
  rocket.setHybridAero(hybrid);
  if (hybrid) rocket.setRogersModifiedBarrowman(true);
  let usedSupersonic = !hybrid && input.supersonic;
  rocket.setSupersonicAero(usedSupersonic);
  const upgrade = () => {
    rocket.setSupersonicAero(true);
    usedSupersonic = true;
    input.onSupersonicUpgrade();
  };
  if (aeroMode === 'auto' && !usedSupersonic) {
    const probe = rocket.simulate({
      ...simOptions,
      maxTime: machProbeSeconds(input.assigned.map(([id, mm]) => ({
        ...mm, onLaunchStage: input.isOnLaunchStage(id),
      }))),
    });
    if (probe.summary.maxMachNumber > MACH_AUTO_THRESHOLD) upgrade();
  }
  const budget = { probes: 0 };
  let solverMs = 0;
  for (;;) {
    const delayResolution = await solveAutoDelays({
      mounts: delayMountsOf(input.assigned, input.mountNames), budget,
      signal: input.signal, yieldToUi: input.yieldToUi,
      probe: (delays) => {
        for (const [id, delay] of delays) writeMountDelay(rocket, input, id, delay);
        return rocket.simulate({ ...simOptions, delayProbe: true });
      },
    });
    solverMs += delayResolution.elapsedMs;
    for (const m of delayResolution.mounts) writeMountDelay(rocket, input, m.mountId, readDelay(m.flownDelay));
    input.signal?.throwIfAborted();
    const t0 = now();
    // Load metrics need the kernel's density and sound speed. Keep solver and
    // Mach probes lean; only the reported flight pays for full serialization.
    const result = withLoadSeries(rocket.simulate({ ...simOptions, delayProbe: false, series: 'full' }));
    execMs = now() - t0;
    // The final normal flight decides aero, not the ballistic probe's descent.
    // Recompute every target after an upgrade, within the SAME eight-probe budget.
    if (aeroMode === 'auto' && !usedSupersonic && result.summary.maxMachNumber > MACH_AUTO_THRESHOLD) {
      upgrade();
      continue;
    }
    delayResolution.elapsedMs = solverMs;
    return {
      result, flownDelayS: readDelay(delayResolution.mounts.find((m) => m.mountId === primaryMountId)!.flownDelay),
      usedSupersonic, execMs, delayResolution,
    };
  }
}

export interface ReflyInput extends AssignedMotors {
  delayIdentity?: DelayIdentityContext;
  delayResolution?: DelayResolution;
  primaryMountId: string;
  /** The ejection delay the stored run FLEW (`SimRun.delayS`). */
  delayS: number;
  /** `kernelSimOptions(launch)`, plus `series: 'full'` for the flight-data download. */
  simOptions: SimulationOptions;
  /** The model to fly the re-flight on. */
  fly: AeroFlags;
  /** The model the shared handle must carry afterwards: the design's current one. */
  restore: AeroFlags;
}

/**
 * Re-fly a STORED run: the same design, motors and conditions, at the delay and
 * on the model that run flew. The physics is deterministic (fixed seed), so
 * this reproduces the stored flight exactly rather than approximating it.
 *
 * It starts from the design (applyAssignedMotors) and writes the run's delay
 * UNCONDITIONALLY. Both halves matter, and the second is the one that was
 * missing: the charts and CSV paths used to write the delay only when
 * `delayS` differed from the SPEC's, trusting the handle to hold the spec
 * otherwise — and an auto-delay Launch had left its rounded optimum there. A
 * stored run whose delay WAS the spec's was then re-flown at the optimum, and
 * the "Show charts" result is cached under the run's id, so the vitals
 * apogee, the plots and the flight-data CSV/XLSX all showed the wrong flight
 * (audit 2026-09-22, measured on the starter rocket with an F39-9 on classic
 * aero without Kbf: stored deployment 18.14 m/s, re-fly 1.76 m/s; with Kbf,
 * the default, 18.54 and 4.24).
 */
export function reflyRun(rocket: FlightHandle, input: ReflyInput): FlightResult {
  const { primaryMountId, delayS, simOptions, fly, restore } = input;
  // The mounts the stored flight flew: Launch's own filter, or the delay
  // vector it stored can never match (installedMounts).
  const installed = { ...input, assigned: installedMounts(input.assigned, input.refusedMountIds) };
  if (!installed.assigned.some(([id]) => id === primaryMountId)) {
    throw new Error('no motor on the primary mount — assign one first');
  }
  applyAssignedMotors(rocket, input);
  try {
    if (!canReplayDelays(input.delayResolution, installed.assigned, primaryMountId, delayS, input.delayIdentity)) {
      throw new Error('Saved mount delays are incomplete or no longer match. Launch again.');
    }
    if (input.delayResolution !== undefined) {
      for (const m of input.delayResolution.mounts) writeMountDelay(rocket, installed, m.mountId, readDelay(m.flownDelay));
    } else {
      // Old Launch optimized only the primary. All other delays remained in the design.
      writeMountDelay(rocket, installed, primaryMountId, delayS);
    }
    rocket.setHybridAero(fly.hybrid ?? false);
    rocket.setSupersonicAero(fly.supersonic);
    rocket.setRogersModifiedBarrowman(fly.kbf);
    return withLoadSeries(rocket.simulate({ ...simOptions, series: 'full' }));
  } finally {
    // Hand the shared handle back as the design has it: the drag panel and the
    // component table read it too, and they follow the CURRENT model.
    rocket.setHybridAero(restore.hybrid ?? false);
    rocket.setSupersonicAero(restore.supersonic);
    rocket.setRogersModifiedBarrowman(restore.kbf);
    // The MOTORS too, and for the same reason: a finally that restored only
    // the aero model left the run's ejection delay on the shared handle, so the
    // next Launch flew a delay the report never mentions. applyAssignedMotors
    // swallows a refusal (the build already reported it), so a restore can
    // never replace the error that brought us here.
    applyAssignedMotors(rocket, input);
  }
}
