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
    // The band is what stops the flap: at 400 px an open drawer stays open and
    // a closed one stays closed, so no height exists at which the rule both
    // closes and reopens.
    for (const h of [DRAWER_CLOSE_BELOW_PX, 400, DRAWER_OPEN_ABOVE_PX]) {
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

/**
 * The close threshold has to meet the CSS floor EXACTLY, or there is a band of
 * window heights where the drawer stays open and the drawing is already under
 * its 200 px. That band existed, at 356-365 px, and was reachable.
 */
describe('the close threshold meets the CSS floor', () => {
  // `.stats-drawer` is capped at min(75%, max(120px, calc(100% - 246px))), and
  // the app measures the rendered drawer plus a 20 px gap off a stage inset by
  // 4 px at the top. Drawer chrome (padding + border) measures 20 px.
  const drawingBand = (stageH: number): number => {
    const content = Math.min(0.75 * stageH, Math.max(120, stageH - 246));
    return stageH - 4 - (content + 20 + 20);
  };

  it('gives the drawing its 200 px at the close threshold and above', () => {
    for (const h of [DRAWER_CLOSE_BELOW_PX, DRAWER_CLOSE_BELOW_PX + 1, 410, 500, 900]) {
      expect(drawingBand(h), `stage ${h}px`).toBeGreaterThanOrEqual(200);
    }
  });

  it('sits at the point the CSS calc stops binding, with a couple of pixels to spare', () => {
    // 366 is where `calc(100% - 246px)` falls under the 120px guard. Below it
    // the drawer is pinned and the drawing loses a pixel per pixel, so it
    // crosses 200 within a few more — measured chrome is 20px, not the 22 the
    // budget assumed, which is where the small margin comes from. What must
    // not happen is the threshold sitting BELOW the crossing.
    const firstBad = (() => { for (let h = 300; h < 500; h++) if (drawingBand(h) >= 200) return h; return -1; })();
    expect(firstBad).toBeGreaterThan(0);
    expect(DRAWER_CLOSE_BELOW_PX).toBeGreaterThanOrEqual(firstBad);
    expect(DRAWER_CLOSE_BELOW_PX - firstBad).toBeLessThanOrEqual(5);
  });

  it('leaves no height where the drawer stays open below the floor', () => {
    // The band that existed for an hour: 356..365 with the drawer still open.
    for (let h = 300; h < 500; h++) {
      const stays = drawerAutoState({ stageH: h, open: true, userSet: false }) !== false;
      if (stays) expect(drawingBand(h), `stage ${h}px keeps the drawer`).toBeGreaterThanOrEqual(200);
    }
  });
});
