import { Note } from './Note.js';
import { LaunchOverrideWarning, type LaunchOverrideProps } from './LaunchOverrideWarning.js';
import type { FlightOverrideSummary } from '../services/flightOverrideSummary.js';
import {
  gradeBatchRun, batchTableRows, batchCapNote, batchSummary, BATCH_CONFIRM_ABOVE_FLIGHTS, BATCH_TABLE_ROWS,
  BATCH_RUN_ANYWAY_ABOVE_FLIGHTS, batchConfirmationArmed, batchCandidates, batchFlightCount,
  batchEstimate, batchRefusal, batchButtonLabel, batchConfirmWarning, batchProgressAnnouncement,
  type BatchPace, type Criteria,
} from '../services/batchCriteria.js';
// App retains this re-export until its owning lane updates the import (audit 2026-10-11, S3a-7).
export { batchUnavailableReason } from '../services/batchCriteria.js';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MountMotor } from '../model/design.js';
import type { WeatherSnapshot } from '../services/weatherSnapshot.js';
import { useBackdropClose, useDialog } from './useDialog.js';
import type { IgnitionEvent, MotorSpec, RocketTree, StaticInfo } from '@online-openrocket/engine';
import { includedMotorOf } from '../services/statedLaunchWeight.js';
import {
  splitClusterPairsTree, splitClusterTree, stagesWithNozzle, type ClusterSplit,
} from '../tree/treeModel.js';
import { sheetsToXlsx, type Sheet } from '../services/xlsx.js';
import {
  classLabel, classesFittingMount, manufacturersForMount,
} from '../services/motorDb.js';
import { exToDbEntry, loadExMotors } from '../services/exMotors.js';
import { SAFETY, type DesignMatchKey, type SimRun } from '../services/simReport.js';
import { railNeededCell, railNeededHeader } from '../services/railNeeded.js';
import {
  addRuns, runCapNote, runsEvictedByLastWrite, runsToCsv, runsToTable, runsUnsavedByLastWrite,
} from '../services/simStore.js';
import { XLSX_MIME } from '../services/xlsx.js';
import { TimeStepCaution, type LaunchConditions } from './LaunchPanel.js';
import {
  batchSolverFlights, deploysOnEjectionCharge, isWeighedCandidate, mixedComboCount, runBatchSweep,
  type BatchModel, type BatchMountOption, type BatchRow, type BatchWeighed,
} from '../services/batchSweep.js';
import { useCatalogue } from './useCatalogue.js';
import { aeroOptionLabel, usePrefs } from '../prefs/PrefsContext.js';
import { Icon } from './Icon.js';
import { Modal } from './Modal.js';
import { fmtSi, noticeQuantity, siToUi, uiToSi } from '../prefs/units.js';
import { NumField } from './NumField.js';
import { UnitChip } from './UnitChip.js';
import { safeName } from '../services/fileName.js';
import { downloadBlob } from '../services/saveFile.js';

/**
 * Batch simulation: fly EVERY motor that fits the mount (after filters)
 * through the current design, using the auto-optimal delay per motor, and
 * grade each flight against acceptance criteria (min rod-exit velocity,
 * min thrust:weight, apogee window). Results append to the stored-runs
 * table and download as CSV — the owner's motor-selection flow for a flight day.
 * The flying itself is services/batchSweep.ts; this is the dialog around it.
 */

const CRITERIA_KEY = 'online-openrocket.batch-criteria.v1';

const DEFAULT_CRITERIA: Criteria = {
  minRodExit: null, minThrustToWeight: null, minApogee: null, maxApogee: null,
  autoDelay: true, includeOOP: false, manufacturers: [], classes: [],
};

function loadCriteria(): Criteria {
  try {
    const raw = localStorage.getItem(CRITERIA_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return DEFAULT_CRITERIA;
    const stored = parsed as Record<string, unknown>;
    const number = (v: unknown, fallback: number | null) =>
      v === null || (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
    const strings = (v: unknown, fallback: string[]) =>
      Array.isArray(v) && v.every((s) => typeof s === 'string') ? v as string[] : fallback;
    const numbers = (v: unknown, fallback: number[]) =>
      Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? v as number[] : fallback;
    // Every persisted field needs a reader, including future optional fields.
    return {
      minRodExit: number(stored['minRodExit'], DEFAULT_CRITERIA.minRodExit),
      minThrustToWeight: number(stored['minThrustToWeight'], DEFAULT_CRITERIA.minThrustToWeight),
      minApogee: number(stored['minApogee'], DEFAULT_CRITERIA.minApogee),
      maxApogee: number(stored['maxApogee'], DEFAULT_CRITERIA.maxApogee),
      autoDelay: typeof stored['autoDelay'] === 'boolean' ? stored['autoDelay'] : DEFAULT_CRITERIA.autoDelay,
      includeOOP: typeof stored['includeOOP'] === 'boolean' ? stored['includeOOP'] : DEFAULT_CRITERIA.includeOOP,
      manufacturers: strings(stored['manufacturers'], DEFAULT_CRITERIA.manufacturers),
      classes: numbers(stored['classes'], DEFAULT_CRITERIA.classes),
    } satisfies Required<Criteria>;
  } catch {
    return DEFAULT_CRITERIA;
  }
}

/** The pair-split box's words — on the box, and in the refusal that says to untick it. */
const PAIRS_NAME = 'mixed 4+2 / 2+2+2';

/**
 * The Delay cell's own words for a plugged-only motor flown at its optimum
 * (D7 §5, L20): the charge that delay fires is hypothetical — the motor as
 * sold has none — so the cell says so beside the number, not only a paragraph
 * above the table.
 */
export const PLUGGED_DELAY_MARK = ' · opt., hypothetical charge';

export function batchDelayCell(run: Pick<SimRun, 'delayS'> | undefined, optimumForPlugged?: boolean): ReactNode {
  return <>
    {run ? (Number.isFinite(run.delayS) ? `${run.delayS}s` : 'P') : '—'}
    {optimumForPlugged && <span className="motor-db-meta">{PLUGGED_DELAY_MARK}</span>}
  </>;
}

export function BatchSimulate({ configurationForMount, overrideSummaryForMount, onShowOverride, provenance = null, info, tree, mounts, initialMountId, assignedMountMotors, assignedMotors, assignedMotorIds, assignedIgnitions, assignedAutoDelays, weighed, retainedHardware, launch, weatherSnapshot, rocketName, onRunsChange, onClose }: {
  /** The editing tree — the batch builds its OWN engine handles from it, so
   *  the design's shared handle is never touched (no restore, no stale
   *  motors left on unassigned mounts). */
  tree: RocketTree;
  configurationForMount?: (candidateMountId: string) => Pick<SimRun, 'flightConfig' | 'flightConfigId' | 'flightOverrides'>;
  overrideSummaryForMount?: (candidateMountId: string) => FlightOverrideSummary | null;
  onShowOverride?: LaunchOverrideProps['onShowOverride'];
  /** App's current comparison key (`provenanceKey`), so this window's CSV /
   *  XLSX Status column says Current / Changed exactly as the Saved
   *  simulations export does for the same rows. Absent = Unknown. */
  provenance?: DesignMatchKey | null;
  info: StaticInfo;
  /** Every motor mount in the (single-stage) design — the user picks which
   *  one the batch targets (2026-08-05: a ring around a central mount needs
   *  the ring selectable). */
  mounts: BatchMountOption[];
  initialMountId: string;
  /** Currently assigned motors by mount id — mounts OTHER than the batch
   *  target fly with these during every batch flight. App hands them over
   *  already `flownSpec`'d, so a weighed motor on a non-target mount keeps
   *  its hardware here too. */
  assignedMotors: Record<string, MotorSpec>;
  /** Catalogue specs and metadata for provenance, before hardware is applied. */
  assignedMountMotors: Record<string, MountMotor>;
  /**
   * Nozzle-database ids for those same motors, by mount id. A MotorSpec
   * carries no id, and the nozzle database is keyed on one — so without this
   * the sweep can resolve the CANDIDATE's published exit but not the exits of
   * the other mounts firing alongside it, and a cluster's equivalent nozzle
   * cannot be summed. An imported EX motor is carried by its `ex:` library id
   * (App passes `motorId ?? exMotorId`, as nozzleFollow reads it), which
   * resolves to the exit its own file states. Absent for a motor recorded with
   * neither id — an EX record from before exMotorId existed, say.
   */
  assignedMotorIds: Record<string, string | undefined>;
  /**
   * The ignition setting for those same motors, by mount id. A MotorSpec does
   * not carry one, and the bridge installs a FRESH MotorConfiguration on every
   * `setMotorById` (OrkEngine.java:379), so writing a motor here silently
   * resets its mount to AUTOMATIC. Without this an imported single-stage
   * design with a `never` or delayed mount fired that motor through the whole
   * sweep while the Launch button honoured it — the same motor reading two
   * ways in two places (2026-09-21, from the 19 Sep review).
   */
  assignedIgnitions: Record<string, { event: IgnitionEvent; delay: number }>;
  assignedAutoDelays?: Record<string, boolean>;
  /** The weighed pad mass, when the design page is carrying one (see
   *  {@link BatchWeighed}); the candidate matching it on its mount flies
   *  shifted, every other row at catalogue weight. */
  weighed?: BatchWeighed;
  /** Accepted hardware already in the retained mounts' specs; separate from candidate eligibility. */
  retainedHardware?: Pick<BatchWeighed, 'mountId' | 'deltaKg'>;
  launch: LaunchConditions;
  weatherSnapshot?: WeatherSnapshot | null;
  rocketName: string;
  onRunsChange: (runs: SimRun[]) => void;
  onClose: () => void;
}) {
  const { prefs } = usePrefs();
  const alt = prefs.units.altitude;
  const vel = prefs.units.velocity;
  const len = prefs.units.length;

  const [criteria, setCriteriaRaw] = useState<Criteria>(loadCriteria);
  const railThreshold = criteria.minRodExit ?? SAFETY.minRodExitVelocity;
  // Batch-local aero model. Auto is the sensible default: a candidate list
  // routinely spans subsonic to supersonic flights, and one fixed model
  // would be wrong at one end or the other.
  //
  // DELIBERATELY independent of both the stored preference and the vitals
  // strip's session override — the batch builds and flies its own engine
  // handle, and a fixed model chosen for one design is the wrong default for
  // a catalog sweep. Do not "fix" this by seeding it from either of them.
  const [batchModel, setBatchModel] = useState<BatchModel>('auto');
  // Which mount the batch targets (candidates, cluster count, max length and
  // the combination split all follow it).
  const [mountId, setMountId] = useState(initialMountId);
  const sel = mounts.find((m) => m.id === mountId) ?? mounts[0]!;
  // Candidate ignition is automatic; only the other loaded mounts retain overrides.
  const overrideSummary = overrideSummaryForMount?.(sel.id);
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
  // Which stages carry a nozzle exit diameter — what the sweep strips, and
  // what the note under the candidates row names. Empty under Classic EB on
  // purpose: neither half of the nozzle (thrust or base drag) is live in the
  // parity model, so stripping it changes nothing there and a sentence about
  // it would describe a difference that does not exist.
  const nozzleStages = useMemo(
    () => (batchModel === 'eb' ? [] : stagesWithNozzle(tree)), [tree, batchModel]);
  // Whether the recovery waits for the motor's charge — what decides if a
  // plugged-only candidate searches for its delay, so what the estimate counts.
  const deploysOnCharge = useMemo(() => deploysOnEjectionCharge(tree), [tree]);
  // The motor whose weight is still inside the swept stage's own mass override
  // — a RASAero import that named a motor the catalogue does not have, whose
  // user has not loaded it yet (services/statedLaunchWeight.ts). The design
  // page takes that weight back out the moment a motor is assigned; the sweep
  // cannot, because it does not know what the named motor weighs and each
  // candidate would need a different subtraction on a rocket this dialog
  // builds ONCE. So it is SAID rather than silently carried: every row is that
  // one motor's weight heavy, which shifts every absolute number (apogee, rod
  // T:W, optimum delay) while leaving the ranking roughly intact. Same
  // treatment, and the same reason, as the stripped nozzle above.
  const includedMotor = useMemo(() => includedMotorOf(tree, sel.id), [tree, sel.id]);
  const clusterSplit = useMemo(() => splitClusterTree(tree, sel.id), [tree, sel.id]);
  const pairSplit = useMemo(() => splitClusterPairsTree(tree, sel.id), [tree, sel.id]);
  /** The halves box's words — on the box, and in the refusal that tells you to untick it. */
  const halvesName = clusterSplit ? `mixed ${clusterSplit.groupSize}+${clusterSplit.groupSize}` : '';
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [sweepMountId, setSweepMountId] = useState(mountId);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; current: string } | null>(null);
  /**
   * Set when a run ends, cleared when the next one starts — the "it's done"
   * signal. `candidates` and `planned` are the sweep as it STARTED, so the line
   * keeps describing that run while the filters above it change.
   */
  const [finished, setFinished] = useState<{
    total: number; candidates: number; planned: number; stopped: boolean; evicted: number; unsaved: number;
  } | null>(null);
  /** Why a sweep ended without finishing — something threw outside any one flight. */
  const [failure, setFailure] = useState<string | null>(null);
  // Stop, and unmount: the ONE cancel signal. It reaches every download, so
  // Stop no longer waits out a fetch, and the sweep checks it between flights.
  // The controller is per-run and is replaced at every start, because an
  // aborted signal stays aborted.
  const abort = useRef<AbortController | null>(null);

  const setCriteria = (next: Criteria) => {
    setCriteriaRaw(next);
    try { localStorage.setItem(CRITERIA_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
  };
  // The criteria as they stand when a sweep ENDS — what decides which runs go
  // into the history, read through a ref because the sweep's closure was made
  // at its start and the fields stay editable while it runs.
  const criteriaRef = useRef(criteria);
  criteriaRef.current = criteria;

  // The EFFECTIVE catalogue — shipped rows plus any "Check thrustcurve.org"
  // overlay — and the imported EX motors, which simulate like any other; the
  // same pair the motor browser lists. This was the static MOTOR_DB import, so
  // after a check the same motor could fly a changed catalogue row on the
  // design page and the stale one here: two apogees for one motor, which is
  // the trust problem v0.135 was written to remove (audit 2026-09-22).
  const catalogue = useCatalogue();
  const allMotors = useMemo(() => [...catalogue, ...loadExMotors().map(exToDbEntry)], [catalogue]);

  const fittingClasses = useMemo(
    () => classesFittingMount(mountDiameterMm, allMotors), [mountDiameterMm, allMotors]);
  const manufacturers = useMemo(
    () => manufacturersForMount(mountDiameterMm, criteria.includeOOP, allMotors),
    [mountDiameterMm, criteria.includeOOP, allMotors],
  );
  // The candidates, through the maker chips that apply here (batchCandidates).
  const { candidates, tooLongCount, appliedMakers } = useMemo(
    () => batchCandidates(criteria, { diameterMm: mountDiameterMm, maxMotorLengthM }, allMotors),
    [criteria, mountDiameterMm, maxMotorLengthM, allMotors]);
  // What unticking "include OOP" would leave — the same filters, run again —
  // so the refusal offers it only when it is enough.
  const withoutOOP = useMemo(() => (criteria.includeOOP
    ? batchCandidates({ ...criteria, includeOOP: false }, { diameterMm: mountDiameterMm, maxMotorLengthM }, allMotors)
      .candidates.length
    : null), [criteria, mountDiameterMm, maxMotorLengthM, allMotors]);

  /**
   * Separate from the abort signal, which the Stop BUTTON also fires. Both stop
   * the sweep; only this one means the dialog is gone, and the sweep's tail
   * writes accepted runs into the design's persisted history — so on unmount it
   * must not (2026-09-08 audit). The setStates in that tail are already
   * harmless no-ops; `onRunsChange` is not.
   *
   * RE-ARMED in the effect body, not only set in its cleanup. Dev StrictMode
   * mounts, unmounts and re-mounts every component once, so a flag that the
   * cleanup set and nothing ever cleared read "unmounted" for the life of the
   * dialog: every sweep under `npm run dev` ended without its completion line
   * and without writing a single run to the history (audit 2026-09-22).
   */
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      abort.current?.abort();
    };
  }, []);

  const toggle = <T,>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const start = async () => {
    if (runningRef.current || refusal !== null || candidates.length === 0) return;
    runningRef.current = true;
    setRunning(true);
    setFinished(null);
    setFailure(null);
    setRows([]);
    setSweepMountId(mountId);
    const ctrl = new AbortController();
    abort.current = ctrl;
    const splits: ClusterSplit[] = [
      ...(comboMode && clusterSplit ? [clusterSplit] : []),
      ...(pairMode && pairSplit ? [pairSplit] : []),
    ];
    // try/finally, so `running` can never stick. Anything that throws outside
    // one flight — the lazy nozzle table failing to load, say — used to reject
    // this promise with `running` still true, and a running dialog cannot be
    // closed: ✕ is disabled, the backdrop is inert and Escape is guarded
    // (audit 2026-09-22). Now it ends the sweep and says why.
    try {
      const { rows: out, stopped } = await runBatchSweep({
        units: prefs.units,
        advisoryLimits: prefs.flightAdvisories,
        tree, info, mounts, target: sel, candidates, splits,
        configuration: configurationForMount?.(sel.id),
        assignedMountMotors, assignedMotors, assignedMotorIds, assignedIgnitions, assignedAutoDelays, weighed, retainedHardware,
        model: batchModel, autoDelay: criteria.autoDelay, launch, weatherSnapshot, rocketName,
      }, { signal: ctrl.signal, onProgress: setProgress, onRows: setRows });
      // The run ENDING used to be invisible: the progress bar and its
      // "simulating 173/226" line simply disappeared, the Stop button turned
      // back into Simulate, and nothing ever said the batch was done. On a
      // 226-motor run that is minutes of watching followed by no announcement
      // at all (owner report, 2026-09-01b). This line stays until the next run
      // starts.
      if (unmounted.current) return;
      // The resolved rows ARE the table: onRows has normally delivered the
      // same list flight by flight, and this makes the end state not depend
      // on it having done so.
      setRows(out);
      const accepted = out.flatMap((r) =>
        (r.run && gradeBatchRun(r.run, criteriaRef.current).length === 0 ? [r.run] : []));
      // Saving them can push the oldest saved runs past the 500-run cap, which
      // used to happen in silence (audit 2026-09-22) — and a sweep that accepts
      // more than 500 does not fit at all. The line below says both, apart.
      const stored = accepted.length > 0 ? addRuns(accepted) : null;
      setFinished({ total: out.length, candidates: candidates.length, planned: totalFlights, stopped,
        evicted: stored ? runsEvictedByLastWrite() : 0, unsaved: stored ? runsUnsavedByLastWrite() : 0 });
      if (stored) onRunsChange(stored);
    } catch (e) {
      if (!unmounted.current) setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      runningRef.current = false;
      setProgress(null);
      setRunning(false);
    }
  };

  /** Did any row actually fly a published nozzle? Drives the note below. */
  const anyRowFlewNozzle = useMemo(
    () => rows.some((r) => r.run && !(r.run.aeroModel === 'classic' && !r.run.rogersKbf)
      && (r.run.nozzleStages?.length ?? 0) > 0), [rows]);

  // Graded here, against the criteria on screen (see gradeBatchRun), then
  // sorted: accepted first, then by apogee; rows that never flew go last.
  const sorted = useMemo(() => rows
    .map((r) => ({ ...r, failed: r.run ? gradeBatchRun(r.run, criteria) : ['error'] }))
    .sort((a, b) => {
      if (!a.run || !b.run) return (a.run ? 0 : 1) - (b.run ? 0 : 1);
      if ((a.failed.length === 0) !== (b.failed.length === 0)) return a.failed.length === 0 ? -1 : 1;
      return b.run.maxAltitude - a.run.maxAltitude;
    }), [rows, criteria]);
  /** The rows the table draws — every FLOWN row still reaches the CSV and XLSX. */
  const table = useMemo(() => batchTableRows(sorted), [sorted]);
  const capNote = batchCapNote(table);
  // D7 G12: Caution only where the cap changes what is KEPT. Rows the table
  // leaves out but both exports carry lose nothing (Information); failed rows
  // past the cap are in neither export, so that branch is Caution.
  const capLosesRows = table.failed > BATCH_TABLE_ROWS;

  const downloadAs = (blob: Blob, ext: string) => {
    downloadBlob(blob, `batch-${safeName(rocketName)}.${ext}`,
      ext === 'csv' ? 'Comma-separated values' : 'Excel workbook');
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
    downloadAs(new Blob(['﻿', runsToCsv(exportRuns(), prefs.units, railThreshold, provenance)], { type: 'text/csv' }), 'csv');
  };
  const downloadXlsx = () => {
    const all = exportRuns();
    const configs = [...new Set(all.map((r) => r.motorConfig ?? ''))].filter((c) => c.startsWith('mixed'));
    // Combination batches get one tab per config PLUS an everything tab.
    const sheets: Sheet[] = configs.length === 0
      ? [{ name: 'Batch', ...runsToTable(all, prefs.units, railThreshold, provenance) }]
      : [
        { name: 'All results', ...runsToTable(all, prefs.units, railThreshold, provenance) },
        { name: 'Single motor', ...runsToTable(all.filter((r) => !r.motorConfig?.startsWith('mixed')), prefs.units, railThreshold, provenance) },
        ...configs.map((c) => ({
          name: `Mixed ${c.replace('mixed ', '')}`,
          ...runsToTable(all.filter((r) => r.motorConfig === c), prefs.units, railThreshold, provenance),
        })),
      ];
    downloadAs(new Blob([sheetsToXlsx(sheets) as BlobPart], { type: XLSX_MIME }), 'xlsx');
  };

  const velUi = (si: number | null) => (si === null ? undefined : siToUi('velocity', vel, si));
  const altUi = (si: number | null) => (si === null ? undefined : siToUi('altitude', alt, si));

  // Escape must NOT close a sweep that is running. The ✕ is disabled={running}
  // and the backdrop's close is guarded on the same ref below, but
  // useDialog's Escape handler is unconditional — so the one key a modal binds
  // by reflex unmounted this component mid-run, taking `rows` with it. Nothing
  // survives that: the ⬇ CSV and ⬇ XLSX buttons live inside this dialog, and
  // the rejected and errored rows — the point of the comparison — exist
  // nowhere else, since only ACCEPTED runs reach the history and only after
  // the loop finishes. A several-minute 226-motor sweep was one keystroke from
  // gone, and reopening starts from an empty table. Stop is the way out; it
  // keeps every row.
  //
  // Read through a ref, not the closure: useDialog installs its listener once
  // and calls through an onCloseRef it happens to refresh each render, which is
  // an implementation detail of that hook rather than a contract.
  const runningRef = useRef(running);
  runningRef.current = running;
  const dialogRef = useDialog(() => { if (!runningRef.current) onClose(); });
  // A press AND a release on the backdrop itself (useBackdropClose): a name
  // drag-selected in a finished results table and released past the card's
  // edge closed the dialog and threw the batch away (audit 2026-09-22).
  const backdrop = useBackdropClose(() => { if (!runningRef.current) onClose(); });

  // What the batch will actually fly — the same counts the meta line quotes.
  // The time-step caution multiplies by this: a fine step's cost is per
  // flight, and the launch panel's per-flight caution says nothing about a
  // candidate list turning 15 s of freeze into 20 minutes of it.
  const ticked = [
    ...(comboMode && clusterSplit ? [{ name: halvesName, groups: clusterSplit.mountIds.length }] : []),
    ...(pairMode && pairSplit ? [{ name: PAIRS_NAME, groups: pairSplit.mountIds.length }] : []),
  ];
  const totalFlights = batchFlightCount(candidates.length, ticked.map((t) => t.groups));
  // How many of them search for their delay, by the sweep's own rule — with
  // the box unticked, still those of plugged-only motors on a design whose
  // recovery waits for the charge, and every flight while another mount's
  // motor is on Auto. The estimate prices them apart from the rest.
  const solverFlights = batchSolverFlights({
    candidates, groups: ticked.map((t) => t.groups), autoDelay: criteria.autoDelay, deploysOnCharge,
    othersAuto: Object.keys(assignedMotors).some((id) => id !== sel.id && assignedAutoDelays?.[id] === true),
  });
  // How long that takes, and whether it is more than one sweep will fly. Past
  // BATCH_MAX_FLIGHTS the button is disabled and says why — refused, never
  // trimmed to fit.
  const pace: BatchPace = { flights: totalFlights, solverFlights, timeStepS: launch.timeStepS };
  const estimate = batchEstimate(pace);
  const refusal = batchRefusal({
    candidates: candidates.length, withoutOOP, modes: ticked, solverFlights, timeStepS: launch.timeStepS,
  });

  // Disarm when the proposed sweep changes, even at the same flight count.
  // Include every runBatchSweep input, the criteria and count. Identity changes
  // invalidate confirmation during render, before any layout or passive effect.
  // A memo eviction can only disarm; returning to old settings cannot re-arm.
  const sweepIdentity = useMemo(() => ({
    totalFlights, candidates, criteria, mountId, comboMode, pairMode, clusterSplit, pairSplit,
    tree, info, mounts, sel, assignedMountMotors, assignedMotors, assignedMotorIds,
    assignedIgnitions, assignedAutoDelays, weighed, retainedHardware, batchModel, launch, rocketName,
  }), [
    totalFlights, candidates, criteria, mountId, comboMode, pairMode, clusterSplit, pairSplit,
    tree, info, mounts, sel, assignedMountMotors, assignedMotors, assignedMotorIds,
    assignedIgnitions, assignedAutoDelays, weighed, retainedHardware, batchModel, launch, rocketName,
  ]);
  const [confirmedSweep, setConfirmedSweep] = useState<object | null>(null);
  const armed = batchConfirmationArmed(confirmedSweep, sweepIdentity, totalFlights, refusal);
  const runAnyway = totalFlights > BATCH_RUN_ANYWAY_ABOVE_FLIGHTS;

  return (
    <>
    <div className="prefs-overlay" role="presentation" {...backdrop}>
      <div className="prefs-dialog panel motor-browser" role="dialog" aria-modal="true" aria-label="Batch simulate motors"
        ref={dialogRef} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h2 style={{ flex: 1 }}>
            Batch simulate — every motor that fits
            {motorCount > 1 && <span className="motor-db-meta"> each candidate fires ×{motorCount} on this mount</span>}
          </h2>
          <button className="file-btn" onClick={onClose} disabled={running}>✕ Close</button>
        </div>

        <div className="motor-filter-block">
          {/* The chips are TOGGLES, so they say so: aria-pressed for a screen
              reader, and a ✓ for anyone who cannot tell the on-state's border
              and text shade from the off one's — outside Daylight that shade is
              the only difference, and these filters persist, so a chip left on
              last week hides motors with nothing else to say why (audit
              2026-09-22). The ✓ is aria-hidden: aria-pressed already says it. */}
          <div className="motor-chip-row" role="group" aria-label="Manufacturers">
            <span className="motor-chip-caption">Makers</span>
            {manufacturers.map(({ abbrev, count }) => {
              const on = criteria.manufacturers.includes(abbrev);
              return (
                <button key={abbrev}
                  className={`series-chip ${on ? 'series-chip-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => setCriteria({ ...criteria, manufacturers: toggle(criteria.manufacturers, abbrev) })}>
                  {on && <span aria-hidden="true">✓</span>}
                  {abbrev} <span className="motor-chip-count">{count}</span>
                </button>
              );
            })}
            {appliedMakers.length > 0 && (
              <button className="file-btn" onClick={() => setCriteria({ ...criteria, manufacturers: [] })}>all</button>
            )}
          </div>
          <div className="motor-chip-row" role="group" aria-label="Diameter classes">
            <span className="motor-chip-caption">Diameter</span>
            {fittingClasses.map((c) => {
              const on = criteria.classes.includes(c);
              return (
                <button key={c}
                  className={`series-chip ${on ? 'series-chip-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => setCriteria({ ...criteria, classes: toggle(criteria.classes, c) })}>
                  {on && <span aria-hidden="true">✓</span>}
                  {classLabel(c)} mm
                </button>
              );
            })}
          </div>
          {/* Explicit label targets keep clicks on the number, not its unit picker
              (audit 2026-10-11, S3a-g3). Each criteria box names ITSELF. A <label> with no `for` labels its
              first labelable descendant, and in the three with a unit that is
              the UnitChip <select>, not the number box — so min rod-exit, min
              apogee and max apogee were all announced as "—", their
              placeholder, and a value typed in the wrong one changes which
              motors pass (audit 2026-09-22). */}
          <div className="motor-filter-row" style={{ flexWrap: 'wrap' }}>
            <label className="motor-inline-label" htmlFor="batch-rod">
              Min rod-exit <UnitChip quantity="velocity" />
              <NumField id="batch-rod" value={velUi(criteria.minRodExit)} step={1} nullable placeholder="—"
                ariaLabel={`Minimum rod-exit velocity (${vel})`}
                onCommit={(v) => setCriteria({ ...criteria, minRodExit: v === null ? null : uiToSi('velocity', vel, v) })} />
            </label>
            <label className="motor-inline-label">
              Min thrust:weight
              <NumField value={criteria.minThrustToWeight ?? undefined} step={0.5} nullable placeholder="—"
                onCommit={(v) => setCriteria({ ...criteria, minThrustToWeight: v })} />
            </label>
            <label className="motor-inline-label" htmlFor="batch-min">
              Apogee min <UnitChip quantity="altitude" />
              <NumField id="batch-min" value={altUi(criteria.minApogee)} step={10} nullable placeholder="—"
                ariaLabel={`Minimum apogee (${alt})`}
                validate={(v) => Number.isFinite(uiToSi('altitude', alt, v))}
                onCommit={(v) => setCriteria({ ...criteria, minApogee: v === null ? null : uiToSi('altitude', alt, v) })} />
            </label>
            <label className="motor-inline-label" htmlFor="batch-max">
              max <UnitChip quantity="altitude" />
              <NumField id="batch-max" value={altUi(criteria.maxApogee)} step={10} nullable placeholder="—"
                ariaLabel={`Maximum apogee (${alt})`}
                validate={(v) => Number.isFinite(uiToSi('altitude', alt, v))}
                onCommit={(v) => setCriteria({ ...criteria, maxApogee: v === null ? null : uiToSi('altitude', alt, v) })} />
            </label>
            <label className="motor-inline-label" title="Which physics model the batch flies. Auto is recommended: candidates often straddle Mach 1, and each motor gets the model its own flight calls for.">
              aero model
              <select value={batchModel} disabled={running}
                onChange={(e) => setBatchModel(e.target.value as typeof batchModel)}>
                <option value="auto">{aeroOptionLabel('auto', 'recommended')}</option>
                <option value="kbf">{aeroOptionLabel('kbf')}</option>
                <option value="eb">{aeroOptionLabel('eb')}</option>
                <option value="supersonic">{aeroOptionLabel('supersonic', 'all speeds')}</option>
                <option value="hybrid">{aeroOptionLabel('hybrid')}</option>
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
                {halvesName}
              </label>
            )}
            {pairSplit && (
              <label className="motor-inline-label"
                title="Also fly the 6-motor cluster as THREE opposite-tube pairs with up to three motor types — 4+2 and 2+2+2 configurations (every pair is thrust-balanced, so all of them are symmetric). Adds every candidate multiset of size 3 — this grows FAST: n candidates add n(n+1)(n+2)/6 − n flights.">
                <input type="checkbox" checked={pairMode} style={{ width: 'auto' }}
                  onChange={(e) => setPairMode(e.target.checked)} />
                {PAIRS_NAME}
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

        <TimeStepCaution dt={candidates.length > 0 ? launch.timeStepS : undefined} flights={totalFlights} />

        {armed && !runAnyway && !running && (
          <p className="field-caution" role="alert" style={{ margin: '6px 0 0' }}>
            <Icon name="zap" size={13} /> {batchConfirmWarning(totalFlights, estimate)}
          </p>
        )}
        {/* On screen, not in a tooltip on the disabled button: a disabled
            button shows nothing when it is clicked (the 2026-09-01b report). */}
        {refusal && !running && (
          <Note as="p" tier="danger" className="field-caution batch-refused" role="alert" style={{ margin: '6px 0 0' }}>
            <Icon name="zap" size={13} /> {refusal}
          </Note>
        )}

        <div className="motor-load-row">
          <span style={{ flex: 1 }} className="motor-db-meta">
            {candidates.length} candidate motors
            {comboMode && clusterSplit
              && ` · +${mixedComboCount(candidates.length, clusterSplit.mountIds.length)} ${halvesName} combinations`}
            {pairMode && pairSplit
              && ` · +${mixedComboCount(candidates.length, pairSplit.mountIds.length)} ${PAIRS_NAME} combinations`}
            {tooLongCount > 0 && ` · ${tooLongCount} excluded — over this mount’s max motor length`}
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
            <button className="file-btn modal-danger"
              onClick={() => { abort.current?.abort(); }}>
              Stop
            </button>
          ) : (
            <div className="batch-launch-group">
            <button aria-describedby={overrideSummary ? 'launch-override-batch' : undefined} className="launch-btn" style={{ width: 'auto', marginTop: 0, padding: '6px 16px' }}
              onClick={() => {
                // Past the cap there is nothing to start or to confirm.
                if (refusal) return;
                // Only the separate Run anyway action may authorize a large sweep.
                if ((runAnyway || !armed) && totalFlights > BATCH_CONFIRM_ABOVE_FLIGHTS) {
                  setConfirmedSweep(sweepIdentity);
                  return;
                }
                setConfirmedSweep(null);
                void start();
              }}
              disabled={candidates.length === 0 || refusal !== null}>
              <Icon name="rocket" /> {batchButtonLabel({
                candidates: candidates.length, totalFlights, confirming: armed && !runAnyway, estimate,
              })}
            </button>
            <LaunchOverrideWarning id="launch-override-batch" summary={overrideSummary} onShow={onShowOverride} />
            </div>
          )}
        </div>
        {/* Which row carries the weighed hardware, in words. v0.116's batch
            flew every candidate at catalogue weight and said nothing, so the
            weighed motor read higher here than on the design page. Three
            cases: the weighed motor is among these candidates (that row flies
            shifted), it is not (nothing here was weighed), or the weighed
            mount is not the one being swept (its hardware rides along on
            every flight through assignedMotors). */}
        {weighed && (() => {
          const delta = noticeQuantity('mass', weighed.deltaKg, prefs.units);
          const matched = candidates.some((e) => isWeighedCandidate(e, weighed));
          const text = mountId === weighed.mountId
            ? (matched
              ? `Weighed pad mass: ${weighed.name} flies with ${delta} of hardware (adapter, retainer, closure), as on the design page — expect its apogee to read a little lower than another candidate of the same impulse. Every other candidate flies at its catalogue weight; only that motor was weighed.`
              : `Weighed pad mass: ${weighed.name}, the motor it was weighed with, is not among these candidates, so every row flies at its catalogue weight.`)
            : `Weighed pad mass: ${weighed.name} on ${mounts.find((m) => m.id === weighed.mountId)?.label ?? 'another mount'} keeps its ${delta} of hardware in every flight; the candidates on this mount fly at their catalogue weight.`;
          return <p className="comp-stats batch-weighed" style={{ margin: '4px 0 0' }}>{text}</p>;
        })()}
        {/* What the sweep does with the design's nozzle exit diameter, said
            only when the design has one — every other design would read it as
            noise about a field it has never touched. Its own line, beside the
            weighed-mass note rather than folded into it: the two are separate
            facts and either can be present without the other. */}
        {(anyRowFlewNozzle || (rows.length === 0 && batchModel !== 'eb' && nozzleStages.length > 0)) && (
          <p className="comp-stats batch-nozzle" style={{ margin: '4px 0 0' }}>
            {'Nozzle exit diameter: each candidate flies its OWN published exit where the app has '
              + 'one, so a motor reads the same here as it does on the design page. Rows that flew '
              + 'one are marked · nozzle; the rest have no published exit and fly without it, '
              + 'which is why two motors of similar impulse can sit a few percent apart. '
              + (nozzleStages.length > 0
                ? `The exit you typed under ${nozzleStages.map((s) => s.name).join(', ')} is used `
                  + 'for the motor you typed it for, so that row matches your design-page flight exactly.'
                : '')}
          </p>
        )}
        {includedMotor && (
          <p className="comp-stats batch-included-motor" style={{ margin: '4px 0 0' }}>
            {`Stage weight: this stage still carries the launch weight the RASAero file stated for it, `
              + `with “${includedMotor}” still inside it — that motor is not in the database, so `
              + 'nothing is loaded on the stage and its weight was never taken out. Every row below '
              + 'flies that weight ON TOP of its own candidate, so every apogee here reads low, every '
              + 'rod speed reads low, and the optimum delays belong to a heavier rocket. Load a motor on '
              + 'the design page first — Browse motor database takes an .eng or .rse file — and the app '
              + 'takes the stated weight back out before you sweep.'}
          </p>
        )}
        {progress && (
          // role="progressbar" so the width-only bar is readable by assistive
          // tech at all: NVDA and JAWS report a progress bar's value as it
          // moves, which is the "is anything happening" signal a multi-minute
          // sweep otherwise gives only in pixels.
          <div className="batch-progress"
            role="progressbar"
            aria-label="Batch simulation progress"
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.done}
            aria-valuetext={`${progress.done + 1} of ${progress.total}: ${progress.current}`}>
            <div className="batch-progress-fill" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
        )}
        {/* Always mounted, never conditional: a polite live region inserted
            into the DOM with its text already in place is unreliably announced,
            so the region has to exist before the first flight starts. */}
        <span className="sr-only" aria-live="polite">
          {(progress && batchProgressAnnouncement(progress.done, progress.total)) || ''}
        </span>

        {/* The run is over and the results are ready to download. Says it in
            words, with the counts, because the progress bar vanishing is not an
            announcement. `role="status"` so a screen reader hears it too — on
            a region ALWAYS MOUNTED, the line rendered into it (audit
            2026-09-30). It was a paragraph inserted with its text already in
            place, the pattern the progress region above says is announced
            unreliably, and this is the line a screen-reader user waits out a
            multi-minute sweep for. */}
        <div className="batch-status" role="status">
          {finished && !running && (
            <p className="comp-stats batch-finished" style={{ margin: '6px 0 0' }}>
              {batchSummary({
                total: finished.total,
                candidates: finished.candidates,
                planned: finished.planned,
                stopped: finished.stopped,
                accepted: sorted.filter((r) => r.run && r.failed.length === 0).length,
                errors: sorted.filter((r) => r.error).length,
                downloadable: sorted.some((r) => r.run),
              })}
            </p>
          )}
          {/* D7 G12: saved runs evicted or never saved is the batch's
              retention loss, so it is the Caution here — its own block, in
              this status region so it is still announced, leading with the
              loss rather than trailing the summary. */}
          {finished && !running && (finished.evicted > 0 || finished.unsaved > 0) && (
            <Note as="p" tier="caution" className="comp-stats batch-retention" style={{ margin: '6px 0 0' }}>
              {runCapNote(finished.evicted, finished.unsaved)}
              {finished.unsaved > 0 && ' The CSV and XLSX above still carry every accepted run: download one before closing.'}
            </Note>
          )}
        </div>
        {(failure && !running || sorted.some(r => r.optimumForPlugged) || capNote) && <Note
          tier={failure && !running ? 'danger' : sorted.some(r => r.optimumForPlugged) || capLosesRows ? 'caution' : 'information'}
          className="batch-outcome-notes">
        {failure && !running && (
          <p className="comp-stats batch-failed stability-bad" role="alert" style={{ margin: '6px 0 0' }}>
            {`The batch stopped before it finished: ${failure}`}
            {rows.some((r) => r.run) ? ' The rows it flew are below and still download.' : ''}
          </p>
        )}

        {/* A plugged-only motor on a design that deploys on the ejection
            charge: flown plugged it would never deploy, so its row flies the
            optimum instead (services/batchSweep.ts, batchDelayRule) — and says
            so, because that is a delay the motor is not sold with. */}
        {sorted.some((r) => r.optimumForPlugged) && (
          <p className="comp-stats batch-plugged" style={{ margin: '4px 0 0' }}>
            {`Delay marked${PLUGGED_DELAY_MARK}: that motor is sold plugged (no ejection charge), and this design `
              + 'deploys its recovery on the motor’s charge, so the row flies it with a hypothetical charge at its '
              + 'optimum delay rather than with no deployment at all. To fly it plugged, set the recovery to deploy '
              + 'at apogee or altitude.'}
          </p>
        )}
        {capNote && (
          <p className="comp-stats batch-cap" style={{ margin: '4px 0 0' }}>{capNote}</p>
        )}

        </Note>}

        {sorted.length > 0 && (
          <div className="motor-table-wrap" style={{ maxHeight: 320 }}>
            <table className="motor-table">
              <thead>
                <tr>
                  <th scope="col">Motor</th>
                  <th scope="col">Delay</th>
                  <th scope="col">Apogee (<UnitChip quantity="altitude" />)</th>
                  <th scope="col">Rod exit (<UnitChip quantity="velocity" />)</th>
                  <th scope="col">{railNeededHeader(railThreshold, vel, len, 'travel')}</th>
                  <th scope="col">{railNeededHeader(railThreshold, vel, len)}</th>
                  <th scope="col">T:W</th>
                  <th scope="col">Opt. delay</th>
                  <th scope="col">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {/* Keyed on the row's own identity (batchRowKey: configuration
                    plus the motor ids flown), never on its label or its sorted
                    position — see batchRowKey for what each of those broke. */}
                {table.shown.map(({ key, entry, label, combo, run, error, failed, optimumForPlugged }) => (
                  <tr key={key} className={failed.length ? 'motor-row-long' : ''}>
                    <td>
                      {label}
                      {/* The one single-motor row that flew with the weighed hardware on. */}
                      {!combo && run && weighed && sweepMountId === weighed.mountId && isWeighedCandidate(entry, weighed)
                        && <span className="motor-db-meta"> · weighed</span>}
                      {/*
                        Which rows flew a published nozzle exit. Only about a
                        third of a 54 mm sweep has one, and without this marker
                        that shows up as two motors of the same impulse a few
                        percent apart with nothing on screen to explain it.
                        HIDDEN UNDER CLASSIC EB, where neither half of the
                        nozzle model runs: the marker would be pointing at a
                        difference that is not there, and the note that explains
                        it is hidden under that model too. The nozzleStages
                        STAMP is deliberately left alone — the design page
                        stamps it unconditionally as well (App.tsx), and both
                        of its consumers gate on the model themselves.
                      */}
                      {run && !(run.aeroModel === 'classic' && !run.rogersKbf) && (run.nozzleStages?.length ?? 0) > 0
                        && <span className="motor-db-meta"> · nozzle</span>}
                    </td>
                    <td>{batchDelayCell(run, optimumForPlugged)}</td>
                    <td>{run ? fmtSi('altitude', alt, run.maxAltitude) : '—'}</td>
                    <td>{run?.rodExitVelocity != null ? fmtSi('velocity', vel, run.rodExitVelocity) : '—'}</td>
                    <td>{run && !run.importedSummary ? railNeededCell(run.railProfile, railThreshold, len, 'travel') : ''}</td>
                    <td>{run && !run.importedSummary ? railNeededCell(run.railProfile, railThreshold, len) : ''}</td>
                    <td>{run?.thrustToWeightAtRod != null ? run.thrustToWeightAtRod.toFixed(1) : '—'}</td>
                    <td>{typeof run?.optimumDelayS === 'number' && Number.isFinite(run.optimumDelayS) ? `${run.optimumDelayS.toFixed(1)}s` : '—'}</td>
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
    {armed && runAnyway && !running && (
      <Modal label="Run a large batch?" onClose={() => setConfirmedSweep(null)}>
        <h2>Run a large batch?</h2>
        <p role="alert">{batchConfirmWarning(totalFlights, estimate)}</p>
        <div className="modal-actions">
          <button className="file-btn" onClick={() => setConfirmedSweep(null)}>Cancel</button>
          <div className="batch-launch-group">
          <button aria-describedby={overrideSummary ? 'launch-override-batch-confirm' : undefined} className="file-btn file-btn-primary" onClick={() => {
            setConfirmedSweep(null);
            void start();
          }}>Run anyway</button>
          <LaunchOverrideWarning id="launch-override-batch-confirm" summary={overrideSummary} onShow={onShowOverride} />
          </div>
        </div>
      </Modal>
    )}
    </>
  );
}
