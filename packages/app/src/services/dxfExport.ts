import type { ComponentNode } from '@online-openrocket/engine';
import {
  centeringRingBore, collapseLoop, finCutContours, ringOuterRadius, type SolidContext,
} from '../tree/solidMesh.js';
import { asciiOnly } from './textFold.js';
import { kernelNum } from '../tree/kernelDefaults.js';
import { num, numOpt } from '../tree/nodeNum.js';
import { axialLength } from '../tree/position.js';
import { finRootChord, finTabSpan } from '../tree/finTab.js';

/**
 * DXF export — the 2D CNC/laser boundary. Everything offered here is a FLAT
 * part cut from plate: fins, centering rings, bulkheads, coupler/thrust
 * rings. Nobody profiles a nose cone or a body tube on a router, so the
 * revolved parts are deliberately absent — they already have the STL path,
 * and a real solid interchange for them is STEP's job, not DXF's.
 *
 * Format decisions, and why:
 *
 * - **AutoCAD R12 (AC1009) ASCII.** R12 is the maximum-compatibility target:
 *   LightBurn, Carbide Create, Easel, Fusion 360's DXF sketch import and
 *   essentially every laser cutter's own software read it without complaint,
 *   and modern readers still accept it. The choice costs something real: the
 *   convenient LWPOLYLINE entity is R14+, and an R12-only reader *rejects* a
 *   file that contains one. So a closed contour is the older
 *   POLYLINE/VERTEX/SEQEND trio and a round hole is a true CIRCLE (exact,
 *   and CAM can read its centre and diameter for a drill/bore op instead of
 *   chasing a faceted polygon).
 * - **Millimetres or inches, from Rocket dimensions (`prefs.units.length`)**
 *   (@atestani, TRF 2026-10-11: the file came out metric on an imperial setup).
 *   A unit of in or ft draws in INCHES ($INSUNITS=1); mm, cm or m draw in
 *   MILLIMETRES ($INSUNITS=4). Feet are never the drawing unit: a fin is a
 *   few inches, and cutter software takes in or mm. Everything upstream is
 *   pure SI (meters) and the conversion lives in the writer alone — see
 *   DrawingUnits — along with the lengths that are fixed drawing figures
 *   (the DASHED pattern, the text style's height), so an inch drawing looks
 *   the same as a millimetre one. The millimetre file is byte-for-byte the
 *   one this module wrote before inches existed (dxfExport.units.test.ts).
 *   STL stays millimetres (stlExport.ts): every slicer assumes mm. $INSUNITS
 *   declares the unit: a strict R12 reader ignores the variable, a modern one
 *   uses it to place the drawing without asking the operator to guess.
 * - **A real HEADER and TABLES section.** The minimum viable DXF skips both,
 *   and the result is entities sitting on layers the reader has never heard
 *   of — which some CAM packages silently drop rather than auto-create.
 *   Every layer, the DASHED linetype and the STANDARD text style used below
 *   are therefore defined up front, and $EXTMIN/$EXTMAX are computed from
 *   the geometry so "zoom extents" lands on the part.
 * - **No calibration ruler.** The SVG template carries a 50 mm ruler because
 *   a printer will happily rescale the page behind your back. A DXF is
 *   dimensionally exact by definition, so a ruler here would be one more
 *   thing for the operator to delete before cutting.
 * - **Y is up, unflipped.** The SVG template flips Y because SVG's Y grows
 *   downward; DXF's grows upward, so the fin planform passes straight
 *   through — span grows +Y, chord runs +X, and a through-the-wall tab hangs
 *   below y = 0 exactly as the kernel models it.
 * - **One closed contour per part outline.** A fin with a TTW tab merges the
 *   tab into the outline (finCutOutline, shared with the STL prism) instead
 *   of drawing the tab as a separate box: CAM offsets a single closed path
 *   correctly, whereas two overlapping open paths cut a slot through the
 *   root.
 *
 * Layers, so the operator can pick what actually gets cut:
 *   CUT        closed contours — the part outline and every bore
 *   REFERENCE  construction marks (fin root chord, disc centre cross-hairs)
 *   TEXT       the label block, kept separate so it can be switched off
 */

/** Registered media type for DXF (IANA image/vnd.dxf). */
export const DXF_MIME = 'image/vnd.dxf';

/** Component types the ✂ DXF button supports — flat, plate-cut parts only. */
export const DXF_CUTTABLE = new Set([
  'trapezoidfinset', 'ellipticalfinset', 'freeformfinset',
  'centeringring', 'bulkhead', 'tubecoupler', 'engineblock',
]);

const EPS = 1e-9;
/** Label text height (m) = 3.2 mm — the SVG template's label size. */
const TEXT_H = 0.0032;
/** Baseline-to-baseline spacing and the gap under the geometry (m). */
const LINE_STEP = 0.005;
const LABEL_GAP = 0.008;
/** Centre cross-hair arm as a fraction of the disc radius. */
const CROSS_FRAC = 0.15;
/** Points this close to the root line count as ON it (m). */
const ON_ROOT = 1e-7;
/**
 * How far below its baseline a STANDARD (txt) glyph descends, as a fraction of
 * the text height. DXF gives a TEXT entity no extents of its own, so anything
 * computing a bounding box has to allow for the part of the glyph the reader
 * draws under the insertion point — otherwise "zoom extents" clips the tails
 * off the last label line.
 */
const DESCENDER_FRAC = 0.25;

type Layer = 'CUT' | 'REFERENCE' | 'TEXT';

/**
 * Layer colours are ACI indices, not RGB. CUT is 7 (white/black — whatever
 * the reader's background makes visible, the convention for real cut
 * geometry); REFERENCE 5 (blue) and TEXT 3 (green) are deliberately NOT 7 so
 * a glance at the drawing shows what would be cut if the operator forgot to
 * switch the other two off.
 */
const LAYERS: Array<[Layer, number]> = [['CUT', 7], ['REFERENCE', 5], ['TEXT', 3]];

interface Pt { x: number; y: number }

type Ent =
  | { kind: 'poly'; layer: Layer; pts: Pt[] }
  | { kind: 'circle'; layer: Layer; c: Pt; r: number }
  | { kind: 'line'; layer: Layer; a: Pt; b: Pt; dashed?: boolean }
  | { kind: 'text'; layer: Layer; at: Pt; h: number; s: string };

interface Part {
  /** Mirrors componentSolid()'s label — used for the download filename. */
  label: string;
  ents: Ent[];
}

/** The two units a drawing from this module can be written in. */
export type DxfUnit = 'mm' | 'in';

/**
 * The drawing unit for the Rocket dimensions preference (`prefs.units.length`): in
 * and ft draw in inches, every metric length unit in millimetres.
 * Name the rendered setting, not its key (audit 2026-10-11, CR-4).
 */
export const dxfUnitFor = (lengthSymbol: string): DxfUnit =>
  lengthSymbol === 'in' || lengthSymbol === 'ft' ? 'in' : 'mm';

/**
 * What the writer and the label block need to know about the drawing unit.
 * The meters -> drawing-unit conversion lives here and nowhere else.
 */
interface DrawingUnits {
  /** Meters -> drawing units. */
  fromM: (meters: number) => number;
  /** $INSUNITS: 4 = millimeters, 1 = inches. */
  insunits: number;
  /** Geometry decimals: 0.1 µm in mm, 0.0254 µm in inches — far below any kerf. */
  geomDp: number;
  /** Label-block decimals: 0.1 mm, 0.001 in. */
  dimDp: number;
  /** Decimals for the fixed TABLES figures (dash pattern, style height). */
  tableDp: number;
  sym: string;
  word: string;
}

const DRAWING_UNITS: Record<DxfUnit, DrawingUnits> = {
  mm: { fromM: (m) => m * 1000, insunits: 4, geomDp: 4, dimDp: 1, tableDp: 1, sym: 'mm', word: 'millimetres' },
  in: { fromM: (m) => m / 0.0254, insunits: 1, geomDp: 6, dimDp: 3, tableDp: 4, sym: 'in', word: 'inches' },
};

/** Keep tooltip and drawing labels together (audit 2026-10-11, CR-5). */
export const dxfUnitWord = (unit: DxfUnit): string => DRAWING_UNITS[unit].word;

/** Geometry group value. */
const geomVal = (u: DrawingUnits, meters: number): string => u.fromM(meters).toFixed(u.geomDp);
/** The same number for human eyes in the label block. */
const dimVal = (u: DrawingUnits, meters: number): string => u.fromM(meters).toFixed(u.dimDp);

/**
 * The fixed lengths in the TABLES section, in meters so they scale with the
 * unit: the SVG template's 2 mm dash / 1.5 mm gap (3.5 mm period), and the
 * STANDARD style's last-used height of 2.5 mm.
 */
const DASH = 0.002;
const GAP = 0.0015;
const STYLE_LAST_H = 0.0025;

/**
 * R12 carries text in the reader's ANSI code page, and every group value is
 * one newline-terminated line — so a non-ASCII character mojibakes and an
 * embedded newline splits the file into garbage. Rocket and component names
 * are free user text, so they get the same defence stlExport.ts applies to
 * its 80-byte header: fold the typography the app itself emits down to
 * ASCII, then force whatever is left into the printable range. Keeping the
 * whole file 7-bit also makes it byte-identical under UTF-8 and ANSI.
 *
 * The folding is services/textFold.ts's, shared with the other text-format
 * headers since the 2026-09-22 audit. The copy that lived here did not know
 * the ⌀ this module's own "BORE ASSUMED" line writes, so a CAM operator read
 * "motor mount ? 29.0 mm does not fit".
 */
const ascii = asciiOnly;

// --- geometry builders -----------------------------------------------------

/**
 * The bore discEnts() will actually draw, given a requested one: zero when the
 * request degenerates (a wall thicker than the radius, or thinner than
 * nothing). Labels are computed from THIS, never from the raw arithmetic —
 * otherwise a 50 mm wall on a 24.5 mm radius prints "ID -51.0 mm" beside a
 * drawing that is a plain solid disc.
 */
const acceptedBore = (outerR: number, boreR: number): number =>
  boreR > EPS && boreR < outerR - EPS ? boreR : 0;

/**
 * A disc-shaped part: outer contour, optional concentric bore, and centre
 * cross-hairs. The cross-hairs exist because these parts are almost always
 * drilled on centre afterwards (an eyebolt through a bulkhead, a vent in a
 * ring) and a marked centre saves the operator a measurement they would
 * otherwise take off the arc.
 */
function discEnts(outerR: number, boreR: number | null): Ent[] {
  const ents: Ent[] = [{ kind: 'circle', layer: 'CUT', c: { x: 0, y: 0 }, r: outerR }];
  if (boreR !== null && acceptedBore(outerR, boreR) > 0) {
    ents.push({ kind: 'circle', layer: 'CUT', c: { x: 0, y: 0 }, r: boreR });
  }
  const arm = outerR * CROSS_FRAC;
  ents.push(
    { kind: 'line', layer: 'REFERENCE', a: { x: -arm, y: 0 }, b: { x: arm, y: 0 } },
    { kind: 'line', layer: 'REFERENCE', a: { x: 0, y: -arm }, b: { x: 0, y: arm } },
  );
  return ents;
}

/**
 * The label-block warning for a part whose outer diameter is a placeholder
 * (solidMesh.ringOuterRadius found neither a stated OD nor a bore to sit in —
 * the SAME function the STL takes its size from, so the two cannot disagree).
 * A cut file carries its label on the TEXT layer, so this is where the
 * operator reads it: before the cut, not after the part fails to fit.
 */
const OD_ASSUMED = ' | OD ASSUMED: no tube found to size this part from - measure the bore before cutting';

/** Bounding box over every emitted entity, in meters. */
function bounds(ents: Ent[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number): void => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  for (const e of ents) {
    if (e.kind === 'poly') for (const p of e.pts) add(p.x, p.y);
    else if (e.kind === 'circle') { add(e.c.x - e.r, e.c.y - e.r); add(e.c.x + e.r, e.c.y + e.r); }
    else if (e.kind === 'line') { add(e.a.x, e.a.y); add(e.b.x, e.b.y); }
    else {
      // TEXT has no vertices in the file — the extents have to cover the
      // glyphs the reader will draw, or "zoom extents" clips the label.
      // 0.75 em/char is a generous width for the STANDARD (txt) font, and the
      // box runs from the DESCENDER (group 10/20 is the BASELINE, not the
      // bottom of the glyph) up to the cap height.
      add(e.at.x, e.at.y - e.h * DESCENDER_FRAC);
      add(e.at.x + e.h * 0.75 * e.s.length, e.at.y + e.h);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/** Stack the label block under the geometry, left-aligned with it. */
function labelEnts(geom: Ent[], lines: string[]): Ent[] {
  const b = bounds(geom);
  return lines.map((s, i) => ({
    kind: 'text' as const,
    layer: 'TEXT' as const,
    at: { x: b.minX, y: b.minY - LABEL_GAP - (i + 1) * LINE_STEP },
    h: TEXT_H,
    s: ascii(s),
  }));
}

/**
 * The flat cut profile for one component, or null when the type has no
 * sensible plate representation. Geometry is in METERS — the writer alone
 * converts it; `u` only words the label block.
 */
function partProfile(node: ComponentNode, ctx: SolidContext, rocketName: string, u: DrawingUnits): Part | null {
  const name = node.name ?? '';
  const dim = (meters: number): string => dimVal(u, meters);
  const U = u.sym;
  const head = (label: string, count?: number): string =>
    `${rocketName} - ${name || label}${count ? ` (cut ${count})` : ''}`;
  const foot = `1:1 in ${u.word} - cut the CUT layer only (REFERENCE/TEXT are marks, not cuts)`;

  switch (node.type) {
    case 'trapezoidfinset':
    case 'ellipticalfinset':
    case 'freeformfinset': {
      // The MERGED outline (tab folded into the root edge) — a cutter wants
      // one closed path, not an outline overlapping a tab box.
      //
      // collapseLoop() is not optional. The merge butts the tab's first corner
      // against the outline's last point, so the two coincide whenever the tab
      // reaches the trailing end of the root ('bottom' anchoring at offset 0),
      // and a full-root tab additionally closes back onto the first point
      // across the wrap. extrudePolygon() dedups internally, which is why the
      // STL never showed this; a POLYLINE written straight from these points
      // carries the zero-length segments into the file, where a degenerate
      // edge has no defined normal for kerf/cutter compensation and Fusion
      // 360 / LightBurn read the profile as an error or as unclosed. The
      // < 3 guard is re-checked AFTER the collapse, since collapsing is what
      // can drop a contour below three distinct corners.
      const raw = finCutContours(node, ctx);
      if (!raw?.length) return null;
      const contours = raw.map(collapseLoop);
      if (contours.some(outline => outline.length < 3)) return null;
      // Separate seated lobes need separate closed cuts (audit 2026-10-11, S4b-1).
      const polygons = contours.map(outline => outline.map(([x, y]) => ({ x, y })));
      const pts = polygons.flat();
      const geom: Ent[] = polygons.map(pts => ({ kind: 'poly', layer: 'CUT', pts }));

      // Root chord = the run of the contour that lies on y = 0. Reading it
      // off the points rather than off rootChord keeps it correct for a
      // freeform fin and for a tab that reaches the leading or trailing end.
      const onRoot = pts.filter((p) => Math.abs(p.y) <= ON_ROOT);
      // A seated root is not on y=0: the taper is neither a zero chord nor
      // part of the TTW tab (audit 2026-10-11, S4b-1).
      const mounted = node.type === 'freeformfinset' && ctx.finMount;
      const rootX0 = mounted ? 0 : onRoot.length >= 2 ? Math.min(...onRoot.map((p) => p.x)) : 0;
      const rootX1 = mounted ? finRootChord(node) : onRoot.length >= 2 ? Math.max(...onRoot.map((p) => p.x)) : 0;
      if (rootX1 - rootX0 > EPS) {
        geom.push({
          kind: 'line', layer: 'REFERENCE', dashed: true,
          a: { x: rootX0, y: 0 }, b: { x: rootX1, y: 0 },
        });
      }

      const span = Math.max(...pts.map((p) => p.y));
      // The tab is described from the contour that was actually EMITTED, not
      // from node.tabLength/tabOffset: finCutOutline clamps the tab into
      // [0, rootChord], so a tab hanging off the leading edge is cut shorter
      // than it was designed. Quoting the design length here would tell the
      // operator to expect a tab that this drawing does not contain, and they
      // would find out when it failed to seat in the airframe slot.
      const below = pts.filter((p) => p.y < -EPS);
      const tab = mounted ? finTabSpan(node, finRootChord(node), ctx.tabMaxDepth) : null;
      const tabDepth = mounted ? tab?.depth ?? 0 : below.length > 0 ? -Math.min(...below.map((p) => p.y)) : 0;
      const tabX0 = mounted ? tab?.x0 ?? 0 : below.length > 0 ? Math.min(...below.map((p) => p.x)) : 0;
      const tabX1 = mounted ? tab?.x1 ?? 0 : below.length > 0 ? Math.max(...below.map((p) => p.x)) : 0;
      const thickness = kernelNum(node, 'thickness');
      const cross = typeof node['crossSection'] === 'string' ? (node['crossSection'] as string) : 'square';
      const label = node.type === 'trapezoidfinset' ? 'Trapezoidal fin'
        : node.type === 'ellipticalfinset' ? 'Elliptical fin' : 'Freeform fin';
      const count = Math.round(num(node, 'finCount', 3));
      const dims = `root ${dim(rootX1 - rootX0)} ${U} | span ${dim(span)} ${U}`
        + ` | stock thickness ${dim(thickness)} ${U} | ${cross} cross-section`
        + (tabDepth > EPS
          ? ` | TTW tab ${dim(tabDepth)} ${U} deep x ${dim(tabX1 - tabX0)} ${U} long`
            + ` at x ${dim(tabX0)}-${dim(tabX1)} ${U}`
          : '');
      return { label, ents: [...geom, ...labelEnts(geom, [head(label, count), dims, foot])] };
    }

    case 'centeringring': {
      const { r: R, assumed } = ringOuterRadius(node, ctx);
      // The ring's own stated bore first, then the mount's OD — the kernel's
      // order, shared with componentLoop (centeringRingBore).
      const raw = centeringRingBore(node, ctx, R);
      if (raw === null) return null;
      const found = typeof raw === 'number';
      const known = found && (raw > EPS || (raw === 0 && numOpt(node, 'innerRadius') === 0)) && raw < R - EPS;
      // Same fallback componentSolid() takes: a ring with no mount tube to
      // center is really a bulkhead, so assume a half-radius bore and put
      // the assumption in the label where it can be caught before cutting.
      // The two not-known cases need DIFFERENT words: "no mount found" sends
      // the builder looking for a missing component, which is the wrong hunt
      // when a mount IS there and its diameter is the bad number.
      const bore = known ? raw : R * 0.5;
      // The same four labels componentLoop() gives the STL.
      const label = known
        ? `Centering ring${assumed ? ' (assumed size)' : ''}`
        : assumed ? 'Centering ring (assumed size and bore)' : 'Centering ring (assumed bore)';
      const geom = discEnts(R, bore);
      // Not "no motor mount found": the bore is the widest inner tube that
      // OVERLAPS this ring (solidContextFor), so a ring forward of a mount
      // that is there has none, and the builder must not go looking for one.
      const why = found
        ? `motor mount ⌀ ${dim(raw * 2)} ${U} does not fit this ring's ${dim(R * 2)} ${U} OD`
        : 'no motor mount passes through this ring';
      // The ring's length is its stock: componentLoop's, the kernel's when absent.
      const dims = `OD ${dim(R * 2)} ${U} | bore ${dim(bore * 2)} ${U}`
        + ` | stock thickness ${dim(axialLength(node))} ${U}`
        + (assumed ? OD_ASSUMED : '')
        + (known ? '' : ` | BORE ASSUMED: ${why} — set to half the OD`);
      return { label, ents: [...geom, ...labelEnts(geom, [head(label), dims, foot])] };
    }

    case 'bulkhead': {
      const { r: R, assumed } = ringOuterRadius(node, ctx);
      const label = assumed ? 'Bulkhead (assumed size)' : 'Bulkhead';
      const geom = discEnts(R, null);
      const dims = `OD ${dim(R * 2)} ${U} | stock thickness ${dim(axialLength(node))} ${U}`
        + ' | centre marked on REFERENCE for the eyebolt'
        + (assumed ? OD_ASSUMED : '');
      return { label, ents: [...geom, ...labelEnts(geom, [head(label), dims, foot])] };
    }

    case 'tubecoupler':
    case 'engineblock': {
      // These are usually bought as tube stock, so the annulus is the one
      // profile here that is NOT self-evidently a plate part — but a plywood
      // or G10 thrust ring / coupler ring gets cut from sheet often enough,
      // and it is the same two circles the disc builder already draws. The
      // label states the axial length so nobody mistakes the section for the
      // whole tube.
      const { r: R, assumed } = ringOuterRadius(node, ctx);
      // A wall at or past the radius closes the bore — ringSolid() degrades the
      // printed version to a solid rod for exactly the same input, so the cut
      // profile agreeing with it is the whole point. Reading the bore back
      // through acceptedBore() keeps OD/ID/wall describing the circles below.
      const bore = acceptedBore(R, R - kernelNum(node, 'thickness'));
      const geom = discEnts(R, bore > 0 ? bore : null);
      const label = (node.type === 'tubecoupler' ? 'Tube coupler' : 'Engine block')
        + (assumed ? ' (assumed size)' : '');
      const dims = `OD ${dim(R * 2)} ${U} | ID ${dim(bore * 2)} ${U}`
        + ` | wall ${dim(R - bore)} ${U} | ${dim(axialLength(node))} ${U} long`
        + ' (this is the ring SECTION, not a developed tube)'
        + (assumed ? OD_ASSUMED : '');
      return { label, ents: [...geom, ...labelEnts(geom, [head(label), dims, foot])] };
    }

    default:
      return null;
  }
}

// --- the R12 writer --------------------------------------------------------

/** One group code + value pair. DXF is strictly two lines per pair. */
const g = (out: string[], code: number, value: string): void => {
  out.push(String(code), value);
};
/** Integer-valued group (flags, counts, colours) — never real-formatted. */
const gi = (out: string[], code: number, value: number): void => g(out, code, String(Math.round(value)));
/** Real-valued group, meters in, drawing units out (bound to one unit by writeDxf). */
type RealGroup = (out: string[], code: number, meters: number) => void;

function writeTables(out: string[], u: DrawingUnits): void {
  /** A fixed TABLES length, meters in: "3.5", "2.0", "-1.5", "2.5" in mm. */
  const fig = (meters: number): string => u.fromM(meters).toFixed(u.tableDp);
  g(out, 0, 'SECTION');
  g(out, 2, 'TABLES');

  // Linetypes. The dash pattern is in DRAWING units (millimetres or inches),
  // so it matches the SVG template's 2 mm dash / 1.5 mm gap in either unit
  // rather than being an invisible hairline stipple on a 100 mm chord — or,
  // read as inches, a 50 mm dash that leaves a 100 mm chord looking solid.
  g(out, 0, 'TABLE');
  g(out, 2, 'LTYPE');
  gi(out, 70, 2);
  g(out, 0, 'LTYPE');
  g(out, 2, 'CONTINUOUS');
  gi(out, 70, 0);
  g(out, 3, 'Solid line');
  gi(out, 72, 65);
  gi(out, 73, 0);
  g(out, 40, '0.0');
  g(out, 0, 'LTYPE');
  g(out, 2, 'DASHED');
  gi(out, 70, 0);
  g(out, 3, 'Dashed __ __ __');
  gi(out, 72, 65);
  gi(out, 73, 2);
  g(out, 40, fig(DASH + GAP));
  g(out, 49, fig(DASH));
  g(out, 49, fig(-GAP));
  g(out, 0, 'ENDTAB');

  g(out, 0, 'TABLE');
  g(out, 2, 'LAYER');
  gi(out, 70, LAYERS.length);
  for (const [name, color] of LAYERS) {
    g(out, 0, 'LAYER');
    g(out, 2, name);
    gi(out, 70, 0);
    gi(out, 62, color);
    g(out, 6, 'CONTINUOUS');
  }
  g(out, 0, 'ENDTAB');

  // STANDARD text style: referenced by every TEXT entity below, and some
  // readers drop text whose style they cannot resolve. Group 4 (big-font
  // file) is legitimately empty — that is a blank value line, not a bug.
  g(out, 0, 'TABLE');
  g(out, 2, 'STYLE');
  gi(out, 70, 1);
  g(out, 0, 'STYLE');
  g(out, 2, 'STANDARD');
  gi(out, 70, 0);
  g(out, 40, '0.0');
  g(out, 41, '1.0');
  g(out, 50, '0.0');
  gi(out, 71, 0);
  g(out, 42, fig(STYLE_LAST_H));
  g(out, 3, 'txt');
  g(out, 4, '');
  g(out, 0, 'ENDTAB');

  g(out, 0, 'ENDSEC');
}

function writeEntity(out: string[], e: Ent, gr: RealGroup): void {
  switch (e.kind) {
    case 'poly': {
      // POLYLINE (not LWPOLYLINE — see the header note). Group 66 = "vertices
      // follow", group 70 bit 1 = closed; both are mandatory in R12, and a
      // missing 66 makes strict readers stop at the POLYLINE header.
      g(out, 0, 'POLYLINE');
      g(out, 8, e.layer);
      gi(out, 66, 1);
      gi(out, 70, 1);
      gr(out, 10, 0);
      gr(out, 20, 0);
      gr(out, 30, 0);
      for (const p of e.pts) {
        g(out, 0, 'VERTEX');
        g(out, 8, e.layer);
        gr(out, 10, p.x);
        gr(out, 20, p.y);
        gr(out, 30, 0);
      }
      g(out, 0, 'SEQEND');
      g(out, 8, e.layer);
      return;
    }
    case 'circle': {
      g(out, 0, 'CIRCLE');
      g(out, 8, e.layer);
      gr(out, 10, e.c.x);
      gr(out, 20, e.c.y);
      gr(out, 30, 0);
      gr(out, 40, e.r);
      return;
    }
    case 'line': {
      g(out, 0, 'LINE');
      g(out, 8, e.layer);
      if (e.dashed) g(out, 6, 'DASHED');
      gr(out, 10, e.a.x);
      gr(out, 20, e.a.y);
      gr(out, 30, 0);
      gr(out, 11, e.b.x);
      gr(out, 21, e.b.y);
      gr(out, 31, 0);
      return;
    }
    case 'text': {
      g(out, 0, 'TEXT');
      g(out, 8, e.layer);
      gr(out, 10, e.at.x);
      gr(out, 20, e.at.y);
      gr(out, 30, 0);
      gr(out, 40, e.h);
      g(out, 1, e.s);
      g(out, 7, 'STANDARD');
      return;
    }
  }
}

/** Serialize entities (METERS) as a complete R12 ASCII DXF drawing in `u`. */
function writeDxf(ents: Ent[], u: DrawingUnits): string {
  const b = bounds(ents);
  const out: string[] = [];
  const gr: RealGroup = (o, code, meters) => g(o, code, geomVal(u, meters));

  g(out, 0, 'SECTION');
  g(out, 2, 'HEADER');
  g(out, 9, '$ACADVER');
  g(out, 1, 'AC1009');
  g(out, 9, '$INSUNITS');
  gi(out, 70, u.insunits); // 4 = millimeters, 1 = inches
  g(out, 9, '$EXTMIN');
  gr(out, 10, b.minX);
  gr(out, 20, b.minY);
  gr(out, 30, 0);
  g(out, 9, '$EXTMAX');
  gr(out, 10, b.maxX);
  gr(out, 20, b.maxY);
  gr(out, 30, 0);
  g(out, 0, 'ENDSEC');

  writeTables(out, u);

  g(out, 0, 'SECTION');
  g(out, 2, 'ENTITIES');
  for (const e of ents) writeEntity(out, e, gr);
  g(out, 0, 'ENDSEC');

  g(out, 0, 'EOF');
  // CRLF is what every DXF in the wild uses; LF-only trips a few older
  // parsers that read the value line with a fixed-length trim.
  return out.join('\r\n') + '\r\n';
}

/**
 * Flat cut profile for one component as an R12 DXF, or null when the type is
 * not plate-cuttable. `ctx` is the same SolidContext the STL export builds,
 * so the machined and printed versions of a part cannot disagree. `unit` is
 * the drawing unit — the caller passes dxfUnitFor(prefs.units.length), the
 * Rocket dimensions preference.
 */
export function componentDxf(
  node: ComponentNode,
  ctx: SolidContext,
  rocketName: string,
  unit: DxfUnit = 'mm',
): { text: string; label: string } | null {
  const u = DRAWING_UNITS[unit];
  const part = partProfile(node, ctx, ascii(rocketName || 'Rocket'), u);
  if (!part) return null;
  return { text: writeDxf(part.ents, u), label: part.label };
}
