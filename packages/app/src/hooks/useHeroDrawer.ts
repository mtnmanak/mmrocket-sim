import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { DRAWER_CLOSE_BELOW_PX, drawerAutoState } from '../components/heroDrawer.js';
import { useFocusHandoff } from '../components/useFocusHandoff.js';

/**
 * THE DESIGN TAB'S HERO CANVAS AND ITS "ALL STATS" DRAWER — whether the drawer
 * is open, where it sits, and how much of the canvas it may take.
 *
 * Extracted from App.tsx in the 2026-09-22 audit (row 501 — the UI hooks of
 * extraction #8, 8 September). Its only test was statsDrawerDefault.test.ts,
 * a regex over App's text for the 981px literal; useHeroDrawer.test.tsx now
 * renders it at each side of the breakpoint, drags the window across it,
 * collapses a short canvas and measures the drawer, and App.render.test.tsx
 * reads the stage App draws with it.
 *
 * The rules for WHEN the drawer puts itself away on a short canvas are
 * components/heroDrawer.ts's (drawerAutoState), tested there; this hook is the
 * state they act on and the measurements they read.
 */

/**
 * Where the hero-canvas layout starts. MUST be the query styles.css lays the
 * canvas out at (`@media (min-width: 981px)`) — statsDrawerDefault.test.ts
 * holds the stylesheet to this constant. If they drift, the drawer opens over
 * a viewport laid out for a phone, the exact problem it was closed to avoid.
 */
export const HERO_WIDE_QUERY = '(min-width: 981px)';

/**
 * Headroom over the drawn rocket for the floating stats chip's default spot
 * (~110px unfolded + margin), so fit-to-content never lands the chip on the
 * airframe.
 */
export const HERO_CHIP_RESERVE = 140;

const wideNow = (): boolean => typeof matchMedia !== 'undefined' && matchMedia(HERO_WIDE_QUERY).matches;

/**
 * The hero stage's sizing variables for a horizontal 2D drawing whose natural
 * height the schematic has reported; undefined otherwise, which leaves the
 * stage on the pure CSS clamp (3D and Aft have no natural height).
 *
 * `--hero-natural` is rocket + chip headroom + drawer clearance.
 * `--drawer-clearance` is published on its own so the stage's CEILING can grow
 * by the drawer's height too: without it styles.css's min() discarded the
 * first for every rocket of any size, and the drawer came straight out of the
 * drawing — the state v0.092 fixed, which every other test would pass in.
 */
export function heroStageStyle(natural: number | null, clearance: number): CSSProperties | undefined {
  if (!natural) return undefined;
  return {
    '--hero-natural': `${natural + HERO_CHIP_RESERVE + clearance}px`,
    '--drawer-clearance': `${clearance}px`,
  } as CSSProperties;
}

export interface HeroDrawer {
  /** Is the All-stats drawer open? */
  open: boolean;
  /**
   * A press on "▤ All stats" or "▾ Collapse": the user's own choice, which the
   * automatic rules never overrule afterwards, and focus handed to the button
   * that replaces the one pressed.
   */
  setByUser: (open: boolean) => void;
  /** Ref for each half of the disclosure, so a press can hand focus across. */
  focusRef: (key: 'chip' | 'collapse') => (el: HTMLElement | null) => void;
  /** At or above the breakpoint: the drawer overlays the canvas, not a block under it. */
  wide: boolean;
  /** The canvas is too short to carry an unfolded stats chip as well. */
  tight: boolean;
  /** Callback ref for the drawer, which is measured. */
  drawerRef: (el: HTMLDivElement | null) => void;
  /** Callback ref for the hero stage, whose height the auto-collapse reads. */
  stageRef: (el: HTMLDivElement | null) => void;
  /** The drawer's measured height plus a gap while it overlays the canvas; else 0. */
  clearance: number;
  /** The 2D schematic's natural drawn height, as it reports it (TreeSchematic's onNaturalHeight). */
  setNatural: (px: number | null) => void;
  /** heroStageStyle over what the schematic reported and the drawer measured. */
  stageStyle: CSSProperties | undefined;
}

export function useHeroDrawer(): HeroDrawer {
  /**
   * S1 stats drawer over the hero canvas.
   * "All stats" starts OPEN on a desktop and closed on anything narrower
   * (the owner, 2026-08-23: "there is enough screen real estate"). 981px is the
   * breakpoint where the hero-canvas layout kicks in — below it the drawer
   * overlays most of the drawing, which is why it defaulted closed for
   * everyone. Session state, not a stored preference: collapsing it still
   * sticks for as long as you are working, and nobody's saved choice is
   * stomped because there was never one to stomp.
   */
  const [open, setOpen] = useState(wideNow);
  /**
   * Has the user opened or closed the drawer themselves? A ref, not storage:
   * the block above rules this session state and not a stored preference, and
   * auto-collapse must not quietly promote it. It only stops the automatic
   * rules fighting a deliberate choice — it is manners, not mechanism.
   */
  const userSet = useRef(false);
  /**
   * The chip and Collapse replace each other, so a press hands focus to the
   * one that appears (review of the audit 2026-09-22 branch, row 462): it fell
   * to <body>, and neither button's aria-expanded was ever heard changing.
   * Only a press — the automatic rules below never move focus.
   */
  const focus = useFocusHandoff<'chip' | 'collapse'>();
  const setByUser = (v: boolean) => {
    userSet.current = true;
    focus.handTo(v ? 'collapse' : 'chip');
    setOpen(v);
  };
  /**
   * The breakpoint is LIVE now (2026-09-21). The initializer above ran once at
   * startup, so a window dragged from wide to narrow kept a drawer that
   * covers most of the drawing at that width, and one dragged the other way
   * never gained it. Same shape as the theme listener in PrefsContext.
   */
  const [wide, setWide] = useState(wideNow);
  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia(HERO_WIDE_QUERY);
    const onChange = (e: MediaQueryListEvent) => {
      setWide(e.matches);
      if (!userSet.current) setOpen(e.matches);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // Measured drawer height + gap: the hero view's bottom edge lifts above the
  // open drawer so the drawing shrinks to the visible sky instead of being
  // covered (batch 08-21d — vertical mode has no zoom/pan to escape with).
  // A CALLBACK ref, not a plain one, and the effect keys on the NODE: the
  // drawer lives inside the design tab's subtree (and behind `built &&`), so
  // switching tabs unmounts it while the drawer stays open. Keyed on `open`
  // alone the effect never re-ran, the ResizeObserver kept watching the
  // detached node — Chrome reports it as a 0x0 box, so the clearance collapsed
  // to 20px — and the fresh drawer that mounted on the way back was never
  // measured at all. The drawing then ran under the drawer again, which is the
  // exact failure this measurement exists to prevent.
  const [drawerEl, setDrawerEl] = useState<HTMLDivElement | null>(null);
  const [clearance, setClearance] = useState(0);
  /**
   * Fit-to-content hero canvas (v0.076, owner report 2026-08-29): the 2D
   * schematic reports its natural drawn height and the stage sizes to
   * rocket + chip headroom + drawer clearance, capped by the old
   * viewport-availability clamp (see styles.css) — so a long thin rocket
   * stops paying for a window-tall band of empty sky, and the footer gets
   * its screen back. 3D and Aft keep the pure CSS clamp: a 3D scene has no
   * "natural" height.
   */
  const [natural, setNatural] = useState<number | null>(null);
  useEffect(() => {
    // Only while the drawer OVERLAYS the drawing. Below 981px it is a block
    // under the canvas (`wide` false), so there is nothing to lift clear of.
    if (!open || !drawerEl || !wide) { setClearance(0); return; }
    const measure = () => setClearance(drawerEl.offsetHeight + 20);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(drawerEl);
    return () => ro.disconnect();
  }, [open, drawerEl, wide]);
  /**
   * AUTO-COLLAPSE ON A SHORT CANVAS (2026-09-21, Eric's quarter-screen
   * window). The measurement is the STAGE's own padding box, never the drawer
   * and never the band left over above it — and that choice is the whole fix,
   * because of the SIGN of the dependency. The leftover band grows when the
   * drawer closes, so a rule reading it would immediately reverse its own
   * verdict and oscillate. The stage's height can only FALL when the drawer
   * closes (the drawer's height feeds the stage's ceiling, never its floor),
   * so "too short" stays true once it is true. Hysteresis is still needed for
   * the other direction: reopening raises the ceiling again, so the reopen
   * threshold sits 60px above the close one.
   */
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!stageEl) return;
    const check = () => {
      const next = drawerAutoState({
        // Below 981px the drawer is a block under the canvas and costs the
        // drawing nothing, so there is nothing for the rule to rescue.
        stageH: wide ? stageEl.clientHeight : Infinity,
        open,
        userSet: userSet.current,
      });
      if (next !== null) setOpen(next);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(stageEl);
    return () => ro.disconnect();
  }, [stageEl, open, wide]);

  return {
    open,
    setByUser,
    focusRef: focus.refFor,
    wide,
    tight: wide && (stageEl?.clientHeight ?? Infinity) < DRAWER_CLOSE_BELOW_PX,
    drawerRef: setDrawerEl,
    stageRef: setStageEl,
    clearance,
    setNatural,
    stageStyle: heroStageStyle(natural, clearance),
  };
}
