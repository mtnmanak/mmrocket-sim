/**
 * solidMesh invariants: every mesh a slicer will see must be watertight and
 * outward-wound (positive signed volume), and where an analytic volume
 * exists the mesh must hit it — 1% for 96-segment revolves (faceting error
 * is ~0.07%), exact for extrusions (divergence theorem is exact on prisms).
 */
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import {
  collapseLoop, componentSolid, extrudePolygon, finCutOutline, isWatertight, revolveProfile,
  solidVolume, type SolidMesh,
} from './solidMesh.js';

const node = (type: string, params: Record<string, unknown>): ComponentNode =>
  ({ type, ...params } as unknown as ComponentNode);

/** Watertight + positive volume, returning the volume for anchors. */
const check = (mesh: SolidMesh): number => {
  expect(isWatertight(mesh)).toBe(true);
  const v = solidVolume(mesh);
  expect(v).toBeGreaterThan(0);
  return v;
};

const relErr = (v: number, expected: number): number => Math.abs(v - expected) / expected;

// async because componentSolid loads the polygon triangulator on demand —
// that dynamic import is what keeps three.js out of the initial bundle.
const solid = async (n: ComponentNode, ctx: Record<string, number> = {}) => {
  const s = await componentSolid(n, ctx);
  expect(s).not.toBeNull();
  return s!;
};

describe('revolveProfile', () => {
  it('annular rectangle profile hits the tube volume within 1%', async () => {
    const v = check(revolveProfile([[0, 0.01], [0, 0.02], [0.1, 0.02], [0.1, 0.01]]));
    expect(relErr(v, Math.PI * (0.02 ** 2 - 0.01 ** 2) * 0.1)).toBeLessThan(0.01);
  });

  it('winding-normalizes: the reversed profile gives the same positive volume', async () => {
    const pts: Array<[number, number]> = [[0, 0.01], [0, 0.02], [0.1, 0.02], [0.1, 0.01]];
    const v1 = check(revolveProfile(pts));
    const v2 = check(revolveProfile(pts.slice().reverse()));
    expect(relErr(v2, v1)).toBeLessThan(1e-12);
  });
});

describe('extrudePolygon', () => {
  it('rectangle volume is exact, either input winding', async () => {
    const rect: Array<[number, number]> = [[0, 0], [0.04, 0], [0.04, 0.02], [0, 0.02]];
    const vCCW = check(await extrudePolygon(rect, 0.003));
    const vCW = check(await extrudePolygon(rect.slice().reverse(), 0.003));
    expect(relErr(vCCW, 0.04 * 0.02 * 0.003)).toBeLessThan(1e-9);
    expect(relErr(vCW, 0.04 * 0.02 * 0.003)).toBeLessThan(1e-9);
  });
});

describe('collapseLoop', () => {
  // Exported for the DXF writer, which has no other dedup on its path — a
  // duplicated vertex there becomes a zero-length POLYLINE segment with no
  // defined edge normal for CAM cutter compensation.
  it('drops consecutive duplicates AND the closing wrap', async () => {
    expect(collapseLoop([[0, 0], [1, 0], [1, 0], [1, 1], [0, 0]]))
      .toEqual([[0, 0], [1, 0], [1, 1]]);
  });

  it('leaves a clean loop untouched and never returns a degenerate edge', async () => {
    const clean: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];
    expect(collapseLoop(clean)).toEqual(clean);
    const out = collapseLoop([[0, 0], [0, 0], [2, 0], [2, 0], [2, 3], [0, 0]]);
    for (let i = 0; i < out.length; i++) {
      const a = out[i]!;
      const b = out[(i + 1) % out.length]!;
      expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeGreaterThan(1e-9);
    }
  });
});

describe('componentSolid: tubes, rings, discs', () => {
  it('body tube annulus hits PI*(R^2-r^2)*L within 1%', async () => {
    const v = check((await solid(node('bodytube', { outerRadius: 0.02, thickness: 0.002, length: 0.3 }))).mesh);
    expect(relErr(v, Math.PI * (0.02 ** 2 - 0.018 ** 2) * 0.3)).toBeLessThan(0.01);
  });

  it('wall thicker than radius collapses to a solid rod: PI*R^2*L', async () => {
    const v = check((await solid(node('bodytube', { outerRadius: 0.01, thickness: 0.02, length: 0.1 }))).mesh);
    expect(relErr(v, Math.PI * 0.01 ** 2 * 0.1)).toBeLessThan(0.01);
  });

  it('tube coupler and engine block size from the parent bore', async () => {
    const ctx = { parentInnerRadius: 0.0165 };
    const expected = Math.PI * (0.0165 ** 2 - 0.015 ** 2) * 0.05;
    for (const t of ['tubecoupler', 'engineblock']) {
      const v = check((await solid(node(t, { thickness: 0.0015, length: 0.05 }), ctx)).mesh);
      expect(relErr(v, expected)).toBeLessThan(0.01);
    }
  });

  it('launch lug is its own annulus', async () => {
    const v = check((await solid(node('launchlug', { outerRadius: 0.003, thickness: 0.0007, length: 0.045 }))).mesh);
    expect(relErr(v, Math.PI * (0.003 ** 2 - 0.0023 ** 2) * 0.045)).toBeLessThan(0.01);
  });

  it('centering ring with a real bore', async () => {
    const s = await solid(node('centeringring', { length: 0.003 }), { parentInnerRadius: 0.0165, mountOuterRadius: 0.009 });
    expect(s.label).toBe('Centering ring');
    const v = check(s.mesh);
    expect(relErr(v, Math.PI * (0.0165 ** 2 - 0.009 ** 2) * 0.003)).toBeLessThan(0.01);
  });

  it('centering ring without a mount assumes a bore and says so', async () => {
    const s = await solid(node('centeringring', { length: 0.003 }), { parentInnerRadius: 0.012 });
    expect(s.label).toBe('Centering ring (assumed bore)');
    const v = check(s.mesh);
    expect(relErr(v, Math.PI * (0.012 ** 2 - 0.006 ** 2) * 0.003)).toBeLessThan(0.01);
  });

  it('bulkhead is a solid disc: PI*R^2*L', async () => {
    const v = check((await solid(node('bulkhead', { length: 0.004 }), { parentInnerRadius: 0.0165 })).mesh);
    expect(relErr(v, Math.PI * 0.0165 ** 2 * 0.004)).toBeLessThan(0.01);
  });

  it('tube fin: one auto-sized tube (6 fins touch at the body radius)', async () => {
    const v = check((await solid(node('tubefinset', { finCount: 6, thickness: 0.001, length: 0.05 }), { bodyRadius: 0.012 })).mesh);
    expect(relErr(v, Math.PI * (0.012 ** 2 - 0.011 ** 2) * 0.05)).toBeLessThan(0.01);
  });
});

describe('componentSolid: nose cones', () => {
  it('filled conical nose hits PI*R^2*L/3 within 1%', async () => {
    const v = check((await solid(node('nosecone', { shape: 'conical', filled: true, length: 0.1, aftRadius: 0.02 }))).mesh);
    expect(relErr(v, (Math.PI * 0.02 ** 2 * 0.1) / 3)).toBeLessThan(0.01);
  });

  it('hollow ogive with capped shoulder: watertight and lighter than filled', async () => {
    const params = {
      shape: 'ogive', length: 0.12, aftRadius: 0.025, thickness: 0.002,
      shoulderRadius: 0.022, shoulderLength: 0.03, shoulderThickness: 0.002, shoulderCapped: true,
    };
    const vHollow = check((await solid(node('nosecone', params))).mesh);
    const vFilled = check((await solid(node('nosecone', { ...params, filled: true }))).mesh);
    expect(vHollow).toBeLessThan(vFilled);
  });

  it('shoulder wider than the base is clamped and stays watertight', async () => {
    const v = check((await solid(node('nosecone', {
      shape: 'ogive', length: 0.1, aftRadius: 0.02, thickness: 0.002,
      shoulderRadius: 0.03, shoulderLength: 0.025, shoulderThickness: 0.002,
    }))).mesh);
    expect(v).toBeGreaterThan(0);
  });

  it('wall thicker than the base radius degrades to the filled cone', async () => {
    const v = check((await solid(node('nosecone', { shape: 'conical', length: 0.1, aftRadius: 0.02, thickness: 0.05 }))).mesh);
    expect(relErr(v, (Math.PI * 0.02 ** 2 * 0.1) / 3)).toBeLessThan(0.01);
  });

  it('shoulder bore wider than the cavity mouth: analytic hollow-cone + tube anchor', async () => {
    // rsi = 0.0185 > innerR = 0.018 — the mouth clamp must not distort the cavity.
    const L = 0.1, R = 0.02, wall = 0.002, rs = 0.019, st = 0.0005, len = 0.03;
    const v = check((await solid(node('nosecone', {
      shape: 'conical', length: L, aftRadius: R, thickness: wall,
      shoulderRadius: rs, shoulderLength: len, shoulderThickness: st,
    }))).mesh);
    const rsi = rs - st;
    const expected = (Math.PI * R * R * L) / 3 - (Math.PI * L * (R - wall) ** 3) / (3 * R)
      + Math.PI * (rs * rs - rsi * rsi) * len;
    expect(relErr(v, expected)).toBeLessThan(0.01);
  });

  it('capped shoulder adds exactly the cap disc volume', async () => {
    const L = 0.1, R = 0.02, wall = 0.002, rs = 0.019, st = 0.0005, len = 0.03;
    const v = check((await solid(node('nosecone', {
      shape: 'conical', length: L, aftRadius: R, thickness: wall,
      shoulderRadius: rs, shoulderLength: len, shoulderThickness: st, shoulderCapped: true,
    }))).mesh);
    const rsi = rs - st;
    const expected = (Math.PI * R * R * L) / 3 - (Math.PI * L * (R - wall) ** 3) / (3 * R)
      + Math.PI * (rs * rs - rsi * rsi) * len + Math.PI * rsi * rsi * st;
    expect(relErr(v, expected)).toBeLessThan(0.01);
  });

  it('solid shoulder narrower than the cavity mouth stays watertight (pinch bridge)', async () => {
    // shoulderThickness > shoulderRadius makes the shoulder a solid rod whose
    // radius is far below the cavity mouth — degenerate input, must not leak.
    check((await solid(node('nosecone', {
      shape: 'conical', length: 0.1, aftRadius: 0.02, thickness: 0.002,
      shoulderRadius: 0.005, shoulderLength: 0.02, shoulderThickness: 0.01,
    }))).mesh);
  });

  it('zero-length shoulder is ignored', async () => {
    const base = { shape: 'ogive', length: 0.1, aftRadius: 0.02, thickness: 0.002 };
    const vNone = check((await solid(node('nosecone', base))).mesh);
    const vZero = check((await solid(node('nosecone', { ...base, shoulderRadius: 0.018, shoulderLength: 0 }))).mesh);
    expect(relErr(vZero, vNone)).toBeLessThan(1e-12);
  });
});

describe('componentSolid: transitions', () => {
  const fwd = {
    shape: 'conical', length: 0.08, foreRadius: 0.012, aftRadius: 0.025, thickness: 0.0015,
    foreShoulderRadius: 0.010, foreShoulderLength: 0.02, foreShoulderThickness: 0.0015,
    aftShoulderRadius: 0.022, aftShoulderLength: 0.025, aftShoulderThickness: 0.002,
  };
  const rev = {
    shape: 'conical', length: 0.08, foreRadius: 0.025, aftRadius: 0.012, thickness: 0.0015,
    foreShoulderRadius: 0.022, foreShoulderLength: 0.025, foreShoulderThickness: 0.002,
    aftShoulderRadius: 0.010, aftShoulderLength: 0.02, aftShoulderThickness: 0.0015,
  };

  it('filled frustum hits PI*L*(R1^2+R1*R2+R2^2)/3 within 1%', async () => {
    const v = check((await solid(node('transition', { shape: 'conical', filled: true, length: 0.08, foreRadius: 0.012, aftRadius: 0.025 }))).mesh);
    const expected = (Math.PI * 0.08 * (0.012 ** 2 + 0.012 * 0.025 + 0.025 ** 2)) / 3;
    expect(relErr(v, expected)).toBeLessThan(0.01);
  });

  it('hollow with both shoulders is watertight, and the reversed (fore > aft) twin matches its volume', async () => {
    const v1 = check((await solid(node('transition', fwd))).mesh);
    const v2 = check((await solid(node('transition', rev))).mesh);
    expect(relErr(v2, v1)).toBeLessThan(1e-9);
  });

  it('fore-capped shoulder mirrors aft-capped: the cap is not dropped', async () => {
    const v1 = check((await solid(node('transition', {
      shape: 'conical', length: 0.08, foreRadius: 0.012, aftRadius: 0.025, thickness: 0.0015,
      aftShoulderRadius: 0.022, aftShoulderLength: 0.025, aftShoulderThickness: 0.002, aftShoulderCapped: true,
    }))).mesh);
    const v2 = check((await solid(node('transition', {
      shape: 'conical', length: 0.08, foreRadius: 0.025, aftRadius: 0.012, thickness: 0.0015,
      foreShoulderRadius: 0.022, foreShoulderLength: 0.025, foreShoulderThickness: 0.002, foreShoulderCapped: true,
    }))).mesh);
    // The cap disc is PI*rsi^2*t = 2.5e-7 m^3, ~1.1% of the part — a dropped
    // fore cap fails this at 0.11 relative error.
    expect(relErr(v2, v1)).toBeLessThan(1e-9);
  });

  it('filled with a capped fore shoulder encloses the bore as an inner void shell', async () => {
    const v = check((await solid(node('transition', {
      shape: 'conical', filled: true, length: 0.08, foreRadius: 0.025, aftRadius: 0.012,
      foreShoulderRadius: 0.022, foreShoulderLength: 0.025, foreShoulderThickness: 0.002, foreShoulderCapped: true,
    }))).mesh);
    const frustum = (Math.PI * 0.08 * (0.012 ** 2 + 0.012 * 0.025 + 0.025 ** 2)) / 3;
    const rsi = 0.02;
    const expected = frustum + Math.PI * (0.022 ** 2 - rsi ** 2) * 0.025 + Math.PI * rsi ** 2 * 0.002;
    expect(relErr(v, expected)).toBeLessThan(0.01);
  });
});

describe('componentSolid: fins', () => {
  it('trapezoid fin with tab: volume is exactly (planform + tab) * thickness', async () => {
    const v = check((await solid(node('trapezoidfinset', {
      rootChord: 0.06, tipChord: 0.03, sweep: 0.02, height: 0.05, thickness: 0.003,
      tabHeight: 0.008, tabLength: 0.02, tabOffset: 0, tabOffsetMethod: 'middle',
    }))).mesh);
    const area = ((0.06 + 0.03) / 2) * 0.05 + 0.02 * 0.008;
    expect(relErr(v, area * 0.003)).toBeLessThan(1e-9);
  });

  it('tab wider than the root is clamped to the root chord', async () => {
    const v = check((await solid(node('trapezoidfinset', {
      rootChord: 0.04, tipChord: 0.02, sweep: 0.01, height: 0.03, thickness: 0.002,
      tabHeight: 0.01, tabLength: 0.1, tabOffset: 0, tabOffsetMethod: 'middle',
    }))).mesh);
    const area = ((0.04 + 0.02) / 2) * 0.03 + 0.04 * 0.01;
    expect(relErr(v, area * 0.002)).toBeLessThan(1e-9);
  });

  it('elliptical fin volume is the TRUE half-ellipse: (PI/4)*root*height*thickness', async () => {
    // Semi-axes root/2 and height, half the ellipse: PI*(root/2)*height/2 =
    // (PI/4)*root*height. This test used to enshrine (2/PI)*root*height, the
    // area of the SINE HUMP the planform builder emitted before the kernel
    // parametrisation went in (EllipticalFinSet.java lines 17-25) — 19% small.
    const v = check((await solid(node('ellipticalfinset', { rootChord: 0.05, height: 0.04, thickness: 0.002 }))).mesh);
    expect(relErr(v, (Math.PI / 4) * 0.05 * 0.04 * 0.002)).toBeLessThan(0.01);
    // ...and is nowhere near the old value, so a silent revert cannot pass.
    expect(relErr(v, (2 / Math.PI) * 0.05 * 0.04 * 0.002)).toBeGreaterThan(0.1);
  });

  it('elliptical planform vertices lie exactly on the ellipse', async () => {
    const outline = finCutOutline(node('ellipticalfinset', { rootChord: 0.09, height: 0.04 }))!;
    expect(outline.length).toBeGreaterThan(8);
    const a = 0.09 / 2;
    for (const [x, y] of outline) {
      expect(((x - a) / a) ** 2 + (y / 0.04) ** 2).toBeCloseTo(1, 9);
    }
    // Root corners land on the chord ends, apex at mid-chord and full span.
    expect(outline[0]).toEqual([0, 0]);
    expect(outline[outline.length - 1]![0]).toBeCloseTo(0.09, 12);
    expect(Math.max(...outline.map((p) => p[1]))).toBeCloseTo(0.04, 12);
  });

  it('freeform concave (L-shaped) fin is watertight with exact volume', async () => {
    const pts = [[0, 0], [0, 0.04], [0.02, 0.04], [0.02, 0.01], [0.05, 0.01], [0.05, 0]];
    const v = check((await solid(node('freeformfinset', { points: pts, thickness: 0.003 }))).mesh);
    expect(relErr(v, (0.02 * 0.04 + 0.03 * 0.01) * 0.003)).toBeLessThan(1e-9);
  });

  it('freeform fin merges the tab along the root edge', async () => {
    const pts = [[0, 0], [0, 0.04], [0.02, 0.04], [0.02, 0.01], [0.05, 0.01], [0.05, 0]];
    const v = check((await solid(node('freeformfinset', {
      points: pts, thickness: 0.003, tabHeight: 0.005, tabLength: 0.02, tabOffset: 0.005, tabOffsetMethod: 'top',
    }))).mesh);
    expect(relErr(v, (0.02 * 0.04 + 0.03 * 0.01 + 0.02 * 0.005) * 0.003)).toBeLessThan(1e-9);
  });

  it('tabOffsetMethod top/middle/bottom each clamp into the root', async () => {
    const base = { rootChord: 0.05, tipChord: 0.02, sweep: 0.01, height: 0.04, thickness: 0.003, tabHeight: 0.008, tabLength: 0.02 };
    const planform = ((0.05 + 0.02) / 2) * 0.04;
    const cases: Array<[string, number, number]> = [
      ['top', -0.01, 0.01],     // front clamps 0 -> tab spans [0, 0.01]
      ['middle', 0.02, 0.015],  // aft end clamps 0.05 -> [0.035, 0.05]
      ['bottom', 0.01, 0.01],   // aft end clamps 0.05 -> [0.04, 0.05]
    ];
    for (const [method, offset, tabSpan] of cases) {
      const v = check((await solid(node('trapezoidfinset', { ...base, tabOffset: offset, tabOffsetMethod: method }))).mesh);
      expect(relErr(v, (planform + tabSpan * 0.008) * 0.003)).toBeLessThan(1e-9);
    }
  });

  it('tab pushed entirely off the root is dropped, not smeared', async () => {
    const v = check((await solid(node('trapezoidfinset', {
      rootChord: 0.05, tipChord: 0.02, sweep: 0.01, height: 0.04, thickness: 0.003,
      tabHeight: 0.008, tabLength: 0.02, tabOffset: 0.2, tabOffsetMethod: 'top',
    }))).mesh);
    expect(relErr(v, ((0.05 + 0.02) / 2) * 0.04 * 0.003)).toBeLessThan(1e-9);
  });

  it('explicitly closed freeform outline (last point repeats first) still merges the tab watertight', async () => {
    const v = check((await solid(node('freeformfinset', {
      points: [[0, 0], [0.01, 0.03], [0.05, 0.02], [0.05, 0], [0, 0]],
      thickness: 0.002, tabHeight: 0.005, tabLength: 0.02, tabOffset: 0.01, tabOffsetMethod: 'top',
    }))).mesh);
    // Shoelace area 0.00115 + tab 0.02*0.005
    expect(relErr(v, (0.00115 + 0.0001) * 0.002)).toBeLessThan(1e-9);
  });

  it('freeform fin whose outline never returns to the root exports without a tab', async () => {
    const pts = [[0, 0], [0.01, 0.03], [0.04, 0.02]];
    const v = check((await solid(node('freeformfinset', {
      points: pts, thickness: 0.002, tabHeight: 0.01, tabLength: 0.02,
    }))).mesh);
    expect(relErr(v, 5e-4 * 0.002)).toBeLessThan(1e-9);
  });
});

describe('componentSolid: unsupported types', () => {
  it('returns null for non-printable components', async () => {
    expect(await componentSolid(node('railbutton', {}), {})).toBeNull();
    expect(await componentSolid(node('parachute', {}), {})).toBeNull();
  });
});

describe('poles', () => {
  it('filled cone has exactly two axis vertices (tip + base center), no duplicates', async () => {
    const mesh = (await solid(node('nosecone', { shape: 'conical', filled: true, length: 0.1, aftRadius: 0.02 }))).mesh;
    let onAxis = 0;
    for (let i = 0; i < mesh.positions.length; i += 3) {
      if (Math.abs(mesh.positions[i + 1]!) < 1e-12 && Math.abs(mesh.positions[i + 2]!) < 1e-12) onAxis++;
    }
    expect(onAxis).toBe(2);
    check(mesh);
  });
});

describe('isWatertight', () => {
  const tet = (flipFirst: boolean): SolidMesh => ({
    positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    triangles: Uint32Array.from([
      ...(flipFirst ? [0, 2, 1] : [0, 1, 2]),
      0, 3, 1, 1, 3, 2, 2, 3, 0,
    ]),
  });

  it('accepts a consistently wound tetrahedron', async () => {
    expect(isWatertight(tet(false))).toBe(true);
  });

  it('rejects a same-direction shared edge even when every edge count is 2', async () => {
    // One flipped face: every undirected edge is still used exactly twice,
    // but three pairs run the SAME direction — count-only checks pass this.
    expect(isWatertight(tet(true))).toBe(false);
  });

  it('rejects an open surface', async () => {
    const bad: SolidMesh = {
      positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangles: Uint32Array.from([0, 1, 2]),
    };
    expect(isWatertight(bad)).toBe(false);
  });

  it('rejects NaN positions', async () => {
    const box = await extrudePolygon([[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01]], 0.01);
    box.positions[0] = NaN;
    expect(isWatertight(box)).toBe(false);
  });
});
