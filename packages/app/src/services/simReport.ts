import type { EngineWarning, FlightEvent, FlightResult, FlightSeries, MotorSpec, StaticInfo } from '@online-openrocket/engine';
import { G0 } from '@online-openrocket/engine';
import type { LaunchConditions } from '../components/LaunchPanel.js';
import { displayDesignation } from './motorDb.js';
import { formatWarningText } from './simWarnings.js';

/**
 * Post-simulation report: every attribute the owner's flight-day workflow needs,
 * derived from the engine's summary/events/series (all SI). One SimRun is
 * one row in the stored-simulations table and one line in the CSV export.
 */

/** App-side metadata about the loaded motor (engine's MotorSpec has no mfr). */
export interface MotorMeta {
  label: string;
  manufacturer?: string;
  /** Delays the motor is actually sold/drilled with (s). */
  availableDelays?: number[];
  /** User asked for the auto-computed optimal delay. */
  autoDelay?: boolean;
  /** 'SU' | 'reload' | 'hybrid' (thrustcurve.org catalog). */
  type?: string;
  /** Propellant name (e.g. "Classic", "White Lightning"). */
  propellant?: string;
  /** Reload case (e.g. "Pro29-6GXL"); empty for single-use. */
  motorCase?: string;
  /** Motors firing together (cluster count of the mount); 1 = no cluster. */
  motorCount?: number;
  /** High-power per the owner's G80 rule (>80 N avg or >160 Ns) — drives staging defaults/warnings. */
  highPower?: boolean;
  /**
   * EX-library motorId ("ex:" + slug), recorded when an EX motor is picked so
   * export resolves the EXACT imported entry. Two vendors' same-designation
   * curves coexist in the library, and a designation-only lookup wrote
   * whichever vendor happened to import first into the saved file.
   */
  exMotorId?: string;
  /**
   * Desktop-.ork motor identity, captured at import and written back verbatim
   * on export so the desktop's matcher (digest tier first) resolves the motor
   * silently. Never displayed — `manufacturer` above stays the thrustcurve
   * abbreviation the UI shows.
   */
  orkManufacturer?: string;
  /** Desktop <type> (single|reload|hybrid), verbatim from the file. */
  orkType?: string;
  /** Desktop motor <digest>, verbatim from the file. */
  orkDigest?: string;
}

/** Human label for the catalog motor type. */
export function motorTypeLabel(type: string | undefined): string {
  return type === 'SU' ? 'single-use'
    : type === 'reload' ? 'reload'
    : type === 'hybrid' ? 'hybrid'
    : type ?? '';
}

/** Safety thresholds (SI). Sources: common HPR/NAR guidance + the owner's rules. */
export const SAFETY = {
  /** Minimum speed leaving the launch guide (m/s) — ~50 ft/s guidance. */
  minRodExitVelocity: 15,
  /** Minimum thrust:weight at rod departure. */
  minThrustToWeight: 5,
  /**
   * Opening shock: a device deploying faster than ~70 ft/s risks a zippered
   * tube / torn chute. 70 ft/s is also the top of the accepted drogue-descent
   * band, so a main opening under a healthy drogue never trips this.
   */
  maxDeploymentVelocity: 21.34,
  /** Descent under a drogue: accepted band tops out at 70 ft/s (the owner). */
  maxDrogueDescentRate: 21.34,
  /** Landing descent rate: 20 ft/s or lower (the owner). */
  maxLandingRate: 6.1,
  /** Static margin sanity band (calibers). */
  minStaticMargin: 1.0,
  maxStaticMargin: 3.0,
} as const;

/**
 * Tiered stability verdict — one rule for the design page, vitals strip and
 * launch report (they used to disagree: design showed a green check with no
 * upper bound while the report red-flagged the same rocket as over-stable).
 * Under-stability is the DANGEROUS case (red); over-stability mostly means
 * weathercocking in wind — a caution (yellow), not a failure. Thresholds are
 * provisional pending the owner's call (response-2026-08-05a.md #4).
 */
export type StabilityState = 'ok' | 'under' | 'over';
export function stabilityState(cal: number | null | undefined): StabilityState | null {
  if (cal == null || !Number.isFinite(cal)) return null;
  if (cal < SAFETY.minStaticMargin) return 'under';
  if (cal > SAFETY.maxStaticMargin) return 'over';
  return 'ok';
}

/**
 * Static margin as a PERCENTAGE, desktop OpenRocket's PercentageOfLengthUnit:
 * (CP − CG) divided by the AERODYNAMIC length — the bounding span of the
 * aerodynamic components — not the all-components length. Older StaticInfo
 * payloads (a session autosaved before the field existed) fall back to
 * `length`, which is what the All-stats tile always used.
 */
export function stabilityPercent(info: Pick<StaticInfo, 'cp' | 'cg' | 'length'>
  & { lengthAerodynamic?: number }): number | null {
  const ref = info.lengthAerodynamic && info.lengthAerodynamic > 0
    ? info.lengthAerodynamic
    : info.length;
  if (!ref || !Number.isFinite(ref) || ref <= 0) return null;
  return ((info.cp - info.cg) / ref) * 100;
}

/** How the margin reads app-wide (Preferences → Display). */
export type StabilityUnit = 'cal' | 'pct' | 'both';

/**
 * The one stability string, so the vitals strip, the floating chip, the 2D and
 * 3D callouts, the Fly screen and the schematic export can never disagree
 * again. Percent was requested on the beta thread — on a very long or very
 * short airframe "two calibers" means quite different things, and the
 * percentage is the figure that stays comparable.
 */
export function formatStability(
  info: Pick<StaticInfo, 'cp' | 'cg' | 'length' | 'stabilityCalibers'> & { lengthAerodynamic?: number },
  unit: StabilityUnit = 'cal',
): string {
  const cal = `${info.stabilityCalibers.toFixed(2)} cal`;
  if (unit === 'cal') return cal;
  const pct = stabilityPercent(info);
  if (pct === null) return cal;
  const pctText = `${pct.toFixed(1)}%`;
  return unit === 'pct' ? pctText : `${cal} · ${pctText}`;
}

/**
 * The stability string for a STORED run. Falls back to calibers when the run
 * predates `launchStaticMarginPct` — a saved flight cannot be re-measured.
 */
export function formatRunStability(
  cal: number | null,
  pct: number | null | undefined,
  unit: StabilityUnit = 'cal',
): { value: string; unit: string } {
  if (cal === null || !Number.isFinite(cal)) return { value: '—', unit: 'cal' };
  const calText = cal.toFixed(2);
  if (unit === 'cal' || pct == null || !Number.isFinite(pct)) {
    return { value: calText, unit: 'cal' };
  }
  if (unit === 'pct') return { value: pct.toFixed(1), unit: '%' };
  return { value: `${calText} cal · ${pct.toFixed(1)}`, unit: '%' };
}

const FPS = 3.28084;
const fps = (v: number) => `${(v * FPS).toFixed(0)} ft/s`;

/** One recovery-device deployment (dual deploy: drogue + main = two rows). */
export interface DeploymentReport {
  /** Device name from the design tree (e.g. "Drogue", "Main Parachute"). */
  device: string;
  time: number;
  altitude: number | null;
  /** Speed when this device opened (opening shock). */
  velocityAtDeployment: number | null;
  /**
   * Settled descent rate under this device: velocity just before the next
   * deployment, or the ground-hit velocity for the last (landing) device.
   */
  descentRate: number | null;
  isLanding: boolean;
  /** Opening shock verdict (false = too fast — THIS device's problem). */
  openingOk: boolean | null;
  /** Descent-rate verdict: drogue band ≤70 ft/s, landing ≤20 ft/s. */
  descentOk: boolean | null;
}

/** One separated stage's own flight (staged rockets; branch 0 excluded). */
export interface BranchReport {
  /** Stage name ("Booster"…). */
  name: string;
  /** That stage's motor, when known. */
  motorLabel?: string;
  /** Branch apogee (m) — the altitude at separation, roughly. */
  apogee: number | null;
  /** True when the branch shows tumble recovery (no device, TUMBLE event). */
  tumbles: boolean;
  deployments: DeploymentReport[];
  landingRate: number | null;
  safeLandingRate: boolean | null;
}

export interface SimRun {
  id: string;
  /** epoch ms */
  when: number;
  rocket: string;
  /** Display designation (Cesaroni impulse prefix / "HP-" already stripped). */
  motor: string;
  manufacturer: string;
  motorDiameterMm: number;
  /** 'single-use' | 'reload' | 'hybrid' (optional: older stored runs lack it). */
  motorType?: string;
  propellant?: string;
  /** Reload case; empty for single-use motors. */
  motorCase?: string;
  /** Motors firing together (cluster); absent/1 = single motor. */
  motorCount?: number;
  /** Ejection delay the sim flew with (s). */
  delayS: number;

  // Results (SI)
  maxAltitude: number;
  maxVelocity: number;
  maxMach: number;
  maxAcceleration: number;
  timeToApogee: number;
  timeToBurnout: number | null;
  timeToRodDeparture: number | null;
  rodExitVelocity: number | null;
  thrustToWeightAtRod: number | null;
  launchMass: number | null;
  /** Rocket mass after motor burnout (kg) — the owner's "recovery weight". */
  burnoutMass?: number | null;
  /**
   * Angle of attack (RADIANS) at launch guide exit. The crosswind, not the
   * design, is what separates the CP below from the Design tab's: at zero wind
   * the two agree to 0.03 in on a real file, and the gap grows monotonically
   * with AoA. Showing the cause beside the effect is what stops the two panels
   * reading as a contradiction.
   */
  rodExitAoa: number | null;
  launchCG: number | null;
  launchCP: number | null;
  launchStaticMarginCal: number | null;
  /**
   * The same margin as a percentage of aerodynamic length. Recorded at build
   * time because a stored run has no rocket to re-measure. Absent on runs
   * saved before the stability-unit preference existed — those display in
   * calibers whatever the preference says, which is the honest fallback.
   */
  launchStaticMarginPct?: number | null;
  /** First deployment (kept for CSV/back-compat; see `deployments`). */
  altitudeAtDeployment: number | null;
  velocityAtDeployment: number | null;
  /** Every recovery deployment, in order — drogue first, main later. */
  deployments: DeploymentReport[];
  /** Staged rockets: each separated stage's own flight (booster branches). */
  branches?: BranchReport[];
  /** Labels of booster/other-mount motors flown alongside the primary. */
  boosterMotors?: string[];
  /** Final descent rate = ground-hit velocity (target ≤ 20 ft/s). */
  landingRate: number | null;
  safeLandingRate: boolean | null;
  groundHitVelocity: number;
  totalFlightTime: number;
  optimumDelayS: number | null;
  /** Optimum rounded to the nearest whole second (drill-to-fit rule). */
  recommendedDelayS: number | null;

  // Safety verdicts
  safeLiftoffSpeed: boolean | null;
  safeThrustToWeight: boolean | null;
  safeDeployment: boolean | null;
  staticMarginOk: boolean | null;
  weathercockRisk: 'low' | 'moderate' | 'high' | null;

  /**
   * Kernel simulation warnings (raw {key, message, priority} triples —
   * simWarnings.ts renders them in the app's voice). Absent on runs stored
   * before this field OR flown on an engine artifact predating the warning
   * export; an empty array means the flight genuinely raised none.
   */
  simWarnings?: EngineWarning[];
  /**
   * Landing drift: lateral distance from the pad at touchdown (m, last Pl
   * sample) and its compass bearing (° clockwise from north, from θl).
   * Absent on runs stored before this build; null when the engine artifact
   * carried no symbol-keyed series.
   */
  landingDistanceM?: number | null;
  landingBearingDeg?: number | null;
  /** Peak |roll rate| over the flight (rad/s, from dΦ). Same absence rules. */
  maxRollRateRadS?: number | null;

  windAvg: number;
  execMs: number;
  /**
   * Which aerodynamics model produced this run: 'classic' Extended Barrowman
   * (desktop parity), the opt-in 'supersonic' RASAero-class model, or
   * 'auto-supersonic' (Auto mode crossed the Mach-0.9 threshold and re-flew
   * on the supersonic model). Absent on runs stored before v0.025.
   */
  aeroModel?: 'classic' | 'supersonic' | 'auto-supersonic';
  /**
   * Rogers Modified Barrowman (Kbf) was on for this run. Only meaningful for
   * classic-model runs — the supersonic model contains the full NACA-1307
   * interference and supersedes the option. Absent before v0.033.
   */
  rogersKbf?: boolean;
  /**
   * Combination-batch grouping: 'single' (one motor type in every tube) or
   * 'mixed 2+2' / 'mixed 3+3'. Absent outside combination batches.
   */
  motorConfig?: string;
  /**
   * Display name of the flight configuration the working motor set came from
   * at launch (Stage B, v0.050+). Absent when none was active — a custom
   * motor set, or a design without configurations. NOT motorConfig, which
   * means cluster combination.
   */
  flightConfig?: string;
  comments: string;
}

/** Linear interpolation of a series value at time t. */
function at(times: number[], values: number[], t: number): number | null {
  if (times.length === 0 || values.length !== times.length) return null;
  if (t <= times[0]!) return values[0]!;
  for (let i = 1; i < times.length; i++) {
    if (times[i]! >= t) {
      const t0 = times[i - 1]!;
      const t1 = times[i]!;
      const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      const v0 = values[i - 1]!;
      const v1 = values[i]!;
      if (v0 === null || v1 === null) return null;
      return v0 + f * (v1 - v0);
    }
  }
  return values[values.length - 1]!;
}

function eventTime(result: FlightResult, type: string): number | null {
  const ev = result.events.find((e) => e.type === type);
  return ev ? ev.time : null;
}

/**
 * Recommended delay = the optimum rounded to the nearest WHOLE second.
 * Real-world rule (the owner's): whatever the manufacturer prescribes, flyers
 * drill the delay to the whole second they want — so an optimal 12.7 s
 * recommends 13 s even if the prescribed list is 0/6/8/10/14. The
 * prescribed list stays informational only.
 */
export function recommendDelay(optimum: number | null): number | null {
  if (optimum === null || !Number.isFinite(optimum)) return null;
  return Math.max(0, Math.round(optimum));
}

/** Per-device deployments for ONE flight branch (drogue/main ordering). */
function extractDeployments(
  events: FlightEvent[],
  series: FlightSeries,
  groundHit: number | null,
): DeploymentReport[] {
  const deployEvents = events.filter((e) => e.type === 'RECOVERY_DEVICE_DEPLOYMENT');
  return deployEvents.map((ev, i) => {
    const device = ev.source ?? `Recovery device ${i + 1}`;
    const isLanding = i === deployEvents.length - 1;
    const vDeploy = at(series.time, series.velocity, ev.time);
    let descentRate: number | null;
    if (isLanding) {
      descentRate = groundHit !== null && Number.isFinite(groundHit) ? groundHit : null;
    } else {
      // Sample just before the next device opens — fully settled under this one.
      const tNext = deployEvents[i + 1]!.time;
      descentRate = at(series.time, series.velocity, Math.max(ev.time, tNext - 0.2));
    }
    return {
      device,
      time: ev.time,
      altitude: at(series.time, series.altitude, ev.time),
      velocityAtDeployment: vDeploy,
      descentRate,
      isLanding,
      openingOk: vDeploy === null ? null : Math.abs(vDeploy) <= SAFETY.maxDeploymentVelocity,
      // abs like openingOk — descent velocities are magnitudes today, but a
      // signed series would make an unsigned ≤ check pass vacuously.
      descentOk: descentRate === null ? null
        : Math.abs(descentRate) <= (isLanding ? SAFETY.maxLandingRate : SAFETY.maxDrogueDescentRate),
    };
  });
}

/** Last finite sample of a symbol-keyed series (wire NaN arrives as null). */
function lastFinite(arr: (number | null)[] | undefined): number | null {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Where the engine's wind pushes the rocket. The kernel's PinkNoiseWindModel
 * holds direction fixed at π/2 — "an East wind", meteorological convention:
 * wind FROM the east. The stepper ADDS the wind vector to the rocket
 * velocity to get airspeed (AbstractSimulationStepper), so the air mass
 * itself moves toward −x = west and the rocket drifts downwind to compass
 * 270°. Verified against a real windy sim in simReport.kernel.test.ts.
 */
export const WIND_BLOWS_TOWARD_DEG = 270;

/**
 * Landing drift from the pad, off the sustainer branch's series: distance is
 * the last finite lateral-distance (Pl, TYPE_POSITION_XY) sample; bearing is
 * the last finite lateral-direction (θl, TYPE_POSITION_DIRECTION) sample.
 * θl is the right direction source — the kernel computes it as
 * atan2(x, y) reduced to [0, 2π) with x = east, y = north ("(x, y) instead
 * of (y, x) because 0 is north" — SimulationStatus.storeData), i.e. it IS
 * the compass bearing; atan2(Py, Px) would be the math-convention angle
 * (0 = east, counterclockwise) and would need remapping. Px/Py are kept
 * only as a fallback for a series set that carries positions but no θl.
 */
export function extractLandingDrift(series: FlightSeries): {
  distanceM: number | null; bearingDeg: number | null;
} {
  const distanceM = lastFinite(series['Pl']);
  let bearingRad = lastFinite(series['θl']);
  if (bearingRad === null) {
    const x = lastFinite(series['Px']);
    const y = lastFinite(series['Py']);
    if (x !== null && y !== null && (x !== 0 || y !== 0)) {
      bearingRad = (Math.atan2(x, y) + 2 * Math.PI) % (2 * Math.PI);
    }
  }
  return {
    distanceM,
    bearingDeg: bearingRad === null ? null : (bearingRad * 180) / Math.PI,
  };
}

/**
 * Below this the "max roll rate" is integrator noise, not rotation: most
 * rockets report ~1e-10…1e-3 rad/s of numerical drift, while the slowest
 * deliberate roll (canted fins) is orders above. 0.01 rad/s ≈ 0.57 °/s
 * ≈ 0.0016 r/s — under a tenth of a turn over a whole minute of flight.
 */
export const ROLL_RATE_MEANINGFUL_RAD_S = 0.01;

/** Peak |roll rate| (rad/s) from the dΦ series; null when absent/empty. */
export function extractMaxRollRate(series: FlightSeries): number | null {
  const arr = series['dΦ'];
  if (!arr) return null;
  let max: number | null = null;
  for (const v of arr) {
    if (v !== null && v !== undefined && Number.isFinite(v)) {
      const a = Math.abs(v);
      if (max === null || a > max) max = a;
    }
  }
  return max;
}

export function buildSimRun(input: {
  result: FlightResult;
  info: StaticInfo;
  motor: MotorSpec;
  meta?: MotorMeta;
  launch: LaunchConditions;
  rocketName: string;
  execMs: number;
  /** Per-stage motor info by STAGE NAME (staged rockets; G80 safety rules). */
  stageMotorInfo?: Record<string, { label: string; highPower: boolean }>;
  boosterMotors?: string[];
  aeroModel?: 'classic' | 'supersonic' | 'auto-supersonic';
  rogersKbf?: boolean;
  motorConfig?: string;
  flightConfig?: string;
}): SimRun {
  const { result, info, motor, meta, launch, rocketName, execMs, stageMotorInfo, boosterMotors, aeroModel, rogersKbf, motorConfig, flightConfig } = input;
  const { summary, series } = result;

  const tRod = eventTime(result, 'LAUNCHROD');
  const tBurnout = eventTime(result, 'BURNOUT');
  const tDeploy = eventTime(result, 'RECOVERY_DEVICE_DEPLOYMENT');
  const tGround = eventTime(result, 'GROUND_HIT');

  const rodExitVelocity = summary.launchRodVelocity
    ?? (tRod !== null ? at(series.time, series.velocity, tRod) : null);
  const thrustAtRod = tRod !== null ? at(series.time, series.thrust, tRod) : null;
  const massAtRod = tRod !== null ? at(series.time, series.mass, tRod) : null;
  const thrustToWeightAtRod = thrustAtRod !== null && massAtRod !== null && massAtRod > 0
    ? thrustAtRod / (massAtRod * G0)
    : null;

  // CP and stability do not exist until the rod is cleared: the kernel records
  // neither at zero airspeed (AbstractSimulationStepper — `if
  // (status.isLaunchRodCleared() && null != forces)`, which is upstream
  // OpenRocket verbatim). cgLocation has no such gap, so scanning each series
  // for its own first finite sample paired sample 0's CG with the rod-clear
  // sample's CP — and the panel then failed its own arithmetic, because
  // (CP - CG) / caliber did not equal the margin printed beside it. A tester
  // hand-checked exactly that and reported the contradiction. One instant for
  // all three rows: the sample the CP first exists at.
  const sampleAt = (arr: number[], i: number): number | null =>
    i >= 0 && arr[i] !== null && Number.isFinite(arr[i]!) ? arr[i]! : null;
  const iRodClear = series.cpLocation.findIndex((v) => v !== null && Number.isFinite(v));
  const launchMass = series.mass[0] ?? null;
  const burnoutMass = tBurnout !== null ? at(series.time, series.mass, tBurnout) : null;
  const rodExitAoa = sampleAt(series.aoa, iRodClear);
  const launchCG = sampleAt(series.cgLocation, iRodClear) ?? info.cg ?? null;
  const launchCP = sampleAt(series.cpLocation, iRodClear) ?? info.cp ?? null;
  const launchStaticMarginCal = sampleAt(series.stability, iRodClear)
    ?? info.stabilityCalibers ?? null;
  // The flight-series margin (calibers, at launch) rescaled onto the same
  // denominator the design views use, so the Results tab can honour the
  // stability-unit preference without re-deriving anything.
  const launchStaticMarginPct = launchStaticMarginCal === null
    ? null
    : (launchStaticMarginCal * info.refDiameter)
        / ((info.lengthAerodynamic && info.lengthAerodynamic > 0)
          ? info.lengthAerodynamic
          : info.length) * 100;

  const altitudeAtDeployment = tDeploy !== null ? at(series.time, series.altitude, tDeploy) : null;
  const velocityAtDeployment = summary.deploymentVelocity
    ?? (tDeploy !== null ? at(series.time, series.velocity, tDeploy) : null);

  // Per-device deployment reports (dual deploy: drogue at apogee, main at
  // altitude). Descent rate under a device = velocity just before the NEXT
  // deployment; the last device's descent rate is the landing rate.
  const deployments = extractDeployments(result.events, series,
    Number.isFinite(summary.groundHitVelocity) ? summary.groundHitVelocity : null);

  // Booster branches (staged flights): each separated stage flies its OWN
  // descent — apogee, recovery (or tumble), and landing verdict per stage.
  const branches: BranchReport[] = [];
  for (const b of result.branches?.slice(1) ?? []) {
    const alt = b.series.altitude.filter((v): v is number => v !== null && Number.isFinite(v));
    const groundEv = b.events.find((e) => e.type === 'GROUND_HIT');
    const vHit = groundEv ? at(b.series.time, b.series.velocity, groundEv.time) : null;
    const landing = vHit !== null && Number.isFinite(vHit) ? Math.abs(vHit) : null;
    branches.push({
      name: b.name,
      motorLabel: stageMotorInfo?.[b.name]?.label,
      apogee: alt.length ? Math.max(...alt) : null,
      tumbles: b.events.some((e) => e.type === 'TUMBLE'),
      deployments: extractDeployments(b.events, b.series, landing),
      landingRate: landing,
      safeLandingRate: landing === null ? null : landing <= SAFETY.maxLandingRate,
    });
  }
  const landingRaw = Number.isFinite(summary.groundHitVelocity)
    ? summary.groundHitVelocity : (tGround !== null ? at(series.time, series.velocity, tGround) : null);
  const landingRate = landingRaw === null ? null : Math.abs(landingRaw); // magnitude, like the branch reports
  const safeLandingRate = landingRate === null ? null : landingRate <= SAFETY.maxLandingRate;

  const optimumDelayS = summary.optimumDelay ?? null;
  const recommendedDelayS = recommendDelay(optimumDelayS);

  // Landing drift + peak roll rate come from the symbol-keyed series (Pl /
  // θl / dΦ) — null on an engine artifact that predates that export.
  const drift = extractLandingDrift(series);
  const maxRollRateRadS = extractMaxRollRate(series);

  const safeLiftoffSpeed = rodExitVelocity !== null
    ? rodExitVelocity >= SAFETY.minRodExitVelocity : null;
  const safeThrustToWeight = thrustToWeightAtRod !== null
    ? thrustToWeightAtRod >= SAFETY.minThrustToWeight : null;
  // Overall "safe deployment" = no device had a hard opening. Per-device
  // detail (WHICH one, drogue or main) lives in `deployments` + comments.
  const safeDeployment = deployments.length > 0
    ? deployments.every((d) => d.openingOk !== false)
    : velocityAtDeployment !== null
      ? Math.abs(velocityAtDeployment) <= SAFETY.maxDeploymentVelocity : null;
  const staticMarginOk = launchStaticMarginCal !== null
    ? launchStaticMarginCal >= SAFETY.minStaticMargin
      && launchStaticMarginCal <= SAFETY.maxStaticMargin
    : null;

  // Weathercocking: how much the wind can rotate the velocity vector while
  // the rocket is slow. Ratio of wind speed to rod-exit speed is the standard
  // rule-of-thumb proxy.
  const weathercockRisk = rodExitVelocity === null || rodExitVelocity <= 0
    ? null
    : launch.windAverage / rodExitVelocity < 0.1 ? 'low'
    : launch.windAverage / rodExitVelocity < 0.25 ? 'moderate'
    : 'high';

  // Format the kernel's static warnings into the app's voice here too: this
  // blob becomes the launch report AND the Comments column of the saved-runs
  // CSV/XLSX, where a raw "[Warning.DISCONTINUITY]" token is just noise.
  const comments: string[] = info.warningTexts.map(formatWarningText);
  // Supersonic flight on the classic model: the flyer should know a validated
  // model exists — and that switching changes the model for the WHOLE flight.
  if ((aeroModel ?? 'classic') === 'classic' && summary.maxMachNumber > 0.9) {
    comments.push(
      `Flight reaches Mach ${summary.maxMachNumber.toFixed(2)} on the classic aero model, `
      + 'which is approximate past ~Mach 0.9 (supersonic CP travel is not modeled). '
      + 'Preferences → Aerodynamics offers a validated supersonic model — switching '
      + 'changes the model for the entire flight, so expect stability and apogee to shift.');
  }
  if (safeLiftoffSpeed === false) {
    comments.push(`Rod-exit speed ${rodExitVelocity!.toFixed(1)} m/s < ${SAFETY.minRodExitVelocity} m/s guidance.`);
  }
  if (safeThrustToWeight === false) {
    comments.push(`Thrust:weight ${thrustToWeightAtRod!.toFixed(1)}:1 at rod exit < ${SAFETY.minThrustToWeight}:1.`);
  }
  for (const d of deployments) {
    if (d.openingOk === false) {
      comments.push(`${d.device} opens at ${Math.abs(d.velocityAtDeployment!).toFixed(1)} m/s (${fps(Math.abs(d.velocityAtDeployment!))}) — hard opening, over the ${fps(SAFETY.maxDeploymentVelocity)} threshold.`);
    }
    if (d.descentOk === false && !d.isLanding) {
      comments.push(`Descent under ${d.device} is ${d.descentRate!.toFixed(1)} m/s (${fps(d.descentRate!)}) — faster than the accepted ${fps(SAFETY.maxDrogueDescentRate)} drogue band.`);
    }
    if (d.descentOk === false && d.isLanding) {
      comments.push(`Landing under ${d.device} at ${d.descentRate!.toFixed(1)} m/s (${fps(d.descentRate!)}) — above the ${fps(SAFETY.maxLandingRate)} landing target.`);
    }
  }
  if (deployments.length === 0 && safeDeployment === false) {
    comments.push(`Deployment at ${Math.abs(velocityAtDeployment!).toFixed(1)} m/s (${fps(Math.abs(velocityAtDeployment!))}) — expect hard opening.`);
  }
  if (deployments.length === 0 && safeLandingRate === false) {
    comments.push(`Landing at ${landingRate!.toFixed(1)} m/s (${fps(landingRate!)}) — above the ${fps(SAFETY.maxLandingRate)} landing target.`);
  }
  if (staticMarginOk === false && launchStaticMarginCal !== null) {
    comments.push(launchStaticMarginCal < SAFETY.minStaticMargin
      ? `Static margin ${launchStaticMarginCal.toFixed(2)} cal — under-stable.`
      : `Static margin ${launchStaticMarginCal.toFixed(2)} cal — over-stable (weathercocks readily).`);
  }
  if (!Number.isFinite(motor.ejectionDelay)) {
    // Plugged motor: no charge to compare against the optimum — instead note
    // the optimum for anyone flying this motor WITH eject another day.
    comments.push(optimumDelayS !== null && Number.isFinite(optimumDelayS)
      ? `Plugged motor (no ejection charge) — recovery must deploy on apogee/altitude electronics. If flown with motor eject instead, the optimal delay is ${optimumDelayS.toFixed(1)}s.`
      : 'Plugged motor (no ejection charge) — recovery must deploy on apogee/altitude electronics.');
  } else if (optimumDelayS !== null && Number.isFinite(optimumDelayS)
      && Math.abs(motor.ejectionDelay - optimumDelayS) > 1.5) {
    comments.push(`Flown delay ${motor.ejectionDelay}s vs optimal ${optimumDelayS.toFixed(1)}s.`);
  }
  // Booster recovery — the owner's G80 rule: high-power boosters MUST have active
  // recovery; low/mid boosters may tumble (no warning).
  for (const b of branches) {
    const landTxt = b.landingRate !== null ? `${b.landingRate.toFixed(1)} m/s (${fps(b.landingRate)})` : 'unknown speed';
    if (b.deployments.length === 0) {
      if (stageMotorInfo?.[b.name]?.highPower === true) {
        comments.push(`${b.name} has NO recovery device — a HIGH-POWER booster must recover actively; it ${b.tumbles ? 'tumbles' : 'falls'} in at ${landTxt}.`);
      }
    } else if (b.safeLandingRate === false) {
      comments.push(`${b.name} lands at ${landTxt} — above the ${fps(SAFETY.maxLandingRate)} landing target.`);
    }
    for (const d of b.deployments) {
      if (d.openingOk === false) {
        comments.push(`${b.name}: ${d.device} opens at ${Math.abs(d.velocityAtDeployment!).toFixed(1)} m/s (${fps(Math.abs(d.velocityAtDeployment!))}) — hard opening.`);
      }
    }
  }

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    when: Date.now(),
    rocket: rocketName,
    motor: displayDesignation(motor.designation, meta?.manufacturer),
    manufacturer: meta?.manufacturer ?? '',
    motorDiameterMm: Math.round(motor.diameter * 1000 * 10) / 10,
    motorType: motorTypeLabel(meta?.type),
    propellant: meta?.propellant ?? '',
    motorCase: meta?.motorCase ?? '',
    motorCount: meta?.motorCount ?? 1,
    delayS: motor.ejectionDelay,
    maxAltitude: summary.maxAltitude,
    maxVelocity: summary.maxVelocity,
    maxMach: summary.maxMachNumber,
    maxAcceleration: summary.maxAcceleration,
    timeToApogee: summary.timeToApogee,
    timeToBurnout: tBurnout,
    timeToRodDeparture: tRod,
    rodExitVelocity,
    thrustToWeightAtRod,
    launchMass,
    burnoutMass,
    rodExitAoa,
    launchCG,
    launchCP,
    launchStaticMarginCal,
    launchStaticMarginPct,
    altitudeAtDeployment,
    velocityAtDeployment,
    deployments,
    branches: branches.length > 0 ? branches : undefined,
    boosterMotors: boosterMotors && boosterMotors.length > 0 ? boosterMotors : undefined,
    landingRate,
    safeLandingRate,
    groundHitVelocity: summary.groundHitVelocity,
    totalFlightTime: summary.flightTime,
    optimumDelayS,
    recommendedDelayS,
    safeLiftoffSpeed,
    safeThrustToWeight,
    safeDeployment,
    staticMarginOk,
    weathercockRisk,
    // Only stored when the engine emitted the field at all — an old artifact
    // must leave simWarnings ABSENT (unknown), not [] (flew clean).
    ...(result.warnings !== undefined ? { simWarnings: result.warnings } : {}),
    landingDistanceM: drift.distanceM,
    landingBearingDeg: drift.bearingDeg,
    maxRollRateRadS,
    windAvg: launch.windAverage,
    execMs,
    aeroModel,
    ...(rogersKbf !== undefined ? { rogersKbf } : {}),
    ...(motorConfig !== undefined ? { motorConfig } : {}),
    ...(flightConfig !== undefined ? { flightConfig } : {}),
    comments: comments.join(' | '),
  };
}
