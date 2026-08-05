import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { Icon } from './components/Icon.js';
import { ChangelogDialog } from './components/ChangelogDialog.js';
import { GuideDialog } from './components/GuideDialog.js';
import { ComponentTree } from './components/ComponentTree.js';
import { FlightCharts } from './components/FlightCharts.js';
import { DragPanel } from './components/DragPanel.js';
import { DEFAULT_CONDITIONS, LaunchPanel, type LaunchConditions } from './components/LaunchPanel.js';
import { builtInMeta, MotorPicker } from './components/MotorPicker.js';
import { NumField } from './components/NumField.js';
import { PropertyPanel } from './components/PropertyPanel.js';
import { SimHistory, SimRunDetails } from './components/SimResults.js';
import { DesignStats, FlightStats, stabilityGlyphClass } from './components/StatTiles.js';
import { Rocket3D } from './components/Rocket3D.js';
import { TreeSchematic } from './components/TreeSchematic.js';
import { AftView } from './components/AftView.js';
import { BUILT_IN_MOTORS } from './motors.js';
import { PreferencesDialog } from './components/PreferencesDialog.js';
import { usePrefs } from './prefs/PrefsContext.js';
import { UnitChip } from './components/UnitChip.js';
import { fmtSi, niceStep, siToUi, uiToSi } from './prefs/units.js';
import { classLabel, diameterClass, displayDesignation, findDbMotor, isHighPower } from './services/motorDb.js';
import { delayOptions, fetchMotorSpec } from './services/thrustcurve.js';
import { exportOrk, importOrk, type OrkExportMotor } from './services/orkFile.js';
import { exportRkt, importRkt } from './services/rocksimFile.js';
import { rocketToObj } from './services/objExport.js';
import { exportCdx1, importCdx1 } from './services/rasaeroFile.js';
import { loadSession, saveSessionDebounced } from './services/session.js';
import { buildSimRun, recommendDelay, type MotorMeta, type SimRun } from './services/simReport.js';
import { addRun, loadRuns } from './services/simStore.js';
import { APP_VERSION } from './version.js';
import {
  addChild, addStage, cloneSubtree, defaultTree, duplicateNode, emptyTree, engineTree, findNode,
  findParent, hasParallelStage, inheritDefaults, makeNode, motorMounts, moveNode,
  normalizeTree, removeNode, stageIndexOf, stages, updateAllNodes, updateNode,
} from './tree/treeModel.js';
import { clusterCount } from './tree/cluster.js';

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
import './styles.css';

/** Rocket names that mean "the user never named it" (desktop default is "Rocket"). */
const GENERIC_ROCKET_NAMES = new Set(['rocket', 'new rocket', 'imported rocket', 'my rocket']);

/**
 * mountainmanrockets.com site menu — the app embeds in the site and should
 * feel like one of its pages. target="_top" makes clicks navigate the WHOLE
 * tab (escaping the WordPress iframe), never a nested frame.
 */
const SITE_MENU: { label: string; url: string }[] = [
  { label: 'Home', url: 'https://www.mountainmanrockets.com/' },
  { label: 'Builds', url: 'https://www.mountainmanrockets.com/index.php/builds/' },
  { label: 'HPR Primer', url: 'https://www.mountainmanrockets.com/index.php/hpr-primer/' },
  { label: 'Tools and Tips', url: 'https://www.mountainmanrockets.com/index.php/tools_tech/' },
  { label: 'Online Tools', url: 'https://www.mountainmanrockets.com/online_tools/' },
  { label: 'Gallery', url: 'https://www.mountainmanrockets.com/index.php/gallery/' },
  { label: 'Videos', url: 'https://www.mountainmanrockets.com/index.php/videos/' },
  { label: 'Links', url: 'https://www.mountainmanrockets.com/index.php/links/' },
];

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

export function App() {
  const { prefs, setPrefs, resolvedTheme, daylight } = usePrefs();
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
  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
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
  const [confirmNew, setConfirmNew] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  // Workspace tab (Design / Motors & Launch / Results) — persisted so a
  // reload lands the user back where they were working.
  const [tab, setTabRaw] = useState<'design' | 'motors' | 'results'>(() => {
    try {
      const t = localStorage.getItem('online-openrocket.workspace.v1');
      return t === 'motors' || t === 'results' ? t : 'design';
    } catch {
      return 'design';
    }
  });
  const setTab = useCallback((t: 'design' | 'motors' | 'results') => {
    setTabRaw(t);
    try { localStorage.setItem('online-openrocket.workspace.v1', t); } catch { /* ignore */ }
  }, []);
  const [showFileMenu, setShowFileMenu] = useState(false);
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
    saveSessionDebounced({ tree, mountMotors, launch, maxMotorLengthByStage });
  }, [tree, mountMotors, launch, maxMotorLen]);

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

  // No setState in here — the error is part of the memo's value (setState
  // during render breaks under StrictMode's double-invoke).
  const buildResult = useMemo((): { rocket: OrkRocket; info: StaticInfo } | { error: string } => {
    try {
      resetEngine();
      const rocket = OrkRocket.buildTree(engineTree(tree));
      // Opt-in Rogers Modified Barrowman (Kbf) — set before staticInfo() so the
      // reported CP/stability reflects it, and it persists onto this build's
      // handle for later simulate() calls.
      rocket.setRogersModifiedBarrowman(prefs.rogersKbf ?? true);
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
  }, [tree, assigned, prefs.rogersKbf, effectiveSupersonic]);
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
  }, [physicsKey, mountMotors, launch, aeroMode]);

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
        const simOpts = {
          launchRodLength: launch.launchRodLengthM,
          launchRodAngle: (launch.launchRodAngleDeg * Math.PI) / 180,
          windAverage: launch.windAverage,
          windStdDeviation: launch.windStdDev,
          launchAltitude: launch.launchAltitudeM,
          temperature: launch.temperatureC === null ? undefined : launch.temperatureC + 273.15,
          pressure: launch.pressureHPa === null ? undefined : launch.pressureHPa * 100,
          launchLatitude: launch.latitudeDeg,
        };
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
        });
        setLastRun(run);
        setRuns(addRun(run));
        setSimError(null);
      } catch (e) {
        setSimError(e instanceof Error ? e.message : String(e));
      } finally {
        setSimulating(false);
      }
    });
  };

  // ---- design file I/O (.ork native, .rkt RockSim) ----
  const exportMotorsMap = (): Record<string, OrkExportMotor> => {
    const motors: Record<string, OrkExportMotor> = {};
    for (const [id, mm] of assigned) {
      motors[id] = {
        designation: mm.spec.designation,
        diameter: mm.spec.diameter,
        length: mm.spec.length,
        delay: mm.spec.ejectionDelay,
        ignitionEvent: mm.ignition.event,
        ignitionDelay: mm.ignition.delay,
      };
    }
    return motors;
  };

  const download = (content: string, ext: string) => {
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(tree.name ?? 'rocket').replace(/[^\w-]+/g, '_')}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onSaveOrk = () => {
    download(exportOrk({ name: tree.name ?? 'My Rocket', tree, motors: exportMotorsMap() }), 'ork');
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

  const onSaveObj = () => {
    try {
      download(rocketToObj(tree, tree.name ?? 'Rocket'), 'obj');
    } catch (e) {
      setFileNote(`OBJ export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const onOpenOrk = async (file: File) => {
    try {
      const buffer = await file.arrayBuffer();
      const imported = /\.rkt$/i.test(file.name) ? importRkt(buffer)
        : /\.cdx1$/i.test(file.name) ? importCdx1(buffer)
        : importOrk(buffer);
      // Desktop OpenRocket's default rocket name is literally "Rocket" (users
      // name the file instead) — fall back to the filename in that case.
      if (!imported.tree.name
          || GENERIC_ROCKET_NAMES.has(imported.tree.name.trim().toLowerCase())) {
        const fromFile = file.name.replace(/\.(ork|rkt|cdx1)$/i, '').replace(/_+/g, ' ').trim();
        if (fromFile) {
          imported.tree.name = fromFile;
          imported.name = fromFile;
        }
      }
      const notes: string[] = [`Loaded “${imported.name}”.`, ...imported.notes];
      // Load EVERY mount's motor (staged/multi-mount files included).
      const nextMotors: Record<string, MountMotor> = {};
      for (const [nodeId, ref] of Object.entries(imported.motors)) {
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
          nextMotors[nodeId] = {
            label,
            spec: { ...builtIn[1], ejectionDelay: fileDelay },
            meta: builtInMeta(builtIn[0]),
            ignition,
          };
          notes.push(`Motor: ${label} (matched built-in).`);
          continue;
        }
        // RockSim refs carry no motor diameter (0) — match by designation only.
        const dbMatch = findDbMotor(ref.designation, ref.diameter > 0 ? ref.diameter * 1000 : undefined);
        if (!dbMatch) {
          notes.push(`Motor “${ref.designation}” isn't in the motor database — pick one via Browse motor database.`);
          continue;
        }
        try {
          const spec = await fetchMotorSpec(dbMatch, ref.delay);
          // Plugged motors (Infinity delay) display the standard "-P" suffix.
          const delayTag = Number.isFinite(ref.delay) ? String(ref.delay) : 'P';
          const label = `${dbMatch.commonName}-${delayTag}`;
          nextMotors[nodeId] = {
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
          };
          notes.push(`Motor: ${dbMatch.manufacturerAbbrev} ${displayDesignation(dbMatch.designation, dbMatch.manufacturerAbbrev)}-${delayTag} (loaded from the motor database).`);
        } catch {
          notes.push(`Motor “${ref.designation}” is in the motor database but its thrust curve couldn't be downloaded — pick it via Browse motor database.`);
        }
      }
      setTree(normalizeTree(imported.tree));
      setMountMotors(nextMotors);
      setMaxMotorLen({}); // imported stages have fresh ids — old limits don't apply
      setSelectedId(null);
      setFileNote(notes.join('\n'));
    } catch (e) {
      setFileNote(`Could not open that .ork file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Loaded motor dimensions per mount — the 2D schematic draws each motor
  // to scale inside its mount tube (the owner's request: real case length).
  const motorDims = useMemo(
    () => Object.fromEntries(assigned.map(([id, mm]) => [
      id, { length: mm.spec.length, diameter: mm.spec.diameter },
    ])),
    [assigned],
  );

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
  const mountDiaMm = (m: ReturnType<typeof findNode>) => m
    ? Math.round(((m['outerRadius'] as number ?? 0.0095) - (m['thickness'] as number ?? 0.0005)) * 2000)
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
    <div className="viz-root" data-theme={resolvedTheme} data-contrast={daylight ? 'high' : undefined}>
      <nav className="site-nav" aria-label="Mountain Man Rockets site menu">
        {SITE_MENU.map((item) => (
          <a key={item.url} href={item.url} target="_top">{item.label}</a>
        ))}
      </nav>
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h1><Icon name="rocket" size={19} /> Online OpenRocket</h1>
          <button
            className="version-badge"
            style={{ flex: '0 0 auto', marginRight: 'auto' }}
            title="What's new in this build"
            onClick={() => setShowChangelog(true)}
          >
            v{APP_VERSION} beta
          </button>
          <label className="file-btn" title="Open an OpenRocket (.ork), RockSim (.rkt), or RASAero II (.CDX1) design">
            <Icon name="folder" /> Open…
            <input type="file" accept=".ork,.rkt,.CDX1" style={{ display: 'none' }}
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
          <button className="file-btn" onClick={() => setShowGuide(true)} title="User guide — quick start, features, and the physics behind the sim">
            <Icon name="book" /> Guide
          </button>
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
        <p>
          Design, simulate, fly — OpenRocket-derived physics, validated to
          Mach&nbsp;4.6 against NASA wind-tunnel data.
          {' '}
          <a
            href="https://github.com/mtnmanak/online_open_rocket"
            target="_blank"
            rel="noreferrer"
            title="This app is free software under the GPL v3 or later — source code for this build"
          >
            source&nbsp;(GPL)
          </a>
        </p>
      </header>
      {showPrefs && <PreferencesDialog onClose={() => setShowPrefs(false)} />}
      {showGuide && <GuideDialog onClose={() => setShowGuide(false)} />}
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
          onRunsChange={setRuns}
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
                  setMaxMotorLen({});
                  setSelectedId(null);
                  setResult(null);
                  setLastRun(null);
                  setConfirmNew(false);
                  // A stale "Loaded <old rocket>…" banner over a fresh design
                  // reads like the import happened again — clear both notes.
                  setFileNote(null);
                  setSimError(null);
                }}
              >
                Discard &amp; start new
              </button>
              <button className="file-btn" onClick={() => setConfirmNew(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <div className="workspace">
        {/* Always-visible vitals, styled as an instrument readout: the
            tweak-and-refly loop never needs a tab switch to check stability/
            mass or start a flight. */}
        <div className="vitals-strip">
          <span className="vitals-item vitals-item-name" title="Rocket name — edit it in the Design workspace">
            <span className="vitals-label">Rocket</span>
            <span className="vitals-value">{tree.name || 'Rocket'}</span>
          </span>
          {built ? (
            <>
              <span className="vitals-item"
                title="Static stability margin (calibers). ✓ = 1–3 cal, △ = over-stable (weathercocks in wind), ⚠ = under-stable">
                <span className="vitals-label">Stability</span>
                {(() => {
                  const { glyph, cls } = stabilityGlyphClass(built.info.stabilityCalibers);
                  return (
                    <span className={`vitals-value ${cls}`}>
                      {glyph} {built.info.stabilityCalibers.toFixed(2)} cal
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
                // rocket can be viewed/weighed clean (2026-08-05 chat).
                <button className="fin-row-del" style={{ marginLeft: 6 }}
                  title="Unload all motors — view and weigh the rocket clean (empty mass, no motor silhouettes). Reload any time from Motors & Launch."
                  onClick={() => setMountMotors({})}>⏏</button>
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
            onClick={onLaunch}
            disabled={!built || !primaryMountId || simulating}
            title={!primaryMountId ? 'Assign a motor first (Motors & Launch workspace)' : 'Simulate the flight'}
          >
            {simulating ? 'Simulating…' : <><Icon name="rocket" size={15} /> Launch</>}
          </button>
        </div>

        <div className="workspace-tabs" role="tablist" aria-label="Workspace">
          <button role="tab" aria-selected={tab === 'design'}
            className={tab === 'design' ? 'active' : ''} onClick={() => setTab('design')}>
            <Icon name="wrench" size={13} /> Design
          </button>
          <button role="tab" aria-selected={tab === 'motors'}
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

        {tab === 'design' && (
        <div className="design-layout">
        <aside>
          <div className="panel">
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
          <div className="panel">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <h2 style={{ flex: 1 }}>Rocket</h2>
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
            <div className="rocket-stage">
              {view === '2d'
                ? (
                  <TreeSchematic
                    tree={tree}
                    info={built?.info ?? null}
                    motors={motorDims}
                    onPatchNode={(id, patch) => setTree(updateNode(tree, id, patch))}
                    selectedId={selectedId}
                    onSelect={(id) => setSelectedId(id)}
                  />
                )
                : view === '3d'
                ? <Rocket3D tree={tree} info={built?.info ?? null} />
                : <AftView tree={tree} motors={motorDims} />}
            </div>
            {mountSizes.length > 0 && (
              <div className="mount-sizes" title="Motor mount inner diameter — the nominal motor size each mount accepts">
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
            {built && (
              <DesignStats
                info={built.info}
                motorLabel={assigned.length > 1
                  ? assigned.map(([, mm]) => mm.label).join(' + ')
                  : primaryLabel}
              />
            )}
            {built && built.info.warningTexts.length > 0 && (
              <div className="file-note" role="alert">
                {built.info.warningTexts.join('\n')}
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
        <main className="results-column">
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
              <SimRunDetails run={lastRun} />
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
          <SimHistory
            runs={runs}
            onRunsChange={setRuns}
            selectedId={lastRun?.id ?? null}
            onSelect={(r) => { setResult(null); setLastRun(r); }}
          />
        </main>
        )}
      </div>
    </div>
  );
}
