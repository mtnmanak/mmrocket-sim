import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { DISPLAY_NAME, FIELDS, POSITIONABLE, type FieldDef } from '../tree/schema.js';
import { findParent } from '../tree/treeModel.js';

/** UI-unit <-> SI conversion at the boundary. */
function toUi(unit: FieldDef['unit'], si: number): number {
  switch (unit) {
    case 'mm': return si * 1000;
    case 'deg': return (si * 180) / Math.PI;
    case 'g': return si * 1000;
    default: return si;
  }
}

function toSi(unit: FieldDef['unit'], ui: number): number {
  switch (unit) {
    case 'mm': return ui / 1000;
    case 'deg': return (ui * Math.PI) / 180;
    case 'g': return ui / 1000;
    default: return ui;
  }
}

const UNIT_LABEL: Record<FieldDef['unit'], string> = {
  mm: 'mm', deg: '°', g: 'g', count: '', 'kg/m3': 'kg/m³', none: '',
};

export function PropertyPanel({ tree, node, onPatch }: {
  tree: RocketTree;
  node: ComponentNode;
  onPatch: (patch: Partial<ComponentNode>) => void;
}) {
  const fields = FIELDS[node.type] ?? [];
  const positionable = POSITIONABLE.has(node.type) && findParent(tree, node.id!) !== 'stage';
  const pos = (node.position ?? { method: 'top', offset: 0 }) as ComponentPosition;

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <h2>{DISPLAY_NAME[node.type]}</h2>
      <div className="field">
        <label>Name</label>
        <input value={node.name ?? ''} onChange={(e) => onPatch({ name: e.target.value })} />
      </div>
      <div className="field-grid" style={{ marginTop: 8 }}>
        {fields.map((f) => {
          if (f.options) {
            return (
              <div className="field" key={f.key}>
                <label>{f.label}</label>
                <select
                  value={String(node[f.key] ?? f.options[0]![0])}
                  onChange={(e) => onPatch({ [f.key]: e.target.value })}
                >
                  {f.options.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
            );
          }
          const raw = node[f.key];
          const value = typeof raw === 'number' ? toUi(f.unit, raw) : '';
          return (
            <div className="field" key={f.key}>
              <label>{f.label}{UNIT_LABEL[f.unit] && ` (${UNIT_LABEL[f.unit]})`}</label>
              <input
                type="number"
                step={f.step ?? 1}
                value={value === '' ? '' : Number(value.toFixed(6))}
                onChange={(e) => {
                  if (e.target.value === '') {
                    onPatch({ [f.key]: undefined });
                    return;
                  }
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) {
                    onPatch({ [f.key]: f.unit === 'count' ? Math.max(1, Math.round(v)) : toSi(f.unit, v) });
                  }
                }}
              />
            </div>
          );
        })}
      </div>

      {node.type === 'innertube' && (
        <div className="field" style={{ marginTop: 8 }}>
          <label>
            <input
              type="checkbox"
              checked={node['motorMount'] === true}
              onChange={(e) => onPatch({ motorMount: e.target.checked })}
              style={{ width: 'auto', marginRight: 6 }}
            />
            Acts as motor mount
          </label>
        </div>
      )}

      {positionable && (
        <div style={{ marginTop: 10 }}>
          <h2>Position (in parent)</h2>
          <div className="field-grid">
            <div className="field">
              <label>Relative to</label>
              <select
                value={pos.method}
                onChange={(e) =>
                  onPatch({ position: { ...pos, method: e.target.value as ComponentPosition['method'] } })}
              >
                <option value="top">Top of parent</option>
                <option value="middle">Middle of parent</option>
                <option value="bottom">Bottom of parent</option>
              </select>
            </div>
            <div className="field">
              <label>Offset (mm)</label>
              <input
                type="number"
                step={1}
                value={Number((pos.offset * 1000).toFixed(6))}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) onPatch({ position: { ...pos, offset: v / 1000 } });
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
