// Frozen pre-FC-4 behavior: migration oracle, never imported by production.
import type { RocketTree } from '@online-openrocket/engine';
import type { SavedConfig } from '../model/design.js';
import type { OrkDeployOverride, OrkSeparationOverride } from './orkFile.js';
import { captureStageMass, completeStageMass, applyStageMass } from './stageMassOverrides.js';
import { findNode, updateNode } from '../tree/treeModel.js';
import { separationEventOrDefault } from '../tree/sanitize.js';
import { stableJson } from './dirtyState.js';
import { applyStageNozzles } from '../tree/treeModel.js';
/** One override field: the type the node must carry it as, and what it flies without one. */
interface OverrideField { kind: 'string' | 'number'; fallback?: string | number }

/**
 * The values a node flies when it carries no field of its own — what the .ork
 * writer puts in the bare tags for the live configuration. A recovery device's
 * missing `deployEvent` has no such value (the .ork writer reads it as
 * ejection, the .CDX1 writer as apogee), so it has none here either.
 */
const DEPLOY_FIELDS: Record<keyof OrkDeployOverride, OverrideField> = {
  deployEvent: { kind: 'string' },
  deployAltitude: { kind: 'number', fallback: 200 },
  deployDelay: { kind: 'number', fallback: 0 },
};
const SEPARATION_FIELDS: Record<keyof OrkSeparationOverride, OverrideField> = {
  separationEvent: { kind: 'string', fallback: 'ejection' },
  separationDelay: { kind: 'number', fallback: 0 },
  separationAltitude: { kind: 'number', fallback: 200 },
};

/**
 * One node's live values in the shape of its stored override. A field the
 * entry already governs takes the node's value (the fallback when the node has
 * none). A field the entry does not govern is added only when the node carries
 * a value other than the fallback — something set on this configuration, which
 * a switch back must restore — so a configuration nobody edited reads exactly
 * as it was stored.
 */
function liveOverride<T extends object>(
  node: Record<string, unknown>, stored: T, fields: Record<keyof T & string, OverrideField>,
): T {
  const had = stored as Record<string, string | number | undefined>;
  const out: Record<string, string | number> = {};
  for (const [k, f] of Object.entries(fields) as [string, OverrideField][]) {
    const v = node[k];
    const own = f.kind === 'string'
      ? (typeof v === 'string' ? v : undefined)
      : (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const was = had[k];
    if (was !== undefined) out[k] = own ?? f.fallback ?? was;
    else if (own !== undefined && own !== f.fallback) out[k] = own;
  }
  return out as T;
}

/**
 * The live tree written back into the active configuration: its recovery
 * deployments, stage separations and (RASAero) nozzles, for exactly the nodes
 * the configuration governs. Stage mass/CG maps also gain every added stage,
 * including while None is active. Returns `configs` BY IDENTITY when no maps
 * need completing and no active values differ under `stableJson`.
 *
 * WHY (audit 2026-09-22). Only the MOTORS were written back, so a deployment,
 * separation or nozzle changed in the app while A was active was overwritten
 * by B's on the switch and then by A's FILE values on the way back — A→B→A
 * reverted the edit, the next Launch on A flew the file's deployment, not the
 * user's, and a Save while B was active wrote A's stale values (the .ork writer
 * replays every non-active configuration from its stored copy). A node the tree
 * no longer has keeps its stored entry; a node the configuration does not
 * govern (a chute added in the app) is tree-level and stays out of it. Stage
 * mass/CG is the exception: all snapshot-bearing configs own every live stage.
 */
export function withActiveConfigTreeSynced(
  configs: SavedConfig[], activeId: string | null, tree: RocketTree,
): SavedConfig[] {
  configs = completeStageMass(configs, tree);
  if (activeId === null) return configs;
  const at = configs.findIndex((c) => c.id === activeId);
  if (at === -1) return configs;
  const c = configs[at]!;
  const sync = <V>(stored: Record<string, V> | undefined, capture: (node: Record<string, unknown>, v: V) => V) => {
    if (!stored) return stored;
    let changed = false;
    const out: Record<string, V> = {};
    for (const [id, v] of Object.entries(stored)) {
      const node = findNode(tree, id);
      const next = node ? capture(node, v) : v;
      if (stableJson(next) !== stableJson(v)) changed = true;
      out[id] = next;
    }
    return changed ? out : stored;
  };
  const stageMassOverrides = sync(c.stageMassOverrides, (n) => captureStageMass(n));
  const deployments = sync(c.deployments, (n, o) => liveOverride(n, o, DEPLOY_FIELDS));
  const separations = sync(c.separations, (n, o) => liveOverride(n, o, SEPARATION_FIELDS));
  // Preserve explicit OFF separately from blank/automatic.
  const nozzles = sync(c.nozzles, (n) => {
    const d = n['nozzleExitDiameter'];
    return typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : null;
  });
  if (deployments === c.deployments && separations === c.separations && nozzles === c.nozzles
      && stageMassOverrides === c.stageMassOverrides) return configs;
  const next: SavedConfig = {
    ...c,
    ...(deployments ? { deployments } : {}),
    ...(separations ? { separations } : {}),
    ...(nozzles ? { nozzles } : {}),
    ...(stageMassOverrides ? { stageMassOverrides } : {}),
  };
  return configs.map((row, i) => (i === at ? next : row));
}

export function configOntoTree(
  tree: RocketTree,
  cfg: Pick<SavedConfig, 'deployments' | 'separations' | 'nozzles' | 'stageMassOverrides'>,
): RocketTree {
  const hasDeploy = cfg.deployments && Object.keys(cfg.deployments).length > 0;
  const hasSep = cfg.separations && Object.keys(cfg.separations).length > 0;
  const hasNozzles = cfg.nozzles && Object.keys(cfg.nozzles).length > 0;
  let next = applyStageMass(tree, cfg.stageMassOverrides);
  if (!hasDeploy && !hasSep && !hasNozzles) return next;
  // The nozzle is the flown motor's, so it switches with the motors: a
  // RASAero file's simulations can each state a different one (0 removes
  // it — the previous configuration's must not linger, same rule as the
  // separation write below).
  if (hasNozzles) next = applyStageNozzles(next, cfg.nozzles!);
  for (const [nodeId, d] of Object.entries(cfg.deployments ?? {})) {
    if (!findNode(next, nodeId)) continue;
    next = updateNode(next, nodeId, {
      ...(d.deployEvent !== undefined ? { deployEvent: d.deployEvent } : {}),
      ...(d.deployAltitude !== undefined ? { deployAltitude: d.deployAltitude } : {}),
      ...(d.deployDelay !== undefined ? { deployDelay: d.deployDelay } : {}),
    });
  }
  // Separation must be written even when it is the kernel default
  // ("ejection"): the point is to REPLACE whatever the previously applied
  // configuration left behind, so skipping the default would strand a
  // "never" from the last one.
  //
  // The event in the kernel's spelling, or desktop's default: a saved
  // configuration lives outside the tree, so the load boundary's sanitize
  // pass never sees it, and OrkEngine THROWS on a value it does not know —
  // which failed the whole build the moment the configuration was applied
  // (audit 2026-09-22). The .ork reader repairs one with a note; this
  // guards a configuration a session saved before it did.
  for (const [nodeId, sep] of Object.entries(cfg.separations ?? {})) {
    if (!findNode(next, nodeId)) continue;
    next = updateNode(next, nodeId, {
      ...(sep.separationEvent !== undefined ? { separationEvent: separationEventOrDefault(sep.separationEvent) } : {}),
      ...(sep.separationDelay !== undefined ? { separationDelay: sep.separationDelay } : {}),
      ...(sep.separationAltitude !== undefined ? { separationAltitude: sep.separationAltitude } : {}),
    });
  }
  return next;
}

