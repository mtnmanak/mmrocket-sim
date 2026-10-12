import { describe, expect, it } from 'vitest';
import { runConfigurationLabel, runConfigurationHeading, runOverrideText, runStatus } from './runConfiguration.js';
import type { SimRun, DesignMatchKey } from './simReport.js';

const records: NonNullable<SimRun['flightOverrides']> = [{ family: 'recovery', kind: 'parachute', partName: 'Main',
  flies: { deployEvent: 'altitude', deployAltitude: 91.44, deployDelay: 0 },
  own: { deployEvent: 'apogee', deployAltitude: 0, deployDelay: 0 } }];

describe('RES-1 frozen run configuration', () => {
  it('distinguishes unknown, none, working settings and a named batch base', () => {
    expect(runConfigurationLabel({})).toBe('—');
    expect(runConfigurationLabel({ flightConfig: 'none' })).toBe('none');
    expect(runConfigurationLabel({ flightConfig: 'working settings' })).toBe('working settings');
    expect(runConfigurationLabel({ flightConfig: 'Club', batch: true })).toBe('Batch · Club');
    expect(runConfigurationHeading({}, 'm')).toBe('Configuration not recorded');
    expect(runConfigurationHeading({ flightConfig: 'none', flightOverrides: [] }, 'm')).toBe('Flown with no configuration');
    expect(runConfigurationHeading({ flightConfig: 'Club' }, 'm')).toContain('overrides: not recorded');
    expect(runConfigurationHeading({ flightConfig: 'none', flightConfigId: 'named' }, 'm')).toContain('Flown in “none”');
  });
  // Review of b9-int, finding 10: a Batch with no saved configuration does not
  // quote 'none' or 'working settings' as if they were configuration names.
  it('words a Batch with no configuration, or with working settings, without quoting a name', () => {
    expect(runConfigurationLabel({ flightConfig: 'none', batch: true })).toBe('Batch · no configuration');
    expect(runConfigurationHeading({ flightConfig: 'none', batch: true, flightOverrides: [] }, 'm')).toBe('Batch with no configuration');
    expect(runConfigurationLabel({ flightConfig: 'working settings', batch: true })).toBe('Batch · working settings');
    expect(runConfigurationHeading({ flightConfig: 'working settings', batch: true, flightOverrides: [] }, 'm'))
      .toBe('Batch with working settings · overrides: none');
    expect(runConfigurationHeading({ flightConfig: 'working settings', flightOverrides: [] }, 'm'))
      .toBe('Flown with working settings · overrides: none');
    // A configuration a user NAMED "none" is still quoted as a name.
    expect(runConfigurationLabel({ flightConfig: 'none', flightConfigId: 'n', batch: true })).toBe('Batch · none');
    expect(runConfigurationHeading({ flightConfig: 'none', flightConfigId: 'n', batch: true, flightOverrides: [] }, 'm'))
      .toBe('Batch from “none” · overrides: none');
  });
  it.each([undefined, [], records])('RES-1b omits the override suffix for no configuration (%j)', flightOverrides => {
    expect(runConfigurationHeading({ flightConfig: 'none', flightOverrides }, 'm')).toBe('Flown with no configuration');
  });
  it('re-renders recorded SI tuples in the viewer units and includes both settings in exports', () => {
    expect(runOverrideText({ flightOverrides: records }, 'ft')).toContain('300 ft');
    expect(runOverrideText({ flightOverrides: records }, 'm')).toContain('91.44 m');
    expect(runOverrideText({ flightOverrides: records }, 'm')).toContain('own: Apogee');
    expect(runOverrideText({}, 'm')).toBe('not recorded');
    expect(runOverrideText({ flightOverrides: [] }, 'm')).toBe('none');
  });
  it('uses provenance evidence, including partial mismatches, without inventing current status', () => {
    expect(runStatus({} as SimRun, null)).toEqual({ label: 'Unknown', title: 'Not recorded or cannot compare' });
    const key = { designKey: 'current' } as DesignMatchKey;
    const status = runStatus({ designKey: 'previous' } as SimRun, key);
    expect(status.label).toBe('Changed');
    expect(status.title).toContain('the design');
  });
});
