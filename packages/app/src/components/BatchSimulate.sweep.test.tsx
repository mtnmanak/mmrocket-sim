// @vitest-environment happy-dom
import { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RocketTree } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import type { SimRun } from '../services/simReport.js';
import { MOTOR_DB, MOTOR_DB_DATE, isAvailable, setCatalogueOverlay } from '../services/motorDb.js';
import { DEFAULT_CONDITIONS } from './LaunchPanel.js';
import { BATCH_TABLE_ROWS, BatchSimulate } from './BatchSimulate.js';
import {
  runBatchSweep, type BatchMountOption, type BatchRow, type BatchSweepHooks,
} from '../services/batchSweep.js';
import { downloadBlob } from '../services/saveFile.js';

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

function mount({ strict = false } = {}) {
  const dialog = (
    <PrefsProvider>
      <BatchSimulate
        tree={TREE} info={{} as never} mounts={MOUNTS} initialMountId="mount"
        assignedMotors={{}} assignedMotorIds={{}} assignedIgnitions={{}}
        launch={DEFAULT_CONDITIONS} rocketName="Sweep bird"
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
   * CAPPED (audit 2026-09-22): every row was drawn and re-drawn after every
   * flight, and a mixed-cluster sweep reaches tens of thousands of rows — a
   * DOM of ~200k nodes on a 25k-row sweep. The export is not capped.
   */
  it(`draws the best ${BATCH_TABLE_ROWS} rows, says how many it leaves out, and exports every one`, async () => {
    const rows = Array.from({ length: BATCH_TABLE_ROWS + 50 }, (_, i) => row(`m${i}`, `Acme E${i}`, 100 + i));
    sweep.mockResolvedValue({ rows, stopped: false });
    mount();
    await start();
    expect(bodyRows()).toHaveLength(BATCH_TABLE_ROWS);
    // The highest apogee first; the 50 lowest are the ones left off.
    expect(bodyRows()[0]!.textContent).toContain(`Acme E${BATCH_TABLE_ROWS + 49}`);
    expect(host.querySelector('.batch-cap')?.textContent)
      .toBe(`Showing the top ${BATCH_TABLE_ROWS} of ${BATCH_TABLE_ROWS + 50} rows — the CSV and XLSX carry every one.`);
    act(() => { buttons().find((b) => b.textContent === '⬇ CSV')!.click(); });
    const csv = await vi.mocked(downloadBlob).mock.calls[0]![0].text();
    // A header line, then one line per row — none of them capped away.
    expect(csv.trim().split('\n')).toHaveLength(BATCH_TABLE_ROWS + 51);
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
