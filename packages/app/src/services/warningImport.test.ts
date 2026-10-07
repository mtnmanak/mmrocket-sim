// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineWarning } from '@online-openrocket/engine';
import { exportOrk, importOrk, type OrkExportFlightData } from './orkFile.js';
import { planSummaryImport, summaryImportCounts } from './orkFlightData.js';
import { addRuns, appendImportedRuns, deleteRun, loadRuns, MAX_RUNS, persistFailed, restoreRun } from './simStore.js';
import { mergeStoredWarnings } from './storedRunIdentity.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { simulateFile } from './simulateFile.js';

const text: EngineWarning = { key: 'HighSpeedDeployment', message: 'Deployment at 30 m/s', priority: 'HIGH' };
const structured: EngineWarning = { ...text, quantity: { kind: 'velocity', value: 30 },
  sources: [{ name: 'Main' }] };
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
  it('stores identical warnings after two fresh opens and does not duplicate them on re-import', async () => {
    const bytes = new Uint8Array(readFileSync(join(dirname(import.meta.filename), '__fixtures__', 'TubeFins2.rkt')));
    const first = await simulateFile(bytes, 'TubeFins2.rkt');
    const second = await simulateFile(bytes, 'TubeFins2.rkt');
    const source = (warnings: EngineWarning[]) => warnings.find(w => w.sources?.some(s => s?.id))!.sources;
    expect(source(first.result.warnings!)).not.toEqual(source(second.result.warnings!));
    expect(first.run.simWarnings!.length).toBeGreaterThan(0);
    expect(second.run.simWarnings).toEqual(first.run.simWarnings);
    expect(first.run.simWarnings!.flatMap(w => w.sources ?? []).every(s => s === null || !('id' in s))).toBe(true);
    open(write(first.run.simWarnings));
    expect(open(write(second.run.simWarnings))).toEqual({ added: 0, updated: 0, alreadySaved: 1, notKept: 0 });
    expect(loadRuns()[0]!.simWarnings).toEqual(first.run.simWarnings);
  }, 60000);

  it('ignores session IDs in multiset matching and Undo while retaining source evidence', () => {
    const first = { ...text, sources: [{ id: 'c1', name: 'Main', extra: { id: 'evidence' } }, null] };
    const second = { ...first, sources: [{ id: 'c99', name: 'Main', extra: { id: 'evidence' } }, null] };
    const expected = { ...text, sources: [{ name: 'Main', extra: { id: 'evidence' } }, null] };
    const before = structuredClone([first, second]);
    expect(mergeStoredWarnings([first, first], [second])).toEqual([expected, expected]);
    expect(mergeStoredWarnings([first], [second, second])).toEqual([expected, expected]);
    expect(mergeStoredWarnings([first], undefined)).toEqual([expected]);
    expect(mergeStoredWarnings(undefined, [second])).toEqual([expected]);
    expect([first, second]).toEqual(before);
    open(write([first, first]));
    const saved = loadRuns()[0]!;
    expect(restoreRun({ ...saved, simWarnings: [second] }, null)[0]!.simWarnings).toEqual([expected, expected]);
    expect(loadRuns()).toHaveLength(1);
  });

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
    expect(loadRuns()[0]!.simWarnings).toEqual([structured, other, structured]);
    expect(counts).toMatchObject({ added: 0, updated: 1 });
    const saved = localStorage.getItem('online-openrocket.sim-runs.v1');
    for (const warnings of [[structured, structured], [structured], [text], undefined, []]) {
      expect(open(write(warnings))).toEqual({ added: 0, updated: 0, alreadySaved: 1, notKept: 0 });
      expect(localStorage.getItem('online-openrocket.sim-runs.v1')).toBe(saved);
    }
  });

  it('keeps identical occurrences on first import and takes the larger count on update', () => {
    open(write([text, text]));
    expect(loadRuns()[0]!.simWarnings).toEqual([text, text]);
    expect(open(write([structured, structured, structured]))).toMatchObject({ updated: 1 });
    expect(loadRuns()[0]!.simWarnings).toEqual([structured, structured, structured]);
    expect(open(write([structured, structured, structured]))).toMatchObject({ updated: 0 });
    expect(open(write([text, text]))).toMatchObject({ updated: 0 });
    expect(loadRuns()[0]!.simWarnings).toHaveLength(3);
  });

  it('matches exact evidence before text-only occurrences, independently of order', () => {
    const old = [text, structured];
    expect(mergeStoredWarnings(old, [structured, text])).toBe(old);
    expect(mergeStoredWarnings([structured], [text, structured])).toEqual([structured, text]);
    const conflicting = { ...structured, sources: [{ name: 'Other' }] };
    expect(mergeStoredWarnings([text, structured], [structured, conflicting]))
      .toEqual([conflicting, structured]);
  });

  it('counts persisted updates independently of legacy source IDs in the returned history', () => {
    open(write([text]));
    const plan = planSummaryImport(importOrk(write([structured])), loadRuns());
    const saved = [{ ...plan.updatedRuns[0]!, simWarnings: [{ ...structured, sources: [{ id: 'c99', name: 'Main' }] }] }];
    expect(summaryImportCounts(plan, saved)).toEqual({ added: 0, updated: 1, alreadySaved: 0, notKept: 0 });
  });

  it('keeps conflicting extension evidence and compares object fields without property-order dependence', () => {
    const first = { ...text, extra: { id: 1, label: 'one' } };
    const second = { ...text, extra: { id: 2, label: 'two' } };
    expect(mergeStoredWarnings([first, first], [second, second])).toEqual([first, first, second, second]);
    const old = [first, first];
    const reordered = { ...text, extra: { label: 'one', id: 1 } };
    expect(mergeStoredWarnings(old, [reordered])).toBe(old);
  });

  it('pairs complementary partial evidence without reusing or stranding an occurrence', () => {
    const quantityOnly = { ...text, quantity: structured.quantity };
    const sourcesOnly = { ...text, sources: structured.sources };
    const differentValue = { ...text, quantity: { kind: 'velocity' as const, value: 40 } };
    const old = [text, quantityOnly];
    const snapshot = structuredClone(old);
    const merged = mergeStoredWarnings(old, [sourcesOnly, differentValue]);
    expect(merged).toEqual([differentValue, structured]);
    expect(old).toEqual(snapshot);
    expect(mergeStoredWarnings(merged, [sourcesOnly, differentValue])).toBe(merged);
  });

  it('restores warning occurrences after delete, reopening an older export, and Undo', () => {
    open(write([structured, structured]));
    const deleted = loadRuns()[0]!;
    deleteRun(deleted.id);
    open(write());
    restoreRun(deleted, null);
    expect(loadRuns()).toHaveLength(1);
    expect(loadRuns()[0]!.simWarnings).toEqual([structured, structured]);
    expect(restoreRun(deleted, null)[0]!.simWarnings).toEqual([structured, structured]);
  });

  it.each([true, false])('merges both warning multisets when Undo finds a report (upgrade=%s)', (upgrade) => {
    open(write([structured, structured, other]));
    const summary = loadRuns()[0]!;
    const full = { ...summary, importedSummary: undefined, simWarnings: [text, text], comments: 'Full report' };
    if (!upgrade) {
      deleteRun(summary.id);
      addRuns([full]);
    }
    const restored = restoreRun(upgrade ? full : summary, null);
    expect(restored).toHaveLength(1);
    expect(restored[0]!.importedSummary).toBeUndefined();
    expect(restored[0]!.comments).toBe('Full report');
    expect(restored[0]!.simWarnings).toEqual([structured, structured, other]);
    expect(loadRuns()[0]!.simWarnings).toEqual([structured, structured, other]);
  });

  it('uses occurrence counts in repeated file rows and persistence updates', () => {
    const first = importOrk(write([text, text]));
    const second = importOrk(write([structured, structured, structured]));
    const plan = planSummaryImport({ ...first, storedSimulations: [...first.storedSimulations!, ...second.storedSimulations!] });
    appendImportedRuns(plan.runs, plan.updatedRuns);
    const saved = loadRuns()[0]!;
    expect(saved.simWarnings).toEqual([structured, structured, structured]);
    appendImportedRuns([], [{ ...saved, simWarnings: [structured, structured, structured, structured] }]);
    expect(loadRuns()[0]!.simWarnings).toEqual([structured, structured, structured, structured]);
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
    const differentSource = { ...structured, sources: [{ name: 'Drogue' }] };
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
