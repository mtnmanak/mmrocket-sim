import { useRef } from 'react';
import type { ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { FinPointsEditor, type FinPoint } from './FinPointsEditor.js';
import { DISPLAY_NAME, FIELDS, POSITIONABLE, type FieldDef } from '../tree/schema.js';
import { findParent } from '../tree/treeModel.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { niceStep, siToUi, uiToSi, type Quantity } from '../prefs/units.js';

/**
 * Schema fields are authored in "legacy" units (mm/deg/g/m/s/kg·m⁻³ — what the
 * app displayed before user-selectable units). Each legacy unit maps to a
 * preference quantity; conversion is legacy → SI → user's unit. The engine
 * side of the boundary stays SI/radians.
 */
const LEGACY: Record<FieldDef['unit'], { quantity: Quantity | null; toSI: number }> = {
  mm: { quantity: 'length', toSI: 0.001 },
  m: { quantity: 'distance', toSI: 1 },
  deg: { quantity: 'angle', toSI: Math.PI / 180 },
  g: { quantity: 'mass', toSI: 0.001 },
  'kg/m3': { quantity: 'density', toSI: 1 },
  s: { quantity: null, toSI: 1 },
  count: { quantity: null, toSI: 1 },
  none: { quantity: null, toSI: 1 },
};

const PLAIN_SUFFIX: Partial<Record<FieldDef['unit'], string>> = { s: 's' };

/**
 * Slider synced with a numeric value (display units). The range grows to
 * include an out-of-range typed value, and is frozen for the duration of a
 * drag so the handle doesn't chase its own updates.
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
  const { prefs } = usePrefs();
  const fields = FIELDS[node.type] ?? [];
  const parent = findParent(tree, node.id!);
  const positionable = POSITIONABLE.has(node.type) && parent !== 'stage';
  const pos = (node.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
  const parentLenSi = parent && parent !== 'stage' && typeof parent['length'] === 'number'
    ? parent['length']
    : 0.2;

  const lengthSym = prefs.units.length;
  const lenToUi = (si: number) => Number(siToUi('length', lengthSym, si).toFixed(6));
  const lenFromUi = (ui: number) => uiToSi('length', lengthSym, ui);
  const massSym = prefs.units.mass;

  const renderNumeric = (f: FieldDef) => {
    const legacy = LEGACY[f.unit];
    const quantity = legacy.quantity;
    const symbol = quantity ? prefs.units[quantity] : null;
    const asDiameter = f.radius === true && prefs.radiusMode === 'diameter';
    const geomFactor = asDiameter ? 2 : 1; // SI radius ↔ displayed diameter

    const toDisplay = (si: number) => quantity && symbol
      ? siToUi(quantity, symbol, si * geomFactor)
      : si * geomFactor;
    const fromDisplay = (ui: number) => (quantity && symbol
      ? uiToSi(quantity, symbol, ui)
      : ui) / geomFactor;

    const raw = node[f.key];
    const value = typeof raw === 'number' ? toDisplay(raw) : '';

    const label = asDiameter
      ? f.label.replace(/radius/gi, (m) => (m[0] === 'R' ? 'Diameter' : 'diameter'))
      : f.label;
    const suffix = symbol ?? PLAIN_SUFFIX[f.unit] ?? '';

    // Step/range are authored in legacy units — convert, then snap the step
    // to a 1-2-5 value so spinners feel sane in any unit.
    const legacyToDisplay = (v: number) => quantity && symbol
      ? siToUi(quantity, symbol, v * legacy.toSI * geomFactor)
      : v * geomFactor;
    const step = f.unit === 'count' ? 1 : niceStep(legacyToDisplay(f.step ?? 1));

    const commit = (ui: number) => {
      onPatch({
        [f.key]: f.unit === 'count'
          ? Math.max(f.smin ?? 1, Math.round(ui))
          : fromDisplay(ui),
      });
    };

    return (
      <div className="field" key={f.key}>
        <label>{label}{suffix && ` (${suffix})`}</label>
        <input
          type="number"
          step={step}
          value={value === '' ? '' : Number(value.toFixed(6))}
          onChange={(e) => {
            if (e.target.value === '') {
              onPatch({ [f.key]: undefined });
              return;
            }
            const v = Number(e.target.value);
            if (Number.isFinite(v)) commit(v);
          }}
        />
        {f.smin !== undefined && f.smax !== undefined && typeof value === 'number' && (
          <ValueSlider
            value={value}
            min={f.unit === 'count' ? f.smin : legacyToDisplay(f.smin)}
            max={f.unit === 'count' ? f.smax : legacyToDisplay(f.smax)}
            step={step}
            onChange={commit}
          />
        )}
      </div>
    );
  };

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
          return renderNumeric(f);
        })}
      </div>

      {node.type === 'nosecone' && (() => {
        // Snap the shoulder into the tube behind the nose: next top-level body tube.
        const idx = tree.components.findIndex((n) => n.id === node.id);
        const tube = tree.components.slice(idx + 1).find((n) => n.type === 'bodytube');
        if (!tube || typeof tube['outerRadius'] !== 'number') return null;
        const innerR = (tube['outerRadius'] as number) - ((tube['thickness'] as number) ?? 0);
        const shown = prefs.radiusMode === 'diameter' ? innerR * 2 : innerR;
        return (
          <button
            className="file-btn"
            style={{ marginTop: 6 }}
            title={`Set the shoulder to the adjacent tube's inner ${prefs.radiusMode} (${lenToUi(shown)} ${lengthSym})`}
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
            <label>Mass ({massSym})</label>
            <input
              type="number"
              step={niceStep(siToUi('mass', massSym, 0.0001))}
              min={0}
              value={typeof node['overrideMass'] === 'number'
                ? Number(siToUi('mass', massSym, node['overrideMass'] as number).toFixed(6)) : ''}
              onChange={(e) => {
                const v = Number(e.target.value);
                onPatch({
                  overrideMass: e.target.value === '' || !Number.isFinite(v)
                    ? undefined : uiToSi('mass', massSym, v),
                });
              }}
            />
          </div>
          <div className="field">
            <label>CG from component top ({lengthSym})</label>
            <input
              type="number"
              step={niceStep(siToUi('length', lengthSym, 0.001))}
              value={typeof node['overrideCGX'] === 'number'
                ? lenToUi(node['overrideCGX'] as number) : ''}
              onChange={(e) => {
                const v = Number(e.target.value);
                onPatch({
                  overrideCGX: e.target.value === '' || !Number.isFinite(v)
                    ? undefined : lenFromUi(v),
                });
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
              <label>Offset ({lengthSym})</label>
              <input
                type="number"
                step={niceStep(siToUi('length', lengthSym, 0.001))}
                value={lenToUi(pos.offset)}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) onPatch({ position: { ...pos, offset: lenFromUi(v) } });
                }}
              />
              <ValueSlider
                value={lenToUi(pos.offset)}
                min={lenToUi(-parentLenSi)}
                max={lenToUi(parentLenSi)}
                step={niceStep(siToUi('length', lengthSym, 0.001))}
                onChange={(v) => onPatch({ position: { ...pos, offset: lenFromUi(v) } })}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
