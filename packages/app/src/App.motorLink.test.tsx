import { matchImportedMotor } from './services/motorMatch.js';
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
vi.mock('react', async original => {
  const real = await original<typeof import('react')>();
  return { ...real, useRef: <T,>(value: T) => {
    const ref = real.useRef(value);
    if (value === null) held.refs.push(ref);
    return ref;
  } };
});
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
import type { ComponentProps } from 'react';
import type { MotorPicker } from './components/MotorPicker.js';
import { OVERRIDE_INCLUDES_MOTOR } from './services/statedLaunchWeight.js';
import { planImport, applyImportPlan } from './services/importApply.js';
import { addRuns } from './services/simStore.js';
import { importedSummaryRuns } from './services/orkFlightData.js';
import { collectOpenMotorIdentities } from './services/openMotorChoices.js';
vi.mock('./services/openMotorChoices.js', async original => {
 const real = await original<typeof import('./services/openMotorChoices.js')>();
 return { ...real, collectOpenMotorIdentities: vi.fn(real.collectOpenMotorIdentities) };
});
import { motorLinkParams } from './services/motorLink.js';
vi.mock('./services/motorLink.js', async original => {
  const real = await original<typeof import('./services/motorLink.js')>();
  return { ...real, motorLinkParams: vi.fn(real.motorLinkParams) };
});

vi.mock('./services/motorMatch.js', async original => {
  const real = await original<typeof import('./services/motorMatch.js')>();
  return { ...real, matchImportedMotor: vi.fn(real.matchImportedMotor) };
});
const held = vi.hoisted(() => ({ refs: [] as { current: unknown }[], build: false, nozzle: false, notes: [] as string[], pick: null as ComponentProps<typeof MotorPicker>['onSelect'] | null }));
vi.mock('./services/buildDesign.js', async original => {
  const real = await original<typeof import('./services/buildDesign.js')>();
  return { ...real, buildDesign: (...args: Parameters<typeof real.buildDesign>) => held.build ? { error: 'Build deferred by test' } : real.buildDesign(...args) };
});
vi.mock('./components/Note.js', async original => {
  const real = await original<typeof import('./components/Note.js')>();
  return { ...real, Note: (props: ComponentProps<typeof real.Note>) => {
    if (typeof props.children === 'string') held.notes.push(props.children);
    return <real.Note {...props} />;
  } };
});
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
  return { ...real, planImport: vi.fn(real.planImport), applyImportPlan: vi.fn(real.applyImportPlan), resolveImportMotors: vi.fn(real.resolveImportMotors) };
});
vi.mock('./services/nozzleDb.js', async original => {
  const real = await original<typeof import('./services/nozzleDb.js')>();
  return { ...real, nozzleForMotorId: vi.fn(real.nozzleForMotorId) };
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
  await waitFor(() => window.location.hash === '');
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
beforeEach(async () => {
  vi.mocked(nozzleForMotorId).mockImplementation((await vi.importActual<typeof import('./services/nozzleDb.js')>('./services/nozzleDb.js')).nozzleForMotorId);
  setCatalogueOverlay(null);
  localStorage.clear();
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  vi.mocked(flyBuiltDesign).mockClear();
  vi.mocked(catalogueCheckSettled).mockReset().mockResolvedValue();
  vi.mocked(loadMotorForMount).mockClear();
  vi.mocked(applyImportPlan).mockClear();
  vi.mocked(matchImportedMotor).mockClear();
  held.refs = [];
  held.nozzle = false;
  held.build = false;
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
  expect(matchImportedMotor).not.toHaveBeenCalled();
  await settle(); await settle();
  expect(runs()).toHaveLength(1);
  expect(flyBuiltDesign).toHaveBeenCalledOnce();
  expect(host.querySelector('.results-column')).not.toBeNull();
  expect(window.location.hash).toBe('');
}, 20_000);
it('opens an unknown motor with an empty mount, a note and no flight', async () => {
  await open('&motor=000000000000000000000000');
  await waitFor(() => host.textContent!.includes('which this app\'s motor list'));
  await waitFor(() => !!session().tree);
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

it('round8 malformed-only links do not wait for catalogue', async () => {
  vi.mocked(catalogueCheckSettled).mockReturnValueOnce(deferred().promise);
  await open('&motor=ABC&motor=ABC'); await settle();
  expect(host.textContent).toContain('was ignored');
  expect(catalogueCheckSettled).not.toHaveBeenCalled();
  expect(vi.mocked(applyImportPlan).mock.calls.at(-1)![0].note.group.lines.filter(n => n.text.includes('was ignored'))).toHaveLength(1);
  expect(vi.mocked(motorLinkParams).mock.results.at(-1)!.value.problems).toHaveLength(1);
});
it('round8 malformed cautions survive a refusal', async () => {
  const fragment = await encodeShareFragment(exportOrk({ name: 'Refused', tree: defaultTree(),
    configs: [{ id: 'refused', name: 'Refused', isDefault: true, motors: {}, motorLoadoutRefusal: 'Refused loadout' }], activeConfigId: 'refused' }));
  await open(`&motor=${motor.motorId}&delay=bad`, fragment); await settle();
  expect(host.textContent).toContain('was ignored');
  expect(host.textContent).toContain("configuration's motor loadout was refused");
  expect(loadMotorForMount).not.toHaveBeenCalled();
  expect(vi.mocked(applyImportPlan).mock.calls.at(-1)![0].snapshot.mountMotors).toEqual({});
});
it('round8 curve failures retain malformed parameter cautions', async () => {
  vi.mocked(loadMotorForMount).mockRejectedValueOnce(new Error('curve failed'));
  await open(`&motor=${motor.motorId}&delay=bad`); await settle();
  expect(host.textContent).toContain('was ignored');
  expect(host.textContent).toContain('could not be loaded');
});
it('round8 failed flight has no mismatch banner', async () => {
  const wide = (await Promise.all(getCatalogue().filter(m => m.diameter > 18 && m.diameter <= 29)
    .map(async m => await bundleHasCurve(m.motorId) ? m : null))).find(m => m !== null)!;
  vi.mocked(flyBuiltDesign).mockRejectedValueOnce(new Error('flight failed round8'));
  await open(`&motor=${wide.motorId}`);
  await waitFor(() => host.textContent!.includes('flight failed round8'));
  expect(host.querySelector('.results-column')?.textContent ?? '').not.toContain('the real rocket could not be built this way');
});
it('round8 pending file motor choices stop the link', async () => {
  const fragment = await encodeShareFragment(`<openrocket version="1.10"><rocket><name>Question</name><motorconfiguration configid="a" default="true"/><subcomponents><stage><subcomponents><bodytube><length>0.5</length><radius>0.016</radius><thickness>0.001</thickness><motormount><motor configid="a"><manufacturer>Enerjet</manufacturer><designation>F67</designation><diameter>0.0286</diameter><length>0.127</length><delay>9</delay></motor></motormount></bodytube></subcomponents></stage></subcomponents></rocket></openrocket>`);
  await open(`&motor=${motor.motorId}`, fragment); await settle();
  expect(host.textContent).toContain("file's motors need a choice first");
  expect(loadMotorForMount).not.toHaveBeenCalled();
  expect(flyBuiltDesign).not.toHaveBeenCalled();
});
it('round8 unknown motor preserves motors already in the link', async () => {
  const tree = defaultTree();
  const motors = { [motorMounts(tree)[0]!.id!]: { designation: motor.designation, manufacturer: motor.manufacturerAbbrev,
    diameter: motor.diameter / 1000, length: motor.length / 1000, delay } };
  await open('&motor=000000000000000000000000', await encodeShareFragment(exportOrk({ name: 'Loaded', tree, motors })));
  await waitFor(() => host.textContent!.includes('No motor was loaded from the link'));
  await waitFor(() => !!session().tree);
  expect(Object.keys(session().mountMotors)).toHaveLength(1);
  expect(flyBuiltDesign).not.toHaveBeenCalled();
});
it('round8 nozzle chunk failure cautions and still flies', async () => {
  const m = (await Promise.all(getCatalogue().filter(m => m.diameter <= 29)
    .map(async m => await nozzleForMotorId(m.motorId) && await bundleHasCurve(m.motorId) ? m : null))).find(m => m !== null)!;
  vi.mocked(nozzleForMotorId).mockRejectedValue(new Error('chunk failed'));
  try {
    await open(`&motor=${m.motorId}`);
    await waitFor(() => runs().length === 1);
    expect(host.textContent).toContain('published nozzle exit could not be loaded');
  } finally { vi.mocked(nozzleForMotorId).mockImplementation((await vi.importActual<typeof import('./services/nozzleDb.js')>('./services/nozzleDb.js')).nozzleForMotorId); }
});
it('round8 notes de-duplicate repeated text even from separate producers', async () => {
  vi.mocked(motorLinkParams).mockReturnValueOnce({ motorId: null, delayHint: null, problems: ['Repeated caution', 'Repeated caution'] });
  await open(''); await settle();
  expect(vi.mocked(applyImportPlan).mock.calls.at(-1)![0].note.group.lines.filter(n => n.text === 'Repeated caution')).toHaveLength(1);
});
it.each(['launch', 'inspect'])('round8 hides run banner after %s', async action => {
  addRuns(importedSummaryRuns({ name: 'Other summary', storedSimulations: [{ name: 'Other summary', configId: null,
    data: { runId: 'other-summary', maxAltitude: 123, aeroModel: 'classic' } }] }));
  const wide = (await Promise.all(getCatalogue().filter(m => m.diameter > 18 && m.diameter <= 29)
    .map(async m => await bundleHasCurve(m.motorId) ? m : null))).find(m => m !== null)!;
  await open(`&motor=${wide.motorId}`); await waitFor(() => runs().length === 2);
  expect(host.querySelector('.results-column')?.textContent).toContain('the real rocket could not be built this way');
  if (action === 'launch') {
    const [, sinks] = vi.mocked(applyImportPlan).mock.calls.at(-1)!;
    held.notes = [];
    await act(async () => sinks.setLaunch({ ...DEFAULT_CONDITIONS, launchRodLengthM: 9 }));
    // The result-clearing effect is later: the intervening render must not flash the old banner.
    expect(held.notes.join('\n')).not.toContain('the real rocket could not be built this way');
  } else {
    const panel = [...host.querySelectorAll('h2')].find(h => h.textContent?.startsWith('Saved simulations'))!.closest('.panel')!;
    const show = [...panel.querySelectorAll('button')].find(b => b.textContent === 'Show');
    if (show) await act(async () => show.click());
    const row = [...host.querySelectorAll<HTMLTableRowElement>('tr.motor-row')].find(r => r.textContent?.includes('Other summary'))!;
    expect(row).toBeDefined(); await act(async () => row.click());
  }
  expect(host.querySelector('.results-column')?.textContent ?? '').not.toContain('the real rocket could not be built this way');
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
  const lookups = vi.mocked(nozzleForMotorId).mock.calls.length;
  await act(async () => gate.resolve());
  await act(async () => { await new Promise(r => setTimeout(r, 500)); });
  if (kind === 'catalogue') expect(loadMotorForMount).not.toHaveBeenCalled();
  expect(vi.mocked(nozzleForMotorId).mock.calls.length).toBe(lookups);
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
    expect(loadMotorForMount).toHaveBeenCalledOnce();
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
  await waitFor(() => (session().tree && stages(session().tree).some(s => s.nozzleExitDiameter === entry.exitDiameterM)));
  expect(flyBuiltDesign).toHaveBeenCalledOnce();
  await click('Results');
  expect(host.querySelector('.results-column')).not.toBeNull();
}, 20_000);
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
  expect(host.querySelector('.results-column')?.textContent ?? '').not.toContain('the real rocket could not be built this way');
});
it('keeps the design unapplied while the catalogue stalls, then proceeds at the 10 s bound', async () => {
  const gate = deferred();
  const real = await vi.importActual<typeof import('./services/catalogueAutoCheck.js')>('./services/catalogueAutoCheck.js');
  real.resetCatalogueAutoCheckForTests();
  vi.mocked(catalogueCheckSettled).mockImplementationOnce(async ms => { await gate.promise; await real.catalogueCheckSettled(ms); });
  await open(`&motor=${motor.motorId}`);
  expect(applyImportPlan).not.toHaveBeenCalled();
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
  expect(host.querySelector('.results-column')?.textContent ?? '').not.toContain('the real rocket could not be built this way');
});

it.each(['catalogue', 'curve', 'nozzle'])('round9 resolves %s before applying anything', async kind => {
  const gate = deferred();
  if (kind === 'catalogue') vi.mocked(catalogueCheckSettled).mockReturnValueOnce(gate.promise);
  if (kind === 'curve') {
    const real = await vi.importActual<typeof import('./services/motorLoad.js')>('./services/motorLoad.js');
    vi.mocked(loadMotorForMount).mockImplementationOnce(async (...args) => { await gate.promise; return real.loadMotorForMount(...args); });
  }
  if (kind === 'nozzle') {
    const real = await vi.importActual<typeof import('./services/nozzleDb.js')>('./services/nozzleDb.js');
    vi.mocked(nozzleForMotorId).mockImplementation(async (...args) => { await gate.promise; return real.nozzleForMotorId(...args); });
  }
  await open(`&motor=${motor.motorId}`, await encodeShareFragment(exportOrk({ name: 'Prepared', tree: defaultTree() }))); await settle();
  expect(applyImportPlan).not.toHaveBeenCalled();
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  await act(async () => gate.resolve());
  await waitFor(() => runs().length === 1);
  expect(applyImportPlan).toHaveBeenCalledOnce();
});

it.each(['edit', 'remove', 'replace'])('round9 pending build: %s', async action => {
  held.build = true;
  await open(`&motor=${motor.motorId}`);
  await waitFor(() => vi.mocked(applyImportPlan).mock.calls.length === 1);
  const [plan, sinks] = vi.mocked(applyImportPlan).mock.calls[0]!;
  expect(flyBuiltDesign).not.toHaveBeenCalled();
  held.build = false;
  await act(async () => {
    if (action === 'edit') sinks.setMeasured({ massKg: 0.2, cgM: null });
    else sinks.setMountMotors(action === 'remove' ? {} : Object.fromEntries(Object.entries(plan.snapshot.mountMotors).map(([id,m]) => [id, { ...m, meta: { ...m.meta, motorId: 'replacement' } }])));
  });
  if (action === 'edit') { await waitFor(() => runs().length === 1); expect(flyBuiltDesign).toHaveBeenCalledOnce(); }
  else { await settle(); await settle(); expect(flyBuiltDesign).not.toHaveBeenCalled(); }
});
it('round9 keeps an existing nozzle when lookup fails', async () => {
  const tree = defaultTree(); stages(tree)[0]!.nozzleExitDiameter = 0.009;
  vi.mocked(nozzleForMotorId).mockRejectedValue(new Error('chunk failed'));
  await open(`&motor=${motor.motorId}`, await encodeShareFragment(exportOrk({ name: 'Existing exit', tree })));
  await waitFor(() => runs().length === 1);
  expect(stages(vi.mocked(flyBuiltDesign).mock.calls[0]![0].tree)[0]!.nozzleExitDiameter).toBeCloseTo(0.009, 10);
  expect(host.textContent).not.toContain('flight used none');
});
it('round9 a second open during resolution supersedes the prepared import', async () => {
  const gate = deferred(); vi.mocked(catalogueCheckSettled).mockReturnValueOnce(gate.promise);
  await open(`&motor=${motor.motorId}`);
  const file = new File([exportOrk({ name: 'Second open', tree: defaultTree() })], 'second.ork');
  const picker = host.querySelector<HTMLInputElement>('[aria-label="Open a design file"]')!;
  Object.defineProperty(picker, 'files', { configurable: true, value: [file] });
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
  await waitFor(() => session().tree?.name === 'Second open');
  await act(async () => gate.resolve()); await settle();
  expect(session().tree.name).toBe('Second open'); expect(flyBuiltDesign).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('Open design from this link?');
});
it('round9 catalogue relabeling a file motor during resolution still flies', async () => {
  const gate = deferred(); vi.mocked(catalogueCheckSettled).mockReturnValueOnce(gate.promise);
  const tree = defaultTree(); const motors = { [motorMounts(tree)[0]!.id!]: { designation: motor.designation, manufacturer: motor.manufacturerAbbrev,
    diameter: motor.diameter / 1000, length: motor.length / 1000, delay } };
  await open(`&motor=${motor.motorId}`, await encodeShareFragment(exportOrk({ name: 'Relabeled', tree, motors })));
  await act(async () => setCatalogueOverlay({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date().toISOString(), liveCount: getCatalogue().length,
    added: [], changed: [{ motorId: motor.motorId, before: motor, after: { ...motor, commonName: 'Relabeled file motor' }, fields: ['commonName'] }], removed: [], rejected: [] }));
  await act(async () => gate.resolve()); await waitFor(() => runs().length === 1);
  expect(flyBuiltDesign).toHaveBeenCalledOnce();
});

it('round9 New discards a pending build even if an old state writer returns', async () => {
  held.build = true; await open(`&motor=${motor.motorId}`);
  await waitFor(() => vi.mocked(applyImportPlan).mock.calls.length === 1);
  const [plan, sinks] = vi.mocked(applyImportPlan).mock.calls[0]!;
  await newDesign(); held.build = false;
  await act(async () => { sinks.history.reset(plan.snapshot.tree); sinks.setMountMotors(plan.snapshot.mountMotors); sinks.setMeasured({ massKg: 0.2, cgM: null }); });
  await settle(); expect(flyBuiltDesign).not.toHaveBeenCalled();
});

it('round9 document generation supersedes the same motor pending build', async () => {
  held.build = true; await open(`&motor=${motor.motorId}`);
  await waitFor(() => vi.mocked(applyImportPlan).mock.calls.length === 1);
  const [old] = vi.mocked(applyImportPlan).mock.calls[0]!;
  const real = await vi.importActual<typeof import('./services/importApply.js')>('./services/importApply.js');
  // A new document can carry the identical tree and motor records. Keep that
  // identity at the apply seam so only document ownership distinguishes it.
  vi.mocked(applyImportPlan).mockImplementationOnce((plan, sinks) => real.applyImportPlan({ ...plan, snapshot: { ...old.snapshot, measured: { massKg: 0.2, cgM: null } } }, sinks));
  held.build = false;
  const picker = host.querySelector<HTMLInputElement>('[aria-label="Open a design file"]')!;
  Object.defineProperty(picker, 'files', { configurable: true, value: [new File([exportOrk({ name: 'Replacement document', tree: defaultTree() })], 'replacement.ork')] });
  await act(async () => picker.dispatchEvent(new Event('change', { bubbles: true })));
  await waitFor(() => vi.mocked(applyImportPlan).mock.calls.length === 2);
  await settle(); expect(flyBuiltDesign).not.toHaveBeenCalled();
});

function linkRef() { return { designation: motor.designation, manufacturer: motor.manufacturerAbbrev,
  diameter: motor.diameter / 1000, length: motor.length / 1000, delay }; }
async function round10File(kind: 'empty' | 'occupied' | 'same-stage' | 'two-stage', pad = false, stored = false) {
  const tree = defaultTree(); const mount = motorMounts(tree)[0]!;
  const motors: Record<string, ReturnType<typeof linkRef>> = {};
  if (kind === 'occupied') { motors[mount.id!] = linkRef(); stages(tree)[0]!.nozzleExitDiameter = 0.009; }
  if (kind === 'same-stage') {
    const body = stages(tree)[0]!.children!.find(n => n.type === 'bodytube')!;
    body.children!.push({ type: 'podset', id: 'pods', instanceCount: 1, children: [{ type: 'bodytube', id: 'pod-body', length: 0.15, outerRadius: 0.012, children: [{ ...mount, id: 'pod-mount' }] }] }); motors['pod-mount'] = linkRef();
  }
  if (kind === 'two-stage') {
    tree.components = [{ type: 'stage', id: 'sustainer', children: stages(tree)[0]!.children },
      { type: 'stage', id: 'booster', children: [{ ...mount, id: 'booster-mount' }] }];
    motors[mount.id!] = linkRef();
  }
  let xml = exportOrk({ name: 'Round10', tree, motors, launch: DEFAULT_CONDITIONS, configs: [{ id: 'c1', name: null, isDefault: true, motors }], activeConfigId: 'c1',
    ...(stored ? { flightData: { c1: { runId: 'stored-r10', maxAltitude: 123, aeroModel: 'classic' as const } } } : {}) });
  if (pad) xml = xml.replace('</rocket>', '<measuredpadmass configid="c1">0.5</measuredpadmass></rocket>');
  return encodeShareFragment(xml);
}
it('round10 occupied applies the original motors before synchronous assignment', async () => {
  held.build = true;
  await open('&motor=' + motor.motorId, await round10File('occupied', true));
  await waitFor(() => vi.mocked(applyImportPlan).mock.calls.length === 1);
  const pre = vi.mocked(applyImportPlan).mock.calls[0]![0].snapshot;
  expect(Object.values(pre.mountMotors)[0]).toMatchObject({ padMassKg: 0.5 });
  expect(Object.values(pre.mountMotors)[0]!.spec.ejectionDelay).toBe(delay);
  await waitFor(() => Object.values(session().mountMotors ?? {}).length === 1);
  expect(Object.values(session().mountMotors)[0]).toMatchObject({ padMassKg: 0.5, spec: { ejectionDelay: defaultDelay(motor) ?? 0 } });
});
it.each(['empty', 'same-stage', 'two-stage'] as const)('round10 pre-injection pad mass %s', async kind => {
  held.build = true;
  await open('&motor=' + motor.motorId, await round10File(kind, true));
  await waitFor(() => vi.mocked(applyImportPlan).mock.calls.length === 1);
  const p = vi.mocked(applyImportPlan).mock.calls[0]![0];
  const motors = p.snapshot.mountMotors;
  if (kind === 'empty') {
    expect(Object.values(motors).some(m => m.padMassKg !== undefined)).toBe(false);
    expect(p.note.group.lines.some(n => n.kind === 'I16.pad-mass-dropped' && n.tier === 'caution')).toBe(true);
  } else {
    const weighed = Object.values(motors).find(m => m.padMassKg === 0.5)!;
    expect(weighed).toBeDefined();
    const { padMassSetKey } = await import('./services/configSync.js');
    expect(weighed.padMassWeighedWith).not.toBe(padMassSetKey(p.snapshot.tree, motors, p.unmatchedRefs));
  }
});
it.each([true, false])('round10 whole-stage published exits known=%s', async known => {
  held.build = true; let calls = 0;
  vi.mocked(nozzleForMotorId).mockImplementation(async () => ++calls === 2 && !known ? null : ({ exitDiameterM: 0.006 } as Awaited<ReturnType<typeof nozzleForMotorId>>));
  await open('&motor=' + motor.motorId, await round10File('same-stage'));
  await waitFor(() => vi.mocked(applyImportPlan).mock.calls.length === 1);
  const p = vi.mocked(applyImportPlan).mock.calls[0]![0];
  const d = stages(p.snapshot.tree)[0]!.nozzleExitDiameter;
  if (known) expect(d).toBeCloseTo(Math.sqrt(2) * 0.006, 10);
  else expect(d == null).toBe(true);
  const prepared = vi.mocked(planImport).mock.calls.at(-1)![0];
  expect(prepared.configs![0]!.nozzles).toBeUndefined();
  const raw = stages(prepared.tree)[0]!.nozzleExitDiameter;
  if (known) expect(raw).toBeCloseTo(Math.sqrt(2) * 0.006, 10);
  else expect(raw == null).toBe(true);
  expect(p.snapshot.savedConfigs[0]!.nozzles).toBeUndefined();
});
it('round10 stored empty configuration retains its flown label', async () => {
  held.build = true;
  await open('&motor=' + motor.motorId, await round10File('empty', false, true));
  await waitFor(() => runs().length === 1);
  expect(runs()[0]).toMatchObject({ flightConfig: 'No motors', importedConfigVerified: true });
});
it('round10 generation comparison alone rejects an obsolete pending stamp', async () => {
  held.build = true; await open('&motor=' + motor.motorId);
  await waitFor(() => vi.mocked(applyImportPlan).mock.calls.length === 1);
  const ref = held.refs.find(r => r.current && typeof r.current === 'object' && 'gen' in r.current && 'mountId' in r.current)!;
  expect(ref).toBeDefined();
  (ref.current as { gen: number }).gen--;
  held.build = false;
  await act(async () => vi.mocked(applyImportPlan).mock.calls[0]![1].setMeasured({ massKg: 0.2, cgM: null }));
  await settle(); expect(flyBuiltDesign).not.toHaveBeenCalled();
});

async function questionFile(otherMount = false) {
  let xml = '<openrocket version="1.10"><rocket><name>Inactive question</name><motorconfiguration configid="a" default="true"/><motorconfiguration configid="b"/><subcomponents><stage><subcomponents><bodytube><length>0.5</length><radius>0.016</radius><thickness>0.001</thickness><motormount><motor configid="b"><manufacturer>Enerjet</manufacturer><designation>F67</designation><diameter>0.0286</diameter><length>0.127</length><delay>9</delay></motor></motormount></bodytube></subcomponents></stage></subcomponents></rocket></openrocket>';
  if (otherMount) xml = xml.replace('<motor configid="b">', '<motor configid="a">').replace('<motormount>', '<motormount/><subcomponents><innertube><length>0.15</length><outerradius>0.015</outerradius><motormount>').replace('</motormount></bodytube>', '</motormount></innertube></subcomponents></bodytube>');
  return encodeShareFragment(xml);
}
it.each([false, true])('round10 inactive configuration or other-mount question %s motor question stops the read', async otherMount => {
  await open('&motor=' + motor.motorId, await questionFile(otherMount)); await settle();
  expect(host.textContent).toContain("file's motors need a choice first");
  expect(loadMotorForMount).not.toHaveBeenCalled();
  expect(flyBuiltDesign).not.toHaveBeenCalled();
});
it('round10 launch guard holds a question opened at apply', async () => {
  // Isolate the launch guard from the earlier read gate.
  vi.mocked(collectOpenMotorIdentities).mockReturnValueOnce([]);
  await open('&motor=' + motor.motorId, await questionFile()); await settle(); await settle();
  expect(loadMotorForMount).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Enerjet');
  expect(flyBuiltDesign).not.toHaveBeenCalled();
});
it('round10 replacing a different occupied motor drops its weighing', async () => {
  const other = getCatalogue().find(m => m.diameter === 18 && m.motorId !== motor.motorId && m.designation !== motor.designation)!;
  expect(other).toBeDefined();
  vi.mocked(nozzleForMotorId).mockResolvedValue({ exitDiameterM: 0.006 } as Awaited<ReturnType<typeof nozzleForMotorId>>);
  held.build = true;
  await open('&motor=' + other.motorId, await round10File('occupied', true));
  await waitFor(() => Object.values(session().mountMotors ?? {}).some(m => (m as { meta: { motorId: string } }).meta.motorId === other.motorId));
  expect(Object.values(session().mountMotors).some(m => (m as { padMassKg?: number }).padMassKg !== undefined)).toBe(false);
  await waitFor(() => stages(session().tree)[0]!.nozzleExitDiameter === 0.006);
  expect(stages(session().tree)[0]!.nozzleExitDiameter).toBeCloseTo(0.006, 10);
  expect(Object.values(vi.mocked(applyImportPlan).mock.calls[0]![0].snapshot.mountMotors)[0]).toMatchObject({ meta: { motorId: motor.motorId }, padMassKg: 0.5 });
});

it('round10 unresolved occupied reference is applied before manual adoption', async () => {
  held.build = true;
  vi.mocked(matchImportedMotor).mockResolvedValueOnce({ note: 'File curve unavailable' });
  await open('&motor=' + motor.motorId, await round10File('occupied', true));
  await waitFor(() => Object.values(session().mountMotors ?? {}).length === 1);
  const applied = vi.mocked(applyImportPlan).mock.calls[0]![0];
  expect(Object.keys(applied.snapshot.mountMotors)).toHaveLength(0);
  expect(Object.values(applied.unmatchedRefs)[0]).toMatchObject({ padMassKg: 0.5, designation: motor.designation });
  expect(Object.values(session().mountMotors)[0]).toMatchObject({ padMassKg: 0.5 });
  expect(session().unmatchedRefs ?? {}).toEqual({});
});
