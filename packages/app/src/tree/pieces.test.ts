import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { buildPieces } from './pieces.js';

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
