import type { DesktopStoredPrediction } from '../services/orkFile.js';
import type { SimRun } from '../services/simReport.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, type Quantity } from '../prefs/units.js';
import { Note } from './Note.js';

const SUMMARY_FIELDS: [keyof DesktopStoredPrediction['data'], keyof SimRun, string, Quantity | null][] = [
  ['maxAltitude', 'maxAltitude', 'Max altitude', 'distance'],
  ['maxVelocity', 'maxVelocity', 'Max velocity', 'velocity'],
  ['maxAcceleration', 'maxAcceleration', 'Max acceleration', 'acceleration'],
  ['maxMach', 'maxMach', 'Max Mach', null],
  ['timeToApogee', 'timeToApogee', 'Time to apogee (s)', null],
  ['flightTime', 'totalFlightTime', 'Total flight time (s)', null],
  ['groundHitVelocity', 'groundHitVelocity', 'Ground hit velocity', 'velocity'],
  ['launchRodVelocity', 'rodExitVelocity', 'Rod exit velocity', 'velocity'],
  ['deploymentVelocity', 'lastDeploymentGroundSpeed', 'Last deployment ground speed', 'velocity'],
  ['optimumDelay', 'lastBurnoutOptimalDelayS', 'Optimal delay from last burnout (s)', null],
];

/** File-owned history, grouped by configuration identity rather than names. */
export function DesktopPredictions({ predictions, configId, run }: {
  predictions?: readonly DesktopStoredPrediction[];
  configId: string | null;
  run?: SimRun | null;
}) {
  const { prefs } = usePrefs();
  const matching = predictions?.filter(p => p.status !== 'external' && (p.configId === null || p.configId === configId)) ?? [];
  if (!matching.length) return null;
  const format = (value: unknown, quantity: Quantity | null) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return quantity ? `${fmtSi(quantity, prefs.units[quantity], value)} ${prefs.units[quantity]}` : value.toFixed(2);
  };
  return <section className="panel comparison-panel desktop-predictions" aria-label="Desktop OpenRocket stored predictions">
    <div className="panel-head"><h2>Desktop OpenRocket stored predictions</h2></div>
    <Note as="p" tier="information" className="download-caption">
      These stored predictions may describe older settings. They are not used as simulation inputs.
      {' '}Last deployment ground speed compares the final deployment in each simulation, rather than the first opening speed in the app's recovery report. Older app runs without this recorded value show —.
      {' '}Optimal delay from last burnout compares the time from the last motor burnout to apogee with recovery disabled. It can differ from the primary mount's Auto delay, which starts at that mount's burnout. Older app runs without the separately recorded value show —.
    </Note>
    {matching.map((prediction, index) => {
      const app = prediction.configId !== null && run && !run.importedSummary && run.flightConfigId === prediction.configId ? run : null;
      return <details key={index}>
        <summary>{prediction.name || `Simulation ${index + 1}`} · Desktop OpenRocket{prediction.sourceVersion ? ` ${prediction.sourceVersion}` : ' (version not recorded)'}</summary>
        <Note as="p" tier="information" className="download-caption">
          {prediction.configId === null ? 'Configuration identity was not recorded; no app comparison is available.'
            : 'The configuration ID is the same; the design, motors and launch conditions may differ.'}
        </Note>
        <div className="comparison-table-scroll" tabIndex={0} role="region" aria-label={`Stored prediction ${prediction.name || index + 1}`}>
          <table>
            <thead><tr><th scope="col">Summary</th><th scope="col">Desktop OpenRocket</th><th scope="col">The app{app ? ' (shown run)' : ' (no run shown)'}</th></tr></thead>
            <tbody>{SUMMARY_FIELDS.map(([desktopKey, appKey, label, quantity]) => <tr key={desktopKey}>
              <th scope="row">{label}</th><td>{format(prediction.data[desktopKey], quantity)}</td><td>{format(app?.[appKey], quantity)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>;
    })}
  </section>;
}
