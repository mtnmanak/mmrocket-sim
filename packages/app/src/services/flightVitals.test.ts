import { describe, expect, it } from 'vitest';
import type { MountMotor, SavedConfig } from '../model/design.js';
import { flightVitals } from './flightVitals.js';

/** CFG-3 (CFG-SPEC B3, ruling D3): the vitals strip's Flight item. */
const motor = { label: 'F67C-9' } as MountMotor;
const named: SavedConfig = { id: 'c', name: 'Club field', isDefault: true, motors: { m: motor } };
const unnamed: SavedConfig = { id: 'u', name: null, isDefault: false, motors: { m: motor } };
const motors = [{ mount: 'Core', text: 'AeroTech F67C, 9 s delay (F67C-9)' }, { mount: 'Pod', text: 'Estes C6, 5 s delay (C6-5)' }];

describe('flightVitals', () => {
  it('names a named configuration, and its label and every motor in the title', () => {
    const v = flightVitals({ active: named, savedCount: 1, working: false, motors });
    expect(v.name).toBe('Club field');
    expect(v.title).toBe('Flight configuration “Club field” · motors: Core — AeroTech F67C, 9 s delay (F67C-9);'
      + ' Pod — Estes C6, 5 s delay (C6-5). Choose or edit it on Motors & Configuration.');
  });

  it('leaves an unnamed configuration to its motor label, which is what its label repeats', () => {
    const v = flightVitals({ active: unnamed, savedCount: 1, working: false, motors: motors.slice(0, 1) });
    expect(v.name).toBeNull();
    expect(v.title).toContain('Flight configuration “[F67C-9]” · motor: Core —');
  });

  it('says Working settings only beside saved configurations, never for a design with none', () => {
    expect(flightVitals({ active: undefined, savedCount: 2, working: true, motors }).name).toBe('Working settings');
    expect(flightVitals({ active: undefined, savedCount: 2, working: true, motors }).title)
      .toMatch(/^Working settings \(not saved as a flight configuration\)/);
    expect(flightVitals({ active: undefined, savedCount: 0, working: true, motors }).name).toBeNull();
    expect(flightVitals({ active: undefined, savedCount: 2, working: false, motors: [] }).name).toBeNull();
  });

  it('says no motor is loaded when none is', () => {
    expect(flightVitals({ active: undefined, savedCount: 0, working: false, motors: [] }).title)
      .toBe('No saved flight configuration · no motor loaded. Choose or edit it on Motors & Configuration.');
  });

  it('ignores a blank name', () => {
    expect(flightVitals({ active: { ...named, name: '  ' }, savedCount: 1, working: false, motors }).name).toBeNull();
  });
});
