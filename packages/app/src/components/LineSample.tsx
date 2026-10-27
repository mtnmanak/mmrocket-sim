import { SAMPLE_HEIGHT, SAMPLE_WIDTH } from '../chartLegend.js';

/**
 * A short sample of a series' line — its colour AND its dash — set beside the
 * series name, which stays in the text colour (chartLegend.ts says why).
 * Decorative: the name beside it is the accessible label.
 */
export function LineSample({ color, dash }: { color: string; dash?: readonly number[] }) {
  return <svg className="line-sample" width={SAMPLE_WIDTH} height={SAMPLE_HEIGHT}
    viewBox={`0 0 ${SAMPLE_WIDTH} ${SAMPLE_HEIGHT}`} aria-hidden="true" focusable="false">
    <line x1="0" y1={SAMPLE_HEIGHT / 2} x2={SAMPLE_WIDTH} y2={SAMPLE_HEIGHT / 2} stroke={color}
      strokeDasharray={dash?.length ? dash.join(' ') : undefined} />
  </svg>;
}
