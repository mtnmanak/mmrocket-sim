// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { importOrk } from './orkFile.js';
import { applyImportPlan, planImport } from './importApply.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';

type Site = [number | null, number | null];
const EAST: Site = [26.380273, 80.126879];
const WEST: Site = [28.1, -80.63];

function read(sites: Site[], chosen = 0, requested?: string) {
  const xml = `<openrocket version="1.10" creator="OpenRocket 24.12"><rocket><name>Site check</name>
    ${sites.map((_, i) => `<motorconfiguration configid="c${i}" default="${i === chosen}"><name>Config ${i}</name></motorconfiguration>`).join('')}
    <subcomponents><stage><name>Sustainer</name><subcomponents><bodytube><name>Tube</name>
    <length>0.5</length><radius>0.03</radius><thickness>0.001</thickness></bodytube></subcomponents></stage></subcomponents>
    </rocket><simulations>${sites.map(([lat, lon], i) => `<simulation><name>${i === 0 ? 'K535' : `Sibling ${i}`}</name>
    <conditions><configid>c${i}</configid>${lat === null ? '' : `<launchlatitude>${lat}</launchlatitude>`}
    ${lon === null ? '' : `<launchlongitude>${lon}</launchlongitude>`}</conditions></simulation>`).join('')}</simulations></openrocket>`;
  const bytes = new TextEncoder().encode(xml);
  const before = bytes.slice();
  const result = importOrk(bytes.buffer, requested ? { configId: requested } : undefined);
  expect(bytes).toEqual(before);
  return result;
}

describe('.ork longitude check at open', () => {
  it('keeps the LEM-IV value, names five siblings and reports rounded distances once', () => {
    const result = read([EAST, EAST, WEST, WEST, WEST, WEST, WEST]);
    expect(result.launch).toMatchObject({ latitudeDeg: 26.380273, longitudeDeg: 80.126879 });
    expect(result.longitudeCheck).toMatchObject({ siblingCount: 5, sibling: { latitudeDeg: 28.1, longitudeDeg: -80.63 } });
    const notes = result.notes.filter((n) => n.includes('longitude’s sign flipped'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('“K535” is at 26.380273, 80.126879 (east); 5 of its other simulations are at 28.1, -80.63 (west), 13,600 km away.');
    expect(notes[0]).toContain('200 km from them. The file’s value was kept.');
  });

  it('checks the chosen configuration, including an explicit choice, rather than the first simulation', () => {
    const sites: Site[] = [[40, -119], EAST, WEST];
    expect(read(sites).longitudeCheck).toBeUndefined();
    expect(read(sites, 1).longitudeCheck?.opened.longitudeDeg).toBe(80.126879);
    expect(read(sites, 0, 'c1').longitudeCheck?.opened.longitudeDeg).toBe(80.126879);
  });

  it.each([
    ['CT-Concep98', [[40, -119], [40.65, -119.35], [41.35, -83.5]]],
    ['desktop defaults only', [EAST, [28.61, -80.6], [28.61, -80.6]]],
    ['near Greenwich', [[0, 4.99], [0, -4.99]]],
    ['blank longitude', [[26.38, null], WEST]],
    ['blank sibling longitude', [EAST, [28.1, null]]],
    ['missing latitude', [[null, 80.126879], WEST]],
    ['legacy default longitude', [[26.38, -80.6], EAST]],
  ] satisfies [string, Site[]][])('does not ask for %s', (_name, sites) => {
    const result = read(sites);
    expect(result.longitudeCheck).toBeUndefined();
    expect(result.notes.join('\n')).not.toContain('longitude’s sign flipped');
  });

  it('carries transient evidence through the import plan and clears it on the next open of any format', () => {
    const imported = read([EAST, WEST]);
    const context = { launch: DEFAULT_CONDITIONS, text: { mass: String, length: String } };
    const plan = planImport(imported, { working: {}, configs: {} }, context);
    const setLongitudeCheck = vi.fn();
    const setLaunch = vi.fn();
    const sinks = {
      history: { reset: vi.fn() }, setMountMotors: vi.fn(), setUnmatchedRefs: vi.fn(), setSavedConfigs: vi.fn(),
      setActiveConfigId: vi.fn(), setLaunch, setLongitudeCheck, setMeasured: vi.fn(), setMachAlt: vi.fn(),
      setNote: vi.fn(), setShroudPrompt: vi.fn(), markSaved: vi.fn(),
    };
    applyImportPlan(plan, sinks);
    expect(setLongitudeCheck).toHaveBeenLastCalledWith(imported.longitudeCheck);
    expect(setLaunch.mock.lastCall?.[0].longitudeDeg).toBe(80.126879);
    expect(plan.snapshot).not.toHaveProperty('longitudeCheck');
    const next = { name: 'Other format', tree: imported.tree, notes: [], motors: {} };
    applyImportPlan(planImport(next, { working: {}, configs: {} }, context), sinks);
    expect(setLongitudeCheck).toHaveBeenLastCalledWith(undefined);
  });
});
