import { usePrefs } from '../prefs/PrefsContext.js';
import type { LaunchConditions } from './LaunchPanel.js';
import { useOnline } from '../services/net.js';
import { formatDay, formatValidTime } from '../services/openMeteo.js';
import {
  fieldProvenance, staleness, WEATHER_CREDIT, type ApplyKey, type WeatherSnapshot,
} from '../services/weatherSnapshot.js';
import { WEATHER_OFFLINE_TITLE } from './WeatherButton.js';
import { altitudeText, fieldText, showsYear, sourceHeading, sourceWord } from './weatherText.js';

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
  // Fetch again opens the same dialog ☁ Get weather does, whose every request
  // fails offline — so it greys out with the same reason (review of
  // 2026-09-23: it was the one way into the dialog that stayed live offline).
  const online = useOnline();
  const alt = (m: number) => altitudeText(prefs.units.distance, m);
  const stale = staleness(launch, weather);
  // Both dates in ONE format (formatDay), and both with their year for an
  // ERA5 answer: the valid time in the site's zone, the fetch in yours.
  const year = showsYear(weather.endpoint);
  const fetchedText = formatDay(Date.parse(weather.retrievedAt), undefined, year);
  return (
    <div className="weather-strip" role="status" data-weather="strip">
      {sourceHeading(weather.endpoint)}{' '}
      <strong>{weather.place.label}</strong> · {formatValidTime(weather.validUnix, weather.timezone, year)} · fetched {fetchedText}
      {' '}
      {/* Undo takes back a σ the gust chip worked out from this weather too
          (weatherSnapshot.sigmaEstimate); Dismiss keeps every value, σ
          included, and drops only the notes — the chip's goes with the rest. */}
      <button type="button" className="file-btn" onClick={onUndo}
        title={'Put back what the applied fields held, and Wind gusts σ if you took the estimate — '
          + 'any you have edited since stay as they are'}>Undo</button>
      {' '}
      <button type="button" className="file-btn file-btn-ghost" onClick={onDismiss}
        title="Keep every value, an estimated Wind gusts σ included, and stop showing where they came from">Dismiss</button>
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
          These came from the {sourceWord(weather.endpoint)} for {alt(stale.forAltitudeM)}; Site altitude is
          now {alt(stale.nowAltitudeM)}.
          {' '}
          {onFetchAgain && (
            <button type="button" className="file-btn" onClick={onFetchAgain} disabled={!online}
              title={online ? undefined : WEATHER_OFFLINE_TITLE}>Fetch again</button>
          )}
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

/**
 * Which source each weather-set field names in its provenance line: the air
 * and the wind come from the forecast — or the ERA5 reanalysis, for an old
 * enough date — the ground height from the terrain model, and the place from
 * whatever chose it.
 */
function sourceOf(key: ApplyKey, weather: WeatherSnapshot): string {
  switch (key) {
    case 'temperatureC': case 'pressureHPa': case 'windAverage': return sourceWord(weather.endpoint);
    case 'launchAltitudeM': return 'terrain model';
    case 'latitudeDeg': case 'longitudeDeg': return 'weather place';
  }
}

/**
 * One field's provenance line — "forecast", or "edited — forecast said
 * 22.9 °C" once the user has changed it ("reanalysis" for an ERA5 date) — or
 * undefined for a field the weather did not set.
 */
export function provenanceText(launch: LaunchConditions, weather: WeatherSnapshot | null | undefined, key: ApplyKey,
    units: Parameters<typeof fieldText>[2]): string | undefined {
  const p = fieldProvenance(launch, weather ?? null, key);
  if (p === null || !weather) return undefined;
  const source = sourceOf(key, weather);
  return p.kind === 'forecast' ? source : `edited — ${source} said ${fieldText(key, p.said, units)}`;
}
