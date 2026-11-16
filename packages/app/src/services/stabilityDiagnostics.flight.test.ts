// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { STABILITY_DIAGNOSTIC_KEYS, finiteSample, withStabilityDiagnostics } from '../flightChartModel.js';
import { defaultTree, motorMounts } from '../tree/treeModel.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { loadCatalogueMotor } from './motorMatch.js';
import { simulateDesign } from './simulateDesign.js';

const expectedKeys = ['ωn', 'Ccm', 'Cn', 'CNα', 'Cθ', 'Cζθ', 'dθ'] as const;

it('N052 displays all seven diagnostics on the starter flight and gaps them at deployment', async () => {
  expect(STABILITY_DIAGNOSTIC_KEYS).toEqual(expectedKeys);
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline (test)'); }));
  try {
    const tree = defaultTree();
    // Resolve the starter motor from shipped data rather than pinning any motor figures.
    const motor = (await loadCatalogueMotor('Estes', 'C6', 5))!;
    expect(motor).toBeTruthy();
    const flight = await simulateDesign({ tree, mountMotors: { [motorMounts(tree)[0]!.id!]: motor },
      launch: DEFAULT_CONDITIONS, measured: { massKg: null, cgM: null }, savedConfigs: [],
      activeConfigId: null, unmatchedRefs: {} });
    const source = flight.result;
    const before = structuredClone(source);
    const deployment = source.events.find(e => e.type === 'RECOVERY_DEVICE_DEPLOYMENT')!.time;
    const guide = source.series.time.map((_, i) => i).filter(i => !finiteSample(source.series.Cn?.[i]));
    expect(guide.some(i => source.series['ωn']?.[i] === 0)).toBe(true);
    expect(guide.some(i => source.series.Ccm?.[i] === 0)).toBe(true);
    const exit = source.events.find(e => e.type === 'LAUNCHROD')!.time;
    expect(source.series.time.every((t, i) => t >= exit || !finiteSample(source.series['CNα']?.[i]))).toBe(true);
    const displayed = withStabilityDiagnostics(source.series, source.events);
    const after = source.series.time.map((t, i) => ({ t, i })).filter(({ t }) => t >= deployment);
    expect(after.length).toBeGreaterThan(0);
    expect(after.some(({ i }) => finiteSample(source.series['CNα']?.[i]) && source.series['CNα']![i] === 0)).toBe(true);
    for (const key of ['Ccm', 'ωn']) expect(after.every(({ i }) => source.series[key]?.[i] === null)).toBe(true);
    for (const key of ['stability', 'cpLocation']) {
      expect(after.every(({ i }) => finiteSample(source.series[key]?.[i]))).toBe(true);
      expect(after.every(({ i }) => displayed[key]?.[i] === null)).toBe(true);
    }
    for (const key of expectedKeys) {
      expect(source.series.time.some((t, i) => t < deployment && finiteSample(displayed[key]?.[i]))).toBe(true);
      expect(after.every(({ i }) => displayed[key]?.[i] === null)).toBe(true);
      expect(guide.every(i => displayed[key]?.[i] === null)).toBe(true);
    }
    // The real descent Cn is null, which alone masks the event gate. Keep the
    // recorded CNα zeros but provide finite Cn to exercise that gate independently.
    const eventOnly = withStabilityDiagnostics({ ...source.series,
      Cn: source.series.time.map((t, i) => t >= deployment ? 0 : source.series.Cn![i]!),
    }, source.events);
    expect(after.every(({ i }) => eventOnly['CNα']?.[i] === null)).toBe(true);
    expect(source).toEqual(before);
  } finally { vi.unstubAllGlobals(); }
}, 60_000);
