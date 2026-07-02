/**
 * Typed wrapper around the TeaVM-compiled OpenRocket kernel
 * (vendor/orkengine.cjs — regenerate with `npm run engine:js`).
 *
 * Engine invariants: pure SI units (m, kg, s, N), angles in RADIANS.
 * See engine-java/ for the kernel, shims, patches and differential tests.
 */
import * as ork from '../vendor/orkengine.cjs';

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
  timeStep?: number;
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
    const raw = ork.simulate(
      this.handle,
      options.launchRodLength ?? 1.0,
      options.launchRodAngle ?? 0,
      options.windAverage ?? 0,
      options.windStdDeviation ?? 0,
      options.launchAltitude ?? 0,
      options.timeStep ?? 0.05);
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
