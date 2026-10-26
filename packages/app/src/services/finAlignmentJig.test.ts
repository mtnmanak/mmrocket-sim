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

it.each(['rounded', 'airfoil'])('refuses a zero-area %s fin set with positive height', crossSection => {
  const collapsed: ComponentNode = { type: 'trapezoidfinset', rootChord: 0, tipChord: 0,
    height: 0.04, thickness: 0.003, crossSection };
  expect(() => finAlignmentJigGeometry(tube, collapsed, 0)).toThrow(/positive area/i);
});

describe('N049 fin alignment jig', () => {
  it.each([
    ['mm', '0.15 mm', '0.2 mm'],
    ['cm', '0.015 cm', '0.02 cm'],
    ['m', '0.00015 m', '0.0002 m'],
    ['in', '0.00591 in', '0.00787 in'],
    ['ft', '0.000492 ft', '0.000656 ft'],
  ])('retains small clearance and slot dimensions in %s', (length, clearance, slot) => {
    const svg = finAlignmentJigSvg(tube, { ...fins(), thickness: 0.00005 }, 0.00015, 'Rocket', { length, angle: '\u00b0' });
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(doc.documentElement.textContent).toContain(`slot width ${slot}`);
    expect(doc.documentElement.textContent).toContain(`fin thickness + ${clearance} total clearance`);
  });

  it.each([3, 4])('contains the full rectangular freeform fin section in all %i closed slots', count => {
    for (const crossSection of ['rounded', 'airfoil']) {
      const fin = { ...fins(count), crossSection,
        points: [[0, 0], [0, 0.04], [0.08, 0.04], [0.08, 0]] };
      const g = finAlignmentJigGeometry(tube, fin, 0.0002);
      for (const slot of g.slots) {
        const radial = ([x, y]: [number, number]) => x * Math.sin(slot.angle) - y * Math.cos(slot.angle);
        const lateral = ([x, y]: [number, number]) => x * Math.cos(slot.angle) + y * Math.sin(slot.angle);
        // This rectangular outline has a 40 mm section at every station of its 80 mm chord.
        // Sample both stock faces from the tube surface through the tip: none may meet jig material.
        for (const span of [0, 0.01, 0.02, 0.03, 0.04]) {
          for (const face of [-0.0015, 0.0015]) {
            expect(0.025 + span).toBeGreaterThanOrEqual(radial(slot.inner[0]) - 1e-12);
            expect(0.025 + span).toBeLessThanOrEqual(radial(slot.outer[0]) + 1e-12);
            expect(face).toBeGreaterThanOrEqual(lateral(slot.outer[0]) - 1e-12);
            expect(face).toBeLessThanOrEqual(lateral(slot.outer[1]) + 1e-12);
          }
        }
      }
      const doc = new DOMParser().parseFromString(
        finAlignmentJigSvg(tube, fin, 0.0002, 'Rocket', { length: 'mm', angle: '°' }), 'image/svg+xml');
      const edge = doc.querySelector('#jig-outer-edge')!;
      const cx = Number(edge.getAttribute('cx')), cy = Number(edge.getAttribute('cy'));
      const path = doc.querySelector('#tube-and-slots')!.getAttribute('d')!;
      const ends = [...path.matchAll(/L ([-\d.]+) ([-\d.]+) L ([-\d.]+) ([-\d.]+) L /g)];
      expect(ends).toHaveLength(count);
      ends.forEach((end, i) => {
        const angle = g.slots[i]!.angle;
        const depth = (Number(end[1]) - cx) * Math.sin(angle) - (Number(end[2]) - cy) * Math.cos(angle);
        // Two serialized coordinates round to 0.0001 mm, allowing 0.00015 mm projection error.
        expect(depth).toBeGreaterThanOrEqual(65 - 0.00015);
      });
    }
  });

  it.each([0.003, 0.15])('leaves at least 10 mm of material beyond every corner with %s m fin stock', thickness => {
    const wideTube = { ...tube, outerRadius: 0.1 };
    const wideFin = { ...fins(3, 'trapezoidfinset'), height: 0.2, thickness };
    const g = finAlignmentJigGeometry(wideTube, wideFin, 0);
    for (const slot of g.slots) {
      for (const corner of slot.outer) {
        // Pure SI geometry; 1e-12 m allows rotation arithmetic roundoff, not a fit allowance.
        expect(g.outerRadius - Math.hypot(...corner)).toBeGreaterThanOrEqual(0.01 - 1e-12);
      }
    }
    const doc = new DOMParser().parseFromString(
      finAlignmentJigSvg(wideTube, wideFin, 0, 'Rocket', { length: 'mm', angle: '°' }), 'image/svg+xml');
    const edge = doc.querySelector('#jig-outer-edge')!;
    const cx = Number(edge.getAttribute('cx')), cy = Number(edge.getAttribute('cy'));
    const radius = Number(edge.getAttribute('r'));
    const path = doc.querySelector('#tube-and-slots')!.getAttribute('d')!;
    const ends = [...path.matchAll(/L ([-\d.]+) ([-\d.]+) L ([-\d.]+) ([-\d.]+) L /g)];
    expect(ends).toHaveLength(3);
    for (const end of ends) {
      for (const index of [1, 3]) {
        // Radius, centre and corner each round to 0.0001 mm: allow 0.0002 mm total error.
        expect(radius - Math.hypot(Number(end[index]) - cx, Number(end[index + 1]) - cy)).toBeGreaterThanOrEqual(10 - 0.0002);
      }
    }
  });

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
