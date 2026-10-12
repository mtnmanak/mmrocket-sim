import { Note } from './Note.js';
import { validDelayResolution, type MountDelayRecord } from '../services/autoDelaySolver.js';
import { formatDelayBand, publishedDelayBand, PUBLISHED_DELAYS_URL } from '../services/publishedDelays.js';

export function autoDelayCardText(record: MountDelayRecord | undefined, current: boolean): string {
  if (!record || record.mode !== 'auto' || record.status !== 'resolved') return 'Auto delay not yet calculated.';
  // A resolved Auto record always carries its optimum and its branch's name
  // (the solver writes both; validDelayResolution refuses one without them).
  return `${current ? '' : 'Previous flight: '}Auto flew ${record.flownDelay} s · ballistic optimum ${record.rawOptimum!.toFixed(1)} s · ${record.branchName!}`
    + (record.caution ? `. ${record.caution}` : '');
}

/** Same persisted evidence supplies the report and mount cards. */
export function MountDelayReport({ resolution }: { resolution: unknown }) {
  if (!validDelayResolution(resolution)) return null;
  // AeroTech's published measured delays (ruled 2026-09-08): a column only when
  // some mount flew a motor and delay the certification tests fired, so a
  // report with nothing to show is unchanged.
  const bands = resolution.mounts.map((m) => publishedDelayBand(m.motorIdentity, m.flownDelay));
  const anyBand = bands.some((b) => b !== null);
  return <section aria-label="Per-mount ejection delays">
    <p className="simdet-delay">Auto targets each mount’s recovery-free branch apogee, rounded to a whole second.</p>
    <div style={{ overflowX: 'auto' }}>
      <table>
        <caption>Ejection delays by mount</caption>
        <thead><tr><th scope="col">Mount</th><th scope="col">Branch</th><th scope="col">Mode</th>
          <th scope="col">Ballistic optimum</th><th scope="col">Recommended</th><th scope="col">Flown delay</th>
          {anyBand && <th scope="col">Published test delays</th>}</tr></thead>
        <tbody>{resolution.mounts.map((m, i) => <tr key={m.mountId}>
          <th scope="row">{m.mountName}</th><td>{m.branchName ?? '—'}</td><td>{m.exception ? 'plugged → Auto (charge recovery)' : m.mode}</td>
          <td>{m.rawOptimum === null ? '—' : `${m.rawOptimum.toFixed(1)} s`}</td>
          <td>{m.recommendedDelay === null ? '—' : `${m.recommendedDelay} s`}</td>
          <td>{m.flownDelay === 'plugged' ? 'plugged' : `${m.flownDelay} s`}{m.caution && <Note as="p" tier="caution">{m.caution}</Note>}</td>
          {anyBand && <td>{bands[i] ? formatDelayBand(bands[i]) : '—'}</td>}
        </tr>)}</tbody>
      </table>
    </div>
    {anyBand && <p className="simdet-delay">
      Published test delays: the shortest and longest delay measured when that motor was fired at that delay setting in
      its certification tests, and how many motors were fired (<a href={PUBLISHED_DELAYS_URL} target="_blank" rel="noopener noreferrer">AeroTech’s
      published delay measurements</a>). The flight fires the charge at exactly the flown delay. A real charge can fire
      anywhere in that range, and the tests are a small sample of motors, not a guarantee: it can fire outside it too.
    </p>}
  </section>;
}
