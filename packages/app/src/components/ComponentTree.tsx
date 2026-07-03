import { useState } from 'react';
import type { ComponentNode, ComponentType, RocketTree } from '@online-openrocket/engine';
import { allowedChildren, DISPLAY_NAME } from '../tree/schema.js';

const TYPE_ICON: Partial<Record<ComponentType, string>> = {
  nosecone: '▲', transition: '◣', bodytube: '▭',
  trapezoidfinset: '◢', ellipticalfinset: '◠', tubefinset: '◎',
  innertube: '▢', tubecoupler: '▣', centeringring: '◌', bulkhead: '●', engineblock: '▪',
  launchlug: '⌐', railbutton: '•',
  parachute: '☂', streamer: '≋', shockcord: '〜', masscomponent: '◆',
};

function NodeRow({ node, depth, selectedId, onSelect, onMove, onDelete }: {
  node: ComponentNode;
  depth: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDelete: (id: string) => void;
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
        {node['motorMount'] === true && <span className="tree-badge">motor</span>}
        {selected && (
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            <button title="Move up" onClick={() => onMove(node.id!, -1)}>↑</button>
            <button title="Move down" onClick={() => onMove(node.id!, 1)}>↓</button>
            <button title="Delete" onClick={() => onDelete(node.id!)}>✕</button>
          </span>
        )}
      </div>
      {(node.children ?? []).map((c) => (
        <NodeRow key={c.id} node={c} depth={depth + 1} selectedId={selectedId}
          onSelect={onSelect} onMove={onMove} onDelete={onDelete} />
      ))}
    </>
  );
}

export function ComponentTree({ tree, selectedId, onSelect, onMove, onDelete, onAdd }: {
  tree: RocketTree;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDelete: (id: string) => void;
  onAdd: (parentId: string | 'stage', type: ComponentType) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);

  // Adding targets the selected node if it can hold children, else the stage.
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
  const targetType: ComponentType | 'stage' = selectedNode?.type ?? 'stage';
  const addable = allowedChildren(targetType);
  const fallbackAddable = allowedChildren('stage');
  const effectiveTarget = addable.length ? targetType : 'stage';
  const effectiveList = addable.length ? addable : fallbackAddable;
  const targetLabel = effectiveTarget === 'stage'
    ? 'rocket'
    : (selectedNode?.name ?? DISPLAY_NAME[effectiveTarget as ComponentType]);

  return (
    <div>
      <div className="tree-box">
        <div className="tree-row tree-row-root" onClick={() => onSelect('')}>
          <span className="tree-icon">🚀</span>
          <span className="tree-label">{tree.name ?? 'Rocket'}</span>
        </div>
        {tree.components.map((n) => (
          <NodeRow key={n.id} node={n} depth={1} selectedId={selectedId}
            onSelect={onSelect} onMove={onMove} onDelete={onDelete} />
        ))}
      </div>

      <div style={{ marginTop: 8 }}>
        <button className="file-btn" onClick={() => setAddOpen(!addOpen)}>
          + Add component to {targetLabel}
        </button>
        {addOpen && (
          <div className="add-menu">
            {effectiveList.map((t) => (
              <button key={t} className="add-menu-item"
                onClick={() => {
                  onAdd(effectiveTarget === 'stage' ? 'stage' : selectedNode!.id!, t);
                  setAddOpen(false);
                }}>
                {TYPE_ICON[t] ?? '·'} {DISPLAY_NAME[t]}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
