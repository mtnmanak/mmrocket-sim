import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// Board Tier 0 row 75, option (a) (Eric, 2026-10-08): the Supersonic model's NACA-1307 body-fin
// interference weights the body carryover K_B(W) by an afterbody factor
// fa = min(1, 0.5 + afterbody / rootChord). Until this fix the kernel computed the afterbody as
// max(0, tube remainder) PLUS the full length of every later body part, so a fin overhanging the
// aft end of its tube onto a boattail threw the overhang away: ARCAS counted its whole 45.974 mm
// boattail where 6.858 mm lies behind the fin, and fa saturated at 1 instead of 0.5799 (fin
// CNa +13.6 %, CP aft at every Mach). The fix walks actual stations: the overhang uses up the
// following parts' length. docs/research/supersonic-cp-2026-10-08/REPORT.md.
//
// Requires the rebuilt kernel (npm run engine:js). The fin set's own CNa and CP (with its body
// carryover) are isolated through the shipped bridge by subtraction: at zero AoA a cylinder
// carries no normal force, and the nose and boattail loads do not depend on the fins, so
// W_fin = W - W0 and x_fin = (x*W - x0*W0) / W_fin with W0/x0 from the same rocket without fins.
//
// THE PHYSICAL CLAIM TESTED: the carryover depends on how much body lies behind the fin root
// trailing edge, not on how that body is split into parts. A fin overhanging its tube onto a
// boattail must therefore load exactly like the same fin, at the same station and on the same
// tube radius, with the same physical afterbody of plain tube behind it. The two differ only in
// the rounding of the station arithmetic (~1e-16 m in the afterbody, ~1e-15 relative in fa), so
// 1e-9 is a rounding bound, not a fitted tolerance. No kernel float literal is pinned (CI Node 22
// and the desktop's Node 24 differ in the last bits).

type Model = 'classic' | 'kbf' | 'supersonic' | 'hybrid';

function build(t: RocketTree, model: Model): OrkRocket {
  const r = OrkRocket.buildTree(t);
  r.setRogersModifiedBarrowman(model === 'kbf');
  r.setSupersonicAero(model === 'supersonic');
  r.setHybridAero(model === 'hybrid');
  return r;
}

type Part = Record<string, unknown>;

/** nose + tube (fins on it) + any following parts; `fins: null` builds the same body bare. */
function rocket(nose: Part, tube: Part, fins: Part | null, after: Part[]): RocketTree {
  return {
    name: 'afterbody',
    components: [nose, { ...tube, children: fins ? [fins] : [] }, ...after],
  } as RocketTree;
}

/** The fin set's CNa weight and absolute CP x at each Mach, isolated by subtraction. */
function finLoad(nose: Part, tube: Part, fins: Part, after: Part[], machs: number[], model: Model) {
  const withFins = build(rocket(nose, tube, fins, after), model).forceSamples(machs);
  const bare = build(rocket(nose, tube, null, after), model).forceSamples(machs);
  return machs.map((_, i) => {
    const [x, , , w] = withFins[i]!;
    const [x0, , , w0] = bare[i]!;
    return { w: w - w0, x: (x * w - x0 * w0) / (w - w0) };
  });
}

function expectSameLoad(
  a: { w: number; x: number }[], b: { w: number; x: number }[], what: string,
) {
  a.forEach((p, i) => {
    const q = b[i]!;
    expect(Math.abs(p.w / q.w - 1), `${what} CNa [${i}]`).toBeLessThan(1e-9);
    expect(Math.abs(p.x - q.x), `${what} CP x [${i}]`).toBeLessThan(1e-9);
  });
}

/** NACA Report 1307 eq. 14 K_W(B), a TS transcription of the kernel's kWB1307. */
function kWB(t: number): number {
  const num = (1 + t ** 4) * (0.5 * Math.atan(0.5 * (1 / t - t)) + Math.PI / 4)
    - t ** 2 * ((1 / t - t) + 2 * Math.atan(t));
  return (2 / Math.PI) * num / (1 - t) ** 2;
}
/** Total interference K_W(B) + fa*K_B(W) for body radius r, span s, afterbody a, root chord c. */
function kTotal(r: number, s: number, a: number, c: number): number {
  const tau = r / (r + s);
  const kw = kWB(tau);
  const fa = Math.min(1, 0.5 + Math.max(0, a) / c);
  return kw + fa * ((1 + tau) ** 2 - kw);
}

// ARCAS (validation/fixtures/arcas-short.json, NASA TN D-4013/D-4014 half-scale model): the
// fins hang 39.1161 mm past the tube's aft end onto a 45.974 mm conical boattail.
const R = 0.028575;
const NOSE: Part = { type: 'nosecone', id: 'nose', shape: 'ogive', shapeParameter: 1, length: 0.26924, aftRadius: R, thickness: 0.0015 };
const TUBE_LEN = 0.724916;
const tube = (length: number): Part => ({ type: 'bodytube', id: 'tube', length, outerRadius: R, thickness: 0.0015 });
const CHORD = 0.085852;
const SPAN = 0.0534162;
const OVERHANG = 0.0391161;
const BOATTAIL = 0.045974;
const AFTERBODY = BOATTAIL - OVERHANG; // 6.8579 mm of body behind the fin root trailing edge
const fins = (bottomOffset: number): Part => ({
  type: 'trapezoidfinset', id: 'fins', finCount: 4, rootChord: CHORD, tipChord: 0.054991,
  sweep: 0.030861, height: SPAN, thickness: 0.0031242, crossSection: 'airfoil', airfoilSection: 'doublewedge',
  airfoilLeDiamond: 0.0377521, airfoilTeDiamond: 0.0326695,
  position: { method: 'bottom', offset: bottomOffset },
});
const cone = (id: string, length: number, fore: number, aft: number): Part =>
  ({ type: 'transition', id, shape: 'conical', length, foreRadius: fore, aftRadius: aft, thickness: 0.0015 });
const ARCAS_BOATTAIL = cone('boattail', BOATTAIL, R, 0.0166116);
// Subsonic, transonic-bridge and supersonic samples: the fix applies at every Mach (option a).
const MACHS = [0.3, 0.8, 1.2, 2, 3];

describe('Supersonic afterbody: the carryover sees only the body behind the fin (row 75)', () => {
  it('an ARCAS fin overhanging onto its boattail loads like the same fin with 6.858 mm of tube behind it', () => {
    for (const model of ['supersonic', 'hybrid'] as const) {
      const overhung = finLoad(NOSE, tube(TUBE_LEN), fins(OVERHANG), [ARCAS_BOATTAIL], MACHS, model);
      // Same fin at the same station on a tube that simply continues AFTERBODY past its trailing edge.
      const plain = finLoad(NOSE, tube(TUBE_LEN + BOATTAIL), fins(-AFTERBODY), [], MACHS, model);
      expectSameLoad(overhung, plain, model);
    }
  });

  it('the ARCAS fin CNa is the NACA-1307 total with fa = 0.5 + 6.858 mm / root chord', () => {
    // Against the same fin with a long afterbody (fa = 1): only the carryover weight differs, so
    // the ratio is K(fa) / K(1). The old kernel gave 1 here (fa saturated); the fix gives 0.880.
    const expected = kTotal(R, SPAN, AFTERBODY, CHORD) / kTotal(R, SPAN, 1, CHORD);
    expect(expected).toBeLessThan(0.9); // the test can tell the two kernels apart
    const overhung = finLoad(NOSE, tube(TUBE_LEN), fins(OVERHANG), [ARCAS_BOATTAIL], MACHS, 'supersonic');
    const long = finLoad(NOSE, tube(TUBE_LEN + BOATTAIL + 0.2), fins(-(AFTERBODY + 0.2)), [], MACHS, 'supersonic');
    overhung.forEach((p, i) => {
      expect(Math.abs(p.w / long[i]!.w / expected - 1), `M${MACHS[i]}`).toBeLessThan(1e-9);
    });
  });

  it('an overhang through more than one following part uses up each of them', () => {
    // Tube, a 20 mm conical step, a 30 mm narrower tube; the fin hangs 25 mm past the first tube:
    // 20 + 30 - 25 = 25 mm of body behind it (the old kernel counted all 50 mm, fa = 1).
    const after = [cone('step', 0.02, R, 0.024), { type: 'bodytube', id: 'tail', length: 0.03, outerRadius: 0.024, thickness: 0.0015 }];
    const overhung = finLoad(NOSE, tube(TUBE_LEN), fins(0.025), after, MACHS, 'supersonic');
    const plain = finLoad(NOSE, tube(TUBE_LEN + 0.05), fins(-0.025), [], MACHS, 'supersonic');
    expectSameLoad(overhung, plain, 'two following parts');
  });

  it('a fin overhanging the whole body gets the flush-base half, as a flush fin does', () => {
    // 30 mm past a tube followed by only 20 mm of boattail: nothing lies behind the trailing edge.
    const overhung = finLoad(NOSE, tube(TUBE_LEN), fins(0.03), [cone('bt', 0.02, R, 0.02)], MACHS, 'supersonic');
    const flush = finLoad(NOSE, tube(TUBE_LEN + 0.02), fins(0.01), [], MACHS, 'supersonic');
    // Both have zero afterbody; the second's fin also overhangs (by 10 mm) a tube with nothing after it.
    expectSameLoad(overhung, flush, 'past the whole body');
    const flushOnEnd = finLoad(NOSE, tube(TUBE_LEN + 0.03), fins(0), [], MACHS, 'supersonic');
    expectSameLoad(overhung, flushOnEnd, 'flush with the base');
  });

  it("a rounded freeform fin overhanging onto a tail cone (PK-68's planform) follows the same rule", () => {
    const r = 0.070358;
    const nose: Part = { type: 'nosecone', id: 'nose', shape: 'ogive', length: 0.3302, aftRadius: r, thickness: 0.002 };
    const body = (length: number): Part => ({ type: 'bodytube', id: 'tube', length, outerRadius: r, thickness: 0.002 });
    const freeform: Part = {
      type: 'freeformfinset', id: 'fins', finCount: 3, thickness: 0.00635, crossSection: 'rounded',
      points: [[0, 0], [0.24765, 0.13335], [0.29845, 0.05715], [0.29845, 0]],
      position: { method: 'top', offset: 0.3175 }, // trailing edge 6.35 mm past the 0.6096 m tube
    };
    for (const model of ['supersonic', 'hybrid'] as const) {
      const overhung = finLoad(nose, body(0.6096), freeform, [cone('tail', 0.075, r, 0.03)], MACHS, model);
      const plain = finLoad(nose, body(0.6096 + 0.075), freeform, [], MACHS, model);
      expectSameLoad(overhung, plain, `freeform ${model}`);
    }
  });

  it('control: a fin that does not overhang keeps tube remainder + boattail (unchanged rule)', () => {
    // Trailing edge 5 mm before the tube's end, then a 10 mm boattail: 15 mm behind it, fa < 1.
    const bt = cone('bt', 0.01, R, 0.025);
    const ahead = finLoad(NOSE, tube(TUBE_LEN), fins(-0.005), [bt], MACHS, 'supersonic');
    const plain = finLoad(NOSE, tube(TUBE_LEN + 0.01), fins(-0.015), [], MACHS, 'supersonic');
    expectSameLoad(ahead, plain, 'no overhang');
    const long = finLoad(NOSE, tube(TUBE_LEN + 0.21), fins(-0.215), [], MACHS, 'supersonic');
    const expected = kTotal(R, SPAN, 0.015, CHORD) / kTotal(R, SPAN, 1, CHORD);
    ahead.forEach((p, i) => {
      expect(Math.abs(p.w / long[i]!.w / expected - 1), `M${MACHS[i]}`).toBeLessThan(1e-9);
    });
  });

  it('the walk follows stations: a gap ends the afterbody, an overlap counts only the new length', () => {
    // Fin trailing edge 5 mm before the tube's end. ABSOLUTE positions are from the nose tip.
    const end = 0.26924 + TUBE_LEN;
    const at = (offset: number): Part => ({ ...ARCAS_BOATTAIL, position: { method: 'absolute', offset } });
    // A boattail 10 mm behind the tube is not body behind the fin: 5 mm, as with no boattail at all.
    const gapped = finLoad(NOSE, tube(TUBE_LEN), fins(-0.005), [at(end + 0.01)], MACHS, 'supersonic');
    const alone = finLoad(NOSE, tube(TUBE_LEN), fins(-0.005), [], MACHS, 'supersonic');
    expectSameLoad(gapped, alone, 'gap');
    // A boattail starting 10 mm inside the tube adds only its 35.974 mm past the tube's end.
    const overlapped = finLoad(NOSE, tube(TUBE_LEN), fins(-0.005), [at(end - 0.01)], MACHS, 'supersonic');
    const plain = finLoad(NOSE, tube(TUBE_LEN + BOATTAIL - 0.01), fins(-(0.005 + BOATTAIL - 0.01)), [], MACHS, 'supersonic');
    expectSameLoad(overlapped, plain, 'overlap');
  });

  it('stations, not child order: a later-listed part that bridges an apparent gap still counts (A5b)', () => {
    // Fin trailing edge 5 mm before the tube's end; two 15 mm tubes fill end..end+15 and end+15..end+30,
    // positioned explicitly. 35 mm of continuous body lies behind the fin (fa < 1) in EITHER list order.
    // Listed far-part-first, the A5 walk saw a 15 mm gap after the tube and kept 5 mm.
    const end = 0.26924 + TUBE_LEN;
    const part = (id: string, offset: number, length = 0.015): Part =>
      ({ type: 'bodytube', id, length, outerRadius: R, thickness: 0.0015, position: { method: 'absolute', offset } });
    const near = part('near', end), far = part('far', end + 0.015);
    const inOrder = finLoad(NOSE, tube(TUBE_LEN), fins(-0.005), [near, far], MACHS, 'supersonic');
    const reversed = finLoad(NOSE, tube(TUBE_LEN), fins(-0.005), [far, near], MACHS, 'supersonic');
    const plain = finLoad(NOSE, tube(TUBE_LEN + 0.03), fins(-0.035), [], MACHS, 'supersonic');
    expectSameLoad(inOrder, plain, 'in order');
    expectSameLoad(reversed, plain, 'reversed order');
    for (const model of ['hybrid', 'classic', 'kbf'] as const) {
      expectSameLoad(
        finLoad(NOSE, tube(TUBE_LEN), fins(-0.005), [far, near], MACHS, model),
        finLoad(NOSE, tube(TUBE_LEN), fins(-0.005), [near, far], MACHS, model), `${model} reversed`);
    }
    // A zero-length part inside a gap has no extent and cannot bridge it: still the tube's own 5 mm.
    const sliver = part('sliver', end + 0.0075, 0);
    const gapped = finLoad(NOSE, tube(TUBE_LEN), fins(-0.005), [far, sliver], MACHS, 'supersonic');
    const alone = finLoad(NOSE, tube(TUBE_LEN), fins(-0.005), [], MACHS, 'supersonic');
    expectSameLoad(gapped, alone, 'zero-length part in a gap');
  });

  it('Classic and Kbf do not use the afterbody; Hybrid below its band is Kbf', () => {
    for (const model of ['classic', 'kbf'] as const) {
      const overhung = finLoad(NOSE, tube(TUBE_LEN), fins(OVERHANG), [ARCAS_BOATTAIL], MACHS, model);
      const long = finLoad(NOSE, tube(TUBE_LEN + BOATTAIL + 0.2), fins(-(AFTERBODY + 0.2)), [], MACHS, model);
      expectSameLoad(overhung, long, model);
    }
    const sub = [0.1, 0.3, 0.5, 0.79];
    const hybrid = finLoad(NOSE, tube(TUBE_LEN), fins(OVERHANG), [ARCAS_BOATTAIL], sub, 'hybrid');
    const kbf = finLoad(NOSE, tube(TUBE_LEN), fins(OVERHANG), [ARCAS_BOATTAIL], sub, 'kbf');
    hybrid.forEach((p, i) => {
      expect(p.w).toBe(kbf[i]!.w);
      expect(p.x).toBe(kbf[i]!.x);
    });
  });
}, 60_000);
