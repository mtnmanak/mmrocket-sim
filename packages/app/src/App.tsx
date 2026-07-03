import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OrkRocket,
  resetEngine,
  type ComponentType,
  type FlightResult,
  type RocketTree,
  type StaticInfo,
} from '@online-openrocket/engine';
import { ComponentTree } from './components/ComponentTree.js';
import { FlightCharts } from './components/FlightCharts.js';
import { DEFAULT_CONDITIONS, LaunchPanel, type LaunchConditions } from './components/LaunchPanel.js';
import { MotorPicker } from './components/MotorPicker.js';
import { PropertyPanel } from './components/PropertyPanel.js';
import { DesignStats, FlightStats } from './components/StatTiles.js';
import { Rocket3D } from './components/Rocket3D.js';
import { TreeSchematic } from './components/TreeSchematic.js';
import { BUILT_IN_MOTORS } from './motors.js';
import { PreferencesDialog } from './components/PreferencesDialog.js';
import { usePrefs } from './prefs/PrefsContext.js';
import { exportOrk, importOrk } from './services/orkFile.js';
import { loadSession, saveSessionDebounced } from './services/session.js';
import {
  addChild, defaultTree, emptyTree, findNode, makeNode, motorMounts, moveNode, removeNode, updateNode,
} from './tree/treeModel.js';
import './styles.css';

/** Rocket names that mean "the user never named it" (desktop default is "Rocket"). */
const GENERIC_ROCKET_NAMES = new Set(['rocket', 'new rocket', 'imported rocket', 'my rocket']);

export function App() {
  const { resolvedTheme } = usePrefs();
  const [showPrefs, setShowPrefs] = useState(false);
  // Restore the previous session (autosaved on every change) if one exists.
  const session = useRef(loadSession()).current;
  const [tree, setTreeRaw] = useState<RocketTree>(() => session?.tree ?? defaultTree());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [motorLabel, setMotorLabel] = useState(session?.motorLabel ?? 'C6-5');
  const [motor, setMotor] = useState(session?.motor ?? BUILT_IN_MOTORS['C6-5']!);
  const [mountId, setMountId] = useState<string | null>(session?.mountId ?? null);
  const [launch, setLaunch] = useState<LaunchConditions>(session?.launch ?? DEFAULT_CONDITIONS);
  const [result, setResult] = useState<FlightResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(
    session ? `Restored your previous session (“${session.tree.name ?? 'unnamed'}”, saved ${new Date(session.savedAt).toLocaleString()}).` : null,
  );
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [confirmNew, setConfirmNew] = useState(false);

  // Autosave the working state so a closed tab or crash never loses work.
  useEffect(() => {
    saveSessionDebounced({ tree, motorLabel, motor, mountId, launch });
  }, [tree, motorLabel, motor, mountId, launch]);

  // ---- undo (Ctrl+Z / button) ----
  const history = useRef<RocketTree[]>([]);
  const setTree = useCallback((next: RocketTree) => {
    setTreeRaw((prev) => {
      history.current.push(prev);
      if (history.current.length > 50) history.current.shift();
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
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo]);

  // ---- engine build + static analysis on every tree change ----
  const mounts = useMemo(() => motorMounts(tree), [tree]);
  const activeMountId = mountId && mounts.some((m) => m.id === mountId)
    ? mountId
    : mounts[0]?.id ?? null;

  const built = useMemo((): { rocket: OrkRocket; info: StaticInfo } | null => {
    try {
      resetEngine();
      const rocket = OrkRocket.buildTree(tree);
      if (activeMountId) {
        rocket.setMotorById(activeMountId, motor);
      }
      const info = rocket.staticInfo();
      setBuildError(null);
      return { rocket, info };
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [tree, motor, activeMountId]);

  useEffect(() => setResult(null), [tree, motor, launch]);

  const onLaunch = () => {
    if (!built) return;
    setSimulating(true);
    requestAnimationFrame(() => {
      try {
        setResult(built.rocket.simulate({
          launchRodLength: launch.launchRodLengthM,
          launchRodAngle: (launch.launchRodAngleDeg * Math.PI) / 180,
          windAverage: launch.windAverage,
          windStdDeviation: launch.windStdDev,
          launchAltitude: launch.launchAltitudeM,
          temperature: launch.temperatureC === null ? undefined : launch.temperatureC + 273.15,
          pressure: launch.pressureHPa === null ? undefined : launch.pressureHPa * 100,
          launchLatitude: launch.latitudeDeg,
        }));
      } catch (e) {
        setBuildError(e instanceof Error ? e.message : String(e));
      } finally {
        setSimulating(false);
      }
    });
  };

  // ---- .ork I/O (via the fixed-shape bridge until P2.5) ----
  const onSaveOrk = () => {
    const xml = exportOrk({
      name: tree.name ?? 'My Rocket',
      tree,
      motor: {
        designation: motor.designation,
        diameter: motor.diameter,
        length: motor.length,
        delay: motor.ejectionDelay,
      },
      mountId: activeMountId,
    });
    const blob = new Blob([xml], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(tree.name ?? 'rocket').replace(/[^\w-]+/g, '_')}.ork`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onOpenOrk = async (file: File) => {
    try {
      const imported = importOrk(await file.arrayBuffer());
      // Desktop OpenRocket's default rocket name is literally "Rocket" (users
      // name the file instead) — fall back to the filename in that case.
      if (!imported.tree.name
          || GENERIC_ROCKET_NAMES.has(imported.tree.name.trim().toLowerCase())) {
        const fromFile = file.name.replace(/\.ork$/i, '').replace(/_+/g, ' ').trim();
        if (fromFile) {
          imported.tree.name = fromFile;
          imported.name = fromFile;
        }
      }
      const notes: string[] = [`Loaded “${imported.name}”.`, ...imported.notes];
      if (imported.motor) {
        const match = Object.entries(BUILT_IN_MOTORS).find(
          ([k]) => k.startsWith(imported.motor!.designation),
        );
        if (match) {
          setMotorLabel(match[0]);
          setMotor(match[1]);
          notes.push(`Motor: ${match[0]} (matched built-in).`);
        } else {
          notes.push(`Motor “${imported.motor.designation}” isn't built-in — pick it via thrustcurve.org search.`);
        }
      }
      setTree(imported.tree);
      setSelectedId(null);
      if (imported.motor?.mountId) setMountId(imported.motor.mountId);
      setFileNote(notes.join('\n'));
    } catch (e) {
      setFileNote(`Could not open that .ork file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const selectedNode = selectedId ? findNode(tree, selectedId) : null;
  const mountNode = activeMountId ? findNode(tree, activeMountId) : null;
  const mountInnerDiaMm = mountNode
    ? Math.round(((mountNode['outerRadius'] as number ?? 0.0095) - (mountNode['thickness'] as number ?? 0.0005)) * 2000)
    : 18;

  return (
    <div className="viz-root" data-theme={resolvedTheme}>
      <header className="app-header">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <h1 style={{ flex: 1 }}>🚀 Online OpenRocket</h1>
          <button className="file-btn" onClick={() => setShowPrefs(true)} title="Preferences">
            ⚙ Preferences
          </button>
        </div>
        <p>
          Design a model rocket and fly it — powered by the real OpenRocket physics
          engine (Extended Barrowman, 6-DOF RK4) compiled to JavaScript.
        </p>
      </header>
      {showPrefs && <PreferencesDialog onClose={() => setShowPrefs(false)} />}
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
                  setSelectedId(null);
                  setResult(null);
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
              onAdd={(parentId, type: ComponentType) => {
                const node = makeNode(type);
                setTree(addChild(tree, parentId, node));
                setSelectedId(node.id!);
              }}
            />
          </div>

          {selectedNode && (
            <PropertyPanel
              tree={tree}
              node={selectedNode}
              onPatch={(patch) => setTree(updateNode(tree, selectedNode.id!, patch))}
            />
          )}

          <div className="panel" style={{ marginTop: 10 }}>
            <h2>Motor</h2>
            {mounts.length > 1 && (
              <div className="field" style={{ marginBottom: 8 }}>
                <label>Mount</label>
                <select value={activeMountId ?? ''} onChange={(e) => setMountId(e.target.value)}>
                  {mounts.map((m) => (
                    <option key={m.id} value={m.id}>{m.name ?? m.id}</option>
                  ))}
                </select>
              </div>
            )}
            {mounts.length === 0 && (
              <p className="stability-bad" style={{ fontSize: 12 }}>
                No motor mount — add an inner tube and check “acts as motor mount”.
              </p>
            )}
            <MotorPicker
              mountDiameterMm={mountInnerDiaMm}
              selectedLabel={motorLabel}
              onSelect={(label, m) => {
                setMotorLabel(label);
                setMotor(m);
              }}
            />
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
              <label className="file-btn">
                Open .ork
                <input type="file" accept=".ork" style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onOpenOrk(f);
                    e.target.value = '';
                  }} />
              </label>
              <button className="file-btn" onClick={onSaveOrk}>Save .ork</button>
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
            {built && <DesignStats info={built.info} motorLabel={activeMountId ? motorLabel : undefined} />}
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
              <FlightCharts result={result} />
            </>
          ) : (
            <div className="panel placeholder">
              Press <strong>Launch</strong> to fly this design and see altitude,
              velocity and acceleration plots.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
