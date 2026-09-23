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
   * A selected history run is a flight of whatever rocket it was — and this is
   * the phone home screen, where the optimum delay is the number people set at
   * the pad. The screen got only the MODEL mark, so a run of another rocket,
   * motor or launch conditions showed its apogee, delay and descent here
   * unmarked, beside a Recovery-weight tile that follows the motor loaded now
   * (audit 2026-09-22).
   */
  describe('a flight that no longer describes the design', () => {
    const FLOWN = {
      ...RUN, when: Date.now(), motor: 'C6', manufacturer: 'Estes', delayS: 3,
    } as SimRun;
    const notes = () => Array.from(host.querySelectorAll('.fly-stale')).map((el) => el.textContent ?? '');

    it('says what flew and what changed since, and sends the user to Launch', () => {
      mount({ run: FLOWN, changedSince: ['the motor'] });
      expect(notes()).toHaveLength(1);
      expect(notes()[0]).toMatch(/Flown with Estes C6-3 at .+ — the motor changed since\. Press Launch/);
    });

    it('lists every change, the way the Results tab does', () => {
      mount({ run: FLOWN, changedSince: ['the design', 'the launch conditions'] });
      expect(notes()[0]).toContain('the design and the launch conditions changed since');
    });

    it('names a plugged motor as plugged, not as an Infinity-second delay', () => {
      mount({ run: { ...FLOWN, delayS: Infinity }, changedSince: ['the design'] });
      expect(notes()[0]).toContain('Estes C6-P');
    });

    it('names a Batch combination as the report header does, with no delay hung on its last leg', () => {
      // Batch stores a combination with the whole label as `motor` and the
      // manufacturers '+'-joined; it carries a conditions key, so a change of
      // launch conditions shows this note for it.
      mount({
        run: {
          ...FLOWN, motor: '4× G80 + 2× F39', manufacturer: 'AT+CTI', delayS: 7, motorConfig: 'mixed 4+2',
        },
        changedSince: ['the launch conditions'],
      });
      expect(notes()[0]).toMatch(/Flown with 4× G80 \+ 2× F39 \(AT\+CTI\) at .+ — the launch conditions changed since/);
      expect(notes()[0]).not.toContain('F39-7');
    });

    it('a single-motor Batch row keeps the single-motor form', () => {
      mount({ run: { ...FLOWN, motorConfig: 'single' }, changedSince: ['the design'] });
      expect(notes()[0]).toContain('Estes C6-3');
    });

    it('says nothing when nothing changed, or when it cannot be told', () => {
      mount({ run: FLOWN, changedSince: [] });
      expect(notes()).toEqual([]);
      mount({ run: FLOWN, changedSince: null });
      expect(notes()).toEqual([]);
    });

    it('keeps the model note as well — they are different reasons', () => {
      mount({ run: FLOWN, changedSince: ['the motor'], staleModel: 'Extended Barrowman' });
      expect(notes()).toHaveLength(2);
      expect(notes()[0]).toContain('Extended Barrowman');
    });
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

  /**
   * ☁ GET WEATHER on the phone (weather build, step 3, owner decision D3
   * default): the same App dialog as the Launch panel's. The Fly screen gets
   * no gust estimate and no σ field — a bulk write of σ is never offered.
   */
  describe('the weather button', () => {
    it('opens App’s weather dialog, and is absent without it', () => {
      mount();
      expect(host.querySelector('.weather-btn')).toBeNull();
      let asked = 0;
      mount({ onGetWeather: () => { asked++; } });
      const btn = host.querySelector<HTMLButtonElement>('.weather-btn')!;
      expect(btn.textContent).toBe('☁ Get weather…');
      act(() => btn.click());
      expect(asked).toBe(1);
    });

    it('greys out offline and says why', () => {
      mount({ onGetWeather: () => {} });
      act(() => { window.dispatchEvent(new Event('offline')); });
      const btn = host.querySelector<HTMLButtonElement>('.weather-btn')!;
      expect(btn.disabled).toBe(true);
      expect(btn.title).toMatch(/^Needs a connection/);
      act(() => { window.dispatchEvent(new Event('online')); });
      expect(host.querySelector<HTMLButtonElement>('.weather-btn')!.disabled).toBe(false);
    });

    it('credits Open-Meteo once weather is applied, and offers no σ or gust estimate', () => {
      mount({
        onGetWeather: () => {},
        weather: { place: { label: 'Gerlach, Nevada, US' } } as never,
      });
      const links = Array.from(host.querySelectorAll('.fly-weather a')).map((a) => a.getAttribute('href'));
      expect(links).toEqual(['https://open-meteo.com/', 'https://creativecommons.org/licenses/by/4.0/']);
      expect(host.querySelector('.gust-estimate')).toBeNull();
      const labels = Array.from(host.querySelectorAll('input')).map((i) => i.getAttribute('aria-label') ?? '');
      expect(labels.some((l) => l.startsWith('Wind gusts'))).toBe(false);
    });
  });
});
