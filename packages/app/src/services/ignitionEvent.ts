import type { IgnitionEvent } from '@online-openrocket/engine';

/**
 * The five ignition events the kernel knows: `OrkEngine.java`
 * `ignitionEventOf`, which is desktop OpenRocket's own `IgnitionEvent` set.
 *
 * A leaf module on purpose: the .ork reader, the motor matcher and the flight
 * runner all need the one list, and none of them should have to load another's
 * data (the preset catalogue, the motor catalogue) to get it.
 */
export const IGNITION_EVENTS: readonly IgnitionEvent[] = [
  'automatic', 'launch', 'ejectioncharge', 'burnout', 'never',
];

/**
 * An ignition event as the kernel reads it, or null when it is none of the
 * five (audit 2026-09-22). Normalised the way `ignitionEventOf` does it —
 * lower case, underscores dropped — so a file's `EJECTION_CHARGE`, which the
 * kernel has always flown as the ejection charge, keeps flying as one; trimmed
 * as desktop's reader trims. The .ork reader maps a null to AUTOMATIC with a
 * note (desktop OpenRocket's reader ignores such a value with a warning,
 * "Unknown ignition event type … ignoring"), and the flight runner refuses to
 * put a motor carrying one on the handle at all.
 */
export function knownIgnitionEvent(raw: string | null | undefined): IgnitionEvent | null {
  if (raw == null) return null;
  const name = raw.trim().toLowerCase().replace(/_/g, '');
  return IGNITION_EVENTS.find((e) => e === name) ?? null;
}
