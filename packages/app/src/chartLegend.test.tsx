// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import uPlot from 'uplot';
import { SAMPLE_WIDTH, drawLineSample, legendSamplePlugin, lineSampleSvg } from './chartLegend.js';
import { LineSample } from './components/LineSample.js';
import { plotPng } from './components/PlotImage.js';
import { tooltipPlugin } from './chartTooltip.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
beforeEach(() => {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (t, p) => t[p] ?? (p === 'measureText' ? () => ({ width: 10 }) : () => undefined),
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.stubGlobal('Path2D', class { moveTo() {} lineTo() {} closePath() {} rect() {} arc() {} addPath() {} });
  host = document.createElement('div');
  document.body.append(host);
});
afterEach(() => { host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('line samples — the series colour and dash, the label in the text colour', () => {
  it('lineSampleSvg draws the colour and the dash, decorative', () => {
    const svg = lineSampleSvg('#7049a8', [2, 3]);
    expect(svg.getAttribute('class')).toBe('line-sample');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('width')).toBe(String(SAMPLE_WIDTH));
    const line = svg.querySelector('line')!;
    expect(line.getAttribute('stroke')).toBe('#7049a8');
    expect(line.getAttribute('stroke-dasharray')).toBe('2 3');
    expect(lineSampleSvg('#006aab').querySelector('line')!.hasAttribute('stroke-dasharray')).toBe(false);
  });

  it('LineSample renders the same sample in React', () => {
    const root = createRoot(host);
    act(() => root.render(<span>Thrust <LineSample color="#ad3c00" dash={[12, 4]} /></span>));
    const line = host.querySelector('svg.line-sample line')!;
    expect(line.getAttribute('stroke')).toBe('#ad3c00');
    expect(line.getAttribute('stroke-dasharray')).toBe('12 4');
    act(() => root.unmount());
  });

  // uPlot draws a bordered square per series and colours the LABEL with the
  // series colour only when markers are off; the plugin keeps markers on and
  // swaps the square for the line sample.
  it('legendSamplePlugin turns each uPlot legend marker into the series line sample', async () => {
    const plot = new uPlot({ width: 400, height: 200, scales: { x: { time: false } }, legend: { live: true },
      plugins: [legendSamplePlugin()],
      series: [{ label: 't' }, { label: 'Altitude', stroke: '#006aab' }, { label: 'Stability', stroke: '#45637b', dash: [6, 4] }] },
    [[0, 1, 2], [0, 1, 0], [1, 1, 1]], host);
    await Promise.resolve();
    const rows = [...host.querySelectorAll('.u-legend .u-series')];
    expect(rows).toHaveLength(3);
    const sample = (r: number) => rows[r]!.querySelector('.u-marker svg.line-sample line');
    expect(sample(0)).toBeNull();
    expect(sample(1)!.getAttribute('stroke')).toBe('#006aab');
    expect(sample(1)!.hasAttribute('stroke-dasharray')).toBe(false);
    expect(sample(2)!.getAttribute('stroke')).toBe('#45637b');
    expect(sample(2)!.getAttribute('stroke-dasharray')).toBe('6 4');
    for (const label of host.querySelectorAll<HTMLElement>('.u-legend .u-label')) expect(label.style.color).toBe('');
    for (const m of host.querySelectorAll<HTMLElement>('.u-marker.u-marker-sample')) expect(m.style.borderStyle).toBe('none');
    plot.destroy();
  });

  // uPlot keeps a built series' stroke as a FUNCTION, so the readout's swatch
  // fell back to currentColor on every live chart until brand v1.
  it('the point readout shows each series as its line sample, label uncoloured', async () => {
    const readout = tooltipPlugin();
    const plot = new uPlot({ width: 400, height: 200, scales: { x: { time: false } },
      plugins: [readout],
      series: [{ label: 't' }, { label: 'Velocity', stroke: '#226b47', dash: [12, 4] }] },
    [[0, 1, 2], [0, 5, 0]], host);
    await Promise.resolve();
    plot.over.dispatchEvent(new Event('pointerenter'));
    // happy-dom lays nothing out, so place the cursor on sample 1 by hand and
    // run the plugin's own setCursor hook against the real, built series.
    plot.cursor.idx = 1;
    (readout.hooks.setCursor as (u: uPlot) => void)(plot);
    const row = host.querySelector('.chart-tooltip-row');
    expect(row).not.toBeNull();
    const line = row!.querySelector('svg.line-sample.chart-tooltip-swatch line')!;
    expect(line.getAttribute('stroke')).toBe('#226b47');
    expect(line.getAttribute('stroke-dasharray')).toBe('12 4');
    expect(row!.querySelector<HTMLElement>('.chart-tooltip-label')!.style.color).toBe('');
    plot.destroy();
  });
});

describe('the saved plot image draws its own legend', () => {
  it('each series: a line sample in its colour and dash, its name in the text ink', async () => {
    const calls: [string, ...unknown[]][] = [];
    const state: Record<string, unknown> = {};
    const ctx = new Proxy(state, {
      get: (t, p: string) => p === 'measureText' ? (s: string) => ({ width: s.length * 7 })
        : p in t ? t[p] : (...a: unknown[]) => { calls.push([p, ...a, { stroke: t['strokeStyle'], fill: t['fillStyle'], width: t['lineWidth'] }]); },
      set: (t, p: string, v) => { t[p] = v; return true; },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb, type) => cb(new Blob(['png'], { type })));
    const source = document.createElement('canvas'); source.width = 600; source.height = 300;
    await plotPng(source, ['Stability + CP + CG'], '#ffffff', '#03254f', { strokeWidth: 2.5, entries: [
      { label: 'Stability margin (cal)', color: '#45637b', dash: [6, 4] },
      { label: 'CP location (cm)', color: '#7049a8', dash: [12, 4] },
    ] });
    const dashes = calls.filter((c) => c[0] === 'setLineDash').map((c) => c[1]);
    expect(dashes).toEqual([[6, 4], [12, 4]]);
    const strokes = calls.filter((c) => c[0] === 'stroke').map((c) => (c[1] as { stroke: string; width: number }));
    expect(strokes.map((s) => s.stroke)).toEqual(['#45637b', '#7049a8']);
    for (const s of strokes) expect(s.width).toBe(2.5);
    const labels = calls.filter((c) => c[0] === 'fillText' && String(c[1]).includes('('));
    expect(labels.map((c) => c[1])).toEqual(['Stability margin (cal)', 'CP location (cm)']);
    for (const c of labels) expect((c.at(-1) as { fill: string }).fill).toBe('#03254f');
  });

  it('drawLineSample scales the dash and width to the image', () => {
    const ctx = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      setLineDash: vi.fn(), strokeStyle: '', lineWidth: 0 };
    drawLineSample(ctx as unknown as CanvasRenderingContext2D, 10, 20, { label: 'Drag', color: '#730d49', dash: [10, 3, 2, 3, 2, 3] }, 3, 2);
    expect(ctx.setLineDash).toHaveBeenCalledWith([20, 6, 4, 6, 4, 6]);
    expect(ctx).toMatchObject({ strokeStyle: '#730d49', lineWidth: 6 });
    expect(ctx.lineTo).toHaveBeenCalledWith(10 + SAMPLE_WIDTH * 2, 20);
  });
});
