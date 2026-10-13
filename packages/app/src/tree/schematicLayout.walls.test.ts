import { describe, expect, it } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { layoutSchematic, schematicFrame } from './schematicLayout.js';

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
  it('keeps phone-width geometry above the caliper readout at a constrained viewer height', () => {
    const f = schematicFrame(tree, { cw: 360, chPx: 240, fillHeight: true, maxHeight: 480,
      rulers: true, rollW: 26, rollBar: 0, lanes: true, topReserve: 0, bottomReserve: 80 });
    expect(f.w).toBe(360);
    expect(f.h).toBeGreaterThanOrEqual(280); // Keep the existing 200 px drawing plus its readout.
    expect(f.cy + f.vHalf * f.scale).toBeLessThan(f.h - 80);
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
