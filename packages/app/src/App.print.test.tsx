// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { defaultTree, motorMounts } from './tree/treeModel.js';
import type { MountMotor } from './model/design.js';
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

it.each([false, true])('prints omitted and installed assignments for a partially refused loadout=%s', async partial => {
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!;
  mount.name = 'Refused mount';
  const motor: MountMotor = { label: 'C6-5', meta: { label: 'C6-5', manufacturer: 'Estes' },
    ignition: { event: 'automatic', delay: 0 }, spec: { designation: 'C6', diameter: 0.018,
      length: 0.07, cgX: 0.035, ejectionDelay: 5, times: [0, 0.2, 1.8],
      thrusts: [0, 14, 0], masses: [0.024, 0.02, 0.0122] } };
  const mountMotors: Record<string, MountMotor> = {
    [mount.id!]: { ...motor, spec: { ...motor.spec, thrusts: [0, 14] } },
  };
  if (partial) {
    const accepted = { ...mount, id: 'accepted-print-mount', name: 'Accepted mount' };
    const parent = tree.components[0]!.children!.find(n => n.children?.includes(mount))!;
    parent.children!.push(accepted);
    mountMotors[accepted.id] = motor;
  }
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true, daylight: partial }));
  localStorage.setItem('online-openrocket.workspace.v1', 'results');
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree, launch: DEFAULT_CONDITIONS,
    savedConfigs: [], mountMotors, savedAt: Date.now(), configLayers: 1, emptyConfigVersion: 1 }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  const print = [...host.querySelectorAll('button')].find(b => b.textContent!.startsWith('Print design / flight report'))!;
  await act(async () => print.click());
  const d = new DOMParser().parseFromString(vi.mocked(openPrintDocument).mock.calls[0]![0], 'text/html').body;
  expect(d.textContent).toContain('No flight selected');
  expect(d.textContent).not.toContain('Launch mass');
  expect(d.textContent).not.toMatch(/CG \d|margin \d/);
  expect(d.querySelector('.caution')?.textContent).toContain('Refused mount');
  expect(d.textContent).toContain('Array lengths do not match');
  const loadout = [...d.querySelectorAll('p')].find(p => p.textContent!.startsWith('Current configuration'))!;
  expect(loadout.textContent).toContain('Refused mount: C6-5 ×1 (omitted from build)');
  if (partial) expect(loadout.textContent).toContain('Accepted mount: C6-5 ×1 (installed in build)');
  expect(loadout.nextElementSibling?.textContent).toContain('Refused mount');
}, 15000);
