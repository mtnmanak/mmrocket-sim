import type { SchematicSnap } from './schematicLayout.js';

type Point = [number, number];
type Geometry =
  | { kind: 'outline'; points: Point[]; closed?: boolean }
  | { kind: 'sections'; sections: Point[]; offset?: number; endCentres?: boolean }
  | { kind: 'seatedPrism'; start: number; length: number; radius: number; height: number; halfWidth: number; curvedBase: boolean; shapedRoof?: boolean }
  | { kind: 'radialCylinder'; station: number; radius: number; surface: number; height: number };

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
  if (geometry.kind === 'sections') {
    const baseline = centre + (geometry.offset ?? 0) * p;
    const outline: Point[] = [...geometry.sections.map(([x, r]): Point => [x, baseline + r]),
      ...geometry.sections.slice().reverse().map(([x, r]): Point => [x, baseline - r])];
    const ends = [geometry.sections[0], geometry.sections.at(-1)];
    return { points: [...outline, ...(geometry.endCentres ? ends.map(section => [section![0], baseline] as Point) : [])],
      outline, hiddenBand };
  }
  if (geometry.kind === 'seatedPrism') {
    const { start, length, radius, height, halfWidth, curvedBase } = geometry;
    const vertices: [number, number, number][] = [];
    const floor = (z: number) => curvedBase ? Math.sqrt(Math.max(0, radius * radius - z * z)) : radius;
    const zs = [-halfWidth, 0, halfWidth];
    if (curvedBase) {
      const reach = Math.asin(halfWidth / radius);
      const turn = Math.atan2(Math.sin(angle), p);
      for (let k = -1; k <= 1; k++) {
        const phi = k * Math.PI - turn;
        if (Math.abs(phi) <= reach) zs.push(radius * Math.sin(phi));
      }
    }
    for (const x of [start, start + length]) for (const z of zs) vertices.push([x, floor(z), z]);
    // Shaped roofs reach full height at mid-length; their end caps need not.
    for (const x of geometry.shapedRoof ? [start + length / 2] : [start, start + length / 2, start + length]) {
      for (const z of [-halfWidth, halfWidth]) vertices.push([x, radius + height, z]);
    }
    return { points: vertices.map(([x, y, z]) => [x, centre + y * p - z * Math.sin(angle)]), hiddenBand };
  }
  // Radial cylinders have end disks in the axial/tangential plane. Their
  // projected radial radius is r*|sin(angle)|, unlike an axial cylinder.
  const { station, radius, surface, height } = geometry;
  const half = radius * Math.abs(Math.sin(angle));
  const ends = [surface * p, (surface + height) * p];
  const points: Point[] = ends.flatMap(y => [[station, centre + y - half], [station, centre + y + half],
    [station - radius, centre + y], [station + radius, centre + y]] as Point[]);
  // Intersect the actual end ellipses with the airframe, rather than chords
  // between their extreme stations (which would invent physical corners).
  if (hiddenRadius !== undefined && half > 0) for (const edge of [-hiddenRadius, hiddenRadius]) {
    for (const y of ends) {
      const fraction = (edge - y) / half;
      if (Math.abs(fraction) <= 1) {
        const dx = radius * Math.sqrt(Math.max(0, 1 - fraction * fraction));
        points.push([station - dx, centre + edge], [station + dx, centre + edge]);
      }
    }
  }
  return { points, hiddenBand };
}
