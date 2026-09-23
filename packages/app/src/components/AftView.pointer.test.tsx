// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { clusterOffsets } from '../tree/cluster.js';
import { AftView } from './AftView.js';

// A call-through spy on one function the cross-section walk calls once per
// inner tube — a count of it is a count of walks.
vi.mock('../tree/cluster.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../tree/cluster.js')>();
  return { ...real, clusterOffsets: vi.fn(real.clusterOffsets) };
});

/**
 * The aft view's own input handling (audit 2026-09-22), driven by real events.
 * TreeSchematic.pointer.test.tsx pins the same rules on the side view.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let rectSpy: ReturnType<typeof vi.spyOn>;

const TREE = {
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [{ id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.024 }],
  }],
} as unknown as RocketTree;

const svgEl = () => host.querySelector('svg')!;
/** The zoom group's transform — the view state, as drawn. */
const view = () => svgEl().querySelector('g')!.getAttribute('transform') ?? '';

beforeEach(() => {
  // happy-dom lays out at 0x0, and the wheel maps the pointer through the
  // svg's client rect — give it a real one.
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 360, bottom: 360, width: 360, height: 360,
    toJSON: () => ({}),
  } as DOMRect);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<AftView tree={TREE} />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  rectSpy.mockRestore();
});

describe('the wheel is swallowed only when it zooms (audit 2026-09-22)', () => {
  // The drawing's preventDefault ran on EVERY wheel event, so at fit (or at
  // the 12x stop) the page could not scroll with the pointer over it — on the
  // Motors tab, where this view and the side view take most of the page.
  const wheel = (deltaY: number): boolean => {
    const ev = new WheelEvent('wheel', { deltaY, clientX: 180, clientY: 180, bubbles: true, cancelable: true });
    act(() => { svgEl().dispatchEvent(ev); });
    return ev.defaultPrevented;
  };

  it('wheel-out at fit leaves the event to the page and the view alone', () => {
    const before = view();
    expect(wheel(100)).toBe(false);
    expect(view()).toBe(before);
  });

  it('wheel-in zooms and keeps the page still; back out to fit, then hands over again', () => {
    expect(wheel(-100)).toBe(true);
    expect(view()).toContain('scale(1.15)');
    expect(wheel(100)).toBe(true); // this one does zoom: 1.15x -> fit
    expect(view()).toContain('scale(1)');
    expect(wheel(100)).toBe(false);
  });

  it('wheel-in at the 12x stop hands the event back too', () => {
    for (let i = 0; i < 20; i++) wheel(-300);
    expect(view()).toContain('scale(12)');
    expect(wheel(-100)).toBe(false);
  });
});

describe('zooming and panning do not re-walk the tree (audit 2026-09-22)', () => {
  // The cross-section walk ran in the render body, so every wheel notch and
  // every pan move rebuilt every shape — every pod ring, every cluster copy —
  // for a view whose geometry had not changed.
  const clustered = {
    name: 'Rocket',
    components: [{
      id: 's1', type: 'stage',
      children: [{
        id: 'b1', type: 'bodytube', length: 0.3, outerRadius: 0.024,
        children: [{ id: 'mt', type: 'innertube', length: 0.1, outerRadius: 0.0095, cluster: '3-ring' }],
      }],
    }],
  } as unknown as RocketTree;
  const walks = () => vi.mocked(clusterOffsets).mock.calls.length;

  it('walks once per tree or roll, not once per wheel notch or pan move', () => {
    act(() => root.render(<AftView tree={clustered} />));
    const after = walks();
    expect(after).toBeGreaterThan(0);
    const ev = new WheelEvent('wheel', { deltaY: -100, clientX: 180, clientY: 180, bubbles: true, cancelable: true });
    act(() => { svgEl().dispatchEvent(ev); });
    expect(view()).toContain('scale(1.15)'); // it did re-render
    const ptr = (type: string, x: number) => act(() => {
      svgEl().dispatchEvent(new PointerEvent(type, {
        bubbles: true, pointerId: 1, isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: x, clientY: 180,
      }));
    });
    ptr('pointerdown', 180);
    ptr('pointermove', 220);
    ptr('pointerup', 220);
    expect(walks()).toBe(after);
    // A real change still re-walks.
    act(() => root.render(<AftView tree={clustered} roll={0.5} />));
    expect(walks()).toBe(after + 1);
  });
});

/**
 * THE PAN TAKES THE SIDE VIEW'S GESTURE RULES (seam review of audit
 * 2026-09-22). The audit gated TreeSchematic's drag and pan — primary button of
 * the primary pointer only, a move with the button up is a release it never
 * saw, and a gesture belongs to the pointer that started it — and left this
 * view's pan as it was: a right-press panned (on macOS the context menu then
 * swallows the release, so the view followed a bare mouse), and a second finger
 * drove the first finger's pan.
 */
describe('the pan follows only the press that started it', () => {
  type Ptr = { id?: number; primary?: boolean; button?: number; buttons?: number; x: number };
  const ptr = (type: string, p: Ptr) => act(() => {
    svgEl().dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: p.id ?? 1, isPrimary: p.primary ?? true,
      button: p.button ?? 0, buttons: p.buttons ?? (type === 'pointerup' || type === 'pointercancel' ? 0 : 1),
      clientX: p.x, clientY: 180,
    }));
  });
  const zoomIn = () => act(() => { host.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click(); });
  beforeEach(zoomIn);

  it('a primary press pans (the gesture these rules must keep)', () => {
    const before = view();
    ptr('pointerdown', { x: 180 });
    ptr('pointermove', { x: 220 });
    expect(view()).not.toBe(before);
  });

  it('a right-press does not pan, even when the move that follows reports no button', () => {
    const before = view();
    ptr('pointerdown', { button: 2, buttons: 2, x: 180 });
    ptr('pointermove', { buttons: 0, x: 220 });
    ptr('pointermove', { buttons: 2, x: 260 });
    expect(view()).toBe(before);
  });

  it('a move with the button up ends the pan: the release it never saw', () => {
    ptr('pointerdown', { x: 180 });
    ptr('pointermove', { x: 200 });
    const panned = view();
    ptr('pointermove', { buttons: 0, x: 240 });
    ptr('pointermove', { buttons: 1, x: 280 }); // no new press: nothing to follow
    expect(view()).toBe(panned);
  });

  it("a second finger neither starts a pan nor drives or ends the first one's", () => {
    ptr('pointerdown', { x: 180 });
    ptr('pointermove', { x: 200 });
    const first = view();
    ptr('pointerdown', { id: 2, primary: false, x: 100 });
    ptr('pointermove', { id: 2, primary: false, x: 60 });
    expect(view()).toBe(first);
    ptr('pointerup', { id: 2, primary: false, x: 60 });
    ptr('pointermove', { x: 240 });
    expect(view()).not.toBe(first); // still the first finger's pan
  });

  it('a cancelled pointer ends the pan', () => {
    ptr('pointerdown', { x: 180 });
    ptr('pointermove', { x: 200 });
    const panned = view();
    ptr('pointercancel', { x: 200 });
    ptr('pointermove', { x: 260 });
    expect(view()).toBe(panned);
  });
});
