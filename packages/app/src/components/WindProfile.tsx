import { useState } from 'react';
import type { LaunchConditions } from './LaunchPanel.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi } from '../prefs/units.js';
import { compassPoint, formatValidTime, parseCoordinates } from '../services/openMeteo.js';
import {
  windProfileSummary, type RelativeWindLevel, type WindProfileConditions, type WindProfileSource,
} from '../services/windProfile.js';
import { WeatherCredit } from './WeatherCredit.js';

/**
 * Whether a fetched profile's place name is GeoNames data — a place a search
 * found. A profile saved by v0.144 did not record how its place was chosen, so
 * then the label decides: the app names a pasted or device position by its
 * coordinates, and a search result by name, region and country, which never
 * reads as coordinates. Anything that is not plainly coordinates gets the
 * credit — one link too many costs nothing; one too few breaches the licence.
 */
function placeFromSearch(source: Extract<WindProfileSource, { kind: 'open-meteo' }>): boolean {
  if (source.method !== undefined) return source.method === 'search';
  return parseCoordinates(source.place)?.ok !== true;
}

export function WindProfileTable({ levels, surfaceFromDeg }: {
  levels: readonly RelativeWindLevel[]; surfaceFromDeg?: number;
}) {
  const { prefs } = usePrefs();
  return <div className="wind-profile-table" tabIndex={0} role="region" aria-label="Wind levels">
    <table>
      <thead><tr><th scope="col">Height AGL (ft / m)</th><th scope="col">Speed ({prefs.units.windspeed})</th>
        <th scope="col">From relative to surface</th>{surfaceFromDeg !== undefined && <th scope="col">Compass from</th>}</tr></thead>
      <tbody>{levels.map((l) => {
        const relative = l.direction * 180 / Math.PI;
        const bearing = ((relative + (surfaceFromDeg ?? 0)) % 360 + 360) % 360;
        return <tr key={l.altitude}><td>{Math.round(l.altitude / 0.3048)} / {Math.round(l.altitude)}</td>
          <td>{fmtSi('windspeed', prefs.units.windspeed, l.speed)}</td><td>{relative.toFixed(1)}°</td>
          {surfaceFromDeg !== undefined && <td>{bearing.toFixed(1)}° {compassPoint(bearing)}</td>}</tr>;
      })}</tbody>
    </table>
  </div>;
}

export function WindProfile({ value, onChange }: { value: LaunchConditions; onChange: (v: LaunchConditions) => void }) {
  const [cleared, setCleared] = useState<{ profile: WindProfileConditions; after: LaunchConditions } | null>(null);
  const levels = value.windLevels;
  if (!levels?.length) return cleared && cleared.after === value ? <div className="wind-profile">
    Winds aloft cleared. <button type="button" className="file-btn" onClick={() => {
      onChange({ ...value, ...cleared.profile }); setCleared(null);
    }}>Undo clear winds aloft</button>
  </div> : null;
  const source = value.windProfileSource;
  return <div className="wind-profile">
    <span>Winds aloft: {windProfileSummary(levels)} · </span>
    <button type="button" className="file-btn" onClick={() => {
      const next = { ...value };
      delete next.windLevels; delete next.windProfileSource;
      setCleared({ profile: { windLevels: levels, windProfileSource: source }, after: next });
      onChange(next);
    }}>Clear</button>
    <details><summary>View winds aloft</summary>
      <WindProfileTable levels={levels} surfaceFromDeg={source?.kind === 'open-meteo' ? source.surfaceFromDeg : undefined} />
      {source?.kind === 'open-meteo' && <p className="weather-small">
        {source.place} · {formatValidTime(source.validUnix, 'UTC', true)} ·{' '}
        <WeatherCredit geoNames={placeFromSearch(source)} />
      </p>}
    </details>
    <p className="weather-small">The flight uses this profile. Wind avg is the surface wind; changing it scales the profile’s speeds. Wind gusts σ sets its turbulence intensity.</p>
  </div>;
}
