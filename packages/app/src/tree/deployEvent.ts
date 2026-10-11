import { DEPLOY_EVENTS } from './schema.js';

/**
 * A recovery device's deploy event, read the way the kernel bridge reads it
 * (ComponentFactory.deployEventOf). The kernel LOWER-CASES the stored text
 * before matching it, so a hand-edited "Altitude" or "APOGEE" flies as altitude
 * or apogee — while every app-side `=== 'altitude'` compared it as written,
 * and the recovery sizer, the deploy-override note, the file writers and the
 * Deploy at menu all read such a chute as something it does not fly
 * (RECOV-CASE). Every app-side comparison goes through one of these two.
 */
export type DeployEvent = 'ejection' | 'apogee' | 'altitude' | 'launch' | 'never';

const KERNEL_EVENTS: ReadonlySet<string> = new Set(DEPLOY_EVENTS.map(([v]) => v));

/**
 * The event the kernel FLIES for a stored value: lower-cased, and anything it
 * does not name — absent, not a string (JsonLite.str's fallback), or desktop's
 * "lowerstageseparation" — is the motor ejection charge.
 */
export function flownDeployEvent(raw: unknown): DeployEvent {
  if (typeof raw !== 'string') return 'ejection';
  const lower = raw.toLowerCase();
  return KERNEL_EVENTS.has(lower) ? lower as DeployEvent : 'ejection';
}

/**
 * The stored value with its case folded the way the kernel folds it, when it
 * names one of the kernel's events; anything else VERBATIM. For the places
 * that keep a value rather than fly it — a file writer, a note quoting the
 * file — where desktop 24.12's sixth value, "lowerstageseparation", must
 * survive (schema.ts, ENUM_LIMITS) but "Altitude" must not reach desktop OR,
 * which matches the text case-sensitively (DocumentConfig.findEnum) and would
 * drop it.
 */
export function foldDeployEvent(raw: string): string {
  const lower = raw.toLowerCase();
  return KERNEL_EVENTS.has(lower) ? lower : raw;
}
