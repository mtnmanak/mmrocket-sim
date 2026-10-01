import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { finRootChord, finTabFront, finTabSpan } from './finTab.js';

const fin = (params: Record<string, unknown>): ComponentNode =>
  ({ type: 'trapezoidfinset', ...params } as unknown as ComponentNode);

describe('finTabFront — AxialMethod.getAsPosition for the tab', () => {
  it('top: the offset from the leading edge', () => {
    expect(finTabFront(fin({ tabLength: 0.02, tabOffset: 0.005, tabOffsetMethod: 'top' }), 0.1)).toBeCloseTo(0.005, 12);
  });

  it('middle (the kernel default): centred, then offset', () => {
    expect(finTabFront(fin({ tabLength: 0.06 }), 0.1)).toBeCloseTo(0.02, 12);
    expect(finTabFront(fin({ tabLength: 0.06, tabOffset: 0.01, tabOffsetMethod: 'middle' }), 0.1)).toBeCloseTo(0.03, 12);
  });

  it('bottom: flush with the trailing edge, then offset', () => {
    expect(finTabFront(fin({ tabLength: 0.02, tabOffset: -0.005, tabOffsetMethod: 'bottom' }), 0.1)).toBeCloseTo(0.075, 12);
  });

  it('reads a NaN field as absent, like every other geometry reader (nodeNum.num)', () => {
    expect(finTabFront(fin({ tabLength: 0.02, tabOffset: Number.NaN, tabOffsetMethod: 'top' }), 0.1)).toBe(0);
  });
});

/**
 * tree/ is the geometry layer the exporters are built on, and it must not
 * reach UP into React components (audit 2026-09-22): solidMesh.ts imported
 * finTabFront from components/TreeSchematic.tsx, which put React and the
 * whole schematic under every STL and DXF export and blocked moving the
 * exporters to a worker or a script.
 */
describe('tree/ imports no React component', () => {
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const modules = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f));

  it('found the modules at all — an empty listing would pass vacuously', () => {
    expect(modules).toContain('solidMesh.ts');
    expect(modules.length).toBeGreaterThan(10);
  });

  it('none of them imports from ../components', () => {
    const offenders = modules.filter((f) =>
      /from\s+['"]\.\.\/components\//.test(readFileSync(`${dir}/${f}`, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

describe('finRootChord — the chord, never the drawn extent', () => {
  it('trapezoid: rootChord, even when sweep + tip overhangs it', () => {
    expect(finRootChord(fin({ rootChord: 0.1, tipChord: 0.05, sweep: 0.08 }))).toBe(0.1);
  });

  it('freeform: the LAST point x, not the max x (FreeformFinSet.java:494)', () => {
    const ff = { type: 'freeformfinset', points: [[0, 0], [0.02, 0.03], [0.05, 0.03], [0.01, 0]] } as unknown as ComponentNode;
    expect(finRootChord(ff)).toBe(0.01);
  });

  it('freeform: a closing point that repeats the first is dropped first', () => {
    const ff = { type: 'freeformfinset', points: [[0, 0], [0.01, 0.03], [0.05, 0.02], [0.05, 0], [0, 0]] } as unknown as ComponentNode;
    expect(finRootChord(ff)).toBe(0.05);
  });
});

describe('finTabSpan — the tab as it is cut', () => {
  it('clamps into [0, root] and drops a tab with nothing left', () => {
    const t = (tabOffset: number, tabOffsetMethod: string) =>
      finTabSpan(fin({ tabHeight: 0.008, tabLength: 0.02, tabOffset, tabOffsetMethod }), 0.05, undefined);
    expect(t(-0.01, 'top')).toEqual({ x0: 0, x1: expect.closeTo(0.01, 12), depth: 0.008 });
    expect(t(0.02, 'middle')).toEqual({ x0: expect.closeTo(0.035, 12), x1: 0.05, depth: 0.008 });
    expect(t(0.2, 'top')).toBeNull();
  });

  it('is null with no tab height, no tab length or no root', () => {
    expect(finTabSpan(fin({ tabLength: 0.02 }), 0.05, undefined)).toBeNull();
    expect(finTabSpan(fin({ tabHeight: 0.01 }), 0.05, undefined)).toBeNull();
    expect(finTabSpan(fin({ tabHeight: 0.01, tabLength: 0.02 }), 0, undefined)).toBeNull();
  });

  /**
   * The kernel clamps the depth to the body's radius at the tab
   * (`FinSet.setTabHeight` → `getMaxTabHeight`), and the side view clamps its
   * drawn tab the same way. The cut outputs read the raw depth (audit
   * 2026-09-30), so a tab deeper than the body — the UI allows 50 mm, and a
   * `.rkt` on a minimum-diameter airframe brings one — printed, cut and
   * templated past the airframe's centreline.
   */
  it('clamps the depth to the body radius at the tab, as the kernel does', () => {
    const deep = fin({ tabHeight: 0.05, tabLength: 0.02 });
    expect(finTabSpan(deep, 0.05, 0.0195))
      .toEqual({ x0: expect.closeTo(0.015, 12), x1: expect.closeTo(0.035, 12), depth: 0.0195 });
    // A tab shallower than the body is untouched…
    expect(finTabSpan(fin({ tabHeight: 0.008, tabLength: 0.02 }), 0.05, 0.0195)!.depth).toBe(0.008);
    // …a body with no radius at the tab leaves no tab, as the kernel's 0 clamp
    // does, and with no radius to clamp to the tab is as stated.
    expect(finTabSpan(deep, 0.05, 0)).toBeNull();
    expect(finTabSpan(deep, 0.05, undefined)!.depth).toBe(0.05);
  });
});
