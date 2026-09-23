import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor, SavedConfig } from '../App.js';
import type { OrkDeployOverride, OrkMotorRef, OrkSeparationOverride } from './orkFile.js';
import { stableJson } from './dirtyState.js';
import {
  LEGACY_PAD_MASS_KEY, motorIdentity, motorSetIdentity, parseSetIdentity, rekeyUnmatched,
} from './hardwareMass.js';
import { findNode, motorMounts, mountMotorCount, primaryMountOf } from '../tree/treeModel.js';

/**
 * The working motor set ↔ the flight configuration it belongs to (v0.118).
 *
 * `savedConfigs` was written only at init / New / import (three sites, all
 * from v0.050), so every in-app motor edit — a delay yesterday, the weighed
 * pad mass today — lived in the working set alone: A→B→A discarded it, and
 * Save while B was active wrote A from its import snapshot. And the working
 * set's unmatched references were not persisted at all, so after a reload
 * the only copy of a configuration's unresolved motors was the configuration
 * itself. These helpers close both: the working set is written BACK into the
 * active configuration before a switch and before the mark a save takes, and
 * the working references are seeded at restore — from the session's own copy
 * since the 2026-09-22 audit, from the active configuration for a session
 * written before. Pure — no React, no kernel — so each is a unit test.
 */

/**
 * THE key a weighed pad mass is stored under, and compared against: the motor
 * SET it was weighed with — each mount's motor identity and the kernel's motor
 * count for that mount (a pod set or parallel stage around it multiplies its
 * cluster) — plus an `unmatched:<designation>` sentinel for every reference the
 * file named that nothing could load, so a set only half loaded is never
 * applied against a partial catalogue sum (hardwareMass 'stale-set').
 *
 * ONE rule (audit 2026-09-22). It was built three times — at import from the
 * configuration's own set, for the set on screen, and when the file's own motor
 * adopts the file's weighing (assignMotorRecord) — kept in step by hand, and the
 * third had drifted: it counted the mount's cluster where the others count the
 * kernel's motors. When they drift, a weighing reads as another set's and
 * carries nothing. `refs` is empty for the set on screen: the working references
 * are not loaded motors, and the sentinel is what keeps the weighing pending
 * until they are.
 */
export function padMassSetKey(
  tree: RocketTree, motors: Record<string, MountMotor>, refs: Record<string, OrkMotorRef> = {},
): string {
  return motorSetIdentity([
    ...Object.entries(motors).map(([id, mm]) =>
      [id, motorIdentity(mm.meta, mm.spec.designation), mountMotorCount(tree, id)] as const),
    ...Object.entries(refs).map(([id, ref]) =>
      [id, `unmatched:${ref.designation}`, mountMotorCount(tree, id)] as const),
  ]);
}

/**
 * The working set written back into the active configuration. Returns
 * `configs` BY IDENTITY when `activeId` is null, names no configuration, or
 * the active configuration's `motors`, `unmatched` and `unmatchedRefs`
 * already equal the working set under `stableJson` — so an unchanged
 * configuration fingerprints exactly as before (the dirty-state contract).
 * Otherwise the active row is rebuilt with `motors` = `motors` (verbatim,
 * stale ids included — an undo-restored mount keeps its motor; the export
 * gate and the set identity ignore them), and `unmatched` / `unmatchedRefs`
 * REPLACED: both keys deleted when `unmatchedRefs` is empty, else
 * `unmatchedRefs` set and `unmatched` derived from the refs' designations in
 * insertion order (the order applyImported wrote them). A `...c` spread alone
 * would leave a stale `unmatched` beside an empty set.
 */
export function withActiveConfigSynced(
  configs: SavedConfig[], activeId: string | null,
  motors: Record<string, MountMotor>, unmatchedRefs: Record<string, OrkMotorRef>,
): SavedConfig[] {
  if (activeId === null) return configs;
  const at = configs.findIndex((c) => c.id === activeId);
  if (at === -1) return configs;
  const c = configs[at]!;
  const unmatched = Object.values(unmatchedRefs).map((r) => r.designation);
  // Compared field by field against the NORMALISED stored shape (absent ≡
  // empty), so a row that was imported with `unmatched: []` and no refs is
  // still "already equal" to an empty working set and comes back untouched.
  if (stableJson(c.motors) === stableJson(motors)
      && stableJson(c.unmatchedRefs ?? {}) === stableJson(unmatchedRefs)
      && stableJson(c.unmatched ?? []) === stableJson(unmatched)) {
    return configs;
  }
  const { unmatched: _u, unmatchedRefs: _r, ...rest } = c;
  const next: SavedConfig = unmatched.length === 0
    ? { ...rest, motors }
    : { ...rest, motors, unmatched, unmatchedRefs };
  return configs.map((row, i) => (i === at ? next : row));
}

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
 * the configuration governs. Returns `configs` BY IDENTITY when there is no
 * active row or nothing differs under `stableJson`, the same contract as
 * `withActiveConfigSynced`.
 *
 * WHY (audit 2026-09-22). Only the MOTORS were written back, so a deployment,
 * separation or nozzle changed in the app while A was active was overwritten
 * by B's on the switch and then by A's FILE values on the way back — A→B→A
 * reverted the edit, the next Launch on A flew the file's deployment, not the
 * user's, and a Save while B was active wrote A's stale values (the .ork writer
 * replays every non-active configuration from its stored copy). A node the tree
 * no longer has keeps its stored entry; a node the configuration does not
 * govern (a chute added in the app) is tree-level and stays out of it.
 */
export function withActiveConfigTreeSynced(
  configs: SavedConfig[], activeId: string | null, tree: RocketTree,
): SavedConfig[] {
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
  const deployments = sync(c.deployments, (n, o) => liveOverride(n, o, DEPLOY_FIELDS));
  const separations = sync(c.separations, (n, o) => liveOverride(n, o, SEPARATION_FIELDS));
  // 0 = no nozzle, the stored shape's own convention (applyStageNozzles deletes
  // the key on 0).
  const nozzles = sync(c.nozzles, (n) => {
    const d = n['nozzleExitDiameter'];
    return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 0;
  });
  if (deployments === c.deployments && separations === c.separations && nozzles === c.nozzles) return configs;
  const next: SavedConfig = {
    ...c,
    ...(deployments ? { deployments } : {}),
    ...(separations ? { separations } : {}),
    ...(nozzles ? { nozzles } : {}),
  };
  return configs.map((row, i) => (i === at ? next : row));
}

/**
 * Everything live written back into the active configuration — its motors and
 * unresolved references (`withActiveConfigSynced`) and what the tree holds for
 * it (`withActiveConfigTreeSynced`). What a switch, "None" and a .ork save call
 * before they read or mark the configurations. Identity when nothing changed.
 */
export function syncActiveConfig(
  configs: SavedConfig[], activeId: string | null,
  live: { motors: Record<string, MountMotor>; unmatchedRefs: Record<string, OrkMotorRef>; tree: RocketTree },
): SavedConfig[] {
  return withActiveConfigTreeSynced(
    withActiveConfigSynced(configs, activeId, live.motors, live.unmatchedRefs), activeId, live.tree);
}

/**
 * A v0.116/v0.117 session's `measured.padMassKg` moved onto the primary
 * mount's record of the restored set — primary and attachment computed over
 * the IN-TREE subset of `motors` (`motorMounts(tree)` ids), keyed
 * `LEGACY_PAD_MASS_KEY` so App checks it against the loaded motor after the
 * first build and the field hides it until then. `outcome` is 'attached',
 * 'dropped' (a finite positive value but no in-tree mount with a motor — the
 * motor was unloaded, so the value has nothing to belong to) or 'none' (no
 * legacy value). Returns `motors` BY IDENTITY unless it attached, so every
 * session without the key restores byte-identical.
 */
export function migrateLegacyPadMass(
  motors: Record<string, MountMotor>, legacyPadMassKg: unknown, tree: RocketTree,
): { motors: Record<string, MountMotor>; outcome: 'attached' | 'dropped' | 'none'; kg?: number; mountId?: string } {
  if (typeof legacyPadMassKg !== 'number' || !Number.isFinite(legacyPadMassKg) || legacyPadMassKg <= 0) {
    return { motors, outcome: 'none' };
  }
  const kg = legacyPadMassKg;
  const mountIds = new Set(motorMounts(tree).map((n) => n.id));
  const primary = primaryMountOf(tree, Object.keys(motors).filter((id) => mountIds.has(id)));
  if (primary === null) return { motors, outcome: 'dropped', kg };
  return {
    motors: { ...motors, [primary]: { ...motors[primary]!, padMassKg: kg, padMassWeighedWith: LEGACY_PAD_MASS_KEY } },
    outcome: 'attached',
    kg,
    mountId: primary,
  };
}

/**
 * Both pad-mass keys deleted from every record (Scale: the rocket that was
 * weighed no longer exists — the same reason the measured figures are
 * cleared there). Returns the input by identity when no record carries one.
 */
export function stripPadMass(motors: Record<string, MountMotor>): Record<string, MountMotor> {
  const carries = (mm: MountMotor) => 'padMassKg' in mm || 'padMassWeighedWith' in mm;
  if (!Object.values(motors).some(carries)) return motors;
  const out: Record<string, MountMotor> = {};
  for (const [id, mm] of Object.entries(motors)) {
    if (!carries(mm)) { out[id] = mm; continue; }
    const { padMassKg: _p, padMassWeighedWith: _w, ...rest } = mm;
    out[id] = rest;
  }
  return out;
}

/** `padMassKg` deleted from every unmatched reference; identity when none carries one. */
export function stripRefPadMass(refs: Record<string, OrkMotorRef>): Record<string, OrkMotorRef> {
  if (!Object.values(refs).some((r) => 'padMassKg' in r)) return refs;
  const out: Record<string, OrkMotorRef> = {};
  for (const [id, ref] of Object.entries(refs)) {
    if (!('padMassKg' in ref)) { out[id] = ref; continue; }
    const { padMassKg: _p, ...rest } = ref;
    out[id] = rest;
  }
  return out;
}

const sameDesignation = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The pad mass a file left on an unmatched reference, when the motor now
 * being loaded on that mount IS the reference's motor — designation equal
 * case-insensitively, the findDbMotor rank-0 rule. Undefined otherwise: a
 * different motor on that mount cannot inherit a weighing nobody made with
 * it. One rule, used by `assignMotorRecord` to attach and by App to word the
 * note (2026-09-08 review: the card had promised "Load that motor to use it"
 * while assignMotor dropped the value and told the user to re-weigh with the
 * motor they had just loaded).
 */
export function adoptsRefPadMass(ref: OrkMotorRef | undefined, designation: string): number | undefined {
  if (!ref || typeof ref.padMassKg !== 'number' || !Number.isFinite(ref.padMassKg) || ref.padMassKg <= 0) {
    return undefined;
  }
  return sameDesignation(ref.designation, designation) ? ref.padMassKg : undefined;
}

/**
 * assignMotor's working set once `fresh` is loaded on `mountId` — the three
 * ways a weighed pad mass survives the assignment, kept pure so each is a
 * unit test rather than an App render:
 *
 *  1. the SAME motor re-picked from the browser (a delay change): the old
 *     record's two keys are carried — the set identity excludes delay, so the
 *     stored key is still right. The card's delay controls spread the record
 *     and kept the weighing already; the browser path replaced the record
 *     and silently lost it, against the guide's promise.
 *  2. the file's reference for this mount carried the file's pad mass (the
 *     mount was the file's primary and its motor could not be loaded) and
 *     the loaded motor is that motor (`adoptsRefPadMass`): the value goes on
 *     the new record, keyed to the POST-assignment set — every in-tree record
 *     plus the remaining references as `unmatched:` sentinels — so it applies
 *     when nothing else is missing and the line reads "load it to use the pad
 *     mass" when something is. A different motor there drops it: the caller
 *     deletes the reference, value and all, and says so.
 *  3. the primary's key names this mount `unmatched:<d>` and the loaded
 *     designation is <d>: that entry is rewritten to the loaded identity,
 *     count kept, so the file's own motor satisfies its own weighing.
 */
export function assignMotorRecord(
  prev: Record<string, MountMotor>, mountId: string, fresh: MountMotor,
  ctx: {
    tree: RocketTree;
    /** App's primaryMountId as of this render (matched motors only). */
    primaryMountId: string | null;
    /** The working reference for `mountId`, if the file left one — the caller drops it. */
    droppedRef: OrkMotorRef | undefined;
    /** Every other working reference, still unmatched after this assignment. */
    remainingRefs: Record<string, OrkMotorRef>;
  },
): Record<string, MountMotor> {
  const { tree, primaryMountId, droppedRef, remainingRefs } = ctx;
  const identity = motorIdentity(fresh.meta, fresh.spec.designation);
  let record: MountMotor = fresh;
  // 1. Same motor, keys carried.
  const old = prev[mountId];
  if (old && typeof old.padMassKg === 'number' && typeof old.padMassWeighedWith === 'string'
      && motorIdentity(old.meta, old.spec.designation) === identity) {
    record = { ...fresh, padMassKg: old.padMassKg, padMassWeighedWith: old.padMassWeighedWith };
  }
  const next: Record<string, MountMotor> = { ...prev, [mountId]: record };
  // 2. The file's value adopted by the file's own motor.
  const adoptedKg = adoptsRefPadMass(droppedRef, fresh.spec.designation);
  if (adoptedKg !== undefined) {
    // THE key rule (padMassSetKey), over the in-tree records and references.
    // It counted each mount's CLUSTER here while the set on screen counts the
    // kernel's motors, so on a mount inside a pod set the adopted weighing read
    // as another set's and carried nothing (audit 2026-09-22).
    const inTree = new Set(motorMounts(tree).map((n) => n.id));
    const key = padMassSetKey(
      tree,
      Object.fromEntries(Object.entries(next).filter(([id]) => inTree.has(id))),
      Object.fromEntries(Object.entries(remainingRefs).filter(([id]) => id !== mountId && inTree.has(id))),
    );
    next[mountId] = { ...record, padMassKg: adoptedKg, padMassWeighedWith: key };
  }
  // 3. The primary's sentinel for this mount satisfied.
  const pr = primaryMountId ? next[primaryMountId] : undefined;
  const key = pr?.padMassWeighedWith;
  if (primaryMountId && pr && key && key !== LEGACY_PAD_MASS_KEY) {
    const e = parseSetIdentity(key)?.find((x) => x[0] === mountId);
    if (e && e[1].startsWith('unmatched:') && sameDesignation(e[1].slice('unmatched:'.length), fresh.spec.designation)) {
      const rekeyed = rekeyUnmatched(key, mountId, identity);
      if (rekeyed !== key) next[primaryMountId] = { ...pr, padMassWeighedWith: rekeyed };
    }
  }
  return next;
}

/**
 * The active configuration's STORED copy of one unmatched reference dropped,
 * `unmatched` re-derived from what remains (both keys deleted when nothing
 * does). Identity when there is no active row or it holds no such reference.
 *
 * assignMotor and ✕ Remove drop the WORKING reference; the stored row kept
 * it until the next switch or save synced the two — and `restoreUnmatchedRefs`
 * reads the stored row, so a reload between an assign-then-remove and any
 * sync put the file's motor back on a mount the user had emptied, and Save
 * then wrote it (2026-09-08 review). v0.117 lost the reference at reload
 * instead, which was right by accident.
 */
export function withoutStoredRef(configs: SavedConfig[], activeId: string | null, mountId: string): SavedConfig[] {
  if (activeId === null) return configs;
  const at = configs.findIndex((c) => c.id === activeId);
  if (at === -1) return configs;
  const c = configs[at]!;
  if (!c.unmatchedRefs || !(mountId in c.unmatchedRefs)) return configs;
  const { [mountId]: _gone, ...refs } = c.unmatchedRefs;
  const { unmatched: _u, unmatchedRefs: _r, ...rest } = c;
  const unmatched = Object.values(refs).map((r) => r.designation);
  const next: SavedConfig = unmatched.length === 0 ? rest : { ...rest, unmatched, unmatchedRefs: refs };
  return configs.map((row, i) => (i === at ? next : row));
}

/**
 * The working set's unmatched references at restore, minus any mount that has
 * a record in `motors` (a motor assigned to that mount after the import
 * superseded the reference).
 *
 * The session's own copy (`stored`) when it carries one — since the 2026-09-22
 * audit the working references are persisted, because a configuration-less
 * import (a .rkt naming a motor the catalogue lacks) has no configuration to
 * keep them in: they lived in React state alone, a reload lost them (the
 * service worker's post-deploy reload included), and Save then wrote the
 * mount with no motor. A session written before that carries none, and falls
 * back to the ACTIVE configuration's stored refs, as v0.118 did.
 */
export function restoreUnmatchedRefs(
  configs: SavedConfig[] | undefined, activeId: string | null | undefined,
  motors: Record<string, MountMotor>, stored?: Record<string, OrkMotorRef>,
): Record<string, OrkMotorRef> {
  const refs = stored ?? (configs && activeId ? configs.find((c) => c.id === activeId)?.unmatchedRefs : undefined);
  if (!refs) return {};
  const out: Record<string, OrkMotorRef> = {};
  for (const [id, ref] of Object.entries(refs)) {
    if (motors[id] === undefined) out[id] = ref;
  }
  return out;
}
