import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { finOutline, finTemplateSvg, tabOutline } from './finTemplate.js';

describe('fin outlines', () => {
  it('trapezoid: root at y=0, tip offset by sweep', () => {
    const pts = finOutline({
      type: 'trapezoidfinset', rootChord: 0.08, tipChord: 0.04, sweep: 0.03, height: 0.05,
    } as ComponentNode);
    expect(pts).toEqual([
      { x: 0, y: 0 }, { x: 0.03, y: 0.05 }, { x: 0.07, y: 0.05 }, { x: 0.08, y: 0 },
    ]);
  });

  it('elliptical: half-ellipse spanning the root chord', () => {
    const pts = finOutline({ type: 'ellipticalfinset', rootChord: 0.06, height: 0.04 } as ComponentNode);
    expect(pts[0]!.x).toBeCloseTo(0, 9);
    expect(pts[pts.length - 1]!.x).toBeCloseTo(0.06, 9);
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(0.04, 6);
  });

  it('freeform: passes the editor points through', () => {
    const pts = finOutline({
      type: 'freeformfinset', points: [[0, 0], [0.02, 0.03], [0.05, 0.03], [0.06, 0]],
    } as ComponentNode);
    expect(pts.length).toBe(4);
    expect(pts[2]).toEqual({ x: 0.05, y: 0.03 });
  });
});

describe('tab outline', () => {
  it('places a middle-referenced tab centered on the root', () => {
    const tab = tabOutline({
      type: 'trapezoidfinset', tabHeight: 0.01, tabLength: 0.04, tabOffset: 0,
      tabOffsetMethod: 'middle',
    } as ComponentNode, 0.08)!;
    expect(tab.x0).toBeCloseTo(0.02, 9);
    expect(tab.x1).toBeCloseTo(0.06, 9);
    expect(tab.depth).toBeCloseTo(0.01, 9);
  });

  it('returns null when there is no tab', () => {
    expect(tabOutline({ type: 'trapezoidfinset' } as ComponentNode, 0.08)).toBeNull();
  });
});

describe('finTemplateSvg', () => {
  const fin: ComponentNode = {
    type: 'trapezoidfinset', name: 'Main fins', finCount: 4,
    rootChord: 0.08, tipChord: 0.04, sweep: 0.03, height: 0.05, thickness: 0.003,
    crossSection: 'airfoil', tabHeight: 0.01, tabLength: 0.04, tabOffsetMethod: 'middle',
  } as ComponentNode;

  it('emits physical millimeter units for 1:1 printing', () => {
    const svg = finTemplateSvg(fin, 'WM Goblin');
    expect(svg).toMatch(/width="[\d.]+mm" height="[\d.]+mm"/);
    expect(svg).toContain('PRINT AT 100% SCALE');
    expect(svg).toContain('50 mm');
  });

  it('includes the outline, the tab, and the label block', () => {
    const svg = finTemplateSvg(fin, 'WM Goblin');
    expect(svg).toContain('WM Goblin — Main fins (cut 4)');
    expect(svg).toContain('root 80.0 mm · height 50.0 mm · thickness 3.0 mm · airfoil cross-section · tab 10.0 mm deep');
    // Cut layer: outline path + tab path inside the hairline group.
    expect((svg.match(/<path /g) ?? []).length).toBe(2);
  });

  it('rejects non-fin components', () => {
    expect(() => finTemplateSvg({ type: 'bodytube' } as ComponentNode, 'X')).toThrow(/Not a fin set/);
  });
});
