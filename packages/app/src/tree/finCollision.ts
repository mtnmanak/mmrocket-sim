import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { finCoordinateProblem, finOutlineIntersection, finOutlinesMeet, kernelFinPoints } from './finOutline.js';
import { finOnMount, flatMount } from './finRoot.js';
import { KERNEL_DEFAULT_FIN_POINTS, kernelNum } from './kernelDefaults.js';
import { axialLength, positionOf, startFromPosition } from './position.js';
import { enclosesArea } from './polygon.js';
import { finPlanformPoints } from './solidMesh.js';
import { tubeFinRadius } from './tubefins.js';

export interface FinComparisonBudget {
  comparisons: number;
  limit: number;
}

/**
 * Sibling planforms in one parent frame, shared by import and Align fins.
 * Only constant-radius body tubes, parent-relative positions and valid single
 * lobes are sound here. Undefined means keep the caller's old span decision;
 * budget.comparisons > budget.limit distinguishes work exhaustion.
 */
export function finCollisionFor(_tree: RocketTree, parent: ComponentNode) {
  const length = axialLength(parent);
  const radius = kernelNum(parent, 'outerRadius');
  const mount = flatMount(radius, length);
  const outlines = new Map<ComponentNode, [number, number][] | undefined>();
  const outline = (node: ComponentNode, budget: FinComparisonBudget): [number, number][] | undefined => {
    if (outlines.has(node)) return outlines.get(node);
    const dimensions = node.type === 'tubefinset' ? ['length', 'outerRadius']
      : ['rootChord', 'tipChord', 'sweep', 'height'];
    if (dimensions.some(key => node[key] !== undefined && !Number.isFinite(node[key]))) return undefined;
    if (dimensions.some(key => key !== 'sweep' && kernelNum(node, key) < 0)) return undefined;
    const position = positionOf(node);
    // Import de-collision precedes resolveAbsolutePositions and base extensions;
    // Auto-align also receives unresolved absolute positions. Do not guess.
    if (!['top', 'middle', 'bottom'].includes(position.method) || !Number.isFinite(position.offset)) return undefined;
    const start = startFromPosition(position, axialLength(node), length);
    if (!Number.isFinite(start)) return undefined;
    let placed: [number, number][];
    if (node.type === 'tubefinset') {
      const height = 2 * tubeFinRadius(node, radius);
      const end = start + axialLength(node);
      placed = [[start, radius], [end, radius], [end, radius + height], [start, radius + height]];
    } else {
      let points: [number, number][] | null;
      if (node.type === 'freeformfinset') {
        const raw = node['points'];
        // Missing points fly a kernel default, not a known explicit outline.
        if (!Array.isArray(raw) || raw.some(p => !Array.isArray(p))) return undefined;
        points = (raw as [number, number][]).map(([x, y]) => [x, y]);
        if (finCoordinateProblem(points)) return undefined;
        // The importer writes this fallback explicitly for absent/bad points.
        // Conservatively exclude matching outlines too: provenance is unknown.
        if (points.length === KERNEL_DEFAULT_FIN_POINTS.length && KERNEL_DEFAULT_FIN_POINTS.every(
          ([x, y], i) => x === points![i]![0] && y === points![i]![1])) return undefined;
        // Interior surface contacts or buried points can split the fin into
        // lobes or leave an empty run along the body. Keep the old span rule.
        if (points.slice(1, -1).some(([, y]) => y <= 1e-9)) return undefined;
        const normalized = kernelFinPoints(points);
        if (normalized.some(([x, y], i) => x !== points![i]![0] || y !== points![i]![1])) return undefined;
      } else {
        if (node.type !== 'trapezoidfinset' && node.type !== 'ellipticalfinset') return undefined;
        points = finPlanformPoints(node);
        if (!points) return undefined;
        // Mesh contours drop a closing point within 0.1 micrometres of the
        // first. Seating needs the user's exact trailing ROOT endpoint:
        // without it a zero-root-chord fin's trailing tip becomes the root.
        const rootEnd: [number, number] = [kernelNum(node, 'rootChord'), 0];
        const last = points.at(-1)!;
        if (last[0] !== rootEnd[0] || last[1] !== rootEnd[1]) points.push([...rootEnd]);
        // A zero tip chord (a triangle) comes back with its tip twice; the
        // repeated vertex makes a zero-length edge that the self-intersection
        // check reads as a crossing. Drop exact consecutive repeats.
        points = points.filter((p, i) => i === 0 || p[0] !== points![i - 1]![0] || p[1] !== points![i - 1]![1]);
      }
      if (finCoordinateProblem(points) || points[0]![0] !== 0 || points[0]![1] !== 0
        || points.at(-1)![1] !== 0) return undefined;
      // Validation is quadratic too. Reserve it before inspecting edge pairs.
      budget.comparisons += points.length * points.length;
      if (budget.comparisons > budget.limit) return undefined;
      if (finOutlineIntersection(points)) return undefined;
      const seated = finOnMount(points, start, mount);
      if (seated.lobes.length !== 1) return undefined;
      placed = seated.lobes[0]!.map(([x, y]) => [start + x, y + seated.r0]);
    }
    if (!enclosesArea(placed)) return undefined;
    outlines.set(node, placed);
    return placed;
  };
  return (a: ComponentNode, b: ComponentNode, budget: FinComparisonBudget): boolean | undefined => {
    if (parent.type !== 'bodytube' || (parent['outerRadius'] !== undefined && !Number.isFinite(parent['outerRadius']))
      || (parent['length'] !== undefined && !Number.isFinite(parent['length']))
      || !Number.isFinite(radius) || radius < 0
      || !Number.isFinite(length) || length <= 0) return undefined;
    if (++budget.comparisons > budget.limit) return undefined;
    const first = outline(a, budget), second = outline(b, budget);
    if (!first || !second) return undefined;
    // Reserve the worst case before entering the quadratic edge loop. Include
    // linear area/containment walks, even when edge contact would finish early.
    const work = first.length * second.length + 2 * (first.length + second.length);
    budget.comparisons += work;
    if (budget.comparisons > budget.limit) return undefined;
    return finOutlinesMeet(first, second);
  };
}
