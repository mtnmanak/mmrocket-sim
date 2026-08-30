/**
 * Ruler tick generation for the 2D design view — a faithful port of the
 * desktop's `GeneralUnit.getTicks(start, end, minor, major)`
 * (info.openrocket.core.unit.GeneralUnit:113-186, 24.12), so a ruler drawn
 * here lands its ticks exactly where desktop OpenRocket lands them.
 *
 * The desktop calls it with `minor = 3 px / scale` and `major = 30 px / scale`
 * (ScaleScrollPane.MINOR_TICKS / MAJOR_TICKS), i.e. "the smallest round step
 * that is at least 3 px apart" and "…at least 30 px apart". Everything here
 * works in DISPLAY units (mm/cm/m/in/ft) — the caller converts, because the
 * step ladder has to be round in the unit the user reads, not in metres.
 *
 * Four tick grades come out, matching the desktop's `Tick` record:
 *   major + notable  — long tick, bold label
 *   major            — long tick, plain label
 *   notable (minor)  — medium tick, no label
 *   minor            — short tick, no label
 */

export interface RulerTick {
  /** Position in display units. */
  value: number;
  major: boolean;
  notable: boolean;
}

/**
 * Runaway guard. The desktop is safe because `minor` is pixel-derived and the
 * canvas is finite; a browser can hand us a degenerate scale (a zero-length
 * rocket, a container measured at 0 px mid-layout) and spin forever. 4000 is
 * far more than any real ruler needs — a 1920 px canvas at the 3 px minimum
 * spacing is 640.
 */
const MAX_TICKS = 4000;

/**
 * Ticks in [start, end], both in display units.
 *
 * @param minor smallest allowed spacing between ticks (display units)
 * @param major smallest allowed spacing between LABELLED ticks (display units)
 */
export function rulerTicks(start: number, end: number, minor: number, major: number): RulerTick[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  if (!(minor > 0) || !(major > 0) || major < minor) return [];

  // --- smallest round step that is at least `minor` ---
  let one = 1;
  while (one > minor) one /= 10;
  while (one < minor) one *= 10;
  // `one` is now the smallest round-ten >= minor.
  let minstep: number;
  let mod2: number; // every mod2'th minor tick is "notable"
  if (one / 2 >= minor) {
    minstep = one / 2;
    mod2 = 2;
  } else {
    minstep = one;
    mod2 = 10;
  }

  // --- step for the labelled (major) ticks ---
  one = 1;
  while (one > major) one /= 10;
  while (one < major) one *= 10;
  let mod3: number; // every mod3'th minor tick is major
  let mod4: number; // every mod4'th is major AND notable (bold)
  if (one / 2 >= major) {
    const majorstep = one / 2;
    mod3 = Math.round(majorstep / minstep);
    mod4 = mod3 * 2;
  } else {
    mod3 = Math.round(one / minstep);
    mod4 = mod3 * 10;
  }
  // A minor-notable that lands on every major tick reads as noise; the
  // desktop demotes it the same way.
  if (mod3 === mod2) mod2 = mod2 === 2 ? 1 : 5;

  const out: RulerTick[] = [];
  let pos = Math.ceil(start / minstep);
  // Guard against a NaN/±Infinity start surviving the checks above.
  if (!Number.isFinite(pos)) return [];
  while (pos * minstep <= end) {
    // Recompute from the integer index, never by accumulation: `0.1 * 3`
    // drifts and puts a "0.30000000000000004" label on the ruler.
    const value = pos * minstep;
    if (pos % mod4 === 0) out.push({ value, major: true, notable: true });
    else if (pos % mod3 === 0) out.push({ value, major: true, notable: false });
    else if (pos % mod2 === 0) out.push({ value, major: false, notable: true });
    else out.push({ value, major: false, notable: false });
    pos++;
    if (out.length >= MAX_TICKS) break;
  }
  return out;
}

/**
 * Tick label: the value with just enough decimals to be distinct, trailing
 * zeros stripped. `minstep` is not passed in — the step ladder is always a
 * round 1/2/5×10^n, so six decimals of rounding removes the float dust
 * (`0.30000000000000004` → `0.3`) without ever losing a real digit.
 */
export function formatTickLabel(value: number): string {
  const v = Number(value.toFixed(6));
  // -0 prints as "-0"; the ruler's origin is not negative.
  if (v === 0) return '0';
  return String(v);
}

/** Smallest tick spacing, in px — desktop's ScaleScrollPane.MINOR_TICKS. */
export const MINOR_TICK_PX = 3;
/** Smallest LABELLED spacing, in px — desktop's ScaleScrollPane.MAJOR_TICKS. */
export const MAJOR_TICK_PX = 30;

export interface RulerMark {
  /** Position along the ruler, in the same px space as `originPx`. */
  px: number;
  /** Tick length in px, measured in from the ruler's inner edge. */
  len: number;
  /** Present only on major ticks. */
  label: string | null;
  /** A "notable" major tick — drawn bold, the desktop's decade marks. */
  bold: boolean;
}

/**
 * Turn a view transform into drawable ruler marks.
 *
 * Both axes are handled by one function because the only difference is the
 * sign of `pxPerUnit`: the horizontal ruler's model axis grows rightwards with
 * SVG x, the vertical ruler's grows UPWARDS against it.
 *
 * @param originPx  px position of model value 0
 * @param pxPerUnit px per one DISPLAY unit (negative if the axis runs backwards)
 * @param px0/px1   the visible window, in px (px0 < px1)
 * @param size      gutter thickness in px; tick lengths are fractions of it
 */
export function rulerLayout(
  originPx: number, pxPerUnit: number, px0: number, px1: number, size: number,
): RulerMark[] {
  if (!Number.isFinite(originPx) || !Number.isFinite(pxPerUnit) || pxPerUnit === 0) return [];
  if (!Number.isFinite(px0) || !Number.isFinite(px1) || px1 <= px0) return [];
  const at = (px: number) => (px - originPx) / pxPerUnit;
  const a = at(px0);
  const b = at(px1);
  const scale = Math.abs(pxPerUnit);
  const ticks = rulerTicks(
    Math.min(a, b), Math.max(a, b), MINOR_TICK_PX / scale, MAJOR_TICK_PX / scale,
  );
  return ticks.map((t) => ({
    px: originPx + t.value * pxPerUnit,
    len: t.major ? size / 2 : t.notable ? size / 3 : size / 6,
    label: t.major ? formatTickLabel(t.value) : null,
    bold: t.major && t.notable,
  }));
}
