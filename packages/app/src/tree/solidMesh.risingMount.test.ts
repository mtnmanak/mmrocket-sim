// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { componentSolid, finPrintShape, isWatertight, solidVolume } from './solidMesh.js';
import { solidContextFor } from './solidContext.js';
import { componentDxf } from '../services/dxfExport.js';
import { finTemplateSvg } from '../services/finTemplate.js';
import { solidToStl } from '../services/stlExport.js';

type Point = [number, number];

// Read the actual DXF polylines, preserving contour boundaries and mm units.
function cutLoops(text: string): Point[][] {
  const lines = text.trim().split(/\r?\n/);
  const loops: Point[][] = [];
  let loop: Point[] | undefined;
  let point: Point | undefined;
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i]);
    const value = lines[i + 1]!;
    if (code === 0) {
      if (value === 'POLYLINE') { loop = []; loops.push(loop); }
      point = value === 'VERTEX' ? [NaN, NaN] : undefined;
      if (point) loop!.push(point);
    } else if (point && code === 10) point[0] = Number(value);
    else if (point && code === 20) point[1] = Number(value);
  }
  return loops;
}

// Check all nonadjacent closed edges, including collinear overlap and touching.
function expectSimple(loop: Point[]) {
  const cross = (a: Point, b: Point, p: Point) =>
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const on = (a: Point, b: Point, p: Point) => Math.abs(cross(a, b, p)) < 1e-8
    && p[0] >= Math.min(a[0], b[0]) - 1e-8 && p[0] <= Math.max(a[0], b[0]) + 1e-8
    && p[1] >= Math.min(a[1], b[1]) - 1e-8 && p[1] <= Math.max(a[1], b[1]) + 1e-8;
  expect(loop.length).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!, b = loop[(i + 1) % loop.length]!;
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeGreaterThan(1e-8);
    for (let j = i + 2; j < loop.length; j++) {
      if (i === 0 && j === loop.length - 1) continue;
      const c = loop[j]!, d = loop[(j + 1) % loop.length]!;
      const crossing = cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
      expect(crossing || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b),
        `edges ${i} and ${j} cross/touch`).toBe(false);
    }
  }
}

const cases = [
  { name: 'no tab', tab: {}, loops: 1 },
  { name: 'tab inside lobe', tab: { tabLength: 0.025, tabOffset: 0.01 }, loops: 1 },
  { name: 'tab past lobe', tab: { tabLength: 0.04, tabOffset: 0.035 }, loops: 1 },
  { name: 'separate tab', tab: { tabLength: 0.01, tabOffset: 0.065 }, loops: 2 },
  { name: 'two lobes', tab: {}, loops: 2, multiple: true },
  { name: 'tab joining lobes', tab: { tabLength: 0.04, tabOffset: 0.02 }, loops: 1, multiple: true },
];

for (const shape of ['conical', 'ogive']) {
  // N062: a square section is the flat prism, whose volume is exact; a rounded
  // or airfoil one prints its cross-section (shaped below), except where a
  // horizontal line crosses the outline more than twice — the two-lobe M — which
  // keeps the flat prism and says so.
  for (const crossSection of ['square', 'rounded', 'airfoil']) {
    for (const scenario of cases) {
      const fin: ComponentNode = { id: 'f', type: 'freeformfinset', crossSection, thickness: 0.003,
        points: scenario.multiple
          ? [[0, 0], [0.015, 0.03], [0.03, 0.001], [0.05, 0.03], [0.06, 0.004], [0.075, 0]]
          : [[0, 0], [0.02, 0.03], [0.06, 0.004], [0.075, 0]],
        position: { method: 'top', offset: 0 }, tabHeight: 0.005, tabOffsetMethod: 'top', ...scenario.tab };
      const tree: RocketTree = { components: [{ id: 'mount', type: 'transition', shape,
        length: 0.08, foreRadius: 0.0125, aftRadius: 0.025, children: [fin] }] };
      const ctx = solidContextFor(tree, fin);
      const name = `S4b-1 rising ${shape}/${crossSection}, ${scenario.name}`;

      it(`${name}: prints a watertight positive-volume STL`, async () => {
        const solid = await componentSolid(fin, ctx);
        expect(solid).not.toBeNull();
        expect(isWatertight(solid!.mesh)).toBe(true);
        expect(solidVolume(solid!.mesh)).toBeGreaterThan(0);
        const flat = crossSection === 'square' || scenario.multiple === true;
        expect(finPrintShape(fin, ctx)).toEqual(crossSection === 'square' ? { kind: 'flat' }
          : scenario.multiple ? { kind: 'fallback', law: crossSection === 'rounded' ? 'rounded' : 'naca', reason: 'chords' }
            : { kind: 'shaped', law: crossSection === 'rounded' ? 'rounded' : 'naca', minEdge: 0.0004,
              tab: 'tabLength' in scenario.tab });
        if (shape === 'conical') {
          // Shoelace areas of the seated triangles, plus the tab's trapezoid
          // below a root rising 12.5 mm over 80 mm. No lobe may disappear.
          const lobeArea = scenario.multiple ? 0.00074765625 : 0.00080625;
          const tabLength = scenario.tab.tabLength ?? 0;
          const tabArea = tabLength * 0.005 + (0.0125 / 0.08) * tabLength ** 2 / 2;
          if (flat) {
            expect(Math.abs(solidVolume(solid!.mesh) - (lobeArea + tabArea) * 0.003)).toBeLessThan(1e-15);
          } else {
            // Shaped: thinner than the stock everywhere on the lobe, never below
            // the 0.4 mm printable edge, and the tab still full stock.
            expect(solidVolume(solid!.mesh)).toBeLessThan((lobeArea + tabArea) * 0.003);
            expect(solidVolume(solid!.mesh)).toBeGreaterThan(lobeArea * 0.0004 + tabArea * 0.003);
          }
        }
        if (!flat) {
          const square = await componentSolid({ ...fin, crossSection: 'square' }, ctx);
          expect(solidVolume(solid!.mesh)).toBeLessThan(solidVolume(square!.mesh));
        }
        const stl = solidToStl(solid!.mesh, 'rising mount');
        expect(new DataView(stl.buffer).getUint32(80, true)).toBe(solid!.mesh.triangles.length / 3);
      });

      it(`${name}: cuts simple DXF contours and templates every lobe`, () => {
        const dxf = componentDxf(fin, ctx, 'rising mount');
        expect(dxf).not.toBeNull();
        const loops = cutLoops(dxf!.text);
        loops.forEach(expectSimple);
        expect(loops).toHaveLength(scenario.loops);
        for (const tip of scenario.multiple ? [[15, 30], [50, 30]] : [[20, 30]]) {
          expect(loops.flat()).toContainEqual(tip);
        }
        if ('tabLength' in scenario.tab) {
          const x0 = scenario.tab.tabOffset!, x1 = x0 + scenario.tab.tabLength!;
          const floor = (Math.min(ctx.finMount!.radiusAt(x0), ctx.finMount!.radiusAt(x1)) - 0.0125 - 0.005) * 1000;
          for (const x of [x0 * 1000, x1 * 1000]) {
            // The DXF stores mm to four decimals; compare those exact coordinates.
            expect(loops.flat()).toContainEqual([Number(x.toFixed(4)), Number(floor.toFixed(4))]);
          }
        } else {
          // The clamped aft run 60-75 mm has no area and must not be cut.
          expect(Math.max(...loops.flat().map(p => p[0]))).toBeCloseTo(60, 6);
        }
        const svg = new DOMParser().parseFromString(finTemplateSvg(fin, 'rising mount', ctx), 'image/svg+xml');
        const subpaths = [...svg.querySelectorAll('path')].flatMap(p => p.getAttribute('d')!.match(/M/g) ?? []);
        expect(subpaths).toHaveLength(scenario.loops);
      });
    }
  }
}
