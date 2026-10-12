import { describe, it, expect } from 'vitest';
import { timeStepCostFactor } from './launchConditions.js';
import { mixedComboCount } from './batchSweep.js';
import { MOTOR_DB } from './motorDb.js';
import {
  BATCH_ESTIMATE_ABOVE_FLIGHTS, BATCH_FLIGHT_S, BATCH_MAX_FLIGHTS, batchButtonLabel, batchCandidates,
  batchConfirmWarning, batchDurationText, batchEstimate, batchFlightCount, batchMaxCandidates,
  batchProgressAnnouncement, batchRefusal, batchSweepSeconds,
} from './batchCriteria.js';

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

