// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentNode, RocketTree } from '@online-openrocket/engine';
import { App } from './App.js';
import { PrefsProvider } from './prefs/PrefsContext.js';
import type { MotorPicker } from './components/MotorPicker.js';
import type { MountMotor, SavedConfig } from './model/design.js';
import { DEFAULT_CONDITIONS } from './services/launchConditions.js';
import type { SessionState } from './services/session.js';
import { APP_VERSION } from './version.js';
import { getCatalogue } from './services/motorDb.js';
import { loadMotorForMount } from './services/motorLoad.js';
import { bundleHasCurve, defaultDelay } from './services/thrustcurve.js';
import { INITIAL_UNITS } from './prefs/units.js';
import type { TreeHistory } from './hooks/useTreeHistory.js';
import { updateNode } from './tree/treeModel.js';
import { padMassSetKey } from './services/configSync.js';
import type { OrkMotorRef } from './services/orkFile.js';
import type { Notice } from './components/NoticeBar.js';
import { reconcileIncludedMotor } from './services/statedLaunchWeight.js';
import { captureStageMass } from './services/stageMassOverrides.js';

const held = vi.hoisted(() => ({ picks: new Map<string, ComponentProps<typeof MotorPicker>>(), history: null as TreeHistory | null,
  notices: [] as Notice[] }));
vi.mock('./components/NoticeBar.js', async original => {
  const real = await original<typeof import('./components/NoticeBar.js')>();
  return { ...real, NoticeBar: (props: ComponentProps<typeof real.NoticeBar>) => {
    held.notices = props.notices;
    return <real.NoticeBar {...props} />;
  } };
});
vi.mock('./hooks/useTreeHistory.js', async original => {
  const real = await original<typeof import('./hooks/useTreeHistory.js')>();
  return { ...real, useTreeHistory: (...args: Parameters<typeof real.useTreeHistory>) => {
    const history = real.useTreeHistory(...args); held.history = history; return history;
  } };
});
vi.mock('./components/MotorPicker.js', () => ({ MotorPicker: (props: ComponentProps<typeof MotorPicker>) => {
  held.picks.set(props.primaryControlId!, props);
  return <button id={props.primaryControlId} onClick={() => props.onSelect(picked.label, picked.spec, picked.meta)}>Test pick</button>;
} }));
vi.mock('./services/catalogueAutoCheck.js', async original => ({
  ...await original<typeof import('./services/catalogueAutoCheck.js')>(), catalogueCheckSettled: async () => {},
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const context = new Proxy({}, { get: (_t, p) => p === 'measureText' ? () => ({ width: 0 }) : () => undefined });
HTMLCanvasElement.prototype.getContext = (() => context) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;
const key = 'online-openrocket.session.v1';
const db = (await Promise.all(getCatalogue().filter(m => m.diameter >= 74 && m.diameter <= 76)
  .map(async m => await bundleHasCurve(m.motorId) ? m : null))).find(m => m !== null)!;
const catalogueMotor = await loadMotorForMount(db, defaultDelay(db) ?? 0, { units: INITIAL_UNITS });
let picked: typeof catalogueMotor;
let host: HTMLDivElement;
let root: Root;
const mount = (id: string, diameter = 0.075, extra: Partial<ComponentNode> = {}): ComponentNode => ({
  type: 'innertube', id, name: `MMT ${id}`, length: 1.5, outerRadius: diameter / 2 + 0.001,
  thickness: 0.001, motorMount: true, motorOverhang: 0.006, ...extra,
});
const tree = (mounts = [mount('1'), mount('2'), mount('3'), mount('4')]): RocketTree => ({
  name: 'Four separate mounts', components: [{ type: 'stage', id: 's', name: 'Sustainer', children: [
    { type: 'bodytube', id: 'body', length: 2, outerRadius: 0.16, thickness: 0.002, children: mounts },
  ] }],
});
const record = (extra: Partial<MountMotor> = {}): MountMotor => ({ ...catalogueMotor,
  ignition: { event: 'automatic', delay: 0 }, ...extra });
const stored = () => JSON.parse(localStorage.getItem(key)!, (_key, value: unknown) => value === 'Infinity' ? Infinity : value) as SessionState;
function flush() { window.dispatchEvent(new Event('pagehide')); }
const offer = () => host.querySelector('.other-mount-offer');
const fileNotice = () => {
  const notice = held.notices.find(n => n.id === 'file-note');
  if (!notice) return undefined;
  const { onDismiss: _dismiss, ...content } = notice;
  return content;
};
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  expect(button, text).toBeDefined();
  await act(async () => { button!.focus(); button!.click(); });
}
async function open(design = tree(), motors: Record<string, MountMotor> = {}, configs: SavedConfig[] = [], refs: Record<string, OrkMotorRef> = {}, layered = false) {
  localStorage.setItem(key, JSON.stringify({ tree: design, mountMotors: motors,
    launch: DEFAULT_CONDITIONS, appVersion: APP_VERSION, savedAt: Date.now(),
    savedConfigs: configs, activeConfigId: configs[0]?.id ?? null, unmatchedRefs: refs,
    ...(layered ? { configLayers: 1, emptyConfigVersion: 1 } : {}) }, (_key, value: unknown) => value === Infinity ? 'Infinity' : value));
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>));
  await click('Motors & Configuration');
}
async function pick(id = '1') {
  const props = held.picks.get(`cfg-mount-${id}-motor`)!;
  expect(props).toBeDefined();
  await act(async () => props.onSelect(picked.label, picked.spec, picked.meta));
  act(flush);
}
beforeEach(() => {
  localStorage.clear(); held.picks.clear(); picked = catalogueMotor;
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ tourOff: true }));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline test'); }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { act(flush); await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('126 offers the other three mounts after a pick, loads once and undoes only those three', async () => {
  await open();
  expect(offer()).toBeNull();
  await pick();
  expect(offer()?.textContent).toContain('other 3 mounts that fit');
  await click('Load into 3 mounts'); act(flush);
  expect(Object.keys(stored().mountMotors!)).toEqual(['1', '2', '3', '4']);
  for (const mm of Object.values(stored().mountMotors!)) expect(mm.spec).toEqual(picked.spec);
  await click('Undo'); act(flush);
  expect(Object.keys(stored().mountMotors!)).toEqual(['1']);
  expect(stored().mountMotors!['1']!.spec).toEqual(picked.spec);
});

it('126 lists narrow, short and different-bore skips, and names every replacement', async () => {
  await open(tree([mount('1'), mount('2'), mount('narrow', 0.038),
    mount('short', 0.075, { maxMotorLength: picked.spec.length / 2 }), mount('wide', 0.098)]),
  { '2': record({ label: 'Previous motor', spec: { ...picked.spec, designation: 'Previous motor' },
    meta: { label: 'Previous motor', exMotorId: 'ex:previous-test-motor' } }) });
  act(flush);
  const replaced = stored().mountMotors!['2']!.label;
  await pick();
  expect(offer()?.textContent).toContain(`MMT 2 (replaces ${replaced})`);
  expect(offer()?.textContent).toContain('MMT narrow (too narrow for');
  expect(offer()?.textContent).toContain('MMT short (too short for');
  expect(offer()?.textContent).toContain('MMT wide (a different bore)');
  await click('Load into 1 mount'); act(flush);
  expect(Object.keys(stored().mountMotors!)).toEqual(['1', '2']);
});

it.each(['single', 'other stage', 'parallel stage', 'identical'] as const)('126 offers nothing for %s', async kind => {
  const design = tree(kind === 'single' ? [mount('1')] : [mount('1'), mount('2')]);
  let motors: Record<string, MountMotor> = {};
  if (kind === 'other stage' || kind === 'parallel stage') {
    const other: ComponentNode = { type: kind === 'other stage' ? 'stage' : 'parallelstage', id: 'other',
      children: [mount('other')] };
    design.components[0]!.children![0]!.children = [mount('1')];
    if (kind === 'other stage') design.components.push(other);
    else design.components[0]!.children!.push(other);
  }
  if (kind === 'identical') motors = { '2': record() };
  await open(design, motors); await pick();
  expect(offer()).toBeNull();
});

it('126 keeps each ignition, Auto policy, overhang and mount-owned weighing, and the other configuration', async () => {
  picked = { ...catalogueMotor, spec: { ...catalogueMotor.spec, ejectionDelay: 5 },
    meta: { ...catalogueMotor.meta, availableDelays: [5, 7] } };
  const old = record({ label: 'Old motor', spec: { ...picked.spec, ejectionDelay: 2 },
    meta: { ...picked.meta, autoDelay: true }, ignition: { event: 'burnout', delay: 1.7 },
    padMassKg: 7, padMassWeighedWith: 'weighed-here' });
  old.spec = { ...old.spec, thrusts: old.spec.thrusts.map(t => t * 0.9) };
  const configs: SavedConfig[] = [
    { id: 'a', name: 'Editing', isDefault: true, motors: { '2': old } },
    { id: 'b', name: 'Other', isDefault: false, motors: { '3': old } },
  ];
  await open(tree(), { '2': old }, configs); await pick();
  const before = stored();
  await click('Load into 3 mounts'); act(flush);
  const after = stored();
  expect(after.mountMotors!['2']).toMatchObject({ ignition: old.ignition, meta: { autoDelay: true }, padMassKg: 7 });
  expect(after.mountMotors!['2']!.spec.ejectionDelay).toBe(picked.spec.ejectionDelay);
  expect(after.mountMotors!['3']).not.toHaveProperty('padMassKg');
  // The existing nozzle follower recomputes the stage's summed exit area.
  // The physical mounts, including their own overhang, stay unchanged.
  expect(after.tree.components[0]!.children).toEqual(before.tree.components[0]!.children);
  expect(after.savedConfigs!.find(c => c.id === 'b')).toEqual(before.savedConfigs!.find(c => c.id === 'b'));
  await click('Undo'); act(flush);
  expect(stored().mountMotors).toEqual(before.mountMotors);
});

it('126 loads an EX motor with the same id and flown curve', async () => {
  picked = { ...catalogueMotor, label: 'My EX', meta: { label: 'My EX', exMotorId: 'ex:my-test' } };
  await open(); await pick(); await click('Load into 3 mounts'); act(flush);
  expect(stored().mountMotors!['4']).toMatchObject({ meta: { exMotorId: 'ex:my-test' }, spec: picked.spec });
});

it.each(['dismiss', 'delay', 'remove', 'another pick'] as const)('126 retires the prompt on %s', async change => {
  await open(); await pick(); expect(offer()).not.toBeNull();
  if (change === 'dismiss') await click('No thanks');
  if (change === 'remove') {
    const remove = host.querySelector<HTMLButtonElement>('#cfg-mount-1 button[title]')!;
    await act(async () => remove.click());
  }
  if (change === 'delay') {
    const input = host.querySelector<HTMLInputElement>('#ejection-delay-1')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '8'); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('blur', { bubbles: true }));
    });
  }
  if (change === 'another pick') { await pick('2'); expect(host.querySelector('#cfg-mount-1 .other-mount-offer')).toBeNull(); return; }
  expect(offer()).toBeNull();
});

it('126 offers a same motor with a different delay and leaves identical neighbours alone', async () => {
  await open(tree(), { '2': record(), '3': record({ spec: { ...picked.spec, ejectionDelay: 2 } }) });
  await pick();
  expect(offer()?.textContent).toContain('other 2 mounts');
  expect(offer()?.textContent).not.toContain('MMT 2');
  await click('Load into 2 mounts'); act(flush);
  expect(stored().mountMotors!['3']!.spec.ejectionDelay).toBe(picked.spec.ejectionDelay);
});

it('126 does not copy the source mount weighing, and restores a rekeyed unmatched-motor weighing on Undo', async () => {
  const design = tree();
  const refs: Record<string, OrkMotorRef> = { '2': { designation: picked.spec.designation,
    manufacturer: picked.meta.manufacturer!, diameter: picked.spec.diameter, length: picked.spec.length,
    delay: picked.spec.ejectionDelay, mountId: '2', autoDelay: true } };
  const primary = record({ padMassKg: 8, padMassWeighedWith: padMassSetKey(design, { '1': record() }, refs) });
  await open(design, { '1': primary }, [], refs); await pick();
  const before = stored();
  expect(offer()?.textContent).toContain(`replaces ${picked.spec.designation}`);
  await click('Load into 3 mounts'); act(flush);
  for (const id of ['2', '3', '4']) expect(stored().mountMotors![id]).not.toHaveProperty('padMassKg');
  expect(stored().mountMotors!['2']!.meta.autoDelay).toBe(picked.spec.ejectionDelay === Infinity ? false : true);
  await click('Undo'); act(flush);
  expect(stored().mountMotors).toEqual(before.mountMotors);
  expect(stored().unmatchedRefs).toEqual(before.unmatchedRefs);
});

it('126 retires the prompt when a design edit makes its fit stale, including after design Undo', async () => {
  await open(); await pick();
  expect(offer()).not.toBeNull();
  await act(async () => held.history!.setTree(updateNode(held.history!.tree, '2', { maxMotorLength: 0 })));
  expect(offer()).toBeNull();
  await act(async () => held.history!.undo());
  expect(offer()).toBeNull();
});

it('126 retires an offer on configuration switch and never applies it to that configuration', async () => {
  await open(tree(), {}, [
    { id: 'a', name: 'First', isDefault: true, motors: {} },
    { id: 'b', name: 'Second', isDefault: false, motors: {} },
  ]);
  await pick(); expect(offer()).not.toBeNull();
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Flight configuration"]')!;
  await act(async () => { select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  act(flush);
  expect(offer()).toBeNull();
  expect(stored().activeConfigId).toBe('b');
  expect(stored().mountMotors).toEqual({});
});

it.each([true, false])('round 2 keeps target Auto %s through the bulk assignment', async auto => {
  picked = { ...catalogueMotor, spec: { ...catalogueMotor.spec, ejectionDelay: 5 },
    meta: { ...catalogueMotor.meta, availableDelays: [5, 7], autoDelay: !auto } };
  await open(tree([mount('1'), mount('2'), mount('empty')]), {
    '2': record({ meta: { ...catalogueMotor.meta, autoDelay: auto },
      spec: { ...catalogueMotor.spec, ejectionDelay: 2, thrusts: catalogueMotor.spec.thrusts.map(t => t * 0.9) } }),
  });
  await pick(); await click('Load into 2 mounts'); act(flush);
  expect(stored().mountMotors!['2']!.meta.autoDelay).toBe(auto);
  expect(stored().mountMotors!.empty!.meta.autoDelay).toBe(!auto);
});

it('round 2 restores the active saved row references on Undo and reload', async () => {
  const refs: Record<string, OrkMotorRef> = { '2': { designation: picked.spec.designation,
    manufacturer: picked.meta.manufacturer!, diameter: picked.spec.diameter,
    length: picked.spec.length, delay: picked.spec.ejectionDelay, mountId: '2' } };
  await open(tree(), {}, [{ id: 'a', name: 'Editing', isDefault: true, motors: {},
    unmatched: [picked.spec.designation], unmatchedRefs: refs }], refs);
  await pick();
  const before = stored().savedConfigs!.find(c => c.id === 'a');
  expect(before!.unmatchedRefs).toEqual(refs);
  await click('Load into 3 mounts'); act(flush);
  expect(stored().savedConfigs!.find(c => c.id === 'a')).not.toHaveProperty('unmatchedRefs');
  await click('Undo'); act(flush);
  expect(stored().savedConfigs!.find(c => c.id === 'a')).toEqual(before);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<PrefsProvider><App /></PrefsProvider>)); act(flush);
  expect(stored().savedConfigs!.find(c => c.id === 'a')).toEqual(before);
  expect(stored().unmatchedRefs).toEqual(refs);
});

it('round 2 restores the file note and repair notice after Undo removes an adopted pad mass', async () => {
  const refs: Record<string, OrkMotorRef> = { '2': { designation: picked.spec.designation,
    manufacturer: picked.meta.manufacturer!, diameter: picked.spec.diameter,
    length: picked.spec.length, delay: picked.spec.ejectionDelay, mountId: '2', padMassKg: 8 } };
  await open(tree(), {}, [{ id: 'a', name: 'Editing', isDefault: true, motors: {},
    unmatched: [picked.spec.designation], unmatchedRefs: refs, motorLoadoutRefusal: 'Ambiguous imported motors.' }], refs);
  await pick();
  const fileNote = fileNotice();
  const repair = held.notices.find(n => n.id === 'motor-loadout-repaired:a');
  expect(repair).toBeDefined();
  await click('Load into 3 mounts'); act(flush);
  expect(held.notices.find(n => n.id === 'file-note')?.text).toContain('it sits under');
  expect(stored().mountMotors!['2']!.padMassKg).toBe(8);
  await click('Undo'); act(flush);
  expect(stored().mountMotors).not.toHaveProperty('2');
  expect(stored().unmatchedRefs).toEqual(refs);
  expect(fileNotice()).toEqual(fileNote);
  expect(held.notices.find(n => n.id === 'motor-loadout-repaired:a')).toEqual(repair);
});

it.each(['Undo', 'No thanks', 'Dismiss'])('round 2 returns focus to the source picker after %s', async action => {
  await open(); await pick();
  if (action !== 'No thanks') {
    await click('Load into 3 mounts');
    expect(document.activeElement?.textContent).toBe('Undo');
  }
  await click(action);
  expect(offer()).toBeNull();
  expect(document.activeElement).toBe(host.querySelector('#cfg-mount-1-motor'));
});

it.each([false, true])('round 3 retires the offer or receipt on ignition edits (loaded %s)', async loaded => {
  await open(); await pick();
  if (loaded) await click('Load into 3 mounts');
  const input = host.querySelector<HTMLSelectElement>('#ignition-1')!;
  await act(async () => { input.value = 'never'; input.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(offer()).toBeNull();
});

it.each(['ignition', 'all'])('round 3 retires the receipt on %s override reset', async kind => {
  const old = record();
  await open(tree(), { '2': old }, [{ id: 'a', name: 'Editing', isDefault: true, motors: { '2': old },
    ignitions: { '2': { event: 'never', delay: 0 } } }], {}, true);
  await pick(); await click('Load into 2 mounts');
  if (kind === 'all') {
    await click('Reset every override in this configuration');
    await click('Confirm reset every override');
  } else {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent === 'Reset to own setting' && b.parentElement?.querySelector('#ignition-2'))!;
    expect(button).toBeDefined();
    await act(async () => button.click());
  }
  expect(offer()).toBeNull();
});

it('round 3 Undo does not resurrect a dismissed post-load file note or repair notice', async () => {
  const refs: Record<string, OrkMotorRef> = { '2': { designation: picked.spec.designation,
    manufacturer: picked.meta.manufacturer!, diameter: picked.spec.diameter,
    length: picked.spec.length, delay: picked.spec.ejectionDelay, mountId: '2', padMassKg: 8 } };
  await open(tree(), {}, [{ id: 'a', name: 'Editing', isDefault: true, motors: {},
    unmatched: [picked.spec.designation], unmatchedRefs: refs, motorLoadoutRefusal: 'Ambiguous imported motors.' }], refs);
  await pick(); await click('Load into 3 mounts');
  const note = held.notices.find(n => n.id === 'file-note');
  const repair = held.notices.find(n => n.id === 'motor-loadout-repaired:a');
  expect(note?.onDismiss).toBeDefined(); expect(repair?.onDismiss).toBeDefined();
  await act(async () => { note!.onDismiss!(); repair!.onDismiss!(); });
  await click('Undo');
  expect(fileNotice()).toBeUndefined();
  expect(held.notices.find(n => n.id === 'motor-loadout-repaired:a')).toBeUndefined();
});

it('round 3 bulk load preserves a target fixed delay and defaults delayless motors to Auto', async () => {
  picked = { ...catalogueMotor, spec: { ...catalogueMotor.spec, ejectionDelay: 0 },
    meta: { ...catalogueMotor.meta, autoDelay: true, availableDelays: [5, 7, 10] } };
  await open(tree([mount('1'), mount('2'), mount('empty')]), { '2': record({
    meta: { ...catalogueMotor.meta, autoDelay: false }, spec: { ...catalogueMotor.spec, ejectionDelay: 7 } }) });
  await pick();
  // A different flown spec forces a replacement, even though the identity matches.
  // Keeping a valid fixed delay on an otherwise identical target needs no offer.
  expect(offer()?.textContent).not.toContain('MMT 2');
  await click('Load into 1 mount'); act(flush);
  expect(stored().mountMotors!['2']!.spec.ejectionDelay).toBe(7);
  picked = { ...picked, meta: { ...picked.meta, availableDelays: [] } };
  await pick(); await click('Load into 1 mount'); act(flush);
  expect(stored().mountMotors!['2']).toMatchObject({ meta: { autoDelay: true }, spec: { ejectionDelay: 0 } });
});

async function openRevisedRasaero(mass = 2) {
  const original = record({ spec: { ...catalogueMotor.spec, masses: [1, 0.5], cgX: 0.1 } });
  const design = tree();
  design.components[0] = { ...design.components[0]!, overrideMass: 10, overrideCGX: 1,
    overrideSubcomponentsMass: true, overrideSubcomponentsCG: true,
    overrideIncludesMotor: original.spec.designation,
    children: [{ ...mount('2'), type: 'bodytube', length: 2 }, mount('1')] };
  const backedOut = reconcileIncludedMotor(design, '2', { designation: original.spec.designation,
    launchMassKg: 1, lengthM: original.spec.length, cgXFromFrontM: original.spec.cgX },
  { mass: String, length: String })!.tree;
  await open(backedOut, { '2': original }, [{ id: 'a', name: 'RASAero', isDefault: true,
    motors: { '2': original }, stageMassOverrides: { s: captureStageMass(backedOut.components[0]!) } }]);
  picked = { ...original, spec: { ...original.spec, masses: [mass, mass / 2], cgX: 0.3 } };
  await pick();
}

it.each([2, 12])('round 4 Undo restores RASAero mass, CG and bookkeeping after a revised %s kg motor', async mass => {
  await openRevisedRasaero(mass);
  const before = stored();
  expect(before.tree.components[0]!.overrideMass).toBeCloseTo(9);
  await click('Load into 1 mount'); act(flush);
  const loaded = stored().tree.components[0]!;
  if (mass === 2) {
    expect(loaded.overrideMass).toBeCloseTo(8);
    expect(loaded.overrideCGX).not.toBeCloseTo(before.tree.components[0]!.overrideCGX as number);
  } else {
    for (const field of ['overrideMass', 'overrideCGX', 'overrideSubcomponentsMass', 'overrideSubcomponentsCG']) {
      expect(loaded).not.toHaveProperty(field);
    }
  }
  await click('Undo'); act(flush);
  expect(stored().mountMotors).toEqual(before.mountMotors);
  expect(captureStageMass(stored().tree.components[0]!)).toEqual(captureStageMass(before.tree.components[0]!));
  expect(stored().savedConfigs).toEqual(before.savedConfigs);
});

it.each(['overrideMass', 'overrideCGX', 'overrideSubcomponentsMass', 'overrideSubcomponentsCG',
  'overrideIncludesMotor', 'statedStageFigures'])('round 4 retires the receipt after editing %s', async field => {
  await openRevisedRasaero();
  await click('Load into 1 mount');
  const values: Record<string, unknown> = { overrideMass: 7, overrideCGX: 0.7,
    overrideSubcomponentsMass: false, overrideSubcomponentsCG: false,
    overrideIncludesMotor: 'Other motor', statedStageFigures: undefined };
  await act(async () => held.history!.setTree(updateNode(held.history!.tree, 's', { [field]: values[field] })));
  expect(offer()).toBeNull();
  await act(async () => held.history!.undo());
  expect(offer()).toBeNull();
});

it('round 4 Undo restores a silently retired stale included-motor mark', async () => {
  await openRevisedRasaero();
  await act(async () => held.history!.setTree(updateNode(held.history!.tree, 's', {
    overrideMass: undefined, overrideCGX: undefined, overrideSubcomponentsMass: undefined,
    overrideSubcomponentsCG: undefined, statedStageFigures: undefined,
    overrideIncludesMotor: picked.spec.designation,
  })));
  const before = held.history!.tree.components[0]!;
  await click('Load into 1 mount');
  expect(held.history!.tree.components[0]).not.toHaveProperty('overrideIncludesMotor');
  await click('Undo');
  expect(held.history!.tree.components[0]).toMatchObject(before);
});

it('round 4 Undo keeps unrelated stage edits and automatic nozzle following', async () => {
  await openRevisedRasaero();
  const before = stored();
  await click('Load into 1 mount');
  await act(async () => held.history!.setTree(updateNode(held.history!.tree, 's', {
    name: 'Renamed stage', overrideCD: 0.4, nozzleExitDiameter: 0.01,
  })));
  expect(offer()).not.toBeNull();
  await click('Undo'); act(flush);
  expect(captureStageMass(stored().tree.components[0]!)).toEqual(captureStageMass(before.tree.components[0]!));
  expect(stored().tree.components[0]).toMatchObject({ name: 'Renamed stage', overrideCD: 0.4 });
});
