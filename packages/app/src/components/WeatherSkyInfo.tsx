import { estimatedCloudBaseM, type HourSample } from '../services/openMeteo.js';
import { altitudeText, visibilityText } from './weatherText.js';

/** Display only: no apply controls, thresholds, verdicts or persistence. */
export function WeatherSkyInfo({ sample, distanceUnit }: { sample: HourSample; distanceUnit: string }) {
  const base = estimatedCloudBaseM(sample.temperatureC, sample.dewPointC);
  if (sample.cloudCoverPct == null && sample.cloudCoverLowPct == null && sample.visibilityM == null && base === null) return null;
  return (
    <section aria-label="Cloud and visibility information">
      <h4>Clouds and visibility — information only</h4>
      <ul className="weather-context">
        {sample.cloudCoverPct != null && <li>Cloud cover (total): {sample.cloudCoverPct}%</li>}
        {sample.cloudCoverLowPct != null && <li>Cloud cover (low): {sample.cloudCoverLowPct}%</li>}
        {sample.visibilityM != null && <li>Visibility: {visibilityText(distanceUnit, sample.visibilityM)}</li>}
        {base !== null && <li>Cloud base (estimate): {altitudeText(distanceUnit, base)} above the site.</li>}
      </ul>
      {base !== null && <p className="weather-small">The estimate uses the surface temperature/dew-point spread for lifted air.
        It is not an observed ceiling and does not establish whether clouds are present.</p>}
      <p className="weather-small">For reference: <a href="https://www.ecfr.gov/current/title-14/chapter-I/subchapter-F/part-101/subpart-C/section-101.25"
        target="_blank" rel="noopener noreferrer">14 CFR 101.25(a)–(c)</a> says Class 2-High Power Rockets and
        Class 3-Advanced High Power Rockets must not operate:</p>
      {/* Verbatim eCFR clauses, read 2026-10-06. These are references, never comparisons. */}
      <ul className="weather-context">
        <li>“At any altitude where clouds or obscuring phenomena of more than five-tenths coverage prevails;”</li>
        <li>“At any altitude where the horizontal visibility is less than five miles;”</li>
        <li>“Into any cloud;”</li>
      </ul>
      <p className="weather-small">These model values do not describe conditions at every altitude and are not a go/no-go.
        The waiver holder / RSO decides. These readouts are not applied to launch conditions.</p>
    </section>
  );
}
