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
    expect(g.lines[7]!.angle).toBe(0);
    expect(g.lines[8]!.x).toBeCloseTo(0.03926990816987, 10);
    expect(g.lines[7]!.root).toEqual({ start: 0.125, end: 0.175 });
    expect(g.lines[8]!.root).toEqual({ start: 0.15, end: 0.15 });
  });

  it.each(['launchlug', 'railbutton'])('defaults an absent %s angle to zero and preserves explicit 180 degrees', type => {
    const { tree, tube } = fixture([node(type), node(type, { id: 'explicit', angleOffset: Math.PI })]);
    const g = tubeWrapGeometry(tree, tube);
    expect(g.lines[0]!.angle).toBe(0);
    expect(g.lines[0]!.x).toBe(0);
    expect(g.lines[1]!.angle).toBeCloseTo(Math.PI, 10);
    expect(g.lines[1]!.x).toBeCloseTo(g.circumference / 2, 10);
  });

  it('normalizes a negative rounding residual at the seam to zero', () => {
    const { tree, tube } = fixture([fin({ finCount: 7, rotation: -(360 * 5 / 7) * (Math.PI / 180) })]);
    const g = tubeWrapGeometry(tree, tube);
    expect(g.lines[5]!.angle).toBe(0);
    expect(g.lines[5]!.x).toBe(0);
    // A real angle near the seam stays distinct; only rounding noise is snapped.
    const nearby = fixture([node('launchlug', { angleOffset: -1e-6 })]);
    expect(tubeWrapGeometry(nearby.tree, nearby.tube).lines[0]!.angle).toBeCloseTo(2 * Math.PI - 1e-6, 10);
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
  it('labels rotated fins, lugs and buttons within 5 mm of the right seam', () => {
    const { tree, tube } = fixture([
      fin({ rotation: -15 * Math.PI / 180 }),
      node('launchlug', { name: 'Lug', angleOffset: 340 * Math.PI / 180 }),
      node('railbutton', { name: 'Button', angleOffset: 350 * Math.PI / 180 }),
    ], { outerRadius: 0.009347 });
    const g = tubeWrapGeometry(tree, tube);
    const [page] = tubeWrapPages(g, 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(page!.svg, 'image/svg+xml');
    const labels = [...doc.getElementsByTagName('text')].filter(t => t.hasAttribute('transform'));
    for (const [name, angle] of [['Fins 1', 345], ['Lug 1', 340], ['Button 1', 350]] as const) {
      const label = labels.find(t => t.textContent!.includes(`${name} · ${angle} °`));
      expect(label).toBeDefined();
      const tx = Number(label!.getAttribute('transform')!.match(/translate\(([-\d.]+)/)![1]);
      const lx = g.lines.find(l => l.label === name)!.x * 1000;
      expect(tx).toBeLessThan(lx);
      expect(tx).toBeGreaterThan(0);
    }
  });

  it.each([0.02, 0.202])('labels fins and guides on short rows of a %s m tube', length => {
    const { tree, tube } = fixture([
      fin({ rootChord: 0.01, tabHeight: 0, position: { method: 'top', offset: 0 } }),
      node('launchlug', { name: 'Lug', length: 0.01, angleOffset: Math.PI / 3 }),
      node('railbutton', { name: 'Button', angleOffset: Math.PI }),
    ], { length });
    const pages = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const page = pages.at(-1)!;
    const doc = new DOMParser().parseFromString(page.svg, 'image/svg+xml');
    const labels = [...doc.getElementsByTagName('text')].filter(t => t.hasAttribute('transform'));
    expect(labels).toHaveLength(5);
    expect(labels.map(t => t.textContent).join(' / ')).toContain('Lug 1 · 60 °');
    expect(labels.map(t => t.textContent).join(' / ')).toContain('Button 1 · 180 °');
    for (const label of labels) {
      const ty = Number(label.getAttribute('transform')!.match(/translate\([-\d.]+ ([-\d.]+)/)![1]);
      const textLength = Number(label.getAttribute('textLength'));
      expect(ty).toBeGreaterThan(page.y * 1000);
      expect(textLength).toBeGreaterThan(0);
      expect(ty + textLength).toBeLessThan(length * 1000);
    }
  });

  it('prints a solid shared seam line and one combined label when the lug precedes a near-zero fin', () => {
    const { tree, tube } = fixture([
      node('launchlug', { name: 'Lug', angleOffset: 0 }),
      fin({ finCount: 7, rotation: -(360 * 5 / 7) * (Math.PI / 180) }),
    ]);
    const [page] = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(page!.svg, 'image/svg+xml');
    const marks = [...doc.getElementsByTagName('line')].filter(l => l.getAttribute('class') === 'marking-line');
    const seamMarks = marks.filter(l => ['0.0000', '157.0796'].includes(l.getAttribute('x1')!));
    expect(seamMarks).toHaveLength(2);
    expect(seamMarks.every(l => !l.hasAttribute('stroke-dasharray'))).toBe(true);
    const labels = [...doc.getElementsByTagName('text')].filter(t => t.textContent!.includes('Lug 1'));
    expect(labels).toHaveLength(1);
    expect(labels[0]!.textContent).toContain('Lug 1 / Fins 6 · 0 °');
  });

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
    const slots = [...doc.getElementsByTagName('line')].filter(r => r.getAttribute('class') === 'tab-slot');
    const sides = slots.filter(s => s.getAttribute('x1') === s.getAttribute('x2'));
    expect(sides).toHaveLength(6);
    expect(sides.some(s => Number(s.getAttribute('x1')) === 1.5)).toBe(true);
    expect(sides.some(s => Math.abs(Number(s.getAttribute('x1')) - 155.5796) < 0.0001)).toBe(true);
    expect(sides.some(s => ['0.0000', '157.0796'].includes(s.getAttribute('x1')!))).toBe(false);
    const ends = slots.filter(s => s.getAttribute('y1') === s.getAttribute('y2'));
    expect(ends).toHaveLength(8); // three front/aft edges; the seam slot has two halves
    expect(Number(ends[0]!.getAttribute('x2')) - Number(ends[0]!.getAttribute('x1'))).toBeCloseTo(1.5, 8);
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

  it('clips longitudinal slot sides without inventing transverse ends at axial tile boundaries', () => {
    const { tree, tube } = fixture([fin({ position: { method: 'top', offset: 0.15 },
      tabLength: 0.1, tabOffsetMethod: 'top', tabOffset: 0 })]);
    const pages = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const slots = pages.map(p => [...new DOMParser().parseFromString(p.svg, 'image/svg+xml').getElementsByTagName('line')]
      .filter(r => r.getAttribute('class') === 'tab-slot'));
    for (const [row, start, end, genuineEnd] of [[0, 150, 200, 150], [1, 190, 250, 250]]) {
      const sides = slots[row!]!.filter(s => s.getAttribute('x1') === s.getAttribute('x2'));
      expect(sides).toHaveLength(6);
      expect(sides.every(s => Number(s.getAttribute('y1')) === start && Number(s.getAttribute('y2')) === end)).toBe(true);
      const ends = slots[row!]!.filter(s => s.getAttribute('y1') === s.getAttribute('y2'));
      expect(ends).toHaveLength(4);
      expect(ends.every(s => Number(s.getAttribute('y1')) === genuineEnd)).toBe(true);
    }
  });

  it('clips transverse slot ends without inventing sides at circumferential tile boundaries', () => {
    // One 20 mm wide slot centred at 175 mm spans both column boundaries (170/180 mm).
    const { tree, tube } = fixture([fin({ finCount: 1, rotation: 3.5, thickness: 0.02,
      position: { method: 'top', offset: 0.04 }, tabOffsetMethod: 'top', tabOffset: 0,
    })], { outerRadius: 0.05, length: 0.15 });
    const pages = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    for (const [column, side, start, end] of [[0, 165, 165, 180], [1, 185, 170, 185]]) {
      const doc = new DOMParser().parseFromString(pages[column!]!.svg, 'image/svg+xml');
      const slots = [...doc.getElementsByTagName('line')].filter(s => s.getAttribute('class') === 'tab-slot');
      const sides = slots.filter(s => s.getAttribute('x1') === s.getAttribute('x2'));
      expect(sides).toHaveLength(1);
      expect(Number(sides[0]!.getAttribute('x1'))).toBe(side);
      const ends = slots.filter(s => s.getAttribute('y1') === s.getAttribute('y2'));
      expect(ends).toHaveLength(2);
      expect(ends.every(s => Number(s.getAttribute('x1')) === start && Number(s.getAttribute('x2')) === end)).toBe(true);
      expect(ends.map(s => Number(s.getAttribute('y1')))).toEqual([40, 100]);
    }
  });

  it.each(['left', 'right'])('separates nearby distinct clock labels at the %s seam into readable axial bands', edge => {
    const angles = edge === 'right' ? [345, 340, 350] : [15, 10, 20];
    const { tree, tube } = fixture([
      fin({ rotation: angles[0]! * Math.PI / 180 }),
      node('launchlug', { name: 'Lug', angleOffset: angles[1]! * Math.PI / 180 }),
      node('railbutton', { name: 'Button', angleOffset: angles[2]! * Math.PI / 180 }),
    ], { outerRadius: 0.009347 });
    for (const page of tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' })) {
      const doc = new DOMParser().parseFromString(page.svg, 'image/svg+xml');
      const labels = [...doc.getElementsByTagName('text')].filter(t => t.hasAttribute('transform'));
      const bounds = labels.map(label => {
        const [, tx, ty] = label.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!;
        const textLength = Number(label.getAttribute('textLength'));
        // At least 1 mm per character for this fixture: catch separation by crushing the text.
        expect(textLength).toBeGreaterThanOrEqual(label.textContent!.length);
        expect(Number(label.getAttribute('font-size'))).toBe(3);
        expect(Number(ty) + textLength).toBeLessThanOrEqual(Math.min(page.y * 1000 + 200, 300) - 2);
        return { x: Number(tx), y: Number(ty), end: Number(ty) + textLength };
      });
      for (let i = 0; i < bounds.length; i++) {
        for (let j = i + 1; j < bounds.length; j++) {
          const a = bounds[i]!, b = bounds[j]!;
          // Allow font ascenders/descenders beyond the rotated 3 mm em, plus axial clearance.
          expect(Math.abs(a.x - b.x) >= 5 || a.end + 2 <= b.y || b.end + 2 <= a.y).toBe(true);
        }
      }
      for (const [name, angle] of [['Fins 1', angles[0]], ['Lug 1', angles[1]], ['Button 1', angles[2]]] as const) {
        expect(labels.some(t => t.textContent!.includes(`${name} · ${angle} °`))).toBe(true);
      }
    }
  });

  it('separates nearby labels with baselines just over 4 mm apart to allow font ascenders and descenders', () => {
    const { tree, tube } = fixture([
      node('launchlug', { name: 'Lug', angleOffset: 0 }),
      node('railbutton', { name: 'Button', angleOffset: 0.162 }), // 25 mm radius * 0.162 rad = 4.05 mm
    ]);
    const [page] = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(page!.svg, 'image/svg+xml');
    const labels = [...doc.getElementsByTagName('text')].filter(t => t.hasAttribute('transform'));
    expect(labels).toHaveLength(2);
    const bands = labels.map(label => {
      const ty = Number(label.getAttribute('transform')!.match(/translate\([-\d.]+ ([-\d.]+)/)![1]);
      return { y: ty, end: ty + Number(label.getAttribute('textLength')) };
    }).sort((a, b) => a.y - b.y);
    expect(bands[0]!.end + 2).toBeLessThanOrEqual(bands[1]!.y);
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
    expect(label.textContent).toContain('Fins 1 / Button 1');
  });
});
