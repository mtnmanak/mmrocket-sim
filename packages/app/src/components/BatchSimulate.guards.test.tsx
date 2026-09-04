// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS } from './LaunchPanel.js';
import {
  BatchSimulate, BATCH_CONFIRM_ABOVE_FLIGHTS, batchButtonLabel, batchConfirmWarning,
  batchProgressAnnouncement, mixedComboCount, type BatchMountOption,
} from './BatchSimulate.js';

/**
 * Three ways the batch dialog could throw away a sweep or misdescribe one.
 *
 *  - Escape closed a RUNNING batch. The ✕ is disabled and the backdrop inert
 *    while it runs, but useDialog's Escape handler is unconditional, so the
 *    reflex key unmounted the dialog and took the rows — including the
 *    rejected and errored ones, which exist nowhere else — with it.
 *  - The button counted MOTORS while the sweep flew FLIGHTS: 226 against
 *    1,949,476 with "mixed 4+2 / 2+2+2" ticked.
 *  - The progress bar was a bare div: no role, no value, nothing for a screen
 *    reader during a multi-minute run.
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Single-stage design with a SIX-ring cluster mount: the only shape that
 * offers both combination modes, and the one the owner actually flies 4+2 and
 * 2+2+2 on — the configuration whose count the button was misreporting.
 */
const TREE: RocketTree = {
  name: 'Cluster bird',
  components: [{
    type: 'stage', id: 'st0', name: 'Sustainer',
    children: [{
      type: 'bodytube', id: 'bt', length: 0.6,
      children: [{ type: 'innertube', id: 'mount', cluster: '6-ring', length: 0.07 }],
    }],
  }],
};

const MOUNTS: BatchMountOption[] = [
  { id: 'mount', label: '24 mm cluster', diameterMm: 24, motorCount: 6, maxMotorLengthM: null },
];

describe('batchButtonLabel — the button must name what it will fly', () => {
  it('counts motors while a motor is a flight', () => {
    expect(batchButtonLabel({ candidates: 226, totalFlights: 226, confirming: false }))
      .toBe('Simulate 226 motors');
    expect(batchButtonLabel({ candidates: 1, totalFlights: 1, confirming: false }))
      .toBe('Simulate 1 motor');
  });

  it('counts FLIGHTS once a combination mode makes the two differ', () => {
    // The owner's reported sweep: 226 candidates, "mixed 4+2 / 2+2+2" ticked.
    const total = 226 + mixedComboCount(226, 3);
    expect(total).toBe(1_949_476);
    expect(batchButtonLabel({ candidates: 226, totalFlights: total, confirming: false }))
      .toBe('Simulate 1,949,476 flights');
  });

  it('becomes the second ask once armed', () => {
    expect(batchButtonLabel({ candidates: 226, totalFlights: 1_949_476, confirming: true }))
      .toBe('Yes — fly 1,949,476 flights');
  });
});

describe('batchConfirmWarning', () => {
  it('names the count and how to shrink it', () => {
    const w = batchConfirmWarning(1_949_476);
    expect(w).toContain('1,949,476 flights');
    expect(w).toContain('untick a combination mode');
  });
});

describe('batchProgressAnnouncement — coarse on purpose', () => {
  it('announces the start', () => {
    expect(batchProgressAnnouncement(0, 226)).toBe('Simulating 226 flights.');
  });

  it('announces each tenth of the sweep and nothing in between', () => {
    // 226 flights → a step of 23, so ten announcements, not 226. A polite
    // region fed once per sub-second flight never drains its queue.
    const spoken = Array.from({ length: 226 }, (_, i) => batchProgressAnnouncement(i, 226))
      .filter((s) => s !== null);
    expect(spoken.length).toBe(10);
    expect(batchProgressAnnouncement(23, 226)).toBe('10 percent — 23 of 226 flights.');
    expect(batchProgressAnnouncement(24, 226)).toBeNull();
  });

  it('never divides by zero on an empty sweep', () => {
    expect(batchProgressAnnouncement(0, 0)).toBeNull();
  });
});

describe('the batch dialog', () => {
  let host: HTMLDivElement;
  let root: Root;
  let closes: number;

  beforeEach(() => {
    localStorage.clear();
    closes = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  const mount = () => act(() => root.render(
    <PrefsProvider>
      <BatchSimulate
        tree={TREE}
        info={{} as never}
        mounts={MOUNTS}
        initialMountId="mount"
        assignedMotors={{}}
        launch={DEFAULT_CONDITIONS}
        rocketName="Cluster bird"
        onRunsChange={() => {}}
        onClose={() => { closes++; }}
      />
    </PrefsProvider>,
  ));

  const escape = () => act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  /** The rocket Icon renders before the label, so the text has a leading space. */
  const primaryText = () => (primary().textContent ?? '').trim();
  const primary = () => Array.from(host.querySelectorAll('button'))
    .find((b) => /^(Simulate|Yes —)/.test((b.textContent ?? '').trim())) as HTMLButtonElement;

  /** A combination-mode checkbox, by the words on its label. */
  const box = (words: string) => Array.from(host.querySelectorAll('label'))
    .find((l) => (l.textContent ?? '').includes(words))
    ?.querySelector('input') as HTMLInputElement;
  /** 3+3 halves: n(n−1)/2 extra flights — inside the cap for the bundled DB. */
  const halvesBox = () => box('mixed 3+3');
  /** 4+2 / 2+2+2: n(n+1)(n+2)/6 − n extra — the one that explodes. */
  const pairsBox = () => box('mixed 4+2');

  it('Escape closes an IDLE dialog — the behaviour that must survive the guard', () => {
    mount();
    escape();
    expect(closes).toBe(1);
  });

  it('the progress bar carries a role and a value', () => {
    // No sweep is running here, so the bar is absent; what this pins is that
    // when it exists it is a progressbar and not a bare div. The wiring test
    // below is what proves the attributes are on the element itself.
    mount();
    expect(host.querySelector('.batch-progress')).toBeNull();
    // The live region, however, must exist BEFORE the run starts — a polite
    // region inserted with its text already in place is not announced.
    const live = host.querySelector('.sr-only[aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(live!.textContent).toBe('');
  });

  /** How many candidates the bundled catalog offers this 24 mm mount. */
  const candidateCount = () => Number(primaryText().replace(/[^0-9]/g, ''));

  it('the primary button names flights, not motors, once combinations are on', () => {
    mount();
    const n = candidateCount();
    expect(n).toBeGreaterThan(0);
    act(() => { halvesBox().click(); });
    // The button used to keep saying "Simulate <n> motors" while the sweep
    // flew n + n(n−1)/2 — the meta line beside it already said the truth.
    expect(primaryText()).toBe(`Simulate ${(n + mixedComboCount(n, 2)).toLocaleString('en-US')} flights`);
  });

  it('asks a second time before a sweep past the cap, and does not start on the first click', () => {
    mount();
    const n = candidateCount();
    act(() => { pairsBox().click(); });
    // The 4+2 / 2+2+2 split is the one that explodes: n(n+1)(n+2)/6 − n.
    const total = n + mixedComboCount(n, 3);
    expect(total).toBeGreaterThan(BATCH_CONFIRM_ABOVE_FLIGHTS);

    act(() => { primary().click(); });
    // Armed, not started: the alert is up, the Stop button is not, and the
    // button now names the count it is asking about.
    expect(host.querySelector('[role="alert"]')?.textContent ?? '').toContain('very long run');
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Stop'))
      .toBe(false);
    expect(primaryText()).toBe(`Yes — fly ${total.toLocaleString('en-US')} flights`);
  });

  it('disarms when the sweep shrinks again', () => {
    mount();
    act(() => { pairsBox().click(); });
    act(() => { primary().click(); });
    expect(primaryText()).toContain('Yes —');
    act(() => { pairsBox().click(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(primaryText()).toContain('motors');
  });
});

/**
 * The Escape guard and the ARIA attributes are on code paths a unit test
 * cannot reach without flying a real sweep (the dialog only becomes `running`
 * inside start(), which builds an engine handle and simulates). This is the
 * same source-level pinning the completion-signal tests in
 * BatchSimulate.test.tsx use, and for the same reason: a mutation that deleted
 * the guard would otherwise pass everything above.
 */
describe('the running-sweep guards are actually wired up', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), './BatchSimulate.tsx'), 'utf8');

  it('Escape is routed through the running check, not straight to onClose', () => {
    expect(src).toContain('useDialog(() => { if (!runningRef.current) onClose(); })');
    expect(src).not.toContain('useDialog(onClose)');
  });

  it('the running flag is mirrored into a ref every render', () => {
    expect(src).toContain('runningRef.current = running;');
  });

  it('the progress bar declares its role and its value', () => {
    expect(src).toContain('role="progressbar"');
    expect(src).toContain('aria-valuenow={progress.done}');
    expect(src).toContain('aria-valuemax={progress.total}');
    expect(src).toContain('aria-label="Batch simulation progress"');
  });

  it('the second ask starts the sweep on the second click', () => {
    expect(src).toContain('if (!confirming && totalFlights > BATCH_CONFIRM_ABOVE_FLIGHTS)');
    expect(src).toContain('setConfirming(false);\n                void start();');
  });
});
