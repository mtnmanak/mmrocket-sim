import { describe, expect, it } from 'vitest';
import type { ComponentNode } from '@online-openrocket/engine';
import { paperTemplateGeometry, paperTemplatePages } from './paperTemplates.js';
import { INITIAL_UNITS, IMPERIAL_UNITS } from '../prefs/units.js';

const node = (type: string, fields = {}): ComponentNode => ({ type, name: 'Part <&>', ...fields } as ComponentNode);

describe('C-A7 paper geometry', () => {
  it('uses the stated ring ID before the adjacent mount OD, without changing the node', () => {
    const ring = node('centeringring', { outerRadius: 0.05, innerRadius: 0.015 });
    const before = JSON.stringify(ring);
    const g = paperTemplateGeometry(ring, { mountOuterRadius: 0.02 });
    expect(g.kind).toBe('disc');
    expect(g.circles).toEqual([0.05, 0.015]);
    expect(JSON.stringify(ring)).toBe(before);
    expect(paperTemplateGeometry(node('centeringring'), { parentInnerRadius: 0.05, mountOuterRadius: 0.02 }).circles)
      .toEqual([0.05, 0.02]);
  });
  it('prints solid bulkheads and refuses unknown or impossible ring bores and outside diameters', () => {
    expect(paperTemplateGeometry(node('bulkhead'), { parentInnerRadius: 0.04 }).circles).toEqual([0.04]);
    expect(() => paperTemplateGeometry(node('bulkhead'), {})).toThrow(/diameter/);
    expect(() => paperTemplateGeometry(node('centeringring', { outerRadius: 0.04 }), {})).toThrow(/bore/);
    expect(() => paperTemplateGeometry(node('centeringring', { outerRadius: 0.04 }), { mountOuterRadius: 0.05 })).toThrow(/bore/);
  });
  it('preserves an explicit zero bore as a solid disc even with an overlapping mount', () => {
    const g = paperTemplateGeometry(node('centeringring', { outerRadius: 0.04, innerRadius: 0 }),
      { parentInnerRadius: 0.03, mountOuterRadius: 0.01 });
    expect(g.circles).toEqual([0.04]);
    expect(g.dimensions).toContainEqual(['Opening diameter', 0]);
  });
  it.each([0, -0.02, NaN, Infinity])('refuses stated outside radius %s despite available context', outerRadius => {
    for (const type of ['centeringring', 'bulkhead']) {
      expect(() => paperTemplateGeometry(node(type, { outerRadius, innerRadius: 0.01 }),
        { parentInnerRadius: 0.03, mountOuterRadius: 0.01 })).toThrow(/diameter|finite/);
    }
  });
  it.each([-0.01, 0.04, 0.05, NaN, Infinity])('refuses stated bore %s despite an overlapping mount', innerRadius => {
    expect(() => paperTemplateGeometry(node('centeringring', { outerRadius: 0.04, innerRadius }),
      { mountOuterRadius: 0.01 })).toThrow(/bore|finite/);
  });
  it('develops a frustum with exact circumference at BOTH ends in either orientation', () => {
    for (const [foreRadius, aftRadius] of [[0.02, 0.05], [0.05, 0.02]]) {
      const g = paperTemplateGeometry(node('transition', { shape: 'conical', length: 0.12, foreRadius, aftRadius }), {});
      expect(g.kind).toBe('wrap');
      // Pure geometry: 12 digits is comfortably above SVG's 0.0001 mm resolution.
      expect(g.sector!.outer * g.sector!.angle).toBeCloseTo(2 * Math.PI * 0.05, 12);
      expect(g.sector!.inner * g.sector!.angle).toBeCloseTo(2 * Math.PI * 0.02, 12);
      expect(g.sector!.outer - g.sector!.inner).toBeCloseTo(Math.hypot(0.12, 0.03), 12);
    }
  });
  it('handles a conical tip, an equal-radius cylinder, and resolved automatic ends', () => {
    expect(paperTemplateGeometry(node('nosecone', { shape: 'conical', length: 0.1, aftRadius: 0.03 }), {}).sector!.inner).toBe(0);
    const cylinder = paperTemplateGeometry(node('transition', { shape: 'conical', length: 0.1, foreRadius: 0.03, aftRadius: 0.03 }), {});
    expect(cylinder.width).toBeCloseTo(2 * Math.PI * 0.03, 12);
    expect(cylinder.height).toBe(0.1);
    expect(paperTemplateGeometry(node('transition'), { foreRadius: 0.02, aftRadius: 0.03 }).kind).toBe('wrap');
    expect(() => paperTemplateGeometry(node('transition'), {})).toThrow(/radii/);
  });
  it('uses curved profiles and fore-to-aft stations, including flipped noses, instead of false flat wraps', () => {
    const n = node('nosecone', { shape: 'ellipsoid', length: 0.1, aftRadius: 0.03 });
    const g = paperTemplateGeometry(n, {});
    expect(g.kind).toBe('profile');
    expect(g.stations[0]).toEqual([0, 0]);
    expect(g.stations.at(-1)).toEqual([0.1, 0.03]);
    expect(g.stations[4]![1]).toBeCloseTo(0.03 * Math.sqrt(0.75), 12);
    const tail = paperTemplateGeometry({ ...n, flipped: true }, {});
    expect(tail.stations[0]).toEqual([0, 0.03]);
    expect(tail.stations.at(-1)).toEqual([0.1, 0]);
    expect(g.notes.join(' ')).toMatch(/not a flat wrap/);
    expect(() => paperTemplateGeometry(node('nosecone', { length: Infinity }), {})).toThrow();
  });
});

describe('C-A7 physical pages', () => {
  it('keeps true millimetre dimensions, escapes labels, and changes ruler and station units with preferences', () => {
    const g = paperTemplateGeometry(node('nosecone', { shape: 'ellipsoid', length: 0.1, aftRadius: 0.03 }), {});
    const metric = paperTemplatePages(g, 'Rocket <&>', INITIAL_UNITS);
    const imperial = paperTemplatePages(g, 'Rocket <&>', IMPERIAL_UNITS);
    expect(metric[0]!.svg).toContain('width="210mm" height="279mm"');
    expect(metric[0]!.svg).toContain('x2="65"');
    expect(imperial[0]!.svg).toContain('x2="65.8"');
    expect(imperial[0]!.svg).toContain('2 in');
    expect(metric[0]!.svg).toContain('Rocket &lt;&amp;&gt;');
    expect(imperial[0]!.svg).toContain('3.937 in');
    expect(metric[0]!.svg).toContain('100%, no fit to page');
  });
  it('tiles large parts without scaling, with overlaps and a ruler on every sheet, and bounds page count', () => {
    const g = paperTemplateGeometry(node('bulkhead', { outerRadius: 0.2 }), {});
    const pages = paperTemplatePages(g, 'Rocket', INITIAL_UNITS);
    expect(pages).toHaveLength(9);
    expect(pages[1]!.x - pages[0]!.x).toBeCloseTo(0.17, 12);
    for (const p of pages) {
      expect(p.svg).toContain('calibration-ruler');
      expect(p.svg).toContain('r="200.0000"');
      expect(p.svg).toContain('10 mm overlap');
    }
    // Adjacent sheets must repeat GLOBAL grid coordinates in the overlap.
    expect(pages[0]!.svg).toContain('x="194" y="84"');
    expect(pages[1]!.svg).toContain('x="24" y="84"');
    expect(() => paperTemplatePages({ ...g, width: 1e8 }, 'Rocket', INITIAL_UNITS)).toThrow(/100 pages/);
  });
});
it('labels the fore/aft wrap diameters and ring opening in the selected unit', () => {
  const transition = paperTemplateGeometry(node('transition', { length: 0.1, foreRadius: 0.02, aftRadius: 0.05 }), {});
  expect(paperTemplatePages(transition, 'Rocket', INITIAL_UNITS)[0]!.svg).toContain('Fore diameter 40 mm; Aft diameter 100 mm');
  const ring = paperTemplateGeometry(node('centeringring', { outerRadius: 0.05, innerRadius: 0.02 }), {});
  expect(paperTemplatePages(ring, 'Rocket', INITIAL_UNITS)[0]!.svg).toContain('Outside diameter 100 mm; Opening diameter 40 mm');
});
