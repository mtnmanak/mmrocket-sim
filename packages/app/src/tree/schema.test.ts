import { describe, expect, it } from 'vitest';
import { FIELDS } from './schema.js';

const field = (type: string, key: string) =>
  (FIELDS[type as keyof typeof FIELDS] ?? []).find((f) => f.key === key);

/**
 * Slider stops that carry physics.
 *
 * PropertyPanel renders a ValueSlider whenever a field has BOTH `smin` and
 * `smax`, its left stop IS `smin`, and its `commit` clamps only the maximum. So
 * `smin` is not decoration: it is the value one mouse drag can write with no
 * typing and no confirmation, and on a coefficient field that makes it a
 * physics decision.
 */
describe('the recovery Cd slider cannot be dragged to zero drag', () => {
  it('starts one step above zero on both recovery devices', () => {
    for (const type of ['parachute', 'streamer']) {
      const cd = field(type, 'cd');
      expect(cd, `${type} has no cd field`).toBeDefined();
      // Exactly one step, so the stop is still the lowest coefficient anyone
      // could mean; the point is only that it is not 0.
      expect(cd!.smin, `${type} cd slider can be dragged to zero drag`).toBe(cd!.step);
      expect(cd!.smin!).toBeGreaterThan(0);
    }
  });

  it('is the OPPOSITE call from the protuberance Cd, deliberately', () => {
    // `cdFrontal` keeps smin 0 because 0 there is the "release the override"
    // stop — treeModel.protuberanceExplicitCd falls a 0 through to the drag
    // class, so the left stop restores automatic behaviour rather than zeroing
    // it. A recovery Cd has no class to fall through to: 0 reaches
    // ComponentFactory as a real 0.0, RecoveryDevice.setCD stores it unclamped
    // and clears cdAutomatic, and the canopy makes no drag at all. Two fields
    // of the same shape, two different right answers — pinned together so the
    // next reader sees why they differ.
    expect(field('protuberance', 'cdFrontal')!.smin).toBe(0);
  });
});
