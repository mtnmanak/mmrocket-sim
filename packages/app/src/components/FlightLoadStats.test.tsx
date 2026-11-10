// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { SimRun } from '../services/simReport.js';
import { FlightLoadStats } from './FlightLoadStats.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('shows the flight window, preferred angle unit, sample details and unavailable old runs', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { altitude: 'ft', distance: 'km' } }));
  const host = document.createElement('div'), root = createRoot(host);
  const peak = { value: 2000, time: 2, altitude: 100, mach: 0.5, aoa: 0.1 };
  const run = { when: 0, loads: { maxQ: peak, maxQAlpha: { ...peak, value: 200 } } } as SimRun;
  try {
    act(() => root.render(<PrefsProvider><FlightLoadStats run={run} /></PrefsProvider>));
    expect(host.textContent).toContain('20 mbar at 2.000 s; 328 ft AGL');
    expect(host.textContent).toContain('114.592 mbar·°');
    expect(host.textContent).toContain('Mach 0.500; α 5.7°');
    expect(host.textContent).toContain('stopping before recovery deployment');
    expect(host.textContent).toContain('not a loads check');
    // D7 §5, R28: the scope statement precedes the first value.
    const scope = host.querySelector('.flight-loads-scope')!;
    expect(scope.textContent).toMatch(/^Inputs to a structural check; no structural verdict\./);
    expect(scope.compareDocumentPosition(host.querySelector('table')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => root.render(<PrefsProvider><FlightLoadStats run={{ ...run,
      loads: { maxQ: peak, maxQAlpha: { ...peak, value: 0.001 } } }} /></PrefsProvider>));
    expect(host.textContent).toContain('0.000573 mbar·°');
    act(() => root.render(<PrefsProvider><FlightLoadStats run={{ when: 0 } as SimRun} /></PrefsProvider>));
    expect(host.textContent).toContain('Unavailable');
    expect(host.textContent).not.toContain('20 mbar');
  } finally { act(() => root.unmount()); localStorage.clear(); }
});

it('uses radians for alpha and the angle factor of q·alpha', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { angle: 'rad', pressure: 'Pa' } }));
  const host = document.createElement('div'), root = createRoot(host);
  const peak = { value: 200, time: 2, altitude: 100, mach: 0.5, aoa: 0.1 };
  try {
    act(() => root.render(<PrefsProvider><FlightLoadStats run={{ when: 0, loads: { maxQAlpha: peak } } as SimRun} /></PrefsProvider>));
    expect(host.textContent).toContain('200 Pa·rad at');
    expect(host.textContent).toContain('Mach 0.500; α 0.1 rad');
    expect(host.textContent).not.toContain('°');
  } finally { act(() => root.unmount()); localStorage.clear(); }
});
