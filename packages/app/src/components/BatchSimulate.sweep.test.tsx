// @vitest-environment happy-dom
import { StrictMode, act } from 'react';
import { strFromU8, unzipSync } from 'fflate';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IgnitionEvent, RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { DesignMatchKey, SimRun } from '../services/simReport.js';
import { MOTOR_DB, MOTOR_DB_DATE, fitsMount, impulseClassesForMount, isAvailable, setCatalogueOverlay } from '../services/motorDb.js';
import { batchLoadoutText } from '../services/batchLoadout.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from './LaunchPanel.js';
import { BatchSimulate } from './BatchSimulate.js';
import { BATCH_TABLE_ROWS, batchCapNote } from '../services/batchCriteria.js';
import {
  candidateIdentity, mixedComboCount, runBatchSweep, type BatchMountOption, type BatchRow, type BatchSweepHooks, type BatchWeighed,
} from '../services/batchSweep.js';
import { downloadBlob } from '../services/saveFile.js';
import { addRuns, loadRuns } from '../services/simStore.js';
import { importedSummaryRuns } from '../services/orkFlightData.js';
import { asymmetricThrustWarnings } from '../services/asymmetricThrust.js';
import { balanceMotor, balanceTree } from '../services/asymmetricThrust.testSupport.js';

/**
 * THE DIALOG AROUND A SWEEP — what BatchSimulate does with the rows, the
 * verdicts and the ending, with the flying itself (services/batchSweep.ts,
 * tested on the real kernel in batchSweep.test.ts) replaced by a stub. These
 * were the paths no unit test could reach while the flying lived inside the
 * component (audit 2026-09-22): the dialog only became `running` inside a
 * closure that built engine handles and simulated.
 */

vi.mock('../services/batchSweep.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/batchSweep.js')>()),
  runBatchSweep: vi.fn(),
}));
vi.mock('../services/saveFile.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/saveFile.js')>()),
  downloadBlob: vi.fn(),
}));
const sweep = vi.mocked(runBatchSweep);

it('J10 qualifies flight matching even without a published nozzle', () => {
  mount({ assignedIgnitions: { mount: { event: 'launch', delay: 2 } } });
  expect(host.textContent).not.toContain('Automatic ignition with zero delay');
  expect(host.textContent).not.toContain('replacing its assigned ignition');
  expect(host.textContent).toContain('same complete loadout, ignition, delay policies');
  expect(host.textContent).not.toContain('matches your design-page flight exactly');
});

it('J10 promises only a matching nozzle value on a delayed target with a typed exit', () => {
  const tree = { ...TREE, components: [{ ...TREE.components[0]!, nozzleExitDiameter: 0.01 }] };
  mount({ tree, assignedIgnitions: { mount: { event: 'launch', delay: 2 } } });
  expect(host.querySelector('.batch-nozzle')?.textContent).toContain('same nozzle value');
  expect(host.querySelector('.batch-nozzle')?.textContent).not.toContain('flight exactly');
  expect(host.textContent).not.toContain('Automatic ignition with zero delay');
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TREE: RocketTree = {
  name: 'Sweep bird',
  components: [{
    type: 'stage', id: 'st0', name: 'Sustainer',
    children: [{ type: 'bodytube', id: 'bt', length: 0.6, children: [{ type: 'innertube', id: 'mount', length: 0.07 }] }],
  }],
};
const MOUNTS: BatchMountOption[] = [
  { id: 'mount', label: '24 mm mount', diameterMm: 24, motorCount: 1, maxMotorLengthM: null },
];

/** A stored run with only what the table, the grading and the CSV read. */
const run = (id: string, motor: string, maxAltitude: number): SimRun => ({
  id, when: 0, rocket: 'Sweep bird', motor, manufacturer: 'Acme', motorDiameterMm: 24, delayS: 5,
  maxAltitude, maxVelocity: 60, maxMach: 0.2, maxAcceleration: 120, timeToApogee: 8, timeToBurnout: 1.2,
  timeToRodDeparture: 0.3, rodExitVelocity: 15, thrustToWeightAtRod: 8, launchMass: 0.5, rodExitAoa: null,
  launchCG: null, launchCP: null, launchStaticMarginCal: null, altitudeAtDeployment: null,
  velocityAtDeployment: null, optimumDelayS: 5,
} as unknown as SimRun);

/** A sweep row; `label` may repeat between rows, `key` never does. */
const row = (key: string, label: string, maxAltitude: number): BatchRow => ({
  key, label, combo: false, run: run(key, label, maxAltitude),
  entry: { motorId: key, manufacturerAbbrev: 'Acme', designation: label } as BatchRow['entry'],
});
/** A row that could not be flown. */
const failedRow = (key: string, label: string): BatchRow => ({
  key, label, combo: false, error: 'no thrust curve',
  entry: { motorId: key, manufacturerAbbrev: 'Acme', designation: label } as BatchRow['entry'],
});

let host: HTMLDivElement;
let root: Root;
let saved: SimRun[][];
let closes: number;
let opened: SimRun[];

beforeEach(() => {
  localStorage.clear();
  saved = [];
  closes = 0;
  opened = [];
  sweep.mockReset();
  vi.mocked(downloadBlob).mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  setCatalogueOverlay(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A 4-ring cluster on the same mount — the shape that offers "mixed 2+2". */
const CLUSTER_TREE: RocketTree = {
  name: 'Sweep bird',
  components: [{
    type: 'stage', id: 'st0', name: 'Sustainer',
    children: [{
      type: 'bodytube', id: 'bt', length: 0.6,
      children: [{ type: 'innertube', id: 'mount', cluster: '4-ring', length: 0.07 }],
    }],
  }],
};
const CLUSTER_MOUNTS: BatchMountOption[] = [{ ...MOUNTS[0]!, label: '24 mm cluster', motorCount: 4 }];

function mount({ strict = false, launch = DEFAULT_CONDITIONS, tree = TREE, mounts = MOUNTS, weighed, retainedHardware, provenance, assignedIgnitions = {} }: {
  strict?: boolean; launch?: LaunchConditions; tree?: RocketTree; mounts?: BatchMountOption[]; weighed?: BatchWeighed;
  retainedHardware?: Pick<BatchWeighed, 'mountId' | 'deltaKg'>; provenance?: DesignMatchKey | null;
  assignedIgnitions?: Record<string, { event: IgnitionEvent; delay: number }>;
} = {}) {
  const dialog = (
    <PrefsProvider>
      <BatchSimulate
        tree={tree} info={{} as never} mounts={mounts} initialMountId="mount"
        assignedMountMotors={{}} assignedMotors={{}} assignedMotorIds={{}} assignedIgnitions={assignedIgnitions}
        launch={launch} rocketName="Sweep bird" weighed={weighed}
        retainedHardware={retainedHardware}
        {...(provenance !== undefined ? { provenance } : {})}
        onRunsChange={(runs) => { saved.push(runs); }}
        onClose={() => { closes++; }}
        onOpenRun={run => { opened.push(run); }}
      />
    </PrefsProvider>
  );
  act(() => root.render(strict ? <StrictMode>{dialog}</StrictMode> : dialog));
}

const buttons = () => [...host.querySelectorAll('button')];
const primary = () => buttons().find((b) => /^(Simulate|Yes —)/.test((b.textContent ?? '').trim()))!;
const closeBtn = () => buttons().find((b) => (b.textContent ?? '').includes('Close'))!;
const stopBtn = () => buttons().find((b) => b.textContent === 'Stop');
const bodyRows = () => [...host.querySelectorAll('tbody tr')];
const verdictOf = (label: string) => bodyRows()
  .find((tr) => tr.querySelector('td')?.textContent?.startsWith(label))
  ?.querySelector('td:last-child')?.textContent;
const field = (label: string) =>
  [...host.querySelectorAll('input')].find((i) => i.getAttribute('aria-label')?.startsWith(label))!;
/** Native setter + input event — how React sees a real keystroke. */
const type = (input: HTMLInputElement, text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
const start = () => act(async () => { primary().click(); });

it('J23N r5 leaves candidate nozzle lookup to the actual batch runner', async () => {
  sweep.mockResolvedValue({ rows: [], stopped: false });
  mount();
  await start();
  expect(sweep.mock.calls[0]![2]).toBeUndefined();
});
const candidateCount = () => Number(/(\d+) candidate motors/.exec(host.textContent ?? '')![1]);

it.each(['Minimum apogee', 'Maximum apogee'])('r5 bounds typed and persisted %s for every altitude unit', label => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { altitude: 'm' } }));
  mount();
  type(field(label), '1e308');
  act(() => { field(label).dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  const stored = JSON.parse(localStorage.getItem('online-openrocket.batch-criteria.v1')!);
  const key = label.startsWith('Minimum') ? 'minApogee' : 'maxApogee';
  expect(stored?.[key] == null || Number.isFinite(stored[key] / 0.3048)).toBe(true);
  act(() => root.unmount());
  root = createRoot(host);
  localStorage.setItem('online-openrocket.batch-criteria.v1', JSON.stringify({ minApogee: 1e308, maxApogee: 1e308 }));
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { altitude: 'ft' } }));
  mount();
  for (const name of ['Minimum apogee', 'Maximum apogee']) {
    expect(field(name).value).not.toMatch(/—|Infinity|NaN/);
    expect(Number.isFinite(Number(field(name).value))).toBe(true);
  }
  type(field(label), '100');
  act(() => { field(label).dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
  const repaired = JSON.parse(localStorage.getItem('online-openrocket.batch-criteria.v1')!);
  expect(Number.isFinite(repaired.minApogee / 0.3048)).toBe(true);
  expect(Number.isFinite(repaired.maxApogee / 0.3048)).toBe(true);
});

it('r5 keeps the sibling rod-exit criterion displayable after a unit change or reload', () => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { velocity: 'm/s' } }));
  mount();
  type(field('Minimum rod-exit velocity'), '1e308');
  const stored = JSON.parse(localStorage.getItem('online-openrocket.batch-criteria.v1') ?? '{}');
  expect(stored.minRodExit == null || Number.isFinite(stored.minRodExit * 3.6)).toBe(true);
  act(() => root.unmount()); root = createRoot(host);
  localStorage.setItem('online-openrocket.batch-criteria.v1', JSON.stringify({ minRodExit: 1e308 }));
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { velocity: 'km/h' } }));
  mount();
  expect(field('Minimum rod-exit velocity').value).not.toMatch(/—|Infinity|NaN/);
});

const checkbox = (text: string) => [...host.querySelectorAll('label')].find(l => l.textContent?.trim().endsWith(text))!.querySelector<HTMLInputElement>('input')!;

it.each([4, 6])('r3 explicitly targets the %s ring tubes and exposes mixed controls beside a kept centre', n => {
  const mounts = Array.from({ length: n + 1 }, (_, i) => ({ ...MOUNTS[0]!, id: `tube${i}`, label: `Tube ${i}` }));
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'b',
    outerRadius: 0.2, length: 0.6, children: mounts.map((m, i) => ({ type: 'innertube', id: m.id, name: m.label,
      motorMount: true, outerRadius: 0.0125, thickness: 0.0005,
      radialPosition: i === n ? 0 : 0.05, radialDirection: i * Math.PI * 2 / n })) }] }] };
  mount({ tree, mounts });
  const control = [...host.querySelectorAll('label')].find(l => l.textContent?.includes(`Use only ${n} ring mounts`))!.querySelector('input')!;
  expect(control.checked).toBe(false);
  act(() => control.click());
  expect(host.textContent).toContain(`mixed ${n / 2}+${n / 2}`);
  expect(host.textContent).toContain(`Tube ${n} stays empty`);
});

it('J1 retains a single row’s frozen loadout after a completed sweep and matching-checkbox change', async () => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: ['mount', 'other'].map(id => ({
    type: 'innertube', id, name: id, motorMount: true, outerRadius: 0.013, thickness: 0.001,
  })) }] };
  const mounts = [MOUNTS[0]!, { ...MOUNTS[0]!, id: 'other', label: 'other' }];
  const flown = row('frozen', 'Candidate', 200);
  flown.run!.batch = true;
  flown.run!.batchMounts = [
    { mountId: 'mount', mountName: 'mount', motor: 'Flown motor', count: 1, role: 'candidate' },
    { mountId: 'other', mountName: 'other', motor: 'Flown motor', count: 1, role: 'candidate' },
  ];
  sweep.mockResolvedValue({ rows: [flown], stopped: false });
  mount({ tree, mounts });
  expect(host.textContent).toContain('in these 2 mounts; 2 can fire');
  await start();
  const matching = [...host.querySelectorAll('label')].find(l => l.textContent?.includes('Use all 2 matching mounts'))!.querySelector('input')!;
  act(() => matching.click());
  expect(bodyRows()[0]?.textContent).toContain('Flown motor in mount, other');
  expect(host.textContent).toContain('Candidates fly in mount only.');
});

it('J1 locks sweep-defining filters and delay/mix controls while a sweep is running', async () => {
  sweep.mockImplementation((_input, hooks) => new Promise(resolve => {
    hooks.signal.addEventListener('abort', () => resolve({ rows: [], stopped: true }));
  }));
  mount({ tree: CLUSTER_TREE, mounts: CLUSTER_MOUNTS });
  await start();
  expect(checkbox('mixed 2+2').disabled).toBe(true);
  expect(checkbox('optimal delay per motor').disabled).toBe(true);
  expect(checkbox('include OOP').disabled).toBe(true);
  expect(host.querySelector('fieldset')?.disabled).toBe(true);
  act(() => stopBtn()!.click());
});

it.each(['CSV', 'XLSX'])('r3 keeps a failed batch %s export local and retains the finished flights', async format => {
  sweep.mockResolvedValue({ rows: [row('a', 'Acme E20', 300)], stopped: false });
  mount(); await start();
  vi.mocked(downloadBlob).mockImplementationOnce(() => { throw new Error('blocked download'); });
  const button = buttons().find(b => b.textContent?.includes(format))!;
  await act(async () => button.click());
  expect(host.textContent).toContain('Batch-table export failed: blocked download');
  expect(host.querySelector('.batch-failed')).toBeNull();
  expect(bodyRows()).toHaveLength(1);
  await act(async () => button.click());
  expect(host.textContent).not.toContain('Batch-table export failed');
});

it('141 opens the saved combination object and closes on the top saved row in table order', async () => {
  const low = row('low', 'Low', 200), top = { ...row('top', '2× A + 2× B', 400), combo: true };
  const rejected = row('rejected', 'Too low', 1);
  sweep.mockResolvedValue({ rows: [low, rejected, top, failedRow('error', 'Error')], stopped: false });
  mount();
  type(field('Minimum apogee'), '100');
  await start();
  const opens = buttons().filter(b => b.textContent === 'Open');
  const resultsRegion = host.querySelector<HTMLElement>('[role="region"][aria-label="Batch simulation results"]');
  expect(resultsRegion?.tabIndex).toBe(0);
  expect(opens).toHaveLength(2);
  expect(opens[0]!.getAttribute('aria-label')).toBe('Open 2× A + 2× B in Results');
  expect(opens[0]!.tabIndex).toBe(0);
  expect(host.textContent).toContain('rejected, errored or unsaved rows cannot be opened');
  act(() => opens[0]!.click());
  expect(opened[0]).toBe(saved[0]!.find(run => run.id === 'top'));
  expect(closes).toBe(1);
  opened = [];
  act(() => closeBtn().click());
  expect(opened[0]).toBe(saved[0]!.find(run => run.id === 'top'));
});

it('S3a-g7 / 141 makes results scrollable and opens the top saved row in table order', async () => {
  const low = row('low', 'Low', 200), top = { ...row('top', '2× A + 2× B', 400), combo: true };
  const rejected = row('rejected', 'Too low', 1);
  sweep.mockResolvedValue({ rows: [low, rejected, top, failedRow('error', 'Error')], stopped: false });
  mount();
  type(field('Minimum apogee'), '100');
  await start();
  const opens = buttons().filter(b => b.textContent === 'Open');
  const resultsRegion = host.querySelector<HTMLElement>('[role="region"][aria-label="Batch simulation results"]');
  expect(resultsRegion?.tabIndex).toBe(0);
  expect(opens).toHaveLength(2);
  expect(opens[0]!.getAttribute('aria-label')).toBe('Open 2× A + 2× B in Results');
  expect(opens[0]!.tabIndex).toBe(0);
  expect(host.textContent).toContain('rejected, errored or unsaved rows cannot be opened');
  act(() => opens[0]!.click());
  expect(opened[0]).toBe(saved[0]!.find(run => run.id === 'top'));
  expect(closes).toBe(1);
  opened = [];
  act(() => closeBtn().click());
  expect(opened[0]).toBe(saved[0]!.find(run => run.id === 'top'));
});

it.each(['before', 'stopped', 'empty', 'quota', 'overflow', 'running', 'escape', 'backdrop'] as const)(
  '141 close/open handles %s without selecting an unsaved or unfinished run', async mode => {
    const rows = mode === 'overflow' ? Array.from({ length: 501 }, (_, i) => row(`r${i}`, `Motor ${i}`, i + 100))
      : mode === 'empty' ? [] : [row('saved', 'Saved', 200)];
    if (mode === 'quota') {
      const original = localStorage;
      vi.stubGlobal('localStorage', {
        getItem: original.getItem.bind(original), removeItem: original.removeItem.bind(original), clear: original.clear.bind(original),
        setItem: (key: string, value: string) => {
          if (key === 'online-openrocket.sim-runs.v1') throw new Error('quota');
          original.setItem(key, value);
        },
      });
    }
    if (mode === 'running') sweep.mockImplementation((_input, hooks) => new Promise(resolve => {
      hooks.onRows?.(rows);
      hooks.signal.addEventListener('abort', () => resolve({ rows, stopped: true }));
    }));
    else sweep.mockResolvedValue({ rows, stopped: mode === 'stopped' });
    mount();
    if (mode !== 'before') await start();
    if (mode === 'running') {
      expect(buttons().some(b => b.textContent === 'Open')).toBe(false);
      expect(closeBtn().disabled).toBe(true);
      await act(async () => stopBtn()!.click());
    }
    if (mode === 'overflow') {
      expect(buttons().filter(b => b.textContent === 'Open')).toHaveLength(BATCH_TABLE_ROWS - 1);
      expect(bodyRows()[0]!.textContent).toContain('Motor 500');
      expect(bodyRows()[0]!.querySelector('button')).toBeNull();
    }
    if (mode === 'escape') act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    else if (mode === 'backdrop') {
      const backdrop = host.querySelector('.prefs-overlay')!;
      act(() => {
        backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        backdrop.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    } else act(() => closeBtn().click());
    if (['overflow', 'escape', 'backdrop'].includes(mode)) {
      expect(opened).toHaveLength(1);
      expect(opened[0]).toBe(saved[0]!.find(run => run.id === (mode === 'overflow' ? 'r499' : 'saved')));
    } else expect(opened).toEqual([]);
    expect(closes).toBe(1);
  });

it('r3-2 identical imported motor names remain distinct in the editor, summary and exclusions', () => {
  const base = MOTOR_DB.find(m => fitsMount(24, m))!;
  const added = ['ex:first', 'ex:second'].map(motorId => ({ ...base, motorId,
    manufacturerAbbrev: 'EX', realManufacturer: 'Maker', designation: 'E999', length: 1000 }));
  setCatalogueOverlay({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date(0).toISOString(), liveCount: 0,
    added, changed: [], removed: [], rejected: [] });
  localStorage.setItem('online-openrocket.batch-my-motors.v1', JSON.stringify(added.map(m => m.motorId)));
  mount({ mounts: [{ ...MOUNTS[0]!, maxMotorLengthM: 0.2 }] });
  for (const m of added) expect(host.textContent).toContain(`Maker (EX) E999 [${m.motorId}]`);
  act(() => buttons().find(b => b.textContent === 'Edit my motors')!.click());
  const panel = host.querySelector('[aria-label="My motors"]')!;
  for (const m of added) expect(panel.textContent).toContain(`Maker (EX) E999 [${m.motorId}]`);
  act(() => host.querySelector<HTMLButtonElement>('fieldset .series-chip')!.click());
  act(() => checkbox('Fly only my motors').click());
  for (const m of added) expect(host.textContent).toContain(`Maker (EX) E999 [${m.motorId}]: too long`);
  const selected = host.querySelector<HTMLButtonElement>('fieldset .series-chip-on')!;
  expect(selected.closest('fieldset')!.disabled).toBe(true);
  expect(selected.getAttribute('aria-pressed')).toBe('true');
  expect(selected.textContent).toContain('✓');
});

it('r2-2 makes singles effective when a target change removes all combinations', async () => {
  const motor = MOTOR_DB.find(m => fitsMount(24, m))!;
  localStorage.setItem('online-openrocket.batch-my-motors.v1', JSON.stringify([motor.motorId]));
  sweep.mockResolvedValue({ rows: [row('one', 'One motor', 300)], stopped: false });
  mount({ tree: CLUSTER_TREE, mounts: CLUSTER_MOUNTS });
  act(() => checkbox('Fly only my motors').click());
  act(() => checkbox('Also fly each motor in every position').click());
  expect(primary().disabled).toBe(true);
  mount(); // Same dialog, now targeting a design with no mixed option.
  expect(host.textContent).not.toContain('Nothing to fly');
  expect(primary().disabled).toBe(false);
  expect(primary().textContent).toContain('Simulate 1 motor');
  await start();
  expect(sweep.mock.calls[0]![0].includeSingles).toBe(true);
  expect(host.querySelector('.batch-finished')!.textContent).toContain('simulated 1 motor;');
});

it('r2-2 resets singles and combinations when a saved target choice becomes stale', () => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'b', children:
    [0, 90, 180, 270].map((deg, i) => ({ type: 'innertube', id: i ? `m${i}` : 'mount', motorMount: true,
      outerRadius: 0.0125, thickness: 0.0005, radialPosition: 0.025, radialDirection: deg * Math.PI / 180 })) }] }] };
  const mounts = ['mount', 'm1', 'm2', 'm3'].map(id => ({ ...MOUNTS[0]!, id, label: id }));
  mount({ tree, mounts });
  const all = () => [...host.querySelectorAll('label')].find(l => l.textContent?.includes('Use all'))!.querySelector('input')!;
  act(() => all().click());
  act(() => all().click()); // Keep an explicit target choice with all tubes on.
  act(() => checkbox('mixed 2+2').click());
  act(() => checkbox('Also fly each motor in every position').click());
  mount({ tree: structuredClone(tree), mounts });
  expect(checkbox('Also fly each motor in every position').checked).toBe(true);
  expect(checkbox('mixed 2+2').checked).toBe(false);
});

it('r2-3 lets disabled filter chips shrink inside their fieldset', () => {
  mount();
  const fieldset = host.querySelector('fieldset')!;
  expect(fieldset.style.minWidth).toMatch(/^0(px)?$/);
  expect(fieldset.style.borderWidth).toMatch(/^0(px)?$/);
});

it('r2-4 uses collision-aware names in the owned list and singular/plural summary', () => {
  const base = MOTOR_DB.find(m => fitsMount(24, m))!;
  const added = ['123E999-9A', '234E999-9A'].map((designation, i) => ({ ...base,
    motorId: `collision-${i}`, manufacturerAbbrev: 'Cesaroni', designation }));
  setCatalogueOverlay({ baseGenerated: MOTOR_DB_DATE, fetchedAt: new Date(0).toISOString(), liveCount: 0,
    added, changed: [], removed: [], rejected: [] });
  localStorage.setItem('online-openrocket.batch-my-motors.v1', JSON.stringify(added.map(m => m.motorId)));
  mount();
  expect(host.textContent).toContain(`2 motors: Cesaroni ${added[0]!.designation}, Cesaroni ${added[1]!.designation}`);
  act(() => buttons().find(b => b.textContent === 'Edit my motors')!.click());
  const panel = host.querySelector('[aria-label="My motors"]')!;
  const selected = [...panel.querySelectorAll<HTMLInputElement>('input:checked')];
  added.forEach(m => expect(selected.some(input => input.closest('label')!.textContent?.includes(`Cesaroni ${m.designation}`))).toBe(true));
  act(() => selected[1]!.click());
  act(() => buttons().find(b => b.textContent === 'Edit my motors')!.click());
  expect(host.textContent).toContain('1 motor: Cesaroni ');
});

it('r2-6 shows the fine-step caution only when there are flights to run', () => {
  mount({ tree: CLUSTER_TREE, mounts: CLUSTER_MOUNTS, launch: { ...DEFAULT_CONDITIONS, timeStepS: 0.01 } });
  expect(host.textContent).toContain('is finer than');
  act(() => checkbox('Also fly each motor in every position').click());
  expect(candidateCount()).toBeGreaterThan(0);
  expect(host.textContent).not.toContain('is finer than');
  act(() => checkbox('mixed 2+2').click());
  expect(host.textContent).toContain('is finer than');
});

it('r2-7 typing in Search my motors filters the tick-list and clearing restores it', () => {
  mount();
  act(() => buttons().find(b => b.textContent === 'Edit my motors')!.click());
  const panel = host.querySelector('[aria-label="My motors"]')!;
  const search = panel.querySelector<HTMLInputElement>('input[type="search"]')!;
  const count = () => panel.querySelectorAll('input[type="checkbox"]').length;
  const before = count();
  type(search, 'no-such-motor-r2');
  expect(search.value).toBe('no-such-motor-r2');
  expect(count()).toBe(0);
  type(search, '');
  expect(count()).toBe(before);
  const motor = MOTOR_DB.find(m => fitsMount(24, m))!;
  type(search, motor.designation);
  expect(count()).toBeGreaterThan(0);
  expect(count()).toBeLessThan(before);
});

it('r2-7 a three-candidate mixed-only 2+2 finishes as three flights', async () => {
  const motors = MOTOR_DB.filter(m => fitsMount(24, m)).slice(0, 3);
  localStorage.setItem('online-openrocket.batch-my-motors.v1', JSON.stringify(motors.map(m => m.motorId)));
  const rows = motors.map((_, i) => ({ ...row(`mix-${i}`, `Mix ${i}`, 300), combo: true }));
  sweep.mockResolvedValue({ rows, stopped: false });
  mount({ tree: CLUSTER_TREE, mounts: CLUSTER_MOUNTS });
  act(() => checkbox('Fly only my motors').click());
  act(() => checkbox('mixed 2+2').click());
  act(() => checkbox('Also fly each motor in every position').click());
  expect(primary().textContent).toContain('Simulate 3 flights');
  await start();
  expect(sweep.mock.calls[0]![0].includeSingles).toBe(false);
  expect(sweep.mock.calls[0]![0].candidates).toHaveLength(3);
  expect(host.querySelector('.batch-finished')!.textContent).toContain('simulated 3 flights;');
});

it('136 mixed-only rows reach exports without an empty Single motor tab, and no selected pass is refused', async () => {
  const r = { ...row('mixed', 'two motors', 300), combo: true };
  r.run!.motorConfig = 'mixed 2+2';
  sweep.mockResolvedValue({ rows: [r], stopped: false });
  const fitting = MOTOR_DB.filter(m => fitsMount(24, m) && isAvailable(m));
  const maker = fitting.find(m => {
    const n = fitting.filter(other => other.manufacturerAbbrev === m.manufacturerAbbrev).length;
    return n >= 2 && n < 10;
  })!.manufacturerAbbrev;
  localStorage.setItem('online-openrocket.batch-criteria.v1', JSON.stringify({ manufacturers: [maker] }));
  mount({ tree: CLUSTER_TREE, mounts: CLUSTER_MOUNTS });
  expect(checkbox('Also fly each motor in every position').checked).toBe(true);
  act(() => checkbox('Also fly each motor in every position').click());
  expect(primary().disabled).toBe(true);
  expect(host.textContent).toContain('Nothing to fly');
  act(() => checkbox('mixed 2+2').click());
  await start();
  expect(sweep.mock.calls[0]![0].includeSingles).toBe(false);
  act(() => buttons().find(b => b.textContent?.includes('XLSX'))!.click());
  const bytes = new Uint8Array(await vi.mocked(downloadBlob).mock.calls[0]![0].arrayBuffer());
  const workbook = strFromU8(unzipSync(bytes)['xl/workbook.xml']!);
  expect(workbook).toContain('All results');
  expect(workbook).toContain('Mixed 2+2');
  expect(workbook).not.toContain('Single motor');
});

it('137 renders the current bore impulse chips, loads legacy criteria, and persists a class toggle', () => {
  localStorage.setItem('online-openrocket.batch-criteria.v1', JSON.stringify({ manufacturers: [], classes: [] }));
  mount();
  const group = host.querySelector('[aria-label="Impulse classes"]')!;
  expect(group).not.toBeNull();
  expect(group.textContent).toContain('Class');
  const chips = [...group.querySelectorAll('button')];
  const offered = impulseClassesForMount(24, false, MOTOR_DB);
  expect(chips).toHaveLength(offered.length);
  offered.forEach((c, i) => {
    expect(chips[i]!.textContent?.trim()).toBe(`${c.letter} ${c.count}`);
  });
  expect(chips.every(b => b.getAttribute('aria-pressed') === 'false')).toBe(true);
  act(() => chips[0]!.click());
  expect(chips[0]!.getAttribute('aria-pressed')).toBe('true');
  expect(chips[0]!.textContent).toContain('✓');
  const selected = JSON.parse(localStorage.getItem('online-openrocket.batch-criteria.v1')!).impulse;
  expect(selected).toHaveLength(1);
  expect(MOTOR_DB.filter(m => fitsMount(24, m)).some(m => m.impulseClass.startsWith(selected[0]))).toBe(true);
});

it('138 My motors overrides OOP and chips, feeds combinations, persists editing, and refuses an empty list', async () => {
  const fitting = MOTOR_DB.filter(m => fitsMount(24, m));
  const oop = fitting.find(m => !isAvailable(m))!;
  const other = fitting.find(m => m.motorId !== oop.motorId)!;
  localStorage.setItem('online-openrocket.batch-my-motors.v1', JSON.stringify([oop.motorId, other.motorId]));
  localStorage.setItem('online-openrocket.batch-criteria.v1', JSON.stringify({ manufacturers: ['Invisible'], classes: [1], impulse: ['Z'] }));
  sweep.mockResolvedValue({ rows: [], stopped: false });
  mount({ tree: CLUSTER_TREE, mounts: CLUSTER_MOUNTS });
  act(() => checkbox('Fly only my motors').click());
  act(() => checkbox('mixed 2+2').click());
  expect(candidateCount()).toBe(2);
  expect(checkbox('include OOP').disabled).toBe(true);
  expect(host.querySelector('fieldset')!.disabled).toBe(true);
  expect(host.textContent).toContain('your choices are kept');
  await start();
  expect(sweep.mock.calls[0]![0].candidates.map(m => m.motorId).sort()).toEqual([oop.motorId, other.motorId].sort());
  expect(sweep.mock.calls[0]![0].splits).toHaveLength(1);
  act(() => buttons().find(b => b.textContent === 'Edit my motors')!.click());
  const panel = host.querySelector('[aria-label="My motors"]')!;
  expect(panel.querySelectorAll('input[type="checkbox"]:checked')).toHaveLength(2);
  act(() => buttons().find(b => b.textContent === 'Clear list')!.click());
  expect(JSON.parse(localStorage.getItem('online-openrocket.batch-my-motors.v1')!)).toEqual([]);
  expect(primary().disabled).toBe(true);
  expect(host.textContent).toContain('No fitting motors in My motors');
  act(() => panel.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  expect(JSON.parse(localStorage.getItem('online-openrocket.batch-my-motors.v1')!)).toHaveLength(1);
  expect(candidateCount()).toBe(1);
  act(() => checkbox('Fly only my motors').click());
  expect(host.querySelector('fieldset')!.disabled).toBe(false);
  expect(JSON.parse(localStorage.getItem('online-openrocket.batch-criteria.v1')!).impulse).toEqual(['Z']);
});

it('138 displays named fit, length and unavailable exclusions as Information', () => {
  const wide = MOTOR_DB.find(m => !fitsMount(24, m))!;
  const long = MOTOR_DB.find(m => fitsMount(24, m) && m.length > 50)!;
  localStorage.setItem('online-openrocket.batch-my-motors.v1', JSON.stringify([wide.motorId, long.motorId, 'ex:missing']));
  mount({ mounts: [{ ...MOUNTS[0]!, label: 'Target\u202eMMT', maxMotorLengthM: 0.05 }] });
  act(() => checkbox('Fly only my motors').click());
  expect(host.textContent).toContain('too wide for Target[U+202E]MMT');
  expect(host.textContent).toContain('too long for Target[U+202E]MMT (max');
  expect(host.textContent).toContain('ex:missing: unavailable');
  const information = [...host.querySelectorAll('p')].find(p => p.textContent?.includes('ex:missing: unavailable'))!;
  expect(information).toBeDefined();
  expect(information.classList.contains('message-tier')).toBe(false);
});

it('Round 5 filters every target bore and names the limiting mount, preserving box-OFF candidates', async () => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'b', children:
    [16.90, 16.49].map((bore, i) => ({ type: 'innertube', id: i ? 'narrow' : 'mount', name: i ? 'Narrow MMT' : 'Wide MMT',
      motorMount: true, outerRadius: bore / 2000 + 0.0005, thickness: 0.0005 })) }] }] };
  const mounts = [{ ...MOUNTS[0]!, diameterMm: 17, label: 'Wide MMT' },
    { ...MOUNTS[0]!, id: 'narrow', diameterMm: 16, label: 'Narrow MMT' }];
  sweep.mockResolvedValue({ rows: [], stopped: false });
  mount({ tree, mounts });
  const expected = MOTOR_DB.filter(m => isAvailable(m) && mounts.every(target => fitsMount(target.diameterMm, m)));
  expect(candidateCount()).toBe(expected.length);
  expect(host.textContent).toContain('excluded — too wide for Narrow MMT');
  await start();
  expect(sweep.mock.calls[0]![0].candidates).toEqual(expect.arrayContaining(expected));
  expect(sweep.mock.calls[0]![0].candidates).toHaveLength(expected.length);
  const allBox = [...host.querySelectorAll('label')].find(l => l.textContent?.includes('Use all'))!.querySelector('input')!;
  act(() => allBox.click());
  const selectedOnly = MOTOR_DB.filter(m => isAvailable(m) && fitsMount(17, m));
  expect(selectedOnly.some(m => m.diameter === 18)).toBe(true);
  expect(candidateCount()).toBe(selectedOnly.length);
  expect(host.textContent).not.toContain('excluded — too wide for');
  await start();
  expect(sweep.mock.calls[1]![0].targetMountIds).toBeUndefined();
  expect(sweep.mock.calls[1]![0].candidates).toHaveLength(selectedOnly.length);
});

it('r4-5 distinguishes six-ring arrangements with identical motor totals in Open accessible names', async () => {
  const mixed = (key: string, pairs: string[]): BatchRow => {
    const result = { ...row(key, '4× Acme E22 + 2× Acme E20', 300), combo: true };
    result.run = { ...result.run!, batch: true, motorConfig: 'mixed 4+2', batchMounts:
      Array.from({ length: 6 }, (_, i) => ({ mountId: `tube${i + 1}`, mountName: `MMT ${i + 1}`,
        role: 'candidate' as const, motor: `Acme ${pairs[i % 3]}`, count: 1 })) };
    return result;
  };
  const rows = [mixed('a', ['E22', 'E20', 'E22']), mixed('b', ['E22', 'E22', 'E20'])];
  sweep.mockResolvedValue({ rows, stopped: false });
  mount();
  await start();
  const cells = bodyRows().map(tr => tr.querySelector('td')!.textContent!);
  for (const r of rows) expect(cells.find(text => text.includes(batchLoadoutText(r.run!)!))).toBeDefined();
  expect(cells[0]).not.toBe(cells[1]);
  const opens = buttons().filter(b => b.textContent === 'Open');
  const names = opens.map(b => b.getAttribute('aria-label'));
  expect(new Set(names).size).toBe(2);
  for (const r of rows) expect(names).toContain(`Open ${r.label} · ${batchLoadoutText(r.run!)} in Results`);
  act(() => opens[1]!.click());
  expect(opened[0]).toBe(saved[0]!.find(run => run.id === 'b'));
  // Editing the current picker/tree cannot replace a completed row's evidence.
  mount({ tree: structuredClone(TREE), mounts: [{ ...MOUNTS[0]!, label: 'Renamed today' }] });
  expect(bodyRows().map(tr => tr.querySelector('td')!.textContent!)).toEqual(cells);
});

it.each([2, 3, 4, 6])('152 r6 shows mirror skipping only for selectable separate ring splits: %s tubes', n => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'b', children:
    Array.from({ length: n }, (_, i) => ({ type: 'innertube', id: i ? `m${i}` : 'mount', motorMount: true,
      length: 0.2, outerRadius: 0.0125, thickness: 0.0005, radialPosition: 0.025, radialDirection: i * 2 * Math.PI / n })) }] }] };
  const mounts = Array.from({ length: n }, (_, i) => ({ ...MOUNTS[0]!, id: i ? `m${i}` : 'mount' }));
  mount({ tree, mounts });
  expect(host.textContent?.includes('Skip mirror arrangements')).toBe(n === 4 || n === 6);
  expect(host.querySelector('#batch-mirror-condition') !== null).toBe(n === 4 || n === 6);
  if (n === 4 || n === 6) {
    act(() => [...host.querySelectorAll('label')].find(l => l.textContent?.includes(`Use all ${n} matching mounts`))!.querySelector('input')!.click());
    expect(checkbox('Skip mirror arrangements').disabled).toBe(true);
    expect(host.querySelector('#batch-mirror-condition')).not.toBeNull();
  }
});

it.each([4, 6].flatMap(n => [
  { setting: 'motorOverhang', value: 0 }, { setting: 'cluster', value: 'single' },
  { setting: 'maxMotorLength', value: 0.25 }, { setting: 'density', value: 500 },
].map(change => ({ n, ...change }))))('153 shows correct mirror eligibility and reason for $setting on $n tubes', ({ n, setting, value }) => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'b', children: [
    ...Array.from({ length: n }, (_, i) => ({ type: 'innertube' as const, id: i ? `m${i}` : 'mount', motorMount: true,
      length: 0.2, outerRadius: 0.0125, thickness: 0.0005, radialPosition: 0.025, radialDirection: i * 2 * Math.PI / n })),
    { type: 'parachute', id: 'chute', deployEvent: 'Apogee' },
  ] }] }] };
  const mounts = Array.from({ length: n }, (_, i) => ({ ...MOUNTS[0]!, id: i ? `m${i}` : 'mount' }));
  const tube = tree.components[0]!.children![0]!.children![1]!;
  tube[setting] = value;
  mount({ tree, mounts });
  expect(checkbox('Skip mirror arrangements').disabled).toBe(setting === 'density');
  if (setting === 'density') {
    expect(host.querySelector('#batch-mirror-condition')!.textContent).toContain('identical material density settings');
  } else {
    expect(host.querySelector('#batch-mirror-condition')!.textContent).not.toContain('recovery independent of motor ejection charges to prove');
  }
});

it.each([4, 6])('152 hides mirror skipping for one %s-ring cluster mount', n => {
  const tree = structuredClone(CLUSTER_TREE);
  tree.components[0]!.children![0]!.children![0]!['cluster'] = `${n}-ring`;
  mount({ tree, mounts: [{ ...CLUSTER_MOUNTS[0]!, motorCount: n }] });
  expect(checkbox(n === 4 ? 'mixed 2+2' : 'mixed 3+3')).toBeDefined();
  expect(host.textContent).not.toContain('Skip mirror arrangements');
  expect(host.querySelector('#batch-mirror-condition')).toBeNull();
});

it.each([4, 6])('152 keeps mirror skipping off and offers wide %s-ring reduction with rounding disclosure', async n => {
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'b', children:
    Array.from({ length: n }, (_, i) => ({ type: 'innertube', id: i ? `m${i}` : 'mount', name: `MMT ${i + 1}`, motorMount: true,
      length: 0.2, outerRadius: 0.0125, thickness: 0.0005, radialPosition: 0.025, radialDirection: i * 2 * Math.PI / n })) }] }] };
  const mounts = Array.from({ length: n }, (_, i) => ({ ...MOUNTS[0]!, id: i ? `m${i}` : 'mount' }));
  const motors = MOTOR_DB.filter(m => fitsMount(24, m) && isAvailable(m)).slice(0, 3);
  localStorage.setItem('online-openrocket.batch-my-motors.v1', JSON.stringify(motors.map(m => m.motorId)));
  const r = { ...row('representative', 'Representative', 300), combo: true, mirrors: ['MMT 1: B; MMT 2: A'] };
  r.run = { ...r.run!, batch: true, batchMounts: [
    { mountId: 'mount', mountName: 'MMT 1', motor: 'A', role: 'candidate', count: 1 },
    { mountId: 'm1', mountName: 'MMT 2', motor: 'B', role: 'candidate', count: 1 },
  ] };
  sweep.mockResolvedValue({ rows: [r], stopped: false });
  mount({ tree, mounts });
  act(() => checkbox('Fly only my motors').click());
  const halvesName = n === 4 ? 'mixed 2+2' : 'mixed 3+3';
  act(() => checkbox(halvesName).click());
  if (n === 6) act(() => checkbox('mixed 4+2 / 2+2+2').click());
  const mirrors = checkbox('Skip mirror arrangements');
  expect(mirrors.checked).toBe(false);
  expect(mirrors.disabled).toBe(false); // Auto is the dialog default.
  expect(checkbox(halvesName).closest('label')!.title).toContain('adds 6 mixed flights');
  expect(checkbox(halvesName).closest('label')!.title).toContain('Fly every arrangement across the separate tubes.');
  await start();
  expect(sweep.mock.calls[0]![0].skipMirrors).toBeUndefined();
  expect(primary().textContent).toContain(`Simulate ${n === 4 ? 9 : 33} flights`);
  act(() => mirrors.click());
  expect(mirrors.checked).toBe(true);
  expect(checkbox(halvesName).closest('label')!.title).toContain('adds 3 mixed flights');
  expect(host.querySelector('#batch-mirror-condition')!.textContent).toContain(`${halvesName} adds 3 mixed flights`);
  expect(host.querySelector('#batch-mirror-condition')!.textContent).toContain('no per-motor');
  expect(host.querySelector('#batch-mirror-condition')!.textContent).toContain('Mirrored layouts of identical tubes fly the same physics');
  expect(host.querySelector('#batch-mirror-condition')!.textContent).toContain('computed numbers can differ slightly from rounding (by millimetres in the app’s tests)');
  expect(host.querySelector('#batch-mirror-condition')!.textContent).not.toContain('few millimetres');
  if (n === 6) {
    expect(checkbox('mixed 4+2 / 2+2+2').closest('label')!.title).toContain('adds 7 mixed flights');
    expect(host.querySelector('#batch-mirror-condition')!.textContent).toContain('mixed 4+2 / 2+2+2 adds 7 mixed flights');
  }
  expect(primary().textContent).toContain(`Simulate ${n === 4 ? 6 : 13} flights`);
  await start();
  expect(sweep.mock.calls[1]![0].skipMirrors).toBe(true);
  expect(bodyRows()[0]!.textContent).toContain('MMT 1: B; MMT 2: A — same flight as A in MMT 1; B in MMT 2');
  expect(bodyRows()[0]!.textContent).toContain('Delay and optimum delay not shown');
  for (const launch of [{ ...DEFAULT_CONDITIONS, windAverage: 5 }, { ...DEFAULT_CONDITIONS, launchRodAngleDeg: 5 }]) {
    mount({ tree, mounts, launch });
    expect(checkbox('Skip mirror arrangements').disabled).toBe(false);
    expect(checkbox('Skip mirror arrangements').checked).toBe(true);
    expect(primary().textContent).toContain(`Simulate ${n === 4 ? 6 : 13} flights`);
  }
  mount({ tree, mounts, assignedIgnitions: { m1: { event: 'never', delay: 0 } } });
  expect(checkbox('Skip mirror arrangements').disabled).toBe(true);
  expect(checkbox('Skip mirror arrangements').checked).toBe(false);
  expect(host.querySelector('#batch-mirror-condition')!.textContent).toContain('identical ignition');
  await start();
  expect(sweep.mock.calls[2]![0].skipMirrors).toBeUndefined();
  // Keep the choice discoverable when only one tube is currently targeted:
  // selecting all matching mounts makes the separate ring available again.
  act(() => [...host.querySelectorAll('label')].find(l => l.textContent?.includes(`Use all ${n} matching mounts`))!.querySelector('input')!.click());
  expect(checkbox('Skip mirror arrangements').disabled).toBe(true);
  expect(host.querySelector('#batch-mirror-condition')!.textContent).toContain('Select four or six separate ring tubes');
});

it('124/125 offers all matching empty tubes by default, restores defaults on picker change and passes ring groups', async () => {
  localStorage.setItem('online-openrocket.batch-criteria.v1', JSON.stringify({ manufacturers: ['Klima'] }));
  const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'b', children:
    [0, 90, 180, 270].map((deg, i) => ({ type: 'innertube', id: i ? `m${i}` : 'mount', name: 'MMT', motorMount: true,
      outerRadius: 0.0125, thickness: 0.0005, radialPosition: 0.025, radialDirection: deg * Math.PI / 180 })) }] }] };
  const mounts = ['mount', 'm1', 'm2', 'm3'].map(id => ({ ...MOUNTS[0]!, id, label: id }));
  sweep.mockResolvedValue({ rows: [], stopped: false });
  mount({ tree, mounts });
  const allBox = () => [...host.querySelectorAll('label')].find(l => l.textContent?.includes('Use all'))!.querySelector('input')!;
  expect(allBox().checked).toBe(true);
  expect(host.textContent).toContain('Candidates fly in MMT 1, MMT 2, MMT 3 and MMT 4.');
  const mixed = [...host.querySelectorAll('label')].find(l => l.textContent?.trim() === 'mixed 2+2')!.querySelector('input')!;
  act(() => mixed.click());
  await start();
  expect(sweep.mock.calls[0]![0].targetMountIds).toEqual(['mount', 'm1', 'm2', 'm3']);
  expect(sweep.mock.calls[0]![0].splits[0]?.mountGroups).toEqual([['mount', 'm2'], ['m1', 'm3']]);
  mount({ tree, mounts, assignedIgnitions: { m1: { event: 'launch', delay: 1 }, m3: { event: 'launch', delay: 1 } } });
  const count = candidateCount();
  expect(host.textContent).toContain(`+${count * (count - 1)} mixed 2+2 combinations`);
  expect(mixed.closest('label')!.title).toContain(`${count * (count - 1)} mixed flights`);
  expect(mixed.closest('label')!.title).toContain('every arrangement');
  expect(primary().textContent).toContain(`Simulate ${new Intl.NumberFormat('en-US').format(count ** 2)} flights`);
  mount({ tree, mounts });
  act(() => allBox().click());
  expect(allBox().checked).toBe(false);
  expect(host.textContent).toContain('Each row is that mix');
  const picker = [...host.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'm1'))!;
  act(() => { picker.value = 'm1'; picker.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(allBox().checked).toBe(true);
  act(() => allBox().click());
  expect(allBox().checked).toBe(false);
  mount({ tree, mounts }); // Same design and picker: the explicit tick is retained.
  // mount() restores initialMountId only when mounting; the existing component stays on m1.
  expect(allBox().checked).toBe(false);
  mount({ tree: structuredClone(tree), mounts });
  expect(allBox().checked).toBe(true);
  mount({ tree, mounts }); // Returning to an old tree must not resurrect an old explicit tick.
  expect(allBox().checked).toBe(true);
  mount({ tree, mounts: mounts.map(m => m.id === 'm2' ? { ...m, maxMotorLengthM: 0 } : m) });
  expect(candidateCount()).toBe(0);
  expect(host.textContent).toContain('m2’s max motor length');
});

it('r2 keeps the Danger mark when an explicit minimum accepts that guidance check', async () => {
  localStorage.setItem('online-openrocket.batch-criteria.v1', JSON.stringify({ minRodExit: 12, minThrustToWeight: 3 }));
  const warned = row('warned', 'Warning motor', 300);
  Object.assign(warned.run!, { rodExitVelocity: 13, thrustToWeightAtRod: 4, simWarnings: [],
    comments: 'Rod-exit speed 13 < guidance. | Thrust:weight 4:1 at rod exit < 5:1.', commentLevels: ['warning', 'warning'] });
  sweep.mockResolvedValue({ rows: [warned], stopped: false });
  mount();
  await start();
  const verdict = bodyRows()[0]!.querySelector('td:last-child')?.textContent;
  expect(verdict).toContain('✓ accepted');
  expect(verdict).toContain('⚠ danger');
  expect(host.textContent).toContain('1 met your criteria');
  expect(loadRuns().map(r => r.id)).toEqual(['warned']);
});

it('J23 puts an expandable thrust mark on a Danger row and excludes it from acceptance', async () => {
  const warned = row('warned', 'Unbalanced', 300), balanced = row('balanced', 'Balanced', 310);
  warned.run!.simWarnings = asymmetricThrustWarnings(balanceTree(2), [['m0', balanceMotor()]]);
  sweep.mockResolvedValue({ rows: [warned, balanced], stopped: false });
  mount();
  await start();
  const warnedRow = bodyRows().find(tr => tr.querySelector('td')?.textContent?.startsWith('Unbalanced'))!;
  const balancedRow = bodyRows().find(tr => tr.querySelector('td')?.textContent?.startsWith('Balanced'))!;
  expect(warnedRow.querySelector('td:last-child')?.textContent).toContain('⚠ danger');
  expect(warnedRow.querySelector('td:last-child')?.textContent).not.toContain('accepted');
  expect(balancedRow.querySelector('td:last-child')?.textContent).toContain('accepted');
  expect(host.textContent).toContain('1 met your criteria');
  expect(loadRuns().map(r => r.id)).toEqual(['balanced']);
  const mark = warnedRow.querySelector('details.message-danger')!;
  expect(mark).not.toBeNull();
  expect(balancedRow.querySelector('details.message-danger')).toBeNull();
  act(() => mark.querySelector('summary')!.click());
  expect(mark.hasAttribute('open')).toBe(true);
  expect(mark.querySelector('p')?.textContent).toContain('simulation does not show this turn');
});

it.each(['NO_RECOVERY_DEVICE', 'TUMBLE_UNDER_THRUST', 'RECOVERY_LAUNCH_ROD'])(
  'J23 excludes any stored Danger %s with default criteria', async key => {
    const warned = row('warned', 'Warning motor', 300);
    warned.run!.simWarnings = [{ key, message: `[Warning.${key}]` }];
    sweep.mockResolvedValue({ rows: [warned], stopped: false });
    mount();
    await start();
    expect(bodyRows()[0]!.querySelector('td:last-child')?.textContent).toContain('⚠ danger');
    expect(host.textContent).toContain('0 met your criteria');
    expect(loadRuns()).toEqual([]);
  });

it.each(['MOTOR_TOO_LONG', 'MOTOR_TOO_WIDE'])('J23 marks a %s Batch row at Caution beside the verdict without failing it', async key => {
  const warned = row('warned', 'Long motor', 300);
  warned.run!.simWarnings = [{ key, message: 'MMT: Long motor: does not fit the mount.' }];
  sweep.mockResolvedValue({ rows: [warned], stopped: false });
  mount();
  await start();
  const verdict = bodyRows()[0]!.querySelector('td:last-child')!;
  expect(verdict.textContent).toContain('motor fit');
  expect(verdict.querySelector('details.message-caution')).not.toBeNull();
  expect(verdict.textContent).not.toContain('⚠ danger');
});

it.each([
  { label: 'slow guide exit', patch: { rodExitVelocity: 7.8, safeLiftoffSpeed: false } },
  { label: 'low thrust to weight', patch: { thrustToWeightAtRod: 4.1, safeThrustToWeight: false } },
  { label: 'under-stable margin', patch: { launchStaticMarginCal: -0.74, staticMarginOk: false } },
])('J23 excludes report Danger for $label without a Danger engine key', async ({ label, patch }) => {
  const warned = row('warned', 'Warning motor', 300);
  Object.assign(warned.run!, patch, { simWarnings: [{ key: 'LargeAOA', message: 'Large angle of attack' }],
    comments: label, commentLevels: ['warning'] });
  sweep.mockResolvedValue({ rows: [warned], stopped: false });
  mount();
  await start();
  expect(bodyRows()[0]!.querySelector('td:last-child')?.textContent).toContain('⚠ danger');
  expect(host.textContent).toContain('0 met your criteria');
  expect(loadRuns()).toEqual([]);
});

describe('the candidates', () => {
  it.each(['synchronous', 'ignition', 'weighed'] as const)('Round 4 six-ring tooltip and visible counts agree for %s groups', async reason => {
    localStorage.setItem('online-openrocket.batch-criteria.v1', JSON.stringify({ manufacturers: ['Klima'] }));
    const tree: RocketTree = { components: [{ type: 'stage', id: 's', children: [{ type: 'bodytube', id: 'b', children:
      Array.from({ length: 6 }, (_, i) => ({ type: 'innertube', id: i ? `m${i}` : 'mount', name: `MMT ${i + 1}`,
        motorMount: true, outerRadius: 0.0125, thickness: 0.0005, radialPosition: 0.025, radialDirection: i * Math.PI / 3 })) }] }] };
    const mounts = ['mount', 'm1', 'm2', 'm3', 'm4', 'm5'].map(id => ({ ...MOUNTS[0]!, id }));
    sweep.mockResolvedValue({ rows: [], stopped: false });
    mount({ tree, mounts });
    await start();
    const candidate = sweep.mock.calls[0]![0].candidates[0]!;
    const weighed = { mountId: 'mount', identity: candidateIdentity(candidate), pinned: false,
      name: candidate.designation, perMotorShiftKg: 0.1, deltaKg: 0.1 };
    mount({ tree, mounts, ...(reason === 'weighed' ? { weighed }
      : reason === 'ignition' ? { assignedIgnitions: { mount: { event: 'launch' as const, delay: 1 } } } : {}) });
    const n = candidateCount();
    for (const [name, extra] of [['mixed 3+3', n ** 2 - n], ['mixed 4+2 / 2+2+2', n ** 3 - n]] as const) {
      const label = [...host.querySelectorAll('label')].find(l => l.textContent?.trim() === name)!;
      expect(label.title).toContain(`${extra} mixed flights`);
      expect(label.title).toContain('every arrangement');
      act(() => label.querySelector('input')!.click());
      expect(host.textContent).toContain(`+${extra} ${name} combinations`);
    }
    expect(primary().textContent).toContain(`Simulate ${new Intl.NumberFormat('en-US').format(n ** 3 + n ** 2 - n)} flights`);
  });

  it('Round 2 marks a separate-ring mixed row carrying weighed hardware', async () => {
    sweep.mockResolvedValue({ rows: [{ ...row('mix', '2× E20 + 2× E22', 300), combo: true, weighed: true }], stopped: false });
    mount();
    await start();
    expect(bodyRows()[0]!.querySelector('td')!.textContent).toContain('· weighed');
  });
  it('N032 batch criteria and apogee cells use Altitude with mixed horizontal units', async () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { altitude: 'ft', distance: 'km' } }));
    sweep.mockResolvedValue({ rows: [row('split', 'Split', 304.8)], stopped: false });
    mount();
    type(host.querySelector<HTMLInputElement>('#batch-min')!, '500');
    expect(JSON.parse(localStorage.getItem('online-openrocket.batch-criteria.v1')!).minApogee).toBeCloseTo(152.4, 10);
    await start();
    const index = [...host.querySelectorAll('thead th')].findIndex(th => th.textContent?.startsWith('Apogee'));
    expect(bodyRows()[0]!.querySelectorAll('td')[index]?.textContent).toBe('1000');
  });
  it.each([undefined, '5', null, {}, Infinity])('storage hardening: draws unavailable optimum delay (%j)', async (optimumDelayS) => {
    const bad = row('bad', 'Bad', 100);
    bad.run = { ...bad.run, optimumDelayS } as SimRun;
    sweep.mockResolvedValue({ rows: [bad, row('good', 'Good', 100)], stopped: false });
    mount();
    await start();
    const headers = [...host.querySelectorAll('thead th')];
    const index = headers.findIndex((th) => th.textContent?.includes('Opt. delay'));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(bodyRows()[0]!.querySelectorAll('td')[index]?.textContent).toBe('—');
    expect(bodyRows()[1]!.querySelectorAll('td')[index]?.textContent).toBe('5.0s');
  });
  /**
   * THE EFFECTIVE CATALOGUE (audit 2026-09-22). The candidates came from the
   * static MOTOR_DB import while every other motor path read the live
   * thrustcurve.org overlay, so after a check the same motor flew a changed
   * row on the design page and the stale one here — two apogees for one motor.
   */
  it('follow a thrustcurve.org overlay, installed while the dialog is open', async () => {
    sweep.mockResolvedValue({ rows: [], stopped: false });
    mount();
    const before = candidateCount();
    const shipped = MOTOR_DB.find((m) => m.diameter === 24 && isAvailable(m))!;
    const changed = { ...shipped, totImpulseNs: shipped.totImpulseNs + 1 };
    const added = { ...shipped, motorId: 'overlay-added', designation: 'E99-T', commonName: 'E99' };
    act(() => setCatalogueOverlay({
      baseGenerated: MOTOR_DB_DATE, fetchedAt: '2026-09-22T00:00:00Z', liveCount: 0,
      added: [added],
      changed: [{ motorId: shipped.motorId, before: shipped, after: changed, fields: ['totImpulseNs'] }],
      removed: [], rejected: [],
    }));
    expect(candidateCount()).toBe(before + 1);
    await start();
    const flown = sweep.mock.calls[0]![0].candidates;
    expect(flown).toContain(added);
    // The changed row flies as thrustcurve.org now publishes it, not as shipped.
    expect(flown).toContain(changed);
    expect(flown).not.toContain(shipped);
  });
});

describe('the filter chips', () => {
  /**
   * They are toggles, and said so only by a CSS class — outside Daylight a
   * border and text shade, no fill — with no aria-pressed (audit 2026-09-22).
   * The filters persist, so a chip left on hides motors with nothing to say why.
   */
  it('say whether they are on, to a screen reader and without colour', () => {
    mount();
    for (const group of ['Manufacturers', 'Diameter classes']) {
      const chip = () => host.querySelector<HTMLButtonElement>(`[aria-label="${group}"] button.series-chip`)!;
      expect(chip().getAttribute('aria-pressed'), group).toBe('false');
      expect(chip().textContent, group).not.toContain('✓');
      act(() => { chip().click(); });
      expect(chip().getAttribute('aria-pressed'), group).toBe('true');
      expect(chip().textContent, group).toContain('✓');
      // The tick is visual only: aria-pressed already says it.
      expect(chip().querySelector('[aria-hidden="true"]')?.textContent, group).toBe('✓');
    }
  });
});

describe('a maker chosen where this mount does not offer it', () => {
  /**
   * The criteria persist across sessions and mounts, and the maker chips draw
   * only what THIS mount offers. The batch filtered by the stored list as it
   * stood, so Loki chosen on a 54 mm mount — Loki makes nothing under 38 mm —
   * left a 24 mm batch at "0 candidate motors", Simulate disabled, no chip
   * pressed and nothing on screen to say why; an out-of-production-only maker
   * did the same once "include OOP" was unticked (audit 2026-09-30). The
   * motor browser intersects the stored list with the chips it draws, and the
   * diameter classes here always did; the makers now do too. The stored list
   * is left alone, so the choice comes back on a mount that offers it.
   */
  const store = (criteria: Record<string, unknown>) =>
    localStorage.setItem('online-openrocket.batch-criteria.v1', JSON.stringify(criteria));
  const pressedMakers = () => [...host.querySelectorAll('[aria-label="Manufacturers"] button[aria-pressed="true"]')]
    .map((b) => (b.textContent ?? '').replace(/^✓/, '').trim().split(' ')[0]);
  const allButton = () => [...host.querySelectorAll('[aria-label="Manufacturers"] button')]
    .find((b) => b.textContent === 'all');
  /** The dialog's own candidate count with no maker stored — read from a fresh mount. */
  const unfiltered = () => {
    mount();
    const n = candidateCount();
    act(() => root.unmount());
    root = createRoot(host);
    return n;
  };

  it('a stored maker this mount does not offer filters nothing', async () => {
    const all = unfiltered();
    expect(all).toBeGreaterThan(0);
    store({ manufacturers: ['Loki'] });
    mount();
    expect(candidateCount()).toBe(all);
    expect(pressedMakers()).toEqual([]);
    // Nothing applies, so there is nothing for "all" to clear.
    expect(allButton()).toBeUndefined();
    expect(primary().disabled).toBe(false);
    sweep.mockResolvedValue({ rows: [], stopped: false });
    await start();
    expect(sweep.mock.calls[0]![0].candidates).toHaveLength(all);
    // Kept for a mount that offers it.
    expect(JSON.parse(localStorage.getItem('online-openrocket.batch-criteria.v1')!).manufacturers).toEqual(['Loki']);
  });

  it('nor does a maker whose motors here are all out of production, with "include OOP" unticked', () => {
    const all = unfiltered();
    // Ellis's 24 mm motors are all out of production in the shipped catalogue.
    expect(MOTOR_DB.some((m) => m.manufacturerAbbrev === 'Ellis' && m.diameter === 24)).toBe(true);
    expect(MOTOR_DB.some((m) => m.manufacturerAbbrev === 'Ellis' && m.diameter === 24 && isAvailable(m))).toBe(false);
    store({ manufacturers: ['Ellis'], includeOOP: false });
    mount();
    expect(candidateCount()).toBe(all);
  });

  it('a stored maker the mount DOES offer still applies beside one it does not', () => {
    const klima = MOTOR_DB.filter((m) => m.manufacturerAbbrev === 'Klima' && m.diameter <= 24 && isAvailable(m)).length;
    expect(klima).toBeGreaterThan(0);
    store({ manufacturers: ['Loki', 'Klima'] });
    mount();
    expect(candidateCount()).toBe(klima);
    expect(pressedMakers()).toEqual(['Klima']);
    expect(allButton()).toBeDefined();
  });
});

describe('the criteria boxes', () => {
  /**
   * A <label> with no `for` names its FIRST labelable descendant, which in the
   * three with a unit is the UnitChip <select> — so min rod-exit, min apogee
   * and max apogee were all announced by their placeholder, "—" (audit
   * 2026-09-22), and a value typed in the wrong one changes which motors pass.
   */
  it('each name themselves, and no two alike', () => {
    mount();
    const names = [...host.querySelectorAll('.motor-filter-row input:not([type="checkbox"])')]
      .map((i) => i.getAttribute('aria-label'));
    for (const n of ['Minimum rod-exit velocity (', 'Minimum apogee (', 'Maximum apogee (']) {
      expect(names.filter((x) => x?.startsWith(n)), n).toHaveLength(1);
    }
  });
});

describe('a sweep that throws', () => {
  /**
   * `start()` had no try/finally (audit 2026-09-22). Anything that threw
   * outside one flight left `running` true for good, and a running dialog
   * cannot be closed: the close button is disabled, the backdrop inert and
   * Escape guarded — a dead dialog over the whole app.
   */
  it('ends the run, says why, and leaves the dialog closable', async () => {
    sweep.mockRejectedValue(new Error('the nozzle table could not be loaded'));
    mount();
    await start();
    expect(stopBtn()).toBeUndefined();
    expect(primary()).toBeDefined();
    expect(closeBtn().disabled).toBe(false);
    expect(host.querySelector('.batch-failed')?.textContent)
      .toBe('The batch stopped before it finished: the nozzle table could not be loaded');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(closes).toBe(1);
  });

  // Live-region sweep (audit 2026-09-22): the alert and the Note around it were
  // both inserted with the failure; they now exist, empty and untiered, first.
  it('reports into an alert region, inside an outcome Note, that were both there before the run', async () => {
    sweep.mockRejectedValue(new Error('the nozzle table could not be loaded'));
    mount();
    const notes = host.querySelector('.batch-outcome-notes');
    const alert = host.querySelector('.batch-outcome-notes > .batch-failed-alert');
    expect(notes).not.toBeNull();
    expect(notes!.textContent).toBe('');
    expect(notes!.classList.contains('message-tier')).toBe(false);
    expect(alert?.getAttribute('role')).toBe('alert');
    expect(alert!.textContent).toBe('');
    await start();
    expect(host.querySelector('.batch-outcome-notes')).toBe(notes);
    expect(host.querySelector('.batch-outcome-notes > .batch-failed-alert')).toBe(alert);
    expect(alert!.querySelector('.batch-failed')?.textContent)
      .toBe('The batch stopped before it finished: the nozzle table could not be loaded');
    expect(notes!.classList.contains('message-danger')).toBe(true);
  });

  it('keeps the rows it flew before it failed, and says they still download', async () => {
    sweep.mockImplementation(async (_input, hooks: BatchSweepHooks) => {
      hooks.onRows?.([row('a', 'Acme E20', 300)]);
      throw new Error('boom');
    });
    mount();
    await start();
    expect(bodyRows()).toHaveLength(1);
    expect(host.querySelector('.batch-failed')?.textContent).toContain('still download');
  });
});

describe('Stop', () => {
  it('reaches the sweep through its signal, and the ending says it was stopped', async () => {
    sweep.mockImplementation((_input, hooks: BatchSweepHooks) => new Promise((resolve) => {
      hooks.onRows?.([row('a', 'Acme E20', 300)]);
      hooks.signal.addEventListener('abort', () => resolve({ rows: [row('a', 'Acme E20', 300)], stopped: true }));
    }));
    mount();
    await start();
    expect(stopBtn()).toBeDefined();
    await act(async () => { stopBtn()!.click(); });
    expect(host.querySelector('.batch-finished')?.textContent).toMatch(/^Stopped early/);
  });
});

describe('the finished line', () => {
  /**
   * It counted every sweep in MOTORS (audit 2026-09-30): with "mixed 2+2"
   * ticked the button said "Simulate 28 flights" and the end of the run
   * "simulated 28 motors", beside "7 candidate motors" in the meta line.
   */
  it('counts flights, as the button did, when a combination mode is ticked', async () => {
    // Klima's seven 24 mm motors: 7 + C(7,2) = 28 flights.
    localStorage.setItem('online-openrocket.batch-criteria.v1', JSON.stringify({ manufacturers: ['Klima'] }));
    mount({ tree: CLUSTER_TREE, mounts: CLUSTER_MOUNTS });
    const n = candidateCount();
    expect(n).toBeGreaterThan(1);
    const flights = n + mixedComboCount(n, 2);
    const box = [...host.querySelectorAll('label')].find((l) => (l.textContent ?? '').includes('mixed 2+2'))!
      .querySelector('input')!;
    act(() => { box.click(); });
    expect((primary().textContent ?? '').trim()).toMatch(new RegExp(`^Simulate ${flights} flights`));
    sweep.mockResolvedValue({
      rows: Array.from({ length: flights }, (_, i) => row(`k${i}`, `Acme E${i}`, 300)), stopped: false,
    });
    await start();
    const done = host.querySelector('.batch-finished')?.textContent ?? '';
    expect(done).toContain(`simulated ${flights} flights;`);
    expect(done).not.toContain('motors');
  });

  it('still counts motors on a sweep that flies only motors', async () => {
    sweep.mockResolvedValue({ rows: [row('a', 'Acme E20', 300), row('b', 'Acme E22', 310)], stopped: false });
    mount();
    await start();
    expect(host.querySelector('.batch-finished')?.textContent).toContain('simulated 2 motors;');
  });
});

describe('the finished line reaches a screen reader (audit 2026-09-30)', () => {
  /**
   * It was a role="status" paragraph MOUNTED with its text already in it — the
   * pattern this dialog's own progress region says is announced unreliably —
   * and it is the announcement a screen-reader user waits a multi-minute sweep
   * for; the progress region speaks only each tenth. The region is now always
   * mounted, and the line is rendered into it.
   */
  it('lands in a status region that was there, empty, before the sweep started', async () => {
    sweep.mockResolvedValue({ rows: [row('a', 'Acme E20', 300)], stopped: false });
    mount();
    const region = host.querySelector('.batch-status');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region!.textContent).toBe('');
    await start();
    // The same node, not a fresh one inserted with the text in place.
    expect(host.querySelector('.batch-status')).toBe(region);
    expect(region!.textContent).toMatch(/^Finished — simulated 1 motor;/);
    // One live region, not one nested inside another.
    expect(region!.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it('empties when the next sweep starts, so that sweep’s ending is new text again', async () => {
    sweep.mockResolvedValue({ rows: [row('a', 'Acme E20', 300)], stopped: false });
    mount();
    await start();
    const region = host.querySelector('.batch-status')!;
    expect(region.textContent).not.toBe('');
    let finish!: () => void;
    sweep.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ rows: [row('a', 'Acme E20', 300)], stopped: false });
    }));
    await start();
    expect(region.textContent).toBe('');
    await act(async () => { finish(); });
    expect(host.querySelector('.batch-status')).toBe(region);
    expect(region.textContent).toMatch(/^Finished/);
  });
});

describe('under StrictMode', () => {
  /**
   * The unmount flag was set in the effect's cleanup and never cleared, and
   * dev StrictMode mounts, unmounts and re-mounts every component once — so
   * under `npm run dev` the dialog believed itself unmounted from the start:
   * every sweep ended with no completion line and saved no runs (audit
   * 2026-09-22). Production was unaffected; anyone testing there was misled.
   */
  it('a finished sweep still announces itself and still saves its accepted runs', async () => {
    sweep.mockResolvedValue({ rows: [row('a', 'Acme E20', 300)], stopped: false });
    mount({ strict: true });
    await start();
    expect(host.querySelector('.batch-finished')?.textContent).toMatch(/^Finished/);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.map((r) => r.id)).toEqual(['a']);
  });
});

describe('the 500-run cap (audit 2026-09-22)', () => {
  it('the finished line says how many old runs saving the sweep removed', async () => {
    addRuns(Array.from({ length: 499 }, (_, i) => run(`old${i}`, 'Acme B4', 100)));
    sweep.mockResolvedValue({
      rows: [row('a', 'Acme E20', 300), row('b', 'Acme E22', 310), row('c', 'Acme E30', 320)], stopped: false,
    });
    mount();
    await start();
    expect(saved[0]).toHaveLength(500);
    // Its own Caution block (review of NOTES-1, finding 4: D7 G12), still in
    // the status region that announces the finished line.
    const retention = host.querySelector('.batch-status .batch-retention')!;
    expect(retention.textContent)
      .toContain('Saved simulations keeps up to 500 runs, so the oldest 2 were removed to make room.');
    expect(retention.textContent).not.toContain('not saved');
    expect(retention.classList.contains('message-caution')).toBe(true);
    expect(retention.textContent).toMatch(/^⚠ Caution: Saved simulations keeps/);
    expect(host.querySelector('.batch-finished')?.textContent).not.toContain('Saved simulations keeps');
  });

  it('a sweep that accepts more than 500 says which runs were removed and which never fit (from review)', async () => {
    // 100 saved, 600 accepted: the cut falls inside the sweep. One lumped count
    // said "the oldest 200"; 100 saved runs went, and 100 accepted never saved.
    addRuns(Array.from({ length: 100 }, (_, i) => run(`old${i}`, 'Acme B4', 100)));
    sweep.mockResolvedValue({
      rows: Array.from({ length: 600 }, (_, i) => row(`m${i}`, `Acme E${i}`, 300)), stopped: false,
    });
    mount();
    await start();
    expect(saved[0]).toHaveLength(500);
    expect(saved[0]!.some((r) => r.id.startsWith('old'))).toBe(false);
    expect(host.querySelector('.batch-retention')?.textContent).toContain(
      'Saved simulations keeps up to 500 runs, so the oldest 100 were removed to make room,'
      + ' and 100 new runs did not fit and were not saved. The CSV and XLSX above still carry every accepted run');
    expect(host.querySelector('.batch-retention')!.classList.contains('message-caution')).toBe(true);
  });

  it('and says nothing when there was room', async () => {
    sweep.mockResolvedValue({ rows: [row('a', 'Acme E20', 300)], stopped: false });
    mount();
    await start();
    expect(host.querySelector('.batch-finished')?.textContent).not.toContain('Saved simulations keeps');
    expect(host.querySelector('.batch-retention')).toBeNull();
  });
});

describe('verdicts', () => {
  /**
   * Graded in RENDER, against the criteria on screen. They were graded once,
   * when each flight landed, while the criteria fields above the table stayed
   * editable — so tightening the window after a sweep left rows marked
   * accepted that the window on screen excluded (audit 2026-09-22).
   */
  it('follow the criteria on screen, not the ones the sweep started with', async () => {
    sweep.mockResolvedValue({ rows: [row('a', 'Acme E20', 300), row('b', 'Acme E30', 500)], stopped: false });
    mount();
    await start();
    expect(verdictOf('Acme E20')).toBe('✓ accepted');
    expect(verdictOf('Acme E30')).toBe('✓ accepted');
    type(field('Maximum apogee'), '400');
    expect(verdictOf('Acme E20')).toBe('✓ accepted');
    expect(verdictOf('Acme E30')).toBe('✗ apogee too high');
    // …and the accepted row now sorts first, as the table's own order says.
    expect(bodyRows()[0]!.textContent).toContain('Acme E20');
    expect(host.querySelector('.batch-finished')?.textContent).toContain('1 met your criteria');
    type(field('Maximum apogee'), '');
    expect(verdictOf('Acme E30')).toBe('✓ accepted');
  });

  it('save the runs that meet the criteria as they stand when the sweep ENDS', async () => {
    let finish!: () => void;
    sweep.mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve({ rows: [row('a', 'Acme E20', 300), row('b', 'Acme E30', 500)], stopped: false });
    }));
    mount();
    await start();
    // Tightened while the sweep is still flying.
    type(field('Maximum apogee'), '400');
    await act(async () => { finish(); });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.map((r) => r.id)).toEqual(['a']);
  });
});

describe('the table', () => {
  /**
   * RES-1c: the Batch window's ⬇ CSV / ⬇ XLSX were built with no comparison
   * key, so every Status cell read Unknown while the Saved simulations export
   * of the SAME runs said Changed / Current. App hands its provenance key in.
   */
  it.each([
    { mixed: false, provenance: true }, { mixed: true, provenance: true }, { mixed: true, provenance: false },
  ])('RES-1c exports Status against App’s provenance key in CSV and every XLSX sheet (mixed $mixed, key $provenance)', async ({ mixed, provenance }) => {
    const single = row('a', 'Acme E20', 300);
    single.run!.designKey = 'flown';
    const rows = [single];
    if (mixed) {
      const combo = row('b', 'Acme E20 + Acme E22', 310);
      combo.run!.designKey = 'flown';
      combo.run!.motorConfig = 'mixed 2+2';
      rows.push(combo);
    }
    sweep.mockResolvedValue({ rows, stopped: false });
    mount({ provenance: provenance ? { designKey: 'edited' } as DesignMatchKey : undefined });
    await start();
    const want = provenance ? 'Changed' : 'Unknown';
    act(() => { buttons().find((b) => b.textContent === '⬇ CSV')!.click(); });
    const lines = (await vi.mocked(downloadBlob).mock.calls[0]![0].text()).trim().split('\n');
    const statusAt = lines[0]!.split(',').indexOf('Status');
    expect(statusAt).toBeGreaterThan(-1);
    expect(lines.slice(1).map((l) => l.split(',')[statusAt]!.trim())).toEqual(rows.map(() => want));
    act(() => { buttons().find((b) => b.textContent === '⬇ XLSX')!.click(); });
    const files = unzipSync(new Uint8Array(await vi.mocked(downloadBlob).mock.calls[1]![0].arrayBuffer()));
    const sheets = Object.keys(files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort();
    // Batch alone; or All results + Single motor + Mixed 2+2.
    expect(sheets).toHaveLength(mixed ? 3 : 1);
    for (const name of sheets) {
      const sheet = new DOMParser().parseFromString(strFromU8(files[name]!), 'text/xml');
      const xlsxRows = [...sheet.querySelectorAll('sheetData row')];
      const ref = xlsxRows[0]!.querySelectorAll('c')[statusAt]!;
      expect(ref.textContent).toBe('Status');
      const col = ref.getAttribute('r')!.replace(/\d+$/, '');
      const cells = xlsxRows.slice(1).map((r, i) => r.querySelector(`c[r="${col}${i + 2}"]`)?.textContent);
      expect(cells.length).toBeGreaterThan(0);
      expect(cells).toEqual(cells.map(() => want));
    }
  });

  it('shows travel and rail beside rod exit and exports both at the current threshold in CSV and XLSX', async () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'ft', velocity: 'm/s' } }));
    const reached = row('a', 'Acme E20', 300);
    reached.run!.railProfile = { segments: [[0, 20, 0, 2]], railM: 4, offsetM: 0.5, allowance: true, thrustEnded: false };
    const short = row('b', 'Acme E22', 200);
    short.run!.railProfile = { ...reached.run!.railProfile, segments: [[0, 10, 0, 2]] };
    const ended = row('c', 'Acme E23', 100);
    ended.run!.railProfile = { ...short.run!.railProfile, thrustEnded: true };
    const imported = row('d', 'Acme imported', 50);
    imported.run = importedSummaryRuns({ name: 'Imported', storedSimulations: [{ name: 'Stored', configId: null,
      data: { maxAltitude: 50 } }] })[0]!;
    // Even a stale/foreign profile must not turn a read-only summary into a measurement.
    imported.run.railProfile = reached.run!.railProfile;
    sweep.mockResolvedValue({ rows: [reached, short, ended, imported, failedRow('x', 'Acme bad')], stopped: false });
    mount();
    await start();
    const headers = () => [...host.querySelectorAll('.motor-table th')].map((x) => x.textContent);
    expect(headers().slice(4, 6)).toEqual(['Travel for 15.0 m/s (ft)', 'Rail for 15.0 m/s (ft)']);
    const lengths = (index: number) => [4, 5].map(i => bodyRows()[index]!.children[i]!.textContent);
    expect(lengths(0)).toEqual(['4.9', '6.6']);
    expect(lengths(1)).toEqual(['Not reached within 11.483 ft (3500 mm)', 'Not reached within 13.123 ft (4000 mm)']);
    expect(lengths(2)).toEqual(['Cannot reach: thrust ended', 'Cannot reach: thrust ended']);
    expect(lengths(3)).toEqual(['', '']);
    expect(lengths(4)).toEqual(['', '']);
    // The field is editable after the sweep: no new flight, and all exports follow it.
    type(field('Minimum rod-exit velocity'), '20');
    expect(headers().slice(4, 6)).toEqual(['Travel for 20.0 m/s (ft)', 'Rail for 20.0 m/s (ft)']);
    expect(lengths(0)).toEqual(['6.6', '8.2']);
    expect(sweep).toHaveBeenCalledOnce();
    act(() => { buttons().find((b) => b.textContent === '⬇ CSV')!.click(); });
    const csv = await vi.mocked(downloadBlob).mock.calls[0]![0].text();
    const exportHeaders = csv.split('\n')[0]!.split(',');
    const railAt = exportHeaders.indexOf('Rail for 20.0 m/s (ft)');
    const travelAt = exportHeaders.indexOf('Travel for 20.0 m/s (ft)');
    expect(railAt).toBeGreaterThan(-1);
    expect(travelAt).toBeGreaterThan(-1);
    expect(exportHeaders[railAt + 1]).toMatch(/^Max dynamic pressure/);
    expect(csv.split('\n')[1]!.split(',')[railAt]).toBe('8.202');
    expect(csv.split('\n')[1]!.split(',')[travelAt]!.trim()).toBe('6.562');
    expect(csv).toContain('Not reached within 13.123 ft (4000 mm)');
    expect(csv).toContain('Not reached within 11.483 ft (3500 mm)');
    expect(csv).toContain('Cannot reach: thrust ended');
    // The imported-summary comment contains quoted commas.
    const importedCsv = csv.split('\n')[4]!.trim().split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    expect(importedCsv[railAt]).toBe('');
    expect(importedCsv[travelAt]).toBe('');
    act(() => { buttons().find((b) => b.textContent === '⬇ XLSX')!.click(); });
    const bytes = new Uint8Array(await vi.mocked(downloadBlob).mock.calls[1]![0].arrayBuffer());
    const xml = strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']!);
    expect(xml).toContain('Rail for 20.0 m/s (ft)');
    expect(xml).toContain('Travel for 20.0 m/s (ft)');
    expect(xml).toContain('<v>8.202</v>');
    expect(xml).toContain('<v>6.562</v>');
    expect(xml).toContain('Not reached within 13.123 ft (4000 mm)');
    expect(xml).toContain('Not reached within 11.483 ft (3500 mm)');
    // Inspect by column, including the imported summary's empty XLSX cells.
    const sheet = new DOMParser().parseFromString(xml, 'text/xml');
    const xlsxRows = [...sheet.querySelectorAll('sheetData row')];
    const xlsxCell = (r: number, c: number) => {
      const ref = xlsxRows[0]!.querySelectorAll('c')[c]!.getAttribute('r')!.replace(/\d+$/, String(r + 1));
      return xlsxRows[r]!.querySelector(`c[r="${ref}"]`)?.textContent ?? '';
    };
    expect(xlsxCell(1, travelAt)).toBe('6.562');
    expect(xlsxCell(1, railAt)).toBe('8.202');
    expect(xlsxCell(3, travelAt)).toBe('Cannot reach: thrust ended');
    expect(xlsxCell(3, railAt)).toBe('Cannot reach: thrust ended');
    expect(xlsxCell(4, travelAt)).toBe('');
    expect(xlsxCell(4, railAt)).toBe('');
    type(field('Minimum rod-exit velocity'), '');
    expect(headers().slice(4, 6)).toEqual(['Travel for 15.0 m/s (ft)', 'Rail for 15.0 m/s (ft)']);
  });
  /**
   * CAPPED (audit 2026-09-22): every row was drawn and re-drawn after every
   * flight, and a mixed-cluster sweep reaches tens of thousands of rows — a
   * DOM of ~200k nodes on a 25k-row sweep. The export is not capped.
   */
  it(`draws the best ${BATCH_TABLE_ROWS} flown rows, says how many it leaves out, and exports every one`, async () => {
    const rows = Array.from({ length: BATCH_TABLE_ROWS + 50 }, (_, i) => row(`m${i}`, `Acme E${i}`, 100 + i));
    sweep.mockResolvedValue({ rows, stopped: false });
    mount();
    await start();
    expect(bodyRows()).toHaveLength(BATCH_TABLE_ROWS);
    // The highest apogee first; the 50 lowest are the ones left off.
    expect(bodyRows()[0]!.textContent).toContain(`Acme E${BATCH_TABLE_ROWS + 49}`);
    expect(host.querySelector('.batch-cap')?.textContent)
      .toBe(`Showing the top ${BATCH_TABLE_ROWS} of ${BATCH_TABLE_ROWS + 50} flown rows — the CSV and XLSX carry every one.`);
    // Nothing is lost — both exports carry every flown row — so it stays
    // Information (review of NOTES-1, finding 4: D7 G12 is the retention loss).
    expect(host.querySelector('.batch-outcome-notes')!.classList.contains('message-tier')).toBe(false);
    expect(host.querySelector('.batch-outcome-notes .message-label')).toBeNull();
    act(() => { buttons().find((b) => b.textContent === '⬇ CSV')!.click(); });
    const csv = await vi.mocked(downloadBlob).mock.calls[0]![0].text();
    // A header line, then one line per row — none of them capped away.
    expect(csv.trim().split('\n')).toHaveLength(BATCH_TABLE_ROWS + 51);
  });

  /**
   * The rows that could not be flown sort LAST, so the first cut of the cap —
   * the top 400 of everything — dropped every one of them from any sweep with
   * more than 400 flown rows, and neither export carries them: which motors
   * failed, and why, was nowhere while the summary still counted them (review
   * of the cap, 2026-09-22). They get an allowance of their own.
   */
  it('still lists every row that could not be flown when the flown rows fill the cap', async () => {
    const rows = [
      ...Array.from({ length: BATCH_TABLE_ROWS + 50 }, (_, i) => row(`m${i}`, `Acme E${i}`, 100 + i)),
      failedRow('x1', 'Acme F1'), failedRow('x2', 'Acme F2'), failedRow('x3', 'Acme F3'),
    ];
    sweep.mockResolvedValue({ rows, stopped: false });
    mount();
    await start();
    expect(bodyRows()).toHaveLength(BATCH_TABLE_ROWS + 3);
    expect(bodyRows().slice(-3).map((tr) => tr.querySelector('td:last-child')!.textContent))
      .toEqual(['error: no thrust curve', 'error: no thrust curve', 'error: no thrust curve']);
    expect(host.querySelector('.batch-finished')?.textContent).toContain('3 could not be flown');
    // The note speaks only of the flown rows, which is what the exports carry.
    expect(host.querySelector('.batch-cap')?.textContent)
      .toBe(`Showing the top ${BATCH_TABLE_ROWS} of ${BATCH_TABLE_ROWS + 50} flown rows — the CSV and XLSX carry every one.`);
  });

  it('caps the rows that could not be flown as well, and says so', async () => {
    const rows = [
      row('a', 'Acme E20', 300),
      ...Array.from({ length: BATCH_TABLE_ROWS + 5 }, (_, i) => failedRow(`x${i}`, `Acme F${i}`)),
    ];
    sweep.mockResolvedValue({ rows, stopped: false });
    mount();
    await start();
    expect(bodyRows()).toHaveLength(BATCH_TABLE_ROWS + 1);
    expect(host.querySelector('.batch-cap')?.textContent)
      .toBe(`Listing the first ${BATCH_TABLE_ROWS} of ${BATCH_TABLE_ROWS + 5} rows that could not be flown, which neither export carries.`);
    // Rows neither export carries: this branch of the cap does lose them.
    expect(host.querySelector('.batch-outcome-notes')!.classList.contains('message-caution')).toBe(true);
  });

  it('names both cuts when both are made, and nothing when neither is', () => {
    expect(batchCapNote({ flown: 26796, failed: 3600 })).toBe(
      'Showing the top 400 of 26,796 flown rows — the CSV and XLSX carry every one. '
      + 'Listing the first 400 of 3,600 rows that could not be flown, which neither export carries.');
    expect(batchCapNote({ flown: BATCH_TABLE_ROWS, failed: BATCH_TABLE_ROWS })).toBeNull();
  });

  it('says nothing about a cap it has not reached', async () => {
    sweep.mockResolvedValue({ rows: [row('a', 'Acme E20', 300)], stopped: false });
    mount();
    await start();
    expect(host.querySelector('.batch-cap')).toBeNull();
  });

  /**
   * KEYED ON EACH ROW'S IDENTITY. Combination rows were keyed on their label,
   * and labels repeat — the audit rendered 6 rows as 8 DOM rows in a re-sorted
   * list — and single-motor rows on their sorted position, so every insertion
   * remounted the rows below it.
   */
  it('keeps one DOM row per row through a re-sort, even where two rows share a label', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    sweep.mockImplementation(async (_input, hooks: BatchSweepHooks) => {
      const out = [row('k1', '3× Acme E20 + 3× Acme E22', 300), row('k2', 'Acme E20', 200)];
      hooks.onRows?.([...out]);
      // Two more that share those labels, and sort ABOVE them.
      out.push(row('k3', '3× Acme E20 + 3× Acme E22', 600), row('k4', 'Acme E20', 500));
      hooks.onRows?.([...out]);
      out.push(row('k5', '3× Acme E20 + 3× Acme E22', 150), row('k6', 'Acme E20', 700));
      hooks.onRows?.([...out]);
      return { rows: out, stopped: false };
    });
    mount();
    await start();
    expect(bodyRows()).toHaveLength(6);
    expect(bodyRows().map((tr) => tr.querySelector('td:nth-child(3)')!.textContent))
      .toEqual(['700', '600', '500', '300', '200', '150']);
    expect(errors.mock.calls.some((c) => String(c[0]).includes('same key'))).toBe(false);
  });
});


it('hands the full profile to the batch sweep', async () => {
  sweep.mockResolvedValue({ rows: [], stopped: false });
  const windLevels = [{ altitude: 10, speed: 3, direction: 0, standardDeviation: 0 }, { altitude: 80, speed: 12, direction: 0.2, standardDeviation: 0 }];
  mount({ launch: { ...DEFAULT_CONDITIONS, windLevels } });
  await start();
  expect(sweep).toHaveBeenCalledOnce();
  expect(sweep.mock.calls[0]![0].launch.windLevels).toEqual(windLevels);
});

it('hands retained hardware to the sweep without enabling weighed candidates', async () => {
  sweep.mockResolvedValue({ rows: [], stopped: false });
  mount({ retainedHardware: { mountId: 'other', deltaKg: 0.01 } });
  await start();
  expect(sweep).toHaveBeenCalledOnce();
  expect(sweep.mock.calls[0]![0].retainedHardware).toEqual({ mountId: 'other', deltaKg: 0.01 });
  expect(sweep.mock.calls[0]![0].weighed).toBeUndefined();
});

it.each([
  [{ mass: 'g' }, '50 g (1.76 oz)'],
  [{ mass: 'oz' }, '1.76 oz (50 g)'],
] as const)('pairs the weighed hardware notice (%j)', (units, mass) => {
  localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units }));
  mount({ weighed: { mountId: 'other', identity: 'Home/Test', pinned: false, name: 'Test', perMotorShiftKg: 0.05, deltaKg: 0.05 } });
  expect(host.querySelector('.batch-weighed')?.textContent).toContain(`keeps its ${mass} of hardware in every flight`);
});

it.each(['auto', 'eb'] as const)('S3a-9: finished %s badges follow the flown model and mount', async (model) => {
  const flown = row('motor', 'C6', 100);
  Object.assign(flown.run!, { aeroModel: model === 'eb' ? 'classic' : 'auto', rogersKbf: false,
    nozzleStages: [{ stageId: 'st0', stageName: 'Sustainer', exitDiameterM: 0.01 }] });
  sweep.mockResolvedValue({ rows: [flown], stopped: false });
  mount({ mounts: [...MOUNTS, { ...MOUNTS[0]!, id: 'other', label: 'Other mount' }],
    weighed: { mountId: 'mount', identity: 'Acme/C6', pinned: false, name: 'C6', perMotorShiftKg: 0.01, deltaKg: 0.01 } });
  const select = (value: string) => [...host.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === value))!;
  const pick = (el: HTMLSelectElement, value: string) => act(() => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })); });
  pick(select('eb'), model);
  await act(async () => primary().click());
  expect(bodyRows()[0]!.textContent).toContain('· weighed');
  pick(select('other'), 'other');
  pick(select('eb'), model === 'eb' ? 'auto' : 'eb');
  expect.soft(bodyRows()[0]!.textContent).toContain('· weighed');
  expect.soft(bodyRows()[0]!.textContent?.includes('· nozzle')).toBe(model === 'auto');
  expect.soft(host.querySelector('.batch-nozzle') !== null).toBe(model === 'auto');
  expect(sweep).toHaveBeenCalledOnce();
});
