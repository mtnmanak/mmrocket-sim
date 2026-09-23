// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DragSweep, OrkRocket, StaticInfo } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { DragPanel } from './DragPanel.js';

/**
 * THE CP-vs-MACH CHART AND THE CSV cp COLUMN (audit 2026-09-22).
 *
 * `dragSweep` measures CP in ONE roll plane. Where that plane makes no lift the
 * kernel reports cp = 0, and the chart drew it as a CP at the nose tip (a flat
 * 0 % for a tube with two fins, measured on the real kernel at all 60 sweep
 * points). And on a design whose CP depends on roll angle the curve is not the
 * CP the rest of the app flies on: two fins clocked 90 degrees charted 81.4 %
 * of length while the app showed 8.7 %.
 *
 * uPlot is replaced by a recorder so the SERIES DATA handed to the chart can be
 * read back — the pixels are not the point.
 */
const plots: { series: { label?: string }[]; data: (number | null)[][] }[] = [];
vi.mock('uplot', () => ({
  default: class RecordingPlot {
    constructor(opts: { series: { label?: string }[] }, data: (number | null)[][]) {
      plots.push({ series: opts.series, data });
    }
    setSize() {}
    destroy() {}
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const machs = [0.5, 1, 1.5, 2];
const flat = (v: number) => machs.map(() => v);

function sweepOf(cp: number[], cna: number[]): DragSweep {
  return {
    machs, hasNozzle: false, cp, cna,
    powerOff: { total: flat(0.4), friction: flat(0.1), pressure: flat(0.2), base: flat(0.1) },
    powerOn: { total: flat(0.35), friction: flat(0.1), pressure: flat(0.2), base: flat(0.05) },
    components: [{ name: 'Nose cone', cd: flat(0.1) }],
  } as DragSweep;
}

const rocketOf = (sweep: DragSweep, info: Partial<StaticInfo>): OrkRocket =>
  ({ dragSweep: () => sweep, staticInfo: () => info } as unknown as OrkRocket);

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  plots.length = 0;
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

const open = (rocket: OrkRocket) => {
  act(() => root.render(<PrefsProvider><DragPanel rocket={rocket} designName="T" /></PrefsProvider>));
  act(() => { (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click(); });
};
/** The data the CP chart was last drawn with, or null when no CP chart was drawn. */
const cpSeries = (): (number | null)[] | null => {
  const p = [...plots].reverse().find((x) => x.series.some((s) => s.label === 'CP'));
  return p ? p.data[1]! : null;
};
const texts = () => [...host.querySelectorAll('p')].map((p) => p.textContent ?? '');
const csvOf = async (): Promise<string> => {
  const blobs: Blob[] = [];
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
    blobs.push(b as Blob);
    return 'blob:cp-test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click() {};
  try {
    const btn = [...host.querySelectorAll('button')]
      .find((b) => (b.textContent ?? '').includes('Drag table (.csv)'))!;
    act(() => { btn.click(); });
  } finally {
    HTMLAnchorElement.prototype.click = origClick;
  }
  return blobs[0]!.text();
};
/** The CSV's cp column, as text cells. */
const cpColumn = (csv: string): string[] => {
  const lines = csv.split('\n');
  const head = lines.findIndex((l) => l.startsWith('mach,'));
  const col = lines[head]!.split(',').indexOf('cp_mm_from_nose');
  return lines.slice(head + 1).map((l) => l.split(',')[col]!);
};

describe('CP vs Mach — no lift is a gap, not a CP at the nose tip', () => {
  it('drops the points where the sweep plane makes no lift, in the chart and the CSV', async () => {
    open(rocketOf(sweepOf([0, 0, 0.6, 0.6], [0, 0, 12, 12]), { length: 1.2, cp: 0.6, cpWorst: 0.6 }));
    const s = cpSeries()!;
    expect(s.slice(0, 2)).toEqual([null, null]);
    expect(s[2]).toBeCloseTo(50, 9);
    const csv = await csvOf();
    expect(cpColumn(csv)).toEqual(['', '', '600', '600']);
    // cna itself is a real number, 0 included.
    expect(csv).toContain('\n0.5,0.4,0.35,,0,');
  });

  it('with no lift anywhere, says so instead of drawing a flat 0 %', () => {
    // A bare tube: no normal force at any roll angle either (measured on the
    // real kernel: cna 0 and cnaWorst 0).
    open(rocketOf(sweepOf(flat(0), flat(0)), { length: 0.3, cp: 0, cna: 0, cpWorst: 0, cnaWorst: 0 }));
    expect(cpSeries()).toBeNull();
    expect(texts().some((t) => t.startsWith('No lift yet — this design makes no aerodynamic normal'))).toBe(true);
  });

  it('with no figures to scale by, draws no CP panel at all — so says nothing about lift', () => {
    // staticInfo() throwing, or a zero length, leaves the chart nothing to
    // plot against. The panel (heading, toggle and every sentence under it) is
    // not rendered then, so "No lift yet" cannot be claimed for a design whose
    // sweep has lift.
    const lifting = sweepOf(flat(0.6), flat(12));
    const throwing = { dragSweep: () => lifting, staticInfo: () => { throw new Error('no'); } } as unknown as OrkRocket;
    for (const rocket of [throwing, rocketOf(lifting, { length: 0, cp: 0.6, cna: 12, cpWorst: 0.6, cnaWorst: 12 })]) {
      plots.length = 0;
      open(rocket);
      expect(cpSeries()).toBeNull();
      expect(host.textContent).not.toContain('Center of pressure vs Mach');
      expect(host.textContent).not.toContain('No lift yet');
      act(() => root.unmount());
      root = createRoot(host);
    }
  });

  it('chooses "No lift yet" by the force itself, not by whether the CP moves with roll', () => {
    // No lift in the sweep's plane, but lift elsewhere with cp == cpWorst (a
    // kernel that gives no swept CP): not "no lift".
    open(rocketOf(sweepOf(flat(0), flat(0)), { length: 0.3, cp: 0, cna: 0, cnaWorst: 0.809 }));
    expect(texts().some((t) => t.startsWith('No CP to plot in this roll plane'))).toBe(true);
    expect(texts().some((t) => t.includes('No lift yet'))).toBe(false);
  });

  it('a symmetric design keeps its four-line header and carries no roll note', async () => {
    open(rocketOf(sweepOf(flat(0.6), flat(12)), { length: 1.2, cp: 0.6, cpWorst: 0.6 }));
    expect(texts().some((t) => t.includes('depends on its roll angle'))).toBe(false);
    const csv = await csvOf();
    expect(csv.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(4);
  });
});

describe('CP vs Mach — a roll-dependent design says which plane it is', () => {
  // Measured on the real kernel: a 70 mm ogive, a 300 mm x 24 mm tube and two
  // fins clocked 90 degrees. The theta = 0 plane holds the fins (cp 301.611 mm);
  // the forward-most CP over all roll angles is the nose's, 32.356 mm.
  const info = { length: 0.37, cp: 0.301611, cpWorst: 0.032356 };

  it('captions the chart with the CP the app flies on', () => {
    open(rocketOf(sweepOf(flat(0.3016), flat(16.27)), info));
    expect(cpSeries()![0]).toBeCloseTo(81.5, 1);
    const note = texts().find((t) => t.includes('depends on its roll angle'))!;
    expect(note).toContain('and this chart is one roll plane, with the fins as drawn.');
    expect(note).toContain('forward-most CP over every roll angle, 8.7 % of length — the conservative figure.');
  });

  it('with no lift in the swept plane, says it is the PLANE that has none', () => {
    // Tube + two fins, no nose: nothing in the theta = 0 plane, lift in others
    // (on the real kernel such a design reads cna 0 with a nonzero cnaWorst).
    open(rocketOf(sweepOf(flat(0), flat(0)), { length: 0.3, cp: 0, cna: 0, cpWorst: 0.269348, cnaWorst: 0.809 }));
    expect(cpSeries()).toBeNull();
    expect(texts().some((t) => t.startsWith('No CP to plot in this roll plane'))).toBe(true);
    // No chart is drawn, so the roll note must not point at one.
    const note = texts().find((t) => t.includes('depends on its roll angle'))!;
    expect(note).not.toContain('this chart');
    expect(note).toContain('and the CP-vs-Mach sweep is measured in one roll plane, with the fins as drawn.');
    expect(note).toContain('89.8 % of length');
  });

  it('adds ONE comment line to the CSV naming the plane and the CP to fly on', async () => {
    open(rocketOf(sweepOf(flat(0.3016), flat(16.27)), info));
    const csv = await csvOf();
    const comments = csv.split('\n').filter((l) => l.startsWith('#'));
    expect(comments).toHaveLength(5);
    expect(comments[4]).toBe('# cp: one roll plane (theta = 0 with the fins as drawn) - this design\'s CP '
      + 'depends on roll angle; the app\'s stability margin uses the forward-most CP over all roll angles: '
      + '32.356 mm from nose');
    // Still comma-free and ASCII, like the rest of the block.
    expect(comments[4]).toMatch(/^[\x20-\x7e]*$/);
    expect(comments[4]).not.toContain(',');
  });
});
