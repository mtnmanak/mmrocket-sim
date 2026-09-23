import { describe, expect, it } from 'vitest';
import type { MotorSpec } from '@online-openrocket/engine';
import { savedConfigLabel, type MountMotor, type SavedConfig } from './design.js';

/**
 * The configuration label the Flight configurations panel and the run's
 * "Flight config" column both print. It moved here from App.tsx with the
 * domain types (audit 2026-09-22, row 497); these pin what it said there.
 */

const SPEC = { designation: 'H128' } as MotorSpec;
const mm = (label: string): MountMotor => ({
  label, spec: SPEC, meta: { label }, ignition: { event: 'automatic', delay: 0 },
});
const config = (over: Partial<SavedConfig>): SavedConfig => ({
  id: 'cfg', name: null, isDefault: false, motors: {}, ...over,
});

describe('savedConfigLabel', () => {
  it('a named configuration reads as its name', () => {
    expect(savedConfigLabel(config({ name: 'Windy day', motors: { a: mm('H128-10') } }))).toBe('Windy day');
  });

  it('a nameless one reads as its motor set, never as its id', () => {
    expect(savedConfigLabel(config({ motors: { a: mm('H128-10'), b: mm('F39-6') } }))).toBe('[H128-10, F39-6]');
  });

  it('names the motors the import could not match too, or an unmatched-only set reads "No motors"', () => {
    expect(savedConfigLabel(config({ motors: { a: mm('H128-10') }, unmatched: ['K550W-L'] })))
      .toBe('[H128-10, K550W-L]');
    expect(savedConfigLabel(config({ unmatched: ['K550W-L'] }))).toBe('[K550W-L]');
  });

  it('says "No motors" only when there are none of either', () => {
    expect(savedConfigLabel(config({}))).toBe('No motors');
    // An empty label is not a motor.
    expect(savedConfigLabel(config({ motors: { a: mm('') } }))).toBe('No motors');
  });
});
