// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { ComponentTree } from './ComponentTree.js';

/**
 * The component tree is the ONLY complete list of what a design contains, and
 * the only way to reach the rocket-level property panel. Two things were
 * mouse-only or unnamed in it, and both are pinned here.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let selected: string[];

const TREE = {
  name: 'Zephyr',
  components: [{
    id: 's1', type: 'stage', name: 'Sustainer',
    children: [
      { id: 'n1', type: 'nosecone', name: 'Nose', length: 0.1, aftRadius: 0.012 },
      { id: 'b1', type: 'bodytube', name: 'Airframe', length: 0.3, outerRadius: 0.012 },
    ],
  }],
} as unknown as RocketTree;

const show = (selectedId: string | null) => act(() => root.render(
  <ComponentTree
    tree={TREE}
    selectedId={selectedId}
    onSelect={(id) => selected.push(id)}
    onMove={() => {}}
    onDelete={() => {}}
    onDuplicate={() => {}}
    onAdd={() => {}}
    onAddStage={() => {}}
    clipboard={null}
    onCopy={() => {}}
    onCut={() => {}}
    onPaste={() => {}}
  />,
));

beforeEach(() => {
  selected = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const rootRow = () => host.querySelector('.tree-row-root') as HTMLElement;

describe('the root "Rocket" row', () => {
  it('is a tab stop and activates on Enter and on Space', () => {
    // It was a bare onClick <div>: no tabIndex, no key handler. Selecting the
    // root is the only route to the rocket-level property panel, so that panel
    // was unreachable without a mouse while every other row went through
    // clickable().
    show(null);
    expect(rootRow().tabIndex).toBe(0);

    act(() => { rootRow().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    act(() => { rootRow().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
    expect(selected).toEqual(['', '']);
  });

  it('still selects on click, and shows the rocket name', () => {
    show(null);
    act(() => { rootRow().click(); });
    expect(selected).toEqual(['']);
    expect(rootRow().textContent).toContain('Zephyr');
  });

  it('reports its own selected state, which only a role makes meaningful', () => {
    show('');
    expect(rootRow().getAttribute('role')).toBe('treeitem');
    expect(rootRow().getAttribute('aria-selected')).toBe('true');
    show('n1');
    expect(rootRow().getAttribute('aria-selected')).toBe('false');
  });
});

describe('roles make aria-selected legal', () => {
  it('wraps the rows in a tree and levels them by depth', () => {
    show('n1');
    expect(host.querySelector('.tree-box')!.getAttribute('role')).toBe('tree');
    const rows = [...host.querySelectorAll('.tree-row')] as HTMLElement[];
    expect(rows.every((r) => r.getAttribute('role') === 'treeitem')).toBe(true);
    // root, stage, nose, tube — the indentation the CSS draws, stated.
    expect(rows.map((r) => r.getAttribute('aria-level'))).toEqual(['1', '2', '3', '3']);
  });
});

describe('the per-row action buttons', () => {
  it('name the action AND the component, not the glyph', () => {
    // `title` is not an accessible name: name-from-content wins, so these six
    // announced as "up arrow button", "scissors button", "multiplication sign
    // button"… with no way to tell Cut from Delete before pressing one.
    show('n1');
    const names = [...host.querySelectorAll('.tree-actions button')]
      .map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual([
      'Move Nose up', 'Move Nose down', 'Duplicate Nose', 'Copy Nose', 'Cut Nose', 'Delete Nose',
    ]);
    // The tooltips stay — they are what a mouse user reads.
    expect([...host.querySelectorAll('.tree-actions button')]
      .every((b) => (b.getAttribute('title') ?? '').length > 0)).toBe(true);
  });

  it('offers no Copy/Cut on a stage, and no Delete on the only stage', () => {
    show('s1');
    const names = [...host.querySelectorAll('.tree-actions button')]
      .map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Move Sustainer up', 'Move Sustainer down', 'Duplicate Sustainer']);
  });
});
