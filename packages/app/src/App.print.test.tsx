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
import type { OrkMotorRef } from './services/orkFile.js';
import * as reportComposer from './services/designPrintReport.js';
import { flushSession } from './services/session.js';

vi.mock('./services/printDocument.js', async original => ({
  ...await original<typeof import('./services/printDocument.js')>(), openPrintDocument: vi.fn(),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const host = document.createElement('div'); document.body.append(host);
const root = createRoot(host);

it.each(['constructor', 'toString', '__proto__'].flatMap(id => [true, false, 'unload' as const].map(stored => [id, stored] as const)))(
  'does not print an inherited unresolved motor for %s, refs stored=%s', async (id, stored) => {
  const tree = defaultTree();
  motorMounts(tree)[0]!.id = id;
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  localStorage.setItem('online-openrocket.workspace.v1', 'results');
  const motor: MountMotor = { label: 'C6-5', meta: { label: 'C6-5', manufacturer: 'Estes' },
    ignition: { event: 'automatic', delay: 0 }, spec: { designation: 'C6', diameter: 0.018,
      length: 0.07, cgX: 0.035, ejectionDelay: 5, times: [0, 0.2, 1.8],
      thrusts: [0, 14, 0], masses: [0.024, 0.02, 0.0122] } };
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree, launch: DEFAULT_CONDITIONS,
    savedConfigs: [], mountMotors: stored === 'unload' ? { [id]: motor } : {},
    ...(stored ? { unmatchedRefs: {} } : {}), savedAt: Date.now(), configLayers: 1, emptyConfigVersion: 1 }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  if (stored === 'unload') {
    const unload = [...host.querySelectorAll('button')].find(b => b.textContent === '⏏ Unload')!;
    expect(unload).toBeDefined();
    await act(async () => unload.click());
  }
  const print = [...host.querySelectorAll('button')].find(b => b.textContent!.startsWith('Print design / flight report'))!;
  await act(async () => print.click());
  const html = vi.mocked(openPrintDocument).mock.calls[0]![0];
  expect(html).not.toContain('Unresolved imported motor');
});
it.each(['constructor', 'toString', '__proto__'])('renders an unloaded restored mount %s on Motors & Configuration', async id => {
  const tree = defaultTree();
  motorMounts(tree)[0]!.id = id;
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  localStorage.setItem('online-openrocket.workspace.v1', 'motors');
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree, launch: DEFAULT_CONDITIONS,
    savedConfigs: [], mountMotors: {}, savedAt: Date.now(), configLayers: 1, emptyConfigVersion: 1 }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  expect(host.textContent).toContain('— no motor —');
});
afterEach(async () => { await act(async () => root.render(null)); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetAllMocks(); });

it.each([false, true])('C-A6 prints the inspected row, rather than the newest row, with imperial/sun=%s', async imperial => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true, daylight: imperial,
    units: imperial ? IMPERIAL_UNITS : INITIAL_UNITS }));
  localStorage.setItem('online-openrocket.workspace.v1', 'results');
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: defaultTree(), launch: DEFAULT_CONDITIONS,
    savedConfigs: [], mountMotors: {}, savedAt: Date.now(), configLayers: 1, emptyConfigVersion: 1 }));
  const runs = importedSummaryRuns({ name: 'Imported file', configs: [], storedSimulations: [
    { name: 'Newer', configId: null, data: { maxAltitude: 91.44 } },
    { name: 'Selected older', configId: null, data: { maxAltitude: 304.8 } },
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

it.each([
  [false, false], [true, false], [false, true], [true, true],
])('prints unresolved imported motors after restoring partial=%s, saved configuration=%s', async (partial, saved) => {
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!;
  mount.name = 'Unresolved <mount>';
  const ref: OrkMotorRef = { designation: 'EX-H999', manufacturer: 'Recorded <maker>',
    diameter: 0.018, length: 0.07, delay: 5, digest: 'file-motor-digest' };
  const refs = { [mount.id!]: ref,
    'removed-print-mount': { ...ref, designation: 'Removed-reference' } };
  const mountMotors: Record<string, MountMotor> = {};
  if (partial) {
    const accepted = { ...mount, id: 'accepted-print-mount', name: 'Accepted mount' };
    const parent = tree.components[0]!.children!.find(n => n.children?.includes(mount))!;
    parent.children!.push(accepted);
    mountMotors[accepted.id] = { label: 'C6-5', meta: { label: 'C6-5', manufacturer: 'Estes' },
      ignition: { event: 'automatic', delay: 0 }, spec: { designation: 'C6', diameter: 0.018,
        length: 0.07, cgX: 0.035, ejectionDelay: 5, times: [0, 0.2, 1.8],
        thrusts: [0, 14, 0], masses: [0.024, 0.02, 0.0122] } };
  }
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true, daylight: partial }));
  localStorage.setItem('online-openrocket.workspace.v1', 'results');
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree, launch: DEFAULT_CONDITIONS,
    savedConfigs: saved ? [{ id: 'imported', name: 'Imported loadout', isDefault: true,
      motors: mountMotors, unmatchedRefs: refs }] : [],
    activeConfigId: saved ? 'imported' : null,
    // Legacy sessions recover refs from the active configuration; working sessions carry them directly.
    ...(saved ? {} : { unmatchedRefs: refs }),
    mountMotors, savedAt: Date.now(), configLayers: 1, emptyConfigVersion: 1 }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  const session = localStorage.getItem('online-openrocket.session.v1');
  const print = [...host.querySelectorAll('button')].find(b => b.textContent!.startsWith('Print design / flight report'))!;
  await act(async () => print.click());
  const d = new DOMParser().parseFromString(vi.mocked(openPrintDocument).mock.calls[0]![0], 'text/html').body;
  expect(d.textContent).toContain('No flight selected');
  expect(d.textContent).toContain('loaded mass for the complete assigned loadout: Unknown');
  expect(d.textContent).toContain('CG, CP and stability for the complete assigned loadout: Unknown');
  expect(d.textContent).not.toMatch(/Launch mass|CG \d|margin \d/);
  expect(d.querySelector('.caution')?.textContent).toContain('Unresolved <mount>');
  expect(d.querySelector('.caution')?.textContent).toContain(mount.id!);
  expect(d.querySelector('.caution')?.textContent).toContain('more mass and less stability margin');
  const loadout = [...d.querySelectorAll('p')].find(p => p.textContent!.startsWith('Current configuration'))!;
  expect(loadout.textContent).toContain('Unresolved <mount>: Recorded <maker> EX-H999 ×1 (unresolved; omitted from build)');
  expect(loadout.textContent).not.toContain('no motor assigned');
  expect(loadout.nextElementSibling?.textContent).toContain('EX-H999');
  expect(d.textContent).not.toContain('Removed-reference');
  expect(d.querySelector('maker')).toBeNull();
  if (partial) expect(loadout.textContent).toContain('Accepted mount: C6-5 ×1 (installed in build)');
  if (saved) expect(loadout.textContent).toContain('Imported loadout');
  expect(localStorage.getItem('online-openrocket.session.v1')).toBe(session);
}, 15000);

it('ignores unresolved references whose mounts are no longer in the design', async () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  localStorage.setItem('online-openrocket.workspace.v1', 'results');
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: defaultTree(), launch: DEFAULT_CONDITIONS,
    unmatchedRefs: { removed: { designation: 'Removed-reference', manufacturer: 'EX', diameter: 0.018, length: 0.07, delay: 5 } },
    savedConfigs: [], mountMotors: {}, savedAt: Date.now(), configLayers: 1, emptyConfigVersion: 1 }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  const print = [...host.querySelectorAll('button')].find(b => b.textContent!.startsWith('Print design / flight report'))!;
  await act(async () => print.click());
  const d = new DOMParser().parseFromString(vi.mocked(openPrintDocument).mock.calls[0]![0], 'text/html').body;
  expect(d.textContent).toContain('no motors loaded');
  expect(d.textContent).not.toContain('Removed-reference');
  expect(d.querySelector('.caution')).toBeNull();
}, 15000);

it.each(['preview', 'preparation'] as const)('keeps the export-menu %s error visible and permits a successful retry', async failure => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true, daylight: true }));
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: defaultTree(), launch: DEFAULT_CONDITIONS,
    savedConfigs: [], mountMotors: {}, savedAt: Date.now(), configLayers: 1, emptyConfigVersion: 1 }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  // The initial restore schedules a real autosave; finish it before measuring
  // whether either print attempt changes the persisted session.
  act(() => flushSession());
  const session = localStorage.getItem('online-openrocket.session.v1');
  // Exercise the autosave window even when the machine runs this test quickly.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
  const exportButton = [...host.querySelectorAll('button')].find(b => b.textContent!.includes('Save As / Export'))!;
  await act(async () => exportButton.click());
  const menu = host.querySelector('[role="group"][aria-label="Save As / Export"]')!;
  const print = [...menu.querySelectorAll('button')].find(b => b.textContent!.startsWith('Print design / flight report'))!;
  print.focus();
  expect(document.activeElement).toBe(print);
  if (failure === 'preview') {
    const real = await vi.importActual<typeof import('./services/printDocument.js')>('./services/printDocument.js');
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.mocked(openPrintDocument).mockImplementationOnce(real.openPrintDocument);
  } else {
    vi.spyOn(reportComposer, 'designPrintHtml').mockImplementationOnce(() => { throw new Error('Cannot prepare report'); });
  }
  await act(async () => print.click());
  const stillOpen = host.querySelector('[role="group"][aria-label="Save As / Export"]');
  const alert = stillOpen?.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain('Caution: Could not open the report:');
  expect(alert?.textContent).toContain(failure === 'preview' ? 'Allow pop-ups for the app, then try again.' : 'Cannot prepare report');
  expect(exportButton.getAttribute('aria-expanded')).toBe('true');
  expect(localStorage.getItem('online-openrocket.session.v1')).toBe(session);
  await act(async () => print.click());
  expect(host.querySelector('[role="group"][aria-label="Save As / Export"]')).toBeNull();
  expect(exportButton.getAttribute('aria-expanded')).toBe('false');
  expect(localStorage.getItem('online-openrocket.session.v1')).toBe(session);
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
