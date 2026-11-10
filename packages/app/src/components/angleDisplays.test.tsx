// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { fmtFieldValue } from '../prefs/units.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { RollControl } from './RollControl.js';
import { LaunchCompass } from './LaunchCompass.js';
import { WindProfileTable } from './WindProfile.js';
import type { LaunchConditions } from './LaunchPanel.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('uses radians for view roll, relative rod lean and wind direction, retaining compass degrees', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { angle: 'rad' } }));
  const host = document.createElement('div'), root = createRoot(host);
  try {
    act(() => root.render(<PrefsProvider>
      <RollControl roll={Math.PI / 2} onRoll={() => {}} />
      <LaunchCompass value={{ launchRodAngleDeg: 5, launchRodAimDeg: 90 } as LaunchConditions} weatherFromDeg={90} />
      <WindProfileTable levels={[{ altitude: 100, speed: 10, direction: Math.PI / 2 }]} surfaceFromDeg={90} />
    </PrefsProvider>));
    expect.soft(host.querySelector('.roll-reset')!.textContent).toBe('1.6');
    expect.soft(host.querySelector('input')!.getAttribute('aria-valuetext')).toBe('1.571 rad');
    expect.soft(host.querySelector('[data-launch-compass]')!.textContent).toContain(`Rod lean ${fmtFieldValue(Math.PI / 2, 'auto')} rad clockwise relative to wind`);
    expect(host.textContent).toContain('Weather wind from 90°');
    const cells = host.querySelectorAll('tbody td');
    expect.soft(cells[2]!.textContent).toBe('1.571 rad');
    expect(cells[3]!.textContent).toContain('180.0°');
  } finally { act(() => root.unmount()); localStorage.clear(); }
});

it.each([
  ['auto', 12.345], [3, 12.345], [4, 12.345],
  ['auto', 33.3335], [3, 33.3335], [4, 33.3335],
] as const)('preserves rod-aim field precision %s at %s in both angle units', (fieldPrecision, aim) => {
  const host = document.createElement('div');
  for (const angle of ['°', 'rad']) {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { angle }, fieldPrecision }));
    const root = createRoot(host);
    try {
      act(() => root.render(<PrefsProvider><LaunchCompass value={{ launchRodAngleDeg: 5, launchRodAimDeg: aim } as LaunchConditions} /></PrefsProvider>));
      const value = angle === '°' ? aim : aim * Math.PI / 180;
      expect.soft(host.textContent).toContain(`Rod lean ${fmtFieldValue(value, fieldPrecision)}${angle === '°' ? '' : ' '}${angle} clockwise`);
    } finally { act(() => root.unmount()); localStorage.clear(); }
  }
});

it('fits the negative radian endpoint in the reset button and keeps the full value accessible', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { angle: 'rad' } }));
  const host = document.createElement('div'), root = createRoot(host);
  try {
    act(() => root.render(<PrefsProvider><RollControl roll={-Math.PI} onRoll={() => {}} /></PrefsProvider>));
    const button = host.querySelector('button')!;
    expect.soft(button.textContent).toBe('-3.1');
    expect.soft(button.style.fontSize).toBe('9px');
    expect.soft(button.style.whiteSpace).toBe('nowrap');
    expect.soft(button.title).toContain('-3.142 rad');
    expect(button.getAttribute('aria-label')).toContain('-3.142 rad');
  } finally { act(() => root.unmount()); localStorage.clear(); }
});

it.each(['vertical', 'horizontal'] as const)('distinguishes small nonzero radian rolls from zero (%s)', orientation => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { angle: 'rad' } }));
  const host = document.createElement('div'), root = createRoot(host);
  try {
    for (const degrees of [0, 1, 2, 3, 8, -1, -2, -8, 180, -180, 1e-25]) {
      const roll = degrees * Math.PI / 180;
      act(() => root.render(<PrefsProvider><RollControl roll={roll} orientation={orientation} onRoll={() => {}} /></PrefsProvider>));
      const button = host.querySelector('button')!;
      const label = button.textContent!;
      if (roll === 0) expect.soft(label).toBe('0');
      else {
        expect.soft(Number(label)).not.toBe(0);
        expect.soft(Math.abs((Number(label) - roll) / roll)).toBeLessThan(0.05);
      }
      expect.soft(button.style.fontSize).toBe('9px');
      expect.soft(button.style.letterSpacing).toBe('-0.6px');
      // IBM Plex Mono's advance, explicit tracking, and existing padding/border.
      const lines = button.querySelectorAll('span');
      const labels = lines.length ? [...lines].map(line => line.textContent!) : [label];
      for (const line of labels) {
        expect.soft(line.length * 9 * 0.6 - Math.max(0, line.length - 1) * 0.6 + 4).toBeLessThanOrEqual(24);
      }
      expect.soft(labels.length * 9 + 6).toBeLessThanOrEqual(24);
    }
  } finally { act(() => root.unmount()); localStorage.clear(); }
});

it.each([1.6, 12])('preserves the original degree reset at %s degrees', degrees => {
  localStorage.clear();
  const host = document.createElement('div'), root = createRoot(host);
  try {
    act(() => root.render(<PrefsProvider><RollControl roll={degrees * Math.PI / 180} onRoll={() => {}} /></PrefsProvider>));
    expect(host.querySelector('button')!.textContent).toBe(`${Math.round(degrees)}°`);
    expect(host.querySelector('button')!.getAttribute('style')).toBeNull();
    expect(host.querySelector('button')!.title).toBe("Roll the view about the rocket's long axis — click to return to the design's own angles");
    expect(host.querySelector('button')!.getAttribute('aria-label')).toBe(`${Math.round(degrees)}° view roll — reset to the design's own angles`);
  } finally { act(() => root.unmount()); }
});
