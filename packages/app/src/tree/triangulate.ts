import { ShapeUtils, Vector2 } from 'three';

/**
 * Polygon triangulation, isolated in its own module ON PURPOSE.
 *
 * This one call was the last thing keeping three.js in the app's INITIAL
 * bundle. solidMesh is reachable from the design screen (PropertyPanel), so a
 * top-level `import { ShapeUtils } from 'three'` there made Rollup hoist the
 * whole 200 KB-gzipped library into the entry chunk — even after the 3D view
 * and every 3D exporter had been made lazy, because a library shared between
 * an eager module and a lazy one lands in the common chunk.
 *
 * Kept as three's own ear-clipper rather than a hand-rolled one: this feeds the
 * meshes people 3D-print and fly, and a subtly wrong triangulation would be
 * invisible until a part came out of the printer wrong. The only change is
 * WHEN it loads — extrudePolygon awaits this module, which is reached solely
 * from click handlers (an STL/DXF export), never from a render.
 */
export function triangulateOutline(outline: Array<[number, number]>): number[][] {
  return ShapeUtils.triangulateShape(outline.map(([x, y]) => new Vector2(x, y)), []);
}
