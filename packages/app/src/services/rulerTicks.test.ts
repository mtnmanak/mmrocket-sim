import { describe, expect, it } from 'vitest';
import { formatTickLabel, rulerLayout, rulerTicks } from './rulerTicks.js';

/**
 * The tick ladder is a port of desktop OpenRocket's
 * `GeneralUnit.getTicks(start, end, minor, major)` (24.12). The expectations
 * below were worked through against that Java source, not against this
 * implementation's output — the point of the port is that a ruler here lands
 * its ticks where the desktop lands them.
 */

const labelled = (t: { value: number; major: boolean }[]) => t.filter((x) => x.major).map((x) => x.value);
const bold = (t: { value: number; notable: boolean; major: boolean }[]) =>
  t.filter((x) => x.major && x.notable).map((x) => x.value);

describe('rulerTicks', () => {
  it('picks a 0.05 minor / 0.5 major ladder for a 0–10 span at 3 px / 30 px', () => {
    // minor 0.03 -> smallest round-ten above it is 0.1, and 0.05 >= 0.03,
    // so the minor step is 0.05. major 0.3 -> round-ten 1, and 0.5 >= 0.3,
    // so labels every 0.5 with every 1.0 bold.
    const t = rulerTicks(0, 10, 0.03, 0.3);
    expect(t[0]).toEqual({ value: 0, major: true, notable: true });
    expect(t[1]!.value).toBeCloseTo(0.05, 12);
    expect(labelled(t).slice(0, 5).map((v) => Number(v.toFixed(6))))
      .toEqual([0, 0.5, 1, 1.5, 2]);
    expect(bold(t).slice(0, 4).map((v) => Number(v.toFixed(6)))).toEqual([0, 1, 2, 3]);
    // Every second minor tick is notable, none of them labelled.
    expect(t.filter((x) => x.notable && !x.major).length).toBeGreaterThan(0);
  });

  it('demotes minor-notable when it would land on every major tick', () => {
    // minstep 0.05 (mod2 = 2) and mod3 = 2 collide: the desktop drops mod2 to
    // 1 so every UNLABELLED tick is notable rather than have the two grades
    // pick out the same positions. (A labelled tick that is not on the mod4
    // ladder still reports notable=false — that flag only bolds its font.)
    const t = rulerTicks(0, 1, 0.04, 0.06);
    expect(t.filter((x) => !x.major).every((x) => x.notable)).toBe(true);
    expect(labelled(t).map((v) => Number(v.toFixed(6))))
      .toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });

  it('spans zero symmetrically for the vertical ruler', () => {
    const t = rulerTicks(-0.05, 0.05, 0.003, 0.03);
    expect(labelled(t).map((v) => Number(v.toFixed(6)))).toEqual([-0.05, 0, 0.05]);
    expect(bold(t).map((v) => Number(v.toFixed(6)))).toEqual([0]);
    // Negative indices must still resolve their grade — JS % keeps the sign
    // exactly as Java's does, which is what makes the port work.
    expect(t[0]!.value).toBeCloseTo(-0.05, 12);
    expect(t[t.length - 1]!.value).toBeCloseTo(0.05, 12);
  });

  it('starts at the first round step inside the range, not at `start`', () => {
    const t = rulerTicks(0.137, 0.4, 0.03, 0.3);
    expect(t[0]!.value).toBeCloseTo(0.15, 12);
  });

  it('computes each value from its integer index so labels stay round', () => {
    const t = rulerTicks(0, 1, 0.06, 0.6);
    // minstep 0.1 here (0.05 < 0.06 so the round-five is too small).
    const third = t[3]!;
    expect(formatTickLabel(third.value)).toBe('0.3');
  });

  it('returns nothing for degenerate ranges and steps', () => {
    expect(rulerTicks(1, 1, 0.1, 1)).toEqual([]);
    expect(rulerTicks(2, 1, 0.1, 1)).toEqual([]);
    expect(rulerTicks(0, 1, 0, 1)).toEqual([]);
    expect(rulerTicks(0, 1, 1, 0.1)).toEqual([]);
    expect(rulerTicks(NaN, 1, 0.1, 1)).toEqual([]);
    expect(rulerTicks(0, Infinity, 0.1, 1)).toEqual([]);
  });

  it('caps a runaway range instead of hanging the render', () => {
    // A container measured mid-layout can hand us a scale that makes the
    // visible span enormous; the desktop cannot hit this because its ruler is
    // clipped to a real canvas.
    const t = rulerTicks(0, 1e9, 1, 10);
    expect(t.length).toBe(4000);
  });
});

describe('rulerLayout', () => {
  // 100 px per display unit, model 0 at px 40 — e.g. a 1 cm/100 px zoom.
  it('places marks and labels along a forward axis', () => {
    const m = rulerLayout(40, 100, 40, 240, 18);
    expect(m[0]!.px).toBeCloseTo(40, 9);
    expect(m[0]!.label).toBe('0');
    expect(m[0]!.bold).toBe(true);
    // 3 px minimum -> 0.05 unit minor steps; 30 px minimum -> 0.5 unit labels.
    expect(m[1]!.px).toBeCloseTo(45, 9);
    const labels = m.filter((x) => x.label).map((x) => x.label);
    expect(labels).toEqual(['0', '0.5', '1', '1.5', '2']);
    // Tick length grades: major half the gutter, minor a sixth.
    expect(m[0]!.len).toBe(9);
    expect(m.find((x) => !x.label && x.len === 3)).toBeTruthy();
  });

  it('runs the other way when the axis is inverted (the vertical ruler)', () => {
    // +y is UP, SVG y grows down: pxPerUnit is negative and 0 sits mid-gutter.
    const m = rulerLayout(100, -1000, 40, 160, 26);
    const labels = m.filter((x) => x.label).map((x) => x.label);
    // Window spans -0.06..+0.06 units; labels land on the 0.05 ladder.
    expect(labels).toEqual(['-0.05', '0', '0.05']);
    // Marks come out in ascending model value, so DESCENDING px on this axis.
    expect(m[0]!.px).toBeGreaterThan(m[m.length - 1]!.px);
    const zero = m.find((x) => x.label === '0')!;
    expect(zero.px).toBeCloseTo(100, 9);
  });

  it('returns nothing for a degenerate transform', () => {
    expect(rulerLayout(0, 0, 0, 100, 18)).toEqual([]);
    expect(rulerLayout(0, 100, 100, 100, 18)).toEqual([]);
    expect(rulerLayout(NaN, 100, 0, 100, 18)).toEqual([]);
  });
});

describe('formatTickLabel', () => {
  it('strips float dust and trailing zeros', () => {
    expect(formatTickLabel(0.1 * 3)).toBe('0.3');
    expect(formatTickLabel(2.5)).toBe('2.5');
    expect(formatTickLabel(12)).toBe('12');
    expect(formatTickLabel(-0.05)).toBe('-0.05');
  });

  it('never prints a negative zero at the origin', () => {
    expect(formatTickLabel(-0)).toBe('0');
    expect(formatTickLabel(0)).toBe('0');
  });
});
