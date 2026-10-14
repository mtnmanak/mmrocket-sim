import { ConfigStabilityRange } from './components/ConfigStabilityRange.js';
import { LaunchOverrideWarning } from './components/LaunchOverrideWarning.js';
import { describeFlightOverrides, recordFlightOverrides, type FlightOverrideSummary } from './services/flightOverrideSummary.js';
import { flightVitals } from './services/flightVitals.js';
import { DesignConfirms } from './components/DesignConfirms.js';
import { RecentDesignsDialog } from './components/RecentDesignsDialog.js';
import { rememberRecentDesign } from './services/recentDesigns.js';
import { assignMotorRecords, planMotorAssignment, retireLoadoutNote } from './services/motorAssignment.js';
import { exportConfigs as assembleExportConfigs, exportMotorsMap as assembleExportMotors,
  flightExportInput as assembleFlightExportInput } from './services/exportAssembly.js';
import { OpenMotorDialog } from './components/OpenMotorDialog.js';
import { acceptedOtherMakerNotes, applyOpenMotorChoices, collectOpenMotorIdentities, commitOpenMotorChoices, type OpenMotorIdentity, type OpenMotorState } from './services/openMotorChoices.js';
import { activeFlightOverrides, holdsOverrides, overrideFor, resolveFlightState, resetOverride, setOverride, sparsify,
  workingSettingsOwnOverrides, isWorkingSettings } from './services/flightState.js';
import type { ComponentFlightTuple } from './services/flightOverrideText.js';
import { deploymentTuple } from './services/foreignConfigLayers.js';
import type { DeploymentTuple, FlightOverrides, FlightTree, IgnitionTuple, SeparationTuple } from './model/design.js';
import { matchingRecoveryEvents } from './services/recoveryFlight.js';
import { editProfileSurface } from './services/windProfile.js';
import { FlightLoadStats } from './components/FlightLoadStats.js';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ComponentNode,
  ComponentType,
  FlightResult,
  MotorSpec,
  RocketTree,
} from '@online-openrocket/engine';
import { BatchSimulate, batchUnavailableReason } from './components/BatchSimulate.js';
import { batchMotorIds } from './services/batchSweep.js';
import { ConfigOverview } from './components/ConfigOverview.js';
import { ConfigPartEditors, overrideScopeText, type FlightEditScope } from './components/ConfigPartEditors.js';
import { MountIgnitionField } from './components/MountIgnitionField.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import type { LongitudeReview } from './components/LongitudeCheck.js';
import { Icon } from './components/Icon.js';
import { LazyDialog } from './components/LazyDialog.js';
import { FirstRunTour } from './components/FirstRunTour.js';
import { FlyScreen } from './components/FlyScreen.js';
import { ComponentTree } from './components/ComponentTree.js';
import { FlightCharts } from './components/FlightCharts.js';
import { DragPanel } from './components/DragPanel.js';
import { kernelSimOptions, hasLaunchGuides, LaunchPanel, PANEL_TIME_STEP_FLOOR_S, type LaunchConditions } from './components/LaunchPanel.js';
import { MACH_AUTO_THRESHOLD } from './services/machProbe.js';
import { NoticeBar, type Notice, type NoticeSeverity } from './components/NoticeBar.js';
import { MeasuredMassBox } from './components/MeasuredMassBox.js';
import { MotorPadMass } from './components/MotorPadMass.js';
import {
  BUILD_ALLOWANCE_NAME, coveringMassOverride, findAllowance, placeAtStation, solveBallast,
  solePinnedStage, withoutAllowance, type BallastSolution,
} from './services/buildAllowance.js';
import { MotorPicker } from './components/MotorPicker.js';
import { zeroDelayRecoveryAdvice } from './services/flightAdvisories.js';
import { useMenuPopup } from './components/useDialog.js';
import { NumField } from './components/NumField.js';
import { PropertyPanel } from './components/PropertyPanel.js';
import { PreflightAudit } from './components/PreflightAudit.js';
import { SimHistory, SimRunDetails } from './components/SimResults.js';
import { DesktopPredictions } from './components/DesktopPredictions.js';
import {
  CD_REFERENCE_MACH, DesignStats, FlightStats, StatsChip, stabilityGlyphClass,
} from './components/StatTiles.js';
/**
 * three.js + @react-three is 205 KB gzipped — about a quarter of the initial
 * bundle — for a view that is NOT the default tab and exports nobody runs on
 * first load. Lazy here, and dynamic import() in the export handlers below, so
 * the design screen (and the launch field's cell signal) does not pay for it.
 */
const Rocket3D = lazy(() => import('./components/Rocket3D.js').then((m) => ({ default: m.Rocket3D })));
const ExampleDesignsDialog = lazy(() => import('./components/ExampleDesignsDialog.js').then(m => ({ default: m.ExampleDesignsDialog })));
/**
 * The user guide (data/userGuide.ts) and the changelog (changelog.ts) are the
 * two biggest texts in the app — 270 KB and 461 KB of source at v0.140, and
 * both grow every release — and nothing on the design or flight screens reads
 * either (audit 2026-09-22, row 510). Lazy, so each is a chunk of its own that
 * the page loads the first time it opens (the service worker precaches it with
 * the rest of the build); LazyDialog stands in, in the real dialog's box and
 * under its name, while it loads, and catches a chunk that fails to download.
 * Nothing that loads at startup may import either dialog or its text, or the
 * chunk folds back into the entry: App.lazyDialogs.test.tsx checks that the
 * app's startup does not load them, and the build fails if the entry chunk
 * carries them (scripts/lazy-chunks.mjs).
 */
const GuideDialog = lazy(() => import('./components/GuideDialog.js').then((m) => ({ default: m.GuideDialog })));
const ChangelogDialog = lazy(() => import('./components/ChangelogDialog.js').then((m) => ({ default: m.ChangelogDialog })));
import { TreeSchematic } from './components/TreeSchematic.js';
import { AftView } from './components/AftView.js';
import { View3DBoundary } from './components/View3DBoundary.js';
import { PanelBoundary } from './components/PanelBoundary.js';
import { motorTooltip, restoreConfigLabels, restoreMotorLabels } from './services/motorLabels.js';
import { getCatalogue, subscribeCatalogue } from './services/motorDb.js';
import { useCatalogue } from './components/useCatalogue.js';
import { loadCatalogueMotor } from './services/motorMatch.js';
import { restoreCatalogueOverlay } from './services/catalogueOverlay.js';
import { PreferencesDialog } from './components/PreferencesDialog.js';
import { SiteBand, SiteBandFooter } from './components/SiteBand.js';
import { MMR_NAV_FALLBACK, useMmrNav } from './services/useMmrNav.js';
import { AERO_NAME, aeroChoiceOf, effectiveAero, usePrefs, type AeroChoice } from './prefs/PrefsContext.js';
import { UnitChip } from './components/UnitChip.js';
import { fmtSi } from './prefs/units.js';
import { classLabel, diameterClass } from './services/motorDb.js';
import type { FlownAutoDelays } from './services/orkExportMotors.js';
import { withAuto, withDelay, withPlugged } from './services/mountDelayEdits.js';
import { canReplayDelays, delayMountsOf, validDelayResolution, resolutionMatchesPolicy } from './services/autoDelaySolver.js';
import { autoDelayCardText } from './components/MountDelayReport.js';
import { installedMounts, reflyRun } from './services/flightRunner.js';
import { flyBuiltDesign } from './services/simulateDesign.js';
import { buildDesign, KERNEL_HANDLES, type DesignBuild } from './services/buildDesign.js';
import { preflightAudit, readAuditMasses } from './services/preflightAudit.js';
import { loadExMotorIdentities, loadExMotors } from './services/exMotors.js';
import { autoDelaySaveNote, exportOrk, importOrk, type MeasuredFigures, type OrkExportFlightData, type OrkMotorRef } from './services/orkFile.js';
import {
  decodeShareFragment, encodeShareFragment, hasSharePayload, MAX_FRAGMENT_CHARS, shareLinkOpenFailure,
} from './services/shareLink.js';
import { exportRkt, rktComponentInfo } from './services/rocksimFile.js';
import { loadPresets } from './services/presets.js';
import { componentCsv, componentTable } from './services/componentTable.js';
import { CSV_BOM, GLB_MIME, safeName } from './services/fileName.js';
import { designFileBase, designFileLabel, designFileTitle, documentTitle, type DesignFileRef } from './services/designFileName.js';
import { saveFile, saveOutcomeNote, type SaveOutcome } from './services/saveFile.js';
import { tableToXlsx, XLSX_MIME } from './services/xlsx.js';
import { exportCdx1 } from './services/rasaeroFile.js';
import { checkFormatLossOf, checkFormatLossSafely, formatExtension, type CheckedFormatLossReport, type FormatLossInput, type FormatLossReport, type LossyFormat } from './services/formatLoss.js';
import { gateLossySave, lossySaveStatus, replacementLossNote, type LossySaveMark } from './services/lossySave.js';
import {
  flushSession, loadSession, onSessionConflictChange, onSessionSaveStateChange, saveSessionDebounced,
  sessionConflicted, sessionPredatesThisBuild, sessionSaveFailing, takeOverSession,
} from './services/session.js';
import {
  AERO_MODEL_CHANGED, aeroModelLabel, changedSinceRun, commentsOf,
  currentModelLabel, formatRunLabel, formatRunWhenProse, formatStability, listAnd,
  hasAerodynamicForce, shownStability, runMatchesDesign, runMatchesModel,
  storedSimCost,
  type DesignMatchKey, type MotorMeta, type SimRun,
} from './services/simReport.js';
import { Note, type NoteTier } from './components/Note.js';
import { formatWarning, staticWarningTier } from './services/simWarnings.js';
import { StaticWarning } from './components/WarningCode.js';
import { railInterferenceFindings } from './tree/mountAngle.js';
import {
  addRun, appendImportedRuns, loadRuns, MAX_RUNS, persistFailed, runsEvictedByLastWrite, runsUnsavedByLastWrite, runsEvictedForUndoByLastWrite,
} from './services/simStore.js';
import { APP_VERSION } from './version.js';
import { pokeServiceWorker, useVersionCheck } from './services/versionCheck.js';
import { DebugLogDownload } from './components/DebugLogDownload.js';
import { sessionDebugLog } from './services/sessionDebugLog.js';
import { offlineStatusText, useOfflineStatus } from './services/offlineStatus.js';
import {
  addChild, addStage, nozzleStages, nozzleEditableStageIds, applyStageNozzles, autoDelayBox, cloneSubtree, duplicateNode, findNode,
  findParent, hasParallelStage, makeNode, motorMounts, moveNode,
  isPristineDefault, mountCountNote, mountMotorCount, mountName, removeNode, stageIndexOf, stages,
  suppressingAncestor, updateAllNodes, updateNode,
} from './tree/treeModel.js';
import { num, numOrNull } from './tree/nodeNum.js';
import {
  flightDataForExport as flightDataForExportPure, flownAutoDelays, planSummaryImport, summaryImportCounts, summaryDocument,
} from './services/orkFlightData.js';
import { sameStoredFlight } from './services/storedRunIdentity.js';
import { motorLengthLimit } from './tree/motorLength.js';
import { noBoreReason } from './tree/motorRoom.js';
import { MotorLengthReadout } from './components/MotorLengthField.js';
import { NozzleField } from './components/NozzleField.js';
import { autoAlignFinSets } from './tree/finAlign.js';
import { addNewComponent } from './services/addComponent.js';
import { convertShrouds, type ShroudCandidate } from './tree/shroudConvert.js';
import { mountBore } from './tree/scaleRocket.js';
import { designNotices, type HeldNote } from './services/notices.js';
import { groupOf, tierLines, withoutLines, noteFlags, type ImportNote, type NoteGroup } from './services/importNotes.js';
import { dismissLegacyPositions, preserveLegacyPositionCheck } from './services/legacyPositionCheck.js';
import {
  legacyPadMassWrite, restoredPadMassNote, typedPadMass, type PadMassText,
} from './services/padMassReconcile.js';
import { baseLabel, massTextFor, padMassTextFor, statedWeightTextFor } from './services/unitText.js';
import {
  assignedMotorsOf, currentSetKeyOf, designBuildInputOf, effectiveSupersonicOf, filePrimaryOf, hardwareDeltaKgOf,
  launchPrimaryOf, legacyPadMassStepOf, physicsKeyOf, provenanceKeyOf, refusedMountIdsOf,
} from './services/designDerivation.js';
import { stageMotors } from './services/nozzleFollow.js';
import { designFingerprint, stableJson, type DesignSnapshot } from './services/dirtyState.js';
import { designStateFromSession, type RankedPadMass } from './services/sessionRestore.js';
import { createSequencer } from './services/latestWins.js';
import { designFileOpenFailure, designFileTooLarge, openDesignFile } from './services/designFile.js';
import { fetchMotorSpec } from './services/thrustcurve.js';
import {
  recoveryMass, recoveryMassByStage, recoveryMassTitle, type RecoveryByStage, type RecoveryMass,
} from './services/recoveryMass.js';
import {
  catalogueMotorMass, flownSpec, LEGACY_PAD_MASS_KEY, motorIdentity,
} from './services/hardwareMass.js';
import {
  migrateLegacyPadMass, stripPadMass, scaleConfigStageMass,
  stripRefPadMass, syncActiveConfig, withoutStoredRef, withActiveConfigTreeSynced, withActiveConfigSynced,
  createLoadedConfig, duplicateActiveConfig, renameConfig, deleteConfig,
} from './services/configSync.js';
import {
  reconcileAllIncludedMotors,
} from './services/statedLaunchWeight.js';
import { RecoverySizingPanel } from './components/RecoverySizingPanel.js';
import {
  applyConfigSwitchPlan, applyImportPlan, attachedSet, openShareLink, planConfigSwitch, planImport,
  planNewDesign, planOrkSave, resolveImportMotors, starterMotorMayLand, type ImportedDesign,
} from './services/importApply.js';
import { ScaleDialog } from './components/ScaleDialog.js';
import { WeatherDialog } from './components/WeatherDialog.js';
import { applyProposal, carrySigmaEstimate, undoApply, withSigmaEstimate, type WeatherSnapshot } from './services/weatherSnapshot.js';
import { useTreeHistory } from './hooks/useTreeHistory.js';
import { useNozzleFollow } from './hooks/useNozzleFollow.js';
import { useRelaunchLatch } from './hooks/useRelaunchLatch.js';
import { useDesignDirty, type PreRankRestore } from './hooks/useDesignDirty.js';
import { useFirstRunTour } from './hooks/useFirstRunTour.js';
import { HERO_CHIP_RESERVE, useHeroDrawer } from './hooks/useHeroDrawer.js';
import { useWorkspaceTab } from './hooks/useWorkspaceTab.js';
import { savedConfigLabel, type MountMotor, type SavedConfig } from './model/design.js';

import './styles.css';

// Static save-format metadata, shared by every render (audit 2026-10-11, S2-8).
/**
 * What the picker's file-type dropdown says, and the MIME each format is
 * offered under. A blanket application/octet-stream made every save look
 * like the same anonymous binary in the dialog.
 */
const FORMAT_INFO: Record<string, { mime: string; description: string }> = {
  ork: { mime: 'application/octet-stream', description: 'OpenRocket design' },
  rkt: { mime: 'application/octet-stream', description: 'RockSim design' },
  CDX1: { mime: 'application/xml', description: 'RASAero II design' },
  obj: { mime: 'text/plain', description: 'Wavefront OBJ geometry' },
  glb: { mime: GLB_MIME, description: 'glTF binary 3D model' },
  stl: { mime: 'application/octet-stream', description: 'STL 3D shell' },
  csv: { mime: 'text/csv', description: 'Comma-separated values' },
  xlsx: { mime: XLSX_MIME, description: 'Excel workbook' },
};

// Public feedback tracker — ONE tracker for the site and all tools
// (adjudicated 2026-08-11).
// Standing rulings: GitHub links open a NEW TAB; mailto does not; plain
// browse links go to /issues, /new only where the user already has a
// concrete bug (these buttons are exactly that context).
//
// These constants are now the FALLBACK: the Nav Contract publishes the same
// four routes (`nav.feedback`), so a tracker move is a site-side edit that
// every tool picks up on the next load. They stay here because the band's
// data can be a build-time snapshot and the Feedback menu must work either way.
const FEEDBACK_REPO = 'https://github.com/mtnmanak/mountainmanrockets-feedback';
const FEEDBACK_EMAIL = 'admin@mountainmanrockets.com';
// NO `&tool=` PARAMETER. GitHub prefills issue-form fields from query
// parameters ONLY for `input` and `textarea` types, and `tool` is a required
// DROPDOWN — passing it does nothing at all, silently. `version` is a plain
// input, so that one really does arrive filled in. See the prefill table in
// the feedback-tracker ruling before adding anything here.
const feedbackIssueUrl = (template: string) =>
  `${FEEDBACK_REPO}/issues/new?template=${template}`;

/**
 * Stamp the running build onto a bug-report URL. Uses the URL API rather than
 * string concatenation because the base may come from the contract, where a
 * future revision could drop or reorder the query string — and it must never
 * clobber `?template=`, without which GitHub bounces the filer to the template
 * chooser and drops every parameter on the way.
 */
const withVersionParam = (url: string) => {
  try {
    const u = new URL(url);
    u.searchParams.set('version', `v${APP_VERSION} beta`);
    // URLSearchParams serializes a space as "+" (form encoding). Percent-
    // encoding is what this app shipped before and what reads unambiguously
    // in a GitHub prefill, so put it back.
    u.search = u.search.replace(/\+/g, '%20');
    return u.toString();
  } catch {
    return url;
  }
};

/**
 * Pre-v0.005 the max-motor-length input lived in the motor browser's filters
 * — seed the rocket-level value from there so nobody has to re-enter it.
 */
function legacyMaxMotorLength(): number | null {
  try {
    const raw = localStorage.getItem('online-openrocket.motor-filters.v1');
    const v = raw ? (JSON.parse(raw) as { maxLength?: unknown }).maxLength : null;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Resolves in the task after the frame React just committed has PAINTED —
 * run a synchronous simulation only after awaiting this, or the busy state
 * never shows. rAF alone does NOT do it: rAF callbacks run at the START of a
 * frame, before style/layout/paint, so the "Simulating…" label React just
 * committed was still unpainted when the synchronous flight began — the
 * button appeared frozen mid-click. rAF-then-task waits for the frame to
 * paint and resumes in the next task. (BatchSimulate always got this right,
 * with a bare setTimeout — which is why its progress bar moves.)
 */
const afterPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

export function App() {
  const {
    prefs, setPrefs, resolvedTheme, daylight,
    saveFailing: prefsSaveFailing, aeroOverride, setAeroOverride,
  } = usePrefs();
  // Keep the document-level ground and the browser-chrome tint in step with
  // the LIVE theme. index.html paints both before React mounts (no white
  // flash), but that inline write is once-per-load: without this, switching
  // theme or Daylight in-app left the stale color behind overscroll and in
  // the scrollbar-gutter strip until a full reload (review finding, v0.076).
  // Values MUST match --surface-0 in styles.css and the index.html script.
  useEffect(() => {
    const bg = daylight ? '#ffffff' : resolvedTheme === 'light' ? '#f4f2ee' : '#111110';
    document.documentElement.style.background = bg;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  }, [resolvedTheme, daylight]);
  // "Am I on the current version?" — one cache-busted read of the deployed
  // version.json, plus an on-demand recheck. Never polls.
  const { state: updateState, recheck: recheckVersion } = useVersionCheck();
  const offlineState = useOfflineStatus();
  // Mountain Man Rockets site band + footer strip, and the feedback routes
  // below. ONE call for all three: the hook fetches once per mount, so the
  // contract is shared state, not three copies of the same request.
  const { nav: mmrNav, source: mmrNavSource } = useMmrNav(MMR_NAV_FALLBACK);
  const [showPrefs, setShowPrefs] = useState(false);
  // Restore the previous session (autosaved on every change) if one exists.
  // normalizeTree wraps pre-v0.009 flat trees in one stage. Lazy useState:
  // loadSession parses the whole tree — never re-run it on re-renders.
  const [session] = useState(loadSession);
  const [importedDocument, setImportedDocument] = useState(() => session?.importedDocument);
  // The autosave holds the PARSED design, not the file it came from, so a
  // design restored from a session another build wrote has never been through
  // this build's importer. Every file-reading fix we ship misses it silently.
  const [restoredByOlderBuild, setRestoredByOlderBuild] = useState(
    () => session !== null && sessionPredatesThisBuild(session));
  const [timeStepMigrated, setTimeStepMigrated] = useState(
    () => session?.timeStepWasClamped === true);
  // The step the migration replaced, so its notice can NAME the number — by
  // the time the notice renders, panel, session and autosave (~400 ms) all
  // hold 0.05 and the original survives nowhere else, so "if you want it
  // back" was a promise about a value the user could no longer find.
  // loadSession records it beside the flag. A value under the panel's floor
  // stays unnamed: the Time step field refuses it, and the notice must not
  // point at a field that cannot take what it names (same rule as the
  // importer's below-floor note in orkFile.ts).
  const timeStepMigratedFrom = (() => {
    const v = session?.timeStepClampedFromS;
    return v != null && Number.isFinite(v) && v >= PANEL_TIME_STEP_FLOOR_S ? v : null;
  })();
  // The design the session restores to, decided ONCE, by the same function
  // anything else that flies a stored session uses (services/sessionRestore.ts,
  // 2026-10-01): the tree normalized and its motor-length limits migrated, a
  // v0.116/v0.117 pad mass moved onto the primary, the core-first ranking, the
  // unmatched references and the third `measured` key. Every initializer below
  // reads from this one value, so they all key onto the SAME tree — a second
  // normalizeTree would mint ids that are not in it.
  const [restored] = useState(() => designStateFromSession(session, { legacyMaxMotorLengthM: legacyMaxMotorLength() }));
  const { restoreNotes, restoreNoteTiers, preLengthRestore } = restored;
  const initialTree = restored.state.tree;
  // Only crossing a Scale step restores configuration snapshots. An ordinary
  // tree undo (especially after Apply None) must not undo saved configuration edits.
  const scaleRevision = useRef<object>({});
  const layerRevision = useRef<object>({});
  // None clears a detached working set permanently, without resetting tree history.
  const detachedHistoryEpoch = useRef<object>({});
  const flightEdit = useRef<{ owner: 'default' | 'detached' | { configId: string }; committed: boolean; cancel: () => void } | null>(null);
  const motorAnswerRevision = useRef<object>({});
  const restoringMotors = useRef<Record<string, MountMotor> | null>(null);
  const [openMotorQuestion, setOpenMotorQuestion] = useState<{ identities: OpenMotorIdentity[]; openId: number; acceptedLines: string[] } | null>(null);
  // The design tree and its undo/redo history (hooks/useTreeHistory.ts, audit
  // 2026-09-22 extraction #4). `onRestore` and `blocked` are read at call time,
  // so they may name what is declared further down. A tree off the stack is
  // flown under the motors mounted NOW, which are not on the stack, so its
  // nozzle is re-decided for them (`restoreNozzleFollow`) and its stated launch
  // weight reconciled (`spendSpentMarks`); `blocked` is the
  // flight-holds-a-handle gate.
  const {
    tree, treeRef, writeTree, setTree, commitStep: commitTreeStep, checkpoint: flightCheckpoint, undo, redo,
    selectedId, setSelectedId, treeElementRef,
    reset: resetHistory, canUndo, canRedo,
  } = useTreeHistory(initialTree, {
    captureCompanion: (): { revision: object; configs: SavedConfig[]; motorRevision: object; motorState: OpenMotorState;
      layerRevision: object; detachedOverrides: FlightOverrides; activeConfigId: string | null; detachedEpoch: object } => ({
      detachedEpoch: detachedHistoryEpoch.current,
      layerRevision: layerRevision.current, detachedOverrides, activeConfigId,
      revision: scaleRevision.current,
      motorRevision: motorAnswerRevision.current,
      motorState: { mountMotors, savedConfigs, unmatchedRefs },
      configs: withActiveConfigTreeSynced(savedConfigs, activeConfigId, treeRef.current),
    }),
    restoreCompanion: ({ revision, configs, motorRevision, motorState, layerRevision: priorLayerRevision,
      detachedOverrides: priorDetached, activeConfigId: priorActiveId, detachedEpoch }) => {
      if (priorLayerRevision !== layerRevision.current) {
        layerRevision.current = priorLayerRevision;
        if (detachedEpoch === detachedHistoryEpoch.current && priorActiveId === activeConfigId) setDetachedOverrides(priorDetached);
        // Delete is not a history boundary (audit 2026-10-11, FC-4 fixup).
        // Its former owner's edits now belong to the detached working set.
        // None keeps the saved owner: restore that entry below, leaving None clear.
        else if (detachedEpoch === detachedHistoryEpoch.current && activeConfigId === null && priorActiveId !== null
            && !savedConfigs.some(c => c.id === priorActiveId)) {
          setDetachedOverrides(activeFlightOverrides(configs, priorActiveId, priorDetached));
        }
        setSavedConfigs(prev => prev.map(c => {
          const old = configs.find(row => row.id === c.id);
          return old ? { ...c, deployments: old.deployments, separations: old.separations, ignitions: old.ignitions } : c;
        }));
      }
      // React has not installed these motors when onRestore runs (audit 2026-10-11, S2-3).
      restoringMotors.current = motorRevision !== motorAnswerRevision.current ? motorState.mountMotors : null;
      // @atestani TRF #162, Eric 2026-10-06: only crossing an answer restores motors.
      if (motorRevision !== motorAnswerRevision.current) {
        motorAnswerRevision.current = motorRevision;
        setMountMotors(motorState.mountMotors);
        setUnmatchedRefs(motorState.unmatchedRefs);
        // Configuration names and deletions are not tree-history edits; keep
        // them when crossing a motor answer (audit 2026-10-11, S2-1).
        setSavedConfigs(prev => prev.map(c => {
          const old = motorState.savedConfigs.find(row => row.id === c.id);
          if (!old) return c;
          const { motors, unmatchedRefs, unmatched, nozzles } = old;
          return { ...c, motors, unmatchedRefs, unmatched, nozzles };
        }));
      }
      if (revision === scaleRevision.current) return;
      scaleRevision.current = revision;
      setSavedConfigs(prev => prev.map(c => {
        const old = configs.find(row => row.id === c.id);
        if (!old) return c;
        const { stageMassOverrides: _snapshot, ...rest } = c;
        return old.stageMassOverrides ? { ...rest, stageMassOverrides: old.stageMassOverrides } : rest;
      }));
    },
    onRestore: (t): RocketTree => {
      restoreNozzleFollow(t);
      return preserveLegacyPositionCheck(spendSpentMarks.current(t), treeRef.current);
    },
    blocked: () => flightHoldsHandle.current || fullSeriesHolds.current > 0,
  });
  // Component clipboard (copy/cut → paste into another parent). Holds the
  // node AS COPIED — a later cut/delete of the original doesn't affect it.
  const [clipboard, setClipboard] = useState<ComponentNode | null>(null);
  // Per-mount motors (Release C). Legacy sessions carried ONE motor + the
  // mount it applied to — migrate it onto that mount.
  const { defaultMountId } = restored;
  /**
   * What became of a v0.116/v0.117 session's `measured.padMassKg` at restore
   * (configSync.migrateLegacyPadMass): attached to the primary mount's record
   * under the 'legacy' key, dropped because no in-tree mount had a motor, or
   * none. Read once, by the `padMassNote` seed below — the notice that says
   * where the value went is the whole reason the outcome is kept.
   */
  const legacyPadMass = useRef<ReturnType<typeof migrateLegacyPadMass> | null>(restored.legacyPadMass);
  /**
   * Where the restore moved a weighed pad mass when the core-first ranking
   * (audit 2026-09-22, row 356) named a different primary than the session was
   * saved under — treeModel.padMassOntoRankedPrimary. Read once, by the
   * `padMassNote` seed, for the same reason as `legacyPadMass`.
   */
  const rankedPadMass = useRef<RankedPadMass | null>(restored.rankedPadMass);
  /**
   * The working set and configurations exactly as the session stored them,
   * kept only when padMassOntoRankedPrimary moved a pad mass in either — for
   * the one re-take of the saved mark after the mark's seed (useDesignDirty).
   */
  const preRankRestore = useRef<PreRankRestore | null>(restored.preRankRestore);
  // The working set as restored (services/sessionRestore.ts): a session's
  // motors with any v0.116/v0.117 pad mass migrated onto the primary and a
  // weighing moved onto the core's record, a pre-per-mount session's one motor
  // on its mount, or — a fresh design — EMPTY: it gets its starter motor from
  // the effect below, the catalogue's Estes C6 with its published curve, which
  // the shipped bundle answers with no network.
  const [mountMotors, setMountMotors] = useState<Record<string, MountMotor>>(restored.state.mountMotors);
  const motorChoices = useRef(new Map<string, object>());
  const beginMotorChoice = (mountId: string) => {
    const token = {};
    motorChoices.current.set(mountId, token);
    return () => motorChoices.current.get(mountId) === token
      && motorMounts(treeRef.current).some((m) => m.id === mountId);
  };
  // A previous "check thrustcurve.org for newer motors" left its delta in this
  // browser; install it before anything looks a motor up, so an imported file
  // naming a motor that exists only in the overlay still resolves. It discards
  // itself if this build's motors.json is newer than the base it was diffed
  // against. Runs BEFORE the starter-motor effect below on purpose.
  useEffect(() => { restoreCatalogueOverlay(); }, []);

  const wantsStarterMotor = !session?.mountMotors && !session?.motor && !!defaultMountId;
  /**
   * The starter motor as it arrives, held until the render that has it in
   * state, where the first-visit saved mark is re-taken over it (the effect
   * after the mark's seed, below). Without that, the mark described the
   * rocket with NO motor — it is seeded on mount, one await before the C6
   * lands — so the untouched starter read as unsaved, the stale mark was
   * autosaved, and every newcomer's Open and ✕ New asked about a rocket they
   * never touched, on every reload (audit 2026-09-22).
   */
  const starterLanding = useRef<MountMotor | null>(null);
  useEffect(() => {
    if (!wantsStarterMotor) return;
    let live = true;
    void loadCatalogueMotor('Estes', 'C6', 5)
      .then((m) => {
        // Only if nothing beat it: the user may have picked a motor, or opened
        // a file or pressed ✕ New, in the time the bundle chunk took to arrive
        // (importApply.starterMotorMayLand — the mount must still be on screen).
        if (!live || !m) return;
        // The saved mark is re-taken on the render that has this motor in
        // state (audit 2026-09-22, row 295) — see the effect that reads it.
        starterLanding.current = m;
        setMountMotors((prev) => (starterMotorMayLand(treeRef.current, defaultMountId!, prev)
          ? { [defaultMountId!]: m } : prev));
      })
      .catch(() => { /* no bundled curve and no network: the design starts with no motor, honestly */ });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot startup decision
  }, []);
  // Stage B: the imported file's flight configurations as presets, and which
  // one the working set (mountMotors) came from. null = custom/none — manual
  // motor edits KEEP the active id (the working set is that config's current
  // truth, and export writes the live set into it); only unloading
  // everything or applying "None" clears it.
  // Each stored configuration's pad mass follows the core-first ranking the
  // same way the working set's does (audit 2026-09-22, row 356; applied in
  // services/sessionRestore.ts), or applying one saved with a pod motor picked
  // first would orphan it again. A row nothing moves in is kept by identity.
  const [savedConfigs, setSavedConfigs] = useState<SavedConfig[]>(restored.state.savedConfigs);
  const [detachedOverrides, setDetachedOverrides] = useState<FlightOverrides>(restored.state.detachedOverrides);
  const [activeConfigId, setActiveConfigId] = useState<string | null>(restored.state.activeConfigId);
  /**
   * The WORKING SET's unmatched motor references, keyed by mount node id — the
   * motors the file named that nothing could resolve. Kept so Save .ork writes
   * them back verbatim instead of emitting a mount with no motor; see
   * SavedConfig.unmatchedRefs. Dropped for a mount as soon as the user assigns
   * or removes a motor there, because at that point the file's reference is no
   * longer what the user wants on that mount.
   *
   * Persisted with the session since the 2026-09-22 audit: a
   * configuration-less import (a .rkt naming a motor the catalogue lacks) has
   * no configuration to hold them, so they lived here alone and a reload lost
   * them. At restore the session's copy is used, minus any mount that has a
   * record; a session written before falls back to the ACTIVE configuration's
   * stored refs, which the write-back in applyConfig / clearConfig / onSaveOrk
   * (configSync.syncActiveConfig) keeps current (v0.118).
   */
  const [unmatchedRefs, setUnmatchedRefsRaw] = useState<Record<string, OrkMotorRef>>(restored.state.unmatchedRefs);
  /**
   * The live references, mirrored into a ref for exactly the reason `treeRef`
   * mirrors the tree (2026-09-08, from review): `assignMotor` runs after an
   * AWAITED thrust-curve fetch, so two quick-picks on a two-stage design can
   * land in one flush, and the second read this render's `unmatchedRefs` —
   * still holding the reference the first pick had just dropped. The deletions
   * themselves composed (they were functional updaters), but the
   * `remainingRefs` SNAPSHOT handed to `assignMotorRecord` was pre-batch, so
   * the adopted pad mass was keyed against a set naming a mount that already
   * had a real motor on it, and read back as a stale weighing.
   *
   * Every writer goes through `setUnmatchedRefs` below, which advances the
   * mirror as it writes. The value is computed OUT here and a plain value
   * handed to React, so the StrictMode purity rule on `treeRef` holds here too.
   */
  const unmatchedRefsRef = useRef(unmatchedRefs);
  unmatchedRefsRef.current = unmatchedRefs;
  const setUnmatchedRefs = useCallback((
    next: Record<string, OrkMotorRef> | ((prev: Record<string, OrkMotorRef>) => Record<string, OrkMotorRef>),
  ) => {
    const value = typeof next === 'function' ? next(unmatchedRefsRef.current) : next;
    unmatchedRefsRef.current = value;
    setUnmatchedRefsRaw(value);
  }, []);
  // A RASAero import's Mach-Alt table, offered to the drag panel as a sweep
  // condition. Session-only: it belongs to the imported file, not the design.
  const [fileMachAlt, setFileMachAlt] = useState<[number, number][] | undefined>(() => session?.fileMachAlt);
  const [designFile, setDesignFile] = useState<DesignFileRef | null>(() => session?.designFile ?? null);
  const [lossySaved, setLossySaved] = useState<LossySaveMark | null>(restored.session?.lossySaved ?? null);
  const [lossDialog, setLossDialog] = useState<{ report: FormatLossReport; confirm: boolean } | null>(null);
  const [liveLoss, setLiveLoss] = useState<{ file: DesignFileRef; report: CheckedFormatLossReport } | null>(null);
  const moveLossyMark = useCallback((before: string, after: string) => {
    setLossySaved(l => l && l.mark === before ? { ...l, mark: after } : l);
  }, []);
  const [launch, setLaunch] = useState<LaunchConditions>(restored.state.launch);
  /**
   * The launch conditions as last rendered, for an open to merge the file's
   * into AFTER its last await (audit 2026-09-22). The open's own closure holds
   * the launch from the render that started it, so a wind typed while a file
   * was opening was kept on screen by the old updater but left out of the saved
   * mark — the just-opened design read as unsaved.
   */
  const launchRef = useRef(launch);
  launchRef.current = launch;
  /**
   * Where the applied weather came from (weather build, step 3) — SESSION
   * state beside `launch`, never part of the design: the fields it set are
   * ordinary launch conditions. Kept across ✕ New, which keeps the launch
   * conditions it describes; dropped when an opened design brings its own
   * (applyImported), since it would then describe numbers no longer there.
   */
  const [weather, setWeather] = useState<WeatherSnapshot | null>(session?.weather ?? null);
  const [longitudeReview, setLongitudeReview] = useState<LongitudeReview | null>(null);
  /**
   * The weather dialog, and which way in: ☁ Get weather opens on today; the
   * stale strip's Fetch again opens on the applied weather's own date and
   * hour (WeatherDialog `initialHour`).
   */
  const [showWeather, setShowWeather] = useState<false | 'get' | 'again'>(false);
  /** ☁ Apply: ONE functional write — never from a render-captured `launch` (AUDIT row 304). */
  const applyWeather = (patch: Parameters<typeof applyProposal>[1], snapshot: WeatherSnapshot) => {
    setLaunch((prev) => applyProposal(prev, patch));
    // σ is never in a weather patch, so this render's launch holds the σ the
    // new record must be compared with (weatherSnapshot.carrySigmaEstimate).
    setWeather((prev) => carrySigmaEstimate(prev, snapshot, launch));
  };
  /**
   * The strip's Undo: each applied field back, unless it has been edited
   * since — and Wind gusts σ too, when the gust chip set it from this weather.
   */
  const undoWeather = () => {
    const snap = weather;
    if (!snap) return;
    setLaunch((prev) => undoApply(prev, snap));
    setWeather(null);
  };
  /**
   * The gust chip's click: σ written, and what σ held a moment before kept
   * on the weather record, so Undo can put it back (review of 2026-09-23).
   * `launchRef` is the launch this click was made against.
   */
  const estimateSigma = (sigmaMs: number) => {
    const current = launchRef.current;
    const before = current.windStdDev;
    setLaunch((prev) => editProfileSurface(prev, { ...prev, windStdDev: sigmaMs }));
    setWeather((w) => (w ? withSigmaEstimate(w, sigmaMs, before, current) : w));
  };
  /**
   * The in-memory flight, BOUND TO THE RUN IT BELONGS TO. It used to be a
   * bare FlightResult with no link to `lastRun`, so selecting a row in the
   * saved-run table had to null it defensively — which destroyed the charts
   * for the flight you had just flown, with no way back short of pressing
   * Launch again (and Launch always saves another row: that is where the
   * duplicate history rows came from). With the id attached, the charts can
   * simply ask "is this result the one this run is showing?".
   */
  const [result, setResult] = useState<{ runId: string; value: FlightResult } | null>(null);
  const [lastRun, setLastRun] = useState<SimRun | null>(null);
  // File summaries are read-only inspections, never the current flight.
  const [inspectedSummary, setInspectedSummary] = useState<SimRun | null>(null);
  /**
   * Re-flights of stored runs, keyed by run id. Small and insertion-ordered
   * (Map) so eviction is the oldest key; cleared by the physics-change reset
   * effect, which already owns the rule that no flight outlives the design it
   * was computed for. Series are NOT persisted — this only spares the user a
   * second re-fly when they click back and forth through history.
   */
  const reflightCache = useRef(new Map<string, FlightResult>()).current;
  const cacheFlight = useCallback((id: string, res: FlightResult) => {
    reflightCache.delete(id);
    reflightCache.set(id, res);
    while (reflightCache.size > 5) {
      const oldest = reflightCache.keys().next().value;
      if (oldest === undefined) break;
      reflightCache.delete(oldest);
    }
  }, [reflightCache]);
  /** Run id currently being re-flown by a "Show charts" press, if any. */
  const [reflying, setReflying] = useState<string | null>(null);
  /**
   * How long the last simulation took, and the step it used — kept SEPARATELY
   * from `lastRun` because it is a performance measurement, not a flight
   * result. `lastRun` is cleared whenever the design or the launch conditions
   * change (a displayed apogee must never outlive the conditions that produced
   * it), but the cost of a step is still the cost of a step. Without this split
   * the time-step caution could never show a seconds estimate: editing the
   * time-step field is itself a launch-conditions change, so it wiped the
   * number it was about to quote.
   */
  const [lastSimCost, setLastSimCost] = useState<{ ms: number; timeStepS?: number } | null>(null);
  const [runs, setRuns] = useState<SimRun[]>(() => loadRuns());
  // Storage-full surfacing. simStore mutations are synchronous, so checking
  // persistFailed() right after each one is enough — recordRuns is that one
  // funnel (App's own addRun plus the SimHistory/BatchSimulate callbacks).
  // Set from the value on EVERY mutation — raise AND clear: a banner that
  // only ever raised kept claiming storage was full while the table showed
  // a freshly saved run. Dismissible; a later refused write raises it again.
  const [runsQuotaWarn, setRunsQuotaWarn] = useState(false);
  // What the 500-run cap cut since the user last dismissed the note — through
  // the same funnel, so a Launch at the cap and a batch that overflows it are
  // both counted (audit 2026-09-22: the cap evicted silently). Saved runs it
  // removed and new runs that never fit are counted apart: only a batch of
  // more than 500 can do the second, and they are not "the oldest" of anything.
  const [runsCapped, setRunsCapped] = useState({ evicted: 0, unsaved: 0, undoEvicted: 0 });
  const recordRuns = useCallback((next: SimRun[]) => {
    setRuns(next);
    setInspectedSummary((selected) => selected
      ? next.find((r) => r.importedSummary && sameStoredFlight(r, selected)) ?? null : null);
    setRunsQuotaWarn(persistFailed());
    const evicted = runsEvictedByLastWrite();
    const unsaved = runsUnsavedByLastWrite();
    const undoEvicted = runsEvictedForUndoByLastWrite();
    if (evicted > 0 || unsaved > 0 || undoEvicted > 0) {
      setRunsCapped((n) => ({ evicted: n.evicted + evicted, unsaved: n.unsaved + unsaved, undoEvicted: n.undoEvicted + undoEvicted }));
    }
  }, []);
  // Session autosave happens inside a debounce, so its health is pushed, not
  // polled: subscribe for the working<->failing edges (deduped in session.ts).
  // Non-dismissible while failing — it clears itself when a save sticks.
  const [autosaveFailing, setAutosaveFailing] = useState(() => sessionSaveFailing());
  useEffect(() => onSessionSaveStateChange(setAutosaveFailing), []);
  // Another tab wrote the autosave since this one last read it, and this tab's
  // writes are being held back rather than overwrite that work (audit
  // 2026-09-22; services/session.ts "ONE SLOT, SEVERAL TABS"). Pushed the same
  // way, and cleared only by a choice in the banner.
  const [sessionConflict, setSessionConflict] = useState(() => sessionConflicted());
  useEffect(() => onSessionConflictChange(setSessionConflict), []);
  // While it stands, closing this tab really would lose its changes — they are
  // in no slot — so this is the one state that earns a leave-page prompt (the
  // pagehide flush's comment explains why every other state does not).
  // "Load the other tab's design" reloads on purpose, and says so first.
  const leavingForOtherTab = useRef(false);
  useEffect(() => {
    if (!sessionConflict) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leavingForOtherTab.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => { window.removeEventListener('beforeunload', onBeforeUnload); };
  }, [sessionConflict]);
  const [simulating, setSimulating] = useState(false);
  /**
   * The Results workspace's <main>, which Launch focuses, and what the polite
   * flight announcer says (audit 2026-09-22). Launch switches tab in the same
   * click, so the button pressed unmounts (Motors & Configuration, Fly) or goes
   * disabled (the vitals strip) and focus fell to <body>; and a finished flight
   * was announced to nobody, so the app's central action gave no non-visual
   * feedback at all. `seq` keys the spoken element, so a second flight to the
   * same apogee is a DOM change a screen reader hears.
   */
  const resultsMainRef = useRef<HTMLElement>(null);
  const motorsHeading = useRef<HTMLHeadingElement>(null);
  const [flightSaid, setFlightSaid] = useState({ seq: 0, text: '' });
  const [simError, setSimError] = useState<string | null>(null);
  // Separate from the file note: repairing a loadout must preserve other import warnings.
  const [motorLoadoutRepair, setMotorLoadoutRepair] = useState<Notice | null>(null);
  /**
   * The file/transient note. Severity was added in 2026-08-23: the same widget
   * carried "share link copied" and "could not open that .ork file", so the
   * strip could not be made quieter for routine information without quietening
   * genuine errors too. setFileNote keeps its old string signature (info by
   * default) so every existing call site is unchanged.
   */
  const [fileNoteState, setFileNoteState] =
    useState<HeldNote | null>(() =>
      // The restore's repairs, each line with its producer's tier (D7 §4).
      restoreNotes.length ? { text: restoreNotes.join('\n'), severity: 'info',
        group: { lines: tierLines(restoreNotes, restoreNoteTiers) } } : null);
  const setFileNote = useCallback((text: string | null, severity: NoticeSeverity = 'info', expand?: boolean, tier?: NoteTier) => {
    setFileNoteState(text === null ? null : { text, severity, ...(expand ? { expand: true } : {}), ...(tier ? { tier } : {}) });
  }, []);
  /**
   * A failed 2D/3D image export from the hero's own buttons: Danger, drawn in
   * the fixed notice strip rather than the header block, which is off screen
   * once the canvas is scrolled into view (review of NOTES-1b, finding 1).
   */
  const setHeroExportFailure = useCallback((text: string) => {
    setFileNoteState({ text, severity: 'error', tier: 'danger', inBar: true });
  }, []);
  /** An open's or a configuration switch's note: its text and its tiered lines (services/importApply.ts). */
  const setGroupNote = useCallback((text: string, severity: NoticeSeverity, expand?: boolean, group?: NoteGroup) => {
    setFileNoteState({ text, severity, ...(expand ? { expand: true } : {}), ...(group ? { group } : {}) });
  }, []);
  /** Imported hand-rolled camera shrouds awaiting the convert-to-native offer. */
  const [shroudPrompt, setShroudPrompt] = useState<ShroudCandidate[] | null>(null);
  // Session restore is routine good news — one quiet line that fades out,
  // not an alert banner (identity pass v0.027).
  const [sessionNote, setSessionNote] = useState<string | null>(
    session ? `Restored your previous session (“${session.tree.name ?? 'unnamed'}”, saved ${new Date(session.savedAt).toLocaleString()}).` : null,
  );
  const [sessionNoteFading, setSessionNoteFading] = useState(false);
  useEffect(() => {
    if (!sessionNote) return;
    const fade = setTimeout(() => setSessionNoteFading(true), 7000);
    const clear = setTimeout(() => setSessionNote(null), 7800);
    return () => { clearTimeout(fade); clearTimeout(clear); };
  }, [sessionNote]);
  const [view, setView] = useState<'2d' | '3d' | 'aft'>('2d');
  // The All-stats drawer over the hero canvas, its breakpoint, its
  // auto-collapse and the canvas's fit-to-content sizing — hooks/useHeroDrawer.ts
  // (audit 2026-09-22, row 501), tested there.
  const hero = useHeroDrawer();
  /** S1's 90° toggle: draw the 2D view nose-up (viewing mode — drag/zoom off). */
  const [vert2d, setVert2d] = useState(false);
  /**
   * Roll about the rocket's long axis, shared by the 2D side view and the Aft
   * view (the desktop's rotation slider drives whichever figure is showing).
   * A VIEW state, like zoom: it is not saved with the design and not a
   * preference — reload and the rocket is back at its own clock angles.
   */
  const [viewRoll, setViewRoll] = useState(0);
  const [confirmNew, setConfirmNew] = useState(false);
  /** A decoded share-link design waiting for the user's OK to replace theirs. */
  const [shareOffer, setShareOffer] = useState<ImportedDesign | null>(null);
  const [showBatch, setShowBatch] = useState(false);
  const [showScale, setShowScale] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  // The workspace tab, persisted, and the first-run tour that walks it —
  // hooks/useWorkspaceTab.ts and hooks/useFirstRunTour.ts (audit 2026-09-22,
  // row 501), each tested there.
  const [tab, setTab] = useWorkspaceTab();
  const tour = useFirstRunTour({ tourOff: prefs.tourOff ?? false, hasSession: session != null, setTab });
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  // Escape closes whichever header popup is open and puts focus back on the
  // button that opened it. Before this, App had no key handling of any kind:
  // the export popup — the only route to Save .ork — could be opened from the
  // keyboard and then not dismissed, and closing it by any route left focus
  // nowhere.
  useMenuPopup(showFileMenu, () => setShowFileMenu(false));
  useMenuPopup(showFeedback, () => setShowFeedback(false));
  // Auto aero mode: did the last flight of THIS design cross the Mach-0.9
  // threshold and upgrade to the supersonic model? Sticky until the design,
  // motors or launch conditions change, so the displayed statics match the
  // model the flight actually used. NOT reset by a model change any more —
  // switching models keeps the flight and marks it (see the reset effect).
  const [autoSupersonic, setAutoSupersonic] = useState(false);

  /**
   * What the user weighed, in SI: the AIRFRAME, with the motor out — mass and
   * CG, the two figures the Measured mass & CG box holds. Persisted with the
   * session so reopening the tab does not lose it; the ballast the pair
   * produced lives in the design itself as an ordinary mass component.
   *
   * The weighed PAD mass (motor in) is NOT here any more. v0.116 put it beside
   * these two as a third key, and a pad weight is not an airframe figure: it
   * is one rocket with one motor set and that set's adapter, retainer and
   * closure in it, so it must go with the motor. Since v0.118 it rides on the
   * primary mount's MountMotor (`padMassKg` / `padMassWeighedWith`, above);
   * the hardware it derives is re-computed on every build (buildResult below),
   * never stored. A session written by v0.116/v0.117 still carries the third
   * key here — the mountMotors initializer above migrated it, and it is
   * stripped below ONLY when present, so every other session's object is
   * returned by identity and fingerprints exactly as it did (dirtyState hashes
   * keys; a normaliser that touched every session would ask every user to
   * save on first load after the upgrade).
   */
  const [measured, setMeasured] = useState<MeasuredFigures>(restored.state.measured);
  /** A mass for a notice, in the user's unit ("7480 g"). */
  const massText = massTextFor(prefs.units);
  /**
   * The unit-aware formatters services/statedLaunchWeight.ts asks for, in one
   * place — four call sites used to build them inline and any one of them could
   * have drifted into a different unit for the same sentence. Built by
   * services/unitText.ts, which the headless Launch writes its notes with too.
   */
  const statedWeightText = statedWeightTextFor(prefs.units);
  /**
   * The words a pad-mass note is written with (services/padMassReconcile.ts):
   * the user's mass unit, and a motor named without its delay grain.
   */
  const padMassText: PadMassText = padMassTextFor(prefs.units);
  /**
   * What became of a pad mass carried in from v0.116/v0.117 — its own entry in
   * the notice strip (`pad-mass-moved`), NOT setFileNote, which would overwrite
   * an import note. Seeded here for the one outcome the restore already knows
   * (dropped: no motor to belong to); the reconcile effect below writes the
   * other two after the first build has checked the value against the motor.
   * Also where a pad mass the core-first ranking moved went (rankedPadMass),
   * so the value is not seen to jump from one card to another unexplained.
   * The sentences are services/padMassReconcile.ts's, tested there.
   */
  const [padMassNote, setPadMassNote] = useState<HeldNote | null>(() => restoredPadMassNote(
    legacyPadMass.current, rankedPadMass.current, { tree: initialTree, motors: mountMotors, text: padMassText }));

  /** The file the user picked while there was unsaved work — held for the prompt. */
  const [pendingOpen, setPendingOpen] = useState<File | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const [showExamples, setShowExamples] = useState(false);
  const [recentNote, setRecentNote] = useState<string | null>(null);
  /**
   * Which OPEN is current. Opening a design is asynchronous — a file read, the
   * preset catalogue, and one thrustcurve.org fetch per unmatched motor with
   * no timeout — so two opens overlap freely and the SLOWER one used to land
   * last and win. Bumped before the first await of every open path — Open…,
   * a share link (importApply.openShareLink) — and by ✕ New, which supersedes
   * any open still in flight (audit 2026-09-22); each open checks it before
   * touching state. See applyImported.
   */
  const openSeq = useRef(createSequencer()).current;
  /**
   * WHICH BUILD'S IMPORTER produced the tree now in state — not which build is
   * running.
   *
   * The autosave holds the PARSED design, so a session restored from an older
   * build has never been through this build's importer and `restoredByOlderBuild`
   * says so. That signal used to self-destruct: the mount-time autosave fires
   * ~400 ms after any load and re-stamps the stored session with the RUNNING
   * version, so the notice was gone on the next reload and the tester kept
   * flying the old parse. Carried forward here until an import or a New
   * actually re-parses the tree.
   */
  const parsedByVersion = useRef<string | undefined>(
    session ? session.appVersion : APP_VERSION);

  /**
   * The design as the user would save it, assembled ONCE per change.
   *
   * `designFingerprint` walks the tree, every mount motor and every saved
   * configuration — and a MountMotor.spec is a full MotorSpec, so the whole
   * thrust curve is in there, twice over for a design with configurations.
   * Measured with the real `stable`/`shortHash` under node: 0.27 ms for a
   * 200-point single-motor design, 2.5 ms at 900 points with 6 configurations,
   * 7.4 ms at 1500 points with 12 — 15 % to 45 % of a 60 fps frame. It used to
   * run unmemoized in the component body, so dragging the roll slider (a range
   * input firing on every pointer move) paid it on every frame, as did every
   * keystroke in the Rocket name field, to produce a string two click handlers
   * read.
   *
   * The dependency list is by construction the set of inputs the snapshot
   * reads, which is the same list the autosave effect below uses.
   */
  const designSnapshot = useMemo<DesignSnapshot>(() => {
    return {
      tree,
      mountMotors,
      launch,
      savedConfigs,
      activeConfigId,
      detachedOverrides,
      measured,
    };
  }, [tree, mountMotors, launch, savedConfigs, activeConfigId, detachedOverrides, measured]);

  /**
   * "Is there work a file on disk does not have?" — hooks/useDesignDirty.ts:
   * the mark, the seeding rule (a first visit is clean, and stays clean when
   * the starter motor lands; a restore that moved a pad mass onto the ranked
   * primary stays as saved as it was stored), the flown-since-save flag and
   * `dirty` itself, tested there by behaviour (audit 2026-09-22, row 501).
   * WHICH actions may call `markSaved` is App's to decide: three — a .ork
   * save, an import and ✕ New. The lint gate holds the sites (eslint.config.mjs
   * refuses any other `markSaved` in this file; each of the three carries a
   * reasoned disable), and App.save.test.tsx drives every Save As / Export
   * entry and the flight actions to show none of the others clears the guard
   * (AUDIT row 477 — savedMarkSites.test.ts counted the sites in this text).
   */
  const {
    dirty, markSaved, migrateSavedMark, markFlown, savedMark, flownSinceSave, flightCount, dirtyTick,
  } = useDesignDirty(designSnapshot, restored.session, { landing: starterLanding, mountId: defaultMountId }, preRankRestore, preLengthRestore, restored.preConfigRestore,
    // A .rkt/.CDX1 save marks the design it wrote, apart from the .ork mark:
    // a non-edit rewrite (catalogue relabel, restore migration, starter landing)
    // moves it too, or a design identical to the saved file reads as unsaved.
    { onMarkMigrated: moveLossyMark });
  const currentMark = useMemo(() => designFingerprint(designSnapshot), [designSnapshot]);
  // The hook's counter is session-local; saved provenance carries its prior count.
  const lossyFlights = (session?.lossySaved?.flights ?? 0) + flightCount.current;
  const lossyStatus = designFile && (designFile.format === 'rkt' || designFile.format === 'cdx1')
    ? lossySaveStatus(lossySaved, currentMark, lossyFlights)
      ?? (designFile.via !== 'opened' || dirty ? 'Unsaved changes' : null) : null;
  const liveLossReport = liveLoss?.file === designFile ? liveLoss.report : null;

  // The rocket name lives INSIDE the file; the name on disk can be different.
  // Desktop OpenRocket shows both in its window title, with the same unsaved
  // marker. Keep the browser tab in step with edits, opens and Save As too.
  useEffect(() => {
    document.title = documentTitle(tree.name, designFile, dirty);
  }, [tree.name, designFile, dirty]);

  const catalogue = useCatalogue();
  useEffect(() => subscribeCatalogue(() => {
    const currentCatalogue = getCatalogue();
    const motors = restoreMotorLabels(designSnapshot.mountMotors, currentCatalogue);
    const configs = designSnapshot.savedConfigs.map(c => restoreConfigLabels(c, currentCatalogue));
    if (motors === designSnapshot.mountMotors
      && configs.every((c, i) => c === designSnapshot.savedConfigs[i])) return;
    migrateSavedMark(designSnapshot, { ...designSnapshot, mountMotors: motors, savedConfigs: configs });
    setMountMotors(motors);
    setSavedConfigs(configs);
  }), [designSnapshot, migrateSavedMark]);

  // The autosave effect itself sits below `flownAutoDelaysNow`: it carries
  // what a Save would write for each Auto mount's delay, from the export input.

  // Close the 400 ms debounce window on the way out. `pagehide` fires on
  // close, reload and navigation away - and on a mobile browser discarding the
  // page, which `beforeunload` does not. No confirmation dialog: the autosave
  // genuinely restores the design, so stopping every tab close to say so would
  // be a nag rather than a guard — except while another tab holds the slot
  // (`sessionConflict` above), when it does not.
  useEffect(() => {
    const onHide = () => { flushSession(); };
    window.addEventListener('pagehide', onHide);
    return () => { window.removeEventListener('pagehide', onHide); };
  }, []);

  /** The design as it would be saved, as of this render — what a save marks. */
  const snapshotNow = (): DesignSnapshot => designSnapshot;
  /**
   * Clear the design and start over. ONE definition, because the New button
   * now reaches it directly when there is nothing to lose and through the
   * confirmation when there is - and two copies of a twelve-setter reset is
   * exactly the shape of thing that gets fixed in one place only.
   */
  const startNewDesign = () => {
    motorChoices.current.clear();
    // ONE emptyTree(), for BOTH the state and the mark (importApply's
    // planNewDesign says why that matters). Pressing ✕ New twice used to raise
    // "Start a new design?" on an empty design, which is the always-fires
    // confirmation the comment on the New button warns about. Handing it the
    // open sequence supersedes any Open still in flight (audit 2026-09-22).
    const { snapshot: fresh, mark } = planNewDesign({ launch, measured: { massKg: null, cgM: null } }, openSeq);
    setTree(fresh.tree);
    setMountMotors({});
    setUnmatchedRefs({});
    setSavedConfigs([]);
    setDetachedOverrides({});
    setImportedDocument(undefined);
    setActiveConfigId(null);
    setSelectedId(null);
    setResult(null);
    setLastRun(null);
    setInspectedSummary(null);
    setConfirmNew(false);
    // This tree was built by THIS build, so the stale-autosave warning no
    // longer describes what is on screen (and must not survive into the
    // session the next autosave writes).
    parsedByVersion.current = APP_VERSION;
    setRestoredByOlderBuild(false);
    // The Mach-Alt table belongs to the RASAero file it came in with. Left
    // standing, the drag panel went on offering the PREVIOUS rocket's flight
    // altitudes as a sweep condition for a design that never flew them.
    setFileMachAlt(undefined);
    setDesignFile(null);
    setLossySaved(null);
    setLongitudeReview(null);
    // A stale "Loaded <old rocket>…" banner over a fresh design
    // reads like the import happened again - clear both notes.
    setFileNote(null);
    setSimError(null);
    setMotorLoadoutRepair(null);
    setShroudPrompt(null);
    // And where a restored pad mass went: it names the motors and mounts of the
    // design being cleared (seam review of audit 2026-09-22).
    setPadMassNote(null);
    // A measured mass & CG describe the rocket that was WEIGHED, which is the
    // one being cleared — as an import and a Scale already treat them. Kept,
    // the pad-mass arithmetic (services/hardwareMass.ts) took the old rocket's
    // weight as the new one's dry mass: weigh A at 2.0 kg, press New, build a
    // 1.2 kg B and type a 3.0 kg pad mass, and the hardware term came out
    // 0.8 kg short, so B flew light and high (audit 2026-09-22).
    const unweighed: MeasuredFigures = { massKg: null, cgM: null };
    setMeasured(unweighed);
    // The launch conditions stay, but for the Earth model: the new design flies
    // Spherical Earth, as desktop's every new simulation does (planNewDesign).
    // The same object when there was none to drop.
    setLaunch(fresh.launch);
    // An empty design is not work anybody would mind losing, so the NEXT Open
    // must not ask about it. Same reasoning as seeding a first visit clean.
    // The mark is the plan's, taken over exactly the values just set, not from
    // state, which has not re-rendered.
    // eslint-disable-next-line no-restricted-syntax -- ✕ New: an empty design is not work to lose
    markSaved(mark);
  };

  // ---- undo / redo (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y / buttons) ----
  //
  // The stacks, the 800 ms coalescing, the cap of 50 and the key binding live in
  // hooks/useTreeHistory.ts (called with the tree state, above), tested there.
  // What stays here is what only App knows: what a restored tree needs, and when
  // stepping through history would pull the engine out from under a flight.
  /**
   * A tree coming BACK off the undo/redo stack, with any stated-launch-weight
   * mark a currently-mounted motor has already spent taken off it again.
   *
   * Why undo needs this at all (2026-09-08, from review). Motors live in
   * `mountMotors`, not in the tree, and this stack restores the tree ALONE. So
   * loading the M787 on an imported MESOS — which corrects the sustainer from
   * 23.310 lb to 7.940 lb and drops the mark — pushed the marked, uncorrected
   * tree onto the stack, and one Ctrl+Z put the mark and the motor-inclusive
   * override back UNDER a motor that was still mounted: 6.97 kg heavy again,
   * silently, and no longer correctable because the mark had returned.
   *
   * Re-running the reconcile on the restored tree is the fix that holds for
   * every stack entry rather than for the one the assignment happened to push:
   * a marked stage under a mounted motor is a wrong number whichever way the
   * user arrived at it. Identity for every design that carries no mark.
   *
   * IT SAYS SO NOW (2026-09-08, from review). v0.120 threw the notes away on
   * the reasoning that a paragraph about stated launch weights is not what
   * Ctrl+Z asked for. What Ctrl+Z asked for even less is a stage mass that
   * moves by tens of pounds with nothing on screen: on MESOS a Ctrl+Z with a
   * motor mounted moves the sustainer by 6.97 kg either way — corrected, or
   * cleared because the motor mounted now is not the one the file named. The
   * notice bar is the one place the app says what it did to a number, and this
   * is a number it changed.
   *
   * Held in a ref because `undo`/`redo` are stable callbacks (the history
   * hook's) and must not close over a render's `mountMotors`.
   */
  const spendSpentMarks = useRef<(t: RocketTree) => RocketTree>((t) => t);
  spendSpentMarks.current = (t) => {
    const motors = restoringMotors.current ?? mountMotors;
    restoringMotors.current = null;
    const spent = reconcileAllIncludedMotors(t, attachedSet(motors), statedWeightText);
    // Each line with the tier its producer flagged (D7 I17), as the open and the
    // open-motor answer show it — not a plain Information strip (review of b9-int).
    if (spent.notes.length) {
      setGroupNote(spent.notes.join('\n'), spent.severity, undefined, { lines: tierLines(spent.notes, noteFlags(spent.notes)) });
    }
    return spent.tree;
  };
  /**
   * Is a flight holding THIS build's engine handle across an await? Launch and
   * "Show charts" await a paint before their synchronous flight, and the flight
   * data export does too; an undo in that frame rebuilds the engine, and since
   * the 2026-09-22 audit a handle held across a rebuild throws `stale engine
   * handle` (it used to fly whatever rocket was built next under its number).
   * So the history refuses to step while one is pending. Launch and re-fly show
   * it in state already — mirrored here, because `undo` is stable and must not
   * close over a render — and the export, which has no state of its own in App,
   * counts itself in and out.
   */
  const flightHoldsHandle = useRef(false);
  flightHoldsHandle.current = simulating || reflying !== null;
  const fullSeriesHolds = useRef(0);

  // ---- engine build + static analysis on every tree change ----
  // KEYED ON `tree.components`, NOT `tree`. The Rocket name input does
  // `setTree({ ...tree, name })` on every keystroke: the spread keeps the SAME
  // components array, so nothing physical moved — but tree's identity did, and
  // on tree identity this chain re-ran `resetEngine()`, `OrkRocket.buildTree`,
  // `staticInfo()` and a fresh one-point `dragSweep` for every character typed.
  // Measured against the shipped artifact on a THREE-component rocket:
  // 11.35 ms for resetEngine + buildTree + staticInfo, plus 0.91 ms for the
  // dragSweep `designCd` then performs — ~12 ms of synchronous main-thread work
  // per keystroke, and CLAUDE.md records the TeaVM kernel at 11–16x the JVM,
  // so a real 40-component design is materially worse.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
  const mounts = useMemo(() => motorMounts(tree), [tree.components]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
  const stageList = useMemo(() => stages(tree), [tree.components]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
  const nozzleEditableIds = useMemo(() => nozzleEditableStageIds(tree), [tree.components]);
  // A nozzle field being typed in stays listed (CFG-3 review, finding 4). A
  // stage with no motor mount is listed only while it carries a value, so it
  // can be cleared — and the field commits a blank draft as "no value" at
  // once, so backspacing the last digit removed the field from under the
  // cursor and dropped focus on the page. A stage stays here while focus is
  // inside its field, and the list is let go when the workspace changes.
  const [nozzleHeld, setNozzleHeld] = useState<ReadonlySet<string>>(() => new Set());
  const holdNozzle = (id: string, held: boolean) => setNozzleHeld((prev) => {
    if (prev.has(id) === held) return prev;
    const next = new Set(prev);
    if (held) next.add(id);
    else next.delete(id);
    return next;
  });
  // "Staged" for the batch-sim gate: a serial stage OR a separating parallel
  // booster — both make the flight multi-branch (batch across them explodes
  // combinatorially, per the owner's rule). A non-separating pod alone is fine.
  // Memoized (2026-09-08 audit). `hasParallelStage` is a full recursive scan,
  // and on a SINGLE-stage design the `||` never short-circuits — so this walked
  // the whole tree on every App render, including the ones that have nothing to
  // do with the tree (sim progress, a notice dismissal, the 7 s session-note
  // fade). It sat between two memos that exist for exactly this reason.
  const isStaged = useMemo(
    () => stageList.length > 1 || hasParallelStage(tree),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
    [stageList.length, tree.components]);
  // Assigned motors on mounts that still exist in the tree.
  const activeLayer = savedConfigs.find(c => c.id === activeConfigId);
  const activeOverrides = useMemo(() => activeFlightOverrides(savedConfigs, activeConfigId, detachedOverrides),
    // Names and other configuration metadata must not rebuild flight inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only these three map identities affect resolution
    [activeLayer?.deployments, activeLayer?.separations, activeLayer?.ignitions, detachedOverrides]);
  // The saved configurations as they will fly NOW: the active row's motors
  // follow the working set, which a motor pick changes without writing back
  // until a switch, None or a save. An unnamed configuration is labelled by its
  // motors, so every label the user reads — the chooser, the Launch warning,
  // the scope wording, a run's record and Batch's — comes from this list, or a
  // run flown on a D12-5 was filed under “[C6-5]” (review of b9-int, finding 1).
  const liveConfigs = useMemo(() => withActiveConfigSynced(savedConfigs, activeConfigId, mountMotors, unmatchedRefs),
    [savedConfigs, activeConfigId, mountMotors, unmatchedRefs]);
  const liveActiveLayer = liveConfigs.find(c => c.id === activeConfigId);
  const overrideConfigLabel = liveActiveLayer ? savedConfigLabel(liveActiveLayer) : null;
  // The detached working settings own an override layer whenever no
  // configuration is active and saved ones exist, or they hold an override:
  // ONE owner rule for the scope choices, beginFlightEdit and editIgnition, so
  // an override edited back to the own setting cannot flip the user's chosen
  // scope into an own-setting edit (review of CFG-2).
  const detachedOwnsOverrides = workingSettingsOwnOverrides(savedConfigs, activeConfigId, detachedOverrides);
  // The vitals strip names the working settings only while they carry something.
  const detachedHoldsOverrides = holdsOverrides(detachedOverrides);
  const overrideScopeLabel = overrideScopeText(overrideConfigLabel, detachedOwnsOverrides);
  const flightOwnerKey = activeLayer?.id ?? 'working';
  const launchOverrideSummary = useMemo(() => describeFlightOverrides(
    tree, activeOverrides, mountMotors, overrideConfigLabel, prefs.units.distance,
  ), [tree, activeOverrides, mountMotors, overrideConfigLabel, prefs.units.distance]);
  // `edit`: the Launch warning's Show lands on the row's Edit… button (CFG-SPEC A2);
  // the All configurations table lands on the row itself.
  // `nozzle`: Design's read-only Nozzle exit line lands on that stage's field (CFG-SPEC A4).
  const [configPartTarget, setConfigPartTarget] = useState<{ id: string; family: string; focus?: 'edit' } | null>(null);
  useEffect(() => {
    if (tab !== 'motors' || !configPartTarget) return;
    const kind = configPartTarget.family === 'ignition' ? 'mount' : configPartTarget.family === 'nozzle' ? 'nozzle' : 'part';
    const target = document.getElementById(`cfg-${kind}-${configPartTarget.id}`);
    target?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    const focus = configPartTarget.focus === 'edit'
      ? target?.querySelector<HTMLButtonElement>('.config-part-actions button') ?? target : target;
    focus?.focus({ preventScroll: true });
    setConfigPartTarget(null);
  }, [tab, configPartTarget]);
  useEffect(() => {
    if (tab !== 'motors') setNozzleHeld((prev) => (prev.size ? new Set() : prev));
  }, [tab]);
  const [flyMountTarget, setFlyMountTarget] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== 'motors' || flyMountTarget === null) return;
    const card = document.getElementById(`cfg-mount-${flyMountTarget}`);
    card?.scrollIntoView({ block: 'center',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    // The control that CHANGES the motor (RES-1c), never "the first control in
    // the card": with a motor loaded that was the card's Remove button, one
    // keypress from unloading the motor with no confirmation.
    document.getElementById(`cfg-mount-${flyMountTarget}-motor`)?.focus({ preventScroll: true });
    setFlyMountTarget(null);
  }, [tab, flyMountTarget]);
  const [ignitionTarget, setIgnitionTarget] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== 'motors' || ignitionTarget === null) return;
    const control = document.getElementById(`ignition-${ignitionTarget}`);
    control?.closest('.mount-card')?.scrollIntoView({ block: 'center',
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    control?.focus({ preventScroll: true });
    setIgnitionTarget(null);
  }, [tab, ignitionTarget]);
  // A motor card's "set on Design ▸" lands on that mount's Max motor length
  // field in the Design property panel (CFG-SPEC A4).
  const [designLengthTarget, setDesignLengthTarget] = useState<string | null>(null);
  // Design's Drag analysis section: collapsed by default, session-only (CFG-SPEC B2).
  const [dragOpen, setDragOpen] = useState(false);
  useEffect(() => {
    if (tab !== 'design' || designLengthTarget === null) return;
    const field = document.getElementById(`design-motor-length-${designLengthTarget}`);
    field?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    field?.focus({ preventScroll: true });
    setDesignLengthTarget(null);
  }, [tab, designLengthTarget, selectedId]);
  const showMotorLengthOnDesign = (mountId: string) => {
    setSelectedId(mountId);
    setDesignLengthTarget(mountId);
    setTab('design');
  };
  /** Design's read-only flight settings: their one editor is a row or field on Motors & Configuration. */
  const showOnConfigTab = (id: string, family: 'recovery' | 'separation' | 'nozzle') => {
    setConfigPartTarget(family === 'nozzle' ? { id, family } : { id, family, focus: 'edit' });
    setTab('motors');
  };
  const showFlightOverride = (target: FlightOverrideSummary['first']) => {
    setShowBatch(false);
    if (target.family === 'ignition') {
      setIgnitionTarget(target.id);
      setTab('motors');
    }
    else {
      // Recovery and separation are edited on Motors & Configuration (CFG-SPEC A2).
      setConfigPartTarget({ id: target.id, family: target.family, focus: 'edit' });
      setTab('motors');
    }
  };
  const flightState = useMemo(() => resolveFlightState(tree, [], null, activeOverrides, mountMotors),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a rocket rename does not alter kernel inputs
    [tree.components, (tree as FlightTree).ignitionDefaults, activeOverrides, mountMotors]);
  const flightTree = useMemo(() => ({ ...tree, components: flightState.tree.components }), [tree, flightState.tree.components]);
  const assigned = useMemo(() => assignedMotorsOf(flightState.mountMotors, mounts), [flightState.mountMotors, mounts]);

  // THE NOZZLE EXIT DIAMETER FOLLOWS THE MOTOR (Eric, 2026-09-13) — the rule,
  // and why it is decided here rather than in NozzleField, are in
  // hooks/useNozzleFollow.ts. It acts on a change of this loadout only.
  const stageMotorLoadout = useMemo(() => stageMotors(flightTree, assigned), [flightTree, assigned]);
  const {
    cleared: nozzleCleared, pending: nozzlePending, seed: seedNozzleFollow, restoring: restoreNozzleFollow,
  } = useNozzleFollow({ loadout: stageMotorLoadout, treeRef, writeTree });
  // The PRIMARY mount drives the report's lead columns, auto-delay and the
  // weighed pad mass: the topmost-stage mount with a motor (the sustainer's).
  // ONE definition of "the primary" — treeModel.primaryMountOf — shared with
  // the export gate, the .ork attach-on-open and the session migration.
  const primaryMountId = useMemo(() => launchPrimaryOf(tree, assigned), [assigned, tree]);
  /**
   * The primary as the FILE sees it: the topmost-stage mount among the
   * assigned motors AND the unmatched references. When the file's sustainer
   * motor could not be matched this differs from `primaryMountId` (the
   * booster's), and it gates the pad-mass field and the export gate — a value
   * typed under the booster would never reach the file (the gate keeps the
   * primary's), so the field is withheld and the card explains instead.
   */
  const filePrimaryMountId = useMemo(
    () => filePrimaryOf(tree, assigned, unmatchedRefs), [assigned, unmatchedRefs, tree]);
  /**
   * The identity of the motor set on the rocket RIGHT NOW — what a weighed pad
   * mass is keyed to when it is committed, and what a stored key is compared
   * against on every build (hardwareMass 'stale-set'). Built from `assigned`,
   * not the kernel-accepted subset: a refusal is a transient of the curve, not
   * of the rocket that was weighed. The tree's cluster counts are part of it,
   * which is why `tree.components` is a dependency.
   */
  const currentSetKey = useMemo(
    // THE key rule (configSync.padMassSetKey), the one an imported pad mass is
    // keyed by too. It counts the KERNEL's motors for each mount, not just its
    // cluster: an enclosing pod set or parallel stage multiplies it, so an
    // instance-count edit after weighing invalidates the weighing the same way a
    // cluster edit does (2026-09-21).
    () => currentSetKeyOf(tree, assigned),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components, not tree: a rename is not a set change
    [assigned, tree.components]);

  // Three-way aero model (feature #1): classic / supersonic / auto. Auto uses
  // classic until a flight crosses Mach 0.9, then the whole design (display,
  // drag panel, subsequent flights) runs on the supersonic model.
  //
  // Normalized ONCE, in PrefsContext, so the build memo, the flight-reset
  // effect, the run label and both model controls all agree. The Preferences
  // pulldown maps BOTH classic options to aeroModel: 'classic' and tells them
  // apart purely by rogersKbf, so aeroMode alone cannot see a switch between
  // Extended Barrowman and Rogers Kbf. Normalizing rather than depending on
  // prefs.rogersKbf raw (boolean | undefined) also avoids a spurious reset
  // when it settles from undefined to true.
  //
  // `aeroOverride` is the vitals strip's session-only switch — null when the
  // stored preference is in force, which is the case that must stay
  // byte-for-byte what it always was.
  const { aeroMode, effectiveKbf } = effectiveAero(prefs, aeroOverride);
  const effectiveSupersonic = effectiveSupersonicOf(aeroMode, autoSupersonic);
  const effectiveHybrid = aeroMode === 'hybrid';
  const flownAtmosphere = useMemo(() => ({
    aeroMode: effectiveSupersonic ? 'supersonic' as const : aeroMode, effectiveKbf,
  }), [aeroMode, effectiveKbf, effectiveSupersonic]);

  // THE BUILD — services/buildDesign.ts, where the two orderings that decide
  // numbers (the ignition re-applied after the weighed-hardware write; the
  // camera-shroud THICK_FIN filter before the wake sentences) are pinned by
  // tests on a recording handle and on the kernel (audit 2026-09-22, row 494).
  // It never throws: the error is part of the memo's value, because setState
  // during render breaks under StrictMode's double-invoke.
  const buildResult = useMemo((): DesignBuild => buildDesign(designBuildInputOf({
    tree: flightTree,
    assigned,
    effectiveKbf,
    effectiveSupersonic,
    hybrid: effectiveHybrid,
    measuredDryMassKg: measured.massKg,
    primaryMountId,
    currentSetKey,
    lengthUnit: prefs.units.length,
  }), {
    ...KERNEL_HANDLES,
    // Auto yields between probes. A render may build a newer design while the
    // captured flight still owns its handle; keep that handle alive until done.
    reset: () => {
      if (!flightHoldsHandle.current && fullSeriesHolds.current === 0) KERNEL_HANDLES.reset();
    },
  }),
    // `tree.components`, not `tree` — see the note on `mounts` above. Renaming
    // the rocket is not a design change: `engineTree` passes `tree.name`
    // through structurally and nothing the app reads comes back OUT of the
    // kernel by rocket name (every consumer uses `tree.name` directly), while
    // every physical input here — geometry, component names for the THICK_FIN
    // filter, rail and wake checks — lives inside `tree.components`.
    //
    // `measured.massKg` — the one SCALAR the hardware arithmetic reads from
    // the box, not `measured` — so typing in the CG field does not rebuild
    // the rocket. The pad mass itself is on the primary's record, reached
    // through `assigned`; `currentSetKey` is the set it is checked against.
    // `primaryMountId` derives from `assigned` and `tree`, so it only ever
    // changes when they do.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
  [flightTree.components, assigned, effectiveKbf, effectiveSupersonic, effectiveHybrid, measured.massKg, primaryMountId, currentSetKey,
    prefs.units.length]);
  const built = 'error' in buildResult ? null : buildResult;
  const auditCanReadMass = built !== null;
  const auditMasses = useMemo(() => auditCanReadMass ? readAuditMasses(flightTree) : {},
    // The diagnostic reads only components; motor picks and rocket renames do
    // not change computed own-part mass (N028). Keep numeric evidence, not a handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- components deliberately: no rocket-name dependency
    [flightTree.components, auditCanReadMass]);
  const designAudit = useMemo(() => preflightAudit(flightTree, auditMasses, built?.info.warningTexts),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- components deliberately: no rocket-name dependency
    [flightTree.components, auditMasses, built]);
  const stabilityRangeInput = useMemo(() => ({
    tree,
    configs: syncActiveConfig(savedConfigs, activeConfigId, { tree, motors: mountMotors, unmatchedRefs }),
    ...(activeConfigId === null ? { workingMotors: mountMotors, workingUnmatchedRefs: unmatchedRefs } : {}),
    kbf: effectiveKbf, supersonic: effectiveSupersonic, hybrid: effectiveHybrid,
    measuredDryMassKg: measured.massKg,
  }), [tree, savedConfigs, activeConfigId, mountMotors, unmatchedRefs, effectiveKbf, effectiveSupersonic,
    effectiveHybrid, measured.massKg]);

  const buildError = 'error' in buildResult ? buildResult.error : simError;
  // A fresh array every render whenever the build failed, which invalidated the
  // `notices` memo below on every render (eslint reports it by name). Stable
  // now, so a failed build stops re-rendering the notice stack forever.
  const motorFailures = useMemo(() => built?.motorFailures ?? [], [built]);
  /**
   * The mounts the build refused. Launch leaves them off the handle and stores
   * the delay vector of the mounts it flew, so every re-fly — and the check
   * that offers one — leaves out the same ones (flightRunner.installedMounts),
   * or the stored vector can never match (audit 2026-09-30).
   */
  const refusedMountIds = useMemo(() => refusedMountIdsOf(motorFailures), [motorFailures]);
  /**
   * The same mounts in a stored delay vector's terms: what the Auto-delay card
   * checks a run's vector against. It was checked against every ASSIGNED mount,
   * so on a design with a refused motor the card called the flight just flown
   * a "Previous flight", and no Launch could change that (verifier, audit
   * 2026-09-30).
   */
  const flownDelayMounts = useMemo(
    () => delayMountsOf(installedMounts(assigned, refusedMountIds)), [assigned, refusedMountIds]);
  /**
   * The hardware this build carries (kg), 0 when none: a provenance term
   * (simReport's motorSetKeyOf) so a pad-mass edit marks the shown flight stale.
   */
  const hardwareDeltaKg = hardwareDeltaKgOf(built);

  /**
   * RECOVERY WEIGHT — the mass that comes down under the chute, which is
   * neither of the two masses the vitals strip used to show. Dry structure
   * plus the SPENT casing: the propellant is gone by apogee. The owner's
   * Wildman only reproduced its measured drogue rate at the sim's own landing
   * mass of 8.786 kg, not the 11.7 kg pad weight, so this is a 33 % error in
   * the one number a canopy is chosen on. See services/recoveryMass.ts.
   *
   * Motors the kernel REFUSED are excluded: their mass is not in `info.mass`,
   * so subtracting their propellant would report a rocket lighter than its own
   * dry structure. Excluding them makes the tile read "load a motor" when the
   * only motor failed, which is the truth.
   */
  // `tree.components`, not `tree` — the same narrowing the four memos above
  // (mounts, stageList, buildResult, physicsKey) already make, and for the same
  // reason: the Rocket name input does `setTree({ ...tree, name })` on EVERY
  // keystroke, so a whole-tree dep re-runs this on every character typed into a
  // field that cannot change its answer. Verified before narrowing: nothing in
  // this computation, or in the functions it calls, reads `tree.name`.
  //
  // Deliberately NOT applied to `pinBlockerToMeasured` below, which is a
  // useCallback that WRITES: narrowing its dep would let it close over a stale
  // tree and setTree an older one back, silently discarding a rename.
  const recoveryInput = useMemo(() => {
    if (!built) return null;
    const failed = new Set(built.motorFailures.map((f) => f.mountId));
    return {
      tree: flightTree,
      info: built.info,
      // The FLOWN specs, hardware included (services/hardwareMass.ts). The
      // single-object path already sees the hardware through `info.mass`, but
      // the multi-stage sustainer path reads `motorBurnoutMass(spec)` from the
      // spec itself (recoveryMass.ts burnoutIn) — handed the catalogue spec it
      // would drop the adapter from the sustainer's recovery weight.
      motors: assigned
        .filter(([id]) => !failed.has(id))
        .map(([id, mm]) => [id, { ...mm, spec: flownSpec(id, mm.spec, built.hardware) }] as const),
      sectionMass: (id: string) => {
        try {
          const v = built.rocket.componentInfo(id).sectionMass;
          return Number.isFinite(v) ? v : null;
        } catch { return null; }
      },
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
  }, [built, flightTree.components, assigned]);

  /**
   * What the app thinks the rocket weighs on the pad with NO hardware
   * correction — the pad field's placeholder (kg): `massEmpty` plus every
   * accepted motor's CATALOGUE mass, cluster-aware; null when a motor carries
   * no mass curve. Not `info.mass`: once a pad mass is typed that already
   * carries the hardware, and the placeholder must show the uncorrected figure
   * (NumField steps from it when the field is blank).
   */
  const computedPadMassKg = useMemo((): number | null => {
    if (!built) return null;
    const failed = new Set(built.motorFailures.map((f) => f.mountId));
    const c = catalogueMotorMass(tree, assigned.filter(([id]) => !failed.has(id)));
    return c === null ? null : built.info.massEmpty + c;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
  }, [built, tree.components, assigned]);

  /**
   * The weighed motor, for Batch simulate: the candidate matching it on its
   * mount flies with the hardware, every other candidate at catalogue weight.
   * Absent for stale-set, a refusal, and a 'legacy' value the reconcile effect
   * has not yet decided — none of those is a number a sweep should carry.
   */
  const batchWeighed = useMemo(() => {
    if (!built || built.hardware.state !== 'ok') return undefined;
    const h = built.hardware;
    const mm = mountMotors[h.appliedTo];
    if (!mm || mm.padMassWeighedWith === LEGACY_PAD_MASS_KEY) return undefined;
    return {
      mountId: h.appliedTo,
      identity: motorIdentity(mm.meta, mm.spec.designation),
      pinned: !!mm.meta.exMotorId,
      name: baseLabel(mm.label),
      perMotorShiftKg: h.perMotorShiftKg,
      deltaKg: h.deltaKg,
    };
  }, [built, mountMotors]);

  const batchRetainedHardware = useMemo(() => built?.hardware.state === 'ok'
    ? { mountId: built.hardware.appliedTo, deltaKg: built.hardware.deltaKg }
    : undefined, [built]);

  /**
   * ONE component's own mass (kg), for the recovery-sizing panel's substitution:
   * swapping the chute in the design for a catalogue canopy changes the very
   * weight being sized against, so the panel needs to know what the chute
   * already in there weighs. Null when the kernel cannot answer, which turns
   * the substitution off rather than guessing — see recoverySizing.ts.
   */
  const componentMass = useCallback((node: ComponentNode): number | null => {
    if (!built || !node.id) return null;
    try {
      const v = built.rocket.componentInfo(node.id).mass;
      return Number.isFinite(v) ? v : null;
    } catch { return null; }
  }, [built]);

  // Cosmetic edits (rocket/component names, display colors) must NOT wipe the
  // current flight result — reset on a physics-relevant projection of the
  // tree, not on tree identity (renaming used to clear Results per keystroke).
  // `tree.components` for the same reason as `mounts`/`buildResult` above: a
  // rename gives `tree` a fresh identity and this whole recursive strip +
  // JSON.stringify re-ran per keystroke to produce the identical string.
  const physicsKey = useMemo(() => physicsKeyOf(flightTree.components), [flightTree.components]);
  // Catalogue relabeling changes only display text. Keep every other motor
  // field (including Auto, ignition and weighing) in the flight-reset key.
  const motorFlightKey = useMemo(() => stableJson(Object.fromEntries(
    Object.entries(flightState.mountMotors).map(([id, mm]) => [id, {
      ...mm, label: undefined, meta: { ...mm.meta, label: undefined },
    }]),
  )), [flightState.mountMotors]);

  useEffect(() => {
    setResult(null);
    setLastRun(null);
    setInspectedSummary(null);
    // Cached re-flights die with the design they were computed for — this
    // effect is the one place that owns that invariant, so a stale flight can
    // never outlive its geometry.
    reflightCache.clear();
    setAutoSupersonic(false); // re-evaluate the auto threshold on the next flight
    // A simulation error describes the flight that threw it, so it dies with
    // the design too. Without this it was cleared ONLY by the next SUCCESSFUL
    // run: the user fixed the thing the message complained about and the red
    // notice stayed up, which reads as though the fix did not take.
    setSimError(null);
    // aeroMode/effectiveKbf are DELIBERATELY NOT deps. They used to be, so
    // that a model switch could not leave the strip showing a stability and an
    // apogee computed under two different models — but throwing the flight
    // away made comparing the two models impossible, which is the whole point
    // of being able to switch them. The flight is now KEPT and MARKED: the
    // Results tab says which model it was flown on when that is no longer the
    // current one, and the strip's Apogee cell carries the same mark. Silent
    // re-labelling is the thing to avoid, not the stale number itself.
    //
    // reflightCache IS listed, and never re-runs this: it is a ref's
    // `.current`, one Map for the life of the app. It is named so the rule can
    // see the whole closure — the lint ceiling is 0, so a genuinely missing
    // dep added here later cannot hide behind this one.
  }, [physicsKey, motorFlightKey, launch, reflightCache]);
  /**
   * The design on screen, in the three terms the effect above resets on and a
   * fourth — what onLaunch compares the design it flew against before anything
   * it computed lands (audit 2026-09-30). A Launch awaits a paint and, on auto
   * delay, yields between up to eight probes, and the whole UI stays live
   * meanwhile: Open…, a share link, ✕ New, ⏏ Unload, every field on Design and
   * Motors & Configuration. Each of those moves one of these terms; the effect clears
   * the shown flight, the Auto aero upgrade and the error for the design now on
   * screen, and a write landing after it put them back on a design that never
   * flew.
   *
   * The fourth is `hardwareDeltaKg`, the weighed hardware the kernel flies. A
   * Measured mass typed on a design with a weighed pad mass moves it (the typed
   * dry mass wins over the computed one, services/hardwareMass.ts) and none of
   * the three: the tree, the motor records and the conditions stay put. The
   * effect keeps a flight already shown over that edit and marks it ("the
   * weighed pad mass changed since"), as it does a model switch, so it is not
   * one of its keys — but a Launch held through the edit landed its report,
   * "M+", "Flight complete" and the flown-since-save mark on hardware it never
   * flew (the v0.145 release-note claim check).
   *
   * Mirrored on every render, not counted by the effect: a click handler reads
   * it, and must not depend on when an effect last ran.
   */
  const designNow = useRef({ physicsKey, motorFlightKey, launch, hardwareDeltaKg });
  designNow.current = { physicsKey, motorFlightKey, launch, hardwareDeltaKg };

  // The measured cost survives LAUNCH edits by design (see lastSimCost above)
  // but must die with the rocket it timed: flying Mach2.trf.ork (~12 s) and
  // then opening a small sport model quoted "roughly 64 s per flight" for a
  // two-second flight. Motors are part of the identity — the thing being
  // costed is this design under this motor's burn. NOT folded into the reset
  // effect above: that one keys on `launch` too, and a launch-condition dep
  // here would wipe the number the moment the time-step field is edited —
  // the exact self-defeat the lastSimCost split exists to prevent.
  useEffect(() => {
    setLastSimCost(null);
  }, [physicsKey, motorFlightKey]);

  /**
   * Power-off total Cd at a fixed subsonic Mach, for the Design tab's stats.
   *
   * There was no drag coefficient anywhere on the Design tab, so a user could
   * set a Cd override — the headline feature of v0.060 — and watch nothing at
   * all change on screen (the owner, 2026-08-23). This is the number that
   * responds to it. It is a one-point dragSweep, memoised on the build, so it
   * costs one kernel call per design change rather than one per render.
   */
  const designCd = useMemo(() => {
    if (!built) return null;
    try {
      return built.rocket.dragSweep({
        machMin: CD_REFERENCE_MACH, machMax: CD_REFERENCE_MACH, machStep: 1,
      }).powerOff.total[0] ?? null;
    } catch {
      // Drag is a nicety; never let it take the stats panel down with it.
      return null;
    }
  }, [built]);

  // ---- Measured mass & CG -> "Build allowance" ballast (v0.061) ----

  /**
   * The existing allowance, if this design already carries one.
   *
   * This memo and the four below it that read the tree — `solePinned` (the
   * check behind `canPinBlocker`), `notices`, `provenanceKey` and `mountSizes`
   * — key on `tree.components`, like `mounts` and `buildResult` above, and for
   * their reason: the Rocket name input does `setTree({ ...tree, name })` on
   * every keystroke, and none of them reads `tree.name` (checked through every
   * function they call). The 8 September audit named nine such memos and
   * f5a4993 narrowed four; these are the other five (audit 2026-09-22, row
   * 513). App.render.test.tsx holds each to it by counting calls to a function
   * that memo alone makes — exhaustive-deps cannot, because it accepts the
   * whole `tree` wherever `tree.components` is read. A callback that WRITES the
   * tree is still never narrowed — see `pinBlockerToMeasured`.
   */
  const allowanceNode = useMemo(
    () => findAllowance(tree),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
    [tree.components]);

  /**
   * Computed dry mass and CG with any existing allowance BACKED OUT, so a
   * re-edit solves against the bare airframe. Without this, typing the same
   * measured numbers a second time would stack a second correction onto the
   * first.
   */
  const bare = useMemo(() => {
    if (!built) return null;
    const massKg = built.info.massEmpty;
    const cgM = built.info.cgEmpty;
    if (!allowanceNode?.id) return { massKg, cgM };
    // An allowance sitting under a mass-overridden stage contributes NOTHING
    // to massEmpty — the kernel zeroes the covered children's weight — so
    // backing it out again would report a "Computed mass" light by exactly the
    // allowance. componentInfo returns the component's own getMass(), which
    // knows nothing about its ancestors' overrides.
    if (suppressingAncestor(tree, allowanceNode.id, 'overrideSubcomponentsMass', 'overrideMass')) {
      return { massKg, cgM };
    }
    try {
      const ci = built.rocket.componentInfo(allowanceNode.id);
      return withoutAllowance(massKg, cgM, ci.mass, ci.positionX + ci.cgX);
    } catch {
      return { massKg, cgM };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
  }, [built, allowanceNode, tree.components]);

  /**
   * Inserts or moves the ballast. Re-editing UPDATES the existing component
   * rather than adding a second one (the owner asked for exactly this: swap a
   * camera or a battery, re-weigh, and correct the same part). Routed through
   * setTree, so it is a single undoable edit like any other.
   */
  const applyAllowance = (sol: Extract<BallastSolution, { kind: 'ok' }>) => {
    const lengthM = allowanceNode ? num(allowanceNode, 'length', 0.02) : 0.02;
    const place = placeAtStation(tree, sol.stationM, lengthM);
    if (!place) return;

    if (allowanceNode?.id) {
      const parent = findParent(tree, allowanceNode.id);
      const parentId = parent && parent !== 'stage' ? parent.id : null;
      if (parentId === place.parentId) {
        setTree(updateNode(tree, allowanceNode.id, {
          mass: sol.massKg,
          position: { method: 'top', offset: place.offset },
        }));
      } else {
        // The new station is in a different body section: there is no
        // move-between-parents helper, so re-home it in one edit.
        const moved = {
          ...allowanceNode,
          mass: sol.massKg,
          position: { method: 'top', offset: place.offset },
        } as ComponentNode;
        setTree(addChild(removeNode(tree, allowanceNode.id), place.parentId, moved));
      }
      setSelectedId(allowanceNode.id);
      return;
    }

    const node = {
      ...makeNode('masscomponent'),
      name: BUILD_ALLOWANCE_NAME,
      mass: sol.massKg,
      length: lengthM,
      position: { method: 'top', offset: place.offset },
    } as ComponentNode;
    setTree(addChild(tree, place.parentId, node));
    if (node.id) setSelectedId(node.id);
  };

  /**
   * The component whose mass override would swallow a Build allowance solved
   * from the measured numbers. v0.073 shipped this as a SILENT no-op: type
   * your scale reading, press Apply, a component appears in the tree, and no
   * number moves. RASAero .CDX1 imports pin every stage this way, so it is
   * reachable by anyone who imports one and then weighs the build.
   */
  const allowanceBlocker = useMemo(() => {
    if (!built || !bare) return null;
    const sol = measured.massKg !== null && measured.cgM !== null
      ? solveBallast({
        computedMassKg: bare.massKg, computedCgM: bare.cgM,
        measuredMassKg: measured.massKg, measuredCgM: measured.cgM,
        rocketLengthM: built.info.length,
      })
      : null;
    if (sol?.kind !== 'ok') return null;
    // Same default length applyAllowance uses for a not-yet-created allowance,
    // read the same way (a non-finite length is none, audit row 522).
    const lengthM = allowanceNode ? num(allowanceNode, 'length', 0.02) : 0.02;
    return coveringMassOverride(tree, sol.stationM, lengthM);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
  }, [built, bare, measured, tree.components, allowanceNode]);

  /**
   * Pinning is only unambiguous when ONE component's override covers the whole
   * rocket — the measured figures are whole-airframe, the overrides are
   * per-stage, and there is no rule for which stage absorbs the difference.
   * With more than one pinned stage the box states the problem and stops,
   * which is the same refusal the RASAero importer itself makes rather than
   * guessing. The rule is services/buildAllowance.ts's `solePinnedStage`; it
   * reads the stages alone, so it is memoized on them — not on whether this
   * render has a blocker — which is what lets App.render.test.tsx count its
   * calls through a rename.
   */
  const solePinned = useMemo(() => solePinnedStage(tree.components), [tree.components]);
  const canPinBlocker = allowanceBlocker != null && solePinned === allowanceBlocker;

  /**
   * Replace the covering override with what the user actually weighed —
   * desktop OpenRocket's own move, and exact when the covered component is the
   * whole rocket. The CG is expressed from that component's own front, which
   * for a single covering stage is the nose tip.
   */
  const pinBlockerToMeasured = useCallback(() => {
    const blocker = allowanceBlocker;
    if (!blocker?.id || measured.massKg === null || measured.cgM === null) return;
    setTree(updateNode(tree, blocker.id, {
      overrideMass: measured.massKg,
      overrideSubcomponentsMass: true,
      overrideCGX: measured.cgM,
      overrideSubcomponentsCG: true,
    } as Partial<ComponentNode>));
    setFileNote(`“${blocker.name ?? 'Stage'}” is now pinned to your measured `
      + `${fmtSi('mass', prefs.units.mass, measured.massKg)} ${prefs.units.mass}`
      + ` and CG ${fmtSi('length', prefs.units.length, measured.cgM, 3)} ${prefs.units.length}. `
      + 'Clear it under Overrides to go back to the computed geometry.');
    setSelectedId(blocker.id);
  }, [allowanceBlocker, measured, tree, prefs.units, setFileNote, setTree, setSelectedId]);

  /**
   * Everything transient the user should see, in one channel with a severity
   * — services/notices.ts, where each branch's copy and its rule for offering
   * a × are tested by what the list says (audit 2026-09-22, row 501). What
   * stays here is what only App holds: the state it reads and the setters its
   * dismissals call.
   */
  const buildFailed = 'error' in buildResult;
  // The legacy check changes on dismissal without changing components; a
  // Rocket name edit preserves both inputs the notice rules read from tree.
  const legacyPositionCheck = 'legacyPositionCheck' in tree ? tree.legacyPositionCheck : undefined;
  const notices = useMemo((): Notice[] => [...designNotices({
    error: buildError,
    buildFailed,
    motorFailures,
    tree,
    assigned,
    restoredByOlderBuild,
    timeStepMigrated,
    timeStepMigratedFrom,
    padMassNote,
    fileNote: fileNoteState,
    runsCapped,
    lengthText: (m) => `${fmtSi('length', prefs.units.length, m)} ${prefs.units.length}`,
  }, {
    simError: () => setSimError(null),
    staleSession: () => setRestoredByOlderBuild(false),
    timeStep: () => setTimeStepMigrated(false),
    padMassNote: () => setPadMassNote(null),
    fileNote: () => setFileNote(null),
    runsCapped: () => setRunsCapped({ evicted: 0, unsaved: 0, undoEvicted: 0 }),
    legacyPositions: () => writeTree(dismissLegacyPositions(treeRef.current)),
  }), ...(motorLoadoutRepair ? [motorLoadoutRepair] : [])],
  // eslint-disable-next-line react-hooks/exhaustive-deps -- components and legacy check deliberately: a rename must not re-run this (row 513)
  [buildError, buildFailed, motorFailures, fileNoteState, setFileNote, motorLoadoutRepair,
    restoredByOlderBuild, timeStepMigrated, timeStepMigratedFrom, padMassNote, runsCapped,
    tree.components, legacyPositionCheck, treeRef, writeTree, assigned, prefs.units.length]);

  /** Assigns a motor to a mount, with the propellant-aware ignition default. */
  const assignMotor = (targetMountId: string, label: string, spec: MotorSpec, meta: MotorMeta) => {
    motorChoices.current.delete(targetMountId);
    // THE LIVE TREE, not this render's (2026-09-08, from review). Both motor
    // pickers call `onSelect` only after an AWAITED thrust-curve fetch, so the
    // `tree` this closure captured can be several renders old by the time the
    // motor arrives — and on a two-stage design two picks can even land in one
    // flush, where the second would rebuild the whole tree from a snapshot
    // taken before the first. See the note on `treeRef`.
    const live = treeRef.current;
    // Pure decisions; keep the live reads and React effect order here (audit 2026-10-11, S2-8).
    const plan = planMotorAssignment({ tree: live, targetMountId, label, spec, meta,
      refs: unmatchedRefsRef.current, savedConfigs, activeConfigId, massText, statedWeightText });
    setMountMotors((prev) => assignMotorRecords(prev, live, targetMountId, plan));
    const { repairedConfig, repairNotice } = plan;
    if (repairedConfig && repairNotice) {
      setFileNoteState(prev => retireLoadoutNote(prev, repairedConfig));
      setMotorLoadoutRepair({ ...repairNotice, onDismiss: () => setMotorLoadoutRepair(null) });
    }
    if (plan.padMassNote !== undefined) setFileNote(plan.padMassNote, 'info', undefined, plan.padMassTier);
    setUnmatchedRefs((prev) => {
      if (!(targetMountId in prev)) return prev;
      const next = { ...prev };
      delete next[targetMountId];
      return next;
    });
    // And the active configuration's STORED copy of that reference, or a
    // reload before the next sync would seed it back (restoreUnmatchedRefs).
    setSavedConfigs((prev) => withoutStoredRef(prev, activeConfigId, targetMountId));
    // LAST, so its note wins: a RASAero stage whose stated launch weight still
    // holds this motor's weight has to give it back now, or the motor is
    // counted twice (+79 % on MESOS — services/statedLaunchWeight.ts). Returns
    // null for every design that carries no such mark, which is all of them
    // bar a RASAero import naming a motor the catalogue does not have. It can
    // only collide with the pad-mass notes above when a file left a weighed
    // pad mass on an unmatched reference AND a stage carries the mark, and the
    // mass being 79 % wrong outranks a note about where a weighing went.
    const fix = plan.reconciliation;
    if (fix) {
      if (fix.note) {
        setTree(fix.tree);
        setFileNote(fix.note, fix.severity, undefined, plan.reconciliationTier);
      } else {
        // A STALE mark and nothing else: both overrides were already cleared by
        // hand, so this only drops the bookkeeping key. `setTree` would push an
        // undo entry the user cannot see and throw away their redo stack for
        // it, so the mirror is advanced without touching the history
        // (2026-09-08, from review).
        writeTree(fix.tree);
      }
    }
  };

  /**
   * The pad-mass field's commit, SI kg or null. Writes BOTH keys or deletes
   * BOTH — never a null value (dirtyState hashes keys). The key is THIS
   * render's assigned set: the value is a weighing of the rocket as it stands.
   * A typed value supersedes any pad mass the file left on an unmatched
   * reference, so that is stripped too, and any on a tied mount's record
   * (padMassReconcile's typedPadMass; a clear is its dropPadMass, the one a
   * dropped legacy value goes through too).
   */
  const setPadMass = (mountId: string, kg: number | null) => {
    setMountMotors(typedPadMass(tree, mountId, kg, currentSetKey));
    setUnmatchedRefs((prev) => stripRefPadMass(prev));
  };

  /**
   * Reconciling a LEGACY pad mass — the effect that makes v0.116's screenshots
   * impossible. A value keyed 'legacy' (a v0.116/v0.117 session, or a
   * bare-form .ork attached in applyImported) reaches the build with no set
   * key, so `built.hardware` is the arithmetic's verdict on it against the
   * motor now loaded, while the field renders BLANK. After that first build it
   * is re-keyed to the current set or dropped, and the notice says which —
   * the four-way decision and its sentences are
   * services/padMassReconcile.ts's reconcileLegacyPadMass, tested there; what
   * stays here is writing the step into state.
   */
  useEffect(() => {
    // The decision's input and its writes are the headless settle's too
    // (designDerivation.legacyPadMassStepOf, padMassReconcile.legacyPadMassWrite,
    // 2026-10-01): written here as functional updaters, so a write in the same
    // flush — the starter motor landing, a pick — is composed with, not lost.
    const step = legacyPadMassStepOf({
      state: { tree, mountMotors, unmatchedRefs },
      derived: { primaryMountId, filePrimaryMountId, currentSetKey },
      hardware: built ? built.hardware : null,
      text: padMassText,
    });
    if (!step) return;
    const write = legacyPadMassWrite(step);
    setMountMotors(write.motors);
    if (write.refs) setUnmatchedRefs(write.refs);
    setPadMassNote(step.note);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- padMassText is a per-render closure over the same state, and the tree is read as of the build it judges
  }, [built, primaryMountId, filePrimaryMountId, unmatchedRefs, mountMotors, currentSetKey]);

  /**
   * A stored set-identity term for display on the pad-mass line:
   * 'AeroTech/I284W' → 'I284W'; 'ex:…' → the EX library entry's designation
   * (or the id when the library no longer has it); 'unmatched:K' → 'K (named
   * by the file, not loaded)'. Lives here because loadExMotors reads the
   * browser's EX library, which the pure component must not.
   */
  const describeIdentity = (identity: string): string => {
    if (identity.startsWith('unmatched:')) {
      return `${identity.slice('unmatched:'.length)} (named by the file, not loaded)`;
    }
    if (identity.startsWith('ex:')) {
      return loadExMotors().find((m) => m.motorId === identity)?.designation ?? identity;
    }
    const slash = identity.indexOf('/');
    return slash === -1 ? identity : identity.slice(slash + 1);
  };

  const onLaunch = () => {
    const refusal = savedConfigs.find(c => c.id === activeConfigId)?.motorLoadoutRefusal;
    if (refusal) { setSimError(refusal); return; }
    if (!built || !primaryMountId || simulating || nozzlePending || flightHoldsHandle.current) return;
    flightHoldsHandle.current = true;
    sessionDebugLog.record('launch-start');
    // The design this flight flies: this render's, the one `built` was built
    // from. Everything it computed lands after an await, and only while that
    // design still stands (`designNow`, audit 2026-09-30) — an Open, a ✕ New,
    // an ⏏ Unload or an edit made meanwhile has had the reset effect clear the
    // screen for the design that replaced it. An edit to this same design
    // counts: the flight does not describe the edited one, and a Save .ork
    // would not write it into the file as the edited one's. The RUN is kept
    // either way (below), stamped with the design it flew. The fourth term,
    // the weighed hardware, is one the effect does not clear on (`designNow`):
    // a Measured mass typed meanwhile leaves the screen as it was, any flight
    // shown there marked stale, and this flight lands nothing on it.
    const flown = { physicsKey, motorFlightKey, launch, hardwareDeltaKg };
    const stillFlown = () => designNow.current.physicsKey === flown.physicsKey
      && designNow.current.motorFlightKey === flown.motorFlightKey && designNow.current.launch === flown.launch
      && designNow.current.hardwareDeltaKg === flown.hardwareDeltaKg;
    setSimulating(true);
    // Flying hands off to the Results workspace — land the user there, focus
    // included: on the Results <main>, before the flight blocks the thread,
    // because the button just pressed is gone or disabled (see resultsMainRef).
    setTab('results');
    void afterPaint().then(async () => {
      resultsMainRef.current?.focus();
      try {
        // THE LAUNCH — services/simulateDesign.ts's flyBuiltDesign (2026-10-01):
        // the flight (flightRunner.flyLaunch: the probe, the Auto upgrade, the
        // auto delay and the handle protocol) and the run built from it, moved
        // out of this closure so a caller with no React flies exactly what this
        // button flies (simulateDesign, simulateFile). App.simulate.test.tsx
        // holds the two to the same bytes; flyBuiltDesign.test.ts pins what it
        // hands the kernel and the report against this body as it stood at
        // 78d3015. The lint gate keeps flyLaunch and buildSimRun out of this
        // file, so the Launch cannot grow a second copy here.
        const { flight: { result: res, execMs }, run } = await flyBuiltDesign({
          units: prefs.units,
          advisoryLimits: prefs.flightAdvisories,
          built,
          tree: flightTree,
          flightOverrides: launchOverrideSummary?.records ?? [],
          derived: { mounts, stageList, assigned, effectiveSupersonic, primaryMountId },
          launch,
          aero: { aeroMode, effectiveKbf },
          activeConfigId,
          savedConfigs,
          // The working set, so an unnamed configuration's label names the motors that fly.
          working: { motors: mountMotors, unmatchedRefs },
          // Stamped from the SAME key every comparison uses (`provenanceKey`,
          // below), so the two cannot be assembled apart.
          provenance: provenanceKey,
          // Rebuilds the engine handle with the flag on after this callback
          // finishes, so the design's displayed statics follow the flight. The
          // runner calls it after its last await: on a design opened meanwhile
          // it put "M+" on the strip and flew every later flight supersonic.
          onSupersonicUpgrade: () => { if (stillFlown()) setAutoSupersonic(true); },
        });
        // Saved simulations keeps the flight whatever is on screen now: it is
        // stamped with the design it flew, and selecting it says what changed
        // since — a Launch press never simply vanishes.
        recordRuns(addRun(run));
        sessionDebugLog.record('launch-complete');
        if (!stillFlown()) return;
        // Bound to the run it produced — the id is what lets a click through
        // the history table come back to these charts.
        setResult({ runId: run.id, value: res });
        setLastRun(run);
        setInspectedSummary(null);
        setLastSimCost({ ms: execMs, ...(launch.timeStepS != null ? { timeStepS: launch.timeStepS } : {}) });
        // A flight is work even though it does not touch the design, and the
        // owner asked for it to count. Hooked HERE, at the one place a run is
        // recorded - NOT inside recordRuns, which is also SimResults' delete-one
        // and clear-all callback, where it would mark a design dirty for
        // REMOVING a flight.
        markFlown();
        setSimError(null);
        setFlightSaid((prev) => ({
          seq: prev.seq + 1,
          text: `Flight complete — apogee ${fmtSi('distance', prefs.units.distance, res.summary.maxAltitude)}`
            + ` ${prefs.units.distance}.`,
        }));
      } catch (e) {
        // The error is the launched design's, and dies with it like the rest.
        sessionDebugLog.record('launch-failed', e);
        if (stillFlown()) setSimError(e instanceof Error ? e.message : String(e));
      } finally {
        setSimulating(false);
      }
    });
  };

  /**
   * The provenance of the design, its motors and the conditions AS THEY STAND:
   * what onLaunch stamps onto every run, and what a stored run is compared
   * against — for the stale marks, for "Show charts" and for the `.ork`
   * `<flightdata>` guard. ONE assembly (simReport's designMatchKeyOf) since the
   * 2026-09-22 audit found it built term by term in four places here.
   *
   * effectiveKbf, not the stored preference: with the vitals strip's session
   * override active the two differ, and the run this is compared against was
   * stamped with the effective value.
   *
   * Deliberately NOT gated on `built && primaryMountId` the way
   * `currentMatchKey` is. That gate is right for the re-fly path — you cannot
   * reproduce a flight without a buildable rocket and a mount — but applying it
   * here made the whole staleness signal vanish in exactly the states where a
   * stored run is most likely to belong to something else: unload the motor, or
   * start a new design, and the report went back to rendering an old flight with
   * nothing to say so. Every term here is computable without a motor.
   */
  // Assembled by designDerivation's provenanceKeyOf (the nozzle and the
  // physics-revision terms with it), which the headless Launch calls too.
  // `tree.components`, not `tree` (row 513, see `allowanceNode`). The memo
  // itself is ~0.3 ms, but a new key per keystroke re-ran everything keyed on
  // it too: `currentMatchKey`, `canShowCharts` and so `chartableRun`'s match
  // against every saved run, and `changedSince`.
  const provenanceKey = useMemo<DesignMatchKey>(() => provenanceKeyOf({
    refusedMountIds,
    physicsKey, tree: flightTree, assigned, hardwareDeltaKg, launch, aero: { aeroMode, effectiveKbf, autoSupersonic },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
  }), [physicsKey, assigned, refusedMountIds, hardwareDeltaKg, launch, aeroMode, effectiveKbf, autoSupersonic, flightTree.components]);
  const recoveryEvents = useMemo(() => matchingRecoveryEvents(runs, provenanceKey,
    (id) => result?.runId === id ? result.value : reflightCache.get(id)),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Show charts fills the ref-backed cache before clearing reflying
  [runs, provenanceKey, result, reflightCache, reflying]);
  const recovery = useMemo((): RecoveryMass => (
    recoveryInput ? recoveryMass({ ...recoveryInput, flightEvents: recoveryEvents, distanceUnit: prefs.units.distance }) : { state: 'no-motor' }
  ), [recoveryInput, recoveryEvents, prefs.units.distance]);
  /**
   * One weight per object that comes down (v0.112 arithmetic; v0.115 panel).
   * Same input, same partition, so the panel's per-stage sections can never
   * disagree with the tile above them about the sustainer.
   */
  const recoveryByStage = useMemo((): RecoveryByStage => (
    recoveryInput ? recoveryMassByStage({ ...recoveryInput, flightEvents: recoveryEvents, distanceUnit: prefs.units.distance }) : { state: 'no-motor' }
  ), [recoveryInput, recoveryEvents, prefs.units.distance]);

  /** The same key, only when there is a rocket and a motor to re-fly it on. */
  const currentMatchKey = useMemo<DesignMatchKey | null>(
    () => (built && primaryMountId ? provenanceKey : null),
    [built, primaryMountId, provenanceKey],
  );

  // What the time-step caution scales from: this session's own measurement
  // when there has been a flight, else the newest STORED run of this design
  // under these motors (storedSimCost, matched on `provenanceKey` — so it sits
  // after it) — stored runs carry execMs and the step it was measured at
  // (SimRun.timeStepS) precisely so the seconds estimate survives a reload
  // instead of degrading to the bare multiplier.
  const simCostRef = useMemo(
    () => lastSimCost ?? storedSimCost(runs, provenanceKey, tree.name ?? 'Rocket'),
    [lastSimCost, runs, provenanceKey, tree.name]);

  /**
   * Whether a stored run's charts can be recovered by re-flying it here.
   *
   * Deliberately NOT gated on a re-fly being in progress: every button that
   * would show its own ⏳ busy label is rendered behind this predicate, so
   * folding "busy" in here would unmount the button the instant it was
   * pressed — and flip the surrounding prose to "this run can no longer be
   * reproduced" for the whole length of the flight reproducing it. The
   * buttons carry `disabled` for that instead.
   */
  const canShowCharts = useCallback((run: SimRun): boolean => {
    if (run.importedSummary) return false;
    if (!currentMatchKey || !built || !primaryMountId) return false;
    if (reflightCache.has(run.id)) return false;
    // The mounts the run FLEW, as reflyRun will see them — a refused motor
    // was never in its delay vector (flightRunner.installedMounts).
    return runMatchesDesign(run, currentMatchKey)
      && canReplayDelays(run.delayResolution, installedMounts(assigned, refusedMountIds), primaryMountId, run.delayS,
        true);
  }, [currentMatchKey, built, primaryMountId, reflightCache, assigned, refusedMountIds]);

  /**
   * The newest stored run this design could still reproduce — what the
   * "nothing to show yet" state offers. A page reload always lands there, and
   * it used to say "this design hasn't flown yet" directly above a table of
   * that same design's flights.
   */
  const chartableRun = useMemo(
    () => runs.find((r) => canShowCharts(r)) ?? null,
    [runs, canShowCharts],
  );

  /**
   * "Show charts" on a stored run: re-fly the design at that run's conditions
   * and cache the series under its id. It deliberately does NOT save a run —
   * six clicks through history must not cost six history rows (nor, thanks to
   * the cache, six flights).
   *
   * The physics is deterministic (fixed seed), so this reproduces the stored
   * flight exactly rather than approximating it — which holds only while the
   * re-fly is handed the delay the run FLEW; services/flightRunner.ts
   * `reflyRun` owns that and the rest of the handle protocol.
   */
  const showChartsFor = useCallback(async (run: SimRun): Promise<void> => {
    // Not while a flight holds this handle. A Launch yields between its
    // auto-delay probes, and a re-fly in one of those yields handed the handle
    // back on the CURRENT model: on an Auto design the probe had upgraded, the
    // rest of the Launch flew Classic under an auto-supersonic stamp (audit
    // 2026-09-30). Every button that calls this waits while one runs; this is
    // the gate behind them.
    if (!built || !primaryMountId || flightHoldsHandle.current || !canShowCharts(run)) return;
    setReflying(run.id);
    setLastRun(run);
    setInspectedSummary(null);
    // Let the busy state paint before the synchronous simulation blocks.
    await afterPaint();
    try {
      // canShowCharts already required the run's model to equal the current
      // one, so the handle is right as it stands. It is set explicitly anyway
      // — in Auto the same effective model can be reached with the session's
      // upgrade flag either way, and a handle rebuilt since the flag flipped
      // would otherwise be silently one model behind.
      const current = { supersonic: effectiveSupersonic, kbf: effectiveKbf, hybrid: effectiveHybrid };
      const res = reflyRun(built.rocket, {
        assigned, hardware: built.hardware, refusedMountIds, primaryMountId,
        delayS: run.delayS, delayResolution: run.delayResolution,
        motorIdentityVerified: true,
        simOptions: kernelSimOptions(launch, { aeroMode: effectiveHybrid ? 'hybrid' : effectiveSupersonic ? 'supersonic' : 'classic', effectiveKbf }),
        fly: current,
        restore: current,
      });
      cacheFlight(run.id, res);
      setSimError(null);
    } catch (e) {
      setSimError(e instanceof Error ? e.message : String(e));
    } finally {
      setReflying(null);
    }
  }, [built, primaryMountId, assigned, refusedMountIds, launch, effectiveSupersonic, effectiveKbf, effectiveHybrid, cacheFlight, canShowCharts]);

  /**
   * Re-flies the LAST launch with `series: 'full'` for the flight-data CSV.
   * simulate() now defaults to the summary series payload (all the report
   * needs); the CSV wants every series the kernel records, and the physics
   * is deterministic — same design/motor/conditions/seed reproduce the shown
   * flight exactly, just with more columns. Reuses the Launch path's engine
   * handle and kernelSimOptions — no second sim-setup.
   */
  const fetchFullSeriesResult = useCallback(async (): Promise<FlightResult> => {
    // Not while a flight holds this handle — see showChartsFor. The download
    // buttons wait while one runs; this is the gate behind them.
    if (flightHoldsHandle.current) throw new Error('a flight is running — download once it has finished.');
    if (!built || !primaryMountId || !lastRun) {
      throw new Error('no flight in memory — press Launch first');
    }
    // Downloads restore the flown aero model, but must still prove every other
    // provenance term (including kernel revisions) before replaying a stored ID.
    const wasSupersonic = lastRun.aeroModel === 'supersonic'
      || lastRun.aeroModel === 'auto-supersonic';
    const wasKbf = lastRun.rogersKbf ?? effectiveKbf;
    if (!runMatchesDesign(lastRun, { ...provenanceKey,
      aeroMode: lastRun.aeroModel === 'hybrid' ? 'hybrid' : wasSupersonic ? 'supersonic' : 'classic', effectiveKbf: wasKbf, autoSupersonic: false })) {
      throw new Error('This flight can no longer be reproduced — press Launch before downloading flight data.');
    }
    // Holds `built.rocket` across the paint below — no undo until it is done
    // (see `fullSeriesHolds`).
    fullSeriesHolds.current += 1;
    try {
      // Let the caller's busy state paint before the synchronous re-simulation.
      await afterPaint();
      // Restore the model the SHOWN flight was flown on, not whatever is
      // selected now. Since a model switch no longer discards the flight, the
      // two can differ — and a CSV that re-flew on today's model would be a
      // different flight from the plots it sits under, under the same name.
      return reflyRun(built.rocket, {
        assigned, hardware: built.hardware, refusedMountIds, primaryMountId,
        // Auto delay flew the rounded optimum, recorded on the run.
        delayS: lastRun.delayS, delayResolution: lastRun.delayResolution,
        motorIdentityVerified: true,
        simOptions: { ...kernelSimOptions(launch, { aeroMode: lastRun.aeroModel ?? 'classic', effectiveKbf: wasKbf }), series: 'full' },
        fly: { supersonic: wasSupersonic, kbf: wasKbf, hybrid: lastRun.aeroModel === 'hybrid' },
        // Hand the shared handle back on the CURRENT model: the drag panel and
        // the component table read it too.
        restore: { supersonic: effectiveSupersonic, kbf: effectiveKbf, hybrid: effectiveHybrid },
      });
    } finally {
      fullSeriesHolds.current -= 1;
    }
  }, [built, primaryMountId, lastRun, assigned, refusedMountIds, launch, effectiveSupersonic, effectiveKbf, effectiveHybrid, provenanceKey]);

  // ---- design file I/O (.ork native, .rkt RockSim) ----
  /**
   * The working set as the writers take it. The mapping — an EX motor's real
   * maker, an Auto mount at the delay it flew, the references on mounts left
   * empty, the pad mass on the primary alone — is services/orkExportMotors.ts's,
   * shared with the crash-recovery download. `flown`: each Auto mount's
   * rounded delay from the newest complete qualifying flight
   * (flownAutoDelaysNow); with none, an Auto mount keeps its provisional delay
   * and the Save says so (autoDelaySaveNote). Loaded motors first, as
   * filePrimaryMountId ranks them, so when two tied mounts BOTH carry a pad
   * mass the one kept is the one under the field the card shows. When that
   * mount carries none, the tied mount's value is kept instead — the file's,
   * under no field (orkExportMotors.ts padMassOnPrimaryOnly) — until a value
   * typed or cleared on the card supersedes it (typedPadMass).
   */
  const exportMotorsMap = (flown: FlownAutoDelays = {}) => assembleExportMotors({
    assigned, unmatchedRefs, tree, activeConfigId, exLibrary: loadExMotorIdentities,
  }, flown);

  /**
   * Prefer an app flight whose replay evidence still matches this design.
   * Otherwise preserve this opened document's own summary as OUTDATED, with
   * no inferred replay evidence. Global history is never a historical fallback.
   */
  /**
   * The stored results this design is allowed to write into a `.ork`.
   *
   * The RULES live in services/orkFlightData.ts, pure and tested — every one of
   * them guards against writing an authoritative-looking wrong number into a
   * file desktop OpenRocket renders indistinguishably from a fresh result. This
   * is the adapter that hands them the app's state.
   */
  const flightExportInput = useCallback(() => assembleFlightExportInput({
    runs, importedDocument, savedConfigs, activeConfigId, assigned, refusedMountIds, mounts, provenanceKey,
    aeroMode, effectiveKbf, autoSupersonic, hardwareDeltaKg, tree, detachedOverrides, mountMotors, launch,
  }), [runs, importedDocument, savedConfigs, activeConfigId, assigned, refusedMountIds, mounts, provenanceKey,
    aeroMode, effectiveKbf, autoSupersonic, hardwareDeltaKg, tree, detachedOverrides, mountMotors, launch]);
  const flightDataForExport = (): Record<string, OrkExportFlightData> => flightDataForExportPure(flightExportInput());
  /**
   * The same results as of this render, for the .rkt/.CDX1 loss check, which
   * only asks whether there are any: memoized on the export input, so the
   * preview does not re-scan the run history 500 ms after every edit.
   */
  const flightDataNow = useMemo(() => flightDataForExportPure(flightExportInput()), [flightExportInput]);
  /**
   * Each Auto mount's rounded optimum from one complete flight of the
   * design, by configuration id ('' for none) and mount id — what a .ork, a
   * .rkt and a share link write for it (orkFlightData.flownAutoDelays), from
   * the same input the results above are judged on, so a file never names one
   * delay and carries the flight of another.
   */
  const flownAutoDelaysNow = (): Record<string, Record<string, number>> => flownAutoDelays(flightExportInput());
  /**
   * The same delays as of this render, for the autosave below: the
   * crash-recovery .ork writes each Auto mount at them (SessionState.
   * flownAutoDelays), because the runs they come from are judged against a
   * build and a model that a crash leaves nothing of. Memoized on the export
   * input, so the autosave re-runs only when that does.
   */
  const flownForAutosave = useMemo(() => flownAutoDelays(flightExportInput()), [flightExportInput]);

  // Autosave the working state so a closed tab or crash never loses work.
  // Declared here, below the export input, for `flownForAutosave`.
  useEffect(() => {
    saveSessionDebounced({
      ...designSnapshot,
      configLayers: 1,
      importedDocument,
      motorLengthLimitsMigrated: true,
      // Not part of the design fingerprint, but the only copy of a
      // configuration-less import's unresolved motors (audit 2026-09-22).
      unmatchedRefs,
      // Not part of the design either: where applied weather came from.
      // Written only while there is some, so an older session's payload is
      // unchanged until weather is applied.
      ...(weather ? { weather } : {}),
      // Nor this: an opened .CDX1's Mach-Alt table, which Drag analysis offers
      // and Save .CDX1 writes back (K10–K11); only while there is one.
      ...(fileMachAlt ? { fileMachAlt } : {}),
      // The file name is provenance, not a design edit. Restore it beside the
      // rocket name so a reload does not silently change Save As's suggestion.
      ...(designFile ? { designFile } : {}),
      ...(lossySaved?.mark === currentMark && lossySaved.flights === lossyFlights ? { lossySaved } : {}),
      // Nor this: the delay each Auto mount flew, which the crash-recovery
      // .ork writes as a Save would (audit 2026-09-30, item 23). Written only
      // while there is one, so a design with no Auto flight stores what it
      // always did.
      ...(Object.keys(flownForAutosave).length > 0 ? { flownAutoDelays: flownForAutosave } : {}),
      // The build that PARSED this design, not the one writing the file — see
      // parsedByVersion. writeNow spreads `pending` AFTER its own
      // `appVersion: APP_VERSION`, so this value is the one that reaches
      // storage; the APP_VERSION there is only the fallback for a payload
      // that carries none.
      appVersion: parsedByVersion.current,
      savedMark: savedMark.current ?? undefined, flownSinceSave: flownSinceSave.current,
    });
  // savedMark and flownSinceSave are useDesignDirty's refs — stable, so naming
  // them costs no runs — and dirtyTick is how they announce a change. `weather`
  // (weather build, step 3) and `flownForAutosave` ride in the same payload,
  // outside the design snapshot, so they are dependencies too.
  }, [designSnapshot, importedDocument, dirtyTick, unmatchedRefs, savedMark, flownSinceSave, weather, flownForAutosave, fileMachAlt, designFile, lossySaved, currentMark, lossyFlights]);

  /**
   * Stage B: the stored presets in exportOrk's shape. Stable ids ride
   * through; the writer swaps the ACTIVE config's motors for the live
   * working set, so in-app edits persist into the saved file. `configs`
   * defaults to state; onSaveOrk passes the set it has just written the
   * working set back into, so the file and the mark agree.
   */
  const exportConfigs = (configs: SavedConfig[] = savedConfigs, flown: FlownAutoDelays = {}) =>
    assembleExportConfigs(configs, tree, loadExMotorIdentities, flown);

  /**
   * Save a design/export file. On Chrome and Edge this opens a REAL Save-As
   * dialog with the name prefilled and editable and the folder the user's
   * choice; everywhere else it downloads, and says which file it wrote and
   * where — "I did a save as a CDX1 and I don't know where it went" is a
   * tester's own sentence, and silence is what made it possible.
   */
  const download = async (
    content: string | Uint8Array, ext: string, suffix = '',
    // What the written file could not carry (exportRkt's `notes`), said under
    // the save line as a warning — never when the user cancelled, because
    // then no file exists to have lost anything.
    losses: readonly string[] = [],
    lossTier: NoteTier = losses.length ? 'caution' : 'information',
  ) => {
    // CSV gets a UTF-8 BOM: headers can carry non-ASCII (units, symbols), and
    // Excel's double-click open decodes BOM-less CSV as the ANSI codepage.
    // Same convention as the flight-data and run-history CSVs (SimResults).
    const info = FORMAT_INFO[ext] ?? { mime: 'application/octet-stream', description: 'File' };
    const parts: BlobPart[] = ext === 'csv' ? [CSV_BOM, content as BlobPart] : [content as BlobPart];
    // Design formats keep the file's own stem, including spaces and Unicode.
    // Tables and geometry still name the rocket and the data they export;
    // all three design formats become the header's file after a successful write.
    const base = suffix === '' && ['ork', 'rkt', 'cdx1'].includes(ext.toLowerCase())
      ? designFileBase(designFile, tree.name) : safeName(tree.name ?? 'rocket');
    const name = `${base}${suffix}.${ext}`;
    const out = await saveFile(new Blob(parts, { type: info.mime }), {
      suggestedName: name,
      mime: info.mime,
      extensions: [`.${ext}`],
      description: info.description,
    });
    if (suffix === '' && ['ork', 'rkt', 'cdx1'].includes(ext.toLowerCase())
        && (out.kind === 'saved' || out.kind === 'downloaded')) {
      // C-A2: keep the exact bytes written, including lossy formats' own limits.
      void new Blob(parts).arrayBuffer().then(bytes => rememberRecentDesign(out.name, bytes))
        .then(setRecentNote, () => setRecentNote('The app could not keep a copy in Recent. Save a file to keep this design.'));
    }
    // Where it went, and what it could not carry (saveOutcomeNote); a
    // cancelled dialog says nothing.
    const said = saveOutcomeNote(out, losses);
    if (said) setFileNote(said.text, said.severity, undefined, out.kind === 'downloaded' && out.fellBack ? 'caution' : lossTier);
    return out;
  };

  // Component data table (issue 2026-08-11a): all components + attributes in
  // the user's units, with engine-computed mass/CG/position where available.
  const buildComponentTable = () => componentTable(
    tree,
    { units: prefs.units, radiusMode: prefs.radiusMode },
    built ? (id) => {
      try { return built.rocket.componentInfo(id); } catch { return null; }
    } : undefined,
  );

  const onSaveOrk = async (): Promise<SaveOutcome | { kind: 'failed' }> => {
    // Caught, like onSaveRkt and onSaveCdx1 below (audit 2026-09-22): the
    // writer can throw on a design it cannot represent, and none of this
    // handler's five callers catches, so a throw was an unhandled rejection —
    // a Save that silently did nothing. 'failed' is not 'cancelled' but stops
    // the same things: nothing is marked saved, and "Save .ork, then open"
    // does not go on to open the other file.
    try {
      // The mark is taken SYNCHRONOUSLY, before the await. `download` opens a
      // Save-As picker that can sit open indefinitely, and the user can keep
      // editing behind it — marking from post-await state would bless those
      // edits as saved when the file on disk does not have them.
      //
      // Everything live — motors, references and what the tree holds for the
      // active configuration — is written back into it FIRST and the mark taken
      // over the synced set (importApply.planOrkSave says why).
      const { savedConfigs: synced, mark } = planOrkSave(snapshotNow(), unmatchedRefs);
      const flightsAtSnapshot = flightCount.current;
      if (synced !== savedConfigs) setSavedConfigs(synced);
      // Every Auto mount at the delay it flew, and a line for each the file
      // cannot carry that way (autoDelaySaveNote) — once per motor, though the
      // active configuration's goes through both maps.
      const flown = flownAutoDelaysNow();
      const motors = exportMotorsMap(flown);
      const configs = exportConfigs(synced, flown);
      const losses = [...new Set([...Object.values(motors), ...configs.flatMap((c) => Object.values(c.motors))]
        .map((m) => autoDelaySaveNote(m, '.ork')).filter((n): n is string => n !== null))];
      // WITH launch: the .ork's first <simulation> carries the pad and weather,
      // so the file (and the desktop app) round-trips the whole flight setup.
      let omittedMotor = losses.length > 0;
      const out = await download(exportOrk({ onOmittedMotor: () => { omittedMotor = true; }, workingOverrides: detachedOverrides,
        name: tree.name ?? 'My Rocket', tree, motors, launch,
        configs, activeConfigId, measured,
        flightData: flightDataForExport(),
        notes: losses,
      }), 'ork', '', losses, omittedMotor ? 'caution' : 'information');
      // Only a real write counts. 'cancelled' means the user backed out of the
      // picker, and treating that as saved is how work gets discarded silently.
      if (out.kind === 'saved' || out.kind === 'downloaded') {
        // eslint-disable-next-line no-restricted-syntax -- a .ork is the one format that round-trips everything
        markSaved(mark, flightsAtSnapshot);
        setDesignFile({ name: out.name, via: out.kind === 'saved' ? 'saved' : 'downloaded', format: 'ork' });
        setLossySaved(null);
      }
      return out;
    } catch (e) {
      setFileNote(`Save .ork failed — nothing was written: ${e instanceof Error ? e.message : String(e)}`, 'error', undefined, 'danger');
      return { kind: 'failed' };
    }
  };

  // DELIBERATELY does not clear the unsaved-changes mark, and neither does
  // onSaveCdx1 below. Both formats are LOSSY relative to the design in the app:
  // the RockSim export carries name, tree, motors and per-component mass/CG,
  // and measured mass/CG only as a one-stage rocket's known mass, but no launch
  // conditions and no flight configurations; the RASAero export keeps launch
  // but drops configurations, measured and flight data. Treating either as
  // "saved" would let the next Open discard the parts the file does not hold -
  // which is the defect this guard exists for. Only the .ork round-trips
  // everything, so only .ork marks.
  // flownForAutosave and flightDataNow are this render's flownAutoDelaysNow()
  // and flightDataForExport(), memoized: the check runs after every edit.
  const lossInput = (format: LossyFormat): FormatLossInput => ({
    tree, overrides: activeOverrides, launch, measured, configs: savedConfigs, activeConfigId,
    motors: exportMotorsMap(format === 'rkt' ? flownForAutosave : {}), flightData: flightDataNow,
    distanceUnit: prefs.units.distance,
  });
  const lossyExportFailed = (format: LossyFormat, e: unknown) =>
    setFileNote(`${format === 'rkt' ? 'RockSim' : 'RASAero'} export failed: ${e instanceof Error ? e.message : String(e)}`, 'error', undefined, 'danger');
  // Use the latest render at the idle edge, without restarting the timer for
  // unrelated UI renders. No kernel calls are made by this preview. The ref is
  // written after render, in a layout effect, so before the timer's effect.
  const lossInputRef = useRef(lossInput);
  useLayoutEffect(() => { lossInputRef.current = lossInput; });
  useEffect(() => {
    if (!designFile || designFile.format === 'ork' || simulating || reflying !== null) return;
    const file = designFile;
    const format = designFile.format;
    const timer = window.setTimeout(() => {
      if (flightHoldsHandle.current) return;
      // A throw building the input still replaces the last report: the header
      // says the check did not finish, never a stale list or nothing at all.
      setLiveLoss({ file, report: checkFormatLossOf(format, () => lossInputRef.current(format)) });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [designFile, designSnapshot, unmatchedRefs, runs, importedDocument, simulating, reflying, flightExportInput,
    prefs.units.distance]);
  // The Open, ✕ New and share confirms say what the .rkt or .CDX1 on disk does
  // not keep. Computed now, from the design on screen, while one is open: the
  // header's debounced preview may not have run yet (just after an Open or an
  // edit, or while a flight holds it), and a stale or missing list is wrong.
  const replacing = confirmNew || pendingOpen !== null || shareOffer !== null;
  const replaceReport = useMemo(() => {
    if (!replacing || !designFile || designFile.format === 'ork') return null;
    // A check that cannot run still says so: the confirm never drops the paragraph silently.
    const format = designFile.format;
    return checkFormatLossOf(format, () => lossInput(format));
  // Keyed on what lossInput reads (through designSnapshot and the two memoized
  // export values), not on lossInput itself, which is rebuilt every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on lossInput's inputs, not its per-render identity
  }, [replacing, designFile, designSnapshot, unmatchedRefs, flownForAutosave, flightDataNow, prefs.units.distance]);
  const replaceLoss = replacementLossNote(designFile, replaceReport);

  const saveLossy = (format: LossyFormat, accepted?: FormatLossReport) => {
    let data: FormatLossInput;
    let report: CheckedFormatLossReport;
    try {
      data = lossInput(format);
      report = checkFormatLossSafely(format, data);
    } catch (e) {
      // The input is the writer's own (the motor set): what cannot be
      // assembled cannot be written, so report it as a failed write would.
      lossyExportFailed(format, e);
      return;
    }
    // If the design changed behind a dialog, show the new losses before
    // writing. There is no await before download reaches the file picker.
    const write = async () => {
      const mark = currentMark;
      const flights = lossyFlights;
      setLossDialog(null);
      try {
        const xml = format === 'rkt'
          ? exportRkt({ name: tree.name ?? 'My Rocket', tree, overrides: activeOverrides, motors: data.motors, measured,
            compInfo: built ? rktComponentInfo(tree, id => built.rocket.componentInfo(id)) : {},
            ...(data.distanceUnit !== undefined ? { distanceUnit: data.distanceUnit } : {}) })
          : exportCdx1({ name: tree.name ?? 'My Rocket', tree, overrides: activeOverrides, motors: data.motors, launch,
            launchMassKg: built?.info.mass, launchCgM: built?.info.cg,
            ...(fileMachAlt ? { machAlt: fileMachAlt } : {}) });
        const out = await download(xml, format === 'rkt' ? 'rkt' : 'CDX1', '', report.losses);
        if (out.kind === 'saved' || out.kind === 'downloaded') {
          const file: DesignFileRef = { name: out.name, via: out.kind, format };
          setDesignFile(file);
          setLossySaved({ mark, flights, format, lossCount: report.losses.length, ...(report.incomplete ? { incomplete: true } : {}) });
          setLiveLoss({ file, report });
        }
      } catch (e) {
        lossyExportFailed(format, e);
      }
    };
    if (accepted && !report.refused && stableJson(report) === stableJson(accepted)) void write();
    else gateLossySave(report, () => { void write(); }, next => setLossDialog({ report: next, confirm: true }));
  };
  const onSaveRkt = () => saveLossy('rkt');
  const onSaveCdx1 = () => saveLossy('cdx1');

  // NOTE for the three handlers below: they `await import(...)` before saving,
  // which spends the click's transient user activation — so on Chrome the
  // Save-As picker raises NotAllowedError and saveFile falls back to a plain
  // download. That degradation is deliberate and safe (the user still gets the
  // file, and is told where it went); the alternative is preloading three lazy
  // chunks on every page load to keep a dialog for three rarely-used exports.
  const onSaveObj = async () => {
    try {
      const { rocketToObj } = await import('./services/objExport.js');
      await download(rocketToObj(tree, tree.name ?? 'Rocket'), 'obj');
    } catch (e) {
      setFileNote(`OBJ export failed: ${e instanceof Error ? e.message : String(e)}`, 'error', undefined, 'danger');
    }
  };

  const onSaveGlb = async () => {
    try {
      const { rocketToGlb } = await import('./services/gltfExport.js');
      await download(new Uint8Array(await rocketToGlb(tree, tree.name ?? 'Rocket')), 'glb');
    } catch (e) {
      setFileNote(`glTF export failed: ${e instanceof Error ? e.message : String(e)}`, 'error', undefined, 'danger');
    }
  };

  const onSaveStl = async () => {
    try {
      const [{ buildPieces }, { piecesToStl }] = await Promise.all([
        import('./tree/pieces.js'),
        import('./services/stlExport.js'),
      ]);
      const { pieces } = buildPieces(tree);
      await download(piecesToStl(pieces, tree.name ?? 'Rocket'), 'stl');
    } catch (e) {
      setFileNote(`STL export failed: ${e instanceof Error ? e.message : String(e)}`, 'error', undefined, 'danger');
    }
  };

  /**
   * Applies an imported design to the app — the ONE apply path, shared by
   * Open… and the share-link loader so a linked rocket behaves exactly like
   * an opened file: per-mount motor matching, launch conditions, notes, the
   * camera-shroud offer.
   *
   * The matching itself is `matchImportedMotor` in services/motorMatch.ts —
   * the shipped database and nothing below it: since v0.107 a motor whose
   * curve cannot be had is reported, never substituted. It used to be a
   * closure in this file, where the only thing that could reach it was a
   * regular expression over App.tsx.
   *
   * There used to be an `withoutMotors` option here, driven by the config
   * picker's "Open with no motors loaded" button. The picker is gone
   * (2026-08-22b) and nothing else ever passed it, so the option went with it.
   * The capability did NOT: ⏏ Unload in the vitals strip and the "None" row in
   * the Flight configurations panel both empty the working set in one click.
   */
  const applyImported = async (imported: ImportedDesign, seq?: number, file: DesignFileRef | null = null) => {
    // Which open this is. Every motor in the file can cost a live
    // thrustcurve.org fetch with no timeout, so two opens a second apart
    // finish in whatever order the network decides: at a launch site the
    // second (all built-ins, milliseconds) painted, then the first resolved
    // and its setter block overwrote it AND stamped its own fingerprint as
    // saved — leaving the user editing a rocket they had not asked for, with
    // `dirty` false so the next Open discarded the work silently.
    const openId = seq ?? openSeq.begin();
    // The awaits of an open: every motor the file names, resolved.
    const resolved = await resolveImportMotors(imported);
    // EVERY await is behind us; from here on this function writes state. A
    // newer open started while those fetches were outstanding owns the screen
    // now, so this one stops here rather than overwriting it — and, crucially,
    // never reaches the markSaved at the end, which is what made the loser's
    // work look saved.
    if (!openSeq.isCurrent(openId)) return;
    // Only a winning open replaces the old parse on screen and its notice
    // (audit 2026-10-11, S2-4).
    setRestoredByOlderBuild(false);
    // The winning open owns the file name as well as the design. A share link
    // has no file, so its omitted argument clears the previous file's name.
    setDesignFile(file);
    setLossySaved(null);
    // What goes on screen, decided in services/importApply.ts and written by
    // applyImportPlan, which marks from the SAME plan — so the two cannot be
    // assembled apart. The launch is merged ONCE, from the mirror, now that
    // every await is behind us (audit 2026-09-22). The history starts over
    // from the opened design: Ctrl+Z does not reach across a file open.
    const plan = planImport(imported, resolved, { launch: launchRef.current, text: statedWeightText });
    const quietLines = new Set(planImport(imported, acceptedOtherMakerNotes(resolved),
      { launch: launchRef.current, text: statedWeightText }).note.text.split('\n'));
    const acceptedLines = plan.note.text.split('\n').filter(line => !quietLines.has(line));
    motorChoices.current.clear();
    applyImportPlan(plan, {
      history: { reset: resetHistory },
      setMountMotors, setUnmatchedRefs, setSavedConfigs, setActiveConfigId, setDetachedOverrides, setLaunch, setMeasured,
      setLongitudeCheck: (evidence) => setLongitudeReview(evidence ? { evidence, applied: false } : null),
      setMachAlt: setFileMachAlt, setNote: setGroupNote, setShroudPrompt,
      // eslint-disable-next-line no-restricted-syntax -- an import: the design on screen IS the file on disk
      markSaved,
    });
    const identities = collectOpenMotorIdentities(imported, resolved, plan.snapshot);
    setOpenMotorQuestion(identities.length ? {
      identities, openId, acceptedLines,
    } : null);
    const storedCount = imported.storedSimulations?.length ?? 0;
    setImportedDocument(summaryDocument(imported));
    setInspectedSummary(null);
    if (storedCount) {
      const current = loadRuns();
      // The matched configurations, so an unnamed one's runs carry its shown label.
      const summaryPlan = planSummaryImport(imported, current, plan.snapshot.savedConfigs);
      let next = current;
      if (summaryPlan.runs.length || summaryPlan.updatedRuns.length) {
        next = appendImportedRuns(summaryPlan.runs, summaryPlan.updatedRuns);
        recordRuns(next);
      }
      const { added, updated, alreadySaved, notKept } = summaryImportCounts(summaryPlan, next);
      // Their own lines in the open's group: Information, unless a stored run
      // was not kept — imported flight evidence incomplete (D7 I28).
      const runLines: ImportNote[] = [
        { kind: 'I28.stored-runs', tier: notKept > 0 ? 'caution' : 'information',
          text: `Stored runs: ${added} added to Saved runs; ${updated ? `${updated} updated in Saved runs; ` : ''}${alreadySaved} already in Saved runs; ${notKept} not kept.` },
        { kind: 'I27.stored-runs-rule', tier: 'information',
          text: `Imports fill available spaces up to the ${MAX_RUNS}-run limit in file order; no existing runs were removed or reordered.` },
      ];
      setGroupNote([plan.note.text, ...runLines.map(l => l.text)].filter(Boolean).join('\n'), plan.note.severity, plan.note.expand,
        { ...plan.note.group, lines: [...plan.note.group.lines, ...runLines] });
    }
    // An opened design (a share link included) that brings launch conditions
    // of its own has replaced the ones the weather record describes.
    if (imported.launch) setWeather(null);
    // This design has now been through THIS build's importer, so the session
    // the next autosave writes really was parsed by the running build.
    parsedByVersion.current = APP_VERSION;
    // A simulation error belonged to the design that threw it, and that design
    // has just been replaced — as did the motors and mounts a pad-mass notice
    // names (seam review of audit 2026-09-22). One the opened file earns is
    // written after this, by the reconcile effect.
    setSimError(null);
    setPadMassNote(null);
    setMotorLoadoutRepair(null);
    setSelectedId(null);
  };

  /**
   * Loads a flight-configuration preset into the working set (Stage B) — the
   * decision is importApply's planConfigSwitch, which says what a switch writes
   * back and what it carries across.
   */
  const applyConfig = (requested: SavedConfig) => {
    setMotorLoadoutRepair(null);
    motorChoices.current.clear();
    const plan = planConfigSwitch(
      { savedConfigs, activeConfigId, mountMotors, unmatchedRefs, tree }, requested, statedWeightText);
    // The history starts over from the switched design (applyConfigSwitchPlan
    // says why): the stack holds the tree alone, and one Ctrl+Z used to put the
    // previous configuration's nozzle and recovery back under these motors.
    applyConfigSwitchPlan(plan, savedConfigs, {
      seedNozzleFollow,
      history: { reset: resetHistory },
      setSavedConfigs, setMountMotors, setUnmatchedRefs, setActiveConfigId, setDetachedOverrides, setNote: setGroupNote,
    });
  };

  // FC-4: capture defaults and all layer maps before any setter runs. FC-5's
  // default+override controls use this same transaction, one history step.
  const beginFlightEdit = () => {
    flightEdit.current = { committed: false, cancel: flightCheckpoint(), owner: activeLayer ? { configId: activeLayer.id }
      : detachedOwnsOverrides ? 'detached' : 'default' };
  };
  const finishFlightEdit = (commit: () => void) => {
    if (flightEdit.current?.committed) commit();
    flightEdit.current = null;
  };
  const cancelFlightEdit = () => {
    const gesture = flightEdit.current;
    flightEdit.current = null;
    if (gesture?.committed) gesture.cancel();
  };
  const commitFlightLayers = (next: { tree?: RocketTree; configs?: SavedConfig[]; detached?: FlightOverrides }, numeric = false) => {
    // Ordinary fields use setTree's timed coalescing. Override fields also need
    // a stable owner and deferred sparsification, so their focus/blur gesture
    // explicitly keeps the first companion snapshot, even during slow typing.
    const gesture = numeric ? flightEdit.current : null;
    if (gesture?.committed) writeTree(next.tree ?? treeRef.current);
    else commitTreeStep(next.tree ?? treeRef.current);
    if (gesture) gesture.committed = true;
    layerRevision.current = {};
    if (next.configs) setSavedConfigs(next.configs);
    if (next.detached) setDetachedOverrides(next.detached);
  };
  /**
   * CFG-SPEC A3: the motor card edits an explicit scope. 'own' is the mount's
   * own setting (every configuration without an override flies it); 'override'
   * is the active owner's layer. There is no implicit "an active configuration
   * means override" rule any more.
   */
  const editIgnition = (id: string, tuple: IgnitionTuple, scope: FlightEditScope, numeric = false, finished = false) => {
    const gesture = numeric ? flightEdit.current : null;
    const baseline = (tree as FlightTree).ignitionDefaults?.[id] ?? mountMotors[id]!.ignition;
    if (scope === 'own') {
      // Establishing the first shared default must not change what another
      // configuration flies: one whose own motor record lights differently
      // from today's own setting keeps that as an override. Existing
      // overrides are never touched (own-setting scope).
      let frozen = false;
      const configs = (tree as FlightTree).ignitionDefaults?.[id] ? savedConfigs : savedConfigs.map(c => {
        const native = c.motors[id]?.ignition;
        if (c.id === activeConfigId || !native || overrideFor(c.ignitions, id) || !sparsify(baseline, native)) return c;
        frozen = true;
        return { ...c, ignitions: { ...c.ignitions, [id]: { ...native } } };
      });
      commitFlightLayers({ tree: { ...tree, ignitionDefaults: { ...(tree as FlightTree).ignitionDefaults, [id]: { ...tuple } } } as FlightTree,
        ...(frozen ? { configs } : {}) }, numeric);
      return;
    }
    const owner = gesture?.owner ?? (activeLayer ? { configId: activeLayer.id }
      : detachedOwnsOverrides ? 'detached' : 'default');
    // Native configurations can still inherit their own propellant-based motor
    // record. Establishing one shared default must not change any other owner.
    const establishing = !(tree as FlightTree).ignitionDefaults?.[id];
    const configs = establishing ? savedConfigs.map(c => {
      const effective = c.ignitions?.[id] ?? c.motors[id]?.ignition;
      return effective ? { ...c, ignitions: setOverride(c.ignitions, id, baseline, effective) } : c;
    }) : savedConfigs;
    const detached = establishing ? { ...detachedOverrides,
      ignitions: setOverride(detachedOverrides.ignitions, id, baseline, detachedOverrides.ignitions?.[id] ?? mountMotors[id]!.ignition),
    } : detachedOverrides;
    // With no owner there is no override layer: the mount default it is (FC-5).
    if (owner === 'default') {
      commitFlightLayers({ tree: { ...tree, ignitionDefaults: { ...(tree as FlightTree).ignitionDefaults, [id]: tuple } } as FlightTree }, numeric);
      return;
    }
    const previous = typeof owner === 'object' ? configs.find(c => c.id === owner.configId)?.ignitions : detached.ignitions;
    const ignitions = gesture && !finished ? { ...previous, [id]: tuple } : setOverride(previous, id, baseline, tuple);
    // Freeze a native mount's true default before exporting resolved motors
    // (audit 2026-10-11, FC-4 fixup). Undo restores both layers together.
    const defaults = { ...tree, ignitionDefaults: { ...(tree as FlightTree).ignitionDefaults, [id]: baseline } } as FlightTree;
    if (typeof owner === 'object') {
      commitFlightLayers({ tree: defaults, configs: configs.map(c => c.id === owner.configId ? { ...c, ignitions } : c), detached }, numeric);
    } else commitFlightLayers({ tree: defaults, configs, detached: { ...detached, ignitions } }, numeric);
  };

  const commitActiveOverrides = (patch: FlightOverrides, numeric = false) => {
    const owner = numeric ? flightEdit.current?.owner : undefined;
    const configId = owner ? typeof owner === 'object' ? owner.configId : null : activeLayer?.id;
    if (configId) commitFlightLayers({ configs: savedConfigs.map(c => c.id === configId ? { ...c, ...patch } : c) }, numeric);
    else commitFlightLayers({ detached: { ...detachedOverrides, ...patch } }, numeric);
  };
  const editComponentOverride = (node: ComponentNode, tuple: ComponentFlightTuple, numeric = false, finished = false) => {
    const id = node.id!;
    const gesture = numeric ? flightEdit.current : null;
    const owner = gesture?.owner;
    const overrides = owner
      ? activeFlightOverrides(savedConfigs, typeof owner === 'object' ? owner.configId : null, detachedOverrides)
      : activeOverrides;
    commitActiveOverrides('deployEvent' in tuple
      ? { deployments: gesture && !finished ? { ...overrides.deployments, [id]: tuple }
        : setOverride(overrides.deployments, id, deploymentTuple(node), tuple) }
      : { separations: gesture && !finished ? { ...overrides.separations, [id]: tuple }
        : setOverride(overrides.separations, id, {
        separationEvent: String(node['separationEvent'] ?? 'ejection'),
        separationDelay: num(node, 'separationDelay', 0), separationAltitude: num(node, 'separationAltitude', 200),
      }, tuple) }, numeric);
  };
  const resetComponentOverride = (node: ComponentNode) => {
    const id = node.id!;
    commitActiveOverrides(node.type === 'parachute' || node.type === 'streamer'
      ? { deployments: resetOverride(activeOverrides.deployments, id) }
      : { separations: resetOverride(activeOverrides.separations, id) });
  };
  const adoptComponentOverrideEverywhere = (node: ComponentNode) => {
    const id = node.id!;
    const recovery = node.type === 'parachute' || node.type === 'streamer';
    const tuple = recovery ? activeOverrides.deployments?.[id] : activeOverrides.separations?.[id];
    if (!tuple) return;
    // Clear every owner, including detached choices, in the SAME history step (FC-5).
    commitFlightLayers({ tree: updateNode(tree, id, { ...tuple }),
      configs: savedConfigs.map(c => recovery ? { ...c, deployments: resetOverride(c.deployments, id) }
        : { ...c, separations: resetOverride(c.separations, id) }),
      detached: recovery ? { ...detachedOverrides, deployments: resetOverride(detachedOverrides.deployments, id) }
        : { ...detachedOverrides, separations: resetOverride(detachedOverrides.separations, id) },
    });
  };

  /** CFG-SPEC A2 own-setting scope: the part's tree default, as the Design field edits it. Overrides are left alone. */
  const editComponentDefault = (node: ComponentNode, patch: Partial<ComponentFlightTuple>, numeric = false) => {
    commitFlightLayers({ tree: updateNode(tree, node.id!, patch as Partial<ComponentNode>) }, numeric);
  };
  /** One undo step: drop the active owner's overrides for these parts of one family. */
  const resetComponentOverrides = (family: 'recovery' | 'separation', ids: string[]) => {
    const map = family === 'recovery' ? activeOverrides.deployments : activeOverrides.separations;
    const next = ids.reduce<Record<string, ComponentFlightTuple>>((acc, id) => resetOverride(acc, id), { ...map });
    commitActiveOverrides(family === 'recovery'
      ? { deployments: next as Record<string, DeploymentTuple> }
      : { separations: next as Record<string, SeparationTuple> });
  };

  const createConfig = (): string | null => {
    const next = createLoadedConfig({ savedConfigs, activeConfigId, detachedOverrides, tree, mountMotors, unmatchedRefs });
    if (!next) return null;
    // Older scale companions cannot restore configurations created after them.
    resetHistory();
    setSavedConfigs(next.savedConfigs);
    setActiveConfigId(next.activeConfigId);
    setFileNote('New flight configuration created from the loaded motors.');
    return next.activeConfigId;
  };

  const duplicateFlightConfig = () => {
    const next = duplicateActiveConfig({ savedConfigs, activeConfigId, tree, mountMotors, unmatchedRefs });
    if (!next) return;
    resetHistory();
    setSavedConfigs(next.savedConfigs);
    setActiveConfigId(next.activeConfigId);
    setFileNote('Flight configuration duplicated.');
  };

  const renameFlightConfig = (id: string, name: string) => {
    if (renameConfig(savedConfigs, id, name) === savedConfigs) return;
    setSavedConfigs(prev => renameConfig(prev, id, name));
    setFileNote('Flight configuration renamed.');
  };

  const deleteFlightConfig = (config: SavedConfig) => {
    const next = deleteConfig(savedConfigs, activeConfigId, config.id, detachedOverrides);
    setSavedConfigs(next.savedConfigs);
    setActiveConfigId(next.activeConfigId);
    setDetachedOverrides(next.detachedOverrides);
    // History remains a record of flown flights. Its result export gate rejects this
    // missing id; remove the file-owned fallback association as well.
    setImportedDocument(prev => prev ? { ...prev,
      storedSimulations: prev.storedSimulations.filter(s => s.configId !== config.id) } : prev);
    setFileNote(`Flight configuration "${savedConfigLabel(config)}" deleted.`);
  };

  /** The "None" row / full unload: no motors, no active configuration. */
  const clearConfig = () => {
    motorChoices.current.clear();
    detachedHistoryEpoch.current = {};
    // The working set — and what the tree holds for the configuration — goes
    // back into it before it is emptied, for the same reason applyConfig does
    // it: "None" is a switch, not a discard, and the configuration must still
    // hold the edits made on it.
    const synced = syncActiveConfig(savedConfigs, activeConfigId, { motors: mountMotors, unmatchedRefs, tree });
    if (synced !== savedConfigs) setSavedConfigs(synced);
    const had = Object.keys(mountMotors).length > 0;
    setMountMotors({});
    // "No motors" has to mean no motors in the saved file too, so the file's
    // unresolved references go with them.
    setUnmatchedRefs({});
    setActiveConfigId(null);
    setDetachedOverrides({});
    // Every other action in the Flight configurations panel confirms through
    // the notice bar; this one said nothing, and it is now the last control on
    // the tab. The copy has to read correctly from the vitals strip's
    // ⏏ Unload button too, which is the same function.
    if (had) setFileNote('Every motor unloaded — the rocket is shown and weighed clean.');
  };

  const onOpenOrk = async (file: File) => {
    sessionDebugLog.record('import-start');
    // Claim the open BEFORE the first await — the parse and the motor fetches
    // that follow can take seconds, and a second Open in the meantime has to
    // win however the network orders them. See openSeq.
    const openId = openSeq.begin();
    try {
      // Cheap pre-check before the bytes are read, let alone inflated — the
      // file door (services/designFile.ts), which the headless open uses too.
      const tooBig = designFileTooLarge(file.size, file.name);
      if (tooBig) {
        sessionDebugLog.record('import-failed', new Error('File exceeds the design-file size limit.'));
        setFileNote(tooBig, 'error');
        return;
      }
      const buffer = await file.arrayBuffer();
      // The parts catalogue rides along so a part the file names by
      // manufacturer + part number (.rkt <PartMfg>/<PartNo>, .ork <preset>) is
      // linked to its row and takes the catalogue's values for whatever the
      // file left unset - a RockSim chute's "auto" Cd, above all. The importer
      // the extension names reads it (the user's distance unit to the .rkt
      // reader, whose note quotes each configuration's deployment altitude),
      // and a generically-named design takes its file's name.
      const presets = await loadPresets();
      // A .CDX1's stated launch weight is backed out with the curve the motor
      // match below will fly (`fetchMotorSpec`, its default), loaded here first.
      const imported = await openDesignFile(buffer, file.name, { presets, distanceUnit: prefs.units.distance,
        aeroChoice: aeroOverride ?? aeroChoiceOf(prefs), flownSpec: fetchMotorSpec });
      // A multi-configuration .ork used to stop here and ask which one to
      // open. Two testers found that modal the worst moment in the app — it
      // was the FIRST thing a new user saw, and it listed configurations by
      // the only thing most files give them, an OpenRocket GUID. We now open
      // the file's own default configuration, exactly as desktop OpenRocket
      // does, and say which one in the import note; the Flight configurations
      // panel on Motors & Configuration switches between them (motors AND recovery
      // deployment, since applyConfig applies both now).
      await applyImported(imported, openId, { name: file.name, via: 'opened', format: imported.sourceFormat! });
      if (openSeq.isCurrent(openId)) {
        sessionDebugLog.record('import-complete');
        const note = await rememberRecentDesign(file.name, buffer);
        if (openSeq.isCurrent(openId)) setRecentNote(note);
      }
    } catch (e) {
      sessionDebugLog.record('import-failed', e);
      // A superseded open must not shout about a design nobody is waiting for.
      if (!openSeq.isCurrent(openId)) return;
      // Named for the format the user actually picked (designFile.ts says why);
      // the headless open words a refused file with the same sentence.
      // 'error', not the default 'info'. The design on screen did not change,
      // so this note is the ONLY feedback the click produced — and an info
      // notice never opens the collapsed bar, which is exactly the shape of
      // "I clicked it and nothing happened". Every other export/import failure
      // in this file already passes an explicit severity.
      setFileNote(designFileOpenFailure(file.name, e), 'error');
    }
  };

  // ---- "Open from a link": #d=<compressed .ork> in the URL fragment ----
  // Decoded once at startup, then the fragment is cleared up front —
  // declined and broken links included — so a reload never re-triggers it.
  // Every failure lands in the file-note with the current design untouched;
  // a bad link must never blank the app.
  const shareHandled = useRef(false);
  const shareShouldOffer = useRef(false);
  /**
   * Offer the Quick Picks at all? They are the Quick Start's four Estes
   * motors, so they are advice only while the design is still the Quick
   * Start's rocket (Eric, 2026-09-21). Memoised on the tree rather than called
   * inline: `isPristineDefault` builds a fresh `defaultTree()`, which mints new
   * ids, and this is read once per mount card per render.
   */
  const quickPicksOffered = useMemo(() => isPristineDefault(tree), [tree]);
  // Share and Quick picks use one memoized tree check (audit 2026-10-11, S2-9).
  shareShouldOffer.current = dirty || !quickPicksOffered;
  useEffect(() => {
    if (shareHandled.current || !hasSharePayload(window.location.hash)) return;
    shareHandled.current = true; // StrictMode double-invoke guard (the ref survives the remount)
    const hash = window.location.hash;
    // window.history explicitly: the browser's, not the design's undo history.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    // Sequenced like every other open, claimed before its first await
    // (importApply.openShareLink).
    void openShareLink(hash, {
      openSeq,
      read: async (h) => {
        // Cheap pre-decode cap: no real share link approaches 1 MB of
        // fragment, and a crafted one can inflate to hundreds of MB — refuse
        // it before base64/inflate ever run (same soft-fail path as a
        // corrupt link; the current design stays untouched either way).
        if (h.length > MAX_FRAGMENT_CHARS) {
          throw new Error('the link is far longer than any real design — refusing to decode it');
        }
        return importOrk(await decodeShareFragment(h), { presets: await loadPresets() });
      },
      // Include non-tree edits and work done while the link was decoding.
      shouldOffer: () => shareShouldOffer.current,
      onOffer: setShareOffer,
      apply: applyImported,
      // 'warn', not the default 'info'. The message is 165 characters before the
      // reason is appended and the collapsed bar truncates at 157, so as an info
      // notice the reader got the first sentence, an 'i' glyph, no reason, and a
      // bar that never opened itself — for a link that simply did not work.
      // The sentence names the browser when this one cannot unpack links at
      // all, rather than calling every link damaged (audit 2026-09-22).
      onError: (e) => { sessionDebugLog.record('import-failed', e); setFileNote(shareLinkOpenFailure(e), 'warn'); },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot startup decode
  }, []);

  /**
   * Copy-share-link (Save/Export menu): the WHOLE design — components,
   * motors, launch conditions — deflated into the URL fragment, which never
   * reaches a server (see services/shareLink.ts).
   */
  const onCopyShareLink = async () => {
    try {
      const flown = flownAutoDelaysNow();
      const saveNotes: string[] = [];
      let omittedMotor = false;
      const xml = exportOrk({ onOmittedMotor: () => { omittedMotor = true; }, workingOverrides: detachedOverrides,
        name: tree.name ?? 'My Rocket', tree, motors: exportMotorsMap(flown), launch,
        // Included so a share link reproduces exactly what saving the file
        // reproduces — the recipient sees the sender's weighed build, which is
        // the rocket the "Build allowance" in the tree belongs to.
        configs: exportConfigs(savedConfigs, flown), activeConfigId, measured,
        // Same rule: a link must open to the same file a save would write.
        flightData: flightDataForExport(),
        notes: saveNotes,
      });
      const frag = await encodeShareFragment(xml);
      const url = `${window.location.origin}${window.location.pathname}${window.location.search}${frag}`;
      // DELIBERATELY does not clear the unsaved-changes mark. The payload is
      // byte-identical to what a .ork save writes, so it is not a fidelity
      // problem - it is that nothing lands on disk, and on the clipboard
      // fallback path below the URL goes into a window.prompt() where we
      // cannot tell whether the user ever copied it. Marking work as saved
      // because a link MIGHT have been copied is how it gets lost.
      // Chat apps truncate very long messages, and a truncated link decodes
      // to nothing — warn at the copy, not after a confused report.
      const sizeNote = url.length > 64 * 1024
        ? '\nHeads up: this design is complex, so the link is very long — some chat apps truncate long messages, and a cut-off link won’t open. If it fails for the recipient, send the .ork file instead.'
        : '';
      try {
        await navigator.clipboard.writeText(url);
        setFileNote([`Share link copied — opening it loads “${tree.name ?? 'My Rocket'}” with its motors and launch conditions.${sizeNote}`,
          ...saveNotes].join('\n'), saveNotes.length ? 'warn' : 'info', undefined, omittedMotor ? 'caution' : 'information');
      } catch {
        // Clipboard refused (permissions, iframe embed, non-secure context):
        // hand the link over for a manual Ctrl+C — prompt() pre-selects it.
        window.prompt('Copy this share link (Ctrl+C):', url);
        const fallbackNotes = [sizeNote.trim(), ...saveNotes].filter(Boolean).join('\n');
        if (fallbackNotes) setFileNote(fallbackNotes, 'warn', undefined, omittedMotor ? 'caution' : 'information');
      }
    } catch (e) {
      // 'error' — nothing was copied and nothing is on screen to say so
      // otherwise, matching what onSaveRkt/onSaveCdx1 already do.
      setFileNote(`Share link failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  // Loaded motor dimensions per mount — the 2D schematic draws each motor
  // to scale inside its mount tube (the owner's request: real case length).
  const motorDims = useMemo(
    () => Object.fromEntries(assigned.map(([id, mm]) => [
      id, { length: mm.spec.length, diameter: mm.spec.diameter, label: mm.label },
    ])),
    [assigned],
  );

  /**
   * Reload onto the new build. Poking the service worker first matters: under
   * `registerType: 'autoUpdate'` the new worker takes over and reloads by
   * itself once it installs, so a plain reload could otherwise land back on
   * the cached build and look like the button did nothing.
   */
  const reloadForUpdate = useCallback(async () => {
    await pokeServiceWorker();
    window.location.reload();
  }, []);

  // Data header for the 2D/3D image exports (issue 2026-08-11a) — name,
  // dimensions, mass, CG/CP/margin in the user's units.
  const viewExportData = {
    name: tree.name ?? 'Rocket',
    info: built?.info ?? null,
    units: prefs.units,
    withMotors: assigned.length > 0,
    appVersion: APP_VERSION,
  };

  // Memoized: a `findNode` walk per render, and the dep of the `selectedInfo`
  // memo below it, so leaving it unstable defeated that one too.
  const selectedNode = useMemo(
    () => (selectedId ? findNode(tree, selectedId) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this
    [tree.components, selectedId]);
  // Per-component static info (mass covers ALL fins of a set, per OpenRocket).
  const selectedInfo = useMemo(() => {
    if (!built || !selectedNode?.id) return null;
    try {
      return built.rocket.componentInfo(selectedNode.id);
    } catch {
      return null;
    }
  }, [built, selectedNode]);
  // Sub-minimum mounts (caseAirframe): the motor case IS the airframe, so the
  // fit reference is the tube's OUTER diameter — bore would hide the very
  // motor the rocket is built around.
  // Through `mountBore`, not a fourth hand-rolled copy of the same arithmetic:
  // the bore reader and the snap writer disagreeing about what an absent wall
  // means already put a snapped tube 1 mm off the class it reported, and the
  // next change to the kernel's default wall or the caseAirframe rule would
  // have re-opened that split here, in the motor browser and the batch runner.
  const mountDiaMm = (m: ReturnType<typeof findNode>) =>
    (m ? Math.round(mountBore(m) * 1000) : 18);
  /**
   * Motor diameter (m) per mount id, memoized.
   *
   * NOT because typing in the Scale dialog rebuilds it — the factor is the
   * dialog's own state, so a keystroke re-renders the dialog alone, this
   * object keeps its identity across those renders, and `previewMounts`
   * recomputes anyway because the factor is one of its deps. (An earlier
   * comment here claimed the keystroke path; measurement says otherwise, and a
   * comment that contradicts the measurement sends the next reader past the
   * real cost, which is `allClasses` rescanning the motor DB — cached at
   * source in `motorDb.ts`.)
   *
   * What it does buy: App re-renders for its OWN reasons while the dialog is
   * open — sim progress ticks, notices, autosave — and each of those would
   * otherwise hand the dialog a fresh object and re-walk the tree.
   */
  const assignedMotorDiameters = useMemo(
    () => Object.fromEntries(assigned.map(([id, mm]) => [id, mm.spec.diameter])),
    [assigned],
  );
  // Batch simulate targets the PRIMARY (sustainer) mount; per the owner's rule
  // batch never runs across staged rockets (combinatorics).
  const primaryLabel = primaryMountId ? mountMotors[primaryMountId]?.label : undefined;
  const assignedCount = assigned.length;
  // The strip's Flight item (CFG-SPEC B3): the configuration Launch flies,
  // then its motor; the tooltip names the configuration and every loaded motor.
  // The chooser's own test (isWorkingSettings), so the strip says "Working
  // settings" exactly when the chooser does.
  const flightWorking = isWorkingSettings({ active: !!activeLayer, hasMotors: assignedCount > 0,
    hasUnmatched: Object.keys(unmatchedRefs).length > 0, hasOverrides: detachedHoldsOverrides });
  const flightItem = useMemo(() => flightVitals({
    active: liveActiveLayer, working: flightWorking,
    motors: [...assigned].sort(([a], [b]) => Number(b === primaryMountId) - Number(a === primaryMountId))
      .map(([id, mm]) => ({ mount: mountName(mounts.find((m) => m.id === id)!),
        text: motorTooltip(mountMotors[id] ?? mm, catalogue) })),
  }), [liveActiveLayer, flightWorking, assigned, primaryMountId, mounts, mountMotors, catalogue]);

  // Motor-mount sizes (nominal motor diameter each mount accepts), per stage —
  // surfaced in the Rocket panel and Motors panel so the flyer never has to
  // open the mount tube in the tree to recall what the rocket takes.
  const mountSizes = useMemo(() => mounts.map((m) => {
    const node = findNode(tree, m.id!);
    const stIdx = stageIndexOf(tree, m.id!);
    return {
      id: m.id!,
      size: classLabel(diameterClass(mountDiaMm(node))),
      stage: stageList[stIdx]?.name ?? `Stage ${stIdx + 1}`,
      // Every motor the mount fires, pods and strap-ons included (audit
      // 2026-09-22, row 351) — the same count the mass figures carry.
      count: mountMotorCount(tree, m.id!),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tree.components deliberately: a rename must not re-run this (row 513)
  }), [mounts, tree.components, stageList]);

  /**
   * The series to draw for whatever run the Results tab is showing — the one
   * value every chart/alert gate reads. Either the in-memory flight, when it
   * belongs to this run, or a cached re-flight of it. Null means "this run's
   * report is stored, but nobody has computed its series in this session",
   * which is what the Show-charts button is for.
   */
  const shownResult: FlightResult | null = !lastRun ? null
    : result?.runId === lastRun.id ? result.value
    : reflightCache.get(lastRun.id) ?? null;
  const reportRun = inspectedSummary ?? lastRun;

  // Vitals strip: apogee of the most recent flight (fresh sim or reopened run).
  const lastApogee = shownResult?.summary.maxAltitude ?? lastRun?.maxAltitude ?? null;
  /**
   * Whether the shown flight was flown on a DIFFERENT aerodynamics model than
   * the one now selected. Switching models used to throw the flight away, so
   * this could not arise — but that made comparing the two models impossible,
   * which is what being able to switch them is for. Keeping the flight is only
   * honest if the app says which model produced it.
   *
   * `null` from runMatchesModel means "the run predates the field that would
   * answer this" — unknown is not a mismatch, and old runs must not be accused
   * of a difference we cannot see.
   */
  const modelMatch = lastRun
    ? runMatchesModel(lastRun, { aeroMode, effectiveKbf, autoSupersonic })
    : null;

  /**
   * What has changed since the SHOWN run was flown, against `provenanceKey`
   * (the design as it stands — deliberately not gated on a motor, see there).
   *
   * Selecting a row in Saved simulations loads any stored run into the report —
   * deliberately, because looking at an earlier flight is a real thing to want.
   * But the run list is global and outlives the design, and a change that does
   * not touch the ascent (a parachute's Cd, say) leaves apogee, max velocity and
   * pad mass identical, so every visible column matched and nothing said the
   * numbers were from a different rocket. Meanwhile the far milder aerodynamics
   * MODEL mismatch already got a banner above the tiles. This closes that gap:
   * same treatment, same place, for the bigger discrepancy.
   *
   * `null` when it cannot be told — unknown is not a mismatch.
   */
  const changedSince = useMemo(
    () => (lastRun ? changedSinceRun(lastRun, provenanceKey) : null),
    [lastRun, provenanceKey],
  );
  /**
   * The non-model changes, which is what the new banner reports.
   *
   * The aerodynamics model has had its OWN banner since v0.074 and its own row
   * in the report; `changedSince` still carries it so the report HEADER can be
   * a complete answer on its own (that panel gets screenshotted and forwarded
   * without the banners above it), but repeating it here would be two amber
   * notes saying the same thing.
   */
  const changedSinceNonModel = useMemo(
    () => (changedSince ?? []).filter((c) => c !== AERO_MODEL_CHANGED),
    [changedSince],
  );
  /**
   * The vitals strip's apogee ⚠. It used to mark only a model mismatch — but the
   * strip is the most prominent surface in the app, and `lastApogee` falls back
   * to the stored run, so selecting a saved flight from another rocket put THAT
   * rocket's apogee at the top of the screen unmarked while the report below it
   * carried a warning banner. Any provenance gap earns the mark now.
   */
  const apogeeStale = modelMatch === false || (changedSince?.length ?? 0) > 0;
  /**
   * WHY the ⚠ is there, in one sentence: the strip's tooltip AND, since the ⚠
   * itself is aria-hidden, what a screen reader hears after the number (audit
   * 2026-09-22) — it heard a stale apogee as current on Design and Motors &
   * Launch. Null when the apogee is not stale. The last branch is for a
   * provenance gap that is neither: say the flight may not be this design's,
   * rather than nothing.
   */
  const apogeeStaleWhy = !apogeeStale || !lastRun ? null
    : modelMatch === false
      ? `Apogee of the most recent flight, which was flown on ${aeroModelLabel(lastRun.aeroModel, lastRun.rogersKbf)}. That is not the model now selected. Press Launch to re-fly it.`
      : changedSinceNonModel.length > 0
        ? `Apogee of a flight from ${formatRunWhenProse(lastRun.when)} — ${listAnd(changedSinceNonModel)} changed since. Press Launch to fly the current design.`
        : `Apogee of a flight from ${formatRunWhenProse(lastRun.when)} that may not match the design as it stands. Press Launch to fly the current design.`;

  // "Try Auto & re-fly" from the supersonic-flight alert: once the session
  // override has propagated (aeroMode now 'auto') and the engine handle has
  // been rebuilt with it, fire a fresh launch — or drop the request, if that
  // rebuild left nothing to fly (hooks/useRelaunchLatch, audit 2026-09-22).
  const requestRelaunch = useRelaunchLatch(!!built && !!primaryMountId, onLaunch);

  /**
   * The All-stats drawer, built ONCE and rendered in one of two places: inside
   * the hero stage as an overlay at >= 981px, or as a block under the canvas
   * below that (2026-09-21). One element, so its state, its ref and its
   * Collapse button cannot drift between the two placements.
   */
  const statsDrawerNode = built ? (
    <div className={hero.wide ? 'stats-drawer' : 'stats-drawer stats-drawer-flow'} ref={hero.drawerRef}>
      <div className="stats-drawer-head">
        <span>All stats</span>
        <button className="file-btn" aria-expanded={true} ref={hero.focusRef('collapse')}
          onClick={() => hero.setByUser(false)}>▾ Collapse</button>
      </div>
      <DesignStats
        info={built.info}
        cd={designCd}
        recovery={recovery}
        motorLabel={assigned.length > 1
          ? assigned.map(([, mm]) => mm.label).join(' + ')
          : primaryLabel}
      />
      {lastRun && <FlightLoadStats run={lastRun} />}
    </div>
  ) : null;

  return (
    <div className="viz-root" data-theme={resolvedTheme} data-contrast={daylight ? 'high' : undefined}
      data-tab={tab}>
      <SiteBand nav={mmrNav} source={mmrNavSource} />
      <header className="app-header">
        <div className="app-header-row">
          {/* Wordmark + badge are ONE flex item so a wrap never splits them;
              the cluster (not the badge) now carries the auto margin that
              pushes the buttons right whenever they share its line. */}
          <div className="app-header-brand">
            <h1><Icon name="rocket" size={19} /> MMRocket Sim</h1>
            <button
              className="version-badge"
              title="What's new in this build"
              onClick={() => setShowChangelog(true)}
            >
              v{APP_VERSION} beta
            </button>
            {/* "Am I on the current version?" — the recurring support
                conversation, answered. version.json is deliberately not
                precached, so this always reports what is actually deployed,
                even in a tab running an old cached build. */}
            {/* aria-live on the WRAPPER, which is always present — a live
                region that is itself swapped out announces nothing. And every
                non-stale state renders the SAME button element, so clicking
                "check again" does not destroy the node the user is standing
                on and throw focus back to the document. */}
            <span className="version-check" aria-live="polite">
              {updateState.kind === 'stale' ? (
                <button className="version-update"
                  title={`v${updateState.latest.version}${updateState.latest.released ? ` (released ${updateState.latest.released})` : ''} is deployed. Reload to get it.`}
                  onClick={() => { void reloadForUpdate(); }}>
                  ↻ v{updateState.latest.version} available — Reload
                </button>
              ) : (
                <button className="version-ok"
                  disabled={updateState.kind === 'checking'}
                  title={updateState.kind === 'current'
                    ? 'Checked against what is actually deployed. Click to check again.'
                    : updateState.kind === 'checking'
                    ? 'Checking what is deployed…'
                    // Never a warning, and never a claim that the user is out
                    // of date: an unreachable version.json means offline, a
                    // blocked request, or a dev server — the app's standing
                    // posture for a failed background fetch is to degrade
                    // quietly.
                    : 'Could not reach the server to check — you may be offline. Click to try again.'}
                  onClick={recheckVersion}>
                  {updateState.kind === 'current' ? '✓ Up to date'
                    : updateState.kind === 'checking' ? 'Checking…'
                    : 'Version unknown'}
                </button>
              )}
              {offlineState.kind !== 'unknown' && (
                <span className="offline-status" title={offlineState.detail}>
                  {offlineStatusText(offlineState)}
                </span>
              )}
            </span>
          </div>
          <div className="recent-open-controls">
          <label className="file-btn" title="Open an OpenRocket (.ork), RockSim (.rkt), or RASAero II (.CDX1) design">
            <Icon name="folder" /> Open…
            {/* Visually hidden, NOT display:none — the input must stay in the
                Tab order so the keyboard can reach it (Enter/Space opens the
                picker); the label paints its focus ring via :focus-within. */}
            <input type="file" accept=".ork,.rkt,.CDX1" className="file-btn-input"
              aria-label="Open a design file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Ask before discarding unsaved work (2026-09-01a). The File
                // object stays readable after the input is cleared - the
                // handler below already relied on that, calling the async
                // onOpenOrk and then clearing synchronously - so holding it
                // for the prompt is safe.
                if (f) { if (dirty) setPendingOpen(f); else void onOpenOrk(f); }
                e.target.value = '';
              }} />
          </label>
          <button className="file-btn" onClick={() => setShowRecent(true)}>Recent…</button>
          <button className="file-btn" onClick={() => setShowExamples(true)}>Examples…</button>
          </div>
          <div className="file-menu-wrap">
            {/* A DISCLOSURE button, not a menu button. It used to carry
                aria-haspopup="menu" over a container of plain <button>
                children: a bare button is not an allowed child of
                role="menu", so assistive tech prunes or misreports them —
                the ten export formats, Save .ork included, were announced as
                an empty menu and were effectively pointer-only. Nothing in
                styles.css keys on the role. */}
            <button className="file-btn" onClick={() => setShowFileMenu((v) => !v)}
              aria-expanded={showFileMenu}>
              {/* "Save As": every entry writes a NEW file/download — nothing
                  saves back in place, so the label says what the button does
                  (Eric's ruling, 2026-08-25). */}
              <Icon name="save" /> Save As / Export ▾
            </button>
            {showFileMenu && (
              <>
                {/* The click-away: pointer-only, so presentational, as every
                    dialog's overlay is. Escape is the keyboard's way out
                    (useMenuPopup). */}
                <div className="file-menu-backdrop" role="presentation" onClick={() => setShowFileMenu(false)} />
                <div className="file-menu" role="group" aria-label="Save As / Export"
                  onClick={() => setShowFileMenu(false)}>
                  <button onClick={() => { void onSaveOrk(); }}>Save .ork — OpenRocket design</button>
                  <button onClick={() => { void onCopyShareLink(); }}
                    title="The whole design — components, motors, launch conditions — packed into a link you can paste in chat or email. It opens right in the browser; the design travels in the link itself and never touches a server.">
                    🔗 Copy share link
                  </button>
                  <button onClick={onSaveRkt}
                    title="RockSim design (max 3 stages; clusters split into individual tubes)">
                    Save .rkt — RockSim
                  </button>
                  <button onClick={onSaveCdx1}
                    title="RASAero II design (aero geometry + recovery + launch weight; RASAero needs conical transitions and 3–8 trapezoid fins)">
                    Save .CDX1 — RASAero II
                  </button>
                  <button onClick={() => { void onSaveObj(); }}
                    title="External 3D geometry as a Wavefront OBJ (meters) — print preview / CAD reference">
                    Export .obj — 3D geometry
                  </button>
                  <button onClick={() => { void onSaveGlb(); }}
                    title="Modern 3D model with your component colors (glTF binary, meters) — drops straight into Windows 3D Viewer, PowerPoint, Blender, and web viewers">
                    Export .glb — 3D model with colors
                  </button>
                  <button onClick={() => { void onSaveStl(); }}
                    title="Whole-rocket display shell as binary STL (mm). Reference/display model — NOT watertight; for printable parts use the 🖨 button on a selected component">
                    Export .stl — 3D shell (reference)
                  </button>
                  <button onClick={() => { void download(componentCsv(buildComponentTable()), 'csv', '-components'); }}
                    title="Every component and its attributes as one row per component, in your preferred units — dimensions, materials, and the computed mass/CG/position. For sharing measurement data.">
                    Export .csv — component data
                  </button>
                  <button onClick={() => {
                    const t = buildComponentTable();
                    void download(tableToXlsx(t.headers, t.rows, 'Components'), 'xlsx', '-components');
                  }}
                    title="The same component table as a spreadsheet — typed cells, frozen header, autofilter.">
                    Export .xlsx — component data
                  </button>
                </div>
              </>
            )}
          </div>
          {/* Undo lives in the header so it's reachable from EVERY tab —
              Ctrl+Z has worked globally since v0.013, but nothing advertised
              it outside the Design tab (issue 2026-08-05a #20). */}
          <button className="file-btn" onClick={undo} disabled={!canUndo}
            // audit 2026-10-11, S2-6: crossing a motor answer restores its companion state.
            title="Undo the last change to the design tree (Ctrl+Z) — 50 steps. Motors and launch conditions are not part of undo, except that undoing past an answer to the open-file motor question restores the motors it replaced.">
            ↩ Undo
          </button>
          <button className="file-btn" onClick={redo} disabled={!canRedo}
            title="Redo the change you just undid (Ctrl+Shift+Z or Ctrl+Y) — a new edit clears what is left to redo">
            ↪ Redo
          </button>
          <button className="file-btn" data-tour="guide" onClick={() => setShowGuide(true)} title="User guide — quick start, features, and the physics behind the sim">
            <Icon name="book" /> Guide
          </button>
          {/* Replay lives in the header, not inside the Guide (batch 08-21c). */}
          <button className="file-btn" onClick={tour.start}
            title="Replay the six-step interface tour">
            ⟲ Tour
          </button>
          <div className="file-menu-wrap">
            {/* Disclosure, not a menu — see the Save As button above. This
                popup is the app's only in-product bug-report route, which
                makes it the one a blocked user most needs to reach. */}
            <button className="file-btn" onClick={() => setShowFeedback((v) => !v)}
              aria-expanded={showFeedback}
              title="Report a bug or request a feature — filed on the public tracker; email works too, no account needed">
              <Icon name="bug" /> Feedback
            </button>
            {showFeedback && (
              <>
                <div className="file-menu-backdrop" role="presentation" onClick={() => setShowFeedback(false)} />
                {/* Contract first, hardcoded constants second — see the
                    FEEDBACK_REPO comment. GitHub links open a new tab (the owner's
                    ruling: don't take the user away from the site); the mailto
                    deliberately does NOT, because a mail client launched into a
                    new tab leaves a blank tab behind. */}
                <div className="file-menu feedback-menu" role="group" aria-label="Feedback"
                  onClick={() => setShowFeedback(false)}>
                  <button onClick={() => window.open(
                    withVersionParam(mmrNav.feedback?.bug ?? feedbackIssueUrl('bug-report.yml')),
                    '_blank', 'noopener')}>
                    Report a bug — GitHub
                  </button>
                  <button onClick={() => window.open(
                    mmrNav.feedback?.feature ?? feedbackIssueUrl('feature-request.yml'),
                    '_blank', 'noopener')}>
                    Request a feature — GitHub
                  </button>
                  {/* Safe to concatenate: `parseNav` strips trailing slashes
                      from `feedback.tracker`, so this can never become
                      `…feedback//issues` (which GitHub 404s, dead-ending the
                      only in-app route to the existing-issue list). Keep the
                      normalisation there, at the contract boundary — not here,
                      where every future concatenation site would need its own
                      guard. */}
                  <button onClick={() => window.open(
                    `${mmrNav.feedback?.tracker ?? FEEDBACK_REPO}/issues?q=${encodeURIComponent('is:open label:tool:mmrocket-sim')}`,
                    '_blank', 'noopener')}>
                    Browse open issues
                  </button>
                  <button onClick={() => {
                    const to = mmrNav.feedback?.email ?? FEEDBACK_EMAIL;
                    window.location.href = `mailto:${to}?subject=${encodeURIComponent(`MMRocket Sim v${APP_VERSION} feedback`)}`;
                  }}>
                    Email instead — no account needed
                  </button>
                  <DebugLogDownload />
                </div>
              </>
            )}
          </div>
          {/* One tap, no menus: the field toggle for reading the screen in
              direct sun. Also mirrored in Preferences (Display → Daylight). */}
          <button
            className={`file-btn hc-toggle${daylight ? ' hc-on' : ''}`}
            aria-pressed={daylight}
            onClick={() => setPrefs({ ...prefs, daylight: !daylight })}
            title={daylight
              ? 'Daylight mode is ON — black on white at maximum contrast. Click to go back to your theme.'
              : 'Daylight mode — black on white at maximum contrast, for reading the screen in bright sunlight'}
          >
            <Icon name="sun" /> Daylight
          </button>
          <button className="file-btn" onClick={() => setShowPrefs(true)} title="Preferences">
            <Icon name="sliders" /> Preferences
          </button>
        </div>
        <div className="design-file">
          <span className="design-file-name" title={designFileTitle(designFile)}>{designFileLabel(designFile)}</span>
          <span className={`design-save-status${lossyStatus?.startsWith('Saved as') ? ' design-save-status-lossy' : ''}`} role="status" aria-label="Design save status" aria-live="polite">
            {lossyStatus ?? (dirty ? 'Unsaved changes' : 'No unsaved changes')}
          </span>
          {liveLossReport && (liveLossReport.refused || liveLossReport.losses.length > 0) && (
            <button className={`design-loss-warning message-tier message-${liveLossReport.refused ? 'danger' : 'caution'}`} onClick={() => setLossDialog({ report: liveLossReport, confirm: false })}>
              {liveLossReport.refused ? `\u26a0 Can't be saved as ${formatExtension(liveLossReport.format)}`
                : liveLossReport.incomplete ? `\u26a0 Couldn't fully check this ${formatExtension(liveLossReport.format)}`
                : `\u26a0 ${liveLossReport.losses.length} this ${formatExtension(liveLossReport.format)} can't hold`}
            </button>
          )}
        </div>
        {/* the owner's chosen identity line (2026-08-05b #9) — the per-model detail
            lives in Preferences and the launch report's "Aero model" row. */}
        {fileNoteState?.tier === 'danger' && !fileNoteState.inBar && <Note tier="danger" className="file-operation-note">
          {fileNoteState.text}
          <button className="file-btn" onClick={() => setFileNote(null)} aria-label="Dismiss failed save or export">×</button>
        </Note>}
        <p className="app-tagline">
          Design, simulate, fly — OpenRocket-derived physics, validated to
          Mach&nbsp;4.6 against NASA wind-tunnel data.
          {' '}
          <a
            href="https://github.com/mtnmanak/mmrocket-sim"
            target="_blank"
            rel="noreferrer"
            title="This app is free software under the GPL v3 or later — source code for this build"
          >
            source&nbsp;(GPL)
          </a>
        </p>
        {autosaveFailing && (
          // Persistent (not dismissible) on purpose: while this shows, edits
          // do NOT survive a reload. It clears itself on the recovery edge.
          <Note tier="danger" className="file-note file-note-error autosave-warn" role="alert">
            ⚠ Autosave can&apos;t write (storage full or blocked) — save your
            design to a file (Save As / Export → .ork) to keep it safe.
          </Note>
        )}
        {sessionConflict && (
          // Persistent until answered: until then neither tab's work is at
          // risk, and a × that merely hid it would leave this tab's changes
          // unsaved with nothing on screen to say so.
          <Note tier="caution" className="file-note file-note-error autosave-warn" role="alert">
            ⚠ This design was changed in another tab. This tab has stopped
            autosaving so it does not overwrite that work — changes made here
            are not kept until you choose.{' '}
            <button className="file-btn" onClick={takeOverSession}
              title="Autosave this tab's design over the other tab's. The other tab will then show this same warning.">
              Keep this tab&apos;s design
            </button>{' '}
            <button className="file-btn"
              title="Reload this tab from the autosave, which holds the other tab's design. This tab's unsaved changes are discarded — Save .ork first to keep them."
              onClick={() => { leavingForOtherTab.current = true; window.location.reload(); }}>
              Load the other tab&apos;s design
            </button>
          </Note>
        )}
        {prefsSaveFailing && !autosaveFailing && (
          // Same shape, different store. Shown only when autosave is NOT
          // already shouting — one banner is a diagnosis, two are noise, and
          // the autosave one is the more urgent of the pair.
          <div className="file-note file-note-warn autosave-warn" role="alert">
            ⚠ This browser isn&apos;t keeping your preferences (private window,
            or site data blocked) — units, theme and the tour setting will go
            back to their defaults when you reload.
          </div>
        )}
        {recentNote && <Note tier="caution" role="status" className="recent-storage-note">
          {recentNote} <button className="file-btn" onClick={() => setRecentNote(null)} aria-label="Dismiss recent storage note">Dismiss</button>
        </Note>}
      </header>
      {showPrefs && <PreferencesDialog onClose={() => setShowPrefs(false)} />}
      {showGuide && (
        <LazyDialog label="User guide" className="guide-dialog panel" onClose={() => setShowGuide(false)}>
          <GuideDialog onClose={() => setShowGuide(false)} />
        </LazyDialog>
      )}
      {tour.open && <FirstRunTour onSetTab={setTab} onClose={tour.close} />}
      {showChangelog && (
        <LazyDialog label="Changelog" className="prefs-dialog panel" onClose={() => setShowChangelog(false)}>
          <ChangelogDialog onClose={() => setShowChangelog(false)} />
        </LazyDialog>
      )}
      {showWeather && (
        <WeatherDialog launch={launch} flownAtmosphere={flownAtmosphere}
          initialPlace={weather ? { ...weather.place, timezone: weather.timezone } : null}
          initialHour={showWeather === 'again' && weather
            ? { validUnix: weather.validUnix, timezone: weather.timezone } : null}
          onApply={applyWeather} onClose={() => setShowWeather(false)} />
      )}
      {showScale && (
        <ScaleDialog
          tree={tree}
          assignedMotorDiameters={assignedMotorDiameters}
          {...(() => {
            const padMass = Object.values(mountMotors).some(m => m.padMassKg != null)
              || Object.values(unmatchedRefs).some(m => m.padMassKg != null)
              || savedConfigs.some(c => Object.values(c.motors).some(m => m.padMassKg != null)
                || Object.values(c.unmatchedRefs ?? {}).some(m => m.padMassKg != null));
            return {
              losesMeasurements: measured.massKg !== null || measured.cgM !== null || padMass,
              lossDetail: { massKg: measured.massKg, cgM: measured.cgM, padMass },
            };
          })()}
          onApply={(res) => {
            const scaledConfigs = scaleConfigStageMass(savedConfigs, activeConfigId, tree, res.factor);
            commitTreeStep(res.tree);
            scaleRevision.current = {};
            // A measured mass describes the rocket that was weighed. After a
            // scale it describes one that no longer exists, and the box would
            // report the new design's gap against someone else's scale.
            setMeasured({ massKg: null, cgM: null });
            // The weighed pad mass, for the same reason — on the working set,
            // on every saved configuration's records, and on the unmatched
            // references a file may have left it on (refToExportMotor writes
            // those back, and the pad weight of a rocket that no longer exists
            // must not re-attach on the next open). Identity when none carries
            // one, so a design without a pad mass is untouched.
            setMountMotors((prev) => stripPadMass(prev));
            setUnmatchedRefs((prev) => stripRefPadMass(prev));
            setSavedConfigs(() => {
              const prev = scaledConfigs;
              let changed = false;
              const next = prev.map((c) => {
                const motors = stripPadMass(c.motors);
                const refs = c.unmatchedRefs ? stripRefPadMass(c.unmatchedRefs) : undefined;
                if (motors === c.motors && refs === c.unmatchedRefs) return c;
                changed = true;
                return { ...c, motors, ...(refs ? { unmatchedRefs: refs } : {}) };
              });
              return changed ? next : prev;
            });
            // 'warn' when something needs attention afterwards, so the bar
            // auto-expands. As plain 'info' it stays collapsed showing only the
            // headline - and "the motor no longer fits", which the dialog warned
            // about BEFORE the click, was hidden after it.
            setFileNote(res.notes.join('\n'), res.needsAttention ? 'warn' : 'info');
          }}
          onSaveBackup={() => { void onSaveOrk(); }}
          onClose={() => setShowScale(false)}
        />
      )}
      {/* Gated on having a motor MOUNT, not an assigned MOTOR. Batch simulation
          exists to FIND a motor, so requiring one already loaded was backwards —
          it made the feature unavailable on exactly the designs it is for.
          Reported 2026-09-01b on two single-stage .ork files that carry no motor. */}
      {showBatch && built && mounts.length > 0 && !isStaged && (
        <BatchSimulate
          configurationForMount={targetId => ({
            flightConfig: overrideConfigLabel ?? (flightWorking ? 'working settings' : 'none'),
            ...(activeConfigId !== null ? { flightConfigId: activeConfigId } : {}),
            flightOverrides: recordFlightOverrides(tree, activeOverrides, mountMotors, targetId),
          })}
          overrideSummaryForMount={targetId => describeFlightOverrides(tree, activeOverrides,
            Object.fromEntries(Object.entries(mountMotors).filter(([id]) => id !== targetId)),
            overrideConfigLabel, prefs.units.distance)}
          onShowOverride={showFlightOverride}
          // The Saved simulations export's key, so both exports agree on Status.
          provenance={provenanceKey}
          info={built.info}
          tree={flightTree}
          // Every mount is batchable — a cluster ring around a central mount
          // (the owner's Darkstar) needs the RING selectable, not just the primary.
          mounts={mounts.map((m) => {
            const mNode = findNode(tree, m.id!);
            // Every motor a candidate fires on this mount: the cluster times any
            // enclosing pod set or strap-on ring (audit 2026-09-22, row 351). It
            // feeds the candidate's equivalent stage exit (exitForCandidate), so
            // the cluster alone gave three pods one pod's nozzle.
            const motorCount = mountMotorCount(tree, m.id!);
            return {
              id: m.id!,
              label: `${mountName(m)} (⌀ ${classLabel(diameterClass(mountDiaMm(mNode)))} mm${motorCount > 1 ? ` ×${motorCount}` : ''})`,
              diameterMm: mountDiaMm(mNode),
              motorCount,
              maxMotorLengthM: motorLengthLimit(mNode),
            };
          })}
          // The mount with a motor when there is one; otherwise the first mount,
          // because a design with nothing loaded is the normal starting point.
          initialMountId={primaryMountId ?? mounts[0]!.id!}
          assignedMountMotors={flightState.mountMotors}
          // Flown specs, not catalogue: a weighed motor on a NON-target mount
          // keeps its hardware through the batch's applyOthers; the batch
          // itself shifts only the target mount's matching candidate (weighed).
          assignedMotors={Object.fromEntries(
            Object.entries(flightState.mountMotors).map(([id, mm]) => [id, flownSpec(id, mm.spec, built.hardware)]))}
          // The nozzle-database ids alongside the specs: the database is keyed
          // on the motor's id and a MotorSpec has none, so the sweep needs these
          // to resolve the published exit of every motor firing beside the
          // candidate. The SAME expression nozzleFollow reads: an EX motor
          // carries `exMotorId`, never `motorId`, and reading `motorId` alone
          // (as this did until audit 2026-09-22) left an imported motor out of
          // the sweep's stage sum and kept its row off the exit typed for it.
          assignedMotorIds={batchMotorIds(flightState.mountMotors)}
          // …and their ignition settings, for the same reason: a MotorSpec
          // carries none, and every setMotorById resets the mount to
          // AUTOMATIC. An imported single-stage design can hold a `never` or
          // a delayed mount even though this app shows the control only on a
          // staged design.
          assignedAutoDelays={Object.fromEntries(assigned.map(([id, mm]) => [id, mm.meta.autoDelay === true]))}
          assignedIgnitions={Object.fromEntries(
            Object.entries(flightState.mountMotors).map(([id, mm]) => [id, mm.ignition]))}
          weighed={batchWeighed}
          retainedHardware={batchRetainedHardware}
          launch={launch}
          rocketName={tree.name ?? 'Rocket'}
          onRunsChange={recordRuns}
          onClose={() => setShowBatch(false)}
        />
      )}
      {showExamples && <LazyDialog label="Example designs" className="modal-card example-design-dialog" onClose={() => setShowExamples(false)}>
        <ExampleDesignsDialog onClose={() => setShowExamples(false)} onOpen={file => {
          setShowExamples(false);
          if (dirty) setPendingOpen(file); else void onOpenOrk(file);
        }} /></LazyDialog>}
      {showRecent && <RecentDesignsDialog onClose={() => setShowRecent(false)} onOpen={file => {
        setShowRecent(false);
        if (dirty) setPendingOpen(file); else void onOpenOrk(file);
      }} />}
      <DesignConfirms tree={tree} lossDialog={lossDialog} setLossDialog={setLossDialog} saveLossy={saveLossy}
        unprotected={dirty || flownSinceSave.current} confirmNew={confirmNew} setConfirmNew={setConfirmNew} replaceLoss={replaceLoss} startNewDesign={startNewDesign}
        onSaveOrk={onSaveOrk} pendingOpen={pendingOpen} setPendingOpen={setPendingOpen} onOpenOrk={onOpenOrk}
        shareOffer={shareOffer} setShareOffer={setShareOffer} applyImported={applyImported}
        shroudPrompt={shroudPrompt} setShroudPrompt={setShroudPrompt} hasOpenMotorQuestion={openMotorQuestion !== null}
        onConvertShrouds={() => {
          if (!shroudPrompt) return;
          const res = convertShrouds(tree, shroudPrompt.map((s) => s.id));
          setTree(res.tree);
          setFileNote(res.notes.join('\n'));
          setShroudPrompt(null);
        }}>
      {openMotorQuestion && (
        <OpenMotorDialog key={openMotorQuestion.openId} identities={openMotorQuestion.identities}
          onLater={() => setOpenMotorQuestion(null)}
          onApply={async choices => {
            const { identities, openId } = openMotorQuestion;
            const next = await applyOpenMotorChoices({ tree, mountMotors, savedConfigs, unmatchedRefs }, activeConfigId, identities, choices);
            if (!openSeq.isCurrent(openId)) return;
            // The chosen motor and its back-out are one undo step (audit 2026-10-11, S2-2).
            const spent = reconcileAllIncludedMotors(treeRef.current, attachedSet(next.mountMotors), statedWeightText);
            commitOpenMotorChoices(next, {
              commitStep: () => {
                commitTreeStep(spent.tree);
                motorAnswerRevision.current = {};
              },
              setMountMotors, setSavedConfigs, setUnmatchedRefs,
            });
            setOpenMotorQuestion(null);
            setFileNoteState(prev => {
              if (!prev) return null;
              // @atestani TRF #162, Eric 2026-10-06: edit the CURRENT notice,
              // preserving embedded-EX/storage lines and literal dollars in names.
              // Its group loses the same lines and gains the reconcile's, each
              // keeping its tier (D7 §4).
              const group = withoutLines(groupOf(prev), new Set(openMotorQuestion.acceptedLines));
              return {
                ...prev, text: [...prev.text.split('\n').filter(line => !openMotorQuestion.acceptedLines.includes(line)),
                  ...spent.notes].join('\n'),
                severity: spent.severity === 'warn' ? 'warn' : prev.severity,
                group: { ...group, lines: [...group.lines, ...tierLines(spent.notes, noteFlags(spent.notes))] },
              };
            });
          }} />
      )}
      </DesignConfirms>
      <div className="workspace">
        {/* Always-visible vitals, styled as an instrument readout: the
            tweak-and-refly loop never needs a tab switch to check stability/
            mass or start a flight. The Fly screen is the one exception — it
            IS these numbers, phone-sized, so the strip would be a duplicate. */}
        {tab !== 'fly' && (
        <div className="vitals-strip">
          <span className="vitals-item vitals-item-name" title="Rocket name — edit it in the Design workspace">
            <span className="vitals-label">Rocket</span>
            <span className="vitals-value">{tree.name || 'Rocket'}</span>
          </span>
          {built ? (
            <>
              <span className="vitals-item"
                title="Static stability margin. ✓ = 1–3 cal, △ = over-stable (weathercocks in wind), ⚠ = under-stable. Calibers or % of length: Preferences → Display.">
                <span className="vitals-label">Stability</span>
                {(() => {
                  // A design with no aerodynamic normal force has no margin to
                  // show — see hasAerodynamicForce. Passing null gives the
                  // neutral glyph rather than a green tick.
                  const hasAero = hasAerodynamicForce(built.info);
                  const { glyph, cls, label } = stabilityGlyphClass(
                    hasAero ? shownStability(built.info) : null);
                  return (
                    <span className={`vitals-value ${cls}`}>
                      <span aria-hidden="true">{glyph}</span><span className="sr-only">{label}; stable band 1–3 cal. </span> {hasAero
                        ? formatStability(built.info, prefs.stabilityUnit)
                        : 'no lift yet'}
                    </span>
                  );
                })()}
              </span>
              <span className="vitals-item" title="Mass, loaded (with motors, and any hardware the weighed pad mass carries)">
                <span className="vitals-label">Mass</span>
                <span className="vitals-value">
                  {fmtSi('mass', prefs.units.mass, built.info.mass)}&nbsp;<UnitChip quantity="mass" />
                </span>
              </span>
              {/* RECOVERY WEIGHT, right of the pad weight and on every
                  workspace the strip shows — which includes Motors & Configuration,
                  where the motor gets chosen and therefore where the mass
                  under the chute changes. It is deliberately shown even with
                  no motor loaded, saying "load a motor", because a readout
                  that only appears once you already know to look for it is a
                  readout nobody finds. See services/recoveryMass.ts. */}
              <span className="vitals-item" title={recoveryMassTitle(recovery)}>
                <span className="vitals-label">Recovery</span>
                <span className="vitals-value">
                  {recovery.state === 'ok'
                    ? <>{fmtSi('mass', prefs.units.mass, recovery.mass)}&nbsp;<UnitChip quantity="mass" />{recovery.estimate && ' · estimate'}</>
                    : (
                      <span className="vitals-none">
                        {recovery.state === 'no-motor' ? 'load a motor' : 'n/a'}
                      </span>
                    )}
                </span>
              </span>
            </>
          ) : buildError && (
            <span className="vitals-item" title={buildError}>
              <span className="vitals-label">Build</span>
              <span className="vitals-value stability-bad">⚠ error</span>
            </span>
          )}
          <span className="vitals-item vitals-item-flight" title={flightItem.title}>
            <span className="vitals-label">Flight</span>
            <span className="vitals-value vitals-motor">
              {flightItem.name !== null && <>
                <span className="vitals-flight-name">{flightItem.name}</span>
                <span className="vitals-flight-sep">{' · '}</span>
              </>}
              <span className="vitals-motor-label">
                {primaryLabel ?? <span className="vitals-none">{flightItem.name !== null ? 'no motor' : 'none'}</span>}
              </span>
              {assigned.length > 1 && <span className="vitals-motor-count">{` +${assigned.length - 1}`}</span>}
              {assigned.length > 0 && (
                // One click from ANY tab: strip every loaded motor so the
                // rocket can be viewed/weighed clean (2026-08-05 chat). A
                // labeled button — the bare ⏏ glyph was undiscoverable
                // (batch 08-21c).
                <button className="file-btn vitals-unload"
                  title="Unload all motors — view and weigh the rocket clean (empty mass, no motor silhouettes). Reload any time from Motors & Configuration."
                  onClick={clearConfig}>⏏ Unload</button>
              )}
            </span>
          </span>
          {/* The model, switchable from every workspace that shows the strip.
              It used to be a read-only chip that appeared ONLY when supersonic
              was active, so the model most people fly was never named — and
              changing it meant a trip into Preferences.

              This switch is SESSION-SCOPED and does not write the preference
              (the owner, 2026-08-26): an experiment must not quietly become
              next session's default. Preferences remains the durable setting,
              and choosing there clears this override. */}
          <span className="vitals-item vitals-item-aero"
            title="Which aerodynamics model computes stability, drag and flights. Changing it here applies for this session only — Preferences → Aerodynamics is the setting that persists.">
            <span className="vitals-label">Aero</span>
            <span className="vitals-value">
              <select className="vitals-aero-select"
                aria-label="Aerodynamics model (this session)"
                value={aeroOverride ?? aeroChoiceOf(prefs)}
                disabled={simulating}
                onChange={(e) => setAeroOverride(e.target.value as AeroChoice)}>
                {(['kbf', 'eb', 'auto', 'supersonic', 'hybrid'] as const).map((c) => (
                  <option key={c} value={c}>{AERO_NAME[c]}</option>
                ))}
              </select>
              {effectiveSupersonic && aeroMode === 'auto' && (
                // Auto has upgraded itself on this design — worth saying,
                // because the select still reads "Auto".
                <span className="vitals-aero" title="Auto aero: this design flew past Mach 0.9, so stability, drag analysis and flights use the supersonic model">
                  {' '}M+
                </span>
              )}
              {aeroOverride && aeroOverride !== aeroChoiceOf(prefs) && (
                <button className="vitals-aero-revert" title={`Session override — Preferences is set to ${AERO_NAME[aeroChoiceOf(prefs)]}. Click to go back to it.`}
                  aria-label={`Clear the session aero override and use ${AERO_NAME[aeroChoiceOf(prefs)]}`}
                  onClick={() => setAeroOverride(null)}>↺</button>
              )}
            </span>
          </span>
          {lastApogee !== null && (
            <span className="vitals-item"
              title={apogeeStaleWhy ?? 'Apogee of the most recent flight'}>
              <span className="vitals-label">Apogee</span>
              <span className="vitals-value">
                {fmtSi('distance', prefs.units.distance, lastApogee)}&nbsp;<UnitChip quantity="distance" />
                {/* A model switch no longer throws the flight away — so the
                    number has to say when it belongs to a different model,
                    rather than being silently re-labelled under the new one. */}
                {apogeeStaleWhy && (
                  <>
                    {/* "previous flight" in words beside the number (D7 §5, R04);
                        the sr-only sentence below carries the same fact. */}
                    <span className="vitals-stale" aria-hidden="true"> ⚠ previous flight</span>
                    <span className="sr-only">{` — warning: ${apogeeStaleWhy}`}</span>
                  </>
                )}
              </span>
            </span>
          )}
          <button
            aria-describedby={launchOverrideSummary ? 'launch-override-vitals' : undefined}
            className="launch-btn vitals-launch"
            data-tour="launch"
            onClick={onLaunch}
            disabled={!built || !primaryMountId || simulating || nozzlePending}
            title={savedConfigs.find(c => c.id === activeConfigId)?.motorLoadoutRefusal ?? (nozzlePending ? 'Updating the nozzle for this motor before launch'
              : !primaryMountId ? 'Assign a motor first (Motors & Configuration workspace)' : 'Simulate the flight')}
          >
            {simulating ? 'Simulating…' : <><Icon name="rocket" size={15} /> Launch</>}
          </button>
          <LaunchOverrideWarning id="launch-override-vitals" summary={launchOverrideSummary}
            onShow={showFlightOverride} compact />
        </div>
        )}

        {/* A NAV with aria-current, not a tablist (audit 2026-09-22) — the
            same call DragPanel made for its toggles on 2026-09-08. A tablist
            promises tabpanels, aria-controls, one tab stop and arrow keys, and
            this had none of them: NVDA announced "tab 1 of 3" (Fly is hidden on
            a desktop) and Right Arrow then did nothing on the main navigation.
            The workspaces are whole
            pages — each has its own <main> — so "current page" is what these
            buttons really are, and Tab reaches every one of them. */}
        <nav className="workspace-tabs" aria-label="Workspace">
          <button aria-current={tab === 'fly' ? 'page' : undefined}
            className={`tab-fly${tab === 'fly' ? ' active' : ''}`} onClick={() => setTab('fly')}>
            <Icon name="flame" size={13} /> Fly
          </button>
          <button aria-current={tab === 'design' ? 'page' : undefined}
            className={tab === 'design' ? 'active' : ''} onClick={() => setTab('design')}>
            <Icon name="wrench" size={13} /> Design
          </button>
          <button aria-current={tab === 'motors' ? 'page' : undefined} data-tour="motors-tab"
            className={tab === 'motors' ? 'active' : ''} onClick={() => setTab('motors')}>
            <Icon name="flame" size={13} /> Motors &amp; Configuration
          </button>
          <button aria-current={tab === 'results' ? 'page' : undefined}
            className={tab === 'results' ? 'active' : ''} onClick={() => setTab('results')}>
            <Icon name="chart" size={13} /> Results
          </button>
        </nav>

        {sessionNote && (
          <p className={`session-note${sessionNoteFading ? ' fading' : ''}`}>{sessionNote}</p>
        )}

        {tab === 'fly' && (
          <FlyScreen
            configs={liveConfigs} activeConfigId={activeConfigId}
            // THE shared test (flightState.isWorkingSettings), the one the tab's
            // chooser and the strip read, unresolved motor references included —
            // so None can be chosen here exactly as on the tab (review of b9-int).
            hasWorkingSettings={flightWorking}
            onApplyConfig={applyConfig} onClearConfig={clearConfig}
            overrideSummary={launchOverrideSummary} onShowOverride={showFlightOverride}
            tree={tree}
            info={built?.info ?? null}
            run={lastRun}
            motorLabel={primaryLabel
              ? `${primaryLabel}${assigned.length > 1 ? ` +${assigned.length - 1}` : ''}`
              : null}
            launch={launch}
            onLaunchChange={setLaunch}
            onLaunch={onLaunch}
            simulating={simulating}
            recovery={recovery}
            canLaunch={!!built && !!primaryMountId && !nozzlePending}
            onChangeMotor={() => { setFlyMountTarget(primaryMountId ?? mounts[0]?.id ?? null); setTab('motors'); }}
            onCompare={() => setShowBatch(true)}
            canCompare={!!built && !!primaryMountId && !isStaged}
            staleModel={modelMatch === false && lastRun
              ? aeroModelLabel(lastRun.aeroModel, lastRun.rogersKbf) : null}
            // The same provenance the vitals strip's ⚠ and the Results note
            // read — this screen replaces the strip on a phone.
            changedSince={changedSinceNonModel}
            onGetWeather={() => setShowWeather('get')}
            weather={weather}
          />
        )}

        {tab === 'design' && (
        <div className="design-layout">
        <aside>
          <div className="panel" data-tour="tree">
            <div className="panel-head">
              <h2 style={{ flex: 1 }}>Components</h2>
              <button
                className="file-btn"
                title="Clear all components and start from scratch"
                onClick={() => {
                  // Same test as Open: a design that is already on disk (or a
                  // starter rocket nobody has touched) has nothing to lose, and
                  // a confirmation that always fires is one people learn to
                  // click through - which is how the one that MATTERS gets
                  // dismissed.
                  if (dirty) setConfirmNew(true);
                  else startNewDesign();
                }}
              >
                ✕ New
              </button>
              <button
                className="file-btn"
                title="Scale the whole design by one factor - every length, diameter and position (Ctrl+Z undoes it in one step)"
                onClick={() => setShowScale(true)}
              >
                ⤢ Scale…
              </button>
              <button className="file-btn" onClick={undo} disabled={!canUndo}
                title="Undo the last design-tree change (Ctrl+Z). Undoing past an answer to the open-file motor question restores the motors it replaced.">↩ Undo</button>
              <button className="file-btn" onClick={redo} disabled={!canRedo}
                title="Redo (Ctrl+Shift+Z or Ctrl+Y)">↪ Redo</button>
            </div>
            <div className="field" style={{ marginBottom: 8 }}>
              {/* Wired (audit 2026-09-22): the label reached nothing, so the box
                  announced as "edit, <the design's name>", or "edit, blank". */}
              <label htmlFor="rocket-name">Rocket name</label>
              <input id="rocket-name" value={tree.name ?? ''} onChange={(e) => setTree({ ...tree, name: e.target.value })} />
            </div>
            <ComponentTree
              treeElementRef={treeElementRef}
              tree={tree}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId(id || null)}
              onMove={(id, dir) => setTree(moveNode(tree, id, dir))}
              onDelete={(id) => {
                // Never delete the last stage — an empty top level breaks the
                // "components are always stage nodes" invariant until reload.
                const stageList = stages(tree);
                if (stageList.length === 1 && stageList[0]!.id === id) return;
                setTree(removeNode(tree, id));
                if (selectedId === id) setSelectedId(null);
              }}
              onDuplicate={(id) => {
                const { tree: next, newId } = duplicateNode(tree, id);
                setTree(next);
                if (newId) setSelectedId(newId);
              }}
              clipboard={clipboard}
              onCopy={(id) => {
                const n = findNode(tree, id);
                if (n) setClipboard(n);
              }}
              onCut={(id) => {
                const n = findNode(tree, id);
                if (!n) return;
                setClipboard(n);
                setTree(removeNode(tree, id));
                if (selectedId === id) setSelectedId(null);
              }}
              onPaste={(parentId) => {
                if (!clipboard) return;
                // Fresh ids at every level — pasting twice must never collide.
                const copy = cloneSubtree(clipboard);
                setTree(addChild(tree, parentId, copy));
                setSelectedId(copy.id!);
              }}
              onAdd={(parentId, type: ComponentType) => {
                // services/addComponent.ts: inherited diameter/material/finish,
                // interleaved fin sets, and a new rail button as an auto-placed
                // pair — ONE tree write, so one Ctrl+Z removes the new part.
                // A rail button's pair is placed on the design it lands in,
                // built exactly as the build memo builds it (same motors,
                // weighing and model flags), so its CG is the one the panel's
                // Auto-place reads. The reset is a no-op: resetting would
                // invalidate `built.rocket`, which a flight may hold; these
                // handles go at the memo's next build.
                const measure = (t: RocketTree) => {
                  const b = buildDesign(designBuildInputOf({
                    tree: resolveFlightState(t, [], null, activeOverrides, mountMotors).tree, assigned, effectiveKbf, effectiveSupersonic, hybrid: effectiveHybrid,
                    measuredDryMassKg: measured.massKg, primaryMountId, currentSetKey,
                  }), { reset: () => {}, build: KERNEL_HANDLES.build });
                  if ('error' in b) return null;
                  return {
                    rocketLength: b.info.length,
                    cg: b.info.cg,
                    stationOf: (id: string) => {
                      try { return b.rocket.componentInfo(id).positionX; } catch { return undefined; }
                    },
                  };
                };
                const { tree: next, node } = addNewComponent(tree, parentId, type, measure);
                setTree(next);
                setSelectedId(node.id!);
              }}
              onAddStage={() => {
                const { tree: next, newId } = addStage(tree);
                setTree(next);
                setSelectedId(newId);
              }}
            />
          </div>
          {/* Under the tree, because it is a build-time task rather than a
              design-time one: you come back to it with a scale in your hand. */}
          {built && bare && (
            <MeasuredMassBox
              bareMassKg={bare.massKg}
              bareCgM={bare.cgM}
              rocketLengthM={built.info.length}
              hasAllowance={!!allowanceNode}
              measured={measured}
              onChange={setMeasured}
              onApply={applyAllowance}
              onRemove={() => {
                if (!allowanceNode?.id) return;
                setTree(removeNode(tree, allowanceNode.id));
                if (selectedId === allowanceNode.id) setSelectedId(null);
              }}
              blockedBy={allowanceBlocker}
              onPinStage={allowanceBlocker && canPinBlocker ? pinBlockerToMeasured : undefined}
            />
          )}
        </aside>

        <main>
          {/* S1 (batch 08-21c): the canvas IS the center column now — it
              flexes to the viewport, the stat grid lives in a drawer overlay,
              and the five constants float in a chip on the canvas sky. */}
          <div className="panel hero-panel">
            <div className="panel-head">
              <h2 style={{ flex: 1 }}>Rocket</h2>
              {view === '2d' && (
                <button className={`file-btn${vert2d ? ' hc-on' : ''}`} aria-pressed={vert2d}
                  title="Rotate the drawing 90° — nose up, the way it sits on the pad (viewing mode: drag and zoom pause while rotated)"
                  onClick={() => setVert2d((v) => !v)}>⟳ 90°</button>
              )}
              {/* Toggle buttons in a named group, not tabs — see the workspace
                  nav above and DragPanel's CP toggle (audit 2026-09-22). */}
              <div className="view-toggle" role="group" aria-label="Drawing view">
                <button className={view === '2d' ? 'active' : ''}
                  aria-pressed={view === '2d'} onClick={() => setView('2d')}>2D</button>
                <button className={view === '3d' ? 'active' : ''}
                  aria-pressed={view === '3d'} onClick={() => setView('3d')}>3D</button>
                <button className={view === 'aft' ? 'active' : ''}
                  title="Looking at the rocket from behind — clusters, pods and fin counts as they really sit"
                  aria-pressed={view === 'aft'} onClick={() => setView('aft')}>Aft</button>
              </div>
            </div>
            {/* data-vert raises the stage's height cap in ⟳90° mode ONLY:
                there the container's height is the rocket's length axis, so
                height buys drawing rather than empty sky (styles.css). It is
                gated on view === '2d' as well, because vert2d persists while
                the user is on 3D/Aft — where the taller cap would just be
                letterbox. */}
            <div className="rocket-stage hero-stage" data-tour="canvas"
              data-view={view}
              ref={hero.stageRef}
              data-vert={view === '2d' && vert2d ? 'on' : undefined}
              // Fit-to-content sizing for a horizontal 2D drawing only — 3D and
              // Aft have no natural height (hooks/useHeroDrawer.ts heroStageStyle).
              style={view === '2d' && !vert2d ? hero.stageStyle : undefined}>
              {/* .hero-view owns fill-and-center: the drawing must never size
                  its own container (see the styles.css note on the feedback
                  loop), and the schematic wrap carries inline positioning of
                  its own, so the absolute box has to be ours. */}
              <div className="hero-view" style={hero.clearance ? { bottom: hero.clearance } : undefined}>
                {view === '2d'
                  ? (
                    <TreeSchematic
                      tree={tree}
                      info={built?.info ?? null}
                      motors={motorDims}
                      onPatchNode={(id, patch) => setTree(updateNode(tree, id, patch))}
                      selectedId={selectedId}
                      onSelect={(id) => setSelectedId(id)}
                      exportData={viewExportData}
                      onError={setHeroExportFailure}
                      vertical={vert2d}
                      fillHeight
                      onNaturalHeight={hero.setNatural}
                      // Spend the chip's headroom above the rocket instead of
                      // letting centring split it in half. Only in horizontal
                      // 2D: ⟳90° draws the rocket along the height axis, where
                      // there is no "above" to reserve.
                      topReserve={vert2d ? 0 : HERO_CHIP_RESERVE}
                      roll={viewRoll}
                      onRoll={setViewRoll}
                    />
                  )
                  : view === '3d'
                  ? (
                    // Boundary OUTSIDE the Suspense on purpose: that is what
                    // makes a lazy chunk that fails to DOWNLOAD land here too.
                    <View3DBoundary onBack={() => setView('2d')}>
                      <Suspense fallback={<div className="hero-loading">Loading 3D view…</div>}>
                        <Rocket3D tree={tree} info={built?.info ?? null} motors={motorDims} exportData={viewExportData}
                          onError={setHeroExportFailure} />
                      </Suspense>
                    </View3DBoundary>
                  )
                  : <AftView tree={tree} motors={motorDims} roll={viewRoll} onRoll={setViewRoll} />}
              </div>
              {built && <StatsChip info={built.info} drawerOpen={hero.open} tight={hero.tight} />}
              {/* THE DRAWER IS AN OVERLAY ONLY WHERE IT CAN AFFORD TO BE
                  (2026-09-21). At >= 981px the stage has a height and the
                  drawing is lifted clear of the drawer; below that the stage
                  has no height at all, the inline lift is inert, and the
                  drawer simply painted over the rocket. There it renders as a
                  BLOCK under the canvas instead — a sibling of the stage, so
                  it is outside the stage's border and drafting-grid sky
                  rather than a white card floating on it. Same element, same
                  state, same buttons; only where it sits changes. */}
              {built && (hero.open
                ? (hero.wide ? statsDrawerNode : null)
                : (
                  // aria-expanded on both halves of the drawer's disclosure
                  // (audit 2026-09-22): this one only shows while it is shut,
                  // and a press hands focus across — see useHeroDrawer.
                  <button className="file-btn stats-drawer-chip" aria-expanded={false} ref={hero.focusRef('chip')}
                    onClick={() => hero.setByUser(true)}
                    title="Every design stat, with unit switches">▤ All stats</button>
                ))}
              {mountSizes.length > 0 && (
                <div className="mount-sizes hero-mounts" title="Motor mount inner diameter — the nominal motor size each mount accepts">
                  <span className="mount-sizes-label">
                    Motor mount{mountSizes.length > 1 ? 's' : ''}:
                  </span>
                  {mountSizes.map((s) => (
                    <span key={s.id} className="mount-size-chip">
                      {isStaged ? `${s.stage} · ` : ''}⌀&nbsp;{s.size}&nbsp;mm{s.count > 1 ? ` ×${s.count}` : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
            {built && <ConfigStabilityRange input={stabilityRangeInput} />}
            {built && hero.open && !hero.wide && statsDrawerNode}
            {built && built.info.warningTexts.length > 0 && (() => {
              // Rail-line findings are a mechanical fit problem on the pad, not an
              // aerodynamic footnote or a failed flight (D7 §5, R08): their own
              // block, each with the parts it names one click away, where the
              // rail button's snap controls are. The same sentences buildDesign
              // appended, matched by identity, so nothing is said twice.
              const railFindings = railInterferenceFindings(tree);
              const railTexts = new Set(railFindings.map(f => f.text));
              const rest = built.info.warningTexts.filter(t => !railTexts.has(t));
              return <div id="design-notes" tabIndex={-1}>
                {(['danger', 'caution', 'information'] as const).map(tier => {
                  const texts = rest.filter(t => staticWarningTier(t) === tier);
                  return texts.length ? <Note key={tier} tier={tier} className="file-note" role="alert">
                    {texts.map((text, i) => <div key={i}><StaticWarning text={text} /></div>)}
                  </Note> : null;
                })}
                {railFindings.length > 0 && (
                  <Note tier="information" className="file-note rail-fit-findings" role="alert">
                    <strong>Rail fit on the pad</strong> (the parts&rsquo; angles; no flight number changes):
                    <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                      {railFindings.map(f => <li key={f.text}>
                        {f.text}{' '}
                        {f.parts.filter(p => p.id).map(p => (
                          <button key={p.id} type="button" className="finish-all-btn"
                            onClick={() => setSelectedId(p.id)}>Select “{p.name}”</button>
                        ))}
                      </li>)}
                    </ul>
                  </Note>
                )}
              </div>;
            })()}
            <PreflightAudit result={designAudit} onSelectPart={setSelectedId} />
          </div>
          {/* Drag analysis is a property of the geometry, so it sits under the
              rocket on Design (CFG-SPEC B2, ruling D5), collapsed until asked
              for; its open state lasts the session (the sweep costs ~3 aero
              solves per Mach step, so it never opens itself on a reload). */}
          {built && (
            <PanelBoundary what="The drag chart" resetKey={built}>
              <DragPanel rocket={built.rocket} supersonicModel={effectiveSupersonic || aeroMode === 'hybrid'} hybridModel={aeroMode === 'hybrid'}
                aeroLabel={currentModelLabel({ aeroMode, effectiveKbf, autoSupersonic })}
                designName={tree.name} fileMachAlt={fileMachAlt}
                open={dragOpen} onOpenChange={setDragOpen} />
            </PanelBoundary>
          )}
        </main>

        <aside className="design-props">
          {selectedNode ? (
            <PropertyPanel
              // Keyed by the component, so nothing the panel holds for one part
              // — an in-progress field, the export note, a slider's frozen drag
              // range — is inherited by the next one selected (audit
              // 2026-09-22: tube A's mass-override draft once committed onto
              // tube B through this very element).
              key={selectedNode.id}
              tree={tree}
              node={selectedNode}
              // Deployment, separation and nozzle exit are read-only here;
              // their one editor is on Motors & Configuration (ruling D2a).
              flight={{
                overrides: activeOverrides, configLabel: overrideConfigLabel, detached: detachedOwnsOverrides,
                onOpenPart: (id) => showOnConfigTab(id, selectedNode.type === 'parachute' || selectedNode.type === 'streamer' ? 'recovery' : 'separation'),
                onOpenNozzle: (id) => showOnConfigTab(id, 'nozzle'),
                nozzleEditable: nozzleEditableIds,
              }}
              info={selectedInfo}
              rocketInfo={built?.info ?? null}
              onPatch={(patch) => setTree(updateNode(tree, selectedNode.id!, patch))}
              onPatchAll={(patch) => setTree(updateAllNodes(tree, patch))}
              onAutoAlignFins={() => {
                const res = autoAlignFinSets(tree);
                if (res.changes.length) {
                  setTree(res.tree);
                  setFileNote(res.changes.join('\n'));
                } else {
                  setFileNote('Fin sets already sit at their widest clearance — nothing to rotate.');
                }
              }}
            />
          ) : (
            <div className="panel placeholder empty-state">
              <Icon name="wrench" size={22} />
              <p>Select a component in the tree to edit its properties here.</p>
            </div>
          )}
          {/* Recovery sizing lives in the RIGHT column, under the component
              properties, and NOT beside the tree where it shipped in v0.104:
              there it pushed the measured-mass box below the fold (owner,
              2026-09-04). It renders whether or not a component is selected,
              because it is a fact about the whole rocket, and it collapses to a
              one-line summary because this column is already the long one. */}
          <RecoverySizingPanel
            flownAtmosphere={flownAtmosphere}
            recovery={recovery}
            byStage={recoveryByStage}
            tree={flightTree}
            launch={launch}
            deviceMass={componentMass}
          />
        </aside>
        </div>
        )}

        {/* <main>, like every other workspace (audit 2026-09-22): landmark
            navigation found nothing on this tab. */}
        {tab === 'motors' && (
        <main className="motors-layout">
          <ConfigPanel deletionUnprotected={dirty || !!replaceLoss} configs={liveConfigs} tree={tree} motors={mountMotors} unmatchedRefs={unmatchedRefs} detachedOverrides={detachedOverrides}
            activeConfigId={activeConfigId} hasMotors={assigned.length > 0}
            onApply={applyConfig} onClear={clearConfig} onCreate={createConfig} onDuplicate={duplicateFlightConfig}
            onRename={renameFlightConfig} onDelete={deleteFlightConfig}
            onResetOverrides={() => commitActiveOverrides({ deployments: {}, separations: {}, ignitions: {} })} />
          <div className="panel motors-schematic">
            <h2>Rocket — motors drawn to scale</h2>
            <div className="rocket-stage" data-view="2d">
              <TreeSchematic
                tree={tree}
                info={built?.info ?? null}
                motors={motorDims}
                onPatchNode={(id, patch) => setTree(updateNode(tree, id, patch))}
                maxHeight={300}
                selectedId={selectedId}
                onSelect={(id) => setSelectedId(id)}
                roll={viewRoll}
                onRoll={setViewRoll}
              />
            </div>
            {/* The end-on view, always. It went in as a cluster/pod inset
                (issue #13) and was gated on the design having one — but fin
                count, fin clocking and motor fit read from behind on any
                rocket, and the roll slider it shares with the side view gives
                it a job on a plain 3FNC too (owner, 2026-08-30). */}
            {(() => {
              const hasRadial = (nodes: ComponentNode[]): boolean => nodes.some((n) =>
                (n.type === 'innertube' && typeof n['cluster'] === 'string' && n['cluster'] !== 'single')
                || n.type === 'podset' || n.type === 'parallelstage'
                || hasRadial(n.children ?? []));
              return (
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginTop: 8 }}>
                  <div className="rocket-stage" style={{ flex: '0 1 300px' }}>
                    <AftView tree={tree} motors={motorDims} roll={viewRoll} onRoll={setViewRoll} />
                  </div>
                  <p className="comp-stats" style={{ margin: '4px 0', maxWidth: 260 }}>
                    {hasRadial(tree.components)
                      ? `Aft view — the cluster / pod layout seen from behind, at the
                         current layout, rotation and spacing settings.`
                      : `Aft view — the rocket from behind: fin count and clocking as they
                         really sit, and the motor in its mount. The roll slider turns it
                         with the side view above.`}
                  </p>
                </div>
              );
            })()}
          </div>

          <div className="panel">
            <h2 ref={motorsHeading} tabIndex={-1}>Motors</h2>
            {mounts.length === 0 && (
              <p className="stability-bad" style={{ fontSize: 12 }}>
                No motor mount — add an inner tube, or check “Motor mount” on a body tube (minimum-diameter).
              </p>
            )}
            {stageList.map((st, stIdx) => {
              const stMounts = mounts.filter((m) => stageIndexOf(tree, m.id!) === stIdx);
              const stNozzles = nozzleStages({ ...tree, components: [st] })
                .filter((s) => s.id && (nozzleEditableIds.has(s.id) || nozzleHeld.has(s.id)));
              // A stage with no mount still lists a nozzle value it carries, so
              // its one editor can clear it (CFG-SPEC A4).
              if (stMounts.length === 0 && stNozzles.length === 0) return null;
              const stName = st.name ?? `Stage ${stIdx + 1}`;
              return (
                <div key={st.id}>
                  {isStaged && <div className="motor-stage-header">{stName}</div>}
                  <div className="field" style={{ marginBottom: 8 }}>
                    {/* The nozzle exit diameter, beside the motor it belongs to
                        (Eric, 2026-09-08b: he went looking for it here and it
                        was on the stage in the Property Panel). Still the SAME
                        stage field — this is a second view of it, not a second
                        value — and it fills itself in from AeroTech's published
                        drawings with the provenance shown. */}
                    {stNozzles.map((nozzleStage) => {
                      const loadout = stageMotorLoadout.find((s) => s.stageId === nozzleStage.id)?.motors ?? [];
                      return <div key={nozzleStage.id}
                        onFocus={() => holdNozzle(nozzleStage.id!, true)}
                        onBlur={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) holdNozzle(nozzleStage.id!, false);
                        }}>
                        {nozzleStage.type === 'parallelstage' && <div className="motor-stage-header">{nozzleStage.name ?? 'Strap-on'}</div>}
                        <NozzleField
                          inputId={`cfg-nozzle-${nozzleStage.id!}`}
                          stageName={nozzleStage.name ?? stName}
                          parallel={nozzleStage.type === 'parallelstage'}
                          exitDiameterM={numOrNull(nozzleStage, 'nozzleExitDiameter')}
                          motors={loadout}
                          motorLabel={loadout[0]?.label ?? null}
                          clearedFor={nozzleCleared[nozzleStage.id!] ?? null}
                          onCommit={(m) => setTree(applyStageNozzles(treeRef.current, { [nozzleStage.id!]: m }))}
                          onAutoFill={(m) => writeTree(applyStageNozzles(treeRef.current, { [nozzleStage.id!]: m }))}
                        />
                      </div>;
                    })}
                  </div>
                  {stMounts.map((m) => {
              const mm = flightState.mountMotors[m.id!];
              const mNode = findNode(tree, m.id!);
              // Pods and strap-ons included (audit 2026-09-22, row 351): the
              // label and the pad-mass card's multi-motor wording follow the
              // count the mass figures carry, not the cluster alone.
              const count = mountMotorCount(tree, m.id!);
              const countNote = mountCountNote(tree, m.id!);
              // Every loaded mount has its own Auto policy and flown evidence.
              const autoBox = autoDelayBox(tree, m.id!);
              // The fallback — an earlier flight's Auto delay on this mount — is
              // THIS design and mount's motor alone, including saved batch candidates.
              // The run list is global and mount ids are
              // counter values every load mints afresh, so a match on the id put
              // another design's "Previous flight" under this motor (audit
              // 2026-09-30).
              const delayRun = runs.find((r) => runMatchesDesign(r, provenanceKey)
                && resolutionMatchesPolicy(r.delayResolution, flownDelayMounts))
                ?? runs.find((r) => r.designKey === provenanceKey.designKey
                  && (typeof r.motorDataKeys === 'object' && r.motorDataKeys !== null && !Array.isArray(r.motorDataKeys)
                    ? r.motorDataKeys[m.id!] !== undefined
                      && r.motorDataKeys[m.id!] === provenanceKey.motorDataKeys?.[m.id!]
                    : r.motorDataKey === undefined || r.motorDataKey === provenanceKey.motorDataKey)
                  && validDelayResolution(r.delayResolution)
                  && r.delayResolution.mounts.some((d) => d.mountId === m.id && d.mode === 'auto'
                    // Matching fingerprints or the whole motor-set key establish the motor.
                    // Only a historical record without those needs the evidence identity.
                    && (r.motorDataKeys?.[m.id!] !== undefined
                      || r.motorDataKey !== undefined || r.motorSetKey === provenanceKey.motorSetKey
                      || d.motorIdentity === flownDelayMounts.find((mount) => mount.mountId === m.id)?.motorIdentity)));
              const delayCurrent = !!delayRun && runMatchesDesign(delayRun, provenanceKey)
                && resolutionMatchesPolicy(delayRun.delayResolution, flownDelayMounts);
              return (
                <div key={m.id} id={m.id ? `cfg-mount-${m.id}` : undefined} tabIndex={-1} className="mount-card" style={{ marginBottom: 10, paddingTop: 6, borderTop: '1px solid var(--border, #333)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    {/* The card's title, not a <label>: it names no control
                        (audit 2026-09-30). */}
                    <span className="mount-card-title" style={{ flex: 1, fontWeight: 600 }}>
                      {mountName(m)}
                      <span className="mount-size-inline">⌀&nbsp;{classLabel(diameterClass(mountDiaMm(mNode)))}&nbsp;mm</span>
                      {countNote && ` (${countNote})`}
                    </span>
                    {mm && (
                      <button className="fin-row-del" title="Remove this motor"
                        // Named, not "multiplication x" (audit 2026-09-22).
                        aria-label={`Remove ${mm.label} from ${mountName(m)}`}
                        onClick={() => {
                          motorChoices.current.delete(m.id!);
                          setMountMotors((prev) => {
                            const next = { ...prev };
                            delete next[m.id!];
                            return next;
                          });
                          // An emptied mount stays empty across a reload: the
                          // active configuration's stored reference for it (a
                          // v0.117 session kept one beside the motor assigned
                          // over it) would otherwise be seeded back and saved.
                          setSavedConfigs((prev) => withoutStoredRef(prev, activeConfigId, m.id!));
                        }}>✕</button>
                    )}
                  </div>
                  {/* Read-only: the limit belongs to the physical mount and is
                      edited, with its Estimate, on Design (CFG-SPEC A4). */}
                  <MotorLengthReadout mountName={mountName(m)} value={motorLengthLimit(mNode)}
                    noBore={mNode ? noBoreReason(mNode) : null}
                    onOpenDesign={() => showMotorLengthOnDesign(m.id!)} />
                  <MotorPicker
                    recoveryAdviceFor={(delay, auto) => {
                      // N003: replacement resets the motor's ignition; only mount/config layers survive.
                      const ignition = overrideFor(activeOverrides.ignitions, m.id!)
                        ?? overrideFor((tree as FlightTree).ignitionDefaults, m.id!);
                      return ignition?.event === 'never' ? null : zeroDelayRecoveryAdvice(flightTree, m.id!, delay, auto);
                    }}
                    mountDiameterMm={mountDiaMm(mNode)}
                    maxMotorLengthM={motorLengthLimit(mNode)}
                    selectedLabel={mm?.label ?? ''}
                    beginSelection={() => beginMotorChoice(m.id!)}
                    onSelect={(label, spec, meta) => assignMotor(m.id!, label, spec, meta)}
                    loadedMotors={Object.values(mountMotors).map((x) => ({ label: x.label, manufacturer: x.meta.manufacturer, motorId: x.meta.motorId }))}
                    showQuickPicks={quickPicksOffered}
                    primaryControlId={`cfg-mount-${m.id!}-motor`}
                  />
                  <div className="zero-delay-recovery" role="status">
                    {mm && mm.ignition?.event !== 'never' && zeroDelayRecoveryAdvice(flightTree, m.id!, mm.spec.ejectionDelay, mm.meta.autoDelay) && (
                      <Note tier="caution" as="p" className="comp-stats">
                        {zeroDelayRecoveryAdvice(flightTree, m.id!, mm.spec.ejectionDelay, mm.meta.autoDelay)}
                      </Note>
                    )}
                  </div>
                  {mm && (
                    <div className="field" style={{ marginTop: 6 }}>
                      {/* Tied to its box (audit 2026-09-30), which keeps the
                          name that says which mount, as Max motor length's does. */}
                      <label htmlFor={`ejection-delay-${m.id!}`}>
                        Ejection delay (s)
                        {mm.meta.availableDelays?.length
                          ? ` — prescribed: ${mm.meta.availableDelays.map((d) => (Number.isFinite(d) ? d : 'P')).join(', ')}`
                          : ''}
                      </label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ flex: 1 }}>
                          <NumField
                            id={`ejection-delay-${m.id!}`}
                            // A plugged motor has no numeric delay — blank the
                            // field (it used to render the literal "Infinity").
                            value={Number.isFinite(mm.spec.ejectionDelay) ? mm.spec.ejectionDelay : undefined}
                            step={1}
                            max={60}
                            placeholder={Number.isFinite(mm.spec.ejectionDelay) ? undefined : 'plugged'}
                            // The card heading's own fallback: never the internal id (audit 2026-09-30).
                            ariaLabel={`Ejection delay for ${mountName(m)}`}
                            onCommit={(v) => {
                              if (v === null) return;
                              // Typing a delay overrides auto (mountDelayEdits).
                              // Edit the raw record, never bake a resolved ignition override
                              // into its default (audit 2026-10-11, FC-4 fixup).
                              setMountMotors((prev) => ({ ...prev, [m.id!]: withDelay(prev[m.id!]!, v) }));
                            }}
                          />
                        </div>
                        <label className="motor-inline-label" style={{ whiteSpace: 'nowrap' }}
                          title="No ejection charge (removed for electronic deployment, or a factory -P motor). Recovery must deploy on apogee/altitude.">
                          <input
                            type="checkbox"
                            checked={!Number.isFinite(mm.spec.ejectionDelay)}
                            style={{ width: 'auto' }}
                            onChange={(e) => {
                              // Un-plugging restores the longest prescribed
                              // delay, or 6 s (mountDelayEdits).
                              const plugged = e.target.checked;
                              setMountMotors((prev) => ({ ...prev, [m.id!]: withPlugged(prev[m.id!]!, plugged) }));
                            }}
                          />
                          plugged
                        </label>
                        {autoBox && (
                          <label className="motor-inline-label" style={{ whiteSpace: 'nowrap' }}
                            title="Auto targets this mount’s recovery-free branch apogee, rounded to a whole second.">
                            <input
                              type="checkbox"
                              checked={mm.meta.autoDelay === true}
                              style={{ width: 'auto' }}
                              onChange={(e) => {
                                const auto = e.target.checked;
                                setMountMotors((prev) => ({ ...prev, [m.id!]: withAuto(prev[m.id!]!, auto) }));
                              }}
                            />
                            auto (optimal)
                          </label>
                        )}
                      </div>
                    </div>
                  )}
                  {mm?.meta.autoDelay && <p className="field-hint">{autoDelayCardText(
                    delayRun?.delayResolution?.mounts.find((d) => d.mountId === m.id), delayCurrent,
                  )}</p>}
                  {/* FC-5: keep the same ignition controls visible for every loaded
                      motor, so an inherited default can also be inspected and edited. */}
                  {mm && (
                    <div className="field" style={{ marginTop: 6 }}
                      title="When this motor lights. Automatic = launch-stage motors at launch, upper-stage motors on the ejection charge of the stage below — which lights a black powder motor, but not a composite one. Composite and hybrid motors need an igniter whatever their size, so they default to booster burnout + delay.">
                      {/* The words on screen name the select (audit
                          2026-09-30): it carried its own aria-label, "Ignition
                          event", beside a label tied to nothing. The scope
                          choice is explicit (CFG-SPEC A3). */}
                      <MountIgnitionField mountId={m.id!} mountName={mountName(m)} ownerKey={flightOwnerKey}
                        own={(tree as FlightTree).ignitionDefaults?.[m.id!] ?? mountMotors[m.id!]?.ignition ?? mm.ignition}
                        override={overrideFor(activeOverrides.ignitions, m.id!)}
                        overrideLabel={overrideScopeLabel} isStaged={isStaged}
                        onEdit={(scope, tuple, numeric) => editIgnition(m.id!, tuple, scope, numeric)}
                        onEditStart={beginFlightEdit}
                        onEditCancel={cancelFlightEdit}
                        onEditEnd={(scope, tuple) => finishFlightEdit(() => { if (scope === 'override') editIgnition(m.id!, tuple, scope, true, true); })}
                        onReset={() => commitActiveOverrides({ ignitions: resetOverride(activeOverrides.ignitions, m.id!) })} />
                    </div>
                  )}
                  {/* The weighed pad mass lives under the PRIMARY mount's motor —
                      one number for the whole rocket, carried on that motor
                      (services/hardwareMass.ts) — so only the primary's card
                      gets the field. When the file's primary is a reference the
                      app could not load, a value typed here would never reach
                      the file (the export gate keeps the primary's), so the card
                      explains instead of offering a field. */}
                  {mm && m.id === primaryMountId && (() => {
                    if (filePrimaryMountId === primaryMountId) {
                      return (
                        <MotorPadMass
                          mountId={m.id!}
                          motorLabel={baseLabel(mm.label)}
                          mountName={mountName(m)}
                          multiMotor={assigned.length > 1 || count > 1}
                          valueKg={mm.padMassKg ?? null}
                          legacyPending={mm.padMassWeighedWith === LEGACY_PAD_MASS_KEY}
                          onChange={(kg) => setPadMass(m.id!, kg)}
                          computedPadMassKg={computedPadMassKg}
                          hardware={built?.hardware}
                          nameOfMount={(id) => mountName(findNode(tree, id), 'a removed mount')}
                          describeIdentity={describeIdentity}
                          identityKey={motorIdentity(mm.meta, mm.spec.designation)}
                        />
                      );
                    }
                    // The file's primary is an unmatched reference (filePrimaryMountId
                    // is never null while primaryMountId is not).
                    const fileRef = filePrimaryMountId ? unmatchedRefs[filePrimaryMountId] : undefined;
                    const where = mountName(filePrimaryMountId ? findNode(tree, filePrimaryMountId) : null, 'a removed mount');
                    const named = fileRef?.designation ?? 'a motor the file names';
                    return typeof fileRef?.padMassKg === 'number' && fileRef.padMassKg > 0
                      ? (
                        <p className="print-note print-note-warn" role="status">
                          {`The file's weighed pad mass belongs to the motor on ${where} (${named}), which could not`
                            + ' be loaded. It is kept so the file saves unchanged, and nothing is carried. Load that'
                            + ' motor to use it, or load a motor there and re-weigh with these motors in.'}
                        </p>
                      )
                      : (
                        // No pad mass in the file either: say why there is no field
                        // rather than claiming a value the file never had.
                        <p className="comp-stats" style={{ margin: '3px 0 0' }}>
                          {`The motor the file names on ${where} (${named}) could not be loaded, so there is no`
                            + ' weighed pad mass field here — a weighing belongs with every motor in. Load that'
                            + ' motor, or another one there, and the field appears under it.'}
                        </p>
                      );
                  })()}
                </div>
              );
                  })}
                </div>
              );
            })}
            {/* CFG-SPEC A2: own settings and overrides for recovery and separation are edited here. */}
            <ConfigPartEditors tree={tree} overrides={activeOverrides} ownerKey={flightOwnerKey}
              configLabel={overrideConfigLabel} detached={detachedOwnsOverrides}
              onEdit={(node, scope, tuple, patch, numeric) => scope === 'own'
                ? editComponentDefault(node, patch, numeric) : editComponentOverride(node, tuple, numeric)}
              onEditStart={beginFlightEdit}
              onEditCancel={cancelFlightEdit}
              onEditEnd={(node, scope, tuple) => finishFlightEdit(() => { if (scope === 'override') editComponentOverride(node, tuple, true, true); })}
              onReset={resetComponentOverride}
              onResetAll={resetComponentOverrides}
              onEverywhere={adoptComponentOverrideEverywhere} />
            {/* A disabled button that does not say why reads as a broken button —
                reported 2026-09-01b as "when I click the button, nothing happens".
                There are THREE reasons this can be off and the tooltip named only
                one of them, so the other two showed the ENABLED text and then did
                nothing. The reason is now on screen, not just in a title. */}
            {(() => {
              const blocked = batchUnavailableReason({
                built: !!built, hasMount: mounts.length > 0, isStaged,
              });
              return (
                <>
                  <button
                    className="file-btn"
                    style={{ marginTop: 8, width: '100%' }}
                    disabled={!!blocked}
                    title={blocked
                      ? `Batch simulation is not available here: ${blocked}.`
                      : 'Simulate every motor that fits this rocket, with filters and acceptance criteria'}
                    onClick={() => setShowBatch(true)}
                  >
                    <Icon name="zap" /> Batch simulate motors…
                  </button>
                  {blocked && (
                    <p className="comp-stats" style={{ margin: '4px 0 0' }}>
                      Batch simulation is not available here — {blocked}.
                    </p>
                  )}
                </>
              );
            })()}
          </div>

          <LaunchPanel flownAtmosphere={flownAtmosphere} overrideSummary={launchOverrideSummary} onShowOverride={showFlightOverride} hasLaunchGuide={hasLaunchGuides(tree)} value={launch} onChange={setLaunch} onLaunch={onLaunch} simulating={simulating}
            longitudeReview={longitudeReview} onLongitudeReview={setLongitudeReview}
            canLaunch={!!built && !!primaryMountId && !nozzlePending}
            lastRun={simCostRef}
            weather={weather} onGetWeather={() => setShowWeather('get')}
            onWeatherFetchAgain={() => setShowWeather('again')}
            onWeatherUndo={undoWeather} onWeatherDismiss={() => setWeather(null)} onWeatherSigma={estimateSigma} />

          <ConfigOverview configs={syncActiveConfig(savedConfigs, activeConfigId, { motors: mountMotors, unmatchedRefs, tree })}
            activeConfigId={activeConfigId} tree={tree} onApply={applyConfig}
            onShowPart={(id, family) => setConfigPartTarget({ id, family })} />
        </main>
        )}

        {tab === 'results' && (
        <main className="results-column" data-tour="results-panel" ref={resultsMainRef} tabIndex={-1}>
          {!inspectedSummary && shownResult && aeroMode === 'classic' && shownResult.summary.maxMachNumber > MACH_AUTO_THRESHOLD && (
            <div className="file-note file-note-warn" role="alert">
              ⚠ This flight reaches <strong>Mach {shownResult.summary.maxMachNumber.toFixed(2)}</strong> on
              the classic aero model, which is approximate past ~Mach {MACH_AUTO_THRESHOLD} — supersonic CP travel
              (the stability hazard on fast flights) is not modeled. A wind-tunnel-validated
              supersonic model is available. Note: a model applies to the <strong>entire
              flight</strong>, subsonic portions included, so stability and apogee will shift when
              it changes.{' '}
              <button aria-describedby={launchOverrideSummary ? 'launch-override-relaunch' : undefined} className="file-btn" style={{ marginLeft: 6 }}
                onClick={() => {
                  // Sets the SESSION switch, not the stored preference. It
                  // used to write the preference, which under an active strip
                  // override would have been outranked — leaving a button that
                  // visibly did nothing, twice. Session-scoped also matches
                  // what the button is for: trying the other model on this
                  // flight, not changing what every future session flies.
                  setAeroOverride('auto');
                  requestRelaunch();
                }}>
                Try Auto &amp; re-fly (this session)
              </button>
              <LaunchOverrideWarning id="launch-override-relaunch" summary={launchOverrideSummary} onShow={showFlightOverride} />
            </div>
          )}
          {!inspectedSummary && shownResult && lastRun?.aeroModel === 'auto-supersonic' && (
            <div className="file-note">
              {/* States what the flight DID, not what was predicted: the model can also be
                  chosen by the post-flight backstop, where the short probe projected
                  subsonic and the full flight overruled it — "was projected past" is
                  the opposite of what happened on that path. */}
              Auto aero: this flight reaches <strong>Mach {shownResult.summary.maxMachNumber.toFixed(2)}</strong>,
              past the Mach {MACH_AUTO_THRESHOLD} threshold, so the whole flight was flown
              on the <strong>supersonic model</strong> (the displayed stability follows it too —
              subsonic flights of this design would fly classic).
            </div>
          )}
          {!inspectedSummary && lastRun && (modelMatch === false || changedSinceNonModel.length > 0) &&
            <Note tier="caution" className="result-freshness">
          {!inspectedSummary && modelMatch === false && lastRun && (
            // States what the flight DID first, matching the auto-supersonic
            // note's precedent. This exists because a model switch no longer
            // destroys the flight: keeping it is only honest if the report
            // says which model produced these numbers, rather than letting
            // them be silently re-read under the new one.
            <div className="file-note file-note-warn" role="status">
              These numbers were <strong>flown on {aeroModelLabel(lastRun.aeroModel, lastRun.rogersKbf)}</strong>.
              The model now selected is <strong>{currentModelLabel({ aeroMode, effectiveKbf, autoSupersonic })}</strong>,
              so they are not comparable with a fresh flight — press <strong>Launch</strong> to
              re-fly this design on the current model.
            </div>
          )}
          {!inspectedSummary && lastRun && changedSinceNonModel.length > 0 && (
            // States what the flight DID first, like the two notes above it.
            // No auxiliary verb: "the launch conditions HAS changed" is wrong,
            // and picking has/have from the list length gets that case backwards
            // because one of the three labels is itself plural.
            <div className="file-note file-note-warn" role="status">
              These numbers were <strong>flown {formatRunWhenProse(lastRun.when)}</strong>, and{' '}
              <strong>{listAnd(changedSinceNonModel)}</strong> changed since — they describe the
              rocket as it was then, not the one you have now.
              Press <strong>Launch</strong> to fly the current design.
            </div>
          )}
            </Note>}
          {/* Each panel below draws stored or computed data, so each has its
              own boundary (audit 2026-09-22): a throw in one says so in place,
              and the rest of the tab — the run table included, where a bad
              run can be deleted — keeps working instead of the app going down. */}
          <PanelBoundary what="The desktop stored predictions" resetKey={importedDocument}>
            <DesktopPredictions predictions={importedDocument?.desktopPredictions}
              configId={reportRun?.flightConfigId ?? activeConfigId} run={reportRun} />
          </PanelBoundary>
          {!inspectedSummary && shownResult && lastRun ? (
            <>
              <PanelBoundary what="This flight's report" resetKey={lastRun}>
                <FlightStats run={lastRun} />
                <SimRunDetails run={lastRun} hasSeries changedSince={changedSince} />
              </PanelBoundary>
              <PanelBoundary what="The flight plots" resetKey={shownResult}>
                <FlightCharts result={shownResult} onFullSeries={fetchFullSeriesResult}
                  flightName={formatRunLabel(lastRun)}
                  designName={tree.name}
                  /* The two downloads re-fly the design AS IT STANDS, so they
                     refuse where the 📈 Charts button already does. The
                     aerodynamics model is excluded on purpose —
                     fetchFullSeriesResult puts the flown model back before it
                     runs, so a model switch is a labelling matter, not a
                     different rocket. */
                  staleReason={changedSinceNonModel.length > 0
                    ? listAnd(changedSinceNonModel) : null}
                  /* And they wait while a Launch flies the same handle (see
                     showChartsFor). */
                  flightRunning={simulating} />
              </PanelBoundary>
            </>
          ) : reportRun ? (
            // A stored run whose series nobody has computed in this session —
            // after a reload, or a run flown before the design was edited.
            // The tiles and the report come from the stored scalars; the plots
            // need series, which run history does not carry.
            <>
              <PanelBoundary what="This flight's report" resetKey={reportRun}>
                <FlightStats run={reportRun} />
                <SimRunDetails run={reportRun} changedSince={inspectedSummary ? null : changedSince} />
              </PanelBoundary>
              {!inspectedSummary && lastRun && (
              <div className="panel placeholder empty-state">
                <p><strong>Flight plots aren&apos;t saved with a run</strong></p>
                <p>
                  The report above is stored in full, but the plots are drawn from the
                  simulation&apos;s raw time series, which run history doesn&apos;t keep.
                  {/* This panel owns ONE job: why the plots are missing. The
                      staleness claim and the Launch instruction belong to the
                      banner above, which now names exactly what changed —
                      repeating them here put two "Press Launch" buttons and two
                      accounts of the same fact on one screen. */}
                  {canShowCharts(lastRun)
                    ? ' This design still matches the run, so it can be flown again to redraw them — the physics is deterministic, so it reproduces this exact flight.'
                    : ' This run no longer matches the design, so its plots cannot be redrawn for it.'}
                </p>
                {canShowCharts(lastRun) && (
                  <button className="file-btn file-btn-primary" disabled={reflying !== null || simulating}
                    title="Re-fly this design at this run's conditions to redraw its plots. Does not add a row to the run history."
                    onClick={() => { void showChartsFor(lastRun); }}>
                    {reflying === lastRun.id ? '⏳ Re-flying…' : '📈 Show charts'}
                  </button>
                )}
              </div>
              )}
            </>
          ) : (
            <div className="panel placeholder empty-state">
              <Icon name="rocket" size={30} />
              <p><strong>Nothing to show yet</strong></p>
              <p>
                Press <strong>Launch</strong> (above) to fly this design and see altitude,
                velocity and acceleration plots.
                {chartableRun && ' Its previous flights are saved below — the report and the plots for any of them can be brought back without flying a new one.'}
              </p>
              {chartableRun && (
                <button className="file-btn file-btn-primary" disabled={reflying !== null || simulating}
                  title="Re-fly this design at that run's conditions to redraw its report and plots. Does not add a row to the run history."
                  onClick={() => { void showChartsFor(chartableRun); }}>
                  {reflying === chartableRun.id ? '⏳ Re-flying…' : '📈 Show the last saved flight'}
                </button>
              )}
            </div>
          )}
          {runsQuotaWarn && (
            <Note tier="danger" className="file-note file-note-warn" role="alert">
              {runs.length === 0
                // Nothing stored at all (private mode / storage blocked): the
                // "table below / export the CSV" advice is unfollowable —
                // SimHistory renders nothing with zero runs.
                ? <>⚠ This flight&apos;s report is shown, but it could not be
                  saved — browser storage is full or blocked (private
                  browsing does this). Run history won&apos;t survive a reload.</>
                : <>⚠ Run history is no longer being saved — browser storage is
                  full. The table below shows what is actually stored; export the
                  CSV to keep your results.</>}
              <button className="file-note-dismiss" onClick={() => setRunsQuotaWarn(false)} aria-label="Dismiss">×</button>
            </Note>
          )}
          <PanelBoundary what="The run history" resetKey={runs}>
            <SimHistory
              provenance={provenanceKey}
              runs={runs}
              onRunsChange={recordRuns}
              selectedId={reportRun?.id ?? null}
              // Selecting a row no longer destroys the in-memory flight: the
              // result carries the id of the run it belongs to, so the charts
              // decide for themselves whether they are showing this run. Coming
              // back to the run you just flew restores its charts for free.
              onSelect={(r) => {
                setInspectedSummary(r.importedSummary ? r : null);
                if (!r.importedSummary && r.id !== lastRun?.id) setLastRun(r);
              }}
              canShowCharts={canShowCharts}
              onShowCharts={(r) => { void showChartsFor(r); }}
              reflyingId={reflying}
              flightRunning={simulating}
              hasChartsFor={(r) => (result?.runId === r.id) || reflightCache.has(r.id)}
              designName={tree.name}
            />
          </PanelBoundary>
        </main>
        )}
      </div>
      <SiteBandFooter nav={mmrNav} />
      <div className="sr-only" role="alert" aria-live="assertive">
        {!inspectedSummary && lastRun && [
          ...(lastRun.simWarnings ?? []).map(w => formatWarning(w, prefs.units)).filter(w => w.high || w.tier !== 'information').map(w => w.label),
          ...commentsOf(lastRun).filter(c => c.level === 'warning').map(c => c.text),
        ].join(' ')}
      </div>
      <NoticeBar notices={notices} />
      {/* Always mounted, so the first "Flight complete" lands in a region that
          already exists — see resultsMainRef. */}
      <div className="sr-only" role="status" aria-live="polite">
        {flightSaid.text && <span key={flightSaid.seq}>{flightSaid.text}</span>}
      </div>
    </div>
  );
}
