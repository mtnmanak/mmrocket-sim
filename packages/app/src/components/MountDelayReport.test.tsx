import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { delayMountsOf, solveAutoDelays } from '../services/autoDelaySolver.js';
import { probeFlight, testMotor } from '../services/autoDelay.testSupport.js';
import { autoDelayCardText, MountDelayReport } from './MountDelayReport.js';

it('shows per-mount evidence, an honest empty state and a previous-flight label', async () => {
  const r = await solveAutoDelays({ mounts: delayMountsOf([['a', testMotor()], ['b', testMotor()]]),
    budget: { probes: 0 }, probe: () => probeFlight(), yieldToUi: async () => {} });
  expect(autoDelayCardText(undefined, false)).toBe('Auto delay not yet calculated.');
  expect(autoDelayCardText(r.mounts[1], true)).toBe('Auto flew 7 s · ballistic optimum 7.0 s · Duplicate name');
  expect(autoDelayCardText(r.mounts[1], false)).toMatch(/^Previous flight:/);
  const html = renderToStaticMarkup(<MountDelayReport resolution={r} />);
  expect(html).toContain('Ejection delays by mount');
  expect(html).toContain('10 s'); expect(html).toContain('7 s');
  expect(html).toContain('recovery-free branch apogee');
  expect(renderToStaticMarkup(<MountDelayReport resolution={{}} />)).toBe('');
});
