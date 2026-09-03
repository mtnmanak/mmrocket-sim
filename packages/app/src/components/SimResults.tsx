import { useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi } from '../prefs/units.js';
import { UnitChip } from './UnitChip.js';
import {
  aeroModelLabel, formatRunStability, formatRunWhen, formatRunWhenProse, listAnd,
  ROLL_RATE_MEANINGFUL_RAD_S, stabilityState, WIND_BLOWS_TOWARD_DEG,
  type DeploymentReport, type SimRun,
} from '../services/simReport.js';
import { clearRuns, deleteRun, runsToCsv, runsToTable } from '../services/simStore.js';
import { formatWarning } from '../services/simWarnings.js';
import { CSV_BOM, downloadBlob, stampedName } from '../services/fileName.js';
import { tableToXlsx, XLSX_MIME } from '../services/xlsx.js';

/**
 * Detailed launch report (the full attribute list from the owner's flight-day
 * workflow) + the stored-run history with CSV export for motor comparison.
 */

function Row({ label, value, quantity, unit, bad, warn }: {
  label: string;
  value: string;
  quantity?: Parameters<typeof UnitChip>[0]['quantity'];
  unit?: string;
  bad?: boolean;
  /** Caution styling (yellow) — used when `bad` is false. */
  warn?: boolean;
}) {
  return (
    <tr>
      <td className="simdet-label">{label}</td>
      <td className={bad ? 'stability-bad' : warn ? 'stability-warn' : undefined}>
        {value}
        {quantity ? <> <UnitChip quantity={quantity} /></> : unit ? ` ${unit}` : ''}
      </td>
    </tr>
  );
}

const s = (v: number | null, digits = 2) =>
  v === null || !Number.isFinite(v) ? '—' : v.toFixed(digits);

/**
 * The drag coefficient a recovery device actually flew.
 *
 * A vented canopy shows both figures — "2.13 (2.2 less a 375 mm vent)" — because
 * the design panel holds the manufacturer's 2.2 and the kernel is handed the
 * scaled value, and a reader comparing the two should see why they differ
 * rather than suspect the app of losing their number.
 *
 * Runs stored before v0.099 carry no coefficient; they show "—" rather than a
 * guess.
 */
function flownCd(d: DeploymentReport): string {
  if (d.cd === null) return '—';
  const flown = d.cd.toFixed(2);
  const vented = d.spillHoleDiameter !== null && d.spillHoleDiameter > 0
    && d.cdNominal !== null && Math.abs(d.cdNominal - d.cd) > 1e-9;
  if (!vented) return flown;
  return `${flown} (${d.cdNominal!.toFixed(2)} less a ${(d.spillHoleDiameter! * 1000).toFixed(0)} mm vent)`;
}

function verdict(v: boolean | null): { text: string; bad: boolean } {
  return v === null ? { text: '—', bad: false } : v
    ? { text: '✓ yes', bad: false }
    : { text: '⚠ NO', bad: true };
}

/** 8-point compass name for a bearing (° clockwise from north). */
function compassPoint(deg: number): string {
  const pts = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return pts[Math.round(((deg % 360) + 360) % 360 / 45) % 8]!;
}

/**
 * The stored launch report. Every number here comes from the SimRun, which is
 * what run history persists; `hasSeries` says whether this flight's raw time
 * series also exist in memory, and only changes where the report POINTS for
 * the per-timestep download — the buttons themselves live beside the plots
 * they produce (see FlightCharts).
 */
export function SimRunDetails({ run, hasSeries, changedSince }: {
  run: SimRun;
  hasSeries?: boolean;
  /**
   * What has changed since this run was flown: `[]` when it still describes the
   * design as it stands, a list when it does not, `null`/absent when it cannot
   * be told. The report must carry its own provenance — it is the panel people
   * screenshot and forward, and until v0.101 it showed no date at all.
   */
  changedSince?: string[] | null;
}) {
  const { prefs } = usePrefs();
  const [open, setOpen] = useState(false);
  const dist = prefs.units.distance;
  const vel = prefs.units.velocity;
  const len = prefs.units.length;
  const mass = prefs.units.mass;
  const acc = prefs.units.acceleration;

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <div className="panel-head">
        <h2 style={{ flex: 1 }}>
          Launch report — {run.rocket ? `${run.rocket} · ` : ''}{run.motor}
          {run.manufacturer ? ` (${run.manufacturer})` : ''}
        </h2>
        {/* The report's own provenance, in its header, because this panel is
            what gets screenshotted and forwarded — and a report with no date on
            it cannot be told from a fresh one. */}
        <span className={changedSince && changedSince.length > 0 ? 'simdet-when simdet-when-stale' : 'simdet-when'}>
          Flown {formatRunWhenProse(run.when)}
          {changedSince == null ? '' : changedSince.length === 0
            ? ' · matches the design as it stands'
            : ` · ${listAnd(changedSince)} changed since`}
        </span>
        <button className="file-btn file-btn-ghost" onClick={() => setOpen(!open)}>
          {open ? 'Hide details' : 'Show all details'}
        </button>
      </div>
      {/* The pair of raw flight-data buttons used to sit in this header. They
          vanished exactly when a user went hunting for them — selecting a
          saved run nulled the result they were gated on — leaving only the
          Saved-simulations XLSX, which produces the run table, not flight
          data. A pointer stays behind, and says the true thing in each case. */}
      <p className="download-caption">
        {hasSeries
          ? 'Raw per-timestep flight data downloads under Flight plots, below.'
          : 'Re-fly this design to download its raw flight data — time series aren’t saved with run history.'}
      </p>
      {(run.optimumDelayS !== null || run.recommendedDelayS !== null) && (
        <p className="simdet-delay">
          Optimal delay <strong>{s(run.optimumDelayS, 1)} s</strong>
          {run.recommendedDelayS !== null && (
            <> · recommended (available) <strong>{run.recommendedDelayS} s</strong></>
          )}
          {' '}· flown with{' '}
          <strong>
            {Number.isFinite(run.delayS) ? `${run.delayS} s` : 'plugged (no ejection charge)'}
          </strong>
        </p>
      )}
      {(run.simWarnings ?? []).length > 0 && (
        // Kernel flight warnings — deliberately separate from the comments
        // blob below: HIGH priority is a flight-safety failure (red, like
        // the verdict rows); the rest are cautions.
        <div style={{ marginTop: 6 }}>
          {(run.simWarnings ?? []).map((w, i) => {
            const f = formatWarning(w);
            return (
              <p key={i} className={f.high ? 'simdet-comments stability-bad' : 'simdet-comments'}
                style={{ margin: '2px 0 0' }}>
                {f.high ? '⚠' : '△'} {f.label}
                {f.detail && <span> — {f.detail}</span>}
              </p>
            );
          })}
        </div>
      )}
      {/* simReport joins its advisory sentences with ' | ' — one line each
          reads as ranked flags instead of run-on prose (v0.076). */}
      {run.comments && run.comments.split(' | ').map((c, i) => (
        <p key={i} className="simdet-comments" style={{ margin: '2px 0 0' }}>{c}</p>
      ))}
      {(run.deployments ?? []).length > 0 && (
        <div className="motor-table-wrap" style={{ marginTop: 8 }}>
          <table className="motor-table">
            <thead>
              <tr>
                <th>Recovery device</th>
                <th>Deploys at</th>
                <th>Altitude (<UnitChip quantity="distance" />)</th>
                <th>Opens at (<UnitChip quantity="velocity" />)</th>
                {/* The coefficient the descent verdict rests on. Naming the
                    device without it made two landing-rate reports (2026-09-03)
                    take a round trip each to answer "which Cd did that run
                    use?" — a question the page should answer itself. */}
                <th>Flown at Cd</th>
                {/* VERTICAL from v0.100. It used to be the speed over the
                    ground, which carries the wind drift — so a windy day made
                    every correctly sized main read as landing too fast. */}
                <th>Descent after (<UnitChip quantity="velocity" />)</th>
                <th>Over ground (<UnitChip quantity="velocity" />)</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {run.deployments.map((d, i) => {
                const problems: string[] = [];
                if (d.openingOk === false) problems.push('hard opening');
                if (d.descentOk === false) {
                  problems.push(d.isLanding ? 'landing too fast' : 'drogue descent too fast');
                }
                return (
                  <tr key={i}>
                    <td>{d.device}{d.isLanding ? ' (landing)' : ''}</td>
                    <td>{d.time.toFixed(1)} s</td>
                    <td>{d.altitude === null ? '—' : fmtSi('distance', dist, d.altitude)}</td>
                    <td className={d.openingOk === false ? 'stability-bad' : undefined}>
                      {d.velocityAtDeployment === null ? '—' : fmtSi('velocity', vel, Math.abs(d.velocityAtDeployment))}
                    </td>
                    <td>{flownCd(d)}</td>
                    <td className={d.descentOk === false ? 'stability-bad' : undefined}>
                      {d.descentRate === null ? '—' : fmtSi('velocity', vel, d.descentRate)}
                    </td>
                    <td>{d.groundSpeed === null ? '—' : fmtSi('velocity', vel, d.groundSpeed)}</td>
                    <td className={problems.length ? 'stability-bad' : 'stability-good'}>
                      {problems.length ? `⚠ ${problems.join(', ')}` : '✓ ok'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(run.branches ?? []).map((b) => {
        const landBad = b.safeLandingRate === false;
        return (
          <div key={b.name} style={{ marginTop: 10 }}>
            <p style={{ margin: '4px 0', fontWeight: 600 }}>
              {b.name}{b.motorLabel ? ` (${b.motorLabel})` : ''} — separate flight:
              {' '}apogee {b.apogee === null ? '—' : fmtSi('distance', dist, b.apogee)} <UnitChip quantity="distance" />
              {' '}· lands at{' '}
              <span className={landBad ? 'stability-bad' : undefined}>
                {b.landingRate === null ? '—' : fmtSi('velocity', vel, b.landingRate)} <UnitChip quantity="velocity" />
              </span>
              {b.deployments.length === 0 && (
                <span className="simdet-comments"> · no recovery device{b.tumbles ? ' (tumbles)' : ''}</span>
              )}
            </p>
            {b.deployments.length > 0 && (
              <div className="motor-table-wrap">
                <table className="motor-table">
                  <thead>
                    <tr>
                      <th>Recovery device</th>
                      <th>Deploys at</th>
                      <th>Altitude (<UnitChip quantity="distance" />)</th>
                      <th>Opens at (<UnitChip quantity="velocity" />)</th>
                      <th>Flown at Cd</th>
                      <th>Descent after (<UnitChip quantity="velocity" />)</th>
                      <th>Over ground (<UnitChip quantity="velocity" />)</th>
                      <th>Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.deployments.map((d, i) => {
                      const problems: string[] = [];
                      if (d.openingOk === false) problems.push('hard opening');
                      if (d.descentOk === false) problems.push(d.isLanding ? 'landing too fast' : 'descent too fast');
                      return (
                        <tr key={i}>
                          <td>{d.device}{d.isLanding ? ' (landing)' : ''}</td>
                          <td>{d.time.toFixed(1)} s</td>
                          <td>{d.altitude === null ? '—' : fmtSi('distance', dist, d.altitude)}</td>
                          <td className={d.openingOk === false ? 'stability-bad' : undefined}>
                            {d.velocityAtDeployment === null ? '—' : fmtSi('velocity', vel, Math.abs(d.velocityAtDeployment))}
                          </td>
                          <td>{flownCd(d)}</td>
                          <td className={d.descentOk === false ? 'stability-bad' : undefined}>
                            {d.descentRate === null ? '—' : fmtSi('velocity', vel, d.descentRate)}
                          </td>
                          <td>{d.groundSpeed === null ? '—' : fmtSi('velocity', vel, d.groundSpeed)}</td>
                          <td className={problems.length ? 'stability-bad' : 'stability-good'}>
                            {problems.length ? `⚠ ${problems.join(', ')}` : '✓ ok'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      {open && (
        <div className="simdet-grid">
          <div>
          <h3>Flight</h3>
          <table className="fin-table">
            <tbody>
              <Row label="Max altitude" value={fmtSi('distance', dist, run.maxAltitude)} quantity="distance" />
              <Row label="Max velocity" value={fmtSi('velocity', vel, run.maxVelocity)} quantity="velocity" />
              <Row label="Max Mach" value={s(run.maxMach, 3)} />
              <Row label="Max acceleration" value={fmtSi('acceleration', acc, run.maxAcceleration)} quantity="acceleration" />
              {/* Most rockets don't roll — below the noise floor the row is
                  omitted rather than showing a meaningless 0.000. r/s matches
                  the desktop's UNITS_ROLL default; °/s rides along because
                  flyers think in degrees. */}
              {run.maxRollRateRadS != null && run.maxRollRateRadS > ROLL_RATE_MEANINGFUL_RAD_S && (
                <Row label="Max roll rate"
                  value={`${(run.maxRollRateRadS / (2 * Math.PI)).toFixed(2)} r/s (${Math.round((run.maxRollRateRadS * 180) / Math.PI)}°/s)`} />
              )}
              <Row label="Time to launch guide exit" value={s(run.timeToRodDeparture, 3)} unit="s" />
              <Row label="Time to burnout" value={s(run.timeToBurnout)} unit="s" />
              <Row label="Time to apogee" value={s(run.timeToApogee)} unit="s" />
              <Row label="Total flight time" value={s(run.totalFlightTime, 1)} unit="s" />
              <Row label="Aero model" value={aeroModelLabel(run.aeroModel, run.rogersKbf)} />
              <Row label="Execution time" value={`${Math.round(run.execMs)} ms`} />
            </tbody>
          </table>
          </div>
          <div>
          <h3>Launch &amp; recovery</h3>
          <table className="fin-table">
            <tbody>
              <Row label="Velocity at launch guide exit"
                value={run.rodExitVelocity === null ? '—' : fmtSi('velocity', vel, run.rodExitVelocity)}
                quantity="velocity" bad={run.safeLiftoffSpeed === false} />
              <Row label="Thrust : weight at departure" value={run.thrustToWeightAtRod === null ? '—' : `${s(run.thrustToWeightAtRod, 1)} : 1`}
                bad={run.safeThrustToWeight === false} />
              <Row label="Launch mass"
                value={run.launchMass === null ? '—' : fmtSi('mass', mass, run.launchMass)} quantity="mass" />
              <Row label="Recovery weight (at burnout)"
                value={run.burnoutMass == null ? '—' : fmtSi('mass', mass, run.burnoutMass)} quantity="mass" />
              {/* The cause, printed beside the effect: this is why the CP below
                  sits forward of the Design tab's. At zero wind they agree. */}
              <Row label="Angle of attack at launch guide exit"
                value={run.rodExitAoa == null ? '—' : s((run.rodExitAoa * 180) / Math.PI, 1)} unit="°" />
              <Row label="CG at launch guide exit"
                value={run.launchCG === null ? '—' : fmtSi('length', len, run.launchCG, 3)} quantity="length" />
              <Row label="CP at launch guide exit"
                value={run.launchCP === null ? '—' : fmtSi('length', len, run.launchCP, 3)} quantity="length" />
              {(() => {
                const m = formatRunStability(
                  run.launchStaticMarginCal, run.launchStaticMarginPct, prefs.stabilityUnit);
                return (
                  <Row label="Static margin at launch guide exit" value={m.value} unit={m.unit}
                    bad={stabilityState(run.launchStaticMarginCal) === 'under'}
                    warn={stabilityState(run.launchStaticMarginCal) === 'over'} />
                );
              })()}
              {(run.deployments ?? []).length === 0 && (
                <>
                  <Row label="Altitude at deployment"
                    value={run.altitudeAtDeployment === null ? '—' : fmtSi('distance', dist, run.altitudeAtDeployment)}
                    quantity="distance" />
                  <Row label="Velocity at deployment"
                    value={run.velocityAtDeployment === null ? '—' : fmtSi('velocity', vel, Math.abs(run.velocityAtDeployment))}
                    quantity="velocity" bad={run.safeDeployment === false} />
                </>
              )}
              <Row label="Landing descent rate"
                value={run.landingRate != null ? fmtSi('velocity', vel, run.landingRate)
                  // Pre-landingRate stored runs fall back to groundHitVelocity —
                  // guard it: landingRate is null exactly when it was non-finite.
                  : Number.isFinite(run.groundHitVelocity) ? fmtSi('velocity', vel, run.groundHitVelocity)
                  : '—'}
                quantity="velocity" bad={run.safeLandingRate === false} />
              {run.landingDistanceM != null && (
                <Row label="Landing distance from pad"
                  value={fmtSi('distance', dist, run.landingDistanceM)} quantity="distance" />
              )}
              {run.landingDistanceM != null && run.landingBearingDeg != null && (
                // Compass bearing (0° = north). The kernel's wind is a fixed
                // east wind (the rocket drifts toward 270°), so a windy
                // flight's drift reads "downwind" when it lands on that side.
                <Row label="Landing bearing"
                  value={`${Math.round(run.landingBearingDeg)}° (${compassPoint(run.landingBearingDeg)}${
                    run.windAvg > 0
                      && Math.abs(((run.landingBearingDeg - WIND_BLOWS_TOWARD_DEG) % 360 + 540) % 360 - 180) <= 45
                      ? ', downwind' : ''})`} />
              )}
            </tbody>
          </table>
          </div>
          <div>
          <h3>Checks &amp; motor</h3>
          <table className="fin-table">
            <tbody>
              <Row label="Lift-off speed OK" {...(() => { const v = verdict(run.safeLiftoffSpeed); return { value: v.text, bad: v.bad }; })()} />
              <Row label="Thrust : weight OK" {...(() => { const v = verdict(run.safeThrustToWeight); return { value: v.text, bad: v.bad }; })()} />
              <Row label="Safe deployment" {...(() => { const v = verdict(run.safeDeployment); return { value: v.text, bad: v.bad }; })()} />
              <Row label="Landing rate OK (≤ 20 ft/s)" {...(() => { const v = verdict(run.safeLandingRate ?? null); return { value: v.text, bad: v.bad }; })()} />
              <Row label="Static margin" {...(() => {
                // Tiered: under-stable is the red failure; over-stable is a
                // yellow caution (weathercocks in wind), matching the design
                // page (issue 2026-08-05a #4/#6).
                const st = stabilityState(run.launchStaticMarginCal);
                return st === null ? { value: '—' }
                  : st === 'under' ? { value: '⚠ under-stable', bad: true }
                  : st === 'over' ? { value: '△ over-stable (caution)', warn: true }
                  : { value: '✓ ok' };
              })()} />
              <Row label="Weathercocking" value={run.weathercockRisk ?? '—'}
                bad={run.weathercockRisk === 'high'} />
              <Row label="Wind average" value={fmtSi('windspeed', prefs.units.windspeed, run.windAvg)} quantity="windspeed" />
              <Row label="Motor diameter" value={`${run.motorDiameterMm} mm`} />
              <Row label="Manufacturer" value={run.manufacturer || '—'} />
              <Row label="Motor type" value={run.motorType || '—'} />
              <Row label="Propellant" value={run.propellant || '—'} />
              <Row label="Motor case" value={run.motorCase || '—'} />
              <Row label="Motors" value={(run.motorCount ?? 1) > 1 ? `${run.motorCount} (cluster)` : '1'} />
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function SimHistory({
  runs, onRunsChange, onSelect, selectedId,
  canShowCharts, onShowCharts, reflyingId, hasChartsFor, designName,
}: {
  runs: SimRun[];
  onRunsChange: (runs: SimRun[]) => void;
  /** Click a row to load that run into the launch report. */
  onSelect?: (run: SimRun) => void;
  selectedId?: string | null;
  /**
   * Whether this run's plots can be recovered by re-flying the current
   * design. False when the design, motor or conditions have moved on — a run
   * whose numbers we could no longer reproduce must not offer to try.
   */
  canShowCharts?: (run: SimRun) => boolean;
  /** Re-fly this run for its series. Must not add a row to the history. */
  onShowCharts?: (run: SimRun) => void;
  /** Run currently being re-flown, if any. */
  reflyingId?: string | null;
  /** Whether this run's series are already in memory (so no button is needed). */
  hasChartsFor?: (run: SimRun) => boolean;
  /** Stamped into the export filenames, as every other export here does. */
  designName?: string;
}) {
  const { prefs } = usePrefs();
  const [open, setOpen] = useState(false);
  const dist = prefs.units.distance;
  const vel = prefs.units.velocity;
  if (runs.length === 0) return null;

  const downloadCsv = () => downloadBlob(
    new Blob([CSV_BOM, runsToCsv(runs, prefs.units)], { type: 'text/csv;charset=utf-8' }),
    stampedName(designName, 'run-table', 'csv'));
  const downloadXlsx = () => {
    const { headers, rows } = runsToTable(runs, prefs.units);
    downloadBlob(
      new Blob([tableToXlsx(headers, rows, 'Simulations') as BlobPart], { type: XLSX_MIME }),
      stampedName(designName, 'run-table', 'xlsx'));
  };

  return (
    <div className={open ? 'panel' : 'panel panel-dormant'} style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ flex: 1 }}>Saved simulations ({runs.length})</h2>
        {/* Every button names its DATA; the format is the parenthetical. Three
            different datasets on this tab used to be labelled "⬇ CSV". */}
        <span className="download-caption">All saved runs — one row each, summary numbers only:</span>
        <button className="file-btn" onClick={downloadCsv}
          title="One row per saved run with its summary numbers — the motor-comparison table, not flight data.">
          ⬇ Run table (.csv)
        </button>
        <button className="file-btn" onClick={downloadXlsx}
          title="The same run table as an Excel workbook: typed cells (no date mangling), bold frozen header, filter.">
          ⬇ Run table (.xlsx)
        </button>
        <button className="file-btn file-btn-danger" onClick={() => onRunsChange(clearRuns())}>Clear all</button>
        <button className="file-btn file-btn-ghost" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open && (
        <div className="motor-table-wrap" style={{ maxHeight: 300 }}>
          <table className="motor-table">
            <thead>
              <tr>
                <th>Rocket</th>
                <th>Motor</th>
                <th>Delay</th>
                <th>Apogee (<UnitChip quantity="distance" />)</th>
                <th>Max V (<UnitChip quantity="velocity" />)</th>
                <th>Opt. delay</th>
                <th>Rod exit (<UnitChip quantity="velocity" />)</th>
                <th>Safe</th>
                <th>When</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                // Over-stability is a caution (△), not a failure — only real
                // failures paint the row's Safe cell red.
                const unsafe = r.safeLiftoffSpeed === false || r.safeDeployment === false
                  || stabilityState(r.launchStaticMarginCal) === 'under'
                  || r.safeThrustToWeight === false
                  || r.safeLandingRate === false
                  || (r.deployments ?? []).some((d) => d.descentOk === false);
                const caution = !unsafe && stabilityState(r.launchStaticMarginCal) === 'over';
                return (
                  <tr
                    key={r.id}
                    className={`motor-row ${selectedId === r.id ? 'motor-row-picked' : ''}`}
                    title="Click to open this run in the launch report"
                    onClick={() => onSelect?.(r)}
                  >
                    <td>{r.rocket || '—'}</td>
                    <td>{r.manufacturer ? `${r.manufacturer} ` : ''}{r.motor}</td>
                    <td>{Number.isFinite(r.delayS) ? `${r.delayS}s` : 'P'}</td>
                    <td>{fmtSi('distance', dist, r.maxAltitude)}</td>
                    <td>{fmtSi('velocity', vel, r.maxVelocity)}</td>
                    <td>{r.optimumDelayS === null ? '—' : `${r.optimumDelayS.toFixed(1)}s`}</td>
                    <td>{r.rodExitVelocity === null ? '—' : fmtSi('velocity', vel, r.rodExitVelocity)}</td>
                    <td className={unsafe ? 'stability-bad' : caution ? 'stability-warn' : 'stability-good'}>
                      {unsafe ? '⚠' : caution ? '△' : '✓'}
                    </td>
                    {/* Date AND time once it is not today's run: the time alone
                        made a three-day-old row identical to a fresh one. */}
                    <td style={{ whiteSpace: 'nowrap' }}>{formatRunWhen(r.when)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {/* Re-flying is a BUTTON, never automatic: six clicks
                          through history must not cost six flights. It is
                          offered only when the current design could still
                          reproduce this run, and disappears once its series
                          are in memory. stopPropagation so it does not also
                          fire the row's own select. */}
                      {onShowCharts && !hasChartsFor?.(r) && canShowCharts?.(r) && (
                        <button className="file-btn" style={{ marginRight: 6, fontSize: 11, padding: '2px 6px' }}
                          disabled={reflyingId != null}
                          title="Re-fly the design at this run's conditions to draw its plots. Deterministic — the same flight, not a new one — and it does not add a row here."
                          onClick={(e) => { e.stopPropagation(); onShowCharts(r); }}>
                          {reflyingId === r.id ? '⏳' : '📈 Charts'}
                        </button>
                      )}
                      <button className="fin-row-del" title="Delete run"
                        onClick={(e) => { e.stopPropagation(); onRunsChange(deleteRun(r.id)); }}>✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
