import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { isTailCone, noseEnds, tailConeAsTransition } from './tailCone.js';
import { layoutSchematic, schematicFrame } from './schematicLayout.js';
import { buildPieces } from './pieces.js';
import { componentLoop } from './solidMesh.js';
import { solidContextFor } from './solidContext.js';
import { shoulderFit } from './fitHelpers.js';
import { estimateMotorRoom } from './motorRoom.js';
import { FIELDS } from './schema.js';
import { kernelDefault } from './kernelDefaults.js';

/**
 * EVERY READER OF A NOSE CONE'S PROFILE HONOURS THE FLIP (KB2; format audit
 * 2026-09-03 row 30). A tail cone points AFT — base forward, point aft, its
 * shoulder at the front — and the kernel flies it so once ComponentFactory
 * calls NoseCone.setFlipped. Each view, the printed part and the fit and room
 * estimates read the cone's two ends through `noseEnds`, so none of them can
 * go on drawing, printing or measuring the cone the old way round.
 */

const BASE = 0.03;
const L = 0.12;
const tail = (extra: Record<string, unknown> = {}): ComponentNode => ({
  type: 'nosecone', id: 'tc', name: 'Tail', length: L, aftRadius: BASE, thickness: 0.002, shape: 'conical',
  shoulderRadius: 0.0285, shoulderLength: 0.03, shoulderThickness: 0.002, ...extra,
} as ComponentNode);

/** Nose, tube, then the cone under test at the aft end. */
const rocket = (cone: ComponentNode, tubeChildren: Record<string, unknown>[] = []): RocketTree => ({
  name: 'R',
  components: [{
    type: 'stage', id: 's', name: 'S',
    children: [
      { type: 'nosecone', id: 'n', name: 'Nose', length: 0.2, aftRadius: BASE, thickness: 0.002, shape: 'ogive' },
      { type: 'bodytube', id: 'b', name: 'Tube', length: 0.8, outerRadius: BASE, thickness: 0.001, children: tubeChildren },
      cone,
    ],
  } as ComponentNode],
} as RocketTree);

describe('the flip, as one question', () => {
  it('names the ends: point forward, or flipped, base forward', () => {
    expect(noseEnds(tail(), BASE)).toEqual({ fore: 0, aft: BASE });
    expect(noseEnds(tail({ flipped: true }), BASE)).toEqual({ fore: BASE, aft: 0 });
    expect(isTailCone(tail({ flipped: true }))).toBe(true);
    expect(isTailCone({ type: 'transition', flipped: true } as ComponentNode)).toBe(false);
  });

  it('a tail cone as a transition: base forward, point aft, shoulder at the front, nose shape kept', () => {
    const t = tailConeAsTransition(tail({ flipped: true, shape: undefined }));
    expect(t.type).toBe('transition');
    expect(t['shape']).toBe('ogive');
    expect(t['foreRadius']).toBe(BASE);
    expect(t['aftRadius']).toBe(0);
    expect(t['foreShoulderLength']).toBe(0.03);
    expect(t['shoulderLength']).toBeUndefined();
    expect(t['flipped']).toBeUndefined();
  });

  it('keeps the length a blank tail cone flies: a nose cone’s, not a transition’s', () => {
    // A nose cone with no length flies 70 mm, a transition 50 mm (review of v0.174, B1).
    const t = tailConeAsTransition({ type: 'nosecone', flipped: true } as ComponentNode);
    expect(t['length']).toBe(kernelDefault('nosecone', 'length'));
    expect(t['length']).not.toBe(kernelDefault('transition', 'length'));
  });
});

describe('the side view draws a tail cone base-first', () => {
  const FRAME = { cw: 640, chPx: 480, maxHeight: 480, rulers: false, rollW: 0, rollBar: 0, lanes: false, topReserve: 0 };
  const lay = (cone: ComponentNode) => {
    const t = rocket(cone);
    const f = schematicFrame(t, FRAME);
    return { f, l: layoutSchematic(t, { scale: f.scale, cy: f.cy, x0: f.x0, roll: 0, idPrefix: 't' }) };
  };
  /** The outline's first two points: the fore end's top edge, then the next sample aft. */
  const foreRadiusDrawn = (cone: ComponentNode): number => {
    const { f, l } = lay(cone);
    const d = String(l.shapes.find((s) => s.key === 'tc:nose')!.attrs['d']);
    const [, y] = d.replace(/^M\s*/, '').split(/\s*L\s*/)[0]!.split(/\s+/).map(Number);
    return (f.cy - y!) / f.scale;
  };

  it('its outline starts at the base radius, not at a point', () => {
    expect(foreRadiusDrawn(tail())).toBeCloseTo(0, 9);
    expect(foreRadiusDrawn(tail({ flipped: true }))).toBeCloseTo(BASE, 9);
  });

  it('its shoulder is drawn into the tube ahead, not past its own tip', () => {
    /** The shoulder's fore edge, m from the cone's own front. */
    const shoulderX = (cone: ComponentNode) => {
      const { f, l } = lay(cone);
      const outline = String(l.shapes.find((s) => s.key === 'tc:nose')!.attrs['d']);
      const front = Number(outline.replace(/^M\s*/, '').split(/\s+/)[0]);
      return (Number(l.shapes.find((s) => s.key === 'tc:shoulder')!.attrs['x']) - front) / f.scale;
    };
    expect(shoulderX(tail())).toBeCloseTo(L, 6); // behind the cone
    expect(shoulderX(tail({ flipped: true }))).toBeCloseTo(-0.03, 6); // ahead of it
  });
});

describe('the 3D view turns a tail cone base-first', () => {
  type Lathe = { parameters: { points: Array<{ x: number; y: number }> } };
  const lathe = (cone: ComponentNode) =>
    (buildPieces(rocket(cone)).pieces.filter((p) => p.key.startsWith('nose'))[1]!.geometry as unknown as Lathe)
      .parameters.points;

  it('its lathe profile starts wide and ends at the point', () => {
    const pts = lathe(tail({ flipped: true }));
    expect(pts[0]!.x).toBeCloseTo(BASE, 9);
    expect(pts[pts.length - 1]!.x).toBeLessThan(0.001);
    const plain = lathe(tail());
    expect(plain[0]!.x).toBeLessThan(0.001);
    expect(plain[plain.length - 1]!.x).toBeCloseTo(BASE, 9);
  });
});

describe('the printed part is the tail cone the kernel flies', () => {
  it('base forward, the shoulder forward of x = 0, named a tail cone', () => {
    const flat = componentLoop(tail({ flipped: true }), {})!;
    expect(flat.label).toBe('Tail cone');
    expect(Math.min(...flat.loop.map(([x]) => x))).toBeCloseTo(-0.03, 9);
    expect(Math.max(...flat.loop.map(([x]) => x))).toBeCloseTo(L, 9);
    const nose = componentLoop(tail(), {})!;
    expect(nose.label).toBe('Nose cone');
    expect(Math.max(...nose.loop.map(([x]) => x))).toBeCloseTo(L + 0.03, 9);
  });
});

describe('a part inside a tail cone sizes itself to the profile where it sits', () => {
  it('a bulkhead at the front of a tail cone takes the wide end, not the point', () => {
    const bh = { type: 'bulkhead', id: 'bh', length: 0.004, position: { method: 'top', offset: 0 } } as ComponentNode;
    const at = (cone: ComponentNode) => solidContextFor(rocket({ ...cone, children: [bh] }), bh).parentInnerRadius;
    // A conical tail cone's radius at the part's aft face, 4 mm back from the
    // base (the smaller of its two ends), less the 2 mm wall.
    expect(at(tail({ flipped: true }))).toBeCloseTo(BASE * (1 - 0.004 / L) - 0.002, 9);
    expect(at(tail())).toBeUndefined(); // the point: no bore at all
  });
});

describe("Fit shoulder to tube ⌀ fits a tail cone's shoulder into the tube AHEAD", () => {
  it('takes the bore of the tube in front of it', () => {
    const cone = tail({ flipped: true });
    const t = rocket(cone);
    const stage = t.components[0]!;
    // The tube ahead: 30 mm outer, 1 mm wall.
    expect(shoulderFit(t, cone, stage)?.innerR).toBeCloseTo(0.029, 9);
  });

  it('a nose cone at the aft end has no tube behind it to fit', () => {
    const cone = tail();
    const t = rocket(cone);
    expect(shoulderFit(t, cone, t.components[0]!)).toBeNull();
  });
});

describe('the motor-room estimate reads a tail cone the right way round', () => {
  it("a transition behind a tail cone's point narrows going forward, so it stops the motor", () => {
    // Nose, tube, a TAIL CONE, then a transition whose fore end is automatic —
    // the kernel takes it from the cone's aft face, a point — then the tube
    // with the mount. Walking forward, the motor meets the transition first.
    const t: RocketTree = {
      name: 'R',
      components: [{
        type: 'stage', id: 's', name: 'S',
        children: [
          { type: 'nosecone', id: 'n', name: 'Nose', length: 0.2, aftRadius: BASE },
          { type: 'bodytube', id: 'b1', name: 'Upper', length: 0.3, outerRadius: BASE },
          tail({ flipped: true }),
          { type: 'transition', id: 'x', name: 'Flare', length: 0.1, aftRadius: BASE },
          {
            type: 'bodytube', id: 'b2', name: 'Lower', length: 0.5, outerRadius: BASE,
            children: [{ type: 'innertube', id: 'mt', name: 'MMT', length: 0.2, outerRadius: 0.012,
              motorMount: true, position: { method: 'bottom', offset: 0 } }],
          },
        ],
      } as ComponentNode],
    } as RocketTree;
    expect(estimateMotorRoom(t, 'mt')!.limitedBy).toBe('Flare');
  });
});

describe('the panel offers the flip', () => {
  it('a nose cone has a "Flip to tail cone" tick box', () => {
    const f = (FIELDS['nosecone'] ?? []).find((x) => x.key === 'flipped');
    expect(f?.bool).toBe(true);
    expect(f?.label).toBe('Flip to tail cone');
  });
});
