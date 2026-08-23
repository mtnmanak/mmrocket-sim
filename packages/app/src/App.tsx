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
import { DEFAULT_CONDITIONS, LaunchPanel, type LaunchConditions } from './components/LaunchPanel.js';
import { MovedNotice } from './components/MovedNotice.js';
import { builtInMeta, MotorPicker } from './components/MotorPicker.js';
import { NumField } from './components/NumField.js';
import { PropertyPanel } from './components/PropertyPanel.js';
import { SimHistory, SimRunDetails } from './components/SimResults.js';
import { DesignStats, FlightStats, StatsChip, stabilityGlyphClass } from './components/StatTiles.js';
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
import { usePrefs } from './prefs/PrefsContext.js';
import { UnitChip } from './components/UnitChip.js';
import { fmtSi, niceStep, siToUi, uiToSi } from './prefs/units.js';
import { classLabel, diameterClass, displayDesignation, findDbMotor, isHighPower } from './services/motorDb.js';
import { delayOptions, fetchMotorSpec } from './services/thrustcurve.js';
import { exportOrk, importOrk, type OrkDeployOverride, type OrkExportConfig, type OrkExportMotor, type OrkImportResult, type OrkMotorRef, type OrkTreeImportResult } from './services/orkFile.js';
import { decodeShareFragment, encodeShareFragment, hasSharePayload, MAX_FRAGMENT_CHARS } from './services/shareLink.js';
import { exportRkt, importRkt } from './services/rocksimFile.js';
import { componentCsv, componentTable } from './services/componentTable.js';
import { tableToXlsx } from './services/xlsx.js';
import { exportCdx1, importCdx1 } from './services/rasaeroFile.js';
import { loadSession, onSessionSaveStateChange, saveSessionDebounced, sessionSaveFailing } from './services/session.js';
import { buildSimRun, formatStability, recommendDelay, type MotorMeta, type SimRun } from './services/simReport.js';
import { formatWarning, formatWarningText } from './services/simWarnings.js';
import { addRun, loadRuns, persistFailed } from './services/simStore.js';
import { APP_VERSION } from './version.js';
import {
  addChild, addStage, cloneSubtree, defaultTree, duplicateNode, emptyTree, engineTree, findNode,
  findParent, hasParallelStage, inheritDefaults, makeNode, motorMounts, moveNode,
  normalizeTree, removeNode, stageIndexOf, stages, updateAllNodes, updateNode,
} from './tree/treeModel.js';
import { clusterCount } from './tree/cluster.js';
import { autoAlignFinSets } from './tree/finAlign.js';
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
   * This configuration's recovery-deployment settings as they were in the file,
   * keyed by recovery-device node id. Carried untouched so saving while another
   * configuration is open cannot rewrite this one's chute deployment.
   */
  deployments?: Record<string, OrkDeployOverride>;
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
type ImportedDesign = Pick<OrkTreeImportResult, 'name' | 'tree' | 'motors' | 'notes' | 'launch'>
  & Partial<Pick<OrkImportResult, 'configs' | 'chosenConfigId'>>;

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

/** Rewrites a motor label's delay suffix ("H220-14" / "H220-P" / "H220 (auto delay)"). */
function labelWithDelay(label: string, delay: number | 'auto'): string {
  const base = label.replace(/ \(auto delay\)$/, '').replace(/-(\d+(\.\d+)?|P)$/, '');
  if (delay === 'auto') return `${base} (auto delay)`;
  return `${base}-${Number.isFinite(delay) ? delay : 'P'}`;
}

/**
 * Kernel SimulationOptions from the launch panel — the ONE construction,
 * shared by Launch and the full-series CSV re-run so both fly identical
 * conditions (the physics is deterministic: same options, same flight).
 */
function kernelSimOptions(l: LaunchConditions) {
  return {
    launchRodLength: l.launchRodLengthM,
    launchRodAngle: (l.launchRodAngleDeg * Math.PI) / 180,
    windAverage: l.windAverage,
    windStdDeviation: l.windStdDev,
    launchAltitude: l.launchAltitudeM,
    temperature: l.temperatureC === null ? undefined : l.temperatureC + 273.15,
    pressure: l.pressureHPa === null ? undefined : l.pressureHPa * 100,
    launchLatitude: l.latitudeDeg,
  };
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
  const { prefs, setPrefs, resolvedTheme, daylight } = usePrefs();
  // Mountain Man Rockets site band + footer strip, and the feedback routes
  // below. ONE call for all three: the hook fetches once per mount, so the
  // contract is shared state, not three copies of the same request.
  const { nav: mmrNav, source: mmrNavSource } = useMmrNav(MMR_NAV_FALLBACK);
  const [showPrefs, setShowPrefs] = useState(false);
  // Restore the previous session (autosaved on every change) if one exists.
  // normalizeTree wraps pre-v0.009 flat trees in one stage. Lazy useState:
  // loadSession parses the whole tree — never re-run it on re-renders.
  const [session] = useState(loadSession);
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
  const [result, setResult] = useState<FlightResult | null>(null);
  const [lastRun, setLastRun] = useState<SimRun | null>(null);
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
  const [fileNote, setFileNote] = useState<string | null>(null);
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
  // threshold and upgrade to the supersonic model? Sticky until the design/
  // motors/launch (or the mode itself) changes, so the displayed statics
  // match the model the flight actually used.
  const [autoSupersonic, setAutoSupersonic] = useState(false);
  // "Switch to Auto & re-fly" from the supersonic-flight alert: re-launch as
  // soon as the engine rebuild with the new model lands.
  const [pendingRelaunch, setPendingRelaunch] = useState(false);

  // Autosave the working state so a closed tab or crash never loses work.
  useEffect(() => {
    // Prune limits for stages that no longer exist before persisting.
    const stageIds = new Set(stages(tree).map((s) => s.id));
    const maxMotorLengthByStage = Object.fromEntries(
      Object.entries(maxMotorLen).filter(([id]) => stageIds.has(id)));
    saveSessionDebounced({ tree, mountMotors, launch, maxMotorLengthByStage, savedConfigs, activeConfigId });
  }, [tree, mountMotors, launch, maxMotorLen, savedConfigs, activeConfigId]);

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
  const aeroMode: 'classic' | 'supersonic' | 'auto' =
    prefs.aeroModel ?? (prefs.supersonicAero ? 'supersonic' : 'classic');
  const effectiveSupersonic = aeroMode === 'supersonic' || (aeroMode === 'auto' && autoSupersonic);
  // Normalized ONCE so the build memo and the flight-reset effect below agree.
  // The Preferences pulldown maps BOTH classic options to aeroModel: 'classic'
  // and tells them apart purely by this flag, so aeroMode alone cannot see a
  // switch between Extended Barrowman and Rogers Kbf. Normalizing rather than
  // depending on prefs.rogersKbf raw (boolean | undefined) also avoids a
  // spurious reset when it settles from undefined to true.
  const effectiveKbf = prefs.rogersKbf ?? true;

  // No setState in here — the error is part of the memo's value (setState
  // during render breaks under StrictMode's double-invoke).
  const buildResult = useMemo((): { rocket: OrkRocket; info: StaticInfo } | { error: string } => {
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
      for (const [id, mm] of assigned) {
        rocket.setMotorById(id, mm.spec);
        if (mm.ignition.event !== 'automatic' || mm.ignition.delay !== 0) {
          rocket.setMotorIgnitionById(id, mm.ignition.event, mm.ignition.delay);
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
      return { rocket, info };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [tree, assigned, effectiveKbf, effectiveSupersonic]);
  const built = 'error' in buildResult ? null : buildResult;
  const buildError = 'error' in buildResult ? buildResult.error : simError;

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
    setAutoSupersonic(false); // re-evaluate the auto threshold on the next flight
    // eslint-disable-next-line react-hooks/exhaustive-deps -- physicsKey stands in for tree
    // effectiveKbf is in here because switching between the two CLASSIC models
    // changes CP, stability and drag immediately (the build memo applies it),
    // but used to leave the old flight's apogee and the whole Results tab in
    // place — the vitals strip then showed a stability and an apogee computed
    // under two different aerodynamic models, which is exactly the comparison
    // this preference exists to support.
  }, [physicsKey, mountMotors, launch, aeroMode, effectiveKbf]);

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
    requestAnimationFrame(() => {
      try {
        const simOpts = kernelSimOptions(launch);
        const t0 = performance.now();
        let res = built.rocket.simulate(simOpts);
        // Auto aero mode: the classic first pass projects the flight's Mach.
        // Past 0.9 (transonic onset, where classic aero starts degrading) the
        // WHOLE flight re-flies on the supersonic model, and the design's
        // displayed statics follow (setAutoSupersonic rebuilds the engine
        // handle with the flag on after this callback finishes).
        let usedSupersonic = effectiveSupersonic;
        if (aeroMode === 'auto' && !usedSupersonic && res.summary.maxMachNumber > 0.9) {
          built.rocket.setSupersonicAero(true);
          res = built.rocket.simulate(simOpts);
          usedSupersonic = true;
          setAutoSupersonic(true);
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
            res = built.rocket.simulate(simOpts);
          }
        }
        const execMs = performance.now() - t0;
        setResult(res);
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
          rogersKbf: (prefs.rogersKbf ?? true) && !usedSupersonic,
          ...(activeConfig ? { flightConfig: savedConfigLabel(activeConfig) } : {}),
        });
        setLastRun(run);
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
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const primary = mountMotors[primaryMountId]!;
    if (lastRun.delayS !== primary.spec.ejectionDelay) {
      // Auto delay flew the rounded optimum (recorded on the run); a handle
      // rebuilt since launch (auto-supersonic flips the build memo) still
      // holds the pre-probe spec — restore the flown delay before re-flying.
      built.rocket.setMotorById(primaryMountId, { ...primary.spec, ejectionDelay: lastRun.delayS });
    }
    return built.rocket.simulate({ ...kernelSimOptions(launch), series: 'full' });
  }, [built, primaryMountId, lastRun, mountMotors, launch]);

  // ---- design file I/O (.ork native, .rkt RockSim) ----
  const toExportMotor = (mm: MountMotor): OrkExportMotor => ({
    designation: mm.spec.designation,
    diameter: mm.spec.diameter,
    length: mm.spec.length,
    delay: mm.spec.ejectionDelay,
    ignitionEvent: mm.ignition.event,
    ignitionDelay: mm.ignition.delay,
  });

  const exportMotorsMap = (): Record<string, OrkExportMotor> => {
    const motors: Record<string, OrkExportMotor> = {};
    for (const [id, mm] of assigned) {
      motors[id] = toExportMotor(mm);
    }
    return motors;
  };

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
  }));

  const download = (content: string | Uint8Array, ext: string, suffix = '') => {
    // CSV gets a UTF-8 BOM: headers can carry non-ASCII (units, symbols), and
    // Excel's double-click open decodes BOM-less CSV as the ANSI codepage.
    // Same convention as the flight-data and run-history CSVs (SimResults).
    const parts: BlobPart[] = ext === 'csv' ? ['﻿', content as BlobPart] : [content as BlobPart];
    const blob = new Blob(parts, { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(tree.name ?? 'rocket').replace(/[^\w-]+/g, '_')}${suffix}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
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

  const onSaveOrk = () => {
    // WITH launch: the .ork's first <simulation> carries the pad and weather,
    // so the file (and the desktop app) round-trips the whole flight setup.
    download(exportOrk({
      name: tree.name ?? 'My Rocket', tree, motors: exportMotorsMap(), launch,
      configs: exportConfigs(), activeConfigId,
    }), 'ork');
  };

  const onSaveRkt = () => {
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
      download(exportRkt({ name: tree.name ?? 'My Rocket', tree, motors: exportMotorsMap(), compInfo }), 'rkt');
    } catch (e) {
      setFileNote(`RockSim export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onSaveCdx1 = () => {
    try {
      download(exportCdx1({
        name: tree.name ?? 'My Rocket',
        tree,
        launchMassKg: built?.info.mass,
        launchCgM: built?.info.cg,
      }), 'CDX1');
    } catch (e) {
      setFileNote(`RASAero export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onSaveObj = async () => {
    try {
      const { rocketToObj } = await import('./services/objExport.js');
      download(rocketToObj(tree, tree.name ?? 'Rocket'), 'obj');
    } catch (e) {
      setFileNote(`OBJ export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onSaveGlb = async () => {
    try {
      const { rocketToGlb } = await import('./services/gltfExport.js');
      download(new Uint8Array(await rocketToGlb(tree, tree.name ?? 'Rocket')), 'glb');
    } catch (e) {
      setFileNote(`glTF export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onSaveStl = async () => {
    try {
      const [{ buildPieces }, { piecesToStl }] = await Promise.all([
        import('./components/Rocket3D.js'),
        import('./services/stlExport.js'),
      ]);
      const { pieces } = buildPieces(tree);
      download(piecesToStl(pieces, tree.name ?? 'Rocket'), 'stl');
    } catch (e) {
      setFileNote(`STL export failed: ${e instanceof Error ? e.message : String(e)}`);
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
          meta: builtInMeta(builtIn[0]),
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
    const notes: string[] = [`Loaded “${imported.name}”.`, ...imported.notes];
    // Load EVERY mount's motor (staged/multi-mount files included).
    const nextMotors: Record<string, MountMotor> = {};
    for (const [nodeId, ref] of Object.entries(imported.motors)) {
      const { motor: mm, note } = await matchImportedMotor(ref);
      if (mm) nextMotors[nodeId] = mm;
      notes.push(note);
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
      });
    }
    const importedTree = normalizeTree(imported.tree);
    setTree(importedTree);
    setMountMotors(nextMotors);
    setSavedConfigs(nextConfigs);
    setActiveConfigId(chosenId);
    setMaxMotorLen({}); // imported stages have fresh ids — old limits don't apply
    setSelectedId(null);
    // Launch conditions from the file (.ork's first <simulation>): apply
    // EVERY field the file carried — explicit nulls included (an ISA file
    // sets temperature/pressure to null deliberately) — and keep the
    // panel's fields the file didn't mention. The importer already pushed
    // a user-visible note about what it found.
    if (imported.launch) setLaunch((prev) => ({ ...prev, ...imported.launch }));
    setFileNote(notes.join('\n'));
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
    if (cfg.deployments && Object.keys(cfg.deployments).length > 0) {
      let next = tree;
      for (const [nodeId, d] of Object.entries(cfg.deployments)) {
        if (!findNode(next, nodeId)) continue;
        next = updateNode(next, nodeId, {
          ...(d.deployEvent !== undefined ? { deployEvent: d.deployEvent } : {}),
          ...(d.deployAltitude !== undefined ? { deployAltitude: d.deployAltitude } : {}),
          ...(d.deployDelay !== undefined ? { deployDelay: d.deployDelay } : {}),
        });
      }
      if (next !== tree) setTree(next);
    }
    if (cfg.unmatched?.length) {
      // Quiet at import time (only the applied config reports) — the debt
      // comes due when the user actually loads this preset.
      setFileNote(cfg.unmatched.map((d) =>
        `Motor “${d}” couldn't be matched when the file was opened — pick one via Browse motor database.`).join('\n'));
    }
  };

  /** The "None" row / full unload: no motors, no active configuration. */
  const clearConfig = () => {
    setMountMotors({});
    setActiveConfigId(null);
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
        configs: exportConfigs(), activeConfigId,
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

  // Vitals strip: apogee of the most recent flight (fresh sim or reopened run).
  const lastApogee = result?.summary.maxAltitude ?? lastRun?.maxAltitude ?? null;

  // "Use Auto & re-fly" from the supersonic-flight alert: once the pref
  // change has propagated (aeroMode now 'auto'), fire a fresh launch.
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
              <Icon name="save" /> Save / Export ▾
            </button>
            {showFileMenu && (
              <>
                <div className="file-menu-backdrop" onClick={() => setShowFileMenu(false)} />
                <div className="file-menu" role="menu" onClick={() => setShowFileMenu(false)}>
                  <button onClick={onSaveOrk}>Save .ork — OpenRocket design</button>
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
                  <button onClick={onSaveObj}
                    title="External 3D geometry as a Wavefront OBJ (meters) — print preview / CAD reference">
                    Export .obj — 3D geometry
                  </button>
                  <button onClick={onSaveGlb}
                    title="Modern 3D model with your component colors (glTF binary, meters) — drops straight into Windows 3D Viewer, PowerPoint, Blender, and web viewers">
                    Export .glb — 3D model with colors
                  </button>
                  <button onClick={onSaveStl}
                    title="Whole-rocket display shell as binary STL (mm). Reference/display model — NOT watertight; for printable parts use the 🖨 button on a selected component">
                    Export .stl — 3D shell (reference)
                  </button>
                  <button onClick={() => download(componentCsv(buildComponentTable()), 'csv', '-components')}
                    title="Every component and its attributes as one row per component, in your preferred units — dimensions, materials, and the computed mass/CG/position. For sharing measurement data.">
                    Export .csv — component data
                  </button>
                  <button onClick={() => {
                    const t = buildComponentTable();
                    download(tableToXlsx(t.headers, t.rows, 'Components'), 'xlsx', '-components');
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
          <div className="file-note autosave-warn" role="alert">
            ⚠ Autosave can&apos;t write (storage full or blocked) — save your
            design to a file (Save / Export → .ork) to keep it safe.
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
          {effectiveSupersonic && (
            <span className="vitals-item"
              title={aeroMode === 'auto'
                ? 'Auto aero: this design flew past Mach 0.9, so stability, drag analysis and flights use the supersonic model'
                : 'Supersonic aerodynamics model active (Preferences → Aerodynamics)'}>
              <span className="vitals-label">Aero</span>
              <span className="vitals-value vitals-aero">M+ supersonic</span>
            </span>
          )}
          {lastApogee !== null && (
            <span className="vitals-item" title="Apogee of the most recent flight">
              <span className="vitals-label">Apogee</span>
              <span className="vitals-value">
                {fmtSi('distance', prefs.units.distance, lastApogee)}&nbsp;<UnitChip quantity="distance" />
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
        {fileNote && (
          <div className="file-note" role="alert" style={{ margin: '0 0 12px' }}>
            {fileNote}
            <button className="file-note-dismiss" onClick={() => setFileNote(null)} aria-label="Dismiss">×</button>
          </div>
        )}
        {buildError && (
          <p className="stability-bad" style={{ margin: '0 0 12px', fontSize: 13 }}>{buildError}</p>
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
            <div className="rocket-stage hero-stage" data-tour="canvas">
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
                    />
                  )
                  : view === '3d'
                  ? (
                    <Suspense fallback={<div className="hero-loading">Loading 3D view…</div>}>
                      <Rocket3D tree={tree} info={built?.info ?? null} motors={motorDims} exportData={viewExportData} />
                    </Suspense>
                  )
                  : <AftView tree={tree} motors={motorDims} />}
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
              <div className="file-note" role="alert">
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
              />
            </div>
            {/* Cluster/pod layouts only make sense from behind — live inset
                while playing with layout, rotation and spacing (issue #13). */}
            {(() => {
              const hasRadial = (nodes: ComponentNode[]): boolean => nodes.some((n) =>
                (n.type === 'innertube' && typeof n['cluster'] === 'string' && n['cluster'] !== 'single')
                || n.type === 'podset' || n.type === 'parallelstage'
                || hasRadial(n.children ?? []));
              return hasRadial(tree.components) ? (
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginTop: 8 }}>
                  <div className="rocket-stage" style={{ flex: '0 1 300px' }}>
                    <AftView tree={tree} motors={motorDims} />
                  </div>
                  <p className="comp-stats" style={{ margin: '4px 0', maxWidth: 260 }}>
                    Aft view — the cluster / pod layout seen from behind, at the
                    current layout, rotation and spacing settings.
                  </p>
                </div>
              ) : null;
            })()}
          </div>

          {/* Only when there's a genuine choice: a single-config file's one
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

          <LaunchPanel value={launch} onChange={setLaunch} onLaunch={onLaunch} simulating={simulating} />
        </div>
        )}

        {tab === 'results' && (
        <main className="results-column" data-tour="results-panel">
          {result && aeroMode === 'classic' && result.summary.maxMachNumber > 0.9 && (
            <div className="file-note" role="alert">
              ⚠ This flight reaches <strong>Mach {result.summary.maxMachNumber.toFixed(2)}</strong> on
              the classic aero model, which is approximate past ~Mach 0.9 — supersonic CP travel
              (the stability hazard on fast flights) is not modeled. A wind-tunnel-validated
              supersonic model is available. Note: a model applies to the <strong>entire
              flight</strong>, subsonic portions included, so stability and apogee will shift when
              it changes.{' '}
              <button className="file-btn" style={{ marginLeft: 6 }}
                onClick={() => {
                  setPrefs({ ...prefs, aeroModel: 'auto' });
                  setPendingRelaunch(true);
                }}>
                Switch to Auto &amp; re-fly
              </button>
            </div>
          )}
          {(lastRun?.simWarnings ?? []).some((w) => w.priority === 'HIGH') && (
            // The Launch flow lands here — a HIGH-priority kernel warning
            // (no recovery device, deployment on the guide, …) must not be
            // scrollable-past. Full list, cautions included, sits in the
            // launch report below.
            <div className="file-note" role="alert">
              ⚠ <strong>This flight raised {
                lastRun!.simWarnings!.filter((w) => w.priority === 'HIGH').length === 1
                  ? 'a serious simulation warning'
                  : 'serious simulation warnings'
              }:</strong>{' '}
              {lastRun!.simWarnings!.filter((w) => w.priority === 'HIGH')
                .map((w) => formatWarning(w).label).join(' · ')}
            </div>
          )}
          {result && lastRun?.aeroModel === 'auto-supersonic' && (
            <div className="file-note">
              Auto aero: this flight was projected past Mach 0.9, so the whole flight was flown
              on the <strong>supersonic model</strong> (the displayed stability follows it too —
              subsonic flights of this design would fly classic).
            </div>
          )}
          {result && lastRun ? (
            <>
              <FlightStats run={lastRun} />
              <SimRunDetails run={lastRun} result={result} onFullSeries={fetchFullSeriesResult} />
              <FlightCharts result={result} />
            </>
          ) : lastRun ? (
            // A saved run re-opened from the history: tiles + the stored
            // report render in full; charts need a fresh simulation's series.
            <>
              <FlightStats run={lastRun} />
              <SimRunDetails run={lastRun} />
            </>
          ) : (
            <div className="panel placeholder empty-state">
              <Icon name="rocket" size={30} />
              <p><strong>This design hasn't flown yet</strong></p>
              <p>
                Press <strong>Launch</strong> (above) to fly it and see altitude,
                velocity and acceleration plots.
              </p>
            </div>
          )}
          {built && <DragPanel rocket={built.rocket} supersonicModel={effectiveSupersonic} />}
          {runsQuotaWarn && (
            <div className="file-note" role="alert">
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
            onSelect={(r) => { setResult(null); setLastRun(r); }}
          />
        </main>
        )}
      </div>
      <SiteBandFooter nav={mmrNav} />
    </div>
  );
}
