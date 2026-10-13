import { describe, expect, it } from 'vitest';
import { fitFin, finToScreen, screenToFin, panFin, zoomFin } from './finViewport.js';

describe('the freeform fin view (N019)', () => {
  const points: [number, number][] = [[0, 0], [0.02, 0.03], [0.045, 0.03], [0.06, 0]];

  it('fits the outline and inverts a panned, zoomed view without editing points', () => {
    const before = structuredClone(points);
    const fit = fitFin(points);
    expect(finToScreen(fit, points[1]!)).toEqual([106, 22]);
    const view = zoomFin(panFin(fit, [30, -10]), [136, 12], 2, fit.scale);
    expect(finToScreen(view, points[1]!)).toEqual([136, 12]);
    expect(finToScreen(view, points[2]!)).toEqual([346, 12]);
    const model = screenToFin(view, [220, 54]);
    // View arithmetic only: 12 decimal places is well below a nanometre.
    expect(model[0]).toBeCloseTo(0.03, 12);
    expect(model[1]).toBeCloseTo(0.025, 12);
    expect(points).toEqual(before);
  });

  it('keeps the zoom focus fixed at both limits and ignores invalid factors', () => {
    const fit = fitFin(points);
    for (const factor of [1e6, 1e-6]) {
      const next = zoomFin(fit, [106, 22], factor, fit.scale);
      expect(finToScreen(next, points[1]!)).toEqual([106, 22]);
      expect(next.scale / fit.scale).toBe(factor > 1 ? 50 : 0.25);
    }
    for (const factor of [0, -1, NaN, Infinity]) {
      expect(zoomFin(fit, [106, 22], factor, fit.scale)).toEqual(fit);
    }
  });
});
