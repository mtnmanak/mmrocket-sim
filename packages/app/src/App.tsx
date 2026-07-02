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
  rocket.setMotor(BUILT_IN_MOTORS[state.motorKey]!);
  return { rocket, info: rocket.staticInfo() };
}

export function App() {
  const [form, setForm] = useState<DesignFormState>({
    spec: DEFAULT_SPEC,
    motorKey: 'C6-5',
    launchRodLengthM: 1.0,
    launchRodAngleDeg: 0,
    windAverage: 0,
  });
  const [result, setResult] = useState<FlightResult | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);

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
            <h2>Rocket</h2>
            <Schematic spec={form.spec} info={built?.info ?? null} />
            {built && <DesignStats info={built.info} />}
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
