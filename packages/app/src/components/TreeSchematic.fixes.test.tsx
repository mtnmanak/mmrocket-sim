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

/** A FILLED fin, not the wire outline a rolled view draws instead (v0.084). */
const FILLED_FIN = 'polygon:not([data-fin="wire"]):not([data-fin-hit])';
const FILLED_ARC = 'path:not([data-fin="wire"]):not([data-fin-hit])';

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
  /**
   * Sweeps the fin set's OWN rotation with the view left at rest, because from
   * v0.084 a rolled view is a wireframe and has no fills or clips to test.
   * `finFactors` reads `rotation + roll`, so this exercises the identical
   * projection through the at-rest drawing, which is where the fill and the
   * clip still live.
   */
  const roll = (deg: number, finCount: number) => act(() => root.render(
    <TreeSchematic
      tree={treeWith({
        type: 'trapezoidfinset', finCount, tipChord: 0.03, sweep: 0.02,
        rotation: (deg * Math.PI) / 180,
      })}
      info={null} />,
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
 * v0.084 — the owner, after four releases: "the rotating fins on the 2D view
 * is still not working … it just looks like the fins are toggling back and
 * forth." The projection was then measured off his own screen recordings of
 * the same rocket in both programs and found to be right all along (up/down
 * extent ratio 0.50–2.01 here, 0.51–2.00 in desktop, 0.50–2.00 predicted).
 *
 * What differed was the drawing convention. Desktop's figure is a WIREFRAME:
 * `RocketFigure.paintComponent` is `g2.draw(shape)` and the only `g2.fill` is
 * the motor (RocketFigure.java:314, :384). Every fin is on screen at every
 * angle, including the ones lying inside the body, so each can be followed
 * round. He picked that convention from a side-by-side mockup, for the rolled
 * view only.
 *
 * The one property that matters, and the reason the previous five attempts all
 * failed while being individually defensible: THE COUNT ON SCREEN IS EXACTLY
 * THE FIN COUNT, at every angle. Not "at least one", not "no more than" —
 * exactly, or a fin is missing and cannot be followed.
 */
describe('the rolled view is a wireframe: every fin, every angle', () => {
  const roll = (deg: number, finCount: number, fin: Record<string, unknown> = {}) =>
    act(() => root.render(
      <TreeSchematic
        tree={treeWith({ type: 'trapezoidfinset', finCount, tipChord: 0.03, sweep: 0.02, ...fin })}
        info={null} roll={(deg * Math.PI) / 180} />,
    ));
  const wires = () => [...host.querySelectorAll('[data-fin="wire"]')];

  it('draws exactly one outline per instance at every angle', () => {
    for (const finCount of [1, 2, 3, 4, 6]) {
      for (let deg = 1; deg <= 180; deg += 1) {
        roll(deg, finCount);
        expect(wires().length, `${finCount}-fin set at ${deg}deg`).toBe(finCount);
        // …and nothing is filled or clipped: no occlusion anywhere.
        expect(host.querySelectorAll(FILLED_FIN)).toHaveLength(0);
        for (const w of wires()) expect(w.getAttribute('clip-path')).toBeNull();
      }
    }
  }, 120_000);

  it('holds for an elliptical and a freeform fin too — his own two shapes', () => {
    roll(37, 3, { type: 'ellipticalfinset' });
    expect(host.querySelectorAll('path[data-fin="wire"]')).toHaveLength(3);
    roll(37, 3, { type: 'freeformfinset', points: [[0, 0], [0.02, HEIGHT], [0.04, HEIGHT], [0.05, 0]] });
    expect(host.querySelectorAll('polygon[data-fin="wire"]')).toHaveLength(3);
  });

  /**
   * The hit model, and why it is TWO elements. A hollow shape takes pointer
   * events only on its stroke; blanket pointerEvents:all (the first cut of
   * v0.084) made the whole invisible interior the topmost target, so a click
   * or drag aimed at bare body tube landed on a fin nobody could see — and
   * the drag MOVED it. So: the outline hits on its stroke anywhere, and an
   * invisible hit surface covers the interior only OUTSIDE the airframe band.
   */
  it('keeps a hollow fin clickable, without an invisible interior over the tube', () => {
    const picked: string[] = [];
    act(() => root.render(
      <TreeSchematic tree={treeWith({ type: 'trapezoidfinset', finCount: 3, tipChord: 0.03, sweep: 0.02 })}
        info={null} roll={Math.PI / 6} onSelect={(id) => picked.push(id)} />,
    ));
    const w = wires();
    expect(w).toHaveLength(3);
    for (const p of w) {
      expect(p.getAttribute('fill')).toBe('none');
      // No blanket hit override on the outline: its stroke is the target.
      expect((p as SVGElement).style.pointerEvents).not.toBe('all');
      expect((p as SVGElement).style.cursor).toBeTruthy();
    }
    const hits = [...host.querySelectorAll('[data-fin-hit]')];
    expect(hits).toHaveLength(3);
    for (const hit of hits) {
      expect(hit.getAttribute('fill')).toBe('transparent');
      expect(hit.getAttribute('stroke')).toBe('none');
      // Clipped to OUTSIDE the airframe band, so the tube keeps its own clicks.
      const ref = /url\(#(.+)\)/.exec(hit.getAttribute('clip-path')!)!;
      expect(ref[1]).toContain('-outside-');
      expect(host.querySelector(`clipPath[id="${ref[1]}"]`), 'the clip must exist').not.toBeNull();
    }
    act(() => { (hits[0] as SVGElement).dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(picked).toEqual(['f1']);
  });

  it('is the fin colour, not a hint — display colour, then the accent when selected', () => {
    roll(30, 3);
    expect(wires()[0]!.getAttribute('stroke')).toBe('#7a786f');
    // A custom display colour survives the roll (v0.084 first cut greyed it).
    roll(30, 3, { color: '#c0392b' });
    for (const w of wires()) expect(w.getAttribute('stroke')).toBe('#c0392b');
    act(() => root.render(
      <TreeSchematic tree={treeWith({ type: 'trapezoidfinset', finCount: 3, tipChord: 0.03, sweep: 0.02 })}
        info={null} roll={Math.PI / 6} selectedId="f1" />,
    ));
    for (const w of wires()) expect(w.getAttribute('stroke')).toBe('var(--accent)');
  });

  it('covers tube fins: one wire ring per tube, and the outlines paint LAST', () => {
    roll(30, 6, { type: 'tubefinset', length: 0.04 });
    const rects = [...host.querySelectorAll('rect[data-fin="wire"]')];
    expect(rects).toHaveLength(6);
    // Above everything the body paints — a loaded motor case lands in the
    // overlay, exactly on the in-body run the wireframe exists to show.
    const svg = host.querySelector('svg')!;
    const all = [...svg.querySelectorAll('*')];
    const lastBody = Math.max(...[...svg.querySelectorAll('rect[fill="#e7e5e0"]')].map((el) => all.indexOf(el)));
    for (const r of rects) expect(all.indexOf(r)).toBeGreaterThan(lastBody);
  });

  it('lets an edge-on tab vanish with its fin instead of flooring to a band', () => {
    // 4 fins at 90°: two instances edge-on. Their fins collapse to lines; the
    // 1.5 px height floor used to leave their tabs as a dashed band riding the
    // centreline that never foreshortened.
    roll(90, 4, { tabHeight: 0.005, tabLength: 0.03 });
    const tabs = [...host.querySelectorAll('rect[stroke-dasharray="3 2"]')];
    expect(tabs).toHaveLength(2); // the visible pair only — edge-on pair gone
    for (const tb of tabs) expect(Number(tb.getAttribute('height'))).toBeGreaterThan(1.5);
  });

  it('collapses an edge-on elliptical fin to a line, not a 2px lens', () => {
    roll(90, 4, { type: 'ellipticalfinset' });
    // 4 fins at 90° roll: instances at 90/180/270/360 → two edge-on (p≈0).
    const ds = [...host.querySelectorAll('path[data-fin="wire"]')].map((p) => p.getAttribute('d')!);
    expect(ds).toHaveLength(4);
    const ry = (d: string) => Number(/A [\d.e-]+ ([\d.e-]+)/.exec(d)![1]);
    const rys = ds.map(ry).sort((a, b) => a - b);
    // The at-rest drawing floors ry at 2 so slivers stay visible; wired, the
    // floor kept an edge-on ellipse as a lens whose bulge flips with sign(p).
    expect(rys[0]).toBeLessThan(1e-9);
    expect(rys[1]).toBeLessThan(1e-9);
    expect(rys[3]).toBeGreaterThan(2);
  });

  it('changes nothing at rest — an unrolled drawing is still filled', () => {
    act(() => root.render(
      <TreeSchematic tree={treeWith({ type: 'trapezoidfinset', finCount: 4, tipChord: 0.03, sweep: 0.02 })}
        info={null} />,
    ));
    expect(wires()).toHaveLength(0);
    // A 4-fin set at rest is the mirrored pair it has always been.
    expect(host.querySelectorAll(FILLED_FIN)).toHaveLength(2);
  });
});

/**
 * v0.086 — the owner rolled a design carrying a camera shroud and the shroud
 * stayed at 12 o'clock while the fins turned past it. His follow-up question
 * was the right one: "is this just camera shrouds, or do you need to test all
 * parts?" It was not just shrouds — every part that sits ON the airframe
 * surface was drawn at a hardcoded top position: shroud (fairing),
 * protuberance, launch lug and rail button.
 *
 * None of them stores its own clock angle yet (a separate, larger gap — the
 * .ork round-trip drops it). But the VIEW roll must still carry them round,
 * or the cross-section is not rigid: rolling has to turn the whole rocket,
 * not a subset of it.
 */
describe('every surface-mounted part turns with the view', () => {
  const withPart = (part: Record<string, unknown>) => ({
    name: 'Rocket',
    components: [{
      id: 's1', type: 'stage',
      children: [
        { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: BODY_R },
        {
          id: 'b1', type: 'bodytube', length: 0.3, outerRadius: BODY_R,
          children: [{ id: 'p1', ...part }],
        },
      ],
    }],
  } as unknown as RocketTree);

  /** The part's furthest reach from the centreline (+ above, - below). */
  const reach = (sel: string): number => {
    const el = host.querySelector(sel)!;
    const cy = centreY();
    const ys = el.tagName === 'rect'
      ? [Number(el.getAttribute('y')), Number(el.getAttribute('y')) + Number(el.getAttribute('height'))]
      : (el.getAttribute('points') ?? el.getAttribute('d')!)
        .match(/[-\d.]+,[-\d.]+/g)!.map((q) => Number(q.split(',')[1]));
    return cy - ys.reduce((a, b) => (Math.abs(b - cy) > Math.abs(a - cy) ? b : a), cy);
  };

  const CASES: Array<[string, Record<string, unknown>, string]> = [
    ['camera shroud', { type: 'fairing', length: 0.05, height: 0.02, width: 0.02, fairingShape: 'square' }, 'rect:not([fill="#e7e5e0"])'],
    ['protuberance', { type: 'protuberance', length: 0.05, height: 0.01, dragClass: 'plate' }, 'polygon'],
    ['launch lug', { type: 'launchlug', length: 0.03, outerRadius: 0.002 }, 'rect:not([fill="#e7e5e0"])'],
    ['rail button', { type: 'railbutton', outerDiameter: 0.004 }, 'rect:not([fill="#e7e5e0"])'],
  ];

  for (const [label, part, sel] of CASES) {
    it(`${label}: on top at rest, below the axis at 180 deg, edge-on between`, () => {
      show(<TreeSchematic tree={withPart(part)} info={null} />);
      const up = reach(sel);
      expect(up, `${label} should start above the centreline`).toBeGreaterThan(0);

      // Half a turn puts it on the far side, the same distance down.
      show(<TreeSchematic tree={withPart(part)} info={null} roll={Math.PI} />);
      expect(reach(sel), `${label} did not roll to the far side`).toBeCloseTo(-up, 4);

      // A quarter turn is edge-on: it collapses onto the airframe wall.
      show(<TreeSchematic tree={withPart(part)} info={null} roll={Math.PI / 2} />);
      expect(Math.abs(reach(sel)), `${label} did not foreshorten`).toBeLessThan(Math.abs(up) * 0.2);
    });
  }
});
