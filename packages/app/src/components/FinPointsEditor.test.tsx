// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FinPointsEditor, type FinPoint } from './FinPointsEditor.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * What this file protects: a freeform fin outline that crosses itself, or that
 * repeats a point, must never leave this editor. The kernel refuses such an
 * outline, so `OrkRocket.buildTree` throws (naming the fin set)
 * and App.tsx blanks the entire design — mass, CG, CP, stability, the stats
 * drawer, every export and both Launch buttons — after an edit that looked
 * fine on the canvas. tree/finOutline.test.ts pins that the check agrees with
 * the kernel; this file pins that the editor actually applies it.
 *
 * Freeform fins are the project owner's own primary workflow, so "refuse the
 * edit" must also never mean "refuse every edit": the "lets a design that
 * ARRIVED broken be edited with feedback" test covers an already-broken design.
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

it('explains a restored over-limit outline immediately', () => {
  render([[0, 0], [0.02, 3], [0.06, 0]]);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('2500 mm (98.425 in) coordinate limit');
});

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

/** Like onPatch/updateNode: commits return as props, possibly cloned. */
const renderStateful = (points: FinPoint[]) => {
  committed = [];
  let replacePoints: (next: FinPoint[]) => void;
  function Editor() {
    const [current, setCurrent] = useState(points);
    replacePoints = setCurrent;
    return <FinPointsEditor points={current} onChange={next => {
      committed.push(next);
      setCurrent(next.map(p => [...p] as FinPoint));
    }} />;
  }
  act(() => root.render(<PrefsProvider><Editor /></PrefsProvider>));
  return (next: FinPoint[]) => act(() => replacePoints(next));
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
  it('allows deleting an earlier point in a legacy oversized outline', () => {
    render([[0, 0], [0.01, 1], [0.02, 3], [0.06, 0]]);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Remove point 2"]')!.click());
    expect(committed).toEqual([[[0, 0], [0.02, 3], [0.06, 0]]]);
    expect(alertText()).not.toContain('The fin is unchanged.');
  });
  it('refuses worsening a smaller excess even when another legacy point is larger', () => {
    render([[0, 0], [0.02, 3], [0.04, 4], [0.06, 0]]);
    type(field('Point 2 y'), '3100');
    expect(committed).toEqual([]);
    expect(alertText()).toContain('The fin is unchanged.');
  });
  it('allows inserting a point ahead of an oversized legacy vertex', () => {
    render([[0, 0], [0.02, 3], [0.06, 0]]);
    const svg = host.querySelector('svg')!;
    const line = host.querySelector('polygon')!.getAttribute('points')!.split(' ').map(p => p.split(',').map(Number));
    const x = (line[0]![0]! + line[1]![0]!) / 2, y = (line[0]![1]! + line[1]![1]!) / 2;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 170 } as DOMRect);
    act(() => { svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1,
      button: 0, buttons: 1, isPrimary: true, clientX: x, clientY: y })); });
    act(() => { svg.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1,
      button: 0, buttons: 0, isPrimary: true, clientX: x, clientY: y })); });
    expect(committed).toHaveLength(1);
    expect(committed[0]).toHaveLength(4);
    expect(committed[0]![1]![0]).toBeCloseTo(0.01, 10);
    expect(committed[0]![1]![1]).toBeCloseTo(1.5, 10);
  });
  it('allows a negative forward sweep while retaining the existing positive excess', () => {
    render([[0, 0], [0.02, 3], [0.06, 0]]);
    type(field('Point 2 x'), '-3000');
    expect(committed).toEqual([[[0, 0], [-3, 3], [0.06, 0]]]);
    expect(alertText()).not.toContain('The fin is unchanged.');
  });
  it('allows uncrossing an oversized legacy outline before reducing its coordinates', () => {
    renderStateful([[0, 0], [0.04, 3], [0.02, 3], [0.06, 0]]);
    type(field('Point 2 x'), '10');
    expect(committed).toHaveLength(1);
    expect(alertText()).toContain('2500 mm (98.425 in) coordinate limit');
    expect(alertText()).not.toContain('The fin is unchanged.');
  });
  it('allows one-cell repairs of multiple oversized points and labels a refused worsening', () => {
    renderStateful([[0, 0], [0.02, 3], [0.04, 3], [0.06, 0]]);
    type(field('Point 2 y'), '2400');
    expect(committed).toHaveLength(1);
    expect(committed[0]![1]![1]).toBe(2.4);
    expect(alertText()).not.toContain('The fin is unchanged.');
    type(field('Point 3 y'), '3100');
    expect(committed).toHaveLength(1);
    expect(alertText()).toContain('The fin is unchanged.');
    type(field('Point 3 y'), '2400');
    expect(committed).toHaveLength(2);
    expect(alertText()).toBe('');
  });
  it('keeps intersection protection when an imported outline exceeds the coordinate limit', () => {
    render([[0, 0], [0.02, 3], [0.04, 0.02], [0.06, 0]]);
    type(field('Point 3 x'), '-20');
    expect(committed).toEqual([]);
    expect(alertText()).toContain('crosses itself');
  });
  it('refuses further over-limit edits to an already oversized outline', () => {
    render([[0, 0], [0.02, 3], [0.06, 0]]);
    type(field('Point 2 y'), '3100');
    expect(committed).toEqual([]);
    expect(alertText()).toContain('2500 mm (98.425 in) coordinate limit');
    type(field('Point 2 y'), '2400');
    expect(committed.at(-1)![1]![1]).toBe(2.4);
  });
  it('accepts origin-translated imported outlines and still refuses crossings', () => {
    render([[0.01, 0], [0.03, 0.03], [0.055, 0.03], [0.07, 0]]);
    expect(alertText()).toBe('');
    expect(outlineStroke()).toBe('#7a786f');
    type(field('Point 3 x'), '15');
    expect(committed).toEqual([]);
    expect(alertText()).toContain('crosses itself');
    type(field('Point 3 x'), '60');
    expect(committed).toHaveLength(1);
    expect(alertText()).toBe('');
  });
  it('refuses a valid triangle the simulator would clamp to 2.5 m', () => {
    render([[0, 0], [0.02, 0.03], [0.06, 0]]);
    type(field('Point 2 y'), '3000');
    expect(committed).toEqual([]);
    expect(alertText()).toContain('2500 mm (98.425 in) coordinate limit');
  });
  it('renders the table in the preference unit (mm) with point 1 locked', () => {
    render(GOOD);
    expect(field('Point 2 x').value).toBe('20');
    expect(field('Point 3 y').value).toBe('30');
    // Point 1 has no NumField at all — it is pinned to the origin.
    expect(host.querySelector('input[aria-label="Point 1 x"]')).toBeNull();
    expect(alertText()).toBe('');
  });

  it('marks every column header as one (scope="col"), so a reader names each cell’s column', () => {
    render(GOOD);
    const headers = [...host.querySelectorAll('table th')];
    expect(headers.length).toBe(4);
    for (const th of headers) expect(th.getAttribute('scope'), th.textContent ?? '').toBe('col');
  });

  it('refuses a coordinate that makes the outline cross itself', () => {
    render(GOOD);
    // Point 3 back to x = 5 mm: edge P3->P4 then cuts across edge P1->P2.
    type(field('Point 3 x'), '5');
    expect(committed).toEqual([]);
    expect(alertText()).toContain('crosses itself');
    expect(alertText()).toContain('The fin is unchanged.');
  });

  // S3b-g4 (audit 2026-10-17): external point changes retire stale edit feedback.
  it('clears a refused-edit alert when Undo changes the same fin points', () => {
    const replacePoints = renderStateful(GOOD);
    type(field('Point 3 x'), '5');
    expect(alertText()).toContain('crosses itself');
    const restored: FinPoint[] = [[0, 0], [0.02, 0.025], [0.045, 0.025], [0.06, 0]];
    replacePoints(restored);
    expect(field('Point 2 y').value).toBe('25');
    expect(outlineStroke()).toBe('#7a786f');
    expect(alertText()).toBe('');
    expect(committed).toEqual([]);
  });

  // S3b-g4 (audit 2026-10-17): equal coordinates keep the current refusal.
  it.each([{ label: 'stored outline', points: GOOD }, { label: 'starter outline', points: [] as FinPoint[] }])('keeps a refusal when the parent re-renders equal points ($label)', ({ points }) => {
    const replacePoints = renderStateful(points);
    // A crossing (stored outline) or zero root chord (starter) is refused.
    type(field('Point 3 x'), '0');
    const reason = alertText();
    expect(reason).toContain('The fin is unchanged.');
    replacePoints(points.map(p => [...p] as FinPoint));
    expect(alertText()).toBe(reason);
    expect(committed).toEqual([]);
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

  // S3b-g4 (audit 2026-10-17): cloned commit feedback keeps the edit's explanation.
  it('lets a design that ARRIVED broken be edited with feedback', () => {
    // Saved before this guard existed, or hand-edited .ork. Refusing every edit
    // here would trap the user in the exact state they are trying to escape,
    // and the design is already unbuildable, so nothing is made worse.
    const broken: FinPoint[] = [[0, 0], [0.020, 0.030], [0.005, 0.020], [0.060, 0]];
    const replacePoints = renderStateful(broken);
    // Still broken after this edit — but it is allowed through.
    type(field('Point 3 x'), '6');
    expect(committed.length).toBe(1);
    expect(committed[0]![2]![0]).toBeCloseTo(0.006, 9);
    // And the reason stays on screen, without the "unchanged" clause.
    expect(alertText()).toContain('crosses itself');
    expect(alertText()).not.toContain('The fin is unchanged.');
    // An unrelated parent render can clone the same outline again.
    const edited = committed[0]!;
    replacePoints(edited.map(p => [...p] as FinPoint));
    expect(alertText()).toContain('crosses itself');
    // Undo to genuinely different points clears the old edit's explanation.
    replacePoints(broken);
    expect(alertText()).toMatch(/crosses itself/);
  });

  it('shows the 3-point starter for a set with too few points, and an edit never leaks into it', () => {
    // Pins the fallback outline across the 2026-09-22 lint fix that moved it
    // to module scope (one shared array instead of a fresh one per render).
    const starterRows = () => [
      field('Point 2 x').value, field('Point 2 y').value, field('Point 3 x').value,
    ];
    render([]);
    expect(starterRows()).toEqual(['20', '30', '50']);

    type(field('Point 2 y'), '25');
    expect(committed).toEqual([[[0, 0], [0.020, 0.025], [0.050, 0]]]);
    const add = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Add point'))!;
    act(() => { add.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // The prop never changed, so this splits the STARTER's last edge.
    const split = committed[1]!;
    expect(split.length).toBe(4);
    expect(split[2]![0]).toBeCloseTo(0.035, 12);
    expect(split[2]![1]).toBeCloseTo(0.015, 12);
    // A consumer that edits the emitted outline in place must not reach the
    // starter the next freeform set is drawn from.
    try { split[1]![1] = 0.099; split[3]![0] = 0.099; } catch { /* a frozen starter refuses: also fine */ }

    render([[0, 0], [0.050, 0]]);
    expect(starterRows()).toEqual(['20', '30', '50']);
  });
});


it('shows an imported fin extent problem in preferred inches and counterpart millimetres', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'in' } }));
  render([[0, 0], [2.6, 1], [2.7, 2], [3, 0]]);
  type(field('Point 2 y'), '40');
  expect(host.textContent).toContain('within 98.425 in (2500 mm)');
});
