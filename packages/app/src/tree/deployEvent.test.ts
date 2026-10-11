import { describe, expect, it } from 'vitest';
import { flownDeployEvent, foldDeployEvent } from './deployEvent.js';

describe('RECOV-CASE deploy events read the way the kernel reads them', () => {
  it('flownDeployEvent lower-cases, and flies anything it does not name as the ejection charge', () => {
    expect(flownDeployEvent('Altitude')).toBe('altitude');
    expect(flownDeployEvent('APOGEE')).toBe('apogee');
    expect(flownDeployEvent('Never')).toBe('never');
    expect(flownDeployEvent('launch')).toBe('launch');
    expect(flownDeployEvent('lowerstageseparation')).toBe('ejection');
    expect(flownDeployEvent(undefined)).toBe('ejection');
    expect(flownDeployEvent(5)).toBe('ejection');
  });

  it('foldDeployEvent folds the case of a kernel event and keeps any other value as written', () => {
    expect(foldDeployEvent('Altitude')).toBe('altitude');
    expect(foldDeployEvent('EJECTION')).toBe('ejection');
    expect(foldDeployEvent('lowerstageseparation')).toBe('lowerstageseparation');
    expect(foldDeployEvent('LowerStageSeparation')).toBe('LowerStageSeparation');
  });
});
