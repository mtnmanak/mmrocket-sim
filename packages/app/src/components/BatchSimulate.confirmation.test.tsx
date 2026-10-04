// @vitest-environment happy-dom
import { act, useLayoutEffect, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import type { MotorDbEntry } from '../services/motorDb.js';
import { runBatchSweep } from '../services/batchSweep.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS } from './LaunchPanel.js';
import { BatchSimulate, batchConfirmationArmed } from './BatchSimulate.js';

const catalog = vi.hoisted(() => ({ motors: [] as MotorDbEntry[] }));
vi.mock('./useCatalogue.js', () => ({ useCatalogue: () => catalog.motors }));
vi.mock('../services/batchSweep.js', async (original) => ({
  ...(await original<typeof import('../services/batchSweep.js')>()),
  runBatchSweep: vi.fn(),
}));
const sweep = vi.mocked(runBatchSweep);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tree: RocketTree = { name: 'Confirmation bird', components: [{ type: 'stage', id: 'stage',
  children: [{ type: 'bodytube', id: 'body', length: 0.6,
    children: [{ type: 'innertube', id: 'mount', length: 0.1 }] }] }] };
let root: Root;
let host: HTMLDivElement;
const close = vi.fn();
let props: ComponentProps<typeof BatchSimulate>;
let observeCommit: (() => void) | undefined;
function Probe() {
  // Layout effects see the committed DOM before passive disarming could run.
  useLayoutEffect(() => { observeCommit?.(); });
  return <PrefsProvider><BatchSimulate {...props} /></PrefsProvider>;
}
const render = () => act(() => root.render(<Probe />));
const primary = () => host.querySelector<HTMLButtonElement>('.launch-btn')!;
const dialog = () => host.querySelector<HTMLElement>('[aria-label="Run a large batch?"]');
const button = (name: string) => [...dialog()!.querySelectorAll('button')].find(b => b.textContent === name)!;
const click = async (b: HTMLButtonElement) => { await act(async () => { b.click(); }); };
const key = (value: string, shiftKey = false) => act(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true }));
});

beforeEach(() => {
  localStorage.clear();
  close.mockReset();
  observeCommit = undefined;
  sweep.mockReset().mockResolvedValue({ rows: [], stopped: false });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

function mount(flights: number) {
  // One distinct candidate per flight: exercise the actual count at exact boundaries,
  // without spending overnight CPU time flying them. Only the sweep is stubbed.
  catalog.motors = Array.from({ length: flights }, (_, i) => ({
    motorId: `motor-${i}`, designation: `E${i}`, commonName: `E${i}`, manufacturerAbbrev: 'Acme',
    impulseClass: 'E', diameter: 24, length: 70, type: 'SU', avgThrustN: 20, maxThrustN: 48,
    totImpulseNs: 40, burnTimeS: 2, totalWeightG: 70, propWeightG: 40, delays: '5', availability: 'regular',
  }));
  props = { tree, info: {} as never,
    mounts: [{ id: 'mount', label: '24 mm', diameterMm: 24, motorCount: 1, maxMotorLengthM: null }],
    initialMountId: 'mount', assignedMountMotors: {}, assignedMotors: {}, assignedMotorIds: {}, assignedIgnitions: {},
    rocketName: 'Confirmation bird', launch: DEFAULT_CONDITIONS, onClose: close, onRunsChange: () => {},
  };
  render();
}

describe('large batch confirmation', () => {
  it.each([100, 5000])('starts %i flights without confirmation', async flights => {
    mount(flights);
    await click(primary());
    expect(dialog()).toBeNull();
    expect(sweep).toHaveBeenCalledOnce();
    expect(sweep.mock.calls[0]![0].candidates).toHaveLength(flights);
  });

  it.each([5001, 19999, 20000])('preserves HEAD second ask and copy for %i flights', async flights => {
    mount(flights);
    const estimate = primary().textContent!.split(' · ')[1];
    await click(primary());
    expect(dialog()).toBeNull();
    expect(sweep).not.toHaveBeenCalled();
    expect(primary().textContent!.trim()).toBe(`Yes — fly ${flights.toLocaleString('en-US')} flights · ${estimate}`);
    expect(host.querySelector('[role="alert"]')?.textContent?.trim()).toBe(
      `${flights.toLocaleString('en-US')} flights is a very long run — ${estimate}. The page `
      + 'cannot respond while a flight runs, and Stop only takes effect between them. Press the button '
      + 'again to start, or untick a combination mode to shrink it.',
    );
    await click(primary());
    expect(sweep).toHaveBeenCalledOnce();
  });

  it.each([20001, 24804, 37820, 40000, 50000])('requires a separate Run anyway action for %i flights', async flights => {
    mount(flights);
    primary().focus();
    await click(primary());
    expect(sweep).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain(`${flights.toLocaleString('en-US')} flights`);
    expect(dialog()?.textContent).toMatch(/about \d+ h/);
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toContain(`${flights.toLocaleString('en-US')} flights`);
    expect(document.activeElement).toBe(button('Cancel'));
    // Repeating the original action must never count as confirmation.
    await click(primary());
    expect(sweep).not.toHaveBeenCalled();
    const proceed = button('Run anyway');
    await act(async () => { proceed.click(); proceed.click(); });
    expect(dialog()).toBeNull();
    expect(sweep).toHaveBeenCalledOnce();
    expect(sweep.mock.calls[0]![0].candidates).toHaveLength(flights);
  });

  it.each(['Cancel', 'Escape'])('%s keeps settings, restores focus, and requires a fresh confirmation', async action => {
    mount(20001);
    const trigger = primary();
    trigger.focus();
    await click(trigger);
    if (action === 'Cancel') await click(button('Cancel'));
    else key('Escape');
    expect(dialog()).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(sweep).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    expect(primary().textContent).toContain('20,001');
    await click(trigger);
    expect(dialog()).not.toBeNull();
    expect(sweep).not.toHaveBeenCalled();
  });

  it('traps keyboard focus between Cancel and Run anyway', async () => {
    mount(20001);
    await click(primary());
    key('Tab', true);
    expect(document.activeElement).toBe(button('Run anyway'));
    key('Tab');
    expect(document.activeElement).toBe(button('Cancel'));
  });

  it('accepts keyboard-origin activation only after moving focus to Run anyway', async () => {
    mount(20001);
    primary().focus();
    // happy-dom does not synthesize native button activation from Enter/Space.
    // Dispatch its detail=0 click explicitly; Tab/Escape use the real key handler.
    const activate = () => act(() => {
      document.activeElement!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }));
    });
    activate();
    expect(document.activeElement).toBe(button('Cancel'));
    activate();
    expect(sweep).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(primary());
    activate();
    key('Tab', true);
    expect(document.activeElement).toBe(button('Run anyway'));
    await act(async () => { activate(); });
    expect(sweep).toHaveBeenCalledOnce();
  });

  for (const flights of [5001, 20001]) {
    it.each(['tree', 'info', 'mounts', 'assignedMountMotors', 'assignedMotors', 'assignedMotorIds',
      'assignedIgnitions', 'assignedAutoDelays', 'weighed', 'launch', 'rocketName'] as const)(
      `disarms ${flights} flights in the same render when %s changes`, async field => {
        mount(flights);
        await click(primary());
        const previous = props;
        const value = props[field];
        props = { ...props, [field]: field === 'rocketName' ? 'Changed bird'
          : field === 'launch' ? { ...props.launch, timeStepS: 0.025 }
          : field === 'tree' ? { ...props.tree, name: 'Changed design' }
          : Array.isArray(value) ? [...value] : { ...value as object } };
        const observations: { modal: HTMLElement | null; label: string | null; runs: number }[] = [];
        observeCommit = () => {
          observeCommit = undefined;
          const observation = { modal: dialog(), label: primary().textContent, runs: 0 };
          // A click during this commit must ask afresh, never fly the new inputs.
          primary().click();
          observation.runs = sweep.mock.calls.length;
          observations.push(observation);
        };
        render();
        expect(observations).toHaveLength(1);
        expect(observations[0]!.modal).toBeNull();
        expect(observations[0]!.label).not.toContain('Yes —');
        expect(observations[0]!.runs).toBe(0);
        expect(sweep).not.toHaveBeenCalled();
        // Returning to a previously confirmed set of inputs must also disarm.
        props = previous;
        render();
        expect(dialog()).toBeNull();
        expect(primary().textContent).not.toContain('Yes —');
      },
    );
  }

  it.each([500, 19999, 20000, 24804, 50001])('disarms before effects when the flight count changes to %i', async flights => {
    mount(20001);
    await click(primary());
    const seed = catalog.motors[0]!;
    catalog.motors = Array.from({ length: flights }, (_, i) => ({ ...seed, motorId: `new-${i}` }));
    const observations: { modal: HTMLElement | null; label: string | null }[] = [];
    observeCommit = () => { observations.push({ modal: dialog(), label: primary().textContent }); };
    render();
    expect(observations).toHaveLength(1);
    expect(observations[0]!.modal).toBeNull();
    expect(observations[0]!.label).not.toContain('Yes —');
    expect(sweep).not.toHaveBeenCalled();
  });

  it('requires the same identity, a permitted sweep, and strictly more than 5,000 flights to be armed', () => {
    const identity = {};
    expect(batchConfirmationArmed(identity, identity, 5001, null)).toBe(true);
    expect(batchConfirmationArmed(null, identity, 5001, null)).toBe(false);
    expect(batchConfirmationArmed({}, identity, 5001, null)).toBe(false);
    expect(batchConfirmationArmed(identity, identity, 5000, null)).toBe(false);
    expect(batchConfirmationArmed(identity, identity, 5001, 'refused')).toBe(false);
  });

  it('disarms when settings change even if the flight count stays the same', async () => {
    mount(20001);
    await click(primary());
    const select = [...host.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'eb'))!;
    act(() => { select.value = 'eb'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(dialog()).toBeNull();
    await click(primary());
    expect(dialog()).not.toBeNull();
    expect(sweep).not.toHaveBeenCalled();
  });

  it('keeps the separate memory ceiling at 50,000 flights', async () => {
    mount(50001);
    expect(primary().disabled).toBe(true);
    expect(host.querySelector('.batch-refused')?.textContent).toContain('the most is 50,000');
    expect(host.querySelector('.batch-refused')?.textContent).toContain('memory');
    await click(primary());
    expect(dialog()).toBeNull();
    expect(sweep).not.toHaveBeenCalled();
  });
});
