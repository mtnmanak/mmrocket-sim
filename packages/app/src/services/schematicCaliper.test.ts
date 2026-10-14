import { describe, expect, it } from 'vitest';
import { caliperDistances, caliperReadout, schematicSnapTargets, snapCaliperPoint } from './schematicCaliper.js';
import { layoutSchematic, type SchematicLayout } from '../tree/schematicLayout.js';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';

const finTree = { name: 'Rotated freeform fins', components: [{ id: 'b', type: 'bodytube', length: 0.2, outerRadius: 0.02,
  children: [{ id: 'f', type: 'freeformfinset', finCount: 3, rotation: -Math.PI / 9,
    points: [[0, 0], [0.01, 0.06], [0.04, 0.06], [0.05, 0]] }],
}] } as RocketTree;
const finCtx = { scale: 1000, x0: 50, cy: 100, roll: 0, idPrefix: 'caliper' };

describe('N044 projected caliper geometry', () => {
  it.each(['innertube', 'tubecoupler', 'centeringring', 'bulkhead', 'engineblock',
    'masscomponent', 'parachute', 'streamer', 'shockcord', 'launchlug', 'railbutton', 'fairing', 'protuberance',
    'podset', 'parallelstage'])('offers no snap targets for dropped type %s', type => {
    const tree = { name: 'Free picks', components: [{ id: 'b', type: 'bodytube', length: 2,
      outerRadius: 0.02, thickness: 0.002, children: [{ id: 'dropped', type, length: 0.05,
        outerRadius: 0.009, radius: 0.009, packedRadius: 0.009, height: 0.03, width: 0.01,
        outerDiameter: 0.0044, totalHeight: 0.006, instanceCount: 2,
        fairingForeShape: 'box', fairingAftShape: 'box', thickness: 0.001,
        position: { method: 'top', offset: 0.1 } } as ComponentNode] }] } as RocketTree;
    for (const walls of [false, true]) for (const measuring of [false, true]) for (const scale of [126, 1000]) {
      const layout = layoutSchematic(tree, { ...finCtx, walls, measuring, scale });
      const dropped = layout.shapes.filter(s => s.part?.id === 'dropped' || s.attrs['data-wall'] === 'dropped');
      if (!['podset', 'parallelstage'].includes(type)) expect(dropped.length).toBeGreaterThan(0);
      expect(dropped.every(s => s.snap === undefined)).toBe(true);
      expect(schematicSnapTargets({ ...layout, shapes: dropped })).toEqual([]);
    }
  });

  it('keeps walls, bores and shoulders out of the airframe outer-profile targets', () => {
    const tree = { name: 'Outer only', components: [
      { id: 'n', type: 'nosecone', length: 0.1, aftRadius: 0.02,
        shoulderLength: 0.02, shoulderRadius: 0.018, shoulderThickness: 0.001 },
      { id: 'b', type: 'bodytube', length: 0.2, outerRadius: 0.02, thickness: 0.002 },
      { id: 't', type: 'transition', length: 0.05, foreRadius: 0.02, aftRadius: 0.01, thickness: 0.001,
        foreShoulderLength: 0.01, foreShoulderRadius: 0.018, foreShoulderThickness: 0.001 },
    ] } as RocketTree;
    const plain = layoutSchematic(tree, { ...finCtx, walls: false });
    const cut = layoutSchematic(tree, { ...finCtx, walls: true });
    expect(schematicSnapTargets(cut)).toEqual(schematicSnapTargets(plain));
    const inside = cut.shapes.filter(s => s.attrs['data-wall'] || s.key.includes('shoulder'));
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.every(s => s.snap === undefined)).toBe(true);
  });

  it('reads absolute projected distances in mm and inches, including the diagonal', () => {
    const a = { x: 0.1, y: -0.02 }, b = { x: 0.13, y: 0.02 };
    const d = caliperDistances(a, b);
    expect(d.horizontal).toBeCloseTo(0.03, 12);
    expect(d.vertical).toBeCloseTo(0.04, 12);
    expect(d.straight).toBeCloseTo(0.05, 12);
    expect(caliperReadout(a, b, 'mm')).toBe('Horizontal 30 mm · Vertical 40 mm · Straight 50 mm');
    expect(caliperReadout(a, b, 'in')).toBe('Horizontal 1.181 in · Vertical 1.575 in · Straight 1.969 in');
    expect(caliperDistances(b, a)).toEqual(d);
  });

  it('offers physical elliptical root and tip stations without the display-height floor', () => {
    const tree = { name: 'Small ellipse', components: [{ id: 'b', type: 'bodytube', length: 2, outerRadius: 0.02,
      children: [{ id: 'e', type: 'ellipticalfinset', rootChord: 0.01, height: 0.001, finCount: 1,
        position: { method: 'top', offset: 0.1 } }] }] } as RocketTree;
    const ctx = { scale: 126, x0: 50, cy: 100, roll: 0, idPrefix: 'ellipse' };
    const targets = schematicSnapTargets(layoutSchematic(tree, ctx));
    for (const [x, y] of [[0.1, 0.02], [0.105, 0.021], [0.11, 0.02]]) {
      expect(targets.some(p => Math.hypot(p.x - x!, p.y - y!) < 1e-12)).toBe(true);
    }
    expect(targets.every(p => p.y <= 0.021)).toBe(true);
  });

  it('snaps only within a screen-sized radius and keeps arbitrary points otherwise', () => {
    const target = { x: 0.1, y: 0.02 };
    expect(snapCaliperPoint({ x: 0.103, y: 0.02 }, [target], 0.004)).toEqual(target);
    expect(snapCaliperPoint({ x: 0.103, y: 0.02 }, [target], 0.001)).toEqual({ x: 0.103, y: 0.02 });
    expect(snapCaliperPoint({ x: 0, y: 0 }, [], 1)).toEqual({ x: 0, y: 0 });
  });

  it('takes only outer tube corners from each drawn instance in SI', () => {
    const tree = { name: 'T', components: [{ id: 'b', type: 'bodytube', length: 0.2, outerRadius: 0.01 }] } as RocketTree;
    const ctx = { scale: 1000, x0: 50, cy: 100 };
    const targets = schematicSnapTargets(layoutSchematic(tree, { ...ctx, roll: 0, idPrefix: 't' }));
    for (const p of [{ x: 0, y: 0.01 }, { x: 0.2, y: -0.01 }]) {
      expect(targets.some(t => Math.hypot(t.x - p.x, t.y - p.y) < 1e-12)).toBe(true);
    }
    expect(targets.some(p => p.y === 0)).toBe(false);
  });

  it('does not attract a pick to a freeform fin root hidden by the airframe clip', () => {
    const layout = layoutSchematic(finTree, finCtx);
    const fin = layout.shapes.find(s => s.part?.id === 'f' && s.tag === 'polygon' && s.attrs['clipPath'])!;
    expect(fin).toBeDefined();
    const root = { x: 0.15, y: 0.02 * Math.cos(-Math.PI / 9 + 4 * Math.PI / 3) };
    const clip = layout.clips.find(c => fin.attrs['clipPath'] === `url(#${c.id})`)!;
    const rootY = finCtx.cy - root.y * finCtx.scale;
    expect(rootY).toBeGreaterThan(clip.top);
    expect(rootY).toBeLessThan(clip.bottom);
    const targets = schematicSnapTargets(layout);
    expect(targets.some(t => Math.hypot(t.x - root.x, t.y - root.y) < 1e-12)).toBe(false);
    const pick = { x: root.x + 0.003, y: root.y };
    const snapped = snapCaliperPoint(pick, targets, 0.008);
    const cornerX = 0.15 + 0.01 * (-0.02 - root.y) / (3 * root.y);
    expect(snapped.x).toBeCloseTo(cornerX, 12);
    expect(snapped.y).toBeCloseTo(-0.02, 12);
    // Analytic projection tolerances cover JS trigonometric rounding, not kernel results.
    expect(caliperDistances(pick, { x: 0.2, y: pick.y }).horizontal).toBeCloseTo(0.047, 12);
    expect(caliperDistances(snapped, { x: 0.2, y: snapped.y }).horizontal).toBeCloseTo(0.2 - cornerX, 12);
    const tip = { x: 0.16, y: 4 * root.y };
    expect(targets.some(t => Math.hypot(t.x - tip.x, t.y - tip.y) < 1e-12)).toBe(true);
  });

  it('offers the new freeform fin corners where its sloping edges meet the clip', () => {
    const targets = schematicSnapTargets(layoutSchematic(finTree, finCtx));
    const p = Math.cos(-Math.PI / 9 + 4 * Math.PI / 3);
    const fraction = (-0.02 - 0.02 * p) / (0.06 * p);
    for (const x of [0.15 + 0.01 * fraction, 0.2 - 0.01 * fraction]) {
      const corner = { x, y: -0.02 };
      expect(targets.some(t => Math.hypot(t.x - x, t.y + 0.02) < 1e-12)).toBe(true);
      const snapped = snapCaliperPoint({ x, y: -0.021 }, targets, 0.002);
      expect(snapped.x).toBeCloseTo(corner.x, 12);
      expect(snapped.y).toBeCloseTo(corner.y, 12);
    }
  });

  it('retains displayed in-body wireframe roots when rolled, excluding invisible hit surfaces', () => {
    const ctx = { ...finCtx, roll: 0.1 };
    const layout = layoutSchematic(finTree, ctx);
    const root = { x: 0.15, y: 0.02 * Math.cos(-Math.PI / 9 + 4 * Math.PI / 3 + ctx.roll) };
    const wire = layout.shapes.find(s => s.part?.id === 'f' && s.key.endsWith(':fin2'))!;
    expect(wire.attrs['data-fin']).toBe('wire');
    expect(wire.attrs['clipPath']).toBeUndefined();
    expect(Math.abs(root.y)).toBeLessThan(0.02);
    const targets = schematicSnapTargets(layout);
    const snapped = snapCaliperPoint({ x: root.x + 0.001, y: root.y }, targets, 0.002);
    expect(snapped.x).toBeCloseTo(root.x, 12);
    expect(snapped.y).toBeCloseTo(root.y, 12);
    const drawnOnly = { ...layout, shapes: layout.shapes.filter(s => !s.part?.hit) };
    expect(targets).toEqual(schematicSnapTargets(drawnOnly));
  });

  it.each([
    { tag: 'rect' as const, attrs: { x: 100, y: 70, width: 60, height: 60 } },
    { tag: 'polygon' as const, attrs: { points: '100,70 160,100 100,130' } },
    { tag: 'path' as const, attrs: { d: 'M 100 90 L 160 90 L 160 130 L 100 130 Z' } },
  ])('clips explicit physical stations independently of the decorative $tag', ({ tag, attrs }) => {
    const layout: SchematicLayout = { shapes: [{ key: 'clipped', layer: 'base', tag,
      attrs: { ...attrs, clipPath: 'url(#clip)' }, part: { id: 'part', name: 'Part', grip: false },
      snap: { points: [[0.05, 0.03], [0.11, 0.03], [0.11, -0.03], [0.05, -0.03]],
        outline: [[0.05, 0.03], [0.11, 0.03], [0.11, -0.03], [0.05, -0.03]], hiddenBand: [-0.02, 0.02] } }],
      clips: [{ id: 'clip', top: 80, bottom: 120 }], extents: new Map(), grips: new Map() };
    const targets = schematicSnapTargets(layout);
    expect(targets.some(t => t.y > -0.02 && t.y < 0.02)).toBe(false);
    expect(targets).toContainEqual({ x: 0.05, y: -0.03 });
    expect(targets).toContainEqual({ x: 0.11, y: -0.03 });
    expect(targets).toContainEqual({ x: 0.05, y: -0.02 });
    expect(targets).toContainEqual({ x: 0.11, y: -0.02 });
    expect(targets).toContainEqual({ x: 0.05, y: 0.02 });
    expect(targets).toContainEqual({ x: 0.11, y: 0.02 });
    expect(schematicSnapTargets({ ...layout, shapes: layout.shapes.map(s => ({ ...s, snap: undefined })) })).toEqual([]);
    expect(schematicSnapTargets({ ...layout, shapes: layout.shapes.map(s => ({ ...s, part: { ...s.part!, hit: true } })) })).toEqual([]);
  });
});
