/**
 * TN D-4013 p.4 accuracies, combined by the RSS / upward-rounding rule in
 * scorecard-finsoff-figs-2026-08-25.md section 3.1. CD and Mach are dimensionless.
 * Use the larger absolute adjacent secant on the full read curve (including
 * fairing reads); endpoints use their sole secant. This avoids cancelling the
 * rise and fall at a peak. Round RSS upward to the next 0.001 in CD.
 */
import { readFileSync } from 'node:fs';
import { isMain } from '../../scripts/is-main.mjs';

export function finsOnBudgets(points) {
  return points.map(([mach, value], i) => {
    const slopes = [];
    for (const j of [i - 1, i + 1]) {
      if (points[j]) slopes.push(Math.abs((points[j][1] - value) / (points[j][0] - mach)));
    }
    const slope = Math.max(...slopes);
    const rss = Math.hypot(0.004, 0.01 * 0.4225, 0.004, 0.003 * slope);
    const tolerance = Math.ceil(rss * 1000) / 1000;
    if (tolerance > 0.03) throw new Error(`M${mach}: budget ${tolerance} would widen the old 0.03`);
    return { mach, value, slope, rss, tolerance };
  });
}

if (isMain(import.meta.url)) {
  const anchors = JSON.parse(readFileSync(new URL('../anchors.json', import.meta.url), 'utf8'));
  for (const cell of ['arcas-short', 'arcas-short-nosection', 'arcas-long']) {
    const series = anchors[cell].series.filter(s => ['cd-transonic-tunnel', 'cd-transonic-fairing'].includes(s.id));
    const points = series.flatMap(s => s.points).sort(([a], [b]) => a - b);
    const gated = series.find(s => s.id === 'cd-transonic-tunnel').points.map(([m]) => m);
    for (const budget of finsOnBudgets(points).filter(p => gated.includes(p.mach))) {
      console.log(JSON.stringify({ cell, ...budget }));
    }
  }
}
