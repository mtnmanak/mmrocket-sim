import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import * as exMotors from '../services/exMotors.js';
import { DELAY_POLICY, delayMountsOf, LATE_BURNOUT_CAUTION, solveAutoDelays } from '../services/autoDelaySolver.js';
import { probeFlight, testMotor } from '../services/autoDelay.testSupport.js';
import { autoDelayCardText, MountDelayReport } from './MountDelayReport.js';
import delayData from '../data/aerotechDelays.json';
import { formatDelayAverage, PRINTED_AVERAGE_NOTE } from '../services/publishedDelays.js';
import * as publishedDelays from '../services/publishedDelays.js';

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
it('Round 7 preserves typographic quotes in the resolved Motor column', () => {
  const html = renderToStaticMarkup(<MountDelayReport resolution={resolution(manual('Home/“K500”', 5, '3” MMT'))} />);
  expect(html).toContain('<th scope="row">3” MMT</th><td>“K500”</td>');
  expect(html).not.toContain('[U+201');
});
it('Round 5 resolves the whole delay table for different makers and EX identities', () => {
  const ex = exMotors.parseEng('K500 54 300 P 0.1 0.2 Home\n0 0\n0.5 500\n1 0')[0]!;
  const spy = vi.spyOn(exMotors, 'getExMotor').mockReturnValue(ex);
  try {
    const r = resolution(...['Estes/C6', 'Klima/C6', 'ex:alpha', 'ex:beta'].map((id, i) => manual(id, 5, `MMT ${i}`)));
    const html = renderToStaticMarkup(<MountDelayReport resolution={r} />);
    for (const name of ['Estes C6', 'Klima C6', 'EX K500 (1)', 'EX K500 (2)']) expect(html).toContain(`<td>${name}</td>`);
  } finally { spy.mockRestore(); }
});
it('Round 5 omits all resolved motor cells when an EX name exceeds the display bound', () => {
  const ex = exMotors.parseEng('K500 54 300 P 0.1 0.2 Home\n0 0\n0.5 500\n1 0')[0]!;
  const spy = vi.spyOn(exMotors, 'getExMotor').mockReturnValue({ ...ex, designation: 'K'.repeat(1_000_000) });
  try {
    const html = renderToStaticMarkup(<MountDelayReport resolution={resolution(manual('ex:oversized-round5', 5))} />);
    expect(html).toContain('<th scope="row">Motor mount</th><td>—</td>');
    expect(html.length).toBeLessThan(5000);
  } finally { spy.mockRestore(); }
});
const F52C = '5f5e57811e865c0004c955d8';

it('prefers a measured band even if an average lookup could supply a figure', () => {
  const spy = vi.spyOn(publishedDelays, 'publishedDelayAverage').mockReturnValue({
    designation: 'Fixture', nominalS: 5, averageS: 4.34, url: 'https://example.invalid/cert.pdf',
  });
  try {
    const html = renderToStaticMarkup(<MountDelayReport resolution={resolution(manual(F52C, 5))} />);
    expect(html).toContain('4.5–5.2 s (3 motors)');
    expect(html).not.toContain('printed average only');
  } finally { spy.mockRestore(); }
});

it('keeps the band explanation out of a table supplied only with a printed average', () => {
  const spy = vi.spyOn(publishedDelays, 'publishedDelayAverage').mockReturnValue({
    designation: 'Fixture', nominalS: 5, averageS: 4.34, url: 'https://example.invalid/cert.pdf',
  });
  try {
    const html = renderToStaticMarkup(<MountDelayReport resolution={resolution(manual('fixture-average', 5))} />);
    expect(html).toContain('Published test delays');
    expect(html).toContain('4.3 s (printed average only)');
    expect(html).toContain(PRINTED_AVERAGE_NOTE.replaceAll("'", '&#x27;'));
    expect(html).toContain('The flight fires the charge at exactly the flown delay.');
    expect(html).toContain(`<a href="${publishedDelays.PUBLISHED_DELAYS_URL}" target="_blank" rel="noopener noreferrer">AeroTech’s certification documents</a>`);
    expect(html).not.toContain('shortest and longest');
  } finally { spy.mockRestore(); }
});

it('shows a printed average and its safety note without implying a measured band', () => {
  const [id, motor] = Object.entries(delayData.averages)[0]!;
  const delay = motor.delays[0]!;
  const html = renderToStaticMarkup(<MountDelayReport resolution={resolution(manual(id, delay.nominalS))} />);
  expect(html).toContain('Published test delays');
  expect(html).toContain(formatDelayAverage(delay));
  expect(html).toContain(PRINTED_AVERAGE_NOTE.replaceAll("'", '&#x27;'));
  expect(html).not.toContain('shortest and longest');
  const absent = renderToStaticMarkup(<MountDelayReport resolution={resolution(manual(id, delay.nominalS + 0.1))} />);
  expect(absent).not.toContain('Published test delays');
  expect(absent).not.toContain('Printed average only:');
});

it('keeps both explanations and band precedence in a mixed table', () => {
  const [id, motor] = Object.entries(delayData.averages)[0]!;
  const html = renderToStaticMarkup(<MountDelayReport resolution={resolution(
    manual(id, motor.delays[0]!.nominalS, 'Average'), manual(F52C, 5, 'Band'),
  )} />);
  expect(html).toContain('Printed average only:');
  expect(html).toContain('shortest and longest');
  expect(html).toContain('4.5–5.2 s (3 motors)');
  const rows = html.match(/<tr><th scope="row">.*?<\/tr>/g)!;
  expect(rows).toHaveLength(2);
  expect(rows[0]).toContain(`<th scope="row">Average</th>`);
  expect(rows[0]).toContain(`<td>${formatDelayAverage(motor.delays[0]!)}</td></tr>`);
  expect(rows[1]).toContain('<th scope="row">Band</th>');
  expect(rows[1]).toContain('<td>4.5–5.2 s (3 motors)</td></tr>');
});

it('puts the resolved Motor immediately after Mount', () => {
  const html = renderToStaticMarkup(<MountDelayReport resolution={resolution(manual('AeroTech/K1499N', 5, 'MMT 2'))} />);
  expect(html).toContain('<th scope="col">Mount</th><th scope="col">Motor</th><th scope="col">Branch</th>');
  expect(html).toContain('<th scope="row">MMT 2</th><td>K1499N</td><td>—</td><td>manual</td>');
});

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

it('says "hypothetical charge" in the flown-delay cell of a plugged motor flown on Auto (D7 §5, L20/M16)', () => {
  const auto = { ...manual(F52C, 7), mode: 'auto' as const, rawOptimum: 7.25, recommendedDelay: 7, status: 'resolved' as const,
    burnoutTime: 1.5, apogeeTime: 8.75, branchId: 'b', branchName: 'Sustainer' };
  const probed = (m: object) => ({ ...resolution(m as never), probes: 1 });
  const plugged = renderToStaticMarkup(<MountDelayReport resolution={probed({ ...auto, exception: 'plugged-on-charge' })} />);
  expect(plugged).toMatch(/<td>7 s<span class="simdet-delay-mark"> · hypothetical charge \(motor sold plugged\)<\/span><\/td>/);
  expect(plugged).toContain('Auto (hypothetical charge)');
  expect(plugged).not.toContain('charge recovery');
  const plain = renderToStaticMarkup(<MountDelayReport resolution={probed(auto)} />);
  expect(plain).toContain('<td>7 s</td>');
  expect(plain).not.toContain('hypothetical charge');
});

it('says "limited by burnout" in the flown-delay cell when Auto could only use 0 s (D7 §5, M17)', () => {
  const late = { ...manual(F52C, 0), mode: 'auto' as const, rawOptimum: -0.5, recommendedDelay: 0, status: 'resolved' as const,
    burnoutTime: 3, apogeeTime: 2.5, branchId: 'b', branchName: 'Sustainer', caution: LATE_BURNOUT_CAUTION };
  const html = renderToStaticMarkup(<MountDelayReport resolution={{ ...resolution(late as never), probes: 1 }} />);
  expect(html).toMatch(/<td>0 s<span class="simdet-delay-mark"> · limited by burnout<\/span>/);
  expect(html).toContain(LATE_BURNOUT_CAUTION.replace("'", '&#x27;'));
});
