import { useEffect, useMemo, useRef, useState } from 'react';
import type { OrkRocket, SimulationOptions, StaticInfo } from '@online-openrocket/engine';
import {
  MOTOR_DB, classLabel, classesFittingMount, displayDesignation, filterMotors,
  isHighPower, manufacturersForMount, sortMotors, type MotorDbEntry,
} from '../services/motorDb.js';
import { exToDbEntry, loadExMotors } from '../services/exMotors.js';
import { fetchMotorSpec, delayOptions } from '../services/thrustcurve.js';
import { buildSimRun, recommendDelay, type SimRun } from '../services/simReport.js';
import { addRuns, runsToCsv } from '../services/simStore.js';
import type { LaunchConditions } from './LaunchPanel.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { fmtSi, siToUi, uiToSi } from '../prefs/units.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';

/**
 * Batch simulation: fly EVERY motor that fits the mount (after filters)
 * through the current design, using the auto-optimal delay per motor, and
 * grade each flight against acceptance criteria (min rod-exit velocity,
 * min thrust:weight, apogee window). Results append to the stored-runs
 * table and download as CSV — the owner's motor-selection flow for a flight day.
 */

const CRITERIA_KEY = 'online-openrocket.batch-criteria.v1';

interface Criteria {
  /** SI m/s; null = don't filter. */
  minRodExit: number | null;
  minThrustToWeight: number | null;
  /** SI meters AGL. */
  minApogee: number | null;
  maxApogee: number | null;
  autoDelay: boolean;
  includeOOP: boolean;
  manufacturers: string[];
  classes: number[];
}

const DEFAULT_CRITERIA: Criteria = {
  minRodExit: null, minThrustToWeight: null, minApogee: null, maxApogee: null,
  autoDelay: true, includeOOP: false, manufacturers: [], classes: [],
};

function loadCriteria(): Criteria {
  try {
    const raw = localStorage.getItem(CRITERIA_KEY);
    return raw ? { ...DEFAULT_CRITERIA, ...(JSON.parse(raw) as Partial<Criteria>) } : DEFAULT_CRITERIA;
  } catch {
    return DEFAULT_CRITERIA;
  }
}

interface BatchRow {
  entry: MotorDbEntry;
  run?: SimRun;
  error?: string;
  /** Which acceptance criteria this flight failed (empty = accepted). */
  failed: string[];
}

export function BatchSimulate({ rocket, info, mountId, mountDiameterMm, maxMotorLengthM, motorCount, launch, rocketName, aeroModelLabel, onRunsChange, onClose }: {
  rocket: OrkRocket;
  info: StaticInfo;
  mountId: string;
  mountDiameterMm: number;
  /** Rocket-level max motor length (SI m); null = no limit. Too-long motors are excluded. */
  maxMotorLengthM: number | null;
  /** Cluster count of the mount — each candidate fires ×N (thrust/mass automatic). */
  motorCount: number;
  launch: LaunchConditions;
  rocketName: string;
  /** Aero model on the design's engine handle (batch flies all candidates on it). */
  aeroModelLabel: 'classic' | 'supersonic' | 'auto-supersonic';
  onRunsChange: (runs: SimRun[]) => void;
  onClose: () => void;
}) {
  const { prefs } = usePrefs();
  const dist = prefs.units.distance;
  const vel = prefs.units.velocity;

  const [criteria, setCriteriaRaw] = useState<Criteria>(loadCriteria);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  const cancelled = useRef(false);

  const setCriteria = (next: Criteria) => {
    setCriteriaRaw(next);
    try { localStorage.setItem(CRITERIA_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
  };

  // Bundled DB + imported EX motors (they simulate like any other).
  const allMotors = useMemo(() => [...MOTOR_DB, ...loadExMotors().map(exToDbEntry)], []);

  const fittingClasses = useMemo(
    () => classesFittingMount(mountDiameterMm, allMotors), [mountDiameterMm, allMotors]);
  const manufacturers = useMemo(
    () => manufacturersForMount(mountDiameterMm, criteria.includeOOP, allMotors),
    [mountDiameterMm, criteria.includeOOP, allMotors],
  );

  // Motors longer than the rocket's max motor length are EXCLUDED here (not
  // just flagged): in a batch there's no point flying motors that don't fit.
  const { candidates, tooLongCount } = useMemo(() => {
    const filtered = filterMotors({
      manufacturers: new Set(criteria.manufacturers),
      classes: new Set(criteria.classes.filter((c) => fittingClasses.includes(c))),
      boreMm: mountDiameterMm,
      includeOOP: criteria.includeOOP,
      text: '',
    }, allMotors);
    const fitting = maxMotorLengthM === null
      ? filtered
      : filtered.filter((m) => m.length / 1000 <= maxMotorLengthM);
    return {
      candidates: sortMotors(fitting, 'totImpulseNs', -1),
      tooLongCount: filtered.length - fitting.length,
    };
  }, [criteria, mountDiameterMm, maxMotorLengthM, fittingClasses, allMotors]);

  useEffect(() => () => { cancelled.current = true; }, []);

  const toggle = <T,>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const gradeRun = (run: SimRun): string[] => {
    const failed: string[] = [];
    if (criteria.minRodExit !== null
        && (run.rodExitVelocity === null || run.rodExitVelocity < criteria.minRodExit)) {
      failed.push('rod-exit velocity');
    }
    if (criteria.minThrustToWeight !== null
        && (run.thrustToWeightAtRod === null || run.thrustToWeightAtRod < criteria.minThrustToWeight)) {
      failed.push('thrust:weight');
    }
    if (criteria.minApogee !== null && run.maxAltitude < criteria.minApogee) failed.push('apogee too low');
    if (criteria.maxApogee !== null && run.maxAltitude > criteria.maxApogee) failed.push('apogee too high');
    return failed;
  };

  const start = async () => {
    setRunning(true);
    cancelled.current = false;
    setRows([]);
    const out: BatchRow[] = [];
    const accepted: SimRun[] = [];
    const simOpts: SimulationOptions = {
      launchRodLength: launch.launchRodLengthM,
      launchRodAngle: (launch.launchRodAngleDeg * Math.PI) / 180,
      windAverage: launch.windAverage,
      windStdDeviation: launch.windStdDev,
      launchAltitude: launch.launchAltitudeM,
      temperature: launch.temperatureC === null ? undefined : launch.temperatureC + 273.15,
      pressure: launch.pressureHPa === null ? undefined : launch.pressureHPa * 100,
      launchLatitude: launch.latitudeDeg,
    };

    for (let i = 0; i < candidates.length; i++) {
      if (cancelled.current) break;
      const entry = candidates[i]!;
      setProgress({ done: i, total: candidates.length, current: `${entry.manufacturerAbbrev} ${displayDesignation(entry.designation, entry.manufacturerAbbrev)}` });
      // Yield to the browser so the progress bar paints between sims.
      await new Promise((r) => setTimeout(r, 0));
      try {
        const opts = delayOptions(entry);
        const provisional = opts[opts.length - 1] ?? 0;
        const spec = await fetchMotorSpec(entry, provisional);
        const t0 = performance.now();
        rocket.setMotorById(mountId, spec);
        let res = rocket.simulate(simOpts);
        let flownDelay = provisional;
        if (criteria.autoDelay) {
          const rec = recommendDelay(res.summary.optimumDelay);
          if (rec !== null && rec !== provisional) {
            flownDelay = rec;
            rocket.setMotorById(mountId, { ...spec, ejectionDelay: rec });
            res = rocket.simulate(simOpts);
          } else if (rec !== null) {
            flownDelay = rec;
          }
        }
        const run = buildSimRun({
          result: res,
          info,
          motor: { ...spec, ejectionDelay: flownDelay },
          meta: {
            label: entry.designation,
            manufacturer: entry.manufacturerAbbrev,
            availableDelays: opts,
            autoDelay: criteria.autoDelay,
            type: entry.type,
            propellant: entry.propInfo,
            motorCase: entry.caseInfo,
            motorCount,
            highPower: isHighPower(entry),
          },
          launch,
          rocketName,
          execMs: performance.now() - t0,
          // Batch flies on whatever model the design's engine handle carries
          // (Auto mode: the model chosen by the design's last single flight).
          aeroModel: aeroModelLabel,
        });
        const failed = gradeRun(run);
        out.push({ entry, run, failed });
        if (failed.length === 0) accepted.push(run);
      } catch (e) {
        out.push({ entry, error: e instanceof Error ? e.message : String(e), failed: ['error'] });
      }
      setRows([...out]);
    }

    setProgress(null);
    setRunning(false);
    if (accepted.length > 0) onRunsChange(addRuns(accepted));
  };

  const sorted = useMemo(() => [...rows].sort((a, b) => {
    if (!a.run) return 1;
    if (!b.run) return -1;
    if ((a.failed.length === 0) !== (b.failed.length === 0)) return a.failed.length === 0 ? -1 : 1;
    return b.run.maxAltitude - a.run.maxAltitude;
  }), [rows]);

  const downloadCsv = () => {
    const runsOnly = sorted.filter((r) => r.run).map((r) => r.run!);
    const blob = new Blob([runsToCsv(runsOnly)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `batch-${rocketName.replace(/[^\w-]+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const velUi = (si: number | null) => (si === null ? undefined : siToUi('velocity', vel, si));
  const distUi = (si: number | null) => (si === null ? undefined : siToUi('distance', dist, si));

  return (
    <div className="prefs-overlay" role="presentation" onClick={running ? undefined : onClose}>
      <div className="prefs-dialog panel motor-browser" role="dialog" aria-label="Batch simulate motors"
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ flex: 1 }}>
            Batch simulate — every motor that fits
            {motorCount > 1 && <span className="motor-db-meta"> cluster mount: each candidate fires ×{motorCount}</span>}
          </h2>
          <button className="file-btn" onClick={onClose} disabled={running}>✕ Close</button>
        </div>

        <div className="motor-filter-block">
          <div className="motor-chip-row" role="group" aria-label="Manufacturers">
            <span className="motor-chip-caption">Makers</span>
            {manufacturers.map(({ abbrev, count }) => (
              <button key={abbrev}
                className={`series-chip ${criteria.manufacturers.includes(abbrev) ? 'series-chip-on' : ''}`}
                onClick={() => setCriteria({ ...criteria, manufacturers: toggle(criteria.manufacturers, abbrev) })}>
                {abbrev} <span className="motor-chip-count">{count}</span>
              </button>
            ))}
            {criteria.manufacturers.length > 0 && (
              <button className="file-btn" onClick={() => setCriteria({ ...criteria, manufacturers: [] })}>all</button>
            )}
          </div>
          <div className="motor-chip-row" role="group" aria-label="Diameter classes">
            <span className="motor-chip-caption">Diameter</span>
            {fittingClasses.map((c) => (
              <button key={c}
                className={`series-chip ${criteria.classes.includes(c) ? 'series-chip-on' : ''}`}
                onClick={() => setCriteria({ ...criteria, classes: toggle(criteria.classes, c) })}>
                {classLabel(c)} mm
              </button>
            ))}
          </div>
          <div className="motor-filter-row" style={{ flexWrap: 'wrap' }}>
            <label className="motor-inline-label">
              Min rod-exit <UnitChip quantity="velocity" />
              <NumField value={velUi(criteria.minRodExit)} step={1} nullable placeholder="—"
                onCommit={(v) => setCriteria({ ...criteria, minRodExit: v === null ? null : uiToSi('velocity', vel, v) })} />
            </label>
            <label className="motor-inline-label">
              Min thrust:weight
              <NumField value={criteria.minThrustToWeight ?? undefined} step={0.5} nullable placeholder="—"
                onCommit={(v) => setCriteria({ ...criteria, minThrustToWeight: v })} />
            </label>
            <label className="motor-inline-label">
              Apogee min <UnitChip quantity="distance" />
              <NumField value={distUi(criteria.minApogee)} step={10} nullable placeholder="—"
                onCommit={(v) => setCriteria({ ...criteria, minApogee: v === null ? null : uiToSi('distance', dist, v) })} />
            </label>
            <label className="motor-inline-label">
              max <UnitChip quantity="distance" />
              <NumField value={distUi(criteria.maxApogee)} step={10} nullable placeholder="—"
                onCommit={(v) => setCriteria({ ...criteria, maxApogee: v === null ? null : uiToSi('distance', dist, v) })} />
            </label>
            <label className="motor-inline-label">
              <input type="checkbox" checked={criteria.autoDelay} style={{ width: 'auto' }}
                onChange={(e) => setCriteria({ ...criteria, autoDelay: e.target.checked })} />
              optimal delay per motor
            </label>
            <label className="motor-inline-label">
              <input type="checkbox" checked={criteria.includeOOP} style={{ width: 'auto' }}
                onChange={(e) => setCriteria({ ...criteria, includeOOP: e.target.checked })} />
              include OOP
            </label>
          </div>
        </div>

        <div className="motor-load-row">
          <span style={{ flex: 1 }} className="motor-db-meta">
            {candidates.length} candidate motors
            {tooLongCount > 0 && ` · ${tooLongCount} excluded (over max motor length)`}
            {criteria.autoDelay ? ' · 2 sims each (delay probe + final)' : ''}
            {progress && ` — simulating ${progress.done + 1}/${progress.total}: ${progress.current}`}
          </span>
          {rows.some((r) => r.run) && (
            <button className="file-btn" onClick={downloadCsv}>⬇ CSV</button>
          )}
          {running ? (
            <button className="file-btn modal-danger" onClick={() => { cancelled.current = true; }}>
              Stop
            </button>
          ) : (
            <button className="launch-btn" style={{ width: 'auto', marginTop: 0, padding: '6px 16px' }}
              onClick={start} disabled={candidates.length === 0}>
              🚀 Simulate {candidates.length} motors
            </button>
          )}
        </div>
        {progress && (
          <div className="batch-progress">
            <div className="batch-progress-fill" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
        )}

        {sorted.length > 0 && (
          <div className="motor-table-wrap" style={{ maxHeight: 320 }}>
            <table className="motor-table">
              <thead>
                <tr>
                  <th>Motor</th>
                  <th>Delay</th>
                  <th>Apogee (<UnitChip quantity="distance" />)</th>
                  <th>Rod exit (<UnitChip quantity="velocity" />)</th>
                  <th>T:W</th>
                  <th>Opt. delay</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(({ entry, run, error, failed }) => (
                  <tr key={entry.motorId} className={failed.length ? 'motor-row-long' : ''}>
                    <td>{entry.manufacturerAbbrev} {displayDesignation(entry.designation, entry.manufacturerAbbrev)}</td>
                    <td>{run ? `${run.delayS}s` : '—'}</td>
                    <td>{run ? fmtSi('distance', dist, run.maxAltitude) : '—'}</td>
                    <td>{run?.rodExitVelocity != null ? fmtSi('velocity', vel, run.rodExitVelocity) : '—'}</td>
                    <td>{run?.thrustToWeightAtRod != null ? run.thrustToWeightAtRod.toFixed(1) : '—'}</td>
                    <td>{run?.optimumDelayS != null ? `${run.optimumDelayS.toFixed(1)}s` : '—'}</td>
                    <td className={failed.length ? 'stability-bad' : 'stability-good'}>
                      {error ? `error: ${error}` : failed.length ? `✗ ${failed.join(', ')}` : '✓ accepted'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
