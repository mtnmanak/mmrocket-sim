// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimHistory, SimRunDetails } from './SimResults.js';
import { addRuns, loadRuns } from '../services/simStore.js';
import { importedSummaryRuns } from '../services/orkFlightData.js';
import { compassPoint } from '../services/openMeteo.js';
import { PrefsProvider, usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi } from '../prefs/units.js';
import * as units from '../prefs/units.js';
import { buildSimRun, type DeploymentReport, type SimRun, formatRunWhenProse, runStoppedEarly,
} from '../services/simReport.js';
import { DEFAULT_CONDITIONS } from './LaunchPanel.js';
import { gradeBatchRun, type Criteria } from './BatchSimulate.js';
import type { FlightResult, StaticInfo } from '@online-openrocket/engine';

/**
 * Two things this file pins, both of them copy the user reads on the busiest
 * tab in the app:
 *
 *  - The launch report no longer carries the raw flight-data buttons (they
 *    live beside the plots now), so what it says in their place has to be true
 *    in BOTH states — series in memory, and a stored run whose series nobody
 *    has computed.
 *  - Every download button names its DATA with the format as a parenthetical.
 *    Three different datasets on this tab used to be labelled "⬇ CSV".
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const info: StaticInfo = {
  length: 0.37, lengthAerodynamic: 0.37, mass: 0.051, massEmpty: 0.027, cgEmpty: 0.19, cg: 0.26,
  rotationalInertia: 1.2e-4, longitudinalInertia: 3.4e-3,
  rotationalInertiaEmpty: 1.0e-4, longitudinalInertiaEmpty: 3.0e-3,
  cp: 0.29, cna: 8, stabilityCalibers: 1.3, refDiameter: 0.024,
  warnings: 0, warningTexts: [],
};

/** The same self-consistent flight simReport.test.ts uses. */
function fakeResult(): FlightResult {
  const time = [0, 0.15, 1, 2, 6.8, 7.0, 104];
  return {
    summary: {
      maxAltitude: 331.7, maxVelocity: 116.2, maxAcceleration: 227.5,
      maxMachNumber: 0.35, timeToApogee: 6.8, flightTime: 104,
      groundHitVelocity: 3.4, launchRodVelocity: 18.4,
      deploymentVelocity: 4.2, optimumDelay: 4.9,
    },
    events: [
      { type: 'LAUNCH', time: 0 },
      { type: 'LAUNCHROD', time: 0.15 },
      { type: 'BURNOUT', time: 2 },
      { type: 'APOGEE', time: 6.8 },
      { type: 'EJECTION_CHARGE', time: 7.0 },
      { type: 'RECOVERY_DEVICE_DEPLOYMENT', time: 7.0 },
      { type: 'GROUND_HIT', time: 104 },
    ],
    series: {
      time,
      altitude: [0, 2, 60, 200, 331.7, 331.0, 0],
      velocity: [0, 18.4, 100, 116.2, 1, 4.2, 3.4],
      acceleration: [0, 120, 30, -9.8, -9.8, -9.8, 0],
      mass: [0.051, 0.050, 0.045, 0.040, 0.040, 0.040, 0.040],
      thrust: [0, 11, 5, 0, 0, 0, 0],
      drag: [0, 0.1, 1, 1.4, 0, 0, 0],
      mach: [0, 0.05, 0.3, 0.35, 0, 0, 0],
      stability: [1.3, 1.3, 1.5, 1.6, 1.6, 1.6, 1.6],
      cpLocation: [0.29, 0.29, 0.29, 0.29, 0.29, 0.29, 0.29],
      cgLocation: [0.26, 0.26, 0.25, 0.25, 0.25, 0.25, 0.25],
      aoa: [0, 0, 0, 0, 0, 0, 0],
    },
  } as unknown as FlightResult;
}

const run = (): SimRun => buildSimRun({
  result: fakeResult(), info,
  motor: {
    designation: 'C6', ejectionDelay: 5, diameter: 0.018, length: 0.07,
    totalImpulse: 8.8, burnTime: 1.85, averageThrust: 4.7, maxThrust: 14.1,
  } as never,
  meta: { label: 'C6-5' },
  launch: DEFAULT_CONDITIONS,
  rocketName: 'Big Dog 4in',
  execMs: 100,
});

let host: HTMLDivElement;
let root: Root;

const render = (node: React.ReactNode) => act(() => root.render(
  <PrefsProvider>{node}</PrefsProvider>,
));

/** The run table starts collapsed — the rows (and their buttons) need it open.
 *  A no-op once it already is (re-rendering into the same root keeps state). */
const openTable = () => act(() => {
  Array.from(host.querySelectorAll('button'))
    .find((b) => (b.textContent ?? '') === 'Show')
    ?.click();
});

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('SimRunDetails — where the raw flight data went', () => {
  it.each([null, undefined, '5', {}, NaN, Infinity])('storage hardening: renders unavailable deployment time (%j)', (time) => {
    const deployment = { device: 'Main', time, altitude: 200, velocityAtDeployment: 35,
      descentRate: 5, groundSpeed: 5, isLanding: true, descentOk: true };
    localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify([
      { ...run(), deployments: [deployment, { ...deployment, device: 'Drogue', time: 6 }] },
    ]));
    render(<SimRunDetails run={loadRuns()[0]!} />);
    const rows = [...host.querySelectorAll('tr')];
    const main = rows.find((tr) => tr.cells[0]?.textContent === 'Main (landing)');
    const drogue = rows.find((tr) => tr.cells[0]?.textContent === 'Drogue (landing)');
    expect(main?.cells[1]?.textContent).toBe('—');
    expect(drogue?.cells[1]?.textContent).toBe('6.0 s');
    expect(main?.textContent).toContain('hard opening');
  });

  it.each([null, undefined, '5', {}, NaN, Infinity])('renders unavailable deployment altitude and ground speed without coercion (%j)', (value) => {
    const format = vi.spyOn(units, 'fmtSi');
    const deployment = { device: 'Main', time: 6, altitude: value, velocityAtDeployment: 35,
      descentRate: 5, groundSpeed: value, isLanding: true, descentOk: true };
    localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify([
      { ...run(), deployments: [deployment, { ...deployment, device: 'Drogue', altitude: 200, groundSpeed: 5 },
        { ...deployment, device: 'Zero', altitude: 0, groundSpeed: 0 }] },
    ]));
    const stored = loadRuns()[0]!;
    // JSON normalizes NaN/Infinity to null; also exercise the raw values directly.
    for (const current of [stored, { ...stored, deployments: [deployment, ...stored.deployments!.slice(1)] } as SimRun]) {
      format.mockClear();
      render(<SimRunDetails run={current} />);
      // Invalid measurements must be rejected by the reader before formatting.
      expect(format.mock.calls.every(([, , si]) => typeof si === 'number' && Number.isFinite(si))).toBe(true);
      const rows = [...host.querySelectorAll('tr')];
      const main = rows.find((tr) => tr.cells[0]?.textContent === 'Main (landing)')!;
      const drogue = rows.find((tr) => tr.cells[0]?.textContent === 'Drogue (landing)')!;
      const zero = rows.find((tr) => tr.cells[0]?.textContent === 'Zero (landing)')!;
      expect(main.cells[2]?.textContent).toBe('\u2014');
      expect(main.cells[6]?.textContent).toBe('\u2014');
      expect(drogue.cells[2]?.textContent).toBe(fmtSi('distance', 'm', 200));
      expect(drogue.cells[6]?.textContent).toBe(fmtSi('velocity', 'm/s', 5));
      expect(zero.cells[2]?.textContent).toBe(fmtSi('distance', 'm', 0));
      expect(zero.cells[6]?.textContent).toBe(fmtSi('velocity', 'm/s', 0));
    }
  });

  it.each([null, undefined, '5', {}, NaN, Infinity])('renders unavailable deployment speeds without coercion (%j)', (speed) => {
    const deployment = { device: 'Main', time: 6, altitude: 200, velocityAtDeployment: speed,
      descentRate: speed, groundSpeed: 5, isLanding: true, descentOk: true };
    localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify([
      { ...run(), velocityAtDeployment: speed, deployments: [deployment,
        { ...deployment, device: 'Drogue', velocityAtDeployment: 35, descentRate: 5 }] },
    ]));
    render(<SimRunDetails run={loadRuns()[0]!} />);
    const rows = [...host.querySelectorAll('tr')];
    const main = rows.find((tr) => tr.cells[0]?.textContent === 'Main (landing)')!;
    const drogue = rows.find((tr) => tr.cells[0]?.textContent === 'Drogue (landing)')!;
    expect(main.cells[3]?.textContent).toBe('\u2014');
    expect(main.cells[5]?.textContent).toBe('\u2014');
    expect(drogue.cells[3]?.textContent).not.toBe('\u2014');
    expect(drogue.cells[5]?.textContent).not.toBe('\u2014');
    expect(main.textContent).toContain('not measured');
    render(<SimRunDetails run={{ ...loadRuns()[0]!, deployments: [] }} />);
    act(() => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Show all details'))!.click(); });
    const scalar = [...host.querySelectorAll('tr')].find((tr) => tr.cells[0]?.textContent === 'Velocity at deployment')!;
    expect(scalar.cells[1]?.textContent).toContain('\u2014');
  });

  it('reports guide travel and physical rail beside exit speed, without changing the safety check', () => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { length: 'ft', velocity: 'm/s' } }));
    const r = run();
    r.railProfile = { segments: [[0, 20, 0, 2]], railM: 4, offsetM: 0.5, allowance: true, guideKind: 'buttons', thrustEnded: false };
    render(<SimRunDetails run={r} />);
    act(() => { [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Show all details'))!.click(); });
    const exit = [...host.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('Velocity at launch guide exit'))!;
    expect(exit.nextElementSibling?.textContent).toBe('Rail neededReaches 15.0 m/s after 4.9 ft of travel, measured from the bottom edge of the second rail button up from the tail on the line the rail runs through (the upper button on a two-button rocket) (6.6 ft of rail if the tail sits at the bottom of the rail). At the pad, measure the usable rail from that button edge to the end of the rail.');
    expect(r.safeLiftoffSpeed).toBe(true);
    render(<SimRunDetails run={{ ...r, launchGuideReason: 'lug', railProfile: { ...r.railProfile, guideKind: undefined } }} />);
    expect(host.textContent).toContain('measured from the bottom of the lowest launch lug');
    expect(host.textContent).not.toContain('re-launch to identify');
    render(<SimRunDetails run={{ ...r, railProfile: undefined }} />);
    expect(host.textContent).not.toContain('Rail needed');
  });
  it('shows an imported model and blend band without inventing a delay, execution time or safety pass', () => {
    const imported = importedSummaryRuns({ name: 'Imported', storedSimulations: [{ name: 'Hybrid', configId: null,
      windAverage: 12, data: { maxAltitude: 123, groundHitVelocity: 13, deploymentVelocity: 1, optimumDelay: 5, aeroModel: 'hybrid', rogersKbf: true, hybridBand: [0.7, 1.4] } }] })[0]!;
    render(<SimRunDetails run={imported} />);
    act(() => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show all details')!.click(); });
    expect(host.textContent).toContain('Hybrid (experimental)');
    expect(host.textContent).toContain('Mach 0.7–1.4');
    expect(host.textContent).toContain('unknown delay');
    expect(host.textContent).toContain('Unknown motor');
    const cell = (label: string) => [...host.querySelectorAll('tr')]
      .find((r) => r.querySelector('td')?.textContent === label)!.querySelectorAll('td')[1]!.textContent;
    expect(cell('Landing descent rate')).toMatch(/^—/);
    expect(cell('Ground-hit speed')).toMatch(/^13\.0/);
    expect(cell('Wind average')).toMatch(/^—/);
    expect(cell('Safe deployment')).toMatch(/^—/);
    expect(host.textContent).toContain('Flown at an unknown time');
    expect(host.textContent).toContain('This is a summary saved in the file.');
    expect(host.textContent).toContain('The original flight data series is not in it');
    expect(host.textContent).toContain('Pressing Launch re-flies the design on the current settings');
    expect(host.textContent).not.toContain('Re-fly this design to download its raw flight data');
    expect(host.textContent).not.toContain('NaN');
    for (const label of ['Winds aloft', 'Motors', 'Execution time', 'Motor diameter']) {
      const row = [...host.querySelectorAll('tr')].find((r) => r.querySelector('td')?.textContent === label)!;
      expect(row.querySelectorAll('td')[1]!.textContent).toBe('—');
    }
    render(<SimHistory runs={[imported]} onRunsChange={() => {}} />);
    openTable();
    const row = host.querySelector('tbody tr')!;
    expect(row.textContent).not.toContain('✓');
    expect(row.querySelectorAll('td')[2]!.textContent).toBe('—');
    expect(row.querySelectorAll('td')[7]!.textContent).toBe('—');
    expect(row.querySelectorAll('td')[8]!.textContent).toBe('—');
  });
  it('points down to the plots when this flight’s series are in memory', () => {
    render(<SimRunDetails run={run()} hasSeries />);
    expect(host.querySelector('.download-caption')?.textContent)
      .toBe('Raw per-timestep flight data downloads under Flight plots, below.');
  });

  it('says the true thing for a stored run with no series', () => {
    // The old behaviour was worse than silence: the two buttons simply
    // disappeared, leaving only the Saved-simulations XLSX — which produces
    // the run table, not flight data.
    render(<SimRunDetails run={run()} />);
    expect(host.querySelector('.download-caption')?.textContent)
      .toBe('Re-fly this design to download its raw flight data — time series aren’t saved with run history.');
  });

  it('never carries flight-data buttons of its own any more', () => {
    render(<SimRunDetails run={run()} hasSeries />);
    const labels = Array.from(host.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('Flight data'))).toBe(false);
    expect(labels.some((l) => l.includes('xlsx'))).toBe(false);
  });
});

describe('SimRunDetails — the Motors row (audit 2026-09-22, row 351)', () => {
  const motorsCell = () => Array.from(host.querySelectorAll('tr'))
    .find((tr) => tr.querySelector('.simdet-label')?.textContent === 'Motors')
    ?.querySelectorAll('td')[1]?.textContent;
  const showAll = () => {
    const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Show all details')!;
    act(() => { btn.click(); });
  };

  it('counts every motor firing together without calling it a cluster — three pods are not one', () => {
    // The stored count takes in pod sets and strap-on rings now, so a design
    // with one motor in each of three pods used to read "3 (cluster)".
    render(<SimRunDetails run={{ ...run(), motorCount: 3 }} />);
    showAll();
    expect(motorsCell()).toBe('3 firing together');
    render(<SimRunDetails run={{ ...run(), motorCount: 1 }} />);
    expect(motorsCell()).toBe('1');
  });
});

describe('SimRunDetails — the landing bearing (audit 2026-09-30)', () => {
  it('names 331° NW, where the weather dialog names the same bearing NNW, on purpose', () => {
    // Two compass helpers: a landing bearing is a direction to walk out to,
    // named to the nearest 45° (SimResults' compassPoint8), and a wind
    // direction is named to the nearest 22.5° (openMeteo's compassPoint), as
    // weather sources name it. Folding one into the other changes what a user
    // reads on one of the two screens, so it fails here first.
    render(<SimRunDetails run={{ ...run(), landingDistanceM: 120, landingBearingDeg: 331, windAvg: 0 }} />);
    const btn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Show all details')!;
    act(() => { btn.click(); });
    const bearing = Array.from(host.querySelectorAll('tr'))
      .find((tr) => tr.querySelector('.simdet-label')?.textContent === 'Landing bearing')
      ?.querySelectorAll('td')[1]?.textContent;
    expect(bearing).toBe('331° (NW)');
    expect(compassPoint(331)).toBe('NNW');
  });
});

describe('SimRunDetails — comment levels stay on their own comments (audit 2026-09-22)', () => {
  const lines = () => [...host.querySelectorAll('p.simdet-comments')]
    .map((p) => ({ text: p.textContent ?? '', red: p.classList.contains('stability-bad') }));

  it('colours each comment by its own level', () => {
    render(<SimRunDetails run={{
      ...run(),
      comments: 'Descent under Drogue / 36in is fast. | Flown delay 6s vs optimal 4.0s. | Static margin 0.40 cal — under-stable.',
      commentLevels: ['warning', 'info', 'warning'],
    }} />);
    expect(lines().filter((l) => l.red).map((l) => l.text)).toEqual([
      '⚠ Descent under Drogue / 36in is fast.', '⚠ Static margin 0.40 cal — under-stable.',
    ]);
  });

  it('a stored run whose device name split its comments renders plain, not shifted', () => {
    // Saved before the fix: the drogue's name carried the separator, so four
    // pieces for three levels. Indexed anyway, the delay line took the
    // under-stable warning's red and the warning itself went plain.
    render(<SimRunDetails run={{
      ...run(),
      comments: 'Descent under Drogue | 36in is fast. | Flown delay 6s vs optimal 4.0s. | Static margin 0.40 cal — under-stable.',
      commentLevels: ['warning', 'info', 'warning'],
    }} />);
    const got = lines().filter((l) => /Drogue|36in|Flown delay|Static margin/.test(l.text));
    expect(got).toHaveLength(4);
    expect(got.filter((l) => l.red)).toEqual([]);
  });
});

describe('SimRunDetails — the report carries its own provenance (v0.101)', () => {
  // This panel is what people screenshot and forward, and it used to show no
  // timestamp at all. Two investigations on 2026-09-03 turned on "is this
  // report stale?" — a question nothing on screen could answer.
  const whenOf = () => host.querySelector('.simdet-when')?.textContent ?? '';

  it('always says when the flight was flown, in prose', () => {
    const r = run();
    render(<SimRunDetails run={r} hasSeries />);
    // "Flown at 4:58 PM" — the preposition belongs to the sentence, and the
    // seconds do not: nobody tells two flights apart by the eleventh second.
    expect(whenOf()).toContain('Flown at ');
    expect(whenOf()).toContain(formatRunWhenProse(r.when).replace(/^at /, ''));
  });

  it('says so plainly when the run still matches the design', () => {
    render(<SimRunDetails run={run()} hasSeries changedSince={[]} />);
    expect(host.querySelector('.simdet-when')?.textContent).toContain('matches the design as it stands');
    expect(host.querySelector('.simdet-when-stale')).toBeNull();
  });

  it('NAMES what changed, and marks itself stale, when the design has moved on', () => {
    render(<SimRunDetails run={run()} changedSince={['the design', 'the motor']} />);
    const el = host.querySelector('.simdet-when');
    expect(el?.textContent).toContain('the design and the motor changed since');
    // Coloured only in the stale case — a current report must not nag.
    expect(el?.className).toContain('simdet-when-stale');
  });

  it('claims nothing when it cannot be told (a run stored before the keys existed)', () => {
    render(<SimRunDetails run={run()} hasSeries />);
    const text = host.querySelector('.simdet-when')?.textContent ?? '';
    expect(text).toContain('Flown');
    expect(text).not.toContain('changed since');
    expect(text).not.toContain('matches the design');
  });
});

/**
 * A deployment row as run history stored it BEFORE v0.099 (2026-09-03): no
 * `cd`, `cdNominal`, `diameter` or `spillHoleDiameter` key at all — they did
 * not exist yet — and, before v0.100, no `groundSpeed` either. `loadRuns`
 * revives rows as it finds them, so every tester run with a recovery device
 * stored from 2026-08-21 to 2026-09-03 reaches the report in this shape.
 */
const preV099Deployment = {
  device: 'Parachute', time: 7.0, altitude: 331.0, velocityAtDeployment: 4.2,
  descentRate: 3.4, isLanding: true, openingOk: true, descentOk: true,
} as unknown as DeploymentReport;

describe('SimRunDetails — a run stored before v0.099 (audit 2026-09-22)', () => {
  // `flownCd` guarded `d.cd === null`, and an ABSENT key is undefined, so
  // `d.cd.toFixed(2)` threw during render. With no error boundary above the
  // Results column, clicking such a run in Saved simulations unmounted the
  // whole app to "Something went wrong".
  const cdCells = () => Array.from(host.querySelectorAll('.motor-table tbody tr'))
    .map((tr) => tr.querySelectorAll('td')[4]?.textContent);

  it('renders the main flight’s deployment table, with a dash for the coefficient it never recorded', () => {
    const r: SimRun = { ...run(), deployments: [preV099Deployment] };
    render(<SimRunDetails run={r} />);
    expect(cdCells()).toEqual(['—']);
  });

  it('renders a booster branch’s deployment table the same way', () => {
    const r: SimRun = {
      ...run(),
      deployments: [],
      branches: [{
        name: 'Booster', apogee: 120, tumbles: false,
        deployments: [preV099Deployment], landingRate: 5, safeLandingRate: true,
      }],
    };
    render(<SimRunDetails run={r} />);
    expect(cdCells()).toEqual(['—']);
  });
});

describe('SimRunDetails — booster recovery weight', () => {
  it.each(['g', 'kg', 'oz', 'lb'])('shows each booster in the same %s format as the sustainer', (mass) => {
    localStorage.setItem('online-openrocket.prefs.v1', JSON.stringify({ units: { mass } }));
    const r = run();
    r.branches = [0.025, 0.060].map((recoveryMass, i) => ({
      name: `Booster ${i + 1}`, apogee: 120, tumbles: false,
      deployments: [preV099Deployment], landingRate: 5, safeLandingRate: true, recoveryMass,
    }));
    render(<SimRunDetails run={r} />);
    const rows = Array.from(host.querySelectorAll('p')).filter((p) => p.textContent?.includes('separate flight:'));
    for (const [i, b] of r.branches.entries()) {
      expect(rows[i]?.textContent).toContain(`recovery weight ${fmtSi('mass', mass, b.recoveryMass!)} `);
      expect(rows[i]?.querySelector<HTMLSelectElement>('select[aria-label="Mass unit"]')?.value).toBe(mass);
    }
    act(() => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Show all details')?.click());
    const sustainer = Array.from(host.querySelectorAll('tr')).find((tr) => tr.textContent?.includes('Recovery weight (after burnout)'));
    expect(sustainer?.textContent).toContain(fmtSi('mass', mass, r.burnoutMass!));
  });

  it.each([null, undefined])('omits unavailable or legacy booster recovery weight (%s)', (recoveryMass) => {
    const r = run();
    r.branches = [{
      name: 'Booster', apogee: 120, tumbles: true,
      deployments: [], landingRate: 30, safeLandingRate: false, recoveryMass,
    }];
    render(<SimRunDetails run={r} />);
    const row = Array.from(host.querySelectorAll('p')).find((p) => p.textContent?.includes('separate flight:'));
    expect(row?.textContent).toContain('no recovery device (tumbles)');
    expect(row?.textContent).not.toContain('recovery weight');
    expect(row?.textContent).not.toMatch(/NaN|undefined/);
  });

  it('keeps a booster recovery weight when the run is saved and loaded', () => {
    const r = run();
    r.branches = [{
      name: 'Booster', apogee: 120, tumbles: false,
      deployments: [preV099Deployment], landingRate: 5, safeLandingRate: true, recoveryMass: 0.025,
    }];
    addRuns([r]);
    expect(loadRuns()[0]?.branches?.[0]?.recoveryMass).toBeCloseTo(0.025, 9);
  });
});

describe('SimHistory — the run table names its data', () => {
  it.each([undefined, '5', null, {}, Infinity])('storage hardening: draws unavailable stored optimum delay (%j)', (optimumDelayS) => {
    localStorage.setItem('online-openrocket.sim-runs.v1', JSON.stringify([{ ...run(), optimumDelayS }, run()]));
    render(<SimHistory runs={loadRuns()} onRunsChange={() => {}} />);
    openTable();
    const table = host.querySelector('table')!;
    const index = [...table.querySelectorAll('thead th')].findIndex((th) => th.textContent?.includes('Opt. delay'));
    expect(index).toBeGreaterThanOrEqual(0);
    const rows = table.querySelectorAll('tbody tr');
    expect(rows[0]!.querySelectorAll('td')[index]?.textContent).toBe('—');
    expect(rows[1]!.querySelectorAll('td')[index]?.textContent).toBe('4.9s');
  });
  it('labels both exports as the run table, not as bare formats', () => {
    render(<SimHistory runs={[run()]} onRunsChange={() => {}} designName="Big Dog 4in" />);
    const labels = Array.from(host.querySelectorAll('button')).map((b) => b.textContent ?? '');
    expect(labels).toContain('⬇ Run table (.csv)');
    expect(labels).toContain('⬇ Run table (.xlsx)');
    expect(labels.some((l) => l.trim() === '⬇ CSV' || l.trim() === '⬇ XLSX')).toBe(false);
  });

  it('captions the group with what one row actually is', () => {
    render(<SimHistory runs={[run()]} onRunsChange={() => {}} designName="Big Dog 4in" />);
    expect(host.querySelector('.download-caption')?.textContent)
      .toBe('All saved runs — one row each, summary numbers only:');
  });

  it('stamps the design name into both filenames', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const saved: string[] = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      saved.push(this.download);
    };
    try {
      render(<SimHistory runs={[run()]} onRunsChange={() => {}} designName="Big Dog 4in" />);
      const byLabel = (t: string) => Array.from(host.querySelectorAll('button'))
        .find((b) => (b.textContent ?? '') === t) as HTMLButtonElement;
      act(() => { byLabel('⬇ Run table (.csv)').click(); });
      act(() => { byLabel('⬇ Run table (.xlsx)').click(); });
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
    expect(saved).toEqual(['Big_Dog_4in-run-table.csv', 'Big_Dog_4in-run-table.xlsx']);
  });

  it('offers Show charts only for a run the current design could reproduce', () => {
    const r = run();
    const shown: string[] = [];
    render(<SimHistory
      runs={[r]} onRunsChange={() => {}} designName="Big Dog 4in"
      canShowCharts={() => true}
      hasChartsFor={() => false}
      onShowCharts={(x) => shown.push(x.id)}
    />);
    openTable();
    const btn = Array.from(host.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('Charts')) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    act(() => { btn.click(); });
    expect(shown).toEqual([r.id]);
  });

  it('hides it once the series are in memory, and when the design has moved on', () => {
    const has = <SimHistory runs={[run()]} onRunsChange={() => {}}
      canShowCharts={() => true} hasChartsFor={() => true} onShowCharts={() => {}} />;
    render(has);
    openTable();
    expect(Array.from(host.querySelectorAll('button'))
      .some((b) => (b.textContent ?? '').includes('Charts'))).toBe(false);

    render(<SimHistory runs={[run()]} onRunsChange={() => {}}
      canShowCharts={() => false} hasChartsFor={() => false} onShowCharts={() => {}} />);
    openTable();
    expect(Array.from(host.querySelectorAll('button'))
      .some((b) => (b.textContent ?? '').includes('Charts'))).toBe(false);
  });

  /**
   * A Launch flies on the same engine handle a re-fly uses, and yields between
   * its auto-delay probes; a re-fly fired then handed the handle back on the
   * current model mid-Launch (audit 2026-09-30). The button stays — it would
   * come back the moment the flight lands — but does nothing until then.
   */
  it('waits while a flight is running: the Charts button is there, and does nothing', () => {
    const shown: string[] = [];
    render(<SimHistory runs={[run()]} onRunsChange={() => {}}
      canShowCharts={() => true} hasChartsFor={() => false} onShowCharts={(x) => shown.push(x.id)}
      flightRunning />);
    openTable();
    const btn = Array.from(host.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('Charts')) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    act(() => { btn.click(); });
    expect(shown).toEqual([]);
  });

  it('the Charts button does not also select the row it sits in', () => {
    // The row's own onClick opens the run; a click on the button must not
    // fire both.
    const selected: string[] = [];
    render(<SimHistory
      runs={[run()]} onRunsChange={() => {}}
      onSelect={(r) => selected.push(r.id)}
      canShowCharts={() => true} hasChartsFor={() => false} onShowCharts={() => {}}
    />);
    openTable();
    const btn = Array.from(host.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes('Charts')) as HTMLButtonElement;
    act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(selected).toEqual([]);
  });
});

describe('SimHistory — nothing is destroyed by one stray click (audit 2026-09-22)', () => {
  /** The table the way App wires it: simStore is the truth, the prop follows it. */
  function Wired() {
    const [runs, setRuns] = useState(() => loadRuns());
    return <SimHistory runs={runs} onRunsChange={setRuns} />;
  }
  const named = (id: string, rocket: string): SimRun => ({ ...run(), id, rocket });
  const buttons = () => Array.from(host.querySelectorAll('button'));
  const byText = (t: string) => buttons().find((b) => (b.textContent ?? '').includes(t)) as HTMLButtonElement;

  beforeEach(() => {
    // Newest first, as addRuns stores them.
    addRuns([named('a', 'Alpha'), named('b', 'Bravo'), named('c', 'Charlie')]);
  });

  it('"Clear all" asks first, naming the count, and Cancel keeps every run', () => {
    render(<Wired />);
    act(() => { byText('Clear all').click(); });
    expect(loadRuns()).toHaveLength(3);
    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Delete all 3 saved runs?');
    act(() => { byText('Cancel').click(); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(loadRuns().map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('and the confirmation is what deletes them', () => {
    render(<Wired />);
    act(() => { byText('Clear all').click(); });
    act(() => { byText('Delete all 3').click(); });
    expect(loadRuns()).toEqual([]);
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('a row\'s ✕ deletes at once and offers Undo, which puts it back where it was', () => {
    render(<Wired />);
    openTable();
    const del = host.querySelector('button[aria-label^="Delete run Bravo"]') as HTMLButtonElement;
    act(() => { del.click(); });
    expect(loadRuns().map((r) => r.id)).toEqual(['a', 'c']);
    const undo = byText('Undo');
    expect(undo).toBeTruthy();
    // Focus lands on it: the ✕ the keyboard was on has gone with its row.
    expect(document.activeElement).toBe(undo);
    expect(host.textContent).toContain('Deleted run Bravo');
    act(() => { undo.click(); });
    expect(loadRuns().map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(host.textContent).not.toContain('Deleted run');
  });

  it('Undo still works after the LAST run is deleted', () => {
    localStorage.clear();
    addRuns([named('only', 'Solo')]);
    render(<Wired />);
    openTable();
    act(() => { (host.querySelector('button[aria-label^="Delete run Solo"]') as HTMLButtonElement).click(); });
    expect(loadRuns()).toEqual([]);
    act(() => { byText('Undo').click(); });
    expect(loadRuns().map((r) => r.id)).toEqual(['only']);
  });
});

/**
 * DENSITY ALTITUDE (weather build, step 1): the launch report says what air
 * the run flew in, from the figure stored on the run at launch.
 */
describe('SimRunDetails — the density-altitude row', () => {
  const daRow = () => {
    // The Checks & motor table sits behind "Show all details".
    act(() => {
      Array.from(host.querySelectorAll('button'))
        .find((b) => (b.textContent ?? '') === 'Show all details')?.click();
    });
    return Array.from(host.querySelectorAll('tr'))
      .find((tr) => tr.querySelector('td')?.textContent === 'Density altitude');
  };

  it('shows the stored figure in the user’s distance unit, with a unit chip', () => {
    render(<SimRunDetails run={{ ...run(), densityAltitudeM: 2170.81 }} />);
    const row = daRow();
    expect(row, 'the Density altitude row').toBeTruthy();
    expect(row!.textContent).toMatch(/^Density altitude2171/);
    expect(row!.querySelector('select.unit-chip')).toBeTruthy();
  });

  it('is absent for a run flown before the field, and for a stored value that is not a number', () => {
    const old = run();
    delete (old as Partial<SimRun>).densityAltitudeM;
    render(<SimRunDetails run={old} />);
    expect(daRow()).toBeUndefined();
    // The details really are open: the neighbouring row is there.
    expect(Array.from(host.querySelectorAll('td')).some((td) => td.textContent === 'Wind average')).toBe(true);
    render(<SimRunDetails run={{ ...run(), densityAltitudeM: 'x' as unknown as number }} />);
    expect(daRow()).toBeUndefined();
  });
});


describe('K16 rendered opening tiers', () => {
  it.each([[65, ''], [75, 'stability-warn'], [95, 'stability-bad']] as const)(
    'styles the summary-only opening speed at %s ft/s', (fps, cls) => {
      const r = { ...run(), deployments: [], velocityAtDeployment: fps * 3048 / 10000 };
      render(<SimRunDetails run={r} />);
      act(() => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Show all details')?.click());
      const row = Array.from(host.querySelectorAll('tr')).find((tr) => tr.firstElementChild?.textContent === 'Velocity at deployment')!;
      expect(row.lastElementChild!.className).toBe(cls);
    });
  for (const booster of [false, true]) {
    it.each([
      [65, 'ok', 'stability-good', 'yes'], [70, 'ok', 'stability-good', 'yes'],
      [75, 'fast opening', 'stability-warn', 'CAUTION'], [85, 'fast opening', 'stability-warn', 'CAUTION'],
      [90, 'fast opening', 'stability-warn', 'CAUTION'], [95, 'hard opening', 'stability-bad', 'NO'],
    ])('shows %s ft/s on ' + (booster ? 'booster' : 'sustainer'), (fps, label, cls, safe) => {
      const d = { ...preV099Deployment, velocityAtDeployment: Number(fps) * 3048 / 10000, openingOk: false };
      const r = run();
      // Deliberately old boolean flags: rendering must re-grade the recorded speed.
      r.safeDeployment = false;
      if (booster) r.branches = [{ name: 'Booster', apogee: 120, tumbles: false,
        deployments: [d], landingRate: 5, safeLandingRate: true }];
      else r.deployments = [d];
      render(<SimRunDetails run={r} />);
      act(() => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Show all details')?.click());
      const rows = Array.from(host.querySelectorAll('.motor-table tbody tr'));
      const cells = rows.at(-1)!.querySelectorAll('td');
      expect(cells[7]!.textContent).toContain(String(label));
      expect(cells[7]!.className).toBe(cls);
      if (cls === 'stability-warn') {
        expect(cells[3]!.className).toBe('stability-warn');
        expect(cells[7]!.textContent).not.toContain('hard opening');
      }
      const safeRow = Array.from(host.querySelectorAll('tr')).find((row) => row.firstElementChild?.textContent === 'Safe deployment')!;
      expect(safeRow.textContent).toContain(String(safe));
      expect(safeRow.lastElementChild!.className).toBe(cls);
      render(<SimHistory runs={[r]} onRunsChange={() => {}} designName="K16" />);
      openTable();
      const summary = host.querySelector('tr.motor-row');
      expect(summary?.querySelector('td.stability-warn, td.stability-bad, td.stability-good')?.className).toBe(cls);
    });
  }
  it('keeps a landing failure red alongside an amber opening', () => {
    const r = run();
    r.deployments = [{ ...preV099Deployment, velocityAtDeployment: 75 * 0.3048, descentOk: false }];
    render(<SimRunDetails run={r} />);
    const cell = host.querySelector('.motor-table tbody tr')!.querySelectorAll('td')[7]!;
    expect(cell.textContent).toContain('fast opening');
    expect(cell.textContent).toContain('landing too fast');
    expect(cell.className).toBe('stability-bad');
  });
});

/**
 * A FLIGHT THE KERNEL STOPPED EARLY IS NEVER "SAFE" (audit 2026-09-30). The
 * Saved simulations Safe column read only the stored verdicts, so an aborted
 * run whose verdicts all passed — or were all blank, as for a rocket that never
 * left the pad — showed a green ✓, while the batch's own grade (gradeBatchRun)
 * refused the same run as "flight stopped early". Both now ask the one
 * predicate, simReport's runStoppedEarly.
 */
describe('SimHistory — a flight the kernel stopped early', () => {
  /** The batch's grade with no criteria set: only an abort can fail it. */
  const NO_CRITERIA: Criteria = {
    minRodExit: null, minThrustToWeight: null, minApogee: null, maxApogee: null,
    autoDelay: true, includeOOP: false, manufacturers: [], classes: [],
  };
  const flown = (result: FlightResult, id: string): SimRun => ({ ...buildSimRun({
    result, info,
    motor: { designation: 'C6', ejectionDelay: 5, diameter: 0.018, length: 0.07 } as never,
    meta: { label: 'C6-5' }, launch: DEFAULT_CONDITIONS, rocketName: 'Big Dog 4in', execMs: 100,
  }), id });
  const clean = flown({ ...fakeResult(), warnings: [] }, 'clean');
  // Stopped at T+1.14 s, with every stored verdict still passing.
  const passing = flown({
    ...fakeResult(), warnings: [],
    events: [...fakeResult().events, { type: 'SIM_ABORT', time: 1.14, cause: 'TUMBLE_UNDER_THRUST' }],
  } as FlightResult, 'aborted-passing');
  // Never left the pad: no verdict could be formed at all.
  const blank: SimRun = {
    ...flown({
      ...fakeResult(), warnings: [],
      events: [{ type: 'LAUNCH', time: 0 }, { type: 'SIM_ABORT', time: 2, cause: 'NO_LIFTOFF' }],
    } as FlightResult, 'aborted-blank'),
    rodExitVelocity: null, safeLiftoffSpeed: null, safeThrustToWeight: null, safeLandingRate: null,
    safeDeployment: null, deployments: [], velocityAtDeployment: null, launchStaticMarginCal: null,
  };
  const safeCells = () => Array.from(host.querySelectorAll('tr.motor-row')).map((tr) =>
    tr.querySelector('td.stability-warn, td.stability-bad, td.stability-good')!.textContent);

  it('marks an aborted run ⚠, whatever its verdicts say', () => {
    render(<SimHistory runs={[clean, passing, blank]} onRunsChange={() => {}} />);
    openTable();
    expect(safeCells()).toEqual(['✓', '⚠', '⚠']);
  });

  it('agrees with the batch grade on every run, an aborted one included', () => {
    const runs = [clean, passing, blank];
    render(<SimHistory runs={runs} onRunsChange={() => {}} />);
    openTable();
    const cells = safeCells();
    runs.forEach((r, i) => {
      const batchStopped = gradeBatchRun(r, NO_CRITERIA).includes('flight stopped early');
      expect(batchStopped, r.id).toBe(runStoppedEarly(r));
      // Nothing else is wrong with these runs, so the two verdicts coincide.
      expect(cells[i], r.id).toBe(batchStopped ? '⚠' : '✓');
      expect(gradeBatchRun(r, NO_CRITERIA), r.id).toEqual(batchStopped ? ['flight stopped early'] : []);
    });
  });
});

it('names winds aloft in the report and the saved-run table', () => {
  const flown = { ...run(), windLevels: [{ altitude: 10, speed: 4, direction: 0 }, { altitude: 500, speed: 10, direction: 0.2 }] };
  render(<SimRunDetails run={flown} />);
  act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show all details')!.click());
  expect(host.textContent).toContain('Winds aloft2 levels to 1,640 ft');
  render(<SimHistory runs={[flown]} onRunsChange={() => {}} />);
  openTable();
  expect([...host.querySelectorAll('th')].some((th) => th.textContent === 'Winds aloft')).toBe(true);
  expect(host.querySelector('tbody')!.textContent).toContain('2 levels');
});

it.each(['none', 'lug', 'buttons', 'single-button', 'mixed-lug', 'mixed-buttons', 'off'] as const)('renders flown guided length and %s reason with unit controls', (reason) => {
  const r = { ...run(), guidedLengthM: 0.5, enteredRodLengthM: 1.5, launchGuideReason: reason };
  act(() => root.render(<PrefsProvider><SimRunDetails run={r} /></PrefsProvider>));
  const expand = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Show all details'))!;
  act(() => expand.click());
  const row = [...host.querySelectorAll('tr')].find(tr => tr.textContent?.includes('Guided length'))!;
  expect(row).toBeDefined();
  expect(row.textContent).toContain(' of ');
  expect(row.querySelectorAll('select.unit-chip').length).toBe(2);
  const unit = row.querySelector<HTMLSelectElement>('select.unit-chip')!.value;
  expect(row.children[1]!.textContent?.trim().startsWith(fmtSi('length', unit, r.guidedLengthM) + ' ')).toBe(true);
  expect(row.textContent).toContain(' of ' + fmtSi('length', unit, r.enteredRodLengthM));
  const phrase = { none: 'as for a tower', lug: 'last launch lug', buttons: 'second-to-last rail-button station',
    'mixed-lug': 'shorter guidance: the last lug', 'mixed-buttons': 'shorter guidance: the second-to-last',
      'single-button': 'as it lifts off', off: 'switched off' };
  expect(row.textContent).toContain(phrase[reason]);
});

it('Amendment 1 renders the ignored-button note saved with a lug report', () => {
  const r = { ...run(), guidedLengthM: 0.5, enteredRodLengthM: 1.5,
    launchGuideReason: 'lug' as const, launchGuideIgnoredButtons: true };
  act(() => root.render(<PrefsProvider><SimRunDetails run={r} /></PrefsProvider>));
  const expand = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Show all details'))!;
  act(() => expand.click());
  expect(host.textContent).toContain('Rail buttons without two stations on one line were not counted.');
});


describe('S3a-3 booster recovery in history safety', () => {
  it.each(['landing', 'descent', 'safe'] as const)('includes booster %s verdict', (kind) => {
    const r = run();
    r.branches = [{ name: 'Booster', apogee: 120, tumbles: kind === 'landing',
      landingRate: kind === 'landing' ? 30 : 5, safeLandingRate: kind !== 'landing',
      deployments: kind === 'landing' ? [] : [{ ...preV099Deployment, velocityAtDeployment: 5, descentOk: kind !== 'descent' }],
    }];
    render(<SimHistory runs={[r]} onRunsChange={() => {}} designName="Booster" />);
    openTable();
    expect(host.querySelector('tr.motor-row td.stability-bad, tr.motor-row td.stability-good')?.className)
      .toBe(kind === 'safe' ? 'stability-good' : 'stability-bad');
  });
});

it.each(['opening', 'descent'] as const)('S3a-4: marks an unknown %s check as not measured', (missing) => {
  const r = run();
  r.deployments = [{ ...preV099Deployment, groundSpeed: null,
    velocityAtDeployment: missing === 'opening' ? null : 4.2,
    descentRate: missing === 'descent' ? null : 3.4,
    descentOk: missing === 'descent' ? null : true }];
  render(<SimRunDetails run={r} />);
  act(() => { [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show all details')!.click(); });
  const row = [...host.querySelectorAll('tr')].find((tr) => tr.firstElementChild?.textContent === 'Parachute (landing)')!;
  expect(row.lastElementChild?.textContent).toBe('— not measured');
  expect(row.lastElementChild?.className).not.toContain('stability-good');
});

// A saved report must react immediately to a preference change, without re-flying.
it('reformats saved warning quantities when the current units change', () => {
  const saved = run();
  saved.simWarnings = [{ key: 'HighSpeedDeployment', message: 'old speed',
    quantity: { kind: 'velocity', value: 30.48 }, sources: [{ id: 'chute', name: 'Main' }] }];
  addRuns([saved]);
  const restored = loadRuns()[0]!;
  function SwitchUnits() {
    const { prefs, setPrefs } = usePrefs();
    return <button onClick={() => setPrefs({ ...prefs, units: { ...prefs.units, velocity: 'ft/s' } })}>Switch warning units</button>;
  }
  render(<><SwitchUnits /><SimRunDetails run={restored} /></>);
  expect(host.textContent).toContain('(30.48 m/s): "Main"');
  act(() => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Switch warning units')!.click());
  expect(host.textContent).toContain('(100 ft/s): "Main"');
  expect(host.textContent).not.toContain('(30.48 m/s): "Main"');
});
