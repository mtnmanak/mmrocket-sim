import { describe, expect, it } from 'vitest';
import { signedArea } from './polygon.js';

describe('signedArea — the one shoelace', () => {
  it('is positive counter-clockwise and negative clockwise, closing edge implied', () => {
    const ccw: [number, number][] = [[0, 0], [0.08, 0], [0.08, 0.02], [0, 0.02]];
    expect(signedArea(ccw)).toBeCloseTo(0.0016, 15);
    expect(signedArea([...ccw].reverse())).toBeCloseTo(-0.0016, 15);
  });

  it('is exact for a concave outline', () => {
    // A 2 x 2 square with a 1 x 1 notch out of one corner: area 3.
    expect(signedArea([[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]])).toBe(3);
  });

  it('reads a crossed outline as zero, which is why a caller wanting an AREA must check first', () => {
    // The two lobes of a bow-tie wind opposite ways and cancel.
    expect(signedArea([[0, 0], [0.08, 0.02], [0, 0.02], [0.08, 0]])).toBeCloseTo(0, 15);
  });

  it('is zero below three points', () => {
    expect(signedArea([])).toBe(0);
    expect(signedArea([[1, 2], [3, 4]])).toBe(0);
  });
});
