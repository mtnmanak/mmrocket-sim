// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DragSweep, OrkRocket, StaticInfo } from '@online-openrocket/engine';
import { PrefsProvider } from '../prefs/PrefsContext.js';
import { DragPanel } from './DragPanel.js';
import { APP_VERSION } from '../version.js';

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

function sweepOf(cp: (number | null)[], cna: number[]): DragSweep {
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

/**
 * THE WHOLE FILE, BYTE FOR BYTE — pinned before the table's builder left the
 * panel for services/ (audit 2026-09-22, extractions carried from 8 September:
 * "every other exporter in the app lives in src/services/"). Every column,
 * every header line, the gaps, the name folding, the file name.
 */
describe('the Drag table (.csv), byte for byte', () => {
  it('writes the file it wrote before the move', async () => {
    const sweep = {
      machs: [0.5, 1, 2.5],
      hasNozzle: true,
      cp: [0, 0.3016, 0.29],
      cna: [0, 16.27, 15.5],
      powerOff: { total: [0.45, 0.61, 0.52], friction: [0.2, 0.18, 0.12], pressure: [0.15, 0.33, 0.3], base: [0.1, 0.1, 0.1] },
      powerOn: { total: [0.4, 0.55, 0.47], friction: [0.2, 0.18, 0.12], pressure: [0.15, 0.33, 0.3], base: [0.05, 0.04, 0.05] },
      components: [
        { name: 'Nose cone', cd: [0.1, 0.2, 0.15] },
        { name: 'Fin set, “3 fins”\nrev B', cd: [0.12, 0.2, 0.19] },
      ],
    } as DragSweep;
    const info = { length: 0.37, cp: 0.301611, cpWorst: 0.032356, cna: 16.27 } as StaticInfo;
    act(() => root.render(
      <PrefsProvider>
        <DragPanel rocket={rocketOf(sweep, info)} designName={'Big “Bertha”\nMk 2, rev B'}
          fileMachAlt={[[0, 0], [0.9, 7620], [5, 19202.4]]} />
      </PrefsProvider>,
    ));
    act(() => { (host.querySelector('button[aria-expanded]') as HTMLButtonElement).click(); });
    const cond = host.querySelector('select[aria-label="Sweep conditions"]') as HTMLSelectElement;
    act(() => { cond.value = 'file'; cond.dispatchEvent(new Event('change', { bubbles: true })); });
    let saved = '';
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:x'; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { saved = this.download; };
    try {
      const btn = [...host.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Drag table (.csv)'))!;
      act(() => { btn.click(); });
    } finally {
      HTMLAnchorElement.prototype.click = origClick;
    }
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.type).toBe('text/csv');
    const csv = await blobs[0]!.text();
    expect(saved).toBe('Big_Bertha_Mk_2_rev_B-drag-table.csv');
    expect(csv).toBe([
      `# MMRocket Sim ${APP_VERSION}`,
      '# design: Big "Bertha" Mk 2; rev B',
      '# aero model: Rogers Modified Barrowman (Kbf)',
      '# conditions: file Mach-Alt table - 3 points from Mach 0 to 5 (0-19202 m ISA)',
      '# cp: one roll plane (theta = 0 with the fins as drawn) - this design\'s CP depends on roll angle;'
        + ' the app\'s stability margin uses the forward-most CP over all roll angles: 32.356 mm from nose',
      'mach,cd_power_off,cd_power_on,cp_mm_from_nose,cna_per_rad,friction,pressure,base_power_off,base_power_on,'
        + 'cd_Nose_cone,cd_Fin_set_"3_fins"_rev_B',
      '0.5,0.45,0.4,,0,0.2,0.15,0.1,0.05,0.1,0.12',
      '1,0.61,0.55,301.59999999999997,16.27,0.18,0.33,0.1,0.04,0.2,0.2',
      '2.5,0.52,0.47,290,15.5,0.12,0.3,0.1,0.05,0.15,0.19',
    ].join('\n'));
  });
});

// Mutation guard: undefined reported CP with usable derivative weight is a gap.
it('keeps a null high-AOA CP missing in the plotted series and downloaded CSV', async () => {
  open(rocketOf(sweepOf([0.6, null, 0.6, 0.6], flat(12)), { length: 1.2, cp: 0.6, cpWorst: 0.6 }));
  expect(cpSeries()).toEqual([50, null, 50, 50]);
  const csv = await csvOf();
  expect(cpColumn(csv)).toEqual(['600', '', '600', '600']);
  expect(csv).toContain('\n1,0.4,0.35,,12,');
});

/**
 * CP AT ANGLE OF ATTACK (Eric, 2026-10-08, board row 65: "Approve, 0–20° only").
 * The CP chart's selector offers 0, 2, 5, 10, 15 and 20 degrees and nothing
 * above — past the fins' 20-degree stall the CP is not validated (W10). At 0 the
 * panel is the panel it was: one sweep, no aoaDeg, one 'CP' line, the same file.
 */
describe('CP vs Mach at an angle of attack', () => {
  /** A stub whose CP moves with the angle it is asked for, recording each call. */
  const angled = (calls: { aoaDeg?: number }[]): OrkRocket => ({
    dragSweep: (opts: { aoaDeg?: number }) => {
      calls.push(opts);
      const a = opts.aoaDeg ?? 0;
      return sweepOf(flat(0.6 - a * 0.01), flat(12));
    },
    staticInfo: () => ({ length: 1.2, cp: 0.6, cpWorst: 0.6 }),
  } as unknown as OrkRocket);
  const aoaSelect = () => [...host.querySelectorAll('label')]
    .find((l) => (l.textContent ?? '').startsWith('Angle of attack'))?.querySelector('select') ?? null;
  const pick = (deg: number) => act(() => {
    const el = aoaSelect()!;
    el.value = String(deg);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const lastCpPlot = () => [...plots].reverse().find((x) => x.series.some((s) => (s.label ?? '').startsWith('CP')))!;

  it('offers 0, 2, 5, 10, 15 and 20 degrees — nothing above 20 — and opens at 0', () => {
    const calls: { aoaDeg?: number }[] = [];
    open(angled(calls));
    const sel = aoaSelect();
    expect(sel).not.toBeNull();
    // The control is named by the label that wraps it.
    expect(sel!.closest('label')!.textContent).toContain('Angle of attack');
    const values = [...sel!.options].map((o) => Number(o.value));
    expect(values).toEqual([0, 2, 5, 10, 15, 20]);
    expect(values.every((v) => v <= 20)).toBe(true);
    expect([...sel!.options].map((o) => o.textContent)).toEqual(['0°', '2°', '5°', '10°', '15°', '20°']);
    expect(sel!.value).toBe('0');
    // At 0 the kernel is asked exactly what it always was: one sweep, no angle.
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('aoaDeg');
    expect(cpSeries()).toEqual(flat(50));
  });

  it('at 10 degrees charts that angle beside the 0-degree curve, and leaves the drag charts alone', () => {
    const calls: { aoaDeg?: number }[] = [];
    open(angled(calls));
    pick(10);
    expect(calls.map((c) => c.aoaDeg ?? 0)).toEqual([0, 10]);
    const p = lastCpPlot();
    expect(p.series.map((s) => s.label).slice(1)).toEqual(['CP at 10°', 'CP at 0°']);
    expect(p.data[1]![0]).toBeCloseTo((0.5 / 1.2) * 100, 9);
    expect(p.data[2]![0]).toBeCloseTo(50, 9);
    expect(host.textContent).toContain('Center of pressure vs Mach (% of length) at 10° angle of attack');
    expect(texts().some((t) => t.includes('this changes no flight'))).toBe(true);
    // Back to 0: the one line it always drew, and no further kernel call.
    pick(0);
    expect(cpSeries()).toEqual(flat(50));
    expect(calls).toHaveLength(2);
  });

  it('names the angle in the CSV header, beside the unchanged 0-degree column', async () => {
    open(angled([]));
    pick(15);
    const csv = await csvOf();
    const lines = csv.split('\n');
    const head = lines.find((l) => l.startsWith('mach,'))!.split(',');
    expect(head.slice(3, 6)).toEqual(['cp_mm_from_nose', 'cp_mm_from_nose_aoa_15deg', 'cna_per_rad']);
    const comments = lines.filter((l) => l.startsWith('#'));
    expect(comments).toHaveLength(5);
    expect(comments[4]).toBe('# angle of attack: cp_mm_from_nose_aoa_15deg is the CP at 15 deg angle of attack'
      + ' (same roll plane); every other column is at 0 deg');
    expect(comments[4]).not.toContain(',');
    expect(cpColumn(csv)).toEqual(['600', '600', '600', '600']);
    const col = head.indexOf('cp_mm_from_nose_aoa_15deg');
    for (const row of lines.slice(lines.findIndex((l) => l.startsWith('mach,')) + 1)) {
      expect(Number(row.split(',')[col])).toBeCloseTo(450, 9);
    }
  });

  it('at 0 degrees writes the file it always wrote — no angle column, no extra line', async () => {
    open(angled([]));
    const csv = await csvOf();
    expect(csv).not.toContain('aoa');
    expect(csv.split('\n').filter((l) => l.startsWith('#'))).toHaveLength(4);
  });

  it('says so when the angle sweep fails, and keeps the 0-degree curve', () => {
    const rocket = {
      dragSweep: (opts: { aoaDeg?: number }) => {
        if (opts.aoaDeg) throw new Error('kernel said no');
        return sweepOf(flat(0.6), flat(12));
      },
      staticInfo: () => ({ length: 1.2, cp: 0.6, cpWorst: 0.6 }),
    } as unknown as OrkRocket;
    open(rocket);
    pick(5);
    expect(texts().some((t) => t === 'CP at 5° could not be computed: kernel said no')).toBe(true);
    expect(cpSeries()).toEqual(flat(50));
  });

  it('on the real kernel, the 0-degree curve at Mach 0.3 is the static CP the app shows', async () => {
    const { OrkRocket: Real } = await import('@online-openrocket/engine');
    const { defaultTree, engineTree } = await import('../tree/treeModel.js');
    const { shownCp } = await import('../services/simReport.js');
    const rocket = Real.buildTree(engineTree(defaultTree()));
    const info = rocket.staticInfo();
    open(rocket);
    const p = [...plots].reverse().find((x) => x.series.some((s) => s.label === 'CP'))!;
    const machs = p.data[0]! as number[];
    const i = machs.findIndex((m) => Math.abs(m - 0.3) < 1e-9);
    expect(i).toBeGreaterThanOrEqual(0);
    // The chart's % of length, against the stat tiles' CP (forward-most over
    // roll — one number with the default rocket's fins) and the plane CP.
    expect(p.data[1]![i]!).toBeCloseTo((shownCp(info) / info.length) * 100, 6);
    expect(p.data[1]![i]!).toBeCloseTo((info.cp / info.length) * 100, 6);
    // And an angle draws a real, finite curve of its own beside it.
    pick(20);
    const q = lastCpPlot();
    expect(q.series.map((s) => s.label).slice(1)).toEqual(['CP at 20°', 'CP at 0°']);
    expect(Number.isFinite(q.data[1]![i])).toBe(true);
    expect(q.data[2]![i]!).toBeCloseTo(p.data[1]![i]!, 9);
  }, 30_000);
});
