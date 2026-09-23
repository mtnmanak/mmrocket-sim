// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HERO_WIDE_QUERY } from '../hooks/useHeroDrawer.js';
import { PHONE_QUERY } from '../hooks/useWorkspaceTab.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

/**
 * "All stats" opens by default on a desktop and stays closed on anything
 * narrower (the owner, 2026-08-23). The breakpoint is 981px because that is where
 * the hero-canvas layout starts; below it the drawer covers most of the
 * drawing. The JS check and the CSS layout must agree — if they drift, the
 * drawer opens on a viewport laid out for a phone, which is the exact problem
 * it was closed to avoid.
 *
 * WHAT IS BEHAVIOUR NOW (audit 2026-09-22, row 477). This file was regexes over
 * App.tsx as well as the stylesheet. The drawer moved into hooks/useHeroDrawer.ts
 * and the workspace tab into hooks/useWorkspaceTab.ts (row 501), and each is
 * rendered against its breakpoint in its own test; App.render.test.tsx
 * mounts App and reads the hero stage it sizes. What stays here is what only
 * the stylesheet can say — and it is checked against the hooks' own constants,
 * so the two halves cannot drift apart unseen.
 */
describe('stats-drawer default and the desktop breakpoint', () => {
  it('styles.css lays the hero canvas out at the breakpoint the drawer opens on', () => {
    // HERO_WIDE_QUERY is what useHeroDrawer opens the drawer at, and what
    // useHeroDrawer.test.tsx renders it against.
    expect(HERO_WIDE_QUERY).toBe('(min-width: 981px)');
    expect(read('../styles.css')).toContain(`@media ${HERO_WIDE_QUERY}`);
  });

  it('the hero canvas fits the rocket, capped by what the viewport affords', () => {
    // Three generations of this rule, each pinned against silent reverts:
    //  1. `max(420px, calc(100vh - 335px))` — floor, NO ceiling: the document
    //     came out at 100vh + ~85px at every window height, footer always
    //     below the fold.
    //  2. `clamp(420px, calc(100vh - 420px - --notice-h), 620px)` — capped,
    //     but a pure function of WINDOW height: a long thin rocket flew in a
    //     window-tall band of empty sky (owner report 2026-08-29).
    //  3. v0.076: min(--hero-natural, that clamp) — the canvas sizes to the
    //     DRAWING (TreeSchematic reports its natural height from geometry +
    //     width, so no measure→draw→grow loop), and the clamp survives as
    //     the availability cap. The 9999px fallback keeps 3D/Aft, which set
    //     no natural height, on the pure clamp.
    const css = read('../styles.css');
    expect(css).toContain('var(--hero-natural, 9999px)');
    //  4. v0.092: the ceiling is raised by the All Stats drawer's height,
    //     because a ceiling on how much DRAWING is worth having should not be
    //     spent on a drawer. --hero-natural had included the drawer's
    //     clearance since v0.076 and this min() discarded it for any rocket
    //     over ~230px natural — measured at 1920x1080 the request was 749px
    //     against a 620px ceiling, so the drawer took 125px of 460 off the
    //     drawing (27 %) and nothing gave it back.
    //
    // Pinned IN FULL, the way the ⟳90° cap below already was. The old
    // assertion stopped one character before the ceiling — `clamp(320px,
    // calc(100vh - 420px` — so the number this whole rule turns on could be
    // changed, or silently broken, without a test noticing.
    expect(css).toContain(
      'clamp(320px, calc(100vh - 420px - var(--notice-h, 0px)), calc(620px + var(--drawer-clearance, 0px)))');
    // The middle term is the FOOTER's budget and is deliberately untouched:
    // the owner's 2026-08-26 report set the constraint that the canvas must
    // not "get so big it scrolls the footer and notifications off the screen",
    // so the drawer buys back only what the viewport actually affords.
    expect(css).toContain('calc(100vh - 420px - var(--notice-h, 0px))');
    // Vertical (⟳90°) mode keeps its own taller pure clamp — height there
    // buys drawing, not sky.
    expect(css).toContain('height: clamp(420px, calc(100vh - 420px - var(--notice-h, 0px)), 900px)');
    // Match the DECLARATION, not the string — the rule's comment quotes the
    // old value on purpose, to record what was wrong with it.
    expect(css).not.toContain('height: max(420px');
    // The other half is behaviour now (audit 2026-09-22, row 477), in
    // App.render.test.tsx: App mounted, the schematic REPORTING its natural
    // height into the stage (it used to be a regex for the callback's name),
    // the stage publishing --drawer-clearance — without which the CSS above
    // silently falls back to a bare 620px, precisely the state this fixed —
    // and the chip's headroom (HERO_CHIP_RESERVE) reaching the DRAWING, not
    // just the container: the stage grew by it from v0.076, but centring split
    // it in half, so the chip sat on the rocket regardless. The arithmetic is
    // hooks/useHeroDrawer.test.tsx's (heroStageStyle).
  });

  /*
   * THE BATCH-SIMULATE GATE (owner reports 2026-09-01b: "when I click the
   * button, nothing happens" — disabled, with the reason only in a tooltip;
   * then "no motor mount" on a rocket with a 75mm mount, because the gate read
   * the ASSIGNED motors) was two cases of regexes over App.tsx here. They are
   * behaviour now (audit 2026-09-22, row 477), in App.render.test.tsx's "the
   * Batch simulate button": a staged rocket shows the button off and the same
   * reason on screen as in its title; a rocket with a mount and no motor shows
   * it on, and it opens the dialog. Mutation-checked: the gate back on
   * `!!primaryMountId` fails the second, the visible sentence removed fails
   * the first.
   */

  it('the fixed notice bar reserves its own space instead of covering the footer', () => {
    // NoticeBar publishes its measured height; the footer band and the hero
    // canvas both budget for it. The token needs a 0px default, or every
    // calc() using it collapses to "invalid at computed-value time" when no
    // notice is showing.
    const css = read('../styles.css');
    // Comments stripped: the rule below deliberately QUOTES the wrong form in
    // its own explanation, and a naive match would find that instead.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toContain('calc(10px + var(--notice-h, 0px))');
    // That NoticeBar publishes it — and takes it back when the bar goes — is
    // behaviour, in NoticeBar.test.tsx ("publishes its measured height"),
    // which fails if the write is removed; this file used to regex for it.
    // The default MUST live on :root, not on .viz-root. NoticeBar publishes
    // the measured height as an inline style on <html>; a declaration on
    // .viz-root would beat that inherited value for the whole app subtree and
    // the reserve would silently always be zero. This assertion is the only
    // thing standing between that mistake and a re-introduction.
    expect(/:root\s*\{[^}]*--notice-h:\s*0px;/.test(rules)).toBe(true);
    expect(/\.viz-root\s*\{[^}]*--notice-h:/.test(rules)).toBe(false);
  });

  it('the phone home screen keeps its own, narrower breakpoint', () => {
    // 767px is the phone rule (tab default, drawer chrome). The two must stay
    // distinct: a phone must not inherit the desktop drawer. The tab it opens
    // on is hooks/useWorkspaceTab.test.tsx's and App.render.test.tsx's; the
    // stylesheet's phone block must be the same query.
    expect(PHONE_QUERY).toBe('(max-width: 767px)');
    expect(PHONE_QUERY).not.toBe(HERO_WIDE_QUERY);
    expect(read('../styles.css')).toContain(`@media ${PHONE_QUERY}`);
  });
});
