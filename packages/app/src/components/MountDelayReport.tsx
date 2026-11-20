import { Note } from './Note.js';
import { validDelayResolution, type MountDelayRecord } from '../services/autoDelaySolver.js';
import { formatDelayAverage, formatDelayBand, publishedDelayAverage, publishedDelayBand, PRINTED_AVERAGE_NOTE, PUBLISHED_DELAYS_URL } from '../services/publishedDelays.js';
import { delayReportMotorNames } from '../services/batchLoadout.js';
import type { SimRun } from '../services/simReport.js';
import { noteText } from '../services/noteField.js';

export function autoDelayCardText(record: MountDelayRecord | undefined, current: boolean): string {
  if (!record || record.mode !== 'auto' || record.status !== 'resolved') return 'Auto delay not yet calculated.';
  // A resolved Auto record always carries its optimum and its branch's name
  // (the solver writes both; validDelayResolution refuses one without them).
  return `${current ? '' : 'Previous flight: '}Auto flew ${record.flownDelay} s · ballistic optimum ${record.rawOptimum!.toFixed(1)} s · ${record.branchName!}`
    + (record.caution ? `. ${record.caution}` : '');
}

/** Same persisted evidence supplies the report and mount cards. */
export function MountDelayReport({ resolution, run, mountOrder }: {
  resolution: unknown; run?: Pick<SimRun, 'batch' | 'batchMounts'>; mountOrder?: readonly string[];
}) {
  if (!validDelayResolution(resolution)) return null;
  // Published measurements (2026-09-08) and separately labelled printed
  // averages (2026-11-15), only at the exact catalogue motor and flown setting.
  const bands = resolution.mounts.map((m) => publishedDelayBand(m.motorIdentity, m.flownDelay));
  const averages = resolution.mounts.map((m, i) => bands[i] ? null : publishedDelayAverage(m.motorIdentity, m.flownDelay));
  const anyBand = bands.some((b) => b !== null);
  const anyAverage = averages.some(a => a !== null);
  const anyPublished = anyBand || anyAverage;
  const motorNames = delayReportMotorNames(resolution.mounts, run, mountOrder);
  return <section aria-label="Per-mount ejection delays">
    <p className="simdet-delay">Auto targets each mount’s recovery-free branch apogee, rounded to a whole second.</p>
    <div style={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label="Ejection delays by mount">
      <table>
        <caption>Ejection delays by mount</caption>
        <thead><tr><th scope="col">Mount</th><th scope="col">Motor</th><th scope="col">Branch</th><th scope="col">Mode</th>
          <th scope="col">Ballistic optimum</th><th scope="col">Recommended</th><th scope="col">Flown delay</th>
          {anyPublished && <th scope="col">Published test delays</th>}</tr></thead>
        <tbody>{resolution.mounts.map((m, i) => <tr key={m.mountId}>
          <th scope="row">{m.mountName}</th><td>{noteText(motorNames?.get(m.mountId) ?? '—')}</td><td>{m.branchName ?? '—'}</td><td>{m.exception ? 'Auto (hypothetical charge)' : m.mode}</td>
          <td>{m.rawOptimum === null ? '—' : `${m.rawOptimum.toFixed(1)} s`}</td>
          <td>{m.recommendedDelay === null ? '—' : `${m.recommendedDelay} s`}</td>
          <td>{m.flownDelay === 'plugged' ? 'plugged' : `${m.flownDelay} s`}
            {/* The charge this delay fires is one the motor as sold does not
                have: said IN the flown-delay cell (D7 §5, L20/M16), so
                "plugged" never reads as hardware supplying it. */}
            {m.exception === 'plugged-on-charge' && <span className="simdet-delay-mark"> · hypothetical charge (motor sold plugged)</span>}
            {/* Auto's earliest-possible charge, said in the row (D7 §5, M17). */}
            {m.mode === 'auto' && m.rawOptimum !== null && m.rawOptimum < 0
              && <span className="simdet-delay-mark"> · limited by burnout</span>}
            {m.caution && <Note as="p" tier="caution">{m.caution}</Note>}</td>
          {anyPublished && <td>{bands[i] ? formatDelayBand(bands[i]) : averages[i] ? formatDelayAverage(averages[i]) : '—'}</td>}
        </tr>)}</tbody>
      </table>
    </div>
    {anyBand && <p className="simdet-delay">
      Published test delays: the shortest and longest delay measured when that motor was fired at that delay setting in
      its certification tests, and how many motors were fired (<a href={PUBLISHED_DELAYS_URL} target="_blank" rel="noopener noreferrer">AeroTech’s
      published delay measurements</a>). The flight fires the charge at exactly the flown delay. A real charge can fire
      anywhere in that range, and the tests are a small sample of motors, not a guarantee: it can fire outside it too.
    </p>}
    {anyAverage && <p className="simdet-delay">{PRINTED_AVERAGE_NOTE}{' '}
      Source: <a href={PUBLISHED_DELAYS_URL} target="_blank" rel="noopener noreferrer">AeroTech’s certification documents</a>.
    </p>}
  </section>;
}
