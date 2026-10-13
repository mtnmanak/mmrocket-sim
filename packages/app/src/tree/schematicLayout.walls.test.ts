import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { layoutSchematic, schematicFrame } from './schematicLayout.js';
import { caliperDistances, schematicSnapTargets, snapCaliperPoint } from '../services/schematicCaliper.js';

const tree = { name: 'Walls', components: [{ id: 's', type: 'stage', children: [
  { id: 'n', type: 'nosecone', length: 0.1, aftRadius: 0.02, shoulderLength: 0.02, shoulderRadius: 0.018, shoulderThickness: 0.001 },
  { id: 'b', type: 'bodytube', length: 0.2, outerRadius: 0.02, thickness: 0.002, children: [
    { id: 'i', type: 'innertube', length: 0.1, outerRadius: 0.01, thickness: 0.001 },
    { id: 'c', type: 'tubecoupler', length: 0.03, thickness: 0.001 },
  ] },
  { id: 't', type: 'transition', length: 0.05, foreRadius: 0.02, aftRadius: 0.01, thickness: 0.001 },
] }] } as RocketTree;
const options = { scale: 1000, x0: 0, cy: 100, roll: 0, idPrefix: 'w' };

describe('N033 schematic walls', () => {
  it.each([
    { type: 'nosecone', flipped: false, prefix: '', key: 'n:shoulder', start: 100, end: 120, fore: false },
    { type: 'nosecone', flipped: true, prefix: '', key: 'n:shoulder', start: -20, end: 0, fore: true },
    { type: 'transition', prefix: 'fore', key: 'n:shoulder-fore', start: -20, end: 0, fore: true },
    { type: 'transition', prefix: 'aft', key: 'n:shoulder-aft', start: 100, end: 120, fore: false },
  ])('places the cap at the closed end of $key ($type flipped $flipped)', ({ type, flipped, prefix, key, start, end, fore }) => {
    const layout = (capped: boolean, length = 0.02, thickness = 0.001) => layoutSchematic({ name: 'Caps', components: [
      { id: 'n', type, flipped, length: 0.1, aftRadius: 0.02, foreRadius: 0.02,
        [`${prefix}ShoulderLength`.replace(/^Shoulder/, 'shoulder')]: length,
        [`${prefix}ShoulderRadius`.replace(/^Shoulder/, 'shoulder')]: 0.018,
        [`${prefix}ShoulderThickness`.replace(/^Shoulder/, 'shoulder')]: thickness,
        [`${prefix}ShoulderCapped`.replace(/^Shoulder/, 'shoulder')]: capped } as ComponentNode,
    ] }, { ...options, walls: true });
    const path = (capped: boolean, length?: number, thickness?: number) =>
      String(layout(capped, length, thickness).shapes.find(s => s.attrs['data-wall'] === key)!.attrs['d']);
    const coordinates = (d: string) => d.match(/[-\d.]+/g)!.map(Number);
    for (const capped of [false, true]) {
      const coords = coordinates(path(capped));
      // 1000 px/m: 1 mm cap, 17 mm bore; only arithmetic rounding is allowed.
      const outer = [start, 82, end, 82, end, 118, start, 118];
      coords.slice(0, 8).forEach((v, i) => expect(v).toBeCloseTo(outer[i]!, 10));
      const boreStart = start + (capped && fore ? 1 : 0);
      const boreEnd = end - (capped && !fore ? 1 : 0);
      const want = [boreStart, 83, boreEnd, 83, boreEnd, 117, boreStart, 117];
      coords.slice(8).forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 10));
      expect(coords).toHaveLength(16);
    }
    for (const length of [0.001, 0.0005]) {
      expect(path(false, length).match(/M /g)).toHaveLength(2);
      expect(path(true, length).match(/M /g)).toHaveLength(1);
      const outline = layout(true, length).shapes.find(s => s.key === key)!;
      expect(Number(outline.attrs['width'])).toBeCloseTo(length * 1000, 10);
    }
    expect(layout(true, 0.02, 0).shapes.some(s => s.attrs['data-wall'] === key)).toBe(false);
  });

  it.each([false, true])('keeps subpixel tube ends physical with walls %s', (walls) => {
    const short = { name: 'Short tubes', components: [{ id: 'b', type: 'bodytube', length: 2,
      outerRadius: 0.02, children: [
        { id: 'i', type: 'innertube', length: 0.002, outerRadius: 0.01, thickness: 0.001,
          position: { method: 'top', offset: 0.1 } },
        { id: 'c', type: 'tubecoupler', length: 0.01, outerRadius: 0.008, thickness: 0.001,
          position: { method: 'top', offset: 0.2 } },
      ] }] } as RocketTree;
    const frame = schematicFrame(short, { cw: 360, chPx: 240, maxHeight: 480,
      rulers: true, rollW: 26, rollBar: 0, lanes: false, topReserve: 0, bottomReserve: 80 });
    const lay = layoutSchematic(short, { ...options, ...frame, walls, measuring: true });
    const targets = schematicSnapTargets(lay, frame);
    for (const [id, start, length, radius] of [['i', 0.1, 0.002, 0.01], ['c', 0.2, 0.01, 0.008]] as const) {
      const outline = lay.shapes.find(s => s.part?.id === id && !s.part.hit && s.tag === 'rect')!;
      expect(Number(outline.attrs['width']) / frame.scale).toBeCloseTo(length, 12);
      const hit = lay.shapes.find(s => s.part?.id === id && s.part.hit)!;
      expect(Number(hit.attrs['width'])).toBe(2);
      expect(hit.part?.grip).toBe(true);
      // A zoom changes the screen snap radius, not the end stations (rounding only).
      for (const zoom of [1, 4]) {
        const a = snapCaliperPoint({ x: start, y: radius }, targets, 8 / (frame.scale * zoom));
        const b = snapCaliperPoint({ x: start + length, y: radius }, targets, 8 / (frame.scale * zoom));
        expect(caliperDistances(a, b).horizontal).toBeCloseTo(length, 12);
        expect(targets.some(p => Math.abs(p.x - (start + 2 / frame.scale)) < 1e-12
          && Math.abs(p.y - radius) < 1e-12)).toBe(false);
      }
      if (walls) {
        const coords = String(lay.shapes.find(s => s.attrs['data-wall'] === id)!.attrs['d']).match(/[-\d.]+/g)!.map(Number);
        expect(coords[2]! - coords[0]!).toBeCloseTo(length * frame.scale, 12);
      }
    }
  });

  it.each([false, true])('uses effective nested tube diameters when measuring with walls %s', (walls) => {
    const nested = { name: 'Fitting tubes', components: [{ id: 'b', type: 'bodytube',
      length: 0.2, outerRadius: 0.02, thickness: 0.0003, children: [
        { id: 'i', type: 'innertube', length: 0.1, outerRadius: 0.019, thickness: 0.0005 },
        { id: 'c', type: 'tubecoupler', length: 0.05, thickness: 0.001, children: [
          { id: 'nested', type: 'tubecoupler', length: 0.02, thickness: 0.001 },
        ] },
      ] }] } as RocketTree;
    const lay = layoutSchematic(nested, { ...options, walls, measuring: true });
    for (const [id, diameter] of [['i', 38], ['c', 39.4], ['nested', 37.4]] as const) {
      const outline = lay.shapes.find(s => s.part?.id === id && s.tag === 'rect')!;
      // At 1000 px/m, pixels equal mm; allow only JS arithmetic rounding.
      expect(Number(outline.attrs['height'])).toBeCloseTo(diameter, 10);
    }
  });

  it('preserves the physical aft ruler station below the fit floor while reserving caliper space', () => {
    const short = { name: 'Short', components: [
      { id: 'b', type: 'bodytube', length: 0.03, outerRadius: 0.001 },
    ] } as RocketTree;
    const f = schematicFrame(short, { cw: 360, chPx: 240, fillHeight: true, maxHeight: 480,
      rulers: true, rollW: 26, rollBar: 0, lanes: false, topReserve: 0, bottomReserve: 80 });
    expect(f.axialLen).toBeCloseTo(0.03, 12);
    expect(f.totalLen).toBe(0.05);
    expect(f.cy + f.vHalf * f.scale).toBeLessThan(f.h - 80);
  });

  it('keeps phone-width geometry above the caliper readout at a constrained viewer height', () => {
    const f = schematicFrame(tree, { cw: 360, chPx: 240, fillHeight: true, maxHeight: 480,
      rulers: true, rollW: 26, rollBar: 0, lanes: true, topReserve: 0, bottomReserve: 80 });
    const drawing = schematicFrame(tree, { cw: 360, chPx: 200, fillHeight: true, maxHeight: 480,
      rulers: true, rollW: 26, rollBar: 0, lanes: true, topReserve: 0 });
    expect(f.w).toBe(360);
    expect(f.h).toBeGreaterThanOrEqual(280); // Keep the existing 200 px drawing plus its readout.
    expect(f.cy + f.vHalf * f.scale).toBeLessThan(f.h - 80);
    expect(f.scale).toBe(drawing.scale);
    expect(f.cy).toBe(drawing.cy); // The readout adds space below the existing drawing.
    expect(f.h).toBe(drawing.h + 80);
  });
  it('is opt-in and preserves selection geometry and source data', () => {
    const before = JSON.stringify(tree);
    const plain = layoutSchematic(tree, options);
    const cut = layoutSchematic(tree, { ...options, walls: true });
    expect(plain.shapes.some(s => s.attrs['data-wall'])).toBe(false);
    expect(cut.shapes.filter(s => s.attrs['data-wall']).map(s => s.attrs['data-wall'])).toEqual(['b', 't', 'n:shoulder', 'i', 'c']);
    expect(cut.extents.get('b')).toEqual(plain.extents.get('b'));
    expect(cut.shapes.find(s => s.key === 'b:body')?.part).toEqual(plain.shapes.find(s => s.key === 'b:body')?.part);
    expect(cut.grips).toEqual(plain.grips);
    expect(JSON.stringify(tree)).toBe(before);
    const band = cut.shapes.find(s => s.attrs['data-wall'] === 'b')!;
    expect(band.attrs['d']).toContain('80'); // 20 mm outer radius at cy 100.
    expect(band.attrs['d']).toContain('82'); // 18 mm bore.
    const coupler = cut.shapes.find(s => s.attrs['data-wall'] === 'c')!;
    expect(coupler.attrs['d']).toContain('82'); // Automatic radius is the parent's bore.
    expect(coupler.attrs['d']).toContain('83');
  });

  it('does not exaggerate thin or zero walls; filled tubes have no bore', () => {
    const lay = (thickness: number, filled = false) => layoutSchematic({ name: 'T', components: [
      { id: 'b', type: 'bodytube', length: 0.2, outerRadius: 0.02, thickness, filled },
    ] } as RocketTree, { ...options, walls: true });
    expect(lay(0).shapes.some(s => s.attrs['data-wall'])).toBe(false);
    const coords = String(lay(0.00001).shapes.find(s => s.attrs['data-wall'])!.attrs['d']).match(/[\d.]+/g)!.map(Number);
    expect(coords[9]).toBeCloseTo(80.01, 10); // 10 micrometres remain 0.01 px at this scale.
    expect(String(lay(0.001, true).shapes.find(s => s.attrs['data-wall'])!.attrs['d']).match(/M /g)).toHaveLength(1);
  });

  it('uses defaults and automatic transition ends, with bands at both transition shoulders', () => {
    const auto = { name: 'Automatic', components: [{ id: 's', type: 'stage', children: [
      { id: 'b', type: 'bodytube', length: 0.1, outerRadius: 0.02 },
      { id: 't', type: 'transition', length: 0.05, foreShoulderLength: 0.01, foreShoulderRadius: 0.018,
        foreShoulderThickness: 0.001, aftShoulderLength: 0.01, aftShoulderRadius: 0.008, aftShoulderThickness: 0.001 },
      { id: 'aft', type: 'bodytube', length: 0.1, outerRadius: 0.01 },
    ] }] } as RocketTree;
    const cut = layoutSchematic(auto, { ...options, walls: true });
    expect(cut.shapes.find(s => s.attrs['data-wall'] === 'b')!.attrs['d']).toContain('80.3');
    const transition = String(cut.shapes.find(s => s.attrs['data-wall'] === 't')!.attrs['d']);
    expect(transition).toContain('100 80'); expect(transition).toContain('150.00000000000003 90');
    expect(cut.shapes.filter(s => s.attrs['data-wall'] && String(s.attrs['data-wall']).startsWith('t:shoulder'))).toHaveLength(2);
  });

  it('draws every clustered and nested tube at its projected location and radius', () => {
    const nested = { name: 'Nested', components: [{ id: 'b', type: 'bodytube', length: 0.2, outerRadius: 0.02, thickness: 0.002, children: [
      { id: 'c', type: 'tubecoupler', length: 0.1, thickness: 0.001, children: [
        { id: 'inner', type: 'tubecoupler', length: 0.02, thickness: 0.001 },
      ] },
      { id: 'i', type: 'innertube', length: 0.03, outerRadius: 0.005, thickness: 0.001, cluster: '3-ring' },
    ] }] } as RocketTree;
    const cut = layoutSchematic(nested, { ...options, walls: true, roll: 0.4 });
    expect(cut.shapes.filter(s => s.attrs['data-wall'] === 'i')).toHaveLength(3);
    expect(cut.shapes.find(s => s.attrs['data-wall'] === 'inner')!.attrs['d']).toContain('83'); // 17 mm outer radius.
  });
});
