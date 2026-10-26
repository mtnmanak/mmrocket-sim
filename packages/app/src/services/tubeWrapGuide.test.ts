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

const expectTextClearOfMarks = (doc: ReturnType<DOMParser['parseFromString']>) => {
  const marks = [...doc.getElementsByTagName('g')].filter(g => g.getAttribute('class') === 'drilling-mark');
  const markBoxes = marks.map(mark => {
    const lines = [...mark.getElementsByTagName('line')];
    const circle = mark.getElementsByTagName('circle')[0];
    const xs = lines.flatMap(line => [Number(line.getAttribute('x1')), Number(line.getAttribute('x2'))]);
    const ys = lines.flatMap(line => [Number(line.getAttribute('y1')), Number(line.getAttribute('y2'))]);
    if (circle) {
      const cx = Number(circle.getAttribute('cx')), cy = Number(circle.getAttribute('cy')), r = Number(circle.getAttribute('r'));
      xs.push(cx - r, cx + r);
      ys.push(cy - r, cy + r);
    }
    // Include the 0.2 mm stroke and a readable gap, allowing 0.0001 mm SVG rounding.
    return { left: Math.min(...xs) - 0.8, right: Math.max(...xs) + 0.8,
      top: Math.min(...ys) - 0.8, bottom: Math.max(...ys) + 0.8 };
  });
  const captions = [...doc.getElementsByTagName('text')].filter(text => text.getAttribute('font-size') === '2.4'
    && text.textContent!.includes(': '));
  expect(captions).toHaveLength(marks.length);
  const wrap = [...doc.getElementsByTagName('g')].find(g => g.hasAttribute('transform')
    && g.getAttribute('stroke-width') === '0.2')!;
  for (const text of [...wrap.getElementsByTagName('text')]) {
    const size = Number(text.getAttribute('font-size'));
    const length = text.hasAttribute('textLength') ? Number(text.getAttribute('textLength')) : text.textContent!.length * size;
    const transform = text.getAttribute('transform') ?? '';
    const translated = transform.match(/translate\(([-\d.]+) ([-\d.]+)\) rotate\(90\)/);
    const x = translated ? Number(translated[1]) : Number(text.getAttribute('x'));
    const y = translated ? Number(translated[2]) : Number(text.getAttribute('y'));
    const box = translated || transform.startsWith('rotate(90 ')
      ? { left: x - size / 4, right: x + size, top: y, bottom: y + length }
      : { left: x, right: x + length, top: y - size, bottom: y + size / 4 };
    for (const other of markBoxes) {
      expect(box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom,
        `text ${JSON.stringify(text.textContent)} ${JSON.stringify(box)} intersects drilling geometry ${JSON.stringify(other)}`).toBe(false);
    }
  }
};

describe('tube wrap geometry (SI, hand-computed)', () => {
  it.each([
    ['mm', '0.15 mm'], ['cm', '0.015 cm'], ['m', '0.00015 m'],
    ['in', '0.00591 in'], ['ft', '0.000492 ft'],
  ])('retains sub-millimetre drilling guidance in %s', (length, diameter) => {
    const { tree, tube } = fixture([node('tubehole', { name: 'Small vent', holeDiameter: 0.00015, holeCount: 1 })]);
    const svg = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length, angle: '\u00b0' })[0]!.svg;
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const labels = [...doc.getElementsByTagName('text')].map(text => text.textContent).join(' ');
    expect(labels).toContain(`Small vent: ${diameter}`);
    expect(svg).toContain(`diameter ${diameter}; fabrication only`);
  });

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

  it.each([0.01, 0.025, 0.1])('S7d-g1 snaps seam noise by arc length at radius %s m and keeps its label', radius => {
    const { tree, tube } = fixture([fin({ finCount: 1, rotation: -0.5e-9 / radius }),
      node('launchlug', { name: 'Lug', angleOffset: 0 }),
    ], { outerRadius: radius, length: 0.1 });
    const g = tubeWrapGeometry(tree, tube);
    expect(g.lines[0]!.x).toBe(0);
    expect(g.lines[0]!.angle).toBe(0);
    const svg = tubeWrapPages(g, 'Test', { length: 'mm', angle: 'deg' })[0]!.svg;
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const seamMark = [...doc.getElementsByTagName('line')].find(l => l.getAttribute('class') === 'marking-line'
      && l.getAttribute('x1') === '0.0000');
    expect(seamMark).toBeDefined();
    expect(seamMark!.hasAttribute('stroke-dasharray')).toBe(false);
    expect(doc.documentElement!.textContent).toContain('Fins 1 / Lug 1');
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
  it.each([
    ['axial coordinate', 5, 22, 3, 1],
    ['circumference coordinate', 24, 4, 3, 1],
    ['large diameter circle', 11, 27, 12, 1],
    ['axial overlap copy', 5, 182, 3, 2],
    ['circumference overlap copy', 175, 22, 3, 2],
    ['seam copies', 0, 22, 3, 2],
  ] as const)('keeps all wrap text clear of a single drilling mark at the %s', (_case, x, station, diameter, expectedCopies) => {
    const { tree, tube } = fixture([node('tubehole', { name: 'Vent', holeDiameter: diameter / 1000,
      holeCount: 1, holePosition: station / 1000, angleOffset: x / 50,
    })], { outerRadius: 0.05 });
    const pages = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    let copies = 0;
    for (const page of pages) {
      const doc = new DOMParser().parseFromString(page.svg, 'image/svg+xml');
      expectTextClearOfMarks(doc);
      const leaders = [...doc.getElementsByTagName('line')].filter(line => line.getAttribute('class') === 'hole-caption-leader');
      for (const leader of leaders) {
        // At zero angle the second centre repeats at the analytically derived 100 mm OD seam.
        expect(Number(leader.getAttribute('x1'))).toBeCloseTo(x === 0 && page.column === 2 ? 314.1593 : x, 4);
        expect(Number(leader.getAttribute('y1'))).toBe(station);
      }
      copies += leaders.length;
      expect([...doc.getElementsByTagName('line')].some(line => line.getAttribute('stroke') === '#888')).toBe(true);
      expect([...doc.getElementsByTagName('text')].some(text => text.getAttribute('font-size') === '2.4'
        && !text.textContent!.includes(': '))).toBe(true);
    }
    expect(copies).toBe(expectedCopies);
  });

  it('keeps the 24 mm tube reproduction clear while preserving the drilling centre', () => {
    const { tree, tube } = fixture([node('tubehole', { name: 'Vent', holeDiameter: 0.003,
      holeCount: 1, holePosition: 0.022, angleOffset: 0.005 / 0.012,
    })], { outerRadius: 0.012 });
    const [page] = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(page!.svg, 'image/svg+xml');
    expectTextClearOfMarks(doc);
    const mark = [...doc.getElementsByTagName('g')].find(g => g.getAttribute('class') === 'drilling-mark')!;
    const cross = [...mark.getElementsByTagName('line')];
    expect(cross.map(line => ['x1', 'y1', 'x2', 'y2'].map(attr => Number(line.getAttribute(attr)))))
      .toEqual([[3, 22, 7, 22], [5, 20, 5, 24]]);
    const circle = mark.getElementsByTagName('circle')[0]!;
    expect(['cx', 'cy', 'r'].map(attr => Number(circle.getAttribute(attr)))).toEqual([5, 22, 1.5]);
  });

  it.each(['trapezoidfinset', 'freeformfinset', 'launchlug', 'railbutton'])('keeps %s labels clear of drilling marks without removing its clock line', type => {
    const { tree, tube } = fixture([
      node(type, { name: 'Part', finCount: 1, rotation: 1, angleOffset: 1 }),
      node('launchlug', { id: 'clear', name: 'Clear', angleOffset: Math.PI }),
      node('tubehole', { name: 'Vent', holeDiameter: 0.003, holeCount: 1, holePosition: 0.025, angleOffset: 1.08 }),
    ]);
    const [page] = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(page!.svg, 'image/svg+xml');
    expectTextClearOfMarks(doc);
    const clock = [...doc.getElementsByTagName('line')].find(line => line.getAttribute('class') === 'marking-line'
      && Number(line.getAttribute('x1')) === 25)!;
    expect(['x1', 'y1', 'x2', 'y2'].map(attr => Number(clock.getAttribute(attr)))).toEqual([25, 0, 25, 190]);
    expect([...doc.getElementsByTagName('text')].some(text => text.textContent!.startsWith('Clear 1'))).toBe(true);
    const leader = [...doc.getElementsByTagName('line')].find(line => line.getAttribute('class') === 'hole-caption-leader')!;
    expect(['x1', 'y1'].map(attr => Number(leader.getAttribute(attr)))).toEqual([27, 25]);
  });

  it('omits grid captions that extend beyond a narrow circumference tile', () => {
    const { tree, tube } = fixture([], { outerRadius: 0.0288, length: 0.1 });
    const pages = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(pages[1]!.svg, 'image/svg+xml');
    const labels = [...doc.getElementsByTagName('text')].filter(text => text.getAttribute('font-size') === '2.4');
    expect(labels).toHaveLength(0); // 10.9557 mm tile cannot fit the conservative coordinate-label width.
    const gridLines = [...doc.getElementsByTagName('line')].filter(line => line.getAttribute('stroke') === '#888');
    expect(gridLines.length).toBeGreaterThan(0);
  });

  it('retains readable diameter captions on a narrow final circumference tile', () => {
    const { tree, tube } = fixture([node('tubehole', { name: 'Vent / marking hole',
      holeDiameter: 0.003, holeCount: 1, holePosition: 0.05, angleOffset: 0.175 / 0.0288,
    })], { outerRadius: 0.0288, length: 0.1 });
    const pages = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    expect(pages).toHaveLength(2);
    for (const page of pages) {
      const doc = new DOMParser().parseFromString(page.svg, 'image/svg+xml');
      expectTextClearOfMarks(doc);
      const caption = [...doc.getElementsByTagName('text')].find(text => text.textContent === 'Vent / marking hole: 3 mm')!;
      expect(Number(caption.getAttribute('textLength'))).toBeGreaterThanOrEqual(31); // Physical baseline width, also after rotation.
      expect(Number(caption.getAttribute('font-size'))).toBe(2.4);
      const leader = [...doc.getElementsByTagName('line')].find(line => line.getAttribute('class') === 'hole-caption-leader')!;
      expect(Number(leader.getAttribute('x1'))).toBe(175);
      expect(Number(leader.getAttribute('y1'))).toBe(50);
      const x = Number(caption.getAttribute('x')), y = Number(caption.getAttribute('y'));
      if (page.column === 2) {
        expect(caption.getAttribute('transform')).toBe(`rotate(90 ${caption.getAttribute('x')} ${caption.getAttribute('y')})`);
        expect(x - 0.6).toBeGreaterThanOrEqual(170);
        expect(x + 2.4).toBeLessThanOrEqual(180.9558); // Analytic circumference, rounded outward to 0.0001 mm.
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y + Number(caption.getAttribute('textLength'))).toBeLessThanOrEqual(100);
        expect(Number(leader.getAttribute('x2'))).toBeCloseTo(x + 1.2, 4);
        expect(Number(leader.getAttribute('y2'))).toBeCloseTo(y, 4);
      }
    }
  });

  it('refuses a narrow short tile rather than squeezing a caption in either direction', () => {
    const { tree, tube } = fixture([node('tubehole', { name: 'Vent / marking hole',
      holeDiameter: 0.003, holeCount: 1, holePosition: 0.005, angleOffset: 0.175 / 0.0288,
    })], { outerRadius: 0.0288, length: 0.01 });
    expect(() => tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' }))
      .toThrow(/hole captions.*fit.*reduce.*marks.*shorten.*names/i);
  });

  it('keeps captions clear of diameter circles larger than the centre cross', () => {
    const { tree, tube } = fixture([node('tubehole', { name: 'Vent',
      holeDiameter: 0.012, holeCount: 4, holePosition: 0.025,
    })], { outerRadius: 0.012 });
    const [page] = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    expectTextClearOfMarks(new DOMParser().parseFromString(page!.svg, 'image/svg+xml'));
  });

  it('keeps captions clear of drilling marks at two nearby axial stations', () => {
    const { tree, tube } = fixture([
      node('tubehole', { name: 'Vent / marking hole', holeDiameter: 0.003, holeCount: 1, holePosition: 0.025, angleOffset: 0 }),
      node('tubehole', { name: 'Vent / marking hole', holeDiameter: 0.003, holeCount: 1, holePosition: 0.029, angleOffset: Math.PI / 2 }),
    ], { outerRadius: 0.012 });
    const [page] = tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(page!.svg, 'image/svg+xml');
    expectTextClearOfMarks(doc);
    const leaders = [...doc.getElementsByTagName('line')].filter(line => line.getAttribute('class') === 'hole-caption-leader');
    expect(leaders.map(line => [Number(line.getAttribute('x1')), Number(line.getAttribute('y1'))]))
      .toEqual([[0, 25], [75.3982, 25], [18.8496, 29]]); // 24 mm OD seam copies and quarter circumference.
  });

  it('refuses a page too crowded for readable hole captions', () => {
    const { tree, tube } = fixture([node('tubehole', {
      name: 'Vent / marking hole', holeDiameter: 0.003, holeCount: 64, holePosition: 0.005,
    })], { outerRadius: 0.012, length: 0.01 });
    expect(() => tubeWrapPages(tubeWrapGeometry(tree, tube), 'Rocket', { length: 'mm', angle: '°' }))
      .toThrow(/hole captions.*fit.*reduce.*marks.*shorten.*names/i);
  });

  it.each([
    ['default four-hole pattern', 0.012, 0.025, 0, false, 5],
    ['four holes with fin and guide labels', 0.012, 0.025, 0, true, 5],
    ['four holes at both tile overlaps', 0.05, 0.188, 3.56, true, 10],
  ] as const)('keeps printable diameter captions separate for %s', (_case, outerRadius, holePosition, angleOffset, withLines, copies) => {
    const { tree, tube } = fixture([
      node('tubehole', { name: 'Vent / marking hole', holeDiameter: 0.003, holeCount: 4, holePosition, angleOffset }),
      ...(withLines ? [fin({ finCount: 4 }), node('launchlug', { name: 'Lug', angleOffset: Math.PI / 4 }),
        node('railbutton', { name: 'Button', angleOffset: Math.PI / 2 })] : []),
    ], { outerRadius });
    const guide = tubeWrapGeometry(tree, tube);
    const pages = tubeWrapPages(guide, 'Rocket', { length: 'mm', angle: '°' });
    let total = 0;
    for (const page of pages) {
      const doc = new DOMParser().parseFromString(page.svg, 'image/svg+xml');
      expectTextClearOfMarks(doc);
      const texts = [...doc.getElementsByTagName('text')];
      const captions = texts.filter(t => t.textContent === 'Vent / marking hole: 3 mm');
      const marks = [...doc.getElementsByTagName('g')].filter(g => g.getAttribute('class') === 'drilling-mark');
      expect(captions).toHaveLength(marks.length);
      const leaders = [...doc.getElementsByTagName('line')].filter(l => l.getAttribute('class') === 'hole-caption-leader');
      expect(leaders).toHaveLength(marks.length);
      for (const [i, mark] of marks.entries()) {
        const cross = [...mark.getElementsByTagName('line')];
        expect(leaders[i]!.getAttribute('x1')).toBe(cross[1]!.getAttribute('x1'));
        expect(leaders[i]!.getAttribute('y1')).toBe(cross[0]!.getAttribute('y1'));
        expect(leaders[i]!.getAttribute('x2')).toBe(captions[i]!.getAttribute('x'));
        expect(Number(leaders[i]!.getAttribute('y2'))).toBeCloseTo(Number(captions[i]!.getAttribute('y')) - 1.2, 4);
      }
      total += captions.length;
      // Include ascent and descenders; rotation(90) turns ascent toward positive x.
      const boxes = captions.map(t => ({ x: Number(t.getAttribute('x')), y: Number(t.getAttribute('y')) - 2.4,
        width: Number(t.getAttribute('textLength')), height: 3 }));
      const lineLabels = texts.filter(t => t.hasAttribute('transform')).map(t => {
        const [, x, y] = t.getAttribute('transform')!.match(/translate\(([-\d.]+) ([-\d.]+)\)/)!;
        return { x: Number(x) - 0.75, y: Number(y), width: 3.75, height: Number(t.getAttribute('textLength')) };
      });
      const gridLabels = texts.filter(t => !t.hasAttribute('textLength') && !t.hasAttribute('transform')
        && t.getAttribute('font-size') === '2.4').map(t => ({ x: Number(t.getAttribute('x')),
        y: Number(t.getAttribute('y')) - 2.4, width: t.textContent!.length * 2.4, height: 3 }));
      const intersects = (a: typeof boxes[number], b: typeof boxes[number]) =>
        a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      for (const [i, box] of boxes.entries()) {
        expect(box.width).toBeGreaterThanOrEqual(31); // Full default caption stays readable on these tiles.
        expect(Number(captions[i]!.getAttribute('font-size'))).toBe(2.4);
        expect(box.x).toBeGreaterThanOrEqual(page.x * 1000);
        expect(box.x + box.width).toBeLessThanOrEqual(Math.min(page.x * 1000 + 180, guide.circumference * 1000) + 0.0001);
        expect(box.y).toBeGreaterThanOrEqual(page.y * 1000);
        expect(box.y + box.height).toBeLessThanOrEqual(Math.min(page.y * 1000 + 190, 300) + 0.0001);
        if (!withLines && captions.length) {
          // This ordinary pattern has empty bands beside its 25 mm station.
          expect(Math.abs(Number(captions[i]!.getAttribute('y')) - 25)).toBeLessThan(20);
        }
        for (const other of [...boxes.slice(i + 1), ...lineLabels, ...gridLabels]) expect(intersects(box, other)).toBe(false);
      }
    }
    expect(total).toBe(copies);
  });

  it.each([
    ['aft tube edge', 0.012, 0.3, 0.298, Math.PI, 1],
    ['right tube edge', 0.012, 0.1, 0.05, 2 * Math.PI - 0.002 / 0.012, 1],
    ['axial tile overlap', 0.012, 0.3, 0.188, Math.PI, 2],
    ['circumference tile overlap', 0.05, 0.1, 0.05, 3.56, 2],
    ['tile corner overlap', 0.05, 0.3, 0.188, 3.56, 4],
    ['front seam', 0.012, 0.1, 0.002, 0, 2],
  ] as const)('prints a diameter caption beside every hole centre at the %s', (_edge, outerRadius, length, holePosition, angleOffset, copies) => {
    const { tree, tube } = fixture([node('tubehole', {
      name: 'Vent', holeDiameter: 0.003, holeCount: 1, holePosition, angleOffset,
    })], { outerRadius, length });
    const guide = tubeWrapGeometry(tree, tube);
    const pages = tubeWrapPages(guide, 'Rocket', { length: 'mm', angle: '°' });
    let total = 0;
    for (const page of pages) {
      const doc = new DOMParser().parseFromString(page.svg, 'image/svg+xml');
      const marks = [...doc.getElementsByTagName('g')].filter(g => g.getAttribute('class') === 'drilling-mark');
      // Inspect printable text nodes, never the nonprinting title or the complete SVG string.
      const captions = [...doc.getElementsByTagName('text')].filter(t => t.textContent === 'Vent: 3 mm');
      expect(captions).toHaveLength(marks.length);
      total += marks.length;
      for (const caption of captions) {
        const tx = Number(caption.getAttribute('x')), ty = Number(caption.getAttribute('y'));
        const textLength = Number(caption.getAttribute('textLength'));
        expect(textLength).toBeGreaterThanOrEqual(9); // Do not satisfy presence by crushing the dimension.
        // The fixture's fabrication advice uses two 5 mm note lines: a 190 mm tile height.
        // Serialized coordinates round to 0.0001 mm.
        expect(tx).toBeGreaterThanOrEqual(page.x * 1000);
        expect(tx + textLength).toBeLessThanOrEqual(Math.min(page.x * 1000 + 180, guide.circumference * 1000) + 0.0001);
        expect(ty - 2.4).toBeGreaterThanOrEqual(page.y * 1000);
        expect(ty).toBeLessThanOrEqual(Math.min(page.y * 1000 + 190, length * 1000));
      }
    }
    expect(total).toBe(copies);
  });

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
