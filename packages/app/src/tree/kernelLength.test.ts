import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { axialLength, startFromPosition } from './position.js';
import { inKernelFrame, kernelLength } from './kernelLength.js';

/**
 * A rail button's axial length used to be THREE different numbers in one app:
 * the drawings resolved its station with the outer diameter (9.7 mm by
 * default), the drag/slider/auto-place math with `axialLength`'s 25 mm
 * `packedLength` fallback, and the kernel with 0. These pin the one answer.
 */
describe('kernelLength', () => {
  const button = (extra: Record<string, unknown> = {}) =>
    ({ id: 'rb', type: 'railbutton', outerDiameter: 0.0097, ...extra } as unknown as ComponentNode);

  it('is ZERO for a rail button, whatever it carries', () => {
    expect(kernelLength(button())).toBe(0);
    // Even a button that somehow acquired a length key: the kernel's
    // RocketComponent.length is 0 and RailButton never assigns it.
    expect(kernelLength(button({ length: 0.05, totalHeight: 0.01142 }))).toBe(0);
  });

  it('is the number axialLength answered before, which is what was wrong', () => {
    // The regression guard: if someone "simplifies" kernelLength back to
    // axialLength, this is the 25 mm that broke the auto-place button.
    expect(axialLength(button())).toBeCloseTo(0.025, 12);
  });

  it('delegates unchanged for every other type', () => {
    const lug = { type: 'launchlug', length: 0.04 } as unknown as ComponentNode;
    const tube = { type: 'bodytube', length: 0.3 } as unknown as ComponentNode;
    const ff = {
      type: 'freeformfinset', points: [[0, 0], [0.02, 0.03], [0.06, 0]],
    } as unknown as ComponentNode;
    for (const n of [lug, tube, ff]) expect(kernelLength(n)).toBe(axialLength(n));
    expect(kernelLength(ff)).toBeCloseTo(0.06, 12);
  });

  it('puts the station where the kernel puts it, for all three methods', () => {
    // Parent tube 300 mm long. The kernel resolves a zero-length component,
    // so 'bottom' offset 0 lands ON the aft end and 'middle' dead centre.
    const pLen = 0.3;
    const at = (method: string, offset: number) =>
      startFromPosition({ method, offset } as never, kernelLength(button()), pLen);
    expect(at('top', 0)).toBeCloseTo(0, 12);
    expect(at('middle', 0)).toBeCloseTo(0.15, 12);
    expect(at('bottom', 0)).toBeCloseTo(0.3, 12);
    // What the 25 mm frame said instead — 12.5 mm and 25 mm forward.
    const old = (method: string) =>
      startFromPosition({ method, offset: 0 } as never, axialLength(button()), pLen);
    expect(at('middle', 0) - old('middle')).toBeCloseTo(0.0125, 12);
    expect(at('bottom', 0) - old('bottom')).toBeCloseTo(0.025, 12);
  });
});

describe('inKernelFrame', () => {
  it('gives a rail button a literal length of 0 so axialLength agrees', () => {
    const rb = { id: 'rb', type: 'railbutton', outerDiameter: 0.0097 } as unknown as ComponentNode;
    expect(axialLength(inKernelFrame(rb))).toBe(0);
  });

  it('normalises rail-button CHILDREN, which is what anchorStarts reads', () => {
    const tube = {
      id: 'b1', type: 'bodytube', length: 0.3,
      children: [
        { id: 'rb', type: 'railbutton', outerDiameter: 0.0097 },
        { id: 'cr', type: 'centeringring', length: 0.003 },
      ],
    } as unknown as ComponentNode;
    const framed = inKernelFrame(tube);
    expect(axialLength(framed.children![0]!)).toBe(0);
    // Everything else is passed through untouched — same object, no copy.
    expect(framed.children![1]).toBe(tube.children![1]);
    expect(axialLength(framed)).toBeCloseTo(0.3, 12);
  });

  it('returns the SAME node when there is nothing to normalise', () => {
    const tube = {
      id: 'b1', type: 'bodytube', length: 0.3,
      children: [{ id: 'cr', type: 'centeringring', length: 0.003 }],
    } as unknown as ComponentNode;
    expect(inKernelFrame(tube)).toBe(tube);
  });
});
