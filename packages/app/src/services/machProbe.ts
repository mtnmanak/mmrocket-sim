import type { IgnitionEvent, MotorSpec } from '@online-openrocket/engine';

/** One mount's motor as the probe needs to see it. */
export interface ProbeMotor {
  spec: MotorSpec;
  ignition?: { event: IgnitionEvent; delay: number };
  /**
   * True when this mount sits on the LAUNCH stage — the bottom one, the only
   * stage whose motors fire off the launch clock. Absent is treated as false
   * unless the design has a single motor, where it cannot be anything else.
   */
  onLaunchStage?: boolean;
}

/**
 * How long an auto-aero Mach probe has to fly to see a flight's peak Mach.
 *
 * Auto mode has to decide, before it commits, whether this flight goes
 * supersonic — past Mach 0.9, where classic Barrowman aerodynamics starts
 * degrading. It used to decide by flying the ENTIRE flight on the classic
 * model, and then, on a supersonic design, throwing all of it away and flying
 * the entire thing again: two full flights to read one number. On a design
 * carrying a fine time step that was the difference between a wait and a
 * "page not responding" dialog.
 *
 * A truncated run answers the same question, because peak Mach happens at, or
 * within a moment of, the last motor's burnout — through the coast, drag and
 * gravity only slow the rocket down. So the probe must fly until every motor
 * has finished burning, plus a small margin, and no further.
 *
 * GETTING THIS TOO SHORT IS SILENTLY WRONG: the probe under-reads peak Mach,
 * Auto decides "subsonic", and a Mach 2 flight is flown on classic aero with
 * nothing to tell the user. The old code's discarded full flight used to catch
 * that by brute force. So every bound below is an OVER-estimate on purpose.
 */
export function machProbeSeconds(motors: readonly ProbeMotor[]): number {
  // Upper bound on how far a chain of stage-triggered ignitions can push the
  // last motor's light-up: every motor's burn, plus every finite ejection
  // delay, because an 'ejectioncharge' ignition waits for the charge and the
  // charge waits out the delay after burnout. A plugged motor (delay Infinity)
  // contributes nothing — it never fires a charge, so nothing can chain off it.
  const chainBound = motors.reduce((sum, m) => sum + burnSeconds(m.spec)
    + (Number.isFinite(m.spec.ejectionDelay) ? m.spec.ejectionDelay : 0), 0);
  const single = motors.length === 1;

  let latest = 0;
  for (const m of motors) {
    const event = m.ignition?.event ?? 'automatic';
    const delay = m.ignition?.delay ?? 0;
    // The kernel's AUTOMATIC is NOT "at launch": IgnitionEvent.AUTOMATIC
    // resolves to LAUNCH only when the mount's stage is the launch stage, and
    // to EJECTION_CHARGE of the stage below otherwise. Treating it as
    // clock-relative collapsed the cutoff to the 10 s floor on staged
    // designs — whose sustainer is very often left on OpenRocket's automatic
    // default — so the probe ended before the sustainer ever lit.
    const firesOffClock = event === 'launch'
      || (event === 'automatic' && (single || m.onLaunchStage === true));
    const ignitesAt = firesOffClock ? delay : delay + chainBound;
    latest = Math.max(latest, ignitesAt + burnSeconds(m.spec));
  }
  // +3 s covers the moment of continued acceleration after thrust tails off.
  // The 10 s floor is the shortest fixed cutoff that held across the corpus:
  // 5 s misreads a design whose sustainer lights late, reading Mach 0.72 on a
  // flight that actually reaches 2.39.
  return Math.max(10, latest + 3);
}

/** Burn time of a thrust curve: its last sample's timestamp. */
function burnSeconds(spec: MotorSpec): number {
  return spec.times.length > 0 ? spec.times[spec.times.length - 1]! : 0;
}
