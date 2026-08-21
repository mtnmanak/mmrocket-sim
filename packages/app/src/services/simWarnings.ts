import type { EngineWarning } from '@online-openrocket/engine';

/**
 * Plain-language presentation of the kernel's simulation warnings.
 *
 * The engine emits each flight warning as {key, message, priority}. The key
 * is the stable machine identity (OrkEngine.warningKey): the typed Warning
 * subclass name ("LargeAOA", "HighSpeedDeployment", "EventAfterLanding",
 * "MissingMotor") or the l10n key of the singleton warnings — the part after
 * "Warning." in the bracketed message the shim's DebugTranslator produces
 * ('[Warning.RECOVERY_HIGH_SPEED] (71.1 m/s):  "BoosterChute"'). "Other" is
 * the kernel's own fallback. This module turns those into the app's voice;
 * the raw triple is what SimRun persists, so wording fixes here apply
 * retroactively to stored runs.
 */

/**
 * Every key the kernel can emit during a flight, with a flyer-facing label.
 * Sources: engine-java OrkEngine.warningKey (typed subclasses) + every
 * simulation-time emitter in the carved sources — BasicEventSimulationEngine
 * and RK4SimulationStepper addWarning calls, plus the Barrowman calculators,
 * whose geometry warnings the stepper folds into the flight's WarningSet.
 * Keys are l10n keys, NOT constant names (DIAMETER_DISCONTINUITY emits
 * "Warning.DISCONTINUITY" — the key is "DISCONTINUITY").
 */
export const WARNING_LABEL: Record<string, string> = {
  // Flight-event warnings (BasicEventSimulationEngine / RK4SimulationStepper)
  NO_RECOVERY_DEVICE: 'No recovery device — the rocket comes down ballistic',
  RECOVERY_LAUNCH_ROD: 'Recovery device deployed while still on the launch guide',
  RECOVERY_HIGH_SPEED: 'Recovery device opened at high speed — risk of a zippered tube or torn chute',
  HighSpeedDeployment: 'Recovery device opened at high speed — risk of a zippered tube or torn chute',
  LargeAOA: 'Large angle of attack — the rocket flew notably sideways to its path',
  EventAfterLanding: 'Flight event after landing — the ejection charge likely fired on the ground',
  SEPARATION_ORDER: 'Stages separated out of order (an upper stage left before a lower one)',
  EARLY_SEPARATION: 'Stage separated before clearing the launch guide',
  TUMBLE_UNDER_THRUST: 'The rocket tumbled while the motor was still burning',
  MissingMotor: 'A motor mount has no motor loaded',
  EMPTY_BRANCH: 'A stage produced no flight data — check its separation and ignition settings',
  // Aerodynamic-model warnings (Barrowman calculators, raised in flight)
  SUPERSONIC: 'Flight is supersonic — aerodynamic predictions are approximate',
  DISCONTINUITY: 'Airframe diameter steps abruptly — drag predictions suffer',
  OPEN_AIRFRAME_FORWARD: 'Airframe is open at the front — no nose cone ahead of a body tube',
  AIRFRAME_GAP: 'Gap in the airframe between components',
  AIRFRAME_OVERLAP: 'Airframe components overlap',
  PODSET_FORWARD: 'A pod sits ahead of the nose cone',
  PODSET_OVERLAP: 'Pods overlap the airframe',
  THICK_FIN: 'Very thick fins — fin drag predictions suffer',
  JAGGED_EDGED_FIN: 'Jagged fin outline — fin aerodynamics are approximate',
  ZERO_AREA_FIN: 'A fin has zero area and is ignored',
  PARALLEL_FINS: 'Parallel fins on the same body — interference is not modeled',
  ZERO_VOLUME_BODY: 'A body component has zero volume',
  TUBE_ISOLATED: 'A tube fin is isolated from the body tube',
  TUBE_SEPARATION: 'Tube fins are separated from each other',
  TUBE_OVERLAP: 'Tube fins overlap each other',
  // Rare / bookkeeping (possible in the set; kept for completeness)
  LISTENERS_AFFECTED: 'Simulation listeners may have affected the results',
  FILE_INVALID_PARAMETER: 'A design parameter was invalid and has been ignored',
  OBJ_ZERO_THICKNESS: 'A component has zero wall thickness',
};

/** A warning at this priority is a flight-safety failure, not a note. */
export function isHighPriority(w: EngineWarning): boolean {
  return w.priority === 'HIGH';
}

/**
 * Strip the DebugTranslator bracket prefix ("[Warning.X] rest" → "rest") and
 * tidy the source-list separator (":  \"Chute\"" → ": \"Chute\"").
 */
function stripBrackets(message: string): string {
  return message.replace(/^\[[^\]]*\]\s*/, '').replace(/:\s{2,}/g, ': ').trim();
}

export interface FormattedWarning {
  /** Plain-language label (or the bracket-stripped raw message when unknown). */
  label: string;
  /**
   * Informative remainder of the kernel message — the value/source suffix
   * after the bracketed key ('(71.1 m/s): "BoosterChute"'), null when the
   * message carried nothing beyond the key itself.
   */
  detail: string | null;
  high: boolean;
}

/** One warning in the app's voice; unknown keys fall back to the raw text. */
export function formatWarning(w: EngineWarning): FormattedWarning {
  const label = WARNING_LABEL[w.key];
  const detail = stripBrackets(w.message ?? '');
  if (label === undefined) {
    // Unknown key (new kernel warning, or "Other"): the stripped message IS
    // the label; show the raw text rather than hiding the warning.
    return { label: detail || w.key, detail: null, high: isHighPriority(w) };
  }
  return { label, detail: detail || null, high: isHighPriority(w) };
}

/** Compact machine-readable cell for the run-history CSV/XLSX ("key; key"). */
export function warningKeysCell(warnings: EngineWarning[] | undefined): string {
  return (warnings ?? []).map((w) => w.key).join('; ');
}
