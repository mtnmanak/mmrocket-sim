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
import { exportOrk, importOrk } from './services/orkFile.js';
import { specToTree, treeToSpec } from './tree/specBridge.js';
import {
  addChild, defaultTree, findNode, makeNode, motorMounts, moveNode, removeNode, updateNode,
} from './tree/treeModel.js';
import './styles.css';

export function App() {
  const [tree, setTreeRaw] = useState<RocketTree>(() => defaultTree());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [motorLabel, setMotorLabel] = useState('C6-5');
  const [motor, setMotor] = useState(BUILT_IN_MOTORS['C6-5']!);
  const [mountId, setMountId] = useState<string | null>(null);
  const [launch, setLaunch] = useState<LaunchConditions>(DEFAULT_CONDITIONS);
  const [result, setResult] = useState<FlightResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [view, setView] = useState<'2d' | '3d'>('2d');

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
      spec: treeToSpec(tree),
      motor: {
        designation: motor.designation,
        diameter: motor.diameter,
        length: motor.length,
        delay: motor.ejectionDelay,
      },
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
      if (imported.ignored.length) {
        notes.push(`Ignored unsupported components: ${imported.ignored.join(', ')}.`);
      }
      setTree(specToTree(imported.name, imported.spec));
      setSelectedId(null);
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
    <div className="viz-root">
      <header className="app-header">
        <h1>🚀 Online OpenRocket</h1>
        <p>
          Design a model rocket and fly it — powered by the real OpenRocket physics
          engine (Extended Barrowman, 6-DOF RK4) compiled to JavaScript.
        </p>
      </header>
      <div className="layout">
        <aside>
          <div className="panel">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <h2 style={{ flex: 1 }}>Components</h2>
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
              ? <TreeSchematic tree={tree} info={built?.info ?? null} />
              : <Rocket3D tree={tree} info={built?.info ?? null} />}
            {built && <DesignStats info={built.info} />}
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
