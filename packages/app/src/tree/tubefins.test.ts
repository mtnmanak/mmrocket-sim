import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { tubeFinMaxCount, tubeFinMaxRadius, tubeFinRadius } from './tubefins.js';

const set = (params: Record<string, unknown>): ComponentNode =>
  ({ type: 'tubefinset', id: 't1', ...params } as ComponentNode);

describe('tube-fin collision geometry (issue 2026-08-05e)', () => {
  it('auto radius: 6 tubes around a body exactly touch at the body radius', () => {
    // sin(π/6) = 0.5 ⇒ r = R·0.5/0.5 = R — the classic 6-tube-fin identity.
    expect(tubeFinRadius(set({ finCount: 6 }), 0.049)).toBeCloseTo(0.049, 12);
  });

  it('auto radius falls back to the body radius below 3 fins (no ÷0 at n=2)', () => {
    expect(tubeFinRadius(set({ finCount: 2 }), 0.03)).toBe(0.03);
    expect(tubeFinRadius(set({ finCount: 1 }), 0.03)).toBe(0.03);
  });

  it('explicit outerRadius wins over the auto rule', () => {
    expect(tubeFinRadius(set({ finCount: 6, outerRadius: 0.02 }), 0.049)).toBe(0.02);
  });

  it('touching radius is the ceiling for the explicit field', () => {
    expect(tubeFinMaxRadius(6, 0.049)).toBeCloseTo(0.049, 12);
    const r4 = tubeFinMaxRadius(4, 0.049)!;
    // 4 tubes: r = R·sin45°/(1−sin45°) ≈ 2.414·R
    expect(r4).toBeCloseTo((0.049 * Math.SQRT1_2) / (1 - Math.SQRT1_2), 9);
    expect(tubeFinMaxRadius(2, 0.049)).toBeNull();
  });

  it('max count inverts the touching rule', () => {
    // Tubes at exactly the body radius: 6 fit (touching), 7 collide.
    expect(tubeFinMaxCount(0.049, 0.049)).toBe(6);
    expect(tubeFinMaxCount(0.02, 0.049)).toBe(10);
    // Degenerate inputs never block editing below 2.
    expect(tubeFinMaxCount(0, 0.049)).toBe(2);
  });
});
