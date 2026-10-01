import { describe, expect, it } from 'vitest';
import { enclosesArea, signedArea } from './polygon.js';

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

describe('enclosesArea', () => {
  it('is false for an outline flat along its root — a fin at height 0', () => {
    expect(enclosesArea([[0, 0], [0.02, 0], [0.05, 0], [0.06, 0]])).toBe(false);
  });

  it('is false for points on a slanted line, where the shoelace rounds to a crumb', () => {
    const line: [number, number][] = [0, 1, 2, 3, 4].map((i) => [0.013 * i, 0.0071 * i]);
    expect(enclosesArea(line)).toBe(false);
  });

  it('is true for a real planform, including one with a corner on a straight edge', () => {
    expect(enclosesArea([[0, 0], [0.02, 0.03], [0.05, 0.03], [0.06, 0]])).toBe(true);
    expect(enclosesArea([[0, 0], [0.01, 0.02], [0.02, 0.04], [0.05, 0.04], [0.06, 0]])).toBe(true);
  });

  it('is false below three points', () => {
    expect(enclosesArea([[0, 0], [1, 1]])).toBe(false);
  });
});
