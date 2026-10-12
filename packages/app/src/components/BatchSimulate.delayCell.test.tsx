import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { batchDelayCell, PLUGGED_DELAY_MARK } from './BatchSimulate.js';

/**
 * D7 §5, L20: a plugged-only motor flown at its optimum fires a charge the
 * motor as sold does not have. The row's own Delay cell says so beside the
 * number — the paragraph above the table is not the only place.
 */
it('says "hypothetical charge" in the Delay cell of a plugged motor flown at its optimum, and nowhere else', () => {
  const cell = (run: { delayS: number } | undefined, plugged?: boolean) => renderToStaticMarkup(<>{batchDelayCell(run, plugged)}</>);
  expect(cell({ delayS: 8 }, true)).toBe(`8s<span class="motor-db-meta">${PLUGGED_DELAY_MARK}</span>`);
  expect(PLUGGED_DELAY_MARK).toMatch(/hypothetical charge/);
  expect(cell({ delayS: 8 })).toBe('8s');
  expect(cell({ delayS: Infinity })).toBe('P');
  expect(cell(undefined)).toBe('—');
});
