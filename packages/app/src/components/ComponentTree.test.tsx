// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { ComponentTree } from './ComponentTree.js';
import { duplicateNode, moveNode, removeNode } from '../tree/treeModel.js';

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

/**
 * `role="tree"` is a PROMISE, not a label. It puts NVDA and JAWS into
 * application mode inside the widget, where Up/Down are expected to move
 * between items — and they did nothing at all, while `clickable()` gave every
 * row its own tab stop, so a 40-part rocket cost 40 tab presses to walk past
 * (2026-09-08 audit). Both halves are the same fix.
 */
describe('the tree keeps the keyboard contract its role promises', () => {
  const rows = (): HTMLElement[] =>
    [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
  const key = (el: HTMLElement, k: string) => {
    act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
  };

  it('makes exactly ONE row tabbable, and it is the selected one', () => {
    show('b1');
    const tabbable = rows().filter((r) => r.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(tabbable[0]!.textContent).toContain('Airframe');
    // Every other row is reachable by arrow, not by Tab.
    expect(rows().filter((r) => r.tabIndex === -1).length).toBe(rows().length - 1);
  });

  it('falls back to the root row when the selection is not in the tree', () => {
    show(null);
    expect(rootRow().tabIndex).toBe(0);
    expect(rows().filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it('moves the selection down and up with the arrow keys', () => {
    show('');
    // Draw order is root, stage, nose, tube.
    key(rootRow(), 'ArrowDown');
    expect(selected.at(-1)).toBe('s1');
    show('s1');
    key(rows()[1]!, 'ArrowDown');
    expect(selected.at(-1)).toBe('n1');
    show('n1');
    key(rows()[2]!, 'ArrowUp');
    expect(selected.at(-1)).toBe('s1');
  });

  it('jumps to the ends with Home and End', () => {
    show('n1');
    key(rows()[2]!, 'End');
    expect(selected.at(-1)).toBe('b1');
    show('n1');
    key(rows()[2]!, 'Home');
    expect(selected.at(-1)).toBe('');
  });

  it('does not run off either end', () => {
    show('');
    key(rootRow(), 'ArrowUp');
    expect(selected.at(-1)).toBe('');
    show('b1');
    key(rows()[3]!, 'ArrowDown');
    expect(selected.at(-1)).toBe('b1');
  });

  it('still activates on Enter and Space — the arrows were added, not swapped in', () => {
    // The first attempt at this spread rove() over clickable(), so the second
    // onKeyDown silently won and Enter stopped working. The handlers are
    // composed now, and this is the assertion that caught it.
    show('n1');
    key(rows()[2]!, 'Enter');
    key(rows()[2]!, ' ');
    expect(selected.slice(-2)).toEqual(['n1', 'n1']);
  });
});

/**
 * Audit 2026-09-22, row 457. Move down, Delete, Cut (and Duplicate, which
 * moves the selection to the new copy and so unmounts the old row's buttons)
 * dropped focus to <body>: the button pressed was re-inserted or removed, and
 * nothing put focus anywhere. And the selected row's name was every action
 * label run together, because a treeitem is named from its content.
 */
describe('structural actions keep the keyboard in the tree', () => {
  function Harness() {
    const [tree, setTree] = useState(TREE);
    const [sel, setSel] = useState<string | null>('n1');
    return (
      <>
        <button id="before">before</button>
        <ComponentTree
          tree={tree}
          selectedId={sel}
          onSelect={(id) => setSel(id)}
          onMove={(id, dir) => setTree(moveNode(tree, id, dir))}
          onDelete={(id) => { setTree(removeNode(tree, id)); if (sel === id) setSel(null); }}
          onDuplicate={(id) => {
            const { tree: next, newId } = duplicateNode(tree, id);
            setTree(next);
            if (newId) setSel(newId);
          }}
          onAdd={() => {}}
          onAddStage={() => {}}
          clipboard={null}
          onCopy={() => {}}
          onCut={(id) => { setTree(removeNode(tree, id)); if (sel === id) setSel(null); }}
          onPaste={() => {}}
        />
      </>
    );
  }
  const action = (name: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.tree-actions button')]
      .find((b) => b.getAttribute('aria-label') === name)!;
  const press = (b: HTMLButtonElement) => {
    act(() => { b.focus(); });
    act(() => { b.click(); });
  };
  const labels = () => [...host.querySelectorAll('.tree-row .tree-label')].map((l) => l.textContent);

  // A browser runs the HTML "focus fixup" when a focused node is MOVED (an
  // insertBefore of a connected node is a remove and an insert) and focus
  // falls to <body>; happy-dom keeps it on the moved node. Emulate the
  // browser, or the Move-down case would pass whether or not it was fixed.
  const realInsertBefore = Node.prototype.insertBefore;
  const realAppendChild = Node.prototype.appendChild;
  const blurIfMoving = (node: Node) => {
    const active = document.activeElement;
    if (node.isConnected && active instanceof HTMLElement && node.contains(active)) active.blur();
  };
  beforeEach(() => {
    Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, child: Node | null): T {
      blurIfMoving(node);
      return realInsertBefore.call(this, node, child) as T;
    };
    Node.prototype.appendChild = function <T extends Node>(this: Node, node: T): T {
      blurIfMoving(node);
      return realAppendChild.call(this, node) as T;
    };
  });
  afterEach(() => {
    Node.prototype.insertBefore = realInsertBefore;
    Node.prototype.appendChild = realAppendChild;
  });

  it('Move down keeps focus on the moved row\'s Move-down button', () => {
    act(() => root.render(<Harness />));
    press(action('Move Nose down'));
    expect(labels()).toEqual(['Zephyr', 'Sustainer', 'Airframe', 'Nose']);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move Nose down');
  });

  it('Move up keeps it too', () => {
    act(() => root.render(<Harness />));
    press(action('Move Nose down'));
    press(action('Move Nose up'));
    expect(labels()).toEqual(['Zephyr', 'Sustainer', 'Nose', 'Airframe']);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Move Nose up');
  });

  it('Delete and Cut land on the tree\'s tab stop, not <body>', () => {
    act(() => root.render(<Harness />));
    press(action('Delete Nose'));
    expect(labels()).not.toContain('Nose');
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute('role')).toBe('treeitem');
    expect((document.activeElement as HTMLElement).tabIndex).toBe(0);

    act(() => { (host.querySelectorAll<HTMLElement>('.tree-row')[2]!).click(); }); // Airframe
    press(action('Cut Airframe'));
    expect(labels()).not.toContain('Airframe');
    expect(document.activeElement?.getAttribute('role')).toBe('treeitem');
  });

  it('Duplicate lands on the new copy\'s row', () => {
    act(() => root.render(<Harness />));
    press(action('Duplicate Nose'));
    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute('role')).toBe('treeitem');
    expect(active.getAttribute('aria-selected')).toBe('true');
    expect(active.querySelector('.tree-label')!.textContent).toMatch(/Nose/);
  });

  it('names the selected row by its label and badges, not its buttons', () => {
    show('n1');
    const row = host.querySelectorAll<HTMLElement>('.tree-row')[2]!;
    const ids = (row.getAttribute('aria-labelledby') ?? '').split(' ').filter(Boolean);
    expect(ids.length).toBeGreaterThan(0);
    const name = ids.map((id) => document.getElementById(id)?.textContent).join(' ');
    expect(name).toBe('Nose');
    show('s1');
    const stage = host.querySelectorAll<HTMLElement>('.tree-row')[1]!;
    expect((stage.getAttribute('aria-labelledby') ?? '').split(' ')
      .map((id) => document.getElementById(id)?.textContent).join(' ')).toBe('Sustainer stage');
  });
});

describe('the Add buttons are disclosures (audit 2026-09-22, row 462)', () => {
  it('say whether their menu is open', () => {
    show('b1');
    const add = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent === '+ Add to Airframe')!;
    expect(add.getAttribute('aria-expanded')).toBe('false');
    act(() => { add.click(); });
    expect(add.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.add-menu')).not.toBeNull();
  });
});
