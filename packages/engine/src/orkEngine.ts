/**
 * Typed wrapper around the TeaVM-compiled OpenRocket kernel
 * (vendor/orkengine.mjs — regenerate with `npm run engine:js`).
 *
 * Engine invariants: pure SI units (m, kg, s, N), angles in RADIANS.
 * Documented exceptions: launchLatitude/launchLongitude are DEGREES.
 * See engine-java/ for the kernel, shims, patches and differential tests.
 */
import * as ork from '../vendor/orkengine.mjs';

export type NoseShape = 'ogive' | 'conical' | 'ellipsoid' | 'power' | 'parabolic' | 'haack';

export interface RocketSpec {
  noseCone: {
    length: number;
    aftRadius: number;
    thickness: number;
    shape?: NoseShape;
    /** Bulk density kg/m^3; omit for OpenRocket's default material. */
    materialDensity?: number;
  };
  bodyTube: {
    length: number;
    outerRadius: number;
    thickness: number;
    materialDensity?: number;
  };
  fins: {
    count: number;
    rootChord: number;
    tipChord: number;
    sweep: number;
    height: number;
    thickness: number;
    materialDensity?: number;
  };
  motorMount: {
    length: number;
    outerRadius: number;
    thickness: number;
  };
  parachute?: {
    diameter: number;
    dragCoefficient?: number;
  };
}

export interface MotorSpec {
  designation: string;
  diameter: number;
  length: number;
  /** Thrust curve: times[i] (s) -> thrusts[i] (N); masses[i] = motor mass (kg) at times[i]. */
  times: number[];
  thrusts: number[];
  masses: number[];
  /** Motor CG position from its leading end (m). */
  cgX: number;
  ejectionDelay: number;
}

export interface SimulationOptions {
  launchRodLength?: number;
  /** Radians from vertical. */
  launchRodAngle?: number;
  windAverage?: number;
  windStdDeviation?: number;
  launchAltitude?: number;
  /** Launch-site temperature (K). Default: ISA standard. */
  temperature?: number;
  /** Launch-site pressure (Pa). Default: ISA standard. */
  pressure?: number;
  /** DEGREES (exception to the radians rule — WorldCoordinate's own unit). */
  launchLatitude?: number;
  /** DEGREES (exception to the radians rule). */
  launchLongitude?: number;
  timeStep?: number;
  maxTime?: number;
  randomSeed?: number;
  /**
   * Series payload mode. 'summary' (the default) returns the 12 friendly-named
   * arrays plus only the symbol series the app's flight report reads every run
   * (Pl, θl, Px, Py, dΦ). 'full' additionally returns every series the branch
   * carries — except tc (wall-clock noise, nondeterministic) and the symbols
   * duplicating the friendly dozen. Full costs ~45% extra single-sim wall
   * clock in serialization, so request it only when the extra series are
   * actually consumed (plot pickers, CSV export).
   */
  series?: 'summary' | 'full';
}

export interface StaticInfo {
  length: number;
  /** Launch mass (kg) — includes the motor when one is set. */
  mass: number;
  /** Dry structure mass (kg) — no motor. */
  massEmpty: number;
  /** Dry structure CG (m from nose tip) — no motor. */
  cgEmpty: number;
  /** Launch CG (m from nose tip) — includes the motor when one is set. */
  cg: number;
  cp: number;
  cna: number;
  stabilityCalibers: number;
  refDiameter: number;
  warnings: number;
  /** Engine warning messages (geometry problems etc.). */
  warningTexts: string[];
}

// ---------- Component-tree API (P2.1) ----------

export type ComponentType =
  | 'stage'
  | 'nosecone' | 'transition' | 'bodytube'
  | 'trapezoidfinset' | 'ellipticalfinset' | 'freeformfinset' | 'tubefinset'
  | 'innertube' | 'tubecoupler' | 'centeringring' | 'bulkhead' | 'engineblock'
  | 'launchlug' | 'railbutton'
  // App-level component: the editor's engineTree() lowers a fairing to a
  // kernel strake-fin + CD/mass overrides before buildTree — the kernel
  // itself never sees this type.
  | 'fairing'
  | 'parachute' | 'streamer' | 'shockcord' | 'masscomponent'
  // Off-axis assemblies (ComponentAssembly): a non-separating pod, or a
  // separable parallel booster. Nested under a body component, never at the
  // rocket root. Kernel support (PodSet/ParallelStage) is compiled in; the
  // JS-bridge build path lands in a later phase.
  | 'podset' | 'parallelstage';

/**
 * Stage separation trigger (lower stages only; desktop default "ejection").
 * On a `stage` node: `separationEvent`, `separationDelay` (s),
 * `separationAltitude` (m, for the altitude events), and `nozzleExitDiameter`
 * (m; RASAero power-on base-drag reduction, 0/absent = power-off, all stages).
 */
export type SeparationEvent =
  | 'launch' | 'ignition' | 'burnout' | 'ejection' | 'upperignition'
  | 'altitudeascending' | 'apogee' | 'altitudedescending' | 'never';

/**
 * When a mount's motor ignites. "automatic" = launch-stage motors at launch,
 * upper-stage motors on the ejection charge of the stage below (the low/mid-
 * power pattern). High-power sustainers use electronics: "burnout" or
 * "launch" plus a timer delay.
 */
export type IgnitionEvent = 'automatic' | 'launch' | 'ejectioncharge' | 'burnout' | 'never';

export interface ComponentPosition {
  method: 'top' | 'middle' | 'bottom' | 'absolute';
  /** meters, per the method's convention */
  offset: number;
}

/**
 * A component-tree node. `type` selects the component; the remaining keys are
 * that type's parameters (SI units, radians — see engine-java ComponentFactory
 * for the full per-type list). Nodes with an `id` can be addressed later,
 * e.g. as motor mounts.
 */
export interface ComponentNode {
  type: ComponentType;
  id?: string;
  name?: string;
  /** Bulk material density (kg/m^3). */
  density?: number;
  position?: ComponentPosition;
  children?: ComponentNode[];
  [param: string]: unknown;
}

export interface RocketTree {
  name?: string;
  components: ComponentNode[];
}

export interface FlightSummary {
  maxAltitude: number;
  maxVelocity: number;
  maxAcceleration: number;
  maxMachNumber: number;
  timeToApogee: number;
  flightTime: number;
  groundHitVelocity: number;
  /** Velocity when clearing the launch rod/rail (m/s). */
  launchRodVelocity: number;
  /** Velocity at recovery-device deployment (m/s); null if never deployed. */
  deploymentVelocity: number | null;
  /**
   * Kernel-computed optimum ejection delay (s): coast time from burnout to
   * BALLISTIC apogee (a deployment-free probe flight — not the deployed
   * flight's apogee). null when not computable.
   */
  optimumDelay: number | null;
}

export interface FlightEvent {
  type: string;
  time: number;
  /**
   * Name of the component that raised the event (present for events with a
   * source, e.g. RECOVERY_DEVICE_DEPLOYMENT carries the parachute's name —
   * how dual-deployment drogue and main are told apart).
   */
  source?: string;
}

export interface FlightSeries {
  time: number[];
  altitude: number[];
  velocity: number[];
  acceleration: number[];
  mass: number[];
  thrust: number[];
  drag: number[];
  mach: number[];
  /** Stability margin (calibers). */
  stability: number[];
  cpLocation: number[];
  cgLocation: number[];
  /** Angle of attack (rad). */
  aoa: number[];
  /**
   * Symbol-keyed series beyond the friendly-named dozen above. Which symbols
   * are present depends on {@link SimulationOptions.series}: 'summary' (the
   * default) carries only Pl, θl, Px, Py, dΦ — the ones the app's flight
   * report reads every run; 'full' carries every series the branch records
   * ("Vz", "Cdf", "ρ"…) except tc (wall-clock noise) and the symbols that
   * would duplicate the friendly dozen ("t", "h"…). NaN/Infinity samples
   * arrive as null (JSON), hence the (number | null)[] element type; the
   * named arrays share that wire behavior. Always check for undefined
   * before use.
   */
  [symbol: string]: (number | null)[] | undefined;
}

/**
 * One flight branch of a staged rocket: branch 0 is the sustainer stack
 * (same data as the top-level events/series); each further branch is a
 * separated booster's own flight — its descent, recovery and ground hit.
 */
export interface FlightBranch {
  /** Stage name from the design ("Sustainer", "Booster"…). */
  name: string;
  events: FlightEvent[];
  series: FlightSeries;
}

/**
 * One simulation warning (large AoA, high-speed deployment, no recovery
 * device…). ABSENT on engine artifacts predating the warning export.
 */
export interface EngineWarning {
  /**
   * Stable machine key: the typed Warning subclass name ("LargeAOA",
   * "HighSpeedDeployment", "EventAfterLanding", "MissingMotor") or the
   * kernel's l10n key for the singleton warnings ("NO_RECOVERY_DEVICE",
   * "TUMBLE_UNDER_THRUST", "SUPERSONIC"…); "Other" when neither applies.
   */
  key: string;
  /** Human message incl. source component names (Warning.toString()). */
  message: string;
  /** MessagePriority export label. */
  priority?: 'LOW' | 'NORMAL' | 'HIGH';
}

export interface FlightResult {
  /** Whole-flight summary (branch 0 = the sustainer stack). */
  summary: FlightSummary;
  events: FlightEvent[];
  series: FlightSeries;
  /** Present only for staged flights that actually separated (≥2 branches). */
  branches?: FlightBranch[];
  /**
   * Simulation warnings (whole flight, not per-branch). Optional: the
   * committed vendor orkengine.mjs predates the export — arrives after the
   * next engine rebuild (engine:js + differential pass).
   */
  warnings?: EngineWarning[];
  /** The same warnings as plain text — the shape staticInfo() uses. */
  warningTexts?: string[];
}

/** Per-component static info (SI), from OrkRocket.componentInfo(). */
export interface ComponentInfo {
  /** Component's own length (m). */
  length: number;
  /**
   * The component's own mass (kg), override-aware. For a fin SET this is the
   * mass of ALL fins combined (OpenRocket semantics — overrides too).
   */
  mass: number;
  /** Mass of the component plus all its children (kg). */
  sectionMass: number;
  /** CG measured from the component's own front (m). */
  cgX: number;
  /** Absolute position of the component's front from the nose tip (m). */
  positionX: number;
}

/** Options for {@link OrkRocket.dragSweep}; a Mach grid at a fixed angle. */
export interface DragSweepOptions {
  /** First Mach (default 0.05). */
  machMin?: number;
  /** Last Mach (default 3.0). */
  machMax?: number;
  /** Mach increment (default 0.05). */
  machStep?: number;
  /** Angle of attack in degrees (default 0 — the zero-alpha drag polar). */
  aoaDeg?: number;
  /**
   * Optional Reynolds matching: [mach, altitude m] pairs pin the ISA
   * atmosphere (hence Re) per Mach point, linearly interpolated — the same
   * mechanism as RASAero's Mach-Alt table. Absent ⇒ sea level throughout.
   */
  machAlt?: [number, number][];
}

/** One power state's drag coefficients across the Mach grid (index-aligned to `machs`). */
export interface DragCurve {
  /** Total CD per Mach. */
  total: number[];
  /** Skin-friction CD per Mach. */
  friction: number[];
  /** Pressure/wave CD per Mach. */
  pressure: number[];
  /** Base CD per Mach (the power-on curve reflects the nozzle-exit reduction). */
  base: number[];
}

/**
 * Drag polar sweep (RASAero-style Aero Plots). A static design property — no
 * flight required. NOTE: the underlying method is Extended Barrowman: accurate
 * subsonic/transonic, approximate above ~Mach 1.5-2 (full supersonic fidelity
 * is a later feature). The UI labels the supersonic region accordingly.
 */
export interface DragSweep {
  /** Mach grid (x-axis for every curve). */
  machs: number[];
  /** Whether any stage sets a nozzle exit diameter (so power-on differs from power-off). */
  hasNozzle: boolean;
  /**
   * CP location per Mach (m from the nose tip), at the sweep's angle of attack.
   * Power state doesn't move CP, so one curve serves both. Feeds the
   * validation harness and CP-vs-Mach plotting.
   */
  cp: number[];
  /** Normal-force-coefficient slope CNα per Mach (per radian, kernel reference area). */
  cna: number[];
  /** Coast (motors off) drag. */
  powerOff: DragCurve;
  /** Boost (all stages thrusting) drag — differs from powerOff only when hasNozzle. */
  powerOn: DragCurve;
  /** Per-component power-off total CD (index-aligned to `machs`). */
  components: { name: string; cd: number[] }[];
}

/** A rocket design held inside the engine, addressed by handle. */
export class OrkRocket {
  private readonly handle: number;
  private readonly mountHandle: number;

  private constructor(handle: number, mountHandle: number) {
    this.handle = handle;
    this.mountHandle = mountHandle;
  }

  /**
   * Builds a rocket from an arbitrary component tree (Phase 2 API).
   * Give the motor-mount inner tube an `id` and pass it to setMotorById.
   */
  static buildTree(tree: RocketTree): OrkRocket {
    const handle = ork.buildRocket(JSON.stringify(tree));
    return new OrkRocket(handle, -1);
  }

  /** Attaches a motor to the mount with the given node id (buildTree rockets). */
  setMotorById(componentId: string, motor: MotorSpec): void {
    ork.setMotorById(
      this.handle, componentId, motor.designation, motor.diameter, motor.length,
      motor.times, motor.thrusts, motor.masses, motor.cgX, motor.ejectionDelay);
  }

  /**
   * Overrides WHEN this mount's motor ignites (call after setMotorById).
   * Staged rockets: "automatic" is the low/mid-power default; high-power
   * sustainers are electronics-timed — e.g. ('burnout', 1.0) for booster
   * burnout + 1 s.
   */
  setMotorIgnitionById(componentId: string, event: IgnitionEvent, delayS = 0): void {
    ork.setMotorIgnitionById(this.handle, componentId, event, delayS);
  }

  /** @deprecated Fixed-layout builder kept for the engine tests; the app uses buildTree(). */
  static build(spec: RocketSpec): OrkRocket {
    const r = ork.newRocket();
    ork.addNoseCone(
      r, spec.noseCone.length, spec.noseCone.aftRadius, spec.noseCone.thickness,
      spec.noseCone.shape ?? 'ogive', spec.noseCone.materialDensity ?? 0);
    const body = ork.addBodyTube(
      r, spec.bodyTube.length, spec.bodyTube.outerRadius, spec.bodyTube.thickness,
      spec.bodyTube.materialDensity ?? 0);
    ork.addTrapezoidFins(
      body, spec.fins.count, spec.fins.rootChord, spec.fins.tipChord,
      spec.fins.sweep, spec.fins.height, spec.fins.thickness,
      spec.fins.materialDensity ?? 0);
    const mount = ork.addInnerTube(
      body, spec.motorMount.length, spec.motorMount.outerRadius, spec.motorMount.thickness, 0);
    if (spec.parachute) {
      ork.addParachute(body, spec.parachute.diameter, spec.parachute.dragCoefficient ?? 0);
    }
    return new OrkRocket(r, mount);
  }

  /** @deprecated Pairs with build(); the app assigns motors via setMotorById(). */
  setMotor(motor: MotorSpec): void {
    ork.setMotor(
      this.handle, this.mountHandle, motor.designation, motor.diameter, motor.length,
      motor.times, motor.thrusts, motor.masses, motor.cgX, motor.ejectionDelay);
  }

  /**
   * Enable the opt-in "Rogers Modified Barrowman" body-in-presence-of-fins
   * interference (Kbf). Affects both the reported static CP/stability and the
   * flight sim. Call before {@link staticInfo}/{@link simulate}. Off by default;
   * off ⇒ classic Barrowman (bit-identical to before).
   */
  setRogersModifiedBarrowman(enabled: boolean): void {
    ork.setRogersModifiedBarrowman(this.handle, enabled);
  }

  /**
   * Enable the opt-in supersonic aerodynamics model (RASAero feature #1,
   * Phase 1): corrected supersonic fin normal force, exact NACA-1307 body-fin
   * interference, and Mach-dependent nose CNα — CP moves with Mach above M1
   * instead of collapsing forward. Affects staticInfo, simulate and dragSweep.
   * Off by default; off ⇒ classic Extended Barrowman (bit-identical).
   * Validated against the wind-tunnel anchor suite in validation/.
   */
  setSupersonicAero(enabled: boolean): void {
    ork.setSupersonicAero(this.handle, enabled);
  }

  /** Length, mass, CG/CP, stability margin — computed at Mach 0.3, AoA 0. */
  staticInfo(): StaticInfo {
    const parsed = JSON.parse(ork.getStaticInfo(this.handle)) as StaticInfo & { error?: string };
    if (parsed.error) throw new Error(`Static analysis failed: ${parsed.error}`);
    return parsed;
  }

  /** Static info for one component, addressed by its tree-node id. */
  componentInfo(componentId: string): ComponentInfo {
    const parsed = JSON.parse(ork.getComponentInfo(this.handle, componentId)) as ComponentInfo & { error?: string };
    if (parsed.error) throw new Error(`Component info failed: ${parsed.error}`);
    return parsed;
  }

  /**
   * Drag polar sweep (CD vs Mach) with power-off/power-on curves and a
   * per-component breakdown. Static — no flight needed. See {@link DragSweep}.
   */
  dragSweep(options: DragSweepOptions = {}): DragSweep {
    const raw = ork.getDragSweep(this.handle, JSON.stringify({
      machMin: options.machMin ?? 0.05,
      machMax: options.machMax ?? 3.0,
      machStep: options.machStep ?? 0.05,
      aoaDeg: options.aoaDeg ?? 0,
      machAlt: options.machAlt,
    }));
    const parsed = JSON.parse(raw) as DragSweep & { error?: string };
    if (parsed.error) throw new Error(`Drag sweep failed: ${parsed.error}`);
    return parsed;
  }

  simulate(options: SimulationOptions = {}): FlightResult {
    const raw = ork.simulateJson(this.handle, JSON.stringify({
      rodLength: options.launchRodLength ?? 1.0,
      rodAngle: options.launchRodAngle ?? 0,
      windAverage: options.windAverage ?? 0,
      windStdDeviation: options.windStdDeviation ?? 0,
      launchAltitude: options.launchAltitude ?? 0,
      temperature: options.temperature,
      pressure: options.pressure,
      launchLatitude: options.launchLatitude,
      launchLongitude: options.launchLongitude,
      timeStep: options.timeStep ?? 0.05,
      maxTime: options.maxTime,
      randomSeed: options.randomSeed,
      series: options.series,
    }));
    const parsed = JSON.parse(raw) as FlightResult & { error?: string };
    if (parsed.error) {
      throw new Error(`Simulation failed: ${parsed.error}`);
    }
    return parsed;
  }
}

/** Frees all engine-side objects (all OrkRocket handles become invalid). */
export function resetEngine(): void {
  ork.reset();
}
