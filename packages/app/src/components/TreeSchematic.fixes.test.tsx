// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { ROLL_COL } from './RollControl.js';
import { RULER_LEFT, RULER_TOP, TreeSchematic } from './TreeSchematic.js';

/**
 * v0.079 — three things the v0.078 review found, pinned so they cannot come
 * back: an elliptical fin drawn at 57 % of its span, a hover box measured from
 * the un-foreshortened span, and the button zoom anchoring on the canvas
 * centre after the gutters moved the drawing's.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A drawn fin, not the dashed hidden line the roll adds behind the airframe. */
const FILLED_FIN = 'polygon:not([data-fin="hidden"])';
const FILLED_ARC = 'path:not([data-fin="hidden"])';

let host: HTMLDivElement;
let root: Root;

const BODY_R = 0.012;
const HEIGHT = 0.03;

const treeWith = (fin: Record<string, unknown>) => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: BODY_R },
      {
        id: 'b1', type: 'bodytube', length: 0.3, outerRadius: BODY_R,
        children: [{ id: 'f1', rootChord: 0.05, height: HEIGHT, thickness: 0.003, ...fin }],
      },
    ],
  }],
} as unknown as RocketTree);

const show = (el: React.ReactElement) => act(() => root.render(el));
const viewBox = () => host.querySelector('svg')!.getAttribute('viewBox')!.split(' ').map(Number);
const centreY = () => { const [, , , h] = viewBox(); return RULER_TOP + (h! - RULER_TOP) / 2; };
/** viewBox px per metre — recovered from the body tube's drawn height. */
const scale = () => {
  const tube = host.querySelector<SVGRectElement>('rect[fill="#e7e5e0"]')!;
  return Number(tube.getAttribute('height')) / (2 * BODY_R);
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

describe('elliptical fins reach their full span', () => {
  it('draws a true half-ellipse, not a quadratic that stops halfway to its tip', () => {
    show(<TreeSchematic tree={treeWith({ type: 'ellipticalfinset', finCount: 2 })} info={null} />);
    const d = [...host.querySelectorAll(FILLED_ARC)]
      .map((p) => p.getAttribute('d') ?? '')
      .find((s) => s.includes('A '))!;
    expect(d, 'the elliptical fin should be an arc').toBeTruthy();
    // "M x0 y0 A rx ry 0 0 sweep x1 y0 Z" — ry IS the drawn span, where the
    // old control-point form reached only half of it.
    const ry = Number(/A\s+[\d.]+\s+([\d.]+)/.exec(d)![1]);
    expect(ry).toBeCloseTo(HEIGHT * scale(), 6);
  });

  it('keeps the arc on the correct side of the airframe for each instance', () => {
    show(<TreeSchematic tree={treeWith({ type: 'ellipticalfinset', finCount: 2 })} info={null} />);
    const arcs = [...host.querySelectorAll(FILLED_ARC)]
      .map((p) => p.getAttribute('d') ?? '').filter((s) => s.includes('A '));
    expect(arcs).toHaveLength(2);
    const sweeps = arcs.map((d) => /A\s+[\d.]+\s+[\d.]+\s+0\s+0\s+(\d)/.exec(d)![1]);
    // One fin up, one down: opposite sweep flags bulge them away from the body.
    expect(new Set(sweeps).size).toBe(2);
  });
});

describe('the hover box follows the drawn fins', () => {
  const over = (el: Element) => act(() => {
    el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
  });

  it('a 3-fin set highlights one full span up and half a span down, not the full box', () => {
    show(<TreeSchematic tree={treeWith({ type: 'trapezoidfinset', finCount: 3, tipChord: 0.03, sweep: 0.02 })} info={null} />);
    over(host.querySelector(FILLED_FIN)!);
    const wash = host.querySelector<SVGRectElement>('rect[fill="var(--accent)"]')!;
    expect(wash).not.toBeNull();
    const y = Number(wash.getAttribute('y'));
    const hgt = Number(wash.getAttribute('height'));
    const cy = centreY();
    const s = scale();
    // The wash carries a 2 px bleed on each edge (see the hover overlay).
    const up = cy - (y + 2);
    const down = (y + hgt - 2) - cy;
    // cos 0 = 1 above; cos 120 = cos 240 = -0.5 below.
    expect(up).toBeCloseTo((BODY_R + HEIGHT) * s, 4);
    expect(down).toBeCloseTo((BODY_R + HEIGHT) * s * 0.5, 4);
  });

  it('a single fin still gets a box with height', () => {
    show(<TreeSchematic tree={treeWith({ type: 'trapezoidfinset', finCount: 1, tipChord: 0.03, sweep: 0.02 })} info={null} />);
    over(host.querySelector(FILLED_FIN)!);
    const wash = host.querySelector<SVGRectElement>('rect[fill="var(--accent)"]')!;
    expect(Number(wash.getAttribute('height'))).toBeGreaterThan(HEIGHT * scale() * 0.9);
  });
});

describe('the zoom buttons anchor on the drawing, not the canvas', () => {
  it('holds the drawing area centre fixed across a zoom step', () => {
    show(<TreeSchematic tree={treeWith({ type: 'trapezoidfinset', finCount: 3, tipChord: 0.03, sweep: 0.02 })} info={null} />);
    const [, , w, h] = viewBox();
    const zoomIn = [...host.querySelectorAll('button')]
      .find((b) => b.getAttribute('aria-label') === 'Zoom in')!;
    act(() => { zoomIn.click(); });

    const t = host.querySelector('svg > g')!.getAttribute('transform')!;
    const [, tx, ty, k] = /translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)/.exec(t)!.map(Number) as number[];
    // The gutters: roll column + vertical ruler on the left, ruler band on top.
    const gutX = ROLL_COL + RULER_LEFT;
    const ax = (gutX + w!) / 2;
    const ay = (RULER_TOP + h!) / 2;
    // A point held fixed satisfies  a = t + k*a.
    expect(tx! + k! * ax).toBeCloseTo(ax, 6);
    expect(ty! + k! * ay).toBeCloseTo(ay, 6);
    // …and the canvas centre, which it used to hold, has moved.
    expect(ty! + k! * (h! / 2)).not.toBeCloseTo(h! / 2, 3);
  });
});

/**
 * v0.080 — a fin rolling edge-on used to be drawn in full, most of it lying
 * across the airframe fill, and then dropped the instant its tip crossed the
 * body radius: on a four-fin set, two fin-shaped patches blinking out at once,
 * twice per quarter turn (owner report, 2026-08-30). Fins are clipped to the
 * airframe's outside now, so the same instance retreats into the tube wall and
 * leaves with zero area.
 */
describe('fins retreat into the airframe instead of blinking out', () => {
  const roll = (deg: number, finCount: number) => act(() => root.render(
    <TreeSchematic
      tree={treeWith({ type: 'trapezoidfinset', finCount, tipChord: 0.03, sweep: 0.02 })}
      info={null} roll={(deg * Math.PI) / 180} />,
  ));

  /** The airframe band's edges, read off the OUTSIDE clip (two rects). */
  const band = () => {
    const rects = [...host.querySelectorAll('clipPath[id$="-outside-0"] rect')];
    expect(rects.length, 'the outside clip should be two rects').toBe(2);
    const a = rects[0]!;
    const b = rects[1]!;
    return {
      top: Number(a.getAttribute('y')) + Number(a.getAttribute('height')),
      bottom: Number(b.getAttribute('y')),
    };
  };

  /** Total fin area OUTSIDE the airframe — what the viewer can actually see. */
  const visible = () => {
    if (!host.querySelector(FILLED_FIN)) return 0;
    const { top, bottom } = band();
    return [...host.querySelectorAll(FILLED_FIN)].reduce((sum, p) => {
      const ys = p.getAttribute('points')!.split(' ').map((q) => Number(q.split(',')[1]));
      return sum + Math.max(0, top - Math.min(...ys)) + Math.max(0, Math.max(...ys) - bottom);
    }, 0);
  };

  it('clips the FAR fins to the airframe, with a resolvable reference', () => {
    roll(10, 3);
    const polys = [...host.querySelectorAll(FILLED_FIN)];
    expect(polys.length).toBeGreaterThan(0);
    const clipped = polys.filter((p) => p.getAttribute('clip-path'));
    // Near fins are drawn whole — they are in FRONT of the tube — so only the
    // far ones carry a clip, and at least one always does at a rolled angle.
    expect(clipped.length).toBeGreaterThan(0);
    for (const p of clipped) {
      const ref = /url\(#(.+)\)/.exec(p.getAttribute('clip-path')!);
      expect(host.querySelector(`clipPath[id="${ref![1]}"]`), 'the clip must exist').not.toBeNull();
    }
    // The band is the airframe, not something else.
    const { top, bottom } = band();
    expect(bottom - top).toBeCloseTo(2 * BODY_R * scale(), 4);
    // …and the INSIDE clip is its complement, one rect over the same band.
    const inner = [...host.querySelectorAll('clipPath[id$="-inside-0"] rect')];
    expect(inner).toHaveLength(1);
    expect(Number(inner[0]!.getAttribute('y'))).toBeCloseTo(top, 6);
    expect(Number(inner[0]!.getAttribute('height'))).toBeCloseTo(bottom - top, 6);
  });

  it('namespaces the clip id, so two schematics in one document cannot cross-clip', () => {
    roll(10, 3);
    const id = host.querySelector('clipPath')!.getAttribute('id')!;
    expect(id).toMatch(/-outside-\d+$/);
    expect(id.startsWith('-outside')).toBe(false); // a real instance prefix
  });

  /**
   * THE regression guard. Everything the old code drew inside the airframe was
   * painted over the tube and then thrown away whole; the visible-area sweep
   * below cannot see that, because it reads the polygon's points and those are
   * the same either way. What distinguishes the fix is that a fin overlapping
   * the airframe is CLIPPED, so this asserts exactly that — and asserts the
   * case is reached, or it would pass on a rocket with no such fin.
   */
  it('never paints a FAR fin across the airframe, and always paints a near one', () => {
    let far = 0;
    let near = 0;
    for (const finCount of [3, 4]) {
      for (let deg = 0; deg <= 180; deg += 3) {
        roll(deg, finCount);
        if (!host.querySelector(FILLED_FIN)) continue;
        const { top, bottom } = band();
        for (const p of host.querySelectorAll(FILLED_FIN)) {
          const ys = p.getAttribute('points')!.split(' ').map((q) => Number(q.split(',')[1]));
          if (!ys.some((y) => y > top + 0.01 && y < bottom - 0.01)) continue; // no overlap
          if (p.getAttribute('clip-path')) {
            far++; // behind the tube: the overlap must be clipped away
          } else {
            near++; // in front of it: drawn whole, and that is the depth cue
          }
        }
      }
    }
    // Both cases must actually occur, or neither half of the claim is tested.
    expect(far, 'no clipped overlap was produced — the far-side guard is vacuous').toBeGreaterThan(10);
    expect(near, 'no unclipped overlap was produced — the near-side cue is missing').toBeGreaterThan(10);
  }, 60_000);

  it('loses no fin abruptly: the visible span moves smoothly across a turn', () => {
    for (const finCount of [3, 4]) {
      let prev = NaN;
      let worst = 0;
      for (let deg = 0; deg <= 180; deg += 1) {
        roll(deg, finCount);
        const v = visible();
        if (!Number.isNaN(prev)) worst = Math.max(worst, Math.abs(v - prev));
        prev = v;
      }
      // This held before the clip too — the drop rule already fired at zero
      // visible extent. It is here to keep the two in step: change the drop
      // threshold without changing the clip and a fin starts vanishing while
      // part of it is still outside the tube.
      expect(worst, `${finCount}-fin set jumped ${worst.toFixed(1)} px in one degree`)
        .toBeLessThan(4);
    }
  }, 60_000);
});

/**
 * v0.081 — the owner, on v0.080: "the fins do not depict correctly while
 * rotating … it is not fixed."
 *
 * He was comparing against desktop OR, and the difference is that desktop's
 * figure is a WIREFRAME: `RocketFigure.paintComponent` is `g2.draw(shape)`
 * and the only `g2.fill` is the motor (RocketFigure.java:314, :384). So every
 * fin is on screen at all times and you watch them sweep THROUGH the body.
 * Ours filled them, so whatever the airframe covered had to go somewhere, and
 * a fin appeared at the wall out of nowhere. Now the covered part is a hidden
 * line while the view is rolled, so the count on screen never changes.
 */
describe('every fin stays on screen while the view is rolled', () => {
  const roll = (deg: number, finCount: number) => act(() => root.render(
    <TreeSchematic
      tree={treeWith({ type: 'trapezoidfinset', finCount, tipChord: 0.03, sweep: 0.02 })}
      info={null} roll={(deg * Math.PI) / 180} />,
  ));
  const hiddenCount = () => host.querySelectorAll('[data-fin="hidden"]').length;

  it('accounts for every instance at every angle — nothing silently vanishes', () => {
    for (const finCount of [3, 4, 6]) {
      for (let deg = 1; deg <= 180; deg += 1) {
        roll(deg, finCount);
        // A FAR instance always has a hidden line, whether or not any of it
        // clears the tube; a NEAR one is drawn whole or not at all (edge-on).
        // So hidden lines count the far half exactly.
        const hidden = hiddenCount();
        expect(hidden, `${finCount}-fin set at ${deg}deg`).toBeGreaterThan(0);
        expect(hidden).toBeLessThanOrEqual(finCount);
        expect(host.querySelectorAll(FILLED_FIN).length).toBeLessThanOrEqual(finCount);
      }
    }
  }, 120_000);

  it('gives a far fin a hidden line and a near fin none — it has nothing hidden', () => {
    roll(30, 3);
    const hidden = hiddenCount();
    // 30°: fins at 30/150/270. sin30 and sin150 are positive (near), sin270
    // negative (far) — so exactly one hidden line.
    expect(hidden).toBe(1);
    const filled = host.querySelectorAll(FILLED_FIN).length;
    expect(filled).toBe(2);
    for (const h of host.querySelectorAll('[data-fin="hidden"]')) {
      expect(h.getAttribute('fill')).toBe('none');
      expect(h.getAttribute('stroke-dasharray')).toBeTruthy();
      expect(h.getAttribute('clip-path')).toContain('-inside-');
    }
  });

  it('adds nothing at rest — an unrolled drawing is what it always was', () => {
    act(() => root.render(
      <TreeSchematic tree={treeWith({ type: 'trapezoidfinset', finCount: 4, tipChord: 0.03, sweep: 0.02 })}
        info={null} />,
    ));
    expect(host.querySelectorAll('[data-fin="hidden"]')).toHaveLength(0);
    // A 4-fin set at rest is the mirrored pair it has always been.
    expect(host.querySelectorAll(FILLED_FIN)).toHaveLength(2);
  });
});
