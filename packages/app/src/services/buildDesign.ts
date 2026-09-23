import {
  OrkRocket, resetEngine, type ComponentNode, type RocketTree, type StaticInfo,
} from '@online-openrocket/engine';
import type { MountMotor } from '../model/design.js';
import { railInterferenceWarnings, wakeShadowWarnings } from '../tree/mountAngle.js';
import { explainBuildFailure } from '../tree/sanitize.js';
import { engineTree, flownRecoveryDevices } from '../tree/treeModel.js';
import { writeMountMotor, type FlightHandle } from './flightRunner.js';
import { flownSpec, hardwareMass, LEGACY_PAD_MASS_KEY, type HardwareMassResult } from './hardwareMass.js';
import type { FlownRecoveryDevice } from './simReport.js';

/**
 * THE DESIGN BUILD: the tree and the motors on it, handed to the kernel, and
 * everything the design page reads back — the handle, the static analysis,
 * which motors the kernel refused, the recovery devices as flown and what the
 * weighed pad mass derived.
 *
 * Extracted from App.tsx's build memo in the 2026-09-22 audit (row 494,
 * extraction #2). The memo carried two orderings that decide numbers and
 * that only comments pinned:
 *
 *  - the weighed hardware is written onto the primary mount AFTER the first
 *    `staticInfo()`, through `writeMountMotor`, which re-applies that mount's
 *    ignition — `setMotorById` installs a fresh motor configuration, so a
 *    write that skipped it put a staged sustainer back on AUTOMATIC;
 *  - the camera-shroud THICK_FIN filter runs BEFORE the rail and wake
 *    sentences are appended, or a shroud named like the kernel's warning is
 *    filtered out of its own wake sentence.
 *
 * A reorder of either silently changes flown mass, stability or what the
 * warnings strip says. They are pinned by buildDesign.test.ts, against a
 * handle that records every call and on the real kernel.
 *
 * The handle factory is injected for that reason: the build's calls are the
 * thing under test, and the kernel cannot report them back.
 */

/** The handle calls a build makes — `OrkRocket`'s, narrowed so a test can stand in for it. */
export type BuildHandle = FlightHandle & Pick<OrkRocket, 'staticInfo'>;

/** Where a build gets its handle. */
export interface HandleFactory<R extends BuildHandle> {
  /** Drop every handle the kernel holds (`resetEngine`); a build starts from none. */
  reset(): void;
  /** Build a handle from an ENGINE tree (`treeModel.engineTree`'s output). */
  build(engine: RocketTree): R;
}

/** The TeaVM kernel's own factory — what the design page builds with. */
export const KERNEL_HANDLES: HandleFactory<OrkRocket> = {
  reset: resetEngine,
  build: (engine) => OrkRocket.buildTree(engine),
};

/** What the build reads: the design, the motors on it, the model flags, the weighing. */
export interface DesignBuildInput {
  tree: RocketTree;
  /** App's `assigned`: motors on mounts that still exist in the tree. */
  assigned: readonly (readonly [string, MountMotor])[];
  /** Rogers Modified Barrowman (Kbf) — the EFFECTIVE value, session override included. */
  kbf: boolean;
  /** RASAero-class supersonic aerodynamics — Auto's upgrade included. */
  supersonic: boolean;
  /** The Measured mass & CG box's dry mass; it wins over the kernel's massEmpty. */
  measuredDryMassKg: number | null;
  /** `treeModel.primaryMountOf` over the assigned mounts. */
  primaryMountId: string | null;
  /** `configSync.padMassSetKey` of the motor set on the rocket now. */
  currentSetKey: string;
}

export interface BuiltDesign<R extends BuildHandle = OrkRocket> {
  rocket: R;
  info: StaticInfo;
  motorFailures: { mountId: string; text: string }[];
  flownRecovery: Record<string, FlownRecoveryDevice>;
  /** What the weighed pad mass derived, and on which mount it is carried. */
  hardware: HardwareMassResult;
}

/** A build, or why there is none. Never throws. */
export type DesignBuild<R extends BuildHandle = OrkRocket> = BuiltDesign<R> | { error: string };

export function buildDesign<R extends BuildHandle>(
  input: DesignBuildInput, handles: HandleFactory<R>,
): DesignBuild<R> {
  const { tree, assigned, kbf, supersonic, measuredDryMassKg, primaryMountId, currentSetKey } = input;
  try {
    handles.reset();
    // Built once and kept: the launch report states the drag coefficient each
    // recovery device ACTUALLY flew, and the only honest source for that is
    // the tree the kernel was handed — not the design on screen.
    const engine = engineTree(tree);
    const flownRecovery = flownRecoveryDevices(engine);
    const rocket = handles.build(engine);
    // Opt-in Rogers Modified Barrowman (Kbf) — set before staticInfo() so the
    // reported CP/stability reflects it, and it persists onto this build's
    // handle for later simulate() calls.
    rocket.setRogersModifiedBarrowman(kbf);
    // Opt-in RASAero-class supersonic aerodynamics (feature #1) — CP/drag
    // move with Mach; affects staticInfo, dragSweep and simulate alike.
    rocket.setSupersonicAero(supersonic);
    // A motor the kernel refuses must NOT blank the whole design. Before
    // this, one malformed published thrust curve (issues-2026-08-23a.md) took
    // out stability, mass, CP/CG, the stats drawer, the drag panel, every
    // export and both Launch buttons — for a fault in a file the user did not
    // write. Now the rocket still builds; only the motor is missing, and the
    // notice says which and why.
    const motorFailures: { mountId: string; text: string }[] = [];
    for (const [id, mm] of assigned) {
      try {
        // The motor and its ignition, through the ONE writer every flight
        // uses too (services/flightRunner.ts). It refuses an ignition event
        // the kernel does not know BEFORE the motor goes on, so a mount
        // reported here is also absent from the handle — recovery weight
        // and the pad-mass arithmetic below already treat it so.
        writeMountMotor(rocket, id, mm.spec, mm.ignition);
      } catch (e) {
        motorFailures.push({
          mountId: id,
          text: e instanceof Error ? e.message : String(e),
        });
      }
    }
    let info = rocket.staticInfo();
    // WEIGHED PAD MASS (2026-09-07; moved onto the motor's record 2026-09-08).
    // The catalogue motor weight leaves out the adapter, retainer and
    // closure; when the user has weighed the rocket with the motor in, the
    // difference is derived here and carried on the primary mount's motor
    // curve — services/hardwareMass.ts has the arithmetic, the refusals and
    // why it rides in the motor. The value comes from the PRIMARY mount's
    // MountMotor (`padMassKg`), keyed to the motor set it was weighed with
    // (`padMassWeighedWith`); a key that is not the current set's is
    // refused as 'stale-set' before any arithmetic, and the 'legacy'
    // sentinel (a v0.116/v0.117 value not yet checked) is passed with NO key
    // so the arithmetic gives its verdict and App's legacy reconcile
    // decides. Motors the kernel refused are excluded, as App's recovery
    // input excludes them: their catalogue mass is not on the handle to
    // subtract.
    //
    // TWO staticInfo() CALLS when a pad mass is set, and only then. The dry
    // mass the arithmetic needs (massEmpty) is only knowable from the kernel
    // after the build, so the shifted motor goes on after the first call and
    // the second reads the loaded mass and CG with it. Measured 2026-09-07
    // on this machine: the second call is 7.7 ms on lemiv-motors.ork and
    // 21.7 ms on reference.ork (9 ms steady-state) — and it does not happen
    // at all for a design without a pad mass, which runs the single call it
    // always ran, byte-identically.
    const accepted = assigned.filter(([id]) => !motorFailures.some((f) => f.mountId === id));
    // The record comes from `assigned`, NOT `accepted`: a primary whose curve
    // the kernel refused still holds the value the field shows, and passing
    // it lets step 2 answer 'no-motor' (the line then says the kernel refused
    // the curve) rather than step 1 answering 'no-pad-mass' under a visible
    // number — the v0.116 class this release removes (2026-09-08 review).
    // `motors: accepted` still governs what is subtracted.
    const primaryRecord = assigned.find(([id]) => id === primaryMountId)?.[1];
    const key = primaryRecord?.padMassWeighedWith;
    const hardware = hardwareMass({
      padMassKg: primaryRecord?.padMassKg ?? null,
      weighedWith: key === LEGACY_PAD_MASS_KEY ? undefined : key,
      currentSetKey,
      measuredDryMassKg, // the airframe box's dry mass still wins over massEmpty
      computedDryMassKg: info.massEmpty,
      tree,
      motors: accepted,
      primaryMountId,
    });
    if (hardware.state === 'ok') {
      const mm = accepted.find(([id]) => id === hardware.appliedTo)?.[1];
      if (mm) {
        // Through the same writer as the loop above, which re-applies the
        // ignition: the bridge's setMotorById (OrkEngine.java applyMotor)
        // installs a fresh motor configuration on the mount, so the second
        // write would otherwise leave it on the kernel's default.
        writeMountMotor(rocket, hardware.appliedTo, flownSpec(hardware.appliedTo, mm.spec, hardware), mm.ignition);
        info = rocket.staticInfo();
      }
    }
    // Camera shrouds lower to deliberately thick strake "fins" — the
    // kernel's THICK_FIN warning is expected there and only alarms users.
    const fairingNames = new Set<string>();
    const scanF = (nodes: ComponentNode[]) => {
      for (const nd of nodes) {
        if (nd.type === 'fairing') fairingNames.add(nd.name ?? 'Camera shroud');
        scanF(nd.children ?? []);
      }
    };
    scanF(tree.components);
    if (fairingNames.size > 0) {
      info.warningTexts = info.warningTexts.filter((wtext) =>
        !(wtext.includes('THICK_FIN') && [...fairingNames].some((fn) => wtext.includes(fn))));
    }
    // Interference around the rail (v0.088). An APP-side check, appended to
    // the same strip. It is a build problem, not a physics one: a fin on the
    // rail's line means the rocket does not go on the pad. Eric asked for it
    // on 2026-08-31. (A LUG or RAIL BUTTON's angle still changes no flight
    // number; since v0.089 a CAMERA SHROUD's does — its strake's lift is
    // steered by the mounting angle. See treeModel's lowering notes.)
    const railWarnings = railInterferenceWarnings(tree);
    if (railWarnings.length) info.warningTexts = [...info.warningTexts, ...railWarnings];
    // A bump directly UPSTREAM of a fin sheds a wake onto it, and nothing here
    // or in any other hobby package models that: the fin is flown at full
    // free-stream dynamic pressure. Unlike the rail check above this changes no
    // number at all - it is a stated limit, in the place the reader is already
    // looking. It must sit AFTER the THICK_FIN fairing-name filter above, or a
    // shroud named like a fin gets filtered out of its own sentence.
    const wakeWarnings = wakeShadowWarnings(tree);
    if (wakeWarnings.length) info.warningTexts = [...info.warningTexts, ...wakeWarnings];
    return { rocket, info, motorFailures, flownRecovery, hardware };
  } catch (e) {
    // Named, not raw (audit 2026-09-22): the kernel's own text — "The number
    // NaN cannot be converted to a BigInt", "Unknown format conversion: g" —
    // names nothing on screen, while the design has lost its mass,
    // stability, Launch and every export. The limits table is read as a
    // validator to name the part and the field; failing that, the part the
    // design builds without is named, found with bare builds through the same
    // factory — ~2 ms each on the kernel, where `staticInfo` would be ~75
    // (sanitize.ts `partBlockingBuild`). The kernel's words follow either way.
    return {
      error: explainBuildFailure(tree, e instanceof Error ? e.message : String(e), (t) => {
        try {
          handles.reset();
          handles.build(engineTree(t));
          return true;
        } catch {
          return false;
        }
      }),
    };
  }
}
