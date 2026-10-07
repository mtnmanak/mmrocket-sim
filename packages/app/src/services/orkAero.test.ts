// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { exportOrk, importOrk, type OrkExportFlightData } from './orkFile.js';
import { importedSummaryRuns, planSummaryImport, summaryImportCounts, summaryOf } from './orkFlightData.js';
import { aeroModelLabel, deploymentVerdict, pressureThrustActive, runMatchesModel, type DeploymentReport } from './simReport.js';
import { APP_HYBRID_BAND } from './aeroProvenance.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { addRuns, appendImportedRuns, deleteRun, restoreRun, loadRuns, MAX_RUNS, runCapNote, runsEvictedByLastWrite, runsEvictedForUndoByLastWrite, runsToTable, runsToCsv } from './simStore.js';
import { parseXml } from './xmlParse.js';
import { BASE_DRAG_DECLARATION } from './baseDragImportNotes.js';

const write = (data: OrkExportFlightData) => exportOrk({
  name: 'Provenance test', tree: { name: 'Provenance test', components: [{ type: 'stage', children: [
    { type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001 },
  ] }] },
  launch: DEFAULT_CONDITIONS,
  configs: [{ id: 'c1', name: 'Stored flight', isDefault: true, motors: {} }],
  activeConfigId: 'c1', flightData: { c1: { maxAltitude: 123, ...data } },
});

describe('.ork stored-run de-duplication', () => {
  beforeEach(() => localStorage.clear());
  const open = (xml: string) => {
    const plan = planSummaryImport(importOrk(xml), loadRuns());
    if (plan.runs.length) appendImportedRuns(plan.runs);
    return plan.runs;
  };

  it.each(['flight-1', undefined])('opening twice adds no duplicates (runid=%s)', (runId) => {
    const xml = write({ runId, aeroModel: 'classic', rogersKbf: false });
    expect(open(xml)).toHaveLength(1);
    const before = localStorage.getItem('online-openrocket.sim-runs.v1');
    expect(open(xml)).toEqual([]);
    expect(loadRuns()).toHaveLength(1);
    expect(localStorage.getItem('online-openrocket.sim-runs.v1')).toBe(before);
  });

  it('escapes and restores the exact app run ID', () => {
    const runId = 'flight-"<&>\nnext&line';
    const xml = write({ runId, aeroModel: 'classic' });
    expect(xml).toContain('runid="flight-&quot;&lt;&amp;&gt;&#10;next&amp;line"');
    expect(open(xml)[0]!.id).toBe(runId);
    expect(open(write(summaryOf(loadRuns()[0]!)))).toEqual([]);
    expect(loadRuns()[0]!.id).toBe(runId);
  });

  it('save then reopen in the same session keeps the original run', () => {
    const run = importedSummaryRuns(importOrk(write({ aeroModel: 'classic' })))[0]!;
    const original = { ...run, id: 'app-flight', importedSummary: undefined, designKey: 'original-evidence' };
    addRuns([original]);
    expect(summaryOf(original).runId).toBe(original.id);
    expect(open(write(summaryOf(original)))).toEqual([]);
    expect(loadRuns()).toHaveLength(1);
    expect(loadRuns()[0]!.designKey).toBe('original-evidence');
  });

  it.each([true, false])('adds different runs from two files (with IDs=%s)', (withIds) => {
    expect(open(write({ runId: withIds ? 'first' : undefined, aeroModel: 'classic' }))).toHaveLength(1);
    expect(open(write({ runId: withIds ? 'second' : undefined, aeroModel: 'classic', maxAltitude: 456 }))).toHaveLength(1);
    expect(loadRuns().map((r) => r.maxAltitude)).toEqual([123, 456]);
  });

  it('keeps distinct explicit IDs even with identical summary values', () => {
    open(write({ runId: 'first', aeroModel: 'classic' }));
    expect(open(write({ runId: 'second', aeroModel: 'classic' }))).toHaveLength(1);
    expect(loadRuns()).toHaveLength(2);
  });

  it('preserves conflicting explicit IDs and recognizes both on repeated opens', () => {
    open(write({ runId: 'same-flight', aeroModel: 'classic' }));
    const changed = write({ runId: 'same-flight', aeroModel: 'classic', maxAltitude: 456 });
    expect(open(changed)).toHaveLength(1);
    expect(loadRuns().map((r) => r.maxAltitude)).toEqual([123, 456]);
    expect(new Set(loadRuns().map((r) => r.id)).size).toBe(2);
    expect(open(changed)).toEqual([]);
    expect(open(write({ runId: 'same-flight', aeroModel: 'classic' }))).toEqual([]);
    // The remapped identity survives storage and loss of the first conflicting row.
    localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify([loadRuns()[1]]));
    expect(open(changed)).toEqual([]);
  });

  it('matches a legacy tag to an existing run with a different app ID', () => {
    const xml = write({ aeroModel: 'classic', rogersKbf: false });
    const run = importedSummaryRuns(importOrk(xml))[0]!;
    addRuns([{ ...run, id: 'previous-app-id' }]);
    expect(open(xml)).toEqual([]);
    expect(loadRuns()[0]!.id).toBe('previous-app-id');
  });

  it.each([false, true])('Undo upgrades the same reopened flight without duplication or eviction (full=%s)', (full) => {
    const summary = importedSummaryRuns(importOrk(write({ runId: 'X', aeroModel: 'hybrid', hybridBand: [0.7, 1.4] })))[0]!;
    const original = { ...summary, importedSummary: undefined, when: 12345,
      designKey: 'original-design', conditionsKey: 'original-conditions', nozzleStages: ['stage'],
      motorSetKey: 'original-motors', physicsRevision: 'original-kernel', comments: 'Original report' };
    addRuns([original]);
    deleteRun('X');
    const unrelated = Array.from({ length: full ? MAX_RUNS - 1 : 1 }, (_, i) => ({
      ...summary, id: `unrelated-${i}`, importedRunId: undefined,
    }));
    addRuns(unrelated);
    open(write(summaryOf(original)));
    const before = loadRuns().filter((r) => r.id !== 'X');
    const restored = restoreRun(original, null);
    expect(restored).toHaveLength(full ? MAX_RUNS : 2);
    expect(restored.filter((r) => r.id !== 'X')).toEqual(before);
    expect(restored.find((r) => r.id === 'X')).toMatchObject({
      designKey: 'original-design', conditionsKey: 'original-conditions', motorSetKey: 'original-motors',
      physicsRevision: 'original-kernel', comments: 'Original report', when: 12345,
    });
    expect(restored.find((r) => r.id === 'X')!.importedSummary).toBeUndefined();
    expect(runsEvictedByLastWrite()).toBe(0);
    expect(runsEvictedForUndoByLastWrite()).toBe(0);
    expect(open(write(summaryOf(original)))).toEqual([]);
    expect(restoreRun(summary, null)).toEqual(loadRuns());
    expect(loadRuns().find((r) => r.id === 'X')!.designKey).toBe('original-design'); // No downgrade.
  });

  it('Undo finds the same flight after its imported ID was remapped', () => {
    open(write({ runId: 'X', aeroModel: 'classic', maxAltitude: 456 }));
    open(write({ runId: 'X', aeroModel: 'classic', maxAltitude: 123 }));
    const imported = loadRuns()[1]!;
    const original = { ...imported, id: 'X', importedSummary: undefined, designKey: 'original' };
    const restored = restoreRun(original, null);
    expect(restored).toHaveLength(2);
    expect(restored[0]!.maxAltitude).toBe(456);
    expect(restored[1]).toMatchObject({ id: imported.id, importedRunId: 'X', designKey: 'original' });
    expect(summaryOf(restored[1]!).runId).toBe('X');
  });

  it.each([false, true])('Undo preserves a conflicting import and both identities (full=%s)', (full) => {
    const a = write({ runId: 'X', aeroModel: 'classic', maxAltitude: 123 });
    const b = write({ runId: 'X', aeroModel: 'classic', maxAltitude: 456 });
    open(a);
    const deleted = loadRuns()[0]!;
    deleteRun('X');
    if (full) addRuns(Array.from({ length: MAX_RUNS - 1 }, (_, i) => ({
      ...deleted, id: i === 0 ? 'restored-conflict:X' : `unrelated-${i}`, importedRunId: undefined,
    })));
    open(b);
    const restored = restoreRun(deleted, null);
    expect(restored.filter((r) => r.id === 'X')).toHaveLength(1);
    expect(restored.find((r) => r.id === 'X')!.maxAltitude).toBe(123);
    const conflict = restored.find((r) => r.maxAltitude === 456)!;
    expect(conflict).toMatchObject({ importedRunId: 'X', maxAltitude: 456 });
    expect(conflict.id).not.toBe('X');
    expect(new Set(restored.map((r) => r.id)).size).toBe(restored.length);
    expect(restored).toHaveLength(full ? MAX_RUNS : 2);
    expect(runsEvictedByLastWrite()).toBe(0);
    expect(runCapNote(0, 0, runsEvictedForUndoByLastWrite())).toBe(full
      ? 'Saved simulations keeps up to 500 runs, so Undo kept the restored run and any conflicting report and removed the oldest 1 other run in history.' : '');
    if (full) {
      expect(restored.some((r) => r.id === 'unrelated-498')).toBe(false);
      expect(restored.some((r) => r.id === 'restored-conflict:X')).toBe(true);
    }
    const bytes = localStorage.getItem('online-openrocket.sim-runs.v1');
    expect(open(a)).toEqual([]);
    expect(open(b)).toEqual([]);
    restoreRun(deleted, null);
    expect(localStorage.getItem('online-openrocket.sim-runs.v1')).toBe(bytes);
    deleteRun('X');
    expect(open(b)).toEqual([]);
    expect(open(a)).toHaveLength(1);
    expect(loadRuns().find((r) => r.id === conflict.id)!.maxAltitude).toBe(456);
  });

  it.each(['config', 'model', 'kbf', 'band'])('legacy fingerprint distinguishes %s', (field) => {
    const xml = write({ aeroModel: 'hybrid', rogersKbf: true, hybridBand: [0.8, 1.2] });
    open(xml);
    const changed = field === 'config' ? xml.replaceAll('c1', 'c2')
      : field === 'model' ? xml.replace('>hybrid</aeromodel>', '>supersonic</aeromodel>')
        : field === 'kbf' ? xml.replace('kbf="true"', 'kbf="false"')
          : xml.replace('band="0.8 1.2"', 'band="0.7 1.3"');
    expect(open(changed)).toHaveLength(1);
    expect(loadRuns()).toHaveLength(2);
  });

  it.each([
    'maxAltitude', 'maxVelocity', 'maxAcceleration', 'maxMach', 'timeToApogee',
    'flightTime', 'groundHitVelocity', 'launchRodVelocity', 'deploymentVelocity', 'optimumDelay',
  ] as const)('legacy fingerprint independently distinguishes %s', (field) => {
    const data = { aeroModel: 'classic' as const, [field]: 12 };
    expect(open(write(data))).toHaveLength(1);
    expect(open(write({ ...data, [field]: 13 }))).toHaveLength(1);
    expect(loadRuns()).toHaveLength(2);
  });

  it.each([false, true])('oversized file fills only free slots without changing existing history (mixed history=%s)', (mixed) => {
    const seed = importOrk(write({ runId: 'flight-0', aeroModel: 'classic' }));
    const imported = { ...seed, storedSimulations: Array.from({ length: MAX_RUNS + 1 }, (_, i) => ({
      ...seed.storedSimulations![0]!, data: { ...seed.storedSimulations![0]!.data, runId: `flight-${i}` },
    })) };
    if (mixed) {
      const run = importedSummaryRuns(seed)[0]!;
      addRuns([...Array.from({ length: MAX_RUNS - 1 }, (_, i) => ({ ...run, id: `unrelated-${i}`, importedRunId: undefined })), run]);
    }
    const plan = planSummaryImport(imported, loadRuns());
    const kept = appendImportedRuns(plan.runs);
    expect(summaryImportCounts(plan, kept)).toEqual({ added: mixed ? 0 : 500, updated: 0, alreadySaved: mixed ? 1 : 0, notKept: mixed ? 500 : 1 });
    expect(kept).toHaveLength(MAX_RUNS);
    const before = localStorage.getItem('online-openrocket.sim-runs.v1');
    for (let attempt = 0; attempt < 3; attempt++) {
      const again = planSummaryImport(imported, loadRuns());
      expect(again.runs).toEqual([]);
      expect(summaryImportCounts(again, loadRuns())).toEqual({ added: 0, updated: 0, alreadySaved: mixed ? 1 : 500, notKept: mixed ? 500 : 1 });
      expect(localStorage.getItem('online-openrocket.sim-runs.v1')).toBe(before);
    }
    if (!mixed) {
      deleteRun('flight-0');
      const freed = planSummaryImport(imported, loadRuns());
      expect(summaryImportCounts(freed, appendImportedRuns(freed.runs))).toEqual({ added: 1, updated: 0, alreadySaved: 499, notKept: 1 });
    }
  });

  it('counts repeated file rows as not kept when storage refuses their new report', () => {
    const seed = importOrk(write({ runId: 'new', aeroModel: 'classic' }));
    const plan = planSummaryImport({ ...seed, storedSimulations: [...seed.storedSimulations!, ...seed.storedSimulations!] });
    const storage = localStorage;
    vi.stubGlobal('localStorage', {
      getItem: storage.getItem.bind(storage),
      setItem: () => { throw new Error('quota'); },
    });
    try {
      const kept = appendImportedRuns(plan.runs);
      expect(summaryImportCounts(plan, kept)).toEqual({ added: 0, updated: 0, alreadySaved: 0, notKept: 2 });
    } finally { vi.unstubAllGlobals(); }
  });

  it('counts an overflow row as already saved when it remains in history', () => {
    const seed = importOrk(write({ runId: 'in-window', aeroModel: 'classic' }));
    const overflow = importOrk(write({ runId: 'overflow', aeroModel: 'classic' }));
    addRuns(importedSummaryRuns(overflow));
    const plan = planSummaryImport({ ...seed, storedSimulations: [
      ...Array.from({ length: MAX_RUNS }, () => seed.storedSimulations![0]!),
      overflow.storedSimulations![0]!,
    ] }, loadRuns());
    const kept = appendImportedRuns(plan.runs);
    expect(kept).toHaveLength(2);
    expect(summaryImportCounts(plan, kept)).toEqual({ added: 1, updated: 0, alreadySaved: 500, notKept: 0 });
  });

  it('fills free slots after duplicate rows, including new summaries beyond file row 500', () => {
    const seed = importOrk(write({ runId: 'duplicate', aeroModel: 'classic' }));
    const extra = importOrk(write({ runId: 'extra', aeroModel: 'classic', maxAltitude: 456 }));
    const imported = { ...seed, storedSimulations: [
      ...Array.from({ length: MAX_RUNS }, () => seed.storedSimulations![0]!),
      extra.storedSimulations![0]!,
    ] };
    const plan = planSummaryImport(imported, loadRuns());
    const saved = appendImportedRuns(plan.runs);
    expect(saved.map((r) => r.id)).toEqual(['duplicate', 'extra']);
    expect(summaryImportCounts(plan, saved)).toEqual({ added: 2, updated: 0, alreadySaved: 499, notKept: 0 });
  });

  it('legacy fingerprint ignores XML number formatting, names and unknown summary fields', () => {
    const xml = write({ aeroModel: 'classic', rogersKbf: false });
    open(xml);
    expect(open(xml.replace('maxaltitude="123"', 'maxaltitude="123.000" maxvelocity="NaN"')
      .replaceAll('Provenance test', 'Renamed file'))).toEqual([]);
  });

  it.each(['same-id', undefined])('collapses repeated simulations within one file (runid=%s)', (runId) => {
    const xml = write({ runId, aeroModel: 'classic' });
    const sim = xml.match(/<simulation status=[\s\S]*?<\/simulation>/)![0];
    expect(open(xml.replace('</simulations>', `${sim}</simulations>`))).toHaveLength(1);
  });

  it('still caps history and does not evict more runs on a duplicate open', () => {
    const run = importedSummaryRuns(importOrk(write({ aeroModel: 'classic' })))[0]!;
    addRuns(Array.from({ length: MAX_RUNS }, (_, i) => ({ ...run, id: `existing-${i}` })));
    const xml = write({ runId: 'new-flight', aeroModel: 'hybrid' });
    expect(open(xml)).toEqual([]);
    expect(loadRuns()).toHaveLength(MAX_RUNS);
    expect(runsEvictedByLastWrite()).toBe(0);
    expect(loadRuns().some((r) => r.id === `existing-${MAX_RUNS - 1}`)).toBe(true);
    const ids = loadRuns().map((r) => r.id);
    expect(open(xml)).toEqual([]);
    expect(loadRuns().map((r) => r.id)).toEqual(ids);
  });
});

describe('.ork aero provenance', () => {
  it.each([
    ['classic', false, 'Classic Extended Barrowman', false],
    ['classic', true, 'Rogers Modified Barrowman (Kbf)', true],
    ['supersonic', false, 'Supersonic (our extended model)', true],
    ['auto-supersonic', false, 'Supersonic (auto — flight exceeded Mach 0.9)', true],
    ['hybrid', true, 'Hybrid (experimental)', true],
  ] as const)('restores %s Kbf=%s to the run, label and physics comparison', (aeroModel, rogersKbf, label, pressure) => {
    const data = { aeroModel, rogersKbf, ...(aeroModel === 'hybrid' ? { hybridBand: APP_HYBRID_BAND } : {}) };
    const xml = write(data);
    const doc = parseXml(xml.replace(/<\?xml[^?]*\?>/, ''), 'aero provenance test');
    const simulation = doc.querySelector('openrocket > simulations > simulation');
    const tag = simulation?.querySelector(':scope > aeromodel');
    expect(tag?.textContent).toBe(aeroModel);
    expect(tag?.getAttribute('kbf')).toBe(String(rogersKbf));
    expect(doc.querySelector('conditions > aeromodel')).toBeNull();
    expect(doc.querySelector('flightdata > aeromodel')).toBeNull();
    expect(doc.querySelector('simulation > calculator')?.textContent).toBe('BarrowmanCalculator');
    const loaded = importOrk(xml);
    const run = importedSummaryRuns(loaded)[0]!;
    expect(run).toMatchObject({ ...data, maxAltitude: 123, flightConfigId: 'c1', importedSummary: true });
    expect(aeroModelLabel(run.aeroModel, run.rogersKbf)).toBe(label);
    expect(pressureThrustActive(run)).toBe(pressure);
    expect(runMatchesModel(run, { aeroMode: aeroModel === 'auto-supersonic' ? 'auto' : aeroModel,
      effectiveKbf: rogersKbf, autoSupersonic: true })).toBe(true);
    expect(runMatchesModel(run, { aeroMode: aeroModel === 'hybrid' ? 'classic' : 'hybrid',
      effectiveKbf: false, autoSupersonic: false })).toBe(false);
    expect(run.designKey).toBeUndefined();
    expect(run.physicsRevision).toBeUndefined();
    expect(run.safeLandingRate).toBeNull();
    expect(Number.isFinite(run.when)).toBe(false);
    localStorage.clear();
    addRuns([run]);
    const revived = loadRuns()[0]!;
    expect(revived).toMatchObject(data);
    const table = runsToTable([revived]);
    for (const column of ['Date', 'Diameter (mm)', 'Delay (s)', 'Execution time (ms)', 'Motors (cluster)']) {
      expect(table.rows[0]![table.headers.indexOf(column)]).toBe('');
    }
    expect(importOrk(write(summaryOf(revived))).storedSimulations?.[0]?.data).toMatchObject(data);
    expect(loaded).not.toHaveProperty('aeroModel');
    expect(loaded.launch).not.toHaveProperty('aeroModel');
  });

  it.each(['', '<aeromodel kbf="true">future-model</aeromodel>'])('leaves absent/unknown provenance unknown: %s', (tag) => {
    const xml = write({}).replace('<calculator>BarrowmanCalculator</calculator>',
      `<calculator>BarrowmanCalculator</calculator>${tag}`);
    const loaded = importOrk(xml);
    expect(loaded.storedSimulations).toBeUndefined();
    expect(importedSummaryRuns(loaded)).toEqual([]);
    expect(loaded.configs).toHaveLength(1);
  });

  it.each(['-1 1', '1 1', '2 1', 'NaN 1.2', '0.8 Infinity', '0.8', '0.8 1.2 2', ''])('ignores malformed band %s without losing the model', (band) => {
    const xml = write({ aeroModel: 'hybrid' }).replace('<aeromodel>', `<aeromodel band="${band}">`);
    const run = importedSummaryRuns(importOrk(xml))[0]!;
    expect(run.aeroModel).toBe('hybrid');
    expect(run.hybridBand).toBeUndefined();
    expect(summaryOf(run).hybridBand).toBeUndefined();
  });

  it('preserves a non-default historical band and refuses to guess an unknown Kbf flag', () => {
    const run = importedSummaryRuns(importOrk(write({ aeroModel: 'hybrid', hybridBand: [0.7, 1.4] })))[0]!;
    expect(run.hybridBand).toEqual([0.7, 1.4]);
    expect(summaryOf(run).hybridBand).toEqual([0.7, 1.4]);
    expect(runMatchesModel(run, { aeroMode: 'hybrid', effectiveKbf: true, autoSupersonic: false })).toBe(false);
    const classic = importedSummaryRuns(importOrk(write({ aeroModel: 'classic' }).replace('<aeromodel>', '<aeromodel kbf="maybe">')))[0]!;
    expect(classic.rogersKbf).toBeUndefined();
    expect(aeroModelLabel(classic.aeroModel, classic.rogersKbf)).toBe('Classic (Kbf not recorded)');
    expect(runsToCsv([classic])).toContain('classic (Kbf not recorded)');
    expect(runMatchesModel(classic, { aeroMode: 'classic', effectiveKbf: false, autoSupersonic: false })).toBeNull();
  });

  it('CSV and XLSX table cells leave unknowns blank and preserve both Hybrid bounds after reload', () => {
    localStorage.clear();
    const run = importedSummaryRuns(importOrk(write({ aeroModel: 'hybrid', hybridBand: [0.7, 1.4] })))[0]!;
    addRuns([run]);
    const revived = loadRuns()[0]!;
    const { headers, rows } = runsToTable([revived]);
    // This fixture's comment has a comma; quote-aware cells keep the later
    // provenance columns aligned with their headers.
    const csv = runsToCsv([revived]).split('\n')[1]!.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    for (const column of ['Date', 'Diameter (mm)', 'Delay (s)', 'Execution time (ms)', 'Motors (cluster)',
      'Winds aloft (levels)', 'Wind avg (m/s)', 'Designation', 'Velocity (mph)', 'Accel (Gs)', 'Lift-off speed OK',
      'Rail for 15.0 m/s (m)', 'Max dynamic pressure (Pa)', 'Time at max Q (s)', 'Altitude at max Q (m)',
      'Max q·α (Pa·rad)', 'Max q·α (Pa·deg)', 'Time at max q·α (s)', 'Altitude at max q·α (m)',
      'Mach at max q·α', 'Angle of attack at max q·α (rad)', 'Angle of attack at max q·α (deg)']) {
      expect(rows[0]![headers.indexOf(column)], column).toBe('');
      expect(csv[headers.indexOf(column)], column).toBe('');
    }
    for (const [column, value] of [['Hybrid band lower (Mach)', 0.7], ['Hybrid band upper (Mach)', 1.4]] as const) {
      expect(rows[0]![headers.indexOf(column)]).toBe(value);
      expect(csv[headers.indexOf(column)]).toBe(String(value));
    }
    const known = runsToTable([{ ...revived, windLevels: [], hybridBand: undefined }]);
    expect(known.rows[0]![headers.indexOf('Winds aloft (levels)')]).toBe(0);
    expect(known.rows[0]![headers.indexOf('Hybrid band lower (Mach)')]).toBe('');
    expect(known.rows[0]![headers.indexOf('Hybrid band upper (Mach)')]).toBe('');
  });

  it('preserves the aeromodel and base-drag declaration extensions together on resave', () => {
    const xml = write({ aeroModel: 'hybrid', rogersKbf: true, hybridBand: [0.7, 1.4] })
      .replace('</bodytube>', '<mmrbasedragdeclaration>true</mmrbasedragdeclaration></bodytube>');
    const loaded = importOrk(xml);
    const saved = exportOrk({ name: loaded.name, tree: loaded.tree, launch: DEFAULT_CONDITIONS,
      configs: [{ id: 'c1', name: 'Stored flight', isDefault: true, motors: {} }],
      activeConfigId: 'c1', flightData: { c1: summaryOf(importedSummaryRuns(loaded)[0]!) } });
    expect(saved).toContain('<mmrbasedragdeclaration>true</mmrbasedragdeclaration>');
    expect(saved).toContain('<aeromodel kbf="true" band="0.7 1.4"');
    const reopened = importOrk(saved);
    expect(reopened.tree.components[0]!.children![0]![BASE_DRAG_DECLARATION]).toBe(true);
    expect(importedSummaryRuns(reopened)[0]).toMatchObject({
      aeroModel: 'hybrid', rogersKbf: true, hybridBand: [0.7, 1.4], maxAltitude: 123,
    });
  });

  it('exports imported ground-hit speed separately from unknown landing descent', () => {
    localStorage.clear();
    addRuns(importedSummaryRuns(importOrk(write({ aeroModel: 'classic', groundHitVelocity: 13 }))));
    const revived = loadRuns();
    const { headers, rows } = runsToTable(revived);
    const csv = runsToCsv(revived).split('\n')[1]!.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    expect(rows[0]![headers.indexOf('Landing rate (m/s)')]).toBe('');
    expect(csv[headers.indexOf('Landing rate (m/s)')]).toBe('');
    expect(rows[0]![headers.indexOf('Ground hit velocity (m/s)')]).toBe(13);
    expect(csv[headers.indexOf('Ground hit velocity (m/s)')]).toBe('13');
  });

  it('imported aggregate deployment safety stays unknown after losing the other deployments', () => {
    localStorage.clear();
    const original = { ...importedSummaryRuns(importOrk(write({ aeroModel: 'classic', deploymentVelocity: 1 })))[0]!,
      importedSummary: undefined, deployments: [1, 100].map((velocityAtDeployment) => ({ velocityAtDeployment } as DeploymentReport)) };
    expect(deploymentVerdict(original)).toBe(false);
    addRuns(importedSummaryRuns(importOrk(write(summaryOf(original)))));
    const revived = loadRuns();
    expect(revived[0]!.velocityAtDeployment).toBe(1);
    expect(revived[0]!.deployments).toBeUndefined();
    expect(deploymentVerdict(revived[0]!)).toBeNull();
    const { headers, rows } = runsToTable(revived);
    const csv = runsToCsv(revived).split('\n')[1]!.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    expect(rows[0]![headers.indexOf('Safe deployment')]).toBe('');
    expect(csv[headers.indexOf('Safe deployment')]).toBe('');
  });

  it('keeps each simulation attached to its own configuration, regardless of the selected one', () => {
    const xml = write({ aeroModel: 'classic', rogersKbf: false });
    const sim = xml.match(/<simulation status=[\s\S]*?<\/simulation>/)![0];
    const second = sim.replace('<configid>c1</configid>', '<configid>c2</configid>')
      .replace('>classic</aeromodel>', '>supersonic</aeromodel>').replace('maxaltitude="123"', 'maxaltitude="456"');
    const runs = importedSummaryRuns(importOrk(xml.replace('</simulations>', `${second}</simulations>`)));
    expect(runs.map((r) => [r.flightConfigId, r.aeroModel, r.maxAltitude])).toEqual([
      ['c1', 'classic', 123], ['c2', 'supersonic', 456],
    ]);
  });

  it('does not manufacture a run from provenance without a finite summary', () => {
    const xml = write({ aeroModel: 'hybrid' }).replace('<flightdata maxaltitude="123"/>', '<flightdata maxaltitude="NaN"/>');
    expect(importedSummaryRuns(importOrk(xml))).toEqual([]);
  });

  it('uses the kernel defaults for the app band (the app has no band override)', () => {
    const java = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)),
      '../../../../engine-java/patches/info/openrocket/core/aerodynamics/BarrowmanCalculator.java'), 'utf8');
    expect(APP_HYBRID_BAND).toEqual(['M_LOW', 'M_HIGH'].map((name) => Number(java.match(new RegExp(`${name} = ([0-9.]+);`))![1])));
  });
});
