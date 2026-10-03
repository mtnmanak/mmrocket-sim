import type { SimRun } from '../services/simReport.js';
import { formatRunWhenProse } from '../services/simReport.js';
import { LOAD_WINDOW, type LoadPeak } from '../services/flightLoads.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, fmtSig, siToUi } from '../prefs/units.js';

/** The same reading in All stats and in the selected flight's report. */
export function FlightLoadStats({ run }: { run: SimRun }) {
  const { prefs } = usePrefs();
  const u = prefs.units;
  const digits = (v: number | null, places: number) => v != null && Number.isFinite(v) ? v.toFixed(places) : '—';
  const at = (p: LoadPeak) => `${digits(p.time, 3)} s; ${p.altitude == null ? '—' : fmtSi('distance', u.distance, p.altitude)} ${u.distance} AGL`;
  const pressure = (v: number) => Number.isFinite(v) ? fmtSig(siToUi('pressure', u.pressure, v), 4, 3) : '—';
  const q = run.loads?.maxQ, qa = run.loads?.maxQAlpha;
  const unavailable = run.loads ? 'Unavailable in this flight window' : 'Unavailable — launch again';
  return <div>
    <h3>Flight loads</h3>
    <p className="simdet-comments">Flown {formatRunWhenProse(run.when)}. {LOAD_WINDOW}.</p>
    <table className="fin-table"><tbody>
      <tr><td className="simdet-label">Max dynamic pressure (max Q)</td>
        <td>{q ? `${pressure(q.value)} ${u.pressure} at ${at(q)}` : unavailable}</td></tr>
      <tr><td className="simdet-label">Max q·α</td>
        <td>{qa ? `${pressure(qa.value)} ${u.pressure}·rad (${pressure(qa.value * 180 / Math.PI)} ${u.pressure}·°) at ${at(qa)}` : unavailable}</td></tr>
      {qa && <tr><td className="simdet-label">At max q·α</td>
        <td>Mach {digits(qa.mach, 3)}; α {digits(qa.aoa, 4)} rad ({qa.aoa == null ? '—' : digits(qa.aoa * 180 / Math.PI, 2)}°)</td></tr>}
    </tbody></table>
    <p className="simdet-comments">Normal force on the airframe scales with q·α at small angles of attack.
      This is an input to a structural loads check, not a loads check.</p>
  </div>;
}
