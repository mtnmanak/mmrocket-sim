// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { finAlignmentJigGeometry, finAlignmentJigSvg } from './finAlignmentJig.js';
import { finTemplatePixelSize } from './finTemplate.js';

const tube = { type: 'bodytube', outerRadius: 0.025 } as ComponentNode;
const fins = (finCount = 3, type = 'freeformfinset') => ({
  type, finCount, rotation: Math.PI / 6, thickness: 0.003, crossSection: 'rounded',
  points: [[0, 0], [0.02, 0.04], [0.08, 0]], height: 0.04,
}) as ComponentNode;

describe('N049 fin alignment jig', () => {
  it.each([3, 4])('places %i slots at the fin clocks, with thickness plus total clearance', count => {
    const g = finAlignmentJigGeometry(tube, fins(count), 0.0002);
    expect(g.tubeRadius).toBe(0.025);
    expect(g.slotWidth).toBeCloseTo(0.0032, 12); // SI geometry arithmetic, not a kernel literal.
    expect(g.slots).toHaveLength(count);
    g.slots.forEach((slot, i) => {
      expect(slot.angle).toBeCloseTo(Math.PI / 6 + i * 2 * Math.PI / count, 12);
      const [a, b] = slot.outer;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeCloseTo(g.slotWidth, 12);
      for (const point of slot.inner) expect(Math.hypot(...point)).toBeCloseTo(g.tubeRadius, 12);
    });
  });

  it.each(['freeformfinset', 'ellipticalfinset', 'trapezoidfinset'])('uses actual %s thickness regardless of rounded/airfoil profile', type => {
    for (const crossSection of ['rounded', 'airfoil']) {
      const g = finAlignmentJigGeometry(tube, { ...fins(4, type), crossSection }, 0.0005);
      expect(g.slotWidth).toBeCloseTo(0.0035, 12);
    }
  });

  it('prints a single joined bore-and-slots cut contour, an outer edge and a 1:1 ruler', () => {
    const svg = finAlignmentJigSvg(tube, fins(), 0.0002, 'Rocket & jig', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.querySelector('#tube-and-slots')!.getAttribute('d')!.match(/ A /g)).toHaveLength(3);
    expect(doc.querySelector('#jig-outer-edge')).not.toBeNull();
    const ruler = doc.querySelector('#calibration-ruler')!;
    expect(Number(ruler.getAttribute('x2')) - Number(ruler.getAttribute('x1'))).toBe(50);
    expect(doc.documentElement.textContent).toMatch(/100%.*no fit to page/);
    expect(doc.documentElement.textContent).toContain('3.2 mm');
    expect(doc.documentElement.textContent).toContain('0.2 mm');
    expect(finTemplatePixelSize(svg).width).toBeGreaterThan(0);
    expect(svg).toContain('background:#fff');
    expect(doc.querySelector('#zero-angle-reference')).not.toBeNull();
    expect(doc.documentElement.textContent).toContain('from aft');
    const imperial = finAlignmentJigSvg(tube, fins(), 0, 'Rocket', { length: 'in', angle: 'rad' }, 'transparent');
    expect(imperial).not.toContain('background:#fff');
    expect(imperial).toContain('2 in');
  });

  it.each([3, 4])('writes the %i physical slot widths and tube bore radius into the SVG', count => {
    const svg = finAlignmentJigSvg(tube, fins(count), 0.0002, 'Rocket', { length: 'mm', angle: '°' });
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    const path = doc.querySelector('#tube-and-slots')!.getAttribute('d')!;
    const segments = [...path.matchAll(/L ([-\d.]+) ([-\d.]+) L ([-\d.]+) ([-\d.]+) L /g)];
    expect(segments).toHaveLength(count);
    for (const s of segments) {
      // SVG endpoints round to 0.0001 mm: at most 0.00015 mm error in their separation.
      expect(Math.abs(Math.hypot(Number(s[1]) - Number(s[3]), Number(s[2]) - Number(s[4])) - 3.2)).toBeLessThan(0.00015);
    }
    const arcs = [...path.matchAll(/A ([\d.]+) ([\d.]+)/g)];
    expect(arcs).toHaveLength(count);
    expect(arcs.every(a => Number(a[1]) === 25 && Number(a[2]) === 25)).toBe(true);
  });

  it('rejects impossible fits and non-flat fins without changing the design', () => {
    const before = JSON.stringify(tube);
    for (const clearance of [-0.1, NaN, Infinity]) {
      expect(() => finAlignmentJigGeometry(tube, fins(), clearance)).toThrow(/clearance/i);
    }
    expect(() => finAlignmentJigGeometry(tube, { ...fins(), cant: 0.01 }, 0)).toThrow(/cant/i);
    expect(() => finAlignmentJigGeometry(tube, { ...fins(), thickness: 0 }, 0)).toThrow(/thickness/i);
    expect(() => finAlignmentJigGeometry({ ...tube, outerRadius: 0.002 }, fins(8), 0)).toThrow(/overlap/i);
    expect(() => finAlignmentJigGeometry({ ...tube, type: 'transition' }, fins(), 0)).toThrow(/body tube/i);
    expect(JSON.stringify(tube)).toBe(before);
  });
});
