import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { OrkRocket } from '@online-openrocket/engine';
import { engineTree } from '../tree/treeModel.js';
import { hasAerodynamicForce, stabilityState } from './simReport.js';
import { stabilityGlyphClass } from '../components/StatTiles.js';

/**
 * A design can produce NO aerodynamic normal force, and then its CP and
 * stability margin are artefacts rather than answers: the kernel reports cp = 0
 * (the nose tip) and cna = 0, and the margin becomes (0 − cg)/d — a big
 * negative number that reads as a violently unstable rocket when the truth is
 * "there was nothing to measure".
 *
 * It is a state users pass THROUGH — a tube and a fin set exist before the nose
 * cone does — so it has to render honestly rather than plausibly.
 *
 * Measured against the real kernel here, not asserted from theory, because the
 * condition is NOT "no nose cone": three fins with no nose cone is a perfectly
 * good rocket, and one fin WITH a nose cone has real lift and a real (awful)
 * margin that must still be shown.
 */
const fins = (n: number): ComponentNode => ({
  type: 'trapezoidfinset', id: 'f', finCount: n, rootChord: 0.08, tipChord: 0.04,
  sweep: 0.03, height: 0.05, thickness: 0.003, position: { method: 'bottom', offset: 0 },
} as unknown as ComponentNode);

const design = (finCount: number, nose: boolean): RocketTree => ({
  name: 'r',
  components: [{
    type: 'stage', id: 's',
    children: [
      ...(nose
        ? [{ type: 'nosecone', id: 'n', length: 0.1, aftRadius: 0.025, shape: 'ogive', thickness: 0.002 } as unknown as ComponentNode]
        : []),
      {
        type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.025, thickness: 0.001,
        children: [fins(finCount)],
      } as unknown as ComponentNode,
    ],
  } as unknown as ComponentNode],
});

const infoOf = (finCount: number, nose: boolean) =>
  OrkRocket.buildTree(engineTree(design(finCount, nose))).staticInfo();

describe('a design with no aerodynamic normal force', () => {
  it('really does report a zero CP and a nonsense margin (the premise)', () => {
    const one = infoOf(1, false);
    expect(one.cna).toBe(0);
    expect(one.cp).toBe(0);
    // The artefact this exists to suppress: reads as wildly unstable.
    expect(one.stabilityCalibers).toBeLessThan(-5);
  });

  it('is detected by the force, not by the absence of a nose cone', () => {
    expect(hasAerodynamicForce(infoOf(1, false))).toBe(false);
    expect(hasAerodynamicForce(infoOf(2, false))).toBe(false);
    // THREE fins with no nose cone is a real rocket with a real margin.
    expect(hasAerodynamicForce(infoOf(3, false))).toBe(true);
    expect(infoOf(3, false).stabilityCalibers).toBeGreaterThan(0);
    // ONE fin WITH a nose cone has genuine lift and a genuinely bad margin —
    // that number is an answer and must NOT be suppressed.
    expect(hasAerodynamicForce(infoOf(1, true))).toBe(true);
    expect(infoOf(1, true).cna).toBeGreaterThan(0);
    expect(infoOf(1, true).stabilityCalibers).toBeLessThan(0);
  });

  it('never paints an unknown margin with the good-stability tick', () => {
    // stabilityState returns null for "not known", and that used to fall
    // through to the ✓ branch — so an absent margin looked like a good one.
    expect(stabilityState(null)).toBeNull();
    expect(stabilityGlyphClass(null).glyph).not.toBe('✓');
    expect(stabilityGlyphClass(null).cls).toBe('stability-unknown');
    // …while a real margin still classifies as before.
    expect(stabilityGlyphClass(2.0).glyph).toBe('✓');
    expect(stabilityGlyphClass(-1).glyph).toBe('⚠');
  });
});
