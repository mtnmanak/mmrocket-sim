// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import bundle from '../data/motorCurves.json';
import type { BatchSweepInput } from './batchSweep.js';

beforeEach(() => { vi.resetModules(); localStorage.clear(); });
afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock('../data/motorCurves.json'); localStorage.clear(); });

async function setup() {
  const { OrkRocket } = await import('@online-openrocket/engine');
  const { defaultTree, engineTree, motorMounts, splitClusterTree } = await import('../tree/treeModel.js');
  const { DEFAULT_CONDITIONS } = await import('./launchConditions.js');
  const { MOTOR_DB } = await import('./motorDb.js');
  const { runBatchSweep } = await import('./batchSweep.js');
  const tree = defaultTree();
  const mount = motorMounts(tree)[0]!;
  mount.cluster = '4-ring';
  const target = { id: mount.id!, label: 'Motor mount', diameterMm: 18, motorCount: 4, maxMotorLengthM: null };
  const input: BatchSweepInput = {
    tree, info: OrkRocket.buildTree(engineTree(tree)).staticInfo(), mounts: [target], target,
    candidates: [], splits: [splitClusterTree(tree, mount.id!)!], assignedMountMotors: {}, assignedMotors: {},
    assignedMotorIds: {}, assignedIgnitions: {}, model: 'eb', autoDelay: false, launch: DEFAULT_CONDITIONS, rocketName: 'Traffic test',
  };
  const sweep = () => runBatchSweep(input, { signal: new AbortController().signal }, {
    yieldToUi: async () => {}, nozzleFor: async () => null,
  });
  return { input, sweep, MOTOR_DB };
}

it('a Batch over every known no-curve catalogue motor makes zero requests, including mixed combinations', async () => {
  const { input, sweep, MOTOR_DB } = await setup();
  const curves: Record<string, unknown> = bundle.curves;
  input.candidates = MOTOR_DB.filter((m) => !Object.hasOwn(curves, m.motorId));
  expect(input.candidates.length).toBeGreaterThan(0);
  // Cover all catalogue misses in the single pass; a small mixed pass keeps
  // this test about traffic rather than generating 3,160 redundant labels.
  input.splits = [];
  const fetcher = vi.fn(async () => new Response('{"results":[]}'));
  vi.stubGlobal('fetch', fetcher);
  const out = await sweep();
  expect(out.rows).toHaveLength(input.candidates.length);
  expect(out.rows.every((r) => !r.run && r.error?.startsWith('No sample data available for '))).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  const { splitClusterTree } = await import('../tree/treeModel.js');
  input.candidates = input.candidates.slice(0, 3);
  input.splits = [splitClusterTree(input.tree, input.target.id)!];
  const mixed = await sweep();
  expect(mixed.rows).toHaveLength(6);
  expect(mixed.rows.every((r) => !r.run && r.error?.startsWith('No sample data available for '))).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
});

it('a failed curve bundle stops Batch before any download, while single Load retains its fallback', async () => {
  vi.doMock('../data/motorCurves.json', () => { throw new Error('chunk gone'); });
  const { input, sweep, MOTOR_DB } = await setup();
  input.candidates = MOTOR_DB.slice(0, 3);
  const fetcher = vi.fn(async () => new Response('{"results":[]}'));
  vi.stubGlobal('fetch', fetcher);
  await expect(sweep()).rejects.toThrow('The thrust curves bundled with the app did not load — reload the app and run again.');
  expect(fetcher).not.toHaveBeenCalled();
  const { fetchMotorSpec, NoPublishedCurveError } = await import('./thrustcurve.js');
  await expect(fetchMotorSpec(input.candidates[0]!, 5)).rejects.toBeInstanceOf(NoPublishedCurveError);
  expect(fetcher).toHaveBeenCalledOnce();
});

it('a failed bundle still lets Batch fly candidates with cached curves without requests', async () => {
  vi.doMock('../data/motorCurves.json', () => { throw new Error('chunk gone'); });
  const { input, sweep, MOTOR_DB } = await setup();
  const candidate = MOTOR_DB.find(m => m.designation === 'C6' && m.manufacturerAbbrev === 'Estes')!;
  input.candidates = [candidate];
  input.splits = [];
  const files: Record<string, { samples: number[][] }[]> = bundle.curves;
  const samples = files[candidate.motorId]![0]!.samples.map(([time, thrust]) => ({ time, thrust }));
  localStorage.setItem(`tc:samples:v7:${candidate.motorId}`, JSON.stringify({ samples, masses: null }));
  const fetcher = vi.fn(async () => { throw new Error('unexpected download'); });
  vi.stubGlobal('fetch', fetcher);
  const out = await sweep();
  expect(out.rows).toHaveLength(1);
  expect(out.rows[0]!.error).toBeUndefined();
  expect(out.rows[0]!.run).toBeDefined();
  expect(fetcher).not.toHaveBeenCalled();

  // One uncached candidate must still stop the whole run before downloading.
  input.candidates = [...input.candidates, { ...candidate, motorId: 'uncached' }];
  await expect(sweep()).rejects.toThrow('reload the app and run again');
  expect(fetcher).not.toHaveBeenCalled();
  // A corrupt cache must not bypass that refusal either.
  localStorage.setItem('tc:samples:v7:uncached', '{"samples":[{"time":"bad","thrust":1}]}');
  await expect(sweep()).rejects.toThrow('reload the app and run again');
  expect(fetcher).not.toHaveBeenCalled();
});

it('a breaker opened after candidate k skips all remaining network candidates and their combinations', async () => {
  const { input, sweep, MOTOR_DB } = await setup();
  input.candidates = [0, 1, 2, 3].map((i) => ({ ...MOTOR_DB[0]!, motorId: `new-${i}`, designation: `new-${i}` }));
  // k=1: an empty successful answer, then 503, then only breaker refusals.
  const fetcher = vi.fn(async () => new Response('{}', { status: 503 }));
  fetcher.mockImplementationOnce(async () => new Response('{"results":[]}'));
  vi.stubGlobal('fetch', fetcher);
  const out = await sweep();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(out.rows).toHaveLength(10);
  expect(out.rows[0]!.error).toMatch(/No sample data/);
  expect(out.rows[1]!.error).toMatch(/HTTP 503/);
  expect(out.rows.slice(2, 4).every((r) => r.error?.includes('app will not ask it again for about 10 minutes'))).toBe(true);
  expect(out.rows.every((r) => !r.run)).toBe(true);
});

it('a 404 candidate in a 4-ring run is requested once across single and combination passes', async () => {
  const { input, sweep, MOTOR_DB } = await setup();
  input.candidates = [0, 1, 2, 3].map(i => ({ ...MOTOR_DB[0]!, motorId: `new-${i}`, designation: `new-${i}` }));
  const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  const out = await sweep();
  for (const candidate of input.candidates) {
    expect(fetcher.mock.calls.filter(call => JSON.parse(String(call[1]?.body)).motorIds[0] === candidate.motorId))
      .toHaveLength(1);
  }
  expect(out.rows).toHaveLength(10);
  expect(out.rows.every(r => !r.run && r.error?.includes('HTTP 404'))).toBe(true);
});
