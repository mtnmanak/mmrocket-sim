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

  it('bulges its outer face AWAY from the axis and its base ALONG the tube', () => {
    show(<AftView tree={shroudRocket(true)} />);
    const d = shroudPath();
    // "M x,y A r r 0 laf sf x,y L x,y A r r 0 laf sf x,y Z"
    const nums = d.match(/-?[\d.]+(?:e-?\d+)?/g)!.map(Number);
    const arcs = [...d.matchAll(/A\s+([\d.e-]+)\s+([\d.e-]+)\s+0\s+(\d)\s+(\d)\s+(-?[\d.e-]+),(-?[\d.e-]+)/g)];
    expect(arcs).toHaveLength(2);
    const start = d.match(/M\s+(-?[\d.e-]+),(-?[\d.e-]+)/)!;
    expect(nums.length).toBeGreaterThan(0);

    // Arc 1: the OUTER face, from the M point.
    const [, r1s, , , sf1, x1e, y1e] = arcs[0]!;
    const o = arcMid(Number(start[1]), Number(start[2]), Number(r1s), 0, Number(sf1),
      Number(x1e), Number(y1e));
    // Screen y is negated model y, so distance from the axis is the hypot.
    expect(Math.hypot(o.mx, o.my)).toBeCloseTo(BODY_R + 0.02, 6);

    // Arc 2: the UNDERSIDE, which must lie exactly on the tube.
    const lineEnd = d.match(/L\s+(-?[\d.e-]+),(-?[\d.e-]+)/)!;
    const [, r2s, , , sf2, x2e, y2e] = arcs[1]!;
    const u = arcMid(Number(lineEnd[1]), Number(lineEnd[2]), Number(r2s), 0, Number(sf2),
      Number(x2e), Number(y2e));
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
