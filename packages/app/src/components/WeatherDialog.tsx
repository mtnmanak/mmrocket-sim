import { useEffect, useMemo, useRef, useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { DEFAULT_CONDITIONS, flownLongitudeDeg, type LaunchConditions } from './LaunchPanel.js';
import { createSequencer } from '../services/latestWins.js';
import {
  compassPoint, coordinatesLabel, DateRefusal, fetchWeather, formatValidTime, hoursOnLocalDate, isCancel,
  isTownCentre, placeFromDevice, placeFromGeo, searchPlace, weatherErrorText, ymdInZone,
  type GeoPlace, type LocalHour, type WeatherAnswer, type WeatherPlace,
} from '../services/openMeteo.js';
import {
  applicable, buildProposal, defaultAltitudeChoice, densityAfter, patchOf, snapshotOf,
  type AltitudeChoice, type ProposalRow, type RowRefusal,
} from '../services/weatherProposal.js';
import { WEATHER_CREDIT, type WeatherPatch, type WeatherSnapshot } from '../services/weatherSnapshot.js';
import { densityAltitudeM, padAir } from '../services/atmosphere.js';
import { sigmaFromGust } from '../services/gustSigma.js';
import { useDialog } from './useDialog.js';
import { altitudeText, capitalise, farText, FIELD_LABEL, fieldText, sourceHeading, sourceWord } from './weatherText.js';

/**
 * ☁ GET WEATHER (weather build, step 3): fetch one hour's forecast for one
 * place, REVIEW it beside the launch conditions, then apply what you tick.
 *
 * NOTHING IS WRITTEN UNTIL APPLY. Cancel, Escape, closing and every failure
 * write nothing; Apply hands App ONE patch of the ticked fields plus the
 * provenance record, and App merges it with a functional update.
 *
 * Built on `useDialog` (the focus trap and Escape `Modal` uses), in the wider
 * scrolling card the Scale and Preferences dialogs use — a review table does
 * not fit Modal's 440 px confirmation card. A click on the backdrop does NOT
 * close it: that would throw away a fetched forecast for a stray tap.
 */

/** Per-viewer conveniences: the country last picked, the last search, the hour last applied. */
const PREFS_KEY = 'online-openrocket.weather.v1';
interface DialogMemory { country?: string; lastQuery?: string; lastHour?: number }

function readMemory(): DialogMemory {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const m = raw ? (JSON.parse(raw) as unknown) : null;
    if (!m || typeof m !== 'object') return {};
    const o = m as Record<string, unknown>;
    return {
      ...(typeof o.country === 'string' ? { country: o.country } : {}),
      ...(typeof o.lastQuery === 'string' ? { lastQuery: o.lastQuery } : {}),
      ...(typeof o.lastHour === 'number' && Number.isInteger(o.lastHour) ? { lastHour: o.lastHour } : {}),
    };
  } catch {
    return {};
  }
}

function writeMemory(m: DialogMemory): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(m));
  } catch {
    /* private window or full storage: a convenience, nothing more */
  }
}

/** Every ISO 3166-1 country code, named by the browser in its own language. */
const COUNTRY_CODES = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ '
  + 'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO '
  + 'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE '
  + 'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO '
  + 'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW '
  + 'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM '
  + 'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

function countryOptions(): { code: string; name: string }[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    names = null;
  }
  return COUNTRY_CODES
    .map((code) => ({ code, name: names?.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The region of the browser's language ("en-US" → "US"), as a first guess at the country. */
function browserCountry(): string {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return region && COUNTRY_CODES.includes(region) ? region : '';
  } catch {
    return '';
  }
}

export const WEATHER_DIALOG_COPY = {
  title: 'Weather for launch conditions',
  intro: 'Fetches one hour’s forecast for one place from Open-Meteo, a free weather service. The place '
    + 'you type — or your coordinates — goes to Open-Meteo; nothing about your rocket does. Open-Meteo '
    + 'keeps request logs, which include your IP address and the coordinates, for 90 days, and says it '
    + 'shares them with no one.',
  placeholder: 'Town, State · US ZIP · or coordinates',
  locate: '📍 Use my location',
  locateNote: 'Your browser asks first. The position is rounded to about 1 km before it is sent or '
    + 'saved — latitude and longitude travel with any .ork or share link made from this design.',
  refused: 'Location permission was refused — type a town or paste coordinates.',
  unavailable: 'This browser cannot share a location here — type a town or paste coordinates.',
  failed: 'Could not get a location — type a town or paste coordinates.',
  townCentre: 'Town centre — for a field out of town, paste the field’s coordinates instead.',
  archive: 'ERA5 reanalysis — the weather as it was, not a forecast',
  noHours: 'Open-Meteo sent no hours for that date here.',
} as const;

/** How the review says a row cannot be applied. */
function refusalText(key: ProposalRow['key'], r: RowRefusal, fmt: (k: ProposalRow['key'], v: number) => string,
    alt: (m: number) => string): string {
  if (r.why === 'missing') return 'Open-Meteo has no value for this hour.';
  if (r.why === 'sea-level') return `Reads as sea-level pressure for a pad at ${alt(r.altitudeM)} — not offered.`;
  const [lo, hi] = r.range;
  const accepts = hi === Infinity ? `nothing below ${fmt(key, lo)}` : `${fmt(key, lo)} to ${fmt(key, hi)}`;
  return `Outside what the ${FIELD_LABEL[key]} field accepts (${accepts}).`;
}

export function WeatherDialog({
  launch, initialPlace, onApply, onClose, fetchImpl, now = Date.now, geolocation,
}: {
  launch: LaunchConditions;
  /** Where the last applied weather was for — "Fetch again" starts there. */
  initialPlace?: WeatherSnapshot['place'] | null;
  /** ONE write: the ticked fields, and where they came from. */
  onApply: (patch: WeatherPatch, snapshot: WeatherSnapshot) => void;
  onClose: () => void;
  /** Tests only: every request goes through it. */
  fetchImpl?: typeof fetch;
  /** Tests only: the clock "today" is read from. */
  now?: () => number;
  /** Tests only: null = no geolocation API; undefined = the browser's own. */
  geolocation?: Pick<Geolocation, 'getCurrentPosition'> | null;
}) {
  const { prefs } = usePrefs();
  const units = prefs.units;
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const memory = useMemo(readMemory, []);
  const countries = useMemo(countryOptions, []);

  const [query, setQuery] = useState(memory.lastQuery ?? '');
  const [country, setCountry] = useState(memory.country ?? browserCountry());
  const [places, setPlaces] = useState<GeoPlace[] | null>(null);
  const [searched, setSearched] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [locateNote, setLocateNote] = useState<string | null>(null);
  const [place, setPlace] = useState<WeatherPlace | null>(initialPlace ? { ...initialPlace } : null);
  const [date, setDate] = useState(() => ymdInZone(now(), undefined));
  const [dateTouched, setDateTouched] = useState(false);
  const [dateNote, setDateNote] = useState<string | null>(null);
  const [answer, setAnswer] = useState<WeatherAnswer | null>(null);
  const [hourUnix, setHourUnix] = useState<number | null>(null);
  const [choice, setChoice] = useState<AltitudeChoice>('site');
  const [ticked, setTicked] = useState<Set<ProposalRow['key']>>(new Set());
  const [busy, setBusy] = useState<'search' | 'fetch' | 'locate' | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every request is cancellable, and only the LATEST may touch state: a slow
  // answer to an earlier press must not paint over a newer one.
  const seq = useRef(createSequencer());
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const begin = (what: 'search' | 'fetch' | 'locate') => {
    abort.current?.abort();
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    abort.current = ctrl;
    setBusy(what);
    setError(null);
    return { id: seq.current.begin(), signal: ctrl?.signal };
  };
  const cancel = () => {
    abort.current?.abort();
    seq.current.begin(); // whatever was running is no longer current
    setBusy(null);
  };

  const choosePlace = (p: WeatherPlace) => {
    setPlace(p);
    setPlaces(null);
    setAnswer(null);
    setNote(null);
    setDateNote(null);
    // "Today" is the SITE's today; follow it until the user picks a date.
    if (!dateTouched) setDate(ymdInZone(now(), p.timezone));
  };

  const runSearch = async () => {
    const { id, signal } = begin('search');
    setNote(null);
    setPlaces(null);
    try {
      const out = await searchPlace(query, country || undefined, { signal, fetchImpl });
      if (!seq.current.isCurrent(id)) return;
      if (out.kind === 'place') choosePlace(out.place);
      else if (out.kind === 'none') setNote(out.message);
      else {
        setSearched(true);
        if (out.places.length === 1) choosePlace(placeFromGeo(out.places[0]!));
        else setPlaces(out.places);
      }
    } catch (err) {
      if (seq.current.isCurrent(id) && !isCancel(err)) setError(weatherErrorText(err));
    } finally {
      if (seq.current.isCurrent(id)) setBusy(null);
    }
  };

  const runLocate = () => {
    const geo = geolocation === undefined
      ? (typeof navigator !== 'undefined' && typeof window !== 'undefined' && window.isSecureContext !== false
        ? navigator.geolocation ?? null : null)
      : geolocation;
    if (!geo) {
      setLocateNote(WEATHER_DIALOG_COPY.unavailable);
      return;
    }
    const { id } = begin('locate');
    setLocateNote(null);
    geo.getCurrentPosition((pos) => {
      if (!seq.current.isCurrent(id)) return;
      setBusy(null);
      // Rounded to 2 dp HERE, before it is sent anywhere or kept.
      const p = placeFromDevice(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      choosePlace(p);
      setLocateNote(`Located to within ${farText(units.distance, Math.max(p.accuracyM ?? 0, 1000))}.`);
    }, (err) => {
      if (!seq.current.isCurrent(id)) return;
      setBusy(null);
      setLocateNote(err.code === 1 ? WEATHER_DIALOG_COPY.refused : WEATHER_DIALOG_COPY.failed);
    }, { enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 });
  };

  const hours: LocalHour[] = useMemo(
    () => (answer ? hoursOnLocalDate(answer.variants[0]?.samples ?? [], answer.timezone, answer.date) : []),
    [answer],
  );

  const runFetch = async () => {
    if (!place) return;
    const { id, signal } = begin('fetch');
    setDateNote(null);
    setAnswer(null);
    try {
      const a = await fetchWeather({
        place, siteM: padAir(launch).altitudeM, date, today: ymdInZone(now(), place.timezone),
      }, { signal, fetchImpl });
      if (!seq.current.isCurrent(id)) return;
      const hs = hoursOnLocalDate(a.variants[0]?.samples ?? [], a.timezone, a.date);
      const nowUnix = now() / 1000;
      const pick = hs.find((h) => h.hour === memory.lastHour)
        ?? (a.date === ymdInZone(now(), a.timezone) ? hs.find((h) => h.unix + 3600 > nowUnix) : undefined)
        ?? hs.find((h) => h.hour === 12)
        ?? hs[0];
      setAnswer(a);
      setHourUnix(pick?.unix ?? null);
      setChoice(defaultAltitudeChoice(launch, a));
      setTicked(new Set(['temperatureC', 'pressureHPa', 'windAverage', 'latitudeDeg', 'longitudeDeg']));
    } catch (err) {
      if (!seq.current.isCurrent(id)) return;
      if (err instanceof DateRefusal) setDateNote(err.message);
      else if (!isCancel(err)) setError(weatherErrorText(err));
    } finally {
      if (seq.current.isCurrent(id)) setBusy(null);
    }
  };

  const proposal = useMemo(() => (answer && place && hourUnix !== null
    ? buildProposal({ launch, answer, place, unix: hourUnix, choice })
    : null), [launch, answer, place, hourUnix, choice]);
  const patch = proposal ? patchOf(proposal, ticked) : {};
  const canApply = proposal !== null && Object.keys(patch).length > 0;
  // The step-4 preview: what the panel's σ chip will offer from this hour.
  const gust = sigmaFromGust(proposal?.sample.windSpeedMs, proposal?.sample.windGustMs);

  const apply = () => {
    if (!proposal || !answer || !place || !canApply) return;
    const hour = hours.find((h) => h.unix === proposal.sample.unix)?.hour;
    writeMemory({ country, lastQuery: query, ...(hour !== undefined ? { lastHour: hour } : {}) });
    onApply(patch, snapshotOf({ launch, answer, place, proposal, patch, retrievedAt: new Date(now()) }));
    onClose();
  };

  const alt = (m: number) => altitudeText(units.distance, m);
  const fmt = (k: ProposalRow['key'], v: number) => fieldText(k, v, units);
  const offerSite = launch.latitudeDeg !== DEFAULT_CONDITIONS.latitudeDeg && flownLongitudeDeg(launch) !== null;
  const source = sourceWord(answer?.endpoint ?? 'forecast');
  const applicableKeys = new Set(proposal ? applicable(proposal).map((r) => r.key) : []);

  return (
    <div className="prefs-overlay" role="presentation">
      <div className="prefs-dialog weather-dialog panel" role="dialog" aria-modal="true"
        aria-label={WEATHER_DIALOG_COPY.title} ref={dialogRef} tabIndex={-1}>
        <div className="weather-dialog-head">
          <h2>{WEATHER_DIALOG_COPY.title}</h2>
          <button className="file-btn" onClick={onClose} aria-label="Close the weather dialog">✕ Close</button>
        </div>
        <p className="comp-stats weather-intro">{WEATHER_DIALOG_COPY.intro}</p>

        <form className="weather-place" role="search" onSubmit={(e) => { e.preventDefault(); void runSearch(); }}>
          <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={WEATHER_DIALOG_COPY.placeholder} aria-label="Place" autoComplete="off" />
          <label className="weather-country">
            Country{' '}
            <select value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">Any country</option>
              {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
            </select>
          </label>
          {busy === 'search'
            ? <button type="button" className="file-btn" onClick={cancel}>Cancel</button>
            : <button type="submit" className="file-btn" disabled={busy !== null || query.trim() === ''}>Search</button>}
        </form>
        <div className="weather-place-alt">
          {/* A Cancel while the browser is asked, as for a search or a fetch: its
              `timeout` only starts once permission is given, so a permission
              prompt left unanswered would otherwise hold every button here
              disabled until the dialog was closed. */}
          {busy === 'locate'
            ? <button type="button" className="file-btn" onClick={cancel}>Cancel</button>
            : (
              <button type="button" className="file-btn" onClick={runLocate} disabled={busy !== null}>
                {WEATHER_DIALOG_COPY.locate}
              </button>
            )}
          {offerSite && (
            <button type="button" className="file-btn" disabled={busy !== null} onClick={() => choosePlace({
              label: coordinatesLabel(launch.latitudeDeg, launch.longitudeDeg!),
              latitudeDeg: launch.latitudeDeg, longitudeDeg: launch.longitudeDeg!, method: 'coordinates',
            })}>
              This design’s site ({coordinatesLabel(launch.latitudeDeg, launch.longitudeDeg!)})
            </button>
          )}
        </div>
        <p className="weather-small">{WEATHER_DIALOG_COPY.locateNote}</p>
        {locateNote && <p className="weather-small" role="status">{locateNote}</p>}
        {note && <p className="weather-note" role="status">{note}</p>}

        {places && (
          <ul className="weather-places" aria-label="Places found">
            {places.map((g, i) => (
              <li key={`${g.latitudeDeg},${g.longitudeDeg},${i}`}>
                <button type="button" className="file-btn file-btn-ghost" onClick={() => choosePlace(placeFromGeo(g))}>
                  {[g.name, g.admin1, g.countryCode].filter(Boolean).join(', ')}
                  {g.elevationM !== null ? ` — ${alt(g.elevationM)}` : ''}
                </button>
                {isTownCentre(g) && <span className="weather-small"> {WEATHER_DIALOG_COPY.townCentre}</span>}
              </li>
            ))}
          </ul>
        )}

        {place && (
          <div className="weather-when">
            <p className="weather-chosen">
              <strong>{place.label}</strong>
              {/* Typed and located places are labelled BY their coordinates already. */}
              {place.method === 'search' && <> ({coordinatesLabel(place.latitudeDeg, place.longitudeDeg)})</>}
              {place.townCentre && <span className="weather-small"> {WEATHER_DIALOG_COPY.townCentre}</span>}
            </p>
            <label>
              Date{' '}
              <input type="date" value={date} onChange={(e) => {
                // Another day's answer must not stay applicable under this one —
                // neither the answer on screen nor one still on its way: a fetch
                // for the old date that lands after this would otherwise pass
                // the sequencer (nothing newer had begun) and show, and Apply,
                // a day the Date box no longer says. So a running fetch is
                // cancelled, and Fetch asks again for the new date.
                if (busy === 'fetch') cancel();
                setDate(e.target.value);
                setDateTouched(true);
                setDateNote(null);
                setAnswer(null);
              }} />
            </label>
            {busy === 'fetch'
              ? <button type="button" className="file-btn" onClick={cancel}>Cancel</button>
              : <button type="button" className="file-btn file-btn-primary" onClick={() => void runFetch()} disabled={busy !== null}>Fetch</button>}
            {answer && hours.length > 0 && (
              <label>
                Hour{' '}
                <select value={hourUnix ?? ''} onChange={(e) => setHourUnix(Number(e.target.value))}>
                  {hours.map((h) => <option key={h.unix} value={h.unix}>{h.label}</option>)}
                </select>
              </label>
            )}
            {dateNote && <p className="weather-note" role="status">{dateNote}</p>}
          </div>
        )}

        {busy !== null && (
          <p className="weather-small" role="status">
            {busy === 'locate' ? 'Waiting for your browser’s location…' : 'Asking Open-Meteo…'}
          </p>
        )}
        {error && <p className="weather-error" role="alert">{error}</p>}

        {answer && hours.length === 0 && <p className="weather-note">{WEATHER_DIALOG_COPY.noHours}</p>}

        {proposal && answer && place && (
          <div className="weather-review">
            {/* Every label that names the source reads `source`: an ERA5 answer is
                the weather as it was, and saying "forecast" over it is wrong. */}
            <h3>
              {sourceHeading(answer.endpoint)} {place.label} · {formatValidTime(proposal.sample.unix, answer.timezone)}
            </h3>
            {answer.endpoint === 'archive' && <p className="weather-small">{WEATHER_DIALOG_COPY.archive}</p>}
            <table>
              <thead>
                <tr>
                  <th scope="col"><span className="sr-only">Apply</span></th>
                  <th scope="col"><span className="sr-only">Field</span></th>
                  <th scope="col">Now</th>
                  <th scope="col">{capitalise(source)}</th>
                </tr>
              </thead>
              <tbody>
                {proposal.rows.map((r) => {
                  const on = applicableKeys.has(r.key);
                  return (
                    <tr key={r.key} data-row={r.key} className={r.refusal ? 'weather-row-refused' : undefined}>
                      <td>
                        <input type="checkbox" aria-label={`Apply ${FIELD_LABEL[r.key]}`} disabled={!on}
                          checked={on && ticked.has(r.key)}
                          onChange={(e) => setTicked((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(r.key); else next.delete(r.key);
                            return next;
                          })} />
                      </td>
                      <th scope="row">{FIELD_LABEL[r.key]}</th>
                      <td>
                        {r.now === null
                          ? <>blank (−80.6 flown)</>
                          : fmt(r.key, r.now)}
                        {r.nowFromSite && <span className="weather-small"> (standard for {alt(proposal.altitude.siteM)})</span>}
                      </td>
                      <td>
                        {r.value !== null ? fmt(r.key, r.value) : '—'}
                        {r.key === 'windAverage' && r.value !== null
                          && <span className="weather-small"> ({source} at 10 m / 33 ft)</span>}
                        {r.key === 'latitudeDeg' && place.townCentre
                          && <span className="weather-small"> ({place.label} — town centre)</span>}
                        {r.refusal && (
                          <span className="weather-refusal"> {refusalText(r.key, r.refusal, fmt, alt)}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            <AltitudeReviewBlock proposal={proposal} choice={choice} onChoice={setChoice} alt={alt} />

            <ul className="weather-context">
              {proposal.sample.windFromDeg !== null && (
                // Display only, never applied — and never written into Rod aim
                // either: the aim is the rod's angle TO the wind, which a
                // bearing cannot tell without knowing the rail (weather build,
                // step 2, trap 8). Only the user at the pad knows that.
                <li>Wind from {Math.round(proposal.sample.windFromDeg)}° ({compassPoint(proposal.sample.windFromDeg)}) — the
                  app’s wind has no direction; set Rod aim yourself.</li>
              )}
              {proposal.sample.windGustMs !== null && (
                <li>Gust {fieldText('windAverage', proposal.sample.windGustMs, units)} (strongest in the hour before) — see
                  Wind gusts σ.</li>
              )}
              {gust.ok && (
                <li>σ from this gust ≈ {fieldText('windAverage', gust.sigmaMs, units)} — offered beside Wind gusts σ
                  once this wind is applied; Apply never sets σ.</li>
              )}
              {proposal.gridDistanceM !== null && (
                <li>{capitalise(source)} grid point {farText(units.distance, proposal.gridDistanceM)} from your site.</li>
              )}
              <li>Density altitude {alt(densityAltitudeM(launch))} → {alt(densityAfter(launch, patch))}.</li>
            </ul>
          </div>
        )}

        <div className="modal-actions weather-actions">
          <button type="button" className="file-btn file-btn-primary" onClick={apply} disabled={!canApply}>Apply</button>
          <button type="button" className="file-btn" onClick={onClose}>Cancel</button>
        </div>

        <p className="weather-credit">
          <a href={WEATHER_CREDIT.source.href} target="_blank" rel="noopener noreferrer">{WEATHER_CREDIT.source.text}</a>
          {' · '}
          <a href={WEATHER_CREDIT.licence.href} target="_blank" rel="noopener noreferrer">{WEATHER_CREDIT.licence.text}</a>
          {(searched || place?.method === 'search') && (
            <>
              {' · Place search: '}
              <a href={WEATHER_CREDIT.places.href} target="_blank" rel="noopener noreferrer">{WEATHER_CREDIT.places.text}</a>
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/** The Site altitude part of the review: a choice when both were fetched, a line when they agree. */
function AltitudeReviewBlock({ proposal, choice, onChoice, alt }: {
  proposal: NonNullable<ReturnType<typeof buildProposal>>;
  choice: AltitudeChoice;
  onChoice: (c: AltitudeChoice) => void;
  alt: (m: number) => string;
}) {
  const a = proposal.altitude;
  if (a.unchecked) return <p className="weather-note">No ground height — check Site altitude first.</p>;
  if (a.demM === null) return null;
  if (a.agree) return <p className="weather-small">Site altitude: ground here {alt(a.demM)} · yours {alt(a.siteM)}</p>;
  if (a.groundRefused) {
    return <p className="weather-small">The terrain model puts the ground at {alt(a.demM)}, which the Site altitude field cannot take.</p>;
  }
  return (
    <fieldset className="weather-altitude">
      <legend>Site altitude</legend>
      <label>
        <input type="radio" name="weather-altitude" checked={choice === 'site'} onChange={() => onChoice('site')} />
        {' '}Keep yours, {alt(a.siteM)}
      </label>
      <label>
        <input type="radio" name="weather-altitude" checked={choice === 'ground'} onChange={() => onChoice('ground')} />
        {' '}Use the ground height, {alt(a.demM)} (terrain model)
      </label>
      {a.belowSeaLevel && choice === 'ground' && (
        <p className="weather-small">
          Ground is below sea level here; Site altitude cannot go below 0, so the pad is set to 0 with the air
          measured at {alt(a.demM)}.
        </p>
      )}
    </fieldset>
  );
}
