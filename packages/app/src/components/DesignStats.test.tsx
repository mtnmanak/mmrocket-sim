// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StaticInfo } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { RecoveryMass } from '../services/recoveryMass.js';
import { DesignStats } from './StatTiles.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The owner's Wildman, rounded to the numbers that made the case: 11.7 kg on
 * the pad and 8.786 kg under the drogue. Its measured descent rate only
 * reproduced at the second figure, and the vitals strip showed neither.
 */
const INFO = {
  length: 2.1, lengthAerodynamic: 2.1, refDiameter: 0.098,
  mass: 11.7, massEmpty: 6.651,
  cg: 1.31, cgEmpty: 1.18, cp: 1.62, cna: 12.4, stabilityCalibers: 3.16,
  rotationalInertia: 0.011, longitudinalInertia: 4.9,
  rotationalInertiaEmpty: 0.009, longitudinalInertiaEmpty: 3.8,
  warnings: 0, warningTexts: [],
} as StaticInfo;

describe('DesignStats — recovery weight in the vitals strip', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    localStorage.clear();
  });

  const mount = (recovery?: RecoveryMass) => act(() => root.render(
    <PrefsProvider>
      <DesignStats info={INFO} recovery={recovery} cd={0.41} />
    </PrefsProvider>,
  ));

  const tile = (label: string) => Array.from(host.querySelectorAll('.stat-tile'))
    .find((el) => el.querySelector('.stat-label')?.textContent === label);
  /**
   * The NUMBER only. A mass tile's unit is a UnitChip — a <select> — so
   * `textContent` on the whole cell drags in every option it offers ("kgozlb").
   */
  const value = (label: string) => {
    const cell = tile(label)?.querySelector('.stat-value');
    if (!cell) return undefined;
    return Array.from(cell.childNodes)
      .filter((n) => n.nodeType === 3 /* text */)
      .map((n) => n.textContent)
      .join('');
  };

  it('sits beside Mass (loaded) and is neither of the two masses already shown', () => {
    mount({ state: 'ok', mass: 8.786, multiStage: false });
    const labels = Array.from(host.querySelectorAll('.stat-row')[0]!.querySelectorAll('.stat-label'))
      .map((el) => el.textContent);
    expect(labels).toEqual(['Length', 'Max diameter', 'Mass (empty)', 'Mass (loaded)', 'Recovery weight']);
    // Default mass unit is grams. 11 700 g on the pad, 6 651 g of structure,
    // and the number a canopy is sized on is neither of them.
    expect(value('Mass (empty)')).toBe('6651');
    expect(value('Mass (loaded)')).toBe('11700');
    expect(value('Recovery weight')).toBe('8786');
  });

  it('follows the mass-unit preference rather than hard-coding grams', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { mass: 'lb' } }));
    mount({ state: 'ok', mass: 8.786, multiStage: false });
    // 8.786 kg = 19.37 lb. Whatever the exact rounding, it must NOT be grams.
    expect(value('Recovery weight')).toMatch(/^19\.4?/);
  });

  it('asks for a motor instead of showing a number — the owner’s explicit rule', () => {
    mount({ state: 'no-motor' });
    expect(value('Recovery weight')).toBe('load a motor');
    expect(tile('Recovery weight')?.getAttribute('title')).toMatch(/Load a motor/);
    expect(tile('Recovery weight')?.querySelector('.stat-value')?.className)
      .toContain('stat-value-muted');
  });

  it('says WHY it is absent rather than printing the mass of no real object', () => {
    mount({ state: 'unavailable', reason: 'strap-on boosters separate' });
    expect(value('Recovery weight')).toBe('—');
    expect(tile('Recovery weight')?.getAttribute('title')).toContain('strap-on boosters separate');
  });

  it('names the sustainer in the multi-stage explanation', () => {
    mount({ state: 'ok', mass: 3.2, multiStage: true });
    expect(tile('Recovery weight')?.getAttribute('title')).toMatch(/SUSTAINER/);
  });

  it('is omitted entirely when nothing computed it', () => {
    mount(undefined);
    expect(tile('Recovery weight')).toBeUndefined();
    // …and the rest of the strip is untouched.
    expect(value('Mass (loaded)')).toBe('11700');
  });
});
