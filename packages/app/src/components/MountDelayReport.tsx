import { validDelayResolution, type MountDelayRecord } from '../services/autoDelaySolver.js';

export function autoDelayCardText(record: MountDelayRecord | undefined, current: boolean): string {
  if (!record || record.mode !== 'auto' || record.status !== 'resolved') return 'Auto delay not yet calculated.';
  return `${current ? '' : 'Previous flight: '}Auto flew ${record.flownDelay} s · ballistic optimum ${record.rawOptimum!.toFixed(1)} s · ${record.branchName}`
    + (record.caution ? `. ${record.caution}` : '');
}

/** Same persisted evidence supplies the report and mount cards. */
export function MountDelayReport({ resolution }: { resolution: unknown }) {
  if (!validDelayResolution(resolution)) return null;
  return <section aria-label="Per-mount ejection delays">
    <p className="simdet-delay">Auto targets each mount’s recovery-free branch apogee, rounded to a whole second.</p>
    <div style={{ overflowX: 'auto' }}>
      <table>
        <caption>Ejection delays by mount</caption>
        <thead><tr><th scope="col">Mount</th><th scope="col">Branch</th><th scope="col">Mode</th>
          <th scope="col">Ballistic optimum</th><th scope="col">Recommended</th><th scope="col">Flown delay</th></tr></thead>
        <tbody>{resolution.mounts.map((m) => <tr key={m.mountId}>
          <th scope="row">{m.mountName}</th><td>{m.branchName ?? '—'}</td><td>{m.exception ? 'plugged → Auto (charge recovery)' : m.mode}</td>
          <td>{m.rawOptimum === null ? '—' : `${m.rawOptimum.toFixed(1)} s`}</td>
          <td>{m.recommendedDelay === null ? '—' : `${m.recommendedDelay} s`}</td>
          <td>{m.flownDelay === 'plugged' ? 'plugged' : `${m.flownDelay} s`}{m.caution && <p>{m.caution}</p>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}
