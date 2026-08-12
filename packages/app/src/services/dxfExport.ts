import type { ComponentNode } from '@online-openrocket/engine';
import { collapseLoop, finCutOutline, type SolidContext } from '../tree/solidMesh.js';

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
 * - **Millimetres.** Everything upstream is pure SI (meters); as in
 *   stlExport.ts the x1000 lives in the writer alone — see mm(). $INSUNITS=4
 *   declares it: a strict R12 reader ignores the variable, a modern one uses
 *   it to place the drawing without asking the operator to guess.
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

const M_TO_MM = 1000;
const EPS = 1e-9;
/** Matches solidMesh's fallback, so a DXF and an STL of the same part agree. */
const FALLBACK_RADIUS = 0.012;
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

const num = (n: ComponentNode, key: string, fb: number): number =>
  typeof n[key] === 'number' ? (n[key] as number) : fb;

/** The one and only meters -> millimetres conversion in this module. */
const toMm = (meters: number): number => meters * M_TO_MM;
/** Geometry group value: 0.1 µm resolution, far below any cutter's kerf. */
const mm = (meters: number): string => toMm(meters).toFixed(4);
/** The same number for human eyes in the label block. */
const dim = (meters: number): string => toMm(meters).toFixed(1);

/**
 * R12 carries text in the reader's ANSI code page, and every group value is
 * one newline-terminated line — so a non-ASCII character mojibakes and an
 * embedded newline splits the file into garbage. Rocket and component names
 * are free user text, so they get the same defence stlExport.ts applies to
 * its 80-byte header: fold the typography the app itself emits down to
 * ASCII, then force whatever is left into the printable range. Keeping the
 * whole file 7-bit also makes it byte-identical under UTF-8 and ANSI.
 */
function ascii(s: string): string {
  return s
    .replace(/[‐-―]/g, '-') // hyphen .. horizontal bar (em/en dash)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/·/g, '-') // middle dot — the app's own separator
    .replace(/×/g, 'x')
    .replace(/°/g, ' deg')
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7e]/g, '?')
    .trim();
}

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

/** Outer radius for a part that sits inside its parent tube's bore. */
const bodyBore = (ctx: SolidContext): number =>
  ctx.parentInnerRadius && ctx.parentInnerRadius > 0 ? ctx.parentInnerRadius : FALLBACK_RADIUS;

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
 * sensible plate representation. Everything is in METERS — the writer alone
 * knows about millimetres.
 */
function partProfile(node: ComponentNode, ctx: SolidContext, rocketName: string): Part | null {
  const name = node.name ?? '';
  const head = (label: string, count?: number): string =>
    `${rocketName} - ${name || label}${count ? ` (cut ${count})` : ''}`;
  const foot = '1:1 in millimetres - cut the CUT layer only (REFERENCE/TEXT are marks, not cuts)';

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
      const raw = finCutOutline(node);
      if (!raw) return null;
      const outline = collapseLoop(raw);
      if (outline.length < 3) return null;
      const pts = outline.map(([x, y]) => ({ x, y }));
      const geom: Ent[] = [{ kind: 'poly', layer: 'CUT', pts }];

      // Root chord = the run of the contour that lies on y = 0. Reading it
      // off the points rather than off rootChord keeps it correct for a
      // freeform fin and for a tab that reaches the leading or trailing end.
      const onRoot = pts.filter((p) => Math.abs(p.y) <= ON_ROOT);
      const rootX0 = onRoot.length >= 2 ? Math.min(...onRoot.map((p) => p.x)) : 0;
      const rootX1 = onRoot.length >= 2 ? Math.max(...onRoot.map((p) => p.x)) : 0;
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
      const tabDepth = below.length > 0 ? -Math.min(...below.map((p) => p.y)) : 0;
      const tabX0 = below.length > 0 ? Math.min(...below.map((p) => p.x)) : 0;
      const tabX1 = below.length > 0 ? Math.max(...below.map((p) => p.x)) : 0;
      const thickness = num(node, 'thickness', 0.003);
      const cross = typeof node['crossSection'] === 'string' ? (node['crossSection'] as string) : 'square';
      const label = node.type === 'trapezoidfinset' ? 'Trapezoidal fin'
        : node.type === 'ellipticalfinset' ? 'Elliptical fin' : 'Freeform fin';
      const count = Math.round(num(node, 'finCount', 3));
      const dims = `root ${dim(rootX1 - rootX0)} mm | span ${dim(span)} mm`
        + ` | stock thickness ${dim(thickness)} mm | ${cross} cross-section`
        + (tabDepth > EPS
          ? ` | TTW tab ${dim(tabDepth)} mm deep x ${dim(tabX1 - tabX0)} mm long`
            + ` at x ${dim(tabX0)}-${dim(tabX1)} mm`
          : '');
      return { label, ents: [...geom, ...labelEnts(geom, [head(label, count), dims, foot])] };
    }

    case 'centeringring': {
      const R = bodyBore(ctx);
      const raw = ctx.mountOuterRadius;
      const found = typeof raw === 'number';
      const known = found && raw > EPS && raw < R - EPS;
      // Same fallback componentSolid() takes: a ring with no mount tube to
      // center is really a bulkhead, so assume a half-radius bore and put
      // the assumption in the label where it can be caught before cutting.
      // The two not-known cases need DIFFERENT words: "no mount found" sends
      // the builder looking for a missing component, which is the wrong hunt
      // when a mount IS there and its diameter is the bad number.
      const bore = known ? raw : R * 0.5;
      const label = known ? 'Centering ring' : 'Centering ring (assumed bore)';
      const geom = discEnts(R, bore);
      const why = found
        ? `motor mount ⌀ ${dim(raw * 2)} mm does not fit this ring's ${dim(R * 2)} mm OD`
        : 'no motor mount found';
      const dims = `OD ${dim(R * 2)} mm | bore ${dim(bore * 2)} mm`
        + ` | stock thickness ${dim(num(node, 'length', 0.003))} mm`
        + (known ? '' : ` | BORE ASSUMED: ${why} — set to half the OD`);
      return { label, ents: [...geom, ...labelEnts(geom, [head(label), dims, foot])] };
    }

    case 'bulkhead': {
      const R = bodyBore(ctx);
      const geom = discEnts(R, null);
      const dims = `OD ${dim(R * 2)} mm | stock thickness ${dim(num(node, 'length', 0.003))} mm`
        + ' | centre marked on REFERENCE for the eyebolt';
      return { label: 'Bulkhead', ents: [...geom, ...labelEnts(geom, [head('Bulkhead'), dims, foot])] };
    }

    case 'tubecoupler':
    case 'engineblock': {
      // These are usually bought as tube stock, so the annulus is the one
      // profile here that is NOT self-evidently a plate part — but a plywood
      // or G10 thrust ring / coupler ring gets cut from sheet often enough,
      // and it is the same two circles the disc builder already draws. The
      // label states the axial length so nobody mistakes the section for the
      // whole tube.
      const R = bodyBore(ctx);
      // A wall at or past the radius closes the bore — ringSolid() degrades the
      // printed version to a solid rod for exactly the same input, so the cut
      // profile agreeing with it is the whole point. Reading the bore back
      // through acceptedBore() keeps OD/ID/wall describing the circles below.
      const bore = acceptedBore(R, R - num(node, 'thickness', 0.001));
      const geom = discEnts(R, bore > 0 ? bore : null);
      const label = node.type === 'tubecoupler' ? 'Tube coupler' : 'Engine block';
      const dims = `OD ${dim(R * 2)} mm | ID ${dim(bore * 2)} mm`
        + ` | wall ${dim(R - bore)} mm | ${dim(num(node, 'length', 0.05))} mm long`
        + ' (this is the ring SECTION, not a developed tube)';
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
/** Real-valued group, meters in, millimetres out. */
const gr = (out: string[], code: number, meters: number): void => g(out, code, mm(meters));

function writeTables(out: string[]): void {
  g(out, 0, 'SECTION');
  g(out, 2, 'TABLES');

  // Linetypes. The dash pattern is in DRAWING units, i.e. millimetres, so it
  // matches the SVG template's 2 mm dash / 1.5 mm gap rather than being an
  // invisible hairline stipple on a 100 mm chord.
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
  g(out, 40, '3.5');
  g(out, 49, '2.0');
  g(out, 49, '-1.5');
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
  g(out, 42, '2.5');
  g(out, 3, 'txt');
  g(out, 4, '');
  g(out, 0, 'ENDTAB');

  g(out, 0, 'ENDSEC');
}

function writeEntity(out: string[], e: Ent): void {
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

/** Serialize entities (METERS) as a complete R12 ASCII DXF drawing. */
function writeDxf(ents: Ent[]): string {
  const b = bounds(ents);
  const out: string[] = [];

  g(out, 0, 'SECTION');
  g(out, 2, 'HEADER');
  g(out, 9, '$ACADVER');
  g(out, 1, 'AC1009');
  g(out, 9, '$INSUNITS');
  gi(out, 70, 4); // 4 = millimeters
  g(out, 9, '$EXTMIN');
  gr(out, 10, b.minX);
  gr(out, 20, b.minY);
  gr(out, 30, 0);
  g(out, 9, '$EXTMAX');
  gr(out, 10, b.maxX);
  gr(out, 20, b.maxY);
  gr(out, 30, 0);
  g(out, 0, 'ENDSEC');

  writeTables(out);

  g(out, 0, 'SECTION');
  g(out, 2, 'ENTITIES');
  for (const e of ents) writeEntity(out, e);
  g(out, 0, 'ENDSEC');

  g(out, 0, 'EOF');
  // CRLF is what every DXF in the wild uses; LF-only trips a few older
  // parsers that read the value line with a fixed-length trim.
  return out.join('\r\n') + '\r\n';
}

/**
 * Flat cut profile for one component as an R12 DXF, or null when the type is
 * not plate-cuttable. `ctx` is the same SolidContext the STL export builds,
 * so the machined and printed versions of a part cannot disagree.
 */
export function componentDxf(
  node: ComponentNode,
  ctx: SolidContext,
  rocketName: string,
): { text: string; label: string } | null {
  const part = partProfile(node, ctx, ascii(rocketName || 'Rocket'));
  if (!part) return null;
  return { text: writeDxf(part.ents), label: part.label };
}
