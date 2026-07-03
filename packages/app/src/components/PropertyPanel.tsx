import { useRef } from 'react';
import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { FinPointsEditor, type FinPoint } from './FinPointsEditor.js';
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
  mm: 'mm', m: 'm', s: 's', deg: '°', g: 'g', count: '', 'kg/m3': 'kg/m³', none: '',
};

/**
 * Slider synced with a numeric value (UI units). The range grows to include
 * an out-of-range typed value, and is frozen for the duration of a drag so
 * the handle doesn't chase its own updates.
 */
function ValueSlider({ value, min, max, step, onChange }: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (ui: number) => void;
}) {
  const drag = useRef<{ min: number; max: number } | null>(null);
  const range = drag.current ?? {
    min: Math.min(min, value),
    max: Math.max(max, value),
  };
  return (
    <input
      type="range"
      className="field-slider"
      min={range.min}
      max={range.max}
      step={step}
      value={value}
      onPointerDown={() => { drag.current = range; }}
      onPointerUp={() => { drag.current = null; }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

export function PropertyPanel({ tree, node, onPatch }: {
  tree: RocketTree;
  node: ComponentNode;
  onPatch: (patch: Partial<ComponentNode>) => void;
}) {
  const fields = FIELDS[node.type] ?? [];
  const parent = findParent(tree, node.id!);
  const positionable = POSITIONABLE.has(node.type) && parent !== 'stage';
  const pos = (node.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
  const parentLenMm = parent && parent !== 'stage' && typeof parent['length'] === 'number'
    ? parent['length'] * 1000
    : 200;

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <h2>{DISPLAY_NAME[node.type]}</h2>
      <div className="field">
        <label>Name</label>
        <input value={node.name ?? ''} onChange={(e) => onPatch({ name: e.target.value })} />
      </div>
      <div className="field-grid" style={{ marginTop: 8 }}>
        {fields.map((f) => {
          if (f.bool) {
            return (
              <div className="field" key={f.key} style={{ justifyContent: 'flex-end' }}>
                <label>
                  <input
                    type="checkbox"
                    checked={node[f.key] === true}
                    onChange={(e) => onPatch({ [f.key]: e.target.checked })}
                    style={{ width: 'auto', marginRight: 6 }}
                  />
                  {f.label}
                </label>
              </div>
            );
          }
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
          const commitUi = (v: number) => {
            onPatch({ [f.key]: f.unit === 'count' ? Math.max(f.smin ?? 1, Math.round(v)) : toSi(f.unit, v) });
          };
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
                  if (Number.isFinite(v)) commitUi(v);
                }}
              />
              {f.smin !== undefined && f.smax !== undefined && typeof value === 'number' && (
                <ValueSlider
                  value={value}
                  min={f.smin}
                  max={f.smax}
                  step={f.unit === 'count' ? 1 : (f.step ?? 1)}
                  onChange={commitUi}
                />
              )}
            </div>
          );
        })}
      </div>

      {node.type === 'nosecone' && (() => {
        // Snap the shoulder into the tube behind the nose: next top-level body tube.
        const idx = tree.components.findIndex((n) => n.id === node.id);
        const tube = tree.components.slice(idx + 1).find((n) => n.type === 'bodytube');
        if (!tube || typeof tube['outerRadius'] !== 'number') return null;
        const innerR = (tube['outerRadius'] as number) - ((tube['thickness'] as number) ?? 0);
        return (
          <button
            className="file-btn"
            style={{ marginTop: 6 }}
            title={`Set shoulder radius to the adjacent tube's inner radius (${(innerR * 1000).toFixed(1)} mm)`}
            onClick={() => onPatch({ shoulderRadius: innerR })}
          >
            Fit shoulder to tube ⌀
          </button>
        );
      })()}

      {node.type === 'freeformfinset' && (
        <FinPointsEditor
          points={(node['points'] as FinPoint[] | undefined) ?? []}
          onChange={(points) => onPatch({ points })}
        />
      )}

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

      <div style={{ marginTop: 10 }}>
        <h2>Overrides (blank = calculated)</h2>
        <div className="field-grid">
          <div className="field">
            <label>Mass (g)</label>
            <input
              type="number"
              step={0.1}
              min={0}
              value={typeof node['overrideMass'] === 'number'
                ? Number(((node['overrideMass'] as number) * 1000).toFixed(6)) : ''}
              onChange={(e) => {
                const v = Number(e.target.value);
                onPatch({ overrideMass: e.target.value === '' || !Number.isFinite(v) ? undefined : v / 1000 });
              }}
            />
          </div>
          <div className="field">
            <label>CG from component top (mm)</label>
            <input
              type="number"
              step={1}
              value={typeof node['overrideCGX'] === 'number'
                ? Number(((node['overrideCGX'] as number) * 1000).toFixed(6)) : ''}
              onChange={(e) => {
                const v = Number(e.target.value);
                onPatch({ overrideCGX: e.target.value === '' || !Number.isFinite(v) ? undefined : v / 1000 });
              }}
            />
          </div>
          <div className="field">
            <label>Drag coefficient (Cd)</label>
            <input
              type="number"
              step={0.05}
              min={0}
              value={typeof node['overrideCD'] === 'number' ? (node['overrideCD'] as number) : ''}
              onChange={(e) => {
                const v = Number(e.target.value);
                onPatch({ overrideCD: e.target.value === '' || !Number.isFinite(v) ? undefined : v });
              }}
            />
          </div>
        </div>
      </div>

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
              <ValueSlider
                value={Number((pos.offset * 1000).toFixed(6))}
                min={-parentLenMm}
                max={parentLenMm}
                step={1}
                onChange={(v) => onPatch({ position: { ...pos, offset: v / 1000 } })}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
