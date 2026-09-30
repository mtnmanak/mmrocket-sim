import type { RocketTree } from '@online-openrocket/engine';
import { savedConfigLabel, type SavedConfig } from '../model/design.js';
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

export function recoverySummary(config: SavedConfig, tree?: RocketTree, live = false): string {
  return Object.entries(config.deployments ?? {}).map(([id, stored], i) => {
    const node = tree ? findNode(tree, id) : null;
    const d = live && node ? node : stored;
    const event = d.deployEvent ?? 'ejection';
    const at = event === 'altitude' ? `${d.deployAltitude ?? 200} m AGL descending`
      : event === 'ejection' ? 'ejection charge' : event;
    return `${node?.name ?? `Device ${i + 1}`}: ${at}${d.deployDelay ? ` + ${d.deployDelay} s` : ''}`;
  }).join('; ');
}
