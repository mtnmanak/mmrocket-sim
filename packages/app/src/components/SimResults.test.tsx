// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimHistory, SimRunDetails } from './SimResults.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { buildSimRun, type SimRun, formatRunWhenProse,
} from '../services/simReport.js';
import { DEFAULT_CONDITIONS } from './LaunchPanel.js';
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

describe('SimRunDetails — the report carries its own provenance (v0.101)', () => {
  // This panel is what people screenshot and forward, and it used to show no
  // timestamp at all. Two investigations on 2026-09-03 turned on "is this
  // report stale?" — a question nothing on screen could answer.
  const whenOf = (r: SimRun) => host.querySelector('.simdet-when')?.textContent ?? '';

  it('always says when the flight was flown, in prose', () => {
    const r = run();
    render(<SimRunDetails run={r} hasSeries />);
    // "Flown at 4:58 PM" — the preposition belongs to the sentence, and the
    // seconds do not: nobody tells two flights apart by the eleventh second.
    expect(whenOf(r)).toContain('Flown at ');
    expect(whenOf(r)).toContain(formatRunWhenProse(r.when).replace(/^at /, ''));
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

describe('SimHistory — the run table names its data', () => {
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
