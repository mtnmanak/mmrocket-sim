export type ViewPoint = [number, number];
export interface FinTransform { scale: number; x: number; y: number }

export const FIN_VIEW_W = 300;
export const FIN_VIEW_H = 170;
const PAD = 22;

export function fitFin(points: ViewPoint[]): FinTransform {
  const minX = Math.min(0, ...points.map((p) => p[0]));
  const maxX = Math.max(0.01, ...points.map((p) => p[0]));
  const minY = Math.min(0, ...points.map((p) => p[1]));
  const maxY = Math.max(0.01, ...points.map((p) => p[1]));
  const scale = Math.min((FIN_VIEW_W - 2 * PAD) / (maxX - minX),
    (FIN_VIEW_H - 2 * PAD) / (maxY - minY));
  return { scale, x: PAD - minX * scale, y: FIN_VIEW_H - PAD + minY * scale };
}

export function finToScreen(t: FinTransform, [x, y]: ViewPoint): ViewPoint {
  return [t.x + x * t.scale, t.y - y * t.scale];
}

export function screenToFin(t: FinTransform, [x, y]: ViewPoint): ViewPoint {
  return [(x - t.x) / t.scale, (t.y - y) / t.scale];
}

export function panFin(t: FinTransform, [dx, dy]: ViewPoint): FinTransform {
  return { ...t, x: t.x + dx, y: t.y + dy };
}

/** N019: only the view changes; anchor zoom at the pointer, even at a limit. */
export function zoomFin(t: FinTransform, [x, y]: ViewPoint, factor: number, fitScale: number): FinTransform {
  if (!(factor > 0) || !Number.isFinite(factor)) return t;
  // N019: coordinate edits change the fit limits; zoom must never reverse direction.
  const scale = factor >= 1
    ? Math.max(t.scale, Math.min(fitScale * 50, t.scale * factor))
    : Math.min(t.scale, Math.max(fitScale / 4, t.scale * factor));
  const ratio = scale / t.scale;
  return { scale, x: x + (t.x - x) * ratio, y: y + (t.y - y) * ratio };
}
