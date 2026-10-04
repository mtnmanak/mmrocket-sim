// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComponentNode, MotorSpec, RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS, timeStepCostFactor } from './LaunchPanel.js';
import {
  BatchSimulate, BATCH_CONFIRM_ABOVE_FLIGHTS, BATCH_ESTIMATE_ABOVE_FLIGHTS, BATCH_FLIGHT_S, BATCH_MAX_FLIGHTS,
  batchButtonLabel, batchCandidates, batchConfirmWarning, batchDurationText, batchEstimate, batchFlightCount,
  batchMaxCandidates, batchProgressAnnouncement, batchRefusal, batchSweepSeconds,
} from './BatchSimulate.js';
import { batchSolverFlights, mixedComboCount, type BatchMountOption } from '../services/batchSweep.js';
import { MOTOR_DB } from '../services/motorDb.js';
import * as batchSweep from '../services/batchSweep.js';

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
    expect(batchButtonLabel({ candidates: 113, totalFlights: 6441, confirming: true }))
      .toBe('Yes — fly 6,441 flights');
  });

  it('states how long the sweep will take as well as how many flights, when it is given an estimate', () => {
    expect(batchButtonLabel({ candidates: 232, totalFlights: 232, confirming: false, estimate: 'about 8 min' }))
      .toBe('Simulate 232 motors · about 8 min');
    expect(batchButtonLabel({ candidates: 113, totalFlights: 6441, confirming: false, estimate: 'about 3 h 30 min' }))
      .toBe('Simulate 6,441 flights · about 3 h 30 min');
    expect(batchButtonLabel({ candidates: 113, totalFlights: 6441, confirming: true, estimate: 'about 3 h 30 min' }))
      .toBe('Yes — fly 6,441 flights · about 3 h 30 min');
  });
});

/**
 * THE SCALE OF A SWEEP, said before it starts (board Tier 1 row 7). The count
 * was fixed in v0.105, but nothing said how LONG a sweep was, and nothing
 * stopped one: 226 candidates with "mixed 4+2 / 2+2+2" was 1,949,476 flights —
 * weeks — behind a button and one confirmation. The pace is measured (see
 * BATCH_FLIGHT_S), not guessed.
 */
describe('the estimate', () => {
  it('is the measured pace times the flights, a flight that searches for its delay at the solver’s pace', () => {
    expect(batchSweepSeconds({ flights: 100, solverFlights: 100 })).toBeCloseTo(100 * BATCH_FLIGHT_S.optimalDelay, 9);
    expect(batchSweepSeconds({ flights: 100, solverFlights: 0 })).toBeCloseTo(100 * BATCH_FLIGHT_S.fixedDelay, 9);
    // "Optimal delay per motor" unticked, some flights still search
    // (batchSolverFlights): each is priced as one, the rest at a fixed delay.
    expect(batchSweepSeconds({ flights: 100, solverFlights: 40 }))
      .toBeCloseTo(40 * BATCH_FLIGHT_S.optimalDelay + 60 * BATCH_FLIGHT_S.fixedDelay, 9);
    // The solver flies each candidate several times: it is most of the cost.
    expect(BATCH_FLIGHT_S.optimalDelay).toBeGreaterThan(2 * BATCH_FLIGHT_S.fixedDelay);
  });

  it('scales by the time-step caution’s own factor when the step is finer than the default, and never shrinks for a coarser one', () => {
    const at = (timeStepS: number | null) => batchSweepSeconds({ flights: 100, solverFlights: 100, timeStepS });
    expect(at(0.01)).toBeCloseTo(at(null) * timeStepCostFactor(0.01), 9);
    expect(at(0.01)).toBeGreaterThan(3 * at(null));
    expect(at(0.05)).toBeCloseTo(at(null), 9);
    expect(at(0.1)).toBeCloseTo(at(null), 9);
  });

  it('reads as a rounded duration, never more precise than it can be', () => {
    expect(batchDurationText(30)).toBe('under a minute');
    expect(batchDurationText(61)).toBe('about 1 min');
    expect(batchDurationText(8 * 60 + 20)).toBe('about 8 min');
    expect(batchDurationText(59.6 * 60)).toBe('about 1 h');
    expect(batchDurationText(4 * 3600 + 43 * 60)).toBe('about 4 h 45 min');
    expect(batchDurationText(2 * 3600 + 5 * 60)).toBe('about 2 h');
    expect(batchDurationText(11.1 * 3600)).toBe('about 11 h');
    expect(batchDurationText(45.1 * 86400)).toBe('about 45 days');
  });

  it(`is offered above ${BATCH_ESTIMATE_ABOVE_FLIGHTS} flights only`, () => {
    expect(batchEstimate({ flights: BATCH_ESTIMATE_ABOVE_FLIGHTS, solverFlights: BATCH_ESTIMATE_ABOVE_FLIGHTS }))
      .toBeNull();
    // The owner's 226-motor sweep: minutes of watching, now said up front.
    expect(batchEstimate({ flights: 226, solverFlights: 226 }))
      .toBe(batchDurationText(226 * BATCH_FLIGHT_S.optimalDelay));
    expect(batchEstimate({ flights: 226, solverFlights: 226 })).toBe('about 8 min');
  });
});

describe('the cap', () => {
  it('counts flights as the sweep does: every candidate, plus each ticked split’s combinations', () => {
    expect(batchFlightCount(113, [])).toBe(113);
    expect(batchFlightCount(113, [2])).toBe(113 + mixedComboCount(113, 2));
    expect(batchFlightCount(226, [3])).toBe(1_949_476);
    expect(batchFlightCount(20, [2, 3])).toBe(20 + mixedComboCount(20, 2) + mixedComboCount(20, 3));
  });

  it('knows how many candidates fit under it with the splits that are ticked', () => {
    for (const groups of [[], [2], [3], [2, 3]]) {
      const n = batchMaxCandidates(groups);
      expect(batchFlightCount(n, groups), `${groups}`).toBeLessThanOrEqual(BATCH_MAX_FLIGHTS);
      expect(batchFlightCount(n + 1, groups), `${groups}`).toBeGreaterThan(BATCH_MAX_FLIGHTS);
    }
    expect(batchMaxCandidates([3])).toBe(65);
    expect(batchMaxCandidates([2])).toBe(315);
  });

  const HALVES_2 = { name: 'mixed 2+2', groups: 2 };
  const HALVES_3 = { name: 'mixed 3+3', groups: 2 };
  const PAIRS = { name: 'mixed 4+2 / 2+2+2', groups: 3 };
  type Mode = typeof PAIRS;
  /** The flights a sweep searches when every one does — "optimal delay per motor", the default. */
  const allSearch = (candidates: number, modes: Mode[]) => batchFlightCount(candidates, modes.map((m) => m.groups));

  it.each([['AeroTech', 37820], ['Cesaroni', 24804]] as const)(
    'allows the requested 29 mm six-ring %s sweep to reach confirmation', (maker, expected) => {
      const { candidates } = batchCandidates(
        { manufacturers: [maker], classes: [29], includeOOP: false },
        { diameterMm: 29, maxMotorLengthM: null }, MOTOR_DB,
      );
      const flights = batchFlightCount(candidates.length, [3]);
      expect(flights).toBe(expected);
      expect(batchRefusal({ candidates: candidates.length, withoutOOP: null,
        modes: [PAIRS], solverFlights: flights })).toBeNull();
    },
  );

  it('refuses nothing at the cap, and past it says why and how to narrow the sweep', () => {
    const refuse = (candidates: number, modes: Mode[]) =>
      batchRefusal({ candidates, withoutOOP: null, modes, solverFlights: allSearch(candidates, modes) });
    const atCap = batchMaxCandidates([2]);
    expect(refuse(atCap, [HALVES_3])).toBeNull();
    expect(refuse(atCap + 1, [HALVES_3])).not.toBeNull();
    expect(refuse(226, [PAIRS])).toBe('1,949,476 flights is more than one batch will fly: the most is 50,000, '
      + 'about 28 h at the measured pace. The app keeps every result in memory for export. Untick mixed 4+2 / 2+2+2, or bring the candidates down to 65 or fewer '
      + 'with the maker and diameter chips.');
    // The time at the cap is this sweep's own pace: unticked, with no flight
    // searching, 50,000 flights is 30,000 s, said to the quarter hour.
    expect(batchRefusal({ candidates: 226, withoutOOP: null, modes: [PAIRS], solverFlights: 0 }))
      .toContain('the most is 50,000, about 8 h 15 min at the measured pace.');
  });

  /**
   * EVERY WAY IT NAMES WORKS ON ITS OWN (review of the cap, 2026-10-01). It
   * offered unticking "include OOP" whenever out-of-production motors were in,
   * and either combination box when both were ticked — each checked against
   * nothing — so it told a user to do things that left the sweep refused.
   */
  it('names only the ways that bring the sweep under the cap on their own', () => {
    const refuse = (candidates: number, withoutOOP: number | null, modes: Mode[]) =>
      batchRefusal({ candidates, withoutOOP, modes, solverFlights: allSearch(candidates, modes) });
    // Neither 57,970 flights with OOP nor 54,615 without fits under 50,000.
    expect(refuse(340, 330, [HALVES_2]))
      .toBe('57,970 flights is more than one batch will fly: the most is 50,000, about 28 h at the measured pace. '
        + 'The app keeps every result in memory for export. Untick mixed 2+2, or bring the candidates down to '
        + '315 or fewer with the maker and diameter chips.');
    expect(refuse(320, 315, [HALVES_2]))
      .toContain('Untick mixed 2+2, or bring the candidates down to 315 or fewer with the maker and diameter '
        + 'chips, or by unticking include OOP.');
    expect(refuse(113, null, [HALVES_3, PAIRS]))
      .toContain('Untick mixed 4+2 / 2+2+2, or bring the candidates down to 65 or fewer');
    expect(refuse(340, null, [HALVES_3, PAIRS]))
      .toContain('Untick both mixed 3+3 and mixed 4+2 / 2+2+2, or bring the candidates down to 65 or fewer');
  });
});

describe('batchConfirmWarning', () => {
  it('names the count, how long it takes and how to shrink it', () => {
    const w = batchConfirmWarning(6441, 'about 3 h 30 min');
    expect(w).toContain('6,441 flights is a very long run — about 3 h 30 min');
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
    // These guards exercise mounted UI, not thousands of real kernel flights.
    vi.spyOn(batchSweep, 'runBatchSweep').mockResolvedValue({ rows: [], stopped: false });
    closes = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const mount = (
    tree: RocketTree = TREE, mounts: BatchMountOption[] = MOUNTS,
    others: { assignedMotors?: Record<string, MotorSpec>; assignedAutoDelays?: Record<string, boolean> } = {},
  ) => act(() => root.render(
    <PrefsProvider>
      <BatchSimulate
        tree={tree}
        info={{} as never}
        mounts={mounts}
        initialMountId="mount"
        assignedMountMotors={{}} assignedMotors={others.assignedMotors ?? {}} assignedMotorIds={{}} assignedIgnitions={{}}
        assignedAutoDelays={others.assignedAutoDelays}
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

  it.each(['km', 'mi'])('refuses apogee conversion overflows in %s, preserving both criteria', (unit) => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { distance: unit } }));
    mount();
    for (const label of ['Minimum', 'Maximum']) {
      const input = host.querySelector(`input[aria-label="${label} apogee (${unit})"]`) as HTMLInputElement;
      const type = (value: string) => act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      act(() => input.focus());
      type('2');
      type('1e306');
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.className).toBe('num-invalid');
      act(() => input.blur());
      expect(input.value).toBe('2');
      act(() => input.focus());
      type('3');
      expect(input.hasAttribute('aria-invalid')).toBe(false);
      act(() => input.blur());
      expect(input.value).toBe('3');
      act(() => input.focus());
      type('');
      act(() => input.blur());
      expect(input.value).toBe('');
    }
  });

  /** The rocket Icon renders before the label, so the text has a leading space. */
  const primaryText = () => (primary().textContent ?? '').trim();
  const primary = () => Array.from(host.querySelectorAll('button'))
    .find((b) => /^(Simulate|Yes —)/.test((b.textContent ?? '').trim())) as HTMLButtonElement;

  /** A combination-mode checkbox, by the words on its label. */
  const box = (words: string) => Array.from(host.querySelectorAll('label'))
    .find((l) => (l.textContent ?? '').includes(words))
    ?.querySelector('input') as HTMLInputElement;
  /** 3+3 halves: n(n−1)/2 extra flights, inside the memory cap for the bundled DB. */
  const halvesBox = () => box('mixed 3+3');
  /** 4+2 / 2+2+2: n(n+1)(n+2)/6 − n extra — the one that explodes, past the cap. */
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

  /** How many candidates the bundled catalog offers this 24 mm mount — the count the button names. */
  const candidateCount = () => Number(/^Simulate ([\d,]+) motors?/.exec(primaryText())![1]!.replace(/,/g, ''));
  const en = (n: number) => n.toLocaleString('en-US');

  it('the primary button names flights, not motors, once combinations are on', () => {
    mount();
    const n = candidateCount();
    expect(n).toBeGreaterThan(0);
    act(() => { halvesBox().click(); });
    // The button used to keep saying "Simulate <n> motors" while the sweep
    // flew n + n(n−1)/2 — the meta line beside it already said the truth.
    expect(primaryText()).toMatch(new RegExp(`^Simulate ${en(n + mixedComboCount(n, 2))} flights · about \\d`));
  });

  it('says how long the sweep will take, beside the count', () => {
    mount();
    const n = candidateCount();
    expect(n).toBeGreaterThan(BATCH_ESTIMATE_ABOVE_FLIGHTS);
    // At the dialog's default (optimal delay on: every flight searches) and the default step.
    expect(primaryText()).toBe(`Simulate ${en(n)} motors · ${batchEstimate({ flights: n, solverFlights: n })}`);
    act(() => { halvesBox().click(); });
    const total = n + mixedComboCount(n, 2);
    expect(primaryText()).toBe(`Simulate ${en(total)} flights · ${batchEstimate({ flights: total, solverFlights: total })}`);
    // Unticking "optimal delay per motor" is a third of the pace, and the
    // estimate follows it. Here no flight searches: this design has no
    // recovery device to wait for a motor's charge, and every motor on the
    // mount lists a delay.
    act(() => { box('optimal delay per motor').click(); });
    expect(primaryText()).toBe(`Simulate ${en(total)} flights · ${batchEstimate({ flights: total, solverFlights: 0 })}`);
  });

  /**
   * One 38 mm mount and a side mount, and a parachute that waits for the
   * motor's charge: a motor sold plugged only then flies at its optimum delay
   * even with "optimal delay per motor" unticked (batchSweep's flyLegs).
   */
  const CHUTE_TREE: RocketTree = {
    name: 'Chute bird',
    components: [{
      type: 'stage', id: 'st0', name: 'Sustainer',
      children: [{
        type: 'bodytube', id: 'bt', length: 0.8,
        children: [
          { type: 'innertube', id: 'mount', length: 0.35 },
          { type: 'innertube', id: 'side', length: 0.2 },
          { type: 'parachute', id: 'chute', name: 'Main' } as ComponentNode,
        ],
      }],
    }],
  };
  const CHUTE_MOUNTS: BatchMountOption[] = [
    { id: 'mount', label: '38 mm mount', diameterMm: 38, motorCount: 1, maxMotorLengthM: null },
    { id: 'side', label: 'Side mount', diameterMm: 24, motorCount: 1, maxMotorLengthM: null },
  ];
  /** This mount's candidates, as the dialog lists them. */
  const at38 = () => batchCandidates(
    { manufacturers: [], classes: [], includeOOP: false }, { diameterMm: 38, maxMotorLengthM: null }, MOTOR_DB,
  ).candidates;

  it('prices a flight that still searches for its delay, "optimal delay per motor" unticked, at the solver’s pace', () => {
    mount(CHUTE_TREE, CHUTE_MOUNTS);
    act(() => { box('optimal delay per motor').click(); });
    const candidates = at38();
    const searching = batchSolverFlights({
      candidates, groups: [], autoDelay: false, deploysOnCharge: true, othersAuto: false,
    });
    expect(searching, 'the shipped catalogue still sells some 38 mm motors plugged only').toBeGreaterThan(0);
    const n = candidates.length;
    expect(primaryText()).toBe(`Simulate ${en(n)} motors · ${batchEstimate({ flights: n, solverFlights: searching })}`);
    // Every flight at a fixed delay reads shorter, which is what it said.
    expect(batchEstimate({ flights: n, solverFlights: searching }))
      .not.toBe(batchEstimate({ flights: n, solverFlights: 0 }));
  });

  it('prices every flight as searching while a motor on another mount is on Auto, which is solved on each', () => {
    mount(CHUTE_TREE, CHUTE_MOUNTS, { assignedMotors: { side: {} as MotorSpec }, assignedAutoDelays: { side: true } });
    act(() => { box('optimal delay per motor').click(); });
    const n = at38().length;
    expect(primaryText()).toBe(`Simulate ${en(n)} motors · ${batchEstimate({ flights: n, solverFlights: n })}`);
  });

  it('asks a second time before a sweep past the second-ask threshold, and does not start on the first click', () => {
    mount();
    const n = candidateCount();
    act(() => { halvesBox().click(); });
    // 3+3 on this mount's candidates sits between the two thresholds.
    const total = n + mixedComboCount(n, 2);
    expect(total).toBeGreaterThan(BATCH_CONFIRM_ABOVE_FLIGHTS);
    expect(total).toBeLessThanOrEqual(BATCH_MAX_FLIGHTS);

    act(() => { primary().click(); });
    // Armed, not started: the alert is up, the Stop button is not, and the
    // button now names the count it is asking about.
    expect(host.querySelector('[role="alert"]')?.textContent ?? '').toContain('very long run');
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Stop'))
      .toBe(false);
    expect(primaryText()).toMatch(new RegExp(`^Yes — fly ${en(total)} flights · about \\d`));
  });

  it('disarms when the sweep shrinks again', () => {
    mount();
    act(() => { halvesBox().click(); });
    act(() => { primary().click(); });
    expect(primaryText()).toContain('Yes —');
    act(() => { halvesBox().click(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(primaryText()).toContain('motors');
  });

  it('opens confirmation above 20,000 flights, cancels without starting, and starts only with Run anyway', async () => {
    // Use the shipped 29 mm AeroTech catalogue and the actual three-pair split.
    // Stub only execution: this test must not fly 37,820 real kernel flights.
    const sweep = vi.mocked(batchSweep.runBatchSweep);
    localStorage.setItem(CRITERIA_KEY, JSON.stringify({ manufacturers: ['AeroTech'], classes: [29] }));
    mount(TREE, [{ ...MOUNTS[0]!, label: '29 mm cluster', diameterMm: 29 }]);
    act(() => { pairsBox().click(); });
    expect(primaryText()).toContain('37,820 flights');
    expect(primary().disabled).toBe(false);
    const modal = () => host.querySelector('[role="dialog"][aria-label="Run a large batch?"]');
    const action = (name: string) => Array.from(modal()!.querySelectorAll('button'))
      .find(b => b.textContent === name)!;
    const click = async (button: HTMLButtonElement) => { await act(async () => { button.click(); }); };

    await click(primary());
    expect(modal()).not.toBeNull();
    expect(modal()!.querySelector('[role="alert"]')?.textContent)
      .toContain(`37,820 flights is a very long run — ${batchEstimate({ flights: 37820, solverFlights: 37820 })}`);
    expect(sweep).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(action('Cancel'));
    await click(action('Cancel'));
    expect(modal()).toBeNull();
    expect(sweep).not.toHaveBeenCalled();
    expect(closes).toBe(0);

    await click(primary());
    expect(modal()).not.toBeNull();
    await click(primary());
    expect(sweep).not.toHaveBeenCalled();
    await click(action('Run anyway'));
    expect(modal()).toBeNull();
    expect(sweep).toHaveBeenCalledOnce();
    const input = sweep.mock.calls[0]![0];
    expect(batchFlightCount(input.candidates.length, input.splits!.map(split => split.mountIds.length)))
      .toBe(37820);
  });

  it('refuses a sweep past the cap — says why and how to narrow it, and never starts it', () => {
    mount();
    const n = candidateCount();
    act(() => { pairsBox().click(); });
    // The 4+2 / 2+2+2 split is the one that explodes: n(n+1)(n+2)/6 − n.
    const total = n + mixedComboCount(n, 3);
    expect(total).toBeGreaterThan(BATCH_MAX_FLIGHTS);
    // The button still names the count and the time it would take…
    expect(primaryText()).toMatch(new RegExp(`^Simulate ${en(total)} flights · about \\d`));
    // …but will not start it, and the reason is on screen, not in a tooltip.
    expect(primary().disabled).toBe(true);
    const said = host.querySelector('[role="alert"]')?.textContent ?? '';
    expect(said).toContain(`${en(total)} flights is more than one batch will fly: the most is ${en(BATCH_MAX_FLIGHTS)}`);
    expect(said).toContain('Untick mixed 4+2 / 2+2+2');
    expect(said).toContain(`down to ${batchMaxCandidates([3])} or fewer`);
    act(() => { primary().click(); });
    expect(primaryText()).not.toContain('Yes —');
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Stop')).toBe(false);
    // Unticked, the sweep is back within the cap and the button with it.
    act(() => { pairsBox().click(); });
    expect(primary().disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  /** The refusal's sentence, or '' when the sweep is not refused. */
  const refusedText = () => host.querySelector('.batch-refused')?.textContent ?? '';

  it('with both boxes ticked, names only the one whose unticking brings the sweep under the cap', () => {
    mount();
    act(() => { halvesBox().click(); });
    act(() => { pairsBox().click(); });
    expect(refusedText()).toContain('Untick mixed 4+2 / 2+2+2, or bring the candidates down to '
      + `${batchMaxCandidates([2, 3])} or fewer`);
    // Unticking 3+3 alone leaves the split that explodes: still refused.
    expect(refusedText()).not.toContain('Untick mixed 3+3');
    act(() => { halvesBox().click(); });
    expect(primary().disabled).toBe(true);
  });

  /** A 4-ring: its one combination box is "mixed 2+2". */
  const fourRing = (diameterMm: number): [RocketTree, BatchMountOption[]] => [{
    name: 'Four bird',
    components: [{
      type: 'stage', id: 'st0', name: 'Sustainer',
      children: [{
        type: 'bodytube', id: 'bt', length: 0.6,
        children: [{ type: 'innertube', id: 'mount', cluster: '4-ring', length: 0.07 }],
      }],
    }],
  }, [{ id: 'mount', label: `${diameterMm} mm 4-ring`, diameterMm, motorCount: 4, maxMotorLengthM: null }]];
  const CRITERIA_KEY = 'online-openrocket.batch-criteria.v1';

  it('offers unticking include OOP only when that alone brings the sweep under the cap', () => {
    // On 38 mm both the OOP-inclusive and production-only sweeps exceed 50,000.
    localStorage.setItem(CRITERIA_KEY, JSON.stringify({ includeOOP: true }));
    mount(...fourRing(38));
    act(() => { box('mixed 2+2').click(); });
    expect(refusedText()).toContain('flights is more than one batch will fly');
    expect(refusedText()).not.toContain('include OOP');
    // And rightly: unticked, the sweep is still refused.
    act(() => { box('include OOP').click(); });
    expect(primary().disabled).toBe(true);
  });

  it('counts what unticking include OOP leaves through the same filters, makers that stop applying included', () => {
    // Kosdon, Ellis and KBA are all out of production at 54 mm. Unticked, the
    // stored makers no longer apply and the sweep widens to every motor in
    // production: unticking does not shrink this sweep, it grows it.
    localStorage.setItem(CRITERIA_KEY, JSON.stringify({ includeOOP: true, manufacturers: ['Kosdon', 'Ellis', 'KBA'] }));
    mount(TREE, [{ ...MOUNTS[0]!, label: '54 mm cluster', diameterMm: 54 }]);
    /** The meta line's "<n> candidate motors". */
    const metaCount = () => Number(/(\d+) candidate motors/.exec(host.textContent ?? '')![1]);
    act(() => { pairsBox().click(); });
    const before = metaCount();
    expect(batchFlightCount(before, [3])).toBeGreaterThan(BATCH_MAX_FLIGHTS);
    expect(primary().disabled).toBe(true);
    expect(refusedText()).toContain('flights is more than one batch will fly: the most is 50,000');
    expect(refusedText()).not.toContain('include OOP');
    act(() => { box('include OOP').click(); });
    expect(metaCount()).toBeGreaterThan(before);
    expect(primary().disabled).toBe(true);
  });

  it('and offers it when it is enough', () => {
    // 342 candidates with OOP, 312 without: halves cross the 50,000 ceiling.
    localStorage.setItem(CRITERIA_KEY, JSON.stringify({
      includeOOP: true, manufacturers: ['AeroTech', 'Cesaroni', 'Loki'],
    }));
    mount(...fourRing(38));
    act(() => { box('mixed 2+2').click(); });
    expect(primary().disabled, 'the shipped catalogue still puts this sweep over the cap').toBe(true);
    expect(refusedText()).toContain('or by unticking include OOP.');
    act(() => { box('include OOP').click(); });
    expect(primary().disabled).toBe(false);
    expect(refusedText()).toBe('');
  });

  it('allows the former 20,000-flight refusal cases through to confirmation', () => {
    localStorage.setItem(CRITERIA_KEY, JSON.stringify({ includeOOP: true, manufacturers: ['Cesaroni'] }));
    mount(...fourRing(54));
    act(() => { box('mixed 2+2').click(); });
    expect(primary().disabled).toBe(false);
    expect(refusedText()).toBe('');
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
    expect(src).toContain('if ((runAnyway || !armed) && totalFlights > BATCH_CONFIRM_ABOVE_FLIGHTS)');
    expect(src).toContain('setConfirmedSweep(sweepIdentity);\n                  return;');
    expect(src).toContain('setConfirmedSweep(null);\n                void start();');
  });
});
