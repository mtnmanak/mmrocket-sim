// @vitest-environment happy-dom
import { act } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { FirstRunTour } from '../components/FirstRunTour.js';
import { Modal } from '../components/Modal.js';
import {
  HISTORY_CAP, HISTORY_COALESCE_MS, useTreeHistory, type TreeHistory, type TreeHistoryOptions,
} from './useTreeHistory.js';

/**
 * The design tree's undo / redo history, extracted from App.tsx in the
 * 2026-09-22 audit (extraction #4). It carried four past bugs fixed by hand in
 * its comments — StrictMode double pops, coalescing across an undo, redo merging
 * with the next edit, a stale redo future — and not one test. Each is pinned
 * here, and so are the two things the audit added: `reset` (an Open and a
 * configuration switch start the history over) and the dialog gate on the key
 * binding.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (name: string): RocketTree => ({ name, components: [] });

let roots: Root[] = [];
let containers: HTMLElement[] = [];

function mount(el: React.ReactElement): Root {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(el));
  roots.push(root);
  containers.push(container);
  return root;
}

/** A minimal renderHook: the hook's latest return value, re-read after every act(). */
function renderHistory(initial: RocketTree, options?: TreeHistoryOptions): { current: TreeHistory } {
  const result = { current: undefined as unknown as TreeHistory };
  function Probe() {
    result.current = useTreeHistory(initial, options);
    return null;
  }
  mount(<Probe />);
  return result;
}

const key = (k: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean } = { ctrl: true }, target?: EventTarget) => {
  const ev = new KeyboardEvent('keydown', {
    key: k, ctrlKey: mods.ctrl ?? false, metaKey: mods.meta ?? false, shiftKey: mods.shift ?? false,
    bubbles: true, cancelable: true,
  });
  act(() => { (target ?? window).dispatchEvent(ev); });
  return ev;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-22T12:00:00Z'));
});

afterEach(() => {
  for (const r of roots) act(() => r.unmount());
  for (const c of containers) c.remove();
  roots = [];
  containers = [];
  vi.useRealTimers();
});

/** An edit, then a pause long enough that the next one is its own step. */
const editApart = (h: { current: TreeHistory }, next: RocketTree) => {
  act(() => h.current.setTree(next));
  vi.advanceTimersByTime(HISTORY_COALESCE_MS + 1);
};

describe('useTreeHistory — steps', () => {
  it('coalesces edits less than 800 ms apart into ONE undo step, and starts a new one after', () => {
    const h = renderHistory(t('0'));
    act(() => h.current.setTree(t('a')));
    vi.advanceTimersByTime(HISTORY_COALESCE_MS - 1);
    act(() => h.current.setTree(t('b')));
    vi.advanceTimersByTime(HISTORY_COALESCE_MS + 1);
    act(() => h.current.setTree(t('c')));
    act(() => h.current.undo());
    expect(h.current.tree.name).toBe('b');
    act(() => h.current.undo());
    // a and b were one drag: Ctrl+Z takes both back at once.
    expect(h.current.tree.name).toBe('0');
    expect(h.current.canUndo).toBe(false);
  });

  it(`keeps ${HISTORY_CAP} steps and drops the oldest first`, () => {
    const h = renderHistory(t('0'));
    for (let i = 1; i <= HISTORY_CAP + 10; i++) editApart(h, t(String(i)));
    let undos = 0;
    while (h.current.canUndo) { act(() => h.current.undo()); undos++; }
    expect(undos).toBe(HISTORY_CAP);
    // 60 edits, 50 kept: the earliest reachable state is the one after edit 10.
    expect(h.current.tree.name).toBe('10');
  });

  it('redo puts back what undo took, and a new edit forks the timeline', () => {
    const h = renderHistory(t('0'));
    editApart(h, t('a'));
    editApart(h, t('b'));
    act(() => h.current.undo());
    expect(h.current.tree.name).toBe('a');
    expect(h.current.canRedo).toBe(true);
    act(() => h.current.redo());
    expect(h.current.tree.name).toBe('b');
    act(() => h.current.undo());
    act(() => h.current.setTree(t('x')));
    // A stale future would teleport the design back to 'b' on Ctrl+Shift+Z.
    expect(h.current.canRedo).toBe(false);
    act(() => h.current.redo());
    expect(h.current.tree.name).toBe('x');
  });

  it('never coalesces ACROSS an undo (v0.031): an edit right after Ctrl+Z is its own step', () => {
    const h = renderHistory(t('0'));
    editApart(h, t('a'));
    act(() => h.current.setTree(t('b')));
    act(() => h.current.undo()); // back to 'a', well inside 800 ms of the edit
    act(() => h.current.setTree(t('c')));
    act(() => h.current.undo());
    // Without the clock reset the edit to 'c' joined the pre-undo step and 'a'
    // was unrecoverable.
    expect(h.current.tree.name).toBe('a');
  });

  it('redo resets the clock, so the next edit does not merge into the redone state', () => {
    const h = renderHistory(t('0'));
    editApart(h, t('a'));
    act(() => h.current.undo());
    act(() => h.current.redo());
    act(() => h.current.setTree(t('b')));
    act(() => h.current.undo());
    expect(h.current.tree.name).toBe('a');
  });

  it('commitStep is exactly one step, even straight after a keystroke', () => {
    const h = renderHistory(t('0'));
    act(() => h.current.setTree(t('typed')));
    act(() => h.current.commitStep(t('scaled')));
    act(() => h.current.setTree(t('after')));
    act(() => h.current.undo());
    expect(h.current.tree.name).toBe('scaled');
    act(() => h.current.undo());
    // Scale inside the keystroke's 800 ms window used to join its step.
    expect(h.current.tree.name).toBe('typed');
  });

  it('writeTree changes the design with no undo step and keeps the redo stack', () => {
    const h = renderHistory(t('0'));
    editApart(h, t('a'));
    act(() => h.current.undo());
    act(() => h.current.writeTree(t('consequence')));
    expect(h.current.canUndo).toBe(false);
    expect(h.current.canRedo).toBe(true);
  });

  it('runs onRestore on a tree coming back off either stack', () => {
    const onRestore = vi.fn((x: RocketTree) => ({ ...x, name: `${x.name}*` }));
    const h = renderHistory(t('0'), { onRestore });
    editApart(h, t('a'));
    act(() => h.current.undo());
    expect(h.current.tree.name).toBe('0*');
    act(() => h.current.redo());
    expect(h.current.tree.name).toBe('a*');
    expect(onRestore).toHaveBeenCalledTimes(2);
  });

  it('treeRef is the LATEST tree: two writes in one tick compose', () => {
    const h = renderHistory(t('0'));
    act(() => {
      h.current.setTree({ ...h.current.treeRef.current, name: 'first' });
      // The second writer reads what the first wrote, not the render's tree.
      h.current.setTree({ ...h.current.treeRef.current, components: [{ type: 'bodytube' }] });
    });
    expect(h.current.tree.name).toBe('first');
    expect(h.current.tree.components).toHaveLength(1);
  });
});

describe('useTreeHistory — reset (audit 2026-09-22)', () => {
  /**
   * The stack holds the tree alone. Without a reset, Ctrl+Z after an Open put
   * the old rocket back under the new file's launch conditions, measured mass
   * and configurations, and Save wrote the hybrid.
   */
  it('reset(next) writes the new design and leaves nothing to undo or redo', () => {
    const h = renderHistory(t('old'));
    editApart(h, t('old-edited'));
    editApart(h, t('old-edited-2'));
    act(() => h.current.undo());
    act(() => h.current.reset(t('opened')));
    expect(h.current.tree.name).toBe('opened');
    expect(h.current.canUndo).toBe(false);
    expect(h.current.canRedo).toBe(false);
    act(() => h.current.undo());
    act(() => h.current.redo());
    expect(h.current.tree.name).toBe('opened');
  });

  it('reset() with no tree clears the stacks and keeps the design', () => {
    const h = renderHistory(t('0'));
    editApart(h, t('a'));
    act(() => h.current.reset());
    expect(h.current.tree.name).toBe('a');
    expect(h.current.canUndo).toBe(false);
  });

  it('the first edit after a reset is its own step, however soon it comes', () => {
    const h = renderHistory(t('0'));
    act(() => h.current.setTree(t('a')));
    act(() => h.current.reset(t('opened')));
    act(() => h.current.setTree(t('edit')));
    act(() => h.current.undo());
    expect(h.current.tree.name).toBe('opened');
  });
});

describe('useTreeHistory — the key binding', () => {
  it('Ctrl+Z undoes; Ctrl+Shift+Z, Ctrl+Y and Cmd+Shift+Z redo', () => {
    const h = renderHistory(t('0'));
    editApart(h, t('a'));
    expect(key('z').defaultPrevented).toBe(true);
    expect(h.current.tree.name).toBe('0');
    key('Z', { ctrl: true, shift: true });
    expect(h.current.tree.name).toBe('a');
    key('z', { meta: true });
    expect(h.current.tree.name).toBe('0');
    key('y');
    expect(h.current.tree.name).toBe('a');
    key('z', { meta: true });
    key('z', { meta: true, shift: true });
    expect(h.current.tree.name).toBe('a');
  });

  it('leaves text fields to their own native undo', () => {
    const h = renderHistory(t('0'));
    editApart(h, t('a'));
    const input = document.createElement('input');
    document.body.appendChild(input);
    const ev = key('z', { ctrl: true }, input);
    expect(ev.defaultPrevented).toBe(false);
    expect(h.current.tree.name).toBe('a');
    input.remove();
  });

  /**
   * Audit 2026-09-22. useDialog lets every key but Escape and Tab through, so
   * Ctrl+Z during a Batch sweep rebuilt the rocket the sweep was flying, and
   * behind the Save/Discard modal it undid the design unseen — which Save then
   * wrote. Uses the real Modal (and so the real useDialog stack).
   */
  it('does nothing while a dialog is open, and works again once it closes', () => {
    const h = renderHistory(t('0'));
    editApart(h, t('a'));
    const dialog = mount(<Modal label="Unsaved changes" onClose={() => {}}><button>Cancel</button></Modal>);
    const ev = key('z');
    expect(h.current.tree.name).toBe('a');
    expect(ev.defaultPrevented).toBe(false);
    key('y');
    expect(h.current.tree.name).toBe('a');
    act(() => dialog.unmount());
    key('z');
    expect(h.current.tree.name).toBe('0');
  });

  /**
   * From review (audit 2026-09-22). The gate first counted every useDialog
   * user, and the first-run tour is one — but the tour leaves the app usable
   * behind its card and opens by itself on a first visit, so a new visitor
   * editing around it found Ctrl+Z silently dead while the header's Undo still
   * worked. The real tour, mounted here.
   */
  it('keeps working while the first-run tour (not modal) is up', () => {
    const h = renderHistory(t('0'));
    editApart(h, t('a'));
    mount(<FirstRunTour onSetTab={() => {}} onClose={() => {}} />);
    // The tour moves focus into its card; the keys arrive from the page.
    const ev = key('z', { ctrl: true }, document.body);
    expect(ev.defaultPrevented).toBe(true);
    expect(h.current.tree.name).toBe('0');
    key('y', { ctrl: true }, document.body);
    expect(h.current.tree.name).toBe('a');
  });

  it('a modal opened over the tour still blocks it', () => {
    const h = renderHistory(t('0'));
    editApart(h, t('a'));
    mount(<FirstRunTour onSetTab={() => {}} onClose={() => {}} />);
    mount(<Modal label="Unsaved changes" onClose={() => {}}><button>Cancel</button></Modal>);
    key('z', { ctrl: true }, document.body);
    expect(h.current.tree.name).toBe('a');
  });

  it('refuses undo and redo, keys and buttons alike, while blocked()', () => {
    let busy = true;
    const h = renderHistory(t('0'), { blocked: () => busy });
    editApart(h, t('a'));
    key('z');
    act(() => h.current.undo());
    expect(h.current.tree.name).toBe('a');
    busy = false;
    act(() => h.current.undo());
    expect(h.current.tree.name).toBe('0');
    busy = true;
    act(() => h.current.redo());
    expect(h.current.tree.name).toBe('0');
  });
});
