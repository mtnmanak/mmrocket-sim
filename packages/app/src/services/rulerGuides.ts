/**
 * Measuring guides on the 2D side view (@atestani, 2026-10-09: "ruler
 * measuring cursors"). A guide is a line dragged out of a ruler: out of the
 * top ruler it stands across the rocket at one axial station, out of the left
 * ruler it runs along it at one distance from the centreline. Each reads its
 * own position on its ruler's scale, and neighbouring guides on the same axis
 * read the distance between them.
 *
 * A guide is held in METRES on the rocket, not in screen px, so it stays on
 * the same station while the drawing is panned and zoomed — the way the
 * rulers' own ticks follow the view. Pure geometry here; the drag lives in
 * hooks/useRulerGuides.ts and the drawing in components/RulerGuides.tsx.
 */

/** 'x' stands across the rocket (from the top ruler), 'y' runs along it (from the left one). */
export type GuideAxis = 'x' | 'y';

export interface Guide {
  id: number;
  axis: GuideAxis;
  /** 'x': station from the nose tip; 'y': distance from the centreline, positive up. Metres. */
  m: number;
}

/**
 * The drawing's mapping from rocket metres to viewBox px: the layout's own
 * (`x0` the nose tip, `cy` the centreline, `scale` px per metre) followed by
 * the view's zoom and pan — the same composition the rulers are drawn with.
 */
export interface GuideView {
  k: number;
  x: number;
  y: number;
  x0: number;
  cy: number;
  scale: number;
}

export function guideToPx(v: GuideView, axis: GuideAxis, m: number): number {
  return axis === 'x'
    ? v.x + v.k * (v.x0 + m * v.scale)
    : v.y + v.k * (v.cy - m * v.scale);
}

export function pxToGuide(v: GuideView, axis: GuideAxis, px: number): number {
  return axis === 'x'
    ? ((px - v.x) / v.k - v.x0) / v.scale
    : (v.cy - (px - v.y) / v.k) / v.scale;
}

/** Neighbouring guides on one axis, in order, with the distance between each pair (metres). */
export function guideSpans(guides: readonly Guide[], axis: GuideAxis): { a: Guide; b: Guide; d: number }[] {
  const on = guides.filter((g) => g.axis === axis).sort((p, q) => p.m - q.m);
  const out: { a: Guide; b: Guide; d: number }[] = [];
  for (let i = 1; i < on.length; i++) out.push({ a: on[i - 1]!, b: on[i]!, d: on[i]!.m - on[i - 1]!.m });
  return out;
}

/**
 * Decimals a guide reads to, per length unit: about a tenth of a millimetre
 * whatever the unit, which is finer than a pointer can place a line at any
 * zoom the view allows but never pretends to more.
 */
export function guideDigits(unit: string): number {
  switch (unit) {
    case 'mm': return 1;
    case 'cm': return 2;
    case 'in': return 3;
    default: return 4; // m, ft
  }
}
