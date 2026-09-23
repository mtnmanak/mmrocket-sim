import { usePrefs } from '../prefs/PrefsContext.js';
import type { LaunchConditions } from './LaunchPanel.js';
import { formatValidTime } from '../services/openMeteo.js';
import {
  fieldProvenance, staleness, WEATHER_CREDIT, type ApplyKey, type WeatherSnapshot,
} from '../services/weatherSnapshot.js';
import { altitudeText, fieldText } from './weatherText.js';

/**
 * WHERE THE APPLIED WEATHER CAME FROM, under the Launch panel's grid (weather
 * build, step 3): the place and hour, when it was fetched, Undo and Dismiss,
 * and Open-Meteo's CC BY 4.0 credit — the licence asks for it wherever their
 * numbers are shown, and these fields now show them.
 *
 * It also catches the one way applied weather goes stale on its own: the Site
 * altitude moving under an applied temperature and pressure, which then are
 * one altitude's air flown at another pad. It offers the two honest fixes —
 * fetch again for the new altitude, or clear both so the site's standard air
 * follows it — and applies neither by itself.
 */
export function WeatherStrip({ weather, launch, onUndo, onDismiss, onFetchAgain, onChange }: {
  weather: WeatherSnapshot;
  launch: LaunchConditions;
  onUndo: () => void;
  onDismiss: () => void;
  onFetchAgain?: () => void;
  onChange: (v: LaunchConditions) => void;
}) {
  const { prefs } = usePrefs();
  const alt = (m: number) => altitudeText(prefs.units.distance, m);
  const stale = staleness(launch, weather);
  const fetched = new Date(weather.retrievedAt);
  const fetchedText = Number.isFinite(fetched.getTime())
    ? fetched.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
  return (
    <div className="weather-strip" role="status" data-weather="strip">
      {weather.endpoint === 'archive' ? 'ERA5 weather for ' : 'Forecast for '}
      <strong>{weather.place.label}</strong> · {formatValidTime(weather.validUnix, weather.timezone)} · fetched {fetchedText}
      {' '}
      <button type="button" className="file-btn" onClick={onUndo}
        title="Put back what the applied fields held — any you have edited since stay as they are">Undo</button>
      {' '}
      <button type="button" className="file-btn file-btn-ghost" onClick={onDismiss}
        title="Keep the values and stop showing where they came from">Dismiss</button>
      {' — '}
      <a href={WEATHER_CREDIT.source.href} target="_blank" rel="noopener noreferrer">{WEATHER_CREDIT.source.text}</a>
      {' · '}
      <a href={WEATHER_CREDIT.licence.href} target="_blank" rel="noopener noreferrer">{WEATHER_CREDIT.licence.text}</a>
      {weather.place.method === 'search' && (
        <>
          {' · Place search: '}
          <a href={WEATHER_CREDIT.places.href} target="_blank" rel="noopener noreferrer">{WEATHER_CREDIT.places.text}</a>
        </>
      )}
      {stale && (
        <p className="weather-stale" data-weather="stale">
          These came from the forecast for {alt(stale.forAltitudeM)}; Site altitude is now {alt(stale.nowAltitudeM)}.
          {' '}
          {onFetchAgain && <button type="button" className="file-btn" onClick={onFetchAgain}>Fetch again</button>}
          {' '}
          <button type="button" className="file-btn"
            onClick={() => onChange({ ...launch, temperatureC: null, pressureHPa: null })}>
            Clear both — standard air for {alt(stale.nowAltitudeM)}
          </button>
        </p>
      )}
    </div>
  );
}

/** Which source each weather-set field names in its provenance line. */
const SOURCE: Readonly<Record<ApplyKey, string>> = {
  temperatureC: 'forecast', pressureHPa: 'forecast', windAverage: 'forecast',
  launchAltitudeM: 'terrain model', latitudeDeg: 'weather place', longitudeDeg: 'weather place',
};

/**
 * One field's provenance line — "forecast", or "edited — forecast said
 * 22.9 °C" once the user has changed it — or undefined for a field the
 * weather did not set.
 */
export function provenanceText(launch: LaunchConditions, weather: WeatherSnapshot | null | undefined, key: ApplyKey,
    units: Parameters<typeof fieldText>[2]): string | undefined {
  const p = fieldProvenance(launch, weather ?? null, key);
  if (p === null) return undefined;
  return p.kind === 'forecast' ? SOURCE[key] : `edited — ${SOURCE[key]} said ${fieldText(key, p.said, units)}`;
}
