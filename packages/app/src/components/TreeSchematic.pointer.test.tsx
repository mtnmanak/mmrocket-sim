// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { TreeSchematic } from './TreeSchematic.js';

/**
 * The 2D side view's axial drag, driven by real pointer SEQUENCES (audit
 * 2026-09-22). Synthesized clicks press and release at one coordinate, so the
 * suite never saw what a physical click does: jitter a pixel or two, and — on a
 * touch screen — share the surface with a second finger.
 *
 *  • The 4 px threshold only decided whether the release still counted as a
 *    CLICK. Every pointermove patched the tree regardless, and the snap ran at
 *    zero distance: 2 px of click jitter moved a fin set 1.5 mm, and a fin 3 mm
 *    from the tube end snapped onto it with no movement at all — while the
 *    click still selected it. Every such patch is a real edit: CG and CP move,
 *    an undo step is spent and the design is marked unsaved.
 *  • The gesture was not tied to a pointer or a button: a second finger's
 *    moves drove the first finger's drag, a right-press started one, and with
 *    the release lost to the context menu a buttonless move kept dragging.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let rectSpy: ReturnType<typeof vi.spyOn>;

const BODY_R = 0.012;

const rocket = (children: Record<string, unknown>[]): RocketTree => ({
  name: 'Rocket',
  components: [{
    id: 's1', type: 'stage',
    children: [
      { id: 'n1', type: 'nosecone', shape: 'ogive', length: 0.1, aftRadius: BODY_R },
      { id: 'b1', type: 'bodytube', length: 0.3, outerRadius: BODY_R, children },
    ],
  }],
} as unknown as RocketTree);

const fin = (position: { method: string; offset: number }) => ({
  id: 'f1', type: 'trapezoidfinset', finCount: 3, rootChord: 0.05, tipChord: 0.03,
  sweep: 0.02, height: 0.03, position,
});

type Patch = { id: string; patch: Partial<ComponentNode> };

const mount = (tree: RocketTree, onSelect = vi.fn()) => {
  const patches: Patch[] = [];
  act(() => root.render(
    <TreeSchematic tree={tree} info={null} onSelect={onSelect}
      onPatchNode={(id, patch) => patches.push({ id, patch })} />,
  ));
  return { patches, onSelect };
};

const svgEl = () => host.querySelector('svg')!;
const finShape = () => host.querySelector('polygon')!;

interface Ptr { x: number; y?: number; id?: number; primary?: boolean; button?: number; buttons?: number }
const pointer = (el: Element, type: string, p: Ptr) => act(() => {
  el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true,
    pointerId: p.id ?? 1, isPrimary: p.primary ?? true,
    clientX: p.x, clientY: p.y ?? 0,
    button: p.button ?? 0,
    buttons: p.buttons ?? (type === 'pointerup' || type === 'pointercancel' ? 0 : 1),
  }));
});
const click = (el: Element) => act(() => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

beforeEach(() => {
  // happy-dom lays everything out at 0x0 and beginDrag bails on a zero-width
  // svg — without this no drag would start and every "no patch" below would
  // pass for the wrong reason. 640 client px on a 640-wide viewBox = 1:1.
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 240, width: 640, height: 240,
    toJSON: () => ({}),
  } as DOMRect);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  rectSpy.mockRestore();
});

describe('a click is not a drag: the threshold gates the PATCH', () => {
  it('2 px of click jitter on a fin set moves nothing, and still selects it', () => {
    const { patches, onSelect } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200 });
    pointer(svgEl(), 'pointermove', { x: 202 });
    pointer(svgEl(), 'pointerup', { x: 202 });
    click(finShape());
    expect(patches).toEqual([]);
    expect(onSelect).toHaveBeenCalledWith('f1');
  });

  it('a press with NO movement does not snap a fin 3 mm from the tube end onto it', () => {
    // 3 mm is ~4 px at this scale — inside the ~6 px snap radius, so the old
    // code patched offset 0 on the very first pointermove, at zero distance.
    const { patches, onSelect } = mount(rocket([fin({ method: 'bottom', offset: -0.003 })]));
    pointer(finShape(), 'pointerdown', { x: 300 });
    pointer(svgEl(), 'pointermove', { x: 300 });
    pointer(svgEl(), 'pointerup', { x: 300 });
    click(finShape());
    expect(patches).toEqual([]);
    expect(onSelect).toHaveBeenCalledWith('f1');
  });

  it('clicking an internal part with jitter leaves it where it is', () => {
    // Internal parts cover up to 85 % of the tube's height, so they are what a
    // click aimed at the body tube most often lands on.
    const { patches } = mount(rocket([{
      id: 'it', type: 'innertube', length: 0.08, outerRadius: 0.009,
      position: { method: 'top', offset: 0.05 },
    }]));
    const inner = [...host.querySelectorAll('rect[stroke-dasharray="3 2"]')]
      .find((r) => r.querySelector('title')?.textContent === 'Inner tube')!;
    pointer(inner, 'pointerdown', { x: 250 });
    pointer(svgEl(), 'pointermove', { x: 253 });
    pointer(svgEl(), 'pointermove', { x: 251 });
    pointer(svgEl(), 'pointerup', { x: 251 });
    expect(patches).toEqual([]);
  });

  it('a move past the threshold that snaps back onto the SAME anchor patches nothing', () => {
    // Bottom-anchored at the tube end; 5 px aft is past the 4 px threshold but
    // inside the snap radius, so the snapped offset is the one it already has.
    const { patches } = mount(rocket([fin({ method: 'bottom', offset: 0 })]));
    pointer(finShape(), 'pointerdown', { x: 300 });
    pointer(svgEl(), 'pointermove', { x: 305 });
    pointer(svgEl(), 'pointerup', { x: 305 });
    expect(patches).toEqual([]);
  });

  it('a real drag still moves the part, and patches once per CHANGED offset', () => {
    const { patches, onSelect } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200 });
    pointer(svgEl(), 'pointermove', { x: 240 });
    pointer(svgEl(), 'pointermove', { x: 240 }); // same spot: nothing new to write
    pointer(svgEl(), 'pointerup', { x: 240 });
    click(finShape());
    expect(patches).toHaveLength(1);
    expect(patches[0]!.id).toBe('f1');
    const off = (patches[0]!.patch.position as { offset: number }).offset;
    expect(off).toBeGreaterThan(0.1);
    // The release of a real drag is not a selection.
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('the gesture belongs to one pointer and one button', () => {
  it('a second finger\'s moves do not drive the first finger\'s drag', () => {
    const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200, id: 1 });
    // Finger two lands 200 px away and slides: not primary, other pointerId.
    pointer(svgEl(), 'pointerdown', { x: 400, id: 2, primary: false });
    pointer(svgEl(), 'pointermove', { x: 430, id: 2, primary: false });
    pointer(svgEl(), 'pointerup', { x: 430, id: 2, primary: false });
    expect(patches).toEqual([]);
    // Finger one still owns its drag.
    pointer(svgEl(), 'pointermove', { x: 240, id: 1 });
    expect(patches).toHaveLength(1);
  });

  it('a right-press does not start a drag, and a buttonless move after it moves nothing', () => {
    const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200, button: 2, buttons: 2 });
    // The context menu swallowed the release; the mouse then moves bare.
    pointer(svgEl(), 'pointermove', { x: 230, buttons: 0 });
    expect(patches).toEqual([]);
  });

  it('a buttonless move ends a drag whose release was lost', () => {
    const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200 });
    pointer(svgEl(), 'pointermove', { x: 240 });
    expect(patches).toHaveLength(1);
    pointer(svgEl(), 'pointermove', { x: 300, buttons: 0 });
    pointer(svgEl(), 'pointermove', { x: 320, buttons: 0 });
    expect(patches).toHaveLength(1);
  });

  it('pointercancel ends the drag', () => {
    const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200 });
    pointer(svgEl(), 'pointermove', { x: 240 });
    pointer(svgEl(), 'pointercancel', { x: 240 });
    pointer(svgEl(), 'pointermove', { x: 300 });
    expect(patches).toHaveLength(1);
  });

  it('losing pointer capture ends the drag', () => {
    const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200 });
    pointer(svgEl(), 'pointermove', { x: 240 });
    pointer(svgEl(), 'lostpointercapture', { x: 240 });
    pointer(svgEl(), 'pointermove', { x: 300 });
    expect(patches).toHaveLength(1);
  });

  it('a right-press on the background does not arm a pan', () => {
    mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    const transform = () => [...svgEl().querySelectorAll('g')]
      .map((g) => g.getAttribute('transform') ?? '').find((t) => t.includes('translate')) ?? '';
    const before = transform();
    pointer(svgEl(), 'pointerdown', { x: 100, y: 100, button: 2, buttons: 2 });
    pointer(svgEl(), 'pointermove', { x: 160, y: 140, buttons: 2 });
    expect(transform()).toBe(before);
  });
});
