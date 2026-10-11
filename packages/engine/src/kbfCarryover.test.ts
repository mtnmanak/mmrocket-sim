import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

// RASAero feature #3 (engine-java/patches/LEDGER.md): Rogers Modified Barrowman adds back
// the body-in-presence-of-fins carryover K_B(W) that classic Barrowman drops. Classic
// already credits the fins with (1 + tau), tau = r / (s + r); slender-body theory puts the
// whole fin + carryover load at (1 + tau)^2 times the fin alone, so the carryover is
// tau * (classic fin CNa), and FinSetCalc places it at the fin ROOT quarter chord. With the
// supersonic model on, NACA 1307's K_W(B) + fa K_B(W) replaces (1 + tau) and the separate
// Kbf term is suppressed (it would count the carryover twice).
//
// Nothing else pinned this: hybridAero/finAfterbody compare models with each other or as
// ratios in which a missing or doubled carryover cancels, and difftest has no stored baseline.
//
// The fin set's own load is isolated by subtracting the same rocket without fins: a body
// tube has no CNa of its own at zero AoA and the nose does not see the fins, so the
// whole-rocket first moment CNa * xCP splits exactly into nose + fins.

const NOSE_L = 0.12;
const TUBE_L = 0.5;
const MACHS = [0.3, 0.6]; // subsonic, and below Hybrid's default M0.8 band

type Model = 'classic' | 'kbf' | 'supersonic' | 'hybrid';

interface Fin { r: number; root: number; tip: number; sweep: number; span: number }

function tree(f: Fin, withFins: boolean): RocketTree {
  return {
    name: 'Kbf carryover',
    components: [
      { type: 'nosecone', shape: 'ogive', length: NOSE_L, aftRadius: f.r, thickness: 0.002 },
      {
        type: 'bodytube', length: TUBE_L, outerRadius: f.r, thickness: 0.001,
        children: withFins ? [{
          type: 'trapezoidfinset', finCount: 4, rootChord: f.root, tipChord: f.tip, sweep: f.sweep,
          height: f.span, thickness: 0.003, position: { method: 'bottom', offset: 0 },
        }] : [],
      },
    ],
  } as unknown as RocketTree;
}

function build(t: RocketTree, model: Model): OrkRocket {
  const r = OrkRocket.buildTree(t);
  r.setRogersModifiedBarrowman(model !== 'classic');
  r.setSupersonicAero(model === 'supersonic');
  r.setHybridAero(model === 'hybrid');
  return r;
}

/** The fin set's CNa and first moment CNa * x at each Mach, by subtraction. */
function finLoad(f: Fin, model: Model): { cna: number; moment: number }[] {
  const finned = build(tree(f, true), model).forceSamples(MACHS);
  const bare = build(tree(f, false), model).forceSamples(MACHS);
  return MACHS.map((_, i) => {
    const a = finned[i]!, b = bare[i]!;
    return { cna: a[3] - b[3], moment: a[0]! * a[3] - b[0]! * b[3] };
  });
}

/** NACA Report 1307 eq. 14 K_W(B), the same transcription finAfterbody.test.ts uses. */
function kWB(t: number): number {
  const num = (1 + t ** 4) * (0.5 * Math.atan(0.5 * (1 / t - t)) + Math.PI / 4)
    - t ** 2 * ((1 / t - t) + 2 * Math.atan(t));
  return (2 / Math.PI) * num / (1 - t) ** 2;
}

const FINS: Fin[] = [
  { r: 0.02, root: 0.08, tip: 0.04, sweep: 0.03, span: 0.05 }, // tau 0.286
  { r: 0.0125, root: 0.05, tip: 0.03, sweep: 0.02, span: 0.03 }, // tau 0.294, swept MAC well aft of the root
  { r: 0.04, root: 0.1, tip: 0.1, sweep: 0, span: 0.02 }, // tau 0.667, a stubby fin on a wide body
];

describe('Rogers Kbf body carryover (RASAero feature #3)', () => {
  it('adds tau x the classic fin CNa, at the fin root quarter chord', () => {
    for (const f of FINS) {
      const tau = f.r / (f.span + f.r);
      // Fins flush with the tube's aft end: the root leading edge sits one root chord
      // ahead of the body's end, measured from the nose tip.
      const rootQuarterChord = NOSE_L + TUBE_L - f.root + 0.25 * f.root;
      const classic = finLoad(f, 'classic');
      for (const model of ['kbf', 'hybrid'] as const) {
        const kbf = finLoad(f, model);
        MACHS.forEach((m, i) => {
          const c = classic[i]!, k = kbf[i]!;
          const label = `${model} r${f.r} M${m}`;
          expect(c.cna, `${label}: fixture has fin load`).toBeGreaterThan(0.5);
          // CNa: (1 + tau)^2 x fin-alone against classic's (1 + tau) x fin-alone.
          expect(k.cna / c.cna / (1 + tau) - 1, `${label} CNa ratio`).toBeCloseTo(0, 10);
          // The added load acts at the root quarter chord (absolute, m from the nose tip).
          const xCarry = (k.moment - c.moment) / (k.cna - c.cna);
          expect(Math.abs(xCarry - rootQuarterChord), `${label} carryover station (m)`).toBeLessThan(1e-9);
          // At or ahead of the classic fin CP (the MAC quarter chord or aft of it), yet aft of the
          // whole rocket's CP, so the extra load moves the rocket's CP aft: more displayed margin.
          expect(xCarry).toBeLessThanOrEqual(c.moment / c.cna + 1e-9);
        });
      }
    }
  }, 30_000);

  it('is suppressed under the Supersonic model, where NACA 1307 already carries the full carryover', () => {
    for (const f of FINS) {
      const tau = f.r / (f.span + f.r);
      // Flush with the base: no body behind the root trailing edge, so fa = 0.5.
      const kw = kWB(tau);
      const want = (kw + 0.5 * ((1 + tau) ** 2 - kw)) / (1 + tau);
      const classic = finLoad(f, 'classic');
      const ss = finLoad(f, 'supersonic');
      MACHS.forEach((m, i) => {
        const c = classic[i]!, s = ss[i]!;
        const label = `supersonic r${f.r} M${m}`;
        expect(s.cna / c.cna / want - 1, `${label} CNa = 1307 split, no Kbf term on top`).toBeCloseTo(0, 9);
        // No root-quarter-chord term: the fin CP is the classic fin CP.
        expect(Math.abs(s.moment / s.cna - c.moment / c.cna), `${label} fin CP (m)`).toBeLessThan(1e-9);
      });
    }
  }, 30_000);
});
