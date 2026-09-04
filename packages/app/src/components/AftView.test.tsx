// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { AftView } from './AftView.js';

/**
 * The aft view's cross-section frame, pinned (v0.078). Angle 0 is +y for
 * EVERY radial part — fins, pods, clusters — because that is where the kernel
 * puts them (`FinSet.getInstanceOffsets` starts at `Coordinate(0, bodyRadius,
 * 0)`; `RingInstanceable` starts at `(r·cosθ, r·sinθ)`), and +y draws UP, as
 * the desktop's back view draws it.
 *
 * Before v0.078 this view drew +y RIGHT and +z up, with a compensating +π/2
 * on fin sets alone — so fins came out upright but pods and clusters sat 90°
 * away from them, and 90° away from the same design in the 3D view. The roll
 * slider is what made that visible.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const finRocket = (extra: Record<string, unknown> = {}) => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [{
      id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012,
      children: [{
        id: 'f1', type: 'trapezoidfinset', finCount: 3,
        rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003, ...extra,
      }],
    }],
  }],
} as unknown as RocketTree);

const podRocket = (angleOffset: number) => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [{
      id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.012,
      children: [{
        id: 'p1', type: 'podset', instanceCount: 1, angleOffset, radiusOffset: 0.01,
        children: [{ id: 'pb', type: 'bodytube', length: 0.1, outerRadius: 0.006 }],
      }],
    }],
  }],
} as unknown as RocketTree);

const show = (el: React.ReactElement) => act(() => root.render(el));

/** Mean of a polygon's plotted points — good enough to say which way it points. */
const polyCentre = (p: Element): { x: number; y: number } => {
  const pts = p.getAttribute('points')!.trim().split(/\s+/).map((s) => s.split(',').map(Number));
  return {
    x: pts.reduce((a, q) => a + q[0]!, 0) / pts.length,
    y: pts.reduce((a, q) => a + q[1]!, 0) / pts.length,
  };
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('AftView cross-section frame', () => {
  it('draws an unrotated first fin straight up', () => {
    show(<AftView tree={finRocket()} />);
    const fins = [...host.querySelectorAll('polygon')];
    expect(fins).toHaveLength(3);
    const first = polyCentre(fins[0]!);
    expect(Math.abs(first.x)).toBeLessThan(1e-9); // dead centre horizontally
    expect(first.y).toBeLessThan(0); // SVG y grows down, so this is UP
  });

  it('rolling +90° swings that fin to the right', () => {
    show(<AftView tree={finRocket()} roll={Math.PI / 2} />);
    const first = polyCentre([...host.querySelectorAll('polygon')][0]!);
    expect(first.x).toBeGreaterThan(0);
    expect(Math.abs(first.y)).toBeLessThan(1e-9);
  });

  it("a fin set's own rotation reads the same way as the roll", () => {
    show(<AftView tree={finRocket({ rotation: Math.PI / 2 })} />);
    const first = polyCentre([...host.querySelectorAll('polygon')][0]!);
    expect(first.x).toBeGreaterThan(0);
  });

  it('puts a pod at angle 0 straight up too — with the fins, not across from them', () => {
    show(<AftView tree={podRocket(0)} />);
    // Hulls: the core tube at the origin, then the pod's own tube offset.
    const pod = [...host.querySelectorAll('circle')]
      .map((c) => ({ x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) }))
      .find((c) => Math.abs(c.x) > 1e-9 || Math.abs(c.y) > 1e-9)!;
    expect(pod).toBeTruthy();
    expect(Math.abs(pod.x)).toBeLessThan(1e-9);
    expect(pod.y).toBeLessThan(0);
  });

  it('rolls a pod ring with everything else', () => {
    show(<AftView tree={podRocket(0)} roll={Math.PI / 2} />);
    const pod = [...host.querySelectorAll('circle')]
      .map((c) => ({ x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')) }))
      .find((c) => Math.abs(c.x) > 1e-9 || Math.abs(c.y) > 1e-9)!;
    expect(pod.x).toBeGreaterThan(0);
    expect(Math.abs(pod.y)).toBeLessThan(1e-9);
  });
});

/**
 * v0.088 — the camera shroud's cross-section, and specifically WHICH WAY ITS
 * ARCS BULGE.
 *
 * The first cut had both SVG sweep flags inverted, which drew the shroud as a
 * concave lens sunk into the tube instead of a shell sitting on it. It survived
 * a screenshot: at a glance a wrong-way pair of arcs still reads as "a blob near
 * the top of the body". Only measuring the arc told the truth, so that is what
 * this does — recover each arc's centre from its endpoints the way a renderer
 * does, and check its midpoint is where the geometry says.
 */
describe('the camera shroud sits ON the tube, not in it', () => {
  const BODY_R = 0.027;
  const shroudRocket = (conformal: boolean, width = 0.025, height = 0.02) => ({
    name: 'R',
    components: [{
      id: 's1', type: 'stage', children: [{
        id: 'b1', type: 'bodytube', length: 0.3, outerRadius: BODY_R, thickness: 0.001,
        children: [{
          id: 'f1', type: 'fairing', name: 'Shroud', length: 0.08,
          width, height, angleOffset: 0, conformal,
        }],
      }],
    }],
  } as unknown as RocketTree);

  /** SVG endpoint -> centre parameterisation (rx = ry = r, no x-rotation). */
  const arcMid = (x1: number, y1: number, r: number, laf: number, sf: number, x2: number, y2: number) => {
    const dx = (x1 - x2) / 2;
    const dy = (y1 - y2) / 2;
    const den = r * r * dy * dy + r * r * dx * dx;
    let f = Math.sqrt(Math.max(0, (r ** 4 - den) / den));
    if (laf === sf) f = -f;
    const cx = f * dy + (x1 + x2) / 2;
    const cy = -f * dx + (y1 + y2) / 2;
    const a1 = Math.atan2(y1 - cy, x1 - cx);
    const a2 = Math.atan2(y2 - cy, x2 - cx);
    let d = a2 - a1;
    if (sf === 1 && d < 0) d += 2 * Math.PI;
    if (sf === 0 && d > 0) d -= 2 * Math.PI;
    const am = a1 + d / 2;
    return { mx: cx + r * Math.cos(am), my: cy + r * Math.sin(am) };
  };

  const shroudPath = () => {
    const p = [...host.querySelectorAll('path')]
      .map((e) => e.getAttribute('d') ?? '')
      .find((d) => d.includes('A '));
    expect(p, 'the conformal shroud should draw arcs').toBeTruthy();
    return p!;
  };

  it('stands on straight parallel sides with its floor ON the tube', () => {
    // The cross-section his photos show (docs/Camera Shrouds/): vertical side
    // walls, flat top, and the floor scalloped to the tube. NOT the annular
    // sector of the first cut, whose splayed sides read as a trapezoid — the
    // owner's 2026-08-31b report.
    show(<AftView tree={shroudRocket(true)} />);
    const d = shroudPath();
    const arcs = [...d.matchAll(/A\s+([\d.e-]+)\s+([\d.e-]+)\s+0\s+(\d)\s+(\d)\s+(-?[\d.e-]+),(-?[\d.e-]+)/g)];
    // ONE arc — the floor. The top is a straight line now.
    expect(arcs).toHaveLength(1);

    const pts = (d.match(/-?[\d.e-]+,-?[\d.e-]+/g) ?? [])
      .map((q) => q.split(',').map(Number) as [number, number]);
    // Path: M topLeft L topRight L footRight A ... footLeft Z
    const [topL, topR, footR] = pts;
    // Flat top at exactly R + height above the axis (mount angle 0 => screen
    // y = -(R+h)), spanning the full width with PARALLEL sides.
    expect(-topL![1]).toBeCloseTo(BODY_R + 0.02, 6);
    expect(-topR![1]).toBeCloseTo(BODY_R + 0.02, 6);
    expect(Math.abs(topR![0] - topL![0])).toBeCloseTo(0.025, 6);
    // The wall foot stands ON the tube: its radius from the axis is R.
    expect(Math.hypot(footR![0], footR![1])).toBeCloseTo(BODY_R, 6);
    // …and the same lateral offset as the top corner above it: vertical wall.
    expect(footR![0]).toBeCloseTo(topR![0], 6);

    // The floor arc's midpoint lies on the tube (the v0.088 sweep-flag lesson:
    // measure the arc, never eyeball it).
    const [, rs, , , sf, xe, ye] = arcs[0]!;
    const u = arcMid(footR![0], footR![1], Number(rs), 0, Number(sf), Number(xe), Number(ye));
    expect(Math.hypot(u.mx, u.my)).toBeCloseTo(BODY_R, 6);
  });

  it('draws a flat-bottomed shroud on the TANGENT plane, standing clear at the corners', () => {
    show(<AftView tree={shroudRocket(false)} />);
    // The flat-bottomed shroud is a four-corner path (no arcs), not a polygon.
    const d = [...host.querySelectorAll('path')]
      .map((e) => e.getAttribute('d') ?? '')
      .find((q) => q.startsWith('M ') && !q.includes('A '))!;
    expect(d, 'a flat-bottomed shroud should draw a straight-sided box').toBeTruthy();
    const pts = (d.match(/-?[\d.e-]+,-?[\d.e-]+/g) ?? [])
      .map((q) => q.split(',').map(Number) as [number, number]);
    expect(pts).toHaveLength(4);
    const radii = pts.map(([x, y]) => Math.hypot(x, y)).sort((a, b) => a - b);
    // The two base corners sit on the tangent plane, so they are FARTHER from
    // the axis than the tube surface — that standoff is the gap.
    expect(radii[0]).toBeGreaterThan(BODY_R);
    expect(radii[0]).toBeCloseTo(Math.hypot(BODY_R, 0.025 / 2), 6);
  });

  it('survives a shroud wider than its own tube instead of emitting NaN', () => {
    show(<AftView tree={shroudRocket(true, 0.09, 0.01)} />);
    const d = shroudPath();
    expect(d.includes('NaN')).toBe(false);
  });
});

/**
 * v0.103 — end-on, a rail button is NOT a circle.
 *
 * It is its outer diameter wide TANGENTIALLY and its total height tall
 * RADIALLY, and on a real part those are two different numbers (a Std 1515 RB
 * is 15.75 x 11.42 mm). This view used to draw a circle of radius OD/2 centred
 * at bodyRadius + OD/2, so the diameter stood in for the height — a third
 * disagreement, because the 3D view used the literal 9.7 mm and the side view
 * used twice the radius. Now all three read `totalHeight`, which is also the
 * dimension the kernel flies (RailButtonCalc.java:57-60).
 */
describe('a rail button is drawn its own height tall, not its own diameter', () => {
  const BODY_R = 0.012;
  // Std 1515 RB from OpenRocket's own RailButton_Database.orc — deliberately a
  // part whose height and diameter DIFFER, so a drawing that confuses them
  // cannot pass.
  const OD = 0.01575;
  const H = 0.01142;

  const buttonRocket = (over: Record<string, unknown> = {}) => ({
    name: 'Rocket',
    components: [{
      id: 's1', type: 'stage',
      children: [{
        id: 'b1', type: 'bodytube', length: 0.3, outerRadius: BODY_R,
        children: [{
          id: 'rb', type: 'railbutton', name: 'RB',
          outerDiameter: OD, totalHeight: H, angleOffset: 0, ...over,
        }],
      }],
    }],
  } as unknown as RocketTree);

  /** The straight-sided (non-conformal) box path this view now uses. */
  const boxPts = () => {
    const d = [...host.querySelectorAll('path')]
      .map((e) => e.getAttribute('d') ?? '')
      .find((q) => q.startsWith('M ') && !q.includes('A '));
    expect(d, 'the button should draw a straight-sided box, not a circle').toBeTruthy();
    return (d!.match(/-?[\d.e-]+,-?[\d.e-]+/g) ?? [])
      .map((q) => q.split(',').map(Number) as [number, number]);
  };

  it('stands off the tube by its TOTAL HEIGHT and spans its OUTER DIAMETER', () => {
    show(<AftView tree={buttonRocket()} />);
    const pts = boxPts();
    expect(pts).toHaveLength(4);
    // Angle 0 is straight up, and P() negates y, so the outer face is at
    // screen y = -(R + height). The old circle would have reached
    // R + OD = 0.02775 instead; the height reaches 0.02342.
    const outer = Math.min(...pts.map(([, y]) => y));
    expect(-outer).toBeCloseTo(BODY_R + H, 9);
    expect(-outer).not.toBeCloseTo(BODY_R + OD, 4);
    // The floor sits ON the tube, and the box is OD wide across.
    const inner = Math.max(...pts.map(([, y]) => y));
    expect(-inner).toBeCloseTo(BODY_R, 9);
    const xs = pts.map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(OD, 9);
  });

  it('turns with its own mount angle and with the view roll', () => {
    show(<AftView tree={buttonRocket({ angleOffset: Math.PI / 2 })} />);
    // A quarter turn puts the outer face on the +z side: screen x positive,
    // screen y ~0.
    const pts = boxPts();
    const far = pts.reduce((a, b) => (Math.hypot(...b) > Math.hypot(...a) ? b : a));
    expect(far[0]).toBeGreaterThan(0);
    expect(Math.abs(far[1])).toBeLessThan(OD);
    // The view roll adds to it, exactly as it does for every other surface part.
    show(<AftView tree={buttonRocket({ angleOffset: 0 })} roll={Math.PI / 2} />);
    const rolled = boxPts().reduce((a, b) => (Math.hypot(...b) > Math.hypot(...a) ? b : a));
    expect(rolled[0]).toBeGreaterThan(0);
  });

  it('falls back to the kernel constructor, not to the old 4 mm, when undimensioned', () => {
    // An old design carries neither key. The engine flies such a button as the
    // RailButton constructor's 9.7 x 9.7 mm part (RailButton.java:58-64), so
    // that is what has to be drawn — the previous fallback of 4 mm was less
    // than half of it.
    show(<AftView tree={buttonRocket({ outerDiameter: undefined, totalHeight: undefined })} />);
    const pts = boxPts();
    const outer = Math.min(...pts.map(([, y]) => y));
    expect(-outer).toBeCloseTo(BODY_R + 0.0097, 9);
    const xs = pts.map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.0097, 9);
  });

  it('leaves a launch lug round — it is a tube lying on the surface', () => {
    const lug = {
      name: 'Rocket',
      components: [{
        id: 's1', type: 'stage',
        children: [{
          id: 'b1', type: 'bodytube', length: 0.3, outerRadius: BODY_R,
          children: [{ id: 'lg', type: 'launchlug', length: 0.05, outerRadius: 0.003, angleOffset: 0 }],
        }],
      }],
    } as unknown as RocketTree;
    show(<AftView tree={lug} />);
    const off = [...host.querySelectorAll('circle')]
      .map((c) => ({ x: Number(c.getAttribute('cx')), y: Number(c.getAttribute('cy')), r: Number(c.getAttribute('r')) }))
      .find((c) => Math.abs(c.x) > 1e-9 || Math.abs(c.y) > 1e-9)!;
    expect(off).toBeTruthy();
    expect(off.r).toBeCloseTo(0.003, 9);
    expect(-off.y).toBeCloseTo(BODY_R + 0.003, 9);
  });
});
