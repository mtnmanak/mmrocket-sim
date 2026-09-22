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
