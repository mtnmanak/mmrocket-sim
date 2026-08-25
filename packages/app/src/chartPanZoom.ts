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

export const WHEEL_ZOOM_IN = 0.85;
export const WHEEL_ZOOM_OUT = 1.15;

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
          const win = zoomWindow(sc.min, sc.max, focus,
            e.deltaY < 0 ? WHEEL_ZOOM_IN : WHEEL_ZOOM_OUT, d0, d1);
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
