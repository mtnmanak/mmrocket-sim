// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineWarning } from '@online-openrocket/engine';
import { exportOrk, importOrk, type OrkExportFlightData } from './orkFile.js';
import { planSummaryImport, summaryImportCounts } from './orkFlightData.js';
import { addRuns, appendImportedRuns, loadRuns, MAX_RUNS, persistFailed } from './simStore.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

const text: EngineWarning = { key: 'HighSpeedDeployment', message: 'Deployment at 30 m/s', priority: 'HIGH' };
const structured: EngineWarning = { ...text, quantity: { kind: 'velocity', value: 30 },
  sources: [{ id: 'chute', name: 'Main' }] };
const other: EngineWarning = { key: 'NO_RECOVERY_DEVICE', message: 'No recovery device', priority: 'HIGH' };
const write = (simWarnings?: EngineWarning[], data: Partial<OrkExportFlightData> = {}) => exportOrk({
  name: 'Warning import', tree: { components: [{ type: 'stage', children: [
    { type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001 },
  ] }] }, launch: DEFAULT_CONDITIONS,
  configs: [{ id: 'c1', name: 'Flight', isDefault: true, motors: {} }], activeConfigId: 'c1',
  flightData: { c1: { runId: 'flight', aeroModel: 'classic', maxAltitude: 123, simWarnings, ...data } },
});
const open = (xml: string) => {
  const plan = planSummaryImport(importOrk(xml), loadRuns());
  const saved = appendImportedRuns(plan.runs, plan.updatedRuns);
  return summaryImportCounts(plan, saved);
};

beforeEach(() => localStorage.clear());
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('warning evidence on matching imported runs', () => {
  it.each([{ warnings: undefined }, { warnings: [] }])('enriches an old export with warnings (previous=$warnings)', ({ warnings }) => {
    open(write(warnings));
    const before = loadRuns()[0]!;
    const counts = open(write([structured, other]));
    expect(loadRuns()).toEqual([{ ...before, simWarnings: [structured, other] }]);
    expect(counts).toEqual({ added: 0, updated: 1, alreadySaved: 0, notKept: 0 });
  });

  it('upgrades text warnings, preserves distinct warnings and makes repeat/older imports no-ops', () => {
    open(write([text, other]));
    const counts = open(write([structured, structured]));
    expect(loadRuns()[0]!.simWarnings).toEqual([structured, other]);
    expect(counts).toMatchObject({ added: 0, updated: 1 });
    const saved = localStorage.getItem('online-openrocket.sim-runs.v1');
    for (const warnings of [[structured], [text], undefined, []]) {
      expect(open(write(warnings))).toEqual({ added: 0, updated: 0, alreadySaved: 1, notKept: 0 });
      expect(localStorage.getItem('online-openrocket.sim-runs.v1')).toBe(saved);
    }
  });

  it('unions warning subsets without confusing distinct messages or quantities', () => {
    const different = { ...structured, message: 'Deployment at 40 m/s', quantity: { kind: 'velocity' as const, value: 40 } };
    open(write([structured]));
    open(write([other, different, structured]));
    expect(loadRuns()[0]!.simWarnings).toEqual([structured, other, different]);
    expect(open(write([different, other]))).toMatchObject({ updated: 0, alreadySaved: 1 });
  });

  it('fills quantity and source evidence independently without mutating the input history', () => {
    open(write([{ ...text, sources: structured.sources }]));
    const before = loadRuns();
    const snapshot = structuredClone(before);
    const plan = planSummaryImport(importOrk(write([{ ...text, quantity: { kind: 'velocity', value: 0 } }])), before);
    expect(before).toEqual(snapshot);
    appendImportedRuns(plan.runs, plan.updatedRuns);
    expect(loadRuns()[0]!.simWarnings).toEqual([{ ...structured, quantity: { kind: 'velocity', value: 0 } }]);
    expect(open(write([{ ...text, quantity: { value: 0, kind: 'velocity' }, sources: [{ name: 'Main', id: 'chute' }] }])))
      .toMatchObject({ updated: 0, alreadySaved: 1 });
  });

  it('retains conflicting structured evidence rather than overwriting it', () => {
    const differentSource = { ...structured, sources: [{ id: 'drogue', name: 'Drogue' }] };
    const differentValue = { ...structured, quantity: { kind: 'velocity' as const, value: 30.01 } };
    open(write([structured]));
    open(write([differentSource, differentValue]));
    expect(loadRuns()[0]!.simWarnings).toEqual([structured, differentSource, differentValue]);
    expect(open(write([differentValue, differentSource, text]))).toMatchObject({ updated: 0, alreadySaved: 1 });
  });

  it('counts one updated run for repeated rows carrying complementary warnings', () => {
    open(write());
    const first = importOrk(write([structured]));
    const second = importOrk(write([other]));
    const plan = planSummaryImport({ ...first, storedSimulations: [...first.storedSimulations!, ...second.storedSimulations!] }, loadRuns());
    const saved = appendImportedRuns(plan.runs, plan.updatedRuns);
    expect(saved[0]!.simWarnings).toEqual([structured, other]);
    expect(summaryImportCounts(plan, saved)).toEqual({ added: 0, updated: 1, alreadySaved: 1, notKept: 0 });
  });

  it.each(['flight', undefined])('enriches duplicates within one file before adding a row (id=%s)', (runId) => {
    const old = importOrk(write(undefined, { runId }));
    const enriched = importOrk(write([structured], { runId }));
    const plan = planSummaryImport({ ...old, storedSimulations: [...old.storedSimulations!, ...enriched.storedSimulations!] });
    const saved = appendImportedRuns(plan.runs, plan.updatedRuns);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.simWarnings).toEqual([structured]);
    expect(summaryImportCounts(plan, saved)).toEqual({ added: 1, updated: 0, alreadySaved: 1, notKept: 0 });
  });

  it('updates full history in place, retaining live report fields and order', () => {
    open(write([text]));
    const run = { ...loadRuns()[0]!, importedSummary: undefined, designKey: 'live-evidence', comments: 'My note' };
    const history = Array.from({ length: MAX_RUNS }, (_, i) => ({ ...run, id: i === 250 ? 'flight' : `other-${i}`, importedRunId: undefined }));
    addRuns(history);
    const before = loadRuns();
    expect(open(write([structured]))).toMatchObject({ updated: 1, added: 0, alreadySaved: 0 });
    expect(loadRuns()).toEqual(before.map((r) => r.id === 'flight' ? { ...r, simWarnings: [structured] } : r));
  });

  it('does not claim an update when persistence fails', () => {
    open(write([text]));
    const storage = localStorage;
    vi.stubGlobal('localStorage', { getItem: storage.getItem.bind(storage), setItem: () => { throw new Error('quota'); } });
    expect(open(write([structured]))).toMatchObject({ updated: 0, added: 0 });
    expect(persistFailed()).toBe(true);
    expect(loadRuns()[0]!.simWarnings).toEqual([text]);
  });

  it('preserves distinct run IDs and conflicting numerical summaries', () => {
    open(write([text]));
    expect(open(write([structured], { runId: 'second' }))).toMatchObject({ added: 1, updated: 0 });
    expect(open(write([structured], { maxAltitude: 456 }))).toMatchObject({ added: 1, updated: 0 });
    expect(loadRuns()).toHaveLength(3);
    expect(loadRuns()[0]!.simWarnings).toEqual([text]);
    expect(open(write([structured, other], { maxAltitude: 456 }))).toMatchObject({ added: 0, updated: 1 });
    expect(loadRuns()[2]!.simWarnings).toEqual([structured, other]);
  });
});
