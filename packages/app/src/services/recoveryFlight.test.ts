import { describe, expect, it } from 'vitest';
import type { FlightResult } from '@online-openrocket/engine';
import { matchingRecoveryEvents } from './recoveryFlight.js';
import { completedRecoveryEvents } from './recoveryMass.js';
import type { DesignMatchKey, SimRun } from './simReport.js';
const key: DesignMatchKey = { designKey: 'design', motorSetKey: 'motors', motorDataKey: 'curves',
  conditionsKey: 'conditions', aeroMode: 'classic', effectiveKbf: false, autoSupersonic: false };
const run = (over: Partial<SimRun> = {}): SimRun => ({ ...key, id: 'r', when: 1, aeroModel: 'classic', rogersKbf: false,
  recoveryEvents: [{ type: 'STAGE_SEPARATION', time: 3, sourceId: 'booster' }], ...over } as SimRun);
describe('K1 matching recovery evidence', () => {
  it('uses the newest matching configuration and refuses stale evidence', () => {
    const current = run();
    const stale = run({ id: 'stale', when: 3, designKey: 'other-config' });
    expect(matchingRecoveryEvents([stale, current], key, () => undefined)).toEqual(current.recoveryEvents);
    for (const over of [{ designKey: 'edited' }, { motorSetKey: 'other' }, { conditionsKey: 'wind' },
      { motorDataKey: 'curve' }, { aeroModel: 'supersonic' as const }, { importedSummary: true }]) {
      expect(matchingRecoveryEvents([run(over)], key, () => undefined)).toBeUndefined();
    }
    expect(matchingRecoveryEvents([current, run({ when: 2, recoveryEvents: [] })], key, () => undefined)).toEqual([]);
    expect(matchingRecoveryEvents([current, run({ when: 2, recoveryEvents: undefined })], key, () => undefined)).toBeUndefined();
  });
  it('requires all branches to finish and stable event identities', () => {
    const events = [{ type: 'BURNOUT', time: 2, motorMountId: 'm' }, { type: 'GROUND_HIT', time: 10 }];
    const flight = { events, branches: [{ name: 'booster', events: [
      { type: 'STAGE_SEPARATION', time: 3, sourceId: 's' }, { type: 'GROUND_HIT', time: 12 }],
    }] } as FlightResult;
    expect(completedRecoveryEvents(flight)).toHaveLength(2);
    expect(matchingRecoveryEvents([run()], key, () => flight)).toEqual(completedRecoveryEvents(flight));
    flight.branches![0]!.events.pop();
    expect(completedRecoveryEvents(flight)).toBeUndefined();
    expect(matchingRecoveryEvents([run()], key, () => flight)).toBeUndefined();
    expect(completedRecoveryEvents({ events: [...events, { type: 'SIM_ABORT', time: 5 }] } as FlightResult)).toBeUndefined();
    expect(completedRecoveryEvents({ events: [{ type: 'BURNOUT', time: 2 }, events[1]!] } as FlightResult)).toBeUndefined();
    expect(matchingRecoveryEvents([run({ recoveryEvents: [null] as never })], key, () => undefined)).toBeUndefined();
  });
});
