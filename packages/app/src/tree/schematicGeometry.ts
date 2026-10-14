import type { SchematicSnap } from './schematicLayout.js';

type Point = [number, number];
type Geometry =
  | { kind: 'outline'; points: Point[]; closed?: boolean }
  | { kind: 'sections'; sections: Point[]; offset?: number };

/** N044: project true model geometry, never SVG dimensions or visibility floors.
 * Sections are circles normal to the rocket axis: roll moves their centre,
 * preserving their radius. Outline vertices rotate with their radial plane.
 */
export function projectSchematicGeometry(geometry: Geometry, centre: number, angle = 0, hiddenRadius?: number): SchematicSnap {
  const p = Math.cos(angle);
  const hiddenBand: Point | undefined = hiddenRadius === undefined ? undefined : [centre - hiddenRadius, centre + hiddenRadius];
  if (geometry.kind === 'outline') {
    const points = geometry.points.map(([x, y]): Point => [x, centre + y * p]);
    return { points, outline: geometry.closed === false ? undefined : points, hiddenBand };
  }
  const baseline = centre + (geometry.offset ?? 0) * p;
  const outline: Point[] = [...geometry.sections.map(([x, r]): Point => [x, baseline + r]),
    ...geometry.sections.slice().reverse().map(([x, r]): Point => [x, baseline - r])];
  return { points: outline, outline, hiddenBand };
}
