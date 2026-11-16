// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_CONDITIONS, kernelSimOptions } from './launchConditions.js';
import { importedLaunch, planImport } from './importApply.js';
import { statedWeightTextFor } from './unitText.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import { exportOrk, importOrk } from './orkFile.js';
import { conditionsKeyOf } from './simReport.js';
import { loadRuns } from './simStore.js';
import { simulateFile } from './simulateFile.js';
import { simulateDesign } from './simulateDesign.js';
import { loadSession } from './session.js';

afterEach(() => localStorage.clear());

it('129 defaults older designs to 1200 and bounds every full-flight option', () => {
  expect(kernelSimOptions(DEFAULT_CONDITIONS).maxTime).toBe(1200);
  for (const [maxFlightTimeS, expected] of [[3600, 3600], [0, 1], [-1, 1], [50000, 14400], [NaN, 1200]]) {
    expect(kernelSimOptions({ ...DEFAULT_CONDITIONS, maxFlightTimeS }).maxTime).toBe(expected);
  }
  const previous = { ...DEFAULT_CONDITIONS, maxFlightTimeS: 7200 };
  expect(kernelSimOptions(importedLaunch(previous, undefined)).maxTime).toBe(1200);
  expect(kernelSimOptions(importedLaunch(previous, { windAverage: 2 })).maxTime).toBe(1200);
  expect(conditionsKeyOf({ ...DEFAULT_CONDITIONS, maxFlightTimeS: 1200 })).toBe(conditionsKeyOf(DEFAULT_CONDITIONS));
  expect(conditionsKeyOf({ ...DEFAULT_CONDITIONS, maxFlightTimeS: 3600 })).not.toBe(conditionsKeyOf(DEFAULT_CONDITIONS));
});

const ork = (conditions: string) => '<openrocket version="1.10"><rocket><subcomponents><stage><subcomponents>'
  + '<bodytube><length>1</length><radius>0.03</radius></bodytube></subcomponents></stage></subcomponents></rocket>'
  + `<simulations><simulation><conditions>${conditions}</conditions></simulation></simulations></openrocket>`;

it.each([[3600, 3600], [50000, 14400], [0, 1]])('129 imports and exports maxtime %s as %s', (value, expected) => {
  const imported = importOrk(ork(`<maxtime>${value}</maxtime>`));
  expect(imported.launch?.maxFlightTimeS).toBe(expected);
  expect(imported.notes.join(' ')).toContain(value === expected ? '' : 'Maximum flight time');
  if (value === expected) expect(imported.notes.join(' ')).not.toContain('Maximum flight time');
  const xml = exportOrk({ name: 'Limit', tree: imported.tree, launch: { ...DEFAULT_CONDITIONS, ...imported.launch } });
  expect(xml).toContain(`<maxtime>${expected}</maxtime>`);
  expect(importOrk(xml).launch?.maxFlightTimeS).toBe(expected);
});

it('129 a missing maxtime uses 1200 without a clamp note', () => {
  const imported = importOrk(ork(''));
  expect(imported.launch?.maxFlightTimeS).toBeUndefined();
  expect(kernelSimOptions({ ...DEFAULT_CONDITIONS, ...imported.launch }).maxTime).toBe(1200);
  expect(imported.notes.join(' ')).not.toContain('Maximum flight time');
});

it.each([[14400.001, 'over', 14400], [0.9999999, 'under', 1]])('129 near-bound maxtime %s names the boundary once', (limit, side, bound) => {
  const imported = importOrk(ork(`<maxtime>${limit}</maxtime>`));
  expect(imported.launch?.maxFlightTimeS).toBe(bound);
  expect(imported.notes.join(' ')).toContain(`just ${side} the ${bound} s`);
  expect(imported.notes.join(' ')).toContain('imported at that limit');
});

it.each(['ork', 'rkt', 'cdx1'] as const)('129 %s discloses a missing maximum flight time reset like time step', sourceFormat => {
  const imported = { name: 'Reset', tree: { components: [] }, notes: [], motors: {}, sourceFormat };
  const plan = planImport(imported, { working: {}, configs: {} }, {
    launch: { ...DEFAULT_CONDITIONS, maxFlightTimeS: 3600 }, text: statedWeightTextFor(INITIAL_UNITS),
  });
  expect(kernelSimOptions(plan.snapshot.launch).maxTime).toBe(1200);
  const note = plan.note.group.lines.find(line => line.kind === 'I24.maxtime-default');
  expect(note?.tier).toBe('caution');
  expect(note?.text).toContain('back to the 1200 s default');
  expect(note?.text).toContain('3600 s in the Launch panel');
  const unchanged = planImport(imported, { working: {}, configs: {} }, {
    launch: DEFAULT_CONDITIONS, text: statedWeightTextFor(INITIAL_UNITS),
  });
  expect(unchanged.note.group.lines.some(line => line.kind === 'I24.maxtime-default')).toBe(false);
});

it('129 ORK conditions without maxtime disclose a reset, while an explicit value is a receipt', () => {
  for (const conditions of ['', '<maxtime>7200</maxtime>']) {
    const imported = { ...importOrk(ork(conditions)), name: 'Limit' };
    const plan = planImport(imported, { working: {}, configs: {} }, {
      launch: { ...DEFAULT_CONDITIONS, maxFlightTimeS: 3600 }, text: statedWeightTextFor(INITIAL_UNITS),
    });
    expect(plan.note.text).toContain(conditions ? 'Flights here now use a 7200 s Maximum flight time' : 'back to the 1200 s default');
  }
});

it('129 autosave preserves a chosen limit and leaves legacy absence clean', () => {
  for (const maxFlightTimeS of [undefined, 3600]) {
    const launch = { ...DEFAULT_CONDITIONS, ...(maxFlightTimeS === undefined ? {} : { maxFlightTimeS }) };
    localStorage.setItem('online-openrocket.session.v1', JSON.stringify({ tree: { components: [] }, launch }));
    const restored = loadSession()!;
    expect(restored.launch).toEqual(launch);
    expect(kernelSimOptions(restored.launch).maxTime).toBe(maxFlightTimeS ?? 1200);
  }
});

it('129 chooses maxtime from the same selected simulation as the other launch conditions', () => {
  const xml = ork('<configid>other</configid><maxtime>3600</maxtime>')
    .replace('<subcomponents>', '<motorconfiguration configid="chosen" default="true"/><subcomponents>')
    .replace('</simulations>', '<simulation><conditions><configid>chosen</configid><maxtime>7200</maxtime></conditions></simulation></simulations>');
  expect(importOrk(xml).launch?.maxFlightTimeS).toBe(7200);
});

it('129 stored-run cutoff uses its own limit and 1200 for legacy or corrupt limits', () => {
  const row = (id: string, totalFlightTime: number, maxFlightTimeS?: number) => ({ id, totalFlightTime,
    maxFlightTimeS, landingRate: 3, landingDistanceM: 20, comments: '', deployments: [] });
  localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify([
    row('long-before-limit', 1200, 3600), row('long-cutoff', 3600, 3600), row('short-cutoff', 2, 1),
    row('legacy-cutoff', 1200), row('legacy-before-limit', 1199), row('corrupt', 1200, -5),
  ]));
  const runs = loadRuns();
  expect(runs.filter(r => r.simWarnings?.some(w => w.key === 'INCOMPLETE_FLIGHT')).map(r => r.id))
    .toEqual(['long-cutoff', 'short-cutoff', 'legacy-cutoff', 'corrupt']);
  expect(runs[0]?.landingRate).toBe(3);
  expect(runs[1]?.landingRate).toBeNull();
  expect(runs[1]?.simWarnings?.[0]?.message).toContain('Maximum flight time (3600 s');
  expect(runs[3]?.simWarnings?.[0]?.message).toContain('Maximum flight time (1200 s');
});

it('129 the app flight records its limit, stops at it and names the setting; ordinary flights stay identical', async () => {
  const bytes = new Uint8Array(readFileSync(new NodeURL('./__fixtures__/reference.ork', import.meta.url)));
  const initial = await simulateFile(bytes, 'reference.ork', { yieldToUi: async () => {} });
  const short = await simulateDesign({ ...initial.state, launch: { ...initial.state.launch, maxFlightTimeS: 1 } }, { yieldToUi: async () => {} });
  expect(short.run.maxFlightTimeS).toBe(1);
  expect(short.result.series.time.at(-1)).toBeLessThan(2);
  expect(short.run.simWarnings?.find(w => w.key === 'INCOMPLETE_FLIGHT')?.message).toContain('Maximum flight time (1 s');
  expect(short.run.landingRate).toBeNull();
  const longer = await simulateDesign({ ...initial.state, launch: { ...initial.state.launch, maxFlightTimeS: 14400 } }, { yieldToUi: async () => {} });
  expect(initial.run.maxFlightTimeS).toBe(1200);
  expect(longer.run.maxFlightTimeS).toBe(14400);
  expect(longer.result.summary).toEqual(initial.result.summary);
  expect(longer.result.series).toEqual(initial.result.series);
}, 60_000);
