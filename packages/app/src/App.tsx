import { useEffect, useMemo, useState } from 'react';
import {
  OrkRocket,
  resetEngine,
  type FlightResult,
  type RocketSpec,
  type StaticInfo,
} from '@online-openrocket/engine';
import { DesignForm, type DesignFormState } from './components/DesignForm.js';
import { FlightCharts } from './components/FlightCharts.js';
import { Schematic } from './components/Schematic.js';
import { DesignStats, FlightStats } from './components/StatTiles.js';
import { BUILT_IN_MOTORS } from './motors.js';
import { exportOrk, importOrk } from './services/orkFile.js';
import './styles.css';

const DEFAULT_SPEC: RocketSpec = {
  noseCone: { length: 0.07, aftRadius: 0.012, thickness: 0.002, shape: 'ogive' },
  bodyTube: { length: 0.3, outerRadius: 0.012, thickness: 0.0003, materialDensity: 950 },
  fins: { count: 3, rootChord: 0.05, tipChord: 0.03, sweep: 0.02, height: 0.03, thickness: 0.003 },
  motorMount: { length: 0.07, outerRadius: 0.0095, thickness: 0.0005 },
  parachute: { diameter: 0.3 },
};

/** Builds an engine rocket for the current form state. */
function buildRocket(state: DesignFormState): { rocket: OrkRocket; info: StaticInfo } {
  const rocket = OrkRocket.build(state.spec);
  rocket.setMotor(state.motor);
  return { rocket, info: rocket.staticInfo() };
}

export function App() {
  const [form, setForm] = useState<DesignFormState>({
    spec: DEFAULT_SPEC,
    motorLabel: 'C6-5',
    motor: BUILT_IN_MOTORS['C6-5']!,
    launchRodLengthM: 1.0,
    launchRodAngleDeg: 0,
    windAverage: 0,
  });
  const [result, setResult] = useState<FlightResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [fileNote, setFileNote] = useState<string | null>(null);

  const onSaveOrk = () => {
    const xml = exportOrk({
      name: 'My Rocket',
      spec: form.spec,
      motor: {
        designation: form.motor.designation,
        diameter: form.motor.diameter,
        length: form.motor.length,
        delay: form.motor.ejectionDelay,
      },
    });
    const blob = new Blob([xml], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rocket.ork';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onOpenOrk = async (file: File) => {
    try {
      const imported = importOrk(await file.arrayBuffer());
      const notes: string[] = [`Loaded “${imported.name}”.`, ...imported.notes];

      // Try to match the referenced motor against the built-ins by designation.
      let motorLabel = form.motorLabel;
      let motor = form.motor;
      if (imported.motor) {
        const match = Object.entries(BUILT_IN_MOTORS).find(
          ([k]) => k.startsWith(imported.motor!.designation),
        );
        if (match) {
          [motorLabel, motor] = match;
          notes.push(`Motor: ${motorLabel} (matched built-in).`);
        } else {
          notes.push(
            `Motor “${imported.motor.designation}” isn't built-in — pick it via thrustcurve.org search.`,
          );
        }
      }
      if (imported.ignored.length) {
        notes.push(`Ignored unsupported components: ${imported.ignored.join(', ')}.`);
      }
      setForm({ ...form, spec: imported.spec, motorLabel, motor });
      setFileNote(notes.join('\n'));
    } catch (e) {
      setFileNote(`Could not open that .ork file: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Rebuild + static analysis on every design change (fast: pure JS kernel).
  const built = useMemo(() => {
    try {
      resetEngine(); // free previous engine-side objects
      const b = buildRocket(form);
      setBuildError(null);
      return b;
    } catch (e) {
      setBuildError(String(e));
      return null;
    }
  }, [form]);

  // Invalidate stale flight results when the design changes.
  useEffect(() => {
    setResult(null);
  }, [form]);

  const onLaunch = () => {
    if (!built) return;
    setSimulating(true);
    // Yield a frame so the button state paints before the ~0.3s sim.
    requestAnimationFrame(() => {
      try {
        setResult(built.rocket.simulate({
          launchRodLength: form.launchRodLengthM,
          launchRodAngle: (form.launchRodAngleDeg * Math.PI) / 180,
          windAverage: form.windAverage,
          windStdDeviation: form.windAverage > 0 ? form.windAverage * 0.1 : 0,
        }));
      } catch (e) {
        setBuildError(String(e));
      } finally {
        setSimulating(false);
      }
    });
  };

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
          <DesignForm state={form} onChange={setForm} onLaunch={onLaunch} simulating={simulating} />
        </aside>
        <main className="results-column">
          <div className="panel">
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <h2 style={{ flex: 1 }}>Rocket</h2>
              <label className="file-btn">
                Open .ork
                <input
                  type="file"
                  accept=".ork"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onOpenOrk(f);
                    e.target.value = '';
                  }}
                />
              </label>
              <button className="file-btn" onClick={onSaveOrk}>Save .ork</button>
            </div>
            <Schematic spec={form.spec} info={built?.info ?? null} />
            {built && <DesignStats info={built.info} />}
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
