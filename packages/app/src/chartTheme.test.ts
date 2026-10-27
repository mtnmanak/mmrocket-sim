// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHART_TOKENS, LIGHT_PALETTE, LINE_STYLES, REFERENCE_DASH, chartInk, chartPalette, chartVar, lineStyle, seriesStyle, slotOf,
  type ChartToken,
} from './chartTheme.js';
import { SAMPLE_WIDTH } from './chartLegend.js';

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
const read = (...p: string[]) => readFileSync(join(here, ...p), 'utf8');
const tokens = JSON.parse(read('..', 'public', 'brand', 'tokens.json')) as {
  color: Record<string, string>;
  theme: Record<'light' | 'dark', Record<string, string>>;
  chart: Record<'light' | 'dark', Record<string, string>>;
};
const css = read('styles.css');

type Mode = 'light' | 'dark' | 'daylight';
const MODES: Mode[] = ['light', 'dark', 'daylight'];
/** The selector that opens each mode's variable block (the first match is the variables). */
const OPENER: Record<Mode, string> = {
  light: '\n.viz-root {', dark: "\n.viz-root[data-theme='dark'] {", daylight: "\n.viz-root[data-contrast='high'] {",
};

/** The raw value a block declares for `name`, or undefined. */
function declared(mode: Mode, name: string): string | undefined {
  const at = css.indexOf(OPENER[mode]);
  const body = css.slice(at, css.indexOf('\n}', at));
  return new RegExp(`\\n\\s*${name}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
}

/**
 * A variable's value in a mode, as the cascade gives it: Daylight is
 * data-theme LIGHT, so it inherits the light block and every --mmr-* token is
 * the light value; dark overrides the light block. `var(--mmr-x)` resolves
 * through the vendored tokens.json (chart.*, theme.*, or a c-* primitive).
 */
function resolved(mode: Mode, name: string): string {
  const raw = declared(mode, name) ?? (mode === 'light' ? undefined : declared('light', name));
  const theme = mode === 'dark' ? 'dark' : 'light';
  const ref = /^var\(--mmr-([\w-]+)\)$/.exec(raw ?? '')?.[1];
  const value = !ref ? raw
    : ref.startsWith('chart-') ? tokens.chart[theme][ref.slice(6)]
      : ref.startsWith('c-') ? tokens.color[ref.slice(2)] : tokens.theme[theme][ref];
  return value?.toLowerCase() ?? '';
}

/** The series a mode draws, in slot order, through the stylesheet. */
const paletteIn = (mode: Mode) => CHART_TOKENS.map((t) => resolved(mode, chartVar(t)));

// The surfaces a series line or its legend sample sits on. Plot = --surface-1
// (`.chart-panel .uplot .u-under`), panel = --surface-2 (the chart card and
// uPlot's legend). Pinned below against the stylesheet: the v0.075 defect was
// a palette validated against a surface the charts did not draw on.
const PLOT: Record<Mode, string> = { light: '#f6faff', dark: '#03254f', daylight: '#ffffff' };
const PANEL: Record<Mode, string> = { light: '#ffffff', dark: '#123859', daylight: '#ffffff' };

describe('chart colours come from CSS, never from hex in TypeScript', () => {
  it('chartTheme.ts carries no hex colour literal', () => {
    expect(read('chartTheme.ts').match(/#[0-9a-f]{3,8}\b/gi) ?? []).toEqual([]);
  });

  it('the slot order is the brand order (SPEC §3.2), reference last', () => {
    expect([...CHART_TOKENS]).toEqual(['altitude', 'velocity', 'acceleration', 'pressure', 'thrust', 'drag', 'mach', 'reference']);
    for (const t of CHART_TOKENS) expect(Object.keys(tokens.chart.light)).toContain(t);
  });

  it('styles.css aliases each quantity to its brand token in light and dark', () => {
    const chartCss = read('..', 'public', 'brand', 'chart.css');
    for (const t of CHART_TOKENS) {
      // The brand defines the token in both themes …
      expect(chartCss.match(new RegExp(`--mmr-chart-${t}:`, 'g')) ?? [], t).toHaveLength(3);
      // … and the app's variable is exactly that token, light block and dark block.
      expect(declared('light', chartVar(t)), `light ${t}`).toBe(`var(--mmr-chart-${t})`);
      expect(declared('dark', chartVar(t)), `dark ${t}`).toBe(`var(--mmr-chart-${t})`);
      expect(resolved('light', chartVar(t))).toBe(tokens.chart.light[t]);
      expect(resolved('dark', chartVar(t))).toBe(tokens.chart.dark[t]);
    }
  });

  // Daylight is data-theme light, so it draws the brand LIGHT series. Every one
  // clears 4.5:1 on white except Mach (#00987C, 3.63), so the Daylight block
  // overrides --chart-mach and nothing else, and keeps the 3 px stroke.
  it('Daylight overrides --chart-mach only, with a teal that clears 4.5:1 on white', () => {
    const overridden = CHART_TOKENS.filter((t) => declared('daylight', chartVar(t)) !== undefined);
    expect(overridden).toEqual(['mach']);
    expect(contrast(tokens.chart.light['mach']!, '#ffffff')).toBeLessThan(4.5);
    for (const [i, c] of paletteIn('daylight').entries()) {
      expect(contrast(c, '#ffffff'), `${CHART_TOKENS[i]} ${c}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(resolved('daylight', '--chart-mach')).toBe('#008276');
    expect(declared('daylight', '--chart-series-width')).toBe('3');
  });

  it('series are unique within each mode', () => {
    for (const mode of MODES) expect(new Set(paletteIn(mode)).size, mode).toBe(CHART_TOKENS.length);
  });

  it('chartPalette reads --chart-<token> at the element, falling back to the light brand values', () => {
    const el = document.createElement('div');
    el.style.setProperty('--chart-velocity', '#78ce9a');
    el.style.setProperty('--chart-mach', '#008276');
    document.body.appendChild(el);
    const p = chartPalette(el);
    expect(p[slotOf('velocity')]).toBe('#78ce9a');
    expect(p[slotOf('mach')]).toBe('#008276');
    expect(p[slotOf('altitude')]).toBe(tokens.chart.light['altitude']);
    el.remove();
    expect(chartPalette(null)).toEqual(CHART_TOKENS.map((t) => tokens.chart.light[t]));
    expect([...LIGHT_PALETTE]).toEqual(CHART_TOKENS.map((t) => tokens.chart.light[t]));
  });
});

describe('graphic contrast (3:1) on the surfaces charts really use, brand 1.0.3', () => {
  it('plot and panel surfaces are the stylesheet’s --surface-1 / --surface-2, not stale copies', () => {
    for (const mode of MODES) {
      expect(resolved(mode, '--surface-1'), `${mode} --surface-1`).toBe(PLOT[mode]);
      expect(resolved(mode, '--surface-2'), `${mode} --surface-2`).toBe(PANEL[mode]);
    }
  });

  // No exceptions any more: 1.0.3 gave drag and Mach dark hues that clear 3:1
  // on the navy plot AND the navy-raised panel (the pending #008300 was 2.45).
  it('every series clears 3:1 on its plot and its panel in light, dark and Daylight', () => {
    for (const mode of MODES) {
      paletteIn(mode).forEach((c, i) => {
        expect(contrast(c, PLOT[mode]), `${mode} ${CHART_TOKENS[i]} on plot`).toBeGreaterThanOrEqual(3);
        expect(contrast(c, PANEL[mode]), `${mode} ${CHART_TOKENS[i]} on panel`).toBeGreaterThanOrEqual(3);
      });
    }
  });

  // A chart never sits on navy-high (#1C476A), where dark Mach / drag are 3.17
  // / 3.18 — but a legend chip does, on hover (--hover), and a Daylight chip
  // that is on sits on --selected. Line samples clear 3:1 there too.
  it('legend samples clear 3:1 on the chip surfaces: --surface-3, --hover, Daylight --selected', () => {
    for (const mode of MODES) {
      const grounds = ['--surface-3', '--hover', ...(mode === 'daylight' ? ['--selected'] : [])]
        .map((v) => [v, resolved(mode, v)] as const);
      for (const [v, ground] of grounds) {
        expect(ground, `${mode} ${v}`).toMatch(/^#[0-9a-f]{6}$/);
        paletteIn(mode).forEach((c, i) => {
          expect(contrast(c, ground), `${mode} ${CHART_TOKENS[i]} on ${v}`).toBeGreaterThanOrEqual(3);
        });
      }
    }
    expect(resolved('dark', '--hover')).toBe(tokens.theme.dark['surface-2']);
  });

  it('the chart code carries no pending-1.0.3 exception', () => {
    const pending = ['pending', 'mmr-brand 1.0.3'].join(' ');
    for (const f of ['chartTheme.ts', 'flightChartModel.ts', 'chartLegend.ts', 'flightPlotEvents.ts',
      join('components', 'DragPanel.tsx'), join('components', 'FlightCharts.tsx'), join('components', 'ComparisonChart.tsx')]) {
      expect(read(f), f).not.toContain(pending);
    }
  });
});

describe('eight distinct line styles — colour is never the only cue', () => {
  const key = (d: readonly number[] | undefined) => (d ?? []).join(',');

  it('every slot draws its own style; no two slots share one (all pairs)', () => {
    expect(LINE_STYLES).toHaveLength(CHART_TOKENS.length);
    for (let a = 0; a < LINE_STYLES.length; a++) {
      for (let b = a + 1; b < LINE_STYLES.length; b++) {
        expect(key(LINE_STYLES[a]), `${CHART_TOKENS[a]} vs ${CHART_TOKENS[b]}`).not.toBe(key(LINE_STYLES[b]));
      }
      expect(lineStyle(a)).toBe(LINE_STYLES[a]);
    }
  });

  it('reference is the brand dash 6 4, and only altitude is solid', () => {
    expect(REFERENCE_DASH).toEqual([6, 4]);
    expect(lineStyle(slotOf('reference'))).toEqual([6, 4]);
    expect(LINE_STYLES.flatMap((d, i) => d ? [] : [CHART_TOKENS[i]])).toEqual(['altitude']);
  });

  it('a legend sample shows at least one whole period of every style', () => {
    for (const d of LINE_STYLES) if (d) expect(d.reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(SAMPLE_WIDTH);
  });

  // The per-component drag breakdown used C[i % 8]: component 9 became an
  // exact twin of component 1 (LEM-IV's two Rail Buttons). Repeats take the
  // next tier's style: a colour never meets the same style twice in 64 series.
  it('no two of the first 64 series share both colour and style', () => {
    for (const mode of MODES) {
      const palette = paletteIn(mode);
      const seen = new Set<string>();
      for (let i = 0; i < 64; i++) {
        const s = seriesStyle(i, palette);
        expect(s.stroke).toBe(palette[i % 8]);
        const k = `${s.stroke}|${key(s.dash)}`;
        expect(seen.has(k), `${mode} series ${i}`).toBe(false);
        seen.add(k);
      }
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
/** The smallest ΔE76 between two colours across normal, protan, deutan and tritan vision. */
const minDelta = (a: string, b: string) => Math.min(...CVD.map((m) => {
  const x = lab(a, m); const y = lab(b, m);
  return Math.hypot(...x.map((v, k) => v - y[k]!));
}));

// THE CVD GATE FOR CHARTS THAT SHOW MANY SERIES AT ONCE (the drag breakdown by
// component). Within the first 16 series (two tiers), two series that share a
// line style must be told apart by colour in every simulated vision (15 ΔE76)
// — so a pair hue alone cannot separate always differs in style.
it('within 16 series, a shared style only joins colours every vision separates', () => {
  const measured: Record<string, string> = {};
  for (const mode of MODES) {
    const palette = paletteIn(mode);
    let worst = Infinity;
    for (let i = 0; i < 16; i++) for (let j = i + 1; j < 16; j++) {
      const a = seriesStyle(i, palette); const b = seriesStyle(j, palette);
      if ((a.dash ?? []).join(',') !== (b.dash ?? []).join(',')) continue;
      const d = minDelta(a.stroke, b.stroke);
      worst = Math.min(worst, d);
      expect(d, `${mode} series ${i}/${j}`).toBeGreaterThanOrEqual(15);
    }
    const pairs: string[] = [];
    for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
      const d = minDelta(palette[a]!, palette[b]!);
      if (d < 15) pairs.push(`${CHART_TOKENS[a]}/${CHART_TOKENS[b]} ${d.toFixed(1)}`);
    }
    measured[mode] = `shared-style minimum ${worst.toFixed(1)}; hue-only pairs under 15: ${pairs.join('; ')}`;
  }
  console.info('Line-style CVD screen (ΔE76, min of normal/protan/deutan/tritan):', measured);
});

describe('the flight catalog maps each series by QUANTITY', () => {
  const load = async () => {
    const { seriesCatalog, arbitraryCatalog } = await import('./flightChartModel.js');
    const { METRIC_UNITS } = await import('./prefs/units.js');
    return { seriesCatalog, arbitraryCatalog, METRIC_UNITS };
  };
  const QUANTITY: Record<string, ChartToken> = {
    altitude: 'altitude', velocity: 'velocity', Vz: 'velocity', acceleration: 'acceleration',
    dynamicPressure: 'pressure', thrust: 'thrust', drag: 'drag', mach: 'mach',
    stability: 'reference', stabilityPercent: 'reference',
  };

  it('a quantity series takes its named token in every mode', async () => {
    const { seriesCatalog, METRIC_UNITS } = await load();
    for (const mode of MODES) {
      const palette = paletteIn(mode);
      const cat = seriesCatalog({ units: METRIC_UNITS }, palette);
      for (const [k, token] of Object.entries(QUANTITY)) {
        const d = cat.find((x) => x.key === k)!;
        expect(d.token, k).toBe(token);
        expect(d.color, `${mode} ${k}`).toBe(palette[slotOf(token)]);
      }
      // The first series of each quantity draws the token's own style.
      for (const k of ['altitude', 'velocity', 'acceleration', 'dynamicPressure', 'thrust', 'drag', 'mach', 'stability']) {
        const d = cat.find((x) => x.key === k)!;
        expect(d.dash, k).toEqual(lineStyle(slotOf(d.token!)));
      }
    }
  });

  it('stability (cal and %) is the reference series, dashed 6 4, and nothing else draws 6 4', async () => {
    const { seriesCatalog, METRIC_UNITS } = await load();
    const cat = seriesCatalog({ units: METRIC_UNITS }, LIGHT_PALETTE);
    expect(cat.filter((d) => (d.dash ?? []).join(',') === '6,4').map((d) => d.key)).toEqual(['stability', 'stabilityPercent']);
    // The roll-plane panel draws the stability margin outside seriesCatalog: the same token and dash there.
    const drag = read('components', 'DragPanel.tsx');
    const stabilityLines = drag.match(/label: '[^']*[Ss]tability[^']*', [^\n]*/g) ?? [];
    expect(stabilityLines).toHaveLength(1);
    expect(stabilityLines[0]).toContain("color: palette[slotOf('reference')]!, dash: REFERENCE_DASH");
  });

  // Non-quantities take the next free colour + style pair in slot order. Every
  // token is taken at tier 0, so they land on tier 1, in catalog order after
  // vertical velocity (velocity's tier 1).
  it('other series take free pairs in slot order; no colour + style pair repeats', async () => {
    const { seriesCatalog, arbitraryCatalog, METRIC_UNITS } = await load();
    const cat = seriesCatalog({ units: METRIC_UNITS }, LIGHT_PALETTE);
    const look = (k: string) => { const d = cat.find((x) => x.key === k)!; return [d.token, (d.dash ?? []).join(',')]; };
    expect(look('Vz')).toEqual(['velocity', (lineStyle(slotOf('velocity'), 1) ?? []).join(',')]);
    expect(Object.fromEntries(['mass', 'cpLocation', 'cgLocation', 'aoa', 'qAlpha'].map((k) => [k, look(k)[0]])))
      .toEqual({ mass: 'altitude', cpLocation: 'acceleration', cgLocation: 'pressure', aoa: 'thrust', qAlpha: 'drag' });
    for (const k of ['mass', 'cpLocation', 'cgLocation', 'aoa', 'qAlpha']) {
      const d = cat.find((x) => x.key === k)!;
      expect(d.dash, k).toEqual(lineStyle(slotOf(d.token!), 1));
    }
    const pairs = (defs: { key: unknown; color: string; dash?: number[] }[]) =>
      defs.filter((d) => d.key !== 'stabilityPercent').map((d) => `${d.color}|${(d.dash ?? []).join(',')}`);
    expect(new Set(pairs(cat)).size).toBe(pairs(cat).length);
    // The re-flown extras: quantities take their token, the rest the next free pair.
    const series = { time: [0, 1], altitude: [0, 1], ha: [1, 2], Vl: [0, 1], Az: [0, 1], P: [1, 2], Cd: [0.3, 0.4], Px: [0, 1] };
    const all = arbitraryCatalog(series as never, { units: METRIC_UNITS }, LIGHT_PALETTE);
    for (const [k, token] of [['ha', 'altitude'], ['Vl', 'velocity'], ['Az', 'acceleration'], ['P', 'pressure']] as const) {
      expect(all.find((d) => d.key === k)?.token, k).toBe(token);
    }
    const full = seriesCatalog({ units: METRIC_UNITS }, LIGHT_PALETTE);
    const extras = arbitraryCatalog({ ...series, ...Object.fromEntries(full.map((d) => [d.key, [0, 1]])) } as never,
      { units: METRIC_UNITS }, LIGHT_PALETTE);
    expect(new Set(pairs(extras)).size).toBe(pairs(extras).length);
  });

  it('comparison members keep their own look; no two members of a chart look alike', async () => {
    const { PRESETS, comparisonMembers, seriesCatalog } = await import('./flightChartModel.js');
    const { METRIC_UNITS } = await import('./prefs/units.js');
    for (const mode of MODES) {
      const cat = seriesCatalog({ units: METRIC_UNITS }, paletteIn(mode));
      for (const preset of PRESETS.filter((p) => p.x === 'time')) {
        const members = comparisonMembers(preset, cat);
        for (const m of members) expect(m.dash).toEqual(cat.find((d) => d.key === m.key)!.dash);
        for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
          expect((members[i]!.dash ?? []).join(','), `${mode} ${preset.id}`).not.toBe((members[j]!.dash ?? []).join(','));
        }
      }
    }
  });

  // The default plots (altitude, velocity, acceleration) are three titled
  // single-series panels; their hues must still be told apart at a glance by
  // full-colour vision (the hard 15 floor).
  it('the default altitude / velocity / acceleration set is separable', () => {
    for (const mode of MODES) {
      const p = paletteIn(mode);
      const slots = (['altitude', 'velocity', 'acceleration'] as const).map(slotOf);
      for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
        const a = lab(p[slots[i]!]!, CVD[0]!); const b = lab(p[slots[j]!]!, CVD[0]!);
        expect(Math.hypot(...a.map((v, k) => v - b[k]!)), `${mode} ${i}/${j}`).toBeGreaterThanOrEqual(15);
      }
    }
  });
});

describe('markers never look like a series', () => {
  it('series are drawn at least 2.5 px in every mode; markers are a solid 1 px hairline', () => {
    for (const mode of MODES) expect(Number(resolved(mode, '--chart-series-width')), mode).toBeGreaterThanOrEqual(2.5);
    // Event markers (flightPlotExtras.test draws them) and the worst-angle line.
    expect(read('flightPlotEvents.ts')).toMatch(/ctx\.lineWidth = ratio;[\s\S]*ctx\.setLineDash\(\[\]\)/);
    const drag = read('components', 'DragPanel.tsx');
    expect(drag).toContain('ctx.strokeStyle = ink.reference; ctx.lineWidth = ratio; ctx.setLineDash([]);');
    expect(drag).not.toMatch(/setLineDash\(\[\d/);
  });

  it('markers use --chart-reference, defined as the brand reference token', () => {
    expect(declared('light', '--chart-reference')).toBe('var(--mmr-chart-reference)');
    const el = document.createElement('div');
    el.style.setProperty('--chart-reference', '#a9c3d9');
    document.body.appendChild(el);
    expect(chartInk(el).reference).toBe('#a9c3d9');
    el.remove();
    expect(chartInk(null).reference).toBe(tokens.chart.light['reference']);
  });
});

describe('series labels are text-coloured, beside a line sample', () => {
  /** Every `color:` a rule with this exact selector sets. */
  const colorsOf = (selector: string) => {
    const out: string[] = [];
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of css.matchAll(new RegExp(`(?:^|\\n|,\\s*)${esc}\\s*\\{([^}]*)\\}`, 'g'))) {
      const c = /(?:^|[;\s])color:\s*([^;]+);/.exec(m[1]!)?.[1];
      if (c) out.push(c.trim());
    }
    return out;
  };

  it('legend, readout and chip labels set var(--text-primary)', () => {
    for (const sel of ['.chart-panel .u-legend', '.viz-root .u-legend', '.chart-tooltip-label',
      '.flight-series-legend .series-chip', ".viz-root[data-contrast='high'] .flight-series-legend .series-chip",
      '.series-chip-on']) {
      expect(colorsOf(sel), sel).toEqual(['var(--text-primary)']);
    }
    expect(css).toMatch(/\.line-sample line \{\s*stroke-width: var\(--chart-series-width\);/);
  });

  it('no chart code paints a label in a series colour', () => {
    for (const f of [join('components', 'FlightCharts.tsx'), join('components', 'ComparisonChart.tsx'),
      join('components', 'DragPanel.tsx'), 'chartTooltip.ts', 'chartLegend.ts']) {
      const src = read(f);
      expect(src, f).not.toMatch(/style=\{\{\s*color:\s*d\.color/);
      expect(src, f).not.toMatch(/\.style\.color\s*=/);
      expect(src, f).not.toContain('series-dot');
    }
    // An axis was inked in its single series' colour; its text is now the axis ink.
    expect(read('components', 'ComparisonChart.tsx')).not.toMatch(/stroke: defs\.length === 1 \? defs\[0\]!\.color/);
  });
});
