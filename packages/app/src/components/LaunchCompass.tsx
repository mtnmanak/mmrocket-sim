import { flownRodAimDeg, type LaunchConditions } from '../services/launchConditions.js';
import { compassPoint } from '../services/openMeteo.js';
import { Note } from './Note.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtFieldValue } from '../prefs/units.js';

// N014: modulo arithmetic must not reintroduce noise after canonicalRodAimDeg.
const turn = (degrees: number) => (Math.round((((degrees % 360) + 360) % 360) * 1e9) / 1e9) % 360;

/** N014: weather bearings and rod aim have different frames; neither writes launch inputs. */
export function LaunchCompass({ value, weatherFromDeg }: {
  value: LaunchConditions; weatherFromDeg?: number | null;
}) {
  const { prefs } = usePrefs();
  const weather = typeof weatherFromDeg === 'number' && Number.isFinite(weatherFromDeg)
    ? turn(weatherFromDeg) : null;
  const vertical = value.launchRodAngleDeg === 0;
  const lean = turn((flownRodAimDeg(value) ?? 0) + (value.launchRodAngleDeg < 0 ? 180 : 0));
  const angleText = (degrees: number) => fmtFieldValue(degrees, prefs.fieldPrecision);
  const rodText = vertical ? 'Vertical rod: no lean direction'
    : `Rod lean ${angleText(lean)}° clockwise relative to wind${value.launchRodAngleDeg < 0 ? ' (negative Rod angle reverses the aim)' : ''}`;
  return <div className="launch-compass" data-launch-compass>
    <div className="launch-compass-frames">
      <figure>
        <svg viewBox="0 0 100 100" role="img" aria-label={rodText}>
          <circle cx="50" cy="50" r="29" />
          <text x="50" y="10">Into wind</text><text x="50" y="97">Downwind</text>
          <text x="8" y="53">L</text><text x="92" y="53">R</text>
          {!vertical ? <g data-direction="rod" transform={`rotate(${lean} 50 50)`}>
            <path d="M50 50 V24" strokeDasharray="4 2" /><path d="M45 30 L50 23 L55 30" />
          </g> : <circle cx="50" cy="50" r="3" />}
        </svg>
        <figcaption>{rodText}</figcaption>
      </figure>
      {weather !== null ? <figure>
        <svg viewBox="0 0 100 100" role="img" aria-label={`Weather wind from ${angleText(weather)}° ${compassPoint(weather)}`}>
          <circle cx="50" cy="50" r="29" />
          <text x="50" y="10">N</text><text x="92" y="53">E</text>
          <text x="50" y="97">S</text><text x="8" y="53">W</text>
          <g data-direction="weather" transform={`rotate(${weather} 50 50)`}>
            <path d="M50 50 V24 M45 30 L50 23 L55 30" />
          </g>
        </svg>
        <figcaption>Weather wind from {angleText(weather)}° ({compassPoint(weather)}) — display only</figcaption>
      </figure> : <p>Weather wind bearing unavailable.</p>}
    </div>
    <Note as="p" tier="information" className="weather-small">
      Rod aim is relative to the wind, not north. The app’s surface wind always blows from the east;
      the weather bearing does not turn it or set Rod aim. L and R are left and right as you face into the wind.
    </Note>
  </div>;
}
