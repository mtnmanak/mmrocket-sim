// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type uPlot from 'uplot';
import { panZoomPlugin } from './chartPanZoom.js';

/**
 * The pan half of panZoomPlugin is event wiring, and none of it was driven by
 * a test (audit 2026-09-30): only the wheel path was, through the flight
 * charts. Two failures would have shipped green. A pan whose `panId` is never
 * cleared swallows every later plain mousedown on the chart, so uPlot's
 * box-zoom silently stops working; and an interceptor that lets a shift or
 * middle mousedown through starts uPlot's select box under every pan.
 *
 * These drive the plugin's own listeners on a stand-in plot — the slice of
 * uPlot it reads — with uPlot's select-box mousedown bound on `over` BEFORE
 * the plugin's init hook runs, which is the order uPlot itself binds them in
 * (uPlot.esm.js 1.6.32: the mousedown at :5989, `fire("init")` at :6074).
 */

/** posToVal's slope: 10 px per second of flight, so 50 px is 5 s. */
const PX_PER_S = 10;

interface Stand {
  over: HTMLDivElement;
  data: number[][];
  scales: Record<string, { min: number | null; max: number | null }>;
  posToVal: (px: number, key: string) => number;
  setScale: ReturnType<typeof vi.fn<(key: string, win: { min: number; max: number }) => void>>;
  /** uPlot's own select-box mousedown listener. */
  selectBox: ReturnType<typeof vi.fn<(e: Event) => void>>;
}

const made: Stand[] = [];
afterEach(() => { for (const p of made.splice(0)) p.over.remove(); });

/** A 0–100 s flight showing 40–60 s. */
function stand(): Stand {
  const p: Stand = {
    over: document.createElement('div'),
    data: [[0, 25, 50, 75, 100]],
    scales: { x: { min: 40, max: 60 } },
    posToVal: (px) => px / PX_PER_S,
    setScale: vi.fn((key: string, win: { min: number; max: number }) => { p.scales[key] = { ...win }; }),
    selectBox: vi.fn(),
  };
  document.body.append(p.over);
  p.over.addEventListener('mousedown', p.selectBox);
  made.push(p);
  return p;
}

/** Runs the plugin's init hook on `p`, as uPlot does once per chart. */
function install(p: Stand, peers?: Stand[]): void {
  const init = panZoomPlugin(peers && (() => peers as unknown as uPlot[])).hooks.init;
  if (typeof init !== 'function') throw new Error('panZoomPlugin has no init hook');
  init(p as unknown as uPlot, {} as uPlot.Options, p.data as unknown as uPlot.AlignedData);
}

type Ptr = { id?: number; type?: string; button?: number; buttons?: number; shift?: boolean; x?: number };
/**
 * A pointer event as a browser sends it: `buttons` is what is held DURING the
 * event — the middle button is bit 4, a touch contact or the left button bit
 * 1 — and nothing once the pointer is up or cancelled.
 */
const pointer = (p: Stand, kind: string, o: Ptr = {}) => {
  const ended = kind === 'pointerup' || kind === 'pointercancel';
  const e = new PointerEvent(kind, {
    bubbles: true, cancelable: true, isPrimary: true, pointerId: o.id ?? 1, pointerType: o.type ?? 'mouse',
    button: o.button ?? 0, buttons: o.buttons ?? (ended ? 0 : o.button === 1 ? 4 : 1),
    shiftKey: o.shift ?? false, clientX: o.x ?? 0,
  });
  p.over.dispatchEvent(e);
  return e;
};
const mousedown = (p: Stand, o: { button?: number; shift?: boolean } = {}) => {
  const e = new MouseEvent('mousedown', {
    bubbles: true, cancelable: true, button: o.button ?? 0, shiftKey: o.shift ?? false,
  });
  p.over.dispatchEvent(e);
  return e;
};
const x = (p: Stand) => p.scales['x'];

describe('panZoomPlugin — which presses pan', () => {
  it('leaves a vertical touch swipe to the page (touch-action: pan-y)', () => {
    const a = stand();
    install(a);
    expect(a.over.style.touchAction).toBe('pan-y');
  });

  it('pans this chart and every peer on a shift-drag, the data following the pointer', () => {
    const [a, b, c] = [stand(), stand(), stand()];
    install(a, [a, b, c]); // a's own plot set includes a, as the flight charts' does
    const down = pointer(a, 'pointerdown', { shift: true, x: 100 });
    // Cancelled, so the browser sends no compatibility mousedown to start a select box.
    expect(down.defaultPrevented).toBe(true);
    expect(a.over.hasPointerCapture(1)).toBe(true);
    pointer(a, 'pointermove', { x: 150 }); // 50 px right: the window slides 5 s earlier
    for (const p of [a, b, c]) expect(x(p)).toEqual({ min: 35, max: 55 });
    expect(a.setScale).toHaveBeenCalledOnce(); // its own call; the peer loop skips it
    pointer(a, 'pointermove', { x: 130 }); // 20 px back, counted from the last move
    for (const p of [a, b, c]) expect(x(p)).toEqual({ min: 37, max: 57 });
    expect(a.selectBox).not.toHaveBeenCalled();
  });

  it.each([
    ['a middle-button drag', { button: 1 }],
    ['a one-finger touch drag', { type: 'touch' }],
  ])('pans on %s, with no Shift', (_, o: Ptr) => {
    const a = stand();
    install(a);
    expect(pointer(a, 'pointerdown', { ...o, x: 100 }).defaultPrevented).toBe(true);
    pointer(a, 'pointermove', { ...o, button: -1, buttons: o.button === 1 ? 4 : 1, x: 80 });
    expect(x(a)).toEqual({ min: 42, max: 62 });
  });

  it('leaves a plain drag to uPlot: its select box starts and nothing pans', () => {
    const a = stand();
    install(a);
    expect(pointer(a, 'pointerdown', { x: 100 }).defaultPrevented).toBe(false);
    expect(a.over.hasPointerCapture(1)).toBe(false);
    expect(mousedown(a).defaultPrevented).toBe(false);
    expect(a.selectBox).toHaveBeenCalledOnce();
    pointer(a, 'pointermove', { x: 150 });
    expect(a.setScale).not.toHaveBeenCalled();
  });

  it('pans nothing while the x scale is unset', () => {
    const a = stand();
    a.scales['x'] = { min: null, max: null };
    install(a);
    pointer(a, 'pointerdown', { shift: true, x: 100 });
    pointer(a, 'pointermove', { x: 150 });
    expect(a.setScale).not.toHaveBeenCalled();
  });

  it('stops at the data edge, read from this chart’s own data', () => {
    const a = stand();
    install(a);
    pointer(a, 'pointerdown', { shift: true, x: 0 });
    pointer(a, 'pointermove', { x: 1000 }); // 100 s right: past the start
    expect(x(a)).toEqual({ min: 0, max: 20 });
    pointer(a, 'pointermove', { x: -1000 }); // 200 s left: past the end
    expect(x(a)).toEqual({ min: 80, max: 100 });
  });
});

describe('panZoomPlugin — the mousedown interceptor keeps uPlot’s select box out of a pan', () => {
  it('stops a shift or middle mousedown before uPlot’s own listener sees it', () => {
    const a = stand();
    install(a);
    expect(mousedown(a, { shift: true }).defaultPrevented).toBe(true);
    expect(mousedown(a, { button: 1 }).defaultPrevented).toBe(true);
    expect(a.selectBox).not.toHaveBeenCalled();
  });

  it('stops any mousedown while a pan is held — a touch pan’s compatibility mouse event', () => {
    const a = stand();
    install(a);
    pointer(a, 'pointerdown', { type: 'touch', x: 100 });
    expect(mousedown(a).defaultPrevented).toBe(true);
    expect(a.selectBox).not.toHaveBeenCalled();
  });
});

describe('panZoomPlugin — a pan ends with its own pointer', () => {
  it.each(['pointerup', 'pointercancel'])('ends on %s: moves stop panning and a plain mousedown reaches uPlot again', (end) => {
    // pointercancel is how a vertical touch drag hands the gesture back to the page scroller.
    const a = stand();
    install(a);
    pointer(a, 'pointerdown', { shift: true, x: 100 });
    pointer(a, 'pointermove', { x: 110 });
    expect(a.setScale).toHaveBeenCalledOnce();
    pointer(a, end, { x: 110 });
    pointer(a, 'pointermove', { x: 200 });
    expect(a.setScale).toHaveBeenCalledOnce(); // no pan after the end
    // A stuck pan swallowed this, and with it every box-zoom on the chart.
    expect(mousedown(a).defaultPrevented).toBe(false);
    expect(a.selectBox).toHaveBeenCalledOnce();
  });

  it('holds a pan under pointer id 0, a valid id that a truthiness test would read as no pan', () => {
    const a = stand();
    install(a);
    pointer(a, 'pointerdown', { id: 0, shift: true, x: 100 });
    expect(mousedown(a).defaultPrevented).toBe(true); // held: no select box under the pan
    pointer(a, 'pointermove', { id: 0, x: 110 });
    expect(x(a)).toEqual({ min: 39, max: 59 });
    pointer(a, 'pointerup', { id: 0, x: 110 });
    expect(mousedown(a).defaultPrevented).toBe(false); // and released
    expect(a.selectBox).toHaveBeenCalledOnce();
  });

  it('ignores a second pointer: it starts no second pan, and neither steers nor ends the first', () => {
    const a = stand();
    install(a);
    pointer(a, 'pointerdown', { id: 1, shift: true, x: 100 });
    expect(pointer(a, 'pointerdown', { id: 2, type: 'touch', x: 300 }).defaultPrevented).toBe(false);
    expect(a.over.hasPointerCapture(2)).toBe(false);
    pointer(a, 'pointermove', { id: 2, x: 400 });
    expect(a.setScale).not.toHaveBeenCalled();
    pointer(a, 'pointerup', { id: 2, x: 400 });
    pointer(a, 'pointermove', { id: 1, x: 110 }); // still the first pointer's pan
    expect(x(a)).toEqual({ min: 39, max: 59 });
  });
});
