// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { SimRun } from '../services/simReport.js';
import { FlightLoadStats } from './FlightLoadStats.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('shows the flight window, both angle units, sample details and unavailable old runs', () => {
  localStorage.clear();
  const host = document.createElement('div'), root = createRoot(host);
  const peak = { value: 2000, time: 2, altitude: 100, mach: 0.5, aoa: 0.1 };
  const run = { when: 0, loads: { maxQ: peak, maxQAlpha: { ...peak, value: 200 } } } as SimRun;
  try {
    act(() => root.render(<PrefsProvider><FlightLoadStats run={run} /></PrefsProvider>));
    expect(host.textContent).toContain('20 mbar at 2.000 s; 100 m AGL');
    expect(host.textContent).toContain('2 mbar·rad (114.592 mbar·°)');
    expect(host.textContent).toContain('Mach 0.500; α 0.1000 rad (5.73°)');
    expect(host.textContent).toContain('stopping before recovery deployment');
    expect(host.textContent).toContain('not a loads check');
    act(() => root.render(<PrefsProvider><FlightLoadStats run={{ ...run,
      loads: { maxQ: peak, maxQAlpha: { ...peak, value: 0.001 } } }} /></PrefsProvider>));
    expect(host.textContent).toContain('0.00001 mbar·rad');
    act(() => root.render(<PrefsProvider><FlightLoadStats run={{ when: 0 } as SimRun} /></PrefsProvider>));
    expect(host.textContent).toContain('Unavailable');
    expect(host.textContent).not.toContain('20 mbar');
  } finally { act(() => root.unmount()); localStorage.clear(); }
});
