// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { defaultTree } from './tree/treeModel.js';
import { importedSummaryRuns } from './services/orkFlightData.js';
import { openPrintDocument } from './services/printDocument.js';
import { INITIAL_UNITS, IMPERIAL_UNITS } from './prefs/units.js';

vi.mock('./services/printDocument.js', async original => ({
  ...await original<typeof import('./services/printDocument.js')>(), openPrintDocument: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div'); document.body.append(host);
const root = createRoot(host);
afterEach(async () => { await act(async () => root.render(null)); localStorage.clear(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it.each([false, true])('C-A6 prints the inspected row, rather than the newest row, with imperial/sun=%s', async imperial => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true, daylight: imperial,
    units: imperial ? IMPERIAL_UNITS : INITIAL_UNITS }));
  localStorage.setItem('online-openrocket.workspace.v1', 'results');
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: defaultTree(), launch: DEFAULT_CONDITIONS,
    savedConfigs: [], mountMotors: {}, savedAt: Date.now(), configLayers: 1, emptyConfigVersion: 1 }));
  const runs = importedSummaryRuns({ name: 'Imported file', configs: [], storedSimulations: [
    { name: 'Newer', configId: null, windAverage: 0, data: { maxAltitude: 91.44 } },
    { name: 'Selected older', configId: null, windAverage: 0, data: { maxAltitude: 304.8 } },
  ] });
  localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify(runs));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  const historyHeader = [...host.querySelectorAll('h2')].find(h => h.textContent!.startsWith('Saved simulations'))!.parentElement!;
  const show = [...historyHeader.querySelectorAll('button')].find(b => b.textContent === 'Show')!;
  await act(async () => show.click());
  const row = [...host.querySelectorAll<HTMLTableRowElement>('tr[title="Click to open this run in the launch report"]')]
    .find(r => r.textContent!.includes(imperial ? '1000' : '305'));
  expect(row).toBeDefined();
  await act(async () => row!.click());
  const print = [...host.querySelectorAll('button')].find(b => b.textContent!.startsWith('Print design / flight report'))!;
  expect(print).toBeDefined();
  await act(async () => print.click());
  const html = vi.mocked(openPrintDocument).mock.calls[0]![0];
  const report = new DOMParser().parseFromString(html, 'text/html').body.textContent;
  expect(report).toContain(`Run ID: ${runs[1]!.id}`);
  expect(report).not.toContain(`Run ID: ${runs[0]!.id}`);
  expect(report).toContain(imperial ? 'Apogee: 1000 ft' : 'Apogee: 305 m');
  expect(report).toContain('Imported summary');
  expect(localStorage.getItem('online-openrocket.sim-runs.v1')).toBe(JSON.stringify(runs));
}, 15000);
