// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { GustEstimate } from './GustEstimate.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from './LaunchPanel.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The gust-to-σ chip (weather build, step 4): offered, labelled, and never
 * written without a click. The worked pair is mean 5 m/s, gust 11 m/s →
 * σ 2 m/s, intensity 40 % (convective).
 */

let host: HTMLDivElement;
let root: Root;
let changes: LaunchConditions[];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  changes = [];
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
});

const FIVE: LaunchConditions = { ...DEFAULT_CONDITIONS, windAverage: 5, windStdDev: 0 };

function render(value: LaunchConditions, forecastWind: { meanMs: number; gustMs: number } | null = { meanMs: 5, gustMs: 11 }) {
  act(() => {
    root.render(
      <PrefsProvider>
        <GustEstimate value={value} onChange={(v) => { changes.push(v); }} forecastWind={forecastWind} />
      </PrefsProvider>,
    );
  });
}
const chip = () => host.querySelector('.gust-estimate');
const button = () => host.querySelector<HTMLButtonElement>('.gust-estimate button');
const text = () => chip()?.textContent ?? '';

describe('the gust-to-σ chip', () => {
  it('writes nothing by rendering', () => {
    render(FIVE);
    expect(chip()).toBeTruthy();
    expect(changes).toHaveLength(0);
  });

  it('is absent with no forecast, and with a gust that is not above the mean', () => {
    render(FIVE, null);
    expect(chip()).toBeNull();
    render(FIVE, { meanMs: 5, gustMs: 5 });
    expect(chip()).toBeNull();
    render(FIVE, { meanMs: 5, gustMs: 5.1 });
    expect(chip()).toBeNull();
  });

  it('offers σ, and one click writes it — and nothing else', () => {
    render({ ...FIVE, windStdDev: 0.7 });
    expect(text()).toMatch(/^Estimate from forecast gustσ ≈ 2 m\/s from an 11 m\/s gust\./);
    expect(button()!.title).toBe('Works out σ from the forecast’s gust and average wind. Nothing changes until you click.');
    expect(button()!.getAttribute('aria-describedby')).toBe(host.querySelector('.gust-estimate [role="status"]')!.id);
    act(() => button()!.click());
    expect(changes).toHaveLength(1);
    expect(changes[0]!.windStdDev).toBe(2);
    const { windStdDev: _a, ...rest } = changes[0]!;
    const { windStdDev: _b, ...before } = { ...FIVE, windStdDev: 0.7 };
    expect(rest).toEqual(before);
  });

  it('once applied, says it is an estimate, how it was worked out, and warns on a convective gust', () => {
    render({ ...FIVE, windStdDev: 2 });
    expect(button()).toBeNull();
    expect(text()).toMatch(/^Wind gusts σ is an estimate from the forecast: \(11 − 5 m\/s\)\s+÷ 3 = 2 m\/s, taking 11 m\/s as the hour’s strongest 3-second gust\./);
    expect(text()).toContain('Good to about ±25 %.');
    expect(text()).toContain('(σ is 40 % of it)');
    expect(chip()!.classList.contains('gust-estimate-warn')).toBe(true);
    expect(chip()!.getAttribute('data-caution')).toBe('gust-convective');
    expect(chip()!.classList.contains('field-caution')).toBe(false);
  });

  it('offers again once σ is edited away from the estimate', () => {
    render({ ...FIVE, windStdDev: 1.7 });
    expect(button()).toBeTruthy();
    expect(text()).not.toMatch(/estimate from the forecast/);
  });

  it('says so when Wind avg moves after applying — and never rescales σ', () => {
    render({ ...FIVE, windAverage: 3, windStdDev: 2 });
    expect(button()).toBeNull();
    expect(text()).toBe('Wind gusts σ, 2 m/s, was estimated against the forecast’s 5 m/s average; Wind avg now reads 3 m/s.');
    expect(chip()!.classList.contains('gust-estimate-muted')).toBe(true);
    expect(changes).toHaveLength(0);
    // Edited away from BOTH: nothing to say.
    render({ ...FIVE, windAverage: 3, windStdDev: 1 });
    expect(chip()).toBeNull();
  });

  it('reads in mph, and still stores σ in m/s exactly', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { windspeed: 'mph' } }));
    render(FIVE);
    expect(text()).toContain('σ ≈ 4.5 mph from a 24.6 mph gust.');
    act(() => button()!.click());
    expect(changes[0]!.windStdDev).toBe(2);
    render({ ...FIVE, windStdDev: 2 });
    expect(text()).toMatch(/\(24\.6 − 11\.2 mph\)\s+÷ 3 = 4\.5 mph/);
  });

  it('says when σ was capped at the average, and gives no convective warning at exactly 30 %', () => {
    render({ ...FIVE, windAverage: 1 }, { meanMs: 1, gustMs: 6 });
    expect(text()).toContain('Capped at the average wind, the most desktop OpenRocket’s panel allows.');
    render(FIVE, { meanMs: 5, gustMs: 9.5 });
    expect(text()).toContain('σ ≈ 1.5 m/s');
    expect(text()).not.toMatch(/far above the average/);
    expect(chip()!.classList.contains('gust-estimate-warn')).toBe(false);
  });
});
