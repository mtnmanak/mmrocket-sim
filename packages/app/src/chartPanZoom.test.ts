import { describe, expect, it } from 'vitest';
import {
  clampWindow, panWindow, WHEEL_ZOOM_IN, WHEEL_ZOOM_OUT, zoomWindow,
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
