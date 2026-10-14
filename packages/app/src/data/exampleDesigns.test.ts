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
import { absoluteStations } from '../tree/position.js';
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

it.each([
  ['minimum-diameter.ork', 1, [0.003]], ['freeform.ork', 1, [0.003]], ['two-stage.ork', 2, [0.01, 0.005]],
  ['dual-deploy.ork', 2, [0.15]], ['cluster.ork', 1, []], ['boattail.ork', 1, [0.025]],
] as const)('fits the packed recovery in %s ahead of its motors', async (fileName, count, masses) => {
  const data = bytes(fileName);
  const imported = await openDesignFile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), fileName, { presets: await loadBundledPresets() });
  const stations = [...absoluteStations(imported.tree).values()];
  const recovery = stations.filter(s => s.node.type === 'parachute');
  expect(recovery).toHaveLength(count);
  expect(stations.filter(s => s.node.type === 'masscomponent').map(s => s.node['mass']), 'placement preserves the assumed masses in kg').toEqual(masses);
  for (const packed of recovery) {
    const parent = packed.parent!;
    expect(parent.type).toBe('bodytube');
    const body = stations.find(s => s.node === parent)!;
    const radius = Number(packed.node['packedRadius']);
    const length = Number(packed.node['packedLength']);
    expect(radius).toBeGreaterThan(0);
    expect(length).toBeGreaterThan(0);
    expect(radius + Math.abs(Number(packed.node['radialPosition'] ?? 0)), 'packed radius clears the bore').toBeLessThanOrEqual(Number(parent['outerRadius']) - Number(parent['thickness']));
    // C-A3: reshape the original 12.5 mm radius x 25 mm bundle, not its volume.
    // Absolute tolerance 5e-13 m³ allows decimal serialization of the cylinder.
    expect(Math.PI * radius ** 2 * length).toBeCloseTo(Math.PI * 0.0125 ** 2 * 0.025, 12);
    expect(packed.start, 'packed front stays in the tube').toBeGreaterThanOrEqual(body.start);
    expect(packed.end, 'packed rear stays in the tube').toBeLessThanOrEqual(body.end);
    for (const obstacle of stations.filter(s => s !== packed && s.parent === parent && ['masscomponent', 'innertube', 'parachute'].includes(s.node.type))) {
      expect(packed.end <= obstacle.start || packed.start >= obstacle.end, `packed recovery clears ${obstacle.node.name}`).toBe(true);
    }
    const nose = stations.find(s => s.node.type === 'nosecone' && Math.abs(s.end - body.start) < 1e-9);
    if (nose) expect(packed.start, 'packed front clears the nose shoulder').toBeGreaterThanOrEqual(nose.end + Number(nose.node['shoulderLength']));
    for (const mount of motorMounts(imported.tree).filter(n => n === parent || parent.children?.includes(n))) {
      const motor = imported.motors[mount.id!]!;
      const station = stations.find(s => s.node === mount)!;
      expect(motor.length).toBeGreaterThan(0);
      expect(packed.end, 'packed rear clears the loaded motor').toBeLessThanOrEqual(station.end + Number(mount['motorOverhang'] ?? 0) - motor.length);
    }
  }
  for (const ballast of stations.filter(s => s.node.type === 'masscomponent')) {
    const body = stations.find(s => s.node === ballast.parent)!;
    expect(ballast.start, 'ballast front stays in the tube').toBeGreaterThanOrEqual(body.start);
    expect(ballast.end, 'ballast rear stays in the tube').toBeLessThanOrEqual(body.end);
    const nose = stations.find(s => s.node.type === 'nosecone' && Math.abs(s.end - body.start) < 1e-9);
    if (nose && Number(nose.node['shoulderThickness']) >= Number(nose.node['shoulderRadius'])) {
      expect(ballast.start, 'ballast clears the solid nose shoulder').toBeGreaterThanOrEqual(nose.end + Number(nose.node['shoulderLength']));
    }
  }
});

it.each(EXAMPLE_DESIGNS)('uses cuttable stock or explains the extended airframe in $id', async example => {
  const data = bytes(example.fileName);
  const presets = await loadBundledPresets();
  const imported = await openDesignFile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), example.fileName, { presets });
  for (const tube of flatten(imported.tree.components).filter(n => ['bodytube', 'innertube'].includes(n.type))) {
    const stock = linkedPreset(tube, presets)!;
    expect(stock, `${example.id}: tube has bundled stock`).toBeDefined();
    // Catalogue dimensions are SI decimals; allow their serialization rounding.
    expect(Number(tube['outerRadius']) * 2).toBeCloseTo(Number(stock.outsideDiameter), 9);
    expect((Number(tube['outerRadius']) - Number(tube['thickness'])) * 2).toBeCloseTo(Number(stock.insideDiameter), 9);
    expect(tube['density']).toBe(stock.material?.density);
    if (Number(tube['length']) > Number(stock.length) + 1e-9) {
      expect(example.id).toBe('dual-deploy');
      expect(tube.type).toBe('bodytube');
      expect(stock.manufacturer).toBe('Estes');
      expect(stock.partNo).toBe('30615');
      expect(tube['length']).toBe(0.55);
      expect(stock.length).toBe(0.3429);
      expect(tube['comment']).toContain('Assumed 550 mm continuous airframe');
      expect(tube['comment']).toContain('342.9 mm stock length');
      expect(tube['comment']).toContain('cannot be cut from that stock');
      expect(tube['comment']).toContain('No joining coupler is modeled');
    } else {
      expect(Number(tube['length']), `${example.id}: tube can be cut from its linked stock`).toBeLessThanOrEqual(Number(stock.length) + 1e-9);
    }
  }
});

it('imports the dual-deploy fins as custom plywood at their assumed density', async () => {
  const data = bytes('dual-deploy.ork');
  const imported = await openDesignFile(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), 'dual-deploy.ork', { presets: await loadBundledPresets() });
  const fins = flatten(imported.tree.components).find(n => n.type === 'trapezoidfinset')!;
  expect(fins.name).toBe('Rounded plywood fins');
  expect(fins['materialName']).toBe('Plywood (assumed)');
  expect(fins['density']).toBe(600);
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
