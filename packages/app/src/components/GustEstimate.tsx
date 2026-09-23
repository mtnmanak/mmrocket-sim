import { useId } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { GUST_CONVECTIVE_INTENSITY, GUST_PEAK_FACTOR, sigmaFromGust } from '../services/gustSigma.js';
import type { LaunchConditions } from './LaunchPanel.js';
import { windNumber } from './weatherText.js';

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
export function GustEstimate({ value, onChange, onEstimate, forecastWind }: {
  value: LaunchConditions;
  onChange: (v: LaunchConditions) => void;
  /**
   * The click, when App wants it: App writes σ AND keeps what σ held before on
   * the weather record, so the strip's Undo can put it back. Without it the
   * click is a plain `onChange` of σ alone.
   */
  onEstimate?: (sigmaMs: number) => void;
  /**
   * The applied hour's mean wind and gust (m/s), or null when there is none.
   * `source` is what the copy calls them: "forecast" unless the hour came from
   * the ERA5 archive, the weather as it was ("reanalysis").
   */
  forecastWind: { meanMs: number; gustMs: number; source?: 'forecast' | 'reanalysis' } | null;
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
  // Every speed with the digits its box shows (weatherText.windNumber): the σ
  // offered is the number the Wind gusts σ box then reads, and the average in
  // the arithmetic is the Wind avg box's.
  const num = (ms: number) => windNumber(sym, ms);
  const speed = (ms: number) => `${num(ms)} ${sym}`;
  const gust = speed(forecastWind.gustMs);
  const warn = est.convective;
  const source = forecastWind.source ?? 'forecast';
  // The warning is for σ STRICTLY above 30 % of the average, so a share that
  // rounds to 30 — 30.2 % at 5 m/s gusting 9.53 — must not print as "30 %".
  const pct = Math.round(est.intensity * 100);
  const threshold = Math.round(GUST_CONVECTIVE_INTENSITY * 100);
  const share = pct > threshold ? `${pct} %` : `just over ${threshold} %`;
  const extras = (
    <>
      {warn && (
        <>
          {' '}That gust is far above the average (σ is {share} of it), which usually means
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
          title={`Works out σ from the ${source}’s gust and average wind. Nothing changes until you click.`}
          onClick={() => (onEstimate ? onEstimate(est.sigmaMs) : onChange({ ...value, windStdDev: est.sigmaMs }))}>
          Estimate from {source} gust
        </button>
      )}
      <span id={lineId} role="status">
        {meanMatches && !applied && (
          <>σ ≈ {speed(est.sigmaMs)} from {article(num(forecastWind.gustMs))} {gust} gust.{extras}</>
        )}
        {meanMatches && applied && (
          <>
            Wind gusts σ is an estimate from the {source}: ({num(forecastWind.gustMs)} − {speed(forecastWind.meanMs)})
            {/* Capped, the division's own result is printed and then the cap:
                "= 1 m/s" after "(6 − 1 m/s) ÷ 3" would be an equation that
                does not add up. */}
            {' '}÷ {GUST_PEAK_FACTOR} = {est.capped
              ? <>{speed(est.rawSigmaMs)}, capped at {speed(est.sigmaMs)}</>
              : speed(est.sigmaMs)}, taking {gust} as the hour’s strongest 3-second gust.
            Good to about ±25 %. See <em>Launch Conditions → Wind gusts from a forecast</em> in the Guide.{extras}
          </>
        )}
        {!meanMatches && applied && (
          <>
            Wind gusts σ, {speed(est.sigmaMs)}, was estimated against the {source}’s {speed(forecastWind.meanMs)} average;
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
