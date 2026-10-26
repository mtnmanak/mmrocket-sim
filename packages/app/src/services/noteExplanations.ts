import { WARNING_LABEL } from './simWarnings.js';

export interface NoteExplanation { meaning: string; remedy: string }

// N046: advice only. The producer continues to own the note's text and tier.
const flightRemedies: Record<string, string> = {
  NO_RECOVERY_DEVICE: 'Check how each stage will recover. Add and configure a recovery device where needed; this warning only checks whether a device exists, not whether it opens.',
  RECOVERY_LAUNCH_ROD: 'Check deployment events and delays. A device opening on the guide can interfere with departure.',
  RECOVERY_HIGH_SPEED: 'Review the speed at opening, deployment timing and recovery hardware. The kernel flag uses 20 m/s; the report has separate opening-speed guidance. A fast opening can tear the chute or zipper the tube.',
  HighSpeedDeployment: 'Review the speed at opening, deployment timing and recovery hardware. The kernel flag uses 20 m/s; the report has separate opening-speed guidance. A fast opening can tear the chute or zipper the tube.',
  LargeAOA: 'Review the stability plot, wind and guide-exit speed. Aerodynamic predictions become less reliable when the rocket flies sideways.',
  EventAfterLanding: 'Check the ejection delay and event timeline. An ejection charge firing on the ground can damage the rocket or injure someone approaching it.',
  SEPARATION_ORDER: 'Check each stage’s separation event and delay against the event timeline.',
  EARLY_SEPARATION: 'Check separation events and delays. A separating stage can interfere with the launch guide.',
  TUMBLE_UNDER_THRUST: 'Review stability, guide-exit speed and the event timeline before choosing a flight setup. The powered rocket is not following the intended path.',
  MissingMotor: 'Check the motors in the selected flight configuration, including booster mounts.',
  EMPTY_BRANCH: 'Check the stage’s ignition and separation settings. Missing data is not evidence of a successful flight.',
  SIM_ABORT: 'Read the event timeline for the stopping cause. Treat the reported values as incomplete and correct the cause before relying on them.',
  INCOMPLETE_FLIGHT: 'Review the event timeline and recovery settings. Ground contact was not recorded for the flight or stage the note names, so its landing rate is unavailable; when that is the main flight, landing drift is unavailable too. Do not rely on it as a completed descent; resolve the incomplete descent before using its landing predictions.',
  SUPERSONIC: 'Check the aerodynamic model used by this run and its documented range. Compare predictions with flight measurements; a simulated result does not establish structural survival.',
  DISCONTINUITY: 'Check adjacent outside diameters and positions. If the step is intentional, allow for uncertainty in predicted drag.',
  OPEN_AIRFRAME_FORWARD: 'Check the forward body and nose cone. If the opening is intentional, allow for uncertainty in predicted aerodynamics.',
  AIRFRAME_GAP: 'Check component positions and lengths for an unintended gap.',
  AIRFRAME_OVERLAP: 'Check component positions and lengths for an unintended overlap.',
  PODSET_FORWARD: 'Check the pod’s position relative to the nose. Treat predictions for unusual geometry with care.',
  PODSET_OVERLAP: 'Check pod positions and radial offsets for unintended overlap.',
  THICK_FIN: 'Check fin thickness and cross-section. If the dimensions are intentional, allow for uncertainty in fin drag.',
  JAGGED_EDGED_FIN: 'Inspect the fin outline and point order. Keep the intended outline, but allow for uncertainty in its aerodynamic prediction.',
  ZERO_AREA_FIN: 'Check the fin outline and dimensions. The ignored fin supplies no aerodynamic contribution, so the simulated stability can differ from the real rocket.',
  PARALLEL_FINS: 'Check fin rotations and positions. If the arrangement is intentional, allow for the aerodynamic interference the model leaves out.',
  ZERO_VOLUME_BODY: 'Check body dimensions and shape. A zero-volume part can omit mass or aerodynamic contributions.',
  TUBE_ISOLATED: 'Check tube-fin radial position and body diameter against the intended geometry.',
  TUBE_SEPARATION: 'Check tube-fin count, diameter and radial positions. Allow for uncertainty if the tubes are intentionally separated.',
  TUBE_OVERLAP: 'Check tube-fin diameter, count and radial positions for unintended overlap.',
  LISTENERS_AFFECTED: 'Check the source of the saved simulation and any custom listeners used to run it.',
  FILE_INVALID_PARAMETER: 'Read the original note and check the named input against the original design; an ignored input can change the simulated rocket.',
  OBJ_ZERO_THICKNESS: 'Check the named component’s wall thickness against the real part.',
  RAIL_CHECK_INCOMPLETE: 'Check every rail button and fin for clearance against the rail before flying. The app stopped checking this design partway, so a part that fouls the rail may not be named.',
};

const importGroups: { codes: string; meaning: string; remedy: string }[] = [
  { codes: 'I21.zero-bulk-density', meaning: 'The engine replaces zero bulk density with 680 kg per cubic metre, adding mass. Saving replaces the zero density.', remedy: 'Check the named part and its mass before flying. Keep the original file if you need the zero-density material.' },
  { codes: 'I02.not-run', meaning: 'The app preserves direct simulation extensions in .ork files but does not run them. Flight results can differ from desktop OpenRocket when extensions affect the flight.', remedy: 'Keep the original file. Use desktop OpenRocket to run the simulation with its extensions; enabled scripts run there only if trusted on that computer. Check which extensions affect the flight before relying on the app\u2019s results.' },
  { codes: 'I02.not-standalone', meaning: 'A simulation extension was not preserved because its XML depends on namespace declarations elsewhere in the original document.', remedy: 'Keep the original .ork file: saving from the app loses this extension. If you need to edit the design here and keep the extension, make its XML include the namespace declarations it needs before importing again.' },
  { codes: 'I02.nested-dropped', meaning: 'Simulation extensions inside other elements are not preserved when you save; their enclosing elements are omitted.', remedy: 'Keep the original .ork file if you need those payloads. Only direct children of a simulation are kept as extensions. Do not move nested XML into direct simulation children unless it is intended to run as an extension in desktop OpenRocket.' },
  { codes: 'I03.fin-attached I03.ignored-components I03.ignored-elements I03.left-out I03.too-deep', meaning: 'The file contains parts or settings the app could not keep in the design.', remedy: 'Compare the named missing parts and settings with the original file. Add supported parts where needed and check mass, balance and recovery before relying on a flight.' },
  { codes: 'I04.enum I04.invalid-number I04.limits I04.surface-finish I04.unreadable-numbers I04.recovery-cd I04.nozzle-dimension', meaning: 'An input was unreadable, outside the supported range or replaced with a supported value.', remedy: 'Check the named input and its units against the original file. Enter the intended supported value; the original note says what was used.' },
  { codes: 'I05.fin-outline I05.fin-points I05.origin I05.tree-repair', meaning: 'Fin points or the component arrangement needed repair when opened.', remedy: 'Inspect the fin outline, point order and component positions against the original design. A changed fin outline can change the predicted stability.' },
  { codes: 'I06.cluster I06.instances I06.stage-activeness', meaning: 'The file’s repeated parts, motor cluster or stage selection could not be used exactly as written.', remedy: 'Check the named instances, motor mounts and stages against the real rocket. Read the note for what is kept and what the flight uses.' },
  { codes: 'I07.auto-diameter-default I07.auto-diameter-no-cavity', meaning: 'An automatic diameter had no usable reference and needed a fallback.', remedy: 'Measure the part and enter its diameter. Check the fit and mass rather than relying on the fallback.' },
  { codes: 'I08.configs-dropped I08.duplicate-config', meaning: 'Some saved flight configurations were omitted or merged.', remedy: 'Review the remaining configurations and their motors, recovery settings and launch conditions against the original file.' },
  { codes: 'I10.config-override I10.layer-migration', meaning: 'Configuration-specific component settings were translated or could not all be applied.', remedy: 'Read the named settings and compare the selected configuration with the original design. Check mass, balance and recovery in that configuration.' },
  { codes: 'I11.delay-plugged I11.ignition-event I11.pro-conditions I11.unknown-trigger', meaning: 'An ignition, ejection or deployment condition was unsupported or needed a fallback.', remedy: 'Check the event and delay on the named motor or recovery device. A plugged motor supplies no ejection charge; set another deployment event where needed.' },
  { codes: 'I12.booster-unpowered I12.loadout-refused I12.motor-not-loaded I12.motor-unconfirmed I12.reader-pick-skipped I12.simulation-opened I12.unattached-motors', meaning: 'The file’s motor selection or simulation choice needs checking.', remedy: 'Match the selected configuration and every stage’s loaded motor to the motor you intend to fly. Resolve unloaded or ambiguous motors before relying on a result.' },
  { codes: 'I15.serial-evidence-limited', meaning: 'Some RockSim motor mount serial fields could not be used. Motor size and loaded-mass checks may be missing.', remedy: 'Compare each selected motor and its dimensions with the intended motor mount. Check the loaded mass against the real rocket before relying on flight results.' },
  { codes: 'I15.embedded-ex-refused I15.ex-session-only I15.stored-ex-refused', meaning: 'A custom motor could not be restored or saved as expected.', remedy: 'Read the note’s storage limitation. Keep the original motor file and reload it where needed; check that the intended curve is loaded.' },
  { codes: 'I16.pad-mass-dropped I16.pad-mass-inactive', meaning: 'A weighed pad mass was not used for this motor or configuration.', remedy: 'Check the loaded motor and enter the measured ready-to-fly mass for that loadout. Do not reuse a mass measured with a different motor.' },
  { codes: 'I17.override-not-applied I17.reconcile I17.stage-overrides I17.stand-in-mass', meaning: 'Stage mass or balance settings were reconciled with imported motor data or could not be applied.', remedy: 'Read which values were used. Check stage mass, balance and loaded motor against measurements, especially when a stand-in motor mass was used.' },
  { codes: 'I18.airfoil-mass-pinned I18.cg-flag-ignored I18.measured-not-applied I18.stage-masses-not-applied', meaning: 'Mass or balance data needed special handling or was not applied.', remedy: 'Compare the named mass and balance settings with the original file and the built rocket. The note says whether an override was retained or omitted.' },
  { codes: 'I19.catalogue-filled', meaning: 'Missing part data was filled from the catalogue.', remedy: 'Check the named part and filled values against the actual part; catalogue data is not a measurement of your rocket.' },
  { codes: 'I21.blunt-radius I21.booster-location I21.fin-can-flat I21.fin-rotated I21.nose-shape I21.radial-offset', meaning: 'A shape or position was translated, changed or retained only as file data.', remedy: 'Compare the named geometry with the original file and real parts. Read the note for what the flight actually models.' },
  { codes: 'I22.default-walls', meaning: 'The file lacked wall thicknesses and the app supplied defaults.', remedy: 'Measure and enter the actual wall thicknesses, then check empty mass and balance.' },
  { codes: 'I22.multiple-designs', meaning: 'The file contains multiple designs and the app opened one of them.', remedy: 'Check that the expected design opened, including its parts, motors and flight settings, before flying.' },
  { codes: 'I23.aero-model', meaning: 'The file requests an aerodynamic setting the app does not reproduce exactly.', remedy: 'Read the note and check the aerodynamic model the app uses. Compare predictions with measured flights.' },
  { codes: 'I24.geodetic-unknown I24.launch-retained I24.site-retained I24.timestep I24.timestep-default', meaning: 'Launch or simulation settings were kept, translated or reset as described in the note.', remedy: 'Review Launch conditions and the selected configuration before flying. Check site altitude, wind and Time step against your intended setup.' },
  { codes: 'I25.clamped I25.pressure I25.temperature I25.wind-levels I25.wind-profile', meaning: 'Weather or atmosphere inputs were refused, limited or partly omitted.', remedy: 'Check Launch conditions and Winds aloft against the conditions at the pad. Use station pressure for the launch altitude; the note says which inputs were used.' },
  { codes: 'I27.stored-runs-rule I28.stored-runs I28.stored-warnings', meaning: 'Saved flight results or warning records could not all be retained as written.', remedy: 'Keep the original file. Read which saved results are available, and re-fly the design if you need current results; missing saved data is not a passing flight.' },
];

export const NOTE_EXPLANATIONS: ReadonlyMap<string, NoteExplanation> = new Map([
  ...Object.entries(flightRemedies).map(([code, remedy]) => [code, { meaning: WARNING_LABEL[code]!, remedy }] as const),
  ...importGroups.flatMap(({ codes, meaning, remedy }) => codes.split(' ').map(code => [code, { meaning, remedy }] as const)),
]);

export function explanationFor(code: string): NoteExplanation {
  return NOTE_EXPLANATIONS.get(code) ?? {
    meaning: 'No explanation is available for this code in this version of the app.',
    remedy: 'Read the original note and keep its code and details with your bug report. Do not assume an unknown code means the result is safe.',
  };
}

export function staticWarningCode(text: string): string | undefined {
  return /^\[Warning\.([^\]]+)\]/.exec(text)?.[1];
}

/** Plain legacy strings have no producer code; never guess one from their words. */
export function importNoteCode(kind: string): string | undefined {
  return /^I\d{2}\.[a-z-]+$/.test(kind) ? kind : undefined;
}
