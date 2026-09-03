import type { EngineWarning, FlightEvent, FlightResult, FlightSeries, MotorSpec, StaticInfo } from '@online-openrocket/engine';
import { boosterBranches, DEFAULT_TIME_STEP_S, G0 } from '@online-openrocket/engine';
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
/**
 * Does this design generate any aerodynamic normal force at all?
 *
 * When it does not, the CP and the stability margin are ARTEFACTS rather than
 * answers. The kernel reports cp = 0 (the nose tip) and cna = 0, and the margin
 * is then (0 - cg)/d — a large negative number that looks like a violently
 * unstable rocket and is really "there was nothing to measure".
 *
 * Measured against the real kernel: a body tube with ONE fin and no nose cone
 * reports cp 0, cna 0, -5.449 cal; with two fins, -5.813. Add a third fin, or a
 * nose cone, and the numbers become real. It is not "no nose cone" as such —
 * fewer than three fins cancel in the measured plane, and a constant-diameter
 * tube contributes no normal force of its own — so the condition to test is the
 * force itself, not the shape of the parts list.
 *
 * This is a state a user passes THROUGH: a tube and a fin set exist before the
 * nose cone does. Printing a green ✓ and a plausible margin there would be the
 * dangerous kind of wrong; printing a huge negative one is merely the confusing
 * kind.
 */
export function hasAerodynamicForce(info: Pick<StaticInfo, 'cna' | 'cnaWorst'>): boolean {
  const cna = shownCna(info);
  return Number.isFinite(cna) && Math.abs(cna) > 1e-8;
}

/**
 * WHICH CP THE APP SHOWS — the forward one, swept over all roll angles.
 *
 * `cp` / `cna` / `stabilityCalibers` are ONE plane, at theta = 0, and for
 * fewer than three fins or a single asymmetric appendage the answer depends on
 * how that part is CLOCKED: measured on this kernel, a one-finned rocket reads
 * -5.346 cal with the fin at 0 degrees and +1.696 cal at 90. Same rocket. The
 * swept figure is clocking-independent, is what desktop OpenRocket shows, and
 * is the one Chuck Rogers argues for — the forward CP is the one to watch.
 * Symmetric designs are unaffected: three and four fins measure identically
 * either way.
 *
 * The `??` is for StaticInfo objects built by hand in tests and for any payload
 * predating the field, NOT for persisted data — StaticInfo is never stored.
 */
export const shownCp = (info: Pick<StaticInfo, 'cp' | 'cpWorst'>): number =>
  info.cpWorst ?? info.cp;
export const shownCna = (info: Pick<StaticInfo, 'cna' | 'cnaWorst'>): number =>
  info.cnaWorst ?? info.cna;
export const shownStability = (
  info: Pick<StaticInfo, 'stabilityCalibers' | 'stabilityCalibersWorst'>,
): number => info.stabilityCalibersWorst ?? info.stabilityCalibers;

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
  & { lengthAerodynamic?: number; cpWorst?: number }): number | null {
  const ref = info.lengthAerodynamic && info.lengthAerodynamic > 0
    ? info.lengthAerodynamic
    : info.length;
  if (!ref || !Number.isFinite(ref) || ref <= 0) return null;
  return ((shownCp(info) - info.cg) / ref) * 100;
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
  info: Pick<StaticInfo, 'cp' | 'cg' | 'length' | 'stabilityCalibers'>
    & { lengthAerodynamic?: number; cpWorst?: number; stabilityCalibersWorst?: number },
  unit: StabilityUnit = 'cal',
): string {
  const cal = `${shownStability(info).toFixed(2)} cal`;
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
  /**
   * Speed over the GROUND at the same instant — descent plus wind drift. What
   * the rocket actually hits the ground at, and what the report used to call
   * the descent rate. Kept beside it, never in place of it: the safety limits
   * are about descent, and in a 5 m/s wind the two differ by half again.
   */
  groundSpeed: number | null;
  isLanding: boolean;
  /** Opening shock verdict (false = too fast — THIS device's problem). */
  openingOk: boolean | null;
  /** Descent-rate verdict: drogue band ≤70 ft/s, landing ≤20 ft/s. */
  descentOk: boolean | null;
  /**
   * THE DRAG COEFFICIENT THIS FLIGHT ACTUALLY FLEW, and the canopy it flew it
   * on — read from the tree that was handed to the kernel, not from the design
   * on screen.
   *
   * Why it is here: the descent verdict rests entirely on this number, and
   * until v0.099 the report named the device but never the figure. That cost
   * two round trips with the owner (2026-09-03): both times a landing-rate
   * report came down to "which Cd did that run actually use?", and neither the
   * results page nor the report could answer it. A reader can now check the
   * verdict against the input in one glance.
   *
   * `cd` is what reached the kernel — already scaled by any spill hole, since
   * the kernel has no vent concept and takes the reduction in the coefficient.
   * `cdNominal` is the canopy's catalogue/entered figure before that scaling,
   * so the two together show the vent doing its work rather than hiding it.
   */
  cd: number | null;
  cdNominal: number | null;
  diameter: number | null;
  spillHoleDiameter: number | null;
}

/**
 * What the kernel was actually handed for each recovery device, keyed by the
 * device NAME the kernel reports in its deployment events.
 *
 * Built from the ENGINE tree rather than the design tree on purpose: if the two
 * ever diverge, the report must show what flew.
 */
export interface FlownRecoveryDevice {
  cd: number | null;
  cdNominal: number | null;
  diameter: number | null;
  spillHoleDiameter: number | null;
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
  /**
   * Integration time step this flight actually used (s); absent = the engine
   * default. Recorded because it is the one launch setting that changes how
   * LONG a flight takes rather than how it flies, so the launch panel needs to
   * know what a stored `execMs` was measured at before it can estimate the cost
   * of a different one. {@link storedSimCost} is that reader.
   */
  timeStepS?: number;
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
  /**
   * PROVENANCE KEYS — what a stored run has to prove before its numbers may
   * be written into an exported `.ork` as that configuration's simulation
   * results (option (c): write our own computed results, guarded).
   *
   * Desktop OpenRocket shows a saved `<flightdata>` block in its simulation
   * table with nothing on screen saying how old it is, so a stale result is
   * indistinguishable from a fresh one. The standing verdict on writing
   * results we cannot vouch for is "the worst outcome: wrong numbers that
   * look authoritative" — these three keys are what let the exporter refuse.
   *
   * All optional: every run stored before v0.074 carries none of them, and a
   * run that cannot prove itself is simply not written.
   */
  /** The `.ork` `<configid>` of the flight configuration that flew. */
  flightConfigId?: string;
  /** Hash of the physics-relevant design tree at launch (names/colours stripped). */
  designKey?: string;
  /** The flown motor set: every mount, designation, delay and ignition setting. */
  motorSetKey?: string;
  /** The launch conditions in force, serialized. */
  conditionsKey?: string;
  comments: string;
}

/**
 * The launch panel's time-step-caution cost reference when this session has
 * not flown yet: the newest stored run of THIS design. Stored runs carry
 * `execMs` and the step it was measured at (`timeStepS` above) precisely so
 * the seconds estimate survives a reload — without a reader the caution
 * degraded to the bare multiplier the moment the tab closed. Matched by
 * rocket name (a stored run has no design identity beyond it), and ONLY that
 * name: another rocket's twelve-second flight must never price this one's.
 * An absent timeStepS stays absent — it means the run flew the engine
 * default, and the caution scales from that.
 */
export function storedSimCost(
  runs: readonly SimRun[], rocketName: string,
): { ms: number; timeStepS?: number } | null {
  const r = runs.find((run) => run.rocket === rocketName
    && Number.isFinite(run.execMs) && run.execMs > 0);
  if (!r) return null;
  return { ms: r.execMs, ...(r.timeStepS != null ? { timeStepS: r.timeStepS } : {}) };
}

/**
 * What a stored run has to prove before we will offer to re-fly it for its
 * charts — and before its numbers may be written into an exported `.ork`.
 *
 * A SimRun stores ~50 scalars and a rocket NAME, so identity cannot come from
 * the run itself. It comes from three provenance keys stamped at launch:
 * `designKey` (the physics-relevant tree, names and colours stripped),
 * `motorSetKey` (every mount's motor, delay and ignition setting) and
 * `conditionsKey` (every launch condition). All three must be present AND
 * equal: a run stored before those keys existed cannot be verified, and an
 * unverifiable match is not a match.
 *
 * This replaced a looser check on launch mass and wind alone, which passed on
 * runs flown at a different rod angle, rod length, altitude, temperature,
 * pressure or latitude — so "Show charts" would re-fly at TODAY's conditions
 * and draw a genuinely different flight under the stored run's numbers.
 *
 * The aerodynamics model is checked separately by `runMatchesModel`, because
 * `null` there means "this run predates the field" and must not be read as a
 * mismatch.
 */
export interface DesignMatchKey {
  designKey: string;
  motorSetKey: string;
  conditionsKey: string;
  aeroMode: 'classic' | 'supersonic' | 'auto';
  effectiveKbf: boolean;
  autoSupersonic: boolean;
}

/**
 * When a run was flown, written so a stale one cannot pass for a fresh one.
 *
 * Same calendar day → the time alone; any other day → the date with it. The
 * history table used to print `toLocaleTimeString()` unconditionally, which made
 * a run from three days ago typographically identical to one flown a minute ago
 * — and the launch report showed no timestamp at all, so the panel a user
 * screenshots and forwards carried no date whatsoever. That is the single
 * strongest cue that a report predates the design, and it was invisible; it cost
 * two investigations on 2026-09-03.
 */
export function formatRunWhen(when: number, now: number = Date.now()): string {
  const d = new Date(when);
  // isFinite alone lets 1e16 through, which is a finite number and an Invalid
  // Date; run history is JSON-parsed from localStorage with no validation of
  // `when`, so a corrupted entry would print "Invalid Date" into the report.
  if (!Number.isFinite(when) || Number.isNaN(d.getTime())) return 'an unknown time';
  const ref = new Date(now);
  if (ref.toDateString() === d.toDateString()) return d.toLocaleTimeString();
  // The YEAR matters: the store keeps 500 runs and never expires them, so
  // without it a run from last December reads exactly like one from a fortnight
  // ago — the very failure this function exists to prevent, one year out.
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== ref.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${date}, ${d.toLocaleTimeString()}`;
}

/**
 * The same instant written to sit inside a sentence — "Flown **at 10:42 AM**",
 * "flown **on Sep 3 at 10:42 AM**".
 *
 * Separate from `formatRunWhen` because a table cell under a "When" header
 * supplies its own preposition and wants the seconds, while prose needs the
 * preposition and does not: nobody tells two flights apart by the eleventh
 * second, and "Flown 10:42:11 AM" reads as machine output rather than English.
 */
export function formatRunWhenProse(when: number, now: number = Date.now()): string {
  const d = new Date(when);
  if (!Number.isFinite(when) || Number.isNaN(d.getTime())) return 'at an unknown time';
  const ref = new Date(now);
  const clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (ref.toDateString() === d.toDateString()) return `at ${clock}`;
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== ref.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `on ${date} at ${clock}`;
}

/**
 * What has changed in the design, motors or launch conditions since a run was
 * flown — the provenance a stored run is rendered with.
 *
 * Returns `null` when it cannot be told (no current design to compare against,
 * or a run stored before these keys existed). **Unknown is not a mismatch**: an
 * old run must not be accused of a difference we cannot see, the same rule
 * `runMatchesModel` already follows.
 */
export const AERO_MODEL_CHANGED = 'the aerodynamics model';

export function changedSinceRun(
  run: SimRun, cur: DesignMatchKey | null,
): string[] | null {
  if (!cur) return null;
  const changed: string[] = [];
  // A key the run does not carry cannot be compared — but one that IS carried
  // and differs is a real mismatch worth naming, so a partial run still reports.
  if (run.designKey && run.designKey !== cur.designKey) changed.push('the design');
  if (run.motorSetKey && run.motorSetKey !== cur.motorSetKey) changed.push('the motor');
  if (run.conditionsKey && run.conditionsKey !== cur.conditionsKey) {
    changed.push('the launch conditions');
  }
  // The model is part of "does this still describe my rocket". Leaving it out
  // let the header print "matches the design as it stands" directly beneath a
  // banner saying the numbers were flown on a different model and are not
  // comparable — two lines a finger-width apart contradicting each other.
  if (runMatchesModel(run, cur) === false) changed.push(AERO_MODEL_CHANGED);
  if (changed.length > 0) return changed;

  // NOTHING DIFFERS — but silence and a clean bill of health are not the same
  // claim, and only the second one can be wrong. Clearing a run requires every
  // key to be present: batch-simulate runs carry `conditionsKey` (buildSimRun
  // always stamps it) and neither of the other two, so a one-key rule would
  // have stamped "matches the design as it stands" on a batch row belonging to
  // a different rocket — worse than the silence this feature replaced.
  const complete = !!run.designKey && !!run.motorSetKey && !!run.conditionsKey;
  return complete ? [] : null;
}

/** "a", "a and b", "a, b and c" — for naming what changed without a bare list. */
export function listAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function runMatchesDesign(run: SimRun, cur: DesignMatchKey): boolean {
  if (!run.designKey || run.designKey !== cur.designKey) return false;
  if (!run.motorSetKey || run.motorSetKey !== cur.motorSetKey) return false;
  if (!run.conditionsKey || run.conditionsKey !== cur.conditionsKey) return false;
  // Unlike the UI's "flown on a different model" mark, an UNKNOWN model is a
  // refusal here: re-flying reproduces a flight, and reproducing one whose
  // model we cannot name is exactly the authoritative-looking wrong number
  // this guard exists to prevent.
  return runMatchesModel(run, cur) === true;
}

/**
 * One spelling of "which aerodynamics model produced this", used by the launch
 * report's detail row and by the stale-run banner, so the two cannot drift.
 */
export function aeroModelLabel(
  aeroModel: SimRun['aeroModel'], rogersKbf?: boolean,
): string {
  switch (aeroModel) {
    case 'supersonic': return 'Supersonic (our extended model)';
    case 'auto-supersonic': return 'Supersonic (auto — flight exceeded Mach 0.9)';
    case 'classic': return `Classic (Extended Barrowman${rogersKbf ? ' + Rogers Kbf' : ''})`;
    default: return '—';
  }
}

/** The same label for the model the app is set to fly RIGHT NOW. */
export function currentModelLabel(cur: {
  aeroMode: 'classic' | 'supersonic' | 'auto';
  effectiveKbf: boolean;
  autoSupersonic: boolean;
}): string {
  if (cur.aeroMode === 'supersonic') return aeroModelLabel('supersonic');
  if (cur.aeroMode === 'auto') {
    return cur.autoSupersonic
      ? aeroModelLabel('auto-supersonic')
      : `Auto (classic${cur.effectiveKbf ? ' + Rogers Kbf' : ''} until Mach 0.9)`;
  }
  return aeroModelLabel('classic', cur.effectiveKbf);
}

/**
 * Whether a stored run was flown on the model the app is set to now.
 *
 * Returns `null` — unknown, do NOT flag — when the run predates the field that
 * would answer it: `aeroModel` is absent before v0.025, and `rogersKbf` before
 * v0.033. An absent field must never render as a mismatch; the app would be
 * accusing old runs of a difference it cannot see.
 */
export function runMatchesModel(
  run: Pick<SimRun, 'aeroModel' | 'rogersKbf'>,
  cur: { aeroMode: 'classic' | 'supersonic' | 'auto'; effectiveKbf: boolean; autoSupersonic: boolean },
): boolean | null {
  if (!run.aeroModel) return null;
  // 'supersonic' and 'auto-supersonic' are the SAME physics — the second only
  // records that Auto chose it rather than the user. Treating them as
  // different would put a "flown on a different model" banner on a flight
  // whose numbers are identical.
  const runSupersonic = run.aeroModel === 'supersonic' || run.aeroModel === 'auto-supersonic';
  const nowSupersonic = cur.aeroMode === 'supersonic'
    || (cur.aeroMode === 'auto' && cur.autoSupersonic);
  if (nowSupersonic || runSupersonic) return runSupersonic === nowSupersonic;
  // Both classic. Kbf is the only remaining difference, and it is real — it
  // moves CP, stability and drag.
  if (run.rogersKbf === undefined) return null;
  return run.rogersKbf === cur.effectiveKbf;
}

/**
 * A short, stable hash. FNV-1a, base-36 — enough to tell "this is the same
 * design/motor set" from "this is a different one" in a stored run, and short
 * enough that 500 of them do not bloat localStorage the way the raw JSON
 * projection would.
 */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * Every launch condition that changes a flight, in one comparable string.
 * `windAvg` and `timeStepS` were already recorded individually; rod length,
 * rod angle, altitude, temperature, pressure and latitude were not, and all of
 * them move the numbers.
 */
export function conditionsKeyOf(launch: LaunchConditions): string {
  const l = launch as unknown as Record<string, unknown>;
  const keys = Object.keys(l).sort();
  return keys.map((k) => `${k}=${String(l[k] ?? '')}`).join('|');
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

/**
 * VERTICAL descent rate (m/s, positive downward) at time `t`, from the altitude
 * series — NOT from the velocity series.
 *
 * WHY THIS EXISTS, and it is a correction. The kernel's velocity series is
 * `TYPE_VELOCITY_TOTAL`: the speed over the GROUND, which under canopy includes
 * the full horizontal wind drift, because drag makes the rocket's horizontal
 * velocity relax to the wind within a fraction of a second
 * (`AbstractEulerStepper.java:196,214`). Until v0.100 the report drew its
 * "descent rate" from that and judged it against `SAFETY.maxLandingRate`, whose
 * own name and comment say DESCENT — so wind was being charged against a
 * landing-safety limit.
 *
 * MEASURED (2026-09-03c, the owner's `WM_4_Extreme.ork`): the same design and
 * canopy, only the wind changed — 0 m/s → 3.385 m/s reported, 3 → 4.523,
 * 5 → 6.038 — exact quadrature with √(v_z² + w²) to three decimals. His file
 * carries `windaverage 5`, so a rocket descending at a healthy 13 ft/s was
 * reported at 20.9 and failed the 20 ft/s check. **His own screenshot proves the
 * true rate without any modelling:** the main opened at 376 ft and the flight
 * ended 28.1 s later, which is 13.4 ft/s.
 *
 * The severity is the point: with a 5 m/s wind, the 20 ft/s test could only be
 * passed by a rocket descending under 11.4 ft/s — so **every correctly sized
 * main failed it in wind**, and worst on the slowest, safest canopies, which is
 * exactly where a flyer trusts the verdict.
 *
 * Vz is computed inside the kernel (`SimulationStatus.java:640`) and thrown away
 * before export, so this differences the altitude series instead. Under canopy
 * the recovery stepper runs a fixed 0.5 s step and the descent is settled, so a
 * central difference over a short window is exact to the sampling; a longer
 * window would smear the opening transient into it.
 */
const descentRateAt = (
  time: number[], altitude: number[], t: number, windowS = 1.5,
): number | null => {
  if (!time.length) return null;
  const alt = (x: number) => at(time, altitude, x);
  // Prefer a window that sits BEFORE t (the settled descent), clamped into range.
  const t1 = Math.min(t, time[time.length - 1]!);
  const t0 = Math.max(time[0]!, t1 - windowS);
  if (!(t1 > t0)) return null;
  const a1 = alt(t1);
  const a0 = alt(t0);
  if (a0 === null || a1 === null || !Number.isFinite(a0) || !Number.isFinite(a1)) return null;
  const rate = (a0 - a1) / (t1 - t0); // positive while falling
  return Number.isFinite(rate) ? Math.abs(rate) : null;
};

/** Per-device deployments for ONE flight branch (drogue/main ordering). */
function extractDeployments(
  events: FlightEvent[],
  series: FlightSeries,
  groundHit: number | null,
  flown?: Record<string, FlownRecoveryDevice>,
): DeploymentReport[] {
  const deployEvents = events.filter((e) => e.type === 'RECOVERY_DEVICE_DEPLOYMENT');
  return deployEvents.map((ev, i) => {
    const device = ev.source ?? `Recovery device ${i + 1}`;
    const isLanding = i === deployEvents.length - 1;
    const vDeploy = at(series.time, series.velocity, ev.time);
    // The instant this device's descent is settled: just before the ground, or
    // just before the next device opens.
    const tSettled = isLanding
      ? series.time[series.time.length - 1] ?? ev.time
      : Math.max(ev.time, deployEvents[i + 1]!.time - 0.2);
    // VERTICAL — the rate the safety limits are written about. See descentRateAt.
    const descentRate = descentRateAt(series.time, series.altitude, tSettled)
      // A branch too short to difference (an immediate ground hit) keeps the old
      // reading rather than reporting nothing.
      ?? (isLanding && groundHit !== null && Number.isFinite(groundHit) ? Math.abs(groundHit) : null);
    // Speed over the ground at the same instant: descent AND drift. Reported
    // beside the descent rate rather than in place of it, because it is what a
    // rocket actually hits the ground at.
    const groundSpeedRaw = isLanding
      ? (groundHit !== null && Number.isFinite(groundHit) ? groundHit : null)
      : at(series.time, series.velocity, tSettled);
    const groundSpeed = groundSpeedRaw === null ? null : Math.abs(groundSpeedRaw);
    const f = flown?.[device];
    return {
      device,
      time: ev.time,
      altitude: at(series.time, series.altitude, ev.time),
      velocityAtDeployment: vDeploy,
      descentRate,
      groundSpeed,
      isLanding,
      cd: f?.cd ?? null,
      cdNominal: f?.cdNominal ?? null,
      diameter: f?.diameter ?? null,
      spillHoleDiameter: f?.spillHoleDiameter ?? null,
      openingOk: vDeploy === null ? null : Math.abs(vDeploy) <= SAFETY.maxDeploymentVelocity,
      // abs like openingOk — descent velocities are magnitudes today, but a
      // signed series would make an unsigned ≤ check pass vacuously.
      descentOk: descentRate === null ? null
        : Math.abs(descentRate) <= (isLanding ? SAFETY.maxLandingRate : SAFETY.maxDrogueDescentRate),
    };
  });
}

/** Last finite sample of a symbol-keyed series (wire NaN arrives as null). */
/**
 * A SIM_ABORT event rendered as an engine warning, so an aborted flight travels
 * through the one channel the report, the notices and the CSV already read.
 *
 * The kernel stops the flight and returns a normal (but truncated) result — no
 * exception, no warning of its own — so without this the user sees a chart that
 * simply ends, or a rocket that "flew" to 0 m, with nothing saying why. Desktop
 * OpenRocket prints the same cause sentence on its plot.
 *
 * The `cause` field arrives only from engines built after it was exported; an
 * older artifact falls back to the generic sentence with no reason attached.
 */
function abortWarnings(result: FlightResult): EngineWarning[] {
  // EVERY branch, not just branch 0. A staged rocket's booster flies its own
  // branch, and the kernel can abort that one alone — leaving the sustainer's
  // numbers perfectly good while the booster's truncated apogee is rendered
  // beside them as if it were a real flight. `result.events` is branch 0.
  const branches: { name?: string; events: FlightEvent[] }[] = [
    { events: result.events ?? [] },
    ...boosterBranches(result).map((b) => ({ name: b.name, events: b.events ?? [] })),
  ];
  const out: EngineWarning[] = [];
  for (const b of branches) {
    const abort = b.events.find((e) => e.type === 'SIM_ABORT');
    if (!abort) continue;
    const when = Number.isFinite(abort.time) ? ` at T+${abort.time.toFixed(2)} s` : '';
    const why = ABORT_CAUSES[abort.cause ?? ''] ?? null;
    const whose = b.name ? `The ${b.name} stage's flight` : 'The flight';
    out.push({
      key: 'SIM_ABORT',
      priority: 'HIGH',
      message: `${whose} stopped${when} before it finished, so`
        + `${b.name ? ' that branch’s' : ' the'} numbers below are incomplete.${why ? ` ${why}` : ''}`,
    });
  }
  return out;
}

/**
 * The kernel's ten abort causes, in this app's voice.
 *
 * Worded HERE, not echoed from the kernel: the kernel's own Cause.toString()
 * goes through its Translator, and this build ships no resource bundle, so it
 * returns the bracketed l10n KEY — "[SimulationAbort.tumbleUnderThrust]". That
 * is why the bridge exports the enum NAME only. The wording below follows
 * desktop OpenRocket's messages.properties (837-846) so a user who has seen the
 * desktop recognises it, with the cause followed by what to do about it where
 * there is an obvious answer.
 */
const ABORT_CAUSES: Record<string, string> = {
  NO_ACTIVE_STAGES: 'No stage was active.',
  NO_MOTORS_DEFINED: 'No motors were defined in this flight configuration.',
  NO_CONFIGURED_IGNITION: 'No motor was set to ignite at liftoff — check the ignition settings on'
    + ' each stage.',
  NO_MOTORS_FIRED: 'No motor ignited.',
  NO_LIFTOFF: 'The motor burned out without lifting the rocket — it needs more thrust, or the'
    + ' design needs to be lighter.',
  ACTIVE_LENGTH_ZERO: 'The active airframe has zero length.',
  NO_CP: 'The centre of pressure could not be calculated for this airframe.',
  ACTIVE_MASS_ZERO: 'The active stages weigh nothing.',
  TUMBLE_UNDER_THRUST: 'The rocket began to tumble while the motor was still burning — it is'
    + ' unstable as modelled. Check the stability margin, and the mass and CG, before trusting'
    + ' any of these numbers.',
  DEPLOY_UNDER_THRUST: 'The recovery system deployed while the motor was still burning.',
};

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
  flightConfigId?: string;
  designKey?: string;
  motorSetKey?: string;
  /** What the kernel was handed for each recovery device — see FlownRecoveryDevice. */
  flownRecovery?: Record<string, FlownRecoveryDevice>;
}): SimRun {
  const { result, info, motor, meta, launch, rocketName, execMs, stageMotorInfo, boosterMotors, aeroModel, rogersKbf, motorConfig, flightConfig, flightConfigId, designKey, motorSetKey, flownRecovery } = input;
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
    Number.isFinite(summary.groundHitVelocity) ? summary.groundHitVelocity : null,
    flownRecovery);

  // Booster branches (staged flights): each separated stage flies its OWN
  // descent — apogee, recovery (or tumble), and landing verdict per stage.
  const branches: BranchReport[] = [];
  for (const b of boosterBranches(result)) {
    const alt = b.series.altitude.filter((v): v is number => v !== null && Number.isFinite(v));
    const groundEv = b.events.find((e) => e.type === 'GROUND_HIT');
    const vHit = groundEv ? at(b.series.time, b.series.velocity, groundEv.time) : null;
    const landing = vHit !== null && Number.isFinite(vHit) ? Math.abs(vHit) : null;
    const bDeployments = extractDeployments(b.events, b.series, landing, flownRecovery);
    const bLanding = bDeployments.length > 0
      ? (bDeployments[bDeployments.length - 1]!.descentRate ?? landing)
      : (descentRateAt(b.series.time, b.series.altitude,
        groundEv?.time ?? b.series.time[b.series.time.length - 1] ?? 0) ?? landing);
    branches.push({
      name: b.name,
      motorLabel: stageMotorInfo?.[b.name]?.label,
      apogee: alt.length ? Math.max(...alt) : null,
      tumbles: b.events.some((e) => e.type === 'TUMBLE'),
      deployments: bDeployments,
      // Vertical, like the sustainer's — a booster drifts in the same wind, and
      // judging its arrival on ground speed charged the wind against it too.
      landingRate: bLanding,
      safeLandingRate: bLanding === null ? null : bLanding <= SAFETY.maxLandingRate,
    });
  }
  const landingRaw = Number.isFinite(summary.groundHitVelocity)
    ? summary.groundHitVelocity : (tGround !== null ? at(series.time, series.velocity, tGround) : null);
  /** Speed over the ground at impact: descent AND wind drift. */
  const landingGroundSpeed = landingRaw === null ? null : Math.abs(landingRaw);
  /**
   * The DESCENT rate — vertical — which is what `SAFETY.maxLandingRate` is
   * about. Drawn from the altitude series, because the kernel's velocity series
   * is speed over the ground and carries the full wind drift; see descentRateAt.
   * The landing device's own settled figure is preferred (same instant, same
   * method); the trailing-window fallback covers a flight with no recovery
   * device at all, where a tumbling arrival has no settled rate to speak of and
   * the ground speed IS the honest number.
   */
  const landingRate = deployments.length > 0
    ? (deployments[deployments.length - 1]!.descentRate ?? landingGroundSpeed)
    : (descentRateAt(series.time, series.altitude,
      tGround ?? series.time[series.time.length - 1] ?? 0) ?? landingGroundSpeed);
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
      // The app's strongest claim about a design has to carry its own
      // reconciliation. It names the coefficient it rests on (the owner's
      // reports twice turned on "which Cd did that run use?"), and — when there
      // is wind — the ground speed too, so the two figures a reader can see
      // elsewhere cannot look like a contradiction. Before v0.100 this sentence
      // quoted the GROUND speed and called it a descent rate.
      const cdSaid = d.cd !== null ? ` on a drag coefficient of ${d.cd.toFixed(2)}` : '';
      const drift = d.groundSpeed !== null && d.descentRate !== null
        && d.groundSpeed - d.descentRate > 0.1
        ? ` It touches down at ${d.groundSpeed.toFixed(1)} m/s (${fps(d.groundSpeed)}) over the ground, the rest of that being wind drift.`
        : '';
      comments.push(`Landing under ${d.device} at ${d.descentRate!.toFixed(1)} m/s (${fps(d.descentRate!)}) of descent${cdSaid} — above the ${fps(SAFETY.maxLandingRate)} landing target.${drift}`);
    }
  }
  if (deployments.length === 0 && safeDeployment === false) {
    comments.push(`Deployment at ${Math.abs(velocityAtDeployment!).toFixed(1)} m/s (${fps(Math.abs(velocityAtDeployment!))}) — expect hard opening.`);
  }
  if (deployments.length === 0 && safeLandingRate === false) {
    comments.push(`Landing at ${landingRate!.toFixed(1)} m/s (${fps(landingRate!)}) of descent — above the ${fps(SAFETY.maxLandingRate)} landing target.`);
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
    //
    // A SIM_ABORT is folded in as a HIGH warning. The kernel does NOT raise one
    // of its own for an abort — it stops the flight and returns normally — so
    // before this a design that never left the pad came back with apogee 0, an
    // empty warning list and nothing anywhere saying why. On the beta test
    // corpus 17 of the 72 flyable designs end this way, almost all .CDX1.
    ...(result.warnings !== undefined
      ? { simWarnings: [...abortWarnings(result), ...result.warnings] }
      : {}),
    landingDistanceM: drift.distanceM,
    landingBearingDeg: drift.bearingDeg,
    maxRollRateRadS,
    windAvg: launch.windAverage,
    ...(launch.timeStepS != null ? { timeStepS: launch.timeStepS } : {}),
    execMs,
    aeroModel,
    ...(rogersKbf !== undefined ? { rogersKbf } : {}),
    ...(motorConfig !== undefined ? { motorConfig } : {}),
    ...(flightConfig !== undefined ? { flightConfig } : {}),
    // Provenance for the .ork <flightdata> guard. Absent inputs stay absent
    // rather than storing empty strings — "unknown" and "known to be empty"
    // must not read the same on the way back out.
    ...(flightConfigId !== undefined ? { flightConfigId } : {}),
    ...(designKey !== undefined ? { designKey } : {}),
    ...(motorSetKey !== undefined ? { motorSetKey } : {}),
    conditionsKey: conditionsKeyOf(launch),
    comments: comments.join(' | '),
  };
}
