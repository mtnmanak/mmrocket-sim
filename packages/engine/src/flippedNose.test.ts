import { describe, expect, it } from 'vitest';
import { OrkRocket, type ComponentNode } from './orkEngine.js';

// KB2: requires rebuilding the Java bridge into vendor/orkengine.mjs.
// Intentionally active: the stale kernel must fail, never silently skip this gate.
//
// A FLIPPED nose cone is a tail cone (desktop's "Flip to tail cone", .ork
// <isflipped>): NoseCone.setFlipped moves the base radius and the shoulder to
// the FORE side. The bridge never called it, so a tail cone at the back of a
// rocket flew point-forward: reversed geometry, its solid mass at the wrong
// end, a diameter step against the tube ahead, and the drag and CP of a cone
// facing the wrong way.
const L = 0.12;
const stack = (tail: Record<string, unknown>) => OrkRocket.buildTree({
  name: 'KB2',
  components: [
    { type: 'nosecone', id: 'nose', length: 0.2, aftRadius: 0.03, thickness: 0.002, shape: 'ogive' },
    {
      type: 'bodytube', id: 'body', length: 0.8, outerRadius: 0.03, thickness: 0.001,
      children: [{
        type: 'trapezoidfinset', id: 'fins', finCount: 3, rootChord: 0.1, tipChord: 0.05, sweep: 0.05,
        height: 0.06, thickness: 0.003, position: { method: 'bottom', offset: 0 },
      }],
    },
    { type: 'nosecone', id: 'tail', length: L, aftRadius: 0.03, shape: 'conical', filled: true, ...tail } as ComponentNode,
  ],
});

const stepped = (r: OrkRocket) => r.staticInfo().warningTexts.some((w) => /discontinu/i.test(w));

describe('KB2 a flipped nose cone flies as a tail cone', () => {
  it('meets the tube ahead with its base: no diameter step', () => {
    expect(stepped(stack({}))).toBe(true); // point-forward behind a 60 mm tube
    expect(stepped(stack({ flipped: true }))).toBe(false);
  });

  it('carries its solid mass at the wide, FORE end', () => {
    const fwd = stack({}).componentInfo('tail');
    const aft = stack({ flipped: true }).componentInfo('tail');
    expect(aft.mass).toBeCloseTo(fwd.mass, 9);
    // A solid cone's centroid is a quarter of its length from its base.
    expect(fwd.cgX).toBeCloseTo(0.75 * L, 3);
    expect(aft.cgX).toBeCloseTo(0.25 * L, 3);
  });

  it('takes its shoulder to the front, into the tube ahead', () => {
    const shoulder = { shoulderRadius: 0.028, shoulderLength: 0.04, shoulderThickness: 0.002 };
    const plain = stack({ flipped: true }).componentInfo('tail');
    const withShoulder = stack({ flipped: true, ...shoulder }).componentInfo('tail');
    expect(withShoulder.mass).toBeGreaterThan(plain.mass);
    // The shoulder's mass sits FORWARD of the cone's own front (negative x),
    // so it pulls the part's CG forward; an aft shoulder would push it aft.
    expect(withShoulder.cgX).toBeLessThan(plain.cgX);
    const pointForward = stack({ ...shoulder }).componentInfo('tail');
    expect(pointForward.cgX).toBeGreaterThan(stack({}).componentInfo('tail').cgX);
  });

  it('moves the centre of pressure: it is a different shape to the air', () => {
    expect(Math.abs(stack({ flipped: true }).staticInfo().cp - stack({}).staticInfo().cp)).toBeGreaterThan(0.001);
  });

  it('flipped: false is the nose cone it always was', () => {
    const a = stack({}).staticInfo();
    const b = stack({ flipped: false }).staticInfo();
    expect(b.cg).toBe(a.cg);
    expect(b.cp).toBe(a.cp);
    expect(b.massEmpty).toBe(a.massEmpty);
  });
});
