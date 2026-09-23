import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { RocketTree } from '@online-openrocket/engine';
import { nozzleForMotorId, type NozzleEntry } from '../services/nozzleDb.js';
import {
  equivalentExitDiameterM, followNozzle, stageMotorKey, type StageMotors,
} from '../services/nozzleFollow.js';
import { applyStageNozzles, findNode } from '../tree/treeModel.js';

/**
 * THE NOZZLE EXIT DIAMETER FOLLOWS THE MOTOR (Eric, 2026-09-13).
 *
 * Two reports, one cause: the field was treated as a property of the ROCKET
 * when it is a property of the MOTOR. Unloading a motor left its exit
 * diameter behind ("there is no motor loaded, how can there be an exit
 * diameter?"), and loading a motor whose published exit disagreed raised a
 * warning the user had to notice and click, "which could cause a very big
 * issue if they load a motor with a very disparate exit diameter from the
 * previous motor but fail to see the warning and fly it on the old motor's
 * exit diameter."
 *
 * WHY THE DECISION IS HERE AND NOT IN NozzleField. The rule is "when the
 * motors CHANGE", and only App can tell a motor change from a file being
 * opened — a `.ork` or RASAero file arrives with a nozzle AND the motor it
 * was typed for, and replacing that on load would throw away the very case
 * the do-not-overwrite rule was written for. So this keeps a per-stage record
 * of the loadout it last saw: a stage not in it yet is SEEDED and left alone
 * (that is an open, a session restored at load, a new design), and only a stage
 * whose loadout has changed under a record is acted on. A state coming back
 * off the undo stack brings its own record with it (`restoring`, below).
 *
 * A stage id cannot collide across two opens — ids are minted `c<N>` from a
 * counter that only ever increases within a page load — so a newly opened
 * design is always seeded, never mistaken for an edit of the last one.
 *
 * Moved out of App.tsx in the 2026-09-22 audit so it can be driven by a test.
 */

/** What a stage's nozzle was cleared from, for the field's note. */
export interface NozzleCleared { previousLabel: string; previousM: number }

/** One stage's loadout as the follow bookkeeping records it. */
interface Seen { key: string; label: string }

/** The published-exit lookup; injectable so a test can hold it open. */
export type NozzleLookup = (motorId: string | undefined) => Promise<Pick<NozzleEntry, 'exitDiameterM'> | null>;

export function useNozzleFollow(opts: {
  /** `stageMotors(tree, assigned)` — the trigger: this fires on a new loadout. */
  loadout: StageMotors[];
  /** The history hook's latest-tree mirror and its no-undo-step writer. */
  treeRef: MutableRefObject<RocketTree>;
  writeTree: (next: RocketTree) => void;
  lookup?: NozzleLookup;
}): {
  /** Per stage id: the nozzle this cleared, and whose it was. */
  cleared: Record<string, NozzleCleared>;
  /**
   * Record these stages' loadouts as already SEEN — called before writing a
   * change that brings its own nozzle, so the change is not taken for a motor
   * swap. See `seed` below.
   */
  seed: (stages: readonly StageMotors[]) => void;
  /**
   * Call with a tree coming BACK off the undo / redo stack, before it is
   * written — App's `onRestore`. See `restoring` below.
   */
  restoring: (t: RocketTree) => void;
} {
  const { loadout, treeRef, writeTree, lookup = nozzleForMotorId } = opts;
  const seen = useRef(new Map<string, Seen>());
  /**
   * Per stage, the loadout the nozzle IN THE TREE was decided for. The same as
   * `seen` except while a lookup is pending, when the tree still carries the
   * previous loadout's nozzle. Replaced, never mutated, so the stamps below can
   * share one copy between every tree that carried it.
   */
  const decided = useRef<ReadonlyMap<string, Seen>>(new Map());
  /**
   * Every tree this has seen live → `decided` as it stood while that tree was
   * the live one: what each of its stages' nozzles belongs to. The undo stack
   * keeps the trees themselves, so a restored tree finds its own stamp here.
   * Weak, so a tree dropped off the stack takes its stamp with it.
   */
  const stamps = useRef(new WeakMap<RocketTree, ReadonlyMap<string, Seen>>());
  const [cleared, setCleared] = useState<Record<string, NozzleCleared>>({});
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    void (async () => {
      const acted = loadout.filter((s) => {
        const was = seen.current.get(s.stageId);
        return was !== undefined && was.key !== stageMotorKey(s);
      });
      // Record what we have seen BEFORE any await, so a second render landing
      // mid-lookup cannot act on the same change twice.
      const previous = new Map(seen.current);
      for (const s of loadout) {
        seen.current.set(s.stageId, {
          key: stageMotorKey(s),
          label: s.motors[0]?.label ?? '',
        });
      }
      // Stages the tree no longer has: drop them, or a deleted-then-recreated
      // id would inherit a loadout it never had.
      for (const id of [...seen.current.keys()]) {
        if (!loadout.some((s) => s.stageId === id)) seen.current.delete(id);
      }
      // A stage seen for the first time carries a nozzle decided for what is
      // loaded now (the file's own, the new design's); a stage that has gone,
      // goes. An ACTED stage keeps its old record until its decision lands.
      const firstSight = loadout.filter((s) => !previous.has(s.stageId));
      const gone = [...decided.current.keys()].filter((id) => !seen.current.has(id));
      if (firstSight.length > 0 || gone.length > 0) {
        const next = new Map(decided.current);
        for (const s of firstSight) next.set(s.stageId, seen.current.get(s.stageId)!);
        for (const id of gone) next.delete(id);
        decided.current = next;
      }
      stamps.current.set(treeRef.current, decided.current);
      if (acted.length === 0) return;

      const looked: { s: StageMotors; entries: (Pick<NozzleEntry, 'exitDiameterM'> | null)[] }[] = [];
      for (const s of acted) {
        looked.push({ s, entries: await Promise.all(s.motors.map((m) => lookup(m.motorId))) });
      }
      if (!mounted.current) return;

      // EACH STAGE'S DECISION IS STILL ITS OWN after the await (audit
      // 2026-09-22). This used to be one flag for the whole run, cleared
      // whenever the effect re-ran — and it re-runs on ANY new loadout array,
      // which a rename or a keystroke anywhere produces, while the record above
      // had already been written. The decision was dropped with nothing left to
      // make it again, and the new motor flew the previous motor's exit. Now a
      // stage is decided here unless a NEWER loadout has been recorded for it
      // since, in which case that run decides it.
      const updates: Record<string, number> = {};
      const clearedNow: Record<string, NozzleCleared> = {};
      const forgotten: string[] = [];
      const nowDecided = new Map(decided.current);
      for (const { s, entries } of looked) {
        const current = seen.current.get(s.stageId);
        if (current?.key !== stageMotorKey(s)) continue;
        nowDecided.set(s.stageId, current);
        // The stage as it stands NOW, not when the lookup started.
        const node = findNode(treeRef.current, s.stageId);
        const was = previous.get(s.stageId);
        const act = followNozzle({
          hadMotorsBefore: (was?.key ?? '') !== '',
          previousLabel: was?.label ?? '',
          currentValueM: typeof node?.['nozzleExitDiameter'] === 'number' ? node['nozzleExitDiameter'] : null,
          publishedM: equivalentExitDiameterM(s.motors.map((m, i) => ({
            count: m.count,
            exitDiameterM: entries[i]?.exitDiameterM ?? null,
          }))),
        });
        if (act.kind === 'set') { updates[s.stageId] = act.exitDiameterM; forgotten.push(s.stageId); }
        else if (act.kind === 'clear') {
          updates[s.stageId] = 0; // applyStageNozzles deletes the key on 0
          clearedNow[s.stageId] = { previousLabel: act.previousLabel, previousM: act.previousM };
        } else forgotten.push(s.stageId);
      }
      // `writeTree`, NOT `setTree`: this is a consequence of a motor change,
      // and motors do not live in the tree, so they are not on the undo stack.
      // Pushing an undo entry here would make this write the first thing Ctrl+Z
      // takes back, putting the PREVIOUS motor's exit diameter under the motor
      // that is actually loaded. It is not the only way back there: every state
      // already on the stack was recorded under the previous motor too, which
      // is what `restoring` below is for.
      decided.current = nowDecided;
      if (Object.keys(updates).length > 0) writeTree(applyStageNozzles(treeRef.current, updates));
      stamps.current.set(treeRef.current, decided.current);
      if (Object.keys(clearedNow).length > 0 || forgotten.length > 0) {
        setCleared((prev) => {
          const next = { ...prev, ...clearedNow };
          for (const id of forgotten) delete next[id];
          return next;
        });
      }
    })();
    // `treeRef`, `writeTree` and `lookup` are stable; the loadout is the trigger.
  }, [loadout, treeRef, writeTree, lookup]);
  /**
   * A CONFIGURATION SWITCH IS NOT A MOTOR CHANGE (audit 2026-09-22). A RASAero
   * simulation states the nozzle of the motor it flies, and the switch writes
   * that nozzle with those motors — but the record above had never seen the new
   * loadout, so it acted on the switch as a swap and replaced or cleared the
   * very nozzle the configuration states. Measured by the audit on
   * `ThreeCarbYen-2018.CDX1`: switching to sim-2 deleted its stated 25.40 mm
   * exit under a false note ("was for M745-P"), and Save then dropped it. The
   * switch seeds the stages whose nozzle it states, BEFORE its state writes, so
   * the effect finds nothing changed there.
   */
  const seed = useCallback((stages: readonly StageMotors[]) => {
    const next = new Map(decided.current);
    for (const s of stages) {
      const v = { key: stageMotorKey(s), label: s.motors[0]?.label ?? '' };
      seen.current.set(s.stageId, v);
      next.set(s.stageId, v);
    }
    decided.current = next;
  }, []);
  /**
   * UNDO AFTER A MOTOR CHANGE (audit 2026-09-22, from review). The undo stack
   * holds the tree alone, and the nozzle is the one field in it that follows
   * the motor — so every state recorded before a motor change carries the
   * previous motor's exit. Ctrl+Z on any earlier edit (a rename) put it back
   * under the motor loaded now, and the effect never corrected it because the
   * loadout had not changed: the review restored J1's 12 mm under K1, the state
   * Eric's rule exists to prevent. (An Open and a configuration switch start
   * the history over instead; this is the path neither of those covers.)
   *
   * So a restored tree brings back the record of what ITS nozzles were decided
   * for, from its stamp. Where that is not what is loaded now, the effect sees
   * a motor change from it — the same one the user made — and makes the same
   * decision on the restored state: the loaded motor's published exit, or a
   * clear with the note saying whose it was. Where it IS what is loaded now
   * (undoing a nozzle typed for this motor, or a deleted mount coming back
   * with its motor), nothing changes and the restored value stands. A tree
   * with no stamp — written and pushed in one tick, never rendered — is left
   * to the record as it stands, which is how every restore behaved before.
   */
  const restoring = useCallback((t: RocketTree) => {
    const was = stamps.current.get(t);
    if (was === undefined) return;
    const next = new Map(decided.current);
    for (const [id, v] of was) {
      seen.current.set(id, v);
      next.set(id, v);
    }
    decided.current = next;
  }, []);
  return { cleared, seed, restoring };
}
