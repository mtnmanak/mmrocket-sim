// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import {
  DEFAULT_CONDITIONS, DEFAULT_TIME_STEP_S, LaunchPanel, timeStepCostFactor,
} from './LaunchPanel.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(timeStepS?: number | null, lastRun?: { ms: number; timeStepS?: number } | null) {
  act(() => {
    root.render(
      <PrefsProvider>
        <LaunchPanel
          value={{ ...DEFAULT_CONDITIONS, ...(timeStepS !== undefined ? { timeStepS } : {}) }}
          onChange={() => {}}
          onLaunch={() => {}}
          simulating={false}
          lastRun={lastRun}
        />
      </PrefsProvider>,
    );
  });
  return host.querySelector('.field-caution');
}

describe('the time-step field', () => {
  it('is offered in the panel', () => {
    render();
    const labels = [...host.querySelectorAll('label')].map((l) => l.textContent);
    expect(labels.some((l) => /Time step/i.test(l ?? ''))).toBe(true);
  });

  it('says nothing at the default, or when the field is blank', () => {
    expect(render()).toBeNull();
    expect(render(null)).toBeNull();
    expect(render(DEFAULT_TIME_STEP_S)).toBeNull();
  });

  it('says nothing for a step COARSER than the default — that is cheaper, not riskier', () => {
    expect(render(0.1)).toBeNull();
  });

  // The user is allowed below 0.05, but never silently: a beta tester lost
  // ~40 s a flight to a 0.01 s step he could not see.
  it('cautions below the default, with the measured cost multiplier', () => {
    const el = render(0.01);
    expect(el).not.toBeNull();
    const text = el!.textContent ?? '';
    expect(text).toMatch(/0\.01 s is finer than the 0\.05 s default/);
    // toContain, not a built RegExp: the factor renders as e.g. "4.3×", and
    // an unescaped "." in a RegExp would match "4x3×" too.
    expect(text).toContain(`${timeStepCostFactor(0.01).toFixed(1)}×`);
    expect(text).toMatch(/Guide/);
  });

  it('quotes seconds per flight once a flight has been timed', () => {
    // A 4.9 s flight measured AT the default: at 0.01 s it should quote the
    // multiplier applied to that, and name the default's own figure too.
    const el = render(0.01, { ms: 4900, timeStepS: DEFAULT_TIME_STEP_S });
    const text = el!.textContent ?? '';
    const expected = (4.9 * timeStepCostFactor(0.01)).toFixed(0);
    expect(text).toContain(`${expected} s`);
    expect(text).toMatch(/per flight instead of 4\.9 s/);
  });

  it('scales from the step the timed flight actually used, not from the default', () => {
    // Same 4.9 s, but measured at 0.01 s — so the default would have been much
    // faster, and re-selecting 0.01 should quote ~the same 4.9 s, not 21 s.
    const el = render(0.01, { ms: 4900, timeStepS: 0.01 });
    const text = el!.textContent ?? '';
    expect(text).toMatch(/roughly 4\.9 s/);
    const atDefault = (4.9 / timeStepCostFactor(0.01)).toFixed(1);
    expect(text).toContain(`instead of ${atDefault} s`);
  });
});

describe('timeStepCostFactor', () => {
  it('is 1 at the default and grows as the step gets finer', () => {
    expect(timeStepCostFactor(DEFAULT_TIME_STEP_S)).toBeCloseTo(1, 6);
    expect(timeStepCostFactor(0.04)).toBeGreaterThan(1);
    expect(timeStepCostFactor(0.01)).toBeGreaterThan(timeStepCostFactor(0.02));
  });

  // Fitted to whole-flight timings on four designs with real thrust curves.
  it('reproduces the measured cost bands', () => {
    expect(timeStepCostFactor(0.04)).toBeGreaterThanOrEqual(1.1);
    expect(timeStepCostFactor(0.04)).toBeLessThanOrEqual(1.3);
    expect(timeStepCostFactor(0.02)).toBeGreaterThanOrEqual(2.0);
    expect(timeStepCostFactor(0.02)).toBeLessThanOrEqual(2.8);
    expect(timeStepCostFactor(0.01)).toBeGreaterThanOrEqual(3.7);
    expect(timeStepCostFactor(0.01)).toBeLessThanOrEqual(6.0);
  });
});

/**
 * THE PAD'S OWN PRESSURE (2026-09-08).
 *
 * The kernel reads the launch site's temperature and pressure as a PAIR: type
 * a temperature, leave the pressure blank, and it flies sea-level 101,325 Pa at
 * the pad however high the site. The field used to be labelled "Pressure",
 * which let every reader supply their own meaning — and the common one, the
 * altimeter setting an airport broadcasts, is the wrong number by 15 % at
 * 3,900 ft. Mechanism and measurements: services/atmosphere.ts.
 */
function renderConditions(over: Partial<typeof DEFAULT_CONDITIONS>) {
  act(() => {
    root.render(
      <PrefsProvider>
        <LaunchPanel
          value={{ ...DEFAULT_CONDITIONS, ...over }}
          onChange={() => {}}
          onLaunch={() => {}}
          simulating={false}
        />
      </PrefsProvider>,
    );
  });
  return host.querySelector('[data-caution="pad-pressure"]');
}

describe('the station-pressure field', () => {
  it('names what it wants: the pressure AT THE PAD, not "Pressure"', () => {
    renderConditions({});
    const labels = [...host.querySelectorAll('label')].map((l) => l.textContent ?? '');
    expect(labels.some((l) => /Station pressure/.test(l))).toBe(true);
    // The bare word is gone — a label that reads only "Pressure" is the thing
    // being fixed, so it must not survive anywhere in the grid.
    expect(labels.some((l) => /^\s*Pressure/.test(l))).toBe(false);
  });

  it('matches how the other launch fields are labelled', () => {
    renderConditions({});
    const labels = [...host.querySelectorAll('label')].map((l) => (l.textContent ?? '').trim());
    // Sentence case, two words, the same shape as "Site altitude" beside it —
    // not Title Case, not an appended explainer.
    expect(labels.some((l) => l.startsWith('Site altitude'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Station pressure'))).toBe(true);
  });

  it('carries field help saying what blank actually does', () => {
    renderConditions({});
    const help = [...host.querySelectorAll('.field')]
      .map((f) => f.getAttribute('title') ?? '')
      .find((t) => /^The pressure AT THE PAD/.test(t)) ?? '';
    expect(help).toMatch(/AT THE PAD/);
    expect(help).toMatch(/not the sea-level altimeter setting/);
    // The correction itself: blank is computed from site altitude ONLY when
    // the temperature is blank too.
    expect(help).toMatch(/BOTH blank/);
    expect(help).toMatch(/computes the pad's pressure from your site altitude/);
    expect(help).toMatch(/Leave only this blank while a temperature is typed and it does not/);
    // And names the number the flight would actually use.
    expect(help).toMatch(/sea-level pressure — 101,325 Pa/);
  });

  it('says on the temperature field that it drags the pressure with it', () => {
    renderConditions({});
    const help = [...host.querySelectorAll('.field')]
      .map((f) => f.getAttribute('title') ?? '')
      .find((t) => /^Air temperature at the pad/.test(t)) ?? '';
    expect(help).toMatch(/type the pad's station pressure with it/);
  });

  it('reaches a screen reader and the keyboard, not only the mouse', () => {
    // The help used to be a `title` on the wrapper `<div>`: not announced, not
    // focusable, so the one sentence explaining the blank-pressure trap was
    // hover-only (2026-09-08, from review). It is now on the input itself
    // through aria-describedby, which is what the `.field` idiom — label
    // BESIDE the control, not around it — otherwise never provides.
    renderConditions({});
    const input = [...host.querySelectorAll('input')]
      .find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Station pressure'));
    expect(input, 'the Station pressure input').toBeTruthy();
    const described = input!.getAttribute('aria-describedby');
    expect(described, 'aria-describedby on the pressure input').toBeTruthy();
    const target = host.querySelector(`#${CSS.escape(described!)}`);
    expect(target?.textContent ?? '').toMatch(/^The pressure AT THE PAD/);
    // Visually hidden, so it says the sentence without printing it twice.
    expect(target?.className).toContain('sr-only');
  });
});

describe('the pad-pressure caution', () => {
  it('says nothing on the defaults — a sea-level pad with both fields blank', () => {
    expect(renderConditions({})).toBeNull();
  });

  it('says nothing at a high site when BOTH fields are blank — that input is right', () => {
    expect(renderConditions({ launchAltitudeM: 2682 })).toBeNull();
  });

  it('says nothing at a low site with a temperature typed', () => {
    expect(renderConditions({ launchAltitudeM: 213, temperatureC: 15 })).toBeNull();
  });

  it('fires when a temperature is typed and the pressure is left blank at altitude', () => {
    const c = renderConditions({ launchAltitudeM: 1189, temperatureC: 32.2 });
    expect(c).not.toBeNull();
    const t = c!.textContent ?? '';
    expect(t).toMatch(/Station pressure is blank and a temperature is typed/);
    // Quotes both numbers: what the flight would use, and what the site reads.
    expect(t).toMatch(/1013 mbar/);
    expect(t).toMatch(/878 mbar/);
    expect(t).toMatch(/clear the temperature too/);
  });

  it('fires on an altimeter setting typed at a high site', () => {
    // 30 in-Hg = 1015.9 mbar at 1,189 m, where a barometer reads about 878.
    const c = renderConditions({ launchAltitudeM: 1189, temperatureC: 32.2, pressureHPa: 1015.9 });
    expect(c).not.toBeNull();
    const t = c!.textContent ?? '';
    expect(t).toMatch(/is about sea-level pressure/);
    expect(t).toMatch(/looks like an altimeter setting/);
    expect(t).toMatch(/878 mbar/);
    // Nothing to clear here — the fix is to replace the number.
    expect(t).not.toMatch(/clear the temperature too/);
  });

  it('says nothing when a plausible station pressure is typed at a high site', () => {
    // A tester who typed the real reading must not be nagged: 878 mbar at
    // 1,189 m is that site's own standard pressure.
    expect(renderConditions({ launchAltitudeM: 1189, temperatureC: 32.2, pressureHPa: 878 })).toBeNull();
    // And a LOW reading is weather or height, never this mistake.
    expect(renderConditions({ launchAltitudeM: 1189, temperatureC: 32.2, pressureHPa: 820 })).toBeNull();
  });
});
