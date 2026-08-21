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
});
