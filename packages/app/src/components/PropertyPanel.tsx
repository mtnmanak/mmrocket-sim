import { MotorLengthField } from './MotorLengthField.js';
import { motorLengthLimit } from '../tree/motorLength.js';
import { Fragment, useEffect, useId, useMemo, useState } from 'react';
import type { ComponentInfo, ComponentNode, ComponentPosition, RocketTree, StaticInfo } from '@online-openrocket/engine';
import { FinPointsEditor, type FinPoint } from './FinPointsEditor.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';
import {
  applyFieldLimit, blankValue, DISPLAY_NAME, FIELDS, fieldLimit, POSITIONABLE, type FieldDef,
} from '../tree/schema.js';
import {
  bodyDragReference, fairingCd, fairingDeliveredCd, fairingFrontalArea, findParent,
  mountRadiusOf, protuberanceCd, protuberanceClass, protuberanceDeliveredCd,
  protuberanceExplicitCd, protuberanceFrontalArea, suppressingAncestor,
} from '../tree/treeModel.js';
import { anchorStarts, axialLength, offsetForStart, positionOf, snapStart, startFromPosition } from '../tree/position.js';
import { tubeFinMaxCount, tubeFinMaxRadius, tubeFinRadius } from '../tree/tubefins.js';
import { betweenFinAnglesAmong, finAnglesAmong, frameContaining, nearestAngle } from '../tree/mountAngle.js';
import { shroudEnds } from '../tree/shroud.js';
import { finTabFit, shoulderFit } from '../tree/fitHelpers.js';
import { ventLimit } from '../tree/canopyVent.js';
import { num, numOpt } from '../tree/nodeNum.js';
import { RAIL_BUTTON_AFT_GAP, railButtonPlacement } from '../services/railButtonPlacement.js';

/**
 * Selects whose displayed value is not simply "the stored key or a default",
 * because an older file stores it somewhere else. Keyed by field, resolved with
 * the SAME function every other consumer uses — see the comment at the call
 * site.
 */
const RESOLVE_SELECT: Record<string, (n: ComponentNode) => string | undefined> = {
  fairingForeShape: (n) => shroudEnds(n).fore,
  fairingAftShape: (n) => shroudEnds(n).aft,
};
import { shapeParamDefault, shapeParamMax, shapeUsesParameter } from '../tree/shapeProfile.js';
import { componentSolid } from '../tree/solidMesh.js';
import { solidContextFor } from '../tree/solidContext.js';
import { componentDxf, DXF_CUTTABLE, DXF_MIME } from '../services/dxfExport.js';
import { buildPrintPack, printOffer, SINGLE_BUTTON, ZIP_MIME } from '../services/printPack.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { printerName, toPrinterVolume } from '../prefs/printers.js';
import { fmtFieldValue, fmtSi, fmtSig, niceStep, siToUi, uiToSi, type Quantity } from '../prefs/units.js';
import { BULK_MATERIALS, LINE_MATERIALS, SURFACE_MATERIALS, type MaterialDef } from '../data/materials.js';
import { PresetPicker } from './PresetPicker.js';
import {
  catalogueDifferences, detachPatch, KIND_FOR_TYPE, linkedPreset, loadPresets,
  type CatalogueDifference, type Preset,
} from '../services/presets.js';
import { limitPatch, POSITION_LIMIT } from '../tree/sanitize.js';
import { OVERRIDE_INCLUDES_MOTOR } from '../services/statedLaunchWeight.js';
import { finTemplateSvg } from '../services/finTemplate.js';
import { safeName } from '../services/fileName.js';
import { downloadBlob } from '../services/saveFile.js';

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
 * The kernel RailButton constructor's own dimensions in metres
 * (RailButton.java:58-64), used ONLY to grey a "default: …" placeholder into an
 * empty box. Every other layer falls back to these same numbers — the .ork
 * reader, the .ork writer, the engine bridge and all three drawings — so a
 * button that states nothing reads, saves, draws and flies as one part.
 */
const RAILBUTTON_DEFAULTS: Record<string, number> = {
  outerDiameter: 0.0097, totalHeight: 0.0097, innerDiameter: 0.008,
  baseHeight: 0.002, flangeHeight: 0.002, screwHeight: 0,
};

/**
 * What to call the component that is overriding this one. Three copies of this
 * fallback chain existed, and they did not agree on the last resort ("a part
 * above this one" / "a part above").
 */
const blockerName = (n: ComponentNode): string =>
  n.name || DISPLAY_NAME[n.type] || 'a part above this one';

/**
 * "Your drag number is not reaching the flight" — shared by the protuberance
 * and camera-shroud figures.
 *
 * It was copy-pasted between the two panels, differing in one phrase, and this
 * commit exists partly because a fix to one of that pair was not applied to
 * the other. `replaces` is the only thing that ever legitimately differed.
 */
function CdBlockedNotice({ blocker, replaces }: { blocker: ComponentNode; replaces: string }) {
  return (
    <>
      {' '}<strong>None of it is reaching the flight right now:</strong>{' '}
      “{blockerName(blocker)}”
      {' '}has a drag-coefficient override with <em>Use instead of everything
      inside</em> ticked, so its figure replaces {replaces}. Clear that override to
      fly the number above.
    </>
  );
}

/**
 * Slider synced with a numeric value (display units). The range grows to
 * include an out-of-range typed value, and is frozen for the duration of a
 * drag so the handle doesn't chase its own updates.
 *
 * The freeze ends on pointerup, AND on pointercancel and lostpointercapture,
 * and it is void once `min`/`max` change under it (audit 2026-09-22). Released
 * on pointerup alone, a touch the browser cancelled — a scroll gesture taking
 * over — left the slider on a stale range until the next complete drag, and a
 * unit switch meanwhile left a millimetre range on an inch slider (1000 in).
 */
function ValueSlider({ value, min, max, step, onChange, ariaLabel }: {
  value: number;
  min: number;
  max: number;
  step: number;
  /**
   * `pointer` is true while a pointer holds the handle, false for the
   * keyboard (arrows, Page Up/Down, Home/End) — so a caller that snaps can
   * snap a DRAG without trapping the arrow keys at every snap point.
   */
  onChange: (ui: number, pointer: boolean) => void;
  /**
   * REQUIRED, even though the type says otherwise for the one caller that has
   * no field label. A `<label>` names ONE control, and each `.field` label is
   * wired to its typed box (htmlFor), so the slider beside it is named by
   * nothing else: before this, on a body tube a screen-reader user met five or
   * six controls all announced as "slider" with a bare number and no clue
   * which dimension they were about to change — and these write straight into
   * the flight model.
   */
  ariaLabel?: string;
}) {
  /** Set while a pointer holds the handle: the range it froze, and the props it froze from. */
  const [held, setHeld] = useState<{ min: number; max: number; ofMin: number; ofMax: number } | null>(null);
  const live = { min: Math.min(min, value), max: Math.max(max, value) };
  const range = held !== null && held.ofMin === min && held.ofMax === max ? held : live;
  const release = () => setHeld(null);
  return (
    <input
      type="range"
      className="field-slider"
      aria-label={ariaLabel}
      min={range.min}
      max={range.max}
      step={step}
      value={value}
      onPointerDown={() => setHeld({ ...range, ofMin: min, ofMax: max })}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onChange={(e) => onChange(Number(e.target.value), held !== null)}
    />
  );
}

/**
 * THE CONFLICT MARKER, tier (b) — the design Eric approved on 2026-09-07
 * (docs/testing/response-2026-09-03b.md §3): "a small ≠ chip next to the
 * value, its tooltip naming the catalogue's figure, and a one-click 'use 12'
 * beside it. It sits there indefinitely without demanding anything." Not an
 * alert, so nothing to dismiss and nothing stored: the chip goes when the
 * value matches the catalogue again (this button, or typing it) or when the
 * part is detached — real edits, which persist like any other.
 *
 * The button is the accessible part — a real <button> in the tab order whose
 * name says what it does ("Use catalogue value 12 for Line count"); the ≠ is
 * its visual twin and is hidden from screen readers so the figure is not read
 * twice. `onUse` is the caller's: each field takes the figure through the same
 * commit a typed or picked value takes, so the limits table applies and one
 * undo takes it back.
 */
function CatalogueChip({ figure, label, tip, onUse }: {
  /** The catalogue's figure as this field shows values: "12", "914.4 mm", "Ripstop nylon". */
  figure: string;
  /** The field's own label, for the button's accessible name. */
  label: string;
  /** Names the row, its figure and the part's, for the mouse. */
  tip: string;
  onUse: () => void;
}) {
  return (
    <span className="catalogue-diff">
      <span className="catalogue-diff-mark" title={tip} aria-hidden="true">≠</span>
      <button type="button" className="finish-all-btn" title={tip}
        aria-label={`Use catalogue value ${figure} for ${label}`} onClick={onUse}>
        use {figure}
      </button>
    </span>
  );
}

/** A field label as a running name: "Drag coefficient (blank = auto)" → "Drag coefficient". */
const plainLabel = (label: string): string => label.replace(/\s*\([^)]*\)\s*$/, '');

/** A marker's figure as a number, where it is one (catalogueDifferences carries finite ones only). */
const markerNumber = (v: CatalogueDifference['have']): number | undefined => numOpt({ v }, 'v');

/**
 * Named-material dropdown (desktop material database). Picking one writes the
 * name + density into the node; "Custom" clears the name and keeps whatever
 * density is set. Densities: bulk kg/m³, surface kg/m², line kg/m.
 *
 * A material the node NAMES but this list does not hold still shows its own
 * name, as an extra option at the top. Reported 2026-09-01a: "anytime you pull
 * in a part from the database, it marks the material as Custom, even if the
 * database clearly shows the material."
 *
 * That was exactly right, and it was a display bug rather than a data one —
 * `presetPatch` writes both `materialName` and `density`, so the flight physics
 * was always correct. The dropdown simply had no option matching the name and
 * fell back to the empty value, which renders as "Custom". Measured on the
 * shipped catalogue: 4,697 of 4,723 rows carry a material, they use 145
 * distinct names, and only 18 of those are in this list — so 3,977 rows, 84 %
 * of the database, read "Custom" after being applied.
 *
 * "Custom" now means what it says: no name at all.
 */
function MaterialSelect({ label, list, nameKey, densityKey, densityUnit, node, onPatch, catalogue }: {
  label: string;
  list: MaterialDef[];
  nameKey: string;
  densityKey: string;
  densityUnit: string;
  node: ComponentNode;
  onPatch: (patch: Partial<ComponentNode>) => void;
  /** The conflict marker for this material, when the part's catalogue row names another. */
  catalogue?: { diff: CatalogueDifference; row: string; onUse: () => void };
}) {
  const current = node[nameKey];
  const named = typeof current === 'string' && current !== '' ? current : null;
  const known = named !== null && list.some((m) => m.name === named);
  // The node names a material this list has never heard of — a catalogue part's
  // own material, almost always. Offer it, selected, with the density the node
  // is actually flying, rather than silently calling it Custom.
  const foreign = named !== null && !known ? named : null;
  // A non-finite density is no density (audit row 522): the option would read "(NaN kg/m³)".
  const foreignDensity = numOpt(node, densityKey);
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        aria-label={label}
        value={named ?? ''}
        onChange={(e) => {
          const mat = list.find((m) => m.name === e.target.value);
          if (mat) onPatch({ [nameKey]: mat.name, [densityKey]: mat.density });
          // Re-picking the part's own material is a no-op, not a reason to
          // rewrite the density it came with.
          else if (e.target.value === foreign) { /* already applied */ }
          else onPatch({ [nameKey]: undefined });
        }}
      >
        <option value="">Custom</option>
        {foreign !== null && (
          <option value={foreign}>
            {foreign}{foreignDensity !== undefined ? ` (${foreignDensity} ${densityUnit})` : ''}
            {' — from the parts database'}
          </option>
        )}
        {list.map((m) => (
          <option key={m.name} value={m.name}>{m.name} ({m.density} {densityUnit})</option>
        ))}
      </select>
      {catalogue && (() => {
        const { diff, row, onUse } = catalogue;
        const name = diff.patch[nameKey];
        const figure = `${typeof name === 'string' && name ? `${name}, ` : ''}${String(diff.want)} ${densityUnit}`;
        const mine = `${typeof current === 'string' && current ? `${current}, ` : ''}${String(diff.have)} ${densityUnit}`;
        return (
          <CatalogueChip figure={figure} label={label} onUse={onUse}
            tip={`${row} in the catalogue: ${figure}. This part: ${mine}.`} />
        );
      })()}
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
 * Containers with no mass, CG or drag of their own (ComponentAssembly:
 * getComponentMass() = 0, isMassive() = false).
 *
 * An UNTICKED override on one of these describes a PHANTOM POINT MASS the
 * container contributes: the mass override gives that point its weight, the CG
 * override gives it its station, and Cd simply sums because drag is not
 * mass-weighted. Measured 2026-08-23 and pinned in orkEngine.test.ts:
 *   stage mass 1 kg unticked          -> base + 1 kg   (adds, does not set)
 *   stage Cd 1.0 unticked             -> base + 1.0    (0.60236 -> 1.60236)
 *   stage CG 0.1 m unticked, no mass  -> NO CHANGE — it is positioning 0 kg
 *   stage CG 0.1 m + mass 1 kg        -> exactly the point-mass average,
 *                                        (m0*cg0 + 1*0.1) / (m0 + 1)
 *
 * That last pair is the correction. This copy used to say an unticked CG "does
 * nothing at all", which is what it looks like on its own and is why the owner
 * reported it twice — but it is a no-op only while there is no mass to
 * position. One rule explains all three quantities instead of three unrelated
 * behaviours.
 */
const CONTAINER_TYPES = new Set(['stage', 'podset', 'parallelstage']);

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
function SubcomponentsToggle({ tree, node, quantity, valueKey, flagKey, onPatch }: {
  tree: RocketTree;
  node: ComponentNode;
  quantity: string;
  valueKey: string;
  flagKey: string;
  onPatch: (patch: Partial<ComponentNode>) => void;
}) {
  // suppressingAncestor's own reading of an override (audit row 522).
  const active = numOpt(node, valueKey) !== undefined;
  const hasChildren = (node.children?.length ?? 0) > 0;
  const blocker = node.id ? suppressingAncestor(tree, node.id, flagKey, valueKey) : null;

  if (blocker) {
    // Shown whether or not THIS component has a value of its own: its geometry
    // is being stood in for either way, so the explanation is owed regardless.
    return (
      <p className="override-suppressed" role="note">
        Not in use — <strong>{blockerName(blocker)}</strong>
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

/** Quick palette for the display color (the owner: basic colors one click away). */
const COLOR_PRESETS = [
  '#ffffff', '#1c1c1c', '#e34948', '#f5871f', '#f2c230',
  '#3fa34d', '#2a78d6', '#8e5bd1', '#9a978f', '#7a4a2b',
];

export function PropertyPanel({ tree, node, info, rocketInfo, recoveryContext, onPatch, onPatchAll, onAutoAlignFins }: {
  tree: RocketTree;
  node: ComponentNode;
  recoveryContext?: string | null;
  /** Engine-computed stats for THIS component (null while a build is broken). */
  info?: ComponentInfo | null;
  /**
   * Whole-rocket StaticInfo (null while a build is broken). Carried for the
   * controls that place a part against ROCKET quantities — the rail-button
   * auto-place needs the CG and the overall length, neither of which any
   * per-component figure can supply.
   */
  rocketInfo?: StaticInfo | null;
  onPatch: (patch: Partial<ComponentNode>) => void;
  /** Applies a patch to every component carrying those fields (bulk finish). */
  onPatchAll?: (patch: Partial<ComponentNode>) => void;
  /** Rotates overlapping sibling fin sets apart (tree/finAlign.ts). */
  onAutoAlignFins?: () => void;
}) {
  const { prefs } = usePrefs();
  /**
   * Every field's `<label htmlFor>` points at its own control through these
   * ids (audit 2026-09-22). Without one, a label names its first labelable
   * DESCENDANT — the unit chip's <select> on every field that shows a unit,
   * and on Surface finish the "→ all" button, so clicking the words "Surface
   * finish" rewrote the finish, and so the skin-friction drag, of every
   * component in the rocket.
   */
  const uid = useId();
  const idFor = (key: string) => `${uid}-${key}`;
  const [showPresets, setShowPresets] = useState(false);
  // Why an export button did nothing, and for WHICH component. Cleared on the
  // next attempt, and shown only while that component is the one selected, so
  // it never outlives the outline it is complaining about: a self-crossing-fin
  // warning used to sit under the next nose cone selected, because this is one
  // panel across selections unless its parent keys it (audit 2026-09-22).
  const [exportNoteFor, setExportNoteFor] = useState<{ id: string | undefined; text: string } | null>(null);
  const exportNote = exportNoteFor !== null && exportNoteFor.id === node.id ? exportNoteFor.text : null;
  const setExportNote = (text: string | null) =>
    setExportNoteFor(text === null ? null : { id: node.id, text });
  // What the limits table repaired in the last preset pick, and for WHICH
  // component — scoped like the export note above, for the same reason. The
  // picker has closed by the time the patch lands, so the panel says it.
  const [presetNoteFor, setPresetNoteFor] = useState<{ id: string | undefined; text: string } | null>(null);
  const presetNote = presetNoteFor !== null && presetNoteFor.id === node.id ? presetNoteFor.text : null;
  /**
   * A preset pick, held to the limits table on its way in (seam review of audit
   * 2026-09-22). The table was enforced by the typed commit below and by the
   * load boundary's sanitize pass, and a pick went through neither: the shipped
   * SEMROC HTC-11 stored a -10.668 mm wall and a CSV canopy of a million lines
   * a 540 kg chute, which a restored session then repaired with no word said.
   */
  const applyPreset = (patch: Partial<ComponentNode>) => {
    const notes: string[] = [];
    onPatch(limitPatch(node, patch, notes));
    setPresetNoteFor(notes.length > 0 ? { id: node.id, text: notes.join(' ') } : null);
  };

  /*
   * THE CONFLICT MARKER, tiers (b) and (c) (approved 2026-09-07; tier (a), the
   * import note, shipped in v0.115). A part linked to the parts catalogue — by
   * a pick, or by a file that named it — is held against its row, field by
   * field, under the one table in services/presets.ts (`catalogueDifferences`);
   * a field that differs by enough to matter gets a ≠ chip with a one-click
   * "use", and the part gets a Catalogue line naming the row, with Detach.
   * Nothing is stored about any of it. The catalogue (~1.3 MB, lazy) is fetched
   * only for a part that is linked, so a design with no links never loads it.
   */
  const linkPartNo = typeof node['presetPartNo'] === 'string' && node['presetPartNo'] !== ''
    ? node['presetPartNo'] : null;
  const linkMfr = typeof node['presetManufacturer'] === 'string' ? node['presetManufacturer'] : '';
  const linked = linkPartNo !== null && KIND_FOR_TYPE[node.type] !== undefined;
  /**
   * The catalogue is read again each time the preset picker closes: its CSV
   * import is the one place this browser's catalogue grows while the panel is
   * open, and a pick closes it too (wave 3 verifier: read once, the row the
   * user had just imported and picked was "not in this browser's catalogue",
   * with no markers, until the part was selected again). Only the first read
   * fetches the bundle; after it a read is the user's own presets, from
   * localStorage.
   */
  const [pickerCloses, setPickerCloses] = useState(0);
  const [read, setRead] = useState<{ after: number; presets: readonly Preset[] } | null>(null);
  useEffect(() => {
    if (!linked || read?.after === pickerCloses) return;
    // The `live` flag of every lazy catalogue load (PresetPicker, the recovery
    // panel): this panel is keyed by the part, and a selection can move on
    // before the bundle arrives.
    let live = true;
    // A failed load leaves the line naming the link with no markers on it —
    // nothing here claims the part matches.
    loadPresets().then((p) => { if (live) setRead({ after: pickerCloses, presets: p }); }, () => {});
    return () => { live = false; };
  }, [linked, pickerCloses, read]);
  // The last read stands until the next arrives, so the markers do not blink;
  // but only a read made since the picker last closed may say a row is missing.
  const catalogue = read?.presets ?? null;
  const catalogueIsCurrent = read !== null && read.after === pickerCloses;
  const row = useMemo(
    () => (linked && catalogue ? linkedPreset(node, catalogue) ?? null : null),
    [linked, catalogue, node],
  );
  const diffs = useMemo(() => (row ? catalogueDifferences(node, row) : []), [row, node]);
  const diffFor = (key: string): CatalogueDifference | undefined => diffs.find((d) => d.key === key);
  const rowName = row ? `${row.manufacturer} ${row.partNo}` : `${linkMfr} ${linkPartNo ?? ''}`.trim();
  // What Detach did, for WHICH part — scoped like the preset note above.
  const [detachNoteFor, setDetachNoteFor] = useState<{ id: string | undefined; text: string } | null>(null);
  const detachNote = detachNoteFor !== null && detachNoteFor.id === node.id ? detachNoteFor.text : null;
  /**
   * Tier (c)'s Detach: the link goes, through one ordinary tree edit (so one
   * undo puts it back), every value on the part stays, and the panel says so —
   * the markers vanish with the link, and a vanished marker should never be
   * mistaken for a part that now matches.
   */
  const detach = () => {
    onPatch(detachPatch());
    setDetachNoteFor({
      id: node.id,
      text: `Detached from ${rowName}. This part keeps every value it has; it is no longer compared `
        + 'with the catalogue, and a file saved from here no longer names that part. Undo puts the link back.',
    });
  };
  /**
   * The other half of a catalogue fact (a canopy's spill hole beside its Cd, a
   * material's name beside its density), or a figure with no box of its own,
   * held to the limits table a typed value meets — and a vent to its canopy,
   * the ceiling the spill-hole box applies (tree/canopyVent.ts).
   */
  const limitCatalogue = (patch: Partial<ComponentNode>): Partial<ComponentNode> => {
    const out = limitPatch(node, patch);
    const vent = out['spillHoleDiameter'];
    const cap = typeof vent === 'number' && node.type === 'parachute' ? ventLimit(node)?.maxHole : undefined;
    return cap !== undefined && (vent as number) > cap ? { ...out, spillHoleDiameter: cap } : out;
  };
  /** A canopy's or a line's material marker: the select's own edit, name and density together. */
  const materialMarker = (key: string) => {
    const d = diffFor(key);
    return d ? { diff: d, row: rowName, onUse: () => onPatch(limitCatalogue(d.patch)) } : undefined;
  };
  /** A length as the length boxes show one. */
  const lengthFigure = (si: number): string => `${fmtFieldValue(siToUi('length', prefs.units.length, si))} ${prefs.units.length}`;
  /**
   * The tooltip for a marker. A canopy's Cd and spill hole are one figure (the
   * maker's Cd is measured against the vented canopy), so either half's marker
   * names both and its "use" sets both.
   */
  const catalogueTip = (d: CatalogueDifference, figure: string, have: string): string => {
    if (node.type === 'parachute' && (d.key === 'cd' || d.key === 'spillHoleDiameter')) {
      const vent = (v: number | undefined) => (v !== undefined && v > 0 ? `a ${lengthFigure(v)} spill hole` : 'no spill hole');
      const cdNow = numOpt(node, 'cd');
      return `${rowName} in the catalogue: Cd ${fmtFieldValue(d.patch['cd'] as number)} with `
        + `${vent(numOpt(d.patch, 'spillHoleDiameter'))}. This part flies `
        + `${cdNow === undefined ? 'the automatic Cd' : `Cd ${fmtFieldValue(cdNow)}`} with `
        + `${vent(numOpt(node, 'spillHoleDiameter'))}. The maker measures the Cd against the vented `
        + 'canopy, so the two are one figure: “use” sets both.';
    }
    return `${rowName} in the catalogue: ${figure}. This part: ${have}.`;
  };
  const fields = FIELDS[node.type] ?? [];
  /**
   * The fields this panel draws a box for, where a conflict marker sits beside
   * the value; a difference anywhere else (a coupler's outside diameter, a
   * lug's material) is marked on the Catalogue line instead.
   */
  const placed = new Set<string>([...fields.map((f) => f.key), 'overrideMass']);
  if (node.type === 'parachute' || node.type === 'streamer') placed.add('surfaceDensity');
  if (node.type === 'parachute' || node.type === 'shockcord') placed.add('lineDensity');
  const parent = findParent(tree, node.id!);
  const positionable = POSITIONABLE.has(node.type) && parent !== 'stage';
  // Where the kernel flies it: a part with no position is NOT at Top, 0.
  const pos = positionOf(node);
  // The kernel's length (axialLength), as the drag and the snap ladder read
  // it — a cleared tube is its type's 300 mm, not 200 (audit 2026-09-30).
  const parentLenSi = parent && parent !== 'stage' ? axialLength(parent) : 0.2;

  /**
   * What the 🖨 button offers for this component: its caption, the one line
   * under it, and — only when the part does not fit the configured printer —
   * the segments to pack into a zip. With no printer configured this is the
   * untouched single-STL offer, which is the compatibility guarantee.
   *
   * Memoised because it plans the split and clips the profile; cheap in
   * absolute terms, but this panel re-renders on every keystroke in the fields
   * below and nothing here changes unless the node, the tree or the printer
   * does — the tree, because a ring's size comes from the tube it sits in
   * and that tube's own ancestors (tree/solidContext.ts).
   */
  const printer = prefs.printer;
  const offer = useMemo(
    () => (PRINTABLE.has(node.type)
      ? printOffer(node, solidContextFor(tree, node), toPrinterVolume(printer), printerName(printer))
      : null),
    [tree, node, printer],
  );

  const lengthSym = prefs.units.length;
  const lenToUi = (si: number) => Number(siToUi('length', lengthSym, si).toFixed(6));
  const lenFromUi = (ui: number) => uiToSi('length', lengthSym, ui);
  const massSym = prefs.units.mass;

  /**
   * Folded into BOTH override commits below: typing a mass or a CG by hand
   * takes this stage off the RASAero file's stated launch weight, so the mark
   * that says "a motor's weight is still in here" has to go with it
   * (services/statedLaunchWeight.ts; 2026-09-08, from review). Without it the
   * reconcile fired later against the USER's own measurement — subtracting a
   * motor from a number the file never stated, and saying the file's weight
   * "cannot be right" about it.
   *
   * `undefined` rather than a delete because `updateNode` spreads a patch and
   * cannot remove a key — the same shape the two clear-the-override commits
   * beside it already use. Every reader tests `typeof === 'string'`, and
   * `JSON.stringify` drops the key, so an undefined mark is an absent one.
   */
  const statedLaunchMark = typeof node[OVERRIDE_INCLUDES_MOTOR] === 'string'
    ? { [OVERRIDE_INCLUDES_MOTOR]: undefined }
    : {};

  /**
   * The wording of the stated-launch-weight banner below, which depends on
   * WHICH of the two overrides the file actually landed (2026-09-08, from
   * review — the banner said "the launch mass and CG" on the mark alone).
   *
   * The mark follows whichever override landed, not both: `rasaeroFile.ts`
   * writes the mass and the CG on separate paths, and either can be skipped on
   * its own — a stage stating a CG and no usable weight gets the CG alone, and
   * a stage whose CG works out to a place outside its own extent gets the mass
   * alone. Naming a figure that is not on screen sends the reader looking for
   * a blank field.
   */
  // The two overrides as the Overrides fields below show them, and as the
  // kernel reads them: a non-finite value is none (audit row 522).
  const massOverride = numOpt(node, 'overrideMass');
  const cgOverride = numOpt(node, 'overrideCGX');
  const statedMass = massOverride !== undefined;
  const statedCg = cgOverride !== undefined;
  const statedLaunchCopy = statedMass && statedCg
    ? {
      lead: 'These came from the RASAero file, with the motor still in them.',
      figures: 'They are the launch mass and CG the file states for this stage, and they still include',
      mine: 'both become yours',
      enter: 'so enter what the stage weighs, and where it balances, with no motor in it',
    }
    : {
      lead: 'This came from the RASAero file, with the motor still in it.',
      figures: `It is the launch ${statedMass ? 'mass' : 'CG'} the file states for this stage, and it still includes`,
      mine: 'it becomes yours',
      enter: statedMass
        ? 'so enter what the stage weighs with no motor in it'
        : 'so enter where the stage balances with no motor in it',
    };

  // Tube-fin collision geometry: N tubes around a body of radius R touch at
  // r = R·sin(π/N)/(1−sin(π/N)). The kernel enforces that only in auto mode
  // (blank radius); explicit values get the same ceiling here so neither the
  // slider nor typing can push the tubes into each other.
  const tubeFinBodyR = node.type === 'tubefinset' && parent && parent !== 'stage'
    && typeof parent['outerRadius'] === 'number' && (parent['outerRadius'] as number) > 0
    ? (parent['outerRadius'] as number)
    : null;

  /**
   * Where "in line with a fin" and "between two fins" actually are, for THIS
   * part on THIS parent — or null when the parent carries no fin set and the
   * question has no answer.
   *
   * Buttons, not a persistent snap MODE. Eric asked for "toggles", and a
   * sticky snap is the obvious reading, but it fights the field it sits on: the
   * angle is also a typed number and a slider, and a mode that quietly rewrites
   * what you type is the kind of control people turn off and never turn on
   * again. A one-shot button says exactly what it did, leaves the value
   * editable, and matches what the panel already does elsewhere ("→ all" on
   * finish, "Fit tab to motor tube", "🧭 Auto-align fin sets").
   *
   * Candidates come from the node's whole ANGULAR FRAME (frameContaining) —
   * every fin on the inline stack, however many tubes or stages away — cut
   * only at pod sets and parallel stages, whose sub-chains rotate as a unit.
   */
  const snapTargets = (() => {
    if (typeof parent === 'string' || !parent || !node.id) return null;
    // The node's whole ANGULAR FRAME, not just its siblings. The owner's report
    // (2026-08-31b): a pre-existing rail button on the tube above the fin can
    // got no snap buttons, while a freshly added one did — because Add attaches
    // under the selected tube, so new parts were born siblings of the fins and
    // old parts were not. The fin's plane runs the length of the stack; which
    // tube carries the part is irrelevant. frameContaining cuts only at pod
    // sets and parallel stages, whose sub-chains rotate as a unit.
    const members = frameContaining(tree, node.id) ?? (parent.children ?? []);
    const cur = num(node, 'angleOffset', 0);
    const onFin = nearestAngle(finAnglesAmong(members), cur);
    const between = nearestAngle(betweenFinAnglesAmong(members), cur);
    if (onFin === null || between === null) return null;
    const show = (rad: number) => {
      const sym = prefs.units.angle;
      return `${Number(siToUi('angle', sym, rad).toFixed(2))} ${sym}`;
    };
    return {
      inline: onFin,
      between,
      inlineTitle: `Put this in line with the nearest fin (${show(onFin)}). A camera shroud here has the fin in shot, and puts that fin in a wake the app does not model; a rail button here fouls the rail.`,
      betweenTitle: `Put this midway between two fins (${show(between)}) — clear of both.`,
    };
  })();

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

    // The stored value, if it is one the rocket can fly: a NaN or infinite one
    // shows as blank, with the default it flies in its place (the kernel reads
    // it as absent), rather than as "—" in the box and NaN or Infinity on the
    // slider (audit row 522).
    const raw = numOpt(node, f.key);
    const value = raw !== undefined ? toDisplay(raw) : undefined;

    // Cross-field ceilings for tube fins (issue 2026-08-05e): the outer
    // radius is capped by the touching radius for the current fin count, and
    // the fin count by how many tubes of the explicit radius fit. Blank
    // radius shows the auto (touching) value grayed so builders can read the
    // real as-built dimension without committing to an override.
    let maxSi: number | undefined;
    let maxCount: number | undefined;
    let autoPlaceholder: string | undefined;
    // The exact figure behind a numeric placeholder, in the display unit. The
    // placeholder is rounded for reading (fmtSig, NumField's own display rule);
    // the spinner steps from THIS. Both used to be one `toFixed(3)` string in
    // the display unit, which NumField parsed back as the spinner's base (audit
    // 2026-09-22): in metres the kernel's 9.7 mm rail button read
    // "default: 0.01", and one ▴ committed 10.5 mm instead of 10.2.
    let autoValue: number | undefined;
    if (tubeFinBodyR !== null && f.key === 'outerRadius') {
      const n = Math.round(num(node, 'finCount', 6));
      maxSi = tubeFinMaxRadius(n, tubeFinBodyR) ?? undefined;
      if (raw === undefined) {
        autoValue = toDisplay(tubeFinRadius(node, tubeFinBodyR));
        autoPlaceholder = `auto: ${fmtSig(autoValue, 3, 3)}`;
      }
    }
    if (tubeFinBodyR !== null && f.key === 'finCount') {
      const r = node['outerRadius'];
      if (typeof r === 'number' && r > 0) {
        maxCount = tubeFinMaxCount(r, tubeFinBodyR);
      }
    }
    // THE HARD LIMIT (audit 2026-09-22) — the same table the load boundary's
    // sanitize pass applies (schema.ts `fieldLimit`), so a typed or dragged
    // value can never be one a reopened file would have to repair. A count's
    // ceiling goes on the field itself, which CLAMPS a typed count to it
    // (NumField `clampToMax`, below): typing 12 fins stores 8 and flags the
    // box until blur shows 8 (the kernel flies at most 8, and the app used to
    // draw and export 12). Refusing it instead kept the "1" committed on the
    // way to "12" — a one-fin set. Bulk density also gets a typed ceiling
    // below, refusing absurd prefixes (register: "Typed one key at a time...").
    // The commit enforces the remaining bounds, including the positive floor
    // for a tube-fin length or shroud height that would fail a build at 0.
    const limit = fieldLimit(node.type, f.key);
    if (f.unit === 'count' && limit?.hmax !== undefined) {
      maxCount = Math.min(maxCount ?? Infinity, limit.hmax);
    }
    // Shape parameter: capped per shape (haack tops out at 1/3 = LV-Haack,
    // matching the kernel's setShapeParameter clamp); blank = kernel default.
    if (f.key === 'shapeParameter') {
      const sh = String(node['shape'] ?? (node.type === 'transition' ? 'conical' : 'ogive'));
      maxSi = shapeParamMax(sh);
      if (raw === undefined) {
        autoPlaceholder = `default: ${shapeParamDefault(sh)}`;
      }
    }
    // A vent cannot be bigger than the canopy it is cut in. engineTree clamps
    // the FLOWN hole to 0.95·D — silently, so the panel could show a 1 m vent
    // on a 0.3 m chute that the rocket was not flying, on the one control that
    // scales descent Cd. This is the same ceiling by construction: one rule,
    // tree/canopyVent.ts, with the 0.3 m fallback and the `> 0` guard.
    if (node.type === 'parachute' && f.key === 'spillHoleDiameter') {
      const vent = ventLimit(node);
      if (vent) maxSi = vent.maxHole;
    }
    // A rail button's five geometry dimensions did not exist as fields before
    // v0.103, so a button in a design saved earlier carries none of them and
    // these boxes come up empty. Empty must not read as "zero": the engine
    // falls back to the kernel constructor (RailButton.java:58-64) exactly as
    // the .ork reader and writer do, and it is that value the rocket is flying.
    // Same idiom as the shape-parameter default above.
    if (node.type === 'railbutton' && raw === undefined) {
      const dflt = RAILBUTTON_DEFAULTS[f.key];
      if (dflt !== undefined) {
        autoValue = toDisplay(dflt);
        autoPlaceholder = `default: ${fmtSig(autoValue, 3, 3)}`;
      }
    }
    // Every other blank that flies ONE known value — a new fin set's cant (0), a
    // new canopy's lines (6), a set saved with no fin count (3) — shows it and
    // steps from it the same way (seam review of audit 2026-09-22; schema.ts
    // `blankValue`). A blank with no such figure keeps no base, so NumField's
    // spinner stays inert on it, as the audit made it.
    if (raw === undefined && autoValue === undefined && autoPlaceholder === undefined) {
      const blank = blankValue(node.type, f.key);
      if (blank !== undefined) {
        autoValue = toDisplay(blank);
        autoPlaceholder = `default: ${fmtSig(autoValue, 3, 3)}`;
      }
    }
    // NumField rejects typed values above max — round the display cap up a
    // hair so typing the limit as NumField shows it (three decimals, or three
    // figures below 0.1) still lands; the commit clamp below keeps the stored
    // SI value exactly at the ceiling.
    const inputMaxSi = maxSi ?? (limit?.kind === 'density' ? limit.hmax : undefined);
    const maxUi = f.unit === 'count'
      ? maxCount
      : inputMaxSi !== undefined ? Math.ceil(toDisplay(inputMaxSi) * 1e4) / 1e4 : undefined;

    const label = asDiameter
      ? f.label.replace(/radius/gi, (m) => (m[0] === 'R' ? 'Diameter' : 'diameter'))
      : f.label;
    /** The accessible name for BOTH controls in this field. The visible
     *  `<label>` is wired to the typed box only — a label names one control —
     *  so the slider needs this, and it begins with the label's own words. */
    const fieldName = quantity ? `${label} (${symbol ?? ''})`.trim() : label;
    const inputId = idFor(f.key);
    const plainSuffix = PLAIN_SUFFIX[f.unit];

    // Step/range are authored in legacy units — convert, then snap the step
    // to a 1-2-5 value so spinners feel sane in any unit.
    const legacyToDisplay = (v: number) => quantity && symbol
      ? siToUi(quantity, symbol, v * legacy.toSI * geomFactor)
      : v * geomFactor;
    // `|| 1`, not `?? 1`: a schema step of ZERO must fall back too. `??`
    // substitutes only for undefined/null, so the one field that declares 0 —
    // schema.ts's `lenMM('spillHoleDiameter', …, 0, 500)` — reached
    // `niceStep(0)`, which returns 1 for any non-positive input. That 1 is in
    // the DISPLAY unit, not the field's legacy mm: with Preferences → length
    // set to m the spill-hole slider ran 0…0.5 in steps of 1 (one reachable
    // position, no vent settable at all) and one press of ▴ committed a 1 m
    // hole; with 'in' the step was 25.4 mm, with 'ft' 305 mm.
    const step = f.unit === 'count' ? 1 : niceStep(legacyToDisplay(f.step || 1));

    /**
     * One value for this field, in SI, held to every limit a typed value meets.
     * `partner` is the rest of a catalogue fact the conflict marker's "use"
     * takes with it (a canopy's spill hole with its Cd, a material's name with
     * its density) — empty for typing, the slider and the one-shot buttons.
     */
    const commitSi = (si: number, partner: Partial<ComponentNode> = {}) => {
      let next = f.unit === 'count' ? Math.max(f.smin ?? 1, Math.round(si)) : si;
      if (f.unit === 'count' && maxCount !== undefined) next = Math.min(next, maxCount);
      if (f.unit !== 'count' && maxSi !== undefined) next = Math.min(next, maxSi);
      // Last, so it wins over the cross-field caps above: a tube-fin count the
      // radius caps at 0 is still the kernel's minimum of 1.
      if (limit) next = applyFieldLimit(limit, next);
      // A finite entry can still convert to an infinite one: 1e306 g/cm³ is
      // 1e309 kg/m³, which is Infinity, and applyFieldLimit passes a non-finite
      // value through. Stored, the kernel flew the default density while a
      // saved .ork said density="Infinity" (claim check of the v0.141 notes).
      // NumField's validate check also flags the refused draft (register:
      // "Typed one key at a time, an overflowing density...").
      if (!Number.isFinite(next)) return;
      const patch: Partial<ComponentNode> = { ...limitCatalogue(partner), [f.key]: next };
      // A hand-typed density is no longer the named material's density.
      if (f.key === 'density' && !('materialName' in partner)) patch['materialName'] = undefined;
      onPatch(patch);
    };
    // A count's display value IS its SI value (no unit, never a radius).
    const commit = (ui: number) => commitSi(f.unit === 'count' ? ui : fromDisplay(ui));

    // The conflict marker on this field (tier b), when its catalogue row says otherwise.
    const diff = diffFor(f.key);
    const shownFigure = (si: number): string => (f.unit === 'count'
      ? String(si)
      : `${fmtFieldValue(toDisplay(si))}${symbol ? ` ${symbol}` : plainSuffix ? ` ${plainSuffix}` : ''}`);
    // The figure "use" writes: the row's, as this field flies it. Not the edit's
    // own value for the field, which is blank where the row's figure is the
    // field's blank — an unvented row's spill hole, the shape of 188 shipped
    // canopy rows — and a blank there drew no chip at all for a difference
    // catalogueDifferences had found. Typed, that figure is "0 = none".
    const want = diff ? markerNumber(diff.want) : undefined;
    const catalogueChip = diff && want !== undefined && (() => {
      const figure = shownFigure(want);
      const haveNum = markerNumber(diff.have);
      const have = diff.have === undefined ? 'the automatic value'
        : haveNum !== undefined ? shownFigure(haveNum) : String(diff.have);
      // A material density is named with its material, which "use" takes too.
      const named = (n: unknown, v: string) => (typeof n === 'string' && n ? `${n}, ${v}` : v);
      const tip = f.key === 'density'
        ? catalogueTip(diff, named(diff.patch['materialName'], figure), named(node['materialName'], have))
        : catalogueTip(diff, figure, have);
      const partner = Object.fromEntries(Object.entries(diff.patch).filter(([k]) => k !== f.key));
      return (
        <CatalogueChip figure={figure} label={plainLabel(label)} tip={tip}
          onUse={() => commitSi(want, partner)} />
      );
    })();

    // Negative input is valid only where the schema's slider dips below zero
    // (sweep, cant angle) — dimensions and counts reject a typed minus sign.
    const allowNegative = f.smin !== undefined && f.smin < 0;

    // K15 (open-items.md): blank still flies zero; this is a one-shot edit,
    // through the typed field's limits and undo path. Solid parts have no wall.
    const shoulderLengthKey = f.key === 'shoulderThickness'
      ? 'shoulderLength'
      : f.key === 'foreShoulderThickness' || f.key === 'aftShoulderThickness'
        ? f.key.replace('Thickness', 'Length') : undefined;
    const emptyShoulder = shoulderLengthKey !== undefined && (raw === undefined || raw === 0)
      && num(node, shoulderLengthKey, 0) > 0 && node['filled'] !== true;
    const wall = numOpt(node, 'thickness') ?? blankValue(node.type, 'thickness') ?? 0;
    const wallLabel = `${fmtSi('length', lengthSym, wall, 3)} ${lengthSym}`;

    const fieldLabel = (
      <label htmlFor={inputId}>
        {label}
        {quantity ? <> <UnitChip quantity={quantity} /></> : plainSuffix && ` (${plainSuffix})`}
      </label>
    );

    return (
      <div className="field" key={f.key}>
        {/* The snap buttons sit BESIDE the label, never inside it: a button
            inside a label is that label's control, so a click on the words
            would press it (see `uid`). */}
        {f.key === 'angleOffset' && snapTargets ? (
          <div>
            {fieldLabel}
            {' '}
            <button className="finish-all-btn" title={snapTargets.inlineTitle}
              onClick={() => onPatch({ angleOffset: snapTargets.inline })}>
              ▲ on a fin
            </button>
            {' '}
            <button className="finish-all-btn" title={snapTargets.betweenTitle}
              onClick={() => onPatch({ angleOffset: snapTargets.between })}>
              ⟂ between fins
            </button>
          </div>
        ) : fieldLabel}
        <NumField
          id={inputId}
          ariaLabel={fieldName}
          describedBy={emptyShoulder || f.help ? idFor(`${f.key}-hint`) : undefined}
          value={value}
          step={step}
          allowNegative={allowNegative}
          integer={f.unit === 'count'}
          min={f.unit === 'count' ? (f.smin ?? 1) : undefined}
          max={maxUi}
          validate={(v) => Number.isFinite(fromDisplay(v))}
          clampToMax={f.unit === 'count'}
          placeholder={autoPlaceholder}
          autoValue={autoValue}
          // Only a field whose blank MEANS something can be cleared; on any
          // other, an emptied box commits nothing and reverts on blur
          // (FieldDef.optional).
          nullable={f.optional === true}
          onCommit={(v) => {
            if (v === null) onPatch({ [f.key]: undefined });
            else commit(v);
          }}
        />
        {catalogueChip}
        {f.help && <p className="hint" id={idFor(`${f.key}-hint`)}>{f.help}</p>}
        {emptyShoulder && (
          <p className="hint" id={idFor(`${f.key}-hint`)}>
            Blank flies as 0 — this shoulder weighs nothing.
            {wall > 0 && <> A shoulder’s wall is usually the part’s wall thickness ({wallLabel}).{' '}
              <button type="button" className="finish-all-btn"
                onClick={() => commit(toDisplay(wall))}>Use {wallLabel}</button>
            </>}
          </p>
        )}
        {f.smin !== undefined && f.smax !== undefined && value !== undefined && (
          <ValueSlider
            ariaLabel={fieldName}
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
        {/* The label is wired by htmlFor, and the explicit aria-label stays:
            these two were once announced as a bare "edit text" and "color
            picker", and every other control in the panel carries one. */}
        <label htmlFor={idFor('name')}>Name</label>
        <input id={idFor('name')} aria-label="Component name"
          value={node.name ?? ''} onChange={(e) => onPatch({ name: e.target.value })} />
      </div>
      {KIND_FOR_TYPE[node.type] && (
        <button className="file-btn" style={{ marginTop: 6, width: '100%' }}
          onClick={() => setShowPresets(true)}>
          📦 Choose from preset database…
        </button>
      )}
      {(linked || detachNote) && (
        <>
          {/* Tier (c): the row this part is linked to, with Detach — and the
              marker for any figure that has no box of its own in this panel
              (a coupler's outside diameter, a lug's material). */}
          {linked && (
            <div className="catalogue-line">
              <span>
                Catalogue: <strong>{rowName}</strong>
                {catalogueIsCurrent && !row && ' — not in this browser’s catalogue, so nothing here is compared with it'}
              </span>
              <button type="button" className="finish-all-btn" onClick={detach}
                aria-label={`Detach from the catalogue: ${rowName}`}
                title="Unlink this part from its catalogue row. Every value stays as it is; the part is no longer compared with the catalogue.">
                Detach
              </button>
              {diffs.filter((d) => !placed.has(d.key)).map((d) => {
                const radius = /Radius$/.test(d.key);
                const asDia = radius && prefs.radiusMode === 'diameter';
                const words = asDia ? d.words.replace(/radius/g, 'diameter') : d.words;
                const fig = (v: unknown): string => {
                  if (typeof v !== 'number') return String(v);
                  if (d.key === 'density') {
                    return `${fmtFieldValue(siToUi('density', prefs.units.density, v))} ${prefs.units.density}`;
                  }
                  return /Radius$|^length$|Length$|^thickness$/.test(d.key) ? lengthFigure(asDia ? v * 2 : v) : fmtFieldValue(v);
                };
                const figure = fig(d.want);
                return (
                  <span key={d.key} className="catalogue-diff-item">
                    {words}:{' '}
                    <CatalogueChip figure={figure} label={words}
                      tip={catalogueTip(d, figure, d.have === undefined ? 'nothing stated' : fig(d.have))}
                      onUse={() => onPatch(limitCatalogue(d.patch))} />
                  </span>
                );
              })}
            </div>
          )}
          {/* Mounted while the part is linked, so Detach's sentence lands in a
              live region that already exists (PresetPicker's note, for why). */}
          <div role="status">
            {detachNote && <p className="print-note">{detachNote}</p>}
          </div>
        </>
      )}
      {presetNote && (
        <p className="print-note print-note-warn" role="status">{presetNote}</p>
      )}
      {(node.type === 'trapezoidfinset' || node.type === 'ellipticalfinset'
        || node.type === 'freeformfinset') && (
        <button className="file-btn" style={{ marginTop: 6, width: '100%' }}
          title="True-scale SVG cut template — print at 100% or send to a laser cutter; includes the through-the-wall tab and a 50 mm calibration ruler"
          onClick={() => {
            // The exporters' context, so the paper tab is clamped to the body
            // radius exactly as the ✂ and 🖨 files clamp theirs.
            const svg = finTemplateSvg(node, tree.name ?? 'Rocket', solidContextFor(tree, node));
            downloadBlob(new Blob([svg], { type: 'image/svg+xml' }),
              `${safeName(node.name ?? 'fin', 'fin')}-template.svg`, 'SVG cut template');
          }}>
          📐 Fin template (SVG, 1:1)
        </button>
      )}
      {DXF_CUTTABLE.has(node.type) && (
        // Scissors, NOT the 📐 the fin-template button above already owns. The
        // two sit adjacent, and with a shared glyph a user scanning for the
        // laser export stops at the print-and-trace template instead.
        <button className="file-btn" style={{ marginTop: 6, width: '100%' }}
          title="Flat 1:1 cut profile as R12 DXF in millimetres — for laser/router/waterjet CAM and Fusion 360 sketch import. Fin sets export ONE fin as a single closed contour with the through-the-wall tab merged into it (airfoil shaping, cant and sweep-into-the-tube are NOT represented); rings, bulkheads and couplers take their own stated diameter, else the bore of the tube, coupler, nose or transition they sit in (the label says so when neither can be found), and a centering ring's bore from its own stated ID, else the motor mount. Cut geometry is on the CUT layer only — REFERENCE (root chord, centre marks) and TEXT are guides; switch them off before cutting."
          onClick={() => {
            const dxf = componentDxf(node, solidContextFor(tree, node), tree.name ?? 'Rocket');
            // Same reason as the STL button below: componentDxf returns null for
            // a planform that collapses under three distinct corners, and a
            // button that silently does nothing reads as a broken button.
            if (!dxf) {
              setExportNote(node.type.endsWith('finset')
                ? 'This fin outline crosses itself or encloses no area — fix the '
                  + 'fin points before exporting.'
                : 'Nothing to cut for this component.');
              return;
            }
            setExportNote(null);
            downloadBlob(new Blob([dxf.text], { type: DXF_MIME }),
              `${safeName(node.name ?? dxf.label, safeName(dxf.label))}-cut.dxf`, 'DXF cut profile');
          }}>
          ✂ DXF (CNC/laser, 1:1)
        </button>
      )}
      {PRINTABLE.has(node.type) && (
        <>
          <button className="file-btn" style={{ marginTop: 6, width: '100%' }}
            title={offer?.kind === 'split'
              ? 'This part is taller than your printer, so it exports as a ZIP: one STL per segment plus a README with the print orientation, the glue, and the shrinkage rule that decides whether the halves fit each other. Each cut adds a tapered spigot and a flat land — the land sets the assembled length, so nothing is lost at the joint.'
              : 'Watertight solid STL in millimetres, ready to slice. Hollow noses/transitions include shoulders and end caps at your wall thickness; fin sets export ONE fin as a flat prism with its tab (airfoil/cross-section shaping is left to sanding, cant not baked); rings, bulkheads and couplers take their own stated diameter, else the bore of the tube, coupler, nose or transition they sit in (a warning appears under this button when neither can be found). Verify fit before a long print.'}
            // eslint-disable-next-line @typescript-eslint/no-misused-promises -- every await is inside the try below, whose catch reports into exportNote, so the promise React drops cannot reject
            onClick={async () => {
              // Every await below can reject — the mesher, the print-pack
              // builder, a lazily loaded chunk offline — and a rejection here
              // was unhandled: the same silently dead button the null case
              // below exists to prevent. It says why, in the same note
              // (audit 2026-09-22).
              try {
                // Split path: a zip of segments. Everything else — no printer, a
                // part that fits, a part that cannot be split — takes the single
                // STL path below, byte-for-byte and filename-for-filename what
                // this button has always produced.
                if (offer?.kind === 'split' && offer.split) {
                  const vol = toPrinterVolume(printer);
                  if (!vol) return;
                  const name = node.name ?? offer.split.label;
                  const pack = await buildPrintPack(offer.split, name, vol, printerName(printer));
                  downloadBlob(new Blob([pack.bytes as BlobPart], { type: ZIP_MIME }),
                    pack.filename, 'ZIP of printable segments');
                } else {
                  const solid = await componentSolid(node, solidContextFor(tree, node));
                  // componentSolid now returns null for a fin whose planform is
                  // unusable as well as for a type that is not printable, and a
                  // button that silently does nothing reads as a broken button.
                  if (!solid) {
                    setExportNote(node.type.endsWith('finset')
                      ? 'This fin outline crosses itself or encloses no area — fix the '
                        + 'fin points before exporting.'
                      : 'Nothing to export for this component.');
                    return;
                  }
                  setExportNote(null);
                  // Loaded on click: stlExport imports the whole three.js
                  // namespace, and this panel renders on the design screen.
                  const { solidToStl, STL_MIME } = await import('../services/stlExport.js');
                  const stl = solidToStl(solid.mesh, node.name ?? solid.label);
                  downloadBlob(new Blob([stl as BlobPart], { type: STL_MIME }),
                    `${safeName(node.name ?? solid.label, safeName(solid.label))}-print.stl`, 'STL 3D print');
                }
              } catch (e) {
                setExportNote(`Couldn't export this part: ${e instanceof Error ? e.message : String(e)}`);
              }
            }}>
            {offer?.button ?? SINGLE_BUTTON}
          </button>
          {offer?.note && (
            <p className={offer.tone === 'warn' ? 'print-note print-note-warn' : 'print-note'}>
              {offer.note}
            </p>
          )}
          {exportNote && (
            <p className="print-note print-note-warn" role="alert">{exportNote}</p>
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
      {node.type === 'railbutton' && (() => {
        // One-shot AUTO-PLACE: the pair across the CG and an inch off the
        // tail — the rule is services/railButtonPlacement.ts; the words are here.
        if (!rocketInfo || !info || !parent || parent === 'stage') return null;
        const at = railButtonPlacement(node, {
          rocketLength: rocketInfo.length, cg: rocketInfo.cg, positionX: info.positionX, parentLength: parentLenSi,
        });
        const mm = (m: number) => (m * 1000).toFixed(0);
        return (
          <button className="file-btn" style={{ marginTop: 6, width: '100%' }}
            disabled={!at.feasible}
            title={at.feasible
              ? `Places two buttons: forward one at the CG (${mm(at.fwdX)} mm — the loaded CG when a motor is loaded), aft one ${mm(RAIL_BUTTON_AFT_GAP)} mm from the aft end. Press again after the CG moves; typed values always win afterwards.`
              : !at.fits
                ? `Both buttons would have to sit outside this tube (they want ${mm(at.fwdX)}–${mm(at.aftX)} mm from the nose; this tube spans ${mm(at.parentStart)}–${mm(at.parentEnd)} mm). Move the rail button to the tube that spans the CG and the aft end, or place them by hand.`
                : 'The CG sits within an inch of the aft end — two buttons cannot straddle it. Place them by hand.'}
            onClick={() => onPatch(at.patch as Partial<ComponentNode>)}>
            📍 Auto-place rail buttons
          </button>
        );
      })()}
      {showPresets && (
        <PresetPicker type={node.type} node={node} onApply={applyPreset} onClose={() => {
          setShowPresets(false);
          // Its CSV import may have added the very row this part names.
          setPickerCloses((n) => n + 1);
        }} />
      )}
      <div className="field" style={{ marginTop: 6 }}>
        <label htmlFor={idFor('color')}>Color (2D/3D display)</label>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="color" id={idFor('color')} aria-label="Component color" style={{ width: 44, padding: 2, height: 26 }}
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
      {(node.type === 'parachute' || node.type === 'streamer') && recoveryContext && (
        <p className="comp-stats">{recoveryContext}</p>
      )}
      <div className="field-grid" style={{ marginTop: 8 }}>
        {fields.map((f) => {
          if (f.key === 'maxMotorLength') {
            return node['motorMount'] === true ? <MotorLengthField key={f.key}
              mountName={node.name ?? 'Motor mount'} value={motorLengthLimit(node)}
              onCommit={(value) => onPatch({ maxMotorLength: value })} /> : null;
          }
          // Conical and ellipsoid profiles have no shape parameter.
          if (f.key === 'shapeParameter'
              && !shapeUsesParameter(String(node['shape'] ?? (node.type === 'transition' ? 'conical' : 'ogive')))) {
            return null;
          }
          // A plate angle only means anything for the inclined-flat-plate class.
          if (f.key === 'plateAngle' && protuberanceClass(node) !== 'plate') {
            return null;
          }
          if (f.bool) {
            // Sub-minimum only makes sense on a tube that already IS a mount.
            if (f.key === 'caseAirframe' && node['motorMount'] !== true) return null;
            const bdiff = diffFor(f.key);
            return (
              <div className="field" key={f.key} style={{ justifyContent: 'flex-end' }}>
                <label title={f.key === 'caseAirframe'
                  ? 'Sub-minimum build: the motor case IS the outer airframe (fins bond straight to the case, or propellant is cast into this tube). The motor browser then fits motors to this tube’s OUTER diameter. The motor file’s weight should include the case; keep the wall at 0 unless this tube adds real structure on top of it.'
                  : undefined}>
                  <input
                    type="checkbox"
                    // `f.dflt` is what an ABSENT key means. Without it a
                    // default-ON flag reads as OFF for every file saved before
                    // the field existed — the box says one thing and the
                    // drawing does another. See schema.FieldDef.dflt.
                    checked={node[f.key] === undefined ? f.dflt === true : node[f.key] === true}
                    onChange={(e) => onPatch({ [f.key]: e.target.checked })}
                    style={{ width: 'auto', marginRight: 6 }}
                  />
                  {f.label}
                </label>
                {/* Beside the label, never inside it: a button inside a label
                    is that label's control (see `uid`). */}
                {bdiff && typeof bdiff.want === 'boolean' && (() => {
                  const want = bdiff.want;
                  const word = (v: unknown) => (f.key === 'filled' ? (v ? 'solid' : 'hollow') : v ? 'on' : 'off');
                  return (
                    <CatalogueChip figure={word(want)} label={plainLabel(f.label)}
                      tip={catalogueTip(bdiff, word(want), word(bdiff.have))}
                      onUse={() => onPatch({ [f.key]: want })} />
                  );
                })()}
              </div>
            );
          }
          if (f.options) {
            const selectLabel = <label htmlFor={idFor(f.key)}>{f.label}</label>;
            const sdiff = diffFor(f.key);
            return (
              <div className="field" key={f.key}>
                {/* "→ all" sits BESIDE the label. Inside it, the button was the
                    label's control, and a click on the words "Surface finish"
                    rewrote the finish of every component (audit 2026-09-22). */}
                {f.key === 'finish' && onPatchAll ? (
                  <div>
                    {selectLabel}
                    {' '}
                    <button className="finish-all-btn"
                      title="Apply this finish to every component"
                      onClick={() => onPatchAll({ finish: node['finish'] ?? 'normal' })}>
                      → all
                    </button>
                  </div>
                ) : selectLabel}
                <select
                  id={idFor(f.key)}
                  aria-label={f.label}
                  // An unset select shows what the READERS fall back to, never
                  // options[0]. Those two disagreed until v0.088: unset finish
                  // means the engine's 'normal' (regular paint) but showed
                  // "Rough", and an unset camera-shroud shape showed
                  // "Streamlined" while every drawing and the physics used
                  // half-round.
                  //
                  // `f.dflt` covers the plain case. RESOLVE_SELECT covers the
                  // case where the value is not a plain default but a
                  // MIGRATION: a pre-v0.088 shroud carries one `fairingShape`
                  // and no per-end key, and the answer for the dropdown is
                  // whatever `shroudEnds` migrates it to — which is the same
                  // function the drawing, the physics and the writer use. The
                  // resolver exists so there is still exactly one declaration.
                  value={String(RESOLVE_SELECT[f.key]?.(node) ?? node[f.key] ?? f.dflt ?? f.options[0]![0])}
                  onChange={(e) => onPatch({ [f.key]: e.target.value })}
                >
                  {f.options.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
                {sdiff && typeof sdiff.want === 'string' && (() => {
                  // A catalogue shape comes with its default parameter, as a
                  // pick does: its "use" sets both (catalogueDifferences).
                  const named = (v: unknown) => f.options!.find(([o]) => o === v)?.[1] ?? String(v);
                  const figure = named(sdiff.want);
                  return (
                    <CatalogueChip figure={figure} label={plainLabel(f.label)}
                      tip={catalogueTip(sdiff, figure, named(sdiff.have))}
                      onUse={() => onPatch(limitCatalogue(sdiff.patch))} />
                  );
                })()}
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
          // in sync with the body tube behind them. Finite values only (audit
          // row 522): with a NaN radius the box read "—", and a diameter typed
          // into it committed a NaN wall.
          const outerR = numOpt(node, 'outerRadius')
            ?? (node.type === 'nosecone' ? numOpt(node, 'aftRadius') : undefined);
          const wall = numOpt(node, 'thickness');
          if (f.key === 'thickness' && outerR !== undefined && wall !== undefined) {
            const innerSi = Math.max(0, outerR - wall) * 2;
            const idQuantity: Quantity = 'length';
            const idSym = prefs.units[idQuantity];
            return (
              <Fragment key={f.key}>
                {renderNumeric(f)}
                <div className="field">
                  <label htmlFor={idFor('innerDiameter')}>
                    {node.type === 'nosecone' ? 'Base inner diameter' : 'Inner diameter'}
                    {' '}<UnitChip quantity="length" />
                  </label>
                  <NumField
                    id={idFor('innerDiameter')}
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
            node={node} onPatch={onPatch} catalogue={materialMarker('surfaceDensity')} />
        )}
        {(node.type === 'parachute' || node.type === 'shockcord') && (
          <MaterialSelect label={node.type === 'parachute' ? 'Line material' : 'Cord material'}
            list={LINE_MATERIALS}
            nameKey="lineMaterialName" densityKey="lineDensity" densityUnit="kg/m"
            node={node} onPatch={onPatch} catalogue={materialMarker('lineDensity')} />
        )}
      </div>
      {/* Say what the coefficient IS. The two streamlined classes are not
          constants any more — RASAero's Streamlined Protuberance method makes
          the drag per unit frontal area equal to the rocket BODY's own, so the
          Cd shown is this design's measured body CD (see treeModel
          .bodyDragReference). A user who cannot see where 0.354 came from
          cannot check us, so the sentence names the method, prints BOTH body
          CDs it measured, and says which Mach they were taken at. */}
      {/* Shared by the protuberance and shroud blocks below. Both synthesize
          their whole physics as an `overrideCD` at the engine boundary, and the
          kernel DISCARDS a component's CD when an ancestor overrides Cd with
          "Use instead of everything inside" ticked — so both must say when the
          figure they print is not reaching the flight. Fixing only one of them
          is how the same defect survives in the other. */}
      {(node.type as string) === 'protuberance' && (() => {
        // Both rules come from treeModel, so the panel cannot explain a Cd the
        // engine did not use: resolving the class here with String(...) gave a
        // class protuberanceClass never returns whenever dragClass was present
        // but not a string, and the explanation below was then skipped.
        const cls = protuberanceClass(node);
        const explicit = protuberanceExplicitCd(node) !== null;
        // A typed 0 is not an override (protuberanceExplicitCd) — but the field
        // still shows the 0, so the sentence has to account for it.
        const zeroed = !explicit && node['cdFrontal'] === 0;
        const streamlined = !explicit && (cls === 'streamlined' || cls === 'streamlinedbase');
        const body = streamlined ? bodyDragReference(tree) : null;
        const cdBlocker = node.id
          ? suppressingAncestor(tree, node.id, 'overrideSubcomponentsCD', 'overrideCD')
          : null;
        return (
          <p className="comp-stats" style={{ marginTop: 6 }}>
            {(protuberanceFrontalArea(node) * 1e6).toFixed(0)} mm² frontal
            {' × '}Cd {protuberanceCd(tree, node).toFixed(3)}
            {' = '}<strong>+{protuberanceDeliveredCd(tree, node).toFixed(5)}</strong> on the
            rocket&rsquo;s CD
            {/* "at every Mach" is TRUE for the flat classes and FALSE for the
                two streamlined ones since v0.103: those hand the kernel the area
                ratio and it re-evaluates them against the body CD at the Mach
                being flown, so this figure is the Mach 0.3 reading, not the
                whole flight's. `body` is non-null exactly when that is the case
                (streamlined class AND no typed Cd), so it is the right test. */}
            {body ? <> at Mach {body.mach}.</> : ', at every Mach.'}
            {explicit && ' The Cd is the one you typed — a fixed number at every Mach.'}
            {zeroed && ' A typed 0 is not an override — blank and 0 both mean “from the class”.'}
            {body && (
              <>
                {' '}The Cd is not a table value: RASAero&rsquo;s Streamlined
                Protuberance method sets a streamlined bump&rsquo;s drag per unit
                frontal area equal to the rocket <em>body</em>&rsquo;s, so this is
                your own body&rsquo;s CD{' '}
                {cls === 'streamlined' ? 'excluding' : 'including'} base drag
                {body.measured
                  ? <> at Mach {body.mach} (body CD {body.noBase.toFixed(3)} without
                      base drag, {body.withBase.toFixed(3)} with).</>
                  : <> — but the kernel could not evaluate this design, so a
                      placeholder body CD ({body.noBase.toFixed(3)} /{' '}
                      {body.withBase.toFixed(3)}) is standing in.</>}
                {' '}In flight it is re-evaluated at every Mach against your
                body&rsquo;s own CD, so the bump&rsquo;s drag rises through the
                transonic peak and falls away above it exactly as the airframe
                does — the figure above is the Mach {body.mach} reading, not a
                constant the whole flight is charged. Type a Cd above only if you
                want it pinned to a fixed number instead.
              </>
            )}
            {cdBlocker && <CdBlockedNotice blocker={cdBlocker} replaces="this one" />}
            {' '}Drag only — a protuberance adds no normal force and does not
            move the CP, the same as RASAero.
            {' '}For real rail buttons prefer the <em>Rail button</em> component:
            it gets OpenRocket&rsquo;s own Mach- and boundary-layer-dependent model.
          </p>
        );
      })()}

      {/* A shroud's drag was computed on every keystroke and shown nowhere —
          the same shape of gap that let the rotational-inertia fault survive
          two years (v0.088). v0.090 both CHANGED this number and put it on
          screen, in that order where it could not be: the sentence names the
          area, the coefficient and the delivered CD, and says the area is
          measured from the tube rather than from the shroud's own flat base,
          because that is the part a reader cannot derive from the fields
          above. Every figure comes from treeModel, so the panel cannot print
          an area the kernel did not use. */}
      {node.type === 'fairing' && (() => {
        // Read as fairingFrontalArea reads them (audit row 522), so the flat
        // part and the crescent split the area it returns.
        const W = num(node, 'width', 0.025);
        const H = num(node, 'height', 0.02);
        const area = fairingFrontalArea(tree, node);
        const flat = Math.max(0, W) * Math.max(0, H);
        const bodyR = mountRadiusOf(parent === 'stage' ? null : (parent as ComponentNode | null));
        const crescent = area - flat;
        // An ancestor with "Use instead of everything inside" ticked on its Cd
        // replaces this component's contribution wholesale — the kernel skips a
        // covered component in the friction, pressure and base loops alike. So
        // the figure below is what the shroud WOULD add, not what the rocket is
        // flying, and saying "+0.03593 on the rocket's CD, at every Mach" with
        // no qualifier is exactly the kind of number-stated-as-fact this panel
        // has printed wrongly before.
        const cdBlocker = node.id
          ? suppressingAncestor(tree, node.id, 'overrideSubcomponentsCD', 'overrideCD')
          : null;
        return (
          <p className="comp-stats" style={{ marginTop: 6 }}>
            {(area * 1e6).toFixed(0)} mm² frontal
            {' × '}Cd {fairingCd(node).toFixed(3)}
            {' = '}<strong>+{fairingDeliveredCd(tree, node).toFixed(5)}</strong> on the
            rocket&rsquo;s CD, at every Mach.
            {crescent > 1e-12 && bodyR > 0 ? (
              <>
                {' '}The area is measured from the <em>tube surface</em>, not from the
                shroud&rsquo;s own base: {(flat * 1e6).toFixed(0)} mm² of shroud plus{' '}
                {(crescent * 1e6).toFixed(0)} mm² of the gap its flat underside leaves
                over a {(bodyR * 2000).toFixed(0)} mm tube, which the flow is blocked by
                either way. Conformal or not makes no difference to this — a conformal
                shroud fills that gap with material instead of dead air.
              </>
            ) : (
              <>
                {' '}The area is measured from the tube surface; with no body radius to
                read here it falls back to width × height.
              </>
            )}
            {' '}The coefficient is a Hoerner surface-protuberance value for the two end
            shapes, and it has no wind-tunnel anchor of its own — treat the shroud&rsquo;s
            drag as an estimate with a stated method, not a measurement.
            {cdBlocker && <CdBlockedNotice blocker={cdBlocker} replaces="this shroud’s" />}
          </p>
        );
      })()}

      {(node.type === 'trapezoidfinset' || node.type === 'freeformfinset'
        || node.type === 'ellipticalfinset') && (() => {
        // Tab depth to the motor tube, or the wall; a new tab 60 % of the root
        // chord (tree/fitHelpers.ts).
        const tab = finTabFit(node, parent);
        if (!tab) return null;
        return (
          <button
            className="file-btn"
            style={{ marginTop: 6 }}
            title={tab.toMount
              ? `Set tab depth to reach the motor tube (${lenToUi(tab.depth)} ${lengthSym})`
              : `No motor tube found — set tab depth to the tube wall (${lenToUi(tab.depth)} ${lengthSym})`}
            onClick={() => onPatch(tab.patch)}
          >
            Fit tab to motor tube
          </button>
        );
      })()}

      {node.type === 'nosecone' && (() => {
        // The shoulder into the tube behind the nose — ahead of a tail cone
        // (tree/fitHelpers.ts).
        const shoulder = shoulderFit(tree, node, parent);
        if (!shoulder) return null;
        const shown = prefs.radiusMode === 'diameter' ? shoulder.innerR * 2 : shoulder.innerR;
        return (
          <button
            className="file-btn"
            style={{ marginTop: 6 }}
            title={`Set the shoulder to the adjacent tube's inner ${prefs.radiusMode} (${lenToUi(shown)} ${lengthSym})`}
            onClick={() => onPatch(shoulder.patch)}
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

      {/* No Overrides block for a protuberance. Its whole physics IS a CD
          override synthesized at the engine boundary (treeModel.engineTree),
          and its mass is a mass override — so a figure typed here would be
          overwritten on the way to the kernel while looking live and surviving
          a .ork round-trip. That is exactly the trap the fairing component
          still carries (findings-2026-08-22-import-fidelity.md item 8); the
          Cd escape hatch that item asks for is the "Cd on frontal area" field
          above. */}
      {(node.type as string) !== 'protuberance' && (
      <div style={{ marginTop: 10 }}>
        <h3 style={{ marginTop: 0 }}>
          Overrides (blank = calculated)
          {node.type === 'stage' ? ' — whole stage' : ''}
        </h3>
        {/* The one state where the two fields below are NOT the user's own
            numbers: a RASAero stage still holding the weight of a motor the
            catalogue does not have (services/statedLaunchWeight.ts). Until
            2026-09-08 nothing here said so and nothing here cleared the mark,
            so a user who typed their own weighed mass over the file's figure
            had it silently reduced by a motor's weight the next time one was
            loaded — and the note blamed a file that never stated their number.
            Both halves are fixed: this panel says what the figures are, and
            typing either one takes the stage off the file's stated weight
            (`statedLaunchMark` in the two commits below). */}
        {typeof node[OVERRIDE_INCLUDES_MOTOR] === 'string' && node[OVERRIDE_INCLUDES_MOTOR] !== '' && (
          <p className="override-inert override-stated-launch" role="note">
            <strong>{statedLaunchCopy.lead}</strong>
            {' '}{statedLaunchCopy.figures} the weight of the
            “{node[OVERRIDE_INCLUDES_MOTOR] as string}” it names — that
            motor matched no motor in the motor database when the file was imported, so nothing
            could take it out. Load a motor of that name and the app takes its weight back out
            first, and any other motor clears these figures instead; Browse motor database on
            Motors &amp; Launch takes an .eng or .rse file. Type your own figure here instead and {statedLaunchCopy.mine} —{' '}
            {statedLaunchCopy.enter}.
          </p>
        )}
        <div className="field-grid">
          <div className="field">
            <label htmlFor={idFor('overrideMass')}>Mass{node.type.endsWith('finset') ? ' (all fins combined)' : ''} <UnitChip quantity="mass" /></label>
            <NumField
              id={idFor('overrideMass')}
              ariaLabel="Mass override"
              value={massOverride !== undefined ? siToUi('mass', massSym, massOverride) : undefined}
              step={niceStep(siToUi('mass', massSym, 0.0001))}
              nullable
              placeholder={info ? fmtSi('mass', massSym, info.mass) : undefined}
              // The spinner steps from the computed figure itself, not from the
              // placeholder's rounding of it: in kg a 4.5 g part reads "0.004",
              // and ▴ committed 4.1 g (audit 2026-09-22, as `autoValue` above).
              autoValue={info ? siToUi('mass', massSym, info.mass) : undefined}
              onCommit={(v) => onPatch(v === null
                ? { overrideMass: undefined, overrideSubcomponentsMass: undefined, ...statedLaunchMark }
                : { overrideMass: uiToSi('mass', massSym, v), ...statedLaunchMark })}
            />
            {(() => {
              // A mass this part states against the one its catalogue row
              // publishes (never the computed mass — catalogueDifferences).
              const md = diffFor('overrideMass');
              const want = md ? numOpt(md.patch, 'overrideMass') : undefined;
              if (!md || want === undefined) return null;
              const fig = (v: number) => `${fmtFieldValue(siToUi('mass', massSym, v))} ${massSym}`;
              const have = markerNumber(md.have);
              return (
                <CatalogueChip figure={fig(want)} label="Mass"
                  tip={catalogueTip(md, fig(want), have !== undefined ? fig(have) : String(md.have))}
                  onUse={() => onPatch({ ...limitCatalogue({ overrideMass: want }), ...statedLaunchMark })} />
              );
            })()}
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
            <label htmlFor={idFor('overrideCGX')}>CG from component top <UnitChip quantity="length" /></label>
            <NumField
              id={idFor('overrideCGX')}
              ariaLabel="CG override, from component top"
              value={cgOverride !== undefined ? lenToUi(cgOverride) : undefined}
              step={niceStep(siToUi('length', lengthSym, 0.001))}
              allowNegative
              nullable
              placeholder={info ? fmtSi('length', lengthSym, info.cgX, 3) : undefined}
              autoValue={info ? lenToUi(info.cgX) : undefined}
              // Through the limits table, as a schema field's commit is: typed
              // 5000 m it stored and flew 5000 m until a reload's sanitize pass
              // cut it to 1 km (audit 2026-09-30).
              onCommit={(v) => onPatch(v === null
                ? { overrideCGX: undefined, overrideSubcomponentsCG: undefined, ...statedLaunchMark }
                : { ...limitPatch(node, { overrideCGX: lenFromUi(v) }), ...statedLaunchMark })}
            />
            <SubcomponentsToggle
              tree={tree}
              node={node}
              quantity="CG"
              valueKey="overrideCGX"
              flagKey="overrideSubcomponentsCG"
              onPatch={onPatch}
            />
            {/* The one case where a typed number provably changes nothing and
                the panel would otherwise stay silent: a CG on a container, with
                no mass override to position and the flag off. Reported twice by
                the owner, which is once more than it should have taken. */}
            {CONTAINER_TYPES.has(node.type)
              && cgOverride !== undefined
              && node['overrideSubcomponentsCG'] !== true
              && massOverride === undefined && (
              <p className="override-inert" role="note">
                <strong>This is not doing anything yet.</strong> A
                {' '}{DISPLAY_NAME[node.type]?.toLowerCase() ?? 'container'} has
                no mass of its own, so unticked this CG is positioning nothing.
                Tick the box to set the balance point of the whole assembly, or
                add a mass override for it to place.
                <button
                  type="button"
                  className="override-inert-fix"
                  onClick={() => onPatch({ overrideSubcomponentsCG: true })}
                >Use instead of everything inside</button>
              </p>
            )}
          </div>
          <div className="field">
            {/* A fin set's Cd override is multiplied by the fin COUNT (the
                kernel's instanceCount), while its MASS override covers the
                whole set — measured, not assumed: Cd 0.5 contributes 1.5 / 2.0
                / 3.0 on 3 / 4 / 6 fins. That asymmetry has to be on the label
                or it silently triples someone's drag. */}
            <label htmlFor={idFor('overrideCD')}>
              Drag coefficient (Cd){node.type.endsWith('finset') ? ' — per fin' : ''}
            </label>
            <NumField
              id={idFor('overrideCD')}
              ariaLabel="Drag coefficient (Cd) override"
              value={numOpt(node, 'overrideCD')}
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
            are containers with no mass, CG or drag of their own. Unticked, your
            figure describes a <em>point mass the container adds</em> rather than
            replacing anything: a mass of 1 kg makes the rocket 1 kg heavier, a
            Cd of 1.0 adds 1.0 to its drag, and a CG says <em>where</em> that
            added mass sits — so a CG on its own moves nothing, because it is
            positioning zero kilograms. Ticked, your figure sets that quantity
            for the whole assembly, which is how you set one Cd, or one weighed
            mass, for the entire rocket.
          </p>
        )}
      </div>
      )}

      {positionable && (
        <div style={{ marginTop: 10 }}>
          <h3 style={{ marginTop: 0 }}>Position (in parent)</h3>
          <div className="field-grid">
            <div className="field">
              <label htmlFor={idFor('positionMethod')}>Relative to</label>
              <select
                id={idFor('positionMethod')}
                aria-label="Position relative to"
                value={pos.method}
                onChange={(e) => {
                  // A new way of MEASURING the same station: the offset is
                  // recomputed so the part stays put, as desktop's
                  // setAxialMethod does (RocketComponent.java:1384-1387). It
                  // used to keep the offset, so a fin set at Top +0.25 m on a
                  // 0.30 m tube became Bottom +0.25 m, its trailing edge 0.25 m
                  // past the tube's end (audit 2026-09-30). Both lengths are the
                  // kernel's — axialLength is what 'middle' and 'bottom' measure
                  // against when it builds, which `parentLenSi` is not for a
                  // tube saved with no length. ('absolute' never gets here:
                  // normalizeTree rewrites it at every load boundary.)
                  const next = e.target.value as ComponentPosition['method'];
                  if (next === pos.method || !parent) return;
                  const cLen = axialLength(node);
                  const pLen = axialLength(parent);
                  const start = startFromPosition(pos, cLen, pLen);
                  onPatch({ position: { method: next, offset: offsetForStart(next, start, cLen, pLen) } });
                }}
              >
                <option value="top">Top of parent</option>
                <option value="middle">Middle of parent</option>
                <option value="bottom">Bottom of parent</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor={idFor('positionOffset')}>Offset <UnitChip quantity="length" /></label>
              <NumField
                id={idFor('positionOffset')}
                ariaLabel="Position offset"
                value={lenToUi(pos.offset)}
                step={niceStep(siToUi('length', lengthSym, 0.001))}
                allowNegative
                onCommit={(v) => {
                  // The load boundary's ±1 km, as the CG override above.
                  if (v !== null) onPatch({ position: { ...pos, offset: applyFieldLimit(POSITION_LIMIT, lenFromUi(v)) } });
                }}
              />
              <ValueSlider
                ariaLabel="Position offset"
                value={lenToUi(pos.offset)}
                min={lenToUi(-parentLenSi)}
                max={lenToUi(parentLenSi)}
                step={niceStep(siToUi('length', lengthSym, 0.001))}
                onChange={(v, pointer) => {
                  // The keyboard steps exactly: snapping an arrow press put it
                  // straight back on the anchor it had just left (1 mm against
                  // a 1.5 % window), so the slider stuck at every tube end
                  // (audit 2026-09-22). Only a pointer drag is magnetic.
                  if (!pointer) {
                    onPatch({ position: { ...pos, offset: lenFromUi(v) } });
                    return;
                  }
                  // Magnetic slider: snap to structural anchors (tube/sibling ends).
                  // `parent` is a ComponentNode here — positionable excludes 'stage'.
                  // Same frame as the 2D drag (hooks/useAxialDrag's move) and the
                  // drawings — axialLength, the kernel's length: zero for a
                  // rail button, the root chord for a freeform fin — and the
                  // anchor ladder is built in that frame too.
                  const cLen = axialLength(node);
                  const start = startFromPosition({ ...pos, offset: lenFromUi(v) }, cLen, parentLenSi);
                  const snapped = snapStart(start,
                    anchorStarts(parent as ComponentNode, node),
                    parentLenSi * 0.015);
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
