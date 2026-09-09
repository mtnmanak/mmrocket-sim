// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import {
  DEFAULT_CONDITIONS, DEFAULT_TIME_STEP_S, kernelSimOptions, LaunchPanel, timeStepCostFactor,
  type LaunchConditions,
} from './LaunchPanel.js';
import { isaPressurePa, isaTemperatureK } from '../services/atmosphere.js';

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
/** The last conditions the panel committed, so a spinner step can be asserted. */
let lastLaunch: LaunchConditions | null = null;

function renderConditions(over: Partial<typeof DEFAULT_CONDITIONS>) {
  lastLaunch = null;
  act(() => {
    root.render(
      <PrefsProvider>
        <LaunchPanel
          value={{ ...DEFAULT_CONDITIONS, ...over }}
          onChange={(v) => { lastLaunch = v; }}
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
    expect(labels.some((l) => l.startsWith('Site altitude'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Station pressure'))).toBe(true);
  });

  /**
   * REWRITTEN 2026-09-08b. The help used to explain a trap; there is no trap
   * now, so it explains a default instead. What it must NOT do again is ask the
   * user for a barometer reading at a pad they have not driven to yet.
   */
  it('says the field fills itself in, and does not ask for a reading nobody has', () => {
    renderConditions({});
    const help = [...host.querySelectorAll('.field')]
      .map((f) => f.getAttribute('title') ?? '')
      .find((t) => /^Filled in from your Site altitude/.test(t) && /STATION pressure/.test(t)) ?? '';
    expect(help, 'the Station pressure help').toBeTruthy();
    expect(help).toMatch(/follows the altitude when you change it/);
    expect(help).toMatch(/Type a value only to try a specific day/);
    // Still names the KIND of number, because a typed one can still be wrong.
    expect(help).toMatch(/not the\s+sea-level altimeter setting/);
    // The v0.120 copy, and the instruction it carried, are both gone.
    expect(help).not.toMatch(/AT THE PAD/);
    expect(help).not.toMatch(/BOTH blank/);
    expect(help).not.toMatch(/Type the two together/);
  });

  it('shows the computed pressure in the box, not the word "standard"', () => {
    // Eric's ask: "the user should get this filled in automatically based on
    // the altitude". A placeholder rather than a committed value, so the number
    // stays LINKED to Site altitude — see LaunchField.autoStored.
    renderConditions({ launchAltitudeM: 1189 });
    const input = [...host.querySelectorAll('input')]
      .find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Station pressure'));
    expect(input, 'the Station pressure input').toBeTruthy();
    // 878 mbar is the standing pressure at 1,189 m.
    expect(input!.getAttribute('placeholder')).toMatch(/878/);
    expect(input!.getAttribute('placeholder')).not.toBe('standard');
  });

  it('moves the shown pressure when the site altitude moves', () => {
    const at = (h: number) => {
      renderConditions({ launchAltitudeM: h });
      return [...host.querySelectorAll('input')]
        .find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Station pressure'))!
        .getAttribute('placeholder') ?? '';
    };
    // The whole reason it is a placeholder and not a written value: a real
    // number typed into the box would freeze at the old site's air.
    expect(at(0)).toMatch(/1013/);
    expect(at(2682)).toMatch(/730/);
  });

  it('reaches a screen reader and the keyboard, not only the mouse', () => {
    // The help used to be a `title` on the wrapper div: not announced, not
    // focusable (2026-09-08, from review). It is now on the input itself
    // through aria-describedby, which is what the `.field` idiom — label
    // BESIDE the control, not around it — otherwise never provides.
    renderConditions({});
    const input = [...host.querySelectorAll('input')]
      .find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Station pressure'));
    expect(input, 'the Station pressure input').toBeTruthy();
    const described = input!.getAttribute('aria-describedby');
    expect(described, 'aria-describedby on the pressure input').toBeTruthy();
    const target = host.querySelector(`#${CSS.escape(described!)}`);
    expect(target?.textContent ?? '').toMatch(/^Filled in from your Site altitude/);
    expect(target?.className).toContain('sr-only');
  });
});

/**
 * THE ASSERTION THE WHOLE CHANGE RESTS ON (2026-09-08b).
 *
 * Everything above is copy. This is the behaviour: a blank field flies the
 * value for the SITE, not the value for sea level. It is asserted against
 * kernelSimOptions because that is the ONE construction Launch, the full-series
 * CSV re-run and the batch runner all share — right here is right everywhere
 * that flies.
 */
describe('kernelSimOptions fills a blank atmosphere field from the site altitude', () => {
  const opts = (over: Partial<LaunchConditions>) =>
    kernelSimOptions({ ...DEFAULT_CONDITIONS, ...over });

  it('gives a blank pressure the standing pressure for the site, not 101,325 Pa', () => {
    // The MESOS case: a file states a temperature and no pressure at 2,682 m.
    // This flew sea level through v0.120 and cost 29.7 % of apogee.
    const o = opts({ launchAltitudeM: 2682, temperatureC: 12.8 });
    expect(o.pressure).toBeCloseTo(isaPressurePa(2682), 6);
    expect(o.pressure!).toBeLessThan(80000);
    expect(o.temperature).toBeCloseTo(12.8 + 273.15, 6);
  });

  it('gives a blank temperature the standing temperature for the site, not 288.15 K', () => {
    const o = opts({ launchAltitudeM: 2682, pressureHPa: 730 });
    expect(o.temperature).toBeCloseTo(isaTemperatureK(2682), 6);
    expect(o.temperature!).toBeLessThan(280);
    expect(o.pressure).toBeCloseTo(73000, 6);
  });

  it('still defers to the kernel when BOTH are blank, so those flights are unchanged', () => {
    // Deliberately undefined rather than a value computed here: the kernel's
    // own atmosphere is the reference, and passing our numbers instead would
    // move every existing design by whatever the two implementations disagree
    // by. Both-blank is the common case, so this is the bit-identical guard.
    const o = opts({ launchAltitudeM: 2682 });
    expect(o.temperature).toBeUndefined();
    expect(o.pressure).toBeUndefined();
  });

  it('passes both through untouched when both are typed', () => {
    const o = opts({ launchAltitudeM: 2682, temperatureC: -2.4, pressureHPa: 730 });
    expect(o.temperature).toBeCloseTo(270.75, 2);
    expect(o.pressure).toBeCloseTo(73000, 6);
  });

  it('does the same at sea level, where the fill is the sea-level value anyway', () => {
    const o = opts({ launchAltitudeM: 0, temperatureC: 30 });
    expect(o.pressure).toBeCloseTo(101325, 0);
  });
});

describe('the site-temperature field', () => {
  it('says the field fills itself in from the site altitude', () => {
    renderConditions({});
    const help = [...host.querySelectorAll('.field')]
      .map((f) => f.getAttribute('title') ?? '')
      .find((t) => /falling 6\.5/.test(t)) ?? '';
    expect(help, 'the Temperature field help').toBeTruthy();
    expect(help).toMatch(/^Filled in from your Site altitude/);
    expect(help).toMatch(/follows the altitude when\s+you change it/);
    // The v0.120 instruction is gone from this half too.
    expect(help).not.toMatch(/BOTH blank/);
    expect(help).not.toMatch(/station pressure with it/);
  });

  /**
   * ASSERT THE NUMBER, not a pattern it happens to contain.
   *
   * This test used to read `toMatch(/-2/)`, which passes on "-2.43" and passes
   * just as happily on "-275.58" — and -275.58 is what v0.122 actually shipped,
   * because the placeholder hand-rolled the stored->SI conversion and dropped
   * temperature's 273.15 offset. A blank Temperature field advertised the
   * sea-level standard as MINUS 258.15 C. The test could not tell the right
   * answer from one 273 degrees out, so it did not.
   */
  it('shows the computed temperature in its box, as an actual temperature', () => {
    renderConditions({ launchAltitudeM: 0 });
    const at = (label: string) => [...host.querySelectorAll('input')]
      .find((i) => (i.getAttribute('aria-label') ?? '').startsWith(label))!
      .getAttribute('placeholder') ?? '';
    // Sea level: the ISA standard, 15 C. NOT -258.15.
    expect(Number(at('Temperature'))).toBeCloseTo(15, 1);

    renderConditions({ launchAltitudeM: 2682 });
    // 2,682 m: 15 - 6.5 * 2.682 = -2.43 C.
    expect(Number(at('Temperature'))).toBeCloseTo(-2.43, 1);

    renderConditions({ launchAltitudeM: 1189 });
    expect(Number(at('Temperature'))).toBeCloseTo(7.27, 1);
  });

  it('never advertises a temperature colder than the field will accept', () => {
    // The blunt guard: whatever the conversion does, a standing temperature is
    // an ordinary air temperature. The field's own range is -60..60 C.
    for (const h of [0, 500, 1189, 2682, 5000, 10000]) {
      renderConditions({ launchAltitudeM: h });
      const shown = Number([...host.querySelectorAll('input')]
        .find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Temperature'))!
        .getAttribute('placeholder'));
      expect(shown, `site altitude ${h} m`).toBeGreaterThan(-60);
      expect(shown, `site altitude ${h} m`).toBeLessThan(60);
    }
  });

  it('seeds the spinner from the shown value, not from a parsed placeholder', () => {
    // Why this matters: NumField digs the auto value out of the placeholder
    // text with a regex when it is not given one explicitly. With the wrong
    // placeholder that made the display bug REACHABLE — stepping up from a
    // blank Temperature field seeded from -258.15 and committed the field's own
    // -60 C floor, and a typed value IS flown. LaunchField now passes
    // autoValue, so the spinner cannot depend on formatted text at all.
    renderConditions({ launchAltitudeM: 0 });
    const input = [...host.querySelectorAll('input')]
      .find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Temperature'))!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    // One step of 1 C up from the sea-level standard 15 C.
    expect(lastLaunch?.temperatureC).toBeCloseTo(16, 1);
  });

  it('reaches a screen reader, the same way the pressure help does', () => {
    renderConditions({});
    const input = [...host.querySelectorAll('input')]
      .find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Temperature'));
    expect(input, 'the Temperature input').toBeTruthy();
    const described = input!.getAttribute('aria-describedby');
    expect(described, 'aria-describedby on the temperature input').toBeTruthy();
    const target = host.querySelector(`#${CSS.escape(described!)}`);
    expect(target?.textContent ?? '').toMatch(/^Filled in from your Site altitude/);
    expect(target?.className).toContain('sr-only');
  });
});

describe('the pad-pressure caution', () => {
  it('says nothing on the defaults — a sea-level pad with both fields blank', () => {
    expect(renderConditions({})).toBeNull();
  });

  /**
   * The four cases that used to fire and must not any more. Each is correct
   * input now: the app fills the blank field from the site altitude, so a
   * caution here would be the app warning the user about its own default.
   */
  it('says nothing whenever a field is left blank, however high the site', () => {
    expect(renderConditions({ launchAltitudeM: 2682 })).toBeNull();
    expect(renderConditions({ launchAltitudeM: 1189, temperatureC: 32.2 })).toBeNull();
    expect(renderConditions({ launchAltitudeM: 2682, temperatureC: null, pressureHPa: 730 })).toBeNull();
    expect(renderConditions({ launchAltitudeM: 213, temperatureC: 15 })).toBeNull();
  });

  it('fires on an altimeter setting typed at a high site', () => {
    // 30 in-Hg = 1015.9 mbar at 1,189 m, where a barometer reads about 878.
    // The one case a default cannot rescue: the user typed a number, and it is
    // the wrong KIND of number.
    const c = renderConditions({ launchAltitudeM: 1189, temperatureC: 32.2, pressureHPa: 1015.9 });
    expect(c).not.toBeNull();
    const t = c!.textContent ?? '';
    expect(t).toMatch(/is about sea-level\s+pressure/);
    expect(t).toMatch(/looks like an altimeter setting/);
    expect(t).toMatch(/878 mbar/);
    // The fix is now "clear it", not "type the right one" — because clearing
    // it gets the right one automatically.
    expect(t).toMatch(/Clear the field/);
    expect(t).toMatch(/See Launch Conditions in the Guide/);
  });

  it('fires with the temperature blank too — there is no second issue to outrank', () => {
    const c = renderConditions({ launchAltitudeM: 1189, temperatureC: null, pressureHPa: 1015.9 });
    expect(c).not.toBeNull();
    expect(c!.textContent ?? '').toMatch(/is about sea-level\s+pressure/);
  });

  it('says nothing when a plausible station pressure is typed at a high site', () => {
    // A tester who typed the real reading must not be nagged: 878 mbar at
    // 1,189 m is that site's own standard pressure.
    expect(renderConditions({ launchAltitudeM: 1189, temperatureC: 32.2, pressureHPa: 878 })).toBeNull();
    // And a LOW reading is weather or height, never this mistake.
    expect(renderConditions({ launchAltitudeM: 1189, temperatureC: 32.2, pressureHPa: 820 })).toBeNull();
  });

  /**
   * The NaN reproduction, at the panel. An imported site altitude is not
   * clamped by NumField's `max` (that only rejects TYPED text), so a .CDX1
   * stating 150,000 ft reaches the caution intact. `isaPressurePa` is total
   * now, so the caution quotes a real figure instead of "—".
   */
  it('quotes a real pressure at an absurd imported site altitude', () => {
    const c = renderConditions({ launchAltitudeM: 45720, temperatureC: null, pressureHPa: 500 });
    expect(c).not.toBeNull();
    const t = c!.textContent ?? '';
    expect(t).not.toMatch(/NaN/);
    expect(t).not.toMatch(/—\s*(mbar|°C)/);
  });
});
