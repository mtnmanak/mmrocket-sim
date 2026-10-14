import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { SavedConfig } from '../model/design.js';
import { fmtFieldValue, siToUi } from '../prefs/units.js';
import { findNode } from '../tree/treeModel.js';
import { foldDeployEvent } from '../tree/deployEvent.js';
import { activeFlightOverrides, resolveFlightState } from '../services/flightState.js';

/**
 * A deployment altitude as the Deploy altitude box shows it: the user's
 * altitude unit (`prefs.units.altitude`) and the box's own digits, "400 ft" or
 * "121.92 m". Flight configurations and the RockSim reader's import note both
 * quote it through here, so the one figure reads the same in both places.
 */
export function deployAltitudeText(altM: number, distanceUnit: string): string {
  return `${fmtFieldValue(siToUi('altitude', distanceUnit, altM))} ${distanceUnit}`;
}

/**
 * `distanceUnit` is the user's altitude unit (`prefs.units.altitude`),
 * the one the Deploy altitude box itself is shown in. It is required, not
 * defaulted: the altitude used to print as raw SI with a hard-coded "m", so an
 * imperial user's 400 ft main read "121.92 m AGL descending" (audit 2026-09-30).
 * The digits are the box's own (`fmtFieldValue`), since this line quotes it.
 */
export function recoverySummary(
  config: SavedConfig, distanceUnit: string, tree?: RocketTree,
): string {
  // Summaries describe what flies, including inheriting devices in a sparse map (FC-5).
  const resolved = tree ? resolveFlightState(tree, [config], config.id, {}, {}).tree : undefined;
  const devices: Record<string, ComponentNode> = {};
  const visit = (nodes: ComponentNode[]) => nodes.forEach(n => {
    if ((n.type === 'parachute' || n.type === 'streamer') && n.id) devices[n.id] = n;
    visit(n.children ?? []);
  });
  if (resolved) visit(resolved.components);
  const entries = resolved ? Object.entries(devices) : Object.entries(config.deployments ?? {});
  const overrides = activeFlightOverrides([config], config.id, {}).deployments;
  return entries.map(([id, d], i) => {
    const node = tree ? findNode(tree, id) : null;
    // A live node's fields are `unknown`; the stored record's are typed.
    // Case folded as the kernel folds it (RECOV-CASE): "Altitude" is quoted as
    // the altitude it flies at, not as a bare word.
    const event = foldDeployEvent(String(d.deployEvent ?? 'ejection'));
    // A missing or non-finite altitude flies at the kernel's own 200 m
    // (ComponentFactory.applyDeployment keeps its default), so that is quoted.
    const altM = Number.isFinite(d.deployAltitude) ? d.deployAltitude as number : 200;
    const at = event === 'altitude'
      ? `${deployAltitudeText(altM, distanceUnit)} AGL descending`
      : event === 'ejection' ? 'ejection charge' : event;
    return `${node?.name ?? `Device ${i + 1}`}: ${at}${d.deployDelay ? ` + ${String(d.deployDelay)} s` : ''}${overrides?.[id] ? ' (override; component default is shown in the panel)' : ''}`;
  }).join('; ');
}
