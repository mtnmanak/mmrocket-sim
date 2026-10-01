import type { MountMotor } from '../model/design.js';
import { stripDelay } from './motorMatch.js';

/**
 * WHAT THE MOTOR CARD'S DELAY CONTROLS DO TO A MOUNT'S MOTOR — the typed
 * delay, the plugged box and the auto box. Each rewrites three things that
 * must move together: the delay, the Auto flag and the label, whose suffix
 * ("-14", "-P", " (auto delay)") the pad-mass line and the batch note read.
 * They were written inline in App's JSX, which no test drove (audit
 * 2026-09-30, item 20).
 */

/** Rewrites a motor label's delay suffix ("H220-14" / "H220-P" / "H220 (auto delay)"). */
export function labelWithDelay(label: string, delay: number | 'auto'): string {
  const base = stripDelay(label);
  if (delay === 'auto') return `${base} (auto delay)`;
  return `${base}-${Number.isFinite(delay) ? delay : 'P'}`;
}

/**
 * A delay typed into the card. It overrides Auto — real motors get drilled to
 * whatever whole second the flyer wants.
 */
export function withDelay(mm: MountMotor, delay: number): MountMotor {
  return {
    ...mm,
    spec: { ...mm.spec, ejectionDelay: delay },
    meta: { ...mm.meta, autoDelay: false },
    label: labelWithDelay(mm.label, delay),
  };
}

/**
 * The plugged box. Ticked: no ejection charge (removed for electronic
 * deployment, or a factory -P motor). Unticked: the longest delay the motor
 * is sold with — the last finite one, as delayOptions lists them ascending —
 * or 6 s when it lists none, not whatever it had before it was plugged.
 * Either way the delay is now a fixed one, so Auto goes off.
 */
export function withPlugged(mm: MountMotor, plugged: boolean): MountMotor {
  const finite = (mm.meta.availableDelays ?? []).filter((d) => Number.isFinite(d));
  return withDelay(mm, plugged ? Infinity : finite[finite.length - 1] ?? 6);
}

/**
 * The auto box. The delay is left as it is — on Auto a flight decides what it
 * flies, and off again the motor goes back to it — and the label says which.
 */
export function withAuto(mm: MountMotor, auto: boolean): MountMotor {
  return {
    ...mm,
    meta: { ...mm.meta, autoDelay: auto },
    label: labelWithDelay(mm.label, auto ? 'auto' : mm.spec.ejectionDelay),
  };
}
