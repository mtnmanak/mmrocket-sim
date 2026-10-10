import { useRef, useState, type RefObject } from 'react';
import { releasedDuring, startsGesture } from '../chartPanZoom.js';
import { pxToGuide, type Guide, type GuideAxis, type GuideView } from '../services/rulerGuides.js';

/**
 * The measuring guides' state and drag (services/rulerGuides.ts has the why).
 *
 *  • Press on a ruler and drag: a new guide follows the pointer. A plain click
 *    on a ruler drops one where it was clicked.
 *  • Press on a guide and drag: it moves. Drag it back onto its own ruler and
 *    let go: it is removed.
 *
 * The drag is tied to the pointer that started it, like the axial drag and
 * the pan beside it — a second finger neither moves the guide nor ends it.
 */
export function useRulerGuides({ svgRef, viewWidth, gutX, gutY }: {
  svgRef: RefObject<SVGSVGElement | null>;
  /** The svg's viewBox width — px per CSS px is viewWidth / rendered width. */
  viewWidth: number;
  /** The left ruler's inner edge and the top ruler's lower edge, viewBox px. */
  gutX: number;
  gutY: number;
}) {
  const [guides, setGuides] = useState<Guide[]>([]);
  const nextId = useRef(1);
  const drag = useRef<{ id: number; axis: GuideAxis; pointerId: number; fresh: boolean; left: boolean } | null>(null);

  /** The pointer in viewBox px, or null while the svg has no size. */
  const pointAt = (e: { clientX: number; clientY: number }): { x: number; y: number } | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    const s = viewWidth / rect.width;
    return { x: (e.clientX - rect.left) * s, y: (e.clientY - rect.top) * s };
  };
  /** Is the pointer on the ruler this axis's guides come out of? */
  const onOwnRuler = (axis: GuideAxis, p: { x: number; y: number }) =>
    (axis === 'x' ? p.y < gutY : p.x < gutX);

  const capture = (e: React.PointerEvent) => {
    e.stopPropagation(); // the background pan must not arm under a guide
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };

  /** A press on a ruler: a new guide at the pointer, already being dragged. */
  const create = (axis: GuideAxis, view: GuideView, e: React.PointerEvent) => {
    if (!startsGesture(e)) return;
    const p = pointAt(e);
    if (!p) return;
    const id = nextId.current++;
    setGuides((gs) => [...gs, { id, axis, m: pxToGuide(view, axis, axis === 'x' ? p.x : p.y) }]);
    drag.current = { id, axis, pointerId: e.pointerId, fresh: true, left: false };
    capture(e);
  };

  /** A press on an existing guide. */
  const grab = (g: Guide, e: React.PointerEvent) => {
    if (!startsGesture(e)) return;
    drag.current = { id: g.id, axis: g.axis, pointerId: e.pointerId, fresh: false, left: true };
    capture(e);
  };

  /** Drives a live guide drag; true when this move was the guide's. */
  const move = (view: GuideView, e: React.PointerEvent): boolean => {
    const d = drag.current;
    if (!d) return false;
    if (e.pointerId !== d.pointerId) return true; // a second finger moves nothing
    if (releasedDuring(e)) { end(e); return true; }
    const p = pointAt(e);
    if (!p) return true;
    if (!onOwnRuler(d.axis, p)) d.left = true;
    const m = pxToGuide(view, d.axis, d.axis === 'x' ? p.x : p.y);
    setGuides((gs) => gs.map((g) => (g.id === d.id ? { ...g, m } : g)));
    return true;
  };

  /** Ends the drag its own pointer started. Released on its ruler after
   *  leaving it, the guide goes; a click that never left the ruler keeps it. */
  const end = (e: { pointerId: number; clientX: number; clientY: number }) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    const p = pointAt(e);
    if (p && d.left && onOwnRuler(d.axis, p)) setGuides((gs) => gs.filter((g) => g.id !== d.id));
  };

  /** A capture the browser took away ends the drag where it stands. */
  const lostCapture = (e: { pointerId: number }) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  };

  const clear = () => { drag.current = null; setGuides([]); };

  return { guides, create, grab, move, end, lostCapture, clear, dragging: () => drag.current !== null };
}
