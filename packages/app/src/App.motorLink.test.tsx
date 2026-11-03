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
import { nozzleForMotorId } from './services/nozzleDb.js';
import { stages, motorMounts } from './tree/treeModel.js';
import { setCatalogueOverlay } from './services/motorDb.js';
import { INITIAL_UNITS } from './prefs/units.js';
import type { ComponentProps } from 'react';
import type { MotorPicker } from './components/MotorPicker.js';
import { OVERRIDE_INCLUDES_MOTOR } from './services/statedLaunchWeight.js';
import { applyImportPlan } from './services/importApply.js';

const held = vi.hoisted(() => ({ nozzle: false, pick: null as ComponentProps<typeof MotorPicker>['onSelect'] | null }));
vi.mock('./components/MotorPicker.js', async original => {
  const real = await original<typeof import('./components/MotorPicker.js')>();
  return { ...real, MotorPicker: (props: ComponentProps<typeof MotorPicker>) => {
    held.pick = props.onSelect;
    return <real.MotorPicker {...props} />;
  } };
});
vi.mock('./hooks/useNozzleFollow.js', async original => {
  const real = await original<typeof import('./hooks/useNozzleFollow.js')>();
  return { ...real, useNozzleFollow: (...args: Parameters<typeof real.useNozzleFollow>) => {
    const result = real.useNozzleFollow(...args);
    return { ...result, pending: held.nozzle || result.pending };
  } };
});

vi.mock('./services/catalogueAutoCheck.js', async original => ({
  ...await original<typeof import('./services/catalogueAutoCheck.js')>(), catalogueCheckSettled: vi.fn(async () => {}),
}));
vi.mock('./services/motorLoad.js', async original => {
  const real = await original<typeof import('./services/motorLoad.js')>();
  return { ...real, loadMotorForMount: vi.fn(real.loadMotorForMount) };
});
vi.mock('./services/importApply.js', async original => {
  const real = await original<typeof import('./services/importApply.js')>();
  return { ...real, applyImportPlan: vi.fn(real.applyImportPlan) };
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
  setCatalogueOverlay(null);
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  vi.mocked(flyBuiltDesign).mockClear();
  vi.mocked(catalogueCheckSettled).mockClear().mockResolvedValue();
  vi.mocked(loadMotorForMount).mockClear();
  vi.mocked(applyImportPlan).mockClear();
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
}, 20_000);
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
it.each(['unknown', 'failure'])('merges the %s caution with the import format caution', async kind => {
  if (kind === 'failure') vi.mocked(loadMotorForMount).mockRejectedValueOnce(new Error('curve failed'));
  const fragment = await encodeShareFragment(exportOrk({ name: 'Future format', tree: defaultTree() })
    .replace(/version="1.10"/, 'version="999.0"'));
  await open(`&motor=${kind === 'unknown' ? '000000000000000000000000' : motor.motorId}`, fragment);
  await waitFor(() => host.textContent!.includes(kind === 'unknown' ? 'which this app\'s motor list' : 'could not be loaded'));
  expect(host.textContent).toContain('Warning: this file uses format');
  expect(host.querySelector('[aria-label="Dismiss: Loaded “Future format”."]')).not.toBeNull();
  expect(flyBuiltDesign).not.toHaveBeenCalled();
});
it('assigns to the committed active configuration even with immediate promises', async () => {
  const fragment = await encodeShareFragment(exportOrk({ name: 'Active config', tree: defaultTree(),
    configs: [{ id: 'link-config', name: 'Link config', motors: {}, isDefault: true }], activeConfigId: 'link-config' }));
  await open(`&motor=${motor.motorId}`, fragment);
  await waitFor(() => runs().length === 1);
  const flown = vi.mocked(flyBuiltDesign).mock.calls[0]![0];
  expect(flown.activeConfigId).toBe('link-config');
  expect(Object.values(flown.working!.motors)[0]).toMatchObject({ meta: { motorId: motor.motorId } });
});
it('merges the stated-weight reconciliation with the original import cautions', async () => {
  const tree = defaultTree();
  Object.assign(tree.components[0]!, { overrideMass: 0.6, overrideSubcomponentsMass: true,
    [OVERRIDE_INCLUDES_MOTOR]: 'Z99999-NOPE' });
  const fragment = await encodeShareFragment(exportOrk({ name: 'Future format', tree })
    .replace(/version="1.10"/, 'version="999.0"'));
  await open(`&motor=${motor.motorId}`, fragment);
  await waitFor(() => host.textContent!.includes('matched no motor in the motor database'));
  expect(host.textContent).toContain('Warning: this file uses format');
  expect(host.querySelector('[aria-label="Dismiss: Loaded “Future format”."]')).not.toBeNull();
});
it.each(['catalogue', 'curve'])('keeps an active configuration refusal across a %s macrotask', async kind => {
  const refusal = 'Launch refused: review this ambiguous loadout.';
  const fragment = await encodeShareFragment(exportOrk({ name: 'Refused link', tree: defaultTree(),
    configs: [{ id: 'refused', name: 'Refused', isDefault: true, motors: {}, motorLoadoutRefusal: refusal }],
    activeConfigId: 'refused' }));
  const gate = deferred();
  if (kind === 'catalogue') vi.mocked(catalogueCheckSettled).mockReturnValueOnce(gate.promise);
  else {
    const real = await vi.importActual<typeof import('./services/motorLoad.js')>('./services/motorLoad.js');
    vi.mocked(loadMotorForMount).mockImplementationOnce(async (...args) => { await gate.promise; return real.loadMotorForMount(...args); });
  }
  await open(`&motor=${motor.motorId}`, fragment);
  await settle();
  await act(async () => gate.resolve());
  await settle(); await settle();
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  expect(host.textContent).toContain(refusal);
  expect(host.textContent).toContain("configuration's motor loadout was refused");
  expect(loadMotorForMount).not.toHaveBeenCalled();
});
it('assigns Auto for a shipped motor with no listed delays', async () => {
  const m = (await Promise.all(getCatalogue().filter(m => delayOptions(m).length === 0)
    .map(async m => await bundleHasCurve(m.motorId) ? m : null))).find(m => m !== null)!;
  await open(`&motor=${m.motorId}`);
  await waitFor(() => Object.keys(session().mountMotors ?? {}).length === 1);
  expect(Object.values(session().mountMotors)[0]).toMatchObject({ meta: { motorId: m.motorId, autoDelay: true } });
});
it('reads a late live refusal after a curve wait without repairing or flying it', async () => {
  const gate = deferred();
  const real = await vi.importActual<typeof import('./services/motorLoad.js')>('./services/motorLoad.js');
  vi.mocked(loadMotorForMount).mockImplementationOnce(async (...args) => {
    await gate.promise;
    return real.loadMotorForMount(...args);
  });
  const fragment = await encodeShareFragment(exportOrk({ name: 'Late refusal', tree: defaultTree(),
    configs: [{ id: 'late', name: 'Late', motors: {}, isDefault: true }], activeConfigId: 'late' }));
  await open(`&motor=${motor.motorId}`, fragment);
  await waitFor(() => vi.mocked(loadMotorForMount).mock.calls.length === 1);
  await settle();
  // Inject an asynchronous import/configuration update through App's actual sink,
  // independently of manual-action cancellation, while the curve is outstanding.
  const [plan, sinks] = vi.mocked(applyImportPlan).mock.calls.at(-1)!;
  const refusal = 'Launch refused: the late loadout evidence is ambiguous.';
  await act(async () => sinks.setSavedConfigs(plan.snapshot.savedConfigs.map(c => ({ ...c, motorLoadoutRefusal: refusal }))));
  await settle();
  await act(async () => gate.resolve());
  await settle(); await settle();
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  expect(host.textContent).toContain("configuration's motor loadout was refused");
  expect(session().mountMotors).toEqual({});
  await waitFor(() => session().savedConfigs.some((c: { motorLoadoutRefusal?: string }) => c.motorLoadoutRefusal === refusal));
});
it.each(['ABC', 'ex:bad'])('keeps a malformed %s motor caution without loading', async id => {
  await open(`&motor=${id}`); await settle();
  expect(host.textContent).toContain('was ignored');
  expect(loadMotorForMount).not.toHaveBeenCalled();
  expect(flyBuiltDesign).not.toHaveBeenCalled();
});
it.each(['design', 'motors'])('fills the published nozzle on %s before exactly one flight', async tab => {
  const m = (await Promise.all(getCatalogue().filter(m => m.diameter <= 29)
    .map(async m => await nozzleForMotorId(m.motorId) && await bundleHasCurve(m.motorId) ? m : null))).find(m => m !== null)!;
  const entry = (await nozzleForMotorId(m.motorId))!;
  const gate = deferred();
  vi.mocked(catalogueCheckSettled).mockReturnValueOnce(gate.promise);
  await open(`&motor=${m.motorId}`);
  if (tab === 'motors') await click('Motors & Configuration');
  await act(async () => gate.resolve());
  await waitFor(() => runs().length === 1);
  const flown = vi.mocked(flyBuiltDesign).mock.calls[0]![0].tree;
  expect(stages(flown).some(s => s.nozzleExitDiameter === entry.exitDiameterM)).toBe(true);
  await click('Motors & Configuration'); await settle();
  await waitFor(() => stages(session().tree).some(s => s.nozzleExitDiameter === entry.exitDiameterM));
  expect(flyBuiltDesign).toHaveBeenCalledOnce();
  await click('Results');
  expect(host.querySelector('.results-column')).not.toBeNull();
}, 20_000);
it('a manual motor pick during the catalogue wait wins', async () => {
  const gate = deferred();
  vi.mocked(catalogueCheckSettled).mockReturnValueOnce(gate.promise);
  await open(`&motor=${motor.motorId}`);
  await click('Motors & Configuration');
  const real = await vi.importActual<typeof import('./services/motorLoad.js')>('./services/motorLoad.js');
  const loaded = await real.loadMotorForMount(motor, delay, { units: INITIAL_UNITS });
  expect(held.pick).toBeTypeOf('function');
  await act(async () => held.pick!(loaded.label, loaded.spec, loaded.meta));
  await waitFor(() => Object.keys(session().mountMotors ?? {}).length > 0);
  const picked = session().mountMotors;
  await act(async () => gate.resolve()); await settle();
  expect(loadMotorForMount).not.toHaveBeenCalled();
  expect(session().mountMotors).toEqual(picked);
  expect(flyBuiltDesign).not.toHaveBeenCalled();
});
it.each(['Unload', 'Launch', 'Remove', 'Config'])('%s cancels a link during the catalogue wait', async action => {
  const gate = deferred();
  vi.mocked(catalogueCheckSettled).mockReturnValueOnce(gate.promise);
  const tree = defaultTree();
  const motors = {
    [motorMounts(tree)[0]!.id!]: { designation: motor.designation, manufacturer: motor.manufacturerAbbrev,
      diameter: motor.diameter / 1000, length: motor.length / 1000, delay },
  };
  const fragment = await encodeShareFragment(exportOrk({ name: 'Already loaded', tree, motors,
    configs: [{ id: 'loaded', name: 'Loaded', motors, isDefault: true },
      { id: 'other', name: 'Other motors', motors, isDefault: false }], activeConfigId: 'loaded' }));
  await open(`&motor=${motor.motorId}`, fragment);
  await waitFor(() => Object.keys(session().mountMotors ?? {}).length === 1);
  if (action === 'Remove' || action === 'Config') {
    await click('Motors & Configuration');
    await act(async () => host.querySelector<HTMLButtonElement>(action === 'Remove'
      ? '[title="Remove this motor"]' : '[aria-label^="Apply Other motors"]')!.click());
  } else await click(action);
  await act(async () => gate.resolve()); await settle();
  expect(loadMotorForMount).not.toHaveBeenCalled();
  if (action === 'Launch') { await waitFor(() => runs().length === 1); expect(flyBuiltDesign).toHaveBeenCalledOnce(); }
  else expect(flyBuiltDesign).not.toHaveBeenCalled();
});
it('quotes the active snapshot date when the motor is unknown', async () => {
  const gate = deferred();
  vi.mocked(catalogueCheckSettled).mockReturnValueOnce(gate.promise);
  await open('&motor=000000000000000000000000');
  const date = new Date(Date.parse(MOTOR_DB_DATE) + 86400000).toISOString().slice(0, 10);
  await act(async () => setCatalogueOverlay({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(), liveCount: getCatalogue().length,
    added: [], changed: [], removed: [], rejected: [], snapshot: { id: 'test', generated: date, motorsSha256: '0'.repeat(64),
      curves: { path: 'v1/test/curves.json', bytes: 1, sha256: '0'.repeat(64) } } }));
  await act(async () => gate.resolve()); await settle();
  expect(host.textContent).toContain(`dated ${date}`);
});
it('hides the mismatch banner after removing the motor', async () => {
  const wide = (await Promise.all(getCatalogue().filter(m => m.diameter > 18 && m.diameter <= 29)
    .map(async m => await bundleHasCurve(m.motorId) ? m : null))).find(m => m !== null)!;
  await open(`&motor=${wide.motorId}`); await waitFor(() => runs().length === 1);
  expect(host.textContent).toContain('the real rocket could not be built this way');
  await click('Motors & Configuration');
  await act(async () => host.querySelector<HTMLButtonElement>('[title="Remove this motor"]')!.click());
  await click('Results');
  expect(host.textContent).not.toContain('the real rocket could not be built this way');
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
