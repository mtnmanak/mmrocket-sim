import { describe, expect, it } from 'vitest';
import { OrkRocket, type RocketTree } from './orkEngine.js';

/**
 * A REFUSED FREEFORM OUTLINE — audit 2026-09-22 ("Degenerate values fail the
 * whole build", kernel half).
 *
 * The kernel's FreeformFinSet.setPoints refuses an outline whose edges cross or
 * touch (a repeated point does it: the zero-length edge touches its neighbours'
 * neighbours) and rolls back to the previous outline — on a fresh fin set, the
 * constructor's DEFAULT fin. Upstream reports the refusal with two log lines
 * formatted with `%g`, and TeaVM's String.format has no `%g`, so in the browser
 * the LOG LINE threw "Unknown format conversion: g" out of buildTree — an error
 * naming nothing — while the JVM carried on and flew the default fin.
 *
 * The fix is two-sided and both halves are pinned here: the `%g` is patched to
 * `%s` (the BasicEventSimulationEngine precedent, engine-java/patches/LEDGER.md),
 * and the bridge reads the refusal and throws a message NAMING the fin set, so
 * neither runtime ever flies a fin the design does not draw. The app's own
 * pre-check (packages/app/src/tree/finOutline.ts) keeps refusing these outlines
 * before they get here; its kernel-agreement test only asserts that buildTree
 * throws, which stays true.
 */

const withFin = (points: [number, number][], name?: string): RocketTree => ({
  name: 'Outline',
  components: [
    { type: 'nosecone', length: 0.15, aftRadius: 0.02, thickness: 0.002 },
    {
      type: 'bodytube', length: 0.4, outerRadius: 0.02, thickness: 0.001,
      children: [{ type: 'freeformfinset', id: 'fins', finCount: 3, thickness: 0.003, points, ...(name ? { name } : {}) }],
    },
  ],
} as unknown as RocketTree);

/** The fin editor's own starting outline: a 4-point clipped delta. */
const GOOD: [number, number][] = [[0, 0], [0.020, 0.030], [0.045, 0.030], [0.060, 0]];
/** Edge 0-1 crosses edge 2-3. */
const CROSSING: [number, number][] = [[0, 0], [0.020, 0.030], [0.005, 0.020], [0.060, 0]];
/** Point 2 repeats point 1. */
const REPEATED: [number, number][] = [[0, 0], [0.020, 0.030], [0.020, 0.030], [0.060, 0]];

describe('a self-intersecting freeform outline is refused by name, never flown as the default fin', () => {
  it('throws a message naming the fin set, not "Unknown format conversion: g"', () => {
    for (const bad of [CROSSING, REPEATED]) {
      let message = '';
      try {
        OrkRocket.buildTree(withFin(bad, 'Aft fins'));
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toBe('Fin set "Aft fins": its outline crosses or touches itself, so it cannot be '
        + 'simulated. Redraw it in the fin editor.');
      expect(message).not.toMatch(/format conversion/);
    }
  });

  it('names an unnamed fin set by its id', () => {
    expect(() => OrkRocket.buildTree(withFin(CROSSING))).toThrow(/^Fin set "fins": its outline crosses/);
  });

  it('still builds a valid outline, and flies THAT outline', () => {
    // The refusal is per call, so a good outline must come through untouched.
    const r = OrkRocket.buildTree(withFin(GOOD));
    const info = r.staticInfo();
    expect(Number.isFinite(info.mass)).toBe(true);
    // Nose 0.15 + body 0.4: GOOD's tip ends forward of its own trailing corner,
    // so nothing overhangs the tube. The DEFAULT fin's tip runs 25 mm aft of its
    // root and past the tube's end — the pre-fix JVM reported 0.575 m for both
    // refused outlines above, which is how the silent substitution showed.
    expect(info.length).toBeCloseTo(0.55, 12);
  });
});
