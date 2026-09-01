// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { ScaleDialog } from './ScaleDialog.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { ScaleResult } from '../tree/scaleRocket.js';

/**
 * The dialog's own job is the FACTOR ↔ TARGET DIAMETER link — the pair desktop
 * OpenRocket calls "Scale from X to Y", and the half of the feature a user
 * actually reaches for ("I have 4 inch tube; what does this 2.6 inch plan
 * become?"). Getting that inverse wrong silently scales by the reciprocal, and
 * nothing downstream would notice.
 *
 * Rendered through react-dom's own root API with React's `act` — no
 * @testing-library in this workspace (see SiteBand.test.tsx).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The preset catalogue is a 1.8 MB lazy import. Mocking it with an EMPTY array
 * (as this file first did) leaves the tube dropdown with no options, so the
 * catalogue -> factor division never runs — and that is the THIRD place a
 * reciprocal could hide, after the two NumFields. Mock it with real-shaped rows
 * instead, including a duplicate OD so the 0.1 mm bucketing is exercised.
 */
vi.mock('../services/presets.js', () => ({
  loadPresets: () => Promise.resolve([
    { kind: 'BodyTube', manufacturer: 'LOC', partNo: '4.0in', description: '', outsideDiameter: 0.102 },
    { kind: 'BodyTube', manufacturer: 'Other', partNo: 'dup', description: '', outsideDiameter: 0.10201 },
    { kind: 'BodyTube', manufacturer: 'Estes', partNo: 'BT-55', description: '', outsideDiameter: 0.0334 },
    { kind: 'NoseCone', manufacturer: 'X', partNo: 'nc', description: '', outsideDiameter: 0.5 },
  ]),
}));

let host: HTMLDivElement;
let root: Root;

/** 54 mm airframe: max body diameter 0.052 m. */
const tree = (): RocketTree => ({
  name: 'r',
  components: [{
    type: 'stage', id: 's', children: [
      { type: 'nosecone', id: 'n', length: 0.25, aftRadius: 0.026 } as ComponentNode,
      {
        type: 'bodytube', id: 'b', length: 0.8, outerRadius: 0.026, thickness: 0.0015,
        children: [{
          type: 'innertube', id: 'm', length: 0.3, outerRadius: 0.0145, thickness: 0.0008,
          motorMount: true, position: { method: 'bottom', offset: 0 },
        } as ComponentNode],
      } as ComponentNode,
    ],
  } as ComponentNode],
});

let applied: ScaleResult | null = null;

/**
 * Flush the microtask the mocked `loadPresets` resolves on, INSIDE act(), so the
 * resulting setState is not an unwrapped update. Without it this file was the
 * only one in the suite printing React act() warnings.
 */
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

const render = async (assigned: Record<string, number> = {}) => {
  applied = null;
  act(() => {
    root.render(
      <PrefsProvider>
        <ScaleDialog
          tree={tree()}
          assignedMotorDiameters={assigned}
          onApply={(r) => { applied = r; }}
          onSaveBackup={() => {}}
          onClose={() => {}}
        />
      </PrefsProvider>,
    );
  });
  // The mocked loadPresets resolves on a microtask; flush it INSIDE act() so
  // its setState is not an unwrapped update. Every test needs this, not just
  // the two that touch the dropdown.
  await flush();
};

const numberInputs = (): HTMLInputElement[] =>
  [...host.querySelectorAll('input')].filter((i) => i.type !== 'checkbox');

const type = (el: HTMLInputElement, value: string) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value')!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const text = () => host.textContent ?? '';

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

describe('ScaleDialog', () => {
  it('shows the design it is about to scale, in the preference units', async () => {
    await render();
    // Metric default: 1050 mm long, 52.0 mm across, doubling by default.
    expect(text()).toContain('52.0');
    expect(text()).toContain('200.0 %');
  });

  it('typing a target diameter sets the reciprocal-correct factor', async () => {
    await render();
    const [, target] = numberInputs();
    // 52 mm airframe → 102 mm tube. The factor must be 102/52 = 1.9615…,
    // NOT 52/102. A reversed division still "works" and still scales the
    // rocket, which is exactly why this is pinned.
    type(target!, '102');
    expect(text()).toContain('196.2 %');
    expect(text()).toContain('102.0');
  });

  it('typing a factor moves the target diameter with it', async () => {
    await render();
    const [factor] = numberInputs();
    type(factor!, '0.5');
    expect(text()).toContain('50.0 %');
    expect(text()).toContain('26.0'); // half of 52 mm
  });

  it('names the motor mount it is about to make un-buyable', async () => {
    await render();
    // 27.4 mm bore doubled is 54.8 mm — close to the standard 54, but not it.
    expect(text()).toContain('Motor mount');
    expect(text()).toMatch(/not a motor size you can buy/);
  });

  it('warns when the loaded motor will no longer fit', async () => {
    await render({ m: 0.029 }); // a 29 mm motor in the mount, then halve the rocket
    const [factor] = numberInputs();
    type(factor!, '0.5');
    expect(text()).toContain('no longer fit');
  });

  it('applies the factor that is on screen', async () => {
    await render();
    const [factor] = numberInputs();
    type(factor!, '3');
    const btn = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Scale to'))!;
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(applied).not.toBeNull();
    const bt = applied!.tree.components[0]!.children![1]!;
    expect(bt['outerRadius']).toBeCloseTo(0.026 * 3, 12);
    expect(bt['length']).toBeCloseTo(0.8 * 3, 12);
  });

  it('picking a catalogue tube sets the factor from ITS diameter, not the reciprocal', async () => {
    await render();
    const sel = host.querySelector('select') as HTMLSelectElement;
    // 246 raw ODs collapse to distinct 0.1 mm buckets: 0.102 and 0.10201 are
    // the same nominal 4 inch tube and must appear once.
    expect(sel.options.length).toBe(1 + 2); // placeholder + 33.4 mm + 102 mm
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(sel, '0.102');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // 102 / 52 = 1.9615… — a reversed division gives 51.0 % and SHRINKS it.
    expect(text()).toContain('196.2 %');
    // …and the widget keeps the choice rather than snapping back, which is what
    // made it unusable from the keyboard.
    expect(sel.value).toBe('0.102');
  });

  it('the snap checkbox reaches the transform and changes the result', async () => {
    await render();
    const box = host.querySelector('input[type=checkbox]') as HTMLInputElement;
    expect(box, 'the mount is off-class at 2x, so the box must be offered').toBeTruthy();
    // A real click: React tracks the node's checked value, so assigning it
    // directly and firing 'change' never reaches onChange - the checkbox
    // looked ticked and the state stayed false, which is precisely the
    // "checkbox is inert" symptom this test exists to rule out.
    act(() => { box.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const btn = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Scale to'))!;
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // The LIST must show the bore the user gets, or it contradicts the fit
    // verdict on the same line: 54.0, not the 54.8 it passed through.
    expect(text()).toContain('54.0 mm');
    expect(text()).toContain('snapped up from 54.8 mm');
    // 27.4 mm bore x2 = 54.8, snapped to the standard 54: outer radius is
    // 54/2 + the scaled 0.8 mm wall = 28.6 mm.
    const mount = applied!.tree.components[0]!.children![1]!.children![0]!;
    expect(mount['outerRadius']).toBeCloseTo(0.054 / 2 + 0.0008 * 2, 12);
    expect(applied!.notes.join(' ')).toContain('snapped to the standard 54 mm');
  });

  it('the preview follows the snap setting, so a fixed warning disappears', async () => {
    // 27.4 mm bore at 1.9x is 52.1 mm - a 54 motor will not enter it - but
    // snapped the bore is exactly 54 and it fits. If the preview ignores the
    // checkbox it keeps warning about a problem the user has just solved.
    await render({ m: 0.054 });
    const [factor] = numberInputs();
    type(factor!, '1.9');
    expect(text()).toContain('no longer fit');
    const box = host.querySelector('input[type=checkbox]') as HTMLInputElement;
    act(() => { box.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(text()).not.toContain('no longer fit');
  });

  it('refuses a factor of 1 rather than committing a no-op undo step', async () => {
    await render();
    const [factor] = numberInputs();
    type(factor!, '1');
    const btn = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Scale to')) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('says there is nothing to scale when the design has no airframe', async () => {
    act(() => {
      root.render(
        <PrefsProvider>
          <ScaleDialog
            tree={{ name: 'empty', components: [] }}
            assignedMotorDiameters={{}}
            onApply={() => {}}
            onSaveBackup={() => {}}
            onClose={() => {}}
          />
        </PrefsProvider>,
      );
    });
    await flush();
    expect(text()).toContain('nothing to scale');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Scale to')))
      .toBe(false);
  });
});
