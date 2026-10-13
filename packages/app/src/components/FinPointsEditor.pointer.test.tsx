// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinPointsEditor, type FinPoint } from './FinPointsEditor.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { useTreeHistory, type TreeHistory } from '../hooks/useTreeHistory.js';
import type { RocketTree } from '@online-openrocket/engine';

/**
 * The freeform fin editor's POINTER paths, which had no test at all (audit
 * 2026-09-22) — FinPointsEditor.test.tsx covers the coordinate table and the
 * outline guard, and every finding the audit made in this component lived in
 * the untested half:
 *
 *  • a press moved its point from the first pixel of jitter, and the release
 *    committed even when nothing had moved — so every click, and both clicks of
 *    the double-click that deletes a point, spent an undo step;
 *  • the release committed the points of the last RENDER, not the last pointer
 *    position, so a move and a release in one frame lost the move;
 *  • a right-press or a second finger started a drag, and nothing ended one the
 *    browser cancelled.
 *
 * Freeform fins are the project owner's own primary workflow.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let commits: FinPoint[][];
let rectSpy: ReturnType<typeof vi.spyOn>;

/**
 * The editor's own 4-point clipped delta. At the 300x170 viewBox, PAD 22, it
 * lays out at 4200 px/m (the height fit wins), so on screen:
 *   P1 (22, 148)  P2 (106, 22)  P3 (211, 22)  P4 (274, 148)
 */
const GOOD: FinPoint[] = [[0, 0], [0.020, 0.030], [0.045, 0.030], [0.060, 0]];
const PX_PER_M = 4200;

beforeEach(() => {
  // A client rect the same size as the viewBox, so client px == svg px.
  rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 300, bottom: 170, width: 300, height: 170,
    toJSON: () => ({}),
  } as DOMRect);
  localStorage.clear();
  commits = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <PrefsProvider>
        <FinPointsEditor points={GOOD} onChange={(n) => commits.push(n)} />
      </PrefsProvider>,
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  rectSpy.mockRestore();
});

const svgEl = () => host.querySelector('svg')!;
/** Point i's generous invisible grab circle. */
const handle = (i: number) => host.querySelectorAll('circle[r="12"]')[i]!;

interface Ptr { x: number; y: number; id?: number; primary?: boolean; button?: number; buttons?: number; touch?: boolean; shift?: boolean }
const event = (type: string, p: Ptr) => new PointerEvent(type, {
  bubbles: true, cancelable: true,
  pointerId: p.id ?? 1, isPrimary: p.primary ?? true,
  clientX: p.x, clientY: p.y, button: p.button ?? 0,
  buttons: p.buttons ?? (type === 'pointerup' || type === 'pointercancel' ? 0 : 1),
  pointerType: p.touch ? 'touch' : 'mouse', shiftKey: p.shift ?? false,
});
const pointer = (el: Element, type: string, p: Ptr) => act(() => { el.dispatchEvent(event(type, p)); });

/** happy-dom does not retarget captured events or emit capture-transfer loss. */
const capturePointers = () => {
  const owners = new Map<number, Element>();
  for (const el of [svgEl(), ...host.querySelectorAll('circle[r="12"]')]) {
    el.setPointerCapture = (id) => {
      const previous = owners.get(id);
      owners.set(id, el);
      if (previous && previous !== el) {
        previous.dispatchEvent(event('lostpointercapture', { id, x: 0, y: 0, touch: true }));
      }
    };
    el.hasPointerCapture = (id) => owners.get(id) === el;
    el.releasePointerCapture = (id) => {
      if (owners.get(id) !== el) return;
      owners.delete(id);
      el.dispatchEvent(event('lostpointercapture', { id, x: 0, y: 0, touch: true }));
    };
  }
  return (id: number, hit: Element) => owners.get(id) ?? hit;
};
const commonAncestor = (down: Element, up: Element): Element => {
  let target = down;
  while (!target.contains(up)) target = target.parentElement!;
  return target;
};

const wheel = (x = 106, y = 22, deltaY = -100) => {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY });
  // happy-dom's WheelEvent extends UIEvent, omitting the browser's mouse coordinates.
  Object.defineProperties(e, { clientX: { value: x }, clientY: { value: y } });
  act(() => { svgEl().dispatchEvent(e); });
  return e;
};
const location = (i: number) => [Number(handle(i).getAttribute('cx')), Number(handle(i).getAttribute('cy'))];
const key = (value: string) => act(() => {
  svgEl().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
});

describe('view gestures preserve fin coordinates (N019)', () => {
  it('does not rescale when a zoomed point drag moves beyond the original outline', () => {
    wheel();
    const unmoved = location(2);
    pointer(handle(1), 'pointerdown', { x: 106, y: 22 });
    pointer(svgEl(), 'pointermove', { x: 106, y: -20 });
    expect(location(2)).toEqual(unmoved);
    pointer(svgEl(), 'pointermove', { x: 106, y: -40 });
    expect(location(2)).toEqual(unmoved);
    pointer(svgEl(), 'pointerup', { x: 106, y: -40 });
    expect(commits).toHaveLength(1);
    expect(commits[0]![1]![1]).toBeCloseTo(0.03 + 62 * 0.9 / 4200, 12);
  });

  it('uses client-to-drawing scaling at a narrow size for pan and zoomed editing', () => {
    rectSpy.mockReturnValue({ left: 10, top: 20, width: 180, height: 102 } as DOMRect);
    pointer(svgEl(), 'pointerdown', { x: 106, y: 80 });
    pointer(svgEl(), 'pointermove', { x: 124, y: 86 });
    pointer(svgEl(), 'pointerup', { x: 124, y: 86 });
    expect(location(1)).toEqual([136, 32]);
    wheel(91.6, 39.2);
    pointer(handle(1), 'pointerdown', { x: 91.6, y: 39.2 });
    pointer(svgEl(), 'pointermove', { x: 109.6, y: 39.2 });
    pointer(svgEl(), 'pointerup', { x: 109.6, y: 39.2 });
    expect(commits).toHaveLength(1);
    expect(commits[0]![1]![0]).toBeCloseTo(0.02 + 30 * 0.9 / 4200, 12);
  });

  it('hands zero-delta and limit wheel events back to scrolling', () => {
    expect(wheel(106, 22, 0).defaultPrevented).toBe(false);
    for (let i = 0; i < 15; i++) wheel(106, 22, -300);
    expect(wheel(106, 22).defaultPrevented).toBe(false);
    expect(wheel(106, 22, 100).defaultPrevented).toBe(true);
    expect(commits).toEqual([]);
  });

  it.each(['wheel', 'button', 'keyboard'])('holds zoom in beyond a changed fit limit (%s)', (input) => {
    for (let i = 0; i < 15; i++) wheel(150, 85, -300);
    const larger = GOOD.map(([x, y]) => [x * 2, y * 2] as FinPoint);
    act(() => root.render(<PrefsProvider><FinPointsEditor points={larger}
      onChange={(next) => commits.push(next)} /></PrefsProvider>));
    const before = location(2);
    if (input === 'wheel') expect(wheel(150, 85).defaultPrevented).toBe(false);
    else if (input === 'keyboard') key('+');
    else act(() => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Zoom in')!.click(); });
    expect(location(2)).toEqual(before);
    wheel(150, 85, 100);
    // New top edge is 0.05 m at 210000 px/m, then one 0.9 zoom-out step.
    expect(location(2)[0]! - location(1)[0]!).toBeCloseTo(9450, 9);
    expect(commits).toEqual([]);
  });

  it.each(['wheel', 'button', 'keyboard'])('holds zoom out beyond a changed fit limit (%s)', (input) => {
    for (let i = 0; i < 15; i++) wheel(150, 85, 300);
    const smaller = GOOD.map(([x, y]) => [x / 2, y / 2] as FinPoint);
    act(() => root.render(<PrefsProvider><FinPointsEditor points={smaller}
      onChange={(next) => commits.push(next)} /></PrefsProvider>));
    const before = location(2);
    if (input === 'wheel') expect(wheel(150, 85, 100).defaultPrevented).toBe(false);
    else if (input === 'keyboard') key('-');
    else act(() => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Zoom out')!.click(); });
    expect(location(2)).toEqual(before);
    wheel(150, 85);
    // New top edge is 0.0125 m at 1050 px/m, then one reciprocal-0.9 step.
    expect(location(2)[0]! - location(1)[0]!).toBeCloseTo(13.125 / 0.9, 9);
    expect(commits).toEqual([]);
  });

  it('keeps both fingers captured when a second finger takes over a point drag', () => {
    const svg = svgEl();
    const target = capturePointers();
    pointer(handle(1), 'pointerdown', { x: 106, y: 22, touch: true });
    pointer(svg, 'pointerdown', { x: 206, y: 22, touch: true, id: 2, primary: false });
    pointer(target(2, document.body), 'pointermove', { x: 306, y: 22, touch: true, id: 2, primary: false });
    expect(location(2)[0]).toBeCloseTo(316, 9);
    expect(commits).toEqual([]);
    pointer(target(1, document.body), 'pointermove', { x: 116, y: 32, touch: true });
    expect(location(2)[1]).toBeCloseTo(27, 9);
    pointer(target(1, document.body), 'pointerup', { x: 116, y: 32, touch: true });
    pointer(target(2, document.body), 'pointerup', { x: 306, y: 22, touch: true, id: 2, primary: false });
    expect(commits).toEqual([]);
  });

  it('view gestures spend no undo steps and a long zoomed drag undoes in one step', () => {
    let history: TreeHistory;
    const initial: RocketTree = { components: [{ type: 'freeformfinset', id: 'fin', points: GOOD }] };
    function EditorWithHistory() {
      history = useTreeHistory(initial);
      return <PrefsProvider><FinPointsEditor
        points={history.tree.components[0]!['points'] as FinPoint[]}
        onChange={(points) => history.setTree({ components: [{ ...history.tree.components[0]!, points }] })}
      /></PrefsProvider>;
    }
    act(() => root.render(<EditorWithHistory />));
    wheel();
    key('ArrowRight');
    expect(history!.tree).toEqual(initial);
    expect(history!.canUndo).toBe(false);
    pointer(handle(1), 'pointerdown', { x: 86, y: 22 });
    pointer(svgEl(), 'pointermove', { x: 106, y: 22 });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    pointer(svgEl(), 'pointermove', { x: 126, y: 22 });
    pointer(svgEl(), 'pointerup', { x: 126, y: 22 });
    const edited = history!.tree;
    expect(edited).not.toEqual(initial);
    act(() => history!.undo());
    expect(history!.tree).toEqual(initial);
    expect(history!.canUndo).toBe(false);
    act(() => history!.redo());
    expect(history!.tree).toEqual(edited);
    vi.restoreAllMocks();
  });

  it('wheel zoom anchors the pointer, consumes scrolling, and a later drag commits once', () => {
    expect(wheel().defaultPrevented).toBe(true);
    expect(location(1)).toEqual([106, 22]);
    expect(location(2)[0]).toBeCloseTo(106 + 105 / 0.9, 9);
    expect(commits).toEqual([]);
    pointer(handle(1), 'pointerdown', { x: 106, y: 22 });
    pointer(svgEl(), 'pointermove', { x: 136, y: 22 });
    const frozen = location(2);
    expect(wheel().defaultPrevented).toBe(false);
    key('ArrowRight');
    expect(location(2)).toEqual(frozen);
    pointer(svgEl(), 'pointermove', { x: 146, y: 22 });
    pointer(svgEl(), 'pointerup', { x: 146, y: 22 });
    expect(commits).toHaveLength(1);
    expect(commits[0]![1]![0]).toBeCloseTo(0.02 + 40 * 0.9 / 4200, 12);
  });

  it('empty-space dragging pans instead of inserting and fit restores the view', () => {
    pointer(svgEl(), 'pointerdown', { x: 160, y: 100 });
    pointer(svgEl(), 'pointermove', { x: 190, y: 110 });
    expect(svgEl().style.cursor).toBe('grabbing');
    pointer(svgEl(), 'pointerup', { x: 190, y: 110 });
    expect(svgEl().style.cursor).toBe('crosshair');
    expect(location(1)).toEqual([136, 32]);
    expect(commits).toEqual([]);
    const fit = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Fit view')!;
    act(() => fit.click());
    expect(location(1)).toEqual([106, 22]);
    expect(commits).toEqual([]);
  });

  it('modifier-drag over a point pans, then insertion uses the transformed nearest edge', () => {
    pointer(handle(1), 'pointerdown', { x: 106, y: 22, shift: true });
    pointer(svgEl(), 'pointermove', { x: 136, y: 32, shift: true });
    pointer(svgEl(), 'pointerup', { x: 136, y: 32, shift: true });
    expect(commits).toEqual([]);
    expect(location(1)).toEqual([136, 32]);
    wheel(136, 32);
    pointer(svgEl(), 'pointerdown', { x: 196, y: 32 });
    pointer(svgEl(), 'pointerup', { x: 196, y: 32 });
    expect(commits).toHaveLength(1);
    expect(commits[0]![2]![0]).toBeCloseTo(0.02 + 60 * 0.9 / 4200, 12);
    expect(commits[0]![2]![1]).toBeCloseTo(0.03, 12);
  });

  it('keyboard pan, zoom and reset leave stored points and coordinate fields unchanged', () => {
    const before = structuredClone(GOOD);
    key('ArrowRight');
    expect(location(1)).toEqual([86, 22]);
    key('+');
    expect(location(1)[0]).not.toBe(86);
    key('0');
    expect(location(1)).toEqual([106, 22]);
    expect(GOOD).toEqual(before);
    expect(commits).toEqual([]);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Point 2 x"]')!.value).toBe('20');
    expect(svgEl().getAttribute('tabindex')).toBe('0');
  });

  it('two fingers take over a point edit as pinch and pan, with no edit on either release', () => {
    pointer(handle(1), 'pointerdown', { x: 106, y: 22, touch: true });
    pointer(svgEl(), 'pointermove', { x: 116, y: 22, touch: true });
    pointer(svgEl(), 'pointerdown', { x: 216, y: 22, id: 2, primary: false, touch: true });
    pointer(svgEl(), 'pointermove', { x: 316, y: 22, id: 2, primary: false, touch: true });
    expect(location(1)[0]).toBeCloseTo(96, 9); // sub-pixel transform roundoff
    expect(location(1)[1]).toBeCloseTo(22, 9);
    pointer(svgEl(), 'pointermove', { x: 126, y: 32, touch: true });
    pointer(svgEl(), 'pointermove', { x: 326, y: 32, id: 2, primary: false, touch: true });
    expect(location(1)[0]).toBeCloseTo(106, 9);
    expect(location(1)[1]).toBeCloseTo(32, 9);
    pointer(svgEl(), 'pointerup', { x: 326, y: 32, id: 2, primary: false, touch: true });
    pointer(svgEl(), 'pointermove', { x: 160, y: 70, touch: true });
    pointer(svgEl(), 'pointerup', { x: 160, y: 70, touch: true });
    expect(commits).toEqual([]);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Point 2 x"]')!.value).toBe('20');
  });

  it('a cancelled pinch cannot become an insertion or a point drop', () => {
    pointer(svgEl(), 'pointerdown', { x: 160, y: 100, touch: true });
    pointer(svgEl(), 'pointerdown', { x: 200, y: 100, touch: true, id: 2, primary: false });
    pointer(svgEl(), 'pointercancel', { x: 200, y: 100, touch: true, id: 2, primary: false });
    pointer(svgEl(), 'pointerup', { x: 160, y: 100, touch: true });
    expect(commits).toEqual([]);
  });
});

describe('a click on a point is not an edit', () => {
  it('a press and release with no movement commits nothing', () => {
    pointer(handle(1), 'pointerdown', { x: 106, y: 22 });
    pointer(svgEl(), 'pointerup', { x: 106, y: 22 });
    expect(commits).toEqual([]);
  });

  it('2 px of click jitter neither moves the point nor commits', () => {
    pointer(handle(1), 'pointerdown', { x: 106, y: 22 });
    pointer(svgEl(), 'pointermove', { x: 108, y: 23 });
    pointer(svgEl(), 'pointerup', { x: 108, y: 23 });
    expect(commits).toEqual([]);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Point 2 x"]')!.value).toBe('20');
  });

  it.each([false, true])('a capture-adjusted double-click delete is ONE edit (touch=%s)', (touch) => {
    const target = capturePointers();
    let clickTarget: Element;
    // Both clicks of a double-click press and release a point first.
    for (let k = 0; k < 2; k++) {
      const down = handle(2);
      pointer(down, 'pointerdown', { x: 211, y: 22, touch });
      const up = target(1, down);
      pointer(up, 'pointerup', { x: 211, y: 22, touch });
      clickTarget = commonAncestor(down, up);
      act(() => { clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: k + 1 })); });
    }
    act(() => { clickTarget!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 })); });
    expect(commits).toEqual([[[0, 0], [0.020, 0.030], [0.060, 0]]]);
  });

  it('losing a single point capture cancels the edit instead of dropping it', () => {
    const target = capturePointers();
    pointer(handle(1), 'pointerdown', { x: 106, y: 22 });
    pointer(target(1, document.body), 'pointermove', { x: 136, y: 22 });
    act(() => { target(1, document.body).releasePointerCapture(1); });
    expect(location(1)).toEqual([106, 22]);
    pointer(svgEl(), 'pointerup', { x: 136, y: 22 });
    expect(commits).toEqual([]);
  });

  it('a real drag moves the point and commits once', () => {
    pointer(handle(1), 'pointerdown', { x: 106, y: 22 });
    pointer(svgEl(), 'pointermove', { x: 136, y: 22 });
    pointer(svgEl(), 'pointerup', { x: 136, y: 22 });
    expect(commits).toHaveLength(1);
    expect(commits[0]![1]![0]).toBeCloseTo(0.020 + 30 / PX_PER_M, 9);
    expect(commits[0]![1]![1]).toBeCloseTo(0.030, 9);
  });

  it('commits where the pointer WAS released, even with no render in between', () => {
    // A move and a release in one frame: the release handler used to read the
    // live points of the last committed render, i.e. before this move.
    act(() => {
      handle(1).dispatchEvent(event('pointerdown', { x: 106, y: 22 }));
    });
    act(() => {
      svgEl().dispatchEvent(event('pointermove', { x: 136, y: 22 }));
      svgEl().dispatchEvent(event('pointerup', { x: 136, y: 22 }));
    });
    expect(commits).toHaveLength(1);
    expect(commits[0]![1]![0]).toBeCloseTo(0.020 + 30 / PX_PER_M, 9);
  });
});

describe('a click on the empty canvas still inserts a point', () => {
  it('inserts at the PRESS position, commits once, and ignores the jitter', () => {
    // (160, 22) is on the top edge P2->P3, 54 px from either end.
    pointer(svgEl(), 'pointerdown', { x: 160, y: 22 });
    pointer(svgEl(), 'pointermove', { x: 162, y: 23 });
    pointer(svgEl(), 'pointerup', { x: 162, y: 23 });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toHaveLength(5);
    expect(commits[0]![2]![0]).toBeCloseTo((160 - 22) / PX_PER_M, 9);
    expect(commits[0]![2]![1]).toBeCloseTo(0.030, 9);
  });
});

describe('the gesture belongs to one pointer and one button', () => {
  it('a right-press on a point starts nothing', () => {
    pointer(handle(1), 'pointerdown', { x: 106, y: 22, button: 2, buttons: 2 });
    pointer(svgEl(), 'pointermove', { x: 150, y: 60, buttons: 2 });
    pointer(svgEl(), 'pointerup', { x: 150, y: 60, button: 2 });
    expect(commits).toEqual([]);
  });

  it('a right-press on the canvas inserts nothing', () => {
    pointer(svgEl(), 'pointerdown', { x: 160, y: 22, button: 2, buttons: 2 });
    pointer(svgEl(), 'pointerup', { x: 160, y: 22, button: 2 });
    expect(commits).toEqual([]);
  });

  it('a second finger neither starts a drag nor steers the first one', () => {
    pointer(handle(1), 'pointerdown', { x: 106, y: 22, id: 1 });
    pointer(svgEl(), 'pointerdown', { x: 160, y: 100, id: 2, primary: false });
    pointer(svgEl(), 'pointermove', { x: 260, y: 140, id: 2, primary: false });
    pointer(svgEl(), 'pointerup', { x: 260, y: 140, id: 2, primary: false });
    expect(commits).toEqual([]);
    // Finger one's own drag is intact and ends on its own release.
    pointer(svgEl(), 'pointermove', { x: 136, y: 22, id: 1 });
    pointer(svgEl(), 'pointerup', { x: 136, y: 22, id: 1 });
    expect(commits).toHaveLength(1);
    expect(commits[0]).toHaveLength(4);
    expect(commits[0]![1]![0]).toBeCloseTo(0.020 + 30 / PX_PER_M, 9);
  });

  it('a cancelled drag is not a drop: nothing commits and the point goes back', () => {
    pointer(handle(1), 'pointerdown', { x: 106, y: 22 });
    pointer(svgEl(), 'pointermove', { x: 150, y: 60 });
    pointer(svgEl(), 'pointercancel', { x: 150, y: 60 });
    expect(commits).toEqual([]);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Point 2 x"]')!.value).toBe('20');
    // And it stays ended.
    pointer(svgEl(), 'pointermove', { x: 200, y: 60 });
    pointer(svgEl(), 'pointerup', { x: 200, y: 60 });
    expect(commits).toEqual([]);
  });

  it('a buttonless move ends a drag whose release was lost, where it was left', () => {
    pointer(handle(1), 'pointerdown', { x: 106, y: 22 });
    pointer(svgEl(), 'pointermove', { x: 136, y: 22 });
    pointer(svgEl(), 'pointermove', { x: 200, y: 90, buttons: 0 });
    pointer(svgEl(), 'pointermove', { x: 220, y: 90, buttons: 0 });
    expect(commits).toHaveLength(1);
    expect(commits[0]![1]![0]).toBeCloseTo(0.020 + 30 / PX_PER_M, 9);
  });
});
