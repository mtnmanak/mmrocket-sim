import { useCallback, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { clickable } from './clickable.js';
import type { ComponentNode, ComponentType, RocketTree } from '@online-openrocket/engine';
import { allowedChildren, DISPLAY_NAME } from '../tree/schema.js';
import { Icon } from './Icon.js';
import { findParent, stageIndexOf } from '../tree/treeModel.js';

const TYPE_ICON: Partial<Record<ComponentType, string>> = {
  stage: '▤',
  nosecone: '▲', transition: '◣', bodytube: '▭',
  trapezoidfinset: '◢', ellipticalfinset: '◠', freeformfinset: '⟁', tubefinset: '◎',
  innertube: '▢', tubecoupler: '▣', centeringring: '◌', bulkhead: '●', engineblock: '▪',
  launchlug: '⌐', railbutton: '•',
  parachute: '☂', streamer: '≋', shockcord: '〜', masscomponent: '◆',
  fairing: '⌂',
};

function NodeRow({ node, depth, selectedId, soleStageId, rove, onSelect, onMove, onDelete, onDuplicate, onCopy, onCut }: {
  node: ComponentNode;
  depth: number;
  selectedId: string | null;
  /**
   * Roving tabindex + arrow keys for one row (2026-09-08 audit).
   *
   * `role="tree"` is a PROMISE: it puts NVDA and JAWS into application mode
   * inside the widget, where Up/Down are expected to move between items — and
   * here they did nothing at all, while `clickable()` gave every row its own tab
   * stop, so a 40-part rocket cost 40 tab presses to walk past. Both halves of
   * that are fixed by the same thing: exactly one row is tabbable at a time, and
   * the arrows move which.
   */
  rove: (id: string) => { tabIndex: number; onKeyDown: (e: ReactKeyboardEvent) => void };
  /** The only stage's id when exactly one stage exists — it can't be deleted. */
  soleStageId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onCopy: (id: string) => void;
  onCut: (id: string) => void;
}) {
  const selected = node.id === selectedId;
  const label = node.name ?? DISPLAY_NAME[node.type];
  return (
    <>
      {/* role="treeitem": `aria-selected` has no defined meaning on a bare
          <div>, so the selection this row spends a CSS class advertising was
          invisible to assistive tech. The rows are a flattened tree — every
          level is always shown — so aria-level carries the nesting the
          indentation shows, and aria-expanded is stated only where there is
          something to expand. The `.tree-box` wrapper below is role="tree". */}
      <div
        className={`tree-row ${selected ? 'tree-row-selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected}
        {...(node.children?.length ? { 'aria-expanded': true } : {})}
        {...rove(node.id!)}
      >
        <span className="tree-icon">{TYPE_ICON[node.type] ?? '·'}</span>
        <span className="tree-label">{label}</span>
        {node.type === 'stage' && <span className="tree-badge">stage</span>}
        {node['motorMount'] === true && <span className="tree-badge">motor</span>}
        {selected && (
          // Each aria-label names the COMPONENT as well as the action: the six
          // buttons repeat on every selected row, and a glyph alone announced
          // as "scissors button" / "multiplication sign button" gave no way to
          // tell Cut from Delete before pressing one — and Delete removes a
          // component. `title` cannot do this job: name-from-content wins over
          // it, so the glyph WAS the accessible name.
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            <button title="Move up" aria-label={`Move ${label} up`}
              onClick={() => onMove(node.id!, -1)}>↑</button>
            <button title="Move down" aria-label={`Move ${label} down`}
              onClick={() => onMove(node.id!, 1)}>↓</button>
            <button title="Duplicate (deep copy)" aria-label={`Duplicate ${label}`}
              onClick={() => onDuplicate(node.id!)}>⧉</button>
            {node.type !== 'stage' && (
              <>
                <button title="Copy — then paste into another component"
                  aria-label={`Copy ${label}`} onClick={() => onCopy(node.id!)}>⎘</button>
                <button title="Cut — then paste into another component"
                  aria-label={`Cut ${label}`} onClick={() => onCut(node.id!)}>✂</button>
              </>
            )}
            {node.id !== soleStageId && (
              <button title="Delete" aria-label={`Delete ${label}`}
                onClick={() => onDelete(node.id!)}>✕</button>
            )}
          </span>
        )}
      </div>
      {(node.children ?? []).map((c) => (
        <NodeRow key={c.id} node={c} depth={depth + 1} selectedId={selectedId} soleStageId={soleStageId} rove={rove}
          onSelect={onSelect} onMove={onMove} onDelete={onDelete} onDuplicate={onDuplicate}
          onCopy={onCopy} onCut={onCut} />
      ))}
    </>
  );
}

export function ComponentTree({
  tree, selectedId, onSelect, onMove, onDelete, onDuplicate, onAdd, onAddStage,
  clipboard, onCopy, onCut, onPaste,
}: {
  tree: RocketTree;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onAdd: (parentId: string | 'stage', type: ComponentType) => void;
  /** Appends a booster stage below the existing ones. */
  onAddStage: () => void;
  /** Copied/cut component awaiting paste (null = empty clipboard). */
  clipboard: ComponentNode | null;
  onCopy: (id: string) => void;
  onCut: (id: string) => void;
  /** Pastes the clipboard as a child of the given parent. */
  onPaste: (parentId: string) => void;
}) {
  // Which add menu is open, keyed by the target parent's id ('stage' = first stage).
  const [addOpen, setAddOpen] = useState<string | null>(null);

  const selectedNode = selectedId
    ? (function find(nodes: ComponentNode[]): ComponentNode | null {
        for (const n of nodes) {
          if (n.id === selectedId) return n;
          const hit = find(n.children ?? []);
          if (hit) return hit;
        }
        return null;
      })(tree.components)
    : null;

  /**
   * Every place the current selection can add INTO: the selected component
   * itself (when it holds children), its immediate parent, and its enclosing
   * stage — e.g. a selected nose cone offers "Add to Nose cone" AND
   * "Add to Sustainer".
   */
  interface AddTarget { id: string | 'stage'; label: string; types: ComponentType[] }
  const targets: AddTarget[] = [];
  if (selectedNode) {
    const selAddable = allowedChildren(selectedNode.type);
    if (selAddable.length > 0) {
      targets.push({
        id: selectedNode.id!,
        label: selectedNode.name ?? DISPLAY_NAME[selectedNode.type],
        types: selAddable,
      });
    }
    if (selectedNode.type !== 'stage') {
      const parent = findParent(tree, selectedNode.id!);
      if (parent && parent !== 'stage' && parent.type !== 'stage' && parent.id) {
        targets.push({
          id: parent.id,
          label: parent.name ?? DISPLAY_NAME[parent.type],
          types: allowedChildren(parent.type),
        });
      }
      const stage = tree.components[stageIndexOf(tree, selectedNode.id!)];
      if (stage?.id) {
        targets.push({
          id: stage.id,
          label: stage.name ?? 'Stage',
          types: allowedChildren('stage'),
        });
      }
    }
  } else {
    targets.push({ id: 'stage', label: '', types: allowedChildren('stage') });
  }

  const menu = (list: ComponentType[], parentId: string | 'stage') => (
    <div className="add-menu">
      {list.map((t) => (
        <button key={t} className="add-menu-item"
          onClick={() => {
            onAdd(parentId, t);
            setAddOpen(null);
          }}>
          {TYPE_ICON[t] ?? '·'} {DISPLAY_NAME[t]}
        </button>
      ))}
    </div>
  );

  /** The tree container, so arrow navigation can move focus with the selection. */
  const boxRef = useRef<HTMLDivElement | null>(null);
  /**
   * The rows in the order they are DRAWN, root first — the order the arrows
   * move through. Every level is always shown (the rows are a flattened tree,
   * see NodeRow's comment), so screen order is document order and there is no
   * expand/collapse state to fold in.
   */
  const rowOrder = useMemo(() => {
    const out: string[] = [''];
    const walk = (ns: readonly ComponentNode[]): void => {
      for (const n of ns) {
        if (n.id) out.push(n.id);
        if (n.children?.length) walk(n.children);
      }
    };
    walk(tree.components);
    return out;
  }, [tree]);

  /**
   * Roving tabindex + arrow navigation — the contract `role="tree"` makes.
   *
   * ONE row is tabbable: the selected one, or the root when the selection is
   * not in the tree. Arrow Up/Down move the selection (and therefore the tab
   * stop) by one; Home/End jump to the ends. Left/Right are deliberately NOT
   * bound: this is a flat always-expanded list, so there is nothing to collapse
   * and nothing a parent jump would reveal.
   *
   * Selecting on arrow rather than only on Enter is right here because
   * selection is what the widget is FOR — it drives the property panel, and a
   * keyboard user moving through the rows wants the same thing a mouse user
   * clicking them wants.
   */
  const rove = useCallback((id: string) => {
    const current = rowOrder.includes(selectedId ?? '') ? (selectedId ?? '') : '';
    // clickable()'s Enter/Space activation is COMPOSED here, not spread
    // alongside: two spreads both defining onKeyDown means the second silently
    // wins, and the first attempt at this shipped arrows by deleting Enter.
    const base = clickable(() => onSelect(id));
    return {
      ...base,
      tabIndex: id === current ? 0 : -1,
      onKeyDown: (e: ReactKeyboardEvent) => {
        // Keys aimed at a control inside the row (its own action buttons) are
        // that control's business — the same rule clickable() applies.
        if (e.target !== e.currentTarget) return;
        const i = rowOrder.indexOf(id);
        if (i < 0) return;
        let next: number | null = null;
        if (e.key === 'ArrowDown') next = Math.min(i + 1, rowOrder.length - 1);
        else if (e.key === 'ArrowUp') next = Math.max(i - 1, 0);
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = rowOrder.length - 1;
        if (next === null) {
          // Not an arrow — let Enter/Space activate the row.
          base.onKeyDown(e);
          return;
        }
        e.preventDefault();
        const id2 = rowOrder[next]!;
        onSelect(id2);
        // Move focus with the selection, or the tab stop and the focus ring
        // part company and the next arrow press comes from the old row.
        const box = boxRef.current;
        if (box) {
          const rows = box.querySelectorAll<HTMLElement>('[role="treeitem"]');
          rows[next]?.focus();
        }
      },
    };
  }, [rowOrder, selectedId, onSelect]);

  return (
    <div>
      <div className="tree-box" role="tree" aria-label="Rocket components" ref={boxRef}>
        {/* The root row was a bare onClick div — no tab stop, no key handler —
            while every other row went through clickable(). Selecting the root
            is the ONLY way to reach the rocket-level property panel, so that
            panel was unreachable without a mouse. */}
        <div className="tree-row tree-row-root"
          role="treeitem" aria-level={1} aria-selected={selectedId === ''}
          aria-expanded={tree.components.length > 0}
          {...rove('')}>
          <span className="tree-icon"><Icon name="rocket" size={12} /></span>
          <span className="tree-label">{tree.name ?? 'Rocket'}</span>
        </div>
        {tree.components.map((n) => (
          <NodeRow key={n.id} node={n} depth={1} selectedId={selectedId} rove={rove}
            soleStageId={tree.components.length === 1 ? tree.components[0]!.id ?? null : null}
            onSelect={onSelect} onMove={onMove} onDelete={onDelete} onDuplicate={onDuplicate}
            onCopy={onCopy} onCut={onCut} />
        ))}
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {targets.map((t) => (
          <button key={t.id} className="file-btn"
            onClick={() => setAddOpen(addOpen === t.id ? null : t.id)}>
            {t.label ? `+ Add to ${t.label}` : '+ Add component'}
          </button>
        ))}
        <button className="file-btn" title="Add a booster stage below the current ones"
          onClick={() => { setAddOpen(null); onAddStage(); }}>
          + Add stage
        </button>
        {/* Paste appears only where the clipboard's type is a legal child —
            real cut/copy/paste across parents (issue 2026-08-05a #19). */}
        {clipboard && targets
          .filter((t) => t.id !== 'stage' && t.types.includes(clipboard.type))
          .map((t) => (
            <button key={`paste-${t.id}`} className="file-btn"
              title={`Paste ${clipboard.name ?? DISPLAY_NAME[clipboard.type]} into ${t.label}`}
              onClick={() => { setAddOpen(null); onPaste(t.id as string); }}>
              ⎗ Paste into {t.label}
            </button>
          ))}
      </div>
      {clipboard && (
        <p className="comp-stats" style={{ margin: '6px 0 0' }}>
          Clipboard: {TYPE_ICON[clipboard.type] ?? '·'} {clipboard.name ?? DISPLAY_NAME[clipboard.type]}
          {' '}— select a destination component, then Paste.
        </p>
      )}
      {(() => {
        const open = targets.find((t) => t.id === addOpen);
        return open ? menu(open.types, open.id) : null;
      })()}
    </div>
  );
}
