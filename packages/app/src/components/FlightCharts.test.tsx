// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlightResult } from '@online-openrocket/engine';
import { FlightCharts } from './FlightCharts.js';
import { PrefsProvider } from '../prefs/PrefsContext.js';

/**
 * The raw flight-data downloads live beside the plots they produce.
 *
 * They used to sit in the launch report's header, and a THIRD button sat above
 * the charts writing a 12-column subset under the name `flight-data.csv` —
 * so the file that sounded canonical was the poorest export on the page, and
 * the two good ones vanished exactly when a user went looking for them (they
 * were gated on an in-memory result that selecting a saved run destroyed).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// happy-dom has no canvas, and uPlot draws into one on a rAF tick — an
// unhandled "Cannot read properties of null (reading 'clearRect')" that fails
// the file long after the assertions passed. Same no-op 2D context
// DragPanel.test.tsx uses: these tests are about labels and filenames, never
// about pixels.
const ctx2d = new Proxy({}, {
  get: (_t, prop) => (prop === 'measureText' ? () => ({ width: 0 }) : () => undefined),
});
HTMLCanvasElement.prototype.getContext = (() => ctx2d) as unknown as HTMLCanvasElement['getContext'];
class NoPath { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} }
(globalThis as unknown as { Path2D: unknown }).Path2D ??= NoPath;

let host: HTMLDivElement;
let root: Root;

/** A minimal flight with two populated series, enough for one panel. */
function fakeResult(): FlightResult {
  const time = [0, 0.5, 1];
  return {
    summary: {
      maxAltitude: 100, maxVelocity: 40, maxAcceleration: 90, maxMachNumber: 0.12,
      timeToApogee: 1, flightTime: 3, groundHitVelocity: 4, launchRodVelocity: 15,
      deploymentVelocity: 4, optimumDelay: 1,
    },
    series: { time, altitude: [0, 30, 100], velocity: [0, 35, 40] },
    events: [],
  } as unknown as FlightResult;
}

const mount = (onFullSeries?: () => Promise<FlightResult>, staleReason?: string | null) => act(() => root.render(
  <PrefsProvider>
    <FlightCharts flightName="Big Dog 4in · C6 (Estes)" result={fakeResult()} onFullSeries={onFullSeries} designName="Big Dog 4in"
      staleReason={staleReason} />
  </PrefsProvider>,
));

const buttons = () => Array.from(host.querySelectorAll('button'));
const labelled = (text: string) =>
  buttons().find((b) => (b.textContent ?? '').includes(text)) as HTMLButtonElement | undefined;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('FlightCharts — the Flight plots block', () => {
  it('has a heading, so the block is named rather than floating', () => {
    mount(() => Promise.resolve(fakeResult()));
    expect(host.querySelector('h2')?.textContent).toBe('Flight plots');
    expect(host.querySelector('.flight-identity')?.textContent).toBe('Big Dog 4in · C6 (Estes)');
  });

  it('captions the pair with what the files actually contain', () => {
    mount(() => Promise.resolve(fakeResult()));
    expect(host.querySelector('.download-caption')?.textContent)
      .toBe('Download this flight, every timestep:');
  });

  it('names its data, with the format as the parenthetical', () => {
    mount(() => Promise.resolve(fakeResult()));
    expect(labelled('⬇ Flight data (.csv)')).toBeTruthy();
    expect(labelled('⬇ Flight data + charts (.xlsx)')).toBeTruthy();
  });

  it('the 12-column subset button is gone — it was a lossless subset of the CSV', () => {
    mount(() => Promise.resolve(fakeResult()));
    // The old chip-bar button was labelled exactly "⬇ CSV".
    expect(buttons().some((b) => (b.textContent ?? '').trim() === '⬇ CSV')).toBe(false);
  });

  it('offers no downloads at all when nothing here can produce them', () => {
    mount(undefined);
    expect(labelled('⬇ Flight data (.csv)')).toBeUndefined();
    expect(host.querySelector('.download-caption')).toBeNull();
    // The plots themselves still render.
    expect(host.querySelector('h2')?.textContent).toBe('Flight plots');
    expect(host.querySelector('.flight-identity')?.textContent).toBe('Big Dog 4in · C6 (Estes)');
  });

  it('stamps the design name into both filenames', async () => {
    const full = vi.fn(() => Promise.resolve(fakeResult()));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const saved: string[] = [];
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      saved.push(this.download);
    };
    try {
      mount(full);
      await act(async () => { labelled('⬇ Flight data (.csv)')!.click(); });
      await act(async () => { labelled('⬇ Flight data + charts (.xlsx)')!.click(); });
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
    expect(full).toHaveBeenCalledTimes(2);
    // A bare `flight-data.csv` says nothing about which rocket produced it,
    // and the old pair collided by base name with the deleted subset export.
    expect(saved).toEqual(['Big_Dog_4in-flight-data.csv', 'Big_Dog_4in-flight-data.xlsx']);
  });

  it('re-flying is stated, and a failure is shown rather than swallowed', async () => {
    const full = vi.fn(() => Promise.reject(new Error('kernel said no')));
    mount(full);
    await act(async () => { labelled('⬇ Flight data (.csv)')!.click(); });
    expect(host.textContent).toContain('Flight-data export failed: kernel said no');
  });

  /**
   * These two files are produced by RE-FLYING the design as it stands, so
   * while something has changed under the shown flight the file they write
   * describes a different rocket from the plots above them — with the plots'
   * own design name on it. The 📈 Charts button already refused in that
   * state; these did not (his 18 Sep item 43, shipped 2026-09-21).
   *
   * The reachable route is the MEASURED AIRFRAME MASS: it changes the
   * hardware the weighed pad mass implies without touching the design, and it
   * is not in the dependency list of the effect that clears the flight.
   * Editing the design, the motors, the launch conditions — or the pad mass
   * itself — clears the flight outright, so there is no button left to press.
   */
  describe('the downloads refuse while the shown flight is stale', () => {
    it('disables both, and says why in text rather than only in a tooltip', () => {
      mount(vi.fn(), 'the weighed pad mass');
      expect(labelled('⬇ Flight data (.csv)')!.disabled).toBe(true);
      expect(labelled('⬇ Flight data + charts (.xlsx)')!.disabled).toBe(true);
      // A browser shows no tooltip on a disabled button, so the reason has to
      // be on the page.
      expect(host.textContent)
        .toContain('Not available — the weighed pad mass changed since this flight');
      expect(host.textContent).toContain('Press Launch to fly the current design');
    });

    it('points the buttons at that explanation for a screen reader', () => {
      mount(vi.fn(), 'the weighed pad mass');
      const csv = labelled('⬇ Flight data (.csv)')!;
      expect(csv.getAttribute('aria-describedby')).toBe('flight-data-stale');
      expect(host.querySelector('#flight-data-stale')!.getAttribute('role')).toBe('status');
    });

    it('leaves them alone, and the caption unchanged, when nothing has changed', () => {
      mount(vi.fn(), null);
      expect(labelled('⬇ Flight data (.csv)')!.disabled).toBe(false);
      expect(host.textContent).toContain('Download this flight, every timestep');
      expect(host.querySelector('#flight-data-stale')!.getAttribute('role')).toBe('status');
      expect(labelled('⬇ Flight data (.csv)')!.getAttribute('aria-describedby')).toBeNull();
    });

    it('does not fire the re-fly when a disabled button is clicked', () => {
      const full = vi.fn(() => Promise.resolve(fakeResult()));
      mount(full, 'the weighed pad mass');
      labelled('⬇ Flight data (.csv)')!.click();
      expect(full).not.toHaveBeenCalled();
    });
  });

  /**
   * A LAUNCH FLIES ON THE SAME ENGINE (audit 2026-09-30). The downloads re-fly
   * the shown flight on the design's handle, and a Launch on auto delay yields
   * between its probes: a re-fly fired then handed the handle back on the
   * current model, and the rest of the Launch flew Classic under an
   * auto-supersonic stamp. So while one runs they wait, and say why.
   */
  describe('the downloads wait while a flight is running', () => {
    const running = (full: () => Promise<FlightResult>, staleReason: string | null = null) => act(() => root.render(
      <PrefsProvider>
        <FlightCharts flightName="Big Dog 4in · C6 (Estes)" result={fakeResult()} onFullSeries={full} designName="Big Dog 4in"
          staleReason={staleReason} flightRunning />
      </PrefsProvider>,
    ));

    it('disables both, says why in text, and a click fires no re-fly', () => {
      const full = vi.fn(() => Promise.resolve(fakeResult()));
      running(full);
      expect(labelled('⬇ Flight data (.csv)')!.disabled).toBe(true);
      expect(labelled('⬇ Flight data + charts (.xlsx)')!.disabled).toBe(true);
      expect(host.querySelector('#flight-data-stale')?.textContent).toBe('Not available while a flight is running.');
      expect(labelled('⬇ Flight data (.csv)')!.getAttribute('aria-describedby')).toBe('flight-data-stale');
      labelled('⬇ Flight data (.csv)')!.click();
      expect(full).not.toHaveBeenCalled();
    });

    it('a stale flight still says it is stale: that outlasts the flight', () => {
      running(vi.fn(), 'the weighed pad mass');
      expect(host.textContent).toContain('Not available — the weighed pad mass changed since this flight');
    });
  });
});

/**
 * Audit 2026-09-22, row 463: each plot was a bare canvas — a screen reader got
 * the heading and the legend's series name, never the curve, and nothing said
 * the CSV beside it holds the same data.
 */
describe('FlightCharts — each chart is named, in words', () => {
  const canvases = () => [...host.querySelectorAll('canvas')].filter((c) => c.getAttribute('role') === 'img');

  it('names every plotted curve with its shape and points at the CSV', () => {
    mount(() => Promise.resolve(fakeResult()));
    const named = canvases().map((c) => c.getAttribute('aria-label') ?? '');
    const altitude = named.find((n) => n.startsWith('Altitude'));
    expect(altitude, named.join(' | ')).toBeDefined();
    expect(altitude).toMatch(/^Altitude \(\w+\) over time — Big Dog 4in · C6 \(Estes\), 0 s to 1 s\./);
    expect(altitude).toContain('The Flight data (.csv) download above holds every timestep.');
    expect(named.some((n) => n.startsWith('Velocity'))).toBe(true);
  });

  it('does not point at a download that is not offered', () => {
    mount(undefined);
    const named = canvases().map((c) => c.getAttribute('aria-label') ?? '');
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(n).not.toContain('.csv');
  });
});

describe('FlightCharts — a refused download is not promised', () => {
  it('drops the CSV sentence while the design has moved under the flight', () => {
    // One result and one callback, so only the stale reason changes between renders.
    const result = fakeResult();
    const full = () => Promise.resolve(result);
    const show = (staleReason: string | null) => act(() => root.render(
      <PrefsProvider>
        <FlightCharts flightName="Big Dog 4in · C6 (Estes)" result={result} onFullSeries={full} designName="Big Dog 4in" staleReason={staleReason} />
      </PrefsProvider>,
    ));
    show('the weighed pad mass');
    const named = [...host.querySelectorAll('canvas[role="img"]')].map((c) => c.getAttribute('aria-label') ?? '');
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(n).not.toContain('.csv');
    // And back, on the same canvases — re-worded, not rebuilt.
    const before = host.querySelector('canvas[role="img"]');
    show(null);
    expect(host.querySelector('canvas[role="img"]')?.getAttribute('aria-label')).toContain('Flight data (.csv)');
    expect(host.querySelector('canvas[role="img"]')).toBe(before);
  });
});

it('constructs all comparisons with real uPlot options (canvas calls stubbed)', async () => {
  const flight = fakeResult();
  flight.series.acceleration = [1, 2, 3];
  flight.series['Vz'] = [0, 20, -4];
  flight.series.stability = [2, 2, 2];
  flight.series.cpLocation = [1, 1, 1];
  flight.series.cgLocation = [0.8, 0.8, 0.8];
  flight.series.altitude = [0, 100, 30];
  await act(async () => { root.render(<PrefsProvider><FlightCharts flightName="Big Dog 4in · C6 (Estes)" result={flight} /></PrefsProvider>); });
  const chooser = host.querySelector('.comparison-controls select') as HTMLSelectElement;
  for (const option of [...chooser.options].slice(1)) {
    await act(async () => {
      chooser.value = option.value; chooser.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const panel = host.querySelector('.comparison-panel')!;
    expect(panel.querySelector('canvas[role="img"]')?.getAttribute('aria-label')).toContain(option.textContent);
    expect(panel.querySelectorAll('.u-series').length).toBeGreaterThanOrEqual(3);
  }
});

it.each([false, true])('S3b-3: StrictMode clears export busy after rejection=%s', async (reject) => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:strict');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const full = vi.fn(() => reject ? Promise.reject(new Error('export failed')) : Promise.resolve(fakeResult()));
  await act(async () => root.render(<StrictMode><PrefsProvider>
    <FlightCharts flightName="Big Dog 4in · C6 (Estes)" result={fakeResult()} onFullSeries={full} designName="Strict bird" />
  </PrefsProvider></StrictMode>));
  const csv = labelled('Flight data (.csv)')!;
  await act(async () => { csv.click(); });
  expect(full).toHaveBeenCalledOnce();
  expect(csv.disabled).toBe(false);
  if (reject) expect(host.textContent).toContain('export failed');
});
