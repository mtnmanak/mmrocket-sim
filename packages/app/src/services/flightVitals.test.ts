import { describe, expect, it } from 'vitest';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { flightVitals } from './flightVitals.js';
import { isWorkingSettings } from './flightState.js';

/** CFG-3 (CFG-SPEC B3, ruling D3): the vitals strip's Flight item. */
const motor = { label: 'F67C-9' } as MountMotor;
const named: SavedConfig = { id: 'c', name: 'Club field', isDefault: true, motors: { m: motor } };
const unnamed: SavedConfig = { id: 'u', name: null, isDefault: false, motors: { m: motor } };
const motors = [{ mount: 'Core', text: 'AeroTech F67C, 9 s delay (F67C-9)' }, { mount: 'Pod', text: 'Estes C6, 5 s delay (C6-5)' }];

describe('flightVitals', () => {
  it('names a named configuration, and its label and every motor in the title', () => {
    const v = flightVitals({ active: named, working: false, motors });
    expect(v.name).toBe('Club field');
    expect(v.title).toBe('Flight configuration “Club field” · motors: Core — AeroTech F67C, 9 s delay (F67C-9);'
      + ' Pod — Estes C6, 5 s delay (C6-5). Choose or edit it on Motors & Configuration.');
  });

  it('leaves an unnamed configuration to its motor label, which is what its label repeats', () => {
    const v = flightVitals({ active: unnamed, working: false, motors: motors.slice(0, 1) });
    expect(v.name).toBeNull();
    expect(v.title).toContain('Flight configuration “[F67C-9]” · motor: Core —');
  });

  it('says Working settings exactly when the chooser does, with or without saved configurations (CFG-3 review, finding 5)', () => {
    expect(flightVitals({ active: undefined, working: true, motors }).name).toBe('Working settings');
    expect(flightVitals({ active: undefined, working: true, motors }).title)
      .toMatch(/^Working settings \(not saved as a flight configuration\)/);
    expect(flightVitals({ active: undefined, working: false, motors: [] }).name).toBeNull();
  });

  it("shares the chooser's test for Working settings: a motor, an unmatched motor, or an override, with nothing active", () => {
    const none = { active: false, hasMotors: false, hasUnmatched: false, hasOverrides: false };
    expect(isWorkingSettings(none)).toBe(false);
    expect(isWorkingSettings({ ...none, hasMotors: true })).toBe(true);
    expect(isWorkingSettings({ ...none, hasUnmatched: true })).toBe(true);
    expect(isWorkingSettings({ ...none, hasOverrides: true })).toBe(true);
    expect(isWorkingSettings({ active: true, hasMotors: true, hasUnmatched: true, hasOverrides: true })).toBe(false);
  });

  it('says no motor is loaded when none is', () => {
    expect(flightVitals({ active: undefined, working: false, motors: [] }).title)
      .toBe('No saved flight configuration · no motor loaded. Choose or edit it on Motors & Configuration.');
  });

  it('ignores a blank name', () => {
    expect(flightVitals({ active: { ...named, name: '  ' }, working: false, motors }).name).toBeNull();
  });
});
