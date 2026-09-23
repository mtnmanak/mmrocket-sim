import { useId } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi } from '../prefs/units.js';
import { GUST_PEAK_FACTOR, sigmaFromGust } from '../services/gustSigma.js';
import type { LaunchConditions } from './LaunchPanel.js';

/**
 * THE GUST-TO-σ CHIP (weather build, step 4) — a full-width row directly under
 * Wind avg | Wind gusts σ in the Launch panel, and nowhere else (never the Fly
 * screen). It OFFERS σ ≈ (gust − mean)/3 from the applied forecast hour and
 * writes it only when clicked: never on render, fetch or Apply.
 *
 * Every state is DERIVED from the launch values and the forecast pair, never
 * stored: whether Wind avg still matches the forecast's mean, and whether
 * Wind gusts σ holds the estimate. So an edit to either field is reflected at
 * once, and nothing can go stale. σ is never rescaled when Wind avg changes —
 * desktop's `setAverage` would; this says what happened instead.
 *
 * Not a `.field-caution`: the panel's tests (and a reader) take the first of
 * those as the caution about what was typed, and this renders ahead of them.
 */
export function GustEstimate({ value, onChange, forecastWind }: {
  value: LaunchConditions;
  onChange: (v: LaunchConditions) => void;
  /** The applied forecast hour's mean wind and gust (m/s), or null when there is none. */
  forecastWind: { meanMs: number; gustMs: number } | null;
}) {
  const { prefs } = usePrefs();
  const lineId = `${useId()}-gust`;
  if (!forecastWind) return null;
  const est = sigmaFromGust(forecastWind.meanMs, forecastWind.gustMs);
  if (!est.ok) return null;
  const meanMatches = Math.abs(value.windAverage - forecastWind.meanMs) <= 0.005;
  const applied = Math.abs(value.windStdDev - est.sigmaMs) < 0.0005;
  if (!meanMatches && !applied) return null;

  const sym = prefs.units.windspeed;
  const num = (ms: number) => fmtSi('windspeed', sym, ms, 1);
  const speed = (ms: number) => `${num(ms)} ${sym}`;
  const gust = speed(forecastWind.gustMs);
  const warn = est.convective;
  const extras = (
    <>
      {warn && (
        <>
          {' '}That gust is far above the average (σ is {Math.round(est.intensity * 100)} % of it), which usually means
          thermals or showers rather than steady turbulence, and this estimate is least reliable there.
        </>
      )}
      {est.capped && <> Capped at the average wind, the most desktop OpenRocket’s panel allows.</>}
    </>
  );

  return (
    <div className={`gust-estimate${warn ? ' gust-estimate-warn' : ''}${!meanMatches ? ' gust-estimate-muted' : ''}`}
      {...(warn ? { 'data-caution': 'gust-convective' } : {})}>
      {meanMatches && !applied && (
        <button type="button" className="file-btn" aria-describedby={lineId}
          title="Works out σ from the forecast’s gust and average wind. Nothing changes until you click."
          onClick={() => onChange({ ...value, windStdDev: est.sigmaMs })}>
          Estimate from forecast gust
        </button>
      )}
      <span id={lineId} role="status">
        {meanMatches && !applied && (
          <>σ ≈ {speed(est.sigmaMs)} from {article(num(forecastWind.gustMs))} {gust} gust.{extras}</>
        )}
        {meanMatches && applied && (
          <>
            Wind gusts σ is an estimate from the forecast: ({num(forecastWind.gustMs)} − {speed(forecastWind.meanMs)})
            {/* Capped, the division's own result is printed and then the cap:
                "= 1 m/s" after "(6 − 1 m/s) ÷ 3" would be an equation that
                does not add up. Two decimals, so a quotient just over the
                mean does not print as the mean it was capped to. */}
            {' '}÷ {GUST_PEAK_FACTOR} = {est.capped
              ? <>{fmtSi('windspeed', sym, est.rawSigmaMs, 2)} {sym}, capped at {speed(est.sigmaMs)}</>
              : speed(est.sigmaMs)}, taking {gust} as the hour’s strongest 3-second gust.
            Good to about ±25 %. See <em>Launch Conditions → Wind gusts from a forecast</em> in the Guide.{extras}
          </>
        )}
        {!meanMatches && applied && (
          <>
            Wind gusts σ, {speed(est.sigmaMs)}, was estimated against the forecast’s {speed(forecastWind.meanMs)} average;
            Wind avg now reads {speed(value.windAverage)}.
          </>
        )}
      </span>
    </div>
  );
}

/** "an 11", "an 8.5", "a 24.6" — the article a spoken number takes. */
function article(numberText: string): string {
  return /^(8|1[18](?!\d))/.test(numberText) ? 'an' : 'a';
}
