// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FinPointsEditor, type FinPoint } from './FinPointsEditor.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

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

interface Ptr { x: number; y: number; id?: number; primary?: boolean; button?: number; buttons?: number }
const event = (type: string, p: Ptr) => new PointerEvent(type, {
  bubbles: true, cancelable: true,
  pointerId: p.id ?? 1, isPrimary: p.primary ?? true,
  clientX: p.x, clientY: p.y, button: p.button ?? 0,
  buttons: p.buttons ?? (type === 'pointerup' || type === 'pointercancel' ? 0 : 1),
});
const pointer = (el: Element, type: string, p: Ptr) => act(() => { el.dispatchEvent(event(type, p)); });

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

  it('a double-click delete is ONE undo step, not three', () => {
    // Both clicks of a double-click press and release a point first.
    for (let k = 0; k < 2; k++) {
      pointer(handle(2), 'pointerdown', { x: 211, y: 22 });
      pointer(svgEl(), 'pointerup', { x: 211, y: 22 });
    }
    act(() => { handle(2).dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    expect(commits).toEqual([[[0, 0], [0.020, 0.030], [0.060, 0]]]);
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
