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

/**
 * The page has to be wide enough to hold the RULER (services-rest-2).
 *
 * `w` came from the fin geometry alone, and the outermost <svg> clips to its
 * viewport silently: a 30 mm root chord gave a 60 mm page, so the 50 mm
 * calibration ruler drawn from x=15 to x=65 measured 45 mm on paper — under a
 * line telling the builder it must measure exactly 50.
 */
describe('finTemplateSvg — the calibration ruler is never off the page', () => {
  const pageWidth = (svg: string): number =>
    Number(/width="([\d.]+)mm"/.exec(svg)![1]);
  /** Right-hand extent of every <text> and <line> the label block emits. */
  const rightmost = (svg: string): number => {
    let max = 0;
    for (const m of svg.matchAll(/<line [^>]*x2="([\d.]+)"/g)) max = Math.max(max, Number(m[1]));
    for (const m of svg.matchAll(/<text x="([\d.]+)"[^>]*>([^<]*)</g)) {
      // Same 0.55 em estimate the module sizes the page with.
      max = Math.max(max, Number(m[1]) + m[2]!.length * 3.2 * 0.55);
    }
    return max;
  };

  const small: ComponentNode = {
    type: 'trapezoidfinset', name: 'F', finCount: 3,
    rootChord: 0.03, tipChord: 0.015, sweep: 0.01, height: 0.02,
  } as ComponentNode;

  it('holds the ruler and its caption on a fin far narrower than 50 mm', () => {
    const svg = finTemplateSvg(small, 'X');
    // The fin is 30 mm; the old page was 60 mm and the ruler ended at 65.
    expect(pageWidth(svg)).toBeGreaterThan(65);
    expect(svg).toContain('x2="65"');          // the ruler's right end
    expect(svg).toContain('x="67"');           // the "50 mm" caption
    expect(rightmost(svg)).toBeLessThanOrEqual(pageWidth(svg));
  });

  it('holds the dimensions line too — it is the widest thing on the sheet', () => {
    // 91 characters ≈ 160 mm, against the 110 mm page an 80 mm root produced.
    const svg = finTemplateSvg({
      type: 'trapezoidfinset', name: 'Main fins', finCount: 4,
      rootChord: 0.08, tipChord: 0.04, sweep: 0.03, height: 0.05, thickness: 0.003,
      crossSection: 'airfoil', tabHeight: 0.01, tabLength: 0.04, tabOffsetMethod: 'middle',
    } as ComponentNode, 'WM Goblin');
    expect(svg).toContain('root 80.0 mm · height 50.0 mm · thickness 3.0 mm · airfoil cross-section · tab 10.0 mm deep');
    expect(pageWidth(svg)).toBeGreaterThan(160);
    expect(rightmost(svg)).toBeLessThanOrEqual(pageWidth(svg));
  });

  it('still sizes to the FIN when the fin is the wider thing', () => {
    const big = finTemplateSvg({
      type: 'trapezoidfinset', name: 'F', finCount: 3,
      rootChord: 0.4, tipChord: 0.2, sweep: 0.1, height: 0.15,
    } as ComponentNode, 'X');
    // 400 mm root + two 15 mm margins, unchanged by the label block.
    expect(pageWidth(big)).toBeCloseTo(430, 1);
  });

  it('keeps the viewBox and the physical size the same number', () => {
    const svg = finTemplateSvg(small, 'X');
    const w = pageWidth(svg);
    expect(svg).toContain(`viewBox="0 0 ${w.toFixed(1)} `);
  });
});
