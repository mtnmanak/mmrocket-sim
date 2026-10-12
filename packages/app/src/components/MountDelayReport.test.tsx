import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { DELAY_POLICY, delayMountsOf, solveAutoDelays } from '../services/autoDelaySolver.js';
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

/** A one-mount manual flight of `motorIdentity` at `delay`, as the runner records it. */
function manual(motorIdentity: string, flownDelay: number | 'plugged', mountName = 'Motor mount') {
  return {
    mountId: mountName, mountName, motorIdentity, mode: flownDelay === 'plugged' ? 'plugged' as const : 'manual' as const,
    flownDelay, rawOptimum: null, recommendedDelay: null, burnoutTime: null, apogeeTime: null,
    branchId: null, branchName: null, status: 'fixed' as const,
  };
}
const resolution = (...mounts: ReturnType<typeof manual>[]) => ({ policy: DELAY_POLICY, mounts, probes: 0, elapsedMs: 0 });
const F52C = '5f5e57811e865c0004c955d8';

it('fills a substituted Auto-delay caution, leaving a manual delay quiet', () => {
  const fixed = manual(F52C, 5);
  const html = renderToStaticMarkup(<MountDelayReport resolution={resolution(fixed)} />);
  expect(html).not.toContain('message-caution');
  const changed = renderToStaticMarkup(<MountDelayReport resolution={resolution({ ...fixed,
    ...{ caution: '0 s is used because the optimum precedes burnout.' },
  })} />);
  expect(changed).toContain('message-caution');
  expect(changed).toContain('0 s is used because the optimum precedes burnout.');
});

it("shows AeroTech's published measured band beside a delay its certification tests fired, and says what it is", () => {
  const html = renderToStaticMarkup(<MountDelayReport resolution={resolution(manual(F52C, 5))} />);
  expect(html).toContain('Published test delays');
  // The F52C letter: 4.946, 4.507, 5.158 s at the 5 s setting.
  expect(html).toContain('4.5–5.2 s (3 motors)');
  expect(html).toContain('AeroTech’s published delay measurements');
  expect(html).toContain('https://www.rocketmotorparts.com/page/nar-tra-certification-docs');
  expect(html).toMatch(/not a guarantee/);
});

it('shows no band, column or note where the data does not have that motor at that delay', () => {
  for (const r of [
    resolution(manual(F52C, 6)), // sold at 6 s, never tested there
    resolution(manual(F52C, 'plugged')),
    resolution(manual('AeroTech/F52C', 5)), // no catalogue motorId
  ]) {
    const html = renderToStaticMarkup(<MountDelayReport resolution={r} />);
    expect(html).toContain('Ejection delays by mount');
    expect(html).not.toContain('Published test delays');
    expect(html).not.toContain('published delay measurements');
  }
});

it('marks the mount with no band with a dash when another mount has one', () => {
  const html = renderToStaticMarkup(<MountDelayReport resolution={resolution(manual(F52C, 8, 'Core'), manual(F52C, 6, 'Outboard'))} />);
  // The F52C at 8 s: 7.239, 6.558, 7.341 s.
  expect(html).toContain('6.5–7.4 s (3 motors)');
  expect(html).toContain('<td>6 s</td><td>—</td></tr>');
});
