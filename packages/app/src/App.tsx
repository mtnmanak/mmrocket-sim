import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OrkRocket,
  resetEngine,
  type ComponentNode,
  type ComponentType,
  type FlightResult,
  type IgnitionEvent,
  type MotorSpec,
  type RocketTree,
  type StaticInfo,
} from '@online-openrocket/engine';
import { BatchSimulate } from './components/BatchSimulate.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { Icon } from './components/Icon.js';
import { ChangelogDialog } from './components/ChangelogDialog.js';
import { GuideDialog } from './components/GuideDialog.js';
import { FirstRunTour, shouldAutoStartTour } from './components/FirstRunTour.js';
import { FlyScreen } from './components/FlyScreen.js';
import { ComponentTree } from './components/ComponentTree.js';
import { FlightCharts } from './components/FlightCharts.js';
import { DragPanel } from './components/DragPanel.js';
import { DEFAULT_CONDITIONS, DEFAULT_TIME_STEP_S, kernelSimOptions, LaunchPanel, PANEL_TIME_STEP_FLOOR_S, type LaunchConditions } from './components/LaunchPanel.js';
import { MACH_AUTO_THRESHOLD, machProbeSeconds } from './services/machProbe.js';
import { MovedNotice } from './components/MovedNotice.js';
import { NoticeBar, type Notice, type NoticeSeverity } from './components/NoticeBar.js';
import { MeasuredMassBox } from './components/MeasuredMassBox.js';
import {
  BUILD_ALLOWANCE_NAME, coveringMassOverride, findAllowance, placeAtStation, solveBallast,
  withoutAllowance, type BallastSolution,
} from './services/buildAllowance.js';
import { builtInMeta, MotorPicker } from './components/MotorPicker.js';
import { NumField } from './components/NumField.js';
import { PropertyPanel } from './components/PropertyPanel.js';
import { SimHistory, SimRunDetails } from './components/SimResults.js';
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
import { TreeSchematic } from './components/TreeSchematic.js';
import { AftView } from './components/AftView.js';
import { BUILT_IN_MOTORS } from './motors.js';
import { PreferencesDialog } from './components/PreferencesDialog.js';
import { SiteBand, SiteBandFooter } from './components/SiteBand.js';
import { MMR_NAV_FALLBACK, useMmrNav } from './services/useMmrNav.js';
import { AERO_SHORT, aeroChoiceOf, effectiveAero, usePrefs, type AeroChoice } from './prefs/PrefsContext.js';
import { UnitChip } from './components/UnitChip.js';
import { fmtSi, niceStep, siToUi, uiToSi } from './prefs/units.js';
import { classLabel, diameterClass, displayDesignation, findDbMotor, isHighPower } from './services/motorDb.js';
import { delayOptions, fetchMotorSpec } from './services/thrustcurve.js';
import { loadExMotors } from './services/exMotors.js';
import { exportOrk, fmtStepS, importOrk, type OrkDeployOverride, type OrkSeparationOverride, type OrkExportConfig, type OrkExportFlightData, type OrkExportMotor, type OrkImportResult, type OrkMotorRef, type OrkTreeImportResult } from './services/orkFile.js';
import { decodeShareFragment, encodeShareFragment, hasSharePayload, MAX_FRAGMENT_CHARS } from './services/shareLink.js';
import { exportRkt, importRkt } from './services/rocksimFile.js';
import { componentCsv, componentTable } from './services/componentTable.js';
import { CSV_BOM, safeName } from './services/fileName.js';
import { saveFile } from './services/saveFile.js';
import { tableToXlsx, XLSX_MIME } from './services/xlsx.js';
import { exportCdx1, importCdx1 } from './services/rasaeroFile.js';
import {
  loadSession, onSessionSaveStateChange, saveSessionDebounced, sessionPredatesThisBuild,
  sessionSaveFailing,
} from './services/session.js';
import {
  aeroModelLabel, buildSimRun, conditionsKeyOf, currentModelLabel, formatStability,
  recommendDelay, runMatchesDesign, runMatchesModel, shortHash, storedSimCost,
  type DesignMatchKey, type MotorMeta, type SimRun,
} from './services/simReport.js';
import { formatWarning, formatWarningText } from './services/simWarnings.js';
import { addRun, loadRuns, persistFailed } from './services/simStore.js';
import { APP_VERSION } from './version.js';
import { pokeServiceWorker, useVersionCheck } from './services/versionCheck.js';
import {
  addChild, addStage, cloneSubtree, defaultTree, duplicateNode, emptyTree, engineTree, findNode,
  findParent, hasParallelStage, inheritDefaults, isOnLaunchStage, makeNode, motorMounts, moveNode,
  normalizeTree, removeNode, stageIndexOf, stages, suppressingAncestor, updateAllNodes,
  updateNode,
} from './tree/treeModel.js';
import { clusterCount } from './tree/cluster.js';
import { estimateMotorRoomForMounts } from './tree/motorRoom.js';
import { autoAlignFinSets } from './tree/finAlign.js';
import { railInterferenceWarnings } from './tree/mountAngle.js';
import { convertShrouds, findShroudCandidates, type ShroudCandidate } from './tree/shroudConvert.js';

/** One mount's assigned motor (Release C: every mount can hold its own). */
export interface MountMotor {
  label: string;
  spec: MotorSpec;
  meta: MotorMeta;
  /**
   * When this motor ignites. Assigned a power-class-aware default at
   * selection time (the owner's G80 rule): high-power sustainers are
   * electronics-timed (burnout + 1 s); everything else AUTOMATIC.
   */
  ignition: { event: IgnitionEvent; delay: number };
}

/**
 * One of the imported file's flight configurations, kept as a ready-to-apply
 * preset (Stage B). `mountMotors` stays the live working set every consumer
 * reads; applying a preset copies its motors in and marks it active.
 */
export interface SavedConfig {
  /** The .ork configid — stable through save, so desktop round-trips keep it. */
  id: string;
  /** null = unnamed in the file (the desktop shows its motor list instead). */
  name: string | null;
  isDefault: boolean;
  /** Matched motors keyed by mount node id; unmatched refs dropped out. */
  motors: Record<string, MountMotor>;
  /** Designations that couldn't be matched at import — reported when applied. */
  unmatched?: string[];
  /**
   * This configuration's stage-separation settings, keyed by stage node id.
   * Separation is per-configuration in the .ork exactly as motors and recovery
   * are, so switching configurations has to carry it: without this, a design
   * that says "never separate" on the configuration you switch TO still flew
   * the configuration you OPENED with, and a 0 s motor delay tore the stages
   * apart at burnout.
   */
  separations?: Record<string, OrkSeparationOverride>;
  /**
   * This configuration's recovery-deployment settings as they were in the file,
   * keyed by recovery-device node id. Carried untouched so saving while another
   * configuration is open cannot rewrite this one's chute deployment.
   */
  deployments?: Record<string, OrkDeployOverride>;
}

/** SimRun -> the ten summary values desktop OpenRocket stores in <flightdata>. */
function summaryOf(r: SimRun): OrkExportFlightData {
  return {
    maxAltitude: r.maxAltitude,
    maxVelocity: r.maxVelocity,
    maxAcceleration: r.maxAcceleration,
    maxMach: r.maxMach,
    timeToApogee: r.timeToApogee,
    flightTime: r.totalFlightTime,
    groundHitVelocity: r.groundHitVelocity,
    launchRodVelocity: r.rodExitVelocity,
    deploymentVelocity: r.velocityAtDeployment,
    optimumDelay: r.optimumDelayS,
  };
}

/**
 * Display name for a working-set configuration. Same rule as the .ork picker's
 * {@link configLabel} — a nameless configuration reads as its motor set, never
 * as a GUID — but SavedConfig's motors are already MATCHED (`label`), with the
 * ones we could not match moved aside into `unmatched`. Both belong in the
 * label, or a configuration whose only motor is unmatched would read as
 * "No motors".
 */
export function savedConfigLabel(c: SavedConfig): string {
  if (c.name) return c.name;
  const labels = [
    ...Object.values(c.motors).map((m) => m.label),
    ...(c.unmatched ?? []),
  ].filter(Boolean);
  return labels.length ? `[${labels.join(', ')}]` : 'No motors';
}

import './styles.css';

/**
 * What the design importers hand the shared apply path (file open AND share
 * link). Structural subset of OrkTreeImportResult so importRkt/importCdx1
 * results — same shape minus `launch` — fit too; only .ork parses carry the
 * flight-configuration fields.
 */
type ImportedDesign = Pick<OrkTreeImportResult, 'name' | 'tree' | 'motors' | 'notes' | 'launch' | 'measured'>
  & Partial<Pick<OrkImportResult, 'configs' | 'chosenConfigId'>>
  // RASAero files carry a Mach-Alt table; the drag panel offers it as a
  // sweep condition so a user can reproduce tunnel-matched Reynolds.
  & { machAlt?: [number, number][] };

/** Rocket names that mean "the user never named it" (desktop default is "Rocket"). */
const GENERIC_ROCKET_NAMES = new Set([
  'rocket', 'new rocket', 'imported rocket', 'my rocket',
  // Importer fallbacks for files with no <Name> — the filename beats these.
  'imported rocksim rocket', 'imported rasaero rocket',
]);

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

/** Rewrites a motor label's delay suffix ("H220-14" / "H220-P" / "H220 (auto delay)"). */
function labelWithDelay(label: string, delay: number | 'auto'): string {
  const base = label.replace(/ \(auto delay\)$/, '').replace(/-(\d+(\.\d+)?|P)$/, '');
  if (delay === 'auto') return `${base} (auto delay)`;
  return `${base}-${Number.isFinite(delay) ? delay : 'P'}`;
}

/**
 * Is this tree still the untouched starter rocket? Compares against a fresh
 * defaultTree() with ids stripped — every normalizeTree/defaultTree call
 * mints new ids, so ids never match and everything else must. Used by the
 * share-link loader: replacing the pristine default needs no confirmation,
 * anything the user actually worked on does.
 */
function isPristineDefault(t: RocketTree): boolean {
  const strip = (n: ComponentNode): unknown => {
    const { id: _id, children, ...rest } = n;
    return { ...rest, children: (children ?? []).map(strip) };
  };
  const ref = defaultTree();
  return t.name === ref.name
    && JSON.stringify(t.components.map(strip)) === JSON.stringify(ref.components.map(strip));
}

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
  // Mountain Man Rockets site band + footer strip, and the feedback routes
  // below. ONE call for all three: the hook fetches once per mount, so the
  // contract is shared state, not three copies of the same request.
  const { nav: mmrNav, source: mmrNavSource } = useMmrNav(MMR_NAV_FALLBACK);
  const [showPrefs, setShowPrefs] = useState(false);
  // Restore the previous session (autosaved on every change) if one exists.
  // normalizeTree wraps pre-v0.009 flat trees in one stage. Lazy useState:
  // loadSession parses the whole tree — never re-run it on re-renders.
  const [session] = useState(loadSession);
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
  // Normalize ONCE and derive every dependent initializer from the SAME tree:
  // each normalizeTree/defaultTree call mints fresh ids for nodes it creates,
  // so a second call yields ids that don't exist in the tree state — the
  // default-motor assignment and legacy migrations would key onto ghosts.
  const [initialTree] = useState<RocketTree>(
    () => normalizeTree(session?.tree ?? defaultTree()));
  const [tree, setTreeRaw] = useState<RocketTree>(initialTree);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Component clipboard (copy/cut → paste into another parent). Holds the
  // node AS COPIED — a later cut/delete of the original doesn't affect it.
  const [clipboard, setClipboard] = useState<ComponentNode | null>(null);
  // Per-mount motors (Release C). Legacy sessions carried ONE motor + the
  // mount it applied to — migrate it onto that mount.
  const [mountMotors, setMountMotors] = useState<Record<string, MountMotor>>(() => {
    if (session?.mountMotors) return session.mountMotors;
    const target = session?.mountId ?? motorMounts(initialTree)[0]?.id;
    if (!target) return {};
    const label = session?.motorLabel ?? 'C6-5';
    const spec = session?.motor ?? BUILT_IN_MOTORS['C6-5']!;
    const meta = session?.motorMeta ?? builtInMeta(label);
    return { [target]: { label, spec, meta, ignition: { event: 'automatic', delay: 0 } } };
  });
  // Stage B: the imported file's flight configurations as presets, and which
  // one the working set (mountMotors) came from. null = custom/none — manual
  // motor edits KEEP the active id (the working set is that config's current
  // truth, and export writes the live set into it); only unloading
  // everything or applying "None" clears it.
  const [savedConfigs, setSavedConfigs] = useState<SavedConfig[]>(session?.savedConfigs ?? []);
  const [activeConfigId, setActiveConfigId] = useState<string | null>(session?.activeConfigId ?? null);
  // A RASAero import's Mach-Alt table, offered to the drag panel as a sweep
  // condition. Session-only: it belongs to the imported file, not the design.
  const [fileMachAlt, setFileMachAlt] = useState<[number, number][] | undefined>();
  // Max motor length is a physical property of each STAGE's airframe (a
  // staged rocket's booster and sustainer have different room), keyed by
  // stage node id. Legacy sessions carried ONE universal value — seed every
  // stage with it.
  const [maxMotorLen, setMaxMotorLen] = useState<Record<string, number | null>>(() => {
    if (session?.maxMotorLengthByStage) return session.maxMotorLengthByStage;
    const legacy = session && 'maxMotorLengthM' in session
      ? session.maxMotorLengthM ?? null
      : legacyMaxMotorLength();
    if (legacy === null) return {};
    return Object.fromEntries(
      stages(initialTree)
        .filter((st) => st.id)
        .map((st) => [st.id!, legacy]));
  });
  const [launch, setLaunch] = useState<LaunchConditions>(session?.launch ?? DEFAULT_CONDITIONS);
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
  const recordRuns = useCallback((next: SimRun[]) => {
    setRuns(next);
    setRunsQuotaWarn(persistFailed());
  }, []);
  // Session autosave happens inside a debounce, so its health is pushed, not
  // polled: subscribe for the working<->failing edges (deduped in session.ts).
  // Non-dismissible while failing — it clears itself when a save sticks.
  const [autosaveFailing, setAutosaveFailing] = useState(() => sessionSaveFailing());
  useEffect(() => onSessionSaveStateChange(setAutosaveFailing), []);
  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  /**
   * The file/transient note. Severity was added in 2026-08-23: the same widget
   * carried "share link copied" and "could not open that .ork file", so the
   * strip could not be made quieter for routine information without quietening
   * genuine errors too. setFileNote keeps its old string signature (info by
   * default) so every existing call site is unchanged.
   */
  const [fileNoteState, setFileNoteState] =
    useState<{ text: string; severity: NoticeSeverity } | null>(null);
  const setFileNote = useCallback((text: string | null, severity: NoticeSeverity = 'info') => {
    setFileNoteState(text === null ? null : { text, severity });
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
  /**
   * S1 stats drawer over the hero canvas.
   * "All stats" starts OPEN on a desktop and closed on anything narrower
   * (the owner, 2026-08-23: "there is enough screen real estate"). 981px is the
   * breakpoint where the hero-canvas layout kicks in — below it the drawer
   * overlays most of the drawing, which is why it defaulted closed for
   * everyone. Session state, not a stored preference: collapsing it still
   * sticks for as long as you are working, and nobody's saved choice is
   * stomped because there was never one to stomp.
   */
  const [statsDrawer, setStatsDrawer] = useState(
    () => typeof matchMedia !== 'undefined' && matchMedia('(min-width: 981px)').matches,
  );
  // Measured drawer height + gap: the hero view's bottom edge lifts above the
  // open drawer so the drawing shrinks to the visible sky instead of being
  // covered (batch 08-21d — vertical mode has no zoom/pan to escape with).
  // A CALLBACK ref, not a plain one, and the effect keys on the NODE: the
  // drawer lives inside the design tab's subtree (and behind `built &&`), so
  // switching tabs unmounts it while statsDrawer stays true. Keyed on
  // statsDrawer alone the effect never re-ran, the ResizeObserver kept
  // watching the detached node — Chrome reports it as a 0x0 box, so the
  // clearance collapsed to 20px — and the fresh drawer that mounted on the way
  // back was never measured at all. The drawing then ran under the drawer
  // again, which is the exact failure this measurement exists to prevent
  // (batch 08-21d: vertical mode has no zoom/pan to escape with).
  const [drawerEl, setDrawerEl] = useState<HTMLDivElement | null>(null);
  const [drawerClearance, setDrawerClearance] = useState(0);
  /**
   * Fit-to-content hero canvas (v0.076, owner report 2026-08-29): the 2D
   * schematic reports its natural drawn height and the stage sizes to
   * rocket + chip headroom + drawer clearance, capped by the old
   * viewport-availability clamp (see styles.css) — so a long thin rocket
   * stops paying for a window-tall band of empty sky, and the footer gets
   * its screen back. 3D and Aft keep the pure CSS clamp: a 3D scene has no
   * "natural" height.
   */
  const [heroNatural, setHeroNatural] = useState<number | null>(null);
  /** Headroom over the drawn rocket for the floating stats chip's default
   *  spot (~110px unfolded + margin), so fit-to-content never lands the chip
   *  on the airframe. */
  const HERO_CHIP_RESERVE = 140;
  useEffect(() => {
    if (!statsDrawer || !drawerEl) { setDrawerClearance(0); return; }
    const measure = () => setDrawerClearance(drawerEl.offsetHeight + 20);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(drawerEl);
    return () => ro.disconnect();
  }, [statsDrawer, drawerEl]);
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
  const [showChangelog, setShowChangelog] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  // First-run tour: decided once at startup (ref = StrictMode double-invoke
  // guard, same pattern as shareHandled below). A share link suppresses it —
  // that visitor came for a design, don't stand in front of it.
  const tourChecked = useRef(false);
  useEffect(() => {
    if (tourChecked.current) return;
    tourChecked.current = true;
    if (shouldAutoStartTour({
      tourOff: prefs.tourOff ?? false,
      hasShare: hasSharePayload(window.location.hash),
      hasSession: session != null,
    })) setTourOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot startup decision
  }, []);
  // Turning the tour off WHILE IT IS ON SCREEN must dismiss it. The tour's
  // spotlight and scrim are both pointer-events:none, so the app stays fully
  // usable behind the card and opening Preferences mid-tour is the natural
  // thing to do — and until now the card just sat there, which is the literal
  // reading of "setting Tour Off doesn't work".
  //
  // Guarded on the false→true TRANSITION, not on the current value: a plain
  // `if (off) setTourOpen(false)` would make the header's ⟲ Tour replay
  // button dead for exactly the people who turned the auto-tour off.
  const prevTourOff = useRef(prefs.tourOff ?? false);
  useEffect(() => {
    const off = prefs.tourOff ?? false;
    if (off && !prevTourOff.current) setTourOpen(false);
    prevTourOff.current = off;
  }, [prefs.tourOff]);
  const closeTour = useCallback(() => {
    setTourOpen(false);
    // The tour walks through tabs — land back on the device's home screen
    // (phones open on Fly, everything else on Design).
    setTab(typeof matchMedia !== 'undefined' && matchMedia('(max-width: 767px)').matches
      ? 'fly' : 'design');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setTab is stable
  }, []);
  // Workspace tab (Fly / Design / Motors & Launch / Results) — persisted so a
  // reload lands the user back where they were working. Fly (S4, batch
  // 08-21c) is the phone home: launch-centered, first and default below the
  // phone breakpoint; its tab button is CSS-hidden on desktop.
  const [tab, setTabRaw] = useState<'fly' | 'design' | 'motors' | 'results'>(() => {
    try {
      const t = localStorage.getItem('online-openrocket.workspace.v1');
      if (t === 'fly' || t === 'motors' || t === 'results' || t === 'design') return t;
    } catch { /* fall through */ }
    return typeof matchMedia !== 'undefined' && matchMedia('(max-width: 767px)').matches
      ? 'fly' : 'design';
  });
  const setTab = useCallback((t: 'fly' | 'design' | 'motors' | 'results') => {
    setTabRaw(t);
    try { localStorage.setItem('online-openrocket.workspace.v1', t); } catch { /* ignore */ }
  }, []);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  // Auto aero mode: did the last flight of THIS design cross the Mach-0.9
  // threshold and upgrade to the supersonic model? Sticky until the design,
  // motors or launch conditions change, so the displayed statics match the
  // model the flight actually used. NOT reset by a model change any more —
  // switching models keeps the flight and marks it (see the reset effect).
  const [autoSupersonic, setAutoSupersonic] = useState(false);
  // "Switch to Auto & re-fly" from the supersonic-flight alert: re-launch as
  // soon as the engine rebuild with the new model lands.
  const [pendingRelaunch, setPendingRelaunch] = useState(false);

  /**
   * What the user weighed, in SI, airframe only (motor out). Persisted with
   * the session so reopening the tab does not lose it; the ballast it produced
   * lives in the design itself as an ordinary mass component.
   */
  const [measured, setMeasured] = useState<{ massKg: number | null; cgM: number | null }>(
    () => session?.measured ?? { massKg: null, cgM: null });

  // Autosave the working state so a closed tab or crash never loses work.
  useEffect(() => {
    // Prune limits for stages that no longer exist before persisting.
    const stageIds = new Set(stages(tree).map((s) => s.id));
    const maxMotorLengthByStage = Object.fromEntries(
      Object.entries(maxMotorLen).filter(([id]) => stageIds.has(id)));
    saveSessionDebounced({
      tree, mountMotors, launch, maxMotorLengthByStage, savedConfigs, activeConfigId, measured,
    });
  }, [tree, mountMotors, launch, maxMotorLen, savedConfigs, activeConfigId, measured]);

  // ---- undo (Ctrl+Z / button) ----
  const history = useRef<RocketTree[]>([]);
  const lastEditAt = useRef(0);
  const setTree = useCallback((next: RocketTree) => {
    setTreeRaw((prev) => {
      // Coalesce rapid-fire edits (schematic drags, slider moves, keystrokes)
      // into ONE undo step — otherwise a 2 s drag floods the 50-entry buffer
      // and Ctrl+Z steps back a pixel at a time.
      const now = Date.now();
      if (now - lastEditAt.current > 800) {
        history.current.push(prev);
        if (history.current.length > 50) history.current.shift();
      }
      lastEditAt.current = now;
      return next;
    });
  }, []);
  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) {
      setTreeRaw(prev);
      // Never coalesce ACROSS an undo: without this, an edit within 800 ms
      // of the last pre-undo edit skips the history push and the state the
      // user just restored becomes unrecoverable.
      lastEditAt.current = 0;
    }
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        // Leave native text undo alone while the user is typing in a field.
        const t = e.target;
        if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement
            || (t instanceof HTMLElement && t.isContentEditable)) {
          return;
        }
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  // ---- engine build + static analysis on every tree change ----
  const mounts = useMemo(() => motorMounts(tree), [tree]);
  const stageList = useMemo(() => stages(tree), [tree]);
  // "Staged" for the batch-sim gate: a serial stage OR a separating parallel
  // booster — both make the flight multi-branch (batch across them explodes
  // combinatorially, per the owner's rule). A non-separating pod alone is fine.
  const isStaged = stageList.length > 1 || hasParallelStage(tree);
  // Assigned motors on mounts that still exist in the tree.
  const assigned = useMemo(
    () => Object.entries(mountMotors).filter(([id]) => mounts.some((m) => m.id === id)),
    [mountMotors, mounts],
  );
  // The PRIMARY mount drives the report's lead columns and auto-delay: the
  // topmost-stage mount with a motor (the sustainer's).
  const primaryMountId = useMemo(() => {
    const byStage = [...assigned].sort(
      (a, b) => stageIndexOf(tree, a[0]) - stageIndexOf(tree, b[0]));
    return byStage[0]?.[0] ?? null;
  }, [assigned, tree]);

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
  const effectiveSupersonic = aeroMode === 'supersonic' || (aeroMode === 'auto' && autoSupersonic);

  // No setState in here — the error is part of the memo's value (setState
  // during render breaks under StrictMode's double-invoke).
  const buildResult = useMemo((): {
    rocket: OrkRocket; info: StaticInfo; motorFailures: { mountId: string; text: string }[];
  } | { error: string } => {
    try {
      resetEngine();
      const rocket = OrkRocket.buildTree(engineTree(tree));
      // Opt-in Rogers Modified Barrowman (Kbf) — set before staticInfo() so the
      // reported CP/stability reflects it, and it persists onto this build's
      // handle for later simulate() calls.
      rocket.setRogersModifiedBarrowman(effectiveKbf);
      // Opt-in RASAero-class supersonic aerodynamics (feature #1) — CP/drag
      // move with Mach; affects staticInfo, dragSweep and simulate alike.
      rocket.setSupersonicAero(effectiveSupersonic);
      // A motor the kernel refuses must NOT blank the whole design. Before
      // this, one malformed published thrust curve (issues-2026-08-23a.md) took
      // out stability, mass, CP/CG, the stats drawer, the drag panel, every
      // export and both Launch buttons — for a fault in a file the user did not
      // write. Now the rocket still builds; only the motor is missing, and the
      // notice says which and why.
      const motorFailures: { mountId: string; text: string }[] = [];
      for (const [id, mm] of assigned) {
        try {
          rocket.setMotorById(id, mm.spec);
          if (mm.ignition.event !== 'automatic' || mm.ignition.delay !== 0) {
            rocket.setMotorIgnitionById(id, mm.ignition.event, mm.ignition.delay);
          }
        } catch (e) {
          motorFailures.push({
            mountId: id,
            text: e instanceof Error ? e.message : String(e),
          });
        }
      }
      const info = rocket.staticInfo();
      // Camera shrouds lower to deliberately thick strake "fins" — the
      // kernel's THICK_FIN warning is expected there and only alarms users.
      const fairingNames = new Set<string>();
      const scanF = (nodes: ComponentNode[]) => {
        for (const nd of nodes) {
          if (nd.type === 'fairing') fairingNames.add(nd.name ?? 'Camera shroud');
          scanF(nd.children ?? []);
        }
      };
      scanF(tree.components);
      if (fairingNames.size > 0) {
        info.warningTexts = info.warningTexts.filter((wtext) =>
          !(wtext.includes('THICK_FIN') && [...fairingNames].some((fn) => wtext.includes(fn))));
      }
      // Interference around the rail (v0.088). The kernel has no opinion about
      // clock angles — a mounting angle changes no flight number — so this is
      // an APP-side check, appended to the same strip. It is a build problem,
      // not a physics one: a fin on the rail's line means the rocket does not
      // go on the pad. Eric asked for it on 2026-08-31.
      const railWarnings = railInterferenceWarnings(tree);
      if (railWarnings.length) info.warningTexts = [...info.warningTexts, ...railWarnings];
      return { rocket, info, motorFailures };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [tree, assigned, effectiveKbf, effectiveSupersonic]);
  const built = 'error' in buildResult ? null : buildResult;
  const buildError = 'error' in buildResult ? buildResult.error : simError;
  const motorFailures = built?.motorFailures ?? [];

  /**
   * Repairs applied to published thrust curves for the motors currently
   * loaded. thrustcurve.org carries manufacturer files with coincident time
   * points; we mend them rather than refuse the motor, and say so here so a
   * silent fix never changes someone's numbers without telling them.
   */
  const curveRepairs = useMemo(() => {
    const out: string[] = [];
    for (const [, mm] of assigned) {
      const repairs = (mm.spec as { curveRepairs?: string[] }).curveRepairs;
      if (repairs?.length) {
        out.push(`${mm.spec.designation}: its published thrust curve needed repair `
          + `before it could be flown (${repairs.join('; ')}). This is a fault in the `
          + 'motor file, not in your design.');
      }
    }
    return out;
  }, [assigned]);

  // Cosmetic edits (rocket/component names, display colors) must NOT wipe the
  // current flight result — reset on a physics-relevant projection of the
  // tree, not on tree identity (renaming used to clear Results per keystroke).
  const physicsKey = useMemo(() => {
    const strip = (n: ComponentNode): unknown => {
      const { name: _n, color: _c, children, ...rest } = n as ComponentNode & { color?: string };
      return { ...rest, children: (children ?? []).map(strip) };
    };
    return JSON.stringify(tree.components.map(strip));
  }, [tree]);

  useEffect(() => {
    setResult(null);
    setLastRun(null);
    // Cached re-flights die with the design they were computed for — this
    // effect is the one place that owns that invariant, so a stale flight can
    // never outlive its geometry.
    reflightCache.clear();
    setAutoSupersonic(false); // re-evaluate the auto threshold on the next flight
    // eslint-disable-next-line react-hooks/exhaustive-deps -- physicsKey stands in for tree
    //
    // aeroMode/effectiveKbf are DELIBERATELY NOT deps. They used to be, so
    // that a model switch could not leave the strip showing a stability and an
    // apogee computed under two different models — but throwing the flight
    // away made comparing the two models impossible, which is the whole point
    // of being able to switch them. The flight is now KEPT and MARKED: the
    // Results tab says which model it was flown on when that is no longer the
    // current one, and the strip's Apogee cell carries the same mark. Silent
    // re-labelling is the thing to avoid, not the stale number itself.
  }, [physicsKey, mountMotors, launch]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- physicsKey stands in for tree
  }, [physicsKey, mountMotors]);

  // What the time-step caution scales from: this session's own measurement
  // when there has been a flight, else the newest STORED run of this same
  // design — stored runs carry execMs and the step it was measured at
  // (SimRun.timeStepS) precisely so the seconds estimate survives a reload
  // instead of degrading to the bare multiplier.
  const simCostRef = useMemo(
    () => lastSimCost ?? storedSimCost(runs, tree.name ?? 'Rocket'),
    [lastSimCost, runs, tree.name]);

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

  /** The existing allowance, if this design already carries one. */
  const allowanceNode = useMemo(() => findAllowance(tree), [tree]);

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
  }, [built, allowanceNode, tree]);

  /**
   * Inserts or moves the ballast. Re-editing UPDATES the existing component
   * rather than adding a second one (the owner asked for exactly this: swap a
   * camera or a battery, re-weigh, and correct the same part). Routed through
   * setTree, so it is a single undoable edit like any other.
   */
  const applyAllowance = (sol: Extract<BallastSolution, { kind: 'ok' }>) => {
    const lengthM = typeof allowanceNode?.['length'] === 'number'
      ? allowanceNode['length'] as number : 0.02;
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
    // Same default length applyAllowance uses for a not-yet-created allowance.
    const lengthM = typeof allowanceNode?.['length'] === 'number'
      ? allowanceNode['length'] as number : 0.02;
    return coveringMassOverride(tree, sol.stationM, lengthM);
  }, [built, bare, measured, tree, allowanceNode]);

  /**
   * Pinning is only unambiguous when ONE component's override covers the whole
   * rocket — the measured figures are whole-airframe, the overrides are
   * per-stage, and there is no rule for which stage absorbs the difference.
   * With more than one pinned stage the box states the problem and stops,
   * which is the same refusal the RASAero importer itself makes rather than
   * guessing.
   */
  const canPinBlocker = useMemo(() => {
    if (!allowanceBlocker) return false;
    const pinned = tree.components.filter((n) =>
      n['overrideSubcomponentsMass'] === true && typeof n['overrideMass'] === 'number');
    return pinned.length === 1 && pinned[0] === allowanceBlocker;
  }, [allowanceBlocker, tree]);

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
  }, [allowanceBlocker, measured, tree, prefs.units, setFileNote]);

  /**
   * Everything transient the user should see, in one channel with a severity.
   * Motor trouble is a WARNING, never a build error: a malformed published
   * thrust curve is a fault in someone else's file and must not take the
   * design down with it (issues-2026-08-23a.md).
   */
  const notices = useMemo((): Notice[] => {
    const out: Notice[] = [];
    if (buildError) {
      out.push({ id: 'build-error', severity: 'error', text: buildError });
    }
    for (const f of motorFailures) {
      out.push({ id: `motor-failed:${f.mountId}`, severity: 'warn', text: f.text });
    }
    for (const [i, text] of curveRepairs.entries()) {
      out.push({ id: `curve-repair:${i}`, severity: 'warn', text });
    }
    if (restoredByOlderBuild) {
      out.push({
        id: 'stale-session',
        severity: 'warn',
        text: 'This design was restored from autosave and was read in by an earlier build of'
          + ' the app, so file-reading fixes made since then have not been applied to it.'
          + ' Re-open the original file to pick them up.',
        onDismiss: () => setRestoredByOlderBuild(false),
      });
    }
    // One-time, on the first load after upgrading: the restored session carried
    // a time step finer than the default, inherited from some file opened long
    // ago and invisible until this build. Say so rather than letting the number
    // in the new field differ from what the user was silently flying.
    if (timeStepMigrated) {
      out.push({
        id: 'timestep-migrated',
        severity: 'info',
        // The closing sentence names the replaced value when the session
        // carried it — the migration overwrites it in place, so this notice is
        // the last thing that can — and promises nothing when it did not:
        // "if you want it back" with no number and 0.05 in every field was a
        // promise the migrated tester could not act on.
        text: 'Your saved session was flying a finer simulation time step than the default,'
          + ' inherited from a design file — it is now set to 0.05 s, which is several times'
          + ' faster and, in our testing, no less accurate.'
          + (timeStepMigratedFrom !== null
            ? ` To get the old step back, type ${fmtStepS(timeStepMigratedFrom)} into the`
              + ' Time step field in the Launch panel.'
            : ' The Time step field in the Launch panel takes a finer step, if you have a'
              + ' reason to pay for one.'),
        onDismiss: () => setTimeStepMigrated(false),
      });
    }
    if (fileNoteState) {
      out.push({
        id: 'file-note',
        severity: fileNoteState.severity,
        text: fileNoteState.text,
        onDismiss: () => setFileNote(null),
      });
    }
    return out;
  }, [buildError, motorFailures, curveRepairs, fileNoteState, setFileNote, restoredByOlderBuild,
    timeStepMigrated, timeStepMigratedFrom]);

  /** Assigns a motor to a mount, with the G80 power-class ignition default. */
  const assignMotor = (targetMountId: string, label: string, spec: MotorSpec, meta: MotorMeta) => {
    const stIdx = stageIndexOf(tree, targetMountId);
    const multiStage = stages(tree).length > 1;
    // High-power sustainer in a staged rocket → electronics-timed (the owner:
    // nobody lights an HPR sustainer off the booster's ejection charge).
    const ignition: MountMotor['ignition'] = multiStage && stIdx === 0 && meta.highPower
      ? { event: 'burnout', delay: 1 }
      : { event: 'automatic', delay: 0 };
    setMountMotors((prev) => ({ ...prev, [targetMountId]: { label, spec, meta, ignition } }));
  };

  const onLaunch = () => {
    if (!built || !primaryMountId) return;
    const primary = mountMotors[primaryMountId]!;
    setSimulating(true);
    // Flying hands off to the Results workspace — land the user there.
    setTab('results');
    void afterPaint().then(() => {
      try {
        const simOpts = kernelSimOptions(launch);
        // The cost the time-step caution quotes is ONE flight at the current
        // step, so each full flight is timed alone and the LAST measurement
        // wins — that is the flight whose result is shown. t0 used to sit
        // before the Mach probe, so auto aero plus auto delay billed a probe
        // and up to two extra flights as "per flight" and the caution quoted
        // 2-3x the real wait.
        let execMs = 0;
        const flyTimed = (): FlightResult => {
          const t0 = performance.now();
          const r = built.rocket.simulate(simOpts);
          execMs = performance.now() - t0;
          return r;
        };
        // Auto aero mode: decide which model to fly BEFORE flying. Past Mach 0.9
        // (transonic onset, where classic aero starts degrading) the whole
        // flight uses the supersonic model, and the design's displayed statics
        // follow (setAutoSupersonic rebuilds the engine handle with the flag on
        // after this callback finishes).
        //
        // This used to fly the entire classic flight and then, on a supersonic
        // design, throw all of it away and fly the entire thing again — paying
        // for two flights to read one number. A run truncated just past burnout
        // reaches the same >0.9 verdict: peak Mach happens at or just after
        // burnout, never during the coast. Measured on the whole test corpus,
        // the truncated probe returns the EXACT maxMach on 6 of 7 designs and
        // lands the same side of 0.9 on all 7, at a fraction of the cost.
        let usedSupersonic = effectiveSupersonic;
        if (aeroMode === 'auto' && !usedSupersonic) {
          const probe = built.rocket.simulate({
            ...simOpts,
            maxTime: machProbeSeconds(assigned.map(([id, mm]) => ({
              ...mm, onLaunchStage: isOnLaunchStage(tree, id),
            }))),
          });
          if (probe.summary.maxMachNumber > MACH_AUTO_THRESHOLD) {
            built.rocket.setSupersonicAero(true);
            usedSupersonic = true;
            setAutoSupersonic(true);
          }
        }
        // The ONE real flight. The probe's result is never used for anything
        // else: a truncated run has no apogee, so its optimumDelay is absent and
        // its warning set is incomplete.
        let res = flyTimed();
        // The probe under-reads by construction — it stops ~3 s after burnout,
        // and its exact-maxMach score on the corpus was 6 of 7 — so its verdict
        // is re-checked against the flight it green-lit. Without this, a
        // borderline design (probe 0.897, flight 0.904), or one whose
        // BALLISTIC DESCENT alone goes supersonic (the probe never sees the
        // descent; v0.070's full-flight decision did), stays on classic aero
        // with nothing to say so. Costs nothing except on the designs the
        // probe misread, and cannot loop: usedSupersonic is true after one
        // upgrade, so the recheck fires at most once.
        if (aeroMode === 'auto' && !usedSupersonic && res.summary.maxMachNumber > MACH_AUTO_THRESHOLD) {
          built.rocket.setSupersonicAero(true);
          usedSupersonic = true;
          setAutoSupersonic(true);
          res = flyTimed();
        }
        let flownDelay = primary.spec.ejectionDelay;
        // Auto delay (sustainer/primary mount): the first run yields the
        // kernel's optimum (ballistic probe) — round to the nearest whole
        // second (drill-to-fit) and fly the real run with that.
        if (primary.meta.autoDelay) {
          const rec = recommendDelay(res.summary.optimumDelay);
          if (rec !== null) {
            flownDelay = rec;
            built.rocket.setMotorById(primaryMountId, { ...primary.spec, ejectionDelay: rec });
            res = flyTimed();
          }
        }
        // Per-stage motor info so booster branches can be safety-checked
        // (chuteless HIGH-POWER boosters must warn — the G80 rule). Branches
        // are named after the SERIAL stage — except mounts inside a parallel
        // stage (strap-on booster), whose branch carries the parallelstage
        // node's own name. Key by the name the branch will actually have, so
        // a strap-on booster neither misses its warning nor overwrites its
        // host stage's entry.
        const stageMotorInfo: Record<string, { label: string; highPower: boolean }> = {};
        for (const [id, mm] of assigned) {
          let branchName: string | undefined;
          let p = findParent(tree, id);
          while (p && p !== 'stage') {
            if (p.type === 'parallelstage') { branchName = p.name; break; }
            p = p.id ? findParent(tree, p.id) : null;
          }
          branchName ??= stageList[stageIndexOf(tree, id)]?.name;
          if (branchName) {
            stageMotorInfo[branchName] = { label: mm.label, highPower: mm.meta.highPower === true };
          }
        }
        // Stage B: which flight configuration flew, by display name (the
        // CSV's trailing "Flight config" column; absent when none active).
        const activeConfig = activeConfigId === null ? undefined
          : savedConfigs.find((c) => c.id === activeConfigId);
        const run = buildSimRun({
          result: res,
          info: built.info,
          motor: { ...primary.spec, ejectionDelay: flownDelay },
          meta: {
            ...primary.meta,
            motorCount: clusterCount(findNode(tree, primaryMountId)?.['cluster'] as string | undefined),
          },
          launch,
          rocketName: tree.name ?? 'Rocket',
          execMs,
          stageMotorInfo,
          boosterMotors: assigned
            .filter(([id]) => id !== primaryMountId)
            .map(([, mm]) => mm.label),
          aeroModel: aeroMode === 'auto' && usedSupersonic ? 'auto-supersonic'
            : usedSupersonic ? 'supersonic' : 'classic',
          // Kbf only matters on the classic model (supersonic supersedes it).
          // effectiveKbf, NOT the raw preference: with a strip override active
          // the two differ, and stamping the preference onto a run flown the
          // other way would put a permanent lie in the run history — and make
          // the "flown on <model>" comparison below compare against it.
          rogersKbf: effectiveKbf && !usedSupersonic,
          ...(activeConfig ? { flightConfig: savedConfigLabel(activeConfig) } : {}),
          // Provenance for the .ork <flightdata> guard: what this flight was
          // computed FROM, so a later export can prove the design, motors and
          // conditions have not moved since — and refuse to write the numbers
          // when they have.
          ...(activeConfigId !== null ? { flightConfigId: activeConfigId } : {}),
          designKey: shortHash(physicsKey),
          motorSetKey: motorSetKeyOf(assigned),
        });
        // Bound to the run it produced — the id is what lets a click through
        // the history table come back to these charts.
        setResult({ runId: run.id, value: res });
        setLastRun(run);
        setLastSimCost({ ms: execMs, ...(launch.timeStepS != null ? { timeStepS: launch.timeStepS } : {}) });
        recordRuns(addRun(run));
        setSimError(null);
      } catch (e) {
        setSimError(e instanceof Error ? e.message : String(e));
      } finally {
        setSimulating(false);
      }
    });
  };

  /**
   * The flown motor set as one comparable string: every mount that carried a
   * motor, WHICH motor, the delay it flew and its ignition setting.
   *
   * The stored run's `motor`/`delayS` describe only the PRIMARY mount and
   * `boosterMotors` is labels-only, so neither can tell a two-stage design
   * re-motored on the booster from the same design untouched.
   *
   * The manufacturer is part of the identity, not decoration: designations
   * are not unique across vendors (an AeroTech J350 and a Cesaroni J350 are
   * different motors with different curves), and the EX library keys on the
   * exact imported entry because two vendors' same-designation curves coexist
   * there. Without them, swapping vendors would leave the old flight's
   * numbers looking current.
   */
  const motorSetKeyOf = useCallback((set: [string, MountMotor][]): string =>
    [...set]
      .map(([id, mm]) => [
        id,
        mm.meta.exMotorId ?? `${mm.meta.manufacturer ?? ''}/${mm.spec.designation}`,
        mm.spec.ejectionDelay,
        mm.ignition.event,
        mm.ignition.delay,
      ].join(':'))
      .sort()
      .join('|'), []);

  /**
   * The provenance of the design as it stands RIGHT NOW, for comparison
   * against what a stored run recorded at launch. Every term is stamped onto
   * every run by onLaunch, so the comparison is like-for-like.
   *
   * effectiveKbf, not the stored preference: with the vitals strip's session
   * override active the two differ, and the run this is compared against was
   * stamped with the effective value.
   */
  const currentMatchKey = useMemo<DesignMatchKey | null>(() => {
    if (!built || !primaryMountId) return null;
    return {
      designKey: shortHash(physicsKey),
      motorSetKey: motorSetKeyOf(assigned),
      conditionsKey: conditionsKeyOf(launch),
      aeroMode,
      effectiveKbf,
      autoSupersonic,
    };
  }, [built, primaryMountId, physicsKey, assigned, launch, aeroMode, effectiveKbf,
    autoSupersonic, motorSetKeyOf]);

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
    if (!currentMatchKey || !built || !primaryMountId) return false;
    if (reflightCache.has(run.id)) return false;
    return runMatchesDesign(run, currentMatchKey);
  }, [currentMatchKey, built, primaryMountId, reflightCache]);

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
   * flight exactly rather than approximating it.
   */
  const showChartsFor = useCallback(async (run: SimRun): Promise<void> => {
    if (!built || !primaryMountId) return;
    setReflying(run.id);
    setLastRun(run);
    // Let the busy state paint before the synchronous simulation blocks.
    await afterPaint();
    try {
      const primary = mountMotors[primaryMountId]!;
      if (run.delayS !== primary.spec.ejectionDelay) {
        built.rocket.setMotorById(primaryMountId, { ...primary.spec, ejectionDelay: run.delayS });
      }
      // canShowCharts already required the run's model to equal the current
      // one, so the handle is right as it stands. It is set explicitly anyway
      // — in Auto the same effective model can be reached with the session's
      // upgrade flag either way, and a handle rebuilt since the flag flipped
      // would otherwise be silently one model behind.
      built.rocket.setSupersonicAero(effectiveSupersonic);
      built.rocket.setRogersModifiedBarrowman(effectiveKbf);
      const res = built.rocket.simulate(kernelSimOptions(launch));
      cacheFlight(run.id, res);
      setSimError(null);
    } catch (e) {
      setSimError(e instanceof Error ? e.message : String(e));
    } finally {
      setReflying(null);
    }
  }, [built, primaryMountId, mountMotors, launch, effectiveSupersonic, effectiveKbf, cacheFlight]);

  /**
   * Re-flies the LAST launch with `series: 'full'` for the flight-data CSV.
   * simulate() now defaults to the summary series payload (all the report
   * needs); the CSV wants every series the kernel records, and the physics
   * is deterministic — same design/motor/conditions/seed reproduce the shown
   * flight exactly, just with more columns. Reuses the Launch path's engine
   * handle and kernelSimOptions — no second sim-setup.
   */
  const fetchFullSeriesResult = useCallback(async (): Promise<FlightResult> => {
    if (!built || !primaryMountId || !lastRun) {
      throw new Error('no flight in memory — press Launch first');
    }
    // Let the caller's busy state paint before the synchronous re-simulation.
    await afterPaint();
    const primary = mountMotors[primaryMountId]!;
    if (lastRun.delayS !== primary.spec.ejectionDelay) {
      // Auto delay flew the rounded optimum (recorded on the run); a handle
      // rebuilt since launch (auto-supersonic flips the build memo) still
      // holds the pre-probe spec — restore the flown delay before re-flying.
      built.rocket.setMotorById(primaryMountId, { ...primary.spec, ejectionDelay: lastRun.delayS });
    }
    // Restore the model the SHOWN flight was flown on, not whatever is
    // selected now. Since a model switch no longer discards the flight, the
    // two can differ — and a CSV that re-flew on today's model would be a
    // different flight from the plots it sits under, under the same name.
    const wasSupersonic = lastRun.aeroModel === 'supersonic'
      || lastRun.aeroModel === 'auto-supersonic';
    const wasKbf = lastRun.rogersKbf ?? effectiveKbf;
    built.rocket.setSupersonicAero(wasSupersonic);
    built.rocket.setRogersModifiedBarrowman(wasKbf);
    try {
      return built.rocket.simulate({ ...kernelSimOptions(launch), series: 'full' });
    } finally {
      // Hand the shared handle back exactly as it was: the drag panel and the
      // component table read it too, and they follow the CURRENT model.
      built.rocket.setSupersonicAero(effectiveSupersonic);
      built.rocket.setRogersModifiedBarrowman(effectiveKbf);
    }
  }, [built, primaryMountId, lastRun, mountMotors, launch, effectiveSupersonic, effectiveKbf]);

  // ---- design file I/O (.ork native, .rkt RockSim) ----
  const toExportMotor = (mm: MountMotor): OrkExportMotor => {
    // EX motors: the file gets the REAL manufacturer from the imported
    // .eng/.rse, never the "EX" browser badge (the desktop would hunt for a
    // manufacturer literally named EX and lose the motor), and never a
    // digest — the desktop's digest is over ITS data file, which we lack.
    const ex = mm.meta.manufacturer === 'EX';
    // The exact library entry (meta.exMotorId, pinned at pick time) wins over
    // the designation-only find: two vendors' same-designation curves coexist
    // (motorId = slug(manufacturer+designation)), and the designation find
    // wrote whichever vendor imported first into the file.
    const exLib = ex ? loadExMotors() : [];
    const exRealRaw = (
      (mm.meta.exMotorId ? exLib.find((m) => m.motorId === mm.meta.exMotorId) : undefined)
      ?? exLib.find((m) => m.designation === mm.spec.designation)
    )?.realManufacturer;
    // An .rse with no mfg attribute carries the 'EX' sentinel — a display
    // badge, not a manufacturer. Omit it from the file: no desktop motor is
    // literally named EX (the match would always fail), while omission lets
    // the designation-only description tier still find the motor.
    const exReal = exRealRaw && exRealRaw !== 'EX' ? exRealRaw : undefined;
    // <type> per the desktop Motor.Type names: the file's own value verbatim
    // when the motor came from a .ork, else mapped from the thrustcurve
    // catalog type; omitted (never guessed) when neither is known.
    const type = mm.meta.orkType
      ?? (mm.meta.type === 'SU' ? 'single'
        : mm.meta.type === 'reload' ? 'reload'
        : mm.meta.type === 'hybrid' ? 'hybrid'
        : undefined);
    return {
      designation: mm.spec.designation,
      // The file identity wins over the display abbreviation — but the
      // thrustcurve abbrevs (AeroTech/Cesaroni/Estes…) are registered desktop
      // alternate names, so a database-picked motor still matches.
      manufacturer: ex ? exReal : mm.meta.orkManufacturer ?? mm.meta.manufacturer,
      ...(type ? { type } : {}),
      ...(!ex && mm.meta.orkDigest ? { digest: mm.meta.orkDigest } : {}),
      diameter: mm.spec.diameter,
      length: mm.spec.length,
      delay: mm.spec.ejectionDelay,
      ignitionEvent: mm.ignition.event,
      ignitionDelay: mm.ignition.delay,
    };
  };

  const exportMotorsMap = (): Record<string, OrkExportMotor> => {
    const motors: Record<string, OrkExportMotor> = {};
    for (const [id, mm] of assigned) {
      motors[id] = toExportMotor(mm);
    }
    return motors;
  };

  /**
   * Which configurations may carry computed results into an exported `.ork`,
   * and what those results are — option (c) from the 2026-08-26 batch: write
   * the flight WE computed, guarded, rather than copying the original file's
   * blocks (which would show desktop a stale result computed from a design
   * that no longer exists, with nothing on screen saying so) or writing
   * nothing at all.
   *
   * A configuration qualifies only when the newest stored run that names it
   * proves it was flown from THIS design, THIS motor set and THESE conditions.
   * Anything else — a changed fin, a different delay, a run stored before the
   * provenance keys existed — yields no entry, and that configuration stays
   * `notsimulated`, which is exactly what desktop shows for a simulation it
   * has not run.
   */
  const flightDataForExport = useCallback((): Record<string, OrkExportFlightData> => {
    const out: Record<string, OrkExportFlightData> = {};
    const designNow = shortHash(physicsKey);
    const conditionsNow = conditionsKeyOf(launch);
    for (const r of runs) {
      // Newest-first, so the first qualifying run per config wins.
      if (!r.flightConfigId || out[r.flightConfigId]) continue;
      if (!savedConfigs.some((c) => c.id === r.flightConfigId)) continue;
      if (r.designKey !== designNow) continue;
      if (r.conditionsKey !== conditionsNow) continue;
      // The model too. Without this a run the app itself marks "flown on a
      // different model" would be written into the file as that
      // configuration's up-to-date result — the exact authoritative-looking
      // wrong number this guard exists to prevent. UNKNOWN (a run predating
      // the field) is a refusal here, as everywhere the numbers travel.
      if (runMatchesModel(r, { aeroMode, effectiveKbf, autoSupersonic }) !== true) continue;
      // The motor set is compared against the CONFIGURATION's own motors, not
      // the live working set: a user who has since switched configurations
      // must still be able to export the results of the others.
      const cfg = savedConfigs.find((c) => c.id === r.flightConfigId)!;
      const cfgMotors: [string, MountMotor][] = cfg.id === activeConfigId
        ? assigned
        : Object.entries(cfg.motors);
      if (r.motorSetKey !== motorSetKeyOf(cfgMotors)) continue;
      out[r.flightConfigId] = {
        maxAltitude: r.maxAltitude,
        maxVelocity: r.maxVelocity,
        maxAcceleration: r.maxAcceleration,
        maxMach: r.maxMach,
        timeToApogee: r.timeToApogee,
        flightTime: r.totalFlightTime,
        groundHitVelocity: r.groundHitVelocity,
        launchRodVelocity: r.rodExitVelocity,
        deploymentVelocity: r.velocityAtDeployment,
        optimumDelay: r.optimumDelayS,
      };
    }
    return out;
  }, [runs, savedConfigs, activeConfigId, assigned, physicsKey, launch, motorSetKeyOf,
    aeroMode, effectiveKbf, autoSupersonic]);

  /**
   * Stage B: the stored presets in exportOrk's shape. Stable ids ride
   * through; the writer swaps the ACTIVE config's motors for the live
   * working set, so in-app edits persist into the saved file.
   */
  const exportConfigs = (): OrkExportConfig[] => savedConfigs.map((c) => ({
    id: c.id, name: c.name, isDefault: c.isDefault,
    motors: Object.fromEntries(
      Object.entries(c.motors).map(([id, mm]) => [id, toExportMotor(mm)])),
    ...(c.deployments ? { deployments: c.deployments } : {}),
    ...(c.separations ? { separations: c.separations } : {}),
  }));

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
    glb: { mime: 'model/gltf-binary', description: 'glTF binary 3D model' },
    stl: { mime: 'application/octet-stream', description: 'STL 3D shell' },
    csv: { mime: 'text/csv', description: 'Comma-separated values' },
    xlsx: { mime: XLSX_MIME, description: 'Excel workbook' },
  };

  /**
   * Save a design/export file. On Chrome and Edge this opens a REAL Save-As
   * dialog with the name prefilled and editable and the folder the user's
   * choice; everywhere else it downloads, and says which file it wrote and
   * where — "I did a save as a CDX1 and I don't know where it went" is a
   * tester's own sentence, and silence is what made it possible.
   */
  const download = async (content: string | Uint8Array, ext: string, suffix = '') => {
    // CSV gets a UTF-8 BOM: headers can carry non-ASCII (units, symbols), and
    // Excel's double-click open decodes BOM-less CSV as the ANSI codepage.
    // Same convention as the flight-data and run-history CSVs (SimResults).
    const info = FORMAT_INFO[ext] ?? { mime: 'application/octet-stream', description: 'File' };
    const parts: BlobPart[] = ext === 'csv' ? [CSV_BOM, content as BlobPart] : [content as BlobPart];
    const name = `${safeName(tree.name ?? 'rocket')}${suffix}.${ext}`;
    const out = await saveFile(new Blob(parts, { type: info.mime }), {
      suggestedName: name,
      mime: info.mime,
      extensions: [`.${ext}`],
      description: info.description,
    });
    if (out.kind === 'downloaded') {
      setFileNote(out.fellBack
        // The dialog opened and then the write failed — a full disk, a locked
        // file, a revoked permission. Reporting a plain success there would
        // send the user looking in the folder they picked.
        ? `Couldn't write to the folder you chose (${out.fellBack}) — `
          + `“${out.name}” went to your browser's download folder instead.`
        : `Saved “${out.name}” to your browser's download folder.`,
      out.fellBack ? 'warn' : 'info');
    } else if (out.kind === 'saved') {
      setFileNote(`Saved “${out.name}”.`);
    }
    // 'cancelled' says nothing — the user pressed Cancel, and an app that
    // reports on that is an app that nags.
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

  const onSaveOrk = async () => {
    // WITH launch: the .ork's first <simulation> carries the pad and weather,
    // so the file (and the desktop app) round-trips the whole flight setup.
    await download(exportOrk({
      name: tree.name ?? 'My Rocket', tree, motors: exportMotorsMap(), launch,
      configs: exportConfigs(), activeConfigId, measured,
      flightData: flightDataForExport(),
    }), 'ork');
  };

  const onSaveRkt = async () => {
    try {
      // Computed mass/CG per partially-overridden component: RockSim couples
      // both under one flag, so the un-overridden half must export its
      // CALCULATED value (issue 2026-08-05b #11).
      const compInfo: Record<string, { mass: number; cgX: number }> = {};
      if (built) {
        const collect = (nodes: ComponentNode[]) => {
          for (const n of nodes) {
            if (n.id && (typeof n['overrideMass'] === 'number') !== (typeof n['overrideCGX'] === 'number')) {
              try {
                const info = built.rocket.componentInfo(n.id);
                compInfo[n.id] = { mass: info.mass, cgX: info.cgX };
              } catch { /* component not in the engine tree — skip */ }
            }
            collect(n.children ?? []);
          }
        };
        collect(tree.components);
      }
      await download(exportRkt({ name: tree.name ?? 'My Rocket', tree, motors: exportMotorsMap(), compInfo }), 'rkt');
    } catch (e) {
      setFileNote(`RockSim export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const onSaveCdx1 = async () => {
    try {
      // The RASAero writer THROWS on ordinary designs it cannot represent
      // (>3 stages, two fin sets on a tube, freeform/elliptical fins,
      // non-conical transitions, unsupported nose shapes). The catch below is
      // the only thing between that and a silent no-file — which is a second,
      // entirely separate explanation for "I don't know where it went".
      await download(exportCdx1({
        name: tree.name ?? 'My Rocket',
        tree,
        launchMassKg: built?.info.mass,
        launchCgM: built?.info.cg,
        launch,
        // Engine strings ride when rasaeroFile's CDX1_ENGINE_EXPORT gate is on
        // — it has been since 2026-08-25, proven against real RASAero II with a
        // single-stage file. The gate stays because RASAero throws an NRE on
        // motor names its own database lacks; flipping it back is one line
        // there.
        motors: exportMotorsMap(),
      }), 'CDX1');
    } catch (e) {
      setFileNote(`RASAero export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

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
      setFileNote(`OBJ export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const onSaveGlb = async () => {
    try {
      const { rocketToGlb } = await import('./services/gltfExport.js');
      await download(new Uint8Array(await rocketToGlb(tree, tree.name ?? 'Rocket')), 'glb');
    } catch (e) {
      setFileNote(`glTF export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const onSaveStl = async () => {
    try {
      const [{ buildPieces }, { piecesToStl }] = await Promise.all([
        import('./components/Rocket3D.js'),
        import('./services/stlExport.js'),
      ]);
      const { pieces } = buildPieces(tree);
      await download(piecesToStl(pieces, tree.name ?? 'Rocket'), 'stl');
    } catch (e) {
      setFileNote(`STL export failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  /**
   * Matches ONE imported motor reference: built-ins first, then the motor
   * database — the per-mount pass applyImported always did, factored out so
   * config presets run the same matching. Returns the loaded motor (absent
   * when nothing matched) and the note describing what happened; the caller
   * decides whether the note surfaces (applied config) or waits (presets).
   */
  const matchImportedMotor = async (ref: OrkMotorRef): Promise<{ motor?: MountMotor; note: string }> => {
    const builtIn = Object.entries(BUILT_IN_MOTORS).find(
      ([k]) => k.startsWith(ref.designation));
    const ignition: MountMotor['ignition'] = {
      event: (ref.ignitionEvent as IgnitionEvent | undefined) ?? 'automatic',
      delay: ref.ignitionDelay ?? 0,
    };
    // The FILE's motor identity rides the meta so Save writes it back
    // verbatim and the desktop's matcher resolves silently (digest tier).
    // 'unknown' is our reader's fallback and 'custom' our old writer's — both
    // are sentinels, not manufacturers, and must not be re-exported.
    const fileIdentity: Partial<MotorMeta> = {
      ...(ref.manufacturer && ref.manufacturer !== 'unknown' && ref.manufacturer !== 'custom'
        ? { orkManufacturer: ref.manufacturer } : {}),
      ...(ref.motorType ? { orkType: ref.motorType } : {}),
      ...(ref.digest ? { orkDigest: ref.digest } : {}),
    };
    if (builtIn) {
      // Keep the FILE's ejection delay — the built-in key's own delay
      // (e.g. C6-5 matching a saved C6-7) would silently change the flight.
      // Infinity is a VALID file delay (plugged, .ork "none") — only fall
      // back to the built-in's delay when the file carried none.
      const fileDelay = ref.delay === Infinity ? Infinity
        : Number.isFinite(ref.delay) ? ref.delay : builtIn[1].ejectionDelay;
      const label = labelWithDelay(builtIn[0], fileDelay);
      return {
        motor: {
          label,
          spec: { ...builtIn[1], ejectionDelay: fileDelay },
          meta: { ...builtInMeta(builtIn[0]), ...fileIdentity },
          ignition,
        },
        note: `Motor: ${label} (matched built-in).`,
      };
    }
    // RockSim refs carry no motor diameter (0) — match by designation only.
    const dbMatch = findDbMotor(ref.designation, ref.diameter > 0 ? ref.diameter * 1000 : undefined);
    if (!dbMatch) {
      return { note: `Motor “${ref.designation}” isn't in the motor database — pick one via Browse motor database.` };
    }
    try {
      const spec = await fetchMotorSpec(dbMatch, ref.delay);
      // Plugged motors (Infinity delay) display the standard "-P" suffix.
      const delayTag = Number.isFinite(ref.delay) ? String(ref.delay) : 'P';
      const label = `${dbMatch.commonName}-${delayTag}`;
      return {
        motor: {
          label,
          spec,
          meta: {
            label,
            manufacturer: dbMatch.manufacturerAbbrev,
            availableDelays: delayOptions(dbMatch),
            type: dbMatch.type,
            propellant: dbMatch.propInfo,
            motorCase: dbMatch.caseInfo,
            highPower: isHighPower(dbMatch),
            ...fileIdentity,
          },
          ignition,
        },
        note: `Motor: ${dbMatch.manufacturerAbbrev} ${displayDesignation(dbMatch.designation, dbMatch.manufacturerAbbrev)}-${delayTag} (loaded from the motor database).`,
      };
    } catch {
      return { note: `Motor “${ref.designation}” is in the motor database but its thrust curve couldn't be downloaded — pick it via Browse motor database.` };
    }
  };

  /**
   * Applies an imported design to the app — the ONE apply path, shared by
   * Open… and the share-link loader so a linked rocket behaves exactly like
   * an opened file: per-mount motor matching (built-ins first, then the
   * motor database), launch conditions, notes, the camera-shroud offer.
   *
   * There used to be an `withoutMotors` option here, driven by the config
   * picker's "Open with no motors loaded" button. The picker is gone
   * (2026-08-22b) and nothing else ever passed it, so the option went with it.
   * The capability did NOT: ⏏ Unload in the vitals strip and the "None" row in
   * the Flight configurations panel both empty the working set in one click.
   */
  const applyImported = async (imported: ImportedDesign) => {
    // Freshly parsed by THIS build's importer, so the autosave-is-stale warning
    // no longer applies to what is on screen.
    setRestoredByOlderBuild(false);
    const notes: string[] = [`Loaded “${imported.name}”.`, ...imported.notes];
    // Load EVERY mount's motor (staged/multi-mount files included).
    //
    // Only motor PROBLEMS go in the note. The successful "Motor: C6-5 (matched
    // built-in)." sentences used to go here too, and they were the note's worst
    // habit: nothing in the motor path rewrites this note, so after the user
    // loaded a different motor the box still named the old one — reported from
    // the beta by Big Dog, and true of every motor change, not just his. The
    // vitals strip and the Motors tab both show the loaded motor live, so the
    // note has no business restating it. What it IS still the only source of is
    // a motor that could not be matched or downloaded.
    const nextMotors: Record<string, MountMotor> = {};
    for (const [nodeId, ref] of Object.entries(imported.motors)) {
      const { motor: mm, note } = await matchImportedMotor(ref);
      if (mm) nextMotors[nodeId] = mm;
      else notes.push(note);
    }
    // Stage B: every configuration in the file becomes a ready-to-apply
    // preset, matched in the same pass. Only the APPLIED config's notes
    // surface — a preset's failures are reported if/when it is applied.
    const chosenId = imported.chosenConfigId ?? null;
    const nextConfigs: SavedConfig[] = [];
    for (const cfg of imported.configs ?? []) {
      const cfgMotors: Record<string, MountMotor> = {};
      const unmatched: string[] = [];
      for (const [nodeId, ref] of Object.entries(cfg.motors)) {
        // The applied config's motors were matched (and reported) above —
        // reuse them rather than re-fetching the same thrust curves.
        const mm = cfg.id === chosenId
          ? nextMotors[nodeId]
          : (await matchImportedMotor(ref)).motor;
        if (mm) cfgMotors[nodeId] = mm;
        else unmatched.push(ref.designation);
      }
      nextConfigs.push({
        id: cfg.id, name: cfg.name, isDefault: cfg.isDefault, motors: cfgMotors,
        ...(unmatched.length > 0 ? { unmatched } : {}),
        ...(cfg.deployments && Object.keys(cfg.deployments).length > 0
          ? { deployments: cfg.deployments } : {}),
        ...(cfg.separations && Object.keys(cfg.separations).length > 0
          ? { separations: cfg.separations } : {}),
      });
    }
    const importedTree = normalizeTree(imported.tree);
    setTree(importedTree);
    setMountMotors(nextMotors);
    setSavedConfigs(nextConfigs);
    setActiveConfigId(chosenId);
    setFileMachAlt(imported.machAlt);
    setMaxMotorLen({}); // imported stages have fresh ids — old limits don't apply
    setSelectedId(null);
    // Launch conditions from the file (.ork's first <simulation>): apply
    // EVERY field the file carried — explicit nulls included (an ISA file
    // sets temperature/pressure to null deliberately) — and keep the
    // panel's fields the file didn't mention. The importer already pushed
    // a user-visible note about what it found.
    // timeStepS is the exception to "keep what the file didn't mention": it is
    // a FIDELITY setting belonging to the file, not a site condition the user
    // set. Merging it made it sticky — open a .ork carrying 0.01 and every
    // later design, including .rkt and .CDX1 imports that carry no step at all,
    // silently inherited it and ran several times slower forever. Always
    // assign, so a file without one goes back to the engine default.
    //
    // Deliberate, but not silent: the importer's notes only speak up when a
    // FILE carries a sub-default step, so a step typed into the panel was
    // being replaced with nothing on screen to say so. Compared as effective
    // values — blank and 0.05 both fly the default, and that non-change is
    // not worth a sentence. Counted AFTER motorTrouble below, which must keep
    // meaning "a motor needs the user's attention", not this.
    //
    // Says what will be FLOWN, never "the file sets" — imported.launch.timeStepS
    // is already past the importer's clamp, so a file asking for 0.005 arrives
    // here as 0.05 and attributing that to the file contradicted the importer's
    // own note directly above it in the same box. What the file asked for, and
    // why it was refused, is that note's job.
    const motorTrouble = notes.length > 1 + imported.notes.length;
    const prevStepS = launch.timeStepS ?? DEFAULT_TIME_STEP_S;
    const nextStepS = imported.launch?.timeStepS ?? DEFAULT_TIME_STEP_S;
    if (prevStepS !== nextStepS) {
      notes.push(imported.launch?.timeStepS != null
        ? `Flights here now use a ${fmtStepS(nextStepS)} s simulation time step, replacing `
          + `the ${fmtStepS(prevStepS)} s they were using.`
        : `The simulation time step is back to the ${fmtStepS(DEFAULT_TIME_STEP_S)} s default `
          + `— this file carries none, and the ${fmtStepS(prevStepS)} s in the Launch panel `
          + 'belonged to the design it was set for.');
    }
    if (imported.launch) {
      setLaunch((prev) => ({ ...prev, ...imported.launch, timeStepS: imported.launch!.timeStepS }));
    } else {
      setLaunch((prev) => ({ ...prev, timeStepS: undefined }));
    }
    // What the builder weighed, if the file carried it. Always assigned — a
    // file WITHOUT the numbers must clear the previous rocket's, or the box
    // would report the new design's gap against someone else's scale.
    setMeasured(imported.measured ?? { massKg: null, cgM: null });
    // A file whose motors all matched is routine information; one that lost a
    // motor is a warning the user has to act on (motorTrouble was counted
    // before the time-step note, which is information either way).
    setFileNote(notes.join('\n'), motorTrouble ? 'warn' : 'info');
    // Hand-rolled shrouds (1-fin freeform sets named like "Camera Shroud")
    // get an offer to become the native fairing component (2026-08-05e).
    const shrouds = findShroudCandidates(importedTree);
    setShroudPrompt(shrouds.length ? shrouds : null);
  };

  /** Loads a flight-configuration preset into the working set (Stage B). */
  const applyConfig = (cfg: SavedConfig) => {
    setMountMotors(cfg.motors);
    setActiveConfigId(cfg.id);
    // A configuration is its motors AND its recovery deployment. These were
    // carried for export only, so applying one here switched the motors and
    // left the chute set the way the previously-opened configuration wanted
    // it — the one thing picking a configuration at file-open used to do that
    // this panel could not. Applying them makes the panel a complete switch,
    // which is what lets the open-time picker go away.
    // setTree takes a value, not an updater (it also runs the autosave and
    // normalisation), so fold the patches first and set once.
    const hasDeploy = cfg.deployments && Object.keys(cfg.deployments).length > 0;
    const hasSep = cfg.separations && Object.keys(cfg.separations).length > 0;
    if (hasDeploy || hasSep) {
      let next = tree;
      for (const [nodeId, d] of Object.entries(cfg.deployments ?? {})) {
        if (!findNode(next, nodeId)) continue;
        next = updateNode(next, nodeId, {
          ...(d.deployEvent !== undefined ? { deployEvent: d.deployEvent } : {}),
          ...(d.deployAltitude !== undefined ? { deployAltitude: d.deployAltitude } : {}),
          ...(d.deployDelay !== undefined ? { deployDelay: d.deployDelay } : {}),
        });
      }
      // Separation must be written even when it is the kernel default
      // ("ejection"): the point is to REPLACE whatever the previously applied
      // configuration left behind, so skipping the default would strand a
      // "never" from the last one.
      for (const [nodeId, sep] of Object.entries(cfg.separations ?? {})) {
        if (!findNode(next, nodeId)) continue;
        next = updateNode(next, nodeId, {
          ...(sep.separationEvent !== undefined ? { separationEvent: sep.separationEvent } : {}),
          ...(sep.separationDelay !== undefined ? { separationDelay: sep.separationDelay } : {}),
          ...(sep.separationAltitude !== undefined ? { separationAltitude: sep.separationAltitude } : {}),
        });
      }
      if (next !== tree) setTree(next);
    }
    // Always rewrite the note, never only on failure. Writing it solely when
    // `unmatched` was non-empty meant a clean switch left the PREVIOUS file's
    // note standing — the staleness Big Dog reported reads as arbitrary
    // precisely because some actions refresh the box and others don't.
    if (cfg.unmatched?.length) {
      // Quiet at import time (only the applied config reports) — the debt
      // comes due when the user actually loads this preset.
      setFileNote(cfg.unmatched.map((d) =>
        `Motor “${d}” couldn't be matched when the file was opened — pick one via Browse motor database.`).join('\n'), 'warn');
    } else {
      setFileNote(`Flight configuration “${cfg.name || cfg.id}” applied — its motors and recovery settings are now live.`);
    }
  };

  /** The "None" row / full unload: no motors, no active configuration. */
  const clearConfig = () => {
    const had = Object.keys(mountMotors).length > 0;
    setMountMotors({});
    setActiveConfigId(null);
    // Every other action in the Flight configurations panel confirms through
    // the notice bar; this one said nothing, and it is now the last control on
    // the tab. The copy has to read correctly from the vitals strip's
    // ⏏ Unload button too, which is the same function.
    if (had) setFileNote('Every motor unloaded — the rocket is shown and weighed clean.');
  };

  // Desktop OpenRocket's default rocket name is literally "Rocket" (users
  // name the file instead) — fall back to the filename in that case. A
  // helper because the config picker re-parses (fresh node ids), and the
  // fallback must re-run on whichever parse is actually applied.
  const applyNameFallback = (imported: ImportedDesign, fileName: string) => {
    if (!imported.tree.name
        || GENERIC_ROCKET_NAMES.has(imported.tree.name.trim().toLowerCase())) {
      const fromFile = fileName.replace(/\.(ork|rkt|cdx1)$/i, '').replace(/_+/g, ' ').trim();
      if (fromFile) {
        imported.tree.name = fromFile;
        imported.name = fromFile;
      }
    }
  };

  const onOpenOrk = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      if (/\.(rkt|cdx1)$/i.test(file.name)) {
        const imported = /\.rkt$/i.test(file.name) ? importRkt(buffer) : importCdx1(buffer);
        applyNameFallback(imported, file.name);
        await applyImported(imported);
        return;
      }
      const imported = importOrk(buffer);
      applyNameFallback(imported, file.name);
      // A multi-configuration .ork used to stop here and ask which one to
      // open. Two testers found that modal the worst moment in the app — it
      // was the FIRST thing a new user saw, and it listed configurations by
      // the only thing most files give them, an OpenRocket GUID. We now open
      // the file's own default configuration, exactly as desktop OpenRocket
      // does, and say which one in the import note; the Flight configurations
      // panel on Motors & Launch switches between them (motors AND recovery
      // deployment, since applyConfig applies both now).
      await applyImported(imported);
    } catch (e) {
      // Name the format the user actually picked. This handler takes .ork, .rkt
      // and .CDX1, and hard-coding ".ork" made a precise importer message read
      // as nonsense — "Could not open that .ork file: This is an older BINARY
      // RockSim file…".
      const ext = /\.(rkt|cdx1|ork)$/i.exec(file.name);
      const kind = ext ? `.${ext[1]!.toLowerCase().replace('cdx1', 'CDX1')}` : '';
      setFileNote(`Could not open that${kind ? ` ${kind}` : ''} file: `
        + `${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ---- "Open from a link": #d=<compressed .ork> in the URL fragment ----
  // Decoded once at startup, then the fragment is cleared up front —
  // declined and broken links included — so a reload never re-triggers it.
  // Every failure lands in the file-note with the current design untouched;
  // a bad link must never blank the app.
  const shareHandled = useRef(false);
  useEffect(() => {
    if (shareHandled.current || !hasSharePayload(window.location.hash)) return;
    shareHandled.current = true; // StrictMode double-invoke guard (the ref survives the remount)
    const hash = window.location.hash;
    // window.history explicitly — plain `history` is this component's undo ref.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    void (async () => {
      try {
        // Cheap pre-decode cap: no real share link approaches 1 MB of
        // fragment, and a crafted one can inflate to hundreds of MB — refuse
        // it before base64/inflate ever run (same soft-fail path as a
        // corrupt link; the current design stays untouched either way).
        if (hash.length > MAX_FRAGMENT_CHARS) {
          throw new Error('the link is far longer than any real design — refusing to decode it');
        }
        const imported = importOrk(await decodeShareFragment(hash));
        // A restored session still holding the untouched starter rocket is
        // replaced silently; a design the user actually worked on gets a
        // confirm dialog (declining keeps it — the link is simply dropped).
        if (session && !isPristineDefault(initialTree)) setShareOffer(imported);
        else await applyImported(imported);
      } catch (e) {
        setFileNote(`Couldn't open the design in this link — it looks damaged or cut short (chat apps sometimes truncate very long links). Ask for the link again, or for the .ork file. (${e instanceof Error ? e.message : String(e)})`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot startup decode
  }, []);

  /**
   * Copy-share-link (Save/Export menu): the WHOLE design — components,
   * motors, launch conditions — deflated into the URL fragment, which never
   * reaches a server (see services/shareLink.ts).
   */
  const onCopyShareLink = async () => {
    try {
      const xml = exportOrk({
        name: tree.name ?? 'My Rocket', tree, motors: exportMotorsMap(), launch,
        // Included so a share link reproduces exactly what saving the file
        // reproduces — the recipient sees the sender's weighed build, which is
        // the rocket the "Build allowance" in the tree belongs to.
        configs: exportConfigs(), activeConfigId, measured,
        // Same rule: a link must open to the same file a save would write.
        flightData: flightDataForExport(),
      });
      const frag = await encodeShareFragment(xml);
      const url = `${window.location.origin}${window.location.pathname}${window.location.search}${frag}`;
      // Chat apps truncate very long messages, and a truncated link decodes
      // to nothing — warn at the copy, not after a confused report.
      const sizeNote = url.length > 64 * 1024
        ? '\nHeads up: this design is complex, so the link is very long — some chat apps truncate long messages, and a cut-off link won’t open. If it fails for the recipient, send the .ork file instead.'
        : '';
      try {
        await navigator.clipboard.writeText(url);
        setFileNote(`Share link copied — opening it loads “${tree.name ?? 'My Rocket'}” with its motors and launch conditions.${sizeNote}`);
      } catch {
        // Clipboard refused (permissions, iframe embed, non-secure context):
        // hand the link over for a manual Ctrl+C — prompt() pre-selects it.
        window.prompt('Copy this share link (Ctrl+C):', url);
        if (sizeNote) setFileNote(sizeNote.trim());
      }
    } catch (e) {
      setFileNote(`Share link failed: ${e instanceof Error ? e.message : String(e)}`);
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

  const selectedNode = selectedId ? findNode(tree, selectedId) : null;
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
  const mountDiaMm = (m: ReturnType<typeof findNode>) => m
    ? Math.round((m['caseAirframe'] === true
      ? (m['outerRadius'] as number ?? 0.0095)
      : (m['outerRadius'] as number ?? 0.0095) - (m['thickness'] as number ?? 0.0005)) * 2000)
    : 18;
  // Batch simulate targets the PRIMARY (sustainer) mount; per the owner's rule
  // batch never runs across staged rockets (combinatorics).
  const primaryMountNode = primaryMountId ? findNode(tree, primaryMountId) : null;
  const primaryMotorCount = clusterCount(primaryMountNode?.['cluster'] as string | undefined);
  const primaryLabel = primaryMountId ? mountMotors[primaryMountId]?.label : undefined;

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
      count: clusterCount(node?.['cluster'] as string | undefined),
    };
  }), [mounts, tree, stageList]);

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
  const apogeeStale = modelMatch === false;

  // "Try Auto & re-fly" from the supersonic-flight alert: once the session
  // override has propagated (aeroMode now 'auto') and the engine handle has
  // been rebuilt with it, fire a fresh launch.
  useEffect(() => {
    if (!pendingRelaunch || !built || !primaryMountId) return;
    setPendingRelaunch(false);
    onLaunch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRelaunch, built, primaryMountId]);

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
            </span>
          </div>
          <label className="file-btn" title="Open an OpenRocket (.ork), RockSim (.rkt), or RASAero II (.CDX1) design">
            <Icon name="folder" /> Open…
            {/* Visually hidden, NOT display:none — the input must stay in the
                Tab order so the keyboard can reach it (Enter/Space opens the
                picker); the label paints its focus ring via :focus-within. */}
            <input type="file" accept=".ork,.rkt,.CDX1" className="file-btn-input"
              aria-label="Open a design file"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onOpenOrk(f);
                e.target.value = '';
              }} />
          </label>
          <div className="file-menu-wrap">
            <button className="file-btn" onClick={() => setShowFileMenu((v) => !v)}
              aria-haspopup="menu" aria-expanded={showFileMenu}>
              {/* "Save As": every entry writes a NEW file/download — nothing
                  saves back in place, so the label says what the button does
                  (Eric's ruling, 2026-08-25). */}
              <Icon name="save" /> Save As / Export ▾
            </button>
            {showFileMenu && (
              <>
                <div className="file-menu-backdrop" onClick={() => setShowFileMenu(false)} />
                <div className="file-menu" role="menu" onClick={() => setShowFileMenu(false)}>
                  <button onClick={() => { void onSaveOrk(); }}>Save .ork — OpenRocket design</button>
                  <button onClick={() => { void onCopyShareLink(); }}
                    title="The whole design — components, motors, launch conditions — packed into a link you can paste in chat or email. It opens right in the browser; the design travels in the link itself and never touches a server.">
                    🔗 Copy share link
                  </button>
                  <button onClick={() => { void onSaveRkt(); }}
                    title="RockSim design (max 3 stages; clusters split into individual tubes)">
                    Save .rkt — RockSim
                  </button>
                  <button onClick={() => { void onSaveCdx1(); }}
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
          <button className="file-btn" onClick={undo} title="Undo the last design change (Ctrl+Z) — 50 steps">
            ↩ Undo
          </button>
          <button className="file-btn" data-tour="guide" onClick={() => setShowGuide(true)} title="User guide — quick start, features, and the physics behind the sim">
            <Icon name="book" /> Guide
          </button>
          {/* Replay lives in the header, not inside the Guide (batch 08-21c). */}
          <button className="file-btn" onClick={() => setTourOpen(true)}
            title="Replay the six-step interface tour">
            ⟲ Tour
          </button>
          <div className="file-menu-wrap">
            <button className="file-btn" onClick={() => setShowFeedback((v) => !v)}
              aria-haspopup="menu" aria-expanded={showFeedback}
              title="Report a bug or request a feature — filed on the public tracker; email works too, no account needed">
              <Icon name="bug" /> Feedback
            </button>
            {showFeedback && (
              <>
                <div className="file-menu-backdrop" onClick={() => setShowFeedback(false)} />
                {/* Contract first, hardcoded constants second — see the
                    FEEDBACK_REPO comment. GitHub links open a new tab (the owner's
                    ruling: don't take the user away from the site); the mailto
                    deliberately does NOT, because a mail client launched into a
                    new tab leaves a blank tab behind. */}
                <div className="file-menu" role="menu" onClick={() => setShowFeedback(false)}>
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
        {/* the owner's chosen identity line (2026-08-05b #9) — the per-model detail
            lives in Preferences and the launch report's "Aero model" row. */}
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
        <MovedNotice hostname={window.location.hostname} />
        {autosaveFailing && (
          // Persistent (not dismissible) on purpose: while this shows, edits
          // do NOT survive a reload. It clears itself on the recovery edge.
          <div className="file-note file-note-error autosave-warn" role="alert">
            ⚠ Autosave can&apos;t write (storage full or blocked) — save your
            design to a file (Save As / Export → .ork) to keep it safe.
          </div>
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
      </header>
      {showPrefs && <PreferencesDialog onClose={() => setShowPrefs(false)} />}
      {showGuide && <GuideDialog onClose={() => setShowGuide(false)} />}
      {tourOpen && <FirstRunTour onSetTab={setTab} onClose={closeTour} />}
      {showChangelog && <ChangelogDialog onClose={() => setShowChangelog(false)} />}
      {showBatch && built && primaryMountId && !isStaged && (
        <BatchSimulate
          info={built.info}
          tree={tree}
          // Every mount is batchable — a cluster ring around a central mount
          // (the owner's Darkstar) needs the RING selectable, not just the primary.
          mounts={mounts.map((m) => {
            const mNode = findNode(tree, m.id!);
            const stId = stageList[stageIndexOf(tree, m.id!)]?.id ?? '';
            return {
              id: m.id!,
              label: `${m.name ?? 'Motor mount'} (⌀ ${classLabel(diameterClass(mountDiaMm(mNode)))} mm${clusterCount(mNode?.['cluster'] as string | undefined) > 1 ? ` ×${clusterCount(mNode?.['cluster'] as string | undefined)}` : ''})`,
              diameterMm: mountDiaMm(mNode),
              motorCount: clusterCount(mNode?.['cluster'] as string | undefined),
              maxMotorLengthM: maxMotorLen[stId]
                ?? (typeof mNode?.['maxMotorLength'] === 'number' ? (mNode['maxMotorLength'] as number) : null),
            };
          })}
          initialMountId={primaryMountId}
          assignedMotors={Object.fromEntries(
            Object.entries(mountMotors).map(([id, mm]) => [id, mm.spec]))}
          launch={launch}
          rocketName={tree.name ?? 'Rocket'}
          onRunsChange={recordRuns}
          onClose={() => setShowBatch(false)}
        />
      )}
      {confirmNew && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Start a new design">
          <div className="modal-card">
            <h2>Start a new design?</h2>
            <p>
              This clears “{tree.name ?? 'the current rocket'}” — all components,
              overrides and the current simulation. Make sure it's saved as an
              .ork file first. (Ctrl+Z can still undo afterwards.)
            </p>
            <div className="modal-actions">
              <button className="file-btn" onClick={() => { onSaveOrk(); }}>
                <Icon name="save" /> Save .ork first
              </button>
              <button
                className="file-btn modal-danger"
                onClick={() => {
                  setTree(emptyTree());
                  setMountMotors({});
                  setSavedConfigs([]);
                  setActiveConfigId(null);
                  setMaxMotorLen({});
                  setSelectedId(null);
                  setResult(null);
                  setLastRun(null);
                  setConfirmNew(false);
                  // A stale "Loaded <old rocket>…" banner over a fresh design
                  // reads like the import happened again — clear both notes.
                  setFileNote(null);
                  setSimError(null);
                  setShroudPrompt(null);
                }}
              >
                Discard &amp; start new
              </button>
              <button className="file-btn" onClick={() => setConfirmNew(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      {shareOffer && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Open design from link">
          <div className="modal-card">
            <h2>Open design from this link?</h2>
            <p>
              This link opens “{shareOffer.name}”. Your current design
              “{tree.name ?? 'Rocket'}” will be replaced. If you want to keep
              it, save it as an .ork file first — declining simply drops the
              link. (Ctrl+Z can still undo afterwards.)
            </p>
            <div className="modal-actions">
              <button className="file-btn" onClick={() => { onSaveOrk(); }}>
                <Icon name="save" /> Save mine first
              </button>
              <button
                className="file-btn modal-danger"
                onClick={() => {
                  const offered = shareOffer;
                  setShareOffer(null);
                  void applyImported(offered);
                }}
              >
                Open “{shareOffer.name}”
              </button>
              <button className="file-btn" onClick={() => setShareOffer(null)}>Keep my design</button>
            </div>
          </div>
        </div>
      )}
      {shroudPrompt && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Convert camera shrouds">
          <div className="modal-card">
            <h2>Camera shroud detected</h2>
            <p>
              It looks like this file has {shroudPrompt.length === 1
                ? <>a camera shroud modeled as a one-fin freeform set (<strong>{shroudPrompt[0]!.name}</strong>)</>
                : <>{shroudPrompt.length} camera shrouds modeled as one-fin freeform sets ({shroudPrompt.map((s) => `“${s.name}”`).join(', ')})</>}.
              Convert {shroudPrompt.length === 1 ? 'it' : 'them'} to this app&apos;s native
              camera-shroud component? The native component models the shroud&apos;s real
              frontal-area drag and mass instead of treating it as a lifting fin —
              dimensions carry over, and you can fine-tune shape and as-built mass
              in its properties. (Ctrl+Z undoes the conversion.)
            </p>
            <div className="modal-actions">
              <button
                className="file-btn"
                onClick={() => {
                  const res = convertShrouds(tree, shroudPrompt.map((s) => s.id));
                  setTree(res.tree);
                  setFileNote(res.notes.join('\n'));
                  setShroudPrompt(null);
                }}
              >
                Convert to camera shroud
              </button>
              <button className="file-btn" onClick={() => setShroudPrompt(null)}>
                Keep as freeform fin
              </button>
            </div>
          </div>
        </div>
      )}
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
                  const { glyph, cls } = stabilityGlyphClass(built.info.stabilityCalibers);
                  return (
                    <span className={`vitals-value ${cls}`}>
                      {glyph} {formatStability(built.info, prefs.stabilityUnit)}
                    </span>
                  );
                })()}
              </span>
              <span className="vitals-item" title="Mass, loaded (with motors)">
                <span className="vitals-label">Mass</span>
                <span className="vitals-value">
                  {fmtSi('mass', prefs.units.mass, built.info.mass)}&nbsp;<UnitChip quantity="mass" />
                </span>
              </span>
            </>
          ) : buildError && (
            <span className="vitals-item" title={buildError}>
              <span className="vitals-label">Build</span>
              <span className="vitals-value stability-bad">⚠ error</span>
            </span>
          )}
          <span className="vitals-item" title="Motor on the primary (sustainer) mount — assign it in Motors & Launch">
            <span className="vitals-label">Motor</span>
            <span className="vitals-value">
              {primaryLabel ?? <span className="vitals-none">none</span>}
              {assigned.length > 1 ? ` +${assigned.length - 1}` : ''}
              {assigned.length > 0 && (
                // One click from ANY tab: strip every loaded motor so the
                // rocket can be viewed/weighed clean (2026-08-05 chat). A
                // labeled button — the bare ⏏ glyph was undiscoverable
                // (batch 08-21c).
                <button className="file-btn vitals-unload"
                  title="Unload all motors — view and weigh the rocket clean (empty mass, no motor silhouettes). Reload any time from Motors & Launch."
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
                <option value="kbf">Rogers Kbf</option>
                <option value="eb">Classic EB</option>
                <option value="auto">Auto</option>
                <option value="supersonic">Supersonic</option>
              </select>
              {effectiveSupersonic && aeroMode === 'auto' && (
                // Auto has upgraded itself on this design — worth saying,
                // because the select still reads "Auto".
                <span className="vitals-aero" title="Auto aero: this design flew past Mach 0.9, so stability, drag analysis and flights use the supersonic model">
                  {' '}M+
                </span>
              )}
              {aeroOverride && aeroOverride !== aeroChoiceOf(prefs) && (
                <button className="vitals-aero-revert" title={`Session override — Preferences is set to ${AERO_SHORT[aeroChoiceOf(prefs)]}. Click to go back to it.`}
                  aria-label={`Clear the session aero override and use ${AERO_SHORT[aeroChoiceOf(prefs)]}`}
                  onClick={() => setAeroOverride(null)}>↺</button>
              )}
            </span>
          </span>
          {lastApogee !== null && (
            <span className="vitals-item"
              title={apogeeStale
                ? `Apogee of the most recent flight, which was flown on ${aeroModelLabel(lastRun?.aeroModel, lastRun?.rogersKbf)} — not the model now selected. Press Launch to re-fly it.`
                : 'Apogee of the most recent flight'}>
              <span className="vitals-label">Apogee</span>
              <span className="vitals-value">
                {fmtSi('distance', prefs.units.distance, lastApogee)}&nbsp;<UnitChip quantity="distance" />
                {/* A model switch no longer throws the flight away — so the
                    number has to say when it belongs to a different model,
                    rather than being silently re-labelled under the new one. */}
                {apogeeStale && <span className="vitals-stale" aria-hidden="true"> ⚠</span>}
              </span>
            </span>
          )}
          <button
            className="launch-btn vitals-launch"
            data-tour="launch"
            onClick={onLaunch}
            disabled={!built || !primaryMountId || simulating}
            title={!primaryMountId ? 'Assign a motor first (Motors & Launch workspace)' : 'Simulate the flight'}
          >
            {simulating ? 'Simulating…' : <><Icon name="rocket" size={15} /> Launch</>}
          </button>
        </div>
        )}

        <div className="workspace-tabs" role="tablist" aria-label="Workspace">
          <button role="tab" aria-selected={tab === 'fly'}
            className={`tab-fly${tab === 'fly' ? ' active' : ''}`} onClick={() => setTab('fly')}>
            <Icon name="flame" size={13} /> Fly
          </button>
          <button role="tab" aria-selected={tab === 'design'}
            className={tab === 'design' ? 'active' : ''} onClick={() => setTab('design')}>
            <Icon name="wrench" size={13} /> Design
          </button>
          <button role="tab" aria-selected={tab === 'motors'} data-tour="motors-tab"
            className={tab === 'motors' ? 'active' : ''} onClick={() => setTab('motors')}>
            <Icon name="flame" size={13} /> Motors &amp; Launch
          </button>
          <button role="tab" aria-selected={tab === 'results'}
            className={tab === 'results' ? 'active' : ''} onClick={() => setTab('results')}>
            <Icon name="chart" size={13} /> Results
          </button>
        </div>

        {sessionNote && (
          <p className={`session-note${sessionNoteFading ? ' fading' : ''}`}>{sessionNote}</p>
        )}

        {tab === 'fly' && (
          <FlyScreen
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
            canLaunch={!!built && !!primaryMountId}
            onChangeMotor={() => setTab('motors')}
            onCompare={() => setShowBatch(true)}
            canCompare={!!built && !!primaryMountId && !isStaged}
            staleModel={modelMatch === false && lastRun
              ? aeroModelLabel(lastRun.aeroModel, lastRun.rogersKbf) : null}
          />
        )}

        {tab === 'design' && (
        <div className="design-layout">
        <aside>
          <div className="panel" data-tour="tree">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <h2 style={{ flex: 1 }}>Components</h2>
              <button
                className="file-btn"
                title="Clear all components and start from scratch"
                onClick={() => setConfirmNew(true)}
              >
                ✕ New
              </button>
              <button className="file-btn" onClick={undo} title="Undo (Ctrl+Z)">↩ Undo</button>
            </div>
            <div className="field" style={{ marginBottom: 8 }}>
              <label>Rocket name</label>
              <input value={tree.name ?? ''} onChange={(e) => setTree({ ...tree, name: e.target.value })} />
            </div>
            <ComponentTree
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
                // New components inherit diameter/material/finish from the
                // component they follow (previous sibling, else the parent).
                const parent = parentId === 'stage' ? 'stage' as const : findNode(tree, parentId);
                const siblings = parent === 'stage'
                  ? stages(tree)[0]?.children ?? []
                  : parent?.children ?? [];
                const prev = siblings.length ? siblings[siblings.length - 1]! : null;
                const node = inheritDefaults(makeNode(type), parent, prev);
                // Adding a second fin-type set to a tube: default it BETWEEN
                // the existing set's fins instead of on top of them
                // (2026-08-05d — tube fins + straight fins interleave).
                if (type.endsWith('finset') && parent !== 'stage') {
                  const existing = (parent?.children ?? []).find((c) => c.type.endsWith('finset'));
                  if (existing) {
                    const exRot = typeof existing['rotation'] === 'number' ? (existing['rotation'] as number) : 0;
                    const exCount = Math.max(1, Math.round(
                      typeof existing['finCount'] === 'number' ? (existing['finCount'] as number) : 3));
                    node['rotation'] = exRot + Math.PI / exCount;
                  }
                }
                setTree(addChild(tree, parentId, node));
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
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <h2 style={{ flex: 1 }}>Rocket</h2>
              {view === '2d' && (
                <button className={`file-btn${vert2d ? ' hc-on' : ''}`} aria-pressed={vert2d}
                  title="Rotate the drawing 90° — nose up, the way it sits on the pad (viewing mode: drag and zoom pause while rotated)"
                  onClick={() => setVert2d((v) => !v)}>⟳ 90°</button>
              )}
              <div className="view-toggle" role="tablist">
                <button className={view === '2d' ? 'active' : ''} role="tab"
                  aria-selected={view === '2d'} onClick={() => setView('2d')}>2D</button>
                <button className={view === '3d' ? 'active' : ''} role="tab"
                  aria-selected={view === '3d'} onClick={() => setView('3d')}>3D</button>
                <button className={view === 'aft' ? 'active' : ''} role="tab"
                  title="Looking at the rocket from behind — clusters, pods and fin counts as they really sit"
                  aria-selected={view === 'aft'} onClick={() => setView('aft')}>Aft</button>
              </div>
            </div>
            {/* data-vert raises the stage's height cap in ⟳90° mode ONLY:
                there the container's height is the rocket's length axis, so
                height buys drawing rather than empty sky (styles.css). It is
                gated on view === '2d' as well, because vert2d persists while
                the user is on 3D/Aft — where the taller cap would just be
                letterbox. */}
            <div className="rocket-stage hero-stage" data-tour="canvas"
              data-vert={view === '2d' && vert2d ? 'on' : undefined}
              style={view === '2d' && !vert2d && heroNatural
                ? ({ '--hero-natural': `${heroNatural + HERO_CHIP_RESERVE + drawerClearance}px` } as React.CSSProperties)
                : undefined}>
              {/* .hero-view owns fill-and-center: the drawing must never size
                  its own container (see the styles.css note on the feedback
                  loop), and the schematic wrap carries inline positioning of
                  its own, so the absolute box has to be ours. */}
              <div className="hero-view" style={drawerClearance ? { bottom: drawerClearance } : undefined}>
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
                      onError={setFileNote}
                      vertical={vert2d}
                      fillHeight
                      onNaturalHeight={setHeroNatural}
                      roll={viewRoll}
                      onRoll={setViewRoll}
                    />
                  )
                  : view === '3d'
                  ? (
                    <Suspense fallback={<div className="hero-loading">Loading 3D view…</div>}>
                      <Rocket3D tree={tree} info={built?.info ?? null} motors={motorDims} exportData={viewExportData} />
                    </Suspense>
                  )
                  : <AftView tree={tree} motors={motorDims} roll={viewRoll} onRoll={setViewRoll} />}
              </div>
              {built && <StatsChip info={built.info} />}
              {built && (statsDrawer
                ? (
                  <div className="stats-drawer" ref={setDrawerEl}>
                    <div className="stats-drawer-head">
                      <span>All stats</span>
                      <button className="file-btn" onClick={() => setStatsDrawer(false)}>▾ Collapse</button>
                    </div>
                    <DesignStats
                      info={built.info}
                      cd={designCd}
                      motorLabel={assigned.length > 1
                        ? assigned.map(([, mm]) => mm.label).join(' + ')
                        : primaryLabel}
                    />
                  </div>
                )
                : (
                  <button className="file-btn stats-drawer-chip" onClick={() => setStatsDrawer(true)}
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
            {built && built.info.warningTexts.length > 0 && (
              <div className="file-note file-note-warn" role="alert">
                {built.info.warningTexts.map(formatWarningText).join('\n')}
              </div>
            )}
          </div>
        </main>

        <aside className="design-props">
          {selectedNode ? (
            <PropertyPanel
              tree={tree}
              node={selectedNode}
              info={selectedInfo}
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
        </aside>
        </div>
        )}

        {tab === 'motors' && (
        <div className="motors-layout">
          <div className="panel motors-schematic">
            <h2>Rocket — motors drawn to scale</h2>
            <div className="rocket-stage">
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
            <h2>Motors</h2>
            {mounts.length === 0 && (
              <p className="stability-bad" style={{ fontSize: 12 }}>
                No motor mount — add an inner tube, or check “Motor mount” on a body tube (minimum-diameter).
              </p>
            )}
            {stageList.map((st, stIdx) => {
              const stMounts = mounts.filter((m) => stageIndexOf(tree, m.id!) === stIdx);
              if (stMounts.length === 0) return null;
              const stName = st.name ?? `Stage ${stIdx + 1}`;
              // Effective limit: the per-stage override when typed, else the
              // first mount tube carrying a design-time maxMotorLength.
              const designMax = stMounts
                .map((m) => findNode(tree, m.id!)?.['maxMotorLength'])
                .find((v): v is number => typeof v === 'number') ?? null;
              const stMax = (st.id ? maxMotorLen[st.id] : null) ?? designMax;
              return (
                <div key={st.id}>
                  {isStaged && <div className="motor-stage-header">{stName}</div>}
                  {/* The PRIMARY limit lives on the mount tube in the design
                      (persists in the tree and .ork). This field is a
                      per-stage OVERRIDE on top; clearing it falls back to the
                      design value (2026-08-05 chat). */}
                  <div className="field" style={{ marginBottom: 8 }}
                    title={`Longest motor ${isStaged ? `the ${stName} stage's` : 'the'} airframe has room for. The design value is set on the motor mount tube itself (Design tab) and travels with the rocket; typing here overrides it for this stage. Longer motors are flagged in the browser and excluded from batch simulation.`}>
                    <label>Max motor length {stMax !== null && st.id && maxMotorLen[st.id] == null ? '(from design)' : '(override)'} <UnitChip quantity="motorDimensions" /></label>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <NumField
                        value={st.id && maxMotorLen[st.id] != null
                          ? siToUi('motorDimensions', prefs.units.motorDimensions, maxMotorLen[st.id]!)
                          : undefined}
                        step={niceStep(siToUi('motorDimensions', prefs.units.motorDimensions, 0.005))}
                        nullable
                        placeholder={stMax !== null
                          ? `design: ${fmtSi('motorDimensions', prefs.units.motorDimensions, stMax)}`
                          : 'no limit'}
                        ariaLabel={`Maximum motor length override for ${stName}`}
                        onCommit={(v) => setMaxMotorLen((prev) => {
                          const next = { ...prev };
                          if (v === null) delete next[st.id!]; // back to the design value
                          else next[st.id!] = uiToSi('motorDimensions', prefs.units.motorDimensions, v);
                          return next;
                        })}
                      />
                      {(() => {
                        const room = estimateMotorRoomForMounts(tree, stMounts.map((m) => m.id!));
                        if (!room || !st.id) return null;
                        return (
                          <button className="file-btn" style={{ whiteSpace: 'nowrap' }}
                            title={`Measure it: ${fmtSi('motorDimensions', prefs.units.motorDimensions, room.lengthM)} ${prefs.units.motorDimensions} from the aft of the mount to ${room.limitedBy}. An estimate — it cannot see wadding, a baffle modelled as something else, or a chute packed against the block.`}
                            onClick={() => setMaxMotorLen((prev) => ({ ...prev, [st.id!]: room.lengthM }))}>
                            ⌾ Estimate
                          </button>
                        );
                      })()}
                    </div>
                    {(() => {
                      const room = estimateMotorRoomForMounts(tree, stMounts.map((m) => m.id!));
                      return room ? (
                        <p className="comp-stats" style={{ margin: '3px 0 0' }}>
                          Room for {fmtSi('motorDimensions', prefs.units.motorDimensions, room.lengthM)}
                          {' '}{prefs.units.motorDimensions} to {room.limitedBy}.
                        </p>
                      ) : null;
                    })()}
                  </div>
                  {stMounts.map((m) => {
              const mm = mountMotors[m.id!];
              const mNode = findNode(tree, m.id!);
              const count = clusterCount(mNode?.['cluster'] as string | undefined);
              const isSustainerMount = stIdx === 0;
              return (
                <div key={m.id} className="mount-card" style={{ marginBottom: 10, paddingTop: 6, borderTop: '1px solid var(--border, #333)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <label style={{ flex: 1, fontWeight: 600 }}>
                      {m.name ?? 'Motor mount'}
                      <span className="mount-size-inline">⌀&nbsp;{classLabel(diameterClass(mountDiaMm(mNode)))}&nbsp;mm</span>
                      {count > 1 && ` (cluster ×${count})`}
                    </label>
                    {mm && (
                      <button className="fin-row-del" title="Remove this motor"
                        onClick={() => setMountMotors((prev) => {
                          const next = { ...prev };
                          delete next[m.id!];
                          return next;
                        })}>✕</button>
                    )}
                  </div>
                  <MotorPicker
                    mountDiameterMm={mountDiaMm(mNode)}
                    maxMotorLengthM={stMax}
                    selectedLabel={mm?.label ?? ''}
                    onSelect={(label, spec, meta) => assignMotor(m.id!, label, spec, meta)}
                  />
                  {mm && (
                    <div className="field" style={{ marginTop: 6 }}>
                      <label>
                        Ejection delay (s)
                        {mm.meta.availableDelays?.length
                          ? ` — prescribed: ${mm.meta.availableDelays.map((d) => (Number.isFinite(d) ? d : 'P')).join(', ')}`
                          : ''}
                      </label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ flex: 1 }}>
                          <NumField
                            // A plugged motor has no numeric delay — blank the
                            // field (it used to render the literal "Infinity").
                            value={Number.isFinite(mm.spec.ejectionDelay) ? mm.spec.ejectionDelay : undefined}
                            step={1}
                            max={60}
                            placeholder={Number.isFinite(mm.spec.ejectionDelay) ? undefined : 'plugged'}
                            ariaLabel={`Ejection delay for ${m.name ?? m.id}`}
                            onCommit={(v) => {
                              if (v === null) return;
                              // Typing a delay overrides auto — real motors get
                              // drilled to whatever whole second the flyer wants.
                              setMountMotors((prev) => ({
                                ...prev,
                                [m.id!]: {
                                  ...mm,
                                  spec: { ...mm.spec, ejectionDelay: v },
                                  meta: { ...mm.meta, autoDelay: false },
                                  label: labelWithDelay(mm.label, v),
                                },
                              }));
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
                              const plugged = e.target.checked;
                              // Un-plugging restores the longest prescribed
                              // delay (or 6 s when the motor lists none).
                              const finite = (mm.meta.availableDelays ?? []).filter((d) => Number.isFinite(d));
                              const restored = finite[finite.length - 1] ?? 6;
                              const next = plugged ? Infinity : restored;
                              setMountMotors((prev) => ({
                                ...prev,
                                [m.id!]: {
                                  ...mm,
                                  spec: { ...mm.spec, ejectionDelay: next },
                                  meta: { ...mm.meta, autoDelay: false },
                                  label: labelWithDelay(mm.label, next),
                                },
                              }));
                            }}
                          />
                          plugged
                        </label>
                        {isSustainerMount && (
                          <label className="motor-inline-label" style={{ whiteSpace: 'nowrap' }}>
                            <input
                              type="checkbox"
                              checked={mm.meta.autoDelay === true}
                              style={{ width: 'auto' }}
                              onChange={(e) => {
                                setMountMotors((prev) => ({
                                  ...prev,
                                  [m.id!]: {
                                    ...mm,
                                    meta: { ...mm.meta, autoDelay: e.target.checked },
                                    label: labelWithDelay(
                                      mm.label, e.target.checked ? 'auto' : mm.spec.ejectionDelay),
                                  },
                                }));
                              }}
                            />
                            auto (optimal)
                          </label>
                        )}
                      </div>
                    </div>
                  )}
                  {mm && isStaged && (
                    <div className="field" style={{ marginTop: 6 }}
                      title="When this motor lights. Automatic = launch-stage motors at launch, upper motors on the ejection charge of the stage below (low/mid power). High-power sustainers are electronics-timed (e.g. booster burnout + delay).">
                      <label>Ignition</label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <select
                          aria-label="Ignition event"
                          style={{ flex: 1 }}
                          value={mm.ignition.event}
                          onChange={(e) => setMountMotors((prev) => ({
                            ...prev,
                            [m.id!]: { ...mm, ignition: { ...mm.ignition, event: e.target.value as IgnitionEvent } },
                          }))}
                        >
                          <option value="automatic">Automatic (launch / lower stage's ejection)</option>
                          <option value="burnout">Lower stage burnout + delay (electronics)</option>
                          <option value="launch">Launch + delay (timer)</option>
                          <option value="ejectioncharge">Lower stage ejection charge + delay</option>
                          <option value="never">Never</option>
                        </select>
                        <div style={{ width: 70 }}>
                          <NumField
                            value={mm.ignition.delay}
                            step={0.5}
                            max={60}
                            ariaLabel={`Ignition delay for ${m.name ?? m.id}`}
                            onCommit={(v) => {
                              if (v === null) return;
                              setMountMotors((prev) => ({
                                ...prev,
                                [m.id!]: { ...mm, ignition: { ...mm.ignition, delay: v } },
                              }));
                            }}
                          />
                        </div>
                        <span className="motor-db-meta">s</span>
                      </div>
                    </div>
                  )}
                </div>
              );
                  })}
                </div>
              );
            })}
            <button
              className="file-btn"
              style={{ marginTop: 8, width: '100%' }}
              disabled={!built || !primaryMountId || isStaged}
              title={isStaged
                ? 'Batch simulation is not available on staged rockets — the motor combinations explode.'
                : 'Simulate every motor that fits this rocket, with filters and acceptance criteria'}
              onClick={() => setShowBatch(true)}
            >
              <Icon name="zap" /> Batch simulate motors…
            </button>
          </div>

          <LaunchPanel value={launch} onChange={setLaunch} onLaunch={onLaunch} simulating={simulating}
            lastRun={simCostRef} />

          {/* Last row of the grid, full width (`.config-panel` spans
              `1 / -1` wherever auto-placement drops it). It sat second, above
              Motors, and pushed the two panels a tester actually works in
              below the fold on a file with several configurations.

              Only when there's a genuine choice: a single-config file's one
              row would be noise on every ordinary design (our own exports
              included), and ⏏ Unload already covers its "None". */}
          {savedConfigs.length > 1 && (
            <ConfigPanel
              configs={savedConfigs}
              activeConfigId={activeConfigId}
              hasMotors={Object.keys(mountMotors).length > 0}
              onApply={applyConfig}
              onClear={clearConfig}
            />
          )}
        </div>
        )}

        {tab === 'results' && (
        <main className="results-column" data-tour="results-panel">
          {shownResult && aeroMode === 'classic' && shownResult.summary.maxMachNumber > MACH_AUTO_THRESHOLD && (
            <div className="file-note file-note-warn" role="alert">
              ⚠ This flight reaches <strong>Mach {shownResult.summary.maxMachNumber.toFixed(2)}</strong> on
              the classic aero model, which is approximate past ~Mach {MACH_AUTO_THRESHOLD} — supersonic CP travel
              (the stability hazard on fast flights) is not modeled. A wind-tunnel-validated
              supersonic model is available. Note: a model applies to the <strong>entire
              flight</strong>, subsonic portions included, so stability and apogee will shift when
              it changes.{' '}
              <button className="file-btn" style={{ marginLeft: 6 }}
                onClick={() => {
                  // Sets the SESSION switch, not the stored preference. It
                  // used to write the preference, which under an active strip
                  // override would have been outranked — leaving a button that
                  // visibly did nothing, twice. Session-scoped also matches
                  // what the button is for: trying the other model on this
                  // flight, not changing what every future session flies.
                  setAeroOverride('auto');
                  setPendingRelaunch(true);
                }}>
                Try Auto &amp; re-fly (this session)
              </button>
            </div>
          )}
          {(lastRun?.simWarnings ?? []).some((w) => w.priority === 'HIGH') && (
            // The Launch flow lands here — a HIGH-priority kernel warning
            // (no recovery device, deployment on the guide, …) must not be
            // scrollable-past. Full list, cautions included, sits in the
            // launch report below.
            <div className="file-note file-note-error" role="alert">
              ⚠ <strong>This flight raised {
                lastRun!.simWarnings!.filter((w) => w.priority === 'HIGH').length === 1
                  ? 'a serious simulation warning'
                  : 'serious simulation warnings'
              }:</strong>{' '}
              {lastRun!.simWarnings!.filter((w) => w.priority === 'HIGH')
                .map((w) => formatWarning(w).label).join(' · ')}
            </div>
          )}
          {shownResult && lastRun?.aeroModel === 'auto-supersonic' && (
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
          {modelMatch === false && lastRun && (
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
          {shownResult && lastRun ? (
            <>
              <FlightStats run={lastRun} />
              <SimRunDetails run={lastRun} hasSeries />
              <FlightCharts result={shownResult} onFullSeries={fetchFullSeriesResult}
                designName={tree.name} />
            </>
          ) : lastRun ? (
            // A stored run whose series nobody has computed in this session —
            // after a reload, or a run flown before the design was edited.
            // The tiles and the report come from the stored scalars; the plots
            // need series, which run history does not carry.
            <>
              <FlightStats run={lastRun} />
              <SimRunDetails run={lastRun} />
              <div className="panel placeholder empty-state">
                <p><strong>Flight plots aren&apos;t saved with a run</strong></p>
                <p>
                  The report above is stored in full, but the plots are drawn from the
                  simulation&apos;s raw time series, which run history doesn&apos;t keep.
                  {canShowCharts(lastRun)
                    ? ' This design still matches the run, so it can be flown again to redraw them — the physics is deterministic, so it reproduces this exact flight.'
                    : ' The design, motor or conditions have changed since this run, so it can no longer be reproduced here. Press Launch to fly the design as it stands now.'}
                </p>
                {canShowCharts(lastRun) && (
                  <button className="file-btn file-btn-primary" disabled={reflying !== null}
                    title="Re-fly this design at this run's conditions to redraw its plots. Does not add a row to the run history."
                    onClick={() => { void showChartsFor(lastRun); }}>
                    {reflying === lastRun.id ? '⏳ Re-flying…' : '📈 Show charts'}
                  </button>
                )}
              </div>
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
                <button className="file-btn file-btn-primary" disabled={reflying !== null}
                  title="Re-fly this design at that run's conditions to redraw its report and plots. Does not add a row to the run history."
                  onClick={() => { void showChartsFor(chartableRun); }}>
                  {reflying === chartableRun.id ? '⏳ Re-flying…' : '📈 Show the last saved flight'}
                </button>
              )}
            </div>
          )}
          {built && <DragPanel rocket={built.rocket} supersonicModel={effectiveSupersonic}
            aeroLabel={currentModelLabel({ aeroMode, effectiveKbf, autoSupersonic })}
            designName={tree.name} fileMachAlt={fileMachAlt} />}
          {runsQuotaWarn && (
            <div className="file-note file-note-warn" role="alert">
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
            </div>
          )}
          <SimHistory
            runs={runs}
            onRunsChange={recordRuns}
            selectedId={lastRun?.id ?? null}
            // Selecting a row no longer destroys the in-memory flight: the
            // result carries the id of the run it belongs to, so the charts
            // decide for themselves whether they are showing this run. Coming
            // back to the run you just flew restores its charts for free.
            onSelect={(r) => { if (r.id !== lastRun?.id) setLastRun(r); }}
            canShowCharts={canShowCharts}
            onShowCharts={(r) => { void showChartsFor(r); }}
            reflyingId={reflying}
            hasChartsFor={(r) => (result?.runId === r.id) || reflightCache.has(r.id)}
            designName={tree.name}
          />
        </main>
        )}
      </div>
      <SiteBandFooter nav={mmrNav} />
      <NoticeBar notices={notices} />
    </div>
  );
}
