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

// The preset catalogue is a 1.8 MB lazy import; the dialog degrades to an empty
// tube list without it, which is all these tests need.
vi.mock('../services/presets.js', () => ({ loadPresets: () => Promise.resolve([]) }));

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

const render = (assigned: Record<string, number> = {}) => {
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
  it('shows the design it is about to scale, in the preference units', () => {
    render();
    // Metric default: 1050 mm long, 52.0 mm across, doubling by default.
    expect(text()).toContain('52.0');
    expect(text()).toContain('200.0 %');
  });

  it('typing a target diameter sets the reciprocal-correct factor', () => {
    render();
    const [, target] = numberInputs();
    // 52 mm airframe → 102 mm tube. The factor must be 102/52 = 1.9615…,
    // NOT 52/102. A reversed division still "works" and still scales the
    // rocket, which is exactly why this is pinned.
    type(target!, '102');
    expect(text()).toContain('196.2 %');
    expect(text()).toContain('102.0');
  });

  it('typing a factor moves the target diameter with it', () => {
    render();
    const [factor] = numberInputs();
    type(factor!, '0.5');
    expect(text()).toContain('50.0 %');
    expect(text()).toContain('26.0'); // half of 52 mm
  });

  it('names the motor mount it is about to make un-buyable', () => {
    render();
    // 27.4 mm bore doubled is 54.8 mm — close to the standard 54, but not it.
    expect(text()).toContain('Motor mount');
    expect(text()).toMatch(/not a motor size you can buy/);
  });

  it('warns when the loaded motor will no longer fit', () => {
    render({ m: 0.029 }); // a 29 mm motor in the mount, then halve the rocket
    const [factor] = numberInputs();
    type(factor!, '0.5');
    expect(text()).toContain('no longer fit');
  });

  it('applies the factor that is on screen', () => {
    render();
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

  it('refuses a factor of 1 rather than committing a no-op undo step', () => {
    render();
    const [factor] = numberInputs();
    type(factor!, '1');
    const btn = [...host.querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Scale to')) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('says there is nothing to scale when the design has no airframe', () => {
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
    expect(text()).toContain('nothing to scale');
    expect([...host.querySelectorAll('button')].some((b) => b.textContent?.includes('Scale to')))
      .toBe(false);
  });
});
