import type { IgnitionEvent, MotorSpec } from '@online-openrocket/engine';
import type { MotorMeta } from '../services/simReport.js';
import type { OrkDeployOverride, OrkMotorRef, OrkSeparationOverride } from '../services/orkFile.js';

/**
 * THE DESIGN'S DOMAIN TYPES — what a mount's motor and a stored flight
 * configuration ARE, apart from the component that happens to hold them.
 *
 * They lived in App.tsx until the 2026-09-22 audit (row 497), which made every
 * module that needed the shape of a motor import the whole application to get
 * it: 17 files besides main.tsx, all but one as an erased `import type`. The
 * one that was not, ConfigPanel, imported `savedConfigLabel` as a VALUE — a
 * real App ⇄ ConfigPanel import cycle one top-level use away from a TDZ error,
 * and the reason ConfigPanel's test spent 1.7 s collecting App's entire import
 * graph for 28 ms of tests.
 *
 * This module imports TYPES only, so nothing that reads it pulls a component,
 * the kernel or a service in at runtime.
 */

/** One mount's assigned motor (Release C: every mount can hold its own). */
export interface MountMotor {
  label: string;
  spec: MotorSpec;
  meta: MotorMeta;
  /**
   * When this motor ignites. Given a PROPELLANT-aware default at selection
   * time: a motor above the launch stage is electronics-timed (burnout + 1 s)
   * unless it burns black powder, which an ejection charge can light.
   * Everything else is AUTOMATIC. See App's assignMotor.
   */
  ignition: { event: IgnitionEvent; delay: number };
  /**
   * The rocket weighed ready to fly WITH this motor set in (kg, finite > 0).
   * PRESENT ONLY on the primary mount's record, and only after the user
   * committed a value (or a file / v0.116 session carried one). ABSENT
   * otherwise — never null, never undefined: dirtyState's fingerprint hashes
   * keys, so the key exists exactly when a value does. Cleared by DELETING
   * both keys. See services/hardwareMass.ts.
   */
  padMassKg?: number;
  /**
   * EITHER `motorSetIdentity(...)` of the assigned motor SET at the moment
   * the value was committed (at import: the configuration's own set),
   * OR the literal `LEGACY_PAD_MASS_KEY` ('legacy') for a value carried in
   * from v0.116/v0.117 that the app has not yet checked against the loaded
   * motor (App's legacy pad-mass reconcile decides it after the first build).
   * Present iff `padMassKg` is. A pad weight is a measurement of the whole
   * stack with every motor in, so the arithmetic refuses to apply it to a
   * different set (hardwareMass 'stale-set'). Delay, plugged and ignition are
   * excluded on purpose; cluster count is included.
   */
  padMassWeighedWith?: string;
}

/**
 * One of the imported file's flight configurations, kept as a ready-to-apply
 * preset (Stage B). `mountMotors` stays the live working set every consumer
 * reads; applying a preset copies its motors in and marks it active.
 */
export interface SavedConfig {
  /** The .ork configid — stable through save, so desktop round-trips keep it. */
  id: string;
  /** null = unnamed in the file (the desktop shows its motor list instead). */
  name: string | null;
  isDefault: boolean;
  /** Matched motors keyed by mount node id; unmatched refs dropped out. */
  motors: Record<string, MountMotor>;
  /** Designations that couldn't be matched at import — reported when applied. */
  unmatched?: string[];
  /**
   * The unmatched motor REFERENCES themselves, keyed by mount node id.
   *
   * `unmatched` above is display text; this is what the file said. Without it,
   * a motor the bundled database lacks (an EX load, a newly certified motor,
   * or any motor whose curve failed to download) was reduced to its
   * designation string at import, so pressing Save .ork wrote that
   * configuration with NO motor on the mount — and the original reference,
   * including the `<digest>` that is desktop's silent-match tier, was gone
   * from the user's only copy. `exportConfigs` re-emits these verbatim for
   * mounts that still have nothing matched.
   */
  unmatchedRefs?: Record<string, OrkMotorRef>;
  /**
   * This configuration's stage-separation settings, keyed by stage node id.
   * Separation is per-configuration in the .ork exactly as motors and recovery
   * are, so switching configurations has to carry it: without this, a design
   * that says "never separate" on the configuration you switch TO still flew
   * the configuration you OPENED with, and a 0 s motor delay tore the stages
   * apart at burnout.
   */
  separations?: Record<string, OrkSeparationOverride>;
  /**
   * This configuration's recovery-deployment settings as they were in the file,
   * keyed by recovery-device node id. Carried untouched so saving while another
   * configuration is open cannot rewrite this one's chute deployment.
   */
  deployments?: Record<string, OrkDeployOverride>;
  /**
   * This configuration's nozzle exit diameter per stage (metres, keyed by
   * stage node id; 0 = none). A RASAero `<Simulation>` carries the nozzle of
   * the motor it flies, so it switches with the configuration exactly as the
   * motor does — see `OrkFlightConfig.nozzles`. Absent for .ork files.
   */
  nozzles?: Record<string, number>;
}

/**
 * Display name for a working-set configuration. Same rule as the .ork picker's
 * `configLabel` (services/orkFile.ts) — a nameless configuration reads as its
 * motor set, never as a GUID — but SavedConfig's motors are already MATCHED
 * (`label`), with the ones we could not match moved aside into `unmatched`.
 * Both belong in the label, or a configuration whose only motor is unmatched
 * would read as "No motors".
 */
export function savedConfigLabel(c: SavedConfig): string {
  if (c.name) return c.name;
  const labels = [
    ...Object.values(c.motors).map((m) => m.label),
    ...(c.unmatched ?? []),
  ].filter(Boolean);
  return labels.length ? `[${labels.join(', ')}]` : 'No motors';
}
