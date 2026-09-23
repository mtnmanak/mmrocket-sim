import { useCallback, useEffect, useReducer, useRef, useState, type MutableRefObject } from 'react';
import type { RocketTree } from '@online-openrocket/engine';

/**
 * THE DESIGN TREE AND ITS UNDO / REDO HISTORY (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
 * and the header buttons) — extracted from App.tsx in the 2026-09-22 audit
 * (extraction #4), where it was 160 lines of refs with no reset and no test.
 *
 * Undo has been here since v0.013 — 50 steps, every design-tree change,
 * gestures coalesced. v0.089 added the other half: a REDO stack, and disabled
 * states so the buttons stop being silent no-ops. (The owner's 2026-08-31b note
 * assumed neither existed; the response doc corrects the record with the
 * v0.013/v0.031/v0.033 provenance.)
 *
 * WHAT IT HOLDS IS THE TREE ALONE. Motors, flight configurations, launch
 * conditions and the measured figures live outside it, so a history that
 * outlives the design it recorded restores an airframe under somebody else's
 * motors and conditions (audit 2026-09-22): Ctrl+Z after an Open put the old
 * rocket under the new file's launch conditions, measured mass and
 * configurations, and after a configuration switch it put the old
 * configuration's nozzle, separations and deployments under the new motors.
 * `reset` is what an Open and a configuration switch call, so the history
 * starts again from the design they put on screen.
 */

/** Edits closer together than this are ONE undo step (a drag, a slider, keystrokes). */
export const HISTORY_COALESCE_MS = 800;
/** Undo steps kept; the oldest goes first. */
export const HISTORY_CAP = 50;

export interface TreeHistoryOptions {
  /**
   * Applied to a tree coming BACK off either stack before it is written — App's
   * stated-launch-weight reconcile, which a restored tree needs because motors
   * are not on the stack (see App's `spendSpentMarks`). Read at call time, so a
   * fresh closure every render is fine.
   */
  onRestore?: (t: RocketTree) => RocketTree;
  /**
   * True while stepping through history must not happen — App passes "a flight
   * holds this build's engine handle across an await". Undo rebuilds the engine,
   * and since the 2026-09-22 audit a handle held across a rebuild throws
   * `stale engine handle` where it used to address the next rocket silently.
   */
  blocked?: () => boolean;
}

export interface TreeHistory {
  /** The tree as last rendered. */
  tree: RocketTree;
  /**
   * The LATEST tree, not the last rendered one. Every writer below advances it
   * as it writes, so two handlers running in the SAME tick compose: the second
   * reads what the first wrote instead of the pre-batch snapshot React has not
   * re-rendered yet (2026-09-08, from review). `assignMotor` runs after an
   * awaited curve fetch (`MotorPicker.pick`), so two quick-picks on a two-stage
   * design can land in one flush, and building both writes from the render-time
   * `tree` discarded the first.
   */
  treeRef: MutableRefObject<RocketTree>;
  /** Write the tree WITHOUT an undo step — a consequence of something that is not on the stack. */
  writeTree: (next: RocketTree) => void;
  /** A user edit: one undo step, coalesced with edits less than {@link HISTORY_COALESCE_MS} apart. */
  setTree: (next: RocketTree) => void;
  /** A one-shot whole-tree transform (Scale): exactly one step, never merged with a neighbour. */
  commitStep: (next: RocketTree) => void;
  undo: () => void;
  redo: () => void;
  /**
   * Forget both stacks — and, given a tree, write it as the start of the new
   * history. For an Open, a share link and a configuration switch.
   */
  reset: (next?: RocketTree) => void;
  canUndo: boolean;
  canRedo: boolean;
}

/** Push onto an undo stack, dropping the oldest step past {@link HISTORY_CAP}. */
function pushCapped(stack: RocketTree[], t: RocketTree): void {
  stack.push(t);
  if (stack.length > HISTORY_CAP) stack.shift();
}

export function useTreeHistory(initial: RocketTree, options: TreeHistoryOptions = {}): TreeHistory {
  const [tree, setTreeRaw] = useState<RocketTree>(initial);
  // The stacks are REFS — they must not re-render the whole App on every push —
  // so a tiny version counter is bumped wherever they change, and THAT is what
  // the buttons' disabled state renders from.
  const history = useRef<RocketTree[]>([]);
  const future = useRef<RocketTree[]>([]);
  const lastEditAt = useRef(0);
  const [, bumpHist] = useReducer((x: number) => x + 1, 0);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  /*
   * The mirror is read by the stack operations so they never run inside a state
   * updater. This matters more than it looks: main.tsx wraps the app in
   * `<StrictMode>`, and React deliberately double-invokes updater functions in
   * development to surface impurity. Mutating `history`/`future` inside one
   * therefore pops twice per Ctrl+Z under `npm run dev` — every other undo state
   * skipped, and duplicate redo entries. Production is unaffected, which is
   * exactly what makes it dangerous: the next tester bug reproduced locally
   * would look like a shipped defect. Refs are mutated out here; the updaters
   * take plain values and stay pure.
   */
  const treeRef = useRef(tree);
  treeRef.current = tree;
  /** setTreeRaw + the mirror, so no writer can leave the two disagreeing. */
  const writeTree = useCallback((next: RocketTree) => {
    treeRef.current = next;
    setTreeRaw(next);
  }, []);

  const setTree = useCallback((next: RocketTree) => {
    // Coalesce rapid-fire edits (schematic drags, slider moves, keystrokes)
    // into ONE undo step — otherwise a 2 s drag floods the 50-entry buffer
    // and Ctrl+Z steps back a pixel at a time.
    const now = Date.now();
    if (now - lastEditAt.current > HISTORY_COALESCE_MS) pushCapped(history.current, treeRef.current);
    lastEditAt.current = now;
    // EVERY user edit forks the timeline, coalesced or not. Clearing the redo
    // stack only inside the push branch would leave a stale future that a
    // later Ctrl+Shift+Z teleports the design into.
    future.current = [];
    bumpHist();
    writeTree(next);
  }, [writeTree]);
  const undo = useCallback(() => {
    if (optionsRef.current.blocked?.()) return;
    const prev = history.current.pop();
    if (!prev) return;
    future.current.push(treeRef.current);
    // Never coalesce ACROSS an undo: without this, an edit within 800 ms of
    // the last pre-undo edit skips the history push and the state the user
    // just restored becomes unrecoverable.
    lastEditAt.current = 0;
    bumpHist();
    writeTree(optionsRef.current.onRestore?.(prev) ?? prev);
  }, [writeTree]);
  const redo = useCallback(() => {
    if (optionsRef.current.blocked?.()) return;
    const next = future.current.pop();
    if (!next) return;
    // Push UNCONDITIONALLY — bypassing the 800 ms coalesce test — and reset
    // the clock so the next real edit cannot merge into the redone state.
    // The same bug class the v0.031 no-coalesce-across-undo fix closed.
    pushCapped(history.current, treeRef.current);
    lastEditAt.current = 0;
    bumpHist();
    writeTree(optionsRef.current.onRestore?.(next) ?? next);
  }, [writeTree]);
  /**
   * `setTree`'s 800 ms coalescing window is right for a drag and wrong for a
   * one-shot transform: press Scale within 800 ms of typing in a field and the
   * transform would silently join that keystroke's step, so Ctrl+Z would take
   * back both — or neither, depending on the timing. Pushes unconditionally and
   * resets the clock afterwards, the same shape as `redo` and for the same
   * reason.
   */
  const commitStep = useCallback((next: RocketTree) => {
    pushCapped(history.current, treeRef.current);
    future.current = [];
    lastEditAt.current = 0;
    bumpHist();
    writeTree(next);
  }, [writeTree]);
  const reset = useCallback((next?: RocketTree) => {
    history.current = [];
    future.current = [];
    lastEditAt.current = 0;
    bumpHist();
    if (next !== undefined) writeTree(next);
  }, [writeTree]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const z = e.key.toLowerCase() === 'z';
      const y = e.key.toLowerCase() === 'y';
      if (!(e.ctrlKey || e.metaKey) || !(z || y)) return;
      // Leave native text undo/redo alone while the user is typing.
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
          || (t instanceof HTMLElement && t.isContentEditable)) {
        return;
      }
      e.preventDefault();
      // Shift decides BEFORE the z test: Ctrl+Shift+Z used to fall through
      // to undo, which was a misbinding, not a feature.
      if (y || (z && e.shiftKey)) redo();
      else undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo]);

  return {
    tree, treeRef, writeTree, setTree, commitStep, undo, redo, reset,
    canUndo: history.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
