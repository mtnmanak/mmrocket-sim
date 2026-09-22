import type uPlot from 'uplot';

/**
 * Wheel-zoom + drag-pan for the uPlot charts, as a uPlot plugin. Stock uPlot
 * gives us drag = select-box zoom and double-click = reset; this adds the two
 * gestures testers kept reaching for — mouse-wheel zoom about the cursor and
 * panning (shift-drag, middle-button drag, or a one-finger horizontal drag on
 * touch) — without touching either stock gesture.
 *
 * The x-window arithmetic lives in the exported pure functions below
 * (unit-tested in chartPanZoom.test.ts); the plugin is the event wiring.
 *
 * Peers: programmatic setScale does NOT ride uPlot's cursor-sync bus (that
 * bus replays mouse events only), so a grouped chart set — the flight
 * panels — hands the plugin a `getPeers` and every zoom/pan is applied to
 * each peer explicitly.
 */

/**
 * ONE base for the wheel, and the two directions are exact inverses of it.
 *
 * They were 0.85 and 1.15, which are not inverses: 0.85 × 1.15 = 0.9775, so
 * every wheel-in-then-out left the window 2.25 % narrower than it started and
 * a fidgeting cursor crept inward.
 *
 * 0.9 rather than 0.85 because the zoom ran away (the owner, 2026-09-18: "the
 * zoom goes very, very fast … a few clicks of turning the wheel and the plot
 * zooms in very close"). One detent is now 10 %: 7 to double, 22 to reach 10×.
 * The bigger half of that report is wheelZoomFactor below — the rate was only
 * ever half the problem.
 */
export const WHEEL_ZOOM_BASE = 0.9;
export const WHEEL_ZOOM_IN = WHEEL_ZOOM_BASE;
export const WHEEL_ZOOM_OUT = 1 / WHEEL_ZOOM_BASE;

/**
 * Deepest the WHEEL may go: one fiftieth of the data extent, i.e. 5000 %.
 * Box-drag stays unlimited — a drag says "exactly this much", where the wheel
 * is the gesture that overshoots.
 */
export const WHEEL_MAX_DEPTH = 50;

/*
 * One wheel DETENT, in each of the three units a browser may report.
 * These are browser conventions, not figures measured here: Chrome on Windows
 * reports ~100 px per detent, Firefox reports lines, and a page-mode wheel
 * reports one page. They only have to be the right ORDER for a detent to mean
 * about one notch in each mode.
 */
const PX_PER_NOTCH = 100;
const LINES_PER_NOTCH = 3;
const PAGES_PER_NOTCH = 1;

/** At most this many notches from a single event, so one flick cannot bottom out. */
const MAX_NOTCHES_PER_EVENT = 3;

/**
 * The zoom factor for one wheel event, normalised by how much scrolling it
 * actually represents.
 *
 * THIS IS THE REAL CAUSE of "very, very fast". The handler used to apply a
 * fixed factor per EVENT and read nothing but the sign of deltaY — so a
 * high-resolution or free-spinning wheel, which fires several events per
 * physical detent, zoomed several times as far per detent as a detented one,
 * and a trackpad further still. Normalising by deltaY and deltaMode makes one
 * detent mean one notch on every device, and makes the composition exact: six
 * events of a sixth of a detent each multiply out to the same factor as one
 * whole-detent event.
 *
 * Returns exactly 1 for a zero or non-finite deltaY, which leaves the window
 * untouched and lets the caller's no-op guard hand the event back to the page.
 */
export function wheelZoomFactor(e: { deltaY: number; deltaMode?: number }): number {
  // Both directions are powers of the SAME base, so any sequence of wheel
  // events and its reverse multiply back to exactly 1.
  return WHEEL_ZOOM_BASE ** wheelNotches(e);
}

/**
 * How many wheel notches one event represents, SIGNED: positive is zoom in
 * (deltaY negative, wheel pushed away), negative is zoom out. Zero for a
 * zero or non-finite deltaY.
 *
 * Shared by the charts and by the 2D and aft drawings, so one physical detent
 * means one notch everywhere rather than "however many events this particular
 * mouse happens to emit".
 */
export function wheelNotches(e: { deltaY: number; deltaMode?: number }): number {
  const d = e.deltaY;
  if (!Number.isFinite(d) || d === 0) return 0;
  const per = e.deltaMode === 1 ? LINES_PER_NOTCH
    : e.deltaMode === 2 ? PAGES_PER_NOTCH
      : PX_PER_NOTCH;
  const n = Math.min(Math.abs(d) / per, MAX_NOTCHES_PER_EVENT);
  return d < 0 ? n : -n;
}

/**
 * How far in the x-axis is zoomed, as a percentage: 100 % is the whole flight,
 * 200 % is half of it on screen. Degenerate or missing scales read 100 %,
 * because "all of it" is what an un-zoomed chart shows.
 */
export function zoomPercent(p: XPlot): number {
  const sc = p.scales['x'];
  if (!sc || sc.min == null || sc.max == null) return 100;
  const win = sc.max - sc.min;
  const [d0, d1] = xDataExtent(p);
  const extent = d1 - d0;
  if (!(win > 0) || !(extent > 0)) return 100;
  return (extent / win) * 100;
}

export interface XWindow {
  min: number;
  max: number;
}

/**
 * Slides a window inside the data extent, preserving its width. A window at
 * least as wide as the extent (or any degenerate input) is the full extent.
 */
export function clampWindow(min: number, max: number, dataMin: number, dataMax: number): XWindow {
  const extent = dataMax - dataMin;
  const w = max - min;
  if (!(extent > 0) || !(w > 0) || w >= extent) return { min: dataMin, max: dataMax };
  if (min < dataMin) return { min: dataMin, max: dataMin + w };
  if (max > dataMax) return { min: dataMax - w, max: dataMax };
  return { min, max };
}

/**
 * Scales the window about `focus` (the x-value under the cursor, which stays
 * put), then clamps. factor < 1 zooms in, > 1 zooms out.
 */
export function zoomWindow(
  min: number, max: number, focus: number, factor: number, dataMin: number, dataMax: number,
): XWindow {
  const nMin = focus - (focus - min) * factor;
  const nMax = focus + (max - focus) * factor;
  // Floating-point collapse at extreme zoom depth: hold the window rather
  // than handing uPlot a zero-width scale.
  if (!(nMax - nMin > 0)) return clampWindow(min, max, dataMin, dataMax);
  return clampWindow(nMin, nMax, dataMin, dataMax);
}

/**
 * One wheel event's window: zoomWindow, plus the WHEEL_MAX_DEPTH floor.
 *
 * The floor stops the WHEEL crossing into the depths — it does not drag back
 * out a window something else put there. A box drag is unlimited, and the
 * floor used to be applied to whatever the wheel produced, so a wheel-IN on a
 * box zoom deeper than 50x re-zoomed to the floor, i.e. zoomed OUT: [40, 40.5]
 * s of a 100 s flight became [39.25, 41.25] s, on every synced panel (audit
 * 2026-09-22). Now:
 *  - a wheel-out is never floored (it can only widen the window);
 *  - a wheel-in that would cross the floor stops ON it, as before;
 *  - a wheel-in on a window already at or under the floor holds it exactly —
 *    the wheel goes no deeper, and the exact hold is what lets the caller's
 *    no-op test hand the event back to the page.
 */
export function wheelWindow(
  min: number, max: number, focus: number, factor: number, dataMin: number, dataMax: number,
): XWindow {
  const win = zoomWindow(min, max, focus, factor, dataMin, dataMax);
  const floor = (dataMax - dataMin) / WHEEL_MAX_DEPTH;
  if (!(floor > 0) || factor >= 1 || win.max - win.min >= floor) return win;
  if (max - min <= floor) return { min, max };
  return zoomWindow(min, max, focus, floor / (max - min), dataMin, dataMax);
}

/** Translates the window by dx (value space), clamped without resizing. */
export function panWindow(
  min: number, max: number, dx: number, dataMin: number, dataMax: number,
): XWindow {
  return clampWindow(min + dx, max + dx, dataMin, dataMax);
}

/**
 * True when the x-scale shows the whole data extent. Exact equality is the
 * contract, same as the wheel handler's no-op detection: clampWindow returns
 * the extent verbatim, uPlot's autoscale and double-click reset set exactly
 * the data min/max, and the pan/zoom paths all round-trip through
 * clampWindow — so a Reset-view button can be disabled on `===` without an
 * epsilon.
 */
export function isFullExtent(min: number, max: number, dataMin: number, dataMax: number): boolean {
  return min === dataMin && max === dataMax;
}

/**
 * The structural slice of a uPlot instance the zoom-state / reset helpers
 * read, so the helpers stay unit-testable with plain objects (uPlot itself
 * needs a real layout pass to construct).
 */
export interface XPlot {
  data: ArrayLike<ArrayLike<number | null | undefined>>;
  scales: { [key: string]: { min?: number | null; max?: number | null } };
  setScale(key: string, win: XWindow): void;
}

/** The plot's own x data extent, [0, 0] when it has no points. */
export function xDataExtent(p: XPlot): [number, number] {
  const xs = p.data[0];
  if (!xs || xs.length === 0) return [0, 0];
  return [xs[0] as number, xs[xs.length - 1] as number];
}

/** Whether the plot currently shows less than its full x extent. */
export function plotIsZoomed(p: XPlot): boolean {
  const sc = p.scales['x'];
  if (!sc || sc.min == null || sc.max == null) return false;
  const [d0, d1] = xDataExtent(p);
  if (!(d1 > d0)) return false;
  return !isFullExtent(sc.min, sc.max, d0, d1);
}

/**
 * Resets every plot to its own full x extent — the Reset-view button's
 * action, equivalent to the (undiscoverable) double-click gesture. Plots
 * with no data are left alone.
 */
export function resetPlots(plots: Iterable<XPlot>): void {
  for (const p of plots) {
    const [d0, d1] = xDataExtent(p);
    if (d1 > d0) p.setScale('x', { min: d0, max: d1 });
  }
}

/**
 * Chart-panel canvas height. Widths drive heights (capped) so a wide chart
 * doesn't flatten into a ribbon; `expanded` is the per-panel ⤢ button —
 * a much taller canvas for reading fine structure. Pure so the sizing
 * policy is unit-testable.
 */
export function panelHeight(width: number, expanded: boolean): number {
  return expanded
    ? Math.max(300, Math.min(560, Math.round(width * 0.42)))
    : Math.max(160, Math.min(240, Math.round(width * 0.22)));
}

export function panZoomPlugin(
  getPeers?: () => Iterable<uPlot>,
  /**
   * Called after any x-scale change on THIS plot (own gesture, peer
   * broadcast, uPlot's double-click reset, initial autoscale) — the hook a
   * Reset-view button uses to track whether the view is zoomed.
   */
  onXScale?: (u: uPlot) => void,
): uPlot.Plugin {
  return {
    hooks: {
      ...(onXScale ? {
        setScale: (u: uPlot, key: string) => {
          if (key === 'x') onXScale(u);
        },
      } : {}),
      init: (u: uPlot) => {
        const over = u.over;
        // Horizontal touch-drag pans the chart; vertical stays the page
        // scroll (a chart that swallows vertical swipes traps the page).
        over.style.touchAction = 'pan-y';

        const extent = (): [number, number] => xDataExtent(u);

        const setWindow = (win: XWindow) => {
          u.setScale('x', win);
          if (getPeers) {
            for (const p of getPeers()) {
              if (p !== u) p.setScale('x', win);
            }
          }
        };

        // Manual non-passive listener: browsers register wheel passive by
        // default, and a passive listener cannot preventDefault the page
        // scroll out from under the zoom.
        over.addEventListener('wheel', (e) => {
          const sc = u.scales['x']!;
          if (sc.min == null || sc.max == null) return;
          const focus = u.posToVal(e.clientX - over.getBoundingClientRect().left, 'x');
          const [d0, d1] = extent();
          // Normalised by how far the wheel actually turned, so one physical
          // detent means the same thing on every device — see wheelZoomFactor.
          // The wheel does not get to zoom for ever. Past WHEEL_MAX_DEPTH the
          // axis labels stop being useful and getting back out is a long
          // scroll; a box drag, which says "exactly this much", is unlimited —
          // and wheelWindow leaves a box zoom deeper than that alone.
          const win = wheelWindow(sc.min, sc.max, focus, wheelZoomFactor(e), d0, d1);
          // Only swallow the wheel when the zoom actually changes the window.
          // A no-op (wheel-out at full extent, the common resting state) must
          // leave the event to the page, or charts become scroll traps. The
          // exact-equality comparison is safe because clampWindow returns the
          // data extent verbatim (tested in chartPanZoom.test.ts).
          if (win.min === sc.min && win.max === sc.max) return;
          e.preventDefault();
          setWindow(win);
        }, { passive: false });

        let panId: number | null = null;
        let panX = 0;
        const wantsPan = (e: { pointerType?: string; button: number; shiftKey: boolean }) =>
          e.pointerType === 'touch' || e.button === 1 || (e.button === 0 && e.shiftKey);

        over.addEventListener('pointerdown', (e) => {
          if (panId != null || !wantsPan(e)) return;
          // Canceling the pointerdown suppresses the compatibility mousedown,
          // so uPlot's select-box drag never starts (the capture-phase
          // mousedown interceptor below is the belt for engines that
          // dispatch it anyway). Plain drags stay uPlot's select-zoom.
          e.preventDefault();
          panId = e.pointerId;
          panX = e.clientX;
          over.setPointerCapture(e.pointerId);
        }, { capture: true });

        over.addEventListener('pointermove', (e) => {
          if (panId !== e.pointerId) return;
          const sc = u.scales['x']!;
          if (sc.min == null || sc.max == null) return;
          const dxPx = e.clientX - panX;
          panX = e.clientX;
          // Value-space delta for the pixel motion: dragging right slides
          // the window left, so the data follows the pointer.
          const dx = u.posToVal(0, 'x') - u.posToVal(dxPx, 'x');
          const [d0, d1] = extent();
          setWindow(panWindow(sc.min, sc.max, dx, d0, d1));
        });

        const endPan = (e: PointerEvent) => {
          if (panId === e.pointerId) panId = null;
        };
        over.addEventListener('pointerup', endPan);
        // A vertical touch drag hands the gesture back to the page scroller
        // (touch-action above) and cancels the pointer — end the pan too.
        over.addEventListener('pointercancel', endPan);

        // uPlot binds its select-box mousedown on this same element in the
        // bubble phase; a capture listener runs first, so pan gestures never
        // reach it and the select box never starts.
        over.addEventListener('mousedown', (e) => {
          if (panId != null || e.button === 1 || (e.button === 0 && e.shiftKey)) {
            e.preventDefault();
            e.stopImmediatePropagation();
          }
        }, { capture: true });
      },
    },
  };
}
