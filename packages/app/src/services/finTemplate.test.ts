import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { finCutOutline } from '../tree/solidMesh.js';
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

/**
 * THE ROOT CHORD IS THE ROOT CHORD, NOT THE WIDEST POINT (audit 2026-09-22).
 *
 * For a trapezoid the template took max-x over the outline, which is the TIP's
 * trailing corner whenever sweep + tip > root. Measured on root 100 / tip 50 /
 * sweep 80 mm: the caption read "root 130.0 mm" and a middle tab was drawn at
 * 35-95 mm, where the STL and the DXF (finCutOutline) cut it at 20-80 mm — a
 * builder cutting from the paper got a tab that does not seat. Every existing
 * test used sweep + tip < root, where the two readings agree.
 */
describe('finTemplateSvg — root chord and tab agree with the cut files', () => {
  const swept: ComponentNode = {
    type: 'trapezoidfinset', name: 'Swept', finCount: 3,
    rootChord: 0.1, tipChord: 0.05, sweep: 0.08, height: 0.05, thickness: 0.003,
    tabHeight: 0.01, tabLength: 0.06, tabOffset: 0, tabOffsetMethod: 'middle',
  } as ComponentNode;
  /** The tab path's two x's in page units (the second path in the cut group). */
  const tabXs = (svg: string): [number, number] | null => {
    const d = [...svg.matchAll(/<path d="([^"]+)"\/>/g)].map((m) => m[1]!);
    if (d.length < 2) return null;
    const xs = [...d[1]!.matchAll(/[ML] ([\d.-]+) /g)].map((m) => Number(m[1]));
    return [Math.min(...xs), Math.max(...xs)];
  };
  /** Page x of a physical x in mm: M (15) plus the outline's own left edge. */
  const pageX = (mm: number, minXmm = 0) => mm - minXmm + 15;
  /** The tab corners the STL/DXF contour actually cuts, in mm. */
  const cutTab = (node: ComponentNode): [number, number] => {
    const below = finCutOutline(node)!.filter((p) => p[1] < 0).map((p) => p[0] * 1000);
    return [Math.min(...below), Math.max(...below)];
  };

  it('captions the 100 mm root as 100.0, not the 130 mm tip overhang', () => {
    const svg = finTemplateSvg(swept, 'X');
    expect(svg).toContain('root 100.0 mm');
    expect(svg).not.toContain('root 130.0 mm');
  });

  it('draws the middle tab at 20-80 mm — the station the STL and DXF cut it at', () => {
    const svg = finTemplateSvg(swept, 'X');
    const [a, b] = cutTab(swept);
    expect(a).toBeCloseTo(20, 9);
    expect(b).toBeCloseTo(80, 9);
    const [x0, x1] = tabXs(svg)!;
    expect(x0).toBeCloseTo(pageX(20), 3);
    expect(x1).toBeCloseTo(pageX(80), 3);
    // ...and the dashed root reference line stops at the root, not the tip.
    expect(svg).toContain(`x2="${pageX(100).toFixed(3)}"`);
  });

  it('reads a closed freeform point list the way finCutOutline does', () => {
    // Last point repeats the first: the root chord is the point BEFORE it
    // (50 mm), not 0 — finCutOutline trims the duplicate, and so must this.
    const closed = {
      type: 'freeformfinset', name: 'FF',
      points: [[0, 0], [0.01, 0.03], [0.05, 0.02], [0.05, 0], [0, 0]],
      tabHeight: 0.005, tabLength: 0.02, tabOffset: 0, tabOffsetMethod: 'middle',
    } as unknown as ComponentNode;
    const svg = finTemplateSvg(closed, 'X');
    expect(svg).toContain('root 50.0 mm');
    const [x0, x1] = tabXs(svg)!;
    const [a, b] = cutTab(closed);
    expect([a, b]).toEqual([expect.closeTo(15, 9), expect.closeTo(35, 9)]);
    expect(x0).toBeCloseTo(pageX(a), 3);
    expect(x1).toBeCloseTo(pageX(b), 3);
  });
});

/**
 * The paper tab is CLAMPED into the root chord exactly as the STL and DXF
 * clamp it (audit 2026-09-22). It used to be drawn unclamped, so a tab hanging
 * off the leading edge printed longer than the part the cut files make.
 */
describe('tab outline — clamped into the root like the cut files', () => {
  const base = {
    type: 'trapezoidfinset', rootChord: 0.05, tipChord: 0.02, sweep: 0.01, height: 0.04,
    tabHeight: 0.008, tabLength: 0.02,
  };

  it('a tab hanging off the leading edge is cut at the leading edge', () => {
    const node = { ...base, tabOffset: -0.01, tabOffsetMethod: 'top' } as unknown as ComponentNode;
    const tab = tabOutline(node, 0.05)!;
    expect(tab.x0).toBe(0);
    expect(tab.x1).toBeCloseTo(0.01, 12);
    const below = finCutOutline(node)!.filter((p) => p[1] < 0).map((p) => p[0]);
    expect(Math.min(...below)).toBeCloseTo(tab.x0, 12);
    expect(Math.max(...below)).toBeCloseTo(tab.x1, 12);
  });

  it('a tab hanging off the trailing edge is cut at the trailing edge', () => {
    const tab = tabOutline({ ...base, tabOffset: 0.02, tabOffsetMethod: 'middle' } as unknown as ComponentNode, 0.05)!;
    expect(tab.x0).toBeCloseTo(0.035, 12);
    expect(tab.x1).toBeCloseTo(0.05, 12);
  });

  it('a tab pushed entirely off the root is not drawn at all — the cut files drop it too', () => {
    const node = { ...base, tabOffset: 0.2, tabOffsetMethod: 'top' } as unknown as ComponentNode;
    expect(tabOutline(node, 0.05)).toBeNull();
    const svg = finTemplateSvg(node, 'X');
    expect((svg.match(/<path /g) ?? []).length).toBe(1);
    expect(svg).not.toContain('tab ');
  });
});
