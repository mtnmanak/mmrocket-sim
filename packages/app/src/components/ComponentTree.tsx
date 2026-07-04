import { useState } from 'react';
import type { ComponentNode, ComponentType, RocketTree } from '@online-openrocket/engine';
import { allowedChildren, DISPLAY_NAME } from '../tree/schema.js';

const TYPE_ICON: Partial<Record<ComponentType, string>> = {
  stage: '▤',
  nosecone: '▲', transition: '◣', bodytube: '▭',
  trapezoidfinset: '◢', ellipticalfinset: '◠', freeformfinset: '⟁', tubefinset: '◎',
  innertube: '▢', tubecoupler: '▣', centeringring: '◌', bulkhead: '●', engineblock: '▪',
  launchlug: '⌐', railbutton: '•',
  parachute: '☂', streamer: '≋', shockcord: '〜', masscomponent: '◆',
};

function NodeRow({ node, depth, selectedId, onSelect, onMove, onDelete, onDuplicate }: {
  node: ComponentNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
}) {
  const selected = node.id === selectedId;
  return (
    <>
      <div
        className={`tree-row ${selected ? 'tree-row-selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => onSelect(node.id!)}
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
            <button title="Delete" onClick={() => onDelete(node.id!)}>✕</button>
          </span>
        )}
      </div>
      {(node.children ?? []).map((c) => (
        <NodeRow key={c.id} node={c} depth={depth + 1} selectedId={selectedId}
          onSelect={onSelect} onMove={onMove} onDelete={onDelete} onDuplicate={onDuplicate} />
      ))}
    </>
  );
}

export function ComponentTree({ tree, selectedId, onSelect, onMove, onDelete, onDuplicate, onAdd, onAddStage }: {
  tree: RocketTree;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onAdd: (parentId: string | 'stage', type: ComponentType) => void;
  /** Appends a booster stage below the existing ones. */
  onAddStage: () => void;
}) {
  // Which add menu is open: the selected component's, or the rocket's.
  const [addOpen, setAddOpen] = useState<'selected' | 'rocket' | null>(null);

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
  const selType: ComponentType | 'stage' = selectedNode?.type ?? 'stage';
  const selAddable = selectedNode ? allowedChildren(selType) : [];
  const rocketAddable = allowedChildren('stage');
  const selLabel = selectedNode?.name
    ?? (selType !== 'stage' ? DISPLAY_NAME[selType as ComponentType] : '');

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
          <span className="tree-icon">🚀</span>
          <span className="tree-label">{tree.name ?? 'Rocket'}</span>
        </div>
        {tree.components.map((n) => (
          <NodeRow key={n.id} node={n} depth={1} selectedId={selectedId}
            onSelect={onSelect} onMove={onMove} onDelete={onDelete} onDuplicate={onDuplicate} />
        ))}
      </div>

      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {selAddable.length > 0 && (
          <button className="file-btn"
            onClick={() => setAddOpen(addOpen === 'selected' ? null : 'selected')}>
            + Add to {selLabel}
          </button>
        )}
        {(selAddable.length === 0 || selectedNode?.type === 'stage') && (
          <button className="file-btn"
            onClick={() => setAddOpen(addOpen === 'rocket' ? null : 'rocket')}>
            + Add component
          </button>
        )}
        <button className="file-btn" title="Add a booster stage below the current ones"
          onClick={() => { setAddOpen(null); onAddStage(); }}>
          + Add stage
        </button>
      </div>
      {addOpen === 'selected' && selectedNode && menu(selAddable, selectedNode.id!)}
      {addOpen === 'rocket' && menu(rocketAddable, 'stage')}
    </div>
  );
}
