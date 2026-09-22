import { describe, expect, it } from 'vitest';
import {
  clampWindow, isFullExtent, panelHeight, panWindow, plotIsZoomed, resetPlots,
  WHEEL_ZOOM_BASE, WHEEL_ZOOM_IN, WHEEL_ZOOM_OUT, wheelNotches, wheelWindow, wheelZoomFactor,
  xDataExtent, zoomPercent, zoomWindow, type XPlot, type XWindow,
} from './chartPanZoom.js';

// Data extent used throughout: a 0–20 s flight.
const D0 = 0;
const D1 = 20;

describe('clampWindow', () => {
  it('passes a window already inside the extent through unchanged', () => {
    expect(clampWindow(2, 5, D0, D1)).toEqual({ min: 2, max: 5 });
  });

  it('slides a window past the left edge back in, width preserved', () => {
    expect(clampWindow(-3, 1, D0, D1)).toEqual({ min: 0, max: 4 });
  });

  it('slides a window past the right edge back in, width preserved', () => {
    expect(clampWindow(18, 22, D0, D1)).toEqual({ min: 16, max: 20 });
  });

  it('caps a window wider than the data at the full extent', () => {
    expect(clampWindow(-5, 30, D0, D1)).toEqual({ min: D0, max: D1 });
  });

  it('returns the full extent for a degenerate (zero/negative width) window', () => {
    expect(clampWindow(5, 5, D0, D1)).toEqual({ min: D0, max: D1 });
    expect(clampWindow(7, 3, D0, D1)).toEqual({ min: D0, max: D1 });
  });

  it('returns the degenerate extent as-is when the data has no width', () => {
    expect(clampWindow(1, 2, 5, 5)).toEqual({ min: 5, max: 5 });
  });
});

describe('zoomWindow', () => {
  it('shrinks the window by the factor when zooming in', () => {
    const w = zoomWindow(0, 10, 5, WHEEL_ZOOM_IN, D0, D1);
    expect(w.max - w.min).toBeCloseTo(10 * WHEEL_ZOOM_IN, 12);
  });

  it('keeps the value under the cursor a fixed point', () => {
    // The cursor sits 30% into the window; it must still sit 30% in after.
    const focus = 3;
    const w = zoomWindow(0, 10, focus, WHEEL_ZOOM_IN, D0, D1);
    expect((focus - w.min) / (w.max - w.min)).toBeCloseTo(0.3, 12);
  });

  it('zooming out grows the window by the factor', () => {
    const w = zoomWindow(4, 8, 6, WHEEL_ZOOM_OUT, D0, D1);
    expect(w.max - w.min).toBeCloseTo(4 * WHEEL_ZOOM_OUT, 12);
  });

  it('clamps zoom-out to the full data extent and never past it', () => {
    let w = { min: 1, max: 19 };
    for (let i = 0; i < 50; i++) {
      w = zoomWindow(w.min, w.max, 10, WHEEL_ZOOM_OUT, D0, D1);
      expect(w.min).toBeGreaterThanOrEqual(D0);
      expect(w.max).toBeLessThanOrEqual(D1);
    }
    expect(w).toEqual({ min: D0, max: D1 });
  });

  it('slides a zoom-out near an edge inward instead of past the data', () => {
    // Zooming out at the very left edge would run min negative — it must
    // clamp by sliding, keeping the factor-grown width.
    const w = zoomWindow(0, 4, 0.2, WHEEL_ZOOM_OUT, D0, D1);
    expect(w.min).toBe(D0);
    expect(w.max - w.min).toBeCloseTo(4 * WHEEL_ZOOM_OUT, 12);
  });

  it('returns the extent verbatim when zooming out at full extent', () => {
    // The wheel handler skips preventDefault (so the page keeps scrolling)
    // when the prospective window === the current one. That no-op detection
    // relies on clampWindow handing back the exact data-extent values, not
    // numbers an epsilon off — assert strict equality, at several foci.
    for (const focus of [D0, 7, D1]) {
      const w = zoomWindow(D0, D1, focus, WHEEL_ZOOM_OUT, D0, D1);
      expect(w.min === D0).toBe(true);
      expect(w.max === D1).toBe(true);
    }
  });

  it('holds the window when zoom depth hits floating-point collapse', () => {
    // A window so narrow that scaling it produces zero width must not hand
    // uPlot min === max.
    const min = 10;
    const max = 10 + Number.EPSILON * 10;
    let w = { min, max };
    for (let i = 0; i < 200; i++) {
      w = zoomWindow(w.min, w.max, 10, WHEEL_ZOOM_IN, D0, D1);
    }
    expect(w.max - w.min).toBeGreaterThan(0);
  });
});

describe('isFullExtent', () => {
  it('is exact equality, both ends', () => {
    expect(isFullExtent(D0, D1, D0, D1)).toBe(true);
    expect(isFullExtent(D0 + 1e-9, D1, D0, D1)).toBe(false);
    expect(isFullExtent(D0, D1 - 1e-9, D0, D1)).toBe(false);
  });

  it('agrees with clampWindow after a zoom-out at full extent (the no-op contract)', () => {
    const w = zoomWindow(D0, D1, 7, WHEEL_ZOOM_OUT, D0, D1);
    expect(isFullExtent(w.min, w.max, D0, D1)).toBe(true);
  });
});

/** Stub uPlot for the structural helpers (real uPlot needs a DOM layout pass). */
function stubPlot(xs: number[], win?: XWindow) {
  const calls: { key: string; win: XWindow }[] = [];
  const p: XPlot = {
    data: [xs],
    scales: { x: win ? { ...win } : {} },
    setScale: (key, w) => calls.push({ key, win: w }),
  };
  return { p, calls };
}

describe('xDataExtent', () => {
  it('reads first/last x value', () => {
    expect(xDataExtent(stubPlot([0, 5, 12, 20]).p)).toEqual([0, 20]);
  });

  it('is [0, 0] for empty or missing data', () => {
    expect(xDataExtent(stubPlot([]).p)).toEqual([0, 0]);
    expect(xDataExtent({ data: [], scales: {}, setScale: () => {} })).toEqual([0, 0]);
  });
});

describe('plotIsZoomed', () => {
  it('is false at the exact full extent and true inside it', () => {
    expect(plotIsZoomed(stubPlot([0, 10, 20], { min: 0, max: 20 }).p)).toBe(false);
    expect(plotIsZoomed(stubPlot([0, 10, 20], { min: 2, max: 18 }).p)).toBe(true);
    expect(plotIsZoomed(stubPlot([0, 10, 20], { min: 0, max: 18 }).p)).toBe(true);
  });

  it('is false when the scale is unset or the data is degenerate', () => {
    expect(plotIsZoomed(stubPlot([0, 10, 20]).p)).toBe(false); // no min/max yet
    expect(plotIsZoomed(stubPlot([], { min: 0, max: 1 }).p)).toBe(false);
    expect(plotIsZoomed(stubPlot([5], { min: 0, max: 1 }).p)).toBe(false); // single point
  });
});

describe('resetPlots', () => {
  it('sets each plot to its OWN full x extent', () => {
    const a = stubPlot([0, 20], { min: 3, max: 9 });
    const b = stubPlot([2, 50], { min: 10, max: 12 });
    resetPlots([a.p, b.p]);
    expect(a.calls).toEqual([{ key: 'x', win: { min: 0, max: 20 } }]);
    expect(b.calls).toEqual([{ key: 'x', win: { min: 2, max: 50 } }]);
  });

  it('leaves plots with no usable extent alone', () => {
    const empty = stubPlot([]);
    const point = stubPlot([5], { min: 0, max: 1 });
    resetPlots([empty.p, point.p]);
    expect(empty.calls).toEqual([]);
    expect(point.calls).toEqual([]);
  });
});

describe('panelHeight', () => {
  it('normal mode keeps the shipped policy: 0.22 x width, clamped 160-240', () => {
    expect(panelHeight(320, false)).toBe(160); // floor
    expect(panelHeight(640, false)).toBe(160); // 140.8 -> floor
    expect(panelHeight(1000, false)).toBe(220); // in-band
    expect(panelHeight(1500, false)).toBe(240); // cap
  });

  it('expanded mode is 0.42 x width, clamped 300-560', () => {
    expect(panelHeight(320, true)).toBe(300); // floor (phone: still ~2x taller)
    expect(panelHeight(1000, true)).toBe(420); // in-band
    expect(panelHeight(1500, true)).toBe(560); // cap
  });

  it('expanded is strictly taller than normal at every width', () => {
    for (const w of [0, 200, 320, 640, 900, 1200, 1500, 2200, 4000]) {
      expect(panelHeight(w, true)).toBeGreaterThan(panelHeight(w, false));
    }
  });
});

/**
 * The wheel's 50x floor (WHEEL_MAX_DEPTH), audit 2026-09-22: it was applied to
 * whatever the wheel produced, so a wheel-IN on a box zoom already deeper than
 * the floor re-zoomed to the floor — outward. Measured on a 100 s flight:
 * [40, 40.5] s became [39.25, 41.25] s, and every synced panel followed.
 */
describe('wheelWindow — the wheel floor', () => {
  const E0 = 0;
  const E1 = 100; // floor = 100 / 50 = 2 s

  it('a wheel-in on a box zoom deeper than the floor holds the window exactly', () => {
    const w = wheelWindow(40, 40.5, 40.2, WHEEL_ZOOM_IN, E0, E1);
    // Exact, not close: the handler hands an unchanged window back to the page.
    expect(w).toEqual({ min: 40, max: 40.5 });
  });

  it('a wheel-out from there widens by one notch, not to the floor', () => {
    const w = wheelWindow(40, 40.5, 40.2, WHEEL_ZOOM_OUT, E0, E1);
    expect(w.max - w.min).toBeCloseTo(0.5 * WHEEL_ZOOM_OUT, 12);
  });

  it('still stops a wheel-in that would cross the floor ON it', () => {
    const w = wheelWindow(40, 42.1, 41, WHEEL_ZOOM_IN, E0, E1);
    expect(w.max - w.min).toBeCloseTo(2, 12);
  });

  it('leaves an ordinary notch above the floor to zoomWindow', () => {
    expect(wheelWindow(0, 10, 5, WHEEL_ZOOM_IN, E0, E1))
      .toEqual(zoomWindow(0, 10, 5, WHEEL_ZOOM_IN, E0, E1));
  });

  it('once the wheel has reached the floor, further wheel-ins are exact no-ops', () => {
    let w: XWindow = { min: 30, max: 60 };
    for (let i = 0; i < 60; i++) w = wheelWindow(w.min, w.max, 45, WHEEL_ZOOM_IN, E0, E1);
    expect(w.max - w.min).toBeCloseTo(2, 9);
    expect(wheelWindow(w.min, w.max, 45, WHEEL_ZOOM_IN, E0, E1)).toEqual(w);
  });
});

describe('panWindow', () => {
  it('translates the window by the delta', () => {
    expect(panWindow(2, 6, 3, D0, D1)).toEqual({ min: 5, max: 9 });
    expect(panWindow(5, 9, -3, D0, D1)).toEqual({ min: 2, max: 6 });
  });

  it('stops at the left edge, width preserved', () => {
    expect(panWindow(1, 5, -4, D0, D1)).toEqual({ min: 0, max: 4 });
  });

  it('stops at the right edge, width preserved', () => {
    expect(panWindow(15, 19, 4, D0, D1)).toEqual({ min: 16, max: 20 });
  });

  it('is a no-op when already showing the full extent', () => {
    expect(panWindow(D0, D1, 5, D0, D1)).toEqual({ min: D0, max: D1 });
  });
});

/**
 * THE WHEEL, which had no test at all until now — and two defects under it.
 *
 * The owner, 2026-09-18: "the zoom goes very, very fast when scrolling the
 * mouse wheel. A few clicks of turning the wheel and the plot zooms in very
 * close." The rate was part of it; the larger part was that the handler applied
 * a fixed factor per EVENT and read nothing but the sign of deltaY, so a
 * high-resolution wheel firing several events per detent zoomed several times
 * as far for the same turn of the hand.
 */
describe('wheelNotches / wheelZoomFactor', () => {
  it('reads one standard detent as one notch, in each deltaMode', () => {
    expect(wheelNotches({ deltaY: -100 })).toBeCloseTo(1, 12);          // pixels
    expect(wheelNotches({ deltaY: -3, deltaMode: 1 })).toBeCloseTo(1, 12);  // lines
    expect(wheelNotches({ deltaY: -1, deltaMode: 2 })).toBeCloseTo(1, 12);  // pages
    expect(wheelZoomFactor({ deltaY: -100 })).toBeCloseTo(WHEEL_ZOOM_BASE, 12);
  });

  it('composes: six small events equal one whole detent', () => {
    // This is the defect. Six events of a sixth of a detent used to zoom six
    // times as far as one event of a whole detent.
    let f = 1;
    for (let i = 0; i < 6; i++) f *= wheelZoomFactor({ deltaY: -100 / 6 });
    expect(f).toBeCloseTo(WHEEL_ZOOM_BASE, 12);
  });

  it('is exactly reversible, which 0.85 and 1.15 were not', () => {
    // 0.85 * 1.15 = 0.9775, so every in-then-out crept 2.25% inward.
    expect(wheelZoomFactor({ deltaY: -100 }) * wheelZoomFactor({ deltaY: 100 }))
      .toBeCloseTo(1, 12);
    expect(WHEEL_ZOOM_IN * WHEEL_ZOOM_OUT).toBeCloseTo(1, 12);
  });

  it('treats a zero or non-finite delta as no movement', () => {
    expect(wheelNotches({ deltaY: 0 })).toBe(0);
    expect(wheelZoomFactor({ deltaY: 0 })).toBe(1);
    expect(wheelZoomFactor({ deltaY: NaN })).toBe(1);
  });

  it('clamps one violent flick so it cannot bottom out in a single event', () => {
    expect(wheelNotches({ deltaY: -10000 })).toBe(3);
    expect(wheelNotches({ deltaY: 10000 })).toBe(-3);
  });

  /**
   * Pinned off the constant rather than typed in, so a figure quoted in a
   * release note cannot drift from what the code does.
   */
  it('takes 7 notches to double and 22 to reach 10x', () => {
    expect(Math.ceil(Math.log(0.5) / Math.log(WHEEL_ZOOM_BASE))).toBe(7);
    expect(Math.ceil(Math.log(0.1) / Math.log(WHEEL_ZOOM_BASE))).toBe(22);
  });
});

describe('zoomPercent', () => {
  const plot = (min: number | null, max: number | null, xs: number[] = [0, 10]): XPlot => ({
    data: [xs],
    scales: { x: { min, max } },
    setScale: () => {},
  });

  it('reads 100% at the full extent and scales inversely with the window', () => {
    expect(zoomPercent(plot(0, 10))).toBeCloseTo(100, 9);
    expect(zoomPercent(plot(0, 5))).toBeCloseTo(200, 9);
    expect(zoomPercent(plot(2.5, 5))).toBeCloseTo(400, 9);
  });

  it('reads 100% rather than dividing by zero on degenerate input', () => {
    expect(zoomPercent(plot(null, null))).toBe(100);
    expect(zoomPercent(plot(0, 0))).toBe(100);
    expect(zoomPercent(plot(0, 10, []))).toBe(100);
    expect(zoomPercent(plot(0, 10, [4]))).toBe(100);
  });
});
