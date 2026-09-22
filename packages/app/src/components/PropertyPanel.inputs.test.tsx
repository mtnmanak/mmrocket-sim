// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComponentInfo, ComponentNode, RocketTree } from '@online-openrocket/engine';
import { PropertyPanel } from './PropertyPanel.js';
import { PrefsProvider, usePrefs } from '../prefs/PrefsContext.js';

/**
 * The property panel's numeric inputs, driven through the real panel — the
 * findings of the 2026-09-22 audit's "Design editing and numeric inputs"
 * section, each of which was measured this way before it was fixed.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let patches: Record<string, unknown>[];

const tube = (id: string, over: Record<string, unknown> = {}): ComponentNode => ({
  id, type: 'bodytube', name: id, length: 0.3, outerRadius: 0.02, thickness: 0.001, ...over,
} as unknown as ComponentNode);

const treeOf = (...nodes: ComponentNode[]): RocketTree => ({
  name: 'R', components: [{ id: 's1', type: 'stage', children: nodes }],
} as unknown as RocketTree);

const infoOf = (massKg: number): ComponentInfo => ({
  length: 0.3, mass: massKg, sectionMass: massKg, cgX: 0.15, positionX: 0,
} as unknown as ComponentInfo);

/**
 * Renders the panel into the SAME root every time, with no key — the way it
 * sat in App before the audit, and the way it still sits for one component
 * across an undo or a unit switch.
 */
const show = (tree: RocketTree, node: ComponentNode, info?: ComponentInfo,
  extra: Partial<Parameters<typeof PropertyPanel>[0]> = {}) => act(() => root.render(
  <PrefsProvider>
    <PropertyPanel tree={tree} node={node} info={info} onPatch={(p) => patches.push(p)} {...extra} />
  </PrefsProvider>,
));

const inputNamed = (name: string): HTMLInputElement =>
  host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
/** The ▴ (0) or ▾ (1) spinner beside a named NumField. */
const spinner = (name: string, i: 0 | 1): HTMLButtonElement =>
  inputNamed(name).closest('.numfield')!.querySelectorAll('button')[i] as HTMLButtonElement;
const click = (el: HTMLElement) => act(() => { el.click(); });
const labelStarting = (text: string): HTMLLabelElement =>
  [...host.querySelectorAll('label')].find((l) => (l.textContent ?? '').startsWith(text))!;

beforeEach(() => {
  localStorage.clear();
  patches = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('PropertyPanel — a spinner click leaves nothing behind for the next component', () => {
  /**
   * The audit's HIGH, reproduced as it was measured: tube B has no override and
   * a computed 120 g, yet its Mass-override field showed A's figure, and one ▴
   * committed A's mass plus a step onto B.
   */
  it("tube B's blank mass override neither shows nor steps from tube A's figure", () => {
    const a = tube('A', { overrideMass: 0.0451 });
    const b = tube('B');
    const tree = treeOf(a, b);
    show(tree, a, infoOf(0.05));
    click(spinner('Mass override', 0));
    expect(patches.at(-1)!['overrideMass']).toBeCloseTo(0.0452, 9);

    show(tree, b, infoOf(0.12));
    expect(inputNamed('Mass override').value, "B's own blank field, not A's 45.2").toBe('');
    click(spinner('Mass override', 0));
    // Seeded from B's computed 120 g (the placeholder), one 0.1 g step up.
    expect(patches.at(-1)!['overrideMass']).toBeCloseTo(0.1201, 9);
  });
});

describe('PropertyPanel — a spinner on a blank field with no figure behind it', () => {
  it('▴/▾ on a blank Cd override ("auto") commit nothing: the computed drag stays', () => {
    // Audit 2026-09-22, measured: ▴ committed overrideCD 0.05 and ▾ committed 0,
    // either one replacing the component's whole computed drag.
    const a = tube('A');
    show(treeOf(a), a, infoOf(0.05));
    click(spinner('Drag coefficient (Cd) override', 0));
    click(spinner('Drag coefficient (Cd) override', 1));
    expect(patches).toEqual([]);
    expect(document.activeElement).toBe(inputNamed('Drag coefficient (Cd) override'));
  });

  it('▴ on a blank mass override with no computed mass (a broken build) commits nothing', () => {
    const a = tube('A');
    show(treeOf(a), a, undefined);
    click(spinner('Mass override', 0));
    expect(patches).toEqual([]);
  });
});

describe('PropertyPanel — every field label names its own control', () => {
  /**
   * Audit 2026-09-22, measured with happy-dom: a label with no htmlFor labels
   * its first labelable descendant, which on Surface finish was the "→ all"
   * button — so clicking the words rewrote the finish, and the skin-friction
   * drag, of every component in the rocket.
   */
  it('clicking the words "Surface finish" does not apply it to every component', () => {
    const a = tube('A', { finish: 'smooth' });
    const all: Record<string, unknown>[] = [];
    show(treeOf(a), a, infoOf(0.05), { onPatchAll: (p) => all.push(p) });
    const label = labelStarting('Surface finish');
    click(label);
    expect(all, 'the label pressed "→ all"').toEqual([]);
    expect(label.querySelector('button'), 'no button lives inside the label').toBeNull();
    // The button itself still does its job.
    const allBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('→ all'))!;
    click(allBtn);
    expect(all).toEqual([{ finish: 'smooth' }]);
  });

  it('points each field label at its own input or select, never at a unit chip or a button', () => {
    const a = tube('A');
    show(treeOf(a), a, infoOf(0.05), { onPatchAll: () => {} });
    const labels = [...host.querySelectorAll('label')]
      // A label that WRAPS its checkbox is associated by nesting, correctly.
      .filter((l) => !l.querySelector('input[type="checkbox"]'));
    expect(labels.length).toBeGreaterThan(8);
    for (const l of labels) {
      const target = l.htmlFor ? document.getElementById(l.htmlFor) : null;
      expect(target, `"${l.textContent}" has no control`).not.toBeNull();
      expect(target!.classList.contains('unit-chip'), l.textContent ?? '').toBe(false);
      expect(['INPUT', 'SELECT'], l.textContent ?? '').toContain(target!.tagName);
    }
    // The DOM's own resolution agrees: the label's control is the typed box.
    expect(labelStarting('Length').control).toBe(inputNamed('Length (mm)'));
  });
});

describe('PropertyPanel — a "default:" or "auto:" figure in metres', () => {
  const prefs = (p: Record<string, unknown>) =>
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify(p));

  /**
   * Audit 2026-09-22 (review of the fix): these placeholders were rounded to
   * three decimals in the DISPLAY unit, and the spinner reads its base back
   * out of the placeholder. In metres a pre-v0.103 rail button's kernel 9.7 mm
   * read "default: 0.01", and one ▴ committed 10.5 mm, not 9.7 + 0.5.
   */
  it("a rail button's kernel default reads 0.0097 m, and ▴ steps from 9.7 mm", () => {
    prefs({ units: { length: 'm' } });
    const rb = { id: 'rb', type: 'railbutton', name: 'rb' } as unknown as ComponentNode;
    show(treeOf(tube('A', { children: [rb] })), rb);
    expect(inputNamed('Outer diameter (m)').placeholder).toBe('default: 0.0097');
    click(spinner('Outer diameter (m)', 0));
    expect(patches.at(-1)!['outerDiameter']).toBeCloseTo(0.0102, 9);
  });

  it("a tube-fin set's auto radius keeps its figures, and ▾ steps from the exact radius", () => {
    prefs({ units: { length: 'm' }, radiusMode: 'radius' });
    // Five tubes touching round a 20 mm-radius body: r = R·s / (1 − s), s = sin(π/5),
    // 28.52 mm — "auto: 0.029" at three decimals.
    const tf = { id: 'tf', type: 'tubefinset', name: 'tf', finCount: 5, length: 0.1,
      thickness: 0.0005 } as unknown as ComponentNode;
    show(treeOf(tube('A', { children: [tf] })), tf);
    const s = Math.sin(Math.PI / 5);
    const auto = 0.02 * s / (1 - s);
    expect(inputNamed('Outer radius (m)').placeholder).toBe('auto: 0.0285');
    click(spinner('Outer radius (m)', 1));
    expect(patches.at(-1)!['outerRadius']).toBeCloseTo(auto - 0.0005, 5);
  });

  it('the mass and CG overrides step from the computed figures, not their rounding', () => {
    // In kg a 4.5 g part's placeholder reads "0.004" and a 123.4 mm CG in m
    // reads "0.123"; ▴ committed 4.1 g and 124 mm.
    prefs({ units: { length: 'm', mass: 'kg' } });
    const a = tube('A');
    show(treeOf(a), a, { ...infoOf(0.0045), cgX: 0.1234 } as ComponentInfo);
    click(spinner('Mass override', 0));
    expect(patches.at(-1)!['overrideMass']).toBeCloseTo(0.0046, 9);
    click(spinner('CG override, from component top', 0));
    expect(patches.at(-1)!['overrideCGX']).toBeCloseTo(0.1244, 9);
  });
});

describe('PropertyPanel — clearing a field', () => {
  /** Native setter + input event, after a real focus — a keystroke. */
  const typeInto = (el: HTMLInputElement, text: string) => {
    if (document.activeElement !== el) act(() => el.focus());
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  /**
   * Audit 2026-09-22: clearing a required dimension committed `undefined`, and
   * every layer then used its own hidden default — a body tube's length flew
   * 0.3 m in the kernel and drew 0 in 3D.
   */
  it('an emptied REQUIRED dimension commits nothing and reverts on blur', () => {
    const a = tube('A');
    show(treeOf(a), a, infoOf(0.05));
    const length = inputNamed('Length (mm)');
    typeInto(length, '');
    expect(patches, 'no length: undefined reached the design').toEqual([]);
    act(() => length.blur());
    expect(length.value).toBe('300');
  });

  it('an OPTIONAL field still clears to its blank state', () => {
    const chute = { id: 'c', type: 'parachute', name: 'c', diameter: 0.5, cd: 1.2 } as unknown as ComponentNode;
    show(treeOf(tube('A', { children: [chute] })), chute);
    typeInto(inputNamed('Drag coefficient (blank = auto)'), '');
    expect(patches).toEqual([{ cd: undefined }]);
  });
});

describe('PropertyPanel — an unset select shows what the design flies', () => {
  const selectNamed = (name: string): HTMLSelectElement =>
    host.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
  const pick = (el: HTMLSelectElement, value: string) => act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

  it('a fin tab with no method shows Middle, and Front of fin is reachable', () => {
    // Audit 2026-09-22: it showed "Front of fin" (options[0]) for a tab every
    // reader placed mid-fin, and choosing Front of fin fired no change.
    const fins = { id: 'f', type: 'trapezoidfinset', finCount: 3, rootChord: 0.05,
      tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003,
      tabHeight: 0.005, tabLength: 0.02 } as unknown as ComponentNode;
    show(treeOf(tube('A', { children: [fins] })), fins);
    const method = selectNamed('Tab offset from');
    expect(method.value).toBe('middle');
    pick(method, 'top');
    expect(patches).toEqual([{ tabOffsetMethod: 'top' }]);
  });

  it('a camera shroud with no end shapes shows half-round at both ends, as shroudEnds reads it', () => {
    const sh = { id: 'sh', type: 'fairing', length: 0.08, width: 0.025, height: 0.02 } as unknown as ComponentNode;
    show(treeOf(tube('A', { children: [sh] })), sh);
    expect(selectNamed('Fore end (toward the nose)').value).toBe('halfround');
    expect(selectNamed('Aft end (toward the tail)').value).toBe('halfround');
    // And a pre-v0.088 single shape reaches both ends.
    const old = { ...sh, fairingShape: 'box' } as unknown as ComponentNode;
    show(treeOf(tube('A', { children: [old] })), old);
    expect(selectNamed('Fore end (toward the nose)').value).toBe('box');
  });

  it('a transition with no shape shows Conical', () => {
    const tr = { id: 't', type: 'transition', length: 0.04, foreRadius: 0.012,
      aftRadius: 0.009, thickness: 0.002 } as unknown as ComponentNode;
    show(treeOf(tr), tr);
    expect(selectNamed('Shape').value).toBe('conical');
  });
});

describe('PropertyPanel — the export note belongs to one component', () => {
  it("a fin's failed-export note does not follow the selection to the next part", () => {
    // Audit 2026-09-22: the note was panel state, so it outlived its component.
    const fins = { id: 'f', type: 'freeformfinset', finCount: 3, thickness: 0.003,
      points: [[0, 0], [0.05, 0]] } as unknown as ComponentNode; // no outline to cut
    const nose = { id: 'n', type: 'nosecone', length: 0.07, aftRadius: 0.012,
      thickness: 0.002, shape: 'ogive' } as unknown as ComponentNode;
    const tree = treeOf(nose, tube('A', { children: [fins] }));
    show(tree, fins);
    const dxf = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('DXF'))!;
    click(dxf);
    const note = () => host.querySelector('[role="alert"]')?.textContent ?? '';
    expect(note()).toMatch(/fin outline/);
    show(tree, nose);
    expect(note(), 'the fin warning under the nose cone').toBe('');
  });
});

describe('PropertyPanel — sliders', () => {
  const sliderNamed = (name: string): HTMLInputElement =>
    host.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${name}"]`)!;
  const pointer = (el: HTMLElement, type: string) => act(() => {
    el.dispatchEvent(new PointerEvent(type, { bubbles: true }));
  });
  /** What an arrow key does to a range input: a new value and an input event, no pointer. */
  const slideTo = (el: HTMLInputElement, v: number) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

  /**
   * Audit 2026-09-22: the range a drag freezes (so the handle does not chase
   * its own updates) was released only on pointerup. A touch the browser
   * cancels — a scroll gesture taking over — never sends one, and the slider
   * stayed on the stale range until the next complete drag.
   */
  for (const release of ['pointercancel', 'lostpointercapture']) {
    it(`${release} releases a frozen range`, () => {
      const a = tube('A');
      show(treeOf(a), a);
      pointer(sliderNamed('Length (mm)'), 'pointerdown');
      pointer(sliderNamed('Length (mm)'), release);
      // A tube longer than the slider's 1000 mm: the live range grows to hold it.
      const long = tube('A', { length: 5 });
      show(treeOf(long), long);
      expect(sliderNamed('Length (mm)').max).toBe('5000');
    });
  }

  it('a unit switch mid-drag does not keep the old unit’s range', () => {
    // Frozen in mm (0-1000), then inches: 1000 on an inch slider is 25 m.
    function Switch() {
      const { prefs, setPrefs } = usePrefs();
      return (
        <button type="button" id="to-inches"
          onClick={() => setPrefs({ ...prefs, units: { ...prefs.units, length: 'in' } })}>in</button>
      );
    }
    const a = tube('A');
    act(() => root.render(
      <PrefsProvider>
        <Switch />
        <PropertyPanel tree={treeOf(a)} node={a} onPatch={(p) => patches.push(p)} />
      </PrefsProvider>,
    ));
    pointer(sliderNamed('Length (mm)'), 'pointerdown');
    click(host.querySelector<HTMLButtonElement>('#to-inches')!);
    expect(Number(sliderNamed('Length (in)').max)).toBeCloseTo(1000 / 25.4, 6);
  });

  /**
   * Audit 2026-09-22: the Position slider snaps to structural anchors (tube and
   * sibling ends) within 1.5 % of the parent's length — right for a drag, and a
   * trap for the keyboard: one arrow press moves 1 mm off an anchor, and the
   * snap put it straight back, so the slider stuck at every tube end.
   */
  it('arrow keys step the Position slider off an anchor; a drag still snaps', () => {
    const mount = { id: 'm', type: 'innertube', name: 'm', length: 0.07, outerRadius: 0.009,
      thickness: 0.0005, position: { method: 'top', offset: 0 } } as unknown as ComponentNode;
    const tree = treeOf(tube('A', { children: [mount] }));
    show(tree, mount);
    slideTo(sliderNamed('Position offset'), 1);
    expect((patches.at(-1)!['position'] as { offset: number }).offset).toBeCloseTo(0.001, 12);

    pointer(sliderNamed('Position offset'), 'pointerdown');
    slideTo(sliderNamed('Position offset'), 1);
    pointer(sliderNamed('Position offset'), 'pointerup');
    expect((patches.at(-1)!['position'] as { offset: number }).offset).toBe(0);
  });
});
