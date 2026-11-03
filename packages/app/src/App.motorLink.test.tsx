// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import { getCatalogue, MOTOR_DB_DATE } from './services/motorDb.js';
import { catalogueCheckSettled } from './services/catalogueAutoCheck.js';
import { loadMotorForMount } from './services/motorLoad.js';
import { defaultDelay } from './services/thrustcurve.js';
import { defaultTree } from './tree/treeModel.js';
import { DEFAULT_CONDITIONS } from './components/LaunchPanel.js';
import { APP_VERSION } from './version.js';
import { encodeShareFragment } from './services/shareLink.js';
import { exportOrk } from './services/orkFile.js';

const held = vi.hoisted(() => ({ nozzle: false }));
vi.mock('./hooks/useNozzleFollow.js', async original => {
  const real = await original<typeof import('./hooks/useNozzleFollow.js')>();
  return { ...real, useNozzleFollow: (...args: Parameters<typeof real.useNozzleFollow>) => ({
    ...real.useNozzleFollow(...args), pending: held.nozzle,
  }) };
});

vi.mock('./services/catalogueAutoCheck.js', async original => ({
  ...await original<typeof import('./services/catalogueAutoCheck.js')>(), catalogueCheckSettled: vi.fn(async () => {}),
}));
vi.mock('./services/motorLoad.js', async original => {
  const real = await original<typeof import('./services/motorLoad.js')>();
  return { ...real, loadMotorForMount: vi.fn(real.loadMotorForMount) };
});
import { delayOptions, bundleHasCurve } from './services/thrustcurve.js';
import { flyBuiltDesign } from './services/simulateDesign.js';

vi.mock('./services/simulateDesign.js', async original => {
  const real = await original<typeof import('./services/simulateDesign.js')>();
  return { ...real, flyBuiltDesign: vi.fn(real.flyBuiltDesign) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const context = new Proxy({}, { get: (_t, p) => p === 'measureText' ? () => ({ width: 0 }) : () => undefined });
HTMLCanvasElement.prototype.getContext = (() => context) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;
let root: Root;
let host: HTMLDivElement;
const motor = (await Promise.all(getCatalogue()
  .filter(m => m.diameter === 18 && delayOptions(m).length >= 2 && delayOptions(m).some(Number.isFinite))
  .map(async m => await bundleHasCurve(m.motorId) ? m : null))).find(m => m !== null)!;
const delay = delayOptions(motor).find(Number.isFinite)!;
const runs = () => JSON.parse(localStorage.getItem('online-openrocket.sim-runs.v1') ?? '[]') as unknown[];
const session = () => JSON.parse(localStorage.getItem('online-openrocket.session.v1') ?? '{}');
async function settle() { await act(async () => { await new Promise(r => setTimeout(r, 50)); }); }
async function waitFor(test: () => boolean) {
  for (let i = 0; i < 160; i++) { if (test()) return; await settle(); }
  throw new Error('motor link did not settle');
}
async function open(suffix: string, fragment?: string) {
  const xml = fragment ?? readFileSync('src/services/__fixtures__/share-link-v0.100.txt', 'utf8').trim();
  window.location.hash = xml + suffix;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<PrefsProvider><App /></PrefsProvider>); });
  await waitFor(() => window.location.hash === '' && !!session().tree);
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text));
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
}
async function newDesign() {
  await act(async () => {
    [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Design')!.click();
  });
  const fresh = host.querySelector<HTMLButtonElement>('[title="Clear all components and start from scratch"]')!;
  expect(fresh).not.toBeNull();
  await act(async () => fresh.click());
  const discard = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Discard'));
  if (discard) await act(async () => discard.click());
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  vi.mocked(flyBuiltDesign).mockClear();
  vi.mocked(catalogueCheckSettled).mockClear().mockResolvedValue();
  vi.mocked(loadMotorForMount).mockClear();
  held.nozzle = false;
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove(); window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('opens, assigns the requested offered delay, flies once and shows results', async () => {
  await open(`&motor=${motor.motorId}&delay=${delay}`);
  await waitFor(() => runs().length === 1);
  await waitFor(() => Object.keys(session().mountMotors ?? {}).length === 1);
  const assigned = Object.values(session().mountMotors) as { meta: { motorId: string }; spec: { ejectionDelay: number } }[];
  expect(assigned).toHaveLength(1);
  expect(assigned[0]).toMatchObject({ meta: { motorId: motor.motorId }, spec: { ejectionDelay: delay } });
  expect(flyBuiltDesign).toHaveBeenCalledOnce();
  await settle(); await settle();
  expect(runs()).toHaveLength(1);
  expect(flyBuiltDesign).toHaveBeenCalledOnce();
  expect(host.querySelector('.results-column')).not.toBeNull();
  expect(window.location.hash).toBe('');
}, 20_000);
it('opens an unknown motor with an empty mount, a note and no flight', async () => {
  await open('&motor=000000000000000000000000');
  await waitFor(() => host.textContent!.includes('which this app\'s motor list'));
  expect(session().mountMotors).toEqual({});
  expect(runs()).toHaveLength(0);
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  expect(host.textContent).toContain(MOTOR_DB_DATE);
}, 20_000);
it('never auto-flies a plain link', async () => {
  await open(''); await settle();
  expect(catalogueCheckSettled).not.toHaveBeenCalled();
  expect(loadMotorForMount).not.toHaveBeenCalled();
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  expect(runs()).toHaveLength(0);
});
it('uses the Motors default when the hinted delay is not offered', async () => {
  await open(`&motor=${motor.motorId}&delay=999`);
  await waitFor(() => runs().length === 1 && Object.keys(session().mountMotors ?? {}).length === 1);
  expect(Object.values(session().mountMotors)[0]).toMatchObject({ spec: { ejectionDelay: defaultDelay(motor) ?? 0 } });
});
it.each(['catalogue', 'curve'])('New cancels a pending %s wait without assigning or flying', async kind => {
  const gate = deferred();
  if (kind === 'catalogue') vi.mocked(catalogueCheckSettled).mockReturnValueOnce(gate.promise);
  else {
    const real = await vi.importActual<typeof import('./services/motorLoad.js')>('./services/motorLoad.js');
    vi.mocked(loadMotorForMount).mockImplementationOnce(async (...args) => { await gate.promise; return real.loadMotorForMount(...args); });
  }
  await open(`&motor=${motor.motorId}`);
  await waitFor(() => kind === 'catalogue' || vi.mocked(loadMotorForMount).mock.calls.length > 0);
  await newDesign();
  await act(async () => gate.resolve());
  await act(async () => { await new Promise(r => setTimeout(r, 500)); });
  if (kind === 'catalogue') expect(loadMotorForMount).not.toHaveBeenCalled();
  await waitFor(() => !Object.keys(session().mountMotors ?? {}).length);
  expect(runs()).toHaveLength(0);
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  expect(host.querySelector('.results-column')).toBeNull();
});
it.each([true, false])('offers a restored design; accept=%s controls the motor and flight', async accept => {
  localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: { ...defaultTree(), name: 'My existing rocket' },
    mountMotors: {}, launch: DEFAULT_CONDITIONS, savedConfigs: [], activeConfigId: null,
    appVersion: APP_VERSION, savedAt: Date.now() }));
  await open(`&motor=${motor.motorId}`);
  await waitFor(() => host.textContent!.includes('Open design from this link?'));
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  if (accept) {
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Open design from link"] .modal-danger');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    await waitFor(() => runs().length === 1);
    expect(loadMotorForMount).toHaveBeenCalledOnce();
  } else {
    await click('Keep my design'); await settle();
    expect(loadMotorForMount).not.toHaveBeenCalled();
    expect(runs()).toHaveLength(0);
  }
});
it('restores a link design without another flight', async () => {
  await open(`&motor=${motor.motorId}`);
  await waitFor(() => runs().length === 1 && Object.keys(session().mountMotors ?? {}).length === 1);
  await act(async () => root.unmount()); host.remove();
  vi.mocked(flyBuiltDesign).mockClear(); vi.mocked(loadMotorForMount).mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  await settle();
  expect(loadMotorForMount).not.toHaveBeenCalled();
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  expect(runs()).toHaveLength(1);
});
it('reports a curve failure without flying', async () => {
  vi.mocked(loadMotorForMount).mockRejectedValueOnce(new Error('curve failed'));
  await open(`&motor=${motor.motorId}`);
  await waitFor(() => host.textContent!.includes('no flight was run'));
  expect(host.textContent).toContain(motor.designation);
  expect(runs()).toHaveLength(0);
});
it('keeps an active configuration refusal instead of treating a link as a manual repair', async () => {
  const refusal = 'Launch refused: review this ambiguous loadout.';
  const fragment = await encodeShareFragment(exportOrk({ name: 'Refused link', tree: defaultTree(),
    configs: [{ id: 'refused', name: 'Refused', isDefault: true, motors: {}, motorLoadoutRefusal: refusal }],
    activeConfigId: 'refused' }));
  await open(`&motor=${motor.motorId}`, fragment);
  await waitFor(() => vi.mocked(loadMotorForMount).mock.calls.length > 0);
  await settle(); await settle();
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  expect(host.textContent).toContain(refusal);
});
it('drops a pending launch when the user edits before the nozzle is ready', async () => {
  held.nozzle = true;
  await open(`&motor=${motor.motorId}`);
  await waitFor(() => Object.keys(session().mountMotors ?? {}).length === 1);
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  await act(async () => {
    const field = host.querySelector<HTMLInputElement>('#rocket-name')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(field, 'Edited before flight'); field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
  });
  held.nozzle = false;
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  await settle();
  await waitFor(() => session().tree.name === 'Edited before flight');
  expect(flyBuiltDesign).not.toHaveBeenCalled();
});
it('completes the design open while the catalogue stalls, then proceeds at the 10 s bound', async () => {
  const gate = deferred();
  const real = await vi.importActual<typeof import('./services/catalogueAutoCheck.js')>('./services/catalogueAutoCheck.js');
  real.resetCatalogueAutoCheckForTests();
  vi.mocked(catalogueCheckSettled).mockImplementationOnce(async ms => { await gate.promise; await real.catalogueCheckSettled(ms); });
  await open(`&motor=${motor.motorId}`);
  expect(session().tree).toBeDefined();
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await act(async () => gate.resolve());
  await act(async () => { await vi.advanceTimersByTimeAsync(9999); });
  expect(loadMotorForMount).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(loadMotorForMount).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  vi.useRealTimers();
  await waitFor(() => runs().length === 1);
}, 20_000);
it('opens a design without a mount and reports why it did not fly', async () => {
  const fragment = await encodeShareFragment('<openrocket version="1.10"><rocket><name>No mounts</name><subcomponents><stage><subcomponents><bodytube><length>0.3</length><radius>0.02</radius></bodytube></subcomponents></stage></subcomponents></rocket></openrocket>');
  await open(`&motor=${motor.motorId}`, fragment);
  await waitFor(() => host.textContent!.includes('This design has no motor mount'));
  expect(loadMotorForMount).not.toHaveBeenCalled();
  expect(runs()).toHaveLength(0);
});
it('loads a motor that does not fit and keeps the consequence beside its results', async () => {
  const wide = (await Promise.all(getCatalogue().filter(m => m.diameter > 18 && m.diameter <= 29)
    .map(async m => await bundleHasCurve(m.motorId) ? m : null))).find(m => m !== null)!;
  await open(`&motor=${wide.motorId}`);
  await waitFor(() => runs().length === 1);
  expect(host.querySelector('.results-column')?.textContent).toContain('the real rocket could not be built this way');
  await newDesign();
  expect(host.textContent).not.toContain('the real rocket could not be built this way');
});
