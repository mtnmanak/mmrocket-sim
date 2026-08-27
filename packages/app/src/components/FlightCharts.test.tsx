// @vitest-environment happy-dom
import { act } from 'react';
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

const mount = (onFullSeries?: () => Promise<FlightResult>) => act(() => root.render(
  <PrefsProvider>
    <FlightCharts result={fakeResult()} onFullSeries={onFullSeries} designName="Big Dog 4in" />
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
});
