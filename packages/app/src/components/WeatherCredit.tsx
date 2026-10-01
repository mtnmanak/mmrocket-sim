import { WEATHER_CREDIT } from '../services/weatherSnapshot.js';

/**
 * The credit Open-Meteo's CC BY 4.0 licence asks for wherever its numbers are
 * shown, and GeoNames' (also CC BY) wherever a place name their data supplied
 * is: `geoNames` is true when one is on screen — a place a search found.
 *
 * ONE component for every site that shows either — the weather dialog, the
 * Launch panel's weather strip, the Fly screen and the winds-aloft details —
 * so the sites differ only in WHEN a place name is GeoNames data, never in
 * what the credit says. Four hand-written copies had already drifted: the
 * winds-aloft details showed a searched place's name with Open-Meteo's credit
 * alone (audit 2026-09-30).
 *
 * A fragment, so each site keeps its own wrapper and separators.
 */
export function WeatherCredit({ geoNames }: { geoNames: boolean }) {
  return (
    <>
      <a href={WEATHER_CREDIT.source.href} target="_blank" rel="noopener noreferrer">{WEATHER_CREDIT.source.text}</a>
      {' · '}
      <a href={WEATHER_CREDIT.licence.href} target="_blank" rel="noopener noreferrer">{WEATHER_CREDIT.licence.text}</a>
      {geoNames && (
        <>
          {' · Place search: '}
          <a href={WEATHER_CREDIT.places.href} target="_blank" rel="noopener noreferrer">{WEATHER_CREDIT.places.text}</a>
        </>
      )}
    </>
  );
}
