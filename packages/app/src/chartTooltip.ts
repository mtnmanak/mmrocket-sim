import type uPlot from 'uplot';

/**
 * Point readout ("what is that sample worth?") for the uPlot charts, as a
 * uPlot plugin — flight panels and the drag panel share it.
 *
 * WHY, given the charts already carry a live legend: `legend: { live: true }`
 * does put the hovered sample's values on screen, but styles.css deliberately
 * mutes it (10.5px, opacity .8, secondary text) so it reads as a footnote,
 * and every value went through `toFixed(2)` (the flight panels) or
 * `toFixed(3)` (the drag breakdown) — which rounds Mach 0.0312 to "0.03" and
 * still flattens drag terms that differ in the fourth decimal. Reported
 * 2026-08-25: "it is very difficult to know the exact data for a point on the
 * chart just by looking at it." The legend stays (it
 * is the stable, always-visible readout); this adds the popup anchored AT the
 * sample, and both now format through `formatReadout`.
 *
 * Three things the wiring has to get right:
 *  - ONLY the panel under the pointer draws. The flight panels share a uPlot
 *    cursor-sync key, so every mounted panel gets `setCursor` when any one of
 *    them is hovered; without the pointer gate, hovering one chart would pop
 *    a tooltip on every one of them (the catalog has eleven).
 *  - `pointer-events: none` on the box (CSS). It sits inside `u.over`, which
 *    is exactly the element panZoomPlugin binds wheel/pointer gestures to —
 *    a tooltip that could take a hit would eat pans and zooms.
 *  - The box flips to the other side of the sample near the right or bottom
 *    edge rather than being clipped (tooltipPlacement, unit-tested).
 *
 * The arithmetic and formatting are pure functions below (tested in
 * chartTooltip.test.ts); the plugin is the DOM wiring, the same split
 * chartPanZoom.ts uses.
 */

/** Trailing-zero trim: "1.2300" → "1.23", "5.000" → "5". */
function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

/** Same trim inside an exponential's mantissa: "1.230000e+8" → "1.23e+8". */
function trimExponential(s: string): string {
  const cut = s.indexOf('e');
  return cut < 0 ? trimZeros(s) : trimZeros(s.slice(0, cut)) + s.slice(cut);
}

/**
 * A readout number: `sig` significant digits, trailing zeros trimmed, plain
 * decimal notation across the range flight data actually occupies.
 *
 * Significant digits rather than a fixed decimal count because one formatter
 * serves altitude in feet (10⁴), Mach (10⁻²) and a roll damping coefficient
 * (10⁻⁵) — `toFixed(2)` is three useful digits for the first and none for the
 * last. Six digits is the point where a double's decimal value stops being
 * the interesting question and the sample's own precision starts; exponential
 * notation takes over only outside 1e-4 … 1e7, where a plain decimal would be
 * a wall of zeros. Null/NaN (the kernel's "no value at this step", which the
 * CSV and xlsx exports write as an empty cell) reads as an en dash.
 */
export function formatReadout(v: number | null | undefined, sig = 6): string {
  if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return '–';
  if (v === 0) return '0';
  const magnitude = Math.abs(v);
  if (magnitude >= 1e7 || magnitude < 1e-4) {
    return trimExponential(v.toExponential(Math.max(0, sig - 1)));
  }
  const decimals = Math.min(12, Math.max(0, sig - 1 - Math.floor(Math.log10(magnitude))));
  return trimZeros(v.toFixed(decimals));
}

export interface Placement {
  left: number;
  top: number;
}

/**
 * Where the box goes, in plot-area pixels: gap to the lower-right of the
 * sample by default, flipped to the other side of whichever edge it would
 * overflow, then clamped inside the plot. A box wider or taller than the plot
 * area clamps to 0 rather than going negative (a 200px tooltip in a 160px-tall
 * collapsed panel is a real case — panelHeight's floor is 160).
 */
export function tooltipPlacement(
  anchorX: number,
  anchorY: number,
  boxW: number,
  boxH: number,
  plotW: number,
  plotH: number,
  gap = 12,
): Placement {
  let left = anchorX + gap;
  if (left + boxW > plotW) left = anchorX - gap - boxW;
  let top = anchorY + gap;
  if (top + boxH > plotH) top = anchorY - gap - boxH;
  return {
    left: Math.max(0, Math.min(left, Math.max(0, plotW - boxW))),
    top: Math.max(0, Math.min(top, Math.max(0, plotH - boxH))),
  };
}

/** One line of the readout: the series, its swatch color, its value there. */
export interface ReadoutRow {
  label: string;
  value: string;
  color: string;
}

/** The minimum of a uPlot series this module reads — keeps the pure half testable. */
export interface ReadoutSeries {
  label?: string;
  show?: boolean;
  stroke?: unknown;
}

/**
 * One row per SHOWN y-series carrying a finite sample at `idx`. Series 0 is
 * the x series and never gets a row (it is the heading). A hidden series —
 * the drag panel's legend toggles hide terms — is skipped, so the readout
 * always matches the lines actually drawn. A series whose sample is null at
 * this step is skipped too: the chart draws a gap there, and a row reading
 * "–" would suggest the line exists and is worth zero.
 */
export function readoutRows(
  series: readonly ReadoutSeries[],
  data: readonly (readonly (number | null | undefined)[])[],
  idx: number,
): ReadoutRow[] {
  const rows: ReadoutRow[] = [];
  for (let i = 1; i < series.length; i++) {
    const s = series[i]!;
    if (s.show === false) continue;
    const v = data[i]?.[idx];
    if (v == null || !Number.isFinite(v)) continue;
    rows.push({
      label: s.label ?? '',
      value: formatReadout(v),
      color: typeof s.stroke === 'string' ? s.stroke : 'currentColor',
    });
  }
  return rows;
}

/** The y pixel to anchor to: the first shown series' own point, else the cursor. */
function anchorTop(u: uPlot, idx: number): number {
  for (let i = 1; i < u.series.length; i++) {
    const s = u.series[i]!;
    if (s.show === false) continue;
    const v = (u.data[i] as (number | null)[] | undefined)?.[idx];
    if (v == null || !Number.isFinite(v)) continue;
    const key = s.scale ?? 'y';
    if (!u.scales[key]) break;
    return u.valToPos(v, key);
  }
  return u.cursor.top ?? 0;
}

/**
 * Anchored point readout. Add to a plot's `plugins`; it owns one absolutely
 * positioned child of `u.over` and removes it on destroy.
 */
export function tooltipPlugin(): uPlot.Plugin {
  let box: HTMLDivElement | null = null;
  let hovering = false;

  const hide = () => {
    if (box) box.style.display = 'none';
  };

  const draw = (u: uPlot) => {
    if (!box) return;
    const idx = u.cursor.idx;
    if (!hovering || idx == null) {
      hide();
      return;
    }
    const rows = readoutRows(
      u.series as readonly ReadoutSeries[],
      u.data as readonly (readonly (number | null | undefined)[])[],
      idx,
    );
    if (rows.length === 0) {
      hide();
      return;
    }

    const xVal = (u.data[0] as (number | null)[] | undefined)?.[idx];
    box.textContent = '';
    const head = document.createElement('div');
    head.className = 'chart-tooltip-x';
    const xLabel = u.series[0]?.label;
    head.textContent = xLabel ? `${xLabel} ${formatReadout(xVal)}` : formatReadout(xVal);
    box.appendChild(head);
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'chart-tooltip-row';
      const swatch = document.createElement('span');
      swatch.className = 'chart-tooltip-swatch';
      swatch.style.background = r.color;
      const label = document.createElement('span');
      label.className = 'chart-tooltip-label';
      label.textContent = r.label;
      const value = document.createElement('span');
      value.className = 'chart-tooltip-value';
      value.textContent = r.value;
      row.append(swatch, label, value);
      box.appendChild(row);
    }

    // Shown before measuring: a display:none box has no offset size.
    box.style.display = '';
    const place = tooltipPlacement(
      xVal == null || !Number.isFinite(xVal) ? (u.cursor.left ?? 0) : u.valToPos(xVal, 'x'),
      anchorTop(u, idx),
      box.offsetWidth,
      box.offsetHeight,
      u.over.clientWidth,
      u.over.clientHeight,
    );
    box.style.left = `${place.left}px`;
    box.style.top = `${place.top}px`;
  };

  return {
    hooks: {
      init: (u: uPlot) => {
        const over = u.over;
        box = document.createElement('div');
        box.className = 'chart-tooltip';
        // Decorative: the legend below the chart carries the same numbers in
        // the accessibility tree, and it is reachable without a pointer.
        box.setAttribute('aria-hidden', 'true');
        box.style.display = 'none';
        over.appendChild(box);
        // pointerenter/leave, not mouseenter/leave: the same gate then works
        // for a touch drag (panZoomPlugin pans on one-finger horizontal drag,
        // and the readout should follow that finger).
        over.addEventListener('pointerenter', () => { hovering = true; });
        over.addEventListener('pointerleave', () => { hovering = false; hide(); });
        over.addEventListener('pointercancel', () => { hovering = false; hide(); });
      },
      setCursor: (u: uPlot) => draw(u),
      destroy: () => {
        box?.remove();
        box = null;
        hovering = false;
      },
    },
  };
}
