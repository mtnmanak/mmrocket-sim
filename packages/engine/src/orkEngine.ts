/**
 * Typed wrapper around the TeaVM-compiled OpenRocket kernel
 * (vendor/orkengine.cjs — regenerate with `npm run engine:js`).
 *
 * Engine invariants: pure SI units (m, kg, s, N), angles in RADIANS.
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
  launchLatitude?: number;
  launchLongitude?: number;
  timeStep?: number;
  maxTime?: number;
  randomSeed?: number;
}

export interface StaticInfo {
  length: number;
  mass: number;
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
  | 'nosecone' | 'transition' | 'bodytube'
  | 'trapezoidfinset' | 'ellipticalfinset' | 'freeformfinset' | 'tubefinset'
  | 'innertube' | 'tubecoupler' | 'centeringring' | 'bulkhead' | 'engineblock'
  | 'launchlug' | 'railbutton'
  | 'parachute' | 'streamer' | 'shockcord' | 'masscomponent';

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
  timeToApogee: number;
  flightTime: number;
  groundHitVelocity: number;
}

export interface FlightEvent {
  type: string;
  time: number;
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
}

export interface FlightResult {
  summary: FlightSummary;
  events: FlightEvent[];
  series: FlightSeries;
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

  setMotor(motor: MotorSpec): void {
    ork.setMotor(
      this.handle, this.mountHandle, motor.designation, motor.diameter, motor.length,
      motor.times, motor.thrusts, motor.masses, motor.cgX, motor.ejectionDelay);
  }

  /** Length, mass, CG/CP, stability margin — computed at Mach 0.3, AoA 0. */
  staticInfo(): StaticInfo {
    return JSON.parse(ork.getStaticInfo(this.handle)) as StaticInfo;
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
