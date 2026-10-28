// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { FlightDataBundleDialog } from './FlightDataBundleDialog.js';
import { defaultTree } from '../tree/treeModel.js';
import { DEFAULT_CONDITIONS } from '../services/launchConditions.js';
import type { SimRun } from '../services/simReport.js';
import { saveFile } from '../services/saveFile.js';
import { runExportContext } from '../services/runExportContext.js';
import { LOCALE_DECIMAL_COMMA } from '../prefs/units.js';
import { loadRuns } from '../services/simStore.js';
vi.mock('../services/saveFile.js', () => ({ saveFile: vi.fn(async () => ({ kind: 'cancelled' })) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); vi.clearAllMocks(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const source = () => ({ design: { name: 'Test', tree: defaultTree(), launch: { ...DEFAULT_CONDITIONS, latitudeDeg: 61.234567 } },
  run: { id: 'chosen', rocket: 'Chosen run', motor: 'C6', manufacturer: 'Estes', when: 1000, comments: '',
    maxAltitude: 100, maxVelocity: 20, maxMach: 0.1, maxAcceleration: 30, windAvg: 0 } as SimRun,
  changedSince: ['the design'],
});
const click = (text: string) => act(async () => { Array.from(host.querySelectorAll('button')).find(b => b.textContent === text)!.click(); });
const fill = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
it('updates an established status region while reading an attachment', async () => {
  act(() => root.render(<FlightDataBundleDialog source={source()} onClose={() => {}} />));
  const regions = new Set(host.querySelectorAll('[role="status"]'));
  const file = new File(['test'], 'log.csv');
  let release!: (v: ArrayBuffer) => void;
  Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(resolve => { release = resolve; }) });
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  const reading = [...host.querySelectorAll('[role="status"]')].find(el => el.textContent?.includes('Reading'))!;
  expect(regions.has(reading)).toBe(true);
  await act(async () => { release(new ArrayBuffer(0)); });
});

it.each(['run', 'summary', 'design'] as const)('credits profile-only weather in the %s with place credit governed by consent', location => {
  const x = source();
  const launch = { ...x.design.launch, windLevels: [{ altitude: 0, speed: 3, direction: 0 }],
    windProfileSource: { kind: 'open-meteo' as const, place: 'Test site', method: 'search' as const,
      validUnix: 1700000000, surfaceFromDeg: 20 } };
  act(() => root.render(<FlightDataBundleDialog source={{ ...x,
    ...(location === 'run' ? { run: { ...x.run, exportContext: runExportContext(launch) } }
      : location === 'summary' ? { run: { ...x.run, windLevels: launch.windLevels, windProfileSource: launch.windProfileSource } }
      : { design: { ...x.design, launch } }),
  }} onClose={() => {}} />));
  const credit = () => host.querySelector('a[href="https://open-meteo.com/"]');
  const places = () => host.querySelector('a[href="https://www.geonames.org/"]');
  expect(credit()).not.toBeNull();
  expect(places()).toBeNull();
  act(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  expect(credit()).not.toBeNull();
  expect(places()).not.toBeNull();
});

it('previews exact members, defaults coordinates off and exports the selected row without sending anything', async () => {
  const close = vi.fn();
  act(() => root.render(<FlightDataBundleDialog source={source()} onClose={close} />));
  expect(host.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
  expect(host.textContent).toContain('design changed');
  expect(host.textContent).toContain('not recorded');
  expect(host.querySelectorAll('details')).toHaveLength(6);
  await click('Download ZIP');
  const [blob, options] = vi.mocked(saveFile).mock.calls[0]!;
  expect(options.suggestedName).toBe('Test-flight-data-bundle.zip');
  const files = unzipSync(new Uint8Array(await (blob as Blob).arrayBuffer()));
  expect(Object.values(files).map(f => strFromU8(f)).join('\n')).not.toContain('61.234567');
  expect(JSON.parse(strFromU8(files['run.json']!)).id).toBe('chosen');
  expect(close).not.toHaveBeenCalled(); // cancelled picker preserves the form
  await act(async () => { host.querySelector('[role=dialog]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  expect(close).toHaveBeenCalledTimes(1);
});

it('keeps failed save errors in the dialog and accepts missing measurements as unknown', async () => {
  vi.mocked(saveFile).mockRejectedValueOnce(new Error('Disk unavailable'));
  act(() => root.render(<FlightDataBundleDialog source={source()} onClose={() => {}} />));
  await click('Download ZIP');
  expect(host.querySelector('[role=alert]')!.textContent).toContain('Disk unavailable');
  expect(host.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled).toBe(false);
});

it('requires correction for invalid measurements while keeping the preview mounted, and accepts comma-decimal SI values and explicit coordinate consent', async () => {
  act(() => root.render(<FlightDataBundleDialog source={source()} onClose={() => {}} />));
  const apogee = [...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('Measured apogee'))!.control as HTMLInputElement;
  fill(apogee, '-2');
  expect(host.querySelectorAll('details')).toHaveLength(6);
  expect(host.textContent).not.toContain('Preview unavailable');
  await click('Download ZIP');
  expect(saveFile).not.toHaveBeenCalled();
  expect(apogee.getAttribute('aria-invalid')).toBe('true');
  expect(document.activeElement).toBe(apogee);
  fill(apogee, '.');
  expect(host.querySelectorAll('details')).toHaveLength(6);
  expect(apogee.getAttribute('aria-invalid')).toBe('true');
  fill(apogee, '111,5');
  expect(apogee.getAttribute('aria-invalid')).toBe('false');
  act(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  await click('Download ZIP');
  const files = unzipSync(new Uint8Array(await (vi.mocked(saveFile).mock.calls[0]![0] as Blob).arrayBuffer()));
  expect(JSON.parse(strFromU8(files['measurements.json']!)).apogeeM).toBe(111.5);
  expect(strFromU8(files['design.ork']!)).toContain('<launchlatitude>61.234567</launchlatitude>');
});

it('explains ambiguous separators at the field and after a refused download', async () => {
  act(() => root.render(<FlightDataBundleDialog source={source()} onClose={() => {}} />));
  const mass = [...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('As-flown liftoff mass'))!.control as HTMLInputElement;
  fill(mass, LOCALE_DECIMAL_COMMA ? '1.234' : '1,500');
  expect(mass.getAttribute('aria-invalid')).toBe('true');
  expect(host.querySelector('#bundle-number-error')!.textContent).toContain('without thousands separators');
  expect(host.querySelector('#bundle-number-error')!.textContent).toContain('1.5 or 1,5');
  await click('Download ZIP');
  expect(saveFile).not.toHaveBeenCalled();
  expect(host.querySelector('[role=alert]')!.textContent).toBe(host.querySelector('#bundle-number-error')!.textContent);
  expect(document.activeElement).toBe(mass);
});

it('reads only the chosen attachment, previews it, and lets the flyer leave it out', async () => {
  act(() => root.render(<FlightDataBundleDialog source={source()} onClose={() => {}} />));
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  const file = new File([new Uint8Array([0, 255, 42])], 'flight.log');
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.textContent).toContain('attachment/flight.log');
  await click('Download ZIP');
  const files = unzipSync(new Uint8Array(await (vi.mocked(saveFile).mock.calls[0]![0] as Blob).arrayBuffer()));
  expect(files['attachment/flight.log']).toEqual(new Uint8Array([0, 255, 42]));
  await click('Leave out attachment');
  expect(host.textContent).not.toContain('attachment/flight.log');
  Object.defineProperty(input, 'files', { value: [{ name: 'large.log', size: 26 * 1024 * 1024 }], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('[role=alert]')!.textContent).toContain('no larger than 25 MiB');
  Object.defineProperty(input, 'files', { value: [{ name: 'unreadable.log', size: 1, arrayBuffer: () => Promise.reject(new Error('read failed')) }], configurable: true });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('[role=alert]')!.textContent).toContain('Could not read that file');
});

it('resets a failed native selection so the same file can be retried without losing measurements', async () => {
  act(() => root.render(<FlightDataBundleDialog source={source()} onClose={() => {}} />));
  const apogee = [...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('Measured apogee'))!.control as HTMLInputElement;
  fill(apogee, '111.5');
  const input = host.querySelector<HTMLInputElement>('input[type=file]')!;
  const file = new File([new Uint8Array([0, 255, 42])], 'flight.log');
  const read = file.arrayBuffer.bind(file);
  let unavailable = true;
  Object.defineProperty(file, 'arrayBuffer', { value: () => unavailable ? Promise.reject(new Error('drive unavailable')) : read() });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  // Emulate the browser-owned fake path; scripts cannot set a nonempty file value.
  Object.defineProperty(input, 'value', { value: 'C:\\fakepath\\flight.log', writable: true, configurable: true });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(host.querySelector('[role=alert]')!.textContent).toContain('Could not read that file');
  expect(input.value).toBe('');
  expect(apogee.value).toBe('111.5');
  expect(input.disabled).toBe(false);
  unavailable = false;
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await click('Download ZIP');
  const files = unzipSync(new Uint8Array(await (vi.mocked(saveFile).mock.calls[0]![0] as Blob).arrayBuffer()));
  expect(files['attachment/flight.log']).toEqual(new Uint8Array([0, 255, 42]));
  expect(JSON.parse(strFromU8(files['measurements.json']!)).apogeeM).toBe(111.5);
});

it('refuses a hex measurement rather than exporting it as decimal (closure audit of v0.194, row C)', async () => {
  act(() => root.render(<FlightDataBundleDialog source={source()} onClose={() => {}} />));
  const apogee = [...host.querySelectorAll('label')].find(l => l.textContent?.startsWith('Measured apogee'))!.control as HTMLInputElement;
  fill(apogee, '0x10');
  expect(apogee.getAttribute('aria-invalid')).toBe('true');
  await click('Download ZIP');
  expect(saveFile).not.toHaveBeenCalled();
  fill(apogee, '16');
  expect(apogee.getAttribute('aria-invalid')).toBe('false');
});

it('names a stored run with no motor as "Unknown motor"', () => {
  localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify([{ ...source().run, motor: 7, manufacturer: undefined }]));
  const [run] = loadRuns();
  act(() => root.render(<FlightDataBundleDialog source={{ ...source(), run: run! }} onClose={() => {}} />));
  const selected = [...host.querySelectorAll('p')].find(p => p.textContent?.startsWith('Selected run:'))!;
  expect(selected.querySelector('strong')!.textContent).toBe('Chosen run · Unknown motor');
  localStorage.clear();
});
