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
    expect(text).toMatch(new RegExp(`${timeStepCostFactor(0.01).toFixed(1)}×`));
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
