import { ENGINE_VERSION, G0, ISA_SEA_LEVEL } from '@online-openrocket/engine';

export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', margin: '2rem auto', maxWidth: 720 }}>
      <h1>🚀 Online OpenRocket</h1>
      <p>
        Browser-based re-creation of the OpenRocket model-rocketry design and
        flight-simulation tool. Phase 0 scaffold.
      </p>
      <ul>
        <li>
          Engine package: <code>v{ENGINE_VERSION}</code>
        </li>
        <li>
          g<sub>0</sub> = <code>{G0} m/s²</code>
        </li>
        <li>
          ISA sea level: <code>{ISA_SEA_LEVEL.temperatureK} K</code>,{' '}
          <code>{ISA_SEA_LEVEL.pressurePa} Pa</code>
        </li>
      </ul>
    </main>
  );
}
