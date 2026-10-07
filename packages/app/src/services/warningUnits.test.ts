// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineWarning, RocketTree } from '@online-openrocket/engine';
import { formatWarning } from './simWarnings.js';
import { IMPERIAL_UNITS, METRIC_UNITS } from '../prefs/units.js';
import { addRun, loadRuns } from './simStore.js';
import { exportOrk, importOrk } from './orkFile.js';
import { importedSummaryRuns, summaryDocument, summaryOf } from './orkFlightData.js';
import { flushSession, loadSession, saveSessionDebounced } from './session.js';
import { DEFAULT_CONDITIONS } from '../components/LaunchPanel.js';
import type { SimRun } from './simReport.js';

const speed: EngineWarning = {
  key: 'HighSpeedDeployment', priority: 'HIGH',
  message: '[Warning.RECOVERY_HIGH_SPEED] (30.5 m/s):  "Main <&>"',
  quantity: { kind: 'velocity', value: 30.48 },
  sources: [{ id: 'chute-1', name: 'Main <&>' }],
};
const aoa: EngineWarning = {
  key: 'LargeAOA', message: '[Warning.LargeAOA.str2]30 deg)',
  quantity: { kind: 'angle', value: Math.PI / 6 }, sources: [],
};
const tree: RocketTree = { name: 'Warning units', components: [{ type: 'stage', children: [
  { type: 'bodytube', length: 0.3, outerRadius: 0.02, thickness: 0.001 },
] }] };
const run = (warnings = [speed, aoa]): SimRun => ({
  id: 'warning-run', aeroModel: 'classic', maxAltitude: 123, simWarnings: warnings,
}) as SimRun;
const write = (data: ReturnType<typeof summaryOf>) => exportOrk({
  name: tree.name!, tree, launch: DEFAULT_CONDITIONS,
  configs: [{ id: 'c1', name: 'Flight', isDefault: true, motors: {} }],
  activeConfigId: 'c1', flightData: { c1: data },
});
afterEach(() => { flushSession(); localStorage.clear(); });

describe('saved warning units', () => {
  it('formats raw SI velocity and radians with the current units, without changing the payload', () => {
    const before = JSON.stringify([speed, aoa]);
    expect(formatWarning(speed, METRIC_UNITS).detail).toBe('(30.48 m/s): "Main <&>"');
    expect(formatWarning(speed, IMPERIAL_UNITS).detail).toBe('(100 ft/s): "Main <&>"');
    expect(formatWarning(aoa, METRIC_UNITS).detail).toBe('(30 \u00b0)');
    expect(formatWarning(aoa, { ...METRIC_UNITS, angle: 'rad' }).detail).toBe('(0.524 rad)');
    expect(JSON.stringify([speed, aoa])).toBe(before);
  });

  it('keeps old text and unknown warning types legible without guessing units', () => {
    const legacy = { key: speed.key, message: speed.message };
    expect(formatWarning(legacy, IMPERIAL_UNITS).detail).toBe('(30.5 m/s): "Main <&>"');
    expect(formatWarning({ ...speed, key: 'FutureWarning' }, IMPERIAL_UNITS))
      .toMatchObject({ label: '(30.5 m/s): "Main <&>"', detail: null });
  });

  it.each([null, {}, { kind: 'velocity', value: null }, { kind: 'velocity', value: Infinity },
    { kind: 'velocity', value: '30.48' }, { kind: 'angle', value: 1 },
    { kind: 'future', value: 30.48 }])('falls back for unusable or mismatched quantities (%j)', quantity => {
    const warning = { ...speed, quantity } as unknown as EngineWarning;
    expect(formatWarning(warning, IMPERIAL_UNITS).detail).toBe('(30.5 m/s): "Main <&>"');
  });

  it.each([undefined, {}, [false], [{ name: 7 }]])('retains the whole fallback when sources are unusable (%j)', sources => {
    expect(formatWarning({ ...speed, sources } as unknown as EngineWarning, IMPERIAL_UNITS).detail)
      .toBe('(30.5 m/s): "Main <&>"');
  });

  it('formats zero as a real quantity', () => {
    expect(formatWarning({ ...aoa, quantity: { kind: 'angle', value: 0 } }, { ...METRIC_UNITS, angle: 'rad' }).detail)
      .toBe('(0 rad)');
  });

  it.each(['invalid JSON', '{}', '[null]', '[{"key":"HighSpeedDeployment"}]'])('keeps a summary when its warning extension is corrupt (%s)', payload => {
    const xml = write(summaryOf(run())).replace(/<simwarnings[^>]*>.*?<\/simwarnings>/,
      `<simwarnings version="1">${payload}</simwarnings>`);
    const imported = importOrk(xml);
    expect(imported.storedSimulations?.[0]?.data.maxAltitude).toBe(123);
    expect(imported.storedSimulations?.[0]?.data.simWarnings).toBeUndefined();
    expect(imported.notes).toContain('Stored simulation warnings could not be read.');
  });

  it('ignores future extension versions rather than misinterpreting them', () => {
    const xml = write(summaryOf(run())).replace('<simwarnings version="1">', '<simwarnings version="2">');
    expect(importOrk(xml).storedSimulations?.[0]?.data.simWarnings).toBeUndefined();
  });

  it('preserves source names and removed sources without parsing the message', () => {
    expect(formatWarning({ ...speed, sources: [{ id: 'one', name: '[Warning.X]: "chute"' }, null] }, IMPERIAL_UNITS).detail)
      .toBe('(100 ft/s): "[Warning.X]: "chute"", Removed component');
  });

  it('reloads run history with full-precision SI data and reformats it', () => {
    addRun(run());
    const warnings = loadRuns()[0]!.simWarnings!;
    expect(warnings).toEqual([speed, aoa]);
    expect(formatWarning(warnings[0]!, IMPERIAL_UNITS).detail).toBe('(100 ft/s): "Main <&>"');
  });

  it('round-trips warnings through .ork app data, session autosave, import, and re-save', () => {
    const imported = importOrk(write(summaryOf(run())));
    expect(imported.storedSimulations?.[0]?.data.simWarnings).toEqual([speed, aoa]);
    saveSessionDebounced({ tree: imported.tree, launch: DEFAULT_CONDITIONS,
      importedDocument: summaryDocument(imported) });
    flushSession();
    const document = loadSession()!.importedDocument!;
    expect(document.storedSimulations[0]!.data.simWarnings).toEqual([speed, aoa]);
    const restored = importedSummaryRuns(document)[0]!;
    expect(restored.simWarnings).toEqual([speed, aoa]);
    const reopened = importedSummaryRuns(importOrk(write(summaryOf(restored))))[0]!;
    expect(formatWarning(reopened.simWarnings![0]!, IMPERIAL_UNITS).detail).toBe('(100 ft/s): "Main <&>"');
    expect(formatWarning(reopened.simWarnings![1]!, { ...METRIC_UNITS, angle: 'rad' }).detail).toBe('(0.524 rad)');
  });

  it('preserves unknown and legacy warnings, and distinguishes unknown from a clean flight in .ork', () => {
    const legacy = { key: 'Other', message: 'Legacy 123 furlongs', priority: 'LOW' as const };
    expect(importedSummaryRuns(importOrk(write(summaryOf(run([legacy])))))[0]!.simWarnings).toEqual([legacy]);
    expect(importedSummaryRuns(importOrk(write(summaryOf(run([])))))[0]!.simWarnings).toEqual([]);
    const old = run(); delete old.simWarnings;
    expect(importedSummaryRuns(importOrk(write(summaryOf(old))))[0]!.simWarnings).toBeUndefined();
  });
});
