import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { batchDelayCell, PLUGGED_DELAY_MARK } from './BatchSimulate.js';
import { testMotor, testResolution } from '../services/autoDelay.testSupport.js';

it('r4 names the retained hypothetical charge without marking the charged candidate delay', () => {
  const delayResolution = testResolution([['candidate', testMotor(false, 7)], ['kept', testMotor(true, Infinity)]], [7, 9]);
  Object.assign(delayResolution.mounts[1]!, { mountName: 'Side mount', exception: 'plugged-on-charge' });
  const html = renderToStaticMarkup(<>{batchDelayCell({ delayS: 7, delayResolution }, true)}</>);
  expect(html).toContain('Hypothetical charge: Side mount: 9s');
  expect(html).not.toContain(`7s<span class="motor-db-meta">${PLUGGED_DELAY_MARK}`);
});

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
