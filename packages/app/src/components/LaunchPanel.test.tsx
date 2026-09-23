// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import {
  canonicalRodAimDeg, DEFAULT_CONDITIONS, DEFAULT_TIME_STEP_S, DENSITY_ALTITUDE_HELP, flownRodAimDeg, kernelSimOptions,
  LaunchField, LaunchPanel, LONGITUDE_HELP, normalizeRodAimDeg, ROD_AIM_DEG_RANGE, ROD_AIM_HELP, timeStepCostFactor,
  type LaunchConditions,
} from './LaunchPanel.js';
import { densityAltitudeM, isaPressurePa, isaTemperatureK } from '../services/atmosphere.js';
import type { WeatherSnapshot } from '../services/weatherSnapshot.js';

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

function render(timeStepS?: number | null, lastRun?: { ms: number; timeStepS?: number } | null,
    canLaunch = true) {
  act(() => {
    root.render(
      <PrefsProvider>
        <LaunchPanel
          value={{ ...DEFAULT_CONDITIONS, ...(timeStepS !== undefined ? { timeStepS } : {}) }}
          onChange={() => {}}
          onLaunch={() => {}}
          simulating={false}
          canLaunch={canLaunch}
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
          canLaunch
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

  /**
   * THE CHOKEPOINT (audit 2026-09-22). A stored atmosphere used to reach the
   * kernel raw: the .CDX1 reader had none of the .ork reader's envelope, so a
   * pressure typed in hPa into RASAero's in-Hg field flew 3,431,260 Pa — 34x
   * sea-level density — and -300 °F flew 88.7 K, with no note. Whatever put
   * such a value in the store, it now flies as blank: the site's standard day.
   */
  it('flies an atmosphere outside the panel’s own envelope as blank, never raw', () => {
    const hPaAsInHg = opts({ launchAltitudeM: 1500, temperatureC: 20, pressureHPa: 1013.25 * 33.8639 });
    expect(hPaAsInHg.pressure).toBe(isaPressurePa(1500));
    expect(hPaAsInHg.temperature).toBeCloseTo(293.15, 9);

    const coldF = opts({ launchAltitudeM: 1500, temperatureC: (-300 - 32) * 5 / 9, pressureHPa: 850 });
    expect(coldF.temperature).toBe(isaTemperatureK(1500));
    expect(coldF.pressure).toBe(85000);

    // Both unusable is both blank, so the kernel flies its own standard day.
    const both = opts({ launchAltitudeM: 1500, temperatureC: -184, pressureHPa: 34313 });
    expect(both.temperature).toBeUndefined();
    expect(both.pressure).toBeUndefined();
  });

  it('flies the site altitude clamped to the field’s own range, the same one it reads the air at', () => {
    const o = opts({ launchAltitudeM: 150000 / 3.28084, temperatureC: 20 });
    expect(o.launchAltitude).toBe(10000);
    expect(o.pressure).toBe(isaPressurePa(10000));
    expect(opts({ launchAltitudeM: -30 }).launchAltitude).toBe(0);
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

/**
 * THE THIRD LAUNCH BUTTON. This one was enabled with no motor assigned, and
 * the click fell through onLaunch's early return with no message and no
 * navigation — silence — while the vitals strip on the same workspace showed
 * a greyed-out Launch at that moment. FlyScreen's button already took this
 * prop from the same expression; all three agree now.
 */
describe('Launch is disabled until a motor is assigned', () => {
  const launchBtn = () => [...host.querySelectorAll('button')]
    .find((b) => /Launch/.test(b.textContent ?? '')) as HTMLButtonElement | undefined;

  it('is disabled and says why with no motor', () => {
    render(undefined, null, false);
    const b = launchBtn();
    expect(b).toBeTruthy();
    expect(b!.disabled).toBe(true);
    expect(b!.title).toBe('Assign a motor first');
  });

  it('is enabled once one is', () => {
    render(undefined, null, true);
    const b = launchBtn();
    expect(b!.disabled).toBe(false);
    expect(b!.title).toBe('Simulate the flight');
  });
});

/**
 * THE ONE CONSTRUCTION MUST NOT MOVE (weather build, 2026-09-22). Every new
 * launch field is spread into kernelSimOptions only when it changes the flight,
 * so what the kernel is handed for an existing design stays byte-identical
 * through the whole build. Captured from the code BEFORE step 1 changed
 * anything; any drift here re-flies every design in every user's history.
 */
describe('kernelSimOptions is byte-identical for every existing design', () => {
  it('matches the golden captured before the weather build', () => {
    expect(JSON.stringify(kernelSimOptions(DEFAULT_CONDITIONS))).toBe(
      '{"launchRodLength":1,"launchRodAngle":0,"windAverage":0,"windStdDeviation":0,'
      + '"launchAltitude":0,"launchLatitude":28.61}');
    expect(JSON.stringify(kernelSimOptions({
      ...DEFAULT_CONDITIONS, launchAltitudeM: 1219.2, temperatureC: 35, windAverage: 4, windStdDev: 1,
      launchRodAngleDeg: 5, latitudeDeg: 40.65, timeStepS: 0.02,
    }))).toBe(
      '{"launchRodLength":1,"launchRodAngle":0.08726646259971647,"windAverage":4,"windStdDeviation":1,'
      + '"launchAltitude":1219.2,"temperature":308.15,"pressure":87510.54501623093,"launchLatitude":40.65,'
      + '"timeStep":0.02}');
  });

  // Weather build, step 2: a Rod aim that leaves the flight as it was — 0,
  // the absent key of every design saved before the field, NaN, or any aim
  // with a vertical rod — hands the kernel the same bytes as the golden.
  it('is unchanged by a Rod aim that does not move the flight', () => {
    const golden = JSON.stringify(kernelSimOptions(DEFAULT_CONDITIONS));
    for (const launchRodAimDeg of [0, -0, 360, NaN, Infinity, 90, 180]) {
      // Rod angle 0 (the default): a vertical rod has no direction.
      expect(JSON.stringify(kernelSimOptions({ ...DEFAULT_CONDITIONS, launchRodAimDeg })), String(launchRodAimDeg))
        .toBe(golden);
    }
    const tilted = { ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, windAverage: 4 };
    for (const launchRodAimDeg of [0, -0, 360, -720, NaN, 1e-12]) {
      expect(JSON.stringify(kernelSimOptions({ ...tilted, launchRodAimDeg })), String(launchRodAimDeg))
        .toBe(JSON.stringify(kernelSimOptions(tilted)));
    }
  });
});

/**
 * DENSITY ALTITUDE (weather build, step 1): a readout of the air the flight
 * flies, under the two air fields it is worked out from (the grid-order test
 * below pins where). Worked numbers in services/atmosphere.test.ts.
 */
describe('the density-altitude readout', () => {
  const readout = () => host.querySelector('[data-readout="density-altitude"]');
  const shown = () => readout()?.querySelector('output');

  afterEach(() => { localStorage.clear(); });

  it('reads the site altitude, muted, when both air fields are blank', () => {
    renderConditions({});
    expect(readout(), 'the readout').toBeTruthy();
    // "0", never fmtSi's ladder "0.000".
    expect(shown()!.textContent).toBe('0');
    expect(shown()!.className).toContain('readout-muted');

    renderConditions({ launchAltitudeM: 1219.2 });
    expect(shown()!.textContent).toBe('1219');
    expect(shown()!.className).toContain('readout-muted');
    expect(shown()!.textContent).not.toMatch(/vs site/);
  });

  it('reads a hot day at a 4,000 ft field, with the difference from the site', () => {
    renderConditions({ launchAltitudeM: 1219.2, temperatureC: 35 });
    expect(shown()!.textContent).toBe('2171 (+952 vs site)');
    expect(shown()!.className).not.toContain('readout-muted');
    // The same air in feet: 7,122 ft, 3,122 above the 4,000 ft site.
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { distance: 'ft' } }));
    act(() => root.unmount());
    root = createRoot(host);
    renderConditions({ launchAltitudeM: 1219.2, temperatureC: 35 });
    expect(shown()!.textContent).toBe('7122 (+3122 vs site)');
  });

  it('goes negative, unclamped, on an altimeter setting — beside the caution that names it', () => {
    const caution = renderConditions({ launchAltitudeM: 1190, pressureHPa: 1013.25 });
    expect(caution).not.toBeNull();
    expect(shown()!.textContent).toMatch(/^-284 /);
  });

  it('is a readout, not an input, and its help reaches a screen reader', () => {
    renderConditions({});
    const out = shown()!;
    expect(readout()!.querySelector('input')).toBeNull();
    const help = host.querySelector(`#${CSS.escape(out.getAttribute('aria-describedby')!)}`);
    expect(help?.textContent).toBe(DENSITY_ALTITUDE_HELP);
    expect(help?.textContent).toMatch(/Dry air/);
    expect(host.querySelector(`#${CSS.escape(out.getAttribute('aria-labelledby')!)}`)?.textContent)
      .toMatch(/^Density altitude/);
    // Not shaped like the two field helps, which other tests find by pattern.
    expect(DENSITY_ALTITUDE_HELP).not.toMatch(/falling 6\.5|STATION pressure|^Filled in from your Site altitude/);
  });

  // The help's "roughly 110 ft, 33 m, for each °C at a 4,000 ft field", held
  // to the readout's own slope: 105.5 ft/°C on a 95 °F day, 118.6 on a
  // standard one, so 110 sits between them.
  it('moves about 110 ft per °C at a 4,000 ft field, as its help says', () => {
    expect(DENSITY_ALTITUDE_HELP).toContain('roughly 110 ft, 33 m, for each °C at a 4,000 ft field');
    const slopeFtPerC = (tC: number) => (densityAltitudeM({ launchAltitudeM: 1219.2, temperatureC: tC + 0.01, pressureHPa: null })
      - densityAltitudeM({ launchAltitudeM: 1219.2, temperatureC: tC - 0.01, pressureHPa: null })) / 0.02 / 0.3048;
    const standardC = isaTemperatureK(1219.2) - 273.15;
    expect(slopeFtPerC(35)).toBeCloseTo(105.5, 1);
    expect(slopeFtPerC(standardC)).toBeCloseTo(118.6, 1);
    expect(110).toBeGreaterThan(slopeFtPerC(35));
    expect(110).toBeLessThan(slopeFtPerC(standardC));
    expect(33 / 0.3048).toBeCloseTo(108.3, 1);
  });
});

/**
 * LONGITUDE (weather build, step 3): a new OPTIONAL field that moves no flight
 * number. Absent, cleared, non-finite and the kernel's own −80.6 all hand the
 * kernel byte-identical options (the golden above), and the box shows what a
 * blank flies rather than NaN or "0.000".
 */
describe('the longitude field', () => {
  const lonInput = () => [...host.querySelectorAll('input')]
    .find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Longitude'));

  it('hands the kernel a longitude only when it would move something', () => {
    for (const longitudeDeg of [undefined, null, NaN, -80.6]) {
      expect(kernelSimOptions({ ...DEFAULT_CONDITIONS, longitudeDeg }), String(longitudeDeg))
        .not.toHaveProperty('launchLongitude');
    }
    expect(kernelSimOptions({ ...DEFAULT_CONDITIONS, longitudeDeg: -119.355 }).launchLongitude).toBe(-119.355);
  });

  it('shows the −80.6 a blank flies, for a session that predates the field — not NaN, and no crash', () => {
    renderConditions({});
    const input = lonInput();
    expect(input, 'the Longitude input').toBeTruthy();
    expect(input!.value).toBe('');
    expect(input!.getAttribute('placeholder')).toBe('-80.6');
    renderConditions({ longitudeDeg: -119.355 });
    expect(lonInput()!.value).toBe('-119.355');
  });

  // The guard behind every OPTIONAL launch field: absent must read as blank.
  // Longitude itself cannot catch a regression here — it has no unit spec, so
  // an absent value passes through toUi as undefined and the box is blank
  // either way — but a field WITH a unit spec (the Rod aim the spec plans for
  // step 2 is one) converts undefined to NaN, which the box shows as "—".
  // Pinned on a spec'd field.
  it('renders an absent value of a field with a unit spec as blank, not "—" or NaN', () => {
    const { temperatureC: _gone, ...noTemperature } = DEFAULT_CONDITIONS;
    act(() => {
      root.render(
        <PrefsProvider>
          <LaunchField label="Temperature" field="temperatureC" value={noTemperature as LaunchConditions}
            onChange={() => {}} stepStored={1} nullable />
        </PrefsProvider>,
      );
    });
    expect(host.querySelector('input')!.value).toBe('');
  });

  it('commits null — never undefined — when the box is cleared', () => {
    renderConditions({ longitudeDeg: -119.355 });
    const input = lonInput()!;
    act(() => input.focus());
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(lastLaunch).not.toBeNull();
    expect(Object.hasOwn(lastLaunch!, 'longitudeDeg')).toBe(true);
    expect(lastLaunch!.longitudeDeg).toBeNull();
  });

  it('says which way is negative, and that it moves no flight number', () => {
    renderConditions({});
    const described = lonInput()!.getAttribute('aria-describedby');
    expect(host.querySelector(`#${CSS.escape(described!)}`)?.textContent).toBe(LONGITUDE_HELP);
    expect(LONGITUDE_HELP).toMatch(/every US site is negative/);
    expect(LONGITUDE_HELP).toMatch(/moves no flight number/);
  });

  it('sits beside Latitude in the two-column grid', () => {
    renderConditions({});
    const cells = [...host.querySelectorAll('.field-grid > *')];
    const at = (label: string) => cells.findIndex((c) => (c.querySelector('label')?.textContent ?? '').startsWith(label));
    const lat = at('Latitude');
    expect(lat % 2, 'Latitude opens a row').toBe(0);
    expect(at('Longitude')).toBe(lat + 1);
  });
});

/**
 * ☁ GET WEATHER in the panel (weather build, step 3): the button, the strip
 * that says where applied weather came from, the per-field provenance line
 * and the stale-altitude note. The dialog itself is WeatherDialog.test.tsx.
 */
describe('applied weather in the Launch panel', () => {
  const SNAP: WeatherSnapshot = {
    v: 1, provider: 'open-meteo', endpoint: 'forecast', model: 'best_match',
    place: { label: 'Gerlach, Nevada, US', latitudeDeg: 40.65157, longitudeDeg: -119.35519, method: 'search', townCentre: true },
    grid: { latitudeDeg: 40.66386, longitudeDeg: -119.35593 },
    demElevationM: 1202, forAltitudeM: 1202, timezone: 'America/Los_Angeles',
    validUnix: Date.UTC(2026, 8, 26, 21) / 1000, retrievedAt: '2026-09-22T18:00:00.000Z',
    fetched: { temperatureC: 23.3, pressureHPa: 877.2, windSpeedMs: 1.75, windGustMs: 4.6, windFromDeg: 294 },
    applied: { temperatureC: 23.3, pressureHPa: 877.2, windAverage: 1.75, launchAltitudeM: 1202 },
    before: { temperatureC: null, pressureHPa: null, windAverage: 0, launchAltitudeM: 0 },
  };
  const APPLIED: LaunchConditions = {
    ...DEFAULT_CONDITIONS, temperatureC: 23.3, pressureHPa: 877.2, windAverage: 1.75, launchAltitudeM: 1202,
  };
  let calls: string[];
  function renderWeather(value: LaunchConditions, weather: WeatherSnapshot | null, withButton = true) {
    calls = [];
    lastLaunch = null;
    act(() => {
      root.render(
        <PrefsProvider>
          <LaunchPanel value={value} onChange={(v) => { lastLaunch = v; }} onLaunch={() => {}} simulating={false}
            canLaunch weather={weather}
            onGetWeather={withButton ? () => { calls.push('get'); } : undefined}
            onWeatherUndo={() => { calls.push('undo'); }} onWeatherDismiss={() => { calls.push('dismiss'); }} />
        </PrefsProvider>,
      );
    });
  }
  const strip = () => host.querySelector('[data-weather="strip"]');
  const provenance = (field: string) => host.querySelector(`[data-provenance="${field}"]`)?.textContent ?? null;
  const btn = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

  it('offers ☁ Get weather… in the heading, greyed out offline with the reason', () => {
    renderWeather(DEFAULT_CONDITIONS, null);
    const b = host.querySelector<HTMLButtonElement>('.panel-head .weather-btn')!;
    expect(b.textContent).toBe('☁ Get weather…');
    expect(b.title).toMatch(/^Fetch one hour’s forecast/);
    act(() => b.click());
    expect(calls).toEqual(['get']);
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(b.disabled).toBe(true);
    expect(b.title).toBe('Needs a connection — the weather comes from Open-Meteo. Everything else works offline.');
    act(() => { window.dispatchEvent(new Event('online')); });
    renderWeather(DEFAULT_CONDITIONS, null, false);
    expect(host.querySelector('.weather-btn')).toBeNull();
  });

  it('says where the numbers came from, credits Open-Meteo and GeoNames, and is not a caution', () => {
    renderWeather(APPLIED, SNAP);
    expect(strip()!.getAttribute('role')).toBe('status');
    expect(strip()!.textContent).toMatch(/^Forecast for Gerlach, Nevada, US · 2:00 PM PDT, Sat 26 Sep · fetched 22 Sep/);
    const links = [...strip()!.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['https://open-meteo.com/', 'https://creativecommons.org/licenses/by/4.0/', 'https://www.geonames.org/']);
    expect(strip()!.classList.contains('field-caution')).toBe(false);
    expect(host.querySelector('.field-caution')).toBeNull();
    expect(host.querySelector('[data-weather="stale"]')).toBeNull();
  });

  it('marks each field the weather set, and what the forecast said once it is edited', () => {
    renderWeather(APPLIED, SNAP);
    expect(provenance('temperatureC')).toBe('forecast');
    expect(provenance('launchAltitudeM')).toBe('terrain model');
    expect(provenance('windStdDev')).toBeNull();
    expect(provenance('latitudeDeg')).toBeNull();
    renderWeather({ ...APPLIED, temperatureC: 30 }, SNAP);
    expect(provenance('temperatureC')).toBe('edited — forecast said 23.3 °C');
    renderWeather(APPLIED, null);
    expect(provenance('temperatureC')).toBeNull();
  });

  it('says so when the Site altitude moves under the applied air, and offers both fixes', () => {
    renderWeather({ ...APPLIED, launchAltitudeM: 1524 }, SNAP);
    const stale = host.querySelector('[data-weather="stale"]')!;
    expect(stale.textContent).toMatch(/^These came from the forecast for 1,202 m; Site altitude is now 1,524 m\./);
    act(() => btn('Fetch again')!.click());
    expect(calls).toEqual(['get']);
    act(() => btn('Clear both — standard air for 1,524 m')!.click());
    expect(lastLaunch).toMatchObject({ temperatureC: null, pressureHPa: null, launchAltitudeM: 1524, windAverage: 1.75 });
  });

  it('routes Undo and Dismiss to App', () => {
    renderWeather(APPLIED, SNAP);
    act(() => btn('Undo')!.click());
    act(() => btn('Dismiss')!.click());
    expect(calls).toEqual(['undo', 'dismiss']);
  });

  // The ERA5 archive is the weather as it was, not a forecast (spec §3.1;
  // review of 2026-09-23): nothing that names the source may say "forecast".
  it('calls an ERA5 answer a reanalysis — in the strip, the stale line, each field and the σ chip', () => {
    const ERA5: WeatherSnapshot = { ...SNAP, endpoint: 'archive', validUnix: Date.UTC(2025, 5, 14, 21) / 1000 };
    renderWeather(APPLIED, ERA5);
    expect(strip()!.textContent).toMatch(/^ERA5 reanalysis for Gerlach, Nevada, US · 2:00 PM PDT, Sat 14 Jun/);
    expect(provenance('temperatureC')).toBe('reanalysis');
    expect(provenance('windAverage')).toBe('reanalysis');
    expect(provenance('launchAltitudeM')).toBe('terrain model');
    expect(host.querySelector('.gust-estimate button')!.textContent).toBe('Estimate from reanalysis gust');
    renderWeather({ ...APPLIED, temperatureC: 30, launchAltitudeM: 1524 }, ERA5);
    expect(provenance('temperatureC')).toBe('edited — reanalysis said 23.3 °C');
    expect(host.querySelector('[data-weather="stale"]')!.textContent)
      .toMatch(/^These came from the reanalysis for 1,202 m;/);
    expect(host.querySelector('[data-weather="strip"]')!.textContent).not.toMatch(/forecast/i);
  });

  // Offline, the strip's Fetch again greys out with the same reason ☁ Get
  // weather gives: it opens the same dialog, whose every request would fail.
  it('greys out the stale line’s Fetch again offline, with the reason', () => {
    renderWeather({ ...APPLIED, launchAltitudeM: 1524 }, SNAP);
    const again = () => btn('Fetch again')! as HTMLButtonElement;
    expect(again().disabled).toBe(false);
    act(() => { window.dispatchEvent(new Event('offline')); });
    try {
      expect(again().disabled).toBe(true);
      expect(again().title).toBe('Needs a connection — the weather comes from Open-Meteo. Everything else works offline.');
      act(() => again().click());
      expect(calls).toEqual([]);
    } finally {
      act(() => { window.dispatchEvent(new Event('online')); });
    }
    expect(again().disabled).toBe(false);
  });

  // Step 4: the chip is a full-width row of the grid, right under the wind
  // pair. The grid is a fixed two columns, so σ must be a RIGHT cell (an odd
  // index) for the chip to start a clean row — a mechanism, not a warning.
  it('offers σ from the forecast gust in a full-width row right after σ, and writes it only on a click', () => {
    renderWeather(APPLIED, SNAP);
    const cells = [...host.querySelectorAll('.field-grid > *')];
    const sigma = cells.findIndex((c) => (c.querySelector('label')?.textContent ?? '').startsWith('Wind gusts σ'));
    expect(sigma % 2, 'σ is the right-hand cell').toBe(1);
    const chip = cells[sigma + 1]!;
    expect(chip.classList.contains('gust-estimate')).toBe(true);
    // 1.75 m/s gusting 4.6: (4.6 − 1.75) / 3 = 0.95.
    expect(lastLaunch).toBeNull();
    act(() => chip.querySelector<HTMLButtonElement>('button')!.click());
    expect(lastLaunch!.windStdDev).toBe(0.95);
    expect({ ...lastLaunch!, windStdDev: APPLIED.windStdDev }).toEqual(APPLIED);
  });

  // What the chip offers, what it writes and what the σ box then shows are one
  // number, and the average in its arithmetic is the Wind avg box's — in m/s
  // and in mph (review of 2026-09-23: the chip printed 0.9 and 1.8 over boxes
  // reading 0.95 and 1.75).
  it('offers the σ the box will show, and states the arithmetic in the boxes’ own digits', () => {
    const box = (label: string) => [...host.querySelectorAll('input')]
      .find((i) => (i.getAttribute('aria-label') ?? '').startsWith(label))!.value;
    const chip = () => host.querySelector('.gust-estimate')!.textContent!;
    for (const unit of ['m/s', 'mph']) {
      // A fresh root, so PrefsProvider reads the unit afresh.
      act(() => root.unmount());
      root = createRoot(host);
      localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { windspeed: unit } }));
      renderWeather(APPLIED, SNAP);
      const offered = /σ ≈ ([\d.]+) /.exec(chip())![1]!;
      act(() => host.querySelector<HTMLButtonElement>('.gust-estimate button')!.click());
      renderWeather(lastLaunch!, SNAP);
      expect(box('Wind gusts σ'), unit).toBe(offered);
      const sum = /\(([\d.]+) − ([\d.]+) \S+\)\s+÷ 3 = ([\d.]+) /.exec(chip())!;
      expect(sum[2], unit).toBe(box('Wind avg'));
      expect(sum[3], unit).toBe(offered);
    }
    localStorage.removeItem('online-openrocket.prefs.v1');
  });

  it('keeps σ a right-hand cell with no forecast too, and shows no chip then', () => {
    renderWeather(DEFAULT_CONDITIONS, null);
    const cells = [...host.querySelectorAll('.field-grid > *')];
    const sigma = cells.findIndex((c) => (c.querySelector('label')?.textContent ?? '').startsWith('Wind gusts σ'));
    expect(sigma % 2).toBe(1);
    expect(host.querySelector('.gust-estimate')).toBeNull();
  });
});

/**
 * ROD AIM (weather build, step 2): the rod's lean measured from straight into
 * the wind. It moves the flight only through `rodDirection`, and only when the
 * rod is tilted and aimed away from the wind — every other case hands the
 * kernel the golden above, byte for byte.
 */
describe('the rod-aim field', () => {
  const aimInput = () => [...host.querySelectorAll('input')]
    .find((i) => (i.getAttribute('aria-label') ?? '').startsWith('Rod aim'));

  it('normalises any angle into (−180°, 180°]', () => {
    expect(ROD_AIM_DEG_RANGE).toEqual([-180, 180]);
    expect(normalizeRodAimDeg(0)).toBe(0);
    expect(normalizeRodAimDeg(90)).toBe(90);
    expect(normalizeRodAimDeg(-90)).toBe(-90);
    expect(normalizeRodAimDeg(180)).toBe(180);
    expect(normalizeRodAimDeg(-180)).toBe(180);
    expect(normalizeRodAimDeg(540)).toBe(180);
    expect(normalizeRodAimDeg(270)).toBe(-90);
    expect(normalizeRodAimDeg(-450)).toBe(-90);
  });

  // Normalising passes through 360.1, which alone turns 0.1 into
  // 0.10000000000002274; the flight, the key and the .ork use the aim rounded
  // to 1e-9°, so it flies — and reopens as — the number typed.
  it('flies the aim as typed, not normalisation’s last-bit noise', () => {
    expect(normalizeRodAimDeg(0.1)).not.toBe(0.1);
    expect(canonicalRodAimDeg(0.1)).toBe(0.1);
    expect(canonicalRodAimDeg(33.3)).toBe(33.3);
    expect(canonicalRodAimDeg(-0.1)).toBe(-0.1);
    expect(canonicalRodAimDeg(-179.99999999999997)).toBe(180);
    expect(Object.is(canonicalRodAimDeg(-0), 0)).toBe(true);
    expect(Object.is(canonicalRodAimDeg(-1e-12), 0)).toBe(true);
    expect(canonicalRodAimDeg(NaN)).toBeNaN();
    expect(flownRodAimDeg({ launchRodAngleDeg: 5, launchRodAimDeg: 0.1 })).toBe(0.1);
    expect(kernelSimOptions({ ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, launchRodAimDeg: 0.1 }).launchRodDirection)
      .toBe(Math.PI / 2 + (0.1 * Math.PI) / 180);
  });

  it('flies an aim only when the rod is tilted and the aim is off the wind', () => {
    for (const l of [
      DEFAULT_CONDITIONS,
      { ...DEFAULT_CONDITIONS, launchRodAimDeg: 0 },
      { ...DEFAULT_CONDITIONS, launchRodAngleDeg: 0, launchRodAimDeg: 90 },
      { ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, launchRodAimDeg: NaN },
      { ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, launchRodAimDeg: 360 },
      { ...DEFAULT_CONDITIONS, launchRodAngleDeg: NaN, launchRodAimDeg: 90 },
    ]) {
      expect(flownRodAimDeg(l), JSON.stringify(l)).toBeNull();
      expect(kernelSimOptions(l), JSON.stringify(l)).not.toHaveProperty('launchRodDirection');
    }
  });

  it('hands the kernel the wind’s own direction plus the aim, in radians', () => {
    const at = (launchRodAimDeg: number) =>
      kernelSimOptions({ ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5, launchRodAimDeg }).launchRodDirection;
    expect(at(180)).toBe(Math.PI / 2 + Math.PI);
    expect(at(540)).toBe(Math.PI / 2 + Math.PI);
    expect(at(-180)).toBe(Math.PI / 2 + Math.PI);
    expect(at(90)).toBe(Math.PI / 2 + Math.PI / 2);
    expect(at(-90)).toBe(Math.PI / 2 - Math.PI / 2);
    // A negative rod angle is a real, different setting, still aimed.
    expect(kernelSimOptions({ ...DEFAULT_CONDITIONS, launchRodAngleDeg: -5, launchRodAimDeg: 90 }).launchRodDirection)
      .toBe(Math.PI);
  });

  it('shows 0 for a design saved before the field — not blank, "0.000" or NaN — and writes nothing', () => {
    renderConditions({});
    const input = aimInput();
    expect(input, 'the Rod aim input').toBeTruthy();
    expect(input!.value).toBe('0');
    expect(input!.getAttribute('aria-label')).toBe('Rod aim (°)');
    expect(lastLaunch).toBeNull();
    renderConditions({ launchRodAngleDeg: 5, launchRodAimDeg: 135 });
    expect(aimInput()!.value).toBe('135');
  });

  it('commits a typed aim in degrees, and refuses one outside ±180°', () => {
    renderConditions({ launchRodAngleDeg: 5 });
    const input = aimInput()!;
    const type = (text: string) => {
      act(() => input.focus());
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    type('-90');
    expect(lastLaunch!.launchRodAimDeg).toBe(-90);
    lastLaunch = null;
    type('200');
    expect(lastLaunch).toBeNull();
  });

  it('says what 0 means, which way is positive, and that a vertical rod ignores it', () => {
    renderConditions({});
    const described = aimInput()!.getAttribute('aria-describedby');
    expect(host.querySelector(`#${CSS.escape(described!)}`)?.textContent).toBe(ROD_AIM_HELP);
    expect(ROD_AIM_HELP).toMatch(/0° \(the default\) leans it into the wind/);
    expect(ROD_AIM_HELP).toMatch(/positive to your right as you face into the wind/);
    expect(ROD_AIM_HELP).toMatch(/only matters when Rod angle is not 0/);
    // Not shaped like the atmosphere helps, which other tests find by pattern.
    expect(ROD_AIM_HELP).not.toMatch(/falling 6\.5|STATION pressure|^Filled in from your Site altitude/);
  });

  /**
   * THE GRID ORDER (spec §0.4, decision D8). `.field-grid` is a fixed two
   * columns, so the order of its children IS the layout: Rod angle beside the
   * Rod aim it is read with, the wind pair, then Rod length beside Site
   * altitude, the air, Density altitude beside Time step, and the site's
   * coordinates last. σ must stay a RIGHT-hand cell so the gust chip's
   * full-width row under it starts clean (the weather tests pin the chip).
   */
  it('lays the panel out in the two-column order, with σ in the right-hand cell', () => {
    renderConditions({});
    const cells = [...host.querySelectorAll('.field-grid > *')];
    const order = ['Rod angle', 'Rod aim', 'Wind avg', 'Wind gusts σ', 'Rod length', 'Site altitude',
      'Temperature', 'Station pressure', 'Density altitude', 'Time step', 'Latitude', 'Longitude'];
    expect(cells.map((c) => {
      const text = c.querySelector('label')?.textContent ?? '';
      return order.find((o) => text.startsWith(o)) ?? text;
    })).toEqual(order);
    const sigma = cells.findIndex((c) => (c.querySelector('label')?.textContent ?? '').startsWith('Wind gusts σ'));
    expect(sigma % 2, 'σ is the right-hand cell').toBe(1);
  });
});
