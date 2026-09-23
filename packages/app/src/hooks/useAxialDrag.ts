import { useMemo, useRef, useState, type RefObject } from 'react';
import type { ComponentPosition, RocketTree } from '@online-openrocket/engine';
import {
  anchorStarts, axialLength, offsetForStart, snapStart, startFromPosition,
} from '../tree/position.js';
import { updateNode } from '../tree/treeModel.js';
import { releasedDuring, startsGesture } from '../chartPanZoom.js';
import type { Grip } from '../tree/schematicLayout.js';

/**
 * THE 2D SIDE VIEW'S AXIAL DRAG — a part pressed on the drawing slides along
 * its parent, snapping to structural anchors (tube ends, sibling edges).
 * Extracted from TreeSchematic's render body (audit 2026-09-22) together with
 * the layout it drags (tree/schematicLayout.ts).
 *
 * A DRAG IS A LOCAL PREVIEW, COMMITTED ONCE, ON RELEASE (audit 2026-09-22,
 * Performance). Every move used to write the design — `onPatchNode`, which
 * App maps to `setTree` — and App rebuilds the kernel from the tree in render:
 * 73 ms a move on kitchensink.ork by the audit's measure, so a complex design
 * dragged at ~13 fps, and a drag with a pause of more than 800 ms in it spent
 * more than one undo step. Now a move changes only what THIS view draws (the
 * same drag on kitchensink.ork with the real kernel rebuilding as App does:
 * 19 moves a second before, ~700 after, one rebuild): `shown` is the
 * design with the part at the pointer, laid out by the same pure layout, and
 * the design itself is written once when the gesture ends — one undo step and
 * one rebuild, whatever the drag's length. What the preview draws is exactly
 * what the commit produces: the same `updateNode` patch App applies.
 *
 * What that costs: the CG and CP markers, and every figure outside this view,
 * are the design's — they move when the part is let go, not while it slides.
 *
 * The gesture rules are the audit's, and each has a test in
 * TreeSchematic.pointer.test.tsx: the gesture belongs to ONE pointer and the
 * primary button (startsGesture), a release this view never saw ends it
 * (releasedDuring), and nothing moves until the press has travelled past
 * PAN_SLOP — below that it is a click. However the gesture ends — release,
 * leave, cancel, a lost capture — what was on screen is what is committed:
 * that is where a drag that wrote every move used to leave the part. (The
 * fin-point editor drops a cancelled drag instead; it always previewed.)
 */

/** Client px a press may wander before it counts as a pan or a drag rather
 *  than a click — ONE threshold for both gestures (TreeSchematic's pan reads
 *  it too), because a physical click jitters 1-3 px whichever of them it could
 *  turn into. */
export const PAN_SLOP = 4;

interface DragState {
  childId: string;
  grip: Grip;
  /** parent-relative start at pointer-down (m) */
  relStart: number;
  pointerX: number;
  /** viewBox px per client px */
  clientScale: number;
  /** The pointer that owns this drag; every other pointer's moves are ignored. */
  pointerId: number;
  /** The element the drag captured the pointer to — the only one whose
   *  lostpointercapture ends it (see lostCapture). */
  captured: Element;
  /** Past PAN_SLOP yet. Until then the press is a click and moves NOTHING. */
  active: boolean;
  /** The offset the part carries at the press — the design's own. */
  pressOffset: number;
  /** The offset on screen now: the press's own, then each one previewed. */
  offset: number;
  method: ComponentPosition['method'];
}

/** The part being dragged and where it is on screen. */
interface Preview {
  id: string;
  position: ComponentPosition;
}

export interface AxialDragOptions {
  /** The design as committed. */
  tree: RocketTree;
  /** Where a moved part's new position goes, once, on release. No handler, no drag. */
  onPatchNode?: (id: string, patch: { position: ComponentPosition }) => void;
  svgRef: RefObject<SVGSVGElement | null>;
  /** The viewBox width (px): with the svg's client width, the press's px scale. */
  viewWidth: number;
  /** viewBox px per metre as drawn NOW — the layout scale times the zoom. */
  pxPerMetre: number;
}

export interface AxialDrag {
  /**
   * The design to DRAW: `tree` itself, or — while a drag is live — `tree`
   * with the dragged part at the pointer. Never the design to fly.
   */
  shown: RocketTree;
  /** A press on a draggable part. Stops the press reaching the background pan. */
  begin: (grip: Grip, e: React.PointerEvent) => void;
  /**
   * A pointermove on the drawing: `idle` when no drag is live (the caller may
   * pan), `busy` when one is (whether or not this pointer is its own), and
   * `released` for the drag's own pointer moving with no button down — a
   * release this view never saw, which the caller ends the gesture on.
   */
  move: (e: React.PointerEvent) => 'idle' | 'busy' | 'released';
  /** Ends the drag its OWN pointer started (pointerup, leave, cancel) and commits it. */
  end: (e: React.PointerEvent) => void;
  /** A lost capture ends (and commits) the drag only when it is the capture the drag took. */
  lostCapture: (e: React.PointerEvent) => void;
  /** Clear the "this press became a drag" latch — at the start of EVERY press. */
  resetLatch: () => void;
  /** Whether the current press became a drag: its click must not select. */
  moved: () => boolean;
}

export function useAxialDrag({ tree, onPatchNode, svgRef, viewWidth, pxPerMetre }: AxialDragOptions): AxialDrag {
  const drag = useRef<DragState | null>(null);
  // True once the current gesture moved far enough to be a drag — a click
  // that follows a real drag must not change the selection.
  const dragMoved = useRef(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  // The committed design with ONE position changed, by the very `updateNode`
  // App's onPatchNode applies on release. Only this view reads it: nothing
  // here reaches the kernel, the history or the saved state.
  const shown = useMemo(
    () => (preview ? updateNode(tree, preview.id, { position: preview.position }) : tree),
    [tree, preview],
  );

  const begin = (grip: Grip, e: React.PointerEvent) => {
    const child = grip.child;
    if (!onPatchNode || !child.id || !startsGesture(e)) return;
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    e.stopPropagation(); // don't also start a background pan
    dragMoved.current = false;
    const pos = (child.position ?? { method: 'top', offset: 0 }) as ComponentPosition;
    const captured = e.currentTarget as Element;
    drag.current = {
      pointerId: e.pointerId,
      captured,
      active: false,
      pressOffset: pos.offset,
      offset: pos.offset,
      method: pos.method,
      childId: child.id,
      grip,
      // axialLength is the KERNEL's length: 0 for a rail button (resolving
      // the drag in a 25 mm frame while the drawing used the 9.7 mm outer
      // diameter is what made a snapped button land 15.3 mm from the anchor
      // it snapped to) and the root chord for a freeform fin, so the drag
      // starts from the station the fin is drawn at (schematicLayout.ts).
      relStart: startFromPosition(pos, axialLength(child), grip.pLen),
      pointerX: e.clientX,
      clientScale: viewWidth / rect.width,
    };
    // Taken INSIDE pointerdown, so on touch it replaces the browser's
    // implicit capture before that one ever lands: no lostpointercapture.
    captured.setPointerCapture?.(e.pointerId);
  };

  const move = (e: React.PointerEvent): 'idle' | 'busy' | 'released' => {
    const d = drag.current;
    if (!d || !onPatchNode) return 'idle';
    if (e.pointerId !== d.pointerId) return 'busy';
    if (releasedDuring(e)) return 'released';
    // THE THRESHOLD GATES THE MOVE, not just the click (audit 2026-09-22).
    // It used to set dragMoved and nothing else, so every pointermove of an
    // ordinary click patched the tree and the snap below ran at zero
    // distance: 2 px of jitter moved a fin set 1.5 mm, a fin 3 mm from the
    // tube end snapped onto it without moving at all, and each one was a
    // real edit — CG/CP moved, an undo step went, the design went unsaved.
    if (!d.active) {
      if (Math.abs(e.clientX - d.pointerX) <= PAN_SLOP) return 'busy';
      d.active = true;
      dragMoved.current = true;
    }
    const dxModel = ((e.clientX - d.pointerX) * d.clientScale) / pxPerMetre;
    // The anchor ladder, the drag start above and the commit below all use
    // axialLength — the kernel's frame — so a snapped part lands ON the
    // anchor it snapped to. `grip` is the part and parent AT THE PRESS, so the
    // anchors are the design's, not the preview's.
    const { child, parent, pLen } = d.grip;
    const anchors = anchorStarts(parent, child);
    const epsilon = (6 * 1) / pxPerMetre; // ~6 screen px of magnetism
    const snapped = snapStart(d.relStart + dxModel, anchors, epsilon);
    const offset = offsetForStart(d.method, snapped, axialLength(child), pLen);
    // Inside a snap zone every move lands on the same anchor: nothing to redraw.
    if (offset === d.offset) return 'busy';
    d.offset = offset;
    setPreview({ id: d.childId, position: { method: d.method, offset } });
    return 'busy';
  };

  /**
   * The ONE write of a drag. A part let go where it was pressed — dragged
   * away and back, or held inside the snap zone of its own anchor — is not
   * an edit: no undo step, no rebuild, the design stays saved.
   */
  const finish = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.active && d.offset !== d.pressOffset) {
      onPatchNode?.(d.childId, { position: { method: d.method, offset: d.offset } });
    }
    // Batched with the parent's write, so the next render draws the committed
    // design and no preview — never the old position for a frame in between.
    setPreview(null);
  };

  const end = (e: React.PointerEvent) => {
    if (drag.current?.pointerId === e.pointerId) finish();
  };

  /**
   * The drag captures the pointer on the pressed shape itself, so that is
   * where the browser fires lostpointercapture when it takes the pointer away.
   * A lost capture from anywhere else — on touch, the pan handing the implicit
   * capture over to the svg — is not this drag's (TreeSchematic's
   * onLostCapture has the whole story).
   */
  const lostCapture = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d?.pointerId === e.pointerId && e.target === d.captured) finish();
  };

  return {
    shown, begin, move, end, lostCapture,
    resetLatch: () => { dragMoved.current = false; },
    moved: () => dragMoved.current,
  };
}
