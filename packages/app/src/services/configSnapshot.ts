import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import type { SavedConfig } from '../model/design.js';
import { num } from '../tree/nodeNum.js';
import { captureTreeStageMass } from './stageMassOverrides.js';

export const MAX_ORK_CONFIGURATIONS = 256;
export const MAX_CONFIG_NAME_LENGTH = 100;

type SnapshotNodes = boolean | ReadonlySet<string>;

/** Do not give Create ownership of settings imported configurations leave on the tree. */
export function snapshotConfigFamilies(configs: readonly SavedConfig[]) {
  const owns = (family: 'deployments' | 'separations' | 'nozzles'): SnapshotNodes => {
    if (configs.length === 0) return true;
    const ids = new Set(configs.flatMap(c => Object.keys(c[family] ?? {})));
    return ids.size > 0 ? ids : false;
  };
  return { deployments: owns('deployments'), separations: owns('separations'),
    // Match completeStageMass: even an empty snapshot map owns every live stage.
    nozzles: owns('nozzles'), stageMass: configs.some(c => !!c.stageMassOverrides) };
}

const includesNode = (nodes: SnapshotNodes | undefined, id: string) =>
  nodes === undefined || nodes === true || (nodes !== false && nodes.has(id));

/** The same UUID format for an explicit configuration and one minted by Save. */
export function configUuid(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () =>
    Math.floor(Math.random() * 16).toString(16));
}

/** One snapshot rule for Create and the writer's appended unnamed working set. */
export function snapshotLoadedConfig<M>(
  tree: RocketTree, motors: Record<string, M>,
  options: { deployments?: SnapshotNodes; separations?: SnapshotNodes; nozzles?: SnapshotNodes;
    stageMass?: SnapshotNodes; stageActiveness?: Record<string, boolean> } = {},
): Omit<SavedConfig, 'motors' | 'deployments' | 'separations' | 'nozzles'> & {
  motors: Record<string, M>;
  deployments: NonNullable<SavedConfig['deployments']>;
  separations: NonNullable<SavedConfig['separations']>;
  nozzles: NonNullable<SavedConfig['nozzles']>;
} {
  const deployments: NonNullable<SavedConfig['deployments']> = {};
  const separations: NonNullable<SavedConfig['separations']> = {};
  const nozzles: NonNullable<SavedConfig['nozzles']> = {};
  const visit = (nodes: ComponentNode[]) => {
    for (const node of nodes) {
      if (node.id && includesNode(options.deployments, node.id) && (node.type === 'parachute' || node.type === 'streamer')) {
        deployments[node.id] = {
          deployEvent: String(node['deployEvent'] ?? 'ejection'),
          deployAltitude: num(node, 'deployAltitude', 200), deployDelay: num(node, 'deployDelay', 0),
        };
      }
      if (node.id && (node.type === 'stage' || node.type === 'parallelstage')) {
        if (includesNode(options.separations, node.id)) separations[node.id] = {
          separationEvent: typeof node['separationEvent'] === 'string' ? node['separationEvent'] : 'ejection',
          separationDelay: num(node, 'separationDelay', 0), separationAltitude: num(node, 'separationAltitude', 200),
        };
        const d = node['nozzleExitDiameter'];
        if (includesNode(options.nozzles, node.id)) nozzles[node.id] = typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : null;
      }
      visit(node.children ?? []);
    }
  };
  visit(tree.components);
  return {
    id: configUuid(), name: null, isDefault: false, motors,
    deployments, separations, nozzles,
    ...(options.stageMass ? { stageMassOverrides: Object.fromEntries(
      Object.entries(captureTreeStageMass(tree)).filter(([id]) => includesNode(options.stageMass, id))) } : {}),
    ...(options.stageActiveness ? { stageActiveness: { ...options.stageActiveness } } : {}),
  };
}
