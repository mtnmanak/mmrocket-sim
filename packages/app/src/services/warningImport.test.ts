// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineWarning } from '@online-openrocket/engine';
import { exportOrk, importOrk, type OrkExportFlightData } from './orkFile.js';
import { planSummaryImport, summaryImportCounts } from './orkFlightData.js';
import { addRun, addRuns, appendImportedRuns, deleteRun, loadRuns, MAX_RUNS, persistFailed, restoreRun } from './simStore.js';
import { boundedWarningEvidence, MAX_STORED_WARNINGS, MAX_WARNING_EVIDENCE_DEPTH, MAX_WARNING_EVIDENCE_VALUES, MAX_WARNING_FIELDS } from './storedWarnings.js';
import * as warningStorage from './storedWarnings.js';
import { createWarningMergeBudget, MAX_WARNING_MERGE_WORK, mergeStoredWarnings, warningMergeNotes } from './storedRunIdentity.js';
import * as warningIdentity from './storedRunIdentity.js';
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
  const saved = appendImportedRuns(plan.runs, plan.updatedRuns, plan.warningMergeBudget);
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

describe('S1d-1 bounded stored warning evidence', () => {
  const withRawWarnings = (warnings: unknown) => write([text]).replace(
    /(<simwarnings[^>]*>)[\s\S]*?(<\/simwarnings>)/,
    (_all, start: string, end: string) => start + JSON.stringify(warnings) + end);
  it('refuses a whole oversized warning array with the I28 caution naming the limit', () => {
    const r = importOrk(withRawWarnings(Array.from({ length: MAX_STORED_WARNINGS + 1 }, () => text)));
    expect(r.storedSimulations![0]!.data.simWarnings).toBeUndefined();
    expect(r.notes.join('\n')).toContain(`more than ${MAX_STORED_WARNINGS.toLocaleString('en-US')} warnings`);
    expect(r.noteTiers?.some(note => note.kind === 'I28.stored-warnings')).toBe(true);
    expect(importOrk(withRawWarnings(Array.from({ length: MAX_STORED_WARNINGS }, () => text)))
      .storedSimulations![0]!.data.simWarnings).toHaveLength(MAX_STORED_WARNINGS);

  });
  it('bounds nested and wide warning evidence before recursive matching', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i <= MAX_WARNING_EVIDENCE_DEPTH; i++) nested = { next: nested };
    for (const evidence of [nested, Array.from({ length: MAX_WARNING_EVIDENCE_VALUES }, () => 0)]) {
      const warnings = [{ ...text, evidence }];
      const r = importOrk(withRawWarnings(warnings));
      expect(r.storedSimulations![0]!.data.simWarnings).toBeUndefined();
      expect(r.notes.join('\n')).toContain('warning details nested too deeply or too large');
      expect(mergeStoredWarnings(warnings, warnings)).toEqual([
        text, expect.objectContaining({ key: 'StoredWarningsUnavailable' }),
      ]);
    }
    let boundary: unknown = 'leaf';
    for (let i = 1; i < MAX_WARNING_EVIDENCE_DEPTH; i++) boundary = { next: boundary };
    for (const evidence of [boundary, Array.from({ length: MAX_WARNING_EVIDENCE_VALUES - 4 }, () => 0)]) {
      expect(importOrk(withRawWarnings([{ key: 'Boundary', message: 'kept', evidence }]))
        .storedSimulations![0]!.data.simWarnings).toHaveLength(1);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.next = cyclic;
    const cyclicWarnings = [{ ...text, cyclic }];
    expect(mergeStoredWarnings(cyclicWarnings, [text])).toEqual([
      text, text, expect.objectContaining({ key: 'StoredWarningsUnavailable' }),
    ]);
  });
  it('indexes exact evidence without scanning previously matched occurrences', () => {
    let reads = 0;
    const stored = Array.from({ length: 256 }, (_, value) => ({ ...text,
      quantity: { kind: 'velocity' as const, get value() { reads++; return value; } },
    }));
    // Reverse distinct evidence: a quadratic exact matcher must compare many
    // unmatched quantities, rather than skipping already-matched duplicates.
    const incoming = stored.map(w => ({ quantity: { value: w.quantity.value, kind: 'velocity' as const }, ...text })).reverse();
    reads = 0;
    expect(mergeStoredWarnings(stored, incoming)).toBe(stored);
    expect(reads).toBeLessThan(stored.length * 12);
  });
  it('accepts 32 own fields and repairs 33 with bounded evidence and the I28 note', () => {
    const fields = Object.fromEntries(Array.from({ length: MAX_WARNING_FIELDS - 2 }, (_, i) => ['k' + i, i]));
    const boundary = { key: 'X', message: 'm', ...fields };
    expect(Reflect.ownKeys(boundary)).toHaveLength(MAX_WARNING_FIELDS);
    expect(importOrk(withRawWarnings([boundary])).storedSimulations![0]!.data.simWarnings).toEqual([boundary]);
    const tooWide = { ...boundary, extra: 1 };
    const imported = importOrk(withRawWarnings([tooWide]));
    expect(imported.storedSimulations![0]!.data.simWarnings).toEqual([
      expect.objectContaining({ key: 'StoredWarningsUnavailable' }),
    ]);
    expect(imported.noteTiers).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'I28.stored-warnings', tier: 'caution', text: expect.stringContaining('32 fields') }),
    ]));
    const high = { ...tooWide, priority: 'HIGH' as const };
    expect(importOrk(withRawWarnings([high])).storedSimulations![0]!.data.simWarnings).toEqual([
      { key: 'X', message: 'm', priority: 'HIGH' }, expect.objectContaining({ key: 'StoredWarningsUnavailable' }),
    ]);
  });

  it('copies enrichment once at the field limit with the internal counter disabled', () => {
    const plain = { key: 'X', message: 'm', ...Object.fromEntries([['__proto__', { kept: true }]]) };
    const enriched = { ...plain, ...Object.fromEntries(Array.from({ length: MAX_WARNING_FIELDS - 3 }, (_, i) => [i === 0 ? 'constructor' : 'k' + i, i])) };
    const original = Object.fromEntries;
    let copied = 0;
    const copy = vi.spyOn(Object, 'fromEntries').mockImplementation(entries => {
      const fields = [...entries];
      copied += fields.length;
      if (copied > 2 * MAX_WARNING_FIELDS) throw new Error('Enrichment copied the accumulated object once per field');
      return original(fields);
    });
    const work = createWarningMergeBudget();
    work.spend = () => {}; // Admission's structural bound must not rely on this guard.
    let result: EngineWarning[] | undefined;
    try { result = mergeStoredWarnings([plain], [enriched], work); }
    finally { copy.mockRestore(); }
    expect(result).toEqual([enriched]);
    expect(Object.getPrototypeOf(result![0]!)).toBe(Object.prototype);
    expect(Object.hasOwn(result![0]!, '__proto__')).toBe(true);
    expect(Object.hasOwn(result![0]!, 'constructor')).toBe(true);
    expect(copied).toBe(MAX_WARNING_FIELDS);
  });

  it('persists prepaid planner updates after a later duplicate exhausts admission', () => {
    open(write([text]));
    const before = loadRuns();
    const summary = importOrk(write([structured, structured])).storedSimulations![0]!;
    const budget = createWarningMergeBudget();
    budget.remaining = MAX_WARNING_FIELDS * (1 + 2 + 1 * 2);
    const factory = vi.spyOn(warningIdentity, 'createWarningMergeBudget').mockReturnValue(budget);
    let plan: ReturnType<typeof planSummaryImport>;
    try {
      plan = planSummaryImport({ name: 'Prepared', storedSimulations: [summary,
        { ...summary, data: { ...summary.data, simWarnings: [other] } }] }, before);
    } finally { factory.mockRestore(); }
    expect(budget.remaining).toBe(0);
    const after = appendImportedRuns(plan.runs, plan.updatedRuns, plan.warningMergeBudget);
    expect(after[0]!.simWarnings).toEqual(plan.updatedRuns[0]!.simWarnings);
    expect(after[0]!.simWarnings).toEqual(expect.arrayContaining([structured]));
    expect(after[0]!.simWarnings).toHaveLength(2);
    expect(budget.rowCounts.get('flight')).toBe(2);
    expect(warningMergeNotes(plan.warningMergeBudget)).toEqual([expect.stringContaining('1 later copy')]);
  });
  it('visits each dense candidate edge once without the internal counter', () => {
    const stored = Array.from({ length: 64 }, () => ({ key: 'X', message: 'm' }));
    const incoming = stored.map(w => ({ ...w, priority: 'HIGH' as const }));
    const filter = Array.prototype.filter;
    let visits = 0;
    const limit = stored.length * incoming.length + 2 * (stored.length + incoming.length);
    const spy = vi.spyOn(Array.prototype, 'filter').mockImplementation(function (this: unknown[], predicate, thisArg) {
      spy.mockClear();
      const result = filter.call(this, predicate, thisArg);
      if (!Number.isInteger(this[0])) return result;
      return new Proxy(result, { get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key) && ++visits > limit) throw new Error('Dense search revisited candidate edges');
        return Reflect.get(target, key, receiver);
      } });
    });
    const work = createWarningMergeBudget();
    work.spend = () => {};
    let result: EngineWarning[] | undefined;
    try { result = mergeStoredWarnings(stored, incoming, work); }
    finally { spy.mockRestore(); }
    expect(result).toEqual(incoming);
    expect(visits).toBeGreaterThan(0);
    expect(visits).toBeLessThanOrEqual(limit);
  });

  it('canonicalizes nested fields once rather than reading them for every pair', () => {
    let reads = 0;
    const evidence = () => Object.fromEntries(Array.from({ length: 128 }, (_, i) => ['k' + i, 1]));
    const watched = () => new Proxy(evidence(), { get(target, key, receiver) {
      if (++reads > 8 * 2 * 64 * 134) throw new Error('Nested evidence was walked again for candidate pairs');
      return Reflect.get(target, key, receiver);
    } });
    const stored = Array.from({ length: 64 }, () => ({ key: 'X', message: 'm', evidence: watched(), priority: 'HIGH' as const }));
    const incoming = Array.from({ length: 64 }, () => ({ key: 'X', message: 'm', evidence: watched(), priority: 'LOW' as const }));
    const work = createWarningMergeBudget();
    work.spend = () => {};
    const result = mergeStoredWarnings(stored, incoming, work)!;
    expect(result.some(w => w.key === 'StoredWarningsUnavailable')).toBe(true);
    expect(result.filter(w => w.priority === 'HIGH')).toHaveLength(64);
    expect(reads).toBeGreaterThan(0);
  });
  it('encodes an accumulated long warning message once per import', () => {
    const summary = importOrk(write()).storedSimulations![0]!;
    const arrays = [[{ key: 'X', message: 'm'.repeat(65_536) }],
      ...Array.from({ length: 999 }, (_, i) => [{ key: 'Y' + i, message: 'm' }])];
    const ownCharacters = arrays.reduce((n, warnings) => n + JSON.stringify(warnings).length, 0);
    const limit = MAX_WARNING_MERGE_WORK + 8 * ownCharacters;
    let characters = 0;
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      spy.mockClear();
      characters += typeof value === 'string' ? value.length : Array.isArray(value)
        ? value.reduce<number>((n, child) => n + (typeof child === 'string' ? child.length : 0), 0) : 0;
      if (characters > limit) throw new Error('Accumulated warning text was encoded again for every duplicate');
      return stringify(value, replacer, space);
    });
    let plan: ReturnType<typeof planSummaryImport>;
    try { plan = planSummaryImport({ name: 'Long warning', storedSimulations: arrays.map(simWarnings =>
      ({ ...summary, data: { ...summary.data, simWarnings } })) }); }
    finally { spy.mockRestore(); }
    expect(characters).toBeGreaterThan(65_536);
    expect(characters).toBeLessThanOrEqual(limit);
    expect(plan.warningMergeBudget.skippedCopies.get('flight')).toBe(638);
  });
  it('preserves the original depth-first partial evidence choice', () => {
    const q1 = { ...text, quantity: { kind: 'velocity' as const, value: 1 } };
    const q2 = { ...text, quantity: { kind: 'velocity' as const, value: 2 } };
    const broad = { key: text.key, message: text.message };
    const first = { ...q1, priority: 'HIGH' as const };
    const second = { ...q2, priority: 'LOW' as const };
    expect(mergeStoredWarnings([broad, { ...q1, priority: undefined }, { ...q2, priority: undefined }], [first, second]))
      .toEqual([second, first, { ...q2, priority: undefined }]);
  });
  it('accepts key-only warnings through file import and re-export', () => {
    const imported = importOrk(withRawWarnings([{ key: 'SIM_ABORT' }]));
    expect(imported.storedSimulations![0]!.data.simWarnings).toEqual([{ key: 'SIM_ABORT' }]);
    expect(imported.notes.join('\n')).not.toContain('Stored simulation warnings');
    expect(importOrk(write(imported.storedSimulations![0]!.data.simWarnings))
      .storedSimulations![0]!.data.simWarnings).toEqual([{ key: 'SIM_ABORT' }]);
  });
  it('groups partial matches by key and message before comparing evidence', () => {
    let reads = 0;
    const stored = Array.from({ length: 256 }, (_, i) => ({
      get key() { reads++; return 'Key' + i; }, message: 'same text',
    }));
    const incoming = stored.map(w => ({ key: w.key, message: w.message, priority: 'HIGH' as const }));
    reads = 0;
    const merged = mergeStoredWarnings(stored, incoming);
    expect(merged).toHaveLength(256);
    expect(reads).toBeLessThan(8000);
    expect(merged!.every(w => w.priority === 'HIGH')).toBe(true);
  });
  it('compares each incompatible partial pair at most once', () => {
    // 55 equal fields force the incompatible object comparison to reach its end.
    const x = (last: number) => ({ ...Object.fromEntries(Array.from({ length: 54 }, (_, i) => ['f' + i, 0])), last });
    const stored = [...Array.from({ length: 128 }, (_, i) => ({ key: 'Same', message: 'same', x: x(-i - 1) })),
      ...Array.from({ length: 128 }, () => ({ key: 'Same', message: 'same' }))];
    const incoming = Array.from({ length: 256 }, (_, i) => ({ key: 'Same', message: 'same', x: x(i) }));
    expect(boundedWarningEvidence(stored)).toBe(true);
    expect(boundedWarningEvidence(incoming)).toBe(true);
    const identities = new Set<object>(incoming);
    const entries = Object.entries;
    let comparisons = 0;
    const spy = vi.spyOn(Object, 'entries').mockImplementation(value => {
      if (identities.has(value) && ++comparisons > 256 * 256 + 128) {
        throw new Error('Warning comparisons exceeded the quadratic work limit');
      }
      return entries(value);
    });
    try {
      const merged = mergeStoredWarnings(stored, incoming);
      // The 384 unmatched/enriched entries exceed the combined value budget.
      expect(merged).toEqual([expect.objectContaining({ key: 'StoredWarningsUnavailable' })]);
      // Enrichment enumerates the 128 successful matches once more.
      expect(comparisons - 128).toBeLessThanOrEqual(256 * 256);
    } finally { spy.mockRestore(); }
  });

  it.each([false, true])('bounds dense partial search at the warning cap (conflict=%s)', conflict => {
    const stored: EngineWarning[] = Array.from({ length: MAX_STORED_WARNINGS }, () => ({ key: 'X', message: 'm' }));
    if (conflict) stored[stored.length - 1] = { key: 'X', message: 'm', priority: 'LOW' };
    const incoming: EngineWarning[] = Array.from({ length: MAX_STORED_WARNINGS }, () => ({ key: 'X', message: 'm', priority: 'HIGH' }));
    expect(boundedWarningEvidence(stored)).toBe(true);
    expect(boundedWarningEvidence(incoming)).toBe(true);
    // Count actual cached-candidate reads, not compatibility comparisons. The
    // proxy throws promptly if rerouting becomes cubic, without retaining a
    // mock-call record for every search step or running the unbounded merge.
    const filter = Array.prototype.filter;
    let steps = 0;
    const limit = MAX_WARNING_MERGE_WORK;
    const spy = vi.spyOn(Array.prototype, 'filter').mockImplementation(function (this: unknown[], predicate, thisArg) {
      const result = filter.call(this, predicate, thisArg);
      if (!Number.isInteger(this[0])) return result;
      return new Proxy(result, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key) && ++steps > limit) {
            throw new Error('Warning augmenting search exceeded the step limit');
          }
          return Reflect.get(target, key, receiver);
        },
      });
    });
    try {
      const merged = mergeStoredWarnings(stored, incoming)!;
      expect(steps).toBeGreaterThan(0);
      expect(steps).toBeLessThanOrEqual(limit);
      expect(merged).toHaveLength(MAX_STORED_WARNINGS);
      expect(merged.filter(w => w.priority === 'HIGH')).toHaveLength(MAX_STORED_WARNINGS - 1);
      expect(merged.filter(w => w.priority === 'LOW')).toHaveLength(0);
      expect(merged.filter(w => w.key === 'StoredWarningsUnavailable')).toHaveLength(1);
      expect(stored[0]!.priority).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('keeps incoming stop and HIGH warnings when matching is over budget', () => {
    const many = Array.from({ length: MAX_STORED_WARNINGS + 1 }, (_, i) => ({ key: 'Joint', message: 'Gap ' + i }));
    const critical: EngineWarning[] = [{ key: 'SIM_ABORT', message: 'Stopped' },
      { key: 'Danger', message: 'Unsafe', priority: 'HIGH' }];
    const incoming = [...many, ...critical];
    const unavailable = expect.objectContaining({ key: 'StoredWarningsUnavailable' });
    expect(mergeStoredWarnings(undefined, incoming)).toEqual([...critical, unavailable]);
    expect(mergeStoredWarnings([], incoming)).toEqual([...critical, unavailable]);
    expect(mergeStoredWarnings([text], incoming)).toEqual([critical[0], text, critical[1], unavailable]);
    expect(mergeStoredWarnings(incoming, [text])).toEqual([...critical, text, unavailable]);
    open(write());
    const summary = loadRuns()[0]!;
    const restored = restoreRun({ ...summary, importedSummary: undefined, simWarnings: incoming }, null);
    for (const rows of [restored, loadRuns()]) {
      expect(rows[0]!.simWarnings).toEqual(expect.arrayContaining(critical));

    }
    expect(loadRuns()[0]!.simWarnings!.some(w => w.key === 'StoredWarningsUnavailable')).toBe(true);
  });

  it.each([100, 1000])('bounds duplicate-summary warning visits linearly (%i summaries)', count => {
    const summary = importOrk(write()).storedSimulations![0]!;
    const critical: EngineWarning[] = [
      { key: 'SIM_ABORT', message: 'First stopped' },
      { key: 'Danger', message: 'First unsafe', priority: 'HIGH' },
      { key: 'SIM_ABORT', message: 'Last stopped' },
      { key: 'Danger', message: 'Last unsafe', priority: 'HIGH' },
    ];
    const simulations = Array.from({ length: count }, (_, i) => {
      // Distinct keys make copies incompatible. Repeated references keep the
      // adversarial fixture small without changing its occurrence count.
      const warnings: EngineWarning[] = Array(MAX_STORED_WARNINGS).fill({ key: `Copy${i}`, message: 'Warning' });
      if (i < 2) warnings[0] = critical[i]!;
      if (i >= count - 2) warnings[0] = critical[i - count + 4]!;
      expect(boundedWarningEvidence(warnings)).toBe(true);
      return { ...summary, data: { ...summary.data, simWarnings: warnings } };
    });
    const normalize = warningStorage.restoredWarnings;
    let visits = 0;
    let largestInput = 0;
    const limit = 4 * count * MAX_STORED_WARNINGS;
    const spy = vi.spyOn(warningStorage, 'restoredWarnings').mockImplementation(warnings => {
      // Count elements traversed by normalization. Clear mock history so the
      // negative proof cannot retain the faulty chain's growing arrays.
      spy.mockClear();
      visits += warnings?.length ?? 0;
      largestInput = Math.max(largestInput, warnings?.length ?? 0);
      if (visits > limit) throw new Error('Duplicate-summary warning visits exceeded the linear bound');
      return normalize(warnings);
    });
    let plan: ReturnType<typeof planSummaryImport>;
    try {
      plan = planSummaryImport({ name: 'Repeated flight', storedSimulations: simulations });
    } finally { spy.mockRestore(); }
    expect(visits).toBeGreaterThan(0);
    expect(visits).toBeLessThanOrEqual(limit);
    expect(largestInput).toBeLessThanOrEqual(MAX_STORED_WARNINGS);
    expect(plan.total).toBe(count);
    expect(plan.runs).toHaveLength(1);
    expect(new Set(plan.summaryIds).size).toBe(1);
    const warnings = plan.runs[0]!.simWarnings!;
    expect(warnings.length).toBeLessThanOrEqual(MAX_STORED_WARNINGS);
    expect(boundedWarningEvidence(warnings)).toBe(true);
    expect(warnings).toEqual(expect.arrayContaining([critical[0]!]));
    expect(warnings).not.toEqual(expect.arrayContaining([critical[1]!]));
    expect(warningMergeNotes(plan.warningMergeBudget)).toEqual([
      expect.stringContaining(`${count - 1} later copies of this flight carried warnings that were not merged`),
    ]);
    expect(simulations[0]!.data.simWarnings).toHaveLength(MAX_STORED_WARNINGS);
  }, 30000);

  it.each(['wide', 'high-wide', 'large-then-tiny', 'distinct', 'enriched', 'high-then-low', 'nested-then-tiny'] as const)(
    'Round 6 counts fields, copies and comparisons through admission (%s)', shape => {
      const summary = importOrk(write()).storedSimulations![0]!;
      const plain = { key: 'X', message: 'm' };
      const high = { ...plain, priority: 'HIGH' as const };
      const wide = { ...plain, ...Object.fromEntries(Array.from({ length: 16_380 }, (_, i) => ['k' + i, null])) };
      const group = (warning: EngineWarning, length = MAX_STORED_WARNINGS) => Array<EngineWarning>(length).fill(warning);
      const arrays = shape === 'wide' ? [[plain], [wide]]
        : shape === 'high-wide' ? [group(high), [wide]]
        : shape === 'large-then-tiny' ? [group(high, 4095), ...Array.from({ length: 999 }, () => [high])]
        : shape === 'distinct' ? Array.from({ length: 1000 }, (_, i) => [{ key: 'Y' + i, message: 'm' }])
        : shape === 'enriched' ? [group(plain), group(high)]
        : shape === 'nested-then-tiny' ? [[{ ...plain, evidence: Object.fromEntries(Array.from({ length: 13_300 }, (_, i) => ['k' + i, 1])) }],
          ...Array.from({ length: 999 }, (_, i) => [{ key: 'Y' + i, message: 'm' }])]
        : [[high], ...Array.from({ length: 20 }, () => group({ ...plain, priority: 'LOW' as const }))];
      const evidenceSize = (value: unknown): number => 1 + (value !== null && typeof value === 'object'
        ? Object.values(value).reduce<number>((n, child) => n + evidenceSize(child), 0) : 0);
      const totalRead = arrays.reduce((sum, warnings) => sum + warnings.reduce((n, warning) => n + evidenceSize(warning), 0), 0);
      const limit = MAX_WARNING_MERGE_WORK + 8 * totalRead;
      let measured = 0;
      const count = (n = 1) => {
        measured += n;
        if (measured > limit) throw new Error('Round 6 actual warning work exceeded ' + limit + ': ' + measured);
      };
      const observed = new WeakMap<object, EngineWarning>();
      const watched = arrays.map(warnings => warnings.map(warning => {
        let proxy = observed.get(warning);
        if (!proxy) {
          proxy = new Proxy(warning, {
            get(target, key, receiver) { count(); return Reflect.get(target, key, receiver); },
            ownKeys(target) { const result = Reflect.ownKeys(target); count(result.length); return result; },
            getOwnPropertyDescriptor(target, key) { count(); return Reflect.getOwnPropertyDescriptor(target, key); },
          });
          observed.set(warning, proxy);
        }
        return proxy;
      }));
      // Count every field enumerated, including generated objects. Unlike the
      // former Object.entries CALL counter, a wide object costs its full width.
      const entries = Object.entries, keys = Object.keys, values = Object.values;
      const ownNames = Reflect.ownKeys, fromEntries = Object.fromEntries;
      const entriesSpy = vi.spyOn(Object, 'entries').mockImplementation(value => {
        entriesSpy.mockClear(); const result = entries(value); count(result.length); return result;
      });
      const keysSpy = vi.spyOn(Object, 'keys').mockImplementation(value => {
        keysSpy.mockClear(); const result = keys(value); count(result.length); return result;
      });
      const valuesSpy = vi.spyOn(Object, 'values').mockImplementation(value => {
        valuesSpy.mockClear(); const result = values(value); count(result.length); return result;
      });
      const namesSpy = vi.spyOn(Reflect, 'ownKeys').mockImplementation(value => {
        namesSpy.mockClear(); const result = ownNames(value); count(result.length); return result;
      });
      const copySpy = vi.spyOn(Object, 'fromEntries').mockImplementation(entries => {
        copySpy.mockClear(); const fields = [...entries]; count(fields.length);
        return fromEntries(fields);
      });
      // All Map lookups include field comparisons in compatible(), even if no
      // original input object is read again. Numeric candidate accesses also
      // measure DFS reroutes, independently of the internal step guard.
      const NativeMap = Map;
      class CountedMap<K, V> extends NativeMap<K, V> {
        override get(key: K): V | undefined { count(); return super.get(key); }
      }
      const filter = Array.prototype.filter;
      const filterSpy = vi.spyOn(Array.prototype, 'filter').mockImplementation(function (this: unknown[], predicate, thisArg) {
        filterSpy.mockClear();
        const result = filter.call(this, (value, at, array) => {
          count(); return predicate.call(thisArg, value, at, array);
        });
        if (!Number.isInteger(this[0])) return result;
        return new Proxy(result, { get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) count();
          return Reflect.get(target, key, receiver);
        } });
      });
      vi.stubGlobal('Map', CountedMap);
      let plan: ReturnType<typeof planSummaryImport>;
      try {
        plan = planSummaryImport({ name: 'Adversarial warnings', storedSimulations: watched.map(simWarnings =>
          ({ ...summary, data: { ...summary.data, simWarnings } })) });
      } finally {
        vi.unstubAllGlobals(); filterSpy.mockRestore(); copySpy.mockRestore(); namesSpy.mockRestore();
        valuesSpy.mockRestore(); keysSpy.mockRestore(); entriesSpy.mockRestore();
        console.info('Round 6 work', { shape, totalRead, measured, limit });
      }
      expect(measured).toBeGreaterThan(0);
      expect(measured).toBeLessThanOrEqual(limit);
      expect(plan.runs).toHaveLength(1);
      expect(boundedWarningEvidence(plan.runs[0]!.simWarnings!)).toBe(true);
      expect(plan.warningMergeBudget.skippedCopies.get('flight') ?? 0).toBe(
        shape === 'large-then-tiny' ? 983 : shape === 'distinct' || shape === 'nested-then-tiny' ? 638
          : shape === 'enriched' ? 1 : shape === 'high-then-low' ? 10 : 0);
      if (shape === 'wide' || shape === 'high-wide') {
        expect(plan.runs[0]!.simWarnings!.some(w => w.key === 'StoredWarningsUnavailable')).toBe(true);
      } else {
        expect(plan.warningMergeBudget.remaining).toBe(0);
        expect(warningMergeNotes(plan.warningMergeBudget)).toHaveLength(1);
        expect(warningMergeNotes(plan.warningMergeBudget)[0]).toContain('warnings that were not merged');
      }
    });

  it('shares exhausted admission with persistence and retains each stored row', () => {
    open(write());
    const base = loadRuns()[0]!;
    const plain = { key: 'X', message: 'm' };
    const high = { ...plain, priority: 'HIGH' as const };
    const low = { ...plain, priority: 'LOW' as const };
    const existing = [{ ...base, id: 'first', simWarnings: [plain, high] },
      { ...base, id: 'second', simWarnings: [plain, low] }];
    addRuns(existing);
    const work = createWarningMergeBudget();
    work.remaining = 0;
    const updated = existing.map(row => ({ ...row, simWarnings: [high, low, high] }));
    const snapshot = structuredClone(existing);
    const saved = appendImportedRuns([], updated, work);
    expect(saved.find(row => row.id === 'first')!.simWarnings).toEqual([plain, high]);
    expect(saved.find(row => row.id === 'second')!.simWarnings).toEqual([plain, low]);
    expect(warningMergeNotes(work)).toHaveLength(2);
    expect(existing).toEqual(snapshot);
    expect(work.remaining).toBe(0);

    // Legacy callers without a planner still get one counter per batch.
    const factory = vi.spyOn(warningIdentity, 'createWarningMergeBudget').mockReturnValue(work);
    try {
      appendImportedRuns([], existing.map(row => ({ ...row, simWarnings: [plain, plain] })));
      expect(factory).toHaveBeenCalledTimes(1);
    } finally { factory.mockRestore(); }
  });

  it('charges recursive evidence and abandons an unfinished DFS path atomically', () => {
    const broad = { key: 'X', message: 'm' };
    const stored = [broad, { ...broad, extra: { nested: [1, 2] } }];
    const incoming = [{ ...broad, extra: { nested: [1, 2] }, priority: 'HIGH' as const }];
    const work = createWarningMergeBudget();
    work.remaining = 12; // Ends within sameEvidence's nested evidence walk.
    expect(mergeStoredWarnings(stored, incoming, work)).toEqual([...stored, ...incoming]);
    expect(work.remaining).toBe(0);

    const q1 = { ...broad, quantity: { kind: 'velocity' as const, value: 1 } };
    const q2 = { ...broad, quantity: { kind: 'velocity' as const, value: 2 } };
    const first = { ...q1, priority: 'HIGH' as const };
    const second = { ...q2, priority: 'LOW' as const };
    // Probe every exhaustion boundary, including just before reroute commit.
    for (let remaining = 1; remaining < 100; remaining++) {
      const budget = createWarningMergeBudget();
      budget.remaining = remaining;
      const merged = mergeStoredWarnings([broad, q1, q2], [first, second], budget)!;
      expect(merged.filter(w => w.priority === 'HIGH')).toHaveLength(1);
      expect(merged.filter(w => w.priority === 'LOW')).toHaveLength(1);
      expect(merged.filter(w => w.quantity?.value === 1).length).toBeGreaterThanOrEqual(1);
      expect(merged.filter(w => w.quantity?.value === 2).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('retains 300 live warnings through another flight, reload, export, reopen and Undo', () => {
    open(write());
    const summary = loadRuns()[0]!;
    deleteRun(summary.id);
    const warnings: EngineWarning[] = Array.from({ length: 299 }, (_, i) => ({ key: 'Joint', message: 'Gap ' + i,
      priority: i % 2 ? 'NORMAL' : 'LOW' }));
    warnings.push({ key: 'SIM_ABORT', message: 'Stopped', priority: 'HIGH' });
    const live = { ...summary, importedSummary: undefined, simWarnings: warnings };
    addRun(live);
    addRun({ ...live, id: 'second', importedRunId: undefined });
    expect(loadRuns().find(r => r.id === live.id)!.simWarnings).toEqual(warnings);
    expect(importOrk(write(warnings)).storedSimulations![0]!.data.simWarnings).toEqual(warnings);
    deleteRun(live.id);
    open(write());
    expect(restoreRun(live, null).find(r => r.id === live.id)!.simWarnings).toEqual(warnings);
    expect(loadRuns().find(r => r.id === live.id)!.simWarnings).toEqual(warnings);
  });
  it('exports oversized warnings as readable critical evidence with an explicit note', () => {
    const critical: EngineWarning[] = [{ key: 'SIM_ABORT', message: 'Stopped' },
      { key: 'Danger', message: 'Unsafe', priority: 'HIGH' }];
    const warnings = [...Array.from({ length: MAX_STORED_WARNINGS + 1 }, () => ({ key: 'Joint', message: 'Gap' })), ...critical];
    const first = importOrk(write(warnings));
    const saved = first.storedSimulations![0]!.data.simWarnings!;
    expect(saved).toEqual(expect.arrayContaining(critical));
    expect(saved.some(w => w.key === 'StoredWarningsUnavailable')).toBe(true);
    expect(boundedWarningEvidence(saved)).toBe(true);
    expect(importOrk(write(saved)).storedSimulations![0]!.data.simWarnings).toEqual(saved);
  });
});
