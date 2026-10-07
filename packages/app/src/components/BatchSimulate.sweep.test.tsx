// @vitest-environment happy-dom
import { StrictMode, act } from 'react';
import { strFromU8, unzipSync } from 'fflate';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { SimRun } from '../services/simReport.js';
import { MOTOR_DB, MOTOR_DB_DATE, isAvailable, setCatalogueOverlay } from '../services/motorDb.js';
import { DEFAULT_CONDITIONS, type LaunchConditions } from './LaunchPanel.js';
import { BATCH_TABLE_ROWS, BatchSimulate, batchCapNote } from './BatchSimulate.js';
import {
  mixedComboCount, runBatchSweep, type BatchMountOption, type BatchRow, type BatchSweepHooks, type BatchWeighed,
} from '../services/batchSweep.js';
import { downloadBlob } from '../services/saveFile.js';
import { addRuns } from '../services/simStore.js';
import { importedSummaryRuns } from '../services/orkFlightData.js';

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

beforeEach(() => {
  localStorage.clear();
  saved = [];
  closes = 0;
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

function mount({ strict = false, launch = DEFAULT_CONDITIONS, tree = TREE, mounts = MOUNTS, weighed, retainedHardware }: {
  strict?: boolean; launch?: LaunchConditions; tree?: RocketTree; mounts?: BatchMountOption[]; weighed?: BatchWeighed;
  retainedHardware?: Pick<BatchWeighed, 'mountId' | 'deltaKg'>;
} = {}) {
  const dialog = (
    <PrefsProvider>
      <BatchSimulate
        tree={tree} info={{} as never} mounts={mounts} initialMountId="mount"
        assignedMountMotors={{}} assignedMotors={{}} assignedMotorIds={{}} assignedIgnitions={{}}
        launch={launch} rocketName="Sweep bird" weighed={weighed}
        retainedHardware={retainedHardware}
        onRunsChange={(runs) => { saved.push(runs); }}
        onClose={() => { closes++; }}
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
const candidateCount = () => Number(/(\d+) candidate motors/.exec(host.textContent ?? '')![1]);

describe('the candidates', () => {
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
    expect(host.querySelector('.batch-finished')?.textContent)
      .toContain('Saved simulations keeps up to 500 runs, so the oldest 2 were removed to make room.');
    expect(host.querySelector('.batch-finished')?.textContent).not.toContain('not saved');
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
    expect(host.querySelector('.batch-finished')?.textContent).toContain(
      'Saved simulations keeps up to 500 runs, so the oldest 100 were removed to make room,'
      + ' and 100 new runs did not fit and were not saved. The CSV and XLSX above still carry every accepted run');
  });

  it('and says nothing when there was room', async () => {
    sweep.mockResolvedValue({ rows: [row('a', 'Acme E20', 300)], stopped: false });
    mount();
    await start();
    expect(host.querySelector('.batch-finished')?.textContent).not.toContain('Saved simulations keeps');
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
  it('shows travel and rail beside rod exit and exports both at the current threshold in CSV and XLSX', async () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'ft', velocity: 'm/s' } }));
    const reached = row('a', 'Acme E20', 300);
    reached.run!.railProfile = { segments: [[0, 20, 0, 2]], railM: 4, offsetM: 0.5, allowance: true, thrustEnded: false };
    const short = row('b', 'Acme E22', 200);
    short.run!.railProfile = { ...reached.run!.railProfile, segments: [[0, 10, 0, 2]] };
    const ended = row('c', 'Acme E23', 100);
    ended.run!.railProfile = { ...short.run!.railProfile, thrustEnded: true };
    const imported = row('d', 'Acme imported', 50);
    imported.run = importedSummaryRuns({ name: 'Imported', storedSimulations: [{ name: 'Stored', configId: null, windAverage: 0,
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
    expect(lengths(1)).toEqual(['Not reached within 11.5 ft', 'Not reached within 13.1 ft']);
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
    expect(csv).toContain('Not reached within 13.1 ft');
    expect(csv).toContain('Not reached within 11.5 ft');
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
    expect(xml).toContain('Not reached within 13.1 ft');
    expect(xml).toContain('Not reached within 11.5 ft');
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
