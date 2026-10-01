import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { buildPieces, type Piece } from './pieces.js';
import { outerProfile, profileRadius } from './shapeProfile.js';

/**
 * `buildPieces` is the app's ONE 3D geometry — the 3D tab, File > Save STL,
 * and the OBJ and glTF exporters all call it. Three of those four never mount
 * a canvas, which is why it lives here and not in components/Rocket3D.tsx.
 */

const BODY_R = 0.024;

const withChildren = (children: ComponentNode[]): RocketTree => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: BODY_R },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: BODY_R, children },
    ],
  }],
} as unknown as RocketTree);

describe('the geometry module imports no renderer', () => {
  it('pulls in three, and neither @react-three/fiber nor drei', () => {
    // App.tsx lazy()-loads Rocket3D precisely to keep 3.6 MB of renderer out
    // of the initial bundle, then the STL path used to import() that same
    // module just to reach buildPieces. If this file ever grows an R3F import
    // the split is silently undone again, and nothing else would notice.
    const src = readFileSync(new URL('./pieces.ts', import.meta.url), 'utf8');
    // Import lines only — the module's own doc comment names the two packages
    // it exists to avoid, and that mention is the record of why.
    const imports = src.split('\n').filter((l) => /^\s*import\b/.test(l));
    expect(imports.some((l) => /'three'/.test(l))).toBe(true);
    expect(imports.filter((l) => /@react-three|'react'/.test(l))).toEqual([]);
  });
});

describe('a freeform fin set with no usable points', () => {
  const ffTree = (points: unknown): RocketTree => withChildren([{
    id: 'ff', type: 'freeformfinset', finCount: 3, thickness: 0.003,
    points, position: { method: 'bottom', offset: 0 },
  } as unknown as ComponentNode]);

  it('does not throw on an EMPTY points array', () => {
    // rocksimFile.ts:580 writes exactly this for a <CustomFinSet> whose
    // <PointList> is missing or empty. `?? default` does not substitute for an
    // empty array, so `raw[0]!` was undefined and the non-null assertion threw
    // a TypeError — inside the design screen, which has no error boundary, so
    // switching to the 3D tab blanked the app and lost unsaved work.
    expect(() => buildPieces(ffTree([]))).not.toThrow();
    expect(buildPieces(ffTree([])).pieces.filter((p) => p.key.startsWith('fin'))).toHaveLength(0);
  });

  it('does not throw on a one- or two-point set either', () => {
    expect(() => buildPieces(ffTree([[0, 0]]))).not.toThrow();
    expect(() => buildPieces(ffTree([[0, 0], [0.05, 0]]))).not.toThrow();
    expect(buildPieces(ffTree([[0, 0], [0.05, 0]])).pieces
      .filter((p) => p.key.startsWith('fin'))).toHaveLength(0);
  });

  it('still draws a real three-point fin, one piece per fin', () => {
    const { pieces } = buildPieces(ffTree([[0, 0], [0.02, 0.03], [0.06, 0]]));
    expect(pieces.filter((p) => p.key.startsWith('fin'))).toHaveLength(3);
  });

  it('leaves the rest of the rocket standing when the fin set is skipped', () => {
    // The point of skipping rather than throwing: the tube and nose still draw.
    const { pieces } = buildPieces(ffTree([]));
    expect(pieces.some((p) => p.key.startsWith('nose'))).toBe(true);
    expect(pieces.some((p) => p.key.startsWith('body'))).toBe(true);
  });
});

/**
 * A planform with NO AREA is not extruded (audit 2026-09-30). The height field
 * allows 0, and a trapezoid or elliptical set at height 0 has an outline that
 * lies along its root: three's ExtrudeGeometry gives it no caps and keeps the
 * side walls, an open sheet of coplanar quads (a 3-fin set: 18 triangles
 * against a sound 36) that went into the display-shell STL, OBJ and glTF
 * while solidMesh.extrudePolygon refuses the same outline.
 */
describe('a fin set whose planform has no area draws nothing', () => {
  const finsOf = (fin: Record<string, unknown>) => buildPieces(withChildren([{
    id: 'f', finCount: 3, thickness: 0.003, position: { method: 'bottom', offset: 0 }, ...fin,
  } as unknown as ComponentNode])).pieces.filter((p) => p.key.startsWith('fin'));

  it('a trapezoid at height 0', () => {
    expect(finsOf({ type: 'trapezoidfinset', rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0 }))
      .toHaveLength(0);
  });

  it('an elliptical set at height 0', () => {
    expect(finsOf({ type: 'ellipticalfinset', rootChord: 0.05, height: 0 })).toHaveLength(0);
  });

  it('a freeform outline lying along its root', () => {
    // Passes finOutlineProblem — no crossing, a positive root chord — and
    // encloses nothing.
    expect(finsOf({ type: 'freeformfinset', points: [[0, 0], [0.02, 0], [0.05, 0]] })).toHaveLength(0);
  });

  it('a real fin of the same sizes still draws, one piece per fin, and closed', () => {
    const fins = finsOf({ type: 'trapezoidfinset', rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03 });
    expect(fins).toHaveLength(3);
    // Caps and walls: 2 + 2 cap triangles and 4 walls of 2 per fin.
    const tris = fins.reduce((n, p) => n + (p.geometry.index?.count ?? p.geometry.getAttribute('position').count) / 3, 0);
    expect(tris).toBe(36);
  });

  it('a fin with a flat run along its root still draws', () => {
    // The last two points and the first lie EXACTLY on y = 0: a sound outline
    // that three's ear clipper simplifies by dropping the middle one, so it
    // returns fewer than m - 2 cap triangles. A face-count test (the one
    // solidMesh.extrudePolygon makes, which refuses this fin outright) would
    // have dropped it from the 3D view too; the area test keeps it.
    expect(finsOf({ type: 'freeformfinset', points: [[0, 0], [0.02, 0.02], [0.07, 0.02], [0.075, 0], [0.08, 0]] }))
      .toHaveLength(3);
  });
});

describe('a rail button is centred on its station', () => {
  const btn = (position: Record<string, unknown>) => withChildren([{
    id: 'rb', type: 'railbutton', outerDiameter: 0.0097, totalHeight: 0.0097,
    angleOffset: 0, position,
  } as unknown as ComponentNode]);

  /** Cylinder axis is +y before rotation, so x is the piece's own position. */
  const stationOf = (tree: RocketTree): number => {
    const rb = buildPieces(tree).pieces.filter((p) => p.key.startsWith('rbtn'));
    expect(rb).toHaveLength(1);
    return rb[0]!.position![0];
  };

  // The tube runs 0.1 -> 0.4 m from the nose tip (nose 0.1, tube 0.3).
  it('top: the station is the tube fore end, not fore end + OD/2', () => {
    expect(stationOf(btn({ method: 'top', offset: 0 }))).toBeCloseTo(0.1, 9);
  });

  it('bottom: the station is the tube aft end, not aft end - OD/2', () => {
    expect(stationOf(btn({ method: 'bottom', offset: 0 }))).toBeCloseTo(0.4, 9);
  });

  it('middle: unchanged, because the two errors cancelled there', () => {
    // The default for a new button. This is why the defect hid: with
    // childLen = OD the drawn CENTRE already landed on the tube's middle.
    expect(stationOf(btn({ method: 'middle', offset: 0 }))).toBeCloseTo(0.25, 9);
  });

  it('line instances march aft from the station at the stated separation', () => {
    const tree = withChildren([{
      id: 'rb', type: 'railbutton', outerDiameter: 0.0097, totalHeight: 0.0097,
      angleOffset: 0, instanceCount: 2, instanceSeparation: 0.12,
      position: { method: 'top', offset: 0.02 },
    } as unknown as ComponentNode]);
    const xs = buildPieces(tree).pieces
      .filter((p) => p.key.startsWith('rbtn')).map((p) => p.position![0]).sort((a, b) => a - b);
    expect(xs).toHaveLength(2);
    expect(xs[0]!).toBeCloseTo(0.12, 9);
    expect(xs[1]! - xs[0]!).toBeCloseTo(0.12, 9);
  });

  it('a launch lug is NOT centred — it starts at its station', () => {
    // Guard against the button fix being applied to the lug, whose length is
    // a real axial extent.
    const lugTree = withChildren([{
      id: 'lg', type: 'launchlug', length: 0.04, outerRadius: 0.003,
      angleOffset: 0, position: { method: 'top', offset: 0 },
    } as unknown as ComponentNode]);
    const lug = buildPieces(lugTree).pieces.find((p) => p.key.startsWith('lug'))!;
    // Cylinder centre = start + len/2 = 0.1 + 0.02.
    expect(lug.position![0]).toBeCloseTo(0.12, 9);
  });
});

describe('an inner tube honours radialPosition / radialDirection', () => {
  const mount = (extra: Record<string, unknown>) => withChildren([{
    id: 'mt', type: 'innertube', length: 0.1, outerRadius: 0.0095,
    position: { method: 'bottom', offset: 0 }, ...extra,
  } as unknown as ComponentNode]);

  it('offsets the tube by rp·cos(rd), rp·sin(rd) — the aft view\'s own frame', () => {
    // Angle 0 is +y for every radial part in this app, which is where the
    // kernel puts them. Before v0.105 only AftView read these two keys, so a
    // desktop split cluster spread out end-on and stacked on the axis here.
    const p = buildPieces(mount({ radialPosition: 0.02, radialDirection: 0 }))
      .pieces.find((q) => q.key.startsWith('inner'))!;
    expect(p.position![1]).toBeCloseTo(0.02, 9);
    expect(p.position![2]).toBeCloseTo(0, 9);

    const q = buildPieces(mount({ radialPosition: 0.02, radialDirection: Math.PI / 2 }))
      .pieces.find((r) => r.key.startsWith('inner'))!;
    expect(q.position![1]).toBeCloseTo(0, 9);
    expect(q.position![2]).toBeCloseTo(0.02, 9);
  });

  it('stays on the axis when neither key is set', () => {
    const p = buildPieces(mount({})).pieces.find((q) => q.key.startsWith('inner'))!;
    expect(p.position![1]).toBeCloseTo(0, 12);
    expect(p.position![2]).toBeCloseTo(0, 12);
  });

  it('adds the radial offset to EVERY cluster copy, and to the motor', () => {
    const tree = mount({
      cluster: '3-ring', radialPosition: 0.03, radialDirection: 0,
    });
    const { pieces } = buildPieces(tree);
    const inners = pieces.filter((p) => p.key.startsWith('inner'));
    expect(inners.length).toBeGreaterThan(1);
    // Their mean y is the radial offset: the cluster pattern is centred on it.
    const meanY = inners.reduce((a, p) => a + p.position![1], 0) / inners.length;
    expect(meanY).toBeCloseTo(0.03, 9);
  });
});

/**
 * A fin on a transition sits ON the transition (audit 2026-09-30). The kernel
 * attaches a fin at its parent's radius AT THE FIN'S LEADING EDGE
 * (FinSet.getFinFront), puts both root corners on the body (getFinPoints) and
 * closes the planform along the body's own profile (getRootPoints). This view
 * drew the root at max(fore, aft) radius along the whole chord, so a fin on a
 * 54 -> 38 mm boat tail floated off the surface, the gap growing aft — in the
 * 3D tab and in every display-shell STL, OBJ and glTF.
 */
describe('a freeform fin on a transition sits on the transition', () => {
  const RF = 0.027, RA = 0.019, TL = 0.08;
  const boatTail = (shape: string, points: number[][]): RocketTree => ({
    name: 'Rocket',
    components: [{
      id: 's1', type: 'stage',
      children: [
        { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: RF },
        { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: RF },
        { id: 't1', type: 'transition', shape, length: TL, foreRadius: RF, aftRadius: RA,
          children: [{ id: 'ff', type: 'freeformfinset', finCount: 1, thickness: 0.003,
            points, position: { method: 'bottom', offset: 0 } }] },
      ],
    }],
  } as unknown as RocketTree);
  /** The transition's own radius at `x` m from its fore end. */
  const surface = (shape: string, x: number): number =>
    outerProfile(shape, undefined, TL, RF, RA, 1, [x]).find((p) => Math.abs(p[0] - x) < 1e-12)![1];
  /** One fin at rotation 0 lies in the x-y plane: the lowest vertex at each x is its root. */
  const rootOf = (tree: RocketTree): Map<number, number> => {
    const fin = buildPieces(tree).pieces.find((p) => p.key.startsWith('fin'))!;
    const pos = fin.geometry.getAttribute('position');
    const low = new Map<number, number>();
    for (let i = 0; i < pos.count; i++) {
      const x = Math.round(pos.getX(i) * 1e6) / 1e6;
      low.set(x, Math.min(low.get(x) ?? Infinity, pos.getY(i)));
    }
    return low;
  };
  // Nose 0.1 + tube 0.3: the transition starts at 0.4. A 60 mm root, bottom-
  // anchored, starts 20 mm into the 80 mm boat tail.
  const FIN = [[0, 0], [0.02, 0.04], [0.05, 0.04], [0.06, 0]];
  const LE = 0.02, TE = 0.08;

  it('the leading root corner is at the boat tail\'s radius at the leading edge', () => {
    const root = rootOf(boatTail('conical', FIN));
    // 25.0 mm, where the old drawing put it at the 27.0 mm fore radius.
    expect(root.get(0.42)!).toBeCloseTo(surface('conical', LE), 6);
  });

  it('the trailing root corner is at the boat tail\'s radius at the trailing edge', () => {
    const root = rootOf(boatTail('conical', FIN));
    // 19.0 mm. The old drawing put it at 27.0 mm, 8 mm off the surface.
    expect(root.get(0.48)!).toBeCloseTo(surface('conical', TE), 6);
  });

  it('on a curved boat tail the root follows the profile between the corners', () => {
    const root = rootOf(boatTail('ogive', FIN));
    const onSurface = [...root].filter(([x, y]) =>
      x > 0.42 + 1e-6 && x < 0.48 - 1e-6 && Math.abs(y - surface('ogive', x - 0.4)) < 1e-6);
    // FinSet.getMountPoints walks a non-conical parent in 2.5 mm steps; the
    // 3D cap is 20 divisions, so 19 interior stations on a 60 mm root.
    expect(onSurface.length).toBeGreaterThanOrEqual(10);
    expect(root.get(0.42)!).toBeCloseTo(surface('ogive', LE), 6);
    expect(root.get(0.48)!).toBeCloseTo(surface('ogive', TE), 6);
  });

  it('a fin on a body tube is unchanged: its root stays at the tube radius', () => {
    const tree = withChildren([{
      id: 'ff', type: 'freeformfinset', finCount: 1, thickness: 0.003,
      points: FIN, position: { method: 'bottom', offset: 0 },
    } as unknown as ComponentNode]);
    const root = rootOf(tree);
    expect(root.get(0.34)!).toBeCloseTo(BODY_R, 6);
    expect(root.get(0.4)!).toBeCloseTo(BODY_R, 6);
  });
});

/**
 * ...and stays CLOSED on a RISING mount (audit 2026-09-30, on review). On a
 * flare or a nose cone the body climbs under the fin's aft half, so a point a
 * planform keeps low there lies inside it: the trailing points of the
 * elliptical fin the RockSim importer converts onto a transition, say. The
 * kernel raises such a point to the surface (FreeformFinSet.clampInteriorPoint).
 * Drawn where it was stored, the outline crossed its own root once the root
 * followed the body, and three's ear clipper deleted vertices: holes in the 3D
 * fin and in every display-shell STL, OBJ and glTF.
 */
describe('a freeform fin on a rising mount is extruded closed, on the body', () => {
  const FORE = 0.0125, AFT = 0.025, TL = 0.08, NOSE = 0.1;
  /** A 12.5 -> 25 mm flare, the fin anchored at its fore end. */
  const flare = (shape: string, points: number[][]): RocketTree => ({
    name: 'Rocket',
    components: [{
      id: 's1', type: 'stage',
      children: [
        { id: 'n1', type: 'nosecone', shape: 'ogive', length: NOSE, aftRadius: FORE },
        { id: 't1', type: 'transition', shape, length: TL, foreRadius: FORE, aftRadius: AFT,
          children: [{ id: 'ff', type: 'freeformfinset', finCount: 1, thickness: 0.003,
            points, position: { method: 'top', offset: 0 } }] },
        { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: AFT },
      ],
    }],
  } as unknown as RocketTree);
  const surface = (shape: string, x: number): number => profileRadius(shape, undefined, TL, FORE, AFT)(x);
  /**
   * rocksimFile.ts's conversion of an elliptical set onto a transition: the
   * quarter-ellipse each way in 16 steps, root 75 mm, semi-span 30 mm.
   */
  const ELLIPSE = (() => {
    const [c, h, steps] = [0.075, 0.03, 16];
    const pts: number[][] = [[0, 0]];
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * (Math.PI / 2);
      pts.push([c / 2 - (c / 2) * Math.cos(t), h * Math.sin(t)]);
    }
    for (let i = steps - 1; i >= 1; i--) {
      const t = (i / steps) * (Math.PI / 2);
      pts.push([c / 2 + (c / 2) * Math.cos(t), h * Math.sin(t)]);
    }
    pts.push([c, 0]);
    return pts;
  })();
  /** Its third point keeps 4 mm off the root where the flare is 9.4 mm up. */
  const LOW = [[0, 0], [0.02, 0.03], [0.06, 0.004], [0.075, 0]];

  const finOf = (tree: RocketTree) => buildPieces(tree).pieces.find((p) => p.key.startsWith('fin'));
  /** The fin's vertices; one fin at rotation 0 lies in the x-y plane, y radial. */
  const verticesOf = (g: Piece['geometry']): [number, number, number][] => {
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    const n = idx ? idx.count : pos.count;
    const out: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const j = idx ? idx.getX(i) : i;
      out.push([pos.getX(j), pos.getY(j), pos.getZ(j)]);
    }
    return out;
  };
  /**
   * Edges used an ODD number of times, vertices welded by position: 0 for a
   * closed surface. An edge a hole or a dropped vertex leaves is used once;
   * two closed loops touching at a point share an edge four times.
   */
  const oddEdges = (g: Piece['geometry']): number => {
    const v = verticesOf(g).map((p) => p.map((c) => Math.round(c * 1e7)).join(','));
    const uses = new Map<string, number>();
    for (let i = 0; i < v.length; i += 3) {
      for (const [p, q] of [[v[i]!, v[i + 1]!], [v[i + 1]!, v[i + 2]!], [v[i + 2]!, v[i]!]]) {
        const e = p! < q! ? `${p}|${q}` : `${q}|${p}`;
        uses.set(e, (uses.get(e) ?? 0) + 1);
      }
    }
    return [...uses.values()].filter((u) => u % 2 === 1).length;
  };
  /** How far the fin's lowest vertex at each station lies below the body (m); 0 when none does. */
  const deepest = (g: Piece['geometry'], shape: string): number => Math.max(0, ...verticesOf(g)
    .filter(([x]) => x >= NOSE && x <= NOSE + TL)
    .map(([x, y]) => surface(shape, x - NOSE) - y));

  it('the elliptical fin the RockSim importer converts onto a conical flare is closed', () => {
    const fin = finOf(flare('conical', ELLIPSE));
    expect(fin).toBeDefined();
    // 126 triangles with 6 open edges while the trailing points sat inside
    // the flare; 128, closed, rooted at one radius before the root followed it.
    expect(oddEdges(fin!.geometry)).toBe(0);
    expect(deepest(fin!.geometry, 'conical')).toBeLessThan(1e-6);
  });

  it('a point kept inside the flare is drawn on its surface, where the kernel flies it', () => {
    const fin = finOf(flare('conical', LOW))!;
    expect(oddEdges(fin.geometry)).toBe(0);
    // The low point's station, 60 mm into the flare: 21.875 mm, not 16.5.
    const atLow = verticesOf(fin.geometry).filter(([x]) => Math.abs(x - (NOSE + 0.06)) < 1e-6);
    expect(atLow.length).toBeGreaterThan(0);
    expect(Math.min(...atLow.map(([, y]) => y))).toBeCloseTo(surface('conical', 0.06), 6);
  });

  it('on a curved flare too, where the root is walked along the profile', () => {
    for (const points of [ELLIPSE, LOW]) {
      const fin = finOf(flare('ogive', points));
      expect(fin).toBeDefined();
      expect(oddEdges(fin!.geometry)).toBe(0);
      expect(deepest(fin!.geometry, 'ogive')).toBeLessThan(1e-6);
    }
  });

  it('a point dipping below a body tube is raised to it: two lobes, each closed', () => {
    // The kernel clamps on any mount: this W flies as two fins meeting at the
    // tube. Drawn as stored, the dip crossed the root line.
    const tree = withChildren([{
      id: 'ff', type: 'freeformfinset', finCount: 1, thickness: 0.003,
      points: [[0, 0], [0.02, 0.03], [0.04, -0.01], [0.06, 0.03], [0.08, 0]],
      position: { method: 'bottom', offset: 0 },
    } as unknown as ComponentNode]);
    const fin = finOf(tree)!;
    expect(oddEdges(fin.geometry)).toBe(0);
    expect(Math.min(...verticesOf(fin.geometry).map(([, y]) => y))).toBeCloseTo(BODY_R, 6);
  });

  it('a flat run along the root past the tube\'s aft end still draws, closed', () => {
    // 10 mm overhang: the run from 75 to 80 mm lies on the root beyond the
    // tube, where the kernel raises nothing. It is a lobe end like any point on
    // the body, so the run is dropped rather than refused as a crossing.
    const fins = buildPieces(withChildren([{
      id: 'ff', type: 'freeformfinset', finCount: 3, thickness: 0.003,
      points: [[0, 0], [0.02, 0.02], [0.07, 0.02], [0.075, 0], [0.08, 0]],
      position: { method: 'bottom', offset: 0.01 },
    } as unknown as ComponentNode])).pieces.filter((p) => p.key.startsWith('fin'));
    expect(fins).toHaveLength(3);
    for (const f of fins) expect(oddEdges(f.geometry)).toBe(0);
  });

  it('an outline that still crosses its root is refused, not extruded', () => {
    // Past the mount's aft end the kernel raises nothing, and the root holds
    // the end radius there: a point below it crosses the root whatever is
    // done. 80 mm boat tail, 60 mm root starting 40 mm in (20 mm overhang),
    // the third point 2 mm under the 19 mm the root holds there.
    const tree = {
      name: 'Rocket',
      components: [{ id: 's1', type: 'stage', children: [
        { id: 'n1', type: 'nosecone', shape: 'ogive', length: NOSE, aftRadius: 0.027 },
        { id: 't1', type: 'transition', shape: 'conical', length: TL, foreRadius: 0.027, aftRadius: 0.019,
          children: [{ id: 'ff', type: 'freeformfinset', finCount: 1, thickness: 0.003,
            points: [[0, 0], [0.02, 0.03], [0.05, -0.006], [0.06, -0.004]],
            position: { method: 'top', offset: 0.04 } }] },
      ] }],
    } as unknown as RocketTree;
    expect(finOf(tree)).toBeUndefined();
  });
});

/**
 * `maxR` is the 3D view's reach from the CORE axis: the snapshot header prints
 * twice it as the span, and the camera and the CG/CP markers stand off by it.
 * Inside a pod everything was measured from the POD's axis (audit 2026-09-30,
 * on review of the side view's fix for the same thing): a pod set on a pod
 * read 40 mm where its tube reaches 50, and the snapshot printed an 80 mm span
 * where the 2D export printed 100.
 */
describe('maxR measures every part from the core axis', () => {
  /** The farthest vertex of any piece from the x axis, transforms applied. */
  const farthest = (tree: RocketTree): number => {
    let r = 0;
    for (const p of buildPieces(tree).pieces) {
      const m = new THREE.Matrix4();
      if (p.rotation) m.makeRotationFromEuler(new THREE.Euler(...p.rotation));
      if (p.position) m.setPosition(...p.position);
      const pos = p.geometry.getAttribute('position');
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
        r = Math.max(r, Math.hypot(v.y, v.z));
      }
    }
    return r;
  };
  /** Core 20 mm; a 10 mm pod touching it, centre 30 mm out; on it `podKids`. */
  const onPod = (podKids: Record<string, unknown>[]): RocketTree => ({
    name: 'Rocket',
    components: [{ id: 's1', type: 'stage', children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: 0.02 },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.02, children: [
        { id: 'p1', type: 'podset', instanceCount: 1, radiusOffset: 0, position: { method: 'top', offset: 0 },
          children: [{ id: 'pb', type: 'bodytube', length: 0.2, outerRadius: 0.01, children: podKids }] },
      ] },
    ] }],
  } as unknown as RocketTree);

  it('a pod set on a pod: its 5 mm tube reaches 30 + 15 + 5 = 50 mm', () => {
    const tree = onPod([{ id: 'p2', type: 'podset', instanceCount: 1, radiusOffset: 0,
      position: { method: 'top', offset: 0 },
      children: [{ id: 'qb', type: 'bodytube', length: 0.1, outerRadius: 0.005 }] }]);
    expect(farthest(tree)).toBeCloseTo(0.05, 6);
    expect(buildPieces(tree).maxR).toBeCloseTo(0.05, 12);
  });

  it('fins on a pod: 30 mm fins on its 10 mm tube reach 30 + 10 + 30 = 70 mm', () => {
    const tree = onPod([{ id: 'pf', type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03,
      sweep: 0.02, height: 0.03, thickness: 0.003, position: { method: 'bottom', offset: 0 } }]);
    // The tip's corners sit half the 3 mm thickness off the fin's plane; maxR
    // counts the fin to its tip, as it does on the core.
    expect(farthest(tree)).toBeCloseTo(Math.hypot(0.07, 0.0015), 6);
    expect(buildPieces(tree).maxR).toBeCloseTo(0.07, 12);
  });

  it('on the core it is unchanged: the fin tip, 24 + 30 mm', () => {
    const tree = withChildren([{ id: 'f', type: 'trapezoidfinset', finCount: 3, rootChord: 0.05,
      tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003, position: { method: 'bottom', offset: 0 } }]);
    expect(buildPieces(tree).maxR).toBeCloseTo(BODY_R + 0.03, 12);
  });
});

/**
 * The half of the v0.044 elliptical-fin fix that was never applied. solidMesh
 * (the printable part, the DXF and the paper template) has drawn a true half
 * ellipse since then; this path — the 3D tab and every whole-rocket .stl/.obj/
 * .glb — kept walking x linearly against y = sin(pi*t), which is a sine hump
 * 18.94 % short on area. Nothing in this suite built an `ellipticalfinset`, so
 * nothing held it for 91 releases. The guard mirrors solidMesh.test.ts:269-287.
 */
describe('an elliptical fin set draws a TRUE half ellipse', () => {
  const ROOT = 0.05, SPAN = 0.04, THK = 0.002;

  const finTree = (): RocketTree => withChildren([{
    id: 'ef', type: 'ellipticalfinset', finCount: 1,
    rootChord: ROOT, height: SPAN, thickness: THK,
    position: { method: 'bottom', offset: 0 },
  } as unknown as ComponentNode]);

  /** Signed volume of a closed triangle mesh, by the divergence theorem. */
  const volumeOf = (g: { getAttribute: (n: string) => { count: number; getX: (i: number) => number; getY: (i: number) => number; getZ: (i: number) => number }; getIndex: () => { count: number; getX: (i: number) => number } | null }): number => {
    const pos = g.getAttribute('position');
    const idx = g.getIndex();
    const n = idx ? idx.count : pos.count;
    const at = (i: number): [number, number, number] => {
      const j = idx ? idx.getX(i) : i;
      return [pos.getX(j), pos.getY(j), pos.getZ(j)];
    };
    let v = 0;
    for (let i = 0; i < n; i += 3) {
      const [ax, ay, az] = at(i), [bx, by, bz] = at(i + 1), [cx, cy, cz] = at(i + 2);
      v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    }
    return Math.abs(v);
  };

  it('encloses (PI/4)*root*height*thickness, not the sine hump (2/PI)*root*height*thickness', () => {
    const fin = buildPieces(finTree()).pieces.find((p) => p.key.startsWith('fin'));
    expect(fin).toBeDefined();
    const v = volumeOf(fin!.geometry);
    const ellipse = (Math.PI / 4) * ROOT * SPAN * THK;
    expect(Math.abs(v - ellipse) / ellipse).toBeLessThan(0.01);
    // ...and nowhere near the sine hump, so a silent revert cannot pass. The
    // two differ by only 19 %, so a loose tolerance would accept either.
    const sineHump = (2 / Math.PI) * ROOT * SPAN * THK;
    expect(Math.abs(v - sineHump) / sineHump).toBeGreaterThan(0.1);
  });

  it('puts every planform vertex ON the ellipse', () => {
    // Pins the CURVE, not just the area: a wrong curve of the right area
    // would pass the volume check alone.
    const fin = buildPieces(finTree()).pieces.find((p) => p.key.startsWith('fin'))!;
    const pos = fin.geometry.getAttribute('position');
    // One fin at rotation 0, so the only transform is the translation onto the
    // tube: the root chord sits at the minimum y, the leading root at minimum
    // x. Normalise by those and the planform is back in fin coordinates.
    let minX = Infinity, minY = Infinity;
    for (let i = 0; i < pos.count; i++) {
      minX = Math.min(minX, pos.getX(i));
      minY = Math.min(minY, pos.getY(i));
    }
    const a = ROOT / 2;
    let checked = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) - minX, y = pos.getY(i) - minY;
      if (y <= 1e-12) continue; // the root chord itself
      // 5 decimals, not more: BufferGeometry stores Float32, so a coordinate
      // near 0.05 m carries about 1e-7 of relative slop and the squared sum
      // lands within ~1.3e-6 of 1. The sine hump misses by up to 0.3.
      expect(((x - a) / a) ** 2 + (y / SPAN) ** 2).toBeCloseTo(1, 5);
      checked++;
    }
    expect(checked).toBeGreaterThan(8);
  });
});
