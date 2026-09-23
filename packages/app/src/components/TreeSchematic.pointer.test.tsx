// @vitest-environment happy-dom
import { act, Profiler, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { TreeSchematic } from './TreeSchematic.js';
import { updateNode } from '../tree/treeModel.js';

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

interface Ptr {
  x: number; y?: number; id?: number; primary?: boolean; button?: number; buttons?: number;
  kind?: 'mouse' | 'touch';
}
const pointer = (el: Element, type: string, p: Ptr) => act(() => {
  el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true,
    pointerId: p.id ?? 1, isPrimary: p.primary ?? true, pointerType: p.kind ?? 'mouse',
    clientX: p.x, clientY: p.y ?? 0,
    button: p.button ?? 0,
    buttons: p.buttons ?? (type === 'pointerup' || type === 'pointercancel' ? 0 : 1),
  }));
});
const click = (el: Element) => act(() => {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

/** The offset a patch wrote. */
const offsetOf = (p: Patch | undefined) => (p?.patch.position as { offset: number } | undefined)?.offset;
/** The x of the fin shape's first point, as drawn. */
const finX = () => Number(finShape().getAttribute('points')!.split(' ')[0]!.split(',')[0]);
/**
 * What an uneventful mouse drag of the standard fin from x 200 to `x` commits
 * — the yardstick the tests below hold an interrupted gesture's commit to,
 * snapping included.
 */
const cleanDrag = (x: number): number | undefined => {
  const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
  pointer(finShape(), 'pointerdown', { x: 200 });
  pointer(svgEl(), 'pointermove', { x });
  pointer(svgEl(), 'pointerup', { x });
  return offsetOf(patches[0]);
};

beforeEach(() => {
  // happy-dom lays everything out at 0x0 and the drag's begin (useAxialDrag)
  // bails on a zero-width svg — without this no drag would start and every
  // "no patch" below would pass for the wrong reason. 640 client px on a
  // 640-wide viewBox = 1:1.
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

  it('a real drag still moves the part, and patches once, on release', () => {
    const { patches, onSelect } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200 });
    pointer(svgEl(), 'pointermove', { x: 240 });
    pointer(svgEl(), 'pointermove', { x: 240 }); // same spot: nothing new to draw
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

/**
 * A DRAG IS A LOCAL PREVIEW, COMMITTED ONCE ON RELEASE (audit 2026-09-22,
 * Performance). Every pointermove used to call onPatchNode, App mapped that to
 * setTree, and App rebuilds the kernel from the tree in render: 73 ms a move on
 * kitchensink.ork, ~13 fps. The host below is App's wiring in miniature — it
 * applies each patch with the same `updateNode` and counts the rebuilds a memo
 * keyed on `tree.components` would run, which is what App's buildResult is.
 */
describe('a drag is a local preview, committed once on release', () => {
  const stats = { builds: 0, patches: 0 };
  function Host({ initial }: { initial: RocketTree }) {
    const [tree, setTree] = useState(initial);
    // App's buildResult: one kernel build per new `tree.components`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components, as App keys it
    useMemo(() => { stats.builds++; }, [tree.components]);
    return (
      <TreeSchematic tree={tree} info={null} onSelect={() => {}}
        onPatchNode={(id, patch) => { stats.patches++; setTree(updateNode(tree, id, patch)); }} />
    );
  }
  const host = () => {
    stats.builds = 0;
    stats.patches = 0;
    act(() => root.render(<Host initial={rocket([fin({ method: 'top', offset: 0.1 })])} />));
    expect(stats.builds).toBe(1);
  };

  it('the part follows the pointer, and the design is written — and rebuilt — once', () => {
    host();
    const x0 = finX();
    pointer(finShape(), 'pointerdown', { x: 200 });
    const drawn: number[] = [];
    for (let x = 206; x <= 290; x += 7) {
      pointer(svgEl(), 'pointermove', { x });
      drawn.push(finX());
    }
    // Twelve moves, every one drawn where the pointer is going...
    expect(new Set(drawn).size).toBeGreaterThan(8);
    expect(drawn.at(-1)!).toBeGreaterThan(x0 + 60);
    // ...and not one of them an edit: no write, no rebuild.
    expect(stats.patches).toBe(0);
    expect(stats.builds).toBe(1);
    const previewed = finShape().getAttribute('points');
    pointer(svgEl(), 'pointerup', { x: 290 });
    expect(stats.patches).toBe(1);
    expect(stats.builds).toBe(2);
    // What the preview drew is exactly what the committed design draws.
    expect(finShape().getAttribute('points')).toBe(previewed);
  });

  it('a part dragged away and let go where it was pressed is not an edit', () => {
    host();
    const x0 = finX();
    pointer(finShape(), 'pointerdown', { x: 200 });
    pointer(svgEl(), 'pointermove', { x: 260 });
    expect(finX()).toBeGreaterThan(x0);
    pointer(svgEl(), 'pointermove', { x: 200 });
    pointer(svgEl(), 'pointerup', { x: 200 });
    expect(stats.patches).toBe(0);
    expect(stats.builds).toBe(1);
    expect(finX()).toBe(x0);
  });

  it('a move that lands on the anchor the part already has draws nothing new', () => {
    // Bottom-anchored at the tube end: every move inside the snap radius lands
    // on the offset the fin already has — no preview state, so not one render.
    stats.builds = 0;
    stats.patches = 0;
    let renders = 0;
    act(() => root.render(
      <Profiler id="drag" onRender={() => { renders++; }}>
        <Host initial={rocket([fin({ method: 'bottom', offset: 0 })])} />
      </Profiler>,
    ));
    const before = finShape();
    const r0 = renders;
    pointer(before, 'pointerdown', { x: 300 });
    pointer(svgEl(), 'pointermove', { x: 305 });
    pointer(svgEl(), 'pointermove', { x: 303 });
    expect(renders).toBe(r0);
    pointer(svgEl(), 'pointerup', { x: 303 });
    expect(stats.patches).toBe(0);
    expect(stats.builds).toBe(1);
  });

  it('the shape under the pointer is the same element for the whole drag', () => {
    // The preview re-renders the view on every move, and a remounted element
    // would drop the pointer capture the drag holds on it. A move adds and
    // removes no shape, so this guards against a key that carried the part's
    // POSITION; the next case is the one that tells an identity key from a
    // counter.
    host();
    const before = finShape();
    pointer(before, 'pointerdown', { x: 200 });
    for (let x = 210; x <= 260; x += 10) pointer(svgEl(), 'pointermove', { x });
    expect(finShape()).toBe(before);
    pointer(svgEl(), 'pointerup', { x: 260 });
    expect(finShape()).toBe(before);
    expect(stats.patches).toBe(1);
  });

  it('a shape that appears ahead of the grabbed one mid-drag does not remount it', () => {
    // A motor loaded into the tube the fins sit on draws its case BEFORE the
    // fins (tree/schematicLayout.ts). Under the old counter keys every shape
    // after it was renumbered — the grabbed fin among them — and React
    // remounted it under the pointer. An identity key leaves it alone.
    let loadMotor!: () => void;
    const patches: Patch[] = [];
    function MotorHost() {
      const [motors, setMotors] = useState<Record<string, { length: number; diameter: number; label?: string }>>();
      loadMotor = () => setMotors({ b1: { length: 0.07, diameter: 0.018, label: 'F42' } });
      return (
        <TreeSchematic tree={rocket([fin({ method: 'top', offset: 0.1 })])} info={null} motors={motors}
          onSelect={() => {}} onPatchNode={(id, patch) => patches.push({ id, patch })} />
      );
    }
    act(() => root.render(<MotorHost />));
    const before = finShape();
    const rects = svgEl().querySelectorAll('rect').length;
    pointer(before, 'pointerdown', { x: 200 });
    pointer(svgEl(), 'pointermove', { x: 230 });
    act(() => loadMotor());
    // The case is drawn now...
    expect(svgEl().querySelectorAll('rect').length).toBeGreaterThan(rects);
    // ...and the fin under the pointer is still the element it pressed.
    expect(finShape()).toBe(before);
    pointer(svgEl(), 'pointermove', { x: 260 });
    expect(finShape()).toBe(before);
    pointer(svgEl(), 'pointerup', { x: 260 });
    expect(patches).toHaveLength(1);
    expect(offsetOf(patches[0])).toBeGreaterThan(0.1);
  });
});

describe('the gesture belongs to one pointer and one button', () => {
  it('a second finger\'s moves do not drive the first finger\'s drag', () => {
    const expected = cleanDrag(240);
    const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    const x0 = finX();
    pointer(finShape(), 'pointerdown', { x: 200, id: 1 });
    // Finger two lands 200 px away and slides: not primary, other pointerId.
    pointer(svgEl(), 'pointerdown', { x: 400, id: 2, primary: false });
    pointer(svgEl(), 'pointermove', { x: 430, id: 2, primary: false });
    pointer(svgEl(), 'pointerup', { x: 430, id: 2, primary: false });
    expect(patches).toEqual([]);
    expect(finX()).toBe(x0); // not even on screen
    // Finger one still owns its drag, and its release is the one that commits.
    pointer(svgEl(), 'pointermove', { x: 240, id: 1 });
    expect(finX()).toBeGreaterThan(x0);
    pointer(svgEl(), 'pointerup', { x: 240, id: 1 });
    expect(patches).toHaveLength(1);
    expect(offsetOf(patches[0])).toBe(expected);
  });

  it('a right-press does not start a drag, and a buttonless move after it moves nothing', () => {
    const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200, button: 2, buttons: 2 });
    // The context menu swallowed the release; the mouse then moves bare.
    pointer(svgEl(), 'pointermove', { x: 230, buttons: 0 });
    expect(patches).toEqual([]);
  });

  it('a buttonless move ends a drag whose release was lost', () => {
    const expected = cleanDrag(240);
    const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200 });
    pointer(svgEl(), 'pointermove', { x: 240 });
    // The release happened somewhere this view never saw: where the part was
    // last drawn is what is committed — once — and the later moves are nobody's.
    pointer(svgEl(), 'pointermove', { x: 300, buttons: 0 });
    pointer(svgEl(), 'pointermove', { x: 320, buttons: 0 });
    expect(patches).toHaveLength(1);
    expect(offsetOf(patches[0])).toBe(expected);
  });

  it('pointercancel ends the drag', () => {
    const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200 });
    pointer(svgEl(), 'pointermove', { x: 240 });
    pointer(svgEl(), 'pointercancel', { x: 240 });
    pointer(svgEl(), 'pointermove', { x: 300 });
    expect(patches).toHaveLength(1);
  });

  it('losing the pointer capture the drag took ends the drag', () => {
    // The drag captures on the pressed shape itself, so that is where the
    // browser fires lostpointercapture when it takes the pointer away.
    const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200 });
    pointer(svgEl(), 'pointermove', { x: 240 });
    pointer(finShape(), 'lostpointercapture', { x: 240, buttons: 0 });
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

describe('a lost capture ends only the gesture whose capture it was', () => {
  // On touch the browser captures the pointer IMPLICITLY to whatever was
  // pressed. The pan takes the capture for the svg only once it passes the
  // slop, which moves it off the pressed shape — and the browser then fires a
  // bubbling lostpointercapture FROM THAT SHAPE (reproduced in headless Chrome
  // with CDP touch input). The first cut of the lost-capture handling ended the
  // pan on it, so a touch pan that started on the rocket froze after its first
  // step. happy-dom raises no capture events of its own, so the tests fire the
  // one the browser fires, where it fires it.
  const transform = () => [...svgEl().querySelectorAll('g')]
    .map((g) => g.getAttribute('transform') ?? '').find((t) => t.includes('translate')) ?? '';
  const bodyTube = () => host.querySelector('[aria-label="Select Body tube"]')!;

  it('a touch pan that starts on the rocket survives the hand-off of the capture to the svg', () => {
    mount(rocket([]));
    pointer(bodyTube(), 'pointerdown', { x: 200, y: 120, kind: 'touch' });
    pointer(bodyTube(), 'pointermove', { x: 206, y: 120, kind: 'touch' });
    expect(transform()).toBe('translate(6 0) scale(1)');
    // The pan has just taken the capture for the svg: the tube loses its own.
    pointer(bodyTube(), 'lostpointercapture', { x: 206, y: 120, kind: 'touch' });
    pointer(svgEl(), 'pointermove', { x: 280, y: 120, kind: 'touch' });
    expect(transform()).toBe('translate(80 0) scale(1)');
  });

  it('the pan losing the capture it took ends the pan', () => {
    mount(rocket([]));
    pointer(svgEl(), 'pointerdown', { x: 200, y: 120, kind: 'touch' });
    pointer(svgEl(), 'pointermove', { x: 206, y: 120, kind: 'touch' });
    pointer(svgEl(), 'lostpointercapture', { x: 206, y: 120, kind: 'touch' });
    pointer(svgEl(), 'pointermove', { x: 280, y: 120, kind: 'touch' });
    expect(transform()).toBe('translate(6 0) scale(1)');
  });

  it('a touch drag of a part is not ended by a lost capture it never held', () => {
    const [at240, at280] = [cleanDrag(240), cleanDrag(280)];
    expect(at280).not.toBe(at240);
    const { patches } = mount(rocket([fin({ method: 'top', offset: 0.1 })]));
    pointer(finShape(), 'pointerdown', { x: 200, kind: 'touch' });
    pointer(finShape(), 'pointermove', { x: 240, kind: 'touch' });
    pointer(bodyTube(), 'lostpointercapture', { x: 240, kind: 'touch' });
    expect(patches).toEqual([]); // still dragging: nothing committed yet
    pointer(finShape(), 'pointermove', { x: 280, kind: 'touch' });
    pointer(finShape(), 'pointerup', { x: 280, kind: 'touch' });
    // One commit, from where the drag really ended.
    expect(patches).toHaveLength(1);
    expect(offsetOf(patches[0])).toBe(at280);
  });
});

describe('the wheel is swallowed only when it zooms (audit 2026-09-22)', () => {
  // The drawing's own preventDefault ran on EVERY wheel event, so at fit (or
  // at the 12x stop) the page could not scroll with the pointer over it.
  const wheel = (deltaY: number): boolean => {
    const ev = new WheelEvent('wheel', { deltaY, clientX: 320, clientY: 120, bubbles: true, cancelable: true });
    act(() => { svgEl().dispatchEvent(ev); });
    return ev.defaultPrevented;
  };
  const scaleOf = () => [...svgEl().querySelectorAll('g')]
    .map((g) => g.getAttribute('transform') ?? '').find((t) => t.includes('translate')) ?? '';

  it('wheel-out at fit leaves the event to the page and the view alone', () => {
    mount(rocket([]));
    const before = scaleOf();
    expect(wheel(100)).toBe(false);
    expect(scaleOf()).toBe(before);
  });

  it('wheel-in zooms and keeps the page still; back out to fit, then hands over again', () => {
    mount(rocket([]));
    expect(wheel(-100)).toBe(true);
    expect(scaleOf()).toContain('scale(1.2)');
    expect(wheel(100)).toBe(true); // this one does zoom: 1.2x -> fit
    expect(scaleOf()).toContain('scale(1)');
    expect(wheel(100)).toBe(false);
  });

  it('wheel-in at the 12x stop hands the event back too', () => {
    mount(rocket([]));
    for (let i = 0; i < 20; i++) wheel(-300);
    expect(scaleOf()).toContain('scale(12)');
    expect(wheel(-100)).toBe(false);
  });
});
