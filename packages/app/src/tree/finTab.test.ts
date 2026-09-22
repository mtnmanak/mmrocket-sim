import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { finTabFront } from './finTab.js';

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
