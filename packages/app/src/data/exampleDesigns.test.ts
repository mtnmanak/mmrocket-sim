// @vitest-environment happy-dom
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { EXAMPLE_DESIGNS, loadExampleFile } from './exampleDesigns.js';
import { effectiveAero, type AeroChoice } from '../prefs/aeroChoice.js';
import { DEFAULT_PREFS } from '../prefs/preferences.js';
import { openDesignFile } from '../services/designFile.js';
import { loadBundledPresets, linkedPreset } from '../services/presets.js';
import type { ComponentNode } from '@online-openrocket/engine';
import { findParent, motorMounts, mountMotorCount } from '../tree/treeModel.js';
import { simulateFile } from '../services/simulateFile.js';
import { planImport, resolveImportMotors } from '../services/importApply.js';
import { DEFAULT_CONDITIONS } from '../services/launchConditions.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import { statedWeightTextFor } from '../services/unitText.js';

afterEach(() => { vi.unstubAllGlobals(); });
const assetPath = (name: string) => resolve('src/data/examples', name);
const bytes = (name: string) => readFileSync(assetPath(name));
const flatten = (nodes: ComponentNode[]): ComponentNode[] => nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);

it('ships six small archives and imports their explanations and catalogue parts', async () => {
  expect(EXAMPLE_DESIGNS.map(e => e.id)).toEqual([
    'minimum-diameter', 'dual-deploy', 'two-stage', 'cluster', 'boattail', 'freeform',
  ]);
  const presets = await loadBundledPresets();
  let total = 0;
  for (const example of EXAMPLE_DESIGNS) {
    const data = bytes(example.fileName);
    expect(data.subarray(0, 2).toString()).toBe('PK');
    // Vite's inline limit keeps each archive inside its own precached lazy chunk.
    expect(data.byteLength).toBeLessThan(4096);
    total += statSync(assetPath(example.fileName)).size;
    const imported = await openDesignFile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), example.fileName, { presets });
    expect(imported.name).toBe(example.name);
    expect(imported.notes).toEqual([]);
    const nodes = flatten(imported.tree.components);
    for (const mount of motorMounts(imported.tree).filter(n => n.type === 'innertube')) {
      const parent = findParent(imported.tree, mount.id!);
      if (parent && parent !== 'stage' && parent.type === 'bodytube') {
        expect(Number(mount['outerRadius']), `${example.id}: mount fits the body cavity`).toBeLessThanOrEqual(
          Number(parent['outerRadius']) - Number(parent['thickness']),
        );
      }
    }
    if (example.id === 'boattail') {
      const tail = nodes.find(n => n.type === 'transition')!;
      const mount = motorMounts(imported.tree)[0]!;
      expect(Number(mount['outerRadius']), 'mount clears the boattail exit').toBeLessThanOrEqual(Number(tail['aftRadius']) - Number(tail['thickness']));
    }
    expect(nodes.some(n => String(n['comment'] ?? '').includes(example.explanation))).toBe(true);
    expect(nodes.filter(n => linkedPreset(n, presets)).length).toBeGreaterThanOrEqual(3);
    if (example.id === 'two-stage') expect(imported.tree.components).toHaveLength(2);
    if (example.id === 'cluster') expect(mountMotorCount(imported.tree, motorMounts(imported.tree)[0]!.id!)).toBe(3);
    if (example.id === 'boattail') expect(nodes.some(n => n.type === 'transition' && Number(n['foreRadius']) > Number(n['aftRadius']))).toBe(true);
    if (example.id === 'freeform') expect(nodes.some(n => n.type === 'freeformfinset' && n['crossSection'] === 'rounded')).toBe(true);
    if (example.id === 'minimum-diameter') {
      const mount = motorMounts(imported.tree)[0]!;
      expect(mount.type).toBe('bodytube');
      // Half the catalogue's 18.034 mm bore, allowing decimal conversion rounding.
      expect(Number(mount['outerRadius']) - Number(mount['thickness'])).toBeCloseTo(0.009017, 6);
    }
  }
  expect(total).toBeLessThan(24000);
});

it('loads only the selected asset and preserves its bytes for the file door', async () => {
  const example = EXAMPLE_DESIGNS[0]!;
  const data = bytes(example.fileName);
  const fetch = vi.fn(async () => new Response(data, { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const file = await loadExampleFile(example);
  expect(file.name).toBe(example.fileName);
  expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(data));
  expect(fetch).toHaveBeenCalledOnce();
});

it('reports a missing asset and honours cancellation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
  await expect(loadExampleFile(EXAMPLE_DESIGNS[0]!)).rejects.toThrow('could not be loaded');
  const fetch = vi.fn(async () => new Response(bytes('minimum-diameter.ork'), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const abort = new AbortController(); abort.abort();
  await expect(loadExampleFile(EXAMPLE_DESIGNS[0]!, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
});

it('ignores a cancelled asset import before making a file request', async () => {
  const abort = new AbortController();
  const asset = vi.fn(async () => { abort.abort(); return { default: 'example-url' }; });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await expect(loadExampleFile({ ...EXAMPLE_DESIGNS[0]!, asset }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(fetch).not.toHaveBeenCalled();
});

it('does not return bytes that arrive after cancellation', async () => {
  const abort = new AbortController();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => { abort.abort(); return new ArrayBuffer(0); } })));
  await expect(loadExampleFile(EXAMPLE_DESIGNS[0]!, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
});

it.each(['database', 'curve'] as const)('keeps geometry and reports missing motor %s data without substitution', async missing => {
  const data = bytes('cluster.ork');
  const imported = await openDesignFile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), 'cluster.ork', { presets: await loadBundledPresets() });
  const resolved = await resolveImportMotors(imported, async () => ({ missing, note: 'The example motor could not be loaded.' }));
  const plan = planImport(imported, resolved, { launch: DEFAULT_CONDITIONS, text: statedWeightTextFor(INITIAL_UNITS) });
  expect(plan.snapshot.tree.name).toBe('Three-motor cluster');
  expect(plan.snapshot.mountMotors).toEqual({});
  expect(Object.keys(plan.unmatchedRefs)).toHaveLength(1);
  expect(plan.note.text).toContain('could not be loaded');
});

it.each(['eb', 'kbf', 'auto', 'supersonic', 'hybrid'] as const)('flies every example on %s with bundled motors and sensible recovery', async (choice: AeroChoice) => {
  const fetch = vi.fn(async () => { throw new TypeError('offline'); });
  vi.stubGlobal('fetch', fetch);
  for (const example of EXAMPLE_DESIGNS) {
    const out = await simulateFile(bytes(example.fileName), example.fileName, {
      aero: { ...effectiveAero(DEFAULT_PREFS, choice), autoSupersonic: false },
    });
    expect(out.plan.unmatchedRefs, example.id).toEqual({});
    expect(out.build.motorFailures, example.id).toEqual([]);
    expect(out.build.info.warningTexts, example.id).toEqual([]);
    expect(out.run.simWarnings, example.id).toEqual([]);
    expect(out.run.commentLevels?.filter(l => l !== 'info'), `${example.id}: ${out.run.comments}`).toEqual([]);
    expect(out.result.summary.maxAltitude, example.id).toBeGreaterThan(100);
    expect(out.run.safeLandingRate, example.id).toBe(true);
    expect(out.run.safeDeployment, example.id).toBe(true);
    expect(out.run.safeLiftoffSpeed, example.id).toBe(true);
    expect(out.run.safeThrustToWeight, example.id).toBe(true);
    expect(out.run.deployments.length, example.id).toBeGreaterThan(0);
    for (const deployment of out.run.deployments) {
      expect(deployment.altitude, example.id).toBeGreaterThan(0);
      expect(deployment.openingOk, example.id).toBe(true);
    }
    for (const branch of out.run.branches ?? []) {
      expect(branch.safeLandingRate, `${example.id}: ${branch.name}`).toBe(true);
      expect(branch.deployments.length, `${example.id}: ${branch.name}`).toBeGreaterThan(0);
    }
    if (example.id === 'dual-deploy') {
      expect(out.run.deployments).toHaveLength(2);
      expect(out.run.deployments[0]!.time).toBeLessThan(out.run.deployments[1]!.time);
    }
    if (example.id === 'two-stage') expect(out.run.branches).toHaveLength(1);
  }
  expect(fetch).not.toHaveBeenCalled();
}, 120000);
