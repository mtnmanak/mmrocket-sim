import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { DOMParser } from '@xmldom/xmldom';
import { tubeWrapGeometry, tubeWrapPages } from './tubeWrapGuide.js';

const node = (type: string, props: Record<string, unknown> = {}): ComponentNode =>
  ({ id: type, type, ...props }) as ComponentNode;
const fin = (props: Record<string, unknown> = {}) => node('trapezoidfinset', {
  name: 'Fins', finCount: 3, rootChord: 0.1, thickness: 0.003,
  tabLength: 0.06, tabHeight: 0.015, position: { method: 'bottom', offset: -0.02 }, ...props,
});
const fixture = (children: ComponentNode[], props: Record<string, unknown> = {}) => {
  const tube = node('bodytube', { name: 'Tube', outerRadius: 0.025, length: 0.3, children, ...props });
  const tree = { name: 'Test & rocket', components: [node('stage', { children: [tube] })] } as RocketTree;
  return { tube, tree };
};

describe('tube wrap geometry (SI, hand-computed)', () => {
  it('50 mm OD, three fins: 157.0796 mm wrap, 120 degree intervals, middle tab', () => {
    const { tree, tube } = fixture([fin()]);
    const g = tubeWrapGeometry(tree, tube);
    // Analytic paper geometry, tolerance 1e-10 m; no kernel floats are pinned.
    expect(g.circumference).toBeCloseTo(0.15707963267949, 10);
    expect(g.lines).toHaveLength(3);
    for (const [i, x] of [0, 0.05235987755983, 0.10471975511966].entries()) {
      expect(g.lines[i]!.x).toBeCloseTo(x, 10);
      expect(g.lines[i]!.slot!.start).toBeCloseTo(0.2, 10);
      expect(g.lines[i]!.slot!.end).toBeCloseTo(0.26, 10);
      expect(g.lines[i]!.slot!.width).toBeCloseTo(0.003, 10);
    }
    expect(g.lines[0]!.root).toEqual({ start: 0.18, end: 0.28 });
  });

  it('four fins rotated -45 degrees, top-positioned fin and bottom-offset tab', () => {
    const { tree, tube } = fixture([fin({ finCount: 4, rotation: -Math.PI / 4,
      position: { method: 'top', offset: 0.04 }, tabOffsetMethod: 'bottom', tabOffset: -0.01,
    })], { outerRadius: 0.02 });
    const g = tubeWrapGeometry(tree, tube);
    for (const [i, x] of [0.10995574287564, 0.01570796326795, 0.04712388980385, 0.07853981633974].entries()) {
      expect(g.lines[i]!.x).toBeCloseTo(x, 10);
      expect(g.lines[i]!.slot!.start).toBeCloseTo(0.07, 10);
      expect(g.lines[i]!.slot!.end).toBeCloseTo(0.13, 10);
    }
  });

  it('keeps unequal-angle fin sets, lug and button lines, with kernel guide defaults', () => {
    const { tree, tube } = fixture([fin(), fin({ id: 'second', finCount: 4, rotation: Math.PI / 6 }),
      node('launchlug'), node('railbutton', { angleOffset: Math.PI / 2 }),
    ]);
    const g = tubeWrapGeometry(tree, tube);
    expect(g.lines).toHaveLength(9);
    expect(g.lines[3]!.x).toBeCloseTo(0.01308996938996, 10);
    expect(g.lines[7]!.angle).toBeCloseTo(Math.PI, 10);
    expect(g.lines[8]!.x).toBeCloseTo(0.03926990816987, 10);
    expect(g.lines[7]!.root).toEqual({ start: 0.125, end: 0.175 });
    expect(g.lines[8]!.root).toEqual({ start: 0.15, end: 0.15 });
  });

  it('uses the freeform root rather than overhanging tip; clamps an offset tab', () => {
    const { tree, tube } = fixture([node('freeformfinset', {
      points: [[0, 0], [0.15, 0.06], [0.1, 0]], finCount: 3, thickness: 0.002,
      tabLength: 0.06, tabHeight: 0.01, tabOffsetMethod: 'top', tabOffset: -0.02,
    })]);
    const g = tubeWrapGeometry(tree, tube);
    expect(g.lines[0]!.root!.start).toBeCloseTo(0.2, 10);
    expect(g.lines[0]!.slot!.start).toBeCloseTo(0.2, 10);
    expect(g.lines[0]!.slot!.end).toBeCloseTo(0.24, 10);
  });

  it('places a closed freeform root at its actual chord instead of the repeated zero point', () => {
    const { tree, tube } = fixture([node('freeformfinset', {
      points: [[0, 0], [0.15, 0.06], [0.1, 0], [0, 0]],
      tabHeight: 0.01, tabLength: 0.06, thickness: 0.002,
    })]);
    const g = tubeWrapGeometry(tree, tube);
    expect(g.lines[0]!.root.start).toBeCloseTo(0.2, 10);
    expect(g.lines[0]!.slot!.start).toBeCloseTo(0.22, 10);
    expect(g.lines[0]!.slot!.end).toBeCloseTo(0.28, 10);
  });

  it('omits slots without a tab, on filled tubes, and for canted fins with advice', () => {
    for (const params of [{ tabHeight: 0 }, { tabLength: 0 }]) {
      const { tree, tube } = fixture([fin(params)]);
      expect(tubeWrapGeometry(tree, tube).lines[0]!.slot).toBeNull();
    }
    const filled = fixture([fin()], { filled: true });
    expect(tubeWrapGeometry(filled.tree, filled.tube).lines[0]!.slot).toBeNull();
    const canted = fixture([fin({ cant: 0.02 })]);
    const g = tubeWrapGeometry(canted.tree, canted.tube);
    expect(g.lines[0]!.slot).toBeNull();
    expect(g.notes.join(' ')).toMatch(/cant.*slot/i);
  });

  it('resolves absolute child stations relative to this tube and leaves the tree untouched', () => {
    const { tree, tube } = fixture([fin({ position: { method: 'absolute', offset: 0.25 } })]);
    tree.components[0]!.children!.unshift(node('nosecone', { length: 0.1 }));
    const before = JSON.stringify(tree);
    expect(tubeWrapGeometry(tree, tube).lines[0]!.slot!.start).toBeCloseTo(0.17, 10);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('marks repeated rail buttons at their separate axial stations', () => {
    const { tree, tube } = fixture([node('railbutton', { instanceCount: 2, instanceSeparation: 0.1,
      position: { method: 'top', offset: 0.03 } })]);
    const g = tubeWrapGeometry(tree, tube);
    expect(g.lines).toHaveLength(2);
    expect(g.lines[0]!.root.start).toBeCloseTo(0.03, 10);
    expect(g.lines[1]!.root.start).toBeCloseTo(0.13, 10);
    expect(g.lines[0]!.x).toBeCloseTo(g.lines[1]!.x, 10);
  });

  it('uses top tab offset and middle fin placement on an elliptical fin', () => {
    const { tree, tube } = fixture([{ ...fin({ position: { method: 'middle', offset: -0.01 },
      tabOffsetMethod: 'top', tabOffset: 0.01 }), type: 'ellipticalfinset' }]);
    const g = tubeWrapGeometry(tree, tube);
    expect(g.lines[0]!.slot!.start).toBeCloseTo(0.1, 10);
    expect(g.lines[0]!.slot!.end).toBeCloseTo(0.16, 10);
  });

  it('rejects non-tubes and invalid dimensions rather than printing a misleading wrap', () => {
    const { tree } = fixture([]);
    expect(() => tubeWrapGeometry(tree, node('transition'))).toThrow(/straight.*tube/i);
    for (const props of [{ outerRadius: 0 }, { length: -1 }]) {
      const f = fixture([], props);
      expect(() => tubeWrapGeometry(f.tree, f.tube)).toThrow(/dimension/i);
    }
  });
});

describe('print pages', () => {
  it('tiles a 314.159 mm by 500 mm tube in six Letter/A4-compatible pages with 10 mm overlap', () => {
    const { tree, tube } = fixture([fin()], { outerRadius: 0.05, length: 0.5 });
    const pages = tubeWrapPages(tubeWrapGeometry(tree, tube), tree.name!, { length: 'mm', angle: '°' });
    expect(pages).toHaveLength(6);
    expect(pages.map(p => [p.column, p.row])).toEqual([[1, 1], [2, 1], [1, 2], [2, 2], [1, 3], [2, 3]]);
    expect(pages[1]!.x).toBeCloseTo(0.17, 10);
    expect(pages[2]!.y).toBeCloseTo(0.19, 10);
    const doc = new DOMParser().parseFromString(pages[0]!.svg, 'image/svg+xml');
    const svg = doc.documentElement!;
    expect(svg.getAttribute('width')).toBe('210mm');
    expect(svg.getAttribute('height')).toBe('279mm');
    expect(svg.getAttribute('viewBox')).toBe('0 0 210 279');
    // Geometry is clipped numerically: SVG readers that ignore clipPath must not draw through the header.
    const lastDoc = new DOMParser().parseFromString(pages[5]!.svg, 'image/svg+xml');
    const marks = [...lastDoc.getElementsByTagName('line')].filter(l => l.getAttribute('class') === 'marking-line');
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(Number(mark.getAttribute('y1'))).toBeGreaterThanOrEqual(380);
      expect(Number(mark.getAttribute('y2'))).toBeLessThanOrEqual(500);
    }
    const ruler = doc.getElementById('calibration-ruler')!;
    expect(Number(ruler.getAttribute('x2')) - Number(ruler.getAttribute('x1'))).toBe(50);
    expect(svg.textContent).toContain('Scale 1:1');
    expect(svg.textContent).toContain('100%');
    expect(svg.textContent).toContain('Test & rocket');
    expect(svg.textContent).toMatch(/front.*aft/i);
    expect(svg.textContent).toContain('10 mm overlap');
  });

  it('splits a 3 mm slot at the wrap seam instead of losing half of it', () => {
    const { tree, tube } = fixture([fin()], { length: 0.1 });
    const [page] = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(page!.svg, 'image/svg+xml');
    const slots = [...doc.getElementsByTagName('rect')].filter(r => r.getAttribute('class') === 'tab-slot');
    expect(slots).toHaveLength(4); // three slots, one in two halves
    expect(Number(slots[0]!.getAttribute('width'))).toBeCloseTo(1.5, 8);
    expect(Number(slots[1]!.getAttribute('width'))).toBeCloseTo(1.5, 8);
  });

  it('labels inches and radians without scaling geometry, with a 2 inch calibration ruler', () => {
    const { tree, tube } = fixture([fin()], { length: 0.1, outerRadius: 0.0127 });
    const [page] = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'in', angle: 'rad' }, 'transparent');
    const doc = new DOMParser().parseFromString(page!.svg, 'image/svg+xml');
    expect(doc.documentElement!.hasAttribute('style')).toBe(false);
    expect(doc.documentElement!.textContent).toContain('OD 1 in');
    expect(doc.documentElement!.textContent).toContain('2 in');
    expect(doc.documentElement!.textContent).toContain('rad');
    const ruler = doc.getElementById('calibration-ruler')!;
    expect(Number(ruler.getAttribute('x2')) - Number(ruler.getAttribute('x1'))).toBeCloseTo(50.8, 8);
  });

  it('keeps cant advice on every printed page beside what it qualifies', () => {
    const { tree, tube } = fixture([fin({ cant: 0.02 })]);
    const pages = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    expect(pages.every(p => p.svg.includes('Caution:') && p.svg.includes('slot outlines are omitted'))).toBe(true);
  });

  it('clips a slot crossing a tile boundary to each overlapping sheet', () => {
    const { tree, tube } = fixture([fin({ position: { method: 'top', offset: 0.15 },
      tabLength: 0.1, tabOffsetMethod: 'top', tabOffset: 0 })]);
    const pages = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const slots = pages.map(p => [...new DOMParser().parseFromString(p.svg, 'image/svg+xml').getElementsByTagName('rect')]
      .filter(r => r.getAttribute('class') === 'tab-slot'));
    expect(Number(slots[0]![0]!.getAttribute('y'))).toBe(150);
    expect(Number(slots[0]![0]!.getAttribute('height'))).toBe(50);
    expect(Number(slots[1]![0]!.getAttribute('y'))).toBe(190);
    expect(Number(slots[1]![0]!.getAttribute('height'))).toBe(60);
  });

  it('labels collinear button instances once so names do not print over one another', () => {
    const { tree, tube } = fixture([node('railbutton', { name: 'Buttons', instanceCount: 2, instanceSeparation: 0.04,
      position: { method: 'top', offset: 0.02 } })], { length: 0.1 });
    const [page] = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(page!.svg, 'image/svg+xml');
    const names = [...doc.getElementsByTagName('text')].filter(t => t.textContent!.includes('Buttons'));
    expect(names).toHaveLength(1);
    expect(names[0]!.textContent).toContain('Buttons 1 / Buttons 2');
    const ticks = [...doc.getElementsByTagName('line')].filter(l => l.getAttribute('stroke-width') === '0.5');
    expect(ticks.some(l => Number(l.getAttribute('y1')) === 20)).toBe(true);
    expect(ticks.some(l => Number(l.getAttribute('y1')) === 60)).toBe(true);
  });

  it('combines a fin and guide on the same clock line into one readable label', () => {
    const { tree, tube } = fixture([fin({ finCount: 4 }), node('railbutton', { name: 'Button' })], { length: 0.1 });
    const [page] = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(page!.svg, 'image/svg+xml');
    const label = [...doc.getElementsByTagName('text')].find(t => t.textContent!.includes('Button'))!;
    expect(label.textContent).toContain('Fins 3 / Button 1');
  });
});
