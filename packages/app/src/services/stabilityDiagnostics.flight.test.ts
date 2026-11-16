// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { STABILITY_DIAGNOSTIC_KEYS, finiteSample, withStabilityDiagnostics } from '../flightChartModel.js';
import { defaultTree, motorMounts } from '../tree/treeModel.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { loadCatalogueMotor } from './motorMatch.js';
import { simulateDesign } from './simulateDesign.js';

it('N052 displays all five diagnostics on the starter flight and gaps them at deployment', async () => {
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
    const displayed = withStabilityDiagnostics(source.series, source.events);
    const after = source.series.time.map((t, i) => ({ t, i })).filter(({ t }) => t >= deployment);
    expect(after.length).toBeGreaterThan(0);
    for (const key of STABILITY_DIAGNOSTIC_KEYS) {
      expect(source.series.time.some((t, i) => t < deployment && finiteSample(displayed[key]?.[i]))).toBe(true);
      expect(after.every(({ i }) => displayed[key]?.[i] === null)).toBe(true);
      expect(guide.every(i => displayed[key]?.[i] === null)).toBe(true);
    }
    expect(source).toEqual(before);
  } finally { vi.unstubAllGlobals(); }
}, 60_000);
