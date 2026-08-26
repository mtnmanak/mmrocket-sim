import { useEffect, useMemo, useRef, useState } from 'react';
import { useDialog } from './useDialog.js';
import { OrkRocket, type MotorSpec, type RocketTree, type SimulationOptions, type StaticInfo } from '@online-openrocket/engine';
import { engineTree, splitClusterPairsTree, splitClusterTree, stageIndexOf, stages, type ClusterSplit } from '../tree/treeModel.js';
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
import { kernelSimOptions, type LaunchConditions } from './LaunchPanel.js';
import { machProbeSeconds } from '../services/machProbe.js';
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
  // Combination modes (opt-in, 4- and 6-motor clusters only):
  //  - group mode: the cluster split in HALVES (2+2 / 3+3), every unordered
  //    pair of candidates;
  //  - pair mode (6-ring only): split into THREE opposite-tube pairs, every
  //    candidate multiset — covers 4+2 and 2+2+2 (the owner flies these).
  const [comboMode, setComboMode] = useState(false);
  const [pairMode, setPairMode] = useState(false);
  const clusterSplit = useMemo(() => splitClusterTree(tree, sel.id), [tree, sel.id]);
  const pairSplit = useMemo(() => splitClusterPairsTree(tree, sel.id), [tree, sel.id]);
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
    // An aborted flight can never be "accepted": the kernel stopped it early,
    // so its apogee is whatever height the rocket had reached when it gave up.
    // Before this, a tumbling design's 140 m truncated flight could sail past
    // an apogee criterion and be graded ✓ in green.
    if (run.simWarnings?.some((w) => w.key === 'SIM_ABORT')) {
      failed.push('flight stopped early');
    }
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
    // The probe cutoff has to see the WHOLE stack, not just the motor under
    // test: a candidate in the sustainer waits on the booster below it, and a
    // cutoff computed from the candidate alone ends before it ever lights.
    // The launch stage is the LAST one — stage 0 is the sustainer.
    const bottomStageIdx = stages(tree).length - 1;
    const probeCutoff = (targets: Record<string, MotorSpec>) => machProbeSeconds(
      Object.entries({ ...assignedMotors, ...targets }).map(([id, spec]) => ({
        spec,
        onLaunchStage: stageIndexOf(tree, id) === bottomStageIdx,
      })));
    // The shared construction — this used to be a private copy that omitted
    // `timeStep`, so a design carrying its own step from its .ork gave one set
    // of numbers here and a different set on the Launch button.
    const simOpts: SimulationOptions = kernelSimOptions(launch);

    const activeSplits: ClusterSplit[] = [
      ...(comboMode && clusterSplit ? [clusterSplit] : []),
      ...(pairMode && pairSplit ? [pairSplit] : []),
    ];
    const comboActive = activeSplits.length > 0;
    const n = candidates.length;
    const comboCount = activeSplits.reduce((sum, s) => sum
      + (s.mountIds.length === 2 ? (n * (n - 1)) / 2 : (n * (n + 1) * (n + 2)) / 6 - n), 0);
    const totalSims = n + comboCount;
    // Multisets of `size` candidate indices (non-decreasing), excluding
    // all-same (those are the single-motor rows already flown).
    function* comboAssignments(count: number, size: number): Generator<number[]> {
      const idx = new Array<number>(size).fill(0);
      while (true) {
        if (!idx.every((v) => v === idx[0])) yield [...idx];
        // increment odometer with non-decreasing constraint
        let p = size - 1;
        while (p >= 0) {
          idx[p]!++;
          if (idx[p]! < count) {
            for (let q = p + 1; q < size; q++) idx[q] = idx[p]!;
            break;
          }
          p--;
        }
        if (p < 0) break;
      }
    }
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
        // Auto: each candidate picks its model from a SHORT probe run and then
        // flies once — per MOTOR, exactly like the single-flight Auto loop.
        // This used to fly the whole classic flight and, on a supersonic
        // candidate, throw it away and fly the whole thing again, per candidate.
        if (batchModel === 'auto') rocket.setSupersonicAero(false);
        rocket.setMotorById(mountId, spec);
        let usedSupersonic = batchModel === 'supersonic';
        if (batchModel === 'auto') {
          const probe = rocket.simulate({ ...simOpts, maxTime: probeCutoff({ [mountId]: spec }) });
          if (probe.summary.maxMachNumber > 0.9) {
            rocket.setSupersonicAero(true);
            usedSupersonic = true;
          }
        }
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

    // ---- Combination passes (opt-in): symmetric group splits of the
    // cluster, each on a SEPARATE engine handle (the design handle is
    // untouched). Group mode = 2 halves (2+2 / 3+3, unordered pairs of
    // candidates); pair mode (6-ring) = 3 opposite-tube pairs, flying every
    // MULTISET of candidates except all-same (covers 4+2 and 2+2+2 —
    // the owner's real-world configs, 2026-08-05d).
    let done = candidates.length;
    for (const split of activeSplits) {
      if (cancelled.current) break;
      const comboRocket = OrkRocket.buildTree(engineTree(split.tree));
      comboRocket.setRogersModifiedBarrowman(kbf);
      comboRocket.setSupersonicAero(batchModel === 'supersonic');
      applyOthers(comboRocket, [...split.mountIds, sel.id]);
      for (const idxs of comboAssignments(candidates.length, split.mountIds.length)) {
        if (cancelled.current) break;
        const entries = idxs.map((i) => candidates[i]!);
        // Collapse equal groups for the label: [A,A,B] → "4× A + 2× B".
        const counts = new Map<string, { entry: MotorDbEntry; groups: number }>();
        for (const e of entries) {
          const cur = counts.get(e.motorId);
          if (cur) cur.groups++;
          else counts.set(e.motorId, { entry: e, groups: 1 });
        }
        const label = [...counts.values()]
          .map(({ entry: e, groups }) => `${groups * split.groupSize}× ${displayDesignation(e.designation, e.manufacturerAbbrev)}`)
          .join(' + ');
        const configTag = split.mountIds.length === 2
          ? `mixed ${split.groupSize}+${split.groupSize}`
          : counts.size === 2 ? 'mixed 4+2' : 'mixed 2+2+2';
        setProgress({ done, total: totalSims, current: label });
        done++;
        await new Promise((r) => setTimeout(r, 0));
        try {
          const specs = await Promise.all(entries.map(async (e) =>
            specCache.get(e.motorId) ?? await fetchMotorSpec(e, 0)));
          const t0 = performance.now();
          if (batchModel === 'auto') comboRocket.setSupersonicAero(false);
          split.mountIds.forEach((id, k) => comboRocket.setMotorById(id, specs[k]!));
          let usedSupersonic = batchModel === 'supersonic';
          if (batchModel === 'auto') {
            const probe = comboRocket.simulate({
              ...simOpts,
              maxTime: probeCutoff(Object.fromEntries(
                split.mountIds.map((id, k) => [id, specs[k]!]))),
            });
            if (probe.summary.maxMachNumber > 0.9) {
              comboRocket.setSupersonicAero(true);
              usedSupersonic = true;
            }
          }
          let res = comboRocket.simulate(simOpts);
          let flownDelay = specs[0]!.ejectionDelay;
          if (criteria.autoDelay) {
            const rec = recommendDelay(res.summary.optimumDelay);
            if (rec !== null) {
              flownDelay = rec;
              split.mountIds.forEach((id, k) =>
                comboRocket.setMotorById(id, { ...specs[k]!, ejectionDelay: rec }));
              res = comboRocket.simulate(simOpts);
            }
          }
          const manuf = [...new Set(entries.map((e) => e.manufacturerAbbrev))].join('+');
          const run = buildSimRun({
            result: res,
            info,
            motor: { ...specs[0]!, ejectionDelay: flownDelay },
            meta: {
              label,
              manufacturer: manuf,
              autoDelay: criteria.autoDelay,
              motorCount: split.groupSize * split.mountIds.length,
              highPower: entries.some((e) => isHighPower(e)),
            },
            launch,
            rocketName,
            execMs: performance.now() - t0,
            aeroModel: batchModel === 'auto' && usedSupersonic ? 'auto-supersonic'
              : usedSupersonic ? 'supersonic' : 'classic',
            rogersKbf: kbf && !usedSupersonic,
            motorConfig: configTag,
          });
          // The stored designation is the combo label so saved runs read right.
          run.motor = label;
          const failed = gradeRun(run);
          out.push({ entry: entries[0]!, label, run, failed });
          if (failed.length === 0) accepted.push(run);
        } catch (e) {
          out.push({ entry: entries[0]!, label, error: e instanceof Error ? e.message : String(e), failed: ['error'] });
        }
        setRows([...out]);
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
  // Export ordering (the owner's spec): group by motor config — single-motor rows
  // first, then each mixed config — every group keeping the
  // accepted-then-apogee sort.
  const CONFIG_ORDER = ['single', 'mixed 2+2', 'mixed 3+3', 'mixed 4+2', 'mixed 2+2+2'];
  const configRank = (r: SimRun) => {
    const i = CONFIG_ORDER.indexOf(r.motorConfig ?? 'single');
    return i < 0 ? CONFIG_ORDER.length : i;
  };
  const exportRuns = (): SimRun[] => {
    const runsOnly = sorted.filter((r) => r.run).map((r) => r.run!);
    if (!runsOnly.some((r) => r.motorConfig?.startsWith('mixed'))) return runsOnly;
    return [...runsOnly].sort((a, b) => configRank(a) - configRank(b));
  };
  const downloadCsv = () => {
    // BOM: unit headers can carry non-ASCII; Excel needs it to decode UTF-8.
    downloadAs(new Blob(['﻿', runsToCsv(exportRuns(), prefs.units)], { type: 'text/csv' }), 'csv');
  };
  const downloadXlsx = () => {
    const all = exportRuns();
    const configs = [...new Set(all.map((r) => r.motorConfig ?? ''))].filter((c) => c.startsWith('mixed'));
    // Combination batches get one tab per config PLUS an everything tab.
    const sheets: Sheet[] = configs.length === 0
      ? [{ name: 'Batch', ...runsToTable(all, prefs.units) }]
      : [
        { name: 'All results', ...runsToTable(all, prefs.units) },
        { name: 'Single motor', ...runsToTable(all.filter((r) => !r.motorConfig?.startsWith('mixed')), prefs.units) },
        ...configs.map((c) => ({
          name: `Mixed ${c.replace('mixed ', '')}`,
          ...runsToTable(all.filter((r) => r.motorConfig === c), prefs.units),
        })),
      ];
    downloadAs(new Blob([sheetsToXlsx(sheets) as BlobPart], { type: XLSX_MIME }), 'xlsx');
  };

  const velUi = (si: number | null) => (si === null ? undefined : siToUi('velocity', vel, si));
  const distUi = (si: number | null) => (si === null ? undefined : siToUi('distance', dist, si));

  const dialogRef = useDialog(onClose);

  return (
    <div className="prefs-overlay" role="presentation" onClick={running ? undefined : onClose}>
      <div className="prefs-dialog panel motor-browser" role="dialog" aria-modal="true" aria-label="Batch simulate motors"
        ref={dialogRef} tabIndex={-1}
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
                  onChange={(e) => { setMountId(e.target.value); setComboMode(false); setPairMode(false); }}>
                  {mounts.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </label>
            )}
            {clusterSplit && (
              <label className="motor-inline-label"
                title={`Also fly every PAIR of candidates split symmetrically across the ${clusterSplit.groupSize * 2}-motor cluster (${clusterSplit.groupSize}+${clusterSplit.groupSize}). Off = one motor type in every tube (the default). Pairs grow fast — n candidates add n·(n−1)/2 extra flights.`}>
                <input type="checkbox" checked={comboMode} style={{ width: 'auto' }}
                  onChange={(e) => setComboMode(e.target.checked)} />
                mixed {clusterSplit.groupSize}+{clusterSplit.groupSize}
              </label>
            )}
            {pairSplit && (
              <label className="motor-inline-label"
                title="Also fly the 6-motor cluster as THREE opposite-tube pairs with up to three motor types — 4+2 and 2+2+2 configurations (every pair is thrust-balanced, so all of them are symmetric). Adds every candidate multiset of size 3 — this grows FAST: n candidates add n(n+1)(n+2)/6 − n flights.">
                <input type="checkbox" checked={pairMode} style={{ width: 'auto' }}
                  onChange={(e) => setPairMode(e.target.checked)} />
                mixed 4+2 / 2+2+2
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
            {pairMode && pairSplit
              && ` · +${(candidates.length * (candidates.length + 1) * (candidates.length + 2)) / 6 - candidates.length} mixed 4+2 / 2+2+2 combinations`}
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
