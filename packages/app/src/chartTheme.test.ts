// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REFERENCE_DASH, SERIES, SERIES_DARK, SERIES_DAYLIGHT, SLOT_PATTERN, chartInk, seriesPalette, seriesStyle, slotDash,
} from './chartTheme.js';

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

const here = dirname(fileURLToPath(import.meta.url));
const tokens = JSON.parse(readFileSync(join(here, '..', 'public', 'brand', 'tokens.json'), 'utf8')) as {
  color: Record<string, string>;
  theme: Record<'light' | 'dark', Record<string, string>>;
  chart: Record<'light' | 'dark', Record<string, string>>;
};

// The recessed plot-area surface each theme's lines actually draw on
// (--surface-1 in styles.css, under the plot: `.chart-panel .uplot .u-under`)
// and the panel the chart card and its legend dots sit on (--surface-2).
// Per the brand table (response-2026-10-26b §2 A): --surface-1 → --mmr-bg,
// --surface-2 → --mmr-surface. Pinned against the stylesheet below so a retune
// that moves a surface fails HERE instead of silently invalidating every
// contrast assertion — the v0.075 defect was precisely a palette validated
// against a surface the charts didn't draw on.
const PLOT = { light: '#f6faff', dark: '#03254f' } as const;
const PANEL = { light: '#ffffff', dark: '#123859' } as const;

/** A theme block's value for `name`, with a `var(--mmr-x)` resolved through tokens.json. */
function surfaceIn(theme: 'light' | 'dark', name: string): string {
  const css = readFileSync(join(here, 'styles.css'), 'utf8');
  // The block's own selector at the start of a line (a comment quotes `.viz-root {`).
  const open = theme === 'dark' ? "\n.viz-root[data-theme='dark'] {" : '\n.viz-root {';
  const block = css.slice(css.indexOf(open));
  const body = block.slice(0, block.indexOf('}'));
  const value = new RegExp(`${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim() ?? '';
  const ref = /^var\(--mmr-([\w-]+)\)$/.exec(value)?.[1];
  // A themed token (--mmr-bg) or a fixed primitive (--mmr-c-paper).
  const resolved = !ref ? value : ref.startsWith('c-') ? tokens.color[ref.slice(2)] : tokens.theme[theme][ref];
  return resolved?.toLowerCase() ?? '';
}

/** Slots the brand has no hue for yet (D7): they keep the pre-brand hues. */
const PENDING_BRAND = [5, 6];

describe('chart palettes', () => {
  it('keeps the slot count aligned across palettes', () => {
    expect(SERIES_DAYLIGHT).toHaveLength(SERIES.length);
    expect(SERIES_DARK).toHaveLength(SERIES.length);
    expect(SLOT_PATTERN).toHaveLength(SERIES.length);
  });

  // uPlot needs strings, so the brand hues are literals here; this holds them
  // to the vendored brand file, so a brand re-sync that moves a hue fails.
  it('brand slots equal the vendored tokens.json chart values', () => {
    const slots = ['altitude', 'velocity', 'acceleration', 'pressure', 'thrust', undefined, undefined, 'reference'];
    // The slots with no brand hue are exactly the pending ones.
    expect(slots.flatMap((name, i) => name ? [] : [i])).toEqual(PENDING_BRAND);
    for (const [theme, palette] of [['light', SERIES], ['dark', SERIES_DARK]] as const) {
      slots.forEach((name, i) => {
        if (name) expect(palette[i], `${theme} slot ${i} (${name})`).toBe(tokens.chart[theme][name]);
      });
    }
  });

  it('plot and panel surfaces are the stylesheet’s --surface-1 / --surface-2, not stale copies', () => {
    for (const theme of ['light', 'dark'] as const) {
      expect(surfaceIn(theme, '--surface-1'), `${theme} --surface-1`).toBe(PLOT[theme]);
      expect(surfaceIn(theme, '--surface-2'), `${theme} --surface-2`).toBe(PANEL[theme]);
    }
  });

  // The v0.075 defect this guards against: the dark theme drew the palette
  // that was validated against WHITE, putting a line at 1.9:1 on the panel.
  // Every hue must clear 3:1 — the non-text minimum — against its plot surface.
  it('light and dark hues clear 3:1 against their plot surface', () => {
    for (const c of SERIES) expect(contrast(c, PLOT.light), c).toBeGreaterThanOrEqual(3);
    for (const c of SERIES_DARK) expect(contrast(c, PLOT.dark), c).toBeGreaterThanOrEqual(3);
  });

  // The legend and selection dots sit on the panel, one step up. Every brand
  // hue clears 3:1 there too. The pending drag hue does not on the dark panel
  // (#008300 on #123859, 2.45): a KNOWN LIMIT until mmr-brand 1.0.3 (D7), which
  // must give drag (and Mach) a dark hue that clears 3:1 on BOTH #03254F and
  // #123859. This is a tripwire, not a pass: the failing slots must be exactly
  // the pending drag slot, so a new failure fails here, and so does the 1.0.3
  // fix — remove the exception then.
  it('hues clear 3:1 against their panel, except the pending dark drag hue', () => {
    SERIES.forEach((c, i) => expect(contrast(c, PANEL.light), `light ${i}`).toBeGreaterThanOrEqual(3));
    const below = SERIES_DARK.flatMap((c, i) => contrast(c, PANEL.dark) < 3 ? [i] : []);
    expect(below).toEqual([5]);
  });

  it('light and dark hues are unique', () => {
    expect(new Set(SERIES).size).toBe(SERIES.length);
    expect(new Set(SERIES_DARK).size).toBe(SERIES_DARK.length);
  });
  // The whole point of daylight mode: every plotted line has to stay readable
  // on a phone in direct sun. 4.5:1 is the WCAG AA text threshold — a chart
  // line is thinner than text, so treat it as the floor, not the target. The
  // surface is always white; daylight mode forces the light palette.
  it('daylight hues clear 4.5:1 against the white page', () => {
    for (const c of SERIES_DAYLIGHT) expect(contrast(c, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('daylight hues stay distinguishable from each other', () => {
    expect(new Set(SERIES_DAYLIGHT).size).toBe(SERIES_DAYLIGHT.length);
  });

  // Daylight still overrides everything; otherwise the THEME picks the
  // palette — dark stopped borrowing light's hues in v0.076.
  it('picks the palette from daylight first, then theme', () => {
    expect(seriesPalette(true, 'light')).toBe(SERIES_DAYLIGHT);
    expect(seriesPalette(true, 'dark')).toBe(SERIES_DAYLIGHT);
    expect(seriesPalette(false, 'light')).toBe(SERIES);
    expect(seriesPalette(false, 'dark')).toBe(SERIES_DARK);
  });

  // Slot-for-slot hue identity: a trace keeps its slot across themes, so
  // switching theme re-steps a line's color but never re-labels the data.
  it('dark palette is a per-slot re-step of the light palette, not a reorder', () => {
    // Spot anchors: slot 0 is the brand altitude blue in both themes; the
    // pending drag slot is the one hue that survives both surfaces unchanged.
    expect(SERIES[0]).toBe(tokens.chart.light.altitude);
    expect(SERIES_DARK[0]).toBe(tokens.chart.dark.altitude);
    expect(SERIES_DARK[SERIES.indexOf('#008300')]).toBe('#008300');
  });

  it('stability is the reference ink, dashed 6 4 wherever it is drawn', async () => {
    const { seriesCatalog } = await import('./flightChartModel.js');
    const { METRIC_UNITS } = await import('./prefs/units.js');
    expect(REFERENCE_DASH).toEqual([6, 4]);
    expect(slotDash(7)).toEqual(REFERENCE_DASH);
    for (const palette of [SERIES, SERIES_DARK, SERIES_DAYLIGHT]) {
      const cat = seriesCatalog({ units: METRIC_UNITS }, palette);
      for (const key of ['stability', 'stabilityPercent']) {
        const d = cat.find((x) => x.key === key)!;
        expect(d.color).toBe(palette[7]);
        expect(d.dash).toEqual(REFERENCE_DASH);
      }
      // Nothing else carries a line pattern of its own in a single-series panel.
      expect(cat.filter((x) => x.dash).map((x) => x.key)).toEqual(['stability', 'stabilityPercent']);
    }
    // The roll-plane panel draws the stability margin outside seriesCatalog:
    // the same reference slot and dash there (it was the altitude blue, solid).
    const drag = readFileSync(join(here, 'components', 'DragPanel.tsx'), 'utf8');
    const stabilityLines = drag.match(/label: '[^']*[Ss]tability[^']*', color: palette\[\d\]!(, dash: REFERENCE_DASH)?/g) ?? [];
    expect(stabilityLines).toHaveLength(1);
    for (const l of stabilityLines) expect(l).toMatch(/color: palette\[7\]!, dash: REFERENCE_DASH$/);
  });
});

describe('chartInk — the reference ink is an app variable Daylight can reach', () => {
  const host = (vars: Record<string, string>) => {
    const el = document.createElement('div');
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
    document.body.appendChild(el);
    return el;
  };

  it('reads --chart-reference ahead of the brand token', () => {
    // Daylight: every --mmr-* token is the LIGHT value (#45637b), and the
    // Daylight block sets --chart-reference to #000 like the rest of its ink.
    const el = host({ '--chart-reference': '#000', '--mmr-chart-reference': '#45637b' });
    expect(chartInk(el).reference).toBe('#000');
    el.remove();
  });

  it('falls back to the brand token, then the light brand value', () => {
    const el = host({ '--mmr-chart-reference': '#a9c3d9' });
    expect(chartInk(el).reference).toBe('#a9c3d9');
    el.remove();
    expect(chartInk(null).reference).toBe(tokens.chart.light.reference);
  });
});

describe('seriesStyle — many-series charts never silently cycle colors', () => {
  const C = SERIES;

  // Re-pinned for the brand palette (2026-10-26): the first 8 used to draw
  // solid, which was safe only because the pre-brand hues passed the CVD gate
  // on hue alone. The brand hues do not (see the gate below), and slots cannot
  // be re-ordered off their quantities, so each slot draws its own pattern.
  it('first 8 series draw in slot order with their slot pattern', () => {
    for (let i = 0; i < C.length; i++) {
      const s = seriesStyle(i, C);
      expect(s.stroke).toBe(C[i]);
      expect(s.dash).toEqual(slotDash(i));
    }
  });

  // The per-component drag breakdown used C[i % 8]: component 9 became an
  // exact twin of component 1 (LEM-IV's two Rail Buttons were the reported
  // case). Reused hues now carry a different pattern as the secondary encoding.
  it('series 8–23 reuse the hues, each repeat with a pattern its slot has not used', () => {
    for (let slot = 0; slot < C.length; slot++) {
      const looks = [0, 1, 2].map((t) => seriesStyle(slot + t * C.length, C));
      for (const l of looks) expect(l.stroke).toBe(C[slot]);
      expect(new Set(looks.map((l) => (l.dash ?? []).join(','))).size).toBe(3);
    }
  });

  it('no two of the first 24 series share both hue and dash', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const s = seriesStyle(i, C);
      const key = `${s.stroke}|${(s.dash ?? []).join(',')}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

// Severity-1 Machado matrices, applied to linear sRGB. Numerical source:
// https://raw.githubusercontent.com/DaltonLens/DaltonLens-Python/master/daltonlens/simulate.py
// This is a subset check, not a claim of universal CVD accessibility.
const CVD = [
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
];
function lab(hex: string, matrix: number[][]) {
  const linear = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const rgb = matrix.map((row) => Math.max(0, Math.min(1, row.reduce((v, c, i) => v + c * linear[i]!, 0))));
  const xyz = [[0.4124564, 0.3575761, 0.1804375], [0.2126729, 0.7151522, 0.072175], [0.0193339, 0.119192, 0.9503041]]
    .map((row, j) => row.reduce((v, c, i) => v + c * rgb[i]!, 0) / [0.95047, 1, 1.08883][j]!)
    .map((v) => v > (6 / 29) ** 3 ? Math.cbrt(v) : v / (3 * (6 / 29) ** 2) + 4 / 29);
  return [116 * xyz[1]! - 16, 500 * (xyz[0]! - xyz[1]!), 200 * (xyz[1]! - xyz[2]!)];
}

it('comparison subsets never depend on hue alone when simulated colours approach', async () => {
  const { PRESETS, comparisonMembers, seriesCatalog } = await import('./flightChartModel.js');
  const { METRIC_UNITS } = await import('./prefs/units.js');
  const measured: Record<string, string> = {};
  for (const [name, palette] of [['light', SERIES], ['dark', SERIES_DARK], ['daylight', SERIES_DAYLIGHT]] as const) {
    const catalog = seriesCatalog({ units: METRIC_UNITS }, palette);
    const minima = CVD.map(() => Infinity);
    for (const preset of PRESETS.filter((p) => p.x === 'time')) {
      const members = comparisonMembers(preset, catalog);
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
        CVD.forEach((matrix, m) => {
          const a = lab(members[i]!.color, matrix); const b = lab(members[j]!.color, matrix);
          const delta = Math.hypot(...a.map((v, k) => v - b[k]!));
          minima[m] = Math.min(minima[m]!, delta);
          // Preserve identity slots; line patterns supply the independent
          // channel when the 15 Delta-E76 screen is not met by hue alone.
          if (delta < 15) expect(members[i]!.dash).not.toEqual(members[j]!.dash);
        });
      }
    }
    measured[name] = minima.map((v) => v.toFixed(2)).join(', ');
  }
  console.info('Comparison minimum Delta-E76 (normal, protan, deutan, tritan):', measured);
});

/** Slot pairs under the 15 ΔE76 screen in any simulated vision, for one palette. */
function conflicts(palette: string[]): [number, number, string][] {
  const out: [number, number, string][] = [];
  for (let i = 0; i < palette.length; i++) for (let j = i + 1; j < palette.length; j++) {
    const deltas = CVD.map((matrix) => {
      const a = lab(palette[i]!, matrix); const b = lab(palette[j]!, matrix);
      return Math.hypot(...a.map((v, k) => v - b[k]!));
    });
    if (Math.min(...deltas) < 15) out.push([i, j, deltas.map((d) => d.toFixed(1)).join('/')]);
  }
  return out;
}

// THE CVD GATE FOR CHARTS THAT SHOW EVERY SLOT AT ONCE (the drag breakdown by
// component). Every pair of slots whose hues come within 15 ΔE76 in normal,
// protan, deutan or tritan vision must draw different line patterns — within
// each group of 8 repeats too. Slots keep their brand hues, so this is met by
// SLOT_PATTERN, never by moving a quantity to another hue.
it('every slot pair that hue alone cannot separate draws different patterns', () => {
  const measured: Record<string, string> = {};
  for (const [name, palette] of [['light', SERIES], ['dark', SERIES_DARK], ['daylight', SERIES_DAYLIGHT]] as const) {
    const pairs = conflicts(palette);
    for (const [a, b] of pairs) for (let tier = 0; tier < 3; tier++) {
      const n = palette.length * tier;
      expect(seriesStyle(n + a, palette).dash, `${name} slots ${a}/${b} tier ${tier}`)
        .not.toEqual(seriesStyle(n + b, palette).dash);
    }
    measured[name] = pairs.map(([a, b, d]) => `${a}-${b} ${d}`).join('; ');
  }
  console.info('Slot pairs under 15 ΔE76 (normal/protan/deutan/tritan):', measured);
});

// The default plots (FlightCharts DEFAULT_SELECTED: altitude, velocity,
// acceleration) are three single-series panels, each titled, so a panel never
// relies on hue to say which quantity it shows. Their hues must still be told
// apart at a glance by full-colour vision (the hard 15 floor, no secondary
// encoding can excuse it).
it('the default altitude / velocity / acceleration set is separable', async () => {
  const { seriesCatalog } = await import('./flightChartModel.js');
  const { METRIC_UNITS } = await import('./prefs/units.js');
  const keys = ['altitude', 'velocity', 'acceleration'];
  for (const palette of [SERIES, SERIES_DARK, SERIES_DAYLIGHT]) {
    const cat = seriesCatalog({ units: METRIC_UNITS }, palette);
    const slots = keys.map((k) => palette.indexOf(cat.find((d) => d.key === k)!.color));
    expect(slots).toEqual([0, 1, 2]);
    // Normal vision only. No chart overlays these three by SLOT pattern (each
    // has its own panel); where two share a chart — the comparison presets —
    // the comparison-subset test above holds the dash that separates them.
    for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
      const a = lab(palette[slots[i]!]!, CVD[0]!); const b = lab(palette[slots[j]!]!, CVD[0]!);
      expect(Math.hypot(...a.map((v, k) => v - b[k]!)), `normal vision ${keys[i]}/${keys[j]}`).toBeGreaterThanOrEqual(15);
    }
  }
});
