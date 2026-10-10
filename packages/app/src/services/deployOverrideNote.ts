import { DEPLOY_EVENTS } from '../tree/schema.js';

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
 * override's ejection charge. The app shows and flies the override
 * (orkFile.ts `readDeployment`); this is the sentence that says so.
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

/** Same deployment, as far as a flight can tell: altitude only counts for the altitude event. */
export function sameDeployment(a: DeploySetting, b: DeploySetting): boolean {
  if (a.deployEvent !== b.deployEvent) return false;
  if (Math.abs(a.deployDelay - b.deployDelay) > 1e-9) return false;
  return a.deployEvent !== 'altitude' || Math.abs(a.deployAltitude - b.deployAltitude) <= 1e-6;
}

const LABEL = new Map(DEPLOY_EVENTS);

/** "Altitude (descending), 91.4 m (300 ft)" / "Motor ejection charge + 1 s". */
export function describeDeployment(d: DeploySetting): string {
  let s = LABEL.get(d.deployEvent) ?? d.deployEvent;
  if (d.deployEvent === 'altitude') {
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
    `${o.name}${n > 1 ? ` (×${n})` : ''} opens at ${describeDeployment(o.flown)}, `
    + `not at its own setting (${describeDeployment(o.own)})`);
  const kinds = new Set(overrides.map((o) => o.kind));
  const dialog = kinds.size === 1 && kinds.has('streamer') ? 'streamer' : kinds.has('streamer') ? 'parachute and streamer' : 'parachute';
  return `Recovery: ${where} overrides the deployment setting — ${lines.join('; ')}. `
    + `Desktop OR flies the override too, but its ${dialog} dialog shows only the component's own setting; `
    + 'the override is on its Motors & Configuration tab, under Recovery, where Reset deployment returns it to the component\'s setting. '
    + 'The app shows and flies the override: to fly the other setting, change Deploy at.';
}
