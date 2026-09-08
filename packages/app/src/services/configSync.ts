import type { RocketTree } from '@online-openrocket/engine';
import type { MountMotor, SavedConfig } from '../App.js';
import type { OrkMotorRef } from './orkFile.js';
import { stableJson } from './dirtyState.js';
import {
  LEGACY_PAD_MASS_KEY, motorIdentity, motorSetIdentity, parseSetIdentity, rekeyUnmatched,
} from './hardwareMass.js';
import { clusterCount } from '../tree/cluster.js';
import { findNode, motorMounts, primaryMountOf } from '../tree/treeModel.js';

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
 * the working references are seeded from the active configuration at
 * restore. Pure — no React, no kernel — so each is a unit test.
 */

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
    const inTree = new Set(motorMounts(tree).map((n) => n.id));
    const count = (id: string) => clusterCount(findNode(tree, id)?.['cluster'] as string | undefined);
    const key = motorSetIdentity([
      ...Object.entries(next).filter(([id]) => inTree.has(id))
        .map(([id, mm]) => [id, motorIdentity(mm.meta, mm.spec.designation), count(id)] as const),
      ...Object.entries(remainingRefs).filter(([id]) => id !== mountId && inTree.has(id))
        .map(([id, ref]) => [id, `unmatched:${ref.designation}`, count(id)] as const),
    ]);
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
 * The working set's unmatched references at restore: the active
 * configuration's stored refs (the session's only copy — the working set is
 * not persisted), minus any mount that has a record in `motors` (a motor
 * assigned to that mount after the import superseded the reference).
 */
export function restoreUnmatchedRefs(
  configs: SavedConfig[] | undefined, activeId: string | null | undefined,
  motors: Record<string, MountMotor>,
): Record<string, OrkMotorRef> {
  if (!configs || !activeId) return {};
  const refs = configs.find((c) => c.id === activeId)?.unmatchedRefs;
  if (!refs) return {};
  const out: Record<string, OrkMotorRef> = {};
  for (const [id, ref] of Object.entries(refs)) {
    if (motors[id] === undefined) out[id] = ref;
  }
  return out;
}
