// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { solidContextFor } from './solidContext.js';
import { componentSolid, finCutOutline, isWatertight, solidVolume } from './solidMesh.js';
import { componentDxf } from '../services/dxfExport.js';
import { finTemplateSvg } from '../services/finTemplate.js';

it.each(['rounded', 'airfoil'])('S4b-1 cuts and prints a seated %s boat-tail fin with its tab', async (crossSection) => {
  const fin: ComponentNode = { id: 'f', type: 'freeformfinset', crossSection,
    points: [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, 0]], thickness: 0.003,
    position: { method: 'top', offset: 0 }, tabLength: 0.04, tabHeight: 0.005 };
  const tree: RocketTree = { components: [{ id: 'tail', type: 'transition', shape: 'conical',
    length: 0.1, foreRadius: 0.027, aftRadius: 0.019, children: [fin] }] };
  const ctx = solidContextFor(tree, fin);
  const outline = finCutOutline(fin, ctx)!;
  const contains = (x: number, y: number) => outline.some(p => Math.abs(p[0] - x) < 1e-10 && Math.abs(p[1] - y) < 1e-10);
  expect(contains(0.1, -0.008)).toBe(true);
  // FinSet.getTabPoints: a flat tab floor under the smaller endpoint radius.
  expect(contains(0.07, -0.0106)).toBe(true);
  expect(contains(0.03, -0.0106)).toBe(true);
  const solid = await componentSolid(fin, ctx);
  expect(solid).not.toBeNull();
  expect(isWatertight(solid!.mesh)).toBe(true);
  expect(solidVolume(solid!.mesh)).toBeGreaterThan(0);
  const dxf = componentDxf(fin, ctx, 'Audit')!;
  expect(dxf).not.toEqual(componentDxf(fin, {}, 'Audit'));
});

it('S4b-1 seated-root labels distinguish the taper from the tab and clear the paper contour', () => {
  const fin: ComponentNode = { id: 'f', type: 'freeformfinset',
    points: [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, 0]], thickness: 0.003,
    position: { method: 'top', offset: 0 }, tabLength: 0.04, tabHeight: 0.005 };
  const tree: RocketTree = { components: [{ id: 'tail', type: 'transition', shape: 'conical',
    length: 0.1, foreRadius: 0.027, aftRadius: 0.019, children: [fin] }] };
  const ctx = solidContextFor(tree, fin);
  const dxf = componentDxf(fin, ctx, 'Audit')!.text;
  expect(dxf).toContain('root 100.0 mm');
  expect(dxf).toContain('TTW tab 5.0 mm deep x 40.0 mm long at x 30.0-70.0 mm');
  const svg = new DOMParser().parseFromString(finTemplateSvg(fin, 'Audit', ctx), 'image/svg+xml');
  expect(svg.documentElement.textContent).toContain('tab 5.0 mm deep');
  // 15 mm margin + 40 mm tip height + 10.6 mm drop below the root origin.
  expect(Number(svg.querySelector('text')!.getAttribute('y'))).toBeGreaterThan(65.6);
});

it('S4b-1 a plain body tube preserves the flat cut outline', () => {
  const fin: ComponentNode = { id: 'f', type: 'freeformfinset',
    points: [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, 0]],
    tabLength: 0.04, tabHeight: 0.005 };
  const tree: RocketTree = { components: [{ type: 'bodytube', id: 'b', length: 0.3,
    outerRadius: 0.027, children: [fin] }] };
  expect(finCutOutline(fin, solidContextFor(tree, fin))).toEqual(finCutOutline(fin));
});

it('S4b-1 resolves a nonzero leading-edge station and the mount end under an overhanging root', () => {
  const fin: ComponentNode = { id: 'f', type: 'freeformfinset',
    points: [[0, 0], [0.02, 0.04], [0.07, 0.04], [0.1, 0]],
    position: { method: 'top', offset: 0.025 } };
  const tree: RocketTree = { components: [{ id: 'tail', type: 'transition', shape: 'conical',
    length: 0.1, foreRadius: 0.027, aftRadius: 0.019, children: [fin] }] };
  const outline = finCutOutline(fin, solidContextFor(tree, fin))!;
  expect(outline).toContainEqual([0.1, expect.closeTo(-0.006, 12)]);
  expect(outline).toContainEqual([expect.closeTo(0.075, 12), expect.closeTo(-0.006, 12)]);
});
