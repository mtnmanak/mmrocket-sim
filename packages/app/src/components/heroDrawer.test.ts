import { describe, expect, it } from 'vitest';
import { DRAWER_CLOSE_BELOW_PX, DRAWER_OPEN_ABOVE_PX, drawerAutoState } from './heroDrawer.js';

/**
 * jsdom has no layout, so the wiring (a ResizeObserver on the stage) can only
 * be proven in a browser. The RULE is pure and is proven here — including the
 * two properties that make it safe: it never overrules the user, and it cannot
 * oscillate, because between the two thresholds it returns null.
 */
describe('drawerAutoState', () => {
  it('closes an open drawer on a stage too short to carry it', () => {
    expect(drawerAutoState({ stageH: 300, open: true, userSet: false })).toBe(false);
  });

  it('reopens once the stage is tall again', () => {
    expect(drawerAutoState({ stageH: 500, open: false, userSet: false })).toBe(true);
  });

  it('does nothing inside the hysteresis band, in EITHER state', () => {
    // The band is what stops the flap: at 380 px an open drawer stays open and
    // a closed one stays closed, so no height exists at which the rule both
    // closes and reopens.
    for (const h of [DRAWER_CLOSE_BELOW_PX, 380, DRAWER_OPEN_ABOVE_PX]) {
      expect(drawerAutoState({ stageH: h, open: true, userSet: false })).toBeNull();
      expect(drawerAutoState({ stageH: h, open: false, userSet: false })).toBeNull();
    }
  });

  it('never overrules a user who worked the drawer themselves', () => {
    expect(drawerAutoState({ stageH: 100, open: true, userSet: true })).toBeNull();
    expect(drawerAutoState({ stageH: 900, open: false, userSet: true })).toBeNull();
  });

  it('treats an unlaid-out stage (0 px) as no information, not as short', () => {
    // The first paint reports 0. Acting on it would close the drawer for
    // everyone, once, before anything had a size.
    expect(drawerAutoState({ stageH: 0, open: true, userSet: false })).toBeNull();
  });

  it('is idempotent: applying its own answer leaves nothing more to do', () => {
    const h = 300;
    const first = drawerAutoState({ stageH: h, open: true, userSet: false });
    expect(first).toBe(false);
    // Re-running with the state it just asked for must NOT ask to reopen —
    // that is the oscillation this rule is built to avoid, and the stage can
    // only get SHORTER when the drawer closes, never taller.
    expect(drawerAutoState({ stageH: h, open: false, userSet: false })).toBeNull();
  });
});
