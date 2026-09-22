import { describe, expect, it } from 'vitest';
import { OrkRocket, resetEngine, type RocketTree } from './orkEngine.js';

/**
 * STALE ENGINE HANDLES — audit 2026-09-22 (engine half).
 *
 * resetEngine() frees every kernel object, and the app calls it on every
 * rebuild. It also used to restart the kernel's handle numbering at 1, so an
 * OrkRocket kept across a reset — a Batch sweep's pooled candidate when Ctrl+Z
 * rebuilt the design mid-sweep, say — silently addressed whatever rocket was
 * built next under the same number. Measured by the audit, and again here
 * before the fix: a stale handle reported the NEW design's length. Numbering is
 * now monotonic and a freed handle throws "stale engine handle".
 */

const rocket = (bodyLength: number): RocketTree => ({
  name: 'Handles',
  components: [
    { type: 'nosecone', length: 0.15, aftRadius: 0.02, thickness: 0.002 },
    { type: 'bodytube', length: bodyLength, outerRadius: 0.02, thickness: 0.001 },
  ],
} as unknown as RocketTree);

describe('a handle held across resetEngine()', () => {
  it('throws "stale engine handle" instead of addressing the next rocket built', () => {
    const before = OrkRocket.buildTree(rocket(0.4));
    expect(before.staticInfo().length).toBeCloseTo(0.55, 12);

    resetEngine();
    const after = OrkRocket.buildTree(rocket(0.9));
    expect(after.staticInfo().length).toBeCloseTo(1.05, 12);

    // Before the fix every one of these reached the 0.9 m rocket: the first
    // read its 1.05 m back, the last switched ITS aero model.
    expect(() => before.staticInfo()).toThrow(/stale engine handle/);
    expect(() => before.componentInfo('anything')).toThrow(/stale engine handle/);
    expect(() => before.setRogersModifiedBarrowman(true)).toThrow(/stale engine handle/);

    // The live rocket is untouched by the stale calls.
    expect(after.staticInfo().length).toBeCloseTo(1.05, 12);
  });

  it('never reissues a number, however many resets come between', () => {
    const handleOf = (r: OrkRocket) => (r as unknown as { handle: number }).handle;
    const seen = new Set<number>();
    for (let i = 0; i < 5; i++) {
      resetEngine();
      const h = handleOf(OrkRocket.buildTree(rocket(0.4)));
      expect(seen.has(h), `handle ${h} reissued after reset ${i}`).toBe(false);
      seen.add(h);
    }
  });
});
