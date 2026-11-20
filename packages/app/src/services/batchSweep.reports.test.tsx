// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { OrkRocket, type MotorSpec, type RocketTree } from '@online-openrocket/engine';
import * as exMotors from './exMotors.js';
import { runBatchSweep, type BatchMountOption } from './batchSweep.js';
import { DEFAULT_CONDITIONS } from './launchConditions.js';
import { engineTree } from '../tree/treeModel.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { INITIAL_UNITS } from '../prefs/units.js';
import { SimHistory, SimRunDetails } from '../components/SimResults.js';
import { designPrintHtml } from './designPrintReport.js';
import { runConfigurationLabel } from './runConfiguration.js';
import { runsToCsv, runsToTable } from './simStore.js';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it('Round 6 preserves each colliding EX motor name from sweep through both reports and exports', async () => {
  const ex = exMotors.parseEng('K500 24 70 5 0.04 0.07 EX\n0 0\n0.1 48\n0.3 24\n1.85 18\n2 0')[0]!;
  const lookup = vi.spyOn(exMotors, 'getExMotor').mockReturnValue(ex);
  const candidate = exMotors.exToDbEntry({ ...ex, motorId: 'ex:alpha' });
  const spec: MotorSpec = exMotors.exToMotorSpec(ex, 5);
  const tree: RocketTree = { name: 'Ordinal bird', components: [{ type: 'stage', id: 'stage', children: [
    { type: 'nosecone', length: 0.15, aftRadius: 0.021, thickness: 0.002, shape: 'ogive' },
    { type: 'bodytube', id: 'body', length: 0.6, outerRadius: 0.021, thickness: 0.001, children: [
      { type: 'trapezoidfinset', finCount: 3, rootChord: 0.08, tipChord: 0.04, sweep: 0.04, height: 0.05, thickness: 0.003 },
      ...['a', 'b'].map(id => ({ type: 'innertube' as const, id, name: `Mount ${id.toUpperCase()}`,
        length: 0.2, outerRadius: 0.0125, thickness: 0.0005, motorMount: true })),
      { type: 'parachute', diameter: 0.45 },
    ] },
  ] }] };
  const mounts: BatchMountOption[] = ['a', 'b'].map(id => ({ id, label: `Mount ${id.toUpperCase()}`,
    diameterMm: 24, motorCount: 1, maxMotorLengthM: null }));
  const info = OrkRocket.buildTree(engineTree(tree)).staticInfo();
  const out = await runBatchSweep({ tree, info, mounts, target: mounts[0]!, candidates: [candidate], splits: [],
    assignedMotors: { b: spec }, assignedMotorIds: { b: 'ex:beta' }, assignedIgnitions: {},
    assignedMountMotors: { b: { spec, label: 'K500-5', meta: { label: 'K500-5', manufacturer: 'EX', exMotorId: 'ex:beta' },
      ignition: { event: 'automatic', delay: 0 } } },
    autoDelay: false, model: 'kbf', launch: DEFAULT_CONDITIONS, rocketName: tree.name!,
    configuration: { flightConfig: 'Base' },
  }, { signal: new AbortController().signal }, {
    fetchSpec: async () => spec, nozzleFor: async () => null, yieldToUi: async () => {},
  });
  expect(out.rows).toHaveLength(1);
  const row = out.rows[0]!;
  expect(row.error).toBeUndefined();
  expect(row.label).toBe('EX K500'); // The compact candidate label retains its existing policy.
  const run = row.run!;
  expect(run.batchMounts?.map(m => [m.mountId, m.motor])).toEqual([
    ['a', 'EX K500 (1)'], ['b', 'EX K500 (2)'],
  ]);
  expect(run.delayResolution?.mounts.map(m => m.mountId)).toEqual(['b', 'a']);
  const label = 'Batch · EX K500 (1) in Mount A; EX K500 (2) in Mount B';
  expect(runConfigurationLabel(run)).toBe(label);
  const tabular = runsToTable([run]);
  expect(tabular.rows[0]?.[tabular.headers.indexOf('Flight config')]).toBe(label);
  expect(tabular.headers.slice(-3)).toEqual(['Batch candidate mount', 'Batch other mounts', 'Motor count scope']);
  expect(tabular.rows[0]?.slice(-3, -1)).toEqual(['Mount A', 'EX K500 (2) in Mount B']);
  expect(runsToCsv([run])).toContain('Mount A,EX K500 (2) in Mount B');

  const host = document.createElement('div');
  const root = createRoot(host);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  try {
    act(() => root.render(<PrefsProvider><SimHistory runs={[run]} onRunsChange={() => {}} /></PrefsProvider>));
    act(() => [...host.querySelectorAll('button')].find(b => b.textContent === 'Show')!.click());
    expect(host.querySelector('tbody tr')?.querySelectorAll('td')[2]?.textContent).toBe(label);
    const assertReports = (selected: typeof run, expected: [string, string][]) => {
      act(() => root.render(<PrefsProvider><SimRunDetails run={selected} /></PrefsProvider>));
      const table = host.querySelector('section[aria-label="Per-mount ejection delays"] table')!;
      expect([...table.querySelectorAll('tbody tr')].map(tr => [tr.querySelector('th')?.textContent,
        tr.querySelector('td')?.textContent])).toEqual(expected);
      const doc = new DOMParser().parseFromString(designPrintHtml({ tree, info, units: INITIAL_UNITS,
        radiusMode: 'diameter', withMotors: true, appVersion: 'test', run: selected, changedSince: [] }), 'text/html');
      expect([...doc.querySelectorAll('table[aria-label="Per-mount ejection delays"] tbody tr')]
        .map(tr => [tr.querySelector('th')?.textContent?.split(' (')[0], tr.querySelector('td')?.textContent])).toEqual(expected);
    };
    assertReports(run, [['Mount B', 'EX K500 (2)'], ['Mount A', 'EX K500 (1)']]);
    assertReports({ ...run, delayResolution: { ...run.delayResolution!, mounts: [...run.delayResolution!.mounts].reverse() } },
      [['Mount A', 'EX K500 (1)'], ['Mount B', 'EX K500 (2)']]);
    // Frozen evidence must also survive a library edit and a missing mount record.
    lookup.mockReturnValue({ ...ex, designation: 'Renamed' });
    assertReports(run, [['Mount B', 'EX K500 (2)'], ['Mount A', 'EX K500 (1)']]);
    assertReports({ ...run, batchMounts: run.batchMounts!.filter(m => m.mountId === 'a') },
      [['Mount B', '—'], ['Mount A', 'EX K500 (1)']]);
    // Valid frozen Launch evidence survives library edits too (S7a-g1).
    assertReports({ ...run, batch: false }, [['Mount B', 'EX K500 (2)'], ['Mount A', 'EX K500 (1)']]);
    // Invalid evidence retains identity resolution, never partial frozen labels.
    for (const selected of [{ ...run, batchMounts: undefined },
      { ...run, batchMounts: [{ ...run.batchMounts![0]!, count: 0 }] }]) {
      assertReports(selected, [['Mount B', 'EX Renamed (2)'], ['Mount A', 'EX Renamed (1)']]);
    }
  } finally { act(() => root.unmount()); }
}, 60_000);
