import { useState } from 'react';
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

function NodeRow({ node, depth, selectedId, soleStageId, onSelect, onMove, onDelete, onDuplicate, onCopy, onCut }: {
  node: ComponentNode;
  depth: number;
  selectedId: string | null;
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
  return (
    <>
      <div
        className={`tree-row ${selected ? 'tree-row-selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        aria-selected={selected}
        {...clickable(() => onSelect(node.id!))}
      >
        <span className="tree-icon">{TYPE_ICON[node.type] ?? '·'}</span>
        <span className="tree-label">{node.name ?? DISPLAY_NAME[node.type]}</span>
        {node.type === 'stage' && <span className="tree-badge">stage</span>}
        {node['motorMount'] === true && <span className="tree-badge">motor</span>}
        {selected && (
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            <button title="Move up" onClick={() => onMove(node.id!, -1)}>↑</button>
            <button title="Move down" onClick={() => onMove(node.id!, 1)}>↓</button>
            <button title="Duplicate (deep copy)" onClick={() => onDuplicate(node.id!)}>⧉</button>
            {node.type !== 'stage' && (
              <>
                <button title="Copy — then paste into another component" onClick={() => onCopy(node.id!)}>⎘</button>
                <button title="Cut — then paste into another component" onClick={() => onCut(node.id!)}>✂</button>
              </>
            )}
            {node.id !== soleStageId && (
              <button title="Delete" onClick={() => onDelete(node.id!)}>✕</button>
            )}
          </span>
        )}
      </div>
      {(node.children ?? []).map((c) => (
        <NodeRow key={c.id} node={c} depth={depth + 1} selectedId={selectedId} soleStageId={soleStageId}
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

  return (
    <div>
      <div className="tree-box">
        <div className="tree-row tree-row-root" onClick={() => onSelect('')}>
          <span className="tree-icon"><Icon name="rocket" size={12} /></span>
          <span className="tree-label">{tree.name ?? 'Rocket'}</span>
        </div>
        {tree.components.map((n) => (
          <NodeRow key={n.id} node={n} depth={1} selectedId={selectedId}
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
