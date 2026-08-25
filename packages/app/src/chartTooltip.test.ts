// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type uPlot from 'uplot';
import { formatReadout, readoutRows, tooltipPlacement, tooltipPlugin } from './chartTooltip.js';

describe('formatReadout', () => {
  it('keeps six significant digits, not two decimals', () => {
    // The complaint this replaced: toFixed(2) turned every one of these into
    // "0.03" / "0.00" / "12345.68".
    expect(formatReadout(0.0312457)).toBe('0.0312457');
    expect(formatReadout(0.00123456789)).toBe('0.00123457');
    expect(formatReadout(12345.6789)).toBe('12345.7');
    expect(formatReadout(9.80665)).toBe('9.80665');
  });

  it('trims trailing zeros so an exact value reads exact', () => {
    expect(formatReadout(1.23)).toBe('1.23');
    expect(formatReadout(5)).toBe('5');
    expect(formatReadout(0.03)).toBe('0.03');
    expect(formatReadout(-2.5)).toBe('-2.5');
  });

  it('zero is zero, and the sign survives', () => {
    expect(formatReadout(0)).toBe('0');
    expect(formatReadout(-0.000450012)).toBe('-0.000450012');
  });

  it('exponential only outside 1e-4 … 1e7, mantissa trimmed', () => {
    expect(formatReadout(1e-5)).toBe('1e-5');
    expect(formatReadout(2.5e8)).toBe('2.5e+8');
    // Just inside the plain-decimal band on both sides.
    expect(formatReadout(0.0001)).toBe('0.0001');
    expect(formatReadout(9999999)).toBe('9999999');
  });

  it('null, undefined and NaN read as an en dash (the kernel gap, not zero)', () => {
    expect(formatReadout(null)).toBe('–');
    expect(formatReadout(undefined)).toBe('–');
    expect(formatReadout(NaN)).toBe('–');
    expect(formatReadout(Infinity)).toBe('–');
  });

  it('honours a caller-chosen digit count', () => {
    expect(formatReadout(1.23456789, 3)).toBe('1.23');
    expect(formatReadout(1.23456789, 9)).toBe('1.23456789');
  });
});

describe('tooltipPlacement', () => {
  const W = 400;
  const H = 200;

  it('sits below-right of the sample by the gap', () => {
    expect(tooltipPlacement(100, 50, 80, 40, W, H, 12)).toEqual({ left: 112, top: 62 });
  });

  it('flips left rather than overflowing the right edge', () => {
    // 380 + 12 + 80 = 472 > 400, so it goes to the sample's left.
    expect(tooltipPlacement(380, 50, 80, 40, W, H, 12)).toEqual({ left: 288, top: 62 });
  });

  it('flips above rather than overflowing the bottom edge', () => {
    expect(tooltipPlacement(100, 190, 80, 40, W, H, 12)).toEqual({ left: 112, top: 138 });
  });

  it('flips on both axes at once in the bottom-right corner', () => {
    expect(tooltipPlacement(390, 195, 80, 40, W, H, 12)).toEqual({ left: 298, top: 143 });
  });

  it('clamps inside the plot instead of going negative', () => {
    // Sample hard against the left edge, box too wide to flip into.
    expect(tooltipPlacement(2, 10, 80, 40, W, H, 12).left).toBe(14);
    expect(tooltipPlacement(390, 10, 500, 40, W, H, 12).left).toBe(0);
    // A 240px box in a 160px-tall collapsed panel (panelHeight's floor).
    expect(tooltipPlacement(100, 80, 80, 240, W, 160, 12).top).toBe(0);
  });
});

describe('readoutRows', () => {
  const data = [
    [0, 1, 2],
    [10, 20, 30],
    [1, null, 3],
  ];

  it('one row per y-series; series 0 is the x heading and never a row', () => {
    const rows = readoutRows(
      [{ label: 't (s)' }, { label: 'Altitude (ft)', stroke: '#2a78d6' }],
      data,
      1,
    );
    expect(rows).toEqual([{ label: 'Altitude (ft)', value: '20', color: '#2a78d6' }]);
  });

  it('skips a hidden series, so the readout matches the lines drawn', () => {
    const rows = readoutRows(
      [{ label: 't' }, { label: 'A', show: false, stroke: '#111' }, { label: 'B', stroke: '#222' }],
      data,
      0,
    );
    expect(rows.map((r) => r.label)).toEqual(['B']);
  });

  it('skips a null sample rather than printing a dash where the line has a gap', () => {
    const rows = readoutRows(
      [{ label: 't' }, { label: 'A', stroke: '#111' }, { label: 'B', stroke: '#222' }],
      data,
      1,
    );
    expect(rows.map((r) => r.label)).toEqual(['A']);
  });

  it('a non-string stroke (uPlot allows a function) falls back to currentColor', () => {
    const rows = readoutRows([{ label: 't' }, { label: 'A', stroke: () => '#333' }], data, 0);
    expect(rows[0]!.color).toBe('currentColor');
  });
});

/**
 * uPlot types a hook slot as "one function OR an array of them"; the plugin
 * always registers the single-function form, so unwrap it once here rather
 * than casting at every call.
 */
function hook(plugin: uPlot.Plugin, name: 'init' | 'setCursor' | 'destroy'): (u: uPlot) => void {
  const h = plugin.hooks[name];
  return (Array.isArray(h) ? h[0]! : h!) as (u: uPlot) => void;
}

/** Minimal uPlot stand-in: only what the plugin actually touches. */
function fakePlot(over: HTMLElement, idx: number | null): uPlot {
  return {
    over,
    cursor: { idx, left: 0, top: 0 },
    series: [{ label: 't (s)' }, { label: 'Altitude (ft)', stroke: '#2a78d6', scale: 'y' }],
    data: [[0, 0.5, 1], [0, 12.5, 40]],
    scales: { x: {}, y: {} },
    valToPos: (v: number) => v,
  } as unknown as uPlot;
}

describe('tooltipPlugin', () => {
  it('stays hidden until the pointer is actually over this plot', () => {
    const over = document.createElement('div');
    const plugin = tooltipPlugin();
    const u = fakePlot(over, 1);
    hook(plugin, 'init')(u);
    const box = over.querySelector('.chart-tooltip') as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.style.display).toBe('none');

    // A synced peer's cursor move must NOT pop this panel's readout — the
    // flight panels share a cursor-sync key and every mounted panel gets setCursor.
    hook(plugin, 'setCursor')(u);
    expect(box.style.display).toBe('none');

    over.dispatchEvent(new Event('pointerenter'));
    hook(plugin, 'setCursor')(u);
    expect(box.style.display).toBe('');
    expect(box.textContent).toContain('t (s) 0.5');
    expect(box.textContent).toContain('Altitude (ft)');
    expect(box.textContent).toContain('12.5');

    over.dispatchEvent(new Event('pointerleave'));
    hook(plugin, 'setCursor')(u);
    expect(box.style.display).toBe('none');
  });

  it('hides when the cursor leaves the data (idx null) and cleans up on destroy', () => {
    const over = document.createElement('div');
    const plugin = tooltipPlugin();
    const u = fakePlot(over, null);
    hook(plugin, 'init')(u);
    over.dispatchEvent(new Event('pointerenter'));
    hook(plugin, 'setCursor')(u);
    expect((over.querySelector('.chart-tooltip') as HTMLElement).style.display).toBe('none');

    hook(plugin, 'destroy')(u);
    expect(over.querySelector('.chart-tooltip')).toBeNull();
  });

  it('is aria-hidden — the live legend carries the same numbers accessibly', () => {
    const over = document.createElement('div');
    const plugin = tooltipPlugin();
    hook(plugin, 'init')(fakePlot(over, 0));
    expect(over.querySelector('.chart-tooltip')!.getAttribute('aria-hidden')).toBe('true');
  });
});
