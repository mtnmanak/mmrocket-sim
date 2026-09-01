import { describe, expect, it } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { OrkRocket } from '@online-openrocket/engine';
import { engineTree } from '../tree/treeModel.js';
import { hasAerodynamicForce, shownCp, shownStability, stabilityState } from './simReport.js';
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

  it('is detected by the force, and the SWEEP finds force one plane cannot', () => {
    // Updated when the app moved to the swept CP. The single plane at theta = 0
    // sees nothing on a 1- or 2-fin design (cna 0), but other roll angles do —
    // measured cnaWorst 0.0057 on the no-nose one-fin case — so it is no longer
    // suppressed, and that is right: there IS a worst-case margin to report.
    // "This is not a finished rocket" is already said through the warnings
    // channel, which is the honest place for it.
    expect(infoOf(1, false).cna).toBe(0);                      // the plane sees nothing
    expect(hasAerodynamicForce(infoOf(1, false))).toBe(true);  // the sweep does
    expect(infoOf(1, false).warningTexts.join(' ')).toContain('OPEN_AIRFRAME');

    // THREE fins with no nose cone is a real rocket with a real margin.
    expect(hasAerodynamicForce(infoOf(3, false))).toBe(true);
    expect(infoOf(3, false).stabilityCalibers).toBeGreaterThan(0);
    // ONE fin WITH a nose cone has genuine lift and a genuinely bad margin.
    expect(hasAerodynamicForce(infoOf(1, true))).toBe(true);
    expect(infoOf(1, true).cna).toBeGreaterThan(0);
    expect(infoOf(1, true).stabilityCalibers).toBeLessThan(0);
  });

  it('still suppresses a design that makes no force at ANY angle', () => {
    // The suppression did not become dead code — it fires on the case it was
    // always about: nothing aerodynamic to measure at all. A bare tube has no
    // fin to find at any roll angle.
    const bare: RocketTree = {
      name: 'bare',
      components: [{
        type: 'stage', id: 's', children: [{
          type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.025, thickness: 0.001,
        } as unknown as ComponentNode],
      } as unknown as ComponentNode],
    };
    const info = OrkRocket.buildTree(engineTree(bare)).staticInfo();
    expect(info.cna).toBe(0);
    expect(info.cnaWorst).toBe(0);
    expect(hasAerodynamicForce(info)).toBe(false);
  });

  it('the shown margin does not depend on how a fin is clocked', () => {
    // The measurement that decided replace-vs-beside. Same rocket, one fin,
    // rotated: the single plane swings from -5.346 to +1.696 cal on a cosmetic
    // choice. The swept figure holds at the worst case.
    const clocked = (deg: number) => OrkRocket.buildTree(engineTree({
      name: 'c',
      components: [{
        type: 'stage', id: 's', children: [
          { type: 'nosecone', id: 'n', length: 0.1, aftRadius: 0.025, shape: 'ogive', thickness: 0.002 } as unknown as ComponentNode,
          {
            type: 'bodytube', id: 'b', length: 0.5, outerRadius: 0.025, thickness: 0.001,
            children: [{
              type: 'trapezoidfinset', id: 'f', finCount: 1, rootChord: 0.08, tipChord: 0.04,
              sweep: 0.03, height: 0.05, thickness: 0.003,
              rotation: (deg * Math.PI) / 180, position: { method: 'bottom', offset: 0 },
            } as unknown as ComponentNode],
          } as unknown as ComponentNode,
        ],
      } as unknown as ComponentNode],
    })).staticInfo();
    const at0 = clocked(0);
    const at90 = clocked(90);
    // The premise: the plane figure really does swing by 7 calibers.
    expect(at0.stabilityCalibers).toBeCloseTo(-5.346, 2);
    expect(at90.stabilityCalibers).toBeCloseTo(1.696, 2);
    expect(at90.stabilityCalibers - at0.stabilityCalibers).toBeGreaterThan(7);
    // What the app SHOWS does not move — the margin OR the CP itself. The CP
    // assertion is not redundant: the 3D marker and the 2D callout draw from
    // cp directly, so a shownCp that quietly fell back to the plane figure
    // would leave the drawing disagreeing with the number beside it.
    expect(at0.cp).not.toBeCloseTo(at90.cp, 4);   // the premise: the plane moves
    expect(shownCp(at0)).toBeCloseTo(shownCp(at90), 9);
    expect(shownStability(at0)).toBeCloseTo(shownStability(at90), 9);
    expect(shownStability(at0)).toBeCloseTo(-5.346, 2);

    // …and a symmetric design is untouched by the whole change.
    const three = infoOf(3, true);
    expect(shownStability(three)).toBeCloseTo(three.stabilityCalibers, 12);
    expect(shownCp(three)).toBeCloseTo(three.cp, 12);
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
