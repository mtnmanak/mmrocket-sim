import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OrkRocket,
  resetEngine,
  type ComponentType,
  type FlightResult,
  type IgnitionEvent,
  type MotorSpec,
  type RocketTree,
  type StaticInfo,
} from '@online-openrocket/engine';
import { BatchSimulate } from './components/BatchSimulate.js';
import { ChangelogDialog } from './components/ChangelogDialog.js';
import { ComponentTree } from './components/ComponentTree.js';
import { FlightCharts } from './components/FlightCharts.js';
import { DEFAULT_CONDITIONS, LaunchPanel, type LaunchConditions } from './components/LaunchPanel.js';
import { builtInMeta, MotorPicker } from './components/MotorPicker.js';
import { NumField } from './components/NumField.js';
import { PropertyPanel } from './components/PropertyPanel.js';
import { SimHistory, SimRunDetails } from './components/SimResults.js';
import { DesignStats, FlightStats } from './components/StatTiles.js';
import { Rocket3D } from './components/Rocket3D.js';
import { TreeSchematic } from './components/TreeSchematic.js';
import { BUILT_IN_MOTORS } from './motors.js';
import { PreferencesDialog } from './components/PreferencesDialog.js';
import { usePrefs } from './prefs/PrefsContext.js';
import { UnitChip } from './components/UnitChip.js';
import { niceStep, siToUi, uiToSi } from './prefs/units.js';
import { displayDesignation, findDbMotor, isHighPower } from './services/motorDb.js';
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
  addChild, addStage, defaultTree, duplicateNode, emptyTree, findNode,
  inheritDefaults, makeNode, motorMounts, moveNode, normalizeTree, removeNode,
  stageIndexOf, stages, updateAllNodes, updateNode,
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

/** Rewrites a motor label's delay suffix ("H220-14" / "H220 (auto delay)"). */
function labelWithDelay(label: string, delay: number | 'auto'): string {
  const base = label.replace(/ \(auto delay\)$/, '').replace(/-\d+(\.\d+)?$/, '');
  return delay === 'auto' ? `${base} (auto delay)` : `${base}-${delay}`;
}

export function App() {
  const { prefs, resolvedTheme } = usePrefs();
  const [showPrefs, setShowPrefs] = useState(false);
  // Restore the previous session (autosaved on every change) if one exists.
  // normalizeTree wraps pre-v0.009 flat trees in one stage. Lazy useState:
  // loadSession parses the whole tree — never re-run it on re-renders.
  const [session] = useState(loadSession);
  const [tree, setTreeRaw] = useState<RocketTree>(
    () => normalizeTree(session?.tree ?? defaultTree()));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Per-mount motors (Release C). Legacy sessions carried ONE motor + the
  // mount it applied to — migrate it onto that mount.
  const [mountMotors, setMountMotors] = useState<Record<string, MountMotor>>(() => {
    if (session?.mountMotors) return session.mountMotors;
    const legacyTree = normalizeTree(session?.tree ?? defaultTree());
    const target = session?.mountId ?? motorMounts(legacyTree)[0]?.id;
    if (!target) return {};
    const label = session?.motorLabel ?? 'C6-5';
    const spec = session?.motor ?? BUILT_IN_MOTORS['C6-5']!;
    const meta = session?.motorMeta ?? builtInMeta(label);
    return { [target]: { label, spec, meta, ignition: { event: 'automatic', delay: 0 } } };
  });
  // Max motor length is a physical property of the ROCKET (how much room the
  // airframe has), so it lives here — not in the motor browser's filters.
  const [maxMotorLenM, setMaxMotorLenM] = useState<number | null>(
    session && 'maxMotorLengthM' in session
      ? session.maxMotorLengthM ?? null
      : legacyMaxMotorLength());
  const [launch, setLaunch] = useState<LaunchConditions>(session?.launch ?? DEFAULT_CONDITIONS);
  const [result, setResult] = useState<FlightResult | null>(null);
  const [lastRun, setLastRun] = useState<SimRun | null>(null);
  const [runs, setRuns] = useState<SimRun[]>(() => loadRuns());
  const [simulating, setSimulating] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(
    session ? `Restored your previous session (“${session.tree.name ?? 'unnamed'}”, saved ${new Date(session.savedAt).toLocaleString()}).` : null,
  );
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [confirmNew, setConfirmNew] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);

  // Autosave the working state so a closed tab or crash never loses work.
  useEffect(() => {
    saveSessionDebounced({ tree, mountMotors, launch, maxMotorLengthM: maxMotorLenM });
  }, [tree, mountMotors, launch, maxMotorLenM]);

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
    if (prev) setTreeRaw(prev);
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
  const isStaged = stageList.length > 1;
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

  // No setState in here — the error is part of the memo's value (setState
  // during render breaks under StrictMode's double-invoke).
  const buildResult = useMemo((): { rocket: OrkRocket; info: StaticInfo } | { error: string } => {
    try {
      resetEngine();
      const rocket = OrkRocket.buildTree(tree);
      for (const [id, mm] of assigned) {
        rocket.setMotorById(id, mm.spec);
        if (mm.ignition.event !== 'automatic' || mm.ignition.delay !== 0) {
          rocket.setMotorIgnitionById(id, mm.ignition.event, mm.ignition.delay);
        }
      }
      const info = rocket.staticInfo();
      return { rocket, info };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [tree, assigned]);
  const built = 'error' in buildResult ? null : buildResult;
  const buildError = 'error' in buildResult ? buildResult.error : simError;

  useEffect(() => { setResult(null); setLastRun(null); }, [tree, mountMotors, launch]);

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
        // (chuteless HIGH-POWER boosters must warn — the G80 rule).
        const stageMotorInfo: Record<string, { label: string; highPower: boolean }> = {};
        for (const [id, mm] of assigned) {
          const st = stageList[stageIndexOf(tree, id)];
          if (st?.name) {
            stageMotorInfo[st.name] = { label: mm.label, highPower: mm.meta.highPower === true };
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
      download(exportRkt({ name: tree.name ?? 'My Rocket', tree, motors: exportMotorsMap() }), 'rkt');
    } catch (e) {
      setFileNote(`RockSim export failed: ${e instanceof Error ? e.message : String(e)}`);
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
          const fileDelay = Number.isFinite(ref.delay) ? ref.delay : builtIn[1].ejectionDelay;
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
          const label = `${dbMatch.commonName}-${ref.delay}`;
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
          notes.push(`Motor: ${dbMatch.manufacturerAbbrev} ${displayDesignation(dbMatch.designation, dbMatch.manufacturerAbbrev)}-${ref.delay} (loaded from the motor database).`);
        } catch {
          notes.push(`Motor “${ref.designation}” is in the motor database but its thrust curve couldn't be downloaded — pick it via Browse motor database.`);
        }
      }
      setTree(normalizeTree(imported.tree));
      setMountMotors(nextMotors);
      setSelectedId(null);
      setFileNote(notes.join('\n'));
    } catch (e) {
      setFileNote(`Could not open that .ork file: ${e instanceof Error ? e.message : String(e)}`);
    }
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
  const mountDiaMm = (m: ReturnType<typeof findNode>) => m
    ? Math.round(((m['outerRadius'] as number ?? 0.0095) - (m['thickness'] as number ?? 0.0005)) * 2000)
    : 18;
  // Batch simulate targets the PRIMARY (sustainer) mount; per the owner's rule
  // batch never runs across staged rockets (combinatorics).
  const primaryMountNode = primaryMountId ? findNode(tree, primaryMountId) : null;
  const primaryMotorCount = clusterCount(primaryMountNode?.['cluster'] as string | undefined);
  const primaryLabel = primaryMountId ? mountMotors[primaryMountId]?.label : undefined;

  return (
    <div className="viz-root" data-theme={resolvedTheme}>
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h1>🚀 Online OpenRocket</h1>
          <button
            className="version-badge"
            style={{ flex: '0 0 auto', marginRight: 'auto' }}
            title="What's new in this build"
            onClick={() => setShowChangelog(true)}
          >
            v{APP_VERSION} beta
          </button>
          <button className="file-btn" onClick={() => setShowPrefs(true)} title="Preferences">
            ⚙ Preferences
          </button>
        </div>
        <p>
          Design a model rocket and fly it — powered by the real OpenRocket physics
          engine (Extended Barrowman, 6-DOF RK4) compiled to JavaScript.
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
      {showChangelog && <ChangelogDialog onClose={() => setShowChangelog(false)} />}
      {showBatch && built && primaryMountId && !isStaged && (
        <BatchSimulate
          rocket={built.rocket}
          info={built.info}
          mountId={primaryMountId}
          mountDiameterMm={mountDiaMm(primaryMountNode)}
          maxMotorLengthM={maxMotorLenM}
          motorCount={primaryMotorCount}
          launch={launch}
          rocketName={tree.name ?? 'Rocket'}
          onRunsChange={setRuns}
          onClose={() => {
            // Batch runs left some other motor on the engine-side rocket —
            // restore the one the UI shows.
            try {
              const mm = mountMotors[primaryMountId];
              if (mm) built.rocket.setMotorById(primaryMountId, mm.spec);
            } catch { /* rebuilt anyway */ }
            setShowBatch(false);
          }}
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
                💾 Save .ork first
              </button>
              <button
                className="file-btn modal-danger"
                onClick={() => {
                  setTree(emptyTree());
                  setMountMotors({});
                  setMaxMotorLenM(null);
                  setSelectedId(null);
                  setResult(null);
                  setLastRun(null);
                  setConfirmNew(false);
                }}
              >
                Discard &amp; start new
              </button>
              <button className="file-btn" onClick={() => setConfirmNew(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <div className="layout">
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
                setTree(removeNode(tree, id));
                if (selectedId === id) setSelectedId(null);
              }}
              onDuplicate={(id) => {
                const { tree: next, newId } = duplicateNode(tree, id);
                setTree(next);
                if (newId) setSelectedId(newId);
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

          {selectedNode && (
            <PropertyPanel
              tree={tree}
              node={selectedNode}
              info={selectedInfo}
              onPatch={(patch) => setTree(updateNode(tree, selectedNode.id!, patch))}
              onPatchAll={(patch) => setTree(updateAllNodes(tree, patch))}
            />
          )}

          <div className="panel" style={{ marginTop: 10 }}>
            <h2>Motors</h2>
            {mounts.length === 0 && (
              <p className="stability-bad" style={{ fontSize: 12 }}>
                No motor mount — add an inner tube and check “acts as motor mount”.
              </p>
            )}
            <div className="field" style={{ marginBottom: 8 }}
              title="Longest motor the airframe has room for — a physical property of this rocket. Longer motors are flagged in the browser and excluded from batch simulation.">
              <label>Max motor length (<UnitChip quantity="motorDimensions" />)</label>
              <NumField
                value={maxMotorLenM === null
                  ? undefined
                  : siToUi('motorDimensions', prefs.units.motorDimensions, maxMotorLenM)}
                step={niceStep(siToUi('motorDimensions', prefs.units.motorDimensions, 0.005))}
                nullable
                placeholder="no limit"
                ariaLabel="Maximum motor length"
                onCommit={(v) => setMaxMotorLenM(
                  v === null ? null : uiToSi('motorDimensions', prefs.units.motorDimensions, v))}
              />
            </div>
            {mounts.map((m) => {
              const mm = mountMotors[m.id!];
              const mNode = findNode(tree, m.id!);
              const stIdx = stageIndexOf(tree, m.id!);
              const stName = stageList[stIdx]?.name ?? `Stage ${stIdx + 1}`;
              const count = clusterCount(mNode?.['cluster'] as string | undefined);
              const isSustainerMount = stIdx === 0;
              return (
                <div key={m.id} className="mount-card" style={{ marginBottom: 10, paddingTop: 6, borderTop: '1px solid var(--border, #333)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                    <label style={{ flex: 1, fontWeight: 600 }}>
                      {isStaged ? `${stName} · ` : ''}{m.name ?? 'Motor mount'}
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
                    maxMotorLengthM={maxMotorLenM}
                    selectedLabel={mm?.label ?? ''}
                    onSelect={(label, spec, meta) => assignMotor(m.id!, label, spec, meta)}
                  />
                  {mm && (
                    <div className="field" style={{ marginTop: 6 }}>
                      <label>
                        Ejection delay (s)
                        {mm.meta.availableDelays?.length
                          ? ` — prescribed: ${mm.meta.availableDelays.join(', ')}`
                          : ''}
                      </label>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ flex: 1 }}>
                          <NumField
                            value={mm.spec.ejectionDelay}
                            step={1}
                            max={60}
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
            <button
              className="file-btn"
              style={{ marginTop: 8, width: '100%' }}
              disabled={!built || !primaryMountId || isStaged}
              title={isStaged
                ? 'Batch simulation is not available on staged rockets — the motor combinations explode.'
                : 'Simulate every motor that fits this rocket, with filters and acceptance criteria'}
              onClick={() => setShowBatch(true)}
            >
              ⚡ Batch simulate motors…
            </button>
          </div>

          <LaunchPanel value={launch} onChange={setLaunch} onLaunch={onLaunch} simulating={simulating} />
        </aside>

        <main className="results-column">
          <div className="panel">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <h2 style={{ flex: 1 }}>Rocket</h2>
              <div className="view-toggle" role="tablist">
                <button className={view === '2d' ? 'active' : ''} role="tab"
                  aria-selected={view === '2d'} onClick={() => setView('2d')}>2D</button>
                <button className={view === '3d' ? 'active' : ''} role="tab"
                  aria-selected={view === '3d'} onClick={() => setView('3d')}>3D</button>
              </div>
              <label className="file-btn" title="Open an OpenRocket (.ork), RockSim (.rkt), or RASAero II (.CDX1) design">
                Open…
                <input type="file" accept=".ork,.rkt,.CDX1" style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onOpenOrk(f);
                    e.target.value = '';
                  }} />
              </label>
              <button className="file-btn" onClick={onSaveOrk}>Save .ork</button>
              <button className="file-btn" onClick={onSaveRkt}
                title="Export as a RockSim design (max 3 stages; clusters split into individual tubes)">
                Save .rkt
              </button>
              <button className="file-btn"
                title="Export as a RASAero II design (aero geometry + recovery + launch weight; RASAero needs conical transitions and 3–8 trapezoid fins)"
                onClick={() => {
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
                }}>
                Save .CDX1
              </button>
              <button className="file-btn"
                title="Export the external 3D geometry as a Wavefront OBJ (meters) — print preview / CAD reference"
                onClick={() => {
                  try {
                    download(rocketToObj(tree, tree.name ?? 'Rocket'), 'obj');
                  } catch (e) {
                    setFileNote(`OBJ export failed: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }}>
                Save .obj
              </button>
            </div>
            {view === '2d'
              ? (
                <TreeSchematic
                  tree={tree}
                  info={built?.info ?? null}
                  onPatchNode={(id, patch) => setTree(updateNode(tree, id, patch))}
                />
              )
              : <Rocket3D tree={tree} info={built?.info ?? null} />}
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
            {fileNote && (
              <div className="file-note" role="alert">
                {fileNote}
                <button className="file-note-dismiss" onClick={() => setFileNote(null)} aria-label="Dismiss">×</button>
              </div>
            )}
            {buildError && <p className="stability-bad">{buildError}</p>}
          </div>
          {result ? (
            <>
              <FlightStats summary={result.summary} />
              {lastRun && <SimRunDetails run={lastRun} />}
              <FlightCharts result={result} />
            </>
          ) : lastRun ? (
            // A saved run re-opened from the history: the stored report renders
            // in full, but charts need a fresh simulation's series.
            <SimRunDetails run={lastRun} />
          ) : (
            <div className="panel placeholder">
              Press <strong>Launch</strong> to fly this design and see altitude,
              velocity and acceleration plots.
            </div>
          )}
          <SimHistory
            runs={runs}
            onRunsChange={setRuns}
            selectedId={lastRun?.id ?? null}
            onSelect={(r) => { setResult(null); setLastRun(r); }}
          />
        </main>
      </div>
    </div>
  );
}
