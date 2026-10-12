import { DEPLOY_EVENTS, FIELDS } from '../tree/schema.js';
import { foldDeployEvent } from '../tree/deployEvent.js';
import type { IgnitionTuple, SeparationTuple } from '../model/design.js';

/**
 * A recovery device whose flight configuration OVERRIDES its own deployment
 * setting (2026-10-10, @atestani's LEM-1 file, reproduced by Eric).
 *
 * An .ork stores two deployment settings per recovery device: the bare
 * <deployevent>/<deployaltitude>/<deploydelay> tags (the component's own
 * setting) and, per flight configuration, a <deploymentconfiguration> block
 * that overrides it. Desktop OR 24.12's parachute and streamer dialogs edit and
 * show ONLY the component's own setting (ParachuteConfig.java:235,
 * StreamerConfig.java:216 — `getDefault()`), but its simulator flies the
 * configuration's value (BasicEventSimulationEngine.java:380 —
 * `get(fcid)`). So a user can set "300 ft" in the dialog, see 300 ft every
 * time they reopen it, and still fly — in desktop OR as in the app — the
 * override's ejection charge. The app retains both layers (FC-2); the note
 * distinguishes the component default from the effective flight setting.
 */
export interface DeploySetting {
  deployEvent: string;
  deployAltitude: number;
  deployDelay: number;
}

export interface DeployOverride {
  /** The device's name as the file gives it. */
  name: string;
  /** "parachute" or "streamer" — desktop OR's dialog is named after it. */
  kind: string;
  /** The component's own setting (what desktop OR's dialog shows). */
  own: DeploySetting;
  /** The chosen configuration's setting (what both apps fly). */
  flown: DeploySetting;
}

/**
 * Same deployment, as far as a flight can tell: altitude only counts for the
 * altitude event. The event's case is folded the way the kernel folds it
 * (RECOV-CASE) — "Altitude" and "altitude" fly the same — while a value the
 * kernel does not name stays distinct, as the file wrote it.
 */
export function sameDeployment(a: DeploySetting, b: DeploySetting): boolean {
  const event = foldDeployEvent(a.deployEvent);
  if (event !== foldDeployEvent(b.deployEvent)) return false;
  if (Math.abs(a.deployDelay - b.deployDelay) > 1e-9) return false;
  return event !== 'altitude' || Math.abs(a.deployAltitude - b.deployAltitude) <= 1e-6;
}

const LABEL = new Map(DEPLOY_EVENTS);

/** "Altitude (descending), 91.4 m (300 ft)" / "Motor ejection charge + 1 s". */
export function describeDeployment(d: DeploySetting): string {
  const event = foldDeployEvent(d.deployEvent);
  let s = LABEL.get(event) ?? event;
  if (event === 'altitude') {
    s += `, ${d.deployAltitude.toFixed(1)} m (${Math.round(d.deployAltitude / 0.3048)} ft)`;
  }
  if (d.deployDelay > 1e-9) s += ` + ${Number(d.deployDelay.toFixed(2))} s`;
  return s;
}

/**
 * One import note for every overridden device. Devices with the same name and
 * the same two settings are listed once with a count, the way the launch
 * report counts them ("Parachute (×2)").
 */
export function deployOverrideNote(overrides: readonly DeployOverride[], configName: string | null): string | null {
  if (overrides.length === 0) return null;
  const groups = new Map<string, { o: DeployOverride; n: number }>();
  for (const o of overrides) {
    const key = JSON.stringify([o.name, o.kind, o.own, o.flown]);
    const g = groups.get(key);
    if (g) g.n++; else groups.set(key, { o, n: 1 });
  }
  const where = configName ? `Flight configuration “${configName}”` : 'The flight configuration this file opens with';
  const lines = [...groups.values()].map(({ o, n }) =>
    `${o.name}${n > 1 ? ` (×${n})` : ''} flies at ${describeDeployment(o.flown)}, `
    + `not at its own setting (${describeDeployment(o.own)})`);
  // Both settings are shown, and edited, in the Recovery section of Motors &
  // Configuration since CFG-3 (ruling D2a); Design shows them read-only.
  return `Recovery: ${where} overrides the deployment setting — ${lines.join('; ')}. `
    + "The Recovery section on Motors & Configuration shows both; Reset to own setting there returns this configuration to the component's own setting.";
}

/** The other two parameter families use the same own-setting/override explanation. */
export function flightParameterOverrideNote(
  kind: 'separation' | 'ignition', name: string, own: SeparationTuple | IgnitionTuple,
  flown: SeparationTuple | IgnitionTuple, configName: string | null,
): string {
  const describe = (tuple: SeparationTuple | IgnitionTuple) => {
    if ('separationEvent' in tuple) {
      const labels = new Map(FIELDS.stage?.find(f => f.key === 'separationEvent')?.options ?? []);
      const event = tuple.separationEvent;
      return (labels.get(event) ?? event)
        + (event.startsWith('altitude') ? `, ${tuple.separationAltitude} m` : '')
        + (tuple.separationDelay ? ` + ${tuple.separationDelay} s` : '');
    }
    const labels: Record<IgnitionTuple['event'], string> = {
      automatic: "Automatic (launch / lower stage's ejection)", burnout: 'Lower stage burnout + delay (electronics)',
      launch: 'Launch + delay (timer)', ejectioncharge: 'Lower stage ejection charge + delay', never: 'Never',
    };
    return `${labels[tuple.event]}${tuple.delay ? ` + ${tuple.delay} s` : ''}`;
  };
  const where = configName ? `Flight configuration “${configName}”` : 'The flight configuration this file opens with';
  const component = kind === 'separation' ? 'stage' : 'mount';
  const panel = kind === 'separation' ? 'Stages section on Motors & Configuration' : 'motor card on Motors & Configuration';
  return `${where} overrides ${kind} for ${name}: it uses ${describe(flown)}, not the ${component}'s own setting (${describe(own)}). `
    + `The ${panel} shows both; Reset to own setting there returns this configuration to the ${component}'s own setting.`;
}
