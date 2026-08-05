import { useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi } from '../prefs/units.js';
import { UnitChip } from './UnitChip.js';
import { stabilityState, type SimRun } from '../services/simReport.js';
import { clearRuns, deleteRun, runsToCsv } from '../services/simStore.js';

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

function verdict(v: boolean | null): { text: string; bad: boolean } {
  return v === null ? { text: '—', bad: false } : v
    ? { text: '✓ yes', bad: false }
    : { text: '⚠ NO', bad: true };
}

export function SimRunDetails({ run }: { run: SimRun }) {
  const { prefs } = usePrefs();
  const [open, setOpen] = useState(false);
  const dist = prefs.units.distance;
  const vel = prefs.units.velocity;
  const len = prefs.units.length;
  const mass = prefs.units.mass;
  const acc = prefs.units.acceleration;

  return (
    <div className="panel" style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ flex: 1 }}>
          Launch report — {run.rocket ? `${run.rocket} · ` : ''}{run.motor}
          {run.manufacturer ? ` (${run.manufacturer})` : ''}
        </h2>
        <button className="file-btn" onClick={() => setOpen(!open)}>
          {open ? 'Hide details' : 'Show all details'}
        </button>
      </div>
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
      {run.comments && <p className="simdet-comments">{run.comments}</p>}
      {(run.deployments ?? []).length > 0 && (
        <div className="motor-table-wrap" style={{ marginTop: 8 }}>
          <table className="motor-table">
            <thead>
              <tr>
                <th>Recovery device</th>
                <th>Deploys at</th>
                <th>Altitude (<UnitChip quantity="distance" />)</th>
                <th>Opens at (<UnitChip quantity="velocity" />)</th>
                <th>Descent after (<UnitChip quantity="velocity" />)</th>
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
                    <td className={d.descentOk === false ? 'stability-bad' : undefined}>
                      {d.descentRate === null ? '—' : fmtSi('velocity', vel, d.descentRate)}
                    </td>
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
                      <th>Descent after (<UnitChip quantity="velocity" />)</th>
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
                          <td className={d.descentOk === false ? 'stability-bad' : undefined}>
                            {d.descentRate === null ? '—' : fmtSi('velocity', vel, d.descentRate)}
                          </td>
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
          <table className="fin-table">
            <tbody>
              <Row label="Max altitude" value={fmtSi('distance', dist, run.maxAltitude)} quantity="distance" />
              <Row label="Max velocity" value={fmtSi('velocity', vel, run.maxVelocity)} quantity="velocity" />
              <Row label="Max Mach" value={s(run.maxMach, 3)} />
              <Row label="Max acceleration" value={fmtSi('acceleration', acc, run.maxAcceleration)} quantity="acceleration" />
              <Row label="Time to launch guide departure" value={s(run.timeToRodDeparture, 3)} unit="s" />
              <Row label="Time to burnout" value={s(run.timeToBurnout)} unit="s" />
              <Row label="Time to apogee" value={s(run.timeToApogee)} unit="s" />
              <Row label="Total flight time" value={s(run.totalFlightTime, 1)} unit="s" />
              <Row label="Aero model" value={run.aeroModel === 'supersonic'
                ? 'Supersonic (RASAero-class)'
                : run.aeroModel === 'auto-supersonic'
                ? `Supersonic (auto — flight exceeded Mach 0.9)`
                : run.aeroModel === 'classic'
                ? `Classic (Extended Barrowman${run.rogersKbf ? ' + Rogers Kbf' : ''})`
                : '—'} />
              <Row label="Execution time" value={`${Math.round(run.execMs)} ms`} />
            </tbody>
          </table>
          <table className="fin-table">
            <tbody>
              <Row label="Velocity at guide departure"
                value={run.rodExitVelocity === null ? '—' : fmtSi('velocity', vel, run.rodExitVelocity)}
                quantity="velocity" bad={run.safeLiftoffSpeed === false} />
              <Row label="Thrust : weight at departure" value={run.thrustToWeightAtRod === null ? '—' : `${s(run.thrustToWeightAtRod, 1)} : 1`}
                bad={run.safeThrustToWeight === false} />
              <Row label="Launch mass"
                value={run.launchMass === null ? '—' : fmtSi('mass', mass, run.launchMass)} quantity="mass" />
              <Row label="Recovery weight (at burnout)"
                value={run.burnoutMass == null ? '—' : fmtSi('mass', mass, run.burnoutMass)} quantity="mass" />
              <Row label="Launch CG"
                value={run.launchCG === null ? '—' : fmtSi('length', len, run.launchCG, 3)} quantity="length" />
              <Row label="Launch CP"
                value={run.launchCP === null ? '—' : fmtSi('length', len, run.launchCP, 3)} quantity="length" />
              <Row label="Launch static margin" value={s(run.launchStaticMarginCal)} unit="cal"
                bad={stabilityState(run.launchStaticMarginCal) === 'under'}
                warn={stabilityState(run.launchStaticMarginCal) === 'over'} />
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
            </tbody>
          </table>
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
      )}
    </div>
  );
}

export function SimHistory({ runs, onRunsChange, onSelect, selectedId }: {
  runs: SimRun[];
  onRunsChange: (runs: SimRun[]) => void;
  /** Click a row to load that run into the launch report. */
  onSelect?: (run: SimRun) => void;
  selectedId?: string | null;
}) {
  const { prefs } = usePrefs();
  const [open, setOpen] = useState(false);
  const dist = prefs.units.distance;
  const vel = prefs.units.velocity;
  if (runs.length === 0) return null;

  const downloadCsv = () => {
    const blob = new Blob([runsToCsv(runs, prefs.units)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'simulations.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className={open ? 'panel' : 'panel panel-dormant'} style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ flex: 1 }}>Saved simulations ({runs.length})</h2>
        <button className="file-btn" onClick={downloadCsv}>⬇ CSV</button>
        <button className="file-btn" onClick={() => onRunsChange(clearRuns())}>Clear all</button>
        <button className="file-btn" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>
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
                    <td>{new Date(r.when).toLocaleTimeString()}</td>
                    <td>
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
