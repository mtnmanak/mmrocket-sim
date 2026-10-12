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
    expect(runConfigurationHeading({ flightConfig: 'none', flightOverrides: [] }, 'm')).toBe('Flown with no configuration · overrides: none');
    expect(runConfigurationHeading({ flightConfig: 'Club' }, 'm')).toContain('overrides: not recorded');
    expect(runConfigurationHeading({ flightConfig: 'none', flightConfigId: 'named' }, 'm')).toContain('Flown in “none”');
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
