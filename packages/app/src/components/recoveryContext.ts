import type { RocketTree } from '@online-openrocket/engine';
import { savedConfigLabel, type SavedConfig } from '../model/design.js';
import { fmtFieldValue, siToUi } from '../prefs/units.js';
import { findNode } from '../tree/treeModel.js';

export function recoveryScope(configs: SavedConfig[], activeId: string | null, nodeId: string): string | null {
  if (configs.length <= 1) return null;
  const active = configs.find((c) => c.id === activeId);
  if (active?.deployments?.[nodeId]) {
    return `Recovery settings for ${savedConfigLabel(active)}. Flight configurations → Apply switches these settings with the motors.`;
  }
  return activeId === null
    ? 'No flight configuration is active. Apply one under Flight configurations to edit its recovery settings. Newly added devices keep shared settings.'
    : 'This device has shared recovery settings across flight configurations. Flight configurations → Apply switches motors and imported devices’ recovery settings.';
}

/**
 * `distanceUnit` is the user's altitude/distance unit (`prefs.units.distance`),
 * the one the Deploy altitude box itself is shown in. It is required, not
 * defaulted: the altitude used to print as raw SI with a hard-coded "m", so an
 * imperial user's 400 ft main read "121.92 m AGL descending" (audit 2026-09-30).
 * The digits are the box's own (`fmtFieldValue`), since this line quotes it.
 */
export function recoverySummary(
  config: SavedConfig, distanceUnit: string, tree?: RocketTree, live = false,
): string {
  return Object.entries(config.deployments ?? {}).map(([id, stored], i) => {
    const node = tree ? findNode(tree, id) : null;
    const d = live && node ? node : stored;
    const event = d.deployEvent ?? 'ejection';
    // A missing or non-finite altitude flies at the kernel's own 200 m
    // (ComponentFactory.applyDeployment keeps its default), so that is quoted.
    const altM = Number.isFinite(d.deployAltitude) ? d.deployAltitude as number : 200;
    const at = event === 'altitude'
      ? `${fmtFieldValue(siToUi('distance', distanceUnit, altM))} ${distanceUnit} AGL descending`
      : event === 'ejection' ? 'ejection charge' : event;
    return `${node?.name ?? `Device ${i + 1}`}: ${at}${d.deployDelay ? ` + ${d.deployDelay} s` : ''}`;
  }).join('; ');
}
