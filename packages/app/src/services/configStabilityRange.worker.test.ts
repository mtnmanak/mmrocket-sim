import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { expect, it } from 'vitest';
import { defaultTree, motorMounts } from '../tree/treeModel.js';
import { OrkRocket } from '@online-openrocket/engine';
import { buildDesign, KERNEL_HANDLES } from './buildDesign.js';
import { prepareStabilityCases, type StabilityRange, type StabilityRangeInput } from './configStabilityRange.js';

const assets = resolve(import.meta.dirname, '../../dist/assets');
const file = existsSync(assets) ? readdirSync(assets).find(f => /^configStabilityRange\.worker-.*\.js$/.test(f)) : undefined;

/** Artifact check after vite build; a clean npm test checkout has no app dist. */
it.skipIf(!file)('keeps the active flight unchanged during 256 configuration calculations and cancels stale work', async () => {
  expect(file, 'Run npx vite build before this artifact integration test').toBeTruthy();
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    globalThis.self = { postMessage: value => parentPort.postMessage(value) };
    import(${JSON.stringify(pathToFileURL(resolve(assets, file!)).href)}).then(() => {
      parentPort.on('message', data => self.onmessage({ data }));
      parentPort.postMessage({ ready: true });
    });
  `, { eval: true });
  const receive = () => new Promise<{ ready?: boolean; id?: number; result?: StabilityRange; error?: string }>((res, rej) => {
    worker.once('message', res); worker.once('error', rej);
  });
  try {
    expect((await receive()).ready).toBe(true);
    const tree = defaultTree();
    const mount = motorMounts(tree)[0]!.id!;
    const motor = { label: 'C6', meta: { label: 'C6' }, ignition: { event: 'automatic' as const, delay: 0 },
      spec: { designation: 'C6', diameter: 0.018, length: 0.07, times: [0, 0.2, 1.8],
        thrusts: [0, 14, 0], masses: [0.024, 0.02, 0.012], cgX: 0.035, ejectionDelay: 5 } };
    const input: StabilityRangeInput = { tree, kbf: true, supersonic: false, measuredDryMassKg: null,
      configs: Array.from({ length: 256 }, (_, i) => ({ id: `c${i}`, name: `Case ${i}`, isDefault: i === 0,
        motors: { [mount]: { ...motor, spec: { ...motor.spec, masses: [0.024 + i * 0.0001, 0.02, 0.012] } } },
        stageMassOverrides: { [tree.components[0]!.id!]: { overrideMass: 0.1 + i * 0.0001,
          overrideCGX: 0.15 + i * 0.00001, overrideSubcomponentsMass: true, overrideSubcomponentsCG: true } },
      })) };
    const built = buildDesign(prepareStabilityCases(input)[1]!.input, KERNEL_HANDLES);
    if ('error' in built) throw new Error(built.error);
    const active: OrkRocket = built.rocket;
    const before = active.staticInfo();
    const flightBefore = active.simulate({ randomSeed: 123 });
    const durations: number[] = [];
    let last = performance.now();
    const ticker = setInterval(() => { const now = performance.now(); durations.push(now - last); last = now; }, 10);
    const timings: Record<string, number> = {};
    for (const [id, name] of [[1, 'cold'], [2, 'warm']] as const) {
      const pending = receive(); const start = performance.now();
      worker.postMessage({ id, input });
      timings[`${name}SendMs`] = performance.now() - start;
      const response = await pending;
      timings[`${name}Ms`] = performance.now() - start;
      expect(response.error).toBeUndefined();
      expect(response.result?.cases).toHaveLength(257);
      expect(response.result?.complete).toBe(true);
      expect(response.result?.builds).toBe(name === 'cold' ? 257 : 0);
    }
    clearInterval(ticker);
    const pending = receive();
    worker.postMessage({ id: 3, input: { ...input, supersonic: true } });
    worker.postMessage({ id: 4 });
    worker.postMessage({ id: 5, input: { ...input, configs: [] } });
    expect((await pending).id).toBe(5);
    expect(active.staticInfo()).toEqual(before);
    const flightAfter = active.simulate({ randomSeed: 123 });
    // Exclude wall-clock noise; all other flight numbers must agree within this runtime.
    const withoutClock = (flight: typeof flightBefore) => ({ ...flight,
      series: Object.fromEntries(Object.entries(flight.series).filter(([key]) => key !== 'tc')) });
    expect(withoutClock(flightAfter)).toEqual(withoutClock(flightBefore));
    console.info('N024 timing (Node worker, 256 configurations + empty):', JSON.stringify({ ...timings,
      maxMainTickMs: Math.max(...durations), mainTicks: durations.length }));
  } finally {
    await worker.terminate();
  }
}, 30_000);
