import type uPlot from 'uplot';
import type { ChartInk } from './chartTheme.js';
import { ROLL_PITCH_BAND } from './flightChartModel.js';

/** Include the entire band, with breathing room, even for a nearly zero roll rate. */
export function rollPitchRange(_plot: uPlot, min: number | null, max: number | null): [number, number] {
  const low = Math.min(min !== null && Number.isFinite(min) ? min : 0, ROLL_PITCH_BAND[0]);
  const high = Math.max(max !== null && Number.isFinite(max) ? max : 0, ROLL_PITCH_BAND[1]);
  const pad = (high - low) * 0.05;
  return [low - pad, high + pad];
}

/** Neutral reference ink, after the grid and before series so unity stays visible. */
export function resonanceBandPlugin(ink: Pick<ChartInk, 'reference'>): uPlot.Plugin {
  return { hooks: { drawAxes: u => {
    const { ctx, bbox } = u;
    const top = u.valToPos(ROLL_PITCH_BAND[1], 'y', true);
    const bottom = u.valToPos(ROLL_PITCH_BAND[0], 'y', true);
    const middle = u.valToPos(1, 'y', true);
    ctx.save();
    ctx.beginPath(); ctx.rect(bbox.left, bbox.top, bbox.width, bbox.height); ctx.clip();
    ctx.fillStyle = ink.reference; ctx.globalAlpha = 0.12;
    ctx.fillRect(bbox.left, top, bbox.width, bottom - top);
    ctx.globalAlpha = 1; ctx.strokeStyle = ink.reference;
    ctx.lineWidth = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(bbox.left, middle); ctx.lineTo(bbox.left + bbox.width, middle); ctx.stroke();
    ctx.restore();
  } } };
}
