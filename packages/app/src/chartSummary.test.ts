// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { chartSummary, nameChartCanvas } from './chartSummary.js';

/** The words a chart's canvas is named with (audit 2026-09-22). */
describe('chartSummary', () => {
  const mach = (v: number) => `Mach ${v}`;

  it('says the range, then each curve: start, highest, lowest, end', () => {
    const s = chartSummary({
      title: 'Drag coefficient vs Mach',
      x: [0.1, 0.5, 1.05, 1.5, 2],
      at: mach,
      series: [{ label: 'CD power-off', values: [0.452, 0.44, 0.719, 0.6, 0.512] }],
      source: 'The Drag table (.csv) download holds the same numbers.',
    });
    expect(s).toBe('Drag coefficient vs Mach, Mach 0.1 to Mach 2.'
      + ' CD power-off: 0.452 at Mach 0.1, highest 0.719 at Mach 1.05, lowest 0.44 at Mach 0.5, 0.512 at Mach 2.'
      + ' The Drag table (.csv) download holds the same numbers.');
  });

  it('does not repeat an extreme that is an end of the curve', () => {
    const s = chartSummary({
      title: 'Mass over time', x: [0, 1, 2], at: (t) => `${t} s`,
      series: [{ label: 'Mass (g)', values: [120, 110, 100] }],
    });
    expect(s).toBe('Mass over time, 0 s to 2 s. Mass (g): 120 at 0 s, 100 at 2 s.');
  });

  it('skips gaps, and says so when a curve has no data at all', () => {
    const s = chartSummary({
      title: 'CP vs Mach', x: [1, 2, 3], at: mach,
      series: [
        { label: 'CP', values: [null, 40, undefined] },
        { label: 'Empty', values: [null, null, null] },
      ],
    });
    expect(s).toBe('CP vs Mach, Mach 1 to Mach 3. CP: 40 at Mach 2. Empty: no data.');
  });

  it('rounds to three significant figures, like a reading', () => {
    const s = chartSummary({
      title: 'Altitude over time', x: [0, 5.6123], at: (t) => `${t.toFixed(1)} s`,
      series: [{ label: 'Altitude (m)', values: [0, 293.4567] }],
    });
    expect(s).toContain('293 at 5.6 s');
  });
});

describe('nameChartCanvas', () => {
  it('names the canvas, not its host, so the legend stays readable', () => {
    const host = document.createElement('div');
    host.innerHTML = '<div class="u-wrap"><canvas></canvas></div><table class="u-legend"></table>';
    nameChartCanvas(host, 'A summary.');
    const canvas = host.querySelector('canvas')!;
    expect(canvas.getAttribute('role')).toBe('img');
    expect(canvas.getAttribute('aria-label')).toBe('A summary.');
    expect(host.getAttribute('role')).toBeNull();
  });

  it('does nothing where there is no canvas (a stubbed chart)', () => {
    const host = document.createElement('div');
    expect(() => nameChartCanvas(host, 'x')).not.toThrow();
  });
});
