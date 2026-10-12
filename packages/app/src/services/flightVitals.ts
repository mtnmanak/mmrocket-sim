import { savedConfigLabel, type SavedConfig } from '../model/design.js';

/**
 * The vitals strip's Flight item (CFG-SPEC B3, ruling D3): which flight
 * configuration Launch flies, then its motor.
 *
 * - `name`: the active configuration's own (user or file) name; "Working
 *   settings" for an unsaved loadout while saved configurations exist (the
 *   chooser's "Working settings (not saved)"); otherwise null, because an
 *   unnamed configuration's label IS its motor list, which the motor label
 *   already says.
 * - `title`: the configuration's label and every loaded motor.
 */
export function flightVitals({ active, savedCount, working, motors }: {
  active: SavedConfig | undefined;
  /** How many saved configurations exist. */
  savedCount: number;
  /** Something is loaded or overridden with no configuration active. */
  working: boolean;
  /** Every loaded motor, primary first: its mount and its tooltip text. */
  motors: readonly { mount: string; text: string }[];
}): { name: string | null; title: string } {
  const own = active?.name?.trim();
  const detached = !active && savedCount > 0 && working;
  const name = own ? own : detached ? 'Working settings' : null;
  const config = active
    ? `Flight configuration “${savedConfigLabel(active)}”`
    : detached ? 'Working settings (not saved as a flight configuration)'
      : 'No saved flight configuration';
  const loaded = motors.length === 0 ? 'no motor loaded'
    : `${motors.length === 1 ? 'motor' : 'motors'}: ${motors.map((m) => `${m.mount} — ${m.text}`).join('; ')}`;
  return { name, title: `${config} · ${loaded}. Choose or edit it on Motors & Configuration.` };
}
