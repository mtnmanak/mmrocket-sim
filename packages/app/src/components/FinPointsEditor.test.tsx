// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FinPointsEditor, type FinPoint } from './FinPointsEditor.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * What this file protects: a freeform fin outline that crosses itself, or that
 * repeats a point, must never leave this editor. The kernel refuses such an
 * outline by logging it through a Java `%g` format TeaVM does not implement, so
 * in the browser `OrkRocket.buildTree` throws `Unknown format conversion: g`
 * and App.tsx blanks the entire design — mass, CG, CP, stability, the stats
 * drawer, every export and both Launch buttons — after an edit that looked
 * fine on the canvas. tree/finOutline.test.ts pins that the check agrees with
 * the kernel; this file pins that the editor actually applies it.
 *
 * Freeform fins are the project owner's own primary workflow, so "refuse the
 * edit" must also never mean "refuse every edit": the last test covers a design
 * that arrived already broken.
 *
 * Rendered through react-dom's own root API with React's `act` — no
 * @testing-library in this workspace (see SiteBand.test.tsx).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let committed: FinPoint[][];
let seq = 0;

/** The editor's own 4-point clipped delta, in metres. */
const GOOD: FinPoint[] = [[0, 0], [0.020, 0.030], [0.045, 0.030], [0.060, 0]];

const render = (points: FinPoint[]) => {
  committed = [];
  seq += 1;
  act(() => {
    root.render(
      <PrefsProvider>
        <FinPointsEditor key={seq} points={points} onChange={(n) => committed.push(n)} />
      </PrefsProvider>,
    );
  });
};

const field = (label: string): HTMLInputElement =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

/** Native setter + input event — how React sees a real keystroke. */
const type = (el: HTMLInputElement, value: string) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const alertText = () => host.querySelector('[role="alert"]')?.textContent ?? '';
const outlineStroke = () => host.querySelector('polygon')!.getAttribute('stroke');

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('FinPointsEditor — the outline guard', () => {
  it('renders the table in the preference unit (mm) with point 1 locked', () => {
    render(GOOD);
    expect(field('Point 2 x').value).toBe('20');
    expect(field('Point 3 y').value).toBe('30');
    // Point 1 has no NumField at all — it is pinned to the origin.
    expect(host.querySelector('input[aria-label="Point 1 x"]')).toBeNull();
    expect(alertText()).toBe('');
  });

  it('refuses a coordinate that makes the outline cross itself', () => {
    render(GOOD);
    // Point 3 back to x = 5 mm: edge P3->P4 then cuts across edge P1->P2.
    type(field('Point 3 x'), '5');
    expect(committed).toEqual([]);
    expect(alertText()).toContain('crosses itself');
    expect(alertText()).toContain('The fin is unchanged.');
  });

  it('refuses a coordinate that lands one point on top of another', () => {
    render(GOOD);
    // Point 3 x onto point 2's x, with the same y — a zero-length edge, which
    // is the case both file importers already collapse by hand.
    type(field('Point 3 x'), '20');
    expect(committed).toEqual([]);
    expect(alertText()).toContain('in the same place');
  });

  it('still commits an ordinary coordinate edit', () => {
    render(GOOD);
    type(field('Point 3 x'), '50');
    expect(committed).toEqual([[[0, 0], [0.020, 0.030], [0.050, 0.030], [0.060, 0]]]);
    expect(alertText()).toBe('');
  });

  it('draws the outline red while it is one the kernel would refuse', () => {
    render(GOOD);
    expect(outlineStroke()).toBe('#7a786f');
    render([[0, 0], [0.020, 0.030], [0.005, 0.020], [0.060, 0]]);
    expect(outlineStroke()).toBe('#e34948');
  });

  it('"+ Add point" splits the last edge and commits', () => {
    render(GOOD);
    const add = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Add point'))!;
    act(() => { add.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(committed.length).toBe(1);
    // Midpoint of (0.045, 0.030) -> (0.060, 0).
    expect(committed[0]![3]).toEqual([0.0525, 0.015]);
    expect(committed[0]!.length).toBe(5);
  });

  it('the ✕ button still removes an interior point', () => {
    render(GOOD);
    const del = [...host.querySelectorAll<HTMLButtonElement>('button.fin-row-del')]
      .filter((b) => !b.disabled);
    act(() => { del[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(committed).toEqual([[[0, 0], [0.045, 0.030], [0.060, 0]]]);
  });

  it('lets a design that ARRIVED broken be edited back to sanity', () => {
    // Saved before this guard existed, or hand-edited .ork. Refusing every edit
    // here would trap the user in the exact state they are trying to escape,
    // and the design is already unbuildable, so nothing is made worse.
    const broken: FinPoint[] = [[0, 0], [0.020, 0.030], [0.005, 0.020], [0.060, 0]];
    render(broken);
    // Still broken after this edit — but it is allowed through.
    type(field('Point 3 x'), '6');
    expect(committed.length).toBe(1);
    expect(committed[0]![2]![0]).toBeCloseTo(0.006, 9);
    // And the reason stays on screen, without the "unchanged" clause.
    expect(alertText()).toContain('crosses itself');
    expect(alertText()).not.toContain('The fin is unchanged.');
  });
});
