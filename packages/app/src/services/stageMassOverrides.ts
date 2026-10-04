import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { numOpt } from '../tree/nodeNum.js';

/** A complete snapshot: absent fields clear the previous configuration's values. */
export interface StageMassOverride {
  overrideMass?: number;
  overrideCGX?: number;
  overrideSubcomponentsMass?: boolean;
  overrideSubcomponentsCG?: boolean;
  overrideIncludesMotor?: string;
}

const KEYS = ['overrideMass', 'overrideCGX', 'overrideSubcomponentsMass',
  'overrideSubcomponentsCG', 'overrideIncludesMotor'] as const;

/** Only mass/CG and their unresolved-motor mark belong to this snapshot, never Cd. */
export function captureStageMass(node: Record<string, unknown>): StageMassOverride {
  const out: StageMassOverride = {};
  for (const key of ['overrideMass', 'overrideCGX'] as const) {
    const value = numOpt(node as ComponentNode, key);
    if (value !== undefined) out[key] = value;
  }
  for (const key of ['overrideSubcomponentsMass', 'overrideSubcomponentsCG'] as const) {
    if (typeof node[key] === 'boolean') out[key] = node[key];
  }
  if ((out.overrideMass !== undefined || out.overrideCGX !== undefined)
      && typeof node['overrideIncludesMotor'] === 'string' && node['overrideIncludesMotor'] !== '') {
    out.overrideIncludesMotor = node['overrideIncludesMotor'];
  }
  return out;
}

/** Include empty stages: switching back must clear values set by another configuration. */
export function captureTreeStageMass(tree: RocketTree): Record<string, StageMassOverride> {
  return Object.fromEntries(tree.components.flatMap(s => s.id ? [[s.id, captureStageMass(s)]] : []));
}

/**
 * Added stages initially share their live values across snapshot-bearing configs.
 * Give every such config ownership before a switch or a custom config is minted.
 * Existing entries (including empty or deleted stages retained for undo) win.
 * Snapshot-free configurations keep their ordinary global overrides.
 */
export function completeStageMass<T extends { stageMassOverrides?: Record<string, StageMassOverride> }>(
  configs: T[], tree: RocketTree,
): T[] {
  let changed = false;
  const next = configs.map(c => {
    if (!c.stageMassOverrides) return c;
    const missing = tree.components.filter(s => s.id && !Object.hasOwn(c.stageMassOverrides!, s.id));
    if (missing.length === 0) return c;
    changed = true;
    return { ...c, stageMassOverrides: { ...c.stageMassOverrides,
      ...Object.fromEntries(missing.map(s => [s.id!, captureStageMass(s)])),
    } };
  });
  return changed ? next : configs;
}

/** Only at boundaries that discard tree history; live deletion must remain undoable. */
export function pruneStageMass<T extends { stageMassOverrides?: Record<string, StageMassOverride> }>(
  configs: T[], tree: RocketTree,
): T[] {
  const ids = new Set(tree.components.map(s => s.id));
  let changed = false;
  const next = configs.map(c => {
    if (!c.stageMassOverrides || Object.keys(c.stageMassOverrides).every(id => ids.has(id))) return c;
    changed = true;
    return { ...c, stageMassOverrides: Object.fromEntries(
      Object.entries(c.stageMassOverrides).filter(([id]) => ids.has(id))) };
  });
  return changed ? next : configs;
}

export function replaceStageMass(node: ComponentNode, values: StageMassOverride): ComponentNode {
  const next = { ...node };
  for (const key of KEYS) delete next[key];
  return Object.assign(next, captureStageMass({ ...values }));
}

/** Only configurations that explicitly own these overrides change them. */
export function applyStageMass(tree: RocketTree, values?: Record<string, StageMassOverride>): RocketTree {
  if (!values) return tree;
  return { ...tree, components: tree.components.map(s =>
    s.id && Object.hasOwn(values, s.id) ? replaceStageMass(s, values[s.id]!) : s) };
}
