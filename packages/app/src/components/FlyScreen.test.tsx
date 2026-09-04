// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS } from './LaunchPanel.js';
import { FlyScreen } from './FlyScreen.js';
import type { SimRun } from '../services/simReport.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TREE = { name: 'Field Bird', components: [] };

const INFO = {
  length: 0.37, refDiameter: 0.024, mass: 0.0513, massEmpty: 0.0273,
  cg: 0.262, cgEmpty: 0.198, cp: 0.299, stabilityCalibers: 1.52,
  // A rocket that is stable at 1.52 cal necessarily generates normal force,
  // and the readout now checks that rather than trusting the margin alone:
  // cna = 0 means the CP and the margin are artefacts, not answers.
  cna: 8.995,
  warningTexts: [],
} as never;

/** Only the fields FlyScreen reads. */
const RUN = {
  maxAltitude: 231, maxVelocity: 39.4, optimumDelayS: 4.8,
  landingRate: 4.6, groundHitVelocity: 4.6,
} as SimRun;

describe('FlyScreen', () => {
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

  function mount(over: Partial<Parameters<typeof FlyScreen>[0]> = {}) {
    const calls: string[] = [];
    act(() => root.render(
      <PrefsProvider>
        <FlyScreen
          tree={TREE}
          info={INFO}
          run={RUN}
          motorLabel="Estes C6-5"
          launch={DEFAULT_CONDITIONS}
          onLaunchChange={() => calls.push('launch-change')}
          onLaunch={() => calls.push('launch')}
          simulating={false}
          canLaunch
          onChangeMotor={() => calls.push('change-motor')}
          onCompare={() => calls.push('compare')}
          canCompare
          {...over}
        />
      </PrefsProvider>,
    ));
    return calls;
  }

  it('shows the four field numbers, the stability verdict, and the motor', () => {
    mount();
    const labels = Array.from(host.querySelectorAll('.fly-stat .stat-label')).map((el) => el.textContent);
    expect(labels).toEqual(['Apogee', 'Optimum delay', 'Descent', 'Max velocity']);
    expect(host.querySelector('.fly-stability')?.textContent).toContain('1.52 cal');
    expect(host.querySelector('.fly-stability')?.className).toContain('stability-good');
    expect(host.querySelector('.fly-motor-name')?.textContent).toBe('Estes C6-5');
    expect(host.querySelector('.fly-name')?.textContent).toBe('Field Bird');
  });

  it('never lies before the first flight — dashes, not zeros', () => {
    mount({ run: null });
    const values = Array.from(host.querySelectorAll('.fly-stat .stat-value')).map((el) => el.textContent);
    expect(values).toEqual(['—', '—', '—', '—']);
  });

  it('routes the three actions', () => {
    const calls = mount();
    act(() => { (host.querySelector('.fly-motor') as HTMLButtonElement).click(); });
    act(() => { (host.querySelector('.fly-compare') as HTMLButtonElement).click(); });
    act(() => { (host.querySelector('.fly-launch') as HTMLButtonElement).click(); });
    expect(calls).toEqual(['change-motor', 'compare', 'launch']);
  });

  it('disables Launch when no motor is loaded, and hides Compare when staged', () => {
    mount({ canLaunch: false, canCompare: false, motorLabel: null });
    expect((host.querySelector('.fly-launch') as HTMLButtonElement).disabled).toBe(true);
    expect(host.querySelector('.fly-compare')).toBeFalsy();
    expect(host.querySelector('.fly-motor-name')?.textContent).toBe('none loaded');
  });

  /**
   * Recovery weight is the mass under the chute — dry rocket plus the SPENT
   * casing, not pad weight. It needs no flight, only a motor, so it is the one
   * number on this screen that reads before Launch is pressed.
   */
  describe('recovery weight', () => {
    const statText = (label: string) => Array.from(host.querySelectorAll('.fly-stat'))
      .find((el) => el.querySelector('.stat-label')?.textContent === label)
      ?.querySelector('.stat-value')?.textContent;

    it('reads in the user’s mass unit, with the unit beside it', () => {
      mount({ recovery: { state: 'ok', mass: 8.786, multiStage: false } });
      // Default preference is grams (SI), so 8.786 kg reads as 8786.
      expect(statText('Recovery weight')).toBe('8786g');
    });

    it('asks for a motor rather than showing a number — the owner’s rule', () => {
      mount({ recovery: { state: 'no-motor' } });
      expect(statText('Recovery weight')).toBe('load a motor');
      const tile = Array.from(host.querySelectorAll('.fly-stat'))
        .find((el) => el.querySelector('.stat-label')?.textContent === 'Recovery weight');
      expect(tile?.getAttribute('title')).toMatch(/Load a motor/);
      // Muted, so a sentence never reads as a value.
      expect(tile?.querySelector('.stat-value')?.className).toContain('stat-value-muted');
    });

    it('dashes, with the reason on the tile, when the design cannot answer', () => {
      mount({ recovery: { state: 'unavailable', reason: 'strap-on boosters separate' } });
      expect(statText('Recovery weight')).toBe('—');
      const tile = Array.from(host.querySelectorAll('.fly-stat'))
        .find((el) => el.querySelector('.stat-label')?.textContent === 'Recovery weight');
      expect(tile?.getAttribute('title')).toContain('strap-on boosters separate');
    });

    it('is absent entirely when nothing computed it (no build)', () => {
      mount();
      const labels = Array.from(host.querySelectorAll('.fly-stat .stat-label'))
        .map((el) => el.textContent);
      expect(labels).not.toContain('Recovery weight');
    });
  });
});
