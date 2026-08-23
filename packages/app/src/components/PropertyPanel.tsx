import { Fragment, useMemo, useRef, useState } from 'react';
import type { ComponentInfo, ComponentNode, ComponentPosition, RocketTree } from '@online-openrocket/engine';
import { FinPointsEditor, type FinPoint } from './FinPointsEditor.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';
import { DISPLAY_NAME, FIELDS, POSITIONABLE, type FieldDef } from '../tree/schema.js';
import { findParent, suppressingAncestor } from '../tree/treeModel.js';
import { anchorStarts, axialLength, offsetForStart, snapStart, startFromPosition } from '../tree/position.js';
import { tubeFinMaxCount, tubeFinMaxRadius, tubeFinRadius } from '../tree/tubefins.js';
import { shapeParamDefault, shapeParamMax, shapeUsesParameter } from '../tree/shapeProfile.js';
import { componentSolid, type SolidContext } from '../tree/solidMesh.js';
import { componentDxf, DXF_CUTTABLE, DXF_MIME } from '../services/dxfExport.js';
import { buildPrintPack, printOffer, SINGLE_BUTTON, ZIP_MIME } from '../services/printPack.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { printerName, toPrinterVolume } from '../prefs/printers.js';
import { fmtSi, niceStep, siToUi, uiToSi, type Quantity } from '../prefs/units.js';
import { BULK_MATERIALS, LINE_MATERIALS, SURFACE_MATERIALS, type MaterialDef } from '../data/materials.js';
import { PresetPicker } from './PresetPicker.js';
import { KIND_FOR_TYPE } from '../services/presets.js';
import { finTemplateSvg } from '../services/finTemplate.js';

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

/**
 * Named-material dropdown (desktop material database). Picking one writes the
 * name + density into the node; "Custom" clears the name and keeps whatever
 * density is set. Densities: bulk kg/m³, surface kg/m², line kg/m.
 */
function MaterialSelect({ label, list, nameKey, densityKey, densityUnit, node, onPatch }: {
  label: string;
  list: MaterialDef[];
  nameKey: string;
  densityKey: string;
  densityUnit: string;
  node: ComponentNode;
  onPatch: (patch: Partial<ComponentNode>) => void;
}) {
  const current = node[nameKey];
  const value = typeof current === 'string' && list.some((m) => m.name === current) ? current : '';
  return (
    <div className="field">
      <label>{label}</label>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => {
          const mat = list.find((m) => m.name === e.target.value);
          onPatch(mat
            ? { [nameKey]: mat.name, [densityKey]: mat.density }
            : { [nameKey]: undefined });
        }}
      >
        <option value="">Custom</option>
        {list.map((m) => (
          <option key={m.name} value={m.name}>{m.name} ({m.density} {densityUnit})</option>
        ))}
      </select>
    </div>
  );
}

/** Component types the 🖨 print-STL button supports (tree/solidMesh.ts). */
const PRINTABLE = new Set([
  'nosecone', 'transition', 'bodytube', 'innertube', 'tubecoupler',
  'centeringring', 'bulkhead', 'engineblock', 'launchlug', 'tubefinset',
  'trapezoidfinset', 'ellipticalfinset', 'freeformfinset',
]);

/**
 * Parent-derived diameters, shared by the STL and DXF exports: rings,
 * bulkheads and couplers size to the parent tube's bore, and a centering
 * ring's own bore comes from the motor-mount tube it centers. Both exporters
 * must read the SAME context or the printed and the machined version of one
 * part would come out different sizes.
 */
/**
 * "Use instead of everything inside" for one override, plus the notice that
 * says when an ANCESTOR'S flag is suppressing this one.
 *
 * Relabelled 2026-08-23 (owner ruling): the old "…and everything inside" read
 * as though the contents were being added in, when ticking is precisely what
 * makes them stop counting.
 *
 * The semantics, measured against the kernel rather than assumed (2026-08-23):
 * an override always stands in for the component's OWN computed value — it does
 * not add to it. The flag widens that to the whole subtree, and everything
 * below then stops contributing, INCLUDING its own overrides. An earlier
 * description of the unticked case as "adds" was wrong for anything with
 * geometry: it is only true of a stage, which has no drag or mass of its own.
 *
 * The suppression notice matters more than it looks. Without it a user sets a
 * mass on a body tube, watches nothing change, and has nothing on screen
 * telling them a stage above is standing in for the lot — exactly the
 * "confusion up and down the hierarchical stack" the owner flagged.
 */
/**
 * Containers with no mass, CG or drag of their own (ComponentAssembly:
 * getComponentMass() = 0, isMassive() = false). On these an UNTICKED override
 * has nothing of its own to replace, so it behaves differently from every
 * other component — measured 2026-08-23 and pinned in orkEngine.test.ts:
 *   stage mass 1 kg unticked  -> base + 1 kg   (adds, does not set)
 *   stage Cd 1.0 unticked     -> base + 1.0    (adds, measured 0.60236 -> 1.60236)
 *   stage CG 0.1 m unticked   -> NO CHANGE AT ALL
 * Which is why the panel tells you to tick the box on one of these. The Cd row
 * was missing from this copy until 2026-08-23 and is the gap the owner kept
 * asking about — a stage is not aerodynamic, so unticked there is nothing of
 * its own to displace and its figure lands on top of the rocket's total.
 */
const CONTAINER_TYPES = new Set(['stage', 'podset', 'parallelstage']);

function SubcomponentsToggle({ tree, node, quantity, valueKey, flagKey, onPatch }: {
  tree: RocketTree;
  node: ComponentNode;
  quantity: string;
  valueKey: string;
  flagKey: string;
  onPatch: (patch: Partial<ComponentNode>) => void;
}) {
  const active = typeof node[valueKey] === 'number';
  const hasChildren = (node.children?.length ?? 0) > 0;
  const blocker = node.id ? suppressingAncestor(tree, node.id, flagKey, valueKey) : null;

  if (blocker) {
    // Shown whether or not THIS component has a value of its own: its geometry
    // is being stood in for either way, so the explanation is owed regardless.
    return (
      <p className="override-suppressed" role="note">
        Not in use — <strong>{blocker.name || DISPLAY_NAME[blocker.type] || 'a part above'}</strong>
        {' '}stands in for the {quantity} of everything inside it. Untick its
        “Use instead of everything inside” to use this.
      </p>
    );
  }
  if (!active || !hasChildren) return null;
  return (
    <label className="override-subs">
      <input
        type="checkbox"
        checked={node[flagKey] === true}
        onChange={(e) => onPatch({ [flagKey]: e.target.checked || undefined })}
        aria-label={`Use this ${quantity} override instead of everything inside this component`}
      />
      Use instead of everything inside
    </label>
  );
}

function solidContextFor(parent: ComponentNode | 'stage' | null): SolidContext {
  const ctx: SolidContext = {};
  if (parent && parent !== 'stage') {
    const pOuter = typeof parent['outerRadius'] === 'number' ? (parent['outerRadius'] as number) : undefined;
    const pThick = typeof parent['thickness'] === 'number' ? (parent['thickness'] as number) : 0.001;
    if (pOuter !== undefined) {
      ctx.parentInnerRadius = Math.max(0.0005, pOuter - pThick);
      ctx.bodyRadius = pOuter;
    }
    const mount = (parent.children ?? []).find((c) => c.type === 'innertube');
    if (mount && typeof mount['outerRadius'] === 'number') {
      ctx.mountOuterRadius = mount['outerRadius'] as number;
    }
  }
  return ctx;
}

/** Quick palette for the display color (the owner: basic colors one click away). */
const COLOR_PRESETS = [
  '#ffffff', '#1c1c1c', '#e34948', '#f5871f', '#f2c230',
  '#3fa34d', '#2a78d6', '#8e5bd1', '#9a978f', '#7a4a2b',
];

export function PropertyPanel({ tree, node, info, onPatch, onPatchAll, onAutoAlignFins }: {
  tree: RocketTree;
  node: ComponentNode;
  /** Engine-computed stats for THIS component (null while a build is broken). */
  info?: ComponentInfo | null;
  onPatch: (patch: Partial<ComponentNode>) => void;
  /** Applies a patch to every component carrying those fields (bulk finish). */
  onPatchAll?: (patch: Partial<ComponentNode>) => void;
  /** Rotates overlapping sibling fin sets apart (tree/finAlign.ts). */
  onAutoAlignFins?: () => void;
}) {
  const { prefs } = usePrefs();
  const [showPresets, setShowPresets] = useState(false);
  const fields = FIELDS[node.type] ?? [];
  const parent = findParent(tree, node.id!);
  const positionable = POSITIONABLE.has(node.type) && parent !== 'stage';
  const pos = (node.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
  const parentLenSi = parent && parent !== 'stage' && typeof parent['length'] === 'number'
    ? parent['length']
    : 0.2;

  /**
   * What the 🖨 button offers for this component: its caption, the one line
   * under it, and — only when the part does not fit the configured printer —
   * the segments to pack into a zip. With no printer configured this is the
   * untouched single-STL offer, which is the compatibility guarantee.
   *
   * Memoised because it plans the split and clips the profile; cheap in
   * absolute terms, but this panel re-renders on every keystroke in the fields
   * below and nothing here changes unless the node or the printer does.
   */
  const printer = prefs.printer;
  const offer = useMemo(
    () => (PRINTABLE.has(node.type)
      ? printOffer(node, solidContextFor(parent), toPrinterVolume(printer), printerName(printer))
      : null),
    [node, parent, printer],
  );

  const lengthSym = prefs.units.length;
  const lenToUi = (si: number) => Number(siToUi('length', lengthSym, si).toFixed(6));
  const lenFromUi = (ui: number) => uiToSi('length', lengthSym, ui);
  const massSym = prefs.units.mass;

  // Tube-fin collision geometry: N tubes around a body of radius R touch at
  // r = R·sin(π/N)/(1−sin(π/N)). The kernel enforces that only in auto mode
  // (blank radius); explicit values get the same ceiling here so neither the
  // slider nor typing can push the tubes into each other.
  const tubeFinBodyR = node.type === 'tubefinset' && parent && parent !== 'stage'
    && typeof parent['outerRadius'] === 'number' && (parent['outerRadius'] as number) > 0
    ? (parent['outerRadius'] as number)
    : null;

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

    // Cross-field ceilings for tube fins (issue 2026-08-05e): the outer
    // radius is capped by the touching radius for the current fin count, and
    // the fin count by how many tubes of the explicit radius fit. Blank
    // radius shows the auto (touching) value grayed so builders can read the
    // real as-built dimension without committing to an override.
    let maxSi: number | undefined;
    let maxCount: number | undefined;
    let autoPlaceholder: string | undefined;
    if (tubeFinBodyR !== null && f.key === 'outerRadius') {
      const n = Math.round(typeof node['finCount'] === 'number' ? (node['finCount'] as number) : 6);
      maxSi = tubeFinMaxRadius(n, tubeFinBodyR) ?? undefined;
      if (typeof raw !== 'number') {
        const autoUi = toDisplay(tubeFinRadius(node, tubeFinBodyR));
        autoPlaceholder = `auto: ${Number(autoUi.toFixed(3))}`;
      }
    }
    if (tubeFinBodyR !== null && f.key === 'finCount') {
      const r = node['outerRadius'];
      if (typeof r === 'number' && r > 0) {
        maxCount = tubeFinMaxCount(r, tubeFinBodyR);
      }
    }
    // Shape parameter: capped per shape (haack tops out at 1/3 = LV-Haack,
    // matching the kernel's setShapeParameter clamp); blank = kernel default.
    if (f.key === 'shapeParameter') {
      const sh = String(node['shape'] ?? (node.type === 'transition' ? 'conical' : 'ogive'));
      maxSi = shapeParamMax(sh);
      if (typeof raw !== 'number') {
        autoPlaceholder = `default: ${shapeParamDefault(sh)}`;
      }
    }
    // NumField rejects typed values above max — round the display cap up a
    // hair so typing the shown 3-decimal limit still lands; the commit clamp
    // below keeps the stored SI value exactly at the ceiling.
    const maxUi = f.unit === 'count'
      ? maxCount
      : maxSi !== undefined ? Math.ceil(toDisplay(maxSi) * 1e4) / 1e4 : undefined;

    const label = asDiameter
      ? f.label.replace(/radius/gi, (m) => (m[0] === 'R' ? 'Diameter' : 'diameter'))
      : f.label;
    const plainSuffix = PLAIN_SUFFIX[f.unit];

    // Step/range are authored in legacy units — convert, then snap the step
    // to a 1-2-5 value so spinners feel sane in any unit.
    const legacyToDisplay = (v: number) => quantity && symbol
      ? siToUi(quantity, symbol, v * legacy.toSI * geomFactor)
      : v * geomFactor;
    const step = f.unit === 'count' ? 1 : niceStep(legacyToDisplay(f.step ?? 1));

    const commit = (ui: number) => {
      let next = f.unit === 'count'
        ? Math.max(f.smin ?? 1, Math.round(ui))
        : fromDisplay(ui);
      if (f.unit === 'count' && maxCount !== undefined) next = Math.min(next, maxCount);
      if (f.unit !== 'count' && maxSi !== undefined) next = Math.min(next, maxSi);
      const patch: Partial<ComponentNode> = { [f.key]: next };
      // A hand-typed density is no longer the named material's density.
      if (f.key === 'density') patch['materialName'] = undefined;
      onPatch(patch);
    };

    // Negative input is valid only where the schema's slider dips below zero
    // (sweep, cant angle) — dimensions and counts reject a typed minus sign.
    const allowNegative = f.smin !== undefined && f.smin < 0;

    return (
      <div className="field" key={f.key}>
        <label>
          {label}
          {quantity ? <> <UnitChip quantity={quantity} /></> : plainSuffix && ` (${plainSuffix})`}
        </label>
        <NumField
          ariaLabel={quantity ? `${label} (${symbol ?? ''})`.trim() : label}
          value={typeof value === 'number' ? value : undefined}
          step={step}
          allowNegative={allowNegative}
          integer={f.unit === 'count'}
          min={f.unit === 'count' ? (f.smin ?? 1) : undefined}
          max={maxUi}
          placeholder={autoPlaceholder}
          nullable
          onCommit={(v) => {
            if (v === null) onPatch({ [f.key]: undefined });
            else commit(v);
          }}
        />
        {f.smin !== undefined && f.smax !== undefined && typeof value === 'number' && (
          <ValueSlider
            value={value}
            min={f.unit === 'count' ? f.smin : legacyToDisplay(f.smin)}
            max={Math.min(
              f.unit === 'count' ? f.smax : legacyToDisplay(f.smax),
              maxUi ?? Infinity,
            )}
            step={step}
            onChange={commit}
          />
        )}
      </div>
    );
  };

  return (
    <div className="panel">
      <h2>{DISPLAY_NAME[node.type]}</h2>
      {info && (
        <p className="comp-stats">
          this component: {fmtSi('length', lengthSym, info.length, 3)} {lengthSym}
          {' · '}{fmtSi('mass', massSym, info.mass)} {massSym}
          {node.type.endsWith('finset') ? ' (all fins)' : ''}
          {info.sectionMass > info.mass + 1e-9 && (
            <> · {fmtSi('mass', massSym, info.sectionMass)} {massSym} with children</>
          )}
          {' · '}CG {fmtSi('length', lengthSym, info.cgX, 3)} {lengthSym} from its front
          {' · '}starts {fmtSi('length', lengthSym, info.positionX, 3)} {lengthSym} from nose
        </p>
      )}
      <div className="field">
        <label>Name</label>
        <input value={node.name ?? ''} onChange={(e) => onPatch({ name: e.target.value })} />
      </div>
      {KIND_FOR_TYPE[node.type] && (
        <button className="file-btn" style={{ marginTop: 6, width: '100%' }}
          onClick={() => setShowPresets(true)}>
          📦 Choose from preset database…
        </button>
      )}
      {(node.type === 'trapezoidfinset' || node.type === 'ellipticalfinset'
        || node.type === 'freeformfinset') && (
        <button className="file-btn" style={{ marginTop: 6, width: '100%' }}
          title="True-scale SVG cut template — print at 100% or send to a laser cutter; includes the through-the-wall tab and a 50 mm calibration ruler"
          onClick={() => {
            const svg = finTemplateSvg(node, tree.name ?? 'Rocket');
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
            a.download = `${(node.name ?? 'fin').replace(/[^\w-]+/g, '_')}-template.svg`;
            a.click();
            URL.revokeObjectURL(a.href);
          }}>
          📐 Fin template (SVG, 1:1)
        </button>
      )}
      {DXF_CUTTABLE.has(node.type) && (
        // Scissors, NOT the 📐 the fin-template button above already owns. The
        // two sit adjacent, and with a shared glyph a user scanning for the
        // laser export stops at the print-and-trace template instead.
        <button className="file-btn" style={{ marginTop: 6, width: '100%' }}
          title="Flat 1:1 cut profile as R12 DXF in millimetres — for laser/router/waterjet CAM and Fusion 360 sketch import. Fin sets export ONE fin as a single closed contour with the through-the-wall tab merged into it (airfoil shaping, cant and sweep-into-the-tube are NOT represented); rings, bulkheads and couplers take their diameters from the parent tube, and a centering ring's bore from the motor mount. Cut geometry is on the CUT layer only — REFERENCE (root chord, centre marks) and TEXT are guides; switch them off before cutting."
          onClick={() => {
            const dxf = componentDxf(node, solidContextFor(parent), tree.name ?? 'Rocket');
            if (!dxf) return;
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([dxf.text], { type: DXF_MIME }));
            a.download = `${(node.name ?? dxf.label).replace(/[^\w-]+/g, '_')}-cut.dxf`;
            a.click();
            URL.revokeObjectURL(a.href);
          }}>
          ✂ DXF (CNC/laser, 1:1)
        </button>
      )}
      {PRINTABLE.has(node.type) && (
        <>
          <button className="file-btn" style={{ marginTop: 6, width: '100%' }}
            title={offer?.kind === 'split'
              ? 'This part is taller than your printer, so it exports as a ZIP: one STL per segment plus a README with the print orientation, the glue, and the shrinkage rule that decides whether the halves fit each other. Each cut adds a tapered spigot and a flat land — the land sets the assembled length, so nothing is lost at the joint.'
              : 'Watertight solid STL in millimetres, ready to slice. Hollow noses/transitions include shoulders and end caps at your wall thickness; fin sets export ONE fin as a flat prism with its tab (airfoil/cross-section shaping is left to sanding, cant not baked); rings, bulkheads and couplers take their diameters from the parent tube. Verify fit before a long print.'}
            onClick={async () => {
              const a = document.createElement('a');
              // Split path: a zip of segments. Everything else — no printer, a
              // part that fits, a part that cannot be split — takes the single
              // STL path below, byte-for-byte and filename-for-filename what
              // this button has always produced.
              if (offer?.kind === 'split' && offer.split) {
                const vol = toPrinterVolume(printer);
                if (!vol) return;
                const name = node.name ?? offer.split.label;
                const pack = await buildPrintPack(offer.split, name, vol, printerName(printer));
                a.href = URL.createObjectURL(new Blob([pack.bytes as BlobPart], { type: ZIP_MIME }));
                a.download = pack.filename;
              } else {
                const solid = await componentSolid(node, solidContextFor(parent));
                if (!solid) return;
                // Loaded on click: stlExport imports the whole three.js
                // namespace, and this panel renders on the design screen.
                const { solidToStl, STL_MIME } = await import('../services/stlExport.js');
                const stl = solidToStl(solid.mesh, node.name ?? solid.label);
                a.href = URL.createObjectURL(new Blob([stl as BlobPart], { type: STL_MIME }));
                a.download = `${(node.name ?? solid.label).replace(/[^\w-]+/g, '_')}-print.stl`;
              }
              a.click();
              URL.revokeObjectURL(a.href);
            }}>
            {offer?.button ?? SINGLE_BUTTON}
          </button>
          {offer?.note && (
            <p className={offer.tone === 'warn' ? 'print-note print-note-warn' : 'print-note'}>
              {offer.note}
            </p>
          )}
        </>
      )}
      {onAutoAlignFins && node.type.endsWith('finset') && parent && parent !== 'stage'
        && (parent.children ?? []).filter((c) => c.type.endsWith('finset')).length >= 2 && (
        <button className="file-btn" style={{ marginTop: 6, width: '100%' }}
          title="Rotates this tube's overlapping fin sets so their fins interleave with the widest clearance — no manual rotation math needed"
          onClick={onAutoAlignFins}>
          🧭 Auto-align fin sets
        </button>
      )}
      {showPresets && (
        <PresetPicker type={node.type} onApply={onPatch} onClose={() => setShowPresets(false)} />
      )}
      <div className="field" style={{ marginTop: 6 }}>
        <label>Color (2D/3D display)</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="color" style={{ width: 44, padding: 2, height: 26 }}
            value={typeof node['color'] === 'string' ? (node['color'] as string) : '#d5d2cb'}
            onChange={(e) => onPatch({ color: e.target.value })} />
          {COLOR_PRESETS.map((c) => (
            <button key={c} className="color-swatch" style={{ background: c }}
              title={c} aria-label={`Set color ${c}`}
              onClick={() => onPatch({ color: c })} />
          ))}
          {typeof node['color'] === 'string' && (
            <button className="file-btn" onClick={() => onPatch({ color: undefined })}>reset</button>
          )}
        </div>
      </div>
      <div className="field-grid" style={{ marginTop: 8 }}>
        {fields.map((f) => {
          // Conical and ellipsoid profiles have no shape parameter.
          if (f.key === 'shapeParameter'
              && !shapeUsesParameter(String(node['shape'] ?? (node.type === 'transition' ? 'conical' : 'ogive')))) {
            return null;
          }
          if (f.bool) {
            // Sub-minimum only makes sense on a tube that already IS a mount.
            if (f.key === 'caseAirframe' && node['motorMount'] !== true) return null;
            return (
              <div className="field" key={f.key} style={{ justifyContent: 'flex-end' }}>
                <label title={f.key === 'caseAirframe'
                  ? 'Sub-minimum build: the motor case IS the outer airframe (fins bond straight to the case, or propellant is cast into this tube). The motor browser then fits motors to this tube’s OUTER diameter. The motor file’s weight should include the case; keep the wall at 0 unless this tube adds real structure on top of it.'
                  : undefined}>
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
                <label>
                  {f.label}
                  {f.key === 'finish' && onPatchAll && (
                    <>
                      {' '}
                      <button className="finish-all-btn"
                        title="Apply this finish to every component"
                        onClick={() => onPatchAll({ finish: node['finish'] ?? 'normal' })}>
                        → all
                      </button>
                    </>
                  )}
                </label>
                <select
                  aria-label={f.label}
                  // Unset finish means the engine's 'normal' (regular paint) —
                  // showing the first option ("Rough") would misreport it.
                  value={String(node[f.key] ?? (f.key === 'finish' ? 'normal' : f.options[0]![0]))}
                  onChange={(e) => onPatch({ [f.key]: e.target.value })}
                >
                  {f.options.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </div>
            );
          }
          if (f.key === 'density') {
            return (
              <Fragment key={f.key}>
                <MaterialSelect label="Material" list={BULK_MATERIALS}
                  nameKey="materialName" densityKey="density" densityUnit="kg/m³"
                  node={node} onPatch={onPatch} />
                {renderNumeric(f)}
              </Fragment>
            );
          }
          // Wall thickness and inner diameter are two views of one dimension
          // — editing either updates the other. Tubes reference outerRadius;
          // nose cones reference their base (aft) radius, so OD/ID/wall stay
          // in sync with the body tube behind them.
          const outerKeyForID = typeof node['outerRadius'] === 'number' ? 'outerRadius'
            : node.type === 'nosecone' && typeof node['aftRadius'] === 'number' ? 'aftRadius'
            : null;
          if (f.key === 'thickness' && outerKeyForID
              && typeof node['thickness'] === 'number') {
            const outerR = node[outerKeyForID] as number;
            const innerSi = Math.max(0, outerR - (node['thickness'] as number)) * 2;
            const idQuantity: Quantity = 'length';
            const idSym = prefs.units[idQuantity];
            return (
              <Fragment key={f.key}>
                {renderNumeric(f)}
                <div className="field">
                  <label>
                    {node.type === 'nosecone' ? 'Base inner diameter' : 'Inner diameter'}
                    {' '}<UnitChip quantity="length" />
                  </label>
                  <NumField
                    ariaLabel={node.type === 'nosecone' ? 'Base inner diameter' : 'Inner diameter'}
                    value={siToUi(idQuantity, idSym, innerSi)}
                    step={niceStep(siToUi(idQuantity, idSym, 0.001))}
                    max={siToUi(idQuantity, idSym, outerR * 2)}
                    onCommit={(v) => {
                      if (v === null) return;
                      const idSi = uiToSi(idQuantity, idSym, v);
                      onPatch({ thickness: Math.max(0, outerR - idSi / 2) });
                    }}
                  />
                </div>
              </Fragment>
            );
          }
          return renderNumeric(f);
        })}
        {(node.type === 'parachute' || node.type === 'streamer') && (
          <MaterialSelect label="Canopy material" list={SURFACE_MATERIALS}
            nameKey="surfaceMaterialName" densityKey="surfaceDensity" densityUnit="kg/m²"
            node={node} onPatch={onPatch} />
        )}
        {(node.type === 'parachute' || node.type === 'shockcord') && (
          <MaterialSelect label={node.type === 'parachute' ? 'Line material' : 'Cord material'}
            list={LINE_MATERIALS}
            nameKey="lineMaterialName" densityKey="lineDensity" densityUnit="kg/m"
            node={node} onPatch={onPatch} />
        )}
      </div>

      {(node.type === 'trapezoidfinset' || node.type === 'freeformfinset'
        || node.type === 'ellipticalfinset') && (() => {
        // Tab depth so the tab just touches the motor-mount tube (the owner's
        // real-build default); falls back to the tube wall if no mount.
        if (!parent || parent === 'stage') return null;
        const p = parent as ComponentNode;
        if (p.type !== 'bodytube' || typeof p['outerRadius'] !== 'number') return null;
        const outerR = p['outerRadius'] as number;
        const mount = (p.children ?? []).find(
          (c) => c.type === 'innertube' && typeof c['outerRadius'] === 'number');
        const depth = mount
          ? outerR - (mount['outerRadius'] as number)
          : ((p['thickness'] as number) ?? 0.001);
        if (depth <= 0) return null;
        const rootLen = node.type === 'freeformfinset'
          ? Math.max(...(((node['points'] as FinPoint[] | undefined) ?? [[0, 0]]).map((pt) => pt[0])))
          : ((node['rootChord'] as number) ?? 0.05);
        const hasLength = typeof node['tabLength'] === 'number' && (node['tabLength'] as number) > 0;
        return (
          <button
            className="file-btn"
            style={{ marginTop: 6 }}
            title={mount
              ? `Set tab depth to reach the motor tube (${lenToUi(depth)} ${lengthSym})`
              : `No motor tube found — set tab depth to the tube wall (${lenToUi(depth)} ${lengthSym})`}
            onClick={() => onPatch({
              tabHeight: depth,
              ...(hasLength ? {} : { tabLength: rootLen * 0.6 }),
              ...(typeof node['tabOffsetMethod'] === 'string' ? {} : { tabOffsetMethod: 'middle', tabOffset: 0 }),
            })}
          >
            Fit tab to motor tube
          </button>
        );
      })()}

      {node.type === 'nosecone' && (() => {
        // Snap the shoulder into the tube behind the nose: the next body tube
        // among the SIBLINGS (the enclosing stage's children — tree.components
        // holds only stage nodes since v0.009).
        const siblings = parent && parent !== 'stage'
          ? ((parent as ComponentNode).children ?? [])
          : tree.components;
        const idx = siblings.findIndex((n) => n.id === node.id);
        const tube = siblings.slice(idx + 1).find((n) => n.type === 'bodytube');
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
              onChange={(e) => {
                const patch: Partial<ComponentNode> = { motorMount: e.target.checked };
                // A tube that becomes a motor mount takes the conventional name
                // (only when the user hasn't renamed it).
                if (e.target.checked
                    && (!node.name || node.name === DISPLAY_NAME.innertube)) {
                  patch.name = 'Motor Mount Tube';
                } else if (!e.target.checked && node.name === 'Motor Mount Tube') {
                  patch.name = DISPLAY_NAME.innertube;
                }
                onPatch(patch);
              }}
              style={{ width: 'auto', marginRight: 6 }}
            />
            Acts as motor mount
          </label>
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        <h2>
          Overrides (blank = calculated)
          {node.type === 'stage' ? ' — whole stage' : ''}
        </h2>
        <div className="field-grid">
          <div className="field">
            <label>Mass{node.type.endsWith('finset') ? ' (all fins combined)' : ''} <UnitChip quantity="mass" /></label>
            <NumField
              ariaLabel="Mass override"
              value={typeof node['overrideMass'] === 'number'
                ? siToUi('mass', massSym, node['overrideMass'] as number) : undefined}
              step={niceStep(siToUi('mass', massSym, 0.0001))}
              nullable
              placeholder={info ? fmtSi('mass', massSym, info.mass) : undefined}
              onCommit={(v) => onPatch(v === null
                ? { overrideMass: undefined, overrideSubcomponentsMass: undefined }
                : { overrideMass: uiToSi('mass', massSym, v) })}
            />
            <SubcomponentsToggle
              tree={tree}
              node={node}
              quantity="mass"
              valueKey="overrideMass"
              flagKey="overrideSubcomponentsMass"
              onPatch={onPatch}
            />
          </div>
          <div className="field">
            <label>CG from component top <UnitChip quantity="length" /></label>
            <NumField
              ariaLabel="CG override, from component top"
              value={typeof node['overrideCGX'] === 'number'
                ? lenToUi(node['overrideCGX'] as number) : undefined}
              step={niceStep(siToUi('length', lengthSym, 0.001))}
              allowNegative
              nullable
              placeholder={info ? fmtSi('length', lengthSym, info.cgX, 3) : undefined}
              onCommit={(v) => onPatch(v === null
                ? { overrideCGX: undefined, overrideSubcomponentsCG: undefined }
                : { overrideCGX: lenFromUi(v) })}
            />
            <SubcomponentsToggle
              tree={tree}
              node={node}
              quantity="CG"
              valueKey="overrideCGX"
              flagKey="overrideSubcomponentsCG"
              onPatch={onPatch}
            />
          </div>
          <div className="field">
            {/* A fin set's Cd override is multiplied by the fin COUNT (the
                kernel's instanceCount), while its MASS override covers the
                whole set — measured, not assumed: Cd 0.5 contributes 1.5 / 2.0
                / 3.0 on 3 / 4 / 6 fins. That asymmetry has to be on the label
                or it silently triples someone's drag. */}
            <label>
              Drag coefficient (Cd){node.type.endsWith('finset') ? ' — per fin' : ''}
            </label>
            <NumField
              ariaLabel="Drag coefficient (Cd) override"
              value={typeof node['overrideCD'] === 'number' ? (node['overrideCD'] as number) : undefined}
              step={0.05}
              nullable
              placeholder="auto"
              onCommit={(v) => onPatch(v === null
                ? { overrideCD: undefined, overrideSubcomponentsCD: undefined }
                : { overrideCD: v })}
            />
            <SubcomponentsToggle
              tree={tree}
              node={node}
              quantity="Cd"
              valueKey="overrideCD"
              flagKey="overrideSubcomponentsCD"
              onPatch={onPatch}
            />
          </div>
        </div>
        <p className="hint">
          An override never deletes anything — this component keeps its own
          numbers, and they come straight back when you clear the field.
          {' '}<strong>Ticked</strong>, your figure is used instead of this
          component <em>and everything in it</em>; nothing below contributes any
          more, including its own overrides. <strong>Unticked</strong>, it
          stands in for <em>this component&rsquo;s own figure only</em>, and
          everything inside it still counts on its own.
        </p>
        {CONTAINER_TYPES.has(node.type) && (
          <p className="hint">
            <strong>On a stage, pod set or booster, tick the box.</strong> These
            are containers with no mass, CG or drag of their own, so an unticked
            override here has nothing to stand in for: an unticked mass or Cd is
            {' '}<em>added</em> to what the contents compute (1 kg unticked makes
            the rocket 1 kg heavier; a Cd of 1.0 adds 1.0 to its drag), and an
            unticked CG does nothing at all. Ticked, it sets the figure for the
            whole assembly — which is how you set one Cd, or one weighed mass,
            for the entire rocket.
          </p>
        )}
      </div>

      {positionable && (
        <div style={{ marginTop: 10 }}>
          <h2>Position (in parent)</h2>
          <div className="field-grid">
            <div className="field">
              <label>Relative to</label>
              <select
                aria-label="Position relative to"
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
              <label>Offset <UnitChip quantity="length" /></label>
              <NumField
                ariaLabel="Position offset"
                value={lenToUi(pos.offset)}
                step={niceStep(siToUi('length', lengthSym, 0.001))}
                allowNegative
                onCommit={(v) => {
                  if (v !== null) onPatch({ position: { ...pos, offset: lenFromUi(v) } });
                }}
              />
              <ValueSlider
                value={lenToUi(pos.offset)}
                min={lenToUi(-parentLenSi)}
                max={lenToUi(parentLenSi)}
                step={niceStep(siToUi('length', lengthSym, 0.001))}
                onChange={(v) => {
                  // Magnetic slider: snap to structural anchors (tube/sibling ends).
                  // `parent` is a ComponentNode here — positionable excludes 'stage'.
                  const cLen = axialLength(node);
                  const start = startFromPosition({ ...pos, offset: lenFromUi(v) }, cLen, parentLenSi);
                  const snapped = snapStart(start, anchorStarts(parent as ComponentNode, node), parentLenSi * 0.015);
                  onPatch({ position: { ...pos, offset: offsetForStart(pos.method, snapped, cLen, parentLenSi) } });
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
