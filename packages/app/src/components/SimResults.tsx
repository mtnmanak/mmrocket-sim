import { useState } from 'react';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi } from '../prefs/units.js';
import { UnitChip } from './UnitChip.js';
import type { SimRun } from '../services/simReport.js';
import { clearRuns, deleteRun, runsToCsv } from '../services/simStore.js';

/**
 * Detailed launch report (the full attribute list from the owner's flight-day
 * workflow) + the stored-run history with CSV export for motor comparison.
 */

function Row({ label, value, quantity, unit, bad }: {
  label: string;
  value: string;
  quantity?: Parameters<typeof UnitChip>[0]['quantity'];
  unit?: string;
  bad?: boolean;
}) {
  return (
    <tr>
      <td className="simdet-label">{label}</td>
      <td className={bad ? 'stability-bad' : undefined}>
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
        <h2 style={{ flex: 1 }}>Launch report — {run.motor}{run.manufacturer ? ` (${run.manufacturer})` : ''}</h2>
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
          {' '}· flown with <strong>{run.delayS} s</strong>
        </p>
      )}
      {run.comments && <p className="simdet-comments">{run.comments}</p>}
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
              <Row label="Launch CG"
                value={run.launchCG === null ? '—' : fmtSi('length', len, run.launchCG)} quantity="length" />
              <Row label="Launch CP"
                value={run.launchCP === null ? '—' : fmtSi('length', len, run.launchCP)} quantity="length" />
              <Row label="Launch static margin" value={s(run.launchStaticMarginCal)} unit="cal"
                bad={run.staticMarginOk === false} />
              <Row label="Altitude at deployment"
                value={run.altitudeAtDeployment === null ? '—' : fmtSi('distance', dist, run.altitudeAtDeployment)}
                quantity="distance" />
              <Row label="Velocity at deployment"
                value={run.velocityAtDeployment === null ? '—' : fmtSi('velocity', vel, Math.abs(run.velocityAtDeployment))}
                quantity="velocity" bad={run.safeDeployment === false} />
              <Row label="Ground hit velocity" value={fmtSi('velocity', vel, run.groundHitVelocity)} quantity="velocity" />
            </tbody>
          </table>
          <table className="fin-table">
            <tbody>
              <Row label="Lift-off speed OK" {...(() => { const v = verdict(run.safeLiftoffSpeed); return { value: v.text, bad: v.bad }; })()} />
              <Row label="Thrust : weight OK" {...(() => { const v = verdict(run.safeThrustToWeight); return { value: v.text, bad: v.bad }; })()} />
              <Row label="Safe deployment" {...(() => { const v = verdict(run.safeDeployment); return { value: v.text, bad: v.bad }; })()} />
              <Row label="Static margin OK" {...(() => { const v = verdict(run.staticMarginOk); return { value: v.text, bad: v.bad }; })()} />
              <Row label="Weathercocking" value={run.weathercockRisk ?? '—'}
                bad={run.weathercockRisk === 'high'} />
              <Row label="Wind average" value={fmtSi('windspeed', prefs.units.windspeed, run.windAvg)} quantity="windspeed" />
              <Row label="Motor diameter" value={`${run.motorDiameterMm} mm`} />
              <Row label="Manufacturer" value={run.manufacturer || '—'} />
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function SimHistory({ runs, onRunsChange }: {
  runs: SimRun[];
  onRunsChange: (runs: SimRun[]) => void;
}) {
  const { prefs } = usePrefs();
  const [open, setOpen] = useState(false);
  const dist = prefs.units.distance;
  const vel = prefs.units.velocity;
  if (runs.length === 0) return null;

  const downloadCsv = () => {
    const blob = new Blob([runsToCsv(runs)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'simulations.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="panel" style={{ marginTop: 10 }}>
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
                const unsafe = r.safeLiftoffSpeed === false || r.safeDeployment === false
                  || r.staticMarginOk === false || r.safeThrustToWeight === false;
                return (
                  <tr key={r.id}>
                    <td title={r.rocket}>{r.manufacturer ? `${r.manufacturer} ` : ''}{r.motor}</td>
                    <td>{r.delayS}s</td>
                    <td>{fmtSi('distance', dist, r.maxAltitude)}</td>
                    <td>{fmtSi('velocity', vel, r.maxVelocity)}</td>
                    <td>{r.optimumDelayS === null ? '—' : `${r.optimumDelayS.toFixed(1)}s`}</td>
                    <td>{r.rodExitVelocity === null ? '—' : fmtSi('velocity', vel, r.rodExitVelocity)}</td>
                    <td className={unsafe ? 'stability-bad' : 'stability-good'}>{unsafe ? '⚠' : '✓'}</td>
                    <td>{new Date(r.when).toLocaleTimeString()}</td>
                    <td>
                      <button className="fin-row-del" title="Delete run"
                        onClick={() => onRunsChange(deleteRun(r.id))}>✕</button>
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
