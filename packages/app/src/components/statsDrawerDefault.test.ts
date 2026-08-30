// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

/**
 * "All stats" opens by default on a desktop and stays closed on anything
 * narrower (the owner, 2026-08-23). The breakpoint is 981px because that is where
 * the hero-canvas layout starts; below it the drawer covers most of the
 * drawing. The JS check and the CSS layout must agree — if they drift, the
 * drawer opens on a viewport laid out for a phone, which is the exact problem
 * it was closed to avoid.
 */
describe('stats-drawer default and the desktop breakpoint', () => {
  it('App.tsx opens the drawer on the same breakpoint the layout uses', () => {
    const app = read('../App.tsx');
    expect(app).toContain("matchMedia('(min-width: 981px)').matches");
    // It must be the drawer's initial state, not some other decision.
    expect(/const \[statsDrawer, setStatsDrawer\] = useState\(\s*\(\) =>[^;]*min-width: 981px/s.test(app))
      .toBe(true);
  });

  it('styles.css still lays the hero canvas out at that same width', () => {
    expect(read('../styles.css')).toContain('@media (min-width: 981px)');
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
    expect(css).toContain('clamp(320px, calc(100vh - 420px');
    // Vertical (⟳90°) mode keeps its own taller pure clamp — height there
    // buys drawing, not sky.
    expect(css).toContain('height: clamp(420px, calc(100vh - 420px - var(--notice-h, 0px)), 900px)');
    // Match the DECLARATION, not the string — the rule's comment quotes the
    // old value on purpose, to record what was wrong with it.
    expect(css).not.toContain('height: max(420px');
    // And the reporter that feeds the variable must stay wired.
    expect(read('../App.tsx')).toContain('onNaturalHeight={setHeroNatural}');
    expect(read('./TreeSchematic.tsx')).toContain('onNaturalHeightRef.current?.(naturalH)');
  });

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
    expect(read('../components/NoticeBar.tsx')).toContain("setProperty('--notice-h'");
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
    // distinct: a phone must not inherit the desktop drawer.
    expect(read('../App.tsx')).toContain("matchMedia('(max-width: 767px)').matches");
  });
});
