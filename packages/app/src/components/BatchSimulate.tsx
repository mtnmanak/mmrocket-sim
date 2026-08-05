import { useEffect, useMemo, useRef, useState } from 'react';
import { OrkRocket, type MotorSpec, type RocketTree, type SimulationOptions, type StaticInfo } from '@online-openrocket/engine';
import { engineTree, splitClusterTree } from '../tree/treeModel.js';
import { sheetsToXlsx, type Sheet } from '../services/xlsx.js';
import {
  MOTOR_DB, classLabel, classesFittingMount, displayDesignation, filterMotors,
  isHighPower, manufacturersForMount, sortMotors, type MotorDbEntry,
} from '../services/motorDb.js';
import { exToDbEntry, loadExMotors } from '../services/exMotors.js';
import { fetchMotorSpec, delayOptions } from '../services/thrustcurve.js';
import { buildSimRun, recommendDelay, type SimRun } from '../services/simReport.js';
import { addRuns, runsToCsv, runsToTable } from '../services/simStore.js';
import { XLSX_MIME } from '../services/xlsx.js';
import type { LaunchConditions } from './LaunchPanel.js';
import { usePrefs } from '../prefs/PrefsContext.js';
import { Icon } from './Icon.js';
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
  /** Display label override — combination rows ("2× A + 2× B"). */
  label?: string;
  run?: SimRun;
  error?: string;
  /** Which acceptance criteria this flight failed (empty = accepted). */
  failed: string[];
}

export interface BatchMountOption {
  id: string;
  label: string;
  diameterMm: number;
  /** Cluster count — each candidate fires ×N. */
  motorCount: number;
  /** Effective max motor length (override ?? mount design value), SI m. */
  maxMotorLengthM: number | null;
}

export function BatchSimulate({ info, tree, mounts, initialMountId, assignedMotors, launch, rocketName, onRunsChange, onClose }: {
  /** The editing tree — the batch builds its OWN engine handles from it, so
   *  the design's shared handle is never touched (no restore, no stale
   *  motors left on unassigned mounts). */
  tree: RocketTree;
  info: StaticInfo;
  /** Every motor mount in the (single-stage) design — the user picks which
   *  one the batch targets (2026-08-05: a ring around a central mount needs
   *  the ring selectable). */
  mounts: BatchMountOption[];
  initialMountId: string;
  /** Currently assigned motors by mount id — mounts OTHER than the batch
   *  target fly with these during every batch flight. */
  assignedMotors: Record<string, MotorSpec>;
  launch: LaunchConditions;
  rocketName: string;
  onRunsChange: (runs: SimRun[]) => void;
  onClose: () => void;
}) {
  const { prefs } = usePrefs();
  const dist = prefs.units.distance;
  const vel = prefs.units.velocity;

  const [criteria, setCriteriaRaw] = useState<Criteria>(loadCriteria);
  // Batch-local aero model. Auto is the sensible default: a candidate list
  // routinely spans subsonic to supersonic flights, and one fixed model
  // would be wrong at one end or the other.
  const [batchModel, setBatchModel] = useState<'eb' | 'kbf' | 'auto' | 'supersonic'>('auto');
  // Which mount the batch targets (candidates, cluster count, max length and
  // the combination split all follow it).
  const [mountId, setMountId] = useState(initialMountId);
  const sel = mounts.find((m) => m.id === mountId) ?? mounts[0]!;
  const mountDiameterMm = sel.diameterMm;
  const maxMotorLengthM = sel.maxMotorLengthM;
  const motorCount = sel.motorCount;
  // Combination mode (opt-in, 4- and 6-motor clusters only): also fly every
  // unordered PAIR of candidates split symmetrically across the cluster
  // (2+2 / 3+3 — the owner's symmetry rule; larger clusters deliberately out).
  const [comboMode, setComboMode] = useState(false);
  const clusterSplit = useMemo(() => splitClusterTree(tree, sel.id), [tree, sel.id]);
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
    const kbf = batchModel !== 'eb';
    // The batch flies its OWN handle built from the tree — the design's
    // shared handle is never touched. Mounts other than the target keep
    // their assigned motors for every flight.
    const applyOthers = (r: OrkRocket, targetIds: string[]) => {
      for (const [id, spec] of Object.entries(assignedMotors)) {
        if (!targetIds.includes(id)) {
          try { r.setMotorById(id, spec); } catch { /* mount absent in variant */ }
        }
      }
    };
    const batchRocket = OrkRocket.buildTree(engineTree(tree));
    batchRocket.setRogersModifiedBarrowman(kbf);
    batchRocket.setSupersonicAero(batchModel === 'supersonic');
    applyOthers(batchRocket, [sel.id]);
    const rocket = batchRocket;
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

    const comboActive = comboMode && clusterSplit !== null;
    const comboCount = comboActive ? (candidates.length * (candidates.length - 1)) / 2 : 0;
    const totalSims = candidates.length + comboCount;
    // Motor specs fetched in the single pass, reused by the combination pass.
    const specCache = new Map<string, Awaited<ReturnType<typeof fetchMotorSpec>>>();

    for (let i = 0; i < candidates.length; i++) {
      if (cancelled.current) break;
      const entry = candidates[i]!;
      setProgress({ done: i, total: totalSims, current: `${entry.manufacturerAbbrev} ${displayDesignation(entry.designation, entry.manufacturerAbbrev)}` });
      // Yield to the browser so the progress bar paints between sims.
      await new Promise((r) => setTimeout(r, 0));
      try {
        // Batch flies each motor's longest PRESCRIBED delay provisionally,
        // then re-flies at the recommended optimum — never plugged (Infinity),
        // which would turn the comparison flight ballistic.
        const opts = delayOptions(entry).filter((d) => Number.isFinite(d));
        const provisional = opts[opts.length - 1] ?? 0;
        const spec = await fetchMotorSpec(entry, provisional);
        specCache.set(entry.motorId, spec);
        const t0 = performance.now();
        // Auto: each candidate flies the Kbf model first and re-flies wholly
        // supersonic when projected past Mach 0.9 — per MOTOR, exactly like
        // the single-flight Auto loop.
        if (batchModel === 'auto') rocket.setSupersonicAero(false);
        rocket.setMotorById(mountId, spec);
        let res = rocket.simulate(simOpts);
        let usedSupersonic = batchModel === 'supersonic';
        if (batchModel === 'auto' && res.summary.maxMachNumber > 0.9) {
          rocket.setSupersonicAero(true);
          res = rocket.simulate(simOpts);
          usedSupersonic = true;
        }
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
          aeroModel: batchModel === 'auto' && usedSupersonic ? 'auto-supersonic'
            : usedSupersonic ? 'supersonic' : 'classic',
          rogersKbf: kbf && !usedSupersonic,
          ...(comboActive ? { motorConfig: 'single' } : {}),
        });
        const failed = gradeRun(run);
        out.push({ entry, run, failed });
        if (failed.length === 0) accepted.push(run);
      } catch (e) {
        out.push({ entry, error: e instanceof Error ? e.message : String(e), failed: ['error'] });
      }
      setRows([...out]);
    }

    // ---- Combination pass (opt-in): every unordered pair of candidates,
    // split symmetrically across the cluster (2+2 / 3+3). The split-mount
    // variant is a SEPARATE engine handle; the design handle is untouched.
    if (comboActive && !cancelled.current && clusterSplit) {
      const group = clusterSplit.groupSize;
      const configTag = `mixed ${group}+${group}`;
      const comboRocket = OrkRocket.buildTree(engineTree(clusterSplit.tree));
      comboRocket.setRogersModifiedBarrowman(kbf);
      comboRocket.setSupersonicAero(batchModel === 'supersonic');
      applyOthers(comboRocket, [...clusterSplit.mountIds, sel.id]);
      const [idA, idB] = clusterSplit.mountIds;
      let done = candidates.length;
      for (let i = 0; i < candidates.length && !cancelled.current; i++) {
        for (let j = i + 1; j < candidates.length && !cancelled.current; j++) {
          const eA = candidates[i]!;
          const eB = candidates[j]!;
          const label = `${group}× ${displayDesignation(eA.designation, eA.manufacturerAbbrev)} + ${group}× ${displayDesignation(eB.designation, eB.manufacturerAbbrev)}`;
          setProgress({ done, total: totalSims, current: label });
          done++;
          await new Promise((r) => setTimeout(r, 0));
          try {
            const specA = specCache.get(eA.motorId) ?? await fetchMotorSpec(eA, 0);
            const specB = specCache.get(eB.motorId) ?? await fetchMotorSpec(eB, 0);
            const t0 = performance.now();
            if (batchModel === 'auto') comboRocket.setSupersonicAero(false);
            comboRocket.setMotorById(idA, specA);
            comboRocket.setMotorById(idB, specB);
            let res = comboRocket.simulate(simOpts);
            let usedSupersonic = batchModel === 'supersonic';
            if (batchModel === 'auto' && res.summary.maxMachNumber > 0.9) {
              comboRocket.setSupersonicAero(true);
              res = comboRocket.simulate(simOpts);
              usedSupersonic = true;
            }
            let flownDelay = specA.ejectionDelay;
            if (criteria.autoDelay) {
              const rec = recommendDelay(res.summary.optimumDelay);
              if (rec !== null) {
                flownDelay = rec;
                comboRocket.setMotorById(idA, { ...specA, ejectionDelay: rec });
                comboRocket.setMotorById(idB, { ...specB, ejectionDelay: rec });
                res = comboRocket.simulate(simOpts);
              }
            }
            const run = buildSimRun({
              result: res,
              info,
              motor: { ...specA, ejectionDelay: flownDelay },
              meta: {
                label,
                manufacturer: eA.manufacturerAbbrev === eB.manufacturerAbbrev ? eA.manufacturerAbbrev : `${eA.manufacturerAbbrev}+${eB.manufacturerAbbrev}`,
                autoDelay: criteria.autoDelay,
                motorCount: group * 2,
                highPower: isHighPower(eA) || isHighPower(eB),
              },
              launch,
              rocketName,
              execMs: performance.now() - t0,
              aeroModel: batchModel === 'auto' && usedSupersonic ? 'auto-supersonic'
                : usedSupersonic ? 'supersonic' : 'classic',
              rogersKbf: kbf && !usedSupersonic,
              motorConfig: configTag,
            });
            // The stored designation is the pair label so saved runs read right.
            run.motor = label;
            const failed = gradeRun(run);
            out.push({ entry: eA, label, run, failed });
            if (failed.length === 0) accepted.push(run);
          } catch (e) {
            out.push({ entry: eA, label, error: e instanceof Error ? e.message : String(e), failed: ['error'] });
          }
          setRows([...out]);
        }
      }
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

  const downloadAs = (blob: Blob, ext: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `batch-${rocketName.replace(/[^\w-]+/g, '_')}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  // Export ordering (the owner's spec): with combination results present, group by
  // motor config — all single-motor rows first, then the mixed pairs — each
  // group keeping the accepted-then-apogee sort.
  const exportRuns = (): SimRun[] => {
    const runsOnly = sorted.filter((r) => r.run).map((r) => r.run!);
    if (!runsOnly.some((r) => r.motorConfig?.startsWith('mixed'))) return runsOnly;
    return [
      ...runsOnly.filter((r) => !r.motorConfig?.startsWith('mixed')),
      ...runsOnly.filter((r) => r.motorConfig?.startsWith('mixed')),
    ];
  };
  const downloadCsv = () => {
    downloadAs(new Blob([runsToCsv(exportRuns(), prefs.units)], { type: 'text/csv' }), 'csv');
  };
  const downloadXlsx = () => {
    const all = exportRuns();
    const mixed = all.filter((r) => r.motorConfig?.startsWith('mixed'));
    // Combination batches get one tab per config PLUS an everything tab.
    const sheets: Sheet[] = mixed.length === 0
      ? [{ name: 'Batch', ...runsToTable(all, prefs.units) }]
      : [
        { name: 'All results', ...runsToTable(all, prefs.units) },
        { name: 'Single motor', ...runsToTable(all.filter((r) => !r.motorConfig?.startsWith('mixed')), prefs.units) },
        { name: `Mixed ${mixed[0]!.motorConfig!.replace('mixed ', '')}`, ...runsToTable(mixed, prefs.units) },
      ];
    downloadAs(new Blob([sheetsToXlsx(sheets) as BlobPart], { type: XLSX_MIME }), 'xlsx');
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
            <label className="motor-inline-label" title="Which physics model the batch flies. Auto is recommended: candidates often straddle Mach 1, and each motor gets the model its own flight calls for.">
              aero model
              <select value={batchModel} disabled={running}
                onChange={(e) => setBatchModel(e.target.value as typeof batchModel)}>
                <option value="auto">Auto (recommended)</option>
                <option value="kbf">Rogers Modified Barrowman</option>
                <option value="eb">Extended Barrowman (desktop)</option>
                <option value="supersonic">Supersonic — all speeds</option>
              </select>
            </label>
            {mounts.length > 1 && (
              <label className="motor-inline-label"
                title="Which motor mount the batch flies candidates in. Other mounts keep their currently loaded motors for every flight.">
                mount
                <select value={mountId} disabled={running}
                  onChange={(e) => { setMountId(e.target.value); setComboMode(false); }}>
                  {mounts.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </label>
            )}
            {clusterSplit && (
              <label className="motor-inline-label"
                title={`Also fly every PAIR of candidates split symmetrically across the ${clusterSplit.groupSize * 2}-motor cluster (${clusterSplit.groupSize}+${clusterSplit.groupSize} in opposite tubes). Off = one motor type in every tube (the default). Pairs grow fast — n candidates add n·(n−1)/2 extra flights.`}>
                <input type="checkbox" checked={comboMode} style={{ width: 'auto' }}
                  onChange={(e) => setComboMode(e.target.checked)} />
                mixed pairs ({clusterSplit.groupSize}+{clusterSplit.groupSize})
              </label>
            )}
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
            {comboMode && clusterSplit
              && ` · +${(candidates.length * (candidates.length - 1)) / 2} mixed ${clusterSplit.groupSize}+${clusterSplit.groupSize} combinations`}
            {tooLongCount > 0 && ` · ${tooLongCount} excluded (over max motor length)`}
            {criteria.autoDelay ? ' · 2 sims each (delay probe + final)' : ''}
            {progress && ` — simulating ${progress.done + 1}/${progress.total}: ${progress.current}`}
          </span>
          {rows.some((r) => r.run) && (
            <>
              <button className="file-btn" onClick={downloadCsv}>⬇ CSV</button>
              <button className="file-btn" onClick={downloadXlsx}
                title="Excel workbook: typed cells (no date mangling), bold frozen header, filter">⬇ XLSX</button>
            </>
          )}
          {running ? (
            <button className="file-btn modal-danger" onClick={() => { cancelled.current = true; }}>
              Stop
            </button>
          ) : (
            <button className="launch-btn" style={{ width: 'auto', marginTop: 0, padding: '6px 16px' }}
              onClick={start} disabled={candidates.length === 0}>
              <Icon name="rocket" /> Simulate {candidates.length} motors
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
                {sorted.map(({ entry, label, run, error, failed }, rowIdx) => (
                  <tr key={label ?? `${entry.motorId}-${rowIdx}`} className={failed.length ? 'motor-row-long' : ''}>
                    <td>{label ?? `${entry.manufacturerAbbrev} ${displayDesignation(entry.designation, entry.manufacturerAbbrev)}`}</td>
                    <td>{run ? (Number.isFinite(run.delayS) ? `${run.delayS}s` : 'P') : '—'}</td>
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
