import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { axialLength, axialStart } from './position.js';
import { finTabFront } from './finTab.js';
import { clusterOffsets } from './cluster.js';
import { tubeFinRadius } from './tubefins.js';
import { assemblyInstanceCount, finCountOf, lineInstanceCount } from './counts.js';
import { DISPLAY_NAME } from './schema.js';
import {
  assemblyBoundingRadius, assemblyChainLength, isAssembly,
  resolveAssemblyRadius, ringInstanceOffsets,
} from './assembly.js';
import { outerProfile } from './shapeProfile.js';
import { shroudEnds } from './shroud.js';
import { num, numOpt } from './nodeNum.js';

/**
 * THE 2D SIDE VIEW'S LAYOUT — pure, and apart from the component that draws it
 * (audit 2026-09-22; carried since the 8 September audit as `schematicLayout`).
 *
 * Until this module the whole layout lived in TreeSchematic's render body: a
 * 1,400-line walk that built React elements by pushing into arrays it closed
 * over, with a shared counter for keys. Three things followed from that. The
 * geometry could only be tested by scraping attributes back out of rendered
 * SVG. It could not be memoised, so every hover re-walked the rocket. And the
 * drag could not draw a part anywhere but where the TREE put it, so every
 * pointermove of an axial drag had to write the tree — a kernel rebuild in
 * App's render per move, 73 ms on kitchensink.ork — which is the performance
 * finding this extraction exists to unblock (TreeSchematic's useAxialDrag now
 * previews a drag by laying out a patched tree here, and commits once).
 *
 * Two functions:
 *  - `schematicFrame` sizes the drawing: the viewBox, the scale, where the
 *    centreline sits. It reads the design's LENGTHS and RADII only, never a
 *    position, so dragging a part cannot move it.
 *  - `layoutSchematic` walks the design and returns every drawn shape as data
 *    — tag, presentation attributes, the part it belongs to — in paint order,
 *    with a key built from the part's IDENTITY (its id, its role, which
 *    instance), never from its place in the list. A counter key renumbered
 *    every shape after the first one that appeared or vanished — a motor
 *    loaded, a shoulder given a length — and React remounted each of them;
 *    one that happened mid-drag remounted the element under the pointer and
 *    lost the capture on it. An axial drag itself adds and removes no shape,
 *    so the drag alone never showed the difference (schematicLayout.test.ts
 *    and TreeSchematic.pointer.test.tsx pin both halves).
 *
 * What stays in the component: selection and hover (both restyle shapes this
 * layout has already placed, so neither re-walks the rocket), the handlers,
 * the CG/CP markers and callouts, the rulers, the zoom and the controls.
 *
 * Every arithmetic expression below was moved verbatim, operation order
 * included: TreeSchematic.golden.test.tsx pinned the rendered SVG attribute by
 * attribute before the move, and the move reproduces it exactly.
 */

/**
 * Ruler gutter thickness (viewBox px). The desktop uses one 20 px band for
 * both (ScaleScrollPane.RULER_SIZE); the left band is wider here because its
 * labels are drawn INSIDE it horizontally — the same thing the desktop does,
 * but its numbers are radii (small, few digits) and ours may be a diameter in
 * millimetres.
 */
export const RULER_TOP = 18;
export const RULER_LEFT = 30;

/** Total viewBox px of height reserved for the two callout lanes (S2). */
const CALLOUT_LANES = 34;

/** Padding round the drawing, viewBox px. */
const PAD = 26;

/**
 * Where the drawing's centreline sits in a box of height `h`.
 *
 * Centring is the default and is exactly what happens when nothing asks for
 * headroom (`topReserve` 0 — every caller but the hero canvas).
 *
 * When the host DOES ask, the reserve is spent ABOVE the rocket instead of
 * being split in half by centring. That split is why the hero canvas's 140px
 * chip reserve never worked: it was added to the container, then divided
 * evenly, so 70px of it landed below the rocket where nothing needed it while
 * the stats chip — 124px tall — sat on the nose cone.
 *
 * Two clamps keep it honest, and both matter:
 *  - it only ever spends SLACK (`skyBelow - keepBelow`), so a height-fitted
 *    drawing, which has none, is untouched;
 *  - `keepBelow` preserves the bottom padding and the bottom callout lane,
 *    exactly what a symmetric layout gives them, so the rocket can never be
 *    pushed down onto its own CP callout.
 */
export function centrelineY({ h, gutY, pad, lanes, halfDrawn, topReserve }: {
  h: number; gutY: number; pad: number; lanes: number; halfDrawn: number; topReserve: number;
}): number {
  const centred = gutY + (h - gutY) / 2;
  const keepBelow = pad + lanes / 2;
  const skyAbove = centred - halfDrawn - gutY;
  const skyBelow = h - (centred + halfDrawn);
  const bias = Math.max(0, Math.min(topReserve - skyAbove, skyBelow - keepBelow));
  return centred + bias;
}

const fillOf = (n: ComponentNode, dflt: string): string =>
  typeof n['color'] === 'string' ? (n['color'] as string) : dflt;

/** Every node of a subtree, depth first, mapped. */
function collect<T>(nodes: ComponentNode[], f: (n: ComponentNode) => T): T[] {
  const out: T[] = [];
  const walk = (ns: ComponentNode[]) => {
    for (const n of ns) {
      out.push(f(n));
      walk(n.children ?? []);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Stages flatten into one nose-to-tail chain (sustainer first, boosters after
 * — the desktop's stacking order); legacy flat trees pass through.
 */
const axialChain = (tree: RocketTree): ComponentNode[] =>
  tree.components.flatMap((n) => (n.type === 'stage' ? n.children ?? [] : [n]));

export interface SchematicFrameOptions {
  /** Container width (CSS px). The viewBox adopts it 1:1. */
  cw: number;
  /** Container height (CSS px) — the length axis in vertical mode. */
  chPx: number;
  /** Nose-up: the length axis runs along the container HEIGHT. */
  vertical?: boolean;
  /** Hero canvas: fill the container's height (horizontal only). */
  fillHeight?: boolean;
  /** Cap on the drawing's height (px), horizontal and not fillHeight. */
  maxHeight: number;
  /** Whether the ruler gutters take their bands. */
  rulers: boolean;
  /** The roll slider's column (horizontal) and bar (nose-up), px. */
  rollW: number;
  rollBar: number;
  /** Whether the CG/CP callout lanes need their sky (the view has figures). */
  lanes: boolean;
  /** Sky kept above the drawing for what the host floats there (centrelineY). */
  topReserve: number;
}

export interface SchematicFrame {
  /** Axial length drawn (m), floored at 5 cm. */
  totalLen: number;
  /** Vertical half-extent (m): body, fins, and any off-axis pod's reach. */
  vHalf: number;
  /** viewBox width and height (layout px, before a nose-up rotation). */
  w: number;
  h: number;
  /** The ruler gutters plus the roll column (x), the top ruler (y). */
  gutX: number;
  gutY: number;
  /** Callout lane allowance included in `h` (px). */
  lanes: number;
  /** The drawing's natural height at width-fit scale, quantised to 8 px. */
  naturalH: number;
  /** Layout px per metre. */
  scale: number;
  /** Screen y of the core centreline, and screen x of the nose tip. */
  cy: number;
  x0: number;
}

/**
 * The frame the side view is drawn in — viewBox size, scale, centreline.
 *
 * Reads lengths and radii and nothing else: a part's POSITION never moves the
 * frame, which is what lets a drag preview re-lay the design out without the
 * whole drawing rescaling under the pointer.
 */
export function schematicFrame(tree: RocketTree, o: SchematicFrameOptions): SchematicFrame {
  // --- measure the axial chain ---
  const chain = axialChain(tree);
  let totalLen = 0;
  let maxR = 0.001;
  for (const n of chain) {
    if (n.type === 'nosecone' || n.type === 'bodytube' || n.type === 'transition') {
      totalLen += num(n, 'length', 0);
      maxR = Math.max(maxR, num(n, 'aftRadius', 0), num(n, 'outerRadius', 0), num(n, 'foreRadius', 0));
    }
  }
  // A fin set's vertical span: freeform fins carry no 'height' key — their
  // reach is the outline's y-max (the 0.03 default clipped tall freeform fins
  // out of the adaptive-height frame).
  const finSpan = (n: ComponentNode): number => {
    if (!n.type.endsWith('finset')) return 0;
    if (n.type === 'freeformfinset') {
      const pts = n['points'];
      if (Array.isArray(pts) && pts.length > 0) {
        return Math.max(0, ...pts.map((p) => (Array.isArray(p) ? Number(p[1]) || 0 : 0)));
      }
    }
    // Tube fins reach one tube diameter above the body surface.
    if (n.type === 'tubefinset') return 2 * tubeFinRadius(n, maxR);
    return num(n, 'height', 0.03);
  };
  const protuberanceSpan = (n: ComponentNode): number =>
    (n.type === 'fairing' ? num(n, 'height', 0.02)
      : (n.type as string) === 'protuberance' ? num(n, 'height', 0.01)
        : 0);
  const finH = Math.max(
    0,
    ...collect(tree.components, finSpan),
    ...collect(tree.components, protuberanceSpan),
  );
  totalLen = Math.max(totalLen, 0.05);

  // Vertical half-extent (m): the core body + fins, plus any off-axis pod's
  // reach (its centerline radius + its own body + its fins) so pods don't clip.
  let vHalf = maxR + finH;
  const scanRadial = (nodes: ComponentNode[], parentR: number) => {
    for (const n of nodes) {
      if (isAssembly(n.type)) {
        const podFin = Math.max(0, ...collect(n.children ?? [], finSpan));
        vHalf = Math.max(vHalf, resolveAssemblyRadius(n, parentR) + assemblyBoundingRadius(n) + podFin);
        scanRadial(n.children ?? [], assemblyBoundingRadius(n));
      } else {
        const r = Math.max(num(n, 'aftRadius', 0), num(n, 'outerRadius', 0), num(n, 'foreRadius', 0)) || parentR;
        scanRadial(n.children ?? [], r);
      }
    }
  };
  scanRadial(chain, maxR);

  // Vertical mode swaps the container roles BEFORE layout: all layout math
  // stays horizontal (length along x) and the finished drawing rotates
  // nose-up as one group, so the length axis fits the container HEIGHT and
  // the cross extent its width.
  const { vertical, fillHeight, maxHeight, cw, chPx, rollBar } = o;
  const w = Math.max(320, vertical ? chPx : cw);
  const pad = PAD;
  // The roll slider's column, and the ruler gutters. All three are surrendered
  // by the DRAWING, so every fit below works from the inset box — and every
  // pointer↔model conversion is unaffected, because they move the origin
  // without touching `scale`. ⟳90° puts the roll control across the BOTTOM
  // instead (`rollBar`): layout stays horizontal and rotates as one group, and
  // rotate(90) maps large layout x to screen bottom — so shortening the length
  // reserves exactly the bottom band.
  const gutX = o.rollW + (o.rulers ? RULER_LEFT : 0);
  const gutY = o.rulers ? RULER_TOP : 0;
  // Height follows the rocket's own proportions (clamped): a long thin
  // rocket gets a wide low band, not a fixed frame of empty sky. When info
  // is present the CG/CP callout lanes need sky of their own, so their
  // allowance is added to the height AND kept out of the vertical fit —
  // otherwise a height-limited short/fat rocket would fill it and clip them.
  const lanes = o.lanes ? CALLOUT_LANES : 0;
  const crossCap = vertical ? Math.max(160, cw) : maxHeight;
  // The adaptive content height, uncapped — what the drawing would take if
  // nothing constrained it. The fillHeight branch still fills its container;
  // this is what the container itself sizes FROM (via onNaturalHeight).
  const naturalRaw = Math.round(Math.max(
    200, 2 * vHalf * ((w - 2 * pad - gutX - rollBar) / totalLen) + 2 * pad + lanes + gutY,
  ));
  // Reported quantized to 8px: naturalRaw moves with every 1px of container
  // width, and each NEW reported value re-renders the whole App — a window
  // drag-resize would cascade an app-wide render per tick (review finding,
  // v0.076). Quantized, most ticks report the same value and React bails.
  const naturalH = Math.round(naturalRaw / 8) * 8;
  const h = vertical || !fillHeight
    ? Math.round(Math.min(crossCap, Math.max(200, naturalRaw)))
    : Math.max(200, chPx);
  const scale = Math.max(1e-6, Math.min(
    (w - 2 * pad - gutX - rollBar) / totalLen,
    (h - 2 * pad - lanes - gutY) / (2 * vHalf),
  ));
  return {
    totalLen, vHalf, w, h, gutX, gutY, lanes, naturalH, scale,
    cy: centrelineY({ h, gutY, pad, lanes, halfDrawn: vHalf * scale, topReserve: o.topReserve }),
    x0: pad + gutX,
  };
}

/** A loaded motor case (m) — drawn to scale; `label` is its designation. */
export interface SchematicMotor {
  length: number;
  diameter: number;
  label?: string;
}

/** Which component a drawn shape belongs to, and how it takes the pointer. */
export interface ShapePart {
  id: string;
  /** The part's name as the hover tag and "Select …" say it. */
  name: string;
  /**
   * The part is a child drawn on or in its parent, and so may be DRAGGED
   * axially (the component decides whether dragging is on at all). The
   * parent frame the drag resolves in is `SchematicLayout.grips`.
   */
  grip: boolean;
  /**
   * An invisible hit surface duplicating a drawn outline (wire fins): it takes
   * the pointer and never the keyboard — focus must not land on nothing.
   */
  hit?: boolean;
}

export type ShapeLayer = 'base' | 'overlay' | 'wires';

export interface SchematicShape {
  /** React key, from the part's IDENTITY — id, role, instance — never a counter. */
  key: string;
  /** Paint layer: the hull, then the dashed/near overlay, then wire fins. */
  layer: ShapeLayer;
  tag: 'rect' | 'path' | 'polygon' | 'line' | 'text' | 'g';
  /** Presentation props in React's spelling: geometry, fill, stroke, clip. */
  attrs: Record<string, unknown>;
  /** The component this shape draws, when it has an id to select it by. */
  part?: ShapePart;
  /** Selection restyles this shape's stroke: the accent, at width 2. */
  sel?: boolean;
  /** A `<title>` child — internal parts name themselves on hover. */
  title?: string;
  /** Text content — type tags and motor designations. */
  text?: string;
  /** A glyph group's own children. */
  children?: SchematicShape[];
}

/** One airframe band's clip: everything OUTSIDE it (see airframeClip). */
export interface SchematicClip {
  id: string;
  top: number;
  bottom: number;
}

/** A part's drawn extent (layout px), unioned across its instances. */
export interface PartExtent {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The frame an axial drag of this child resolves in. */
export interface Grip {
  child: ComponentNode;
  parent: ComponentNode;
  /** The parent's length (m) — the frame the child's offset is written in. */
  pLen: number;
}

export interface SchematicLayout {
  /** Every drawn shape, in paint (and so tab) order. */
  shapes: SchematicShape[];
  clips: SchematicClip[];
  /** By part id — the hover wash and tag. */
  extents: Map<string, PartExtent>;
  /** By child id — what a press on that part may drag, and in what frame. */
  grips: Map<string, Grip>;
}

export interface SchematicLayoutOptions {
  /** From schematicFrame. */
  scale: number;
  cy: number;
  x0: number;
  /** View roll about the long axis (rad), 0 = the design's own clock angles. */
  roll: number;
  /** Loaded motor cases, keyed by mount node id. */
  motors?: Record<string, SchematicMotor>;
  /** Nose-up: every text label counter-rotates about its own anchor. */
  vertical?: boolean;
  /**
   * Namespaces the clipPath ids. Two schematics share a document on the
   * Motors tab, and `url(#id)` resolves to the FIRST match in the document —
   * an unqualified id would have one view clipping its fins to the other's
   * airframe.
   */
  idPrefix: string;
}

/**
 * One drawn instance of a fin set in the side view.
 *
 * `p` is the foreshortening on its radial coordinates: cos(clock angle), so
 * +1 is straight up, 0 edge on, −1 straight down. That much the desktop also
 * computes (FinSetShapes.getShapesSide plots (x, y) after rotate_x, 24.12).
 *
 * `near` is the half a silhouette cannot express and the reason the roll
 * slider read as a see-saw for three releases: a fin at +z is in FRONT of the
 * airframe and you see all of it, one at −z is behind and the tube covers its
 * root. Draw both the same way — as v0.078 did in front and v0.080/81 did
 * behind — and the two lower fins of a three-fin set become identical shapes,
 * so all that is left to watch is their heights swapping.
 *
 * `i` is which fin of the set it is, for its key — the list is sorted for
 * painting, and the sort order changes with the roll.
 */
interface FinInstance {
  p: number;
  near: boolean;
  i: number;
}

/** Internal parts' ink and tag (issue 2026-08-05a #21). */
const TYPE_STYLE: Partial<Record<string, { stroke: string; tag: string }>> = {
  parachute: { stroke: '#b06a35', tag: 'chute' },
  streamer: { stroke: '#a08c2e', tag: 'strmr' },
  shockcord: { stroke: '#8f7a8d', tag: 'cord' },
  masscomponent: { stroke: '#a85f5c', tag: 'mass' },
  centeringring: { stroke: '#6f8a5c', tag: 'CR' },
  bulkhead: { stroke: '#66748c', tag: 'BH' },
  engineblock: { stroke: '#7d7050', tag: 'EB' },
};

/** Every shape of the side view, as data. See the module note. */
export function layoutSchematic(tree: RocketTree, o: SchematicLayoutOptions): SchematicLayout {
  const { scale, roll, motors, vertical } = o;
  const ctx = { scale, cy: o.cy, x0: o.x0 };
  // Three paint layers, concatenated at the end.
  const shapes: SchematicShape[] = [];
  // Dashed "shadow" shapes (inner components, shoulders) paint AFTER the whole
  // hull: SVG stacks by document order, so a coupler overhanging into the NEXT
  // tube used to vanish under that tube's opaque fill (while the overhang into
  // the PREVIOUS tube, already painted, stayed visible — the owner's ebay report).
  const overlay: SchematicShape[] = [];
  // Wireframe fin outlines and their hit surfaces, painted after overlay:
  // a loaded motor case is an overlay rect at 0.85 opacity, and whenever the
  // mount follows the fin set in child order it landed exactly on the in-body
  // run of each rolled fin — the segment the wireframe exists to keep visible.
  const wires: SchematicShape[] = [];
  const clips: SchematicClip[] = [];
  const extents = new Map<string, PartExtent>();
  const grips = new Map<string, Grip>();

  // Keys: the part's id (or, for a node without one, its order of arrival),
  // under the assembly instance it is drawn in — a pod's chain is drawn once
  // per ring instance.
  let anon = 0;
  const partKey = (n: ComponentNode, scope: string) => `${scope}${n.id ?? `@${anon++}`}`;
  const partOf = (n: ComponentNode, grip: boolean): ShapePart | undefined =>
    (n.id ? { id: n.id, name: n.name ?? DISPLAY_NAME[n.type], grip } : undefined);

  // The part's drawn extent, unioned across instances (cluster copies, pod
  // rings) as the shapes are placed.
  const noteHover = (n: ComponentNode, x0: number, y0: number, x1: number, y1: number) => {
    if (!n.id) return;
    const box = {
      x0: Math.min(x0, x1), y0: Math.min(y0, y1),
      x1: Math.max(x0, x1), y1: Math.max(y0, y1),
    };
    const cur = extents.get(n.id);
    extents.set(n.id, {
      name: n.name ?? DISPLAY_NAME[n.type],
      ...(cur
        ? {
          x0: Math.min(cur.x0, box.x0), y0: Math.min(cur.y0, box.y0),
          x1: Math.max(cur.x1, box.x1), y1: Math.max(cur.y1, box.y1),
        }
        : box),
    });
  };

  // Nose-up rendering rotates the whole drawing; every text label counter-
  // rotates about its own anchor so it still reads horizontally.
  const textUp = (x: number, y: number) =>
    (vertical ? { transform: `rotate(-90 ${x} ${y})` } : {});

  // Loaded motor case (S5): launch-orange tint at the real case size, with
  // the designation printed in the case when it's long enough to carry it.
  const motorShapes = (
    layer: ShapeLayer, key: string,
    motor: SchematicMotor,
    mStart: number, cY: number,
  ): SchematicShape[] => {
    const mR = motor.diameter / 2;
    const out: SchematicShape[] = [{
      key, layer, tag: 'rect',
      attrs: {
        x: ctx.x0 + mStart * ctx.scale, y: cY - mR * ctx.scale,
        width: Math.max(2, motor.length * ctx.scale), height: Math.max(2, 2 * mR * ctx.scale),
        rx: '1', fill: 'var(--launch)', fillOpacity: '0.85',
        stroke: '#e0764a', strokeWidth: '0.8',
        style: { pointerEvents: 'none' },
      },
    }];
    if (motor.label && motor.length * ctx.scale > 36) {
      const lx = ctx.x0 + (mStart + motor.length / 2) * ctx.scale;
      out.push({
        key: `${key}-label`, layer, tag: 'text', text: motor.label,
        attrs: {
          x: lx, y: cY, textAnchor: 'middle', dominantBaseline: 'central',
          fontSize: '10', fontWeight: 'bold', fill: '#ffffff', ...textUp(lx, cY),
          style: { pointerEvents: 'none' },
        },
      });
    }
    return out;
  };

  /**
   * ROLLED = WIREFRAME, **FOR FINS ONLY**. The moment the roll slider leaves
   * zero, every fin is drawn as a plain outline, over the body, nothing hidden
   * and nothing occluded — desktop OpenRocket's convention exactly. The owner
   * chose it on 2026-08-30, from a side-by-side mockup, after four releases of
   * trying to keep a filled drawing followable.
   *
   * **`solidWhileRolled`** — camera shrouds, protuberances, launch lugs and
   * rail buttons do NOT take this path, and must not be "unified" into it. The
   * outline works for a fin because a fin IS a thin plate seen edge-on: the
   * outline is the honest picture of it. A 20 mm-tall camera shroud drawn as an
   * outline reads as a thin line and lies about the part (owner report,
   * 2026-08-31: *"That makes them look like thin lines even though they are
   * thick. Using the outlines for the fins works because they are inherently
   * thin — it doesn't look weird for them."*). Those four stay filled at every
   * roll angle, cut at the airframe wall when they pass behind it, which is
   * byte-identical to what they already did at rest.
   *
   * Its figure is a WIREFRAME: `RocketFigure.paintComponent` is
   * `g2.draw(rcs.shape)`, and the only `g2.fill` in the whole method is the
   * motor rectangle (RocketFigure.java:314, :384, 24.12). So all N fins are on
   * screen at every angle, including the ones lying inside the body, and each
   * one can be followed round. That is the property a filled drawing cannot
   * reproduce: v0.078 drew the covered part flat across the tube then dropped
   * it, v0.080 clipped it away, v0.081 made it a hidden line, v0.082 gave each
   * instance its own side, v0.083 put the hidden line at full strength. Every
   * one of those is geometrically continuous, and not one of them lets you
   * watch a single fin go round — which is the entire point of the slider.
   *
   * The projection was measured first and was never the problem: off the
   * owner's own screen recordings of the same rocket, the up/down extent ratio
   * sweeps 0.50–2.01 here and 0.51–2.00 in desktop, against 0.50–2.00
   * predicted for a three-fin set. Only the drawing convention differed.
   *
   * AT REST the view is unchanged — the filled drawing, near fins whole and
   * far fins cut at the wall. A still figure has nothing to follow, and the
   * fill is what says which side of the rocket each fin is on.
   */
  const wire = roll !== 0;

  /**
   * One clip per (centreline, body radius) pair, memoised: everything OUTSIDE
   * the airframe band, as two rects. Sign-free, so it serves flat fins and
   * tube fins alike, including a tube lying across the axis. At rest it cuts
   * a far fin's fill at the wall; while rolled the DRAWING clips nothing, but
   * the same clip bounds each wire fin's invisible hit surface (see pushWire).
   */
  const airframeClips = new Map<string, string>();
  const airframeClip = (baseY: number, pRadius: number): string => {
    const top = baseY - pRadius * ctx.scale;
    const bottom = baseY + pRadius * ctx.scale;
    const memo = `${top.toFixed(3)}:${bottom.toFixed(3)}`;
    const seen = airframeClips.get(memo);
    if (seen) return seen;
    const id = `${o.idPrefix}-outside-${airframeClips.size}`;
    airframeClips.set(memo, id);
    clips.push({ id, top, bottom });
    return id;
  };

  /**
   * One wire fin = the visible outline plus an invisible hit surface CLIPPED
   * TO OUTSIDE the airframe band. A hollow shape takes pointer events only on
   * its stroke; blanket `pointerEvents: all` (the first cut of v0.084) fixed
   * that by making the whole invisible interior the topmost target — so a
   * click or drag aimed at bare body tube landed on a fin nobody could see,
   * and the drag MOVED it. Outside the band the space belongs to the fin;
   * inside it, only the drawn line does.
   *
   * The outline takes the component's own display colour — desktop strokes
   * each component in its colour (RocketFigure.java:287-292), and it is the one
   * view whose purpose is telling fins apart — with selection carried by the
   * same restyle as the filled drawing. The hit surface is a `hit` part: the
   * pointer's, never the keyboard's, so the part's one tab stop can never land
   * on a shape nobody can see.
   */
  const pushWire = (
    n: ComponentNode, part: ShapePart | undefined, clip: string, key: string,
    tag: SchematicShape['tag'], geometry: Record<string, unknown>,
  ) => {
    wires.push({
      key, layer: 'wires', tag, part, sel: true,
      attrs: { ...geometry, 'data-fin': 'wire', fill: 'none', stroke: fillOf(n, '#7a786f'), strokeWidth: 1.4 },
    });
    wires.push({
      key: `${key}-hit`, layer: 'wires', tag, part: part && { ...part, hit: true },
      attrs: { ...geometry, 'data-fin-hit': '', fill: 'transparent', stroke: 'none', clipPath: `url(#${clip})` },
    });
  };

  /**
   * A part that sits ON the airframe surface at one clock angle: shrouds,
   * protuberances, launch lugs, rail buttons. Its own `angleOffset` places it
   * around the body (0 = the top of this drawing, which is also where an
   * un-rotated fin set puts its first fin), and the view roll turns it from
   * there.
   *
   * Both halves were missing before v0.086/v0.087: the parts were pinned to
   * the top of the airframe, so rolling turned the fins and left them behind,
   * and there was no angle to place them at in the first place. A camera
   * shroud in line with a fin has the fin in shot, which is exactly the thing
   * an owner steers away from (Eric, 2026-08-30).
   *
   * Same projection as a fin: a surface point at radius r lands at r·cos θ,
   * and sin θ ≥ 0 puts it in FRONT of the airframe.
   */
  const surfaceAt = (n: ComponentNode): { p: number; near: boolean } => {
    const a = num(n, 'angleOffset', 0) + roll;
    return { p: Math.cos(a), near: Math.sin(a) >= 0 };
  };

  /**
   * Where each fin of a set lands in the side view: a signed foreshortening
   * factor on its radial coordinates, +1 straight up, 0 edge on, −1 straight
   * down. Exactly what the desktop computes — `FinSetShapes.getShapesSide`
   * transforms the fin's own points by `rotate_x(clock angle)` and plots
   * (x, y), so a point at radius r lands at `r·cos θ`
   * (FinSetShapes.java:41-60 + RocketFigure.axialRotation, 24.12).
   *
   * EVERY instance comes back, including the ones the airframe hides. What
   * happens to a hidden one is the renderer's business — at rest the clip cuts
   * its fill at the wall, rolled it is a wire outline — but nothing is dropped
   * here, so nothing can pop.
   */
  const finFactors = (n: ComponentNode): FinInstance[] => {
    // finCountOf: the kernel's 1..8, never the raw count. A .rkt FinCount of
    // 70,000 made the `Math.min(...ys)` spread below throw RangeError and took
    // the whole app down (audit 2026-09-22).
    const count = finCountOf(n);
    const base = num(n, 'rotation', 0) + roll;
    const out: FinInstance[] = [];
    for (let i = 0; i < count; i++) {
      const a = base + (2 * Math.PI * i) / count;
      out.push({ p: Math.cos(a), near: Math.sin(a) >= 0, i });
    }
    // Furthest-out last. Same-colored fins overlap once a set is rolled off
    // its symmetry, and the one that reaches past the others reads best on top.
    return out.sort((x, y) => Math.abs(x.p) - Math.abs(y.p));
  };

  /**
   * Hover extent for a fin set: the union of what is actually DRAWN. Before
   * the projection landed both fins reached full span, so the un-foreshortened
   * ±reach box matched the drawing exactly; with a 3-fin set at rest it would
   * now paint a third of its height over empty sky below the lower pair.
   */
  const noteHoverFins = (
    n: ComponentNode, x0: number, x1: number, baseY: number, reach: number,
    pRadius: number, projections: FinInstance[],
  ) => {
    if (!projections.length) return;
    // Tip AND the airframe edge the fin emerges from. A far fin's projected
    // root is clipped away, so the wash would over-reach into the tube; a near
    // fin is drawn whole, so its own root is the honest edge. Taking both
    // keeps the box on the drawing, and gives a ONE-fin set a box with height
    // (tip-to-tip alone would be a zero-height rect).
    const ys = projections.flatMap(({ p, near }) => [
      baseY - reach * p * ctx.scale,
      baseY - pRadius * (near || wire ? p : Math.sign(p)) * ctx.scale,
    ]);
    noteHover(n, x0, Math.min(...ys), x1, Math.max(...ys));
  };

  const renderChildren = (
    parent: ComponentNode, pStart: number, pLen: number, pRadius: number, baseY: number, scope: string,
  ) => {
    for (const child of parent.children ?? []) {
      const t = child.type;
      // Off-axis assembly: draw its whole chain once per ring instance at the
      // instance's projected baseline (side view projects y, ignores depth z).
      if (isAssembly(t)) {
        const podChain = child.children ?? [];
        const podLen = assemblyChainLength(child);
        const podRadius = resolveAssemblyRadius(child, pRadius);
        const podStart = axialStart(child, podLen, pStart, pLen);
        const count = assemblyInstanceCount(child);
        const podKey = partKey(child, scope);
        let k = 0;
        for (const off of ringInstanceOffsets(count, podRadius, num(child, 'angleOffset', 0) + roll)) {
          // −y: the cross-section frame's +y is UP, and SVG y grows down.
          renderChain(podChain, podStart, baseY - off.y * ctx.scale, `${podKey}#${k++}/`);
        }
        continue;
      }
      const key = partKey(child, scope);
      const part = partOf(child, true);
      if (child.id) grips.set(child.id, { child, parent, pLen });
      // Through-the-wall fin tab: dashed rect from the body surface inward,
      // foreshortened with the fin instance it belongs to.
      const renderTab = (finStart: number, finLen: number, p: number, i: number) => {
        const tabH = Math.min(num(child, 'tabHeight', 0), pRadius);
        const tabLen = num(child, 'tabLength', 0);
        if (tabH <= 0 || tabLen <= 0) return;
        const front = finStart + finTabFront(child, finLen);
        const yInner = baseY - (pRadius - tabH) * p * ctx.scale;
        const ySurface = baseY - pRadius * p * ctx.scale;
        // A tab lies inside the airframe by definition, so while the figure is
        // a wireframe it loses its wash and becomes an outline like everything
        // else — and goes over the body rather than under it. No size floors
        // there either: an edge-on instance's tab projects to nothing, and a
        // floored 1.5 px band riding the centreline is not nothing.
        const hPx = Math.abs(yInner - ySurface);
        if (wire && hPx < 0.5) return;
        (wire ? wires : shapes).push({
          key: `${key}:tab${i}`, layer: wire ? 'wires' : 'base', tag: 'rect',
          attrs: {
            x: ctx.x0 + front * ctx.scale, y: Math.min(yInner, ySurface),
            width: Math.max(2, tabLen * ctx.scale), height: wire ? hPx : Math.max(1.5, hPx),
            fill: wire ? 'none' : fillOf(child, '#b9b7b0'), fillOpacity: wire ? undefined : '0.35',
            stroke: '#7a786f', strokeWidth: '1', strokeDasharray: '3 2',
            style: { pointerEvents: 'none' },
          },
        });
      };
      if (t === 'freeformfinset') {
        const raw = (child['points'] as [number, number][] | undefined) ?? [];
        if (raw.length >= 3) {
          // TWO different lengths, deliberately. `chord` is the drawn EXTENT —
          // a freeform fin may legitimately overhang its own root, and the
          // silhouette (and its hover box) has to show that. `axialLength` is
          // the kernel's LENGTH for the same fin (FreeformFinSet.java: the
          // last point's x, the root chord), and BOTH the fin's station and
          // its tab are resolved against that. v0.105 aligned the tab and
          // left the station on `chord`, so a 'bottom'/'middle'-anchored fin
          // with an overhanging tip was drawn forward of where the kernel
          // flew it by the overhang — 119.5 mm on `ninja_4in_54mm-MMT.ork`,
          // with the property panel printing the kernel's station beside it.
          // finCutOutline (solidMesh.ts:372) and the printed template
          // (finTemplate.ts) both use the kernel's definition too.
          const chord = Math.max(...raw.map((p) => p[0]));
          const tabChord = Math.max(0, raw[raw.length - 1]![0]);
          const start = axialStart(child, axialLength(child), pStart, pLen);
          const ymax = Math.max(0, ...raw.map((p) => p[1]));
          const reach = pRadius + ymax;
          const projections = finFactors(child);
          noteHoverFins(child, ctx.x0 + start * ctx.scale, ctx.x0 + (start + chord) * ctx.scale,
            baseY, reach, pRadius, projections);
          const clip = airframeClip(baseY, pRadius);
          for (const { p, near, i } of projections) {
            const ptsStr = raw
              .map(([px, py]) => `${ctx.x0 + (start + px) * ctx.scale},${baseY - (pRadius + py) * p * ctx.scale}`)
              .join(' ');
            // Rolled: an outline, unclipped, over the body. Every instance is
            // drawn — including one lying flat inside the airframe, which is
            // exactly the one you need on screen to follow a fin round.
            if (wire) {
              pushWire(child, part, clip, `${key}:fin${i}`, 'polygon', { points: ptsStr });
              renderTab(start, tabChord, p, i);
              continue;
            }
            // The same extent rule for both sides: a fin whose whole
            // silhouette is inside the airframe outline has nothing to draw,
            // and a NEAR one at that angle is edge-on — drawing it unclipped
            // would put a bar down the centreline of the fin can.
            if (reach * Math.abs(p) > pRadius) {
              (near ? overlay : shapes).push({
                key: `${key}:fin${i}`, layer: near ? 'overlay' : 'base', tag: 'polygon', part, sel: true,
                attrs: {
                  points: ptsStr, clipPath: near ? undefined : `url(#${clip})`,
                  fill: fillOf(child, '#b9b7b0'), stroke: '#7a786f', strokeWidth: 1,
                },
              });
              renderTab(start, tabChord, p, i);
            }
          }
        }
      } else if (t === 'trapezoidfinset' || t === 'ellipticalfinset') {
        const root = num(child, 'rootChord', 0.05);
        const tip = t === 'trapezoidfinset' ? num(child, 'tipChord', root * 0.6) : 0;
        const sweep = t === 'trapezoidfinset' ? num(child, 'sweep', 0.02) : root / 2;
        const height = num(child, 'height', 0.03);
        const start = axialStart(child, root, pStart, pLen);
        const reach = pRadius + height;
        const projections = finFactors(child);
        noteHoverFins(child, ctx.x0 + start * ctx.scale,
          ctx.x0 + (start + Math.max(root, sweep + tip)) * ctx.scale,
          baseY, reach, pRadius, projections);
        const finClip = airframeClip(baseY, pRadius);
        for (const { p, near, i } of projections) {
          const y0 = baseY - pRadius * p * ctx.scale;
          const yh = baseY - reach * p * ctx.scale;
          const X = ctx.x0 + start * ctx.scale;
          // A TRUE half-ellipse, by arc. It used to be a quadratic with the
          // tip as the CONTROL point — and a quadratic passes through
          // (P0 + 2C + P2)/4, i.e. exactly halfway to its control, so an
          // elliptical fin drew at 57 % of the height its own property panel,
          // its 1:1 cut template, the Aft view and the 3D mesh all give it.
          //
          // The 2 px ry floor is for the AT-REST drawing only (a sliver of a
          // fin still reads as one). Wired, the floor kept an edge-on ellipse
          // as a 2 px lens whose bulge side flips with the sign of p — the
          // raw value lets it degenerate to the line the other shapes draw
          // (an arc with ry 0 renders as a straight segment, per SVG).
          const ry = Math.abs(y0 - yh);
          const ellipse = `M ${X} ${y0} A ${(root / 2) * ctx.scale} ${wire ? ry : Math.max(2, ry)} 0 0 ${p > 0 ? 1 : 0} ${X + root * ctx.scale} ${y0} Z`;
          const trap = `${X},${y0} ${X + sweep * ctx.scale},${yh} ${X + (sweep + tip) * ctx.scale},${yh} ${X + root * ctx.scale},${y0}`;
          const [tag, geometry]: [SchematicShape['tag'], Record<string, unknown>] = t === 'trapezoidfinset'
            ? ['polygon', { points: trap }]
            : ['path', { d: ellipse }];
          if (wire) {
            pushWire(child, part, finClip, `${key}:fin${i}`, tag, geometry);
            renderTab(start, root, p, i);
            continue;
          }
          if (reach * Math.abs(p) > pRadius) {
            (near ? overlay : shapes).push({
              key: `${key}:fin${i}`, layer: near ? 'overlay' : 'base', tag, part, sel: true,
              attrs: {
                clipPath: near ? undefined : `url(#${finClip})`, ...geometry,
                fill: fillOf(child, '#b9b7b0'), stroke: '#7a786f', strokeWidth: 1,
              },
            });
            renderTab(start, root, p, i);
          }
        }
      } else if (t === 'tubefinset') {
        // Side view: every tube of the ring, at its projected height. A tube
        // runs PARALLEL to the body axis, so unlike a fin it is not squashed
        // by roll — its silhouette stays 2·rt tall and only its centre moves,
        // to (pRadius + rt)·cos θ. Tubes whose silhouette falls entirely
        // inside the airframe are hidden behind it and dropped; that is the
        // honest form of the old "side tubes project onto the body — omitted"
        // shortcut, which drew exactly two tubes whatever the count.
        const len = num(child, 'length', 0.1);
        const rt = tubeFinRadius(child, pRadius);
        const start = axialStart(child, len, pStart, pLen);
        const X = ctx.x0 + start * ctx.scale;
        noteHover(child, X, baseY - (pRadius + 2 * rt) * ctx.scale,
          X + len * ctx.scale, baseY + (pRadius + 2 * rt) * ctx.scale);
        const tubes = finFactors(child);
        const tubeClip = airframeClip(baseY, pRadius);
        for (const { p, near, i } of tubes) {
          const yc = baseY - (pRadius + rt) * p * ctx.scale;
          const half = rt * ctx.scale;
          const w2 = Math.max(2, len * ctx.scale);
          const axis = {
            x1: X, y1: yc, x2: X + len * ctx.scale, y2: yc,
            stroke: '#7a786f', strokeWidth: '0.8', strokeDasharray: '4 3',
            style: { pointerEvents: 'none' },
          };
          if (wire) {
            pushWire(child, part, tubeClip, `${key}:tube${i}`, 'rect',
              { x: X, y: yc - half, width: w2, height: 2 * half, rx: '2' });
            wires.push({ key: `${key}:axis${i}`, layer: 'wires', tag: 'line', attrs: axis });
            continue;
          }
          const cut = near ? undefined : `url(#${tubeClip})`;
          const shown = (pRadius + rt) * Math.abs(p) + rt > pRadius;
          if (shown) {
            const layer = near ? 'overlay' : 'base';
            (near ? overlay : shapes).push(
              {
                key: `${key}:tube${i}`, layer, tag: 'rect', part, sel: true,
                attrs: {
                  x: X, y: yc - half, clipPath: cut, width: w2, height: 2 * half,
                  rx: '2', fill: fillOf(child, '#c8c5be'), fillOpacity: '0.6',
                  stroke: '#7a786f', strokeWidth: 1,
                },
              },
              { key: `${key}:axis${i}`, layer, tag: 'line', attrs: { ...axis, clipPath: cut } },
            );
          }
        }
      } else if (t === 'fairing') {
        // External shroud: SOLID, at its own mounting angle (v0.087), turned
        // from there by the view roll. It stays solid EVEN WHILE ROLLED — see
        // `solidWhileRolled`.
        const len = num(child, 'length', 0.08);
        const hgt = num(child, 'height', 0.02);
        const ends = shroudEnds(child);
        const start = axialStart(child, len, pStart, pLen);
        const { p: sp, near: snear } = surfaceAt(child);
        const X = ctx.x0 + start * ctx.scale;
        const y0 = baseY - pRadius * sp * ctx.scale;
        const yh = baseY - (pRadius + hgt) * sp * ctx.scale;
        const Xe = X + len * ctx.scale;
        noteHover(child, X, Math.min(y0, yh), Xe, Math.max(y0, yh));
        // ONE path, two independently-shaped ends (v0.088). The three
        // treatments are exactly the ones the old whole-part switch drew — a
        // 30 % ramp, a quadratic dome, a square edge — but each end now picks
        // its own, because a real camera shroud is domed where the lens looks
        // out and tapered at the other end (Eric, 2026-08-31).
        //
        // The runs are clamped in PIXELS, not as a fraction of length: on a
        // short shroud two 30 % ramps meeting in the middle is fine, but two
        // 8 px dome insets are not, and an unclamped inset makes the path
        // self-intersect. `runFor` never lets the two ends claim more than half
        // the drawn length each.
        const px = Math.max(2, len * ctx.scale);
        const runFor = (s: string): number =>
          s === 'box' ? 0
            : Math.min(px / 2, s === 'streamlined' ? 0.3 * px : Math.min(8, 0.25 * px));
        const foreRun = runFor(ends.fore);
        const aftRun = runFor(ends.aft);
        // A dome's shoulder starts 35 % of the way up the face, as it always
        // has; a ramp and a square edge start at the surface.
        const shoulder = (s: string): number => (s === 'halfround' ? yh + 0.35 * (y0 - yh) : y0);
        // Coordinates are written `x,y` rather than `x y` — both are legal SVG,
        // and the comma form is what the extent helpers in the view tests parse
        // out of a `points` list, so one selector serves polygons and paths.
        const endIn = (s: string, xa: number, xb: number): string =>
          s === 'halfround'
            ? `L ${xa},${shoulder(s)} Q ${xa},${yh} ${xb},${yh}`
            : `L ${xb},${yh}`;
        const endOut = (s: string, xa: number, xb: number): string =>
          s === 'halfround'
            ? `L ${xa},${yh} Q ${xb},${yh} ${xb},${shoulder(s)} L ${xb},${y0}`
            : `L ${xb},${y0}`;
        // Behind the airframe: cut at the wall, rolled or not. A shroud is an
        // opaque solid and the tube really does hide it.
        shapes.push({
          key: `${key}:shroud`, layer: 'base', tag: 'path', part, sel: true,
          attrs: {
            'data-part': 'shroud',
            d: `M ${X},${y0} `
              + endIn(ends.fore, X, X + foreRun)
              + ` L ${Xe - aftRun},${yh} `
              + endOut(ends.aft, Xe - aftRun, Xe)
              + ' Z',
            fill: fillOf(child, '#c8c5be'), stroke: '#7a786f', strokeWidth: 1,
            ...(snear ? {} : { clipPath: `url(#${airframeClip(baseY, pRadius)})` }),
          },
        });
      } else if ((t as string) === 'protuberance') {
        // A drag bump on the outside: solid, shaped by its RASAero class — a
        // ramp for an inclined flat plate, a faired nose with a blunt back for
        // "with base drag", faired both ends for "no base drag". Sits at its
        // own mounting angle (v0.087) and stays solid while rolled.
        const len = num(child, 'length', 0.06);
        const hgt = num(child, 'height', 0.01);
        const cls = String(child['dragClass'] ?? 'streamlinedbase');
        const start = axialStart(child, len, pStart, pLen);
        const { p: pp, near: pnear } = surfaceAt(child);
        const X = ctx.x0 + start * ctx.scale;
        const y0 = baseY - pRadius * pp * ctx.scale;
        const yh = baseY - (pRadius + hgt) * pp * ctx.scale;
        const Xe = X + len * ctx.scale;
        noteHover(child, X, Math.min(y0, yh), Xe, Math.max(y0, yh));
        const nose = Math.min(0.35 * (Xe - X), Math.max(2, Math.abs(y0 - yh)));
        shapes.push({
          key: `${key}:bump`, layer: 'base', tag: 'polygon', part, sel: true,
          attrs: {
            points: cls === 'plate'
              ? `${X},${y0} ${Xe},${yh} ${Xe},${y0}`
              : cls === 'streamlined'
                ? `${X},${y0} ${X + nose},${yh} ${Xe - nose},${yh} ${Xe},${y0}`
                : `${X},${y0} ${X + nose},${yh} ${Xe},${yh} ${Xe},${y0}`,
            fill: fillOf(child, '#c8c5be'), stroke: '#7a786f', strokeWidth: 1,
            ...(pnear ? {} : { clipPath: `url(#${airframeClip(baseY, pRadius)})` }),
          },
        });
      } else if (t === 'launchlug' || t === 'railbutton') {
        // A rail button has no axial 'length' — it is about as long as it is
        // wide, so the outer diameter sets the axial extent. What it stands OFF
        // the tube by is a separate dimension, and until v0.103 this view used
        // the diameter for that too (`2 * r`), with a 4 mm fallback against the
        // kernel's 9.7 — so the side view, the 3D view and the flown part each
        // claimed a different button height. Both fallbacks are now the kernel
        // constructor's own (RailButton.java:58-64).
        const btnDia = t === 'railbutton' ? num(child, 'outerDiameter', 0.0097) : 0;
        // A lug's drawn length is `axialLength`'s — the kernel's, and what the
        // drag and the snap ladder resolve it with — so a lug with no length
        // of its own draws where it flies, 50 mm, not 10 (audit 2026-09-22).
        const len = t === 'railbutton' ? btnDia : axialLength(child);
        const r = t === 'railbutton' ? btnDia / 2 : num(child, 'outerRadius', 0.002);
        const btnH = t === 'railbutton' ? num(child, 'totalHeight', 0.0097) : 2 * r;
        // A BUTTON IS CENTRED ON ITS STATION; a lug starts at it (v0.105).
        // `axialLength` is 0 for a rail button and the lug's own length for a
        // lug, so `axialStart` returns the button's CENTRE and the lug's
        // leading edge — matching `RailButton.getInstanceBoundingBox`, which
        // reaches ±OD/2 about the station, and `RocketComponent.java:86`'s
        // `length = 0` that RailButton never overwrites. Drawing the button
        // aft of its station (the old `axialStart(child, btnDia, …)`) put it
        // 4.85 mm from where it flies on a 'top'- or 'bottom'-anchored button,
        // in the opposite direction each way.
        const start = t === 'railbutton'
          ? axialStart(child, axialLength(child), pStart, pLen) - len / 2
          : axialStart(child, len, pStart, pLen);
        // Its own mounting angle places it (v0.087); the view roll turns it
        // from there. Solid at every roll — a button is a lump, not a line.
        const { p: lp, near: lnear } = surfaceAt(child);
        const ySurf = baseY - pRadius * lp * ctx.scale;
        const yOut = baseY - (pRadius + btnH) * lp * ctx.scale;
        // LINE INSTANCES (v0.089): one node is N collinear copies at the same
        // clock angle, instance 0 forward and the rest marching AFT at
        // `instanceSeparation` spacing — the kernel's own convention
        // (RailButton.getInstanceOffsets), which the sim now flies too.
        const liCount = lineInstanceCount(child);
        const liSep = num(child, 'instanceSeparation', 0);
        noteHover(child, ctx.x0 + start * ctx.scale, Math.min(ySurf, yOut),
          ctx.x0 + (start + len + (liCount - 1) * liSep) * ctx.scale, Math.max(ySurf, yOut));
        for (let li = 0; li < liCount; li++) {
          const x0 = start + li * liSep;
          shapes.push({
            key: `${key}:${t === 'railbutton' ? 'button' : 'lug'}${li}`, layer: 'base', tag: 'rect', part, sel: true,
            attrs: {
              x: ctx.x0 + x0 * ctx.scale,
              y: Math.min(ySurf, yOut),
              width: Math.max(2, len * ctx.scale), height: Math.max(2, Math.abs(ySurf - yOut)),
              fill: fillOf(child, '#c8c5be'), stroke: '#7a786f', strokeWidth: 1,
              ...(lnear ? {} : { clipPath: `url(#${airframeClip(baseY, pRadius)})` }),
            },
          });
        }
      } else {
        // Internal component: dashed outline inside the parent. A clustered
        // inner tube draws once per cluster position (side-view projection).
        // Per-type stroke color + a small tag differentiate what used to be
        // identical grey boxes (issue 2026-08-05a #21) — tubes/couplers stay
        // neutral (they really are tube segments), payload-type parts get
        // muted colors from the theme-safe midrange.
        const style = TYPE_STYLE[child.type];
        // `axialLength`: the kernel's length, a cleared one included — the one
        // the drag resolves the position with, so the part does not jump when
        // grabbed (audit 2026-09-22; it used to fall back to 25 mm here and
        // there alike, where the kernel builds a 70 mm inner tube).
        const len = axialLength(child);
        const r = Math.min(
          pRadius * 0.85,
          num(child, 'outerRadius', num(child, 'radius', num(child, 'packedRadius', pRadius * 0.7))),
        );
        const start = axialStart(child, len, pStart, pLen);
        const offsets = child.type === 'innertube'
          // The view's roll as its own turn, not added to the rotation — the
          // kernel turns a pattern by MINUS its rotation (cluster.ts).
          ? clusterOffsets(
            child['cluster'] as string | undefined,
            num(child, 'outerRadius', 0.0095),
            num(child, 'clusterScale', 1),
            num(child, 'clusterRotation', 0),
            { radialDirection: num(child, 'radialDirection', 0), viewRoll: roll },
          )
          : [{ y: 0, z: 0 }];
        // An inner tube can also sit OFF the centreline on its own, with no
        // cluster involved — desktop's "split cluster" is exactly that, each
        // motor tube at its own radius and angle. The aft view has drawn it
        // since v0.078 (AftView.tsx:215-217) and this view did not, so a split
        // cluster spread out end-on and stacked on the axis from the side.
        // Only the +y component projects into a side view; the view roll turns
        // the pair, same as every other radial part here.
        const radY = child.type === 'innertube'
          ? num(child, 'radialPosition', 0) * Math.cos(num(child, 'radialDirection', 0) + roll)
          : 0;
        // Loaded motor: a brownish silhouette at the REAL case size, seated
        // flush against the mount's aft end (how motors actually load).
        const motor = child.type === 'innertube' && child.id ? motors?.[child.id] : undefined;
        offsets.forEach((off, j) => {
          // −y: the cross-section frame's +y is UP, and SVG y grows down.
          const oy = baseY - (radY + off.y) * ctx.scale;
          const ink = fillOf(child, style?.stroke ?? '#9a978f');
          noteHover(child, ctx.x0 + start * ctx.scale, oy - r * ctx.scale,
            ctx.x0 + (start + len) * ctx.scale, oy + r * ctx.scale);
          overlay.push({
            key: `${key}:inner${j}`, layer: 'overlay', tag: 'rect', part, sel: true,
            title: child.name ?? DISPLAY_NAME[child.type],
            attrs: {
              x: ctx.x0 + start * ctx.scale,
              y: oy - r * ctx.scale,
              width: Math.max(2, len * ctx.scale), height: 2 * r * ctx.scale,
              fill: child.type === 'bulkhead' ? 'url(#bulkhead-hatch)' : 'rgba(127,127,127,0.001)',
              stroke: ink, strokeWidth: 1,
              strokeDasharray: '3 2',
            },
          });
          // Miniature glyphs (the owner's pick, 2026-08-05b #21): a picture inside
          // the box for chutes, mass items, centering rings and shock cords,
          // drawn whenever there's room; the text tag stays for the rest.
          const bw = len * ctx.scale;
          const bh = 2 * r * ctx.scale;
          const gcx = ctx.x0 + (start + len / 2) * ctx.scale;
          const gcy = oy;
          const gs = Math.min(bw * 0.8, bh * 0.7); // glyph box size
          if (gs >= 8) {
            const g = gs / 2;
            const glyphProps = { stroke: ink, fill: 'none', strokeWidth: 1.2, style: { pointerEvents: 'none' as const } };
            const glyph = (children: SchematicShape[]): SchematicShape =>
              ({ key: `${key}:glyph${j}`, layer: 'overlay', tag: 'g', attrs: glyphProps, children });
            const el = (tag: SchematicShape['tag'], attrs: Record<string, unknown>, i: number): SchematicShape =>
              ({ key: String(i), layer: 'overlay', tag, attrs });
            if (child.type === 'parachute') {
              overlay.push(glyph([
                el('path', { d: `M ${gcx - g} ${gcy} A ${g} ${g} 0 0 1 ${gcx + g} ${gcy}` }, 0),
                el('path', { d: `M ${gcx - g} ${gcy} L ${gcx} ${gcy + g} L ${gcx + g} ${gcy} M ${gcx - g * 0.45} ${gcy - g * 0.65} L ${gcx} ${gcy + g} M ${gcx + g * 0.45} ${gcy - g * 0.65} L ${gcx} ${gcy + g}` }, 1),
              ]));
            } else if (child.type === 'masscomponent') {
              overlay.push(glyph([
                el('rect', {
                  x: gcx - g * 0.7, y: gcy - g * 0.35, width: g * 1.4, height: g * 1.05,
                  fill: ink, fillOpacity: '0.35',
                }, 0),
                el('path', { d: `M ${gcx - g * 0.35} ${gcy - g * 0.35} A ${g * 0.4} ${g * 0.5} 0 0 1 ${gcx + g * 0.35} ${gcy - g * 0.35}` }, 1),
              ]));
            } else if (child.type === 'centeringring') {
              // Ring cross-section: material near the walls, bore in the middle.
              overlay.push(glyph([
                el('line', { x1: gcx, y1: gcy - bh / 2 + 1.5, x2: gcx, y2: gcy - bh * 0.16, strokeWidth: Math.max(2, bw * 0.5) }, 0),
                el('line', { x1: gcx, y1: gcy + bh * 0.16, x2: gcx, y2: gcy + bh / 2 - 1.5, strokeWidth: Math.max(2, bw * 0.5) }, 1),
              ]));
            } else if (child.type === 'shockcord') {
              const seg = gs / 4;
              overlay.push({
                key: `${key}:glyph${j}`, layer: 'overlay', tag: 'path',
                attrs: {
                  ...glyphProps,
                  d: `M ${gcx - g} ${gcy} ${[1, 2, 3, 4].map((i) => `L ${gcx - g + i * seg * 2 - seg} ${gcy + (i % 2 ? -1 : 1) * g * 0.45} L ${gcx - g + i * seg * 2} ${gcy}`).join(' ')}`,
                },
              });
            }
          }
          // Type tag, when the box has room for it — glyph types skip the
          // text once their picture is drawn. Counter-rotated tags read
          // horizontally in vertical mode, so the room roles swap.
          const hasGlyph = gs >= 8
            && ['parachute', 'masscomponent', 'centeringring', 'shockcord'].includes(child.type);
          const tagRoom = vertical
            ? 2 * r * ctx.scale > 26 && len * ctx.scale > 11
            : len * ctx.scale > 26 && 2 * r * ctx.scale > 11;
          if (style && !hasGlyph && tagRoom) {
            const tx = ctx.x0 + (start + len / 2) * ctx.scale;
            const ty = oy;
            overlay.push({
              key: `${key}:tag${j}`, layer: 'overlay', tag: 'text', text: style.tag,
              attrs: {
                x: tx, y: ty, textAnchor: 'middle', dominantBaseline: 'central',
                fontSize: '8.5', fill: fillOf(child, style.stroke), ...textUp(tx, ty),
                style: { pointerEvents: 'none', textTransform: 'uppercase', letterSpacing: '0.04em' },
              },
            });
          }
          if (motor) {
            overlay.push(...motorShapes('overlay', `${key}:motor${j}`,
              motor, start + len - motor.length + num(child, 'motorOverhang', 0),
              oy));
          }
        });
        // Children ride the tube's own radial offset (not its cluster copies —
        // there is one child set, and AftView.tsx:234 makes the same choice).
        renderChildren(child, start, len, r, baseY - radY * ctx.scale, scope);
      }
    }
  };

  // Dashed outline for a shoulder sliding inside the adjacent tube. Painted in
  // the overlay pass — an aft shoulder lives inside the NEXT tube, which is
  // drawn later and would otherwise cover it.
  const shoulderRect = (key: string, startX: number, lenSi: number, rSi: number, color: string, baseY: number) => {
    if (lenSi <= 0 || rSi <= 0) return;
    overlay.push({
      key, layer: 'overlay', tag: 'rect',
      attrs: {
        x: ctx.x0 + startX * scale, y: baseY - rSi * scale,
        width: Math.max(1.5, lenSi * scale), height: 2 * rSi * scale,
        fill: 'rgba(127,127,127,0.001)', stroke: color, strokeWidth: '1',
        strokeDasharray: '3 2', style: { pointerEvents: 'none' },
      },
    });
  };

  // Draws an axial nose→tail chain with its centerline at screen `baseY`
  // (ctx.cy for the core rocket; offset for each off-axis pod instance).
  const renderChain = (nodes: ComponentNode[], xStart: number, baseY: number, scope: string) => {
    let cx = xStart;
    for (const n of nodes) {
      const len = num(n, 'length', 0);
      const key = n.type === 'nosecone' || n.type === 'bodytube' || n.type === 'transition'
        ? partKey(n, scope) : '';
      const part = partOf(n, false);
      if (n.type === 'nosecone') {
        const r = num(n, 'aftRadius', 0.012);
        noteHover(n, ctx.x0 + cx * scale, baseY - r * scale, ctx.x0 + (cx + len) * scale, baseY + r * scale);
        shapes.push({
          key: `${key}:nose`, layer: 'base', tag: 'path', part, sel: true,
          attrs: { d: profilePath(ctx, n, cx, len, 0, r, baseY), fill: fillOf(n, '#d5d2cb'), stroke: '#7a786f', strokeWidth: 1 },
        });
        shoulderRect(`${key}:shoulder`, cx + len, num(n, 'shoulderLength', 0), num(n, 'shoulderRadius', 0), '#9a978f', baseY);
        renderChildren(n, cx, len, r, baseY, scope);
        cx += len;
      } else if (n.type === 'bodytube') {
        const r = num(n, 'outerRadius', 0.012);
        noteHover(n, ctx.x0 + cx * scale, baseY - r * scale, ctx.x0 + (cx + len) * scale, baseY + r * scale);
        shapes.push({
          key: `${key}:body`, layer: 'base', tag: 'rect', part, sel: true,
          attrs: {
            x: ctx.x0 + cx * scale, y: baseY - r * scale,
            width: len * scale, height: 2 * r * scale,
            fill: fillOf(n, '#e7e5e0'), stroke: '#7a786f', strokeWidth: 1,
          },
        });
        // Min-diameter: a motor loaded directly in this body tube draws at its
        // real case size, seated flush against the tube's aft end.
        const tubeMotor = n.id ? motors?.[n.id] : undefined;
        if (tubeMotor) {
          shapes.push(...motorShapes('base', `${key}:motor`,
            tubeMotor, cx + len - tubeMotor.length + num(n, 'motorOverhang', 0), baseY));
        }
        renderChildren(n, cx, len, r, baseY, scope);
        cx += len;
      } else if (n.type === 'transition') {
        const rf = num(n, 'foreRadius', 0.012);
        const ra = num(n, 'aftRadius', 0.009);
        noteHover(n, ctx.x0 + cx * scale, baseY - Math.max(rf, ra) * scale,
          ctx.x0 + (cx + len) * scale, baseY + Math.max(rf, ra) * scale);
        shapes.push({
          key: `${key}:transition`, layer: 'base', tag: 'path', part, sel: true,
          attrs: { d: profilePath(ctx, n, cx, len, rf, ra, baseY), fill: fillOf(n, '#d5d2cb'), stroke: '#7a786f', strokeWidth: 1 },
        });
        const fsl = num(n, 'foreShoulderLength', 0);
        shoulderRect(`${key}:shoulder-fore`, cx - fsl, fsl, num(n, 'foreShoulderRadius', 0), '#9a978f', baseY);
        shoulderRect(`${key}:shoulder-aft`, cx + len, num(n, 'aftShoulderLength', 0), num(n, 'aftShoulderRadius', 0), '#9a978f', baseY);
        renderChildren(n, cx, len, Math.max(rf, ra), baseY, scope);
        cx += len;
      }
    }
  };

  renderChain(axialChain(tree), 0, ctx.cy, '');

  // The three layers in the order they are painted — and tabbed.
  const all = [...shapes, ...overlay, ...wires];
  // Keys are identities, and identities are unique while node ids are; a
  // design that somehow carries a duplicate id still gets distinct keys, the
  // later copy suffixed, so React never reconciles one part onto another.
  const used = new Map<string, number>();
  for (const s of all) {
    const n = used.get(s.key);
    used.set(s.key, (n ?? 0) + 1);
    if (n !== undefined) s.key = `${s.key}~${n}`;
  }
  return { shapes: all, clips, extents, grips };
}

/**
 * Closed side-view outline of a nose cone (foreR = 0) or transition, sampled
 * from the kernel-exact profile: top edge fore→aft, aft edge down, bottom
 * edge aft→fore, Z closes the fore edge.
 */
function profilePath(
  ctx: { scale: number; x0: number }, n: ComponentNode, x: number, len: number,
  foreR: number, aftR: number, baseY: number,
): string {
  const shape = typeof n['shape'] === 'string' ? (n['shape'] as string)
    : n.type === 'transition' ? 'conical' : 'ogive';
  // node['clipped'] (.ork <shapeclipped>) rides along so an unclipped
  // transition draws the way it simulates; absent = kernel default (clipped).
  const pts = outerProfile(shape, numOpt(n, 'shapeParameter'), len, foreR, aftR, 24, undefined,
    typeof n['clipped'] === 'boolean' ? (n['clipped'] as boolean) : undefined);
  const px = (xi: number) => ctx.x0 + (x + xi) * ctx.scale;
  const top = pts.map(([xi, r]) => `${px(xi)} ${baseY - r * ctx.scale}`);
  const bottom = pts.slice().reverse().map(([xi, r]) => `${px(xi)} ${baseY + r * ctx.scale}`);
  return `M ${top.join(' L ')} L ${bottom.join(' L ')} Z`;
}
